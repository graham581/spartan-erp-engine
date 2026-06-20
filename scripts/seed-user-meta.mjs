/**
 * seed-user-meta.mjs — seed User / Has Role DocMeta definitions and one bootstrap admin.
 *
 * ORDERING (frozen — see supabase/MIGRATION_RUNBOOK.md):
 *   1. supabase db push  (applies 20260620030000_user_identity.sql — creates tabUser, tabHasRole)
 *   2. node --env-file=.env scripts/seed-user-meta.mjs  (this file)
 *   3. Expose authenticated routes.
 *
 * Idempotent: re-running this script is safe (upserts, not inserts).
 *
 * Required env vars:
 *   SUPABASE_URL              — the ENGINE's OWN isolated Supabase project (NOT the
 *                               shared CRM/prod project) — read from .env
 *   SUPABASE_SERVICE_ROLE_KEY — service role JWT
 *   BOOTSTRAP_ADMIN_EMAIL     — email of the initial admin user (fails fast if unset)
 */

import { SupabaseStore } from '../src/runtime/supabase-store.js';
import { registerBootMeta } from '../src/meta/boot-meta.js';
import { syncDoctype, bumpMetaVersion } from '../src/meta/installer.js';

// ── Fail fast on missing admin email ─────────────────────────────────────────
const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
if (!adminEmail) {
  console.error('ERROR: BOOTSTRAP_ADMIN_EMAIL is not set. Aborting.');
  process.exit(1);
}

// ── DocMeta defs — Has Role first (Table-target closure rule) ─────────────────
// loader.js:112 requires the child doctype meta to be primed before the parent
// that references it via a Table field.  Has Role is a child of User.

/** @type {import('../src/meta/boot-meta.js').DocMeta} */
const HAS_ROLE_DEF = {
  doctype:     'Has Role',
  table:       'tabHasRole',
  submittable: false,
  autoname:    'hash',
  istable:     true,
  fields: [
    { fieldname: 'name',        fieldtype: 'Data' },
    { fieldname: 'parent',      fieldtype: 'Link',  options: 'User' },
    { fieldname: 'parenttype',  fieldtype: 'Data' },
    { fieldname: 'parentfield', fieldtype: 'Data' },
    { fieldname: 'role',        fieldtype: 'Link',  options: 'Role' },
    { fieldname: 'idx',         fieldtype: 'Int' },
  ],
  childTables: [],
  scopeFields: [],
  permissions: [],
};

/** @type {import('../src/meta/boot-meta.js').DocMeta} */
const USER_DEF = {
  doctype:     'User',
  table:       'tabUser',
  submittable: false,
  autoname:    'field:email',
  fields: [
    { fieldname: 'name',      fieldtype: 'Data' },
    { fieldname: 'email',     fieldtype: 'Data',  reqd: true },
    { fieldname: 'full_name', fieldtype: 'Data' },
    { fieldname: 'branch',    fieldtype: 'Data' },
    { fieldname: 'enabled',   fieldtype: 'Check' },
    // Table field -> Has Role child table
    { fieldname: 'roles',     fieldtype: 'Table', options: 'Has Role' },
  ],
  childTables: [
    { field: 'roles', doctype: 'Has Role', table: 'tabHasRole' },
  ],
  scopeFields: [],
  permissions: [
    { role: 'admin', permlevel: 0, read: true, write: true, create: true, delete: true },
  ],
};

// ── Run ───────────────────────────────────────────────────────────────────────
const store = SupabaseStore.fromEnv();
const log   = (ok, msg) => console.log(`${ok ? 'OK' : 'FAIL'} ${msg}`);
let pass = true;
const check = (ok, msg) => { pass = pass && ok; log(ok, msg); };

try {
  registerBootMeta();

  // 1. Sync Has Role FIRST (Table-target closure — child before parent).
  await syncDoctype(HAS_ROLE_DEF, store);
  check(true, 'Synced Has Role DocMeta rows to Postgres');

  // 2. Sync User.
  await syncDoctype(USER_DEF, store);
  check(true, 'Synced User DocMeta rows to Postgres');

  // 3. Bump meta_version so warm caches invalidate.
  await bumpMetaVersion(store);
  check(true, 'meta_version bumped');

  // 4. Upsert the bootstrap admin tabUser row.
  //    name = email (Frappe convention for User autoname field:email).
  const existingUser = await store.get('tabUser', adminEmail);
  if (existingUser) {
    await store.update('tabUser', adminEmail, {
      ...existingUser,
      enabled: true,
    });
    check(true, `tabUser row already exists for ${adminEmail} — ensured enabled=true`);
  } else {
    await store.insert('tabUser', {
      name:     adminEmail,
      email:    adminEmail,
      enabled:  true,
      branch:   null,
      full_name: null,
    });
    check(true, `tabUser row inserted for ${adminEmail}`);
  }

  // 5. Upsert the tabHasRole child row: role=admin.
  //    Idempotent key: parent + role combination; name = deterministic slug.
  const adminRoleName = `${adminEmail}-admin`;
  const existingRole  = await store.get('tabHasRole', adminRoleName);
  if (existingRole) {
    check(true, `tabHasRole admin row already exists for ${adminEmail}`);
  } else {
    await store.insert('tabHasRole', {
      name:        adminRoleName,
      parent:      adminEmail,
      parenttype:  'User',
      parentfield: 'roles',
      role:        'admin',
      idx:         0,
    });
    check(true, `tabHasRole admin row inserted for ${adminEmail}`);
  }

  console.log(`\nSeed complete. Bootstrap admin: ${adminEmail}`);
  process.exit(pass ? 0 : 1);
} catch (err) {
  console.error('Seed failed:', err.message);
  process.exit(1);
}
