import { getMeta } from '../meta/registry.js';
import { newDoc, loadDoc } from '../runtime/document.js';
import { assertCan, assertCanWrite, maskRead, queryConditions } from '../perms/permissions.js';
import { NotFoundError, StateError } from '../runtime/errors.js';

/**
 * The born-perm-aware service layer. Every entry point:
 *   1. gates the op (assertCan, deny-by-default),
 *   2. enforces row-scope (queryConditions — a record outside scope reads as
 *      Not Found, so existence isn't leaked),
 *   3. enforces field-level writes (assertCanWrite),
 *   4. masks the response (maskRead).
 * The API/Vercel layer builds `ctx` from a verified identity and calls these;
 * it never trusts a client-supplied permission.
 */

/** True if `doc` satisfies the ctx's row-scope filter. */
function rowInScope(ctx, doctype, doc) {
  const filter = queryConditions(ctx, doctype);
  return Object.entries(filter).every(([k, v]) => doc[k] === v);
}

/** Load a doc and enforce row-scope; out-of-scope reads as Not Found. */
async function loadInScope(ctx, doctype, name, store) {
  const d = await loadDoc(doctype, name, store); // throws NotFoundError if missing
  if (!rowInScope(ctx, doctype, d.doc)) throw new NotFoundError(`${doctype} ${name} not found`);
  return d;
}

/** @param {import('../perms/context.js').Ctx} ctx */
export async function createDoc(ctx, doctype, payload, store) {
  assertCan(ctx, doctype, 'create');
  const doc = { ...payload, owner: ctx.user };
  assertCanWrite(ctx, doctype, {}, doc); // cannot set above-write-level fields on create
  const d = newDoc(doctype, doc, store);
  await d.insert();
  return maskRead(ctx, doctype, d.doc);
}

/** @param {import('../perms/context.js').Ctx} ctx */
export async function getDoc(ctx, doctype, name, store) {
  assertCan(ctx, doctype, 'read');
  const d = await loadInScope(ctx, doctype, name, store);
  return maskRead(ctx, doctype, d.doc);
}

/** @param {import('../perms/context.js').Ctx} ctx */
export async function listDocs(ctx, doctype, opts = {}, store) {
  assertCan(ctx, doctype, 'read');
  const meta = getMeta(doctype);
  const filters = { ...(opts.filters || {}), ...queryConditions(ctx, doctype) };
  const rows = await store.list(meta.table, { ...opts, filters });
  return rows.map((r) => maskRead(ctx, doctype, r));
}

/** @param {import('../perms/context.js').Ctx} ctx */
export async function updateDoc(ctx, doctype, name, patch, store) {
  assertCan(ctx, doctype, 'write');
  const d = await loadInScope(ctx, doctype, name, store);
  const before = { ...d.doc };
  Object.assign(d.doc, patch);
  assertCanWrite(ctx, doctype, before, d.doc);
  await d.save(); // also enforces docstatus immutability
  return maskRead(ctx, doctype, d.doc);
}

/** @param {import('../perms/context.js').Ctx} ctx */
export async function submitDoc(ctx, doctype, name, store) {
  assertCan(ctx, doctype, 'submit');
  const d = await loadInScope(ctx, doctype, name, store);
  if (typeof d.submit !== 'function') throw new StateError(`${doctype} is not submittable`);
  await d.submit();
  return maskRead(ctx, doctype, d.doc);
}

/** @param {import('../perms/context.js').Ctx} ctx */
export async function cancelDoc(ctx, doctype, name, store) {
  assertCan(ctx, doctype, 'cancel');
  const d = await loadInScope(ctx, doctype, name, store);
  if (typeof d.cancel !== 'function') throw new StateError(`${doctype} is not submittable`);
  await d.cancel();
  return maskRead(ctx, doctype, d.doc);
}
