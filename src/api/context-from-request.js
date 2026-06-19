import { makeContext, GUEST } from '../perms/context.js';

/**
 * ⚠ DEV SHIM — builds a Ctx from request headers. This TRUSTS the caller and is
 * NOT secure on its own. Before exposing publicly, replace with verified-token
 * resolution: verify a Supabase Auth / Google idToken, look the user up, and
 * derive roles + branch from their record. Keep the deployment private (or
 * behind an auth proxy) until then.
 *
 * Headers (dev):
 *   x-spartan-user    the acting user id
 *   x-spartan-roles   comma-separated roles
 *   x-spartan-branch  the user's branch (row-scope value)
 *
 * Role→scope policy lives here (the identity resolver), NOT in the permission
 * evaluator — so `unrestricted` is an EXPLICIT grant on the context, never a
 * role short-circuit inside can()/queryConditions().
 * @returns {import('../perms/context.js').Ctx}
 */
export function ctxFromRequest(req) {
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
    ownerOnly: roles.includes('rep') && !unrestricted,
    unrestricted,
  });
}
