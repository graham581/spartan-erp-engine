/**
 * @typedef {Record<string, any> & { name?: string }} Row
 *
 * @typedef {Object} ListOpts
 * @property {Record<string, any>} [filters]  exact-match field filters (perm query-conditions merge in here)
 * @property {{ field: string, desc?: boolean }} [order]
 * @property {{ offset?: number, limit?: number }} [range]
 */

/**
 * The persistence contract. Concrete stores extend this:
 *   - MemoryStore  (tests + local dev, no DB)
 *   - SupabaseStore (prod; added in Phase 3)
 * Methods throw until overridden, so a half-built store fails loudly rather
 * than silently no-op'ing a write.
 */
export class Store {
  /** @param {string} table @param {string} name @returns {Promise<Row|null>} */
  async get(table, name) { throw new Error('Store.get not implemented'); }

  /** @param {string} table @param {Row} row @returns {Promise<Row>} */
  async insert(table, row) { throw new Error('Store.insert not implemented'); }

  /** @param {string} table @param {string} name @param {Row} row @returns {Promise<Row>} */
  async update(table, name, row) { throw new Error('Store.update not implemented'); }

  /** @param {string} table @param {ListOpts} [opts] @returns {Promise<Row[]>} */
  async list(table, opts) { throw new Error('Store.list not implemented'); }

  /** @returns {Promise<Row[]>} */
  async getChildren(table, parent, parenttype, parentfield) { throw new Error('Store.getChildren not implemented'); }

  /** @returns {Promise<void>} */
  async deleteChildren(table, parent, parenttype, parentfield) { throw new Error('Store.deleteChildren not implemented'); }

  /** Atomically allocate the next counter for a naming-series prefix.
   *  @param {string} prefix
   *  @returns {Promise<number|null>}  new value, or null if no atomic counter (caller falls back). */
  async nextSeries(prefix) { return null; }

  /** Run fn in a transaction; the arg is a tx-bound Store (read-your-writes).
   *  Base is a PASS-THROUGH (no real tx) — load-bearing for MemoryStore tests.
   *  @template T @param {(txStore: Store) => Promise<T>} fn @returns {Promise<T>} */
  async transaction(fn) { return await fn(this); }

  /** Capability flag — true iff transaction(fn) gives real (or pass-through-correct) atomicity.
   *  Base false; subclasses override. The handler selector reads THIS, never instanceof. */
  supportsTransactions = false;
}
