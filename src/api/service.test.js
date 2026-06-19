import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../runtime/memory-store.js';
import { registerDoctype, _resetRegistry } from '../meta/registry.js';
import { registerRolePerm, _resetPerms } from '../perms/registry.js';
import { makeContext } from '../perms/context.js';
import { createDoc, getDoc, listDocs, updateDoc, submitDoc } from './service.js';
import { PermissionError, NotFoundError } from '../runtime/errors.js';

function seed() {
  registerDoctype({
    doctype: 'Job',
    table: 'tabJob',
    submittable: true,
    autoname: 'JOB-.#####',
    scopeFields: ['branch'],
    fields: [
      { fieldname: 'title', fieldtype: 'Data', reqd: true, permlevel: 0 },
      { fieldname: 'branch', fieldtype: 'Data', permlevel: 0 },
      { fieldname: 'margin', fieldtype: 'Currency', permlevel: 1 },
    ],
    childTables: [],
  });
  registerRolePerm({ role: 'admin', doctype: 'Job', permlevel: 0, read: true, write: true, create: true, submit: true, cancel: true, delete: true });
  registerRolePerm({ role: 'admin', doctype: 'Job', permlevel: 1, read: true, write: true });
  registerRolePerm({ role: 'manager', doctype: 'Job', permlevel: 0, read: true, write: true, create: true, submit: true, cancel: true });
  registerRolePerm({ role: 'manager', doctype: 'Job', permlevel: 1, read: true });
  registerRolePerm({ role: 'rep', doctype: 'Job', permlevel: 0, read: true, write: true, create: true });
  registerRolePerm({ role: 'viewer', doctype: 'Job', permlevel: 0, read: true });
}

const admin = makeContext({ user: 'admin@x', roles: ['admin'], unrestricted: true });
const manager = makeContext({ user: 'mgr@x', roles: ['manager'], scopes: { branch: 'VIC' } });
const rep = makeContext({ user: 'rep@x', roles: ['rep'], scopes: { branch: 'VIC' }, ownerOnly: true });
const viewer = makeContext({ user: 'v@x', roles: ['viewer'], scopes: { branch: 'VIC' } });

describe('service — adversarial matrix through the real code path', () => {
  /** @type {MemoryStore} */
  let store;
  beforeEach(() => { _resetRegistry(); _resetPerms(); seed(); store = new MemoryStore(); });

  it('create stamps owner and gates the op', async () => {
    const out = await createDoc(rep, 'Job', { title: 'Kitchen', branch: 'VIC' }, store);
    expect(out.owner).toBe('rep@x');
    expect(out.title).toBe('Kitchen');
    await expect(createDoc(viewer, 'Job', { title: 'X', branch: 'VIC' }, store)).rejects.toBeInstanceOf(PermissionError);
  });

  it('blocks setting an above-write-level field on create', async () => {
    await expect(createDoc(rep, 'Job', { title: 'T', branch: 'VIC', margin: 500 }, store)).rejects.toBeInstanceOf(PermissionError);
    // admin may set margin
    const ok = await createDoc(admin, 'Job', { title: 'T', branch: 'VIC', margin: 500 }, store);
    expect(ok.margin).toBe(500);
  });

  it('list is row-scoped: rep sees only own+branch, manager sees branch, admin sees all', async () => {
    await createDoc(rep, 'Job', { title: 'rep-vic', branch: 'VIC' }, store);          // owner rep@x
    await createDoc(admin, 'Job', { title: 'admin-vic', branch: 'VIC' }, store);      // owner admin@x, VIC
    await createDoc(admin, 'Job', { title: 'admin-nsw', branch: 'NSW' }, store);      // owner admin@x, NSW

    const repList = await listDocs(rep, 'Job', {}, store);
    expect(repList.map((r) => r.title).sort()).toEqual(['rep-vic']); // own + branch only

    const mgrList = await listDocs(manager, 'Job', {}, store);
    expect(mgrList.map((r) => r.title).sort()).toEqual(['admin-vic', 'rep-vic']); // both VIC

    const adminList = await listDocs(admin, 'Job', {}, store);
    expect(adminList).toHaveLength(3); // unrestricted
  });

  it('get of an out-of-scope record reads as Not Found (no existence leak)', async () => {
    const nsw = await createDoc(admin, 'Job', { title: 'secret', branch: 'NSW' }, store);
    await expect(getDoc(rep, 'Job', nsw.name, store)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reads mask above-read-level fields (rep cannot see margin)', async () => {
    // seed a rep-owned VIC doc carrying margin directly (rep itself could never set it)
    await store.insert('tabJob', { name: 'JOB-X', owner: 'rep@x', branch: 'VIC', title: 'T', margin: 999, docstatus: 0 });
    const seen = await getDoc(rep, 'Job', 'JOB-X', store);
    expect(seen).not.toHaveProperty('margin');
    expect(seen).toMatchObject({ title: 'T', branch: 'VIC' });
    // manager can read margin
    const mgrSeen = await getDoc(manager, 'Job', 'JOB-X', store);
    expect(mgrSeen.margin).toBe(999);
  });

  it('update rejects above-write-level fields but allows base fields', async () => {
    const j = await createDoc(rep, 'Job', { title: 'A', branch: 'VIC' }, store);
    await expect(updateDoc(rep, 'Job', j.name, { margin: 10 }, store)).rejects.toBeInstanceOf(PermissionError);
    const ok = await updateDoc(rep, 'Job', j.name, { title: 'B' }, store);
    expect(ok.title).toBe('B');
  });

  it('submit is op-gated: rep denied, manager allowed', async () => {
    const j = await createDoc(rep, 'Job', { title: 'A', branch: 'VIC' }, store);
    await expect(submitDoc(rep, 'Job', j.name, store)).rejects.toBeInstanceOf(PermissionError);
    // manager (branch VIC) can submit the same VIC doc
    const done = await submitDoc(manager, 'Job', j.name, store);
    expect(done.docstatus).toBe(1);
  });
});
