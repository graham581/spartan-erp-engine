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
      // rep: read/write/create at level 0 only (no margin, no submit/cancel/delete)
      { role: 'rep', doctype: 'Job', permlevel: 0, read: true, write: true, create: true },
      // viewer: read only at level 0
      { role: 'viewer', doctype: 'Job', permlevel: 0, read: true },
    ],
  });
}

const admin = makeContext({ user: 'admin@x', roles: ['admin'], unrestricted: true });
const manager = makeContext({ user: 'mgr@x', roles: ['manager'], scopes: { branch: 'VIC' } });
const rep = makeContext({ user: 'rep@x', roles: ['rep'], scopes: { branch: 'VIC' }, ownerOnly: true });
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
