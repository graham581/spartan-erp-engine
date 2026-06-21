// form-view.test.js — node-env, no DOM
// Guards the pure buildSubmitRecord contract (DC3, C1, C2).
// DOM rendering is verified by the live proof (Playwright not installed in v1).

import { describe, it, expect } from 'vitest';
import { buildSubmitRecord } from './form-view.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCALAR_FIELDS = [
  { fieldname: 'title',    fieldtype: 'Data'    },
  { fieldname: 'status',   fieldtype: 'Select'  },
  { fieldname: 'customer', fieldtype: 'Link'    },
];

// Reserved keys that must never appear in the output.
const RESERVED_KEYS = ['owner', 'docstatus', 'name', 'is_stub'];

// ---------------------------------------------------------------------------
// buildSubmitRecord — scalar-only cases
// ---------------------------------------------------------------------------

describe('buildSubmitRecord — scalar fields', () => {
  it('keys scalar values by fieldname', () => {
    const scalarValues = { title: 'My Doc', status: 'Open', customer: 'CUST-001' };
    const record = buildSubmitRecord(SCALAR_FIELDS, scalarValues, []);
    expect(record.title).toBe('My Doc');
    expect(record.status).toBe('Open');
    expect(record.customer).toBe('CUST-001');
  });

  it('omits fields whose fieldname has no value in scalarValues', () => {
    const scalarValues = { title: 'X' }; // status, customer absent
    const record = buildSubmitRecord(SCALAR_FIELDS, scalarValues, []);
    expect(record.title).toBe('X');
    expect('status' in record).toBe(false);
    expect('customer' in record).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSubmitRecord — reserved key stripping (DC3, §1 invariant 1)
// ---------------------------------------------------------------------------

describe('buildSubmitRecord — reserved keys stripped', () => {
  for (const key of RESERVED_KEYS) {
    it(`strips reserved key "${key}" from scalarValues`, () => {
      const fields = [{ fieldname: key, fieldtype: 'Data' }];
      const scalarValues = { [key]: 'should-not-appear' };
      const record = buildSubmitRecord(fields, scalarValues, []);
      expect(key in record).toBe(false);
    });
  }

  it('strips all four reserved keys simultaneously', () => {
    const fields = [
      ...SCALAR_FIELDS,
      ...RESERVED_KEYS.map((k) => ({ fieldname: k, fieldtype: 'Data' })),
    ];
    const scalarValues = {
      title: 'Test',
      status: 'Open',
      customer: 'C-1',
      owner: 'admin',
      docstatus: 1,
      name: 'DOC-001',
      is_stub: true,
    };
    const record = buildSubmitRecord(fields, scalarValues, []);
    for (const key of RESERVED_KEYS) {
      expect(key in record).toBe(false);
    }
    expect(record.title).toBe('Test');
  });
});

// ---------------------------------------------------------------------------
// buildSubmitRecord — child grids embedded under field (DC3, C1)
// ---------------------------------------------------------------------------

describe('buildSubmitRecord — child grids under childTableDef.field (C1)', () => {
  it('embeds child rows under field ("items"), NOT under doctype ("Quote Item")', () => {
    const childTableDef = { field: 'items', doctype: 'Quote Item', table: 'tabQuote Item' };
    const row1 = { qty: 2, rate: 100 };
    const row2 = { qty: 1, rate: 200 };

    const mockGrid = { collect: () => [row1, row2] };
    const record = buildSubmitRecord([], {}, [{ def: childTableDef, grid: mockGrid }]);

    // Rows are under the field name, not the doctype.
    expect(Array.isArray(record.items)).toBe(true);
    expect(record.items).toHaveLength(2);
    expect(record.items[0]).toEqual(row1);
    expect(record.items[1]).toEqual(row2);

    // Doctype should NOT appear as a key.
    expect('Quote Item' in record).toBe(false);
  });

  it('embeds rows from multiple child grids each under their own field', () => {
    const def1 = { field: 'items',    doctype: 'Quote Item',    table: 'tabQuote Item'    };
    const def2 = { field: 'taxes',    doctype: 'Sales Tax',     table: 'tabSales Tax'     };

    const grid1 = { collect: () => [{ qty: 1 }] };
    const grid2 = { collect: () => [{ percent: 10 }] };

    const record = buildSubmitRecord([], {}, [
      { def: def1, grid: grid1 },
      { def: def2, grid: grid2 },
    ]);

    expect(record.items).toEqual([{ qty: 1 }]);
    expect(record.taxes).toEqual([{ percent: 10 }]);
    expect('Quote Item' in record).toBe(false);
    expect('Sales Tax' in record).toBe(false);
  });

  it('skips a child grid whose field is a reserved key', () => {
    // Defensive: should never happen in practice, but the guard is specified.
    const def = { field: 'owner', doctype: 'SomeChild', table: 'tabSomeChild' };
    const grid = { collect: () => [{ x: 1 }] };
    const record = buildSubmitRecord([], {}, [{ def, grid }]);
    expect('owner' in record).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSubmitRecord — combined scalar + child
// ---------------------------------------------------------------------------

describe('buildSubmitRecord — scalar + child combined', () => {
  it('produces a flat record with both scalar fields and child arrays', () => {
    const fields = [
      { fieldname: 'title',  fieldtype: 'Data'  },
      { fieldname: 'branch', fieldtype: 'Select' },
    ];
    const scalarValues = { title: 'My Quote', branch: 'VIC' };
    const def = { field: 'items', doctype: 'Quote Item', table: 'tabQuote Item' };
    const grid = { collect: () => [{ qty: 3, rate: 50 }] };

    const record = buildSubmitRecord(fields, scalarValues, [{ def, grid }]);

    expect(record.title).toBe('My Quote');
    expect(record.branch).toBe('VIC');
    expect(record.items).toEqual([{ qty: 3, rate: 50 }]);
    // No reserved keys
    for (const key of RESERVED_KEYS) {
      expect(key in record).toBe(false);
    }
  });
});
