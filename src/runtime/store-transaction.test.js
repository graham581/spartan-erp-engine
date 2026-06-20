import { describe, it, expect, vi } from 'vitest';
import { Store } from './store.js';
import { MemoryStore } from './memory-store.js';
import { SupabaseStore } from './supabase-store.js';

describe('base Store.transaction', () => {
  it('resolves fn(this) — pass-through', async () => {
    const s = new Store();
    const result = await s.transaction(async (txStore) => txStore);
    expect(result).toBe(s);
  });

  it('supportsTransactions is false on the base', () => {
    expect(new Store().supportsTransactions).toBe(false);
  });
});

describe('MemoryStore transaction', () => {
  it('supportsTransactions === true', () => {
    expect(new MemoryStore().supportsTransactions).toBe(true);
  });

  it('transaction passes the same store (inherited pass-through)', async () => {
    const s = new MemoryStore();
    const result = await s.transaction(async (txStore) => txStore);
    expect(result).toBe(s);
  });

  it('does NOT define its own transaction method (inherits base)', () => {
    // The MemoryStore prototype should not have transaction defined directly
    expect(Object.prototype.hasOwnProperty.call(MemoryStore.prototype, 'transaction')).toBe(false);
  });
});

describe('SupabaseStore transaction', () => {
  const makeSbStore = () => new SupabaseStore({ rpc: vi.fn() });

  it('supportsTransactions === false', () => {
    expect(makeSbStore().supportsTransactions).toBe(false);
  });

  it('transaction throws with /no transactions/ and does NOT call fn', async () => {
    const s = makeSbStore();
    const fn = vi.fn();
    await expect(s.transaction(fn)).rejects.toThrow(/no transactions/);
    expect(fn).not.toHaveBeenCalled();
  });
});
