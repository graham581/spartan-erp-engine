/**
 * Installer — upserts meta rows and emits DDL migration files for a doctype.
 *
 * ONE-DIRECTIONAL SPLIT (ADR §4 / workorder §D1):
 *   (1) emitMigration(def)       — emit DDL to supabase/migrations/<ts>_<slug>.sql
 *                                   HUMAN runs `supabase db push` to apply it
 *   (2) syncDoctype(def, store)  — upsert tabDocType + tabDocField + tabDocPerm rows
 *                                   via Document.save(); PostgREST only, NO DDL
 *   (3) bumpMetaVersion(store)   — set meta_version.version to a new value (set, not append)
 *
 * REQUIRED ORDERING for a new doctype:
 *   emitMigration → human `supabase db push` → (PostgREST schema cache reload)
 *   → syncDoctype → bumpMetaVersion
 *
 * For an existing doctype (schema already pushed):
 *   syncDoctype → bumpMetaVersion
 */

import { createTableSql, alterColumnsSql } from './ddl.js';
import { registerBootMeta }               from './boot-meta.js';
import { newDoc }                          from '../runtime/document.js';
import { writeFileSync, mkdirSync }        from 'node:fs';
import { join, resolve, dirname }          from 'node:path';
import { fileURLToPath }                   from 'node:url';

// Resolve repo root relative to this file: src/meta/installer.js -> ../../
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..');

/**
 * Doctype name → file-system slug (spaces → underscores, lower-case).
 * @param {string} doctype
 * @returns {string}
 */
function slugify(doctype) {
  return doctype.toLowerCase().replace(/\s+/g, '_');
}

/**
 * Generate a migration timestamp string (YYYYMMDDHHmmss).
 * @returns {string}
 */
function migrationTimestamp() {
  const n = new Date();
  const pad = (v, w = 2) => String(v).padStart(w, '0');
  return `${n.getUTCFullYear()}${pad(n.getUTCMonth() + 1)}${pad(n.getUTCDate())}` +
         `${pad(n.getUTCHours())}${pad(n.getUTCMinutes())}${pad(n.getUTCSeconds())}`;
}

/**
 * Emit a migration file containing CREATE TABLE (and optional ALTER) SQL for
 * the doctype's data table.  The file is written to
 * `supabase/migrations/<ts>_<slug>.sql` under the repo root.
 *
 * The Installer NEVER executes DDL — a human must run `supabase db push`.
 *
 * @param {{ doctype: string, table: string, fields: Array<{fieldname:string,fieldtype:string}> }} def
 * @param {{ writer?: (path:string, sql:string)=>void }} [opts]
 *   opts.writer — injectable writer for tests (default: writeFileSync to the real FS)
 * @returns {string} absolute path of the written migration file
 */
export function emitMigration(def, opts = {}) {
  const { writer } = opts;
  const slug  = slugify(def.doctype);
  const ts    = migrationTimestamp();
  const fname = `${ts}_${slug}.sql`;
  const migrDir = join(REPO_ROOT, 'supabase', 'migrations');
  const path  = join(migrDir, fname);

  const rollback = `-- ROLLBACK: drop table if exists "${def.table}";`;
  const createSql = createTableSql(def);
  const sql = [rollback, '', createSql].join('\n');

  if (writer) {
    writer(path, sql);
  } else {
    mkdirSync(migrDir, { recursive: true });
    writeFileSync(path, sql, 'utf8');
  }

  return path;
}

/**
 * Upsert tabDocType (parent) + tabDocField (fields children) + tabDocPerm
 * (permissions children) via the Document.save() child-replace pipeline.
 *
 * Idempotent: save() upserts by name; children are deleted-then-reinserted each run.
 * NEVER runs DDL — the table must already exist (pushed via emitMigration + db push).
 *
 * registerBootMeta() must be called before syncDoctype so getMeta('DocType') resolves.
 *
 * @param {{ doctype: string, table: string, fields?: any[], permissions?: any[] }} def
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<void>}
 */
export async function syncDoctype(def, store) {
  // Ensure the 6 meta-doctypes are pinned so getMeta('DocType') resolves synchronously.
  registerBootMeta();

  // Build the DocType row document — DocType.name = the doctype name.
  // Fields and permissions are child rows on the DocType document.
  const docTypeRow = {
    name:           def.doctype,
    docstatus:      0,
    idx:            0,
    module:         def.module         ?? null,
    autoname:       def.autoname       ?? null,
    naming_rule:    def.naming_rule    ?? null,
    issingle:       def.issingle       ?? false,
    istable:        def.istable        ?? false,
    is_submittable: def.submittable    ?? false,
    scope_fields:   def.scopeFields    ?? null,

    // child rows — Document.save() will persist these via #saveChildren
    fields:      (def.fields ?? []).map((f, i) => ({
      fieldname:   f.fieldname,
      fieldtype:   f.fieldtype,
      reqd:        f.reqd        ?? false,
      options:     f.options     ?? null,
      permlevel:   f.permlevel   ?? 0,
      read_only:   f.readOnly    ?? false,
      unique:      f.unique      ?? false,
      fetch_from:  f.fetchFrom   ?? null,
      idx:         f.idx         ?? i,
    })),
    permissions: (def.permissions ?? []).map((p, i) => ({
      role:       p.role,
      permlevel:  p.permlevel ?? 0,
      if_owner:   p.ifOwner   ?? false,
      read:       p.read      ?? false,
      write:      p.write     ?? false,
      create:     p.create    ?? false,
      submit:     p.submit    ?? false,
      cancel:     p.cancel    ?? false,
      delete:     p.delete    ?? false,
      idx:        p.idx       ?? i,
    })),
  };

  const doc = newDoc('DocType', docTypeRow, store);
  await doc.save();
}

/**
 * Set (not append) the meta_version row so warm lambdas invalidate their
 * non-pinned cache entries on next ensureFresh() check.
 *
 * Idempotent: uses store.update(); if the row is absent (fresh DB), inserts it.
 *
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<void>}
 */
export async function bumpMetaVersion(store) {
  const version = String(Date.now());
  const existing = await store.get('meta_version', 'meta_version');
  if (existing) {
    await store.update('meta_version', 'meta_version', { name: 'meta_version', version });
  } else {
    await store.insert('meta_version', { name: 'meta_version', version });
  }
}
