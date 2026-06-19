import { describe, it, expect, beforeEach } from 'vitest';
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
});
