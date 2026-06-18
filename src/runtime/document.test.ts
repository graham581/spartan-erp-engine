import { describe, it, expect } from 'vitest';
import { MemoryStore } from './store';
import { newDoc, loadDoc, SubmittableDocument } from './document';

describe('document runtime', () => {
  it('creates a Sales Order with 2 items, reloads, submits, cancels', async () => {
    const store = new MemoryStore();

    const so = newDoc(
      'Sales Order',
      {
        name: 'SO-TEST-1',
        customer: 'CUST-1',
        company: 'Spartan VIC',
        items: [
          { item_code: 'WIN-AWN', qty: 2 },
          { item_code: 'WIN-SLD', qty: 1 },
        ],
      },
      store,
    );

    await so.insert();
    expect(so.doc.docstatus).toBe(0);

    // reload pulls the parent + child rows back
    const reloaded = await loadDoc('Sales Order', 'SO-TEST-1', store);
    const items = reloaded.doc.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0].parent).toBe('SO-TEST-1');
    expect(items[0].parenttype).toBe('Sales Order');
    expect(items[0].parentfield).toBe('items');
    expect(items[0].idx).toBe(1);
    expect(items[1].idx).toBe(2);

    // submit: docstatus 0 -> 1, persisted
    expect(reloaded).toBeInstanceOf(SubmittableDocument);
    await (reloaded as SubmittableDocument).submit();
    expect(reloaded.doc.docstatus).toBe(1);

    const afterSubmit = await loadDoc('Sales Order', 'SO-TEST-1', store);
    expect(afterSubmit.doc.docstatus).toBe(1);
    expect(afterSubmit.doc.items as unknown[]).toHaveLength(2);

    // cancel: docstatus 1 -> 2
    await (afterSubmit as SubmittableDocument).cancel();
    const afterCancel = await loadDoc('Sales Order', 'SO-TEST-1', store);
    expect(afterCancel.doc.docstatus).toBe(2);
  });

  it('persists a custom Window doctype linked to the order (autoname assigned)', async () => {
    const store = new MemoryStore();

    const win = newDoc(
      'Window',
      {
        sales_order: 'SO-TEST-1',
        item_code: 'WIN-AWN',
        window_type: 'Awning',
        width_mm: 1200,
        height_mm: 900,
      },
      store,
    );
    await win.insert();
    expect(win.doc.name).toBeTruthy();

    const reloaded = await loadDoc('Window', win.doc.name as string, store);
    expect(reloaded.doc.window_type).toBe('Awning');
    expect(reloaded.doc.width_mm).toBe(1200);
    expect(reloaded.doc.docstatus).toBe(0);
  });

  it('refuses to submit a non-draft and to cancel a non-submitted', async () => {
    const store = new MemoryStore();
    const so = newDoc('Sales Order', { name: 'SO-2', items: [] }, store) as SubmittableDocument;
    await so.insert();

    await expect(so.cancel()).rejects.toThrow(); // can't cancel a draft
    await so.submit();
    await expect(so.submit()).rejects.toThrow(); // can't submit twice
  });
});
