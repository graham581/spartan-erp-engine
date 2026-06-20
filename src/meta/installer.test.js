/**
 * installer.test.js — Unit tests for src/meta/installer.js
 *
 * Test strategy: MemoryStore throughout; no real FS writes (use the injected writer).
 * registerBootMeta() is called inside syncDoctype, but we also call _resetRegistry()
 * in beforeEach so the pinned set is always fresh.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../runtime/memory-store.js';
import { _resetRegistry } from './registry.js';
import { syncDoctype, emitMigration, bumpMetaVersion } from './installer.js';

// A sample doctype definition (camelCase in-memory shape)
const sampleDef = {
  doctype:     'TestWidget',
  table:       'tabTestWidget',
  submittable: false,
  autoname:    'field:widget_name',
  fields: [
    { fieldname: 'widget_name',  fieldtype: 'Data'     },
    { fieldname: 'weight',       fieldtype: 'Float'    },
    { fieldname: 'is_active',    fieldtype: 'Check'    },
    { fieldname: 'notes',        fieldtype: 'Text'     },
    // Table field — must NOT produce a column in the DDL
    { fieldname: 'items',        fieldtype: 'Table', options: 'WidgetItem' },
  ],
  permissions: [
    { role: 'Administrator', read: true, write: true, create: true, delete: true },
    { role: 'Sales User',    read: true },
  ],
};

beforeEach(() => {
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// syncDoctype — meta row upserts via Document.save()
// ---------------------------------------------------------------------------

describe('syncDoctype', () => {
  it('writes a tabDocType row readable by store.get', async () => {
    const store = new MemoryStore();
    await syncDoctype(sampleDef, store);

    const row = await store.get('tabDocType', 'TestWidget');
    expect(row).not.toBeNull();
    expect(row.name).toBe('TestWidget');
  });

  it('writes tabDocField child rows readable by getChildren', async () => {
    const store = new MemoryStore();
    await syncDoctype(sampleDef, store);

    const fields = await store.getChildren('tabDocField', 'TestWidget', 'DocType', 'fields');
    // 5 fields in the def (including the Table field — stored as a meta row, just no DDL column)
    expect(fields).toHaveLength(sampleDef.fields.length);

    const names = fields.map(f => f.fieldname);
    expect(names).toContain('widget_name');
    expect(names).toContain('weight');
    expect(names).toContain('is_active');
    expect(names).toContain('items');
  });

  it('writes tabDocPerm child rows readable by getChildren', async () => {
    const store = new MemoryStore();
    await syncDoctype(sampleDef, store);

    const perms = await store.getChildren('tabDocPerm', 'TestWidget', 'DocType', 'permissions');
    expect(perms).toHaveLength(2);

    const adminPerm = perms.find(p => p.role === 'Administrator');
    expect(adminPerm).toBeDefined();
    expect(adminPerm.read).toBe(true);
    expect(adminPerm.write).toBe(true);
    expect(adminPerm.create).toBe(true);
    expect(adminPerm.delete).toBe(true);
  });

  it('is idempotent — re-running does not produce duplicate child rows', async () => {
    const store = new MemoryStore();
    await syncDoctype(sampleDef, store);
    await syncDoctype(sampleDef, store);

    const fields = await store.getChildren('tabDocField', 'TestWidget', 'DocType', 'fields');
    expect(fields).toHaveLength(sampleDef.fields.length);

    const perms = await store.getChildren('tabDocPerm', 'TestWidget', 'DocType', 'permissions');
    expect(perms).toHaveLength(2);
  });

  it('does NOT execute DDL against the store (no unexpected tables created by syncDoctype)', async () => {
    const store = new MemoryStore();
    // Patch store.get to detect any access to unknown DDL-only tables
    const accessed = new Set();
    const origGet = store.get.bind(store);
    store.get = async (table, name) => { accessed.add(table); return origGet(table, name); };

    await syncDoctype(sampleDef, store);

    // tabTestWidget must NOT have been accessed — it doesn't exist yet (DDL not pushed)
    expect(accessed.has('tabTestWidget')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// emitMigration — DDL emit-only; uses injected writer for test hermeticity
// ---------------------------------------------------------------------------

describe('emitMigration', () => {
  it('calls the writer with a path containing the doctype slug', () => {
    let writtenPath = null;
    let writtenSql  = null;
    const writer = (path, sql) => { writtenPath = path; writtenSql = sql; };

    emitMigration(sampleDef, { writer });

    expect(writtenPath).toMatch(/testwidget\.sql$/);
  });

  it('emitted SQL contains CREATE TABLE IF NOT EXISTS for the data table', () => {
    let writtenSql = null;
    emitMigration(sampleDef, { writer: (_p, sql) => { writtenSql = sql; } });

    expect(writtenSql).toMatch(/create table if not exists "tabTestWidget"/i);
  });

  it('emitted SQL does NOT include a column for Table-type fields', () => {
    let writtenSql = null;
    emitMigration(sampleDef, { writer: (_p, sql) => { writtenSql = sql; } });

    // Table field 'items' should NOT become a column
    expect(writtenSql).not.toMatch(/\bitems\b/);
  });

  it('emitted SQL includes the standard framework columns', () => {
    let writtenSql = null;
    emitMigration(sampleDef, { writer: (_p, sql) => { writtenSql = sql; } });

    expect(writtenSql).toContain('name');
    expect(writtenSql).toContain('docstatus');
    expect(writtenSql).toContain('modified');
  });

  it('emitted SQL contains a grant to service_role', () => {
    let writtenSql = null;
    emitMigration(sampleDef, { writer: (_p, sql) => { writtenSql = sql; } });

    expect(writtenSql).toContain('service_role');
  });

  it('returns the path of the written file', () => {
    const path = emitMigration(sampleDef, { writer: () => {} });
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// bumpMetaVersion — set (not append) the version row
// ---------------------------------------------------------------------------

describe('bumpMetaVersion', () => {
  it('inserts a meta_version row when absent', async () => {
    const store = new MemoryStore();
    await bumpMetaVersion(store);

    const row = await store.get('meta_version', 'meta_version');
    expect(row).not.toBeNull();
    expect(row.name).toBe('meta_version');
    expect(typeof row.version).toBe('string');
    expect(row.version.length).toBeGreaterThan(0);
  });

  it('updates (sets) the version row when already present', async () => {
    const store = new MemoryStore();
    await store.insert('meta_version', { name: 'meta_version', version: 'old-version' });

    await bumpMetaVersion(store);

    const row = await store.get('meta_version', 'meta_version');
    expect(row.version).not.toBe('old-version');
  });

  it('is idempotent — multiple calls still produce one row', async () => {
    const store = new MemoryStore();
    await bumpMetaVersion(store);
    await bumpMetaVersion(store);

    const row = await store.get('meta_version', 'meta_version');
    expect(row).not.toBeNull();
    // Still exactly one row (store is a Map — this is guaranteed by structure)
    expect(row.name).toBe('meta_version');
  });

  it('sets a NEW version on each call (not the same value twice)', async () => {
    const store = new MemoryStore();
    await bumpMetaVersion(store);
    const v1 = (await store.get('meta_version', 'meta_version')).version;

    // Small delay to guarantee Date.now() produces a different ms value
    await new Promise(r => setTimeout(r, 2));
    await bumpMetaVersion(store);
    const v2 = (await store.get('meta_version', 'meta_version')).version;

    expect(v2).not.toBe(v1);
  });
});
