import { ValidationError } from './errors.js';
import { isRelevant } from './depends-on.js';

const NUMERIC = new Set(['Int', 'Float', 'Currency']);

/**
 * Meta-driven field validation — run by Document before the controller's custom
 * validate(). Enforces reqd, Select options, numeric/Check typing, and (when a
 * store is supplied) unique fields. Operates on the parent's scalar fields;
 * child-row validation is a follow-up.
 * @param {import('../meta/registry.js').DocMeta} meta
 * @param {Record<string, any>} doc
 * @param {import('./store.js').Store} [store]
 */
export async function validateAgainstMeta(meta, doc, store) {
  for (const f of meta.fields) {
    if (f.dependsOn && !isRelevant(f.dependsOn, doc)) continue;        // relevance gate FIRST
    const v = doc[f.fieldname];
    const empty = v === undefined || v === null || v === '';
    const required = f.reqd || (f.mandatoryDependsOn && isRelevant(f.mandatoryDependsOn, doc));
    if (required && empty) throw new ValidationError(`${meta.doctype}: '${f.fieldname}' is required`);
    if (empty) continue;

    if (f.fieldtype === 'Select') {
      const opts = optionList(f);
      if (opts && !opts.includes(String(v))) {
        throw new ValidationError(`${meta.doctype}.${f.fieldname}: '${v}' not in [${opts.join(', ')}]`);
      }
    }
    if (NUMERIC.has(f.fieldtype) && typeof v !== 'number') {
      throw new ValidationError(`${meta.doctype}.${f.fieldname}: expected a number, got ${typeof v}`);
    }
    if (f.fieldtype === 'Check' && typeof v !== 'boolean' && v !== 0 && v !== 1) {
      throw new ValidationError(`${meta.doctype}.${f.fieldname}: expected boolean/0/1`);
    }
    if (f.unique && store) {
      const rows = await store.list(meta.table, { filters: { [f.fieldname]: v } });
      const clash = rows.find((r) => r.name !== doc.name);
      if (clash) throw new ValidationError(`${meta.doctype}.${f.fieldname}: '${v}' must be unique (already on ${clash.name})`);
    }
  }
}

/** Select options may be an array or a newline-separated string. @returns {string[]|null} */
function optionList(f) {
  if (Array.isArray(f.options)) return f.options.map(String);
  if (typeof f.options === 'string') return f.options.split('\n').map((s) => s.trim()).filter(Boolean);
  return null;
}
