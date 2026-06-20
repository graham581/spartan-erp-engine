// LIVE proof of closure-bounding + link-stubbing against the engine DB.
//   1. planInstall bounds the REAL ERPNext Quotation (298 → ~9 full + Link stubs) — read-only.
//   2. A stub (Currency) installs live: framework-only table + tabDocType.is_stub=true.
//   3. SOFT-LINK live: a doc with a Link into the EMPTY Currency stub is ACCEPTED.
//   4. Negative control: a bad Link into a FULL target (Customer) is REJECTED — soft is stub-only.
//
//   node --env-file=.env scripts/prove-stub-install.mjs
// Engine's OWN isolated Supabase via .env (DATABASE_URL + DATABASE_URL_POOLER). Requires the
// is_stub ALTER applied first (20260621000000_doctype_is_stub.sql).
import { PgStore }          from '../src/runtime/pg-store.js';
import { PgAdmin }          from '../src/meta/pg-admin.js';
import { registerBootMeta } from '../src/meta/boot-meta.js';
import { migrate }          from '../src/meta/installer.js';
import { ensure }           from '../src/meta/loader.js';
import { makeStubDef }      from '../src/generator/erpnext-to-def.js';
import { planInstall }      from '../src/generator/select-doctypes.js';
import { makeContext }      from '../src/perms/context.js';
import { createDoc }        from '../src/api/service.js';

const ROOT = 'C:/Users/parrg/Documents/erpnext-develop/erpnext-develop/erpnext';
const log = (ok, m) => console.log(`${ok ? '✓' : '✗'} ${m}`);
let pass = true;
const check = (ok, m) => { pass = pass && ok; log(ok, m); };

// A small FULL probe doctype: one Link into a STUB target (Currency), one into a FULL target (Customer).
const QuoteProbeDef = {
  doctype: 'QuoteProbe',
  table: 'tabQuoteProbe',
  autoname: 'QP-.#####',
  fields: [
    { fieldname: 'title',    fieldtype: 'Data', reqd: true, permlevel: 0 },
    { fieldname: 'currency', fieldtype: 'Link', options: 'Currency', permlevel: 0 }, // STUB target
    { fieldname: 'customer', fieldtype: 'Link', options: 'Customer', permlevel: 0 }, // FULL target (exists)
  ],
  permissions: [
    { role: 'admin', permlevel: 0, read: true, write: true, create: true },
  ],
};
const admin = makeContext({ user: 'admin@spartan', roles: ['admin'], unrestricted: true });

try {
  registerBootMeta();
  const pgStore = PgStore.fromEnv();
  const pgAdmin = PgAdmin.fromEnv();

  // 1. BOUNDING (read-only) — the headline: real Quotation's 298-closure bounded.
  const { full, stubs } = planInstall(['Quotation'], ROOT);
  check(full.length >= 9 && full.length < 40, `planInstall bounds Quotation: ${full.length} FULL (closure was 298)`);
  check(stubs.length > 10, `${stubs.length} Link targets STUBBED (not generated full)`);
  check(full.includes('Quotation Item'), 'Quotation Item is FULL (child data preserved)');
  check(stubs.includes('Currency'), 'Currency is a STUB (Link target)');
  check(full.every((n) => !stubs.includes(n)), 'full ∩ stubs = ∅ (disjoint)');
  console.log(`  full(${full.length}): ${full.join(', ')}`);

  // 2. Install a STUB live (Currency) + the FULL probe.
  await migrate(makeStubDef('Currency'), pgStore, { admin: pgAdmin });
  check(true, 'installed Currency as a STUB (framework-only table)');
  await migrate(QuoteProbeDef, pgStore, { admin: pgAdmin });
  check(true, 'installed QuoteProbe (FULL, Link→Currency stub + Link→Customer full)');
  await ensure('QuoteProbe', pgStore);
  check(true, 'QuoteProbe meta hydrated (Currency stub + Customer full primed)');

  // 3. Marker is live: is_stub round-tripped through Postgres.
  const curRow = await pgStore.get('tabDocType', 'Currency');
  check(curRow?.is_stub === true, `tabDocType.Currency.is_stub=true (live, got ${curRow?.is_stub})`);

  // 4. SOFT-LINK: currency='AUD' has NO row in the empty Currency stub → accepted (existence softened).
  const soft = await createDoc(admin, 'QuoteProbe', { title: 'soft-link probe', currency: 'AUD' }, pgStore);
  check(/^QP-\d{5}$/.test(soft.name), `created ${soft.name} with currency='AUD' into EMPTY Currency stub — SOFT-LINK accepted`);

  // 5. NEGATIVE CONTROL: bad value into the FULL Customer target → rejected (soft is stub-only).
  let rejected = false;
  try {
    await createDoc(admin, 'QuoteProbe', { title: 'hard-link probe', customer: 'NO-SUCH-CUSTOMER-XYZ' }, pgStore);
  } catch { rejected = true; }
  check(rejected, "bad Link into FULL Customer REJECTED — soft-link is target-gated to stubs only");

  console.log(`\n${pass
    ? `✅ Stub/bounding PROVEN LIVE — real Quotation bounded to ${full.length} full + ${stubs.length} stubs; ${soft.name} created with a soft Link into an empty stub; hard Link into a full target still enforced`
    : '⚠  some checks failed — review above'}`);
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error(`\n✗ failed: ${e.name} — ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
