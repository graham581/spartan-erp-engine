// LIVE proof — drive ONE doctype (Customer) through the engine against the real
// Supabase project, exercising naming, validation, owner-stamping, permlevel
// masking, row-scope, and field-write denial.
//
//   1. Apply generated/migrations/0001_customer.sql in the engine's Supabase.
//   2. node --env-file=.env scripts/prove-customer.mjs
import { SupabaseStore } from '../src/runtime/supabase-store.js';
import { registerDoctype } from '../src/meta/registry.js';
import { registerRolePerm } from '../src/perms/registry.js';
import { makeContext } from '../src/perms/context.js';
import { createDoc, getDoc, listDocs, updateDoc } from '../src/api/service.js';
import { PermissionError } from '../src/runtime/errors.js';

// --- doctype + perms (hand-registered; the generator will emit this) ---
registerDoctype({
  doctype: 'Customer', table: 'tabCustomer', autoname: 'CUST-.#####', scopeFields: ['territory'],
  fields: [
    { fieldname: 'customer_name', fieldtype: 'Data', reqd: true, permlevel: 0 },
    { fieldname: 'territory', fieldtype: 'Data', permlevel: 0 },
    { fieldname: 'email', fieldtype: 'Data', permlevel: 0 },
    { fieldname: 'credit_limit', fieldtype: 'Currency', permlevel: 1 },
  ],
  childTables: [],
});
registerRolePerm({ role: 'admin', doctype: 'Customer', permlevel: 0, read: true, write: true, create: true, delete: true });
registerRolePerm({ role: 'admin', doctype: 'Customer', permlevel: 1, read: true, write: true });
registerRolePerm({ role: 'sales', doctype: 'Customer', permlevel: 0, read: true, write: true, create: true });

const admin = makeContext({ user: 'admin@spartan', roles: ['admin'], unrestricted: true });
const salesVic = makeContext({ user: 'rep-vic@spartan', roles: ['sales'], scopes: { territory: 'VIC' } });
const salesNsw = makeContext({ user: 'rep-nsw@spartan', roles: ['sales'], scopes: { territory: 'NSW' } });

const store = SupabaseStore.fromEnv();
const log = (ok, msg) => console.log(`${ok ? '✓' : '✗'} ${msg}`);
let pass = true;
const check = (ok, msg) => { pass = pass && ok; log(ok, msg); };

try {
  const c = await createDoc(admin, 'Customer',
    { customer_name: 'Acme Pty Ltd', territory: 'VIC', email: 'acme@x.com', credit_limit: 5000 }, store);
  check(!!c.name && c.owner === 'admin@spartan', `create -> ${c.name} (owner ${c.owner})`);

  const asSales = await getDoc(salesVic, 'Customer', c.name, store);
  check(!('credit_limit' in asSales), 'permlevel mask: sales does NOT see credit_limit');
  const asAdmin = await getDoc(admin, 'Customer', c.name, store);
  check(asAdmin.credit_limit === 5000, `admin sees credit_limit = ${asAdmin.credit_limit}`);

  const vicList = await listDocs(salesVic, 'Customer', {}, store);
  check(vicList.some((r) => r.name === c.name), `row-scope: VIC sales lists the VIC customer (${vicList.length} rows)`);
  const nswList = await listDocs(salesNsw, 'Customer', {}, store);
  check(!nswList.some((r) => r.name === c.name), `row-scope: NSW sales does NOT see it (${nswList.length} rows)`);

  let denied = false;
  try { await createDoc(salesVic, 'Customer', { customer_name: 'Sneaky', territory: 'VIC', credit_limit: 99999 }, store); }
  catch (e) { denied = e instanceof PermissionError; }
  check(denied, 'permlevel write: sales BLOCKED from setting credit_limit');

  const upd = await updateDoc(salesVic, 'Customer', c.name, { email: 'updated@x.com' }, store);
  check(upd.email === 'updated@x.com', `sales update of a base field -> ${upd.email}`);

  console.log(`\n${pass ? '✅ LIVE round-trip against Supabase: PASSED' : '⚠ some checks failed'}`);
  process.exitCode = pass ? 0 : 1;
} catch (e) {
  console.error(`\n✗ LIVE proof errored: ${e.name} — ${e.message}`);
  if (/relation .* does not exist|tabCustomer/.test(e.message)) {
    console.error('  → Did you apply generated/migrations/0001_customer.sql in the engine Supabase?');
  }
  process.exitCode = 1;
}
