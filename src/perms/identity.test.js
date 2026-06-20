import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../runtime/memory-store.js';
import { AuthError } from '../runtime/errors.js';
import { resolveUserToCtx } from './identity.js';

/**
 * Seed helpers — tabUser rows use email as the `name` key (Frappe convention).
 * tabHasRole rows are child rows linked by parent/parenttype/parentfield.
 */
async function seedUser(store, { email, enabled = true, branch = undefined }) {
  await store.insert('tabUser', { name: email, email, enabled, branch });
}

async function seedRole(store, { email, role, idx = 0 }) {
  await store.insert('tabHasRole', {
    name: `${email}-role-${idx}`,
    parent: email,
    parenttype: 'User',
    parentfield: 'roles',
    role,
  });
}

describe('resolveUserToCtx', () => {
  let store;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it('resolves a standard rep user to a branch-scoped, restricted context', async () => {
    await seedUser(store, { email: 'rep@x', branch: 'VIC' });
    await seedRole(store, { email: 'rep@x', role: 'rep', idx: 0 });

    const ctx = await resolveUserToCtx('rep@x', store);

    expect(ctx.user).toBe('rep@x');
    expect(ctx.roles).toEqual(['rep']);
    expect(ctx.scopes).toEqual({ branch: 'VIC' });
    expect(ctx.unrestricted).toBe(false);
    // N5 contract: ownerOnly must NOT appear on the returned context
    expect(Object.prototype.hasOwnProperty.call(ctx, 'ownerOnly')).toBe(false);
  });

  it('resolves an admin user to unrestricted:true', async () => {
    await seedUser(store, { email: 'admin@x', branch: 'NSW' });
    await seedRole(store, { email: 'admin@x', role: 'admin', idx: 0 });

    const ctx = await resolveUserToCtx('admin@x', store);

    expect(ctx.unrestricted).toBe(true);
    expect(ctx.roles).toContain('admin');
    expect(Object.prototype.hasOwnProperty.call(ctx, 'ownerOnly')).toBe(false);
  });

  it('throws AuthError for a missing user', async () => {
    await expect(resolveUserToCtx('ghost@x', store)).rejects.toThrow(AuthError);
  });

  it('throws AuthError for a disabled user', async () => {
    await seedUser(store, { email: 'disabled@x', enabled: false, branch: 'QLD' });
    await seedRole(store, { email: 'disabled@x', role: 'rep', idx: 0 });

    await expect(resolveUserToCtx('disabled@x', store)).rejects.toThrow(AuthError);
  });

  it('returns empty scopes when user has no branch', async () => {
    await seedUser(store, { email: 'nobranch@x' }); // branch undefined
    await seedRole(store, { email: 'nobranch@x', role: 'viewer', idx: 0 });

    const ctx = await resolveUserToCtx('nobranch@x', store);

    expect(ctx.scopes).toEqual({});
    expect(ctx.unrestricted).toBe(false);
  });
});
