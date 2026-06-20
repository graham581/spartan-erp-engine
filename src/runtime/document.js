import { randomUUID } from 'node:crypto';
import { getMeta } from '../meta/registry.js';
import { StateError, NotFoundError } from './errors.js';
import { resolveName } from './naming.js';
import { validateAgainstMeta } from './validate.js';
import { resolveFetchFrom, validateLinks } from './links.js';

const nowISO = () => new Date().toISOString();

/**
 * The mini-Frappe document: wraps a plain payload + its DocMeta and runs the
 * lifecycle (insert / save). Pipeline each write goes through:
 *   resolve fetch_from -> meta validation -> link validation -> controller
 *   validate() -> beforeSave() -> persist (+ children).
 * Business logic lives in controller subclasses overriding the hooks.
 */
export class Document {
  /**
   * @param {string} doctype
   * @param {import('./store.js').Row} doc
   * @param {import('./store.js').Store} store
   */
  constructor(doctype, doc, store) {
    this.doctype = doctype;
    this.doc = doc;
    this.store = store;
    this.meta = getMeta(doctype);
  }

  // ---- lifecycle hooks (override in controllers) ----
  async validate() {}
  async beforeSave() {}
  async beforeSubmit() {}
  /**
   * F1 INVARIANT: this hook runs INSIDE the submit transaction (on the tx-bound store).
   * A hook that creates another doc MUST construct it with `this.store` — the tx-bound store —
   * e.g. `await newDoc('GL Entry', data, this.store).insert()`.
   * NEVER capture an outer store or call `*.fromEnv()`; either commits OUTSIDE the tx
   * and breaks atomicity. (ADR §2.3)
   */
  async onSubmit() {}
  async beforeCancel() {}
  /**
   * F1 INVARIANT: this hook runs INSIDE the cancel transaction (on the tx-bound store).
   * A hook that creates another doc MUST construct it with `this.store` — the tx-bound store.
   * NEVER capture an outer store or call `*.fromEnv()`; either commits OUTSIDE the tx
   * and breaks atomicity. (ADR §2.3)
   */
  async onCancel() {}

  // ---- persistence ----
  async insert() {
    if (this.meta.issingle) this.doc.name = this.meta.doctype;                 // U6 — Singles use doctype as name
    if (!this.doc.name) this.doc.name = await resolveName(this.meta, this.doc, this.store);
    this.doc.docstatus ??= 0;
    this.doc.idx ??= 0;
    const t = nowISO();
    this.doc.creation ??= t;
    this.doc.modified = t;
    await this.#runChecks();
    await this.beforeSave();
    await this.store.insert(this.meta.table, this.#scalarRow());
    await this.#saveChildren();
    return this;
  }

  async save() {
    if (this.meta.issingle) this.doc.name = this.meta.doctype;                 // U6 — Singles use doctype as name
    if (!this.doc.name) return this.insert();
    this.doc.modified = nowISO();
    await this.#runChecks();
    await this.beforeSave();
    const existing = await this.store.get(this.meta.table, this.doc.name);
    if (existing) {
      const prev = existing.docstatus ?? 0;
      const next = this.doc.docstatus ?? 0;
      // Submitted/cancelled docs are immutable. The only legal saves at
      // docstatus>=1 are the transition saves themselves (docstatus changes).
      if (prev >= 1 && next === prev) {
        throw new StateError(`${this.doctype} ${this.doc.name} is ${prev === 1 ? 'submitted' : 'cancelled'} and cannot be edited`);
      }
      await this.store.update(this.meta.table, this.doc.name, this.#scalarRow());
    } else {
      await this.store.insert(this.meta.table, this.#scalarRow());
    }
    // children: replace wholesale (delete-then-insert) — simple and correct for v1
    for (const ct of this.meta.childTables) {
      await this.store.deleteChildren(ct.table, this.doc.name, this.doctype, ct.field);
    }
    await this.#saveChildren();
    return this;
  }

  // ---- internals ----
  async #runChecks() {
    await resolveFetchFrom(this.meta, this.doc, this.store);
    await validateAgainstMeta(this.meta, this.doc, this.store);
    await validateLinks(this.meta, this.doc, this.store);
    await this.validate(); // controller hook, after meta-driven checks
  }

  #childFieldNames() {
    return new Set(this.meta.childTables.map((c) => c.field));
  }

  #scalarRow() {
    const childFields = this.#childFieldNames();
    /** @type {import('./store.js').Row} */
    const row = { name: this.doc.name };
    for (const [k, v] of Object.entries(this.doc)) {
      if (childFields.has(k)) continue;
      row[k] = v;
    }
    return row;
  }

  async #saveChildren() {
    for (const ct of this.meta.childTables) {
      const rows = this.doc[ct.field] ?? [];
      let i = 0;
      for (const child of rows) {
        i += 1;
        child.name ??= randomUUID();
        child.parent = this.doc.name;
        child.parenttype = this.doctype;
        child.parentfield = ct.field;
        child.idx = i;
        child.docstatus ??= this.doc.docstatus ?? 0;
        child.creation ??= nowISO();
        child.modified = nowISO();
        await this.store.insert(ct.table, child);
      }
    }
  }
}

/** A submittable document gains the docstatus 0 -> 1 -> 2 transitions. */
export class SubmittableDocument extends Document {
  async submit() {
    if (!this.meta.submittable) throw new StateError(`${this.doctype} is not submittable`);
    if ((this.doc.docstatus ?? 0) !== 0) {
      throw new StateError(`Cannot submit ${this.doctype} ${this.doc.name}: docstatus is ${this.doc.docstatus}`);
    }
    this.doc.docstatus = 1;
    await this.beforeSubmit(); // may mutate doc -> persisted by save()
    await this.save();
    await this.onSubmit(); // post-commit side-effects
    return this;
  }

  async cancel() {
    if ((this.doc.docstatus ?? 0) !== 1) {
      throw new StateError(`Cannot cancel ${this.doctype} ${this.doc.name}: docstatus is ${this.doc.docstatus}`);
    }
    this.doc.docstatus = 2;
    await this.beforeCancel();
    await this.save();
    await this.onCancel();
    return this;
  }
}

// ---- controller registry + factory ----
/** @type {Map<string, typeof Document>} */
const registry = new Map();

/** Register a controller subclass for a doctype. @param {string} doctype @param {typeof Document} ctor */
export function registerController(doctype, ctor) {
  registry.set(doctype, ctor);
}

/** Build the right Document instance (registered controller > submittable default > plain). */
export function newDoc(doctype, doc, store) {
  const meta = getMeta(doctype);
  const Ctor = registry.get(doctype) ?? (meta.submittable ? SubmittableDocument : Document);
  return new Ctor(doctype, doc, store);
}

/** Load a document (with its child tables) from the store. */
export async function loadDoc(doctype, name, store) {
  const meta = getMeta(doctype);
  const row = await store.get(meta.table, name);
  // U6 — Singles "always exist": absent row → synthesise an empty doc with defaults.
  // The read still flows through the normal perms path (no short-circuit here).
  if (!row && meta.issingle) {
    const defaults = { name: meta.doctype };
    for (const f of meta.fields) {
      if (f.default !== undefined) defaults[f.fieldname] = f.default;
    }
    return newDoc(doctype, defaults, store);
  }
  if (!row) throw new NotFoundError(`${doctype} ${name} not found`);
  const doc = { ...row };
  for (const ct of meta.childTables) {
    const children = await store.getChildren(ct.table, name, doctype, ct.field);
    children.sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
    doc[ct.field] = children;
  }
  return newDoc(doctype, doc, store);
}
