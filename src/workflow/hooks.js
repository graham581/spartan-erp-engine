/**
 * hooks.js — in-code WORKFLOW_HOOKS map.
 *
 * The declarative parts of a workflow (states, transitions, roles, guard text)
 * live as rows in tabWorkflow + tabWorkflowTransition. The imperative parts —
 * condition checks and side-effect hooks that are real closures over (doc, ctx,
 * store) — cannot be DB rows. They live here, keyed by "Doctype::action".
 *
 * This is the code-vs-data split from ADR §6: data in the DB, code here.
 *
 * Key format: "<Doctype>::<action>"  (e.g. "Job::start_measure")
 * Value shape: { condition?, onTransition? }
 *   condition(doc, ctx, store) => boolean|Promise<boolean>
 *   onTransition(doc, ctx, store) => void|Promise<void>
 */

/**
 * @typedef {Object} WorkflowHook
 * @property {(doc:any, ctx:any, store:any) => boolean|Promise<boolean>} [condition]
 * @property {(doc:any, ctx:any, store:any) => void|Promise<void>} [onTransition]
 */

/** @type {Map<string, WorkflowHook>} */
export const WORKFLOW_HOOKS = new Map();

/**
 * Look up the code hooks for a (doctype, action) pair.
 * Returns an empty object if no hooks are registered — the caller treats
 * an undefined condition/onTransition as "no gate / no side-effect".
 * @param {string} doctype
 * @param {string} action
 * @returns {WorkflowHook}
 */
export function getHooks(doctype, action) {
  return WORKFLOW_HOOKS.get(`${doctype}::${action}`) ?? {};
}
