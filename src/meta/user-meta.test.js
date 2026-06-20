/**
 * user-meta.test.js — Unit tests for U6: User / Has Role DocMeta + bootstrap admin.
 *
 * Test strategy: MemoryStore throughout; registerBootMeta() + _resetRegistry()
 * called in beforeEach so the pinned set is always fresh.
 *
 * Covers:
 *   - syncDoctype ordering: Has Role synced before User (Table-target closure).
 *   - getMeta('User') resolves after sync; 'roles' child table is present.
 *   - resolveUserToCtx(adminEmail, store) -> unrestricted:true  (U3 <-> U6 compose).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../runtime/memory-store.js';
import { _resetRegistry, getMeta } from './registry.js';
import { syncDoctype, bumpMetaVersion } from './installer.js';
import { seedViaLoader } from '../test-helpers/seed-via-loader.js';
import { resolveUserToCtx } from '../perms/identity.js';

// ── DocMeta defs (same shape as scripts/seed-user-meta.mjs) ──────────────────

const HAS_ROLE_DEF = {
  doctype:     'Has Role',
  table:       'tabHasRole',
  submittable: false,
  autoname:    'hash',
  istable:     true,
  fields: [
    { fieldname: 'name',        fieldtype: 'Data' },
    { fieldname: 'parent',      fieldtype: 'Link',  options: 'User' },
    { fieldname: 'parenttype',  fieldtype: 'Data' },
    { fieldname: 'parentfield', fieldtype: 'Data' },
    { fieldname: 'role',        fieldtype: 'Link',  options: 'Role' },
    { fieldname: 'idx',         fieldtype: 'Int' },
  ],
  childTables: [],
  scopeFields: [],
  permissions: [],
};

const USER_DEF = {
  doctype:     'User',
  table:       'tabUser',
  submittable: false,
  autoname:    'field:email',
  fields: [
    { fieldname: 'name',      fieldtype: 'Data' },
    { fieldname: 'email',     fieldtype: 'Data', reqd: true },
    { fieldname: 'full_name', fieldtype: 'Data' },
    { fieldname: 'branch',    fieldtype: 'Data' },
    { fieldname: 'enabled',   fieldtype: 'Check' },
    { fieldname: 'roles',     fieldtype: 'Table', options: 'Has Role' },
  ],
  childTables: [
    { field: 'roles', doctype: 'Has Role', table: 'tabHasRole' },
  ],
  scopeFields: [],
  permissions: [
    { role: 'admin', permlevel: 0, read: true, write: true, create: true, delete: true },
  ],
};

beforeEach(() => {
  _resetRegistry();
});

// ── syncDoctype ordering + getMeta resolution ─────────────────────────────────
//
// syncDoctype writes rows to the store; the real MetaLoader (via seedViaLoader)
// hydrates the registry cache.  getMeta() is a sync cache-only lookup, so we
// must pipe through seedViaLoader (= syncDoctype + load) for getMeta to resolve.
// Has Role FIRST (Table-target closure rule: loader.js:112).

describe('User / Has Role DocMeta sync', () => {
  it('seedViaLoader([HAS_ROLE_DEF, USER_DEF]) -> getMeta("User") resolves', async () => {
    // Child first: Has Role must be synced + loaded before User (Table-target closure)
    const store = await seedViaLoader([HAS_ROLE_DEF, USER_DEF]);

    const meta = getMeta('User');
    expect(meta).toBeDefined();
    expect(meta.doctype).toBe('User');
  });

  it('getMeta("Has Role") resolves after seedViaLoader', async () => {
    const store = await seedViaLoader([HAS_ROLE_DEF, USER_DEF]);

    const meta = getMeta('Has Role');
    expect(meta).toBeDefined();
    expect(meta.doctype).toBe('Has Role');
  });

  it('User meta has a "roles" child table pointing at Has Role', async () => {
    const store = await seedViaLoader([HAS_ROLE_DEF, USER_DEF]);

    const meta = getMeta('User');
    const rolesChild = meta.childTables.find((ct) => ct.field === 'roles');
    expect(rolesChild).toBeDefined();
    expect(rolesChild.doctype).toBe('Has Role');
    expect(rolesChild.table).toBe('tabHasRole');
  });

  it('tabDocType row is readable from the store after syncDoctype', async () => {
    // Lower-level: store.get works without going through the loader.
    const store = new MemoryStore();
    await syncDoctype(HAS_ROLE_DEF, store);
    await syncDoctype(USER_DEF, store);

    const row = await store.get('tabDocType', 'User');
    expect(row).not.toBeNull();
    expect(row.name).toBe('User');
  });

  it('bumpMetaVersion completes after User sync', async () => {
    const store = new MemoryStore();
    await syncDoctype(HAS_ROLE_DEF, store);
    await syncDoctype(USER_DEF, store);
    await bumpMetaVersion(store);

    const vrow = await store.get('meta_version', 'meta_version');
    expect(vrow).not.toBeNull();
    expect(typeof vrow.version).toBe('string');
  });
});

// ── End-to-end compose: resolveUserToCtx -> unrestricted for admin ────────────

describe('resolveUserToCtx end-to-end compose (U3 <-> U6)', () => {
  /**
   * Seed a tabUser row + tabHasRole child directly into MemoryStore.
   * (Mirrors the row shape identity.js reads via store.get / store.getChildren.)
   */
  async function seedAdmin(store, email) {
    await store.insert('tabUser', { name: email, email, enabled: true, branch: null });
    await store.insert('tabHasRole', {
      name:        `${email}-admin`,
      parent:      email,
      parenttype:  'User',
      parentfield: 'roles',
      role:        'admin',
      idx:         0,
    });
  }

  it('admin user resolves to unrestricted:true', async () => {
    const store = new MemoryStore();
    const adminEmail = 'admin@spartan.example';
    await seedAdmin(store, adminEmail);

    const ctx = await resolveUserToCtx(adminEmail, store);

    expect(ctx.unrestricted).toBe(true);
    expect(ctx.roles).toContain('admin');
    expect(ctx.user).toBe(adminEmail);
  });

  it('non-admin user resolves to unrestricted:false', async () => {
    const store = new MemoryStore();
    await store.insert('tabUser', { name: 'rep@x', email: 'rep@x', enabled: true, branch: 'VIC' });
    await store.insert('tabHasRole', {
      name: 'rep@x-rep', parent: 'rep@x', parenttype: 'User', parentfield: 'roles',
      role: 'rep', idx: 0,
    });

    const ctx = await resolveUserToCtx('rep@x', store);
    expect(ctx.unrestricted).toBe(false);
  });

  it('disabled admin throws AuthError — disabled check fires before role resolution', async () => {
    const { AuthError } = await import('../runtime/errors.js');
    const store = new MemoryStore();
    const adminEmail = 'disabled-admin@spartan.example';
    await store.insert('tabUser', { name: adminEmail, email: adminEmail, enabled: false });

    await expect(resolveUserToCtx(adminEmail, store)).rejects.toThrow(AuthError);
  });
});
