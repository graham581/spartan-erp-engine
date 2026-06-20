import { describe, it, expect, beforeEach } from 'vitest';
import { PgStore } from './pg-store.js';

// ── Fake sql tag ─────────────────────────────────────────────────────────────
//
// Mirrors the pg-admin injectable _exec pattern (pg-admin.test.js:5-11).
// The fake is a function that:
//   (1) Records every call's SQL string + params.
//   (2) Returns the canned rows configured by the test.
//
// It also exposes `.begin(fn)` so transaction() can be tested without a real DB.

function makeFakeSql(cannedRows = []) {
  const calls = [];

  // The tagged-template / .unsafe interface both collapse to this:
  const fake = Object.assign(
    async function (strings, ...values) {
      // Called as tagged template: fake`SELECT ...`
      const sql = Array.isArray(strings) ? strings.join('$?') : strings;
      calls.push({ sql, params: values });
      return cannedRows;
    },
    {
      unsafe: async (sql, params = []) => {
        calls.push({ sql, params });
        return cannedRows;
      },
      begin: async (fn) => {
        // Simulate sql.begin: invoke fn with a tx-bound fake sql
        const txFake = makeFakeSql(cannedRows);
        return fn(txFake.sql);
      },
      calls,
    }
  );

  // Expose calls on the sql object itself too (tests access fakeSql.calls)
  fake.calls = calls;
  return fake;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeStore(cannedRows = []) {
  const fakeSql = makeFakeSql(cannedRows);
  const store = new PgStore(fakeSql);
  return { store, fakeSql };
}

// ── supportsTransactions ──────────────────────────────────────────────────────

describe('PgStore.supportsTransactions', () => {
  it('is true', () => {
    const { store } = makeStore();
    expect(store.supportsTransactions).toBe(true);
  });
});

// ── get ───────────────────────────────────────────────────────────────────────

describe('PgStore.get', () => {
  it('returns null on empty result (null-on-miss, not undefined/[])', async () => {
    const { store } = makeStore([]); // empty rows → miss
    const result = await store.get('tabSalesOrder', 'SO-00001');
    expect(result).toBeNull();
  });

  it('returns the first row on hit', async () => {
    const row = { name: 'SO-00001', status: 'Draft' };
    const { store, fakeSql } = makeStore([row]);
    const result = await store.get('tabSalesOrder', 'SO-00001');
    expect(result).toEqual(row);
    expect(fakeSql.calls[0].sql).toContain('"tabSalesOrder"');
    expect(fakeSql.calls[0].sql).toContain('"name"');
    expect(fakeSql.calls[0].params).toEqual(['SO-00001']);
  });
});

// ── insert ────────────────────────────────────────────────────────────────────

describe('PgStore.insert', () => {
  it('returns the RETURNING * canned row (full stored row, not the input)', async () => {
    const stored = { name: 'DT-001', creation: '2026-01-01', modified: '2026-01-01' };
    const { store, fakeSql } = makeStore([stored]);
    const input = { name: 'DT-001', label: 'Sales Order' };
    const result = await store.insert('tabDocType', input);

    // Returns the canned RETURNING * row, not the input
    expect(result).toEqual(stored);
    // SQL must contain RETURNING *
    expect(fakeSql.calls[0].sql).toContain('RETURNING *');
    // Table name is quoted
    expect(fakeSql.calls[0].sql).toContain('"tabDocType"');
    // Column names are quoted
    expect(fakeSql.calls[0].sql).toContain('"name"');
  });
});

// ── update ────────────────────────────────────────────────────────────────────

describe('PgStore.update', () => {
  it('returns the RETURNING * canned row; WHERE targets name; SET excludes name', async () => {
    const stored = { name: 'DT-001', label: 'Sales Order (updated)', creation: '2026-01-01' };
    const { store, fakeSql } = makeStore([stored]);
    const result = await store.update('tabDocType', 'DT-001', { name: 'DT-001', label: 'Sales Order (updated)' });

    expect(result).toEqual(stored);
    const { sql, params } = fakeSql.calls[0];
    expect(sql).toContain('RETURNING *');
    expect(sql).toContain('"tabDocType"');
    expect(sql).toContain('WHERE "name"');
    // name should NOT appear in the SET clause (it's the WHERE key)
    // SET should only have label
    expect(sql).toContain('"label"');
    // Last param is the name for the WHERE clause
    expect(params[params.length - 1]).toBe('DT-001');
  });
});

// ── list ──────────────────────────────────────────────────────────────────────

describe('PgStore.list', () => {
  it('emits eq predicates for filters', async () => {
    const { store, fakeSql } = makeStore([]);
    await store.list('tabDocType', { filters: { doctype: 'Sales Order', issingle: 0 } });
    const { sql, params } = fakeSql.calls[0];
    expect(sql).toContain('"doctype"');
    expect(sql).toContain('"issingle"');
    expect(params).toContain('Sales Order');
    expect(params).toContain(0);
  });

  it('emits ORDER BY field DESC when order.desc=true', async () => {
    const { store, fakeSql } = makeStore([]);
    await store.list('tabDocType', { order: { field: 'creation', desc: true } });
    const { sql } = fakeSql.calls[0];
    expect(sql).toContain('ORDER BY "creation" DESC');
  });

  it('emits ORDER BY field (no DESC) when order.desc is falsy', async () => {
    const { store, fakeSql } = makeStore([]);
    await store.list('tabDocType', { order: { field: 'name' } });
    const { sql } = fakeSql.calls[0];
    expect(sql).toContain('ORDER BY "name"');
    expect(sql).not.toContain('DESC');
  });

  it('emits LIMIT/OFFSET with inclusive off..off+limit-1 semantics (matching SupabaseStore)', async () => {
    // SupabaseStore uses supabase range(off, off+limit-1) which is inclusive [off, off+limit-1]
    // That maps to SQL LIMIT limit OFFSET off — the same row count.
    const { store, fakeSql } = makeStore([]);
    await store.list('tabDocType', { range: { offset: 10, limit: 25 } });
    const { sql, params } = fakeSql.calls[0];
    expect(sql).toContain('LIMIT');
    expect(sql).toContain('OFFSET');
    expect(params).toContain(25);  // limit
    expect(params).toContain(10);  // offset
  });

  it('uses default offset 0 and limit 1000 when range is empty object', async () => {
    const { store, fakeSql } = makeStore([]);
    await store.list('tabDocType', { range: {} });
    const { sql, params } = fakeSql.calls[0];
    expect(params).toContain(1000);
    expect(params).toContain(0);
  });
});

// ── getChildren ───────────────────────────────────────────────────────────────

describe('PgStore.getChildren', () => {
  it('filters on parent + parenttype + parentfield (params in that order)', async () => {
    const rows = [{ name: 'DF-001', parent: 'SO', parenttype: 'Sales Order', parentfield: 'items' }];
    const { store, fakeSql } = makeStore(rows);
    const result = await store.getChildren('tabDocField', 'SO', 'Sales Order', 'items');

    expect(result).toEqual(rows);
    const { sql, params } = fakeSql.calls[0];
    expect(sql).toContain('"parent"');
    expect(sql).toContain('"parenttype"');
    expect(sql).toContain('"parentfield"');
    expect(params).toEqual(['SO', 'Sales Order', 'items']);
  });
});

// ── deleteChildren ────────────────────────────────────────────────────────────

describe('PgStore.deleteChildren', () => {
  it('issues DELETE with 3-column filter; params in parent/parenttype/parentfield order', async () => {
    const { store, fakeSql } = makeStore([]);
    await store.deleteChildren('tabDocField', 'SO', 'Sales Order', 'items');

    const { sql, params } = fakeSql.calls[0];
    expect(sql.toUpperCase()).toContain('DELETE');
    expect(sql).toContain('"parent"');
    expect(sql).toContain('"parenttype"');
    expect(sql).toContain('"parentfield"');
    expect(params).toEqual(['SO', 'Sales Order', 'items']);
  });

  it('returns void (no meaningful return value)', async () => {
    const { store } = makeStore([]);
    const result = await store.deleteChildren('tabDocField', 'SO', 'Sales Order', 'items');
    expect(result).toBeUndefined();
  });
});

// ── reserved-word column quoting ─────────────────────────────────────────────

describe('PgStore reserved-word column quoting (tabDocPerm columns)', () => {
  const reservedCols = ['unique', 'read', 'write', 'create', 'submit', 'cancel', 'delete'];

  it('double-quotes reserved-word column names in insert SQL', async () => {
    const row = {
      name: 'DP-001',
      role: 'System Manager',
      unique: 1,
      read: 1,
      write: 1,
      create: 1,
      submit: 1,
      cancel: 1,
      delete: 1,
    };
    const { store, fakeSql } = makeStore([row]);
    await store.insert('tabDocPerm', row);

    const { sql } = fakeSql.calls[0];
    for (const col of reservedCols) {
      expect(sql).toContain(`"${col}"`);
    }
  });

  it('double-quotes reserved-word column names in update SQL', async () => {
    const row = {
      name: 'DP-001',
      read: 1,
      write: 0,
      submit: 1,
      cancel: 0,
      delete: 0,
    };
    const { store, fakeSql } = makeStore([row]);
    await store.update('tabDocPerm', 'DP-001', row);

    const { sql } = fakeSql.calls[0];
    expect(sql).toContain('"read"');
    expect(sql).toContain('"write"');
    expect(sql).toContain('"submit"');
    expect(sql).toContain('"cancel"');
    expect(sql).toContain('"delete"');
  });
});

// ── nextSeries ────────────────────────────────────────────────────────────────

describe('PgStore.nextSeries', () => {
  it('emits SELECT next_series($1) with [prefix] and returns Number(current)', async () => {
    const { store, fakeSql } = makeStore([{ current: 7n }]); // bigint from postgres driver
    const result = await store.nextSeries('SO-');

    expect(result).toBe(7);
    expect(typeof result).toBe('number');
    const { sql, params } = fakeSql.calls[0];
    expect(sql).toContain('next_series($1)');
    expect(params).toEqual(['SO-']);
  });

  it('handles numeric current (not bigint)', async () => {
    const { store } = makeStore([{ current: 42 }]);
    expect(await store.nextSeries('PO-')).toBe(42);
  });
});

// ── transaction ───────────────────────────────────────────────────────────────

describe('PgStore.transaction', () => {
  it('calls sql.begin and passes fn a tx-bound PgStore', async () => {
    let receivedStore = null;
    let beginCalled = false;

    const txSql = makeFakeSql([{ name: 'TX-001' }]);

    const fakeSqlWithBegin = Object.assign(makeFakeSql([]), {
      begin: async (fn) => {
        beginCalled = true;
        return fn(txSql); // pass the tx-sql to fn
      },
    });

    const store = new PgStore(fakeSqlWithBegin);
    const result = await store.transaction(async (txStore) => {
      receivedStore = txStore;
      return 'done';
    });

    expect(beginCalled).toBe(true);
    expect(result).toBe('done');
    // fn receives a PgStore instance (tx-bound)
    expect(receivedStore).toBeInstanceOf(PgStore);
    // The tx-bound store's sql is the txSql, not the outer sql
    expect(receivedStore.sql).toBe(txSql);
  });

  it('a write inside fn goes to the tx sql, not the outer sql', async () => {
    const outerSql = makeFakeSql([]);
    const txSql = makeFakeSql([{ name: 'TX-001', status: 'Submitted' }]);

    outerSql.begin = async (fn) => fn(txSql);

    const store = new PgStore(outerSql);
    await store.transaction(async (txStore) => {
      await txStore.insert('tabSalesOrder', { name: 'TX-001', status: 'Submitted' });
    });

    // The insert went to txSql, not outerSql
    expect(txSql.calls).toHaveLength(1);
    expect(outerSql.calls).toHaveLength(0);
  });
});

// ── fromEnv throws without DATABASE_URL_POOLER ───────────────────────────────

describe('PgStore.fromEnv', () => {
  it('throws /DATABASE_URL_POOLER/ when the var is unset', () => {
    // Reset the singleton to force a fresh fromEnv() call
    PgStore._singleton = null;
    const saved = process.env.DATABASE_URL_POOLER;
    delete process.env.DATABASE_URL_POOLER;
    try {
      expect(() => PgStore.fromEnv()).toThrow(/DATABASE_URL_POOLER/);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL_POOLER = saved;
      PgStore._singleton = null;
    }
  });
});
