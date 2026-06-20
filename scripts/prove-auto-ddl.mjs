// LIVE proof: the engine creates a BRAND-NEW doctype's data table ITSELF and uses
// it immediately — ZERO human `supabase db push`.
//
// Requires DATABASE_URL in .env (Supabase Postgres connection string WITH the DB
// password, Session mode):  Settings → Database → Connection string → Session.
//   node --env-file=.env scripts/prove-auto-ddl.mjs
import { SupabaseStore } from '../src/runtime/supabase-store.js';
import { PgAdmin } from '../src/meta/pg-admin.js';
import { migrate } from '../src/meta/installer.js';
import { ensure } from '../src/meta/loader.js';
import { getMeta } from '../src/meta/registry.js';
import { makeContext } from '../src/perms/context.js';
import { createDoc, getDoc } from '../src/api/service.js';

const WidgetDef = {
  doctype: 'EngineWidget', table: 'tabEngineWidget', autoname: 'EW-.#####', scopeFields: [],
  fields: [
    { fieldname: 'title', fieldtype: 'Data', reqd: true, permlevel: 0 },
    { fieldname: 'qty', fieldtype: 'Int', permlevel: 0 },
    { fieldname: 'secret_cost', fieldtype: 'Currency', permlevel: 1 },
  ],
  permissions: [
    { role: 'admin', permlevel: 0, read: true, write: true, create: true, delete: true },
    { role: 'admin', permlevel: 1, read: true, write: true },
    { role: 'staff', permlevel: 0, read: true, write: true, create: true },
  ],
};

const store = SupabaseStore.fromEnv();
const admin = PgAdmin.fromEnv();
const log = (ok, m) => console.log(`${ok ? '✓' : '✗'} ${m}`);
let pass = true; const c = (ok, m) => { pass = pass && ok; log(ok, m); };

try {
  // 1. Engine creates the new doctype's TABLE itself (DDL run directly) + writes its meta.
  const res = await migrate(WidgetDef, store, { admin });
  c(res.applied === true, `migrate ran DDL directly — created ${WidgetDef.table} (no human db push)`);

  // 2. Hydrate the brand-new doctype's meta FROM the DB (never hand-registered).
  await ensure('EngineWidget', store);
  c(getMeta('EngineWidget').getField('secret_cost').permlevel === 1, 'meta hydrated from DB rows');

  // 3. Use it through the engine immediately.
  const adminCtx = makeContext({ user: 'admin@x', roles: ['admin'], unrestricted: true });
  const staff = makeContext({ user: 'staff@x', roles: ['staff'] });
  const w = await createDoc(adminCtx, 'EngineWidget', { title: 'Auto', qty: 3, secret_cost: 42 }, store);
  c(/^EW-\d{5}$/.test(w.name), `created a row in the auto-made table -> ${w.name}`);

  const seen = await getDoc(staff, 'EngineWidget', w.name, store);
  c(!('secret_cost' in seen), 'permlevel mask from DB meta: staff cannot see secret_cost');

  console.log(`\n${pass ? '✅ AUTO-DDL round-trip PASSED — the engine created its own table and used it, zero human db push' : '⚠ some checks failed'}`);
  process.exitCode = pass ? 0 : 1;
} catch (e) {
  console.error(`\n✗ failed: ${e.name} — ${e.message}`);
  if (/DATABASE_URL/.test(e.message)) {
    console.error('  → add DATABASE_URL to .env: Supabase → Settings → Database → Connection string → Session mode (includes the DB password).');
  }
  process.exitCode = 1;
}
