import { describe, it, expect } from 'vitest';
import { validateAgainstMeta } from './validate.js';

// Minimal stub store — not needed for these tests.
const noStore = undefined;

// ---------------------------------------------------------------------------
// mandatoryDependsOn — conditional required
// ---------------------------------------------------------------------------
describe('validateAgainstMeta — mandatoryDependsOn', () => {
  const meta = {
    doctype: 'TestDoc',
    table: 'test_docs',
    fields: [
      {
        fieldname: 'mode',
        fieldtype: 'Data',
        reqd: 0,
      },
      {
        fieldname: 'extra',
        fieldtype: 'Data',
        reqd: 0,
        // required only when mode === 'advanced'
        mandatoryDependsOn: { field: 'mode', op: 'eq', value: 'advanced' },
      },
    ],
  };

  it('mandatoryDependsOn resolves true → required when empty → throws', async () => {
    const doc = { name: 'X', mode: 'advanced', extra: '' };
    await expect(validateAgainstMeta(meta, doc, noStore)).rejects.toThrow(
      /TestDoc.*'extra' is required/
    );
  });

  it('mandatoryDependsOn resolves false → not required even when empty → no throw', async () => {
    const doc = { name: 'X', mode: 'basic', extra: '' };
    await expect(validateAgainstMeta(meta, doc, noStore)).resolves.toBeUndefined();
  });

  it('mandatoryDependsOn resolves true but field has a value → no throw', async () => {
    const doc = { name: 'X', mode: 'advanced', extra: 'some value' };
    await expect(validateAgainstMeta(meta, doc, noStore)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dependsOn — relevance gate (field skipped entirely when not relevant)
// ---------------------------------------------------------------------------
describe('validateAgainstMeta — dependsOn relevance gate', () => {
  const meta = {
    doctype: 'TestDoc',
    table: 'test_docs',
    fields: [
      {
        fieldname: 'status',
        fieldtype: 'Data',
        reqd: 0,
      },
      {
        fieldname: 'reason',
        fieldtype: 'Data',
        reqd: 1, // would normally be required
        // only relevant when status === 'rejected'
        dependsOn: { field: 'status', op: 'eq', value: 'rejected' },
      },
    ],
  };

  it('dependsOn resolves false → field skipped even if reqd=1 → no throw', async () => {
    const doc = { name: 'X', status: 'approved', reason: '' };
    await expect(validateAgainstMeta(meta, doc, noStore)).resolves.toBeUndefined();
  });

  it('dependsOn resolves true + reqd + empty → throws', async () => {
    const doc = { name: 'X', status: 'rejected', reason: '' };
    await expect(validateAgainstMeta(meta, doc, noStore)).rejects.toThrow(
      /TestDoc.*'reason' is required/
    );
  });

  it('dependsOn resolves true + reqd + value present → no throw', async () => {
    const doc = { name: 'X', status: 'rejected', reason: 'wrong item' };
    await expect(validateAgainstMeta(meta, doc, noStore)).resolves.toBeUndefined();
  });

  it('relevance gate fires BEFORE required check (order matters)', async () => {
    // Even a field with reqd:1 must be skipped when dependsOn is false.
    // This is a belt-and-suspenders assertion identical to the first case
    // but documents the ordering requirement explicitly.
    const doc = { name: 'X', status: 'pending', reason: null };
    await expect(validateAgainstMeta(meta, doc, noStore)).resolves.toBeUndefined();
  });
});
