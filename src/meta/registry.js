import { NotFoundError } from '../runtime/errors.js';

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
 *
 * @typedef {Object} ChildTableDef
 * @property {string} field       parent fieldname holding the rows
 * @property {string} doctype     child doctype
 * @property {string} table       child table name
 *
 * @typedef {Object} DocMeta
 * @property {string} doctype
 * @property {string} table
 * @property {boolean} [submittable]
 * @property {string} [autoname]  'hash' | 'field:<name>' | naming-series prefix
 * @property {FieldDef[]} fields
 * @property {ChildTableDef[]} childTables
 */

/** @type {Record<string, DocMeta>} */
const META = {};

/**
 * Register (or replace) a doctype definition. The generator's output calls this
 * (Phase: generator rebuild); seed/test fixtures call it directly.
 * @param {DocMeta} meta
 */
export function registerDoctype(meta) {
  META[meta.doctype] = { childTables: [], fields: [], ...meta };
}

/** @param {string} doctype @returns {DocMeta} */
export function getMeta(doctype) {
  const m = META[doctype];
  if (!m) throw new NotFoundError(`Unknown doctype: ${doctype}`);
  return m;
}

export function allDoctypes() {
  return Object.keys(META);
}

/** Test/dev only: clear the registry between cases. */
export function _resetRegistry() {
  for (const k of Object.keys(META)) delete META[k];
}
