/**
 * generate-doctypes.test.mjs — closure live-check (critique #4).
 *
 * Drives the pure pipeline directly (no CLI argv parsing):
 *   closureOver → erpnextJsonToDef → assertValidDef → syncDoctype (per def)
 *   → ensure('Sales Order', store) → assert no NotFoundError
 *
 * Also checks: --no-closure with Sales Order (which Links outside the seed)
 * throws at generate time naming the missing target.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

import { closureOver }      from './select-doctypes.js';
import { erpnextJsonToDef } from './erpnext-to-def.js';
import { assertValidDef }   from '../validation/def-schema.js';
import { syncDoctype }      from '../meta/installer.js';
import { ensure }           from '../meta/loader.js';
import { MemoryStore }      from '../runtime/memory-store.js';
import { _resetRegistry, hasMeta }  from '../meta/registry.js';
import { registerBootMeta } from '../meta/boot-meta.js';

// ---------------------------------------------------------------------------
// Fixture helpers — mirror the pattern from select-doctypes.test.js
// ---------------------------------------------------------------------------

/**
 * Write a minimal real-DocType JSON file under
 * `root/<module>/doctype/<name>/<name>.json` in the ERPNext convention.
 *
 * @param {string} root
 * @param {string} name  doctype name
 * @param {object[]} [fields]  ERPNext field objects
 */
function writeDoctype(root, name, fields = []) {
  const dir = path.join(root, 'selling', 'doctype', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({ doctype: 'DocType', name, fields }),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Shared tmp root — one temp dir for the whole suite
// ---------------------------------------------------------------------------

let tmpRoot;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-u5-test-'));

  // Sales Order — has a Link field pointing to Customer (outside the single-seed set).
  writeDoctype(tmpRoot, 'Sales Order', [
    { fieldname: 'customer',   fieldtype: 'Link',     options: 'Customer' },
    { fieldname: 'order_date', fieldtype: 'Date' },
    { fieldname: 'total',      fieldtype: 'Currency' },
  ]);

  // Customer — leaf node; no deps outside itself.
  writeDoctype(tmpRoot, 'Customer', [
    { fieldname: 'customer_name', fieldtype: 'Data' },
    { fieldname: 'email',         fieldtype: 'Data' },
  ]);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Reset the meta registry before each test so hasMeta/getMeta sees a clean slate.
beforeEach(() => {
  _resetRegistry();
  registerBootMeta();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read + parse the JSON for a doctype name from the fake root.
 * (Matches the convention the CLI uses.)
 */
function readDoctypeJson(root, doctypeName) {
  const dir = path.join(root, 'selling', 'doctype', doctypeName);
  return JSON.parse(fs.readFileSync(path.join(dir, `${doctypeName}.json`), 'utf8'));
}

/**
 * Run the pure generate pipeline for a set of names:
 *   parse JSON → erpnextJsonToDef → assertValidDef.
 * Returns the array of defs.
 */
function generateDefs(names, root) {
  return names.map((name) => {
    const json = readDoctypeJson(root, name);
    const def  = erpnextJsonToDef(json);
    assertValidDef(def);
    return def;
  });
}

// ---------------------------------------------------------------------------
// Test 1 — closure-by-default: Sales Order primes into MemoryStore with no
// NotFoundError when ensure('Sales Order', store) is called.
// ---------------------------------------------------------------------------

describe('closure live-check (critique #4)', () => {
  it('closure-default: ensure("Sales Order", store) resolves with no NotFoundError', async () => {
    // closureOver(['Sales Order'], root) must include Customer (transitive Link dep).
    const names = closureOver(['Sales Order'], tmpRoot);

    expect(names).toContain('Sales Order');
    expect(names).toContain('Customer'); // closure pulled in the Link target

    // Generate defs for the full closure.
    const defs = generateDefs(names, tmpRoot);

    // Prime each def into a fresh MemoryStore via syncDoctype.
    // syncDoctype writes tabDocType / tabDocField / tabDocPerm rows.
    const store = new MemoryStore();
    for (const def of defs) {
      await syncDoctype(def, store);
    }

    // ensure('Sales Order', store) must resolve without throwing NotFoundError.
    // It reads the meta rows back from the store and primes the registry.
    await expect(ensure('Sales Order', store)).resolves.toBeUndefined();

    // And the registry must now have Sales Order cached.
    expect(hasMeta('Sales Order')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 2 — noClosure with Sales Order (which Links to Customer) throws at
  // generate time naming the missing target.
  // ---------------------------------------------------------------------------
  it('noClosure: closureOver throws naming the missing Link target (Customer)', () => {
    // Sales Order has a Link to Customer; Customer is not in the seed set.
    expect(() =>
      closureOver(['Sales Order'], tmpRoot, { noClosure: true }),
    ).toThrow(/Customer/);
  });
});
