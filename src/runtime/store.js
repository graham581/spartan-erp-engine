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
}
