import postgres from 'postgres';
import { Store } from './store.js';
import { loadPgStoreEnv } from '../validation/env-schema.js';

/**
 * Direct-Postgres Store implementation for atomic operations (submit / cancel /
 * transition / meta sync). Uses the Supabase transaction pooler (:6543) so each
 * `transaction(fn)` call maps to exactly one pooled backend connection.
 *
 * Connection config:
 *  - `prepare: false`  MANDATORY — PgBouncer transaction-mode rejects prepared statements.
 *  - `max: 1`          One pooled client per warm lambda; overlapping requests queue on
 *                      the single client (tunable to a small N — ADR §2.8).
 *  - `idle_timeout: 5` Close idle connections after 5 s (serverless hygiene).
 *
 * The injectable `sql` constructor arg mirrors pg-admin.js's `_exec` pattern so tests
 * can inject a fake tagged-template without opening a real DB connection.
 *
 * Identifier quoting: ALL table names and column names are double-quoted in generated
 * SQL. This is mandatory for reserved-word columns on tabDocPerm:
 *   "unique" "read" "write" "create" "submit" "cancel" "delete"
 * Values are always positional parameters ($1..$n), never interpolated.
 */
export class PgStore extends Store {
  supportsTransactions = true;

  /** @param {import('postgres').Sql} sql  a `postgres` tagged-template client or injected fake */
  constructor(sql) {
    super();
    this.sql = sql;
  }

  /** Build from DATABASE_URL_POOLER (transaction pooler :6543). Lazy module-scope
   *  singleton — resolved only when the injected store can't transact (ADR R1). */
  static fromEnv() {
    if (!PgStore._singleton) {
      const { DATABASE_URL_POOLER } = loadPgStoreEnv();
      PgStore._singleton = new PgStore(
        postgres(DATABASE_URL_POOLER, { prepare: false, max: 1, idle_timeout: 5 })
      );
    }
    return PgStore._singleton;
  }

  // ── read ────────────────────────────────────────────────────────────────────

  /** @param {string} table @param {string} name @returns {Promise<import('./store.js').Row|null>} */
  async get(table, name) {
    const rows = await this.sql.unsafe(
      `SELECT * FROM "${table}" WHERE "name" = $1`,
      [name]
    );
    return rows[0] ?? null;
  }

  /** @param {string} table @param {import('./store.js').ListOpts} [opts] @returns {Promise<import('./store.js').Row[]>} */
  async list(table, opts = {}) {
    const { filters = {}, order, range } = opts;

    const params = [];
    const conditions = [];
    for (const [k, v] of Object.entries(filters)) {
      params.push(v);
      conditions.push(`"${k}" = $${params.length}`);
    }

    let sql = `SELECT * FROM "${table}"`;
    if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
    if (order) {
      sql += ` ORDER BY "${order.field}"${order.desc ? ' DESC' : ''}`;
    }
    if (range) {
      const off = range.offset ?? 0;
      const lim = range.limit ?? 1000;
      params.push(lim);
      sql += ` LIMIT $${params.length}`;
      params.push(off);
      sql += ` OFFSET $${params.length}`;
    }

    return this.sql.unsafe(sql, params);
  }

  /** @returns {Promise<import('./store.js').Row[]>} */
  async getChildren(table, parent, parenttype, parentfield) {
    return this.sql.unsafe(
      `SELECT * FROM "${table}" WHERE "parent" = $1 AND "parenttype" = $2 AND "parentfield" = $3`,
      [parent, parenttype, parentfield]
    );
  }

  // ── write ───────────────────────────────────────────────────────────────────

  /** @param {string} table @param {import('./store.js').Row} row @returns {Promise<import('./store.js').Row>} */
  async insert(table, row) {
    const keys = Object.keys(row);
    const cols = keys.map((k) => `"${k}"`).join(', ');
    const params = keys.map((k) => row[k]);
    const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await this.sql.unsafe(
      `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) RETURNING *`,
      params
    );
    return rows[0];
  }

  /** @param {string} table @param {string} name @param {import('./store.js').Row} row @returns {Promise<import('./store.js').Row>} */
  async update(table, name, row) {
    const keys = Object.keys(row).filter((k) => k !== 'name');
    const params = keys.map((k) => row[k]);
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    params.push(name);
    const rows = await this.sql.unsafe(
      `UPDATE "${table}" SET ${sets} WHERE "name" = $${params.length} RETURNING *`,
      params
    );
    return rows[0];
  }

  /** @returns {Promise<void>} */
  async deleteChildren(table, parent, parenttype, parentfield) {
    await this.sql.unsafe(
      `DELETE FROM "${table}" WHERE "parent" = $1 AND "parenttype" = $2 AND "parentfield" = $3`,
      [parent, parenttype, parentfield]
    );
  }

  // ── atomic series ────────────────────────────────────────────────────────────

  /** @param {string} prefix @returns {Promise<number>} */
  async nextSeries(prefix) {
    // Non-prepared (prepare:false already set; .unsafe keeps it explicit)
    const rows = await this.sql.unsafe(
      'SELECT next_series($1) AS current',
      [prefix]
    );
    return Number(rows[0].current);
  }

  // ── transaction ──────────────────────────────────────────────────────────────

  /** Run fn in a real Postgres transaction; fn receives a PgStore bound to the tx
   *  connection (read-your-writes, one unit). Mirrors frappe.db.begin/commit.
   *  @template T @param {(txStore: PgStore) => Promise<T>} fn @returns {Promise<T>} */
  async transaction(fn) {
    return this.sql.begin(async (txSql) => fn(new PgStore(txSql)));
  }
}

// Module-scope lazy singleton — reset between tests if needed.
PgStore._singleton = null;
