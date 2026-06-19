import { getMeta } from '../meta/registry.js';
import { ValidationError } from './errors.js';

/**
 * Resolve `fetchFrom` fields: copy a value from a linked document.
 * A field with `fetchFrom: 'customer.territory'` means "set me to the
 * `territory` of the doc my `customer` Link field points at". Runs before
 * validation so fetched values can satisfy reqd. Silent no-op when the link is
 * empty or its target doctype isn't registered.
 * @param {import('../meta/registry.js').DocMeta} meta
 * @param {Record<string, any>} doc
 * @param {import('./store.js').Store} store
 */
export async function resolveFetchFrom(meta, doc, store) {
  for (const f of meta.fields) {
    if (!f.fetchFrom) continue;
    const [linkField, sourceField] = f.fetchFrom.split('.');
    const linkVal = doc[linkField];
    if (!linkVal) continue;
    const linkDef = meta.fields.find((x) => x.fieldname === linkField);
    if (!linkDef || !linkDef.options) continue;
    const target = tryMeta(linkDef.options);
    if (!target) continue;
    const row = await store.get(target.table, String(linkVal));
    if (row) doc[f.fieldname] = row[sourceField];
  }
}

/**
 * Validate that Link field values point at existing records. Skips fields whose
 * target doctype isn't registered yet (incremental-build friendly), so a Link
 * to a not-yet-modelled master doesn't hard-fail.
 * @param {import('../meta/registry.js').DocMeta} meta
 * @param {Record<string, any>} doc
 * @param {import('./store.js').Store} store
 */
export async function validateLinks(meta, doc, store) {
  for (const f of meta.fields) {
    if (f.fieldtype !== 'Link' || !f.options) continue;
    const v = doc[f.fieldname];
    if (v === undefined || v === null || v === '') continue;
    const target = tryMeta(f.options);
    if (!target) continue; // target doctype not modelled yet — skip
    const row = await store.get(target.table, String(v));
    if (!row) throw new ValidationError(`${meta.doctype}.${f.fieldname}: linked ${f.options} '${v}' does not exist`);
  }
}

/** @returns {import('../meta/registry.js').DocMeta|null} */
function tryMeta(doctype) {
  try { return getMeta(doctype); } catch { return null; }
}
