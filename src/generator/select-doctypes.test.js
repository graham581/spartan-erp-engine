import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listAllDoctypeFiles, closureOver } from './select-doctypes.js';

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
