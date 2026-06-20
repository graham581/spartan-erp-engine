/**
 * U6 — Single doctype regression suite (D2-2).
 * Verifies: duplicate-row prevention, Meta.issingle, naming, absent-Single empty doc.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { registerDoctype, getMeta, _resetRegistry } from '../meta/registry.js';
import { newDoc, loadDoc } from './document.js';
import { NotFoundError } from './errors.js';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const SETTINGS_DOCTYPE = 'System Settings';
const SETTINGS_TABLE   = 'tabSystemSettings';

function seedSettings() {
  registerDoctype({
    doctype: SETTINGS_DOCTYPE,
    table:   SETTINGS_TABLE,
    issingle: true,
    fields: [
      { fieldname: 'site_name',    fieldtype: 'Data' },
      { fieldname: 'max_sessions', fieldtype: 'Int'  },
    ],
    childTables: [],
    permissions: [
      { doctype: SETTINGS_DOCTYPE, role: 'Administrator', read: true, write: true, create: true, permlevel: 0, ifOwner: false },
    ],
  });
}

function seedNormal() {
  registerDoctype({
    doctype:  'Customer',
    table:    'tabCustomer',
    issingle: false,
    autoname: 'hash',
    fields:   [{ fieldname: 'name_field', fieldtype: 'Data' }],
    childTables: [],
    permissions: [],
  });
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('Single doctype — U6', () => {
  /** @type {MemoryStore} */
  let store;

  beforeEach(() => {
    _resetRegistry();
    seedSettings();
    seedNormal();
    store = new MemoryStore();
  });

  it('Meta.issingle is true for a Single, false for a normal doctype', () => {
    expect(getMeta(SETTINGS_DOCTYPE).issingle).toBe(true);
    expect(getMeta('Customer').issingle).toBe(false);
  });

  it('saving a Single twice leaves exactly one row whose name === doctype (D2-2 regression)', async () => {
    // first save — no name on the payload
    const doc1 = newDoc(SETTINGS_DOCTYPE, { site_name: 'Spartan', max_sessions: 5 }, store);
    await doc1.save();

    expect(doc1.doc.name).toBe(SETTINGS_DOCTYPE);

    // second save — update values, same Single
    const doc2 = newDoc(SETTINGS_DOCTYPE, { name: SETTINGS_DOCTYPE, site_name: 'Spartan v2', max_sessions: 10 }, store);
    await doc2.save();

    const rows = await store.list(SETTINGS_TABLE);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(SETTINGS_DOCTYPE);
    expect(rows[0].site_name).toBe('Spartan v2');
  });

  it('saving a Single never produces a tab…-<hash> name', async () => {
    const doc = newDoc(SETTINGS_DOCTYPE, { site_name: 'x' }, store);
    await doc.save();
    expect(doc.doc.name).toBe(SETTINGS_DOCTYPE);
    expect(doc.doc.name).not.toMatch(/^tabSystemSettings-[0-9a-f]{8}$/);
  });

  it('insert() on a Single also pins the name to the doctype', async () => {
    const doc = newDoc(SETTINGS_DOCTYPE, { site_name: 'boot' }, store);
    await doc.insert();
    expect(doc.doc.name).toBe(SETTINGS_DOCTYPE);
  });

  it('reading an absent Single returns an empty doc (defaults), not a throw', async () => {
    // Store is empty — no row for System Settings yet.
    const loaded = await loadDoc(SETTINGS_DOCTYPE, SETTINGS_DOCTYPE, store);
    expect(loaded).toBeTruthy();
    expect(loaded.doc.name).toBe(SETTINGS_DOCTYPE);
    // No field defaults in this fixture, so user-defined fields are absent
    expect(loaded.doc.site_name).toBeUndefined();
  });

  it('reading an absent normal doctype still throws NotFoundError', async () => {
    await expect(loadDoc('Customer', 'CUST-MISSING', store)).rejects.toBeInstanceOf(NotFoundError);
  });
});
