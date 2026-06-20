import { getMeta } from '../meta/registry.js';
import { PermissionError } from '../runtime/errors.js';

const FRAMEWORK_FIELDS = new Set([
  'name', 'docstatus', 'owner', 'idx', 'creation', 'modified', 'parent', 'parenttype', 'parentfield',
]);

/**
 * Returns true iff ctx holds a permlevel-0 docperm for `op` on `doctype`
 * that is NOT an if_owner (i.e. a plain/unconditional grant).
 * @param {import('./context.js').Ctx} ctx
 * @param {string} doctype
 * @param {string} op
 * @returns {boolean}
 */
function hasPlainGrant(ctx, doctype, op) {
  if (!ctx || !Array.isArray(ctx.roles)) return false;
  return getMeta(doctype).getDocPerms().some(
    // For 'create', ifOwner is meaningless (no doc exists yet to own) so treat any
    // create===true row as a plain grant regardless of the ifOwner flag.
    (p) => (p.permlevel ?? 0) === 0 && ctx.roles.includes(p.role) && p[op] === true && (op === 'create' || p.ifOwner !== true),
  );
}

/**
 * Returns true iff ctx holds a permlevel-0 docperm for `op` on `doctype`
 * that IS an if_owner grant. `create` is excluded — Frappe never applies
 * if_owner to create (you can't be the owner before the doc exists).
 * @param {import('./context.js').Ctx} ctx
 * @param {string} doctype
 * @param {string} op
 * @returns {boolean}
 */
function hasOwnerGrant(ctx, doctype, op) {
  if (op === 'create') return false;
  if (!ctx || !Array.isArray(ctx.roles)) return false;
  return getMeta(doctype).getDocPerms().some(
    (p) => (p.permlevel ?? 0) === 0 && ctx.roles.includes(p.role) && p[op] === true && p.ifOwner === true,
  );
}

/**
 * Doc-level op gate, evaluated at permlevel 0. Implements the Frappe
 * permissions.py L300-345 formula with if_owner support.
 *
 * - `doc` is optional. When omitted and the only matching grant is if_owner,
 *   the result is true only for 'read' (list-level pre-filter) — all other
 *   owner-only ops need the record loaded first.
 * - When `doc` is provided its `owner` field is checked against `ctx.user`.
 *
 * @param {import('./context.js').Ctx} ctx
 * @param {string} doctype
 * @param {'read'|'write'|'create'|'submit'|'cancel'|'delete'} op
 * @param {Record<string, any>} [doc]   optional loaded doc (for owner check)
 * @returns {boolean}
 */
export function can(ctx, doctype, op, doc) {
  if (hasPlainGrant(ctx, doctype, op)) return true;
  if (!hasOwnerGrant(ctx, doctype, op)) return false;
  if (doc !== undefined) return doc.owner === ctx.user;
  return op === 'read';
}

/**
 * Throw PermissionError unless can(). Accepts an optional doc for owner checks
 * (mirrors the optional-doc signature of can()).
 * @param {import('./context.js').Ctx} ctx
 * @param {string} doctype
 * @param {'read'|'write'|'create'|'submit'|'cancel'|'delete'} op
 * @param {Record<string, any>} [doc]
 */
export function assertCan(ctx, doctype, op, doc) {
  if (!can(ctx, doctype, op, doc)) {
    throw new PermissionError(`${ctx?.user ?? 'anon'} may not ${op} ${doctype}`);
  }
}

/**
 * Cheap pre-load probe: throws PermissionError unless the ctx holds at least
 * a plain or owner grant for `op` on `doctype` (without needing the doc).
 * Paired with a post-load assertCan(ctx, dt, op, doc) check in U8/service.
 * @param {import('./context.js').Ctx} ctx
 * @param {string} doctype
 * @param {'read'|'write'|'create'|'submit'|'cancel'|'delete'} op
 */
export function assertCanMutate(ctx, doctype, op) {
  if (!hasPlainGrant(ctx, doctype, op) && !hasOwnerGrant(ctx, doctype, op)) {
    throw new PermissionError(`${ctx?.user ?? 'anon'} may not ${op} ${doctype}`);
  }
}

/** Permlevels at which the ctx has `op` (read/write) for a doctype. @returns {Set<number>} */
function levels(ctx, doctype, op) {
  const set = new Set();
  if (!ctx || !Array.isArray(ctx.roles)) return set;
  for (const p of getMeta(doctype).getDocPerms()) {
    if (ctx.roles.includes(p.role) && p[op] === true) set.add(p.permlevel ?? 0);
  }
  return set;
}

/** Fieldnames the ctx may read (field.permlevel within the ctx's read permlevels). */
export function visibleFields(ctx, doctype) {
  const meta = getMeta(doctype);
  const readable = levels(ctx, doctype, 'read');
  return meta.fields.filter((f) => readable.has(f.permlevel ?? 0)).map((f) => f.fieldname);
}

/** Copy of `doc` with fields the ctx can't read removed. Framework + child-table
 *  fields are always kept (their visibility is governed by doc-level read). */
export function maskRead(ctx, doctype, doc) {
  const meta = getMeta(doctype);
  const allowed = new Set(visibleFields(ctx, doctype));
  const childFields = new Set(meta.childTables.map((c) => c.field));
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (FRAMEWORK_FIELDS.has(k) || childFields.has(k) || allowed.has(k)) out[k] = v;
  }
  return out;
}

/** Throw if any field above the ctx's write permlevels changed between before/after. */
export function assertCanWrite(ctx, doctype, before, after) {
  const meta = getMeta(doctype);
  const writable = levels(ctx, doctype, 'write');
  for (const f of meta.fields) {
    const lvl = f.permlevel ?? 0;
    if (writable.has(lvl)) continue;
    const b = before ? before[f.fieldname] : undefined;
    const a = after ? after[f.fieldname] : undefined;
    if (a !== b) {
      throw new PermissionError(`${ctx?.user ?? 'anon'} may not write ${doctype}.${f.fieldname} (permlevel ${lvl})`);
    }
  }
}

/**
 * Row-scope filter for list/get. EXPLICIT `unrestricted` -> no filter (admin is
 * scoped by an explicit grant, never by a role short-circuit). Otherwise
 * intersect the doctype's declared scopeFields with the ctx's scope values and
 * add an `owner` restriction when the ctx's only read grant is if_owner.
 * @param {import('./context.js').Ctx} ctx @param {string} doctype
 * @returns {Record<string, any>}
 */
export function queryConditions(ctx, doctype) {
  if (ctx?.unrestricted) return {};
  const meta = getMeta(doctype);
  /** @type {Record<string, any>} */
  const filter = {};
  for (const field of meta.scopeFields ?? []) {
    if (ctx?.scopes && ctx.scopes[field] !== undefined) filter[field] = ctx.scopes[field];
  }
  if (hasOwnerGrant(ctx, doctype, 'read') && !hasPlainGrant(ctx, doctype, 'read') && ctx?.user) {
    filter.owner = ctx.user;
  }
  return filter;
}
