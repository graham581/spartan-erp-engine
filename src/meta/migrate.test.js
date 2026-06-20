import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../runtime/memory-store.js';
import { registerBootMeta } from './boot-meta.js';
import { _resetRegistry } from './registry.js';
import { migrate } from './installer.js';
import { PgAdmin } from './pg-admin.js';

const WidgetDef = {
  doctype: 'Widget',
  table: 'tabWidget',
  autoname: 'WID-.#####',
  fields: [
    { fieldname: 'title', fieldtype: 'Data', reqd: true },
    { fieldname: 'qty', fieldtype: 'Int' },
  ],
  permissions: [{ role: 'admin', permlevel: 0, read: true, write: true, create: true }],
};

describe('Installer.migrate — DDL + rows + version, one call', () => {
  /** @type {MemoryStore} */
  let store;
  beforeEach(() => { _resetRegistry(); registerBootMeta(); store = new MemoryStore(); });

  it('applies DDL via an injected PgAdmin (no human db push) and upserts meta rows', async () => {
    const ddlRun = [];
    const admin = new PgAdmin(async (ddl) => { ddlRun.push(ddl); });
    const res = await migrate(WidgetDef, store, { admin });

    expect(res.applied).toBe(true);
    expect(ddlRun).toHaveLength(1);
    expect(ddlRun[0]).toMatch(/create table if not exists/i);
    expect(ddlRun[0]).toContain('"tabWidget"');

    // meta rows written through the PostgREST/Document path
    expect(await store.get('tabDocType', 'Widget')).toBeTruthy();
    expect(await store.getChildren('tabDocField', 'Widget', 'DocType', 'fields')).toHaveLength(2);
    expect(await store.getChildren('tabDocPerm', 'Widget', 'DocType', 'permissions')).toHaveLength(1);
    // version bumped
    expect(await store.get('meta_version', 'meta_version')).toBeTruthy();
  });

  it('falls back to emitting a migration file when no admin is given', async () => {
    const written = [];
    const res = await migrate(WidgetDef, store, { writer: (path, sql) => written.push({ path, sql }) });
    expect(res.applied).toBe(false);
    expect(written).toHaveLength(1);
    expect(written[0].sql).toMatch(/create table if not exists/i);
    expect(written[0].sql).toContain('"tabWidget"');
  });
});
