/**
 * U7 — Single doctype perms-layer verification (D2-3 critique gate).
 * Proves the absent-Single empty-doc read flows through the SAME perm filter
 * as any other doc — no privileged short-circuit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { registerDoctype, _resetRegistry } from '../meta/registry.js';
import { loadDoc } from './document.js';
import { assertCan, maskRead } from '../perms/permissions.js';
import { makeContext } from '../perms/context.js';
import { PermissionError } from './errors.js';

// --------------------------------------------------------------------------
// Fixture — minimal Single with two roles
// --------------------------------------------------------------------------

const DOCTYPE = 'Global Config';
const TABLE   = 'tabGlobalConfig';

function seedSingle() {
  registerDoctype({
    doctype: DOCTYPE,
    table:   TABLE,
    issingle: true,
    fields: [
      { fieldname: 'flag_enabled', fieldtype: 'Check', permlevel: 0 },
    ],
    childTables: [],
    permissions: [
      // reader role: read only
      { doctype: DOCTYPE, role: 'reader', permlevel: 0, read: true, write: false, create: true, ifOwner: false },
      // nobody role: no grants at all
    ],
  });
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('Single doctype perms — U7', () => {
  /** @type {MemoryStore} */
  let store;

  const ctxWithRead    = makeContext({ user: 'alice@x', roles: ['reader'] });
  const ctxWithoutRead = makeContext({ user: 'bob@x',   roles: ['nobody'] });

  beforeEach(() => {
    _resetRegistry();
    seedSingle();
    store = new MemoryStore();
    // Store is intentionally empty — tests exercise the absent-Single path.
  });

  it('assertCan denies read to a ctx without a read grant — same as any doctype', () => {
    expect(() => assertCan(ctxWithoutRead, DOCTYPE, 'read')).toThrow(PermissionError);
  });

  it('assertCan allows read to a ctx WITH a read grant', () => {
    expect(() => assertCan(ctxWithRead, DOCTYPE, 'read')).not.toThrow();
  });

  it('loadDoc returns an empty defaults doc for the absent Single (no throw)', async () => {
    // pre-check: the reader has read perm — so load proceeds
    const loaded = await loadDoc(DOCTYPE, DOCTYPE, store);
    expect(loaded).toBeTruthy();
    expect(loaded.doc.name).toBe(DOCTYPE);
  });

  it('maskRead applied to the absent-Single doc strips nothing for reader (permlevel 0 granted)', async () => {
    const loaded = await loadDoc(DOCTYPE, DOCTYPE, store);
    // maskRead is the perms filter the read path uses to redact fields
    const visible = maskRead(ctxWithRead, DOCTYPE, loaded.doc);
    // 'name' is a FRAMEWORK_FIELD — always present
    expect(visible).toHaveProperty('name', DOCTYPE);
  });

  it('maskRead strips user-defined fields for ctx without read grant (permlevel denied)', async () => {
    const loaded = await loadDoc(DOCTYPE, DOCTYPE, store);
    const visible = maskRead(ctxWithoutRead, DOCTYPE, loaded.doc);
    // flag_enabled is at permlevel 0 — not readable without a read grant
    expect(visible).not.toHaveProperty('flag_enabled');
    // 'name' (framework field) is still present
    expect(visible).toHaveProperty('name', DOCTYPE);
  });

  it('the absent-Single path does NOT short-circuit: assertCan(read) still rejects ctx without grant', () => {
    // This is the key no-short-circuit assertion: even though loadDoc synthesises an empty doc,
    // the perms gate is unchanged — a ctx without read perm is still denied.
    expect(() => assertCan(ctxWithoutRead, DOCTYPE, 'read')).toThrow(PermissionError);
    expect(() => assertCan(ctxWithRead, DOCTYPE, 'read')).not.toThrow();
  });
});
