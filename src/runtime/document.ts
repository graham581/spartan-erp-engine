import { randomUUID } from 'node:crypto';
import { META, type DocMeta } from '../../generated/meta';
import type { DataStore, Row } from './store';

/** A loosely-typed document payload (scalar fields + child-table arrays). */
export type AnyDoc = Record<string, unknown> & {
  name?: string;
  docstatus?: number;
};

export function getMeta(doctype: string): DocMeta {
  const m = META[doctype];
  if (!m) throw new Error(`Unknown doctype: ${doctype}`);
  return m;
}

const nowISO = (): string => new Date().toISOString();

/**
 * The mini-Frappe document. Wraps a plain payload + its metadata and provides
 * the lifecycle: insert / save / (submit / cancel for submittables).
 * Business logic lives in subclasses overriding the hooks — base hooks no-op.
 */
export class Document {
  readonly meta: DocMeta;

  constructor(
    public readonly doctype: string,
    public doc: AnyDoc,
    protected store: DataStore,
  ) {
    this.meta = getMeta(doctype);
  }

  // ---- lifecycle hooks (override in controllers) ----
  async validate(): Promise<void> {}
  async beforeSave(): Promise<void> {}
  async beforeSubmit(): Promise<void> {}
  async onSubmit(): Promise<void> {}
  async onCancel(): Promise<void> {}

  // ---- persistence ----
  async insert(): Promise<this> {
    if (!this.doc.name) this.doc.name = this.autoname();
    this.doc.docstatus ??= 0;
    this.doc.idx ??= 0;
    const t = nowISO();
    this.doc.creation ??= t;
    this.doc.modified = t;
    await this.validate();
    await this.beforeSave();
    await this.store.insert(this.meta.table, this.scalarRow());
    await this.saveChildren();
    return this;
  }

  async save(): Promise<this> {
    if (!this.doc.name) return this.insert();
    this.doc.modified = nowISO();
    await this.validate();
    await this.beforeSave();
    const existing = await this.store.get(this.meta.table, this.doc.name);
    if (existing) await this.store.update(this.meta.table, this.doc.name, this.scalarRow());
    else await this.store.insert(this.meta.table, this.scalarRow());
    // children: replace wholesale (delete-then-insert) — simple and correct for v1
    for (const ct of this.meta.childTables) {
      await this.store.deleteChildren(ct.table, this.doc.name, this.doctype, ct.field);
    }
    await this.saveChildren();
    return this;
  }

  // ---- internals ----
  private childFieldNames(): Set<string> {
    return new Set(this.meta.childTables.map((c) => c.field));
  }

  private scalarRow(): Row {
    const childFields = this.childFieldNames();
    const row: Row = { name: this.doc.name as string };
    for (const [k, v] of Object.entries(this.doc)) {
      if (childFields.has(k)) continue;
      row[k] = v;
    }
    return row;
  }

  private async saveChildren(): Promise<void> {
    for (const ct of this.meta.childTables) {
      const rows = (this.doc[ct.field] as AnyDoc[] | undefined) ?? [];
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
        await this.store.insert(ct.table, child as Row);
      }
    }
  }

  private autoname(): string {
    const a = this.meta.autoname || '';
    if (a.startsWith('field:')) {
      const v = this.doc[a.slice('field:'.length)];
      if (v) return String(v);
    }
    // hash / naming_series / unspecified -> stable unique fallback
    return `${this.meta.table}-${randomUUID().slice(0, 8)}`;
  }
}

/** A submittable document gains the docstatus 0 -> 1 -> 2 transitions. */
export class SubmittableDocument extends Document {
  async submit(): Promise<this> {
    if (!this.meta.submittable) throw new Error(`${this.doctype} is not submittable`);
    if ((this.doc.docstatus ?? 0) !== 0) {
      throw new Error(`Cannot submit ${this.doctype} ${this.doc.name}: docstatus is ${this.doc.docstatus}`);
    }
    await this.beforeSubmit();
    this.doc.docstatus = 1;
    await this.save();
    await this.onSubmit();
    return this;
  }

  async cancel(): Promise<this> {
    if ((this.doc.docstatus ?? 0) !== 1) {
      throw new Error(`Cannot cancel ${this.doctype} ${this.doc.name}: docstatus is ${this.doc.docstatus}`);
    }
    this.doc.docstatus = 2;
    await this.save();
    await this.onCancel();
    return this;
  }
}

// ---- controller registry + factory ----
type DocCtor = new (doctype: string, doc: AnyDoc, store: DataStore) => Document;
const registry = new Map<string, DocCtor>();

/** Register a controller subclass for a doctype (Phase 4+). */
export function registerController(doctype: string, ctor: DocCtor): void {
  registry.set(doctype, ctor);
}

/** Build the right Document instance for a doctype (registered > submittable default > plain). */
export function newDoc(doctype: string, doc: AnyDoc, store: DataStore): Document {
  const meta = getMeta(doctype);
  const ctor = registry.get(doctype) ?? (meta.submittable ? SubmittableDocument : Document);
  return new ctor(doctype, doc, store);
}

/** Load a document (with its child tables) from the store. */
export async function loadDoc(doctype: string, name: string, store: DataStore): Promise<Document> {
  const meta = getMeta(doctype);
  const row = await store.get(meta.table, name);
  if (!row) throw new Error(`${doctype} ${name} not found`);
  const doc: AnyDoc = { ...row };
  for (const ct of meta.childTables) {
    const children = await store.getChildren(ct.table, name, doctype, ct.field);
    children.sort((a, b) => ((a.idx as number) ?? 0) - ((b.idx as number) ?? 0));
    doc[ct.field] = children;
  }
  return newDoc(doctype, doc, store);
}
