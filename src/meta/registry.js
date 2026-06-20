import { Meta } from './meta.js';
import { NotFoundError } from '../runtime/errors.js';

// ---------------------------------------------------------------------------
// JSDoc typedefs — kept here because other modules import them by path.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FieldDef
 * @property {string} fieldname
 * @property {string} fieldtype   Data|Int|Float|Currency|Select|Check|Date|Datetime|Link|Table|Text|Code
 * @property {boolean} [reqd]
 * @property {string|string[]} [options]   Select: allowed values (array or \n-string); Link/Table: target doctype
 * @property {number} [permlevel] 0 = base (default); >0 = gated (Phase 2)
 * @property {boolean} [readOnly]
 * @property {boolean} [unique]   value must be unique across the table
 * @property {string} [fetchFrom] 'linkField.sourceField' — copy from a linked doc on save
 * @property {number} [idx]
 * @property {object} [dependsOn]          structured Condition object (NOT a string); e.g. {field,op,value} or {all:[]} / {any:[]} / {not:…}
 * @property {object} [mandatoryDependsOn] structured Condition object; field becomes mandatory when condition is truthy
 *
 * @typedef {Object} ChildTableDef
 * @property {string} field       parent fieldname holding the rows
 * @property {string} doctype     child doctype
 * @property {string} table       child table name
 *
 * @typedef {Object} DocPerm
 * @property {string} role
 * @property {string} doctype
 * @property {number} [permlevel]  default 0
 * @property {boolean} [read]
 * @property {boolean} [write]
 * @property {boolean} [create]
 * @property {boolean} [submit]
 * @property {boolean} [cancel]
 * @property {boolean} [delete]
 * @property {boolean} [ifOwner]
 *
 * @typedef {Object} DocMeta
 * @property {string} doctype
 * @property {string} table
 * @property {boolean} [submittable]
 * @property {boolean} [isStub]
 * @property {string} [autoname]  'hash' | 'field:<name>' | naming-series prefix
 * @property {FieldDef[]} fields
 * @property {ChildTableDef[]} childTables
 * @property {string[]} [scopeFields]  row-scope fields (e.g. ['branch']) for query conditions
 * @property {DocPerm[]} [permissions]
 */

// ---------------------------------------------------------------------------
// Module-scope singleton state (warm-lambda cache)
// ---------------------------------------------------------------------------

/** @type {Map<string, Meta>} */
const cache = new Map();
/** @type {Set<string>} — entries in this set are never evicted by invalidate() */
const pinned = new Set();
/** @type {string|null} */
let version = null;
/** @type {number} */
let versionCheckedAt = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a Meta for the doctype. SYNC, cache-only. Throws NotFoundError on a miss
 * (a miss is a programming error — something wasn't primed).
 * @param {string} doctype
 * @returns {Meta}
 */
export function getMeta(doctype) {
  const m = cache.get(doctype);
  if (!m) throw new NotFoundError(`Unknown doctype: ${doctype}`);
  return m;
}

/**
 * @param {string} doctype
 * @returns {boolean}
 */
export function hasMeta(doctype) {
  return cache.has(doctype);
}

/**
 * Store a Meta in the cache (called by the loader or primeFrom).
 * @param {string} doctype
 * @param {Meta|DocMeta} meta
 * @param {boolean} [isPinned]
 */
export function setMeta(doctype, meta, isPinned = false) {
  const m = meta instanceof Meta ? meta : new Meta(meta);
  cache.set(doctype, m);
  if (isPinned) pinned.add(doctype);
}

/** @returns {string[]} */
export function allDoctypes() {
  return Array.from(cache.keys());
}

/**
 * Prime the cache from an array of plain DocMeta or Meta objects.
 * @param {Array<DocMeta|Meta>} metas
 * @param {boolean} [isPinned]
 */
export function primeFrom(metas, isPinned = false) {
  for (const def of metas) {
    const doctype = def instanceof Meta ? def.doctype : def.doctype;
    setMeta(doctype, def, isPinned);
  }
}

/**
 * Invalidate non-pinned cache entries. If doctype is provided, clears only that
 * entry (unless pinned). If omitted, clears all non-pinned entries.
 * @param {string} [doctype]
 */
export function invalidate(doctype) {
  if (doctype !== undefined) {
    if (!pinned.has(doctype)) cache.delete(doctype);
  } else {
    for (const key of Array.from(cache.keys())) {
      if (!pinned.has(key)) cache.delete(key);
    }
  }
}

/**
 * Version state co-located with the cache (used by MetaLoader.ensureFresh).
 * @returns {{ version: string|null, versionCheckedAt: number }}
 */
export function getVersionState() {
  return { version, versionCheckedAt };
}

/**
 * @param {string|null} v
 * @param {number} checkedAt
 */
export function setVersionState(v, checkedAt) {
  version = v;
  versionCheckedAt = checkedAt;
}

// ---------------------------------------------------------------------------
// Test-only reset
// ---------------------------------------------------------------------------

/** Test only — clears cache AND pinned set AND version state. */
export function _resetRegistry() {
  cache.clear();
  pinned.clear();
  version = null;
  versionCheckedAt = 0;
}

// ---------------------------------------------------------------------------
// TEMPORARY backward-compat shim (PR-1 bridge)
//
// Existing tests import registerDoctype from this path and call it in
// beforeEach. This thin wrapper routes through primeFrom (and therefore Meta)
// so the 56-test suite stays green this wave. It is REMOVED in PR-6 once
// every caller has migrated to seedViaLoader / primeFrom.
// ---------------------------------------------------------------------------

/**
 * @deprecated Use primeFrom() or seedViaLoader() instead.
 * @param {DocMeta} meta
 */
export function registerDoctype(meta) {
  primeFrom([{ childTables: [], fields: [], permissions: [], scopeFields: [], ...meta }], false);
}
