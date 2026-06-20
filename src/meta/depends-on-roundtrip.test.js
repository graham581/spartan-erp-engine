/**
 * depends-on-roundtrip.test.js — U9 round-trip spec
 *
 * Verifies that a structured dependsOn / mandatoryDependsOn Condition object
 * survives the full round-trip: registerBootMeta → syncDoctype → loader.load →
 * the loaded FieldDef's dependsOn deep-equals the original Condition.
 * Also asserts the boot DocField meta exposes depends_on / mandatory_depends_on.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore }      from '../runtime/memory-store.js';
import { _resetRegistry, getMeta } from './registry.js';
import { registerBootMeta } from './boot-meta.js';
import { syncDoctype }      from './installer.js';
import { load }             from './loader.js';

// Structured Condition objects (NOT raw strings — per the frozen contract)
const DEPENDS_ON_COND = { field: 'status', op: 'eq', value: 'Open' };
const MANDATORY_COND  = { any: [{ field: 'priority', op: 'eq', value: 'High' }, { field: 'is_urgent', op: 'truthy' }] };

/** A doctype def whose first field carries both Condition objects. */
const defWithDependsOn = {
  doctype:     'ConditionalWidget',
  table:       'tabConditionalWidget',
  submittable: false,
  autoname:    'hash',
  fields: [
    {
      fieldname:          'conditional_note',
      fieldtype:          'Text',
      dependsOn:          DEPENDS_ON_COND,
      mandatoryDependsOn: MANDATORY_COND,
    },
    { fieldname: 'status',     fieldtype: 'Select', options: 'Open\nClosed' },
    { fieldname: 'priority',   fieldtype: 'Select', options: 'High\nLow'    },
    { fieldname: 'is_urgent',  fieldtype: 'Check'                           },
  ],
  permissions: [
    { role: 'Administrator', read: true, write: true, create: true, delete: true },
  ],
};

beforeEach(() => {
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// Boot DocField meta — depends_on / mandatory_depends_on columns are declared
// ---------------------------------------------------------------------------

describe('boot DocField meta', () => {
  it('exposes depends_on and mandatory_depends_on fields', async () => {
    const store = new MemoryStore();
    await registerBootMeta(store);

    const docFieldMeta = getMeta('DocField');
    expect(docFieldMeta, 'DocField meta should be registered').toBeTruthy();

    const fieldnames = docFieldMeta.fields.map((f) => f.fieldname);
    expect(fieldnames).toContain('depends_on');
    expect(fieldnames).toContain('mandatory_depends_on');

    const dependsOnEntry = docFieldMeta.fields.find((f) => f.fieldname === 'depends_on');
    expect(dependsOnEntry.fieldtype).toBe('Code');

    const mandatoryEntry = docFieldMeta.fields.find((f) => f.fieldname === 'mandatory_depends_on');
    expect(mandatoryEntry.fieldtype).toBe('Code');
  });
});

// ---------------------------------------------------------------------------
// Round-trip: syncDoctype → loader.load → dependsOn deep-equals original
// ---------------------------------------------------------------------------

describe('depends_on round-trip', () => {
  it('preserves a structured dependsOn Condition through sync → load', async () => {
    const store = new MemoryStore();
    await registerBootMeta(store);
    await syncDoctype(defWithDependsOn, store);

    const loaded = await load('ConditionalWidget', store);

    const conditionalField = loaded.fields.find((f) => f.fieldname === 'conditional_note');
    expect(conditionalField, 'conditional_note field should be present').toBeTruthy();

    // The loaded dependsOn must deep-equal the original Condition object
    expect(conditionalField.dependsOn).toEqual(DEPENDS_ON_COND);
  });

  it('preserves a structured mandatoryDependsOn Condition through sync → load', async () => {
    const store = new MemoryStore();
    await registerBootMeta(store);
    await syncDoctype(defWithDependsOn, store);

    const loaded = await load('ConditionalWidget', store);

    const conditionalField = loaded.fields.find((f) => f.fieldname === 'conditional_note');
    expect(conditionalField, 'conditional_note field should be present').toBeTruthy();

    expect(conditionalField.mandatoryDependsOn).toEqual(MANDATORY_COND);
  });

  it('leaves dependsOn null for fields that do not declare it', async () => {
    const store = new MemoryStore();
    await registerBootMeta(store);
    await syncDoctype(defWithDependsOn, store);

    const loaded = await load('ConditionalWidget', store);

    const statusField = loaded.fields.find((f) => f.fieldname === 'status');
    expect(statusField.dependsOn).toBeNull();
    expect(statusField.mandatoryDependsOn).toBeNull();
  });
});
