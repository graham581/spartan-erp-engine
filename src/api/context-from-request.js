import { makeContext, GUEST } from '../perms/context.js';
import { verifyGoogleIdToken } from '../perms/auth.js';
import { resolveUserToCtx } from '../perms/identity.js';
import { loadAuthEnv } from '../validation/env-schema.js';

/**
 * Derive a permission context from an incoming request.
 *
 * Resolution order:
 *   1. `Authorization: Bearer <jwt>` present →
 *      verify the Google idToken, resolve the email to a Ctx via the store.
 *   2. No bearer, DEV_AUTH enabled (N6 fail-closed) →
 *      build a dev ctx from x-spartan-* headers (trusted shim, NOT for prod).
 *   3. No bearer, DEV_AUTH disabled (default) → GUEST.
 *
 * Throws `AuthError` if the bearer is present but invalid, or if the resolved
 * user is missing/disabled. The route handler is responsible for mapping
 * `AuthError → 401` (it is called outside `handle()`, so handler.statusFor
 * alone is not sufficient — see §0.3 of the work order).
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<import('../perms/context.js').Ctx>}
 */
export async function ctxFromRequest(req, store) {
  const authHeader = (req && req.headers && req.headers['authorization']) || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (bearer) {
    const payload = await verifyGoogleIdToken(bearer);
    return resolveUserToCtx(payload.email, store);
  }

  if (loadAuthEnv().devAuth) {
    return devCtxFromHeaders(req);
  }

  return GUEST;
}

// ---------------------------------------------------------------------------
// Private — dev shim only (NOT secure; guarded by devAuth flag)
// ---------------------------------------------------------------------------

/**
 * ⚠ DEV SHIM — builds a Ctx from request headers. This TRUSTS the caller and is
 * NOT secure on its own. Only reached when DEV_AUTH is enabled (N6 fail-closed).
 *
 * Headers (dev):
 *   x-spartan-user    the acting user id
 *   x-spartan-roles   comma-separated roles
 *   x-spartan-branch  the user's branch (row-scope value)
 *
 * Role→scope policy lives here (the identity resolver), NOT in the permission
 * evaluator — so `unrestricted` is an EXPLICIT grant on the context, never a
 * role short-circuit inside can()/queryConditions().
 *
 * @param {import('http').IncomingMessage} req
 * @returns {import('../perms/context.js').Ctx}
 */
function devCtxFromHeaders(req) {
  const h = (req && req.headers) || {};
  const user = h['x-spartan-user'];
  if (!user) return GUEST;
  const roles = String(h['x-spartan-roles'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const branch = h['x-spartan-branch'];
  const unrestricted = roles.includes('admin');
  return makeContext({
    user,
    roles,
    scopes: branch ? { branch } : {},
    unrestricted,
  });
}
