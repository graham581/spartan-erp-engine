/**
 * generate-doctypes.mjs — CLI: generate ERPNext DocType JSON → engine defs.
 *
 * Usage:
 *   node scripts/generate-doctypes.mjs \
 *     --root <erpnextRoot> \
 *     --seed "<Doctype>" [--seed ...] \
 *     [--no-closure] \
 *     (--emit | --apply)
 *
 * I/O layer only — all generation logic lives in U2 (erpnext-to-def.js) + U4
 * (select-doctypes.js). Generator fns stay pure; this script reads files and
 * dispatches to installer.
 *
 * --apply REQUIRES PgStore + PgAdmin (ONLY).
 * SupabaseStore.transaction throws — a Pass B verified fact. Never call --apply
 * with a SupabaseStore. If you need to run against the live DB, use emitMigration
 * (--emit) and then `supabase db push` manually.
 *
 * Do NOT auto-run --apply against any live DB from this script.
 * Gated: you must call this CLI explicitly and supply live-DB env vars.
 */

import fs   from 'node:fs';
import path from 'node:path';

import { closureOver, planInstall } from '../src/generator/select-doctypes.js';
import { erpnextJsonToDef, makeStubDef } from '../src/generator/erpnext-to-def.js';
import { assertValidDef }    from '../src/validation/def-schema.js';
import { mapFieldtype }      from '../src/generator/fieldtype-map.js';
import { emitMigration, migrate } from '../src/meta/installer.js';
import { registerBootMeta }  from '../src/meta/boot-meta.js';

// ---------------------------------------------------------------------------
// argv parsing — minimal, no third-party deps
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  let root       = null;
  const seeds    = [];
  let noClosure  = false;
  let stubDeps   = false;
  let doEmit     = false;
  let doApply    = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root')         { root = args[++i]; }
    else if (a === '--seed')    { seeds.push(args[++i]); }
    else if (a === '--no-closure') { noClosure = true; }
    else if (a === '--stub-deps')  { stubDeps = true; }
    else if (a === '--emit')    { doEmit = true; }
    else if (a === '--apply')   { doApply = true; }
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }

  if (!root) {
    console.error('--root is required');
    process.exit(1);
  }
  if (seeds.length === 0) {
    console.error('At least one --seed is required');
    process.exit(1);
  }
  if (!doEmit && !doApply) {
    console.error('One of --emit or --apply is required');
    process.exit(1);
  }
  if (doEmit && doApply) {
    console.error('Only one of --emit or --apply may be specified');
    process.exit(1);
  }
  // --stub-deps, --closure (default), and --no-closure are mutually exclusive modes.
  const modeCount = (stubDeps ? 1 : 0) + (noClosure ? 1 : 0);
  if (modeCount > 1) {
    console.error('--stub-deps, --closure (default), and --no-closure are mutually exclusive');
    process.exit(1);
  }

  return { root, seeds, noClosure, stubDeps, doEmit, doApply };
}

// ---------------------------------------------------------------------------
// Collect unsupported-bucket warnings from the original ERPNext JSON fields.
// erpnextJsonToDef silently demotes them — we surface them here in the I/O layer.
// ---------------------------------------------------------------------------
function collectWarnings(jsonFields = [], doctypeName) {
  const warnings = [];
  for (const f of jsonFields) {
    if (!f.fieldtype) continue;
    let classified;
    try {
      classified = mapFieldtype(f.fieldtype);
    } catch {
      continue; // unknown fieldtype — assertValidDef will catch it downstream
    }
    if (classified.kind === 'unsupported') {
      warnings.push(
        `  [WARN] ${doctypeName}.${f.fieldname} (${f.fieldtype}): ${classified.warn}`,
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const { root, seeds, noClosure, stubDeps, doEmit, doApply } = parseArgs(process.argv);

  // 1. Resolve the doctype set — three modes:
  //      --stub-deps   : BFS on Table edges (full) + Link targets (stubs)
  //      --closure     : (default) full transitive closure via closureOver
  //      --no-closure  : seeds only (closureOver with noClosure:true)
  //    closureOver throws (fail-at-generate) for noClosure=true if any seed has
  //    outside deps — naming the first missing target (D1-1 guard rail).
  const defs    = [];
  const allWarn = [];

  if (stubDeps) {
    // --stub-deps mode: planInstall splits names into full + stubs.
    let full, stubs;
    try {
      ({ full, stubs } = planInstall(seeds, root));
    } catch (err) {
      console.error(`plan failed: ${err.message}`);
      process.exit(1);
    }

    console.log(`Generating ${full.length} full + ${stubs.length} stub doctype(s).\n`);

    // Full defs: locate JSON → erpnextJsonToDef → validate (same as closure path).
    for (const name of full) {
      const jsonPath = _findJsonForDoctype(root, name);
      if (!jsonPath) {
        console.error(`Could not locate JSON for doctype "${name}" under ${root}`);
        process.exit(1);
      }

      let json;
      try {
        json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch (err) {
        console.error(`Failed to parse ${jsonPath}: ${err.message}`);
        process.exit(1);
      }

      const def = erpnextJsonToDef(json);

      try {
        assertValidDef(def);
      } catch (err) {
        console.error(`assertValidDef failed for "${name}": ${err.message}`);
        process.exit(1);
      }

      const warns = collectWarnings(json.fields, name);
      allWarn.push(...warns);

      defs.push(def);
    }

    // Stub defs: synthesized from name alone — no JSON lookup.
    for (const name of stubs) {
      const def = makeStubDef(name);
      try {
        assertValidDef(def);
      } catch (err) {
        console.error(`assertValidDef failed for stub "${name}": ${err.message}`);
        process.exit(1);
      }
      defs.push(def);
    }

  } else {
    // Closure / no-closure path — byte-for-byte unchanged.
    let names;
    try {
      names = closureOver(seeds, root, { noClosure });
    } catch (err) {
      console.error(`closureOver failed: ${err.message}`);
      process.exit(1);
    }

    console.log(`Generating ${names.length} doctype(s): ${names.join(', ')}\n`);

    for (const name of names) {
      // Locate the file: re-use the same index logic that closureOver uses.
      // Simple approach: walk root for this specific name (small overhead — list is short).
      const jsonPath = _findJsonForDoctype(root, name);
      if (!jsonPath) {
        console.error(`Could not locate JSON for doctype "${name}" under ${root}`);
        process.exit(1);
      }

      let json;
      try {
        json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch (err) {
        console.error(`Failed to parse ${jsonPath}: ${err.message}`);
        process.exit(1);
      }

      // D1-3: erpnextJsonToDef implements the security boundary (no depends_on spread).
      const def = erpnextJsonToDef(json);

      // D1-1/D1-3: assertValidDef over EVERY def in the closure, not just seeds.
      try {
        assertValidDef(def);
      } catch (err) {
        console.error(`assertValidDef failed for "${name}": ${err.message}`);
        process.exit(1);
      }

      // Collect unsupported-bucket warnings from the original JSON fields.
      const warns = collectWarnings(json.fields, name);
      allWarn.push(...warns);

      defs.push(def);
    }
  }

  // 3. Print any warnings before acting.
  if (allWarn.length > 0) {
    console.log('Fieldtype warnings (unsupported → text demotions):');
    for (const w of allWarn) console.log(w);
    console.log('');
  }

  // 4. Dispatch — emit or apply.
  if (doEmit) {
    console.log('Emitting migration files (--emit):');
    for (const def of defs) {
      const outPath = emitMigration(def);
      console.log(`  wrote: ${outPath}`);
    }
    console.log('\nDone. Run `supabase db push` to apply the migrations.');

  } else {
    // --apply: PgStore + PgAdmin ONLY.
    // SupabaseStore.transaction throws — Pass B verified fact.
    // See module-level header comment above.
    console.log('Applying (--apply): loading PgStore + PgAdmin from env …');

    let PgStore, PgAdmin;
    try {
      ({ PgStore }  = await import('../src/runtime/pg-store.js'));
      ({ PgAdmin }  = await import('../src/meta/pg-admin.js'));
    } catch (err) {
      console.error(`Failed to load PgStore/PgAdmin (are they implemented?): ${err.message}`);
      process.exit(1);
    }

    const pgStore = PgStore.fromEnv();
    const pgAdmin = PgAdmin.fromEnv();

    registerBootMeta();

    for (const def of defs) {
      console.log(`  applying: ${def.doctype} …`);
      const result = await migrate(def, pgStore, { admin: pgAdmin });
      console.log(`    DDL applied=${result.applied}`);
    }
    console.log('\nDone.');
  }
}

// ---------------------------------------------------------------------------
// Helper: find the JSON file for a named doctype under root.
// Mirrors the ERPNext convention: <module>/doctype/<name>/<name>.json
// Uses readdir recursively (same as listAllDoctypeFiles, but returns on first hit).
// ---------------------------------------------------------------------------
function _findJsonForDoctype(root, doctypeName) {
  const absRoot = path.resolve(root);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        // Must sit inside doctype/<name>/ subtree
        const parts = full.split(path.sep);
        if (parts.length >= 3 && parts[parts.length - 3] === 'doctype') {
          let json;
          try {
            json = JSON.parse(fs.readFileSync(full, 'utf8'));
          } catch {
            continue;
          }
          if (json && json.name === doctypeName && json.doctype === 'DocType') {
            return full;
          }
        }
      }
    }
    return null;
  }

  return walk(absRoot);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
