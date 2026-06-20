import { AuthError } from '../runtime/errors.js';
import { makeContext } from './context.js';

// N5 hard rule: do NOT import from src/api/service.js — identity resolution must
// not recurse through the permission layer that depends on a resolved user.

/**
 * Map roles to the unrestricted flag. Policy lives here; admin -> all-rows access.
 * @param {string[]} roles
 * @returns {boolean}
 */
function applyScopePolicy(roles) {
  return roles.includes('admin');
}

/**
 * Resolve a verified email to a permission context.
 * Uses RAW store.get / store.getChildren — never getDoc / service.js (N5).
 *
 * @param {string} email
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<import('./context.js').Ctx>}
 * @throws {AuthError} if user is missing or disabled
 */
export async function resolveUserToCtx(email, store) {
  const user = await store.get('tabUser', email);

  if (!user || user.enabled === false) {
    throw new AuthError(`User '${email}' not found or disabled`);
  }

  const roleRows = await store.getChildren('tabHasRole', email, 'User', 'roles');
  const roles = roleRows.map((r) => r.role);

  const branch = user.branch;
  const scopes = branch ? { branch } : {};

  const unrestricted = applyScopePolicy(roles);

  return makeContext({ user: email, roles, scopes, unrestricted });
}
