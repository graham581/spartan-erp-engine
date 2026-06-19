import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { registerDoctype, _resetRegistry } from '../meta/registry.js';
import { newDoc } from './document.js';
import { StateError } from './errors.js';

describe('docstatus immutability + series naming', () => {
  /** @type {MemoryStore} */
  let store;
  beforeEach(() => {
    _resetRegistry();
    registerDoctype({
      doctype: 'Invoice',
      table: 'tabInvoice',
      submittable: true,
      autoname: 'INV-.#####',
      fields: [{ fieldname: 'amount', fieldtype: 'Currency', reqd: true }],
      childTables: [],
    });
    store = new MemoryStore();
  });

  it('names via the series', async () => {
    const doc = newDoc('Invoice', { amount: 100 }, store);
    await doc.insert();
    expect(doc.doc.name).toBe('INV-00001');
  });

  it('blocks edits to a submitted document', async () => {
    const doc = newDoc('Invoice', { amount: 100 }, store);
    await doc.insert();
    await doc.submit();
    doc.doc.amount = 999;
    await expect(doc.save()).rejects.toBeInstanceOf(StateError);
  });

  it('blocks edits to a cancelled document', async () => {
    const doc = newDoc('Invoice', { amount: 100 }, store);
    await doc.insert();
    await doc.submit();
    await doc.cancel();
    doc.doc.amount = 5;
    await expect(doc.save()).rejects.toBeInstanceOf(StateError);
  });

  it('still allows the submit and cancel transitions themselves', async () => {
    const doc = newDoc('Invoice', { amount: 100 }, store);
    await doc.insert();
    await doc.submit();
    expect(doc.doc.docstatus).toBe(1);
    await doc.cancel();
    expect(doc.doc.docstatus).toBe(2);
  });
});
