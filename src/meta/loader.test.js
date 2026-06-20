import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore }        from '../runtime/memory-store.js';
import { registerBootMeta }   from './boot-meta.js';
import { _resetRegistry, getMeta, hasMeta, getVersionState } from './registry.js';
import { load, ensure, ensureFresh, META_VERSION_TTL_MS } from './loader.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/**
 * Seed a minimal tabDocType row into the store.
 * @param {MemoryStore} store
 * @param {string} name  doctype name (the pk)
 * @param {Partial<Record<string,any>>} [extra]
 */
function seedDocType(store, name, extra = {}) {
  return store.insert('tabDocType', {
    name,
    docstatus: 0,
    idx: 0,
    is_submittable: false,
    ...extra,
  });
}

/**
 * Seed a DocField child row.
 * @param {MemoryStore} store
 * @param {string} parent  owning DocType name
 * @param {string} fieldname
 * @param {string} fieldtype
 * @param {Partial<Record<string,any>>} [extra]
 */
function seedField(store, parent, fieldname, fieldtype, extra = {}) {
  return store.insert('tabDocField', {
    name: `${parent}-${fieldname}`,
    parent,
    parenttype: 'DocType',
    parentfield: 'fields',
    fieldname,
    fieldtype,
    reqd: false,
    read_only: false,
    unique: false,
    permlevel: 0,
    idx: 0,
    ...extra,
  });
}

/**
 * Seed a DocPerm child row.
 * @param {MemoryStore} store
 * @param {string} parent  owning DocType name
 * @param {string} role
 * @param {Partial<Record<string,boolean|number>>} [flags]
 */
function seedPerm(store, parent, role, flags = {}) {
  return store.insert('tabDocPerm', {
    name: `${parent}-${role}`,
    parent,
    parenttype: 'DocType',
    parentfield: 'permissions',
    role,
    permlevel: 0,
    if_owner: false,
    read: false,
    write: false,
    create: false,
    submit: false,
    cancel: false,
    delete: false,
    ...flags,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRegistry();
  registerBootMeta();
});

// ---------------------------------------------------------------------------
// load() — snake→camel mapping (C4)
// ---------------------------------------------------------------------------

describe('load() — snake→camel mapping', () => {
  it('maps fetch_from → fetchFrom on a DocField row', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Customer');
    await seedField(store, 'Customer', 'customer_name', 'Data');
    await seedField(store, 'Customer', 'territory', 'Link', { options: 'Territory', fetch_from: 'territory.name' });

    const meta = await load('Customer', store);

    const f = meta.getField('territory');
    expect(f).toBeDefined();
    expect(f.fetchFrom).toBe('territory.name');
    // snake column must NOT appear on the camel shape
    expect(f.fetch_from).toBeUndefined();
  });

  it('maps read_only → readOnly', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Customer');
    await seedField(store, 'Customer', 'crm_id', 'Data', { read_only: true });

    const meta = await load('Customer', store);
    const f = meta.getField('crm_id');
    expect(f.readOnly).toBe(true);
    expect(f.read_only).toBeUndefined();
  });

  it('maps is_submittable → submittable on the DocType row', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'SalesOrder', { is_submittable: true });

    const meta = await load('SalesOrder', store);
    expect(meta.submittable).toBe(true);
  });

  it('coerces reqd / readOnly / unique to real booleans via !!', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Item');
    // Simulate values that could arrive as 1, 0, or null from a non-boolean DB column
    await seedField(store, 'Item', 'item_code', 'Data', { reqd: 1, read_only: 0, unique: 1 });

    const meta = await load('Item', store);
    const f = meta.getField('item_code');
    expect(f.reqd).toBe(true);
    expect(f.readOnly).toBe(false);
    expect(f.unique).toBe(true);
    // Must be actual booleans, not numbers
    expect(typeof f.reqd).toBe('boolean');
    expect(typeof f.readOnly).toBe('boolean');
    expect(typeof f.unique).toBe('boolean');
  });

  it('coerces permlevel and idx to numbers', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Item');
    await seedField(store, 'Item', 'secret', 'Data', { permlevel: '2', idx: '5' });

    const meta = await load('Item', store);
    const f = meta.getField('secret');
    expect(typeof f.permlevel).toBe('number');
    expect(f.permlevel).toBe(2);
    expect(typeof f.idx).toBe('number');
    expect(f.idx).toBe(5);
  });

  it('defaults permlevel and idx to 0 when absent', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Item');
    await store.insert('tabDocField', {
      name: 'Item-bare',
      parent: 'Item',
      parenttype: 'DocType',
      parentfield: 'fields',
      fieldname: 'bare',
      fieldtype: 'Data',
      // permlevel and idx omitted
    });

    const meta = await load('Item', store);
    const f = meta.getField('bare');
    expect(f.permlevel).toBe(0);
    expect(f.idx).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// load() — DocPerm normalisation (C5)
// ---------------------------------------------------------------------------

describe('load() — DocPerm normalisation', () => {
  it('renames parent → doctype on perm rows', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Customer');
    await seedPerm(store, 'Customer', 'Sales Manager', { read: true, write: true });

    const meta = await load('Customer', store);
    const perms = meta.getDocPerms();
    expect(perms).toHaveLength(1);
    expect(perms[0].doctype).toBe('Customer');
    expect(perms[0].parent).toBeUndefined();
  });

  it('coerces all flag columns (read/write/create/submit/cancel/delete) to real booleans', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'SalesOrder');
    await store.insert('tabDocPerm', {
      name: 'SalesOrder-Admin',
      parent: 'SalesOrder',
      parenttype: 'DocType',
      parentfield: 'permissions',
      role: 'Admin',
      permlevel: 0,
      read: 1, write: 1, create: 1, submit: 0, cancel: 0, delete: 0, if_owner: 0,
    });

    const meta = await load('SalesOrder', store);
    const [p] = meta.getDocPerms();
    for (const flag of ['read', 'write', 'create', 'submit', 'cancel', 'delete', 'ifOwner']) {
      expect(typeof p[flag]).toBe('boolean');
    }
    expect(p.read).toBe(true);
    expect(p.submit).toBe(false);
  });

  it('coerces NULL perm flags to false (not undefined / null)', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Item');
    await store.insert('tabDocPerm', {
      name: 'Item-Viewer',
      parent: 'Item',
      parenttype: 'DocType',
      parentfield: 'permissions',
      role: 'Viewer',
      permlevel: 0,
      // flags all omitted (null/undefined from DB)
    });

    const meta = await load('Item', store);
    const [p] = meta.getDocPerms();
    for (const flag of ['read', 'write', 'create', 'submit', 'cancel', 'delete', 'ifOwner']) {
      expect(p[flag]).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// load() — childTables resolution (M4)
// ---------------------------------------------------------------------------

describe('load() — childTables resolution (M4)', () => {
  it('derives childTables[].table from the primed child meta', async () => {
    const store = new MemoryStore();

    // Prime the child (Address) first so getMeta('Address').table is available
    await seedDocType(store, 'Address');
    await load('Address', store);

    // Now load Customer which has a Table field pointing to Address
    await seedDocType(store, 'Customer');
    await seedField(store, 'Customer', 'addresses', 'Table', { options: 'Address' });

    const meta = await load('Customer', store);
    expect(meta.childTables).toHaveLength(1);
    expect(meta.childTables[0].field).toBe('addresses');
    expect(meta.childTables[0].doctype).toBe('Address');
    expect(meta.childTables[0].table).toBe('tabAddress');
  });

  it('throws loud (N1) if a Table target was not primed before load()', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Customer');
    await seedField(store, 'Customer', 'contacts', 'Table', { options: 'Contact' });
    // Contact is NOT primed in the registry

    await expect(load('Customer', store)).rejects.toThrow(/Contact.*not primed|not primed.*Contact/i);
  });

  it('returns empty childTables when no Table fields exist', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Territory');
    await seedField(store, 'Territory', 'territory_name', 'Data');

    const meta = await load('Territory', store);
    expect(meta.childTables).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// load() — NotFoundError on missing doctype
// ---------------------------------------------------------------------------

describe('load() — error on missing doctype', () => {
  it('throws NotFoundError when the tabDocType row does not exist', async () => {
    const store = new MemoryStore();
    await expect(load('NonExistent', store)).rejects.toThrow(/Unknown doctype: NonExistent/);
  });
});

// ---------------------------------------------------------------------------
// ensure() — transitive closure priming (C1)
// ---------------------------------------------------------------------------

describe('ensure() — transitive closure', () => {
  it('primes the requested doctype into the registry', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Territory');
    await seedField(store, 'Territory', 'territory_name', 'Data');

    expect(hasMeta('Territory')).toBe(false);
    await ensure('Territory', store);
    expect(hasMeta('Territory')).toBe(true);
  });

  it('primes Link targets transitively', async () => {
    const store = new MemoryStore();
    // Customer → territory (Link) → Territory
    await seedDocType(store, 'Territory');
    await seedField(store, 'Territory', 'territory_name', 'Data');

    await seedDocType(store, 'Customer');
    await seedField(store, 'Customer', 'customer_name', 'Data');
    await seedField(store, 'Customer', 'territory', 'Link', { options: 'Territory' });

    await ensure('Customer', store);

    expect(hasMeta('Customer')).toBe(true);
    expect(hasMeta('Territory')).toBe(true);
  });

  it('primes Table children before the parent (child-first, N2)', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Address');
    await seedField(store, 'Address', 'address_line1', 'Data');

    await seedDocType(store, 'Customer');
    await seedField(store, 'Customer', 'customer_name', 'Data');
    await seedField(store, 'Customer', 'addresses', 'Table', { options: 'Address' });

    await ensure('Customer', store);

    expect(hasMeta('Address')).toBe(true);
    expect(hasMeta('Customer')).toBe(true);
    // Customer.childTables[].table should resolve correctly from the primed Address meta
    expect(getMeta('Customer').childTables[0].table).toBe('tabAddress');
  });

  it('terminates on mutual (cyclic) Links: A → B → A', async () => {
    const store = new MemoryStore();
    // A links to B, B links back to A — must not infinite-loop
    await seedDocType(store, 'NodeA');
    await seedField(store, 'NodeA', 'b_link', 'Link', { options: 'NodeB' });

    await seedDocType(store, 'NodeB');
    await seedField(store, 'NodeB', 'a_link', 'Link', { options: 'NodeA' });

    // Should resolve without hanging or throwing
    await expect(ensure('NodeA', store)).resolves.toBeUndefined();
    expect(hasMeta('NodeA')).toBe(true);
    expect(hasMeta('NodeB')).toBe(true);
  });

  it('does not re-load pinned (boot) entries', async () => {
    // DocType, DocField etc. are pinned by registerBootMeta() in beforeEach
    const store = new MemoryStore();
    // Priming any doctype that links to DocType should not throw even though
    // we haven't inserted a tabDocType row for 'DocType' itself in this store
    await seedDocType(store, 'Territory');
    await seedField(store, 'Territory', 'territory_name', 'Data');
    await seedField(store, 'Territory', 'dt_link', 'Link', { options: 'DocType' });

    await expect(ensure('Territory', store)).resolves.toBeUndefined();
    expect(hasMeta('Territory')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensureFresh() — version poll + TTL
// ---------------------------------------------------------------------------

describe('ensureFresh() — version polling', () => {
  it('does not hit the store when within the TTL window', async () => {
    const store = new MemoryStore();
    await store.insert('meta_version', { name: 'meta_version', version: '1' });

    // First call — sets versionCheckedAt
    await ensureFresh(store);
    const { versionCheckedAt: t1 } = getVersionState();

    // Second call immediately after — should skip the DB read (versionCheckedAt unchanged)
    await ensureFresh(store);
    const { versionCheckedAt: t2 } = getVersionState();

    expect(t2).toBe(t1); // same timestamp => store was not re-queried
  });

  it('invalidates non-pinned entries when version bumps', async () => {
    const store = new MemoryStore();
    await store.insert('meta_version', { name: 'meta_version', version: '1' });

    // Prime a non-pinned doctype manually
    await seedDocType(store, 'Territory');
    await seedField(store, 'Territory', 'territory_name', 'Data');
    await load('Territory', store);
    expect(hasMeta('Territory')).toBe(true);

    // Force the TTL to expire by back-dating versionCheckedAt
    const { setVersionState: _set } = await import('./registry.js');
    _set('1', 0); // set version='1', checkedAt=0 (far in the past)

    // Bump the version in the store
    await store.update('meta_version', 'meta_version', { name: 'meta_version', version: '2' });

    // ensureFresh should detect the version change and invalidate non-pinned
    await ensureFresh(store);

    // Territory (non-pinned) should be gone; boot-pinned entries should remain
    expect(hasMeta('Territory')).toBe(false);
    expect(hasMeta('DocType')).toBe(true);   // pinned — never evicted
  });

  it('does not invalidate when version has not changed (within TTL check after expiry)', async () => {
    const store = new MemoryStore();
    await store.insert('meta_version', { name: 'meta_version', version: '1' });

    await seedDocType(store, 'Territory');
    await seedField(store, 'Territory', 'territory_name', 'Data');
    await load('Territory', store);

    // Back-date so TTL is expired but version unchanged
    const { setVersionState: _set } = await import('./registry.js');
    _set('1', 0);

    await ensureFresh(store);

    // version unchanged → Territory should still be cached
    expect(hasMeta('Territory')).toBe(true);
  });

  it(`respects the ${META_VERSION_TTL_MS}ms TTL constant`, () => {
    expect(typeof META_VERSION_TTL_MS).toBe('number');
    expect(META_VERSION_TTL_MS).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// load() — setMeta registers the result
// ---------------------------------------------------------------------------

describe('load() — registers into MetaRegistry', () => {
  it('makes getMeta(doctype) available synchronously after load()', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Customer');
    await seedField(store, 'Customer', 'customer_name', 'Data');

    await load('Customer', store);
    const meta = getMeta('Customer');
    expect(meta.doctype).toBe('Customer');
    expect(meta.table).toBe('tabCustomer');
  });

  it('produces a Meta instance (not a plain object)', async () => {
    const store = new MemoryStore();
    await seedDocType(store, 'Customer');

    const meta = await load('Customer', store);
    expect(typeof meta.getField).toBe('function');
    expect(typeof meta.getDocPerms).toBe('function');
    expect(typeof meta.childTablesList).toBe('function');
  });
});
