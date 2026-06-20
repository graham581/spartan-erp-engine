// DDLEmitter — pure SQL emitter; no I/O, no store access.
// Called by Installer.emitMigration to produce idempotent migration SQL.
//
// Caller sequence (Installer, per workorder §D1):
//   emitMigration(def) → human `supabase db push` → syncDoctype → bumpMetaVersion
//
// Frozen fieldtype → pg type map (workorder §B1):
//   Data / Text / Code / Select / Link  → text
//   Int                                 → bigint
//   Float / Currency                    → numeric
//   Check (and all DocPerm bool flags)  → boolean
//   Date                                → date
//   Datetime                            → timestamptz
//   Table                               → no column (child rows live in child's own table)

const PG_TYPE_MAP = {
  Data:     'text',
  Text:     'text',
  Code:     'text',
  Select:   'text',
  Link:     'text',
  Int:      'bigint',
  Float:    'numeric',
  Currency: 'numeric',
  Check:    'boolean',
  Date:     'date',
  Datetime: 'timestamptz',
};

/**
 * Map a FieldDef fieldtype to its Postgres column type.
 * Returns undefined for Table (caller should skip these).
 *
 * @param {{ fieldtype: string }} field
 * @returns {string|undefined}
 */
export function pgTypeFor(field) {
  return PG_TYPE_MAP[field.fieldtype];
}

/**
 * Emit a CREATE TABLE IF NOT EXISTS statement for a doctype definition.
 * Includes the standard framework columns (name, owner, docstatus, idx,
 * creation, modified) followed by one column per non-Table field.
 * Ends with a grant to service_role.
 *
 * @param {{ table: string, fields: Array<{fieldname: string, fieldtype: string}> }} def
 * @returns {string}
 */
export function createTableSql(def) {
  const { table, fields = [] } = def;

  // Framework columns — match the proven pattern from 20260620000001_customer.sql
  const frameworkCols = [
    '  name        text primary key',
    '  owner       text',
    '  docstatus   int  not null default 0',
    '  idx         int  not null default 0',
    '  creation    timestamptz',
    '  modified    timestamptz',
  ];

  // One column per non-Table field
  const fieldCols = fields
    .filter(f => f.fieldtype !== 'Table')
    .map(f => {
      const pgType = pgTypeFor(f);
      if (!pgType) return null; // unknown fieldtype — skip rather than error
      return `  ${f.fieldname} ${pgType}`;
    })
    .filter(Boolean);

  const allCols = [...frameworkCols, ...fieldCols].join(',\n');

  return [
    `create table if not exists "${table}" (`,
    allCols,
    `);`,
    `grant all on "${table}" to service_role;`,
  ].join('\n');
}

/**
 * Emit ALTER TABLE ... ADD COLUMN IF NOT EXISTS statements for any fields
 * not already present in existingCols.
 *
 * @param {{ table: string, fields: Array<{fieldname: string, fieldtype: string}> }} def
 * @param {string[]} existingCols — column names already on the table
 * @returns {string}
 */
export function alterColumnsSql(def, existingCols = []) {
  const { table, fields = [] } = def;
  const existing = new Set(existingCols);

  const statements = fields
    .filter(f => f.fieldtype !== 'Table')
    .filter(f => !existing.has(f.fieldname))
    .map(f => {
      const pgType = pgTypeFor(f);
      if (!pgType) return null;
      return `alter table "${table}" add column if not exists ${f.fieldname} ${pgType};`;
    })
    .filter(Boolean);

  return statements.join('\n');
}
