import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listAllDoctypeFiles, closureOver, depsByKind, planInstall } from './select-doctypes.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Write a minimal real-DocType JSON file under `root/<module>/doctype/<name>/<name>.json`.
 */
function writeDoctype(root, name, fields = []) {
  const dir = path.join(root, 'mymodule', 'doctype', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({ doctype: 'DocType', name, fields }),
    'utf8'
  );
}

/** Write a JSON file that is NOT a real DocType (e.g. a Report). */
function writeNonDoctype(root, name) {
  const dir = path.join(root, 'mymodule', 'doctype', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({ doctype: 'Report', name }),
    'utf8'
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let tmpRoot;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-u4-test-'));

  // Alpha — a seed with a Link dep on Beta and a Dynamic Link dep (sibling fieldname ref)
  writeDoctype(tmpRoot, 'Alpha', [
    { fieldname: 'ref_type', fieldtype: 'Select', options: 'Customer\nSupplier' },
    { fieldname: 'ref_name', fieldtype: 'Dynamic Link', options: 'ref_type' },
    { fieldname: 'beta_link', fieldtype: 'Link', options: 'Beta' },
  ]);

  // Beta — target of Alpha's Link dep; has a Table dep on Gamma
  writeDoctype(tmpRoot, 'Beta', [
    { fieldname: 'gamma_table', fieldtype: 'Table', options: 'Gamma' },
  ]);

  // Gamma — target of Beta's Table dep; leaf node
  writeDoctype(tmpRoot, 'Gamma', []);

  // Delta — has a Table MultiSelect dep on Epsilon
  writeDoctype(tmpRoot, 'Delta', [
    { fieldname: 'eps', fieldtype: 'Table MultiSelect', options: 'Epsilon' },
  ]);

  // Epsilon — leaf
  writeDoctype(tmpRoot, 'Epsilon', []);

  // Zeta — has a Link dep on Eta; Eta is outside any seed set in noClosure tests
  writeDoctype(tmpRoot, 'Zeta', [
    { fieldname: 'eta_link', fieldtype: 'Link', options: 'Eta' },
  ]);

  // Eta — leaf
  writeDoctype(tmpRoot, 'Eta', []);

  // NotADoctype — should be filtered out by isRealDoctype
  writeNonDoctype(tmpRoot, 'NotADoctype');
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('listAllDoctypeFiles', () => {
  it('returns JSON paths for all doctype dirs (including non-DocType JSON)', () => {
    const files = listAllDoctypeFiles(tmpRoot);
    // Every fixture we wrote lives under a doctype/<name>/ dir
    expect(files.length).toBeGreaterThanOrEqual(7); // Alpha Beta Gamma Delta Epsilon Zeta Eta + NotADoctype
    expect(files.every(f => f.endsWith('.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('closureOver — closure ON (default)', () => {
  it('includes a transitive Link dep (Alpha → Beta) in the closure', () => {
    const result = closureOver(['Alpha'], tmpRoot);
    expect(result).toContain('Alpha');
    expect(result).toContain('Beta');
  });

  it('includes transitive Table dep (Beta → Gamma) when seeding Alpha', () => {
    const result = closureOver(['Alpha'], tmpRoot);
    expect(result).toContain('Gamma');
  });

  it('includes Table MultiSelect dep (Delta → Epsilon)', () => {
    const result = closureOver(['Delta'], tmpRoot);
    expect(result).toContain('Delta');
    expect(result).toContain('Epsilon');
  });

  it('a Dynamic Link field does NOT add a closure dep', () => {
    // Alpha has Dynamic Link options='ref_type' — 'ref_type' is a fieldname, not a doctype;
    // it must NOT appear in the closure result.
    const result = closureOver(['Alpha'], tmpRoot);
    expect(result).not.toContain('ref_type');
    // Also: Select options are plain strings — 'Customer' and 'Supplier' from the options
    // string of a Select field must not appear (Select is not a Link/Table type).
    expect(result).not.toContain('Customer');
    expect(result).not.toContain('Supplier');
  });
});

// ---------------------------------------------------------------------------

describe('closureOver — noClosure:true', () => {
  it('returns exactly the seed set when all deps are within seeds', () => {
    const result = closureOver(['Alpha', 'Beta', 'Gamma'], tmpRoot, { noClosure: true });
    expect(new Set(result)).toEqual(new Set(['Alpha', 'Beta', 'Gamma']));
  });

  it('throws naming the outside dep when a Link target is outside the seed set', () => {
    // Zeta has a Link dep on Eta; Eta is not in seeds
    expect(() => closureOver(['Zeta'], tmpRoot, { noClosure: true })).toThrow(/Eta/);
  });

  it('throws naming the outside dep when a Table target is outside the seed set', () => {
    // Beta has a Table dep on Gamma; Gamma is not in seeds
    expect(() => closureOver(['Beta'], tmpRoot, { noClosure: true })).toThrow(/Gamma/);
  });

  it('throws naming the outside dep for Table MultiSelect outside seed set', () => {
    // Delta has a Table MultiSelect dep on Epsilon; Epsilon is not in seeds
    expect(() => closureOver(['Delta'], tmpRoot, { noClosure: true })).toThrow(/Epsilon/);
  });

  it('a Dynamic Link does NOT trigger a noClosure throw', () => {
    // Alpha has a Dynamic Link with options='ref_type' — that's a fieldname, not a doctype;
    // but Alpha also has a Link to Beta which IS outside the seed set.
    // Provide just Alpha + Beta to satisfy the Link dep; Dynamic Link must not cause a throw.
    expect(() =>
      closureOver(['Alpha', 'Beta', 'Gamma'], tmpRoot, { noClosure: true })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// depsByKind [CRIT-2]
// ---------------------------------------------------------------------------

describe('depsByKind — split by edge kind', () => {
  it('puts Link in links, Table + Table MultiSelect in tables, excludes Dynamic Link and Data', () => {
    const json = {
      doctype: 'DocType',
      name: 'TestDoc',
      fields: [
        { fieldname: 'customer', fieldtype: 'Link', options: 'Customer' },
        { fieldname: 'items', fieldtype: 'Table', options: 'Sales Item' },
        { fieldname: 'tags', fieldtype: 'Table MultiSelect', options: 'Tag' },
        { fieldname: 'ref_type', fieldtype: 'Select', options: 'Customer\nSupplier' },
        { fieldname: 'ref_name', fieldtype: 'Dynamic Link', options: 'ref_type' },
        { fieldname: 'notes', fieldtype: 'Data', options: '' },
        { fieldname: 'title', fieldtype: 'Data' },  // no options key
      ],
    };
    const { links, tables } = depsByKind(json);
    expect(links).toEqual(['Customer']);
    expect(tables).toContain('Sales Item');
    expect(tables).toContain('Tag');
    expect(tables).toHaveLength(2);
    // Dynamic Link and Data must not appear
    expect(links).not.toContain('ref_type');
    expect(links).not.toContain('Customer\nSupplier');
    expect(tables).not.toContain('ref_type');
  });

  it('deduplicates repeated options within each list', () => {
    const json = {
      doctype: 'DocType',
      name: 'DupDoc',
      fields: [
        { fieldname: 'a', fieldtype: 'Link', options: 'Currency' },
        { fieldname: 'b', fieldtype: 'Link', options: 'Currency' },
        { fieldname: 'c', fieldtype: 'Table', options: 'Item' },
        { fieldname: 'd', fieldtype: 'Table', options: 'Item' },
      ],
    };
    const { links, tables } = depsByKind(json);
    expect(links).toEqual(['Currency']);
    expect(tables).toEqual(['Item']);
  });

  it('drops empty / whitespace-only options', () => {
    const json = {
      doctype: 'DocType',
      name: 'EmptyOpts',
      fields: [
        { fieldname: 'a', fieldtype: 'Link', options: '   ' },
        { fieldname: 'b', fieldtype: 'Table', options: '' },
        { fieldname: 'c', fieldtype: 'Table MultiSelect', options: '  ' },
      ],
    };
    const { links, tables } = depsByKind(json);
    expect(links).toHaveLength(0);
    expect(tables).toHaveLength(0);
  });

  it('returns empty lists for a doc with no fields', () => {
    const { links, tables } = depsByKind({ doctype: 'DocType', name: 'Empty', fields: [] });
    expect(links).toHaveLength(0);
    expect(tables).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// planInstall [CRIT-1, CRIT-3, CRIT-7]
// ---------------------------------------------------------------------------

// We need a second temp root for fixture-based planInstall tests (cycle + dead-end)
let planRoot;

beforeAll(() => {
  planRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-plan-test-'));

  // CycleA → Table → CycleB → Table → CycleA  (mutual cycle)
  writeDoctype(planRoot, 'CycleA', [
    { fieldname: 'b_items', fieldtype: 'Table', options: 'CycleB' },
  ]);
  writeDoctype(planRoot, 'CycleB', [
    { fieldname: 'a_items', fieldtype: 'Table', options: 'CycleA' },
  ]);

  // DeadSeed → Table → MissingChild  (child has NO JSON in this root)
  writeDoctype(planRoot, 'DeadSeed', [
    { fieldname: 'ghost_items', fieldtype: 'Table', options: 'MissingChild' },
  ]);
  // MissingChild intentionally NOT written

  // SelfRef → Table → SelfRef  (self-cycle)
  writeDoctype(planRoot, 'SelfRef', [
    { fieldname: 'self_items', fieldtype: 'Table', options: 'SelfRef' },
  ]);

  // Parent → Table → Child; Child → Link → ExternalLink (becomes stub)
  writeDoctype(planRoot, 'Parent', [
    { fieldname: 'children', fieldtype: 'Table', options: 'Child' },
    { fieldname: 'currency_link', fieldtype: 'Link', options: 'Currency' },
  ]);
  writeDoctype(planRoot, 'Child', [
    { fieldname: 'ext_link', fieldtype: 'Link', options: 'ExternalLink' },
  ]);
  // ExternalLink intentionally not present — it's only a Link target → becomes a stub
});

afterAll(() => {
  fs.rmSync(planRoot, { recursive: true, force: true });
});

const ERPNEXT_ROOT = 'C:\\Users\\parrg\\Documents\\erpnext-develop\\erpnext-develop\\erpnext';

describe('planInstall — transitive full set [CRIT-1]', () => {
  it('Quotation seed: full contains Quotation and Quotation Item', () => {
    const { full } = planInstall(['Quotation'], ERPNEXT_ROOT);
    expect(full).toContain('Quotation');
    expect(full).toContain('Quotation Item');
  });

  it('stubs are disjoint from full (full ∩ stubs === ∅) [CRIT-1]', () => {
    const { full, stubs } = planInstall(['Quotation'], ERPNEXT_ROOT);
    const fullSet = new Set(full);
    for (const s of stubs) {
      expect(fullSet.has(s)).toBe(false);
    }
  });

  it('stubs contain Link targets (e.g. Currency or User)', () => {
    const { stubs } = planInstall(['Quotation'], ERPNEXT_ROOT);
    // At minimum some Link targets appear — at least one well-known stub
    expect(stubs.length).toBeGreaterThan(0);
  });
});

describe('planInstall — Table-BFS cycle termination [CRIT-3]', () => {
  it('mutual Table cycle A→B→A terminates and full ⊇ {CycleA, CycleB}', () => {
    const { full } = planInstall(['CycleA'], planRoot);
    expect(full).toContain('CycleA');
    expect(full).toContain('CycleB');
  });

  it('self-referential Table cycle terminates and full contains SelfRef', () => {
    const { full } = planInstall(['SelfRef'], planRoot);
    expect(full).toContain('SelfRef');
  });
});

describe('planInstall — dead-end guard [CRIT-7]', () => {
  it('throws naming the missing Table child when child has no JSON', () => {
    expect(() => planInstall(['DeadSeed'], planRoot)).toThrow(/Table child "MissingChild"/);
  });

  it('throw message also names the parent', () => {
    expect(() => planInstall(['DeadSeed'], planRoot)).toThrow(/referenced by "DeadSeed"/);
  });
});

describe('planInstall — stubs vs full separation (fixture)', () => {
  it('Parent fixture: full ⊇ {Parent, Child}; stubs contain ExternalLink and Currency (not in full)', () => {
    const { full, stubs } = planInstall(['Parent'], planRoot);
    expect(full).toContain('Parent');
    expect(full).toContain('Child');
    const fullSet = new Set(full);
    expect(fullSet.has('ExternalLink')).toBe(false);
    expect(stubs).toContain('ExternalLink');
    expect(stubs).toContain('Currency');
  });
});
