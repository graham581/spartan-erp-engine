import { describe, it, expect, vi } from 'vitest';
import { Store } from './store.js';
import { MemoryStore } from './memory-store.js';
import { SupabaseStore } from './supabase-store.js';
import { nextSeries } from './naming.js';

describe('Store.nextSeries base', () => {
  it('base Store.nextSeries() resolves null (fallback contract)', async () => {
    const s = new Store();
    await expect(s.nextSeries('SO-')).resolves.toBeNull();
  });
});

describe('MemoryStore.nextSeries', () => {
  it('returns 1 then 2 then 3 on repeated calls', async () => {
    const s = new MemoryStore();
    expect(await s.nextSeries('SO-')).toBe(1);
    expect(await s.nextSeries('SO-')).toBe(2);
    expect(await s.nextSeries('SO-')).toBe(3);
  });

  it('keeps separate counters per prefix', async () => {
    const s = new MemoryStore();
    expect(await s.nextSeries('SO-')).toBe(1);
    expect(await s.nextSeries('INV-')).toBe(1);
    expect(await s.nextSeries('SO-')).toBe(2);
  });
});

describe('naming.nextSeries with MemoryStore (fast path)', () => {
  it('yields SO-00001 then SO-00002 (width-padded)', async () => {
    const store = new MemoryStore();
    expect(await nextSeries('SO-.#####', store)).toBe('SO-00001');
    expect(await nextSeries('SO-.#####', store)).toBe('SO-00002');
  });
});

describe('naming fallback to read-inc-write when store.nextSeries returns null', () => {
  it('uses read-inc-write when nextSeries() returns null', async () => {
    // Stub: a store whose nextSeries always returns null, but has get/insert/update
    const stub = {
      nextSeries: async () => null,
      get: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ name: 'SO-', current: 1 }),
      update: vi.fn(),
    };
    const result = await nextSeries('SO-.#####', stub);
    expect(result).toBe('SO-00001');
    expect(stub.get).toHaveBeenCalledWith('tab_series', 'SO-');
    expect(stub.insert).toHaveBeenCalledWith('tab_series', { name: 'SO-', current: 1 });
  });
});

describe('SupabaseStore.nextSeries (hermetic)', () => {
  it('calls rpc(next_series, {prefix}) and returns the number', async () => {
    const fakeRpc = vi.fn().mockResolvedValue({ data: 7, error: null });
    const fakeSb = { rpc: fakeRpc };
    const store = new SupabaseStore(fakeSb);
    const result = await store.nextSeries('INV-');
    expect(result).toBe(7);
    expect(fakeRpc).toHaveBeenCalledWith('next_series', { prefix: 'INV-' });
  });

  it('throws on rpc error', async () => {
    const fakeSb = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'bad' } }) };
    const store = new SupabaseStore(fakeSb);
    await expect(store.nextSeries('X-')).rejects.toThrow('SupabaseStore.nextSeries X-: bad');
  });
});
