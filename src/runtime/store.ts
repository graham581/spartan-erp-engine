/**
 * Storage abstraction the document runtime writes through.
 * Two implementations: MemoryStore (tests / local) and SupabaseStore (prod).
 * Dependency inversion — the runtime never imports Supabase directly.
 */
export type Row = Record<string, unknown> & { name: string };

export interface DataStore {
  get(table: string, name: string): Promise<Row | null>;
  insert(table: string, row: Row): Promise<void>;
  update(table: string, name: string, row: Row): Promise<void>;
  delete(table: string, name: string): Promise<void>;
  getChildren(
    table: string,
    parent: string,
    parenttype: string,
    parentfield: string,
  ): Promise<Row[]>;
  deleteChildren(
    table: string,
    parent: string,
    parenttype: string,
    parentfield: string,
  ): Promise<void>;
}

/** In-memory store. Deep-clones on read/write so callers can't mutate storage. */
export class MemoryStore implements DataStore {
  private tables = new Map<string, Map<string, Row>>();

  private tbl(table: string): Map<string, Row> {
    let m = this.tables.get(table);
    if (!m) {
      m = new Map();
      this.tables.set(table, m);
    }
    return m;
  }

  async get(table: string, name: string): Promise<Row | null> {
    const row = this.tbl(table).get(name);
    return row ? structuredClone(row) : null;
  }

  async insert(table: string, row: Row): Promise<void> {
    this.tbl(table).set(row.name, structuredClone(row));
  }

  async update(table: string, name: string, row: Row): Promise<void> {
    this.tbl(table).set(name, structuredClone(row));
  }

  async delete(table: string, name: string): Promise<void> {
    this.tbl(table).delete(name);
  }

  async getChildren(
    table: string,
    parent: string,
    parenttype: string,
    parentfield: string,
  ): Promise<Row[]> {
    return [...this.tbl(table).values()]
      .filter(
        (r) => r.parent === parent && r.parenttype === parenttype && r.parentfield === parentfield,
      )
      .map((r) => structuredClone(r));
  }

  async deleteChildren(
    table: string,
    parent: string,
    parenttype: string,
    parentfield: string,
  ): Promise<void> {
    const m = this.tbl(table);
    for (const [key, r] of m) {
      if (r.parent === parent && r.parenttype === parenttype && r.parentfield === parentfield) {
        m.delete(key);
      }
    }
  }
}
