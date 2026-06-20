// erpnext-to-def.test.js — §2-U2 assertions.
//
// Covers: isRealDoctype, table derivation, layout-field exclusion,
//         Dynamic Link options stripping, and assertValidDef round-trip
//         over a realistic Sales Order fixture.

import { describe, it, expect } from 'vitest';
import { isRealDoctype, mapField, erpnextJsonToDef, makeStubDef } from './erpnext-to-def.js';
import { assertValidDef } from '../validation/def-schema.js';

// ---------------------------------------------------------------------------
// Minimal realistic fixture modelled on selling/doctype/sales_order/sales_order.json
// Keys that are NOT part of the whitelist (depends_on, mandatory_depends_on) are
// intentionally present to confirm the transform ignores them.
// ---------------------------------------------------------------------------
const SALES_ORDER_JSON = {
  doctype: 'DocType',
  name: 'Sales Order',
  module: 'Selling',
  is_submittable: 1,
  issingle: 0,
  istable: 0,
  autoname: 'naming_series:',
  naming_rule: 'By Naming Series',
  fields: [
    // Data field — a standard string column
    {
      fieldname: 'title',
      fieldtype: 'Data',
      reqd: 1,
      read_only: 0,
      unique: 0,
      permlevel: 0,
      idx: 1,
      depends_on: 'eval:doc.is_group==0',
      mandatory_depends_on: 'eval:doc.x=="y"',
    },
    // Section Break — layout, must be excluded
    {
      fieldname: 'order_details_section',
      fieldtype: 'Section Break',
      reqd: 0,
      read_only: 0,
      idx: 2,
    },
    // Link field — options must be kept
    {
      fieldname: 'customer',
      fieldtype: 'Link',
      options: 'Customer',
      reqd: 1,
      read_only: 0,
      unique: 0,
      permlevel: 0,
      idx: 3,
    },
    // Dynamic Link — options MUST be stripped (D1-3)
    {
      fieldname: 'link_doctype',
      fieldtype: 'Dynamic Link',
      options: 'link_name',
      reqd: 0,
      read_only: 0,
      unique: 0,
      permlevel: 0,
      idx: 4,
    },
    // Select — options (enum string) must be kept
    {
      fieldname: 'status',
      fieldtype: 'Select',
      options: 'Draft\nSubmitted\nCancelled',
      reqd: 0,
      read_only: 1,
      unique: 0,
      permlevel: 0,
      idx: 5,
    },
    // Currency — options stripped (not in keep-set)
    {
      fieldname: 'grand_total',
      fieldtype: 'Currency',
      reqd: 0,
      read_only: 1,
      unique: 0,
      permlevel: 0,
      idx: 6,
    },
    // Table child — options (child doctype name) must be kept
    {
      fieldname: 'items',
      fieldtype: 'Table',
      options: 'Sales Order Item',
      reqd: 0,
      read_only: 0,
      unique: 0,
      permlevel: 0,
      idx: 7,
    },
    // fetch_from rename
    {
      fieldname: 'customer_name',
      fieldtype: 'Data',
      reqd: 0,
      read_only: 1,
      fetch_from: 'customer.customer_name',
      idx: 8,
    },
  ],
  permissions: [
    {
      role: 'Sales User',
      permlevel: 0,
      if_owner: 0,
      read: 1,
      write: 1,
      create: 1,
      submit: 0,
      cancel: 0,
      delete: 0,
      idx: 0,
    },
  ],
};

// ---------------------------------------------------------------------------
// isRealDoctype
// ---------------------------------------------------------------------------
describe('isRealDoctype', () => {
  it('returns true for a real DocType JSON', () => {
    expect(isRealDoctype({ doctype: 'DocType' })).toBe(true);
  });

  it('returns false for a DocField JSON', () => {
    expect(isRealDoctype({ doctype: 'DocField' })).toBe(false);
  });

  it('returns false when doctype key is absent', () => {
    expect(isRealDoctype({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// table derivation
// ---------------------------------------------------------------------------
describe('erpnextJsonToDef: table formula', () => {
  it('derives "tabSalesOrder" from "Sales Order"', () => {
    const def = erpnextJsonToDef(SALES_ORDER_JSON);
    expect(def.table).toBe('tabSalesOrder');
  });

  it('derives "tabCustomer" from "Customer" (no spaces)', () => {
    const def = erpnextJsonToDef({
      ...SALES_ORDER_JSON,
      name: 'Customer',
      fields: [{ fieldname: 'customer_name', fieldtype: 'Data', reqd: 1, idx: 0 }],
    });
    expect(def.table).toBe('tabCustomer');
  });
});

// ---------------------------------------------------------------------------
// Layout field exclusion
// ---------------------------------------------------------------------------
describe('mapField: layout fields', () => {
  it('returns null for a Section Break', () => {
    expect(mapField({ fieldname: 'sec', fieldtype: 'Section Break' })).toBeNull();
  });

  it('returns null for a Column Break', () => {
    expect(mapField({ fieldname: 'col', fieldtype: 'Column Break' })).toBeNull();
  });

  it('excludes layout fields from def.fields', () => {
    const def = erpnextJsonToDef(SALES_ORDER_JSON);
    const names = def.fields.map(f => f.fieldname);
    expect(names).not.toContain('order_details_section');
  });
});

// ---------------------------------------------------------------------------
// Dynamic Link: options stripped
// ---------------------------------------------------------------------------
describe('mapField: Dynamic Link options stripping (D1-3)', () => {
  it('returns options===undefined for a Dynamic Link field', () => {
    const result = mapField({
      fieldname: 'link_doctype',
      fieldtype: 'Dynamic Link',
      options: 'link_name',
      reqd: 0,
      read_only: 0,
      unique: 0,
      permlevel: 0,
      idx: 1,
    });
    expect(result).not.toBeNull();
    expect(result.options).toBeUndefined();
  });

  it('strips Dynamic Link options in the full def', () => {
    const def = erpnextJsonToDef(SALES_ORDER_JSON);
    const dlField = def.fields.find(f => f.fieldname === 'link_doctype');
    expect(dlField).toBeDefined();
    expect(dlField.options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// options kept for Link / Table / Select
// ---------------------------------------------------------------------------
describe('mapField: options retention', () => {
  it('keeps options for a Link field', () => {
    const def = erpnextJsonToDef(SALES_ORDER_JSON);
    const f = def.fields.find(f => f.fieldname === 'customer');
    expect(f.options).toBe('Customer');
  });

  it('keeps options for a Table field', () => {
    const def = erpnextJsonToDef(SALES_ORDER_JSON);
    const f = def.fields.find(f => f.fieldname === 'items');
    expect(f.options).toBe('Sales Order Item');
  });

  it('keeps options for a Select field', () => {
    const def = erpnextJsonToDef(SALES_ORDER_JSON);
    const f = def.fields.find(f => f.fieldname === 'status');
    expect(typeof f.options).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Renames: read_only → readOnly, fetch_from → fetchFrom
// ---------------------------------------------------------------------------
describe('mapField: renames', () => {
  it('renames read_only to readOnly', () => {
    const result = mapField({ fieldname: 'f', fieldtype: 'Data', read_only: 1 });
    expect(result.readOnly).toBe(true);
    expect(result).not.toHaveProperty('read_only');
  });

  it('renames fetch_from to fetchFrom', () => {
    const def = erpnextJsonToDef(SALES_ORDER_JSON);
    const f = def.fields.find(f => f.fieldname === 'customer_name');
    expect(f.fetchFrom).toBe('customer.customer_name');
    expect(f).not.toHaveProperty('fetch_from');
  });
});

// ---------------------------------------------------------------------------
// boolean coercion (!! on 0/1)
// ---------------------------------------------------------------------------
describe('mapField: boolean coercion', () => {
  it('coerces reqd=1 to true', () => {
    const result = mapField({ fieldname: 'f', fieldtype: 'Data', reqd: 1, idx: 0 });
    expect(result.reqd).toBe(true);
  });

  it('coerces reqd=0 to false', () => {
    const result = mapField({ fieldname: 'f', fieldtype: 'Data', reqd: 0, idx: 0 });
    expect(result.reqd).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertValidDef round-trip
// ---------------------------------------------------------------------------
describe('erpnextJsonToDef: assertValidDef passes', () => {
  it('output over the Sales Order fixture passes assertValidDef', () => {
    const def = erpnextJsonToDef(SALES_ORDER_JSON);
    expect(() => assertValidDef(def)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// makeStubDef — U-STUBDEF contract
// ---------------------------------------------------------------------------
describe('makeStubDef', () => {
  it('returns the exact ADR shape for a single-word name', () => {
    const def = makeStubDef('Currency');
    expect(def).toEqual({
      doctype:     'Currency',
      table:       'tabCurrency',
      isStub:      true,
      submittable: false,
      issingle:    false,
      istable:     false,
      fields:      [],
      permissions: [],
      scopeFields: [],
    });
  });

  it('applies the space-collapse table formula for a multi-word name', () => {
    expect(makeStubDef('Print Format').table).toBe('tabPrintFormat');
  });

  it('passes assertValidDef (zero-field def is structurally valid; isStub stripped harmlessly)', () => {
    expect(() => assertValidDef(makeStubDef('Currency'))).not.toThrow();
  });
});
