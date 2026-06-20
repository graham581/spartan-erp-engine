import { describe, it, expect } from 'vitest';
import { PgAdmin } from './pg-admin.js';

describe('PgAdmin (DDL executor)', () => {
  it('runs DDL through the injected executor', async () => {
    const calls = [];
    const admin = new PgAdmin(async (ddl) => { calls.push(ddl); });
    await admin.applyDDL('create table if not exists "tabX" (name text primary key);');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('tabX');
  });

  it('no-ops on empty DDL', async () => {
    const calls = [];
    const admin = new PgAdmin(async (ddl) => { calls.push(ddl); });
    await admin.applyDDL('');
    await admin.applyDDL('   ');
    expect(calls).toHaveLength(0);
  });

  it('fromEnv throws without DATABASE_URL', () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => PgAdmin.fromEnv()).toThrow(/DATABASE_URL/);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
