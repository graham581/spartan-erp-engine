// LIVE round-trip for a doctype defined AS DATA (the self-describing proof).
// Run AFTER the meta tables exist:  supabase db push  (applies 20260620010000_meta_core.sql)
// Reuses the existing tabCustomer DATA table (from the earlier customer proof);
// here the Installer writes Customer's *definition* into the DB, the Loader reads
// it back, and the engine uses it — nothing about Customer is hand-registered.
//   node --env-file=.env scripts/prove-customer-as-data.mjs
import { SupabaseStore } from '../src/runtime/supabase-store.js';
import { registerBootMeta } from '../src/meta/boot-meta.js';
import { syncDoctype } from '../src/meta/installer.js';
import { ensure } from '../src/meta/loader.js';
import { getMeta } from '../src/meta/registry.js';
import { makeContext } from '../src/perms/context.js';
import { createDoc, getDoc } from '../src/api/service.js';

const CustomerDef = {
  doctype: 'Customer', autoname: 'CUST-.#####', scopeFields: ['territory'],
  fields: [
    { fieldname: 'customer_name', fieldtype: 'Data', reqd: true, permlevel: 0 },
    { fieldname: 'territory', fieldtype: 'Data', permlevel: 0 },
    { fieldname: 'email', fieldtype: 'Data', permlevel: 0 },
    { fieldname: 'credit_limit', fieldtype: 'Currency', permlevel: 1 },
  ],
  permissions: [
    { role: 'admin', permlevel: 0, read: true, write: true, create: true, delete: true },
    { role: 'admin', permlevel: 1, read: true, write: true },
    { role: 'sales', permlevel: 0, read: true, write: true, create: true },
  ],
};

const store = SupabaseStore.fromEnv();
const log = (ok, msg) => console.log(`${ok ? '✓' : '✗'} ${msg}`);
let pass = true; const check = (ok, m) => { pass = pass && ok; log(ok, m); };

try {
  registerBootMeta();

  // 1. Write Customer's DEFINITION into the DB (tabDocType/tabDocField/tabDocPerm).
  await syncDoctype(CustomerDef, store);
  check(true, 'Installer wrote Customer meta rows to Postgres');

  // 2. Hydrate Customer meta FROM the DB (NOT hand-registered) — the self-describing step.
  await ensure('Customer', store);
  const m = getMeta('Customer');
  check(m.getField('credit_limit').permlevel === 1, 'meta hydrated from DB rows (credit_limit permlevel=1)');
  check(m.getDocPerms().some((p) => p.role === 'sales' && p.read === true), 'docperms loaded from DB as booleans');

  // 3. Use the DB-defined doctype through the engine (perms enforced from DB meta).
  const admin = makeContext({ user: 'admin@spartan', roles: ['admin'], unrestricted: true });
  const sales = makeContext({ user: 'rep@spartan', roles: ['sales'], scopes: { territory: 'VIC' } });

  const c = await createDoc(admin, 'Customer',
    { customer_name: 'DataDriven Pty', territory: 'VIC', email: 'dd@x.com', credit_limit: 7000 }, store);
  check(/^CUST-\d{5}$/.test(c.name), `created via DB-defined doctype -> ${c.name}`);

  const asSales = await getDoc(sales, 'Customer', c.name, store);
  check(!('credit_limit' in asSales), 'permlevel mask from DB-loaded meta: sales cannot see credit_limit');
  const asAdmin = await getDoc(admin, 'Customer', c.name, store);
  check(asAdmin.credit_limit === 7000, `admin sees credit_limit = ${asAdmin.credit_limit}`);

  console.log(`\n${pass ? '✅ LIVE doctype-as-data round-trip: PASSED — the engine is self-describing against real Postgres' : '⚠ some checks failed'}`);
  process.exitCode = pass ? 0 : 1;
} catch (e) {
  console.error(`\n✗ failed: ${e.name} — ${e.message}`);
  if (/tabDocType|does not exist|schema cache|column/.test(e.message)) {
    console.error('  → ensure 20260620010000_meta_core.sql is applied (supabase db push), and that its columns match the loader/installer.');
  }
  process.exitCode = 1;
}
