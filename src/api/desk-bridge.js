/**
 * desk-bridge.js — read-only metadata projection service for the Desk client.
 *
 * Two exports:
 *   buildBoot(ctx, store)              → lean boot object (identity + permitted doctype names)
 *   buildMeta(ctx, doctype, store)     → permission-masked meta bundle for one doctype
 *
 * Both compose existing primitives only (ensure, getMeta, can, visibleFields,
 * getWorkflow, store.list, allDoctypes). No new write or trust surface.
 *
 * ADR: docs/adr-desk-bridge.md
 * Work order: docs/workorder-desk-bridge.md
 */

import { ensure }                     from '../meta/loader.js';
import { getMeta, allDoctypes }       from '../meta/registry.js';
import { can, visibleFields }         from '../perms/permissions.js';
import { getWorkflow }                from '../workflow/workflow.js';
import { NotFoundError, PermissionError } from '../runtime/errors.js';

// ---------------------------------------------------------------------------
// Internal helper — project one meta with permlevel-masked fields.
// NEVER includes m.permissions / raw DocPerm rows.
// ---------------------------------------------------------------------------

/**
 * @param {import('../perms/context.js').Ctx} ctx
 * @param {string} dt
 * @returns {{ doctype:string, autoname:string|undefined, submittable:boolean,
 *             issingle:boolean, istable:boolean, isStub:boolean,
 *             fields:import('../meta/registry.js').FieldDef[],
 *             childTables:import('../meta/registry.js').ChildTableDef[],
 *             scopeFields:string[] }}
 */
function projectMeta(ctx, dt) {
  const m = getMeta(dt);
  const allowed = new Set(visibleFields(ctx, dt));
  const fields = m.fields.filter((f) => allowed.has(f.fieldname));
  return {
    doctype:      m.doctype,
    autoname:     m.autoname,
    submittable:  m.submittable,
    issingle:     m.issingle,
    istable:      m.istable,
    isStub:       m.isStub,
    fields,
    childTables:  m.childTables,
    scopeFields:  m.scopeFields ?? [],
  };
}

// ---------------------------------------------------------------------------
// buildBoot
// ---------------------------------------------------------------------------

/**
 * Produce the lean boot object: identity + names of doctypes the ctx may read.
 * istable, isStub, and no-read doctypes are all excluded.
 * GUEST naturally yields an empty doctypes list (can(read) is false for all).
 * A doctype whose ensure() or getMeta() throws is OMITTED and logged — it must
 * not 500 the whole boot for the others.
 *
 * @param {import('../perms/context.js').Ctx} ctx
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<{user:string, roles:string[], scopes:Record<string,any>,
 *                    doctypes:string[], server_date:string}>}
 */
export async function buildBoot(ctx, store) {
  const server_date = new Date().toISOString().slice(0, 10);

  // Candidate names: store rows (non-stub) unioned with warm-cache names.
  const rows = await store.list('tabDocType', { filters: { is_stub: false } });
  const storeNames = rows.map((r) => r.name);
  const allNames = Array.from(new Set([...storeNames, ...allDoctypes()]));

  const doctypes = [];
  for (const name of allNames) {
    try {
      await ensure(name, store);
      const m = getMeta(name);
      if (!m.istable && !m.isStub && can(ctx, name, 'read')) {
        doctypes.push(name);
      }
    } catch (e) {
      // Omit-and-log: one bad doctype must never 500 the whole boot.
      console.warn(`[desk-bridge] buildBoot: skipping doctype "${name}" — ${e.message}`);
    }
  }

  return {
    user:        ctx.user,
    roles:       ctx.roles,
    scopes:      ctx.scopes ?? {},
    doctypes,
    server_date,
  };
}

// ---------------------------------------------------------------------------
// buildMeta
// ---------------------------------------------------------------------------

/**
 * Produce the permission-masked meta bundle for one doctype.
 *
 * Order of guards (FROZEN):
 *   1. ensure() — unknown doctype → NotFoundError → 404 (before any read-gate leak)
 *   2. !can(read) → PermissionError → 403
 *   3. Project meta, capabilities, child_metas, workflow.
 *
 * @param {import('../perms/context.js').Ctx} ctx
 * @param {string} doctype
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<{
 *   doctype: string,
 *   capabilities: {read:boolean, write:boolean, create:boolean, delete:boolean, submit:boolean, cancel:boolean},
 *   meta: object,
 *   child_metas: Record<string, object>,
 *   workflow: {stateField:string, states:string[], transitions:Array<{from:string,to:string,action:string,roles:string[]|undefined}>} | null
 * }>}
 * @throws {NotFoundError} if the doctype is unknown (→ 404)
 * @throws {PermissionError} if the ctx may not read the doctype (→ 403)
 */
export async function buildMeta(ctx, doctype, store) {
  // 1. Prime — throws NotFoundError for an unknown doctype (before any read-gate).
  await ensure(doctype, store);

  // 2. Read gate — 403 first, before any projection.
  if (!can(ctx, doctype, 'read')) {
    throw new PermissionError(`${ctx?.user ?? 'anon'} may not read ${doctype}`);
  }

  // 3. Capabilities — cosmetic booleans only; the engine re-checks on every real call.
  const capabilities = {
    read:   can(ctx, doctype, 'read'),
    write:  can(ctx, doctype, 'write'),
    create: can(ctx, doctype, 'create'),
    delete: can(ctx, doctype, 'delete'),
    submit: can(ctx, doctype, 'submit'),
    cancel: can(ctx, doctype, 'cancel'),
  };

  // 4. Masked parent meta.
  const meta = projectMeta(ctx, doctype);

  // 5. Inline child metas — childTables ONLY (Table edges).
  //    Link targets are structurally absent from childTables, so they are never inlined.
  //    No per-child can() gate: children inherit the parent's read grant (F3).
  /** @type {Record<string, object>} */
  const child_metas = {};
  const m = getMeta(doctype);
  for (const c of m.childTables) {
    child_metas[c.doctype] = projectMeta(ctx, c.doctype);
  }

  // 6. Workflow graph — project to a serializable shape; drop condition/onTransition functions.
  const wf = await getWorkflow(doctype, store);
  const workflow = wf
    ? {
        stateField:  wf.stateField,
        states:      wf.states,
        transitions: wf.transitions.map((t) => ({
          from:   t.from,
          to:     t.to,
          action: t.action,
          roles:  t.roles,
        })),
      }
    : null;

  return { doctype, capabilities, meta, child_metas, workflow };
}
