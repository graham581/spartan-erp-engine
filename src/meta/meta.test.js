import { describe, it, expect } from 'vitest';
import { Meta } from './meta.js';

const baseDef = {
  doctype: 'Customer',
  table: 'tabCustomer',
  submittable: false,
  autoname: 'field:customer_code',
  fields: [
    { fieldname: 'customer_name', fieldtype: 'Data', reqd: true },
    { fieldname: 'territory',     fieldtype: 'Link', options: 'Territory' },
  ],
  childTables: [
    { field: 'contacts', doctype: 'Contact', table: 'tabContact' },
  ],
  scopeFields: ['branch'],
  permissions: [
    { role: 'Sales User', doctype: 'Customer', permlevel: 0, read: true, write: true,
      create: true, submit: false, cancel: false, delete: false },
  ],
};

describe('Meta', () => {
  it('exposes doctype as a readable property', () => {
    const m = new Meta(baseDef);
    expect(m.doctype).toBe('Customer');
  });

  it('exposes table as a readable property', () => {
    const m = new Meta(baseDef);
    expect(m.table).toBe('tabCustomer');
  });

  it('exposes submittable as boolean', () => {
    expect(new Meta(baseDef).submittable).toBe(false);
    expect(new Meta({ ...baseDef, submittable: true }).submittable).toBe(true);
    // absent -> defaults false
    const { submittable: _, ...noSub } = baseDef;
    expect(new Meta(noSub).submittable).toBe(false);
  });

  it('exposes autoname', () => {
    expect(new Meta(baseDef).autoname).toBe('field:customer_code');
  });

  it('exposes fields array', () => {
    const m = new Meta(baseDef);
    expect(m.fields).toHaveLength(2);
    expect(m.fields[0].fieldname).toBe('customer_name');
  });

  it('exposes childTables array', () => {
    const m = new Meta(baseDef);
    expect(m.childTables).toHaveLength(1);
    expect(m.childTables[0].table).toBe('tabContact');
  });

  it('exposes scopeFields array', () => {
    expect(new Meta(baseDef).scopeFields).toEqual(['branch']);
  });

  it('exposes permissions array', () => {
    const m = new Meta(baseDef);
    expect(m.permissions).toHaveLength(1);
    expect(m.permissions[0].role).toBe('Sales User');
  });

  it('defaults to empty arrays when def omits optional arrays', () => {
    const m = new Meta({ doctype: 'Foo', table: 'tabFoo' });
    expect(m.fields).toEqual([]);
    expect(m.childTables).toEqual([]);
    expect(m.scopeFields).toEqual([]);
    expect(m.permissions).toEqual([]);
  });

  it('getField returns the matching FieldDef', () => {
    const m = new Meta(baseDef);
    const f = m.getField('territory');
    expect(f).toBeDefined();
    expect(f.fieldtype).toBe('Link');
  });

  it('getField returns undefined for an unknown fieldname', () => {
    expect(new Meta(baseDef).getField('nonexistent')).toBeUndefined();
  });

  it('childTablesList() returns the same array as .childTables', () => {
    const m = new Meta(baseDef);
    expect(m.childTablesList()).toBe(m.childTables);
  });

  it('getDocPerms() returns the permissions array', () => {
    const m = new Meta(baseDef);
    expect(m.getDocPerms()).toBe(m.permissions);
    expect(m.getDocPerms()).toHaveLength(1);
  });

  it('getDocPerms() returns empty array when no permissions defined', () => {
    const m = new Meta({ doctype: 'Foo', table: 'tabFoo' });
    expect(m.getDocPerms()).toEqual([]);
  });

  it('is duck-compatible: property access works the same as a plain object', () => {
    // Simulate how document.js:27, naming.js:14, links.js:15 read the meta
    const m = new Meta(baseDef);
    const { doctype, table, submittable, autoname, fields, childTables } = m;
    expect(doctype).toBe('Customer');
    expect(table).toBe('tabCustomer');
    expect(submittable).toBe(false);
    expect(autoname).toBe('field:customer_code');
    expect(fields).toHaveLength(2);
    expect(childTables).toHaveLength(1);
  });
});
