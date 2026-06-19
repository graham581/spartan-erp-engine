import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { registerDoctype, _resetRegistry } from '../meta/registry.js';
import { newDoc, loadDoc, SubmittableDocument } from './document.js';
import { StateError } from './errors.js';

function seedDoctypes() {
  registerDoctype({
    doctype: 'Sales Order',
    table: 'tabSalesOrder',
    submittable: true,
    autoname: 'hash',
    fields: [
      { fieldname: 'customer', fieldtype: 'Link', options: 'Customer', reqd: true },
      { fieldname: 'total', fieldtype: 'Currency' },
      { fieldname: 'items', fieldtype: 'Table', options: 'Sales Order Item' },
    ],
    childTables: [{ field: 'items', doctype: 'Sales Order Item', table: 'tabSalesOrderItem' }],
  });
  registerDoctype({
    doctype: 'Sales Order Item',
    table: 'tabSalesOrderItem',
    fields: [
      { fieldname: 'item', fieldtype: 'Link', options: 'Item', reqd: true },
      { fieldname: 'qty', fieldtype: 'Int', reqd: true },
      { fieldname: 'rate', fieldtype: 'Currency' },
    ],
    childTables: [],
  });
}

describe('Document runtime', () => {
  /** @type {MemoryStore} */
  let store;
  beforeEach(() => {
    _resetRegistry();
    seedDoctypes();
    store = new MemoryStore();
  });

  it('inserts a doc with child rows and loads them back in order', async () => {
    const doc = newDoc(
      'Sales Order',
      { customer: 'CUST-1', total: 300, items: [{ item: 'A', qty: 2, rate: 100 }, { item: 'B', qty: 1, rate: 100 }] },
      store,
    );
    await doc.insert();
    expect(doc.doc.name).toBeTruthy();
    expect(doc.doc.docstatus).toBe(0);

    const loaded = await loadDoc('Sales Order', doc.doc.name, store);
    expect(loaded.doc.customer).toBe('CUST-1');
    expect(loaded.doc.items).toHaveLength(2);
    expect(loaded.doc.items[0].parent).toBe(doc.doc.name);
    expect(loaded.doc.items[0].parentfield).toBe('items');
    expect(loaded.doc.items[0].idx).toBe(1);
    expect(loaded.doc.items[1].idx).toBe(2);
  });

  it('builds a SubmittableDocument for a submittable doctype', () => {
    const doc = newDoc('Sales Order', { customer: 'C' }, store);
    expect(doc).toBeInstanceOf(SubmittableDocument);
  });

  it('submits 0->1 and cancels 1->2', async () => {
    const doc = newDoc('Sales Order', { customer: 'C', items: [{ item: 'A', qty: 1 }] }, store);
    await doc.insert();
    await doc.submit();
    expect(doc.doc.docstatus).toBe(1);
    await doc.cancel();
    expect(doc.doc.docstatus).toBe(2);
  });

  it('rejects illegal lifecycle transitions', async () => {
    const doc = newDoc('Sales Order', { customer: 'C' }, store);
    await doc.insert();
    await expect(doc.cancel()).rejects.toBeInstanceOf(StateError); // cancel before submit
    await doc.submit();
    await expect(doc.submit()).rejects.toBeInstanceOf(StateError); // double submit
  });

  it('replaces child rows wholesale on save', async () => {
    const doc = newDoc('Sales Order', { customer: 'C', items: [{ item: 'A', qty: 1 }] }, store);
    await doc.insert();
    doc.doc.items = [{ item: 'B', qty: 5 }];
    await doc.save();

    const loaded = await loadDoc('Sales Order', doc.doc.name, store);
    expect(loaded.doc.items).toHaveLength(1);
    expect(loaded.doc.items[0].item).toBe('B');
    expect(loaded.doc.items[0].qty).toBe(5);
  });
});
