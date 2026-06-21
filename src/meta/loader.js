/**
 * MetaLoader — hydrate one Meta from the store, prime the transitive closure,
 * and poll the meta_version sentinel for cache invalidation.
 *
 * This is the ONLY place where:
 *   - snake_case DB columns are mapped to camelCase FieldDef/DocPerm shapes (ADR §5)
 *   - 0/1/null flag columns are coerced to real JS booleans via !!
 *   - child-table .table is resolved from the already-primed child meta (M4)
 *
 * Callers: api/handler.js calls ensure(doctype, store) before any doc CRUD.
 * Tests:   src/meta/loader.test.js — MemoryStore only, no live DB.
 */

import { Meta } from './meta.js';
import {
  getMeta,
  hasMeta,
  setMeta,
  getVersionState,
  setVersionState,
  invalidate,
} from './registry.js';
import { NotFoundError } from '../runtime/errors.js';

// ---------------------------------------------------------------------------
// Staleness TTL — at most one meta_version read per window per warm lambda.
// Set to 0 to read on every request (useful in tests).
// ---------------------------------------------------------------------------
export const META_VERSION_TTL_MS = 5000;

// ---------------------------------------------------------------------------
// ensureFresh — bounded-staleness version poll (M1/M2)
// ---------------------------------------------------------------------------

/**
 * Check the meta_version sentinel and invalidate non-pinned cache entries if the
 * stored version has changed since the last check. Throttled to at most one DB
 * read per META_VERSION_TTL_MS per warm lambda.
 *
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<void>}
 */
export async function ensureFresh(store) {
  const now = Date.now();
  const { version, versionCheckedAt } = getVersionState();
  if (META_VERSION_TTL_MS > 0 && now - versionCheckedAt < META_VERSION_TTL_MS) {
    return; // within TTL window — skip the DB read
  }
  const row = await store.get('meta_version', 'meta_version');
  const newVersion = row ? row.version : null;
  setVersionState(newVersion, now);
  if (newVersion !== version) {
    invalidate(); // clear all non-pinned entries
  }
}

// ---------------------------------------------------------------------------
// load — hydrate one Meta from tab* rows (C4/C5/M4)
// ---------------------------------------------------------------------------

/**
 * Read the tabDocType row + tabDocField/tabDocPerm children from the store,
 * apply the full snake→camel + coercion map, derive childTables (M4), and
 * register the result in the MetaRegistry.
 *
 * PRE-CONDITION: every Table-field target named in this doctype's fields must
 * already be primed in the registry (ensure() guarantees this with child-first
 * ordering). Violating this throws a clear dev error (N1 — fail loud).
 *
 * @param {string} doctype
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<Meta>}
 */
export async function load(doctype, store) {
  // Step 1 — read the DocType parent row
  const row = await store.get('tabDocType', doctype);
  if (!row) throw new NotFoundError(`Unknown doctype: ${doctype}`);

  // Step 2 — read DocField children and map snake→camel (ADR §5)
  const rawFields = await store.getChildren('tabDocField', doctype, 'DocType', 'fields');
  const fields = rawFields.map((f) => ({
    fieldname:  f.fieldname,
    fieldtype:  f.fieldtype,
    reqd:       !!(f.reqd),
    options:    f.options,
    permlevel:  Number(f.permlevel ?? 0),
    readOnly:   !!(f.read_only),
    unique:     !!(f.unique),
    fetchFrom:  f.fetch_from,
    idx:        Number(f.idx ?? 0),
    dependsOn:          f.depends_on           ?? null,
    mandatoryDependsOn: f.mandatory_depends_on ?? null,
  }));

  // Step 3 — read DocPerm children and map (ADR §5)
  const rawPerms = await store.getChildren('tabDocPerm', doctype, 'DocType', 'permissions');
  const permissions = rawPerms.map((p) => ({
    doctype:    p.parent,           // rename: child key → the field permissions.js reads
    role:       p.role,
    permlevel:  Number(p.permlevel ?? 0),
    read:       !!(p.read),
    write:      !!(p.write),
    create:     !!(p.create),
    submit:     !!(p.submit),
    cancel:     !!(p.cancel),
    delete:     !!(p.delete),
    ifOwner:    !!(p.if_owner),
  }));

  // Step 4 — derive childTables from Table-fieldtype rows (M4 + N1)
  const childTables = fields
    .filter((f) => f.fieldtype === 'Table')
    .map((f) => {
      if (!hasMeta(f.options)) {
        throw new Error(
          `MetaLoader.load: Table target "${f.options}" for field "${f.fieldname}" ` +
          `on doctype "${doctype}" was not primed before load() ran. ` +
          `This is a closure regression in ensure() — add "${f.options}" to the prime set.`
        );
      }
      return {
        field:   f.fieldname,
        doctype: f.options,
        table:   getMeta(f.options).table,
      };
    });

  // Step 5 — scalar columns from the DocType row
  // The table name is not stored as a column; it follows the tab<Doctype> convention.
  // Spaces in doctype names (e.g. "Workflow Transition") become part of the table name
  // as-is (tabWorkflowTransition was set explicitly on the boot meta — we keep that
  // convention for boot-seeded types, but for loaded types we derive tab<Doctype>).
  const scopeFields  = Array.isArray(row.scope_fields) ? row.scope_fields : [];
  const submittable  = !!(row.is_submittable);
  const issingle     = !!(row.issingle);                                        // NEW (U6)
  const isStub       = !!(row.is_stub);                                         // NEW (U-MARKER)
  const istable      = !!(row.istable);                                          // NEW (U1)
  const autoname     = row.autoname || undefined;
  // Derive table name: "tab" + doctype with spaces removed (matches Frappe convention)
  const table = `tab${doctype.replace(/\s+/g, '')}`;

  // Step 6 — assemble and register
  const meta = new Meta({ doctype, table, submittable, issingle, isStub, istable, autoname, fields, childTables, scopeFields, permissions });
  setMeta(doctype, meta, false);
  return meta;
}

// ---------------------------------------------------------------------------
// ensure — per-request transitive prime (C1)
// ---------------------------------------------------------------------------

/**
 * Prime the MetaRegistry with `doctype` and every Link/Table target it references,
 * transitively, to a fixed point.
 *
 * Ordering contract (N2):
 *   - Table edges are loaded child-first so getMeta(options).table is available
 *     when the parent assembles its childTables.
 *   - Link edges need only be PRESENT in the cache (order-free) — they are
 *     loaded after all Table descendants for the current frontier.
 *
 * Visited-set guards self/mutual reference so cyclic Links (A→B→A) terminate.
 * Cyclic Table edges are forbidden by Frappe's model (a child can't reference
 * its own ancestor as a Table child).
 *
 * @param {string} doctype
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<void>}
 */
export async function ensure(doctype, store) {
  // 1. Staleness check first
  await ensureFresh(store);

  // 2. Compute the transitive closure and load in the right order.
  //    We use two-pass per doctype: first load all Table children (child-first,
  //    recursive), then load Link targets (order-free membership).
  const visited = new Set();
  await _primeDoctype(doctype, store, visited);
}

/**
 * Recursively prime a doctype: load its Table children first (child-first),
 * then load the doctype itself, then enqueue Link targets.
 *
 * @param {string} doctype
 * @param {import('../runtime/store.js').Store} store
 * @param {Set<string>} visited
 * @returns {Promise<void>}
 */
async function _primeDoctype(doctype, store, visited) {
  if (visited.has(doctype)) return;
  visited.add(doctype);

  // Pinned entries (boot meta) are already in the cache — skip loading them
  // but we still need to walk their fields to discover transitive deps.
  if (hasMeta(doctype)) {
    // Already in cache — still walk its fields to discover any un-primed deps
    const meta = getMeta(doctype);
    await _walkFields(meta.fields, store, visited);
    return;
  }

  // Not yet cached — read the raw DocField rows to discover children before
  // loading the doctype itself (so Table children are primed first — N2).
  const rawFields = await store.getChildren('tabDocField', doctype, 'DocType', 'fields');

  // Separate Table and Link targets
  const tableTargets = [];
  const linkTargets  = [];
  for (const f of rawFields) {
    if (!f.options) continue;
    if (f.fieldtype === 'Table') tableTargets.push(f.options);
    else if (f.fieldtype === 'Link') linkTargets.push(f.options);
  }

  // Table children load first (child-first — N2)
  for (const target of tableTargets) {
    await _primeDoctype(target, store, visited);
  }

  // Now load the doctype itself (Table children are now primed — M4 satisfied)
  await load(doctype, store);

  // Link targets load after (order-free — N2); fail loud if unreachable (N1)
  for (const target of linkTargets) {
    await _primeLinkTarget(target, store, visited);
  }
}

/**
 * Prime a Link target. Throws if the target can't be loaded (N1 — fail loud).
 *
 * @param {string} doctype
 * @param {import('../runtime/store.js').Store} store
 * @param {Set<string>} visited
 * @returns {Promise<void>}
 */
async function _primeLinkTarget(doctype, store, visited) {
  if (visited.has(doctype)) return;
  visited.add(doctype);

  if (hasMeta(doctype)) {
    const meta = getMeta(doctype);
    await _walkFields(meta.fields, store, visited);
    return;
  }

  // Load the target; propagate NotFoundError as a loud failure
  const rawFields = await store.getChildren('tabDocField', doctype, 'DocType', 'fields');

  const tableTargets = [];
  const linkTargets  = [];
  for (const f of rawFields) {
    if (!f.options) continue;
    if (f.fieldtype === 'Table') tableTargets.push(f.options);
    else if (f.fieldtype === 'Link') linkTargets.push(f.options);
  }

  for (const target of tableTargets) {
    await _primeDoctype(target, store, visited);
  }

  await load(doctype, store);

  for (const target of linkTargets) {
    await _primeLinkTarget(target, store, visited);
  }
}

/**
 * Walk the fields of an already-cached Meta to discover any transitive deps
 * that might not yet be primed (rare — happens when boot-meta entries have
 * Link/Table fields pointing to non-pinned doctypes).
 *
 * @param {import('./registry.js').FieldDef[]} fields
 * @param {import('../runtime/store.js').Store} store
 * @param {Set<string>} visited
 * @returns {Promise<void>}
 */
async function _walkFields(fields, store, visited) {
  for (const f of fields) {
    if (!f.options) continue;
    if (f.fieldtype === 'Table') {
      await _primeDoctype(f.options, store, visited);
    } else if (f.fieldtype === 'Link') {
      await _primeLinkTarget(f.options, store, visited);
    }
  }
}
