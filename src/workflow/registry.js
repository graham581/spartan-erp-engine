/**
 * @typedef {Object} WorkflowTransition
 * @property {string} from       state this transition leaves
 * @property {string} to         state it lands in
 * @property {string} action     the verb the caller invokes (e.g. 'start_measure')
 * @property {string[]} [roles]   roles allowed to fire it (omit = any role that can write)
 * @property {(doc:any, ctx:any, store:any)=>boolean|Promise<boolean>} [condition]  cross-doc/field gate
 * @property {string} [guard]    message when the condition blocks
 * @property {(doc:any, ctx:any, store:any)=>void|Promise<void>} [onTransition]  side-effect hook
 *
 * @typedef {Object} WorkflowDef
 * @property {string} doctype
 * @property {string} stateField  field on the doc holding the workflow state (e.g. 'status')
 * @property {string} initial     state assumed when the field is unset
 * @property {string[]} states
 * @property {WorkflowTransition[]} transitions
 */

/** @type {Record<string, WorkflowDef>} */
const WORKFLOWS = {};

/** Register a declarative workflow for a doctype. @param {WorkflowDef} def */
export function registerWorkflow(def) {
  WORKFLOWS[def.doctype] = def;
}

/** @param {string} doctype @returns {WorkflowDef|null} */
export function getWorkflow(doctype) {
  return WORKFLOWS[doctype] ?? null;
}

/** Test/dev only: clear the workflow registry. */
export function _resetWorkflows() {
  for (const k of Object.keys(WORKFLOWS)) delete WORKFLOWS[k];
}
