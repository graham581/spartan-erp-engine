// END-TO-END proof: a lean (real-shaped) submittable Quotation through the LIVE engine DB.
// Installs Quotation Item (child) + Quotation via the auto-DDL path, then runs the full
// lifecycle: create (draft, with child items + a Link to the existing Customer) -> read back
// -> submit (docstatus 0->1 in a real PgStore transaction) -> re-read. Proves generator-shaped
// meta-as-data + auto-DDL + Link validation + child tables + perms + transactions together.
//
//   node --env-file=.env scripts/prove-quotation.mjs
//
// Engine's OWN isolated Supabase (DATABASE_URL + DATABASE_URL_POOLER in .env) — NOT prod.
import { PgStore }         from '../src/runtime/pg-store.js';
import { PgAdmin }         from '../src/meta/pg-admin.js';
import { registerBootMeta } from '../src/meta/boot-meta.js';
import { migrate }         from '../src/meta/installer.js';
import { ensure }          from '../src/meta/loader.js';
import { makeContext }     from '../src/perms/context.js';
import { createDoc, getDoc, submitDoc } from '../src/api/service.js';

const log = (ok, m) => console.log(`${ok ? '✓' : '✗'} ${m}`);
let pass = true;
const check = (ok, m) => { pass = pass && ok; log(ok, m); };

// Child target — installed FIRST (Table-target closure: loader needs the child meta primed).
const QuotationItemDef = {
  doctype: 'Quotation Item',
  table: 'tabQuotationItem',
  fields: [
    { fieldname: 'item_code', fieldtype: 'Data',     reqd: true },
    { fieldname: 'qty',       fieldtype: 'Float' },
    { fieldname: 'rate',      fieldtype: 'Currency' },
    { fieldname: 'amount',    fieldtype: 'Currency' },
  ],
  permissions: [],
};

// The parent — submittable, Links to the existing Customer doctype, has an items child table.
const QuotationDef = {
  doctype: 'Quotation',
  table: 'tabQuotation',
  autoname: 'QTN-.#####',
  submittable: true,
  fields: [
    { fieldname: 'customer',       fieldtype: 'Link',     options: 'Customer', reqd: true, permlevel: 0 },
    { fieldname: 'quotation_date', fieldtype: 'Date',     permlevel: 0 },
    { fieldname: 'status',         fieldtype: 'Data',     permlevel: 0 },
    { fieldname: 'total',          fieldtype: 'Currency', permlevel: 0 },
    { fieldname: 'items',          fieldtype: 'Table',    options: 'Quotation Item', permlevel: 0 },
  ],
  permissions: [
    { role: 'admin', permlevel: 0, read: true, write: true, create: true, submit: true, cancel: true, delete: true },
  ],
};

const admin = makeContext({ user: 'admin@spartan', roles: ['admin'], unrestricted: true });

try {
  registerBootMeta();
  const pgStore = PgStore.fromEnv();
  const pgAdmin = PgAdmin.fromEnv();

  // 1. Install (auto-DDL): child target first, then the parent.
  await migrate(QuotationItemDef, pgStore, { admin: pgAdmin });
  check(true, 'installed Quotation Item (tabQuotationItem)');
  await migrate(QuotationDef, pgStore, { admin: pgAdmin });
  check(true, 'installed Quotation (tabQuotation, submittable, QTN-.##### series)');

  // 2. Hydrate meta — primes the Customer Link target + Quotation Item child closure.
  await ensure('Quotation', pgStore);
  check(true, 'Quotation meta hydrated (Customer + Quotation Item closure primed)');

  // 3. Pick an existing live Customer to link (raw read — not perm-gated).
  const custRows = await pgStore.list('tabCustomer', {});
  const customerName = custRows[0]?.name;
  check(!!customerName, `found a live Customer to link: ${customerName}`);

  // 4. CREATE a draft Quotation with child line items + the Link.
  const created = await createDoc(admin, 'Quotation', {
    customer:       customerName,
    quotation_date: '2026-06-21',
    status:         'Draft',
    total:          3500,
    items: [
      { item_code: 'WIN-SLIDING-1800', qty: 3, rate: 800, amount: 2400 },
      { item_code: 'WIN-AWNING-900',   qty: 2, rate: 550, amount: 1100 },
    ],
  }, pgStore);
  check(/^QTN-\d{5}$/.test(created.name), `created ${created.name} (naming series resolved)`);
  check((created.docstatus ?? 0) === 0, `draft docstatus=0 (got ${created.docstatus})`);
  check(created.customer === customerName, `Link to ${customerName} validated + persisted`);

  // 5. Read back — child items round-tripped?
  const fetched = await getDoc(admin, 'Quotation', created.name, pgStore);
  check(Array.isArray(fetched.items) && fetched.items.length === 2,
        `child items persisted + reloaded (got ${fetched.items?.length})`);

  // 6. SUBMIT — docstatus 0 -> 1 inside a real PgStore transaction.
  const submitted = await submitDoc(admin, 'Quotation', created.name, pgStore);
  check(submitted.docstatus === 1, `submitted: docstatus 0 -> 1 (got ${submitted.docstatus})`);

  // 7. Re-read — submitted state persisted.
  const after = await getDoc(admin, 'Quotation', created.name, pgStore);
  check(after.docstatus === 1, `re-read confirms docstatus=1 (got ${after.docstatus})`);

  console.log(`\n${pass
    ? `✅ Quotation end-to-end PASSED — ${created.name} created → submitted on the live engine DB (meta-as-data + auto-DDL + Link + child table + transaction)`
    : '⚠  some checks failed — review above'}`);
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error(`\n✗ failed: ${e.name} — ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
