import { describe, it, expect, beforeAll } from 'vitest';
import { MemoryStore, type DataStore } from '../runtime/store';
import { newDoc, loadDoc, SubmittableDocument } from '../runtime/document';
import { registerControllers } from './index';

beforeAll(() => registerControllers());

function makeSO(store: DataStore, overrides: Record<string, unknown> = {}) {
  return newDoc(
    'Sales Order',
    {
      customer: 'CUST-1',
      company: 'Spartan VIC',
      transaction_date: '2026-06-18',
      items: [
        { item_code: 'WIN-AWN', qty: 2, rate: 500 },
        { item_code: 'WIN-SLD', qty: 1, rate: 300 },
      ],
      ...overrides,
    },
    store,
  );
}

describe('SalesOrder controller', () => {
  it('routes Sales Order through the SalesOrder controller via the registry', () => {
    const so = makeSO(new MemoryStore());
    expect(so.constructor.name).toBe('SalesOrder');
  });

  it('computes line amounts and header totals on insert', async () => {
    const store = new MemoryStore();
    const so = makeSO(store);
    await so.insert();
    expect((so.doc.items as Array<Record<string, unknown>>)[0].amount).toBe(1000);
    expect(so.doc.total_qty).toBe(3);
    expect(so.doc.total).toBe(1300);
    expect(so.doc.grand_total).toBe(1300);
    expect(so.doc.status).toBe('Draft');
  });

  it('rejects an order with no items', async () => {
    const so = makeSO(new MemoryStore(), { items: [] });
    await expect(so.insert()).rejects.toThrow(/at least one item/);
  });

  it('rejects a line with non-positive qty', async () => {
    const so = makeSO(new MemoryStore(), { items: [{ item_code: 'X', qty: 0, rate: 10 }] });
    await expect(so.insert()).rejects.toThrow(/Qty must be greater than 0/);
  });

  it('requires a customer', async () => {
    const so = makeSO(new MemoryStore(), { customer: undefined });
    await expect(so.insert()).rejects.toThrow(/Customer is required/);
  });

  it('rejects a delivery date before the transaction date', async () => {
    const so = makeSO(new MemoryStore(), {
      transaction_date: '2026-06-18',
      delivery_date: '2026-06-01',
    });
    await expect(so.insert()).rejects.toThrow(/Delivery Date cannot be before/);
  });

  it('transitions status on submit and cancel (persisted)', async () => {
    const store = new MemoryStore();
    const so = (await makeSO(store).insert()) as SubmittableDocument;

    await so.submit();
    expect(so.doc.docstatus).toBe(1);
    let reloaded = await loadDoc('Sales Order', so.doc.name as string, store);
    expect(reloaded.doc.status).toBe('To Deliver and Bill');

    await (reloaded as SubmittableDocument).cancel();
    reloaded = await loadDoc('Sales Order', so.doc.name as string, store);
    expect(reloaded.doc.docstatus).toBe(2);
    expect(reloaded.doc.status).toBe('Cancelled');
  });
});
