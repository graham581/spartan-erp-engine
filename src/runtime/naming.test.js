import { describe, it, expect } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { resolveName, nextSeries } from './naming.js';

const meta = (autoname) => ({ doctype: 'X', table: 'tabX', autoname, fields: [], childTables: [] });

describe('naming', () => {
  it('field: autoname uses the field value', async () => {
    const name = await resolveName(meta('field:code'), { code: 'ACME' }, new MemoryStore());
    expect(name).toBe('ACME');
  });

  it('falls back to hash when the naming field is empty', async () => {
    const name = await resolveName(meta('field:code'), {}, new MemoryStore());
    expect(name).toMatch(/^tabX-/);
  });

  it('naming series increments per prefix', async () => {
    const store = new MemoryStore();
    const m = meta('SO-.#####');
    expect(await resolveName(m, {}, store)).toBe('SO-00001');
    expect(await resolveName(m, {}, store)).toBe('SO-00002');
    expect(await resolveName(m, {}, store)).toBe('SO-00003');
  });

  it('honours width and prefix', async () => {
    const store = new MemoryStore();
    expect(await nextSeries('INV-.###', store)).toBe('INV-001');
    expect(await nextSeries('INV-.###', store)).toBe('INV-002');
  });

  it('keeps separate counters per prefix', async () => {
    const store = new MemoryStore();
    expect(await nextSeries('A-.##', store)).toBe('A-01');
    expect(await nextSeries('B-.##', store)).toBe('B-01');
    expect(await nextSeries('A-.##', store)).toBe('A-02');
  });
});
