import { getMeta } from '../meta/registry.js';
import { getDocPerms } from './registry.js';
import { PermissionError } from '../runtime/errors.js';

const FRAMEWORK_FIELDS = new Set([
  'name', 'docstatus', 'owner', 'idx', 'creation', 'modified', 'parent', 'parenttype', 'parentfield',
]);

/**
 * Doc-level op gate, evaluated at permlevel 0. Deny-by-default: true only if some
 * role the ctx holds has a permlevel-0 docperm granting `op`.
 * @param {import('./context.js').Ctx} ctx
 * @param {string} doctype
 * @param {'read'|'write'|'create'|'submit'|'cancel'|'delete'} op
 */
export function can(ctx, doctype, op) {
  if (!ctx || !Array.isArray(ctx.roles)) return false;
  return getDocPerms(doctype).some(
    (p) => (p.permlevel ?? 0) === 0 && ctx.roles.includes(p.role) && p[op] === true,
  );
}

/** Throw PermissionError unless can(). */
export function assertCan(ctx, doctype, op) {
  if (!can(ctx, doctype, op)) {
    throw new PermissionError(`${ctx?.user ?? 'anon'} may not ${op} ${doctype}`);
  }
}

/** Permlevels at which the ctx has `op` (read/write) for a doctype. @returns {Set<number>} */
function levels(ctx, doctype, op) {
  const set = new Set();
  if (!ctx || !Array.isArray(ctx.roles)) return set;
  for (const p of getDocPerms(doctype)) {
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
 * add an `owner` restriction when ownerOnly.
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
  if (ctx?.ownerOnly && ctx.user) filter.owner = ctx.user;
  return filter;
}
