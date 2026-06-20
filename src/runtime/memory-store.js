import { Store } from './store.js';

/**
 * In-memory store for tests + local dev. Copies rows on the boundary so callers
 * can't mutate stored state by reference.
 */
export class MemoryStore extends Store {
  /** @type {Map<string, Map<string, import('./store.js').Row>>} */
  #tables = new Map();
  /** @type {Map<string, number>} */
  #series = new Map();

  supportsTransactions = true;
  // transaction: INHERITED — base pass-through is exactly right for single-threaded tests

  /** @param {string} table */
  #t(table) {
    let m = this.#tables.get(table);
    if (!m) { m = new Map(); this.#tables.set(table, m); }
    return m;
  }

  async nextSeries(prefix) {
    const n = (this.#series.get(prefix) ?? 0) + 1;
    this.#series.set(prefix, n);
    return n;
  }

  async get(table, name) {
    const r = this.#t(table).get(name);
    return r ? { ...r } : null;
  }

  async insert(table, row) {
    this.#t(table).set(String(row.name), { ...row });
    return { ...row };
  }

  async update(table, name, row) {
    this.#t(table).set(name, { ...row });
    return { ...row };
  }

  async list(table, opts = {}) {
    const { filters = {}, order, range } = opts;
    let rows = [...this.#t(table).values()].map((r) => ({ ...r }));
    for (const [k, v] of Object.entries(filters)) rows = rows.filter((r) => r[k] === v);
    if (order) {
      const dir = order.desc ? -1 : 1;
      rows.sort((a, b) => {
        const av = a[order.field], bv = b[order.field];
        return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
      });
    }
    if (range) {
      const off = range.offset ?? 0;
      rows = rows.slice(off, off + (range.limit ?? rows.length));
    }
    return rows;
  }

  async getChildren(table, parent, parenttype, parentfield) {
    return [...this.#t(table).values()]
      .filter((r) => r.parent === parent && r.parenttype === parenttype && r.parentfield === parentfield)
      .map((r) => ({ ...r }));
  }

  async deleteChildren(table, parent, parenttype, parentfield) {
    const t = this.#t(table);
    for (const [name, r] of t) {
      if (r.parent === parent && r.parenttype === parenttype && r.parentfield === parentfield) t.delete(name);
    }
  }
}
