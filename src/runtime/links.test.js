import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { registerDoctype, _resetRegistry } from '../meta/registry.js';
import { resolveFetchFrom, validateLinks } from './links.js';
import { ValidationError } from './errors.js';

const orderMeta = {
  doctype: 'Sales Order',
  table: 'tabSalesOrder',
  fields: [
    { fieldname: 'customer', fieldtype: 'Link', options: 'Customer' },
    { fieldname: 'territory', fieldtype: 'Data', fetchFrom: 'customer.territory' },
  ],
  childTables: [],
};

describe('links', () => {
  /** @type {MemoryStore} */
  let store;
  beforeEach(() => {
    _resetRegistry();
    registerDoctype({ doctype: 'Customer', table: 'tabCustomer', fields: [{ fieldname: 'territory', fieldtype: 'Data' }], childTables: [] });
    store = new MemoryStore();
  });

  it('fetch_from copies a value from the linked doc', async () => {
    await store.insert('tabCustomer', { name: 'CUST-1', territory: 'VIC' });
    const doc = { customer: 'CUST-1' };
    await resolveFetchFrom(orderMeta, doc, store);
    expect(doc.territory).toBe('VIC');
  });

  it('validateLinks throws on a missing linked record', async () => {
    await expect(validateLinks(orderMeta, { customer: 'NOPE' }, store)).rejects.toBeInstanceOf(ValidationError);
  });

  it('validateLinks passes when the link exists', async () => {
    await store.insert('tabCustomer', { name: 'CUST-1', territory: 'VIC' });
    await expect(validateLinks(orderMeta, { customer: 'CUST-1' }, store)).resolves.toBeUndefined();
  });

  it('validateLinks skips a link whose target doctype is not registered', async () => {
    const m = { doctype: 'X', table: 'tabX', fields: [{ fieldname: 'item', fieldtype: 'Link', options: 'Item' }], childTables: [] };
    await expect(validateLinks(m, { item: 'WHATEVER' }, store)).resolves.toBeUndefined();
  });

  // [CRIT-5] Soft-link guard — 3-case matrix
  //
  // U-MARKER has landed Meta.isStub, so registerDoctype({ isStub:true }) is now persisted
  // through the Meta constructor and readable via getMeta(doctype).isStub.

  describe('soft-link guard [CRIT-5]', () => {
    it('[CRIT-5a] stub target: non-existent value resolves and store.get is NOT called for that field', async () => {
      // Register Currency as a stub (no rows in store)
      registerDoctype({ doctype: 'Currency', table: 'tabCurrency', fields: [], childTables: [], isStub: true });
      const m = {
        doctype: 'Sales Order',
        table: 'tabSalesOrder',
        fields: [{ fieldname: 'currency', fieldtype: 'Link', options: 'Currency' }],
        childTables: [],
      };
      const getSpy = vi.spyOn(store, 'get');
      await expect(validateLinks(m, { currency: 'MISSING-CURRENCY' }, store)).resolves.toBeUndefined();
      // store.get must not have been called for the stub target's table
      const callsForStubTable = getSpy.mock.calls.filter(([table]) => table === 'tabCurrency');
      expect(callsForStubTable).toHaveLength(0);
      getSpy.mockRestore();
    });

    it('[CRIT-5b] full target enforces existence: non-existent value throws ValidationError', async () => {
      // Customer is registered as full (isStub:false, default) in beforeEach — no matching row
      await expect(validateLinks(orderMeta, { customer: 'NO-SUCH-CUSTOMER' }, store)).rejects.toBeInstanceOf(ValidationError);
    });

    it('[CRIT-5c] two Links — stub accepts bad value, full throws for its bad value only', async () => {
      // Register UoM as stub; Customer (full) already in registry from beforeEach
      registerDoctype({ doctype: 'UoM', table: 'tabUoM', fields: [], childTables: [], isStub: true });
      const m = {
        doctype: 'Quotation',
        table: 'tabQuotation',
        fields: [
          { fieldname: 'uom',      fieldtype: 'Link', options: 'UoM'      }, // stub — bad value accepted
          { fieldname: 'customer', fieldtype: 'Link', options: 'Customer' }, // full — bad value throws
        ],
        childTables: [],
      };
      // No Customer row in store — must throw for the full target, not for the stub
      await expect(validateLinks(m, { uom: 'NO-SUCH-UOM', customer: 'NO-SUCH-CUST' }, store)).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
