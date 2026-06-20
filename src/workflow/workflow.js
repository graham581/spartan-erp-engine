import { randomUUID } from 'node:crypto';
import { getMeta } from '../meta/registry.js';
import { getHooks } from './hooks.js';
import { PermissionError, StateError } from '../runtime/errors.js';

const nowISO = () => new Date().toISOString();
const LOG_TABLE = 'tabWorkflowAction';

/**
 * @typedef {Object} WorkflowTransitionDef
 * @property {string} from
 * @property {string} to
 * @property {string} action
 * @property {string[]} [roles]
 * @property {string} [guard]
 * @property {Function} [condition]
 * @property {Function} [onTransition]
 *
 * @typedef {Object} WorkflowDef
 * @property {string} doctype
 * @property {string} stateField
 * @property {string} initial
 * @property {string[]} states
 * @property {WorkflowTransitionDef[]} transitions
 */

// ---------------------------------------------------------------------------
// Local workflow-def cache (module-scope; mirrors the warm-lambda pattern of
// MetaRegistry). Keyed by doctype. Populated on first transition per doctype.
// Cleared in tests via _resetWorkflowCache().
// ---------------------------------------------------------------------------

/** @type {Map<string, WorkflowDef>} */
const WORKFLOW_DEFS = new Map();

/**
 * Assemble the WorkflowDef for a doctype from the Workflow + WorkflowTransition
 * rows in the store, then reattach any code hooks from WORKFLOW_HOOKS.
 * Caches the result so subsequent sync reads (availableActions) hit the cache.
 *
 * The Workflow "document_type" column is the lookup key. Transitions come from
 * tabWorkflowTransition as children of the Workflow row.
 *
 * @param {string} doctype
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<WorkflowDef|null>}
 */
async function loadWorkflow(doctype, store) {
  // tabWorkflow is described by the pinned Workflow meta-doctype (boot-meta.js).
  // Its table name comes from getMeta('Workflow').table — sync, always pinned.
  const wfMeta = getMeta('Workflow');
  const transMeta = getMeta('Workflow Transition');

  // Find the Workflow row whose document_type matches this doctype.
  const wfRows = await store.list(wfMeta.table, { filters: { document_type: doctype } });
  if (!wfRows.length) return null;
  const wfRow = wfRows[0];

  // Load the transition child rows.
  const transRows = await store.getChildren(
    transMeta.table,
    wfRow.name,
    'Workflow',
    'transitions',
  );

  // Sort by idx so transitions are in authored order.
  transRows.sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));

  // Derive the full states list from transition from/next_state values.
  const stateSet = new Set();
  for (const t of transRows) {
    if (t.state)      stateSet.add(t.state);
    if (t.next_state) stateSet.add(t.next_state);
  }

  // Map each transition row to the WorkflowTransition shape and reattach hooks.
  const transitions = transRows.map((t) => {
    const roles = t.allowed ? t.allowed.split('\n').map((r) => r.trim()).filter(Boolean) : undefined;
    const hooks  = getHooks(doctype, t.action);
    return {
      from:          t.state,
      to:            t.next_state,
      action:        t.action,
      roles,
      guard:         t.guard ?? undefined,
      condition:     hooks.condition,
      onTransition:  hooks.onTransition,
    };
  });

  /** @type {WorkflowDef} */
  const def = {
    doctype,
    stateField: wfRow.workflow_state_field,
    initial:    transRows[0]?.state ?? '',
    states:     Array.from(stateSet),
    transitions,
  };

  WORKFLOW_DEFS.set(doctype, def);
  return def;
}

/**
 * Get the WorkflowDef for a doctype. Cache-first; loads from the store on miss.
 * @param {string} doctype
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<WorkflowDef|null>}
 */
async function getWorkflow(doctype, store) {
  if (WORKFLOW_DEFS.has(doctype)) return WORKFLOW_DEFS.get(doctype);
  return loadWorkflow(doctype, store);
}

/** Test-only: clear the local workflow-def cache so each test starts fresh. */
export function _resetWorkflowCache() {
  WORKFLOW_DEFS.clear();
}

/**
 * Apply a workflow action to an already-loaded, scope-checked Document.
 * Coexists with docstatus: this moves the doc's state FIELD; submit/cancel
 * (docstatus) are a separate axis. Steps: find the transition for
 * (currentState, action) -> role-gate -> condition-gate (cross-doc, e.g. a
 * payment ledger) -> set state + save (full validate pipeline) -> side-effect
 * hook -> append an immutable transition-log row.
 * @param {import('../perms/context.js').Ctx} ctx
 * @param {import('../runtime/document.js').Document} d  loaded Document
 * @param {string} action
 * @param {import('../runtime/store.js').Store} store
 */
export async function transition(ctx, d, action, store) {
  const wf = await getWorkflow(d.doctype, store);
  if (!wf) throw new StateError(`${d.doctype} has no workflow`);

  const from = d.doc[wf.stateField] ?? wf.initial;
  const t = wf.transitions.find((tr) => tr.from === from && tr.action === action);
  if (!t) throw new StateError(`No transition '${action}' from state '${from}' on ${d.doctype}`);

  if (Array.isArray(t.roles) && !t.roles.some((r) => ctx.roles.includes(r))) {
    throw new PermissionError(`${ctx.user} may not '${action}' ${d.doctype} (requires ${t.roles.join('/')})`);
  }

  if (typeof t.condition === 'function') {
    const ok = await t.condition(d.doc, ctx, store);
    if (!ok) throw new StateError(`Transition '${action}' blocked: ${t.guard || 'condition not met'}`);
  }

  d.doc[wf.stateField] = t.to;
  await d.save(); // runs validate/links/immutability; not submittable -> state field is writable
  // F1 INVARIANT: `store` here IS the tx-bound store (passed through from transitionDoc).
  // An onTransition hook that creates another doc MUST use this `store` arg — NEVER a captured
  // outer store or `*.fromEnv()`; either commits OUTSIDE the tx and breaks atomicity. (ADR §2.3)
  if (typeof t.onTransition === 'function') await t.onTransition(d.doc, ctx, store);

  await store.insert(LOG_TABLE, {
    name: randomUUID(),
    ref_doctype: d.doctype,
    ref_name: d.doc.name,
    action,
    from_state: from,
    to_state: t.to,
    actor: ctx.user,
    timestamp: nowISO(),
  });
  return d;
}

/**
 * Actions available from the doc's current state for this ctx — drives the UI
 * (only show transitions the role may fire). Reads the module-scope cache;
 * requires the workflow def to have been loaded (via transition) before calling.
 * @param {import('../perms/context.js').Ctx} ctx
 * @param {import('../runtime/document.js').Document} d
 * @returns {string[]}
 */
export function availableActions(ctx, d) {
  const wf = WORKFLOW_DEFS.get(d.doctype) ?? null;
  if (!wf) return [];
  const from = d.doc[wf.stateField] ?? wf.initial;
  return wf.transitions
    .filter((t) => t.from === from && (!t.roles || t.roles.some((r) => ctx.roles.includes(r))))
    .map((t) => t.action);
}
