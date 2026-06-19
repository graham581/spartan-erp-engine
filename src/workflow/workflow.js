import { randomUUID } from 'node:crypto';
import { getWorkflow } from './registry.js';
import { PermissionError, StateError } from '../runtime/errors.js';

const nowISO = () => new Date().toISOString();
const LOG_TABLE = 'tabWorkflowAction';

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
  const wf = getWorkflow(d.doctype);
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
 * (only show transitions the role may fire).
 * @param {import('../perms/context.js').Ctx} ctx
 * @param {import('../runtime/document.js').Document} d
 * @returns {string[]}
 */
export function availableActions(ctx, d) {
  const wf = getWorkflow(d.doctype);
  if (!wf) return [];
  const from = d.doc[wf.stateField] ?? wf.initial;
  return wf.transitions
    .filter((t) => t.from === from && (!t.roles || t.roles.some((r) => ctx.roles.includes(r))))
    .map((t) => t.action);
}
