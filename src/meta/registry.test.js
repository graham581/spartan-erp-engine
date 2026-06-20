import { describe, it, expect, beforeEach } from 'vitest';
import {
  getMeta, hasMeta, setMeta, allDoctypes, primeFrom, invalidate,
  getVersionState, setVersionState, _resetRegistry, registerDoctype,
} from './registry.js';
import { Meta } from './meta.js';
import { NotFoundError } from '../runtime/errors.js';

const customerDef = {
  doctype: 'Customer',
  table: 'tabCustomer',
  fields: [{ fieldname: 'customer_name', fieldtype: 'Data' }],
  childTables: [],
  permissions: [],
  scopeFields: [],
};

beforeEach(() => {
  _resetRegistry();
});

describe('getMeta', () => {
  it('throws NotFoundError with "Unknown doctype: X" message on a miss', () => {
    expect(() => getMeta('Missing')).toThrow(NotFoundError);
    expect(() => getMeta('Missing')).toThrow('Unknown doctype: Missing');
  });

  it('returns a Meta instance after setMeta', () => {
    setMeta('Customer', customerDef);
    const m = getMeta('Customer');
    expect(m).toBeInstanceOf(Meta);
    expect(m.doctype).toBe('Customer');
    expect(m.table).toBe('tabCustomer');
  });

  it('returns a Meta instance when a Meta was set directly', () => {
    const meta = new Meta(customerDef);
    setMeta('Customer', meta);
    expect(getMeta('Customer')).toBe(meta);
  });
});

describe('hasMeta', () => {
  it('returns false for unregistered doctype', () => {
    expect(hasMeta('Customer')).toBe(false);
  });

  it('returns true after setMeta', () => {
    setMeta('Customer', customerDef);
    expect(hasMeta('Customer')).toBe(true);
  });
});

describe('allDoctypes', () => {
  it('returns empty array when nothing is registered', () => {
    expect(allDoctypes()).toEqual([]);
  });

  it('lists registered doctypes', () => {
    setMeta('Customer', customerDef);
    setMeta('Territory', { doctype: 'Territory', table: 'tabTerritory' });
    expect(allDoctypes().sort()).toEqual(['Customer', 'Territory']);
  });
});

describe('primeFrom', () => {
  it('registers plain DocMeta objects', () => {
    primeFrom([customerDef]);
    expect(hasMeta('Customer')).toBe(true);
    expect(getMeta('Customer')).toBeInstanceOf(Meta);
  });

  it('registers Meta objects directly', () => {
    const meta = new Meta(customerDef);
    primeFrom([meta]);
    expect(getMeta('Customer')).toBe(meta);
  });

  it('marks entries as pinned when isPinned=true', () => {
    primeFrom([customerDef], true);
    // pinned entries survive invalidate()
    invalidate();
    expect(hasMeta('Customer')).toBe(true);
  });

  it('non-pinned entries are evicted by invalidate()', () => {
    primeFrom([customerDef], false);
    invalidate();
    expect(hasMeta('Customer')).toBe(false);
  });
});

describe('invalidate', () => {
  it('clears all non-pinned when called without argument', () => {
    setMeta('Pinned', customerDef, true);
    setMeta('NonPinned', { doctype: 'NonPinned', table: 'tabNonPinned' }, false);
    invalidate();
    expect(hasMeta('Pinned')).toBe(true);
    expect(hasMeta('NonPinned')).toBe(false);
  });

  it('clears a specific non-pinned entry', () => {
    setMeta('A', customerDef, false);
    setMeta('B', { doctype: 'B', table: 'tabB' }, false);
    invalidate('A');
    expect(hasMeta('A')).toBe(false);
    expect(hasMeta('B')).toBe(true);
  });

  it('does NOT evict a pinned entry even when named directly', () => {
    setMeta('Pinned', customerDef, true);
    invalidate('Pinned');
    expect(hasMeta('Pinned')).toBe(true);
  });
});

describe('version state', () => {
  it('starts null/0', () => {
    const { version, versionCheckedAt } = getVersionState();
    expect(version).toBeNull();
    expect(versionCheckedAt).toBe(0);
  });

  it('stores and retrieves version state', () => {
    setVersionState('v2', 12345);
    const { version, versionCheckedAt } = getVersionState();
    expect(version).toBe('v2');
    expect(versionCheckedAt).toBe(12345);
  });
});

describe('_resetRegistry', () => {
  it('clears cache and pinned set and version state', () => {
    setMeta('Pinned', customerDef, true);
    setVersionState('v1', 999);
    _resetRegistry();
    expect(hasMeta('Pinned')).toBe(false);
    expect(allDoctypes()).toEqual([]);
    const { version, versionCheckedAt } = getVersionState();
    expect(version).toBeNull();
    expect(versionCheckedAt).toBe(0);
  });
});

describe('registerDoctype (temporary shim)', () => {
  it('registers a doctype via the shim (backward-compat)', () => {
    registerDoctype(customerDef);
    expect(hasMeta('Customer')).toBe(true);
    const m = getMeta('Customer');
    expect(m).toBeInstanceOf(Meta);
    expect(m.table).toBe('tabCustomer');
  });

  it('defaults empty arrays so getMeta never returns null fields', () => {
    registerDoctype({ doctype: 'Minimal', table: 'tabMinimal' });
    const m = getMeta('Minimal');
    expect(m.fields).toEqual([]);
    expect(m.childTables).toEqual([]);
    expect(m.permissions).toEqual([]);
    expect(m.scopeFields).toEqual([]);
  });
});
