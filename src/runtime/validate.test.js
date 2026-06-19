import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { validateAgainstMeta } from './validate.js';
import { ValidationError } from './errors.js';

const meta = {
  doctype: 'Widget',
  table: 'tabWidget',
  fields: [
    { fieldname: 'title', fieldtype: 'Data', reqd: true },
    { fieldname: 'kind', fieldtype: 'Select', options: ['a', 'b', 'c'] },
    { fieldname: 'qty', fieldtype: 'Int' },
    { fieldname: 'sku', fieldtype: 'Data', unique: true },
  ],
  childTables: [],
};

describe('validateAgainstMeta', () => {
  /** @type {MemoryStore} */
  let store;
  beforeEach(() => { store = new MemoryStore(); });

  it('passes a valid doc', async () => {
    await expect(validateAgainstMeta(meta, { title: 'T', kind: 'a', qty: 3 }, store)).resolves.toBeUndefined();
  });

  it('rejects a missing required field', async () => {
    await expect(validateAgainstMeta(meta, { kind: 'a' }, store)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a Select value not in options', async () => {
    await expect(validateAgainstMeta(meta, { title: 'T', kind: 'z' }, store)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a non-numeric Int', async () => {
    await expect(validateAgainstMeta(meta, { title: 'T', qty: 'five' }, store)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a duplicate unique value', async () => {
    await store.insert('tabWidget', { name: 'W1', sku: 'X' });
    await expect(validateAgainstMeta(meta, { name: 'W2', title: 'T', sku: 'X' }, store)).rejects.toBeInstanceOf(ValidationError);
  });

  it('allows the same unique value on the same record', async () => {
    await store.insert('tabWidget', { name: 'W1', sku: 'X' });
    await expect(validateAgainstMeta(meta, { name: 'W1', title: 'T', sku: 'X' }, store)).resolves.toBeUndefined();
  });
});
