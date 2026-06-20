import { describe, it, expect, beforeAll } from 'vitest';
import { createTableSql, alterColumnsSql, pgTypeFor } from './ddl.js';

// Sample doctype def matching the Customer migration pattern
const customerDef = {
  table: 'tabCustomer',
  fields: [
    { fieldname: 'customer_name', fieldtype: 'Data' },
    { fieldname: 'territory',     fieldtype: 'Link' },
    { fieldname: 'email',         fieldtype: 'Data' },
    { fieldname: 'credit_limit',  fieldtype: 'Currency' },
    { fieldname: 'is_active',     fieldtype: 'Check' },
    { fieldname: 'founded',       fieldtype: 'Date' },
    { fieldname: 'last_contact',  fieldtype: 'Datetime' },
    { fieldname: 'headcount',     fieldtype: 'Int' },
    { fieldname: 'addresses',     fieldtype: 'Table' }, // must be skipped
  ],
};

describe('pgTypeFor', () => {
  it('maps Data to text', () => {
    expect(pgTypeFor({ fieldtype: 'Data' })).toBe('text');
  });

  it('maps Text to text', () => {
    expect(pgTypeFor({ fieldtype: 'Text' })).toBe('text');
  });

  it('maps Code to text', () => {
    expect(pgTypeFor({ fieldtype: 'Code' })).toBe('text');
  });

  it('maps Select to text', () => {
    expect(pgTypeFor({ fieldtype: 'Select' })).toBe('text');
  });

  it('maps Link to text', () => {
    expect(pgTypeFor({ fieldtype: 'Link' })).toBe('text');
  });

  it('maps Int to bigint', () => {
    expect(pgTypeFor({ fieldtype: 'Int' })).toBe('bigint');
  });

  it('maps Float to numeric', () => {
    expect(pgTypeFor({ fieldtype: 'Float' })).toBe('numeric');
  });

  it('maps Currency to numeric', () => {
    expect(pgTypeFor({ fieldtype: 'Currency' })).toBe('numeric');
  });

  it('maps Check to boolean', () => {
    expect(pgTypeFor({ fieldtype: 'Check' })).toBe('boolean');
  });

  it('maps Date to date', () => {
    expect(pgTypeFor({ fieldtype: 'Date' })).toBe('date');
  });

  it('maps Datetime to timestamptz', () => {
    expect(pgTypeFor({ fieldtype: 'Datetime' })).toBe('timestamptz');
  });

  it('returns undefined for Table (no column)', () => {
    expect(pgTypeFor({ fieldtype: 'Table' })).toBeUndefined();
  });
});

describe('createTableSql', () => {
  let sql;

  beforeAll(() => {
    sql = createTableSql(customerDef);
  });

  it('uses CREATE TABLE IF NOT EXISTS with quoted table name', () => {
    expect(sql).toMatch(/create table if not exists "tabCustomer"/i);
  });

  it('includes name text primary key (framework col)', () => {
    expect(sql).toContain('name        text primary key');
  });

  it('includes owner text (framework col)', () => {
    expect(sql).toContain('owner       text');
  });

  it('includes docstatus int (framework col)', () => {
    expect(sql).toContain('docstatus   int  not null default 0');
  });

  it('includes idx int (framework col)', () => {
    expect(sql).toContain('idx         int  not null default 0');
  });

  it('includes creation timestamptz (framework col)', () => {
    expect(sql).toContain('creation    timestamptz');
  });

  it('includes modified timestamptz (framework col)', () => {
    expect(sql).toContain('modified    timestamptz');
  });

  it('maps customer_name (Data) → text', () => {
    expect(sql).toContain('customer_name text');
  });

  it('maps credit_limit (Currency) → numeric', () => {
    expect(sql).toContain('credit_limit numeric');
  });

  it('maps is_active (Check) → boolean', () => {
    expect(sql).toContain('is_active boolean');
  });

  it('maps headcount (Int) → bigint', () => {
    expect(sql).toContain('headcount bigint');
  });

  it('maps founded (Date) → date', () => {
    expect(sql).toContain('founded date');
  });

  it('maps last_contact (Datetime) → timestamptz', () => {
    expect(sql).toContain('last_contact timestamptz');
  });

  it('excludes Table fields (addresses must not appear as a column)', () => {
    // 'addresses' should not appear as a column definition
    expect(sql).not.toMatch(/^\s+addresses\s/m);
  });

  it('grants to service_role', () => {
    expect(sql).toContain('grant all on "tabCustomer" to service_role');
  });

  it('is idempotent — uses IF NOT EXISTS', () => {
    expect(sql).toMatch(/if not exists/i);
  });

  it('does not touch DB or fs (pure — returns a string)', () => {
    expect(typeof sql).toBe('string');
    expect(sql.length).toBeGreaterThan(0);
  });
});

describe('alterColumnsSql', () => {
  it('emits ADD COLUMN IF NOT EXISTS for new fields only', () => {
    const existing = ['name', 'owner', 'docstatus', 'idx', 'creation', 'modified', 'customer_name'];
    const sql = alterColumnsSql(customerDef, existing);

    // territory is new
    expect(sql).toContain('add column if not exists territory text');
    // credit_limit is new
    expect(sql).toContain('add column if not exists credit_limit numeric');
    // customer_name is already present — must be absent
    expect(sql).not.toContain('customer_name');
  });

  it('skips Table fields in alterColumnsSql', () => {
    const sql = alterColumnsSql(customerDef, []);
    expect(sql).not.toContain('addresses');
  });

  it('returns empty string when all columns already exist', () => {
    const existing = customerDef.fields
      .filter(f => f.fieldtype !== 'Table')
      .map(f => f.fieldname);
    const sql = alterColumnsSql(customerDef, existing);
    expect(sql).toBe('');
  });

  it('quotes the table name in ALTER statements', () => {
    const sql = alterColumnsSql(customerDef, []);
    expect(sql).toMatch(/alter table "tabCustomer"/);
  });

  it('handles empty existingCols (defaults to [])', () => {
    const sql = alterColumnsSql(customerDef);
    expect(sql).toContain('add column if not exists customer_name text');
  });
});
