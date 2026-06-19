/**
 * @typedef {Object} DocPerm
 * @property {string} role
 * @property {string} doctype
 * @property {number} [permlevel]  default 0; doc-level ops live at 0, field access at >0
 * @property {boolean} [read]
 * @property {boolean} [write]
 * @property {boolean} [create]
 * @property {boolean} [submit]
 * @property {boolean} [cancel]
 * @property {boolean} [delete]
 */

/** @type {DocPerm[]} */
const PERMS = [];

/** Register a role permission row (the generator/seed feeds these). @param {DocPerm} row */
export function registerRolePerm(row) {
  PERMS.push({ permlevel: 0, ...row });
}

/** All docperm rows for a doctype. @param {string} doctype @returns {DocPerm[]} */
export function getDocPerms(doctype) {
  return PERMS.filter((p) => p.doctype === doctype);
}

/** Test/dev only: clear the perm registry. */
export function _resetPerms() {
  PERMS.length = 0;
}
