import { createClient } from '@supabase/supabase-js';
import { Store } from './store.js';

/**
 * Production store backed by Supabase Postgres (service-role key — runs
 * server-side only, never in the browser). Table names are the doctype's
 * `meta.table`. Rows are keyed by `name`.
 *
 * Naming-series atomicity: `naming.nextSeries` currently does read-inc-write via
 * get/update, which is NOT atomic under concurrent Vercel invocations. The fix
 * is a Postgres RPC (`create function next_series(prefix text) returns int ...
 * update tab_series set current = current + 1 where name = prefix returning
 * current`) called from here — wire `nextSeriesRpc()` once that migration lands.
 */
export class SupabaseStore extends Store {
  supportsTransactions = false;

  /** @param {import('@supabase/supabase-js').SupabaseClient} client */
  constructor(client) {
    super();
    this.sb = client;
  }

  async nextSeries(prefix) {
    const { data, error } = await this.sb.rpc('next_series', { prefix });
    if (error) throw new Error(`SupabaseStore.nextSeries ${prefix}: ${error.message}`);
    return data == null ? null : Number(data);
  }

  async transaction(fn) {
    throw new Error('SupabaseStore has no transactions — route atomic ops through PgStore');
  }

  /** Build from SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. */
  static fromEnv() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SupabaseStore: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    return new SupabaseStore(createClient(url, key, { auth: { persistSession: false } }));
  }

  async get(table, name) {
    const { data, error } = await this.sb.from(table).select('*').eq('name', name).maybeSingle();
    if (error) throw new Error(`SupabaseStore.get ${table}/${name}: ${error.message}`);
    return data ?? null;
  }

  async insert(table, row) {
    const { data, error } = await this.sb.from(table).insert(row).select().single();
    if (error) throw new Error(`SupabaseStore.insert ${table}: ${error.message}`);
    return data;
  }

  async update(table, name, row) {
    const { data, error } = await this.sb.from(table).update(row).eq('name', name).select().single();
    if (error) throw new Error(`SupabaseStore.update ${table}/${name}: ${error.message}`);
    return data;
  }

  async list(table, opts = {}) {
    let q = this.sb.from(table).select('*');
    for (const [k, v] of Object.entries(opts.filters || {})) q = q.eq(k, v);
    if (opts.order) q = q.order(opts.order.field, { ascending: !opts.order.desc });
    if (opts.range) {
      const off = opts.range.offset ?? 0;
      q = q.range(off, off + (opts.range.limit ?? 1000) - 1);
    }
    const { data, error } = await q;
    if (error) throw new Error(`SupabaseStore.list ${table}: ${error.message}`);
    return data ?? [];
  }

  async getChildren(table, parent, parenttype, parentfield) {
    const { data, error } = await this.sb.from(table).select('*')
      .eq('parent', parent).eq('parenttype', parenttype).eq('parentfield', parentfield);
    if (error) throw new Error(`SupabaseStore.getChildren ${table}: ${error.message}`);
    return data ?? [];
  }

  async deleteChildren(table, parent, parenttype, parentfield) {
    const { error } = await this.sb.from(table).delete()
      .eq('parent', parent).eq('parenttype', parenttype).eq('parentfield', parentfield);
    if (error) throw new Error(`SupabaseStore.deleteChildren ${table}: ${error.message}`);
  }
}
