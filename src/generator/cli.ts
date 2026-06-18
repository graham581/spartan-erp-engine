import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERPNEXT_ROOT, SELLING_SLICE } from '../slice.config';
import { resolveDocTypePath } from './resolve';
import { generateOne, buildMigration, buildTypes, buildMeta, type GenResult } from './generate';
import type { DocType } from './types';

const here = dirname(fileURLToPath(import.meta.url));
const syntheticDir = join(here, 'synthetic');
const repoRoot = join(here, '..', '..');
const genDir = join(repoRoot, 'generated');
const migDir = join(genDir, 'migrations');
mkdirSync(migDir, { recursive: true });

const inSlice = new Set(SELLING_SLICE);
const results: GenResult[] = [];

for (const name of SELLING_SLICE) {
  const p = resolveDocTypePath(name, ERPNEXT_ROOT, syntheticDir);
  if (!p) {
    console.error(`  MISSING  ${name} — could not resolve doctype JSON`);
    continue;
  }
  const dt = JSON.parse(readFileSync(p, 'utf8')) as DocType;
  if (!dt.name) dt.name = name;
  results.push(generateOne(dt, inSlice, p));
}

writeFileSync(join(migDir, '0001_selling_slice.sql'), buildMigration(results), 'utf8');
writeFileSync(join(genDir, 'types.ts'), buildTypes(results), 'utf8');
writeFileSync(join(genDir, 'meta.ts'), buildMeta(results), 'utf8');

console.log('\nGenerated Selling slice from ERPNext DocType JSON:\n');
console.log('  DocType            Table                 Cols  Child(in/total)  Submit');
console.log('  ' + '-'.repeat(74));
for (const r of results) {
  const childIn = r.childRefs.filter((c) => c.included).length;
  const cols = r.scalarCount + 7 + (r.istable ? 3 : 0);
  console.log(
    '  ' +
      r.doctype.padEnd(18) +
      r.table.padEnd(21) +
      String(cols).padStart(4) +
      '   ' +
      `${childIn}/${r.childRefs.length}`.padEnd(14) +
      '   ' +
      (r.submittable ? 'yes' : '-'),
  );
}

const deferred = results.flatMap((r) =>
  r.childRefs.filter((c) => !c.included).map((c) => `${r.doctype}.${c.field} -> ${c.target}`),
);
console.log(`\n  Deferred child tables (Table fields to non-slice doctypes): ${deferred.length}`);
for (const d of deferred) console.log(`    - ${d}`);

console.log('\n  Wrote: generated/migrations/0001_selling_slice.sql');
console.log('         generated/types.ts');
console.log('         generated/meta.ts\n');
