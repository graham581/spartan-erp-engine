import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { DataStore, Row } from './store';

/** Supabase-backed DataStore (Phase 6 wiring). Uses the service-role key. */
export class SupabaseStore implements DataStore {
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  static fromEnv(): SupabaseStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    return new SupabaseStore(url, key);
  }

  async get(table: string, name: string): Promise<Row | null> {
    const { data, error } = await this.db.from(table).select('*').eq('name', name).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as Row) ?? null;
  }

  async insert(table: string, row: Row): Promise<void> {
    const { error } = await this.db.from(table).insert(row);
    if (error) throw new Error(error.message);
  }

  async update(table: string, name: string, row: Row): Promise<void> {
    const { error } = await this.db.from(table).update(row).eq('name', name);
    if (error) throw new Error(error.message);
  }

  async delete(table: string, name: string): Promise<void> {
    const { error } = await this.db.from(table).delete().eq('name', name);
    if (error) throw new Error(error.message);
  }

  async getChildren(
    table: string,
    parent: string,
    parenttype: string,
    parentfield: string,
  ): Promise<Row[]> {
    const { data, error } = await this.db
      .from(table)
      .select('*')
      .eq('parent', parent)
      .eq('parenttype', parenttype)
      .eq('parentfield', parentfield);
    if (error) throw new Error(error.message);
    return (data as Row[]) ?? [];
  }

  async deleteChildren(
    table: string,
    parent: string,
    parenttype: string,
    parentfield: string,
  ): Promise<void> {
    const { error } = await this.db
      .from(table)
      .delete()
      .eq('parent', parent)
      .eq('parenttype', parenttype)
      .eq('parentfield', parentfield);
    if (error) throw new Error(error.message);
  }
}
