import { describe, it, expect, beforeEach } from 'vitest';
import { registerDoctype, _resetRegistry } from '../meta/registry.js';
import { makeContext, SYSTEM } from './context.js';
import { can, assertCan, visibleFields, maskRead, assertCanWrite, queryConditions } from './permissions.js';
import { PermissionError } from '../runtime/errors.js';

// One doctype, four roles, a permlevel-1 'margin' field, branch row-scope.
function seed() {
  registerDoctype({
    doctype: 'Job',
    table: 'tabJob',
    submittable: true,
    scopeFields: ['branch'],
    fields: [
      { fieldname: 'title', fieldtype: 'Data', permlevel: 0 },
      { fieldname: 'branch', fieldtype: 'Data', permlevel: 0 },
      { fieldname: 'margin', fieldtype: 'Currency', permlevel: 1 },
    ],
    childTables: [],
    permissions: [
      // admin: everything, incl. permlevel-1 read+write
      { role: 'admin', doctype: 'Job', permlevel: 0, read: true, write: true, create: true, submit: true, cancel: true, delete: true },
      { role: 'admin', doctype: 'Job', permlevel: 1, read: true, write: true },
      // manager: ops minus delete; can READ margin but not write it
      { role: 'manager', doctype: 'Job', permlevel: 0, read: true, write: true, create: true, submit: true, cancel: true },
      { role: 'manager', doctype: 'Job', permlevel: 1, read: true },
      // rep: owner-only read+write at level 0; plain create (R-B: can't own before creation)
      { role: 'rep', doctype: 'Job', permlevel: 0, read: true, ifOwner: true },
      { role: 'rep', doctype: 'Job', permlevel: 0, write: true, ifOwner: true },
      { role: 'rep', doctype: 'Job', permlevel: 0, create: true },
      // viewer: read only at level 0
      { role: 'viewer', doctype: 'Job', permlevel: 0, read: true },
    ],
  });
}

const admin = makeContext({ user: 'admin@x', roles: ['admin'], unrestricted: true });
const manager = makeContext({ user: 'mgr@x', roles: ['manager'], scopes: { branch: 'VIC' } });
const rep = makeContext({ user: 'rep@x', roles: ['rep'], scopes: { branch: 'VIC' } });
const viewer = makeContext({ user: 'v@x', roles: ['viewer'], scopes: { branch: 'VIC' } });
const stranger = makeContext({ user: 'no@x', roles: ['nobody'] });

describe('permissions — op gate (docperm)', () => {
  beforeEach(() => { _resetRegistry(); seed(); });

  it('grants per the docperm matrix', () => {
    expect(can(admin, 'Job', 'delete')).toBe(true);
    expect(can(manager, 'Job', 'submit')).toBe(true);
    expect(can(rep, 'Job', 'create')).toBe(true);
    expect(can(viewer, 'Job', 'read')).toBe(true);
  });

  it('denies what the matrix does not grant', () => {
    expect(can(rep, 'Job', 'delete')).toBe(false);
    expect(can(rep, 'Job', 'submit')).toBe(false);
    expect(can(viewer, 'Job', 'write')).toBe(false);
  });

  it('denies by default for a role with no docperm rows', () => {
    expect(can(stranger, 'Job', 'read')).toBe(false);
    expect(can(stranger, 'Job', 'create')).toBe(false);
  });

  it('assertCan throws PermissionError when denied', () => {
    expect(() => assertCan(rep, 'Job', 'delete')).toThrow(PermissionError);
    expect(() => assertCan(admin, 'Job', 'delete')).not.toThrow();
  });
});

describe('permissions — field level (permlevel)', () => {
  beforeEach(() => { _resetRegistry(); seed(); });

  it('manager sees the margin field; rep does not', () => {
    expect(visibleFields(manager, 'Job')).toContain('margin');
    expect(visibleFields(rep, 'Job')).not.toContain('margin');
    expect(visibleFields(rep, 'Job')).toEqual(expect.arrayContaining(['title', 'branch']));
  });

  it('maskRead strips margin for the rep but keeps framework + base fields', () => {
    const row = { name: 'JOB-1', owner: 'rep@x', title: 'Kitchen', branch: 'VIC', margin: 4200, docstatus: 0 };
    const masked = maskRead(rep, 'Job', row);
    expect(masked).not.toHaveProperty('margin');
    expect(masked).toMatchObject({ name: 'JOB-1', owner: 'rep@x', title: 'Kitchen', branch: 'VIC' });
  });

  it('assertCanWrite blocks writes to a field above the ctx write-level', () => {
    const before = { title: 'A', margin: 100 };
    // rep cannot write margin (permlevel 1)
    expect(() => assertCanWrite(rep, 'Job', before, { title: 'A', margin: 999 })).toThrow(PermissionError);
    // rep CAN write title (permlevel 0)
    expect(() => assertCanWrite(rep, 'Job', before, { title: 'B', margin: 100 })).not.toThrow();
    // manager reads margin but cannot write it
    expect(() => assertCanWrite(manager, 'Job', before, { title: 'A', margin: 999 })).toThrow(PermissionError);
  });
});

describe('permissions — row scope (query conditions)', () => {
  beforeEach(() => { _resetRegistry(); seed(); });

  it('admin is unrestricted by EXPLICIT grant (no filter), not a role bypass', () => {
    expect(queryConditions(admin, 'Job')).toEqual({});
    expect(admin.unrestricted).toBe(true); // the grant is explicit on the context
  });

  it('manager is scoped to its branch', () => {
    expect(queryConditions(manager, 'Job')).toEqual({ branch: 'VIC' });
  });

  it('rep is scoped to its branch AND its own records', () => {
    expect(queryConditions(rep, 'Job')).toEqual({ branch: 'VIC', owner: 'rep@x' });
  });

  it('SYSTEM context is unrestricted (internal ops)', () => {
    expect(queryConditions(SYSTEM, 'Job')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// New tests for if_owner enforcement (F1 / R-A / N1 / F4 / queryConditions)
// ---------------------------------------------------------------------------

describe('permissions — if_owner: owner-only write (F1)', () => {
  // Registers a minimal doctype: 'repB' has owner-only write, no plain read/write.
  function seedOwnerWrite() {
    registerDoctype({
      doctype: 'Job',
      table: 'tabJob',
      scopeFields: [],
      fields: [{ fieldname: 'title', fieldtype: 'Data', permlevel: 0 }],
      childTables: [],
      permissions: [
        { role: 'rep', doctype: 'Job', permlevel: 0, write: true, ifOwner: true },
      ],
    });
  }

  beforeEach(() => { _resetRegistry(); seedOwnerWrite(); });

  it('F1: owner-only write — no doc → false', () => {
    expect(can(rep, 'Job', 'write')).toBe(false);
  });

  it('F1: owner-only write — doc where owner matches → true', () => {
    expect(can(rep, 'Job', 'write', { owner: 'rep@x' })).toBe(true);
  });

  it('F1: owner-only write — doc where owner mismatches → false', () => {
    expect(can(rep, 'Job', 'write', { owner: 'other@x' })).toBe(false);
  });
});

describe('permissions — if_owner: owner-only read no-doc (R-A)', () => {
  function seedOwnerRead() {
    registerDoctype({
      doctype: 'Job',
      table: 'tabJob',
      scopeFields: [],
      fields: [{ fieldname: 'title', fieldtype: 'Data', permlevel: 0 }],
      childTables: [],
      permissions: [
        { role: 'rep', doctype: 'Job', permlevel: 0, read: true, ifOwner: true },
      ],
    });
  }

  beforeEach(() => { _resetRegistry(); seedOwnerRead(); });

  it('R-A: owner-only read, no doc → true (list-level pre-filter)', () => {
    expect(can(rep, 'Job', 'read')).toBe(true);
  });
});

describe('permissions — if_owner: plain-write union wins (N1)', () => {
  // repA has plain write; repB has owner-only write. A user with BOTH roles gets plain.
  function seedUnion() {
    registerDoctype({
      doctype: 'Job',
      table: 'tabJob',
      scopeFields: [],
      fields: [{ fieldname: 'title', fieldtype: 'Data', permlevel: 0 }],
      childTables: [],
      permissions: [
        { role: 'repA', doctype: 'Job', permlevel: 0, write: true },
        { role: 'repB', doctype: 'Job', permlevel: 0, write: true, ifOwner: true },
      ],
    });
  }

  beforeEach(() => { _resetRegistry(); seedUnion(); });

  it('N1: roles with plain-write + owner-only-write → no-doc write is true (plain wins)', () => {
    const hybrid = makeContext({ user: 'rep@x', roles: ['repA', 'repB'] });
    expect(can(hybrid, 'Job', 'write')).toBe(true);
  });
});

describe('permissions — if_owner: create ignores if_owner flag (F4)', () => {
  function seedOwnerCreate() {
    registerDoctype({
      doctype: 'Job',
      table: 'tabJob',
      scopeFields: [],
      fields: [{ fieldname: 'title', fieldtype: 'Data', permlevel: 0 }],
      childTables: [],
      permissions: [
        // ifOwner on a create row — Frappe ignores it; we treat create as plain always.
        { role: 'rep', doctype: 'Job', permlevel: 0, create: true, ifOwner: true },
      ],
    });
  }

  beforeEach(() => { _resetRegistry(); seedOwnerCreate(); });

  it('F4: ifOwner on a create docperm → create is still granted (owner flag ignored for create)', () => {
    expect(can(rep, 'Job', 'create')).toBe(true);
  });
});

describe('permissions — queryConditions: owner filter only when no plain read', () => {
  beforeEach(() => { _resetRegistry(); });

  it('owner-only read (no plain read) → filter includes { owner: ctx.user }', () => {
    registerDoctype({
      doctype: 'Job',
      table: 'tabJob',
      scopeFields: [],
      fields: [{ fieldname: 'title', fieldtype: 'Data', permlevel: 0 }],
      childTables: [],
      permissions: [
        { role: 'rep', doctype: 'Job', permlevel: 0, read: true, ifOwner: true },
      ],
    });
    const conds = queryConditions(rep, 'Job');
    expect(conds).toHaveProperty('owner', 'rep@x');
  });

  it('plain read → filter has no owner key', () => {
    registerDoctype({
      doctype: 'Job',
      table: 'tabJob',
      scopeFields: [],
      fields: [{ fieldname: 'title', fieldtype: 'Data', permlevel: 0 }],
      childTables: [],
      permissions: [
        { role: 'viewer', doctype: 'Job', permlevel: 0, read: true },
      ],
    });
    const viewer2 = makeContext({ user: 'v@x', roles: ['viewer'] });
    const conds = queryConditions(viewer2, 'Job');
    expect(conds).not.toHaveProperty('owner');
  });
});
