/**
 * @typedef {Object} Ctx
 * @property {string} user              acting user (owner stamping + ownerOnly scope)
 * @property {string[]} roles           roles the user holds
 * @property {Record<string, any>} [scopes]   row-scope values, e.g. { branch: 'VIC' }
 * @property {boolean} [ownerOnly]      restrict reads to records this user owns
 * @property {boolean} [unrestricted]   EXPLICIT all-rows access (admin) — never a role===admin bypass
 */

/**
 * Build a request context. The API layer (Phase 3) constructs this from a
 * verified token; the client never supplies it.
 * @returns {Ctx}
 */
export function makeContext({ user, roles = [], scopes = {}, ownerOnly = false, unrestricted = false }) {
  return { user, roles, scopes, ownerOnly, unrestricted };
}

/**
 * Engine-internal context — full access, for migrations / cron / side-effects.
 * Unrestricted by EXPLICIT design, not by holding an admin role.
 * @type {Ctx}
 */
export const SYSTEM = { user: 'system', roles: [], scopes: {}, ownerOnly: false, unrestricted: true };

/** Anonymous, no-access context. @type {Ctx} */
export const GUEST = { user: 'guest', roles: [], scopes: {}, ownerOnly: false, unrestricted: false };
