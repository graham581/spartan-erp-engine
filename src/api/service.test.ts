import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../runtime/store';
import { createSalesOrder, getSalesOrder, transitionSalesOrder } from './service';

describe('api service (MemoryStore — no Supabase needed)', () => {
  it('create -> get -> submit -> cancel', async () => {
    const store = new MemoryStore();

    const created = await createSalesOrder(
      {
        customer: 'CUST-1',
        company: 'Spartan VIC',
        items: [{ item_code: 'WIN-AWN', qty: 2, rate: 100 }],
      },
      store,
    );
    expect(created.total).toBe(200);
    expect(created.status).toBe('Draft');
    const name = created.name as string;

    const got = await getSalesOrder(name, store);
    expect(got.name).toBe(name);

    const submitted = await transitionSalesOrder(name, 'submit', store);
    expect(submitted.docstatus).toBe(1);
    expect(submitted.status).toBe('To Deliver and Bill');

    const cancelled = await transitionSalesOrder(name, 'cancel', store);
    expect(cancelled.docstatus).toBe(2);
    expect(cancelled.status).toBe('Cancelled');
  });

  it('propagates validation errors from the controller', async () => {
    const store = new MemoryStore();
    await expect(createSalesOrder({ company: 'X', items: [] }, store)).rejects.toThrow(
      /Customer is required/,
    );
  });

  it('404-style error when loading a missing order', async () => {
    const store = new MemoryStore();
    await expect(getSalesOrder('NOPE', store)).rejects.toThrow(/not found/i);
  });
});
