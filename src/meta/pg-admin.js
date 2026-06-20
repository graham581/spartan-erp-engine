import postgres from 'postgres';

/**
 * Admin-only DIRECT-Postgres executor for DDL (CREATE/ALTER TABLE) — the one
 * thing PostgREST / supabase-js cannot do. This is NOT used on the per-request
 * hot path; only the Installer's migrate() flow calls it. It opens a
 * short-lived connection, runs the SQL, and closes it (no serverless pool
 * needed for an admin op).
 *
 * Requires DATABASE_URL — a Supabase Postgres connection string WITH the DB
 * password, in SESSION mode (DDL needs a session). Get it from:
 *   Supabase dashboard → Settings → Database → Connection string (Session mode).
 * Keep it in .env (gitignored) — never commit it.
 *
 * The executor is injectable so tests run hermetically without a real DB.
 */
export class PgAdmin {
  /** @param {(ddl: string) => Promise<void>} exec */
  constructor(exec) {
    this._exec = exec;
  }

  /** Build a real-connection PgAdmin from DATABASE_URL. */
  static fromEnv() {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('PgAdmin: set DATABASE_URL (Supabase Postgres connection string WITH the DB password, session mode)');
    }
    return new PgAdmin(async (ddl) => {
      const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 5 });
      try {
        await sql.unsafe(ddl); // raw DDL string
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  }

  /** Run a DDL string. Expected to be idempotent (IF NOT EXISTS). No-op on empty. */
  async applyDDL(ddl) {
    if (!ddl || !ddl.trim()) return;
    await this._exec(ddl);
  }
}
