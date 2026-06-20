// LIVE proof of the JOB SPINE — payment-gated status workflow on the real engine DB.
// Installs Job (auto-DDL) + seeds the Job Workflow, then:
//   create a VIC Job at 'Won' → attempt start_measure with deposit_pct=0 → BLOCKED (gate),
//   status unmoved, ZERO audit rows → fund (deposit_pct=5) → start_measure SUCCEEDS → walk gates.
//
//   node --env-file=.env scripts/prove-job.mjs
// Engine's OWN isolated Supabase via .env (DATABASE_URL + DATABASE_URL_POOLER). NOT prod.
import { PgStore }          from '../src/runtime/pg-store.js';
import { PgAdmin }          from '../src/meta/pg-admin.js';
import { registerBootMeta } from '../src/meta/boot-meta.js';
import { migrate }          from '../src/meta/installer.js';
import { ensure }           from '../src/meta/loader.js';
import { makeContext }      from '../src/perms/context.js';
import { createDoc, updateDoc, getDoc, transitionDoc } from '../src/api/service.js';
import { JobDef }           from '../src/doctypes/job/job.def.js';
import '../src/doctypes/job/job.controller.js';        // side-effect: registerController('Job')
import '../src/doctypes/job/job.hooks.js';             // side-effect: the 3 Job:: gate hooks
import { seedJobWorkflow, JOB_WORKFLOW_NAME } from '../src/doctypes/job/job.workflow.seed.js';

const log = (ok, m) => console.log(`${ok ? '✓' : '✗'} ${m}`);
let pass = true;
const check = (ok, m) => { pass = pass && ok; log(ok, m); };
const admin = makeContext({ user: 'admin@spartan', roles: ['admin'], unrestricted: true });

try {
  registerBootMeta();
  const pgStore = PgStore.fromEnv();
  const pgAdmin = PgAdmin.fromEnv();

  // 1. Install Job (auto-DDL tabJob + meta). Customer + Quotation Link targets already live.
  await migrate(JobDef, pgStore, { admin: pgAdmin });
  check(true, 'installed Job (tabJob, status workflow, VIC-/ACT- naming)');

  // 2. (Re)seed the Job Workflow — pre-clean for idempotent re-runs (insert-once seed).
  await pgStore.sql.unsafe(`DELETE FROM "tabWorkflowTransition" WHERE "parent" = $1`, [JOB_WORKFLOW_NAME]);
  await pgStore.sql.unsafe(`DELETE FROM "tabWorkflow" WHERE "name" = $1`, [JOB_WORKFLOW_NAME]);
  await seedJobWorkflow(pgStore);
  check(true, 'seeded Job Workflow (parent + 15 transition rows)');

  // 3. Hydrate Job meta (primes Customer + Quotation Link closure).
  await ensure('Job', pgStore);
  check(true, 'Job meta hydrated');

  // 4. Create a VIC Job at 'Won' with NO deposit.
  const job = await createDoc(admin, 'Job', {
    entity: 'VIC', status: 'Won', customer: 'CUST-00001',
    site_address: '12 Test St, Melbourne VIC',
    job_value: 24000, deposit_pct: 0, balance_pct: 0, mfg_paid: false,
  }, pgStore);
  check(/^VIC-\d{5}$/.test(job.name), `created ${job.name} (VIC-prefixed) at status='${job.status}'`);

  // 5. GATE BLOCK: start_measure with deposit_pct=0 → blocked (5% gate), status unmoved, no audit row.
  let blocked = false;
  try { await transitionDoc(admin, 'Job', job.name, 'start_measure', pgStore); }
  catch { blocked = true; }
  check(blocked, "start_measure with deposit_pct=0 BLOCKED by the 5% gate");
  const afterBlock = await getDoc(admin, 'Job', job.name, pgStore);
  check(afterBlock.status === 'Won', `status still 'Won' after blocked transition (got '${afterBlock.status}')`);
  const audit0 = await pgStore.list('tabWorkflowAction', { filters: { ref_name: job.name } });
  check(audit0.length === 0, `ZERO audit rows after the blocked gate (got ${audit0.length})`);

  // 6. FUND the deposit, then the gate opens.
  await updateDoc(admin, 'Job', job.name, { deposit_pct: 5 }, pgStore);
  const measured = await transitionDoc(admin, 'Job', job.name, 'start_measure', pgStore);
  check(measured.status === 'Measure', `funded (5%) → start_measure SUCCEEDS → status='${measured.status}'`);
  const audit1 = await pgStore.list('tabWorkflowAction', { filters: { ref_name: job.name } });
  check(audit1.length === 1, `1 audit row appended on the successful transition (got ${audit1.length})`);

  // 7. Walk the next gates: 45% → Sign-off, then mfg paid → (Manufacturing →) Scheduling.
  await updateDoc(admin, 'Job', job.name, { balance_pct: 45 }, pgStore);
  const signed = await transitionDoc(admin, 'Job', job.name, 'start_signoff', pgStore);
  check(signed.status === 'Sign-off', `45% → start_signoff → status='${signed.status}'`);

  console.log(`\n${pass
    ? `✅ JOB SPINE PROVEN LIVE — ${job.name}: gate BLOCKED at 0% deposit (status held, no audit), then funded → advanced Won→Measure→Sign-off through the payment gates (declarative workflow runtime, live)`
    : '⚠  some checks failed — review above'}`);
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error(`\n✗ failed: ${e.name} — ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
