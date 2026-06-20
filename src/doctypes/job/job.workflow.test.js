/**
 * job.workflow.test.js — U5 Vitest suite for the Job-spine workflow (7 tests).
 *
 * Uses MemoryStore throughout. True tx-rollback-on-partial-write is the live
 * proof's job (U6 / prove-job.mjs on PgStore). MemoryStore.transaction is a
 * pass-through (store.js base), so the "no audit row on gate block" assertion
 * is valid because transition() throws BEFORE d.save() and the audit insert
 * (workflow.js:145-148) — nothing is written yet.
 *
 * C-1 FIX: job.hooks.js registers its three Job::* entries at import time (once
 * per worker). To prevent cross-file pollution of the process-global WORKFLOW_HOOKS
 * Map when workflow.test.js's toy hook runs in the same worker, this file
 * re-asserts all three prod Job::* entries in beforeEach and deletes them in
 * afterEach — making hook state per-test, independent of module-load order.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../../runtime/memory-store.js';
import { registerDoctype, _resetRegistry } from '../../meta/registry.js';
import { registerBootMeta } from '../../meta/boot-meta.js';
import { WORKFLOW_HOOKS, getHooks } from '../../workflow/hooks.js';
import { _resetWorkflowCache } from '../../workflow/workflow.js';
import { makeContext } from '../../perms/context.js';
import { createDoc, transitionDoc } from '../../api/service.js';
import { StateError, PermissionError } from '../../runtime/errors.js';

// Import Group A modules for their import-time side-effects:
//   job.controller.js → registerController('Job', JobController)
//   job.hooks.js      → WORKFLOW_HOOKS.set three Job::* entries
import '../../doctypes/job/job.controller.js';
import '../../doctypes/job/job.hooks.js';

import { JobDef, JOB_STATES } from '../../doctypes/job/job.def.js';
import { seedJobWorkflow } from '../../doctypes/job/job.workflow.seed.js';
import { JOB_WORKFLOW_TRANSITIONS } from '../../doctypes/job/job.workflow.seed.js';

// ---------------------------------------------------------------------------
// Prod hook entries (mirrored from job.hooks.js for beforeEach re-registration).
// C-1 FIX: these are set each beforeEach so this file's hook state is
// independent of workflow.test.js's toy hook, regardless of worker load order.
// ---------------------------------------------------------------------------
const JOB_HOOK_ENTRIES = [
  ['Job::start_measure',  { condition: (doc) => Number(doc.deposit_pct) >= 5 }],
  ['Job::start_signoff',  { condition: (doc) => Number(doc.balance_pct) >= 45 }],
  ['Job::to_scheduling',  { condition: (doc) => doc.mfg_paid === true }],
];

// ---------------------------------------------------------------------------
// Test contexts
// ---------------------------------------------------------------------------
const admin     = makeContext({ user: 'admin@x',     roles: ['admin'],     unrestricted: true });
const scheduler = makeContext({ user: 'laura@x',     roles: ['scheduler'] });
const sales     = makeContext({ user: 'sales@x',     roles: ['sales'] });

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** Minimal customer name used as the reqd Link target. */
const CUST = 'CUST-001';

/**
 * Seed the registry and workflow into the given store.
 * registerBootMeta() primes the 6 meta-doctypes (Workflow, WorkflowTransition, …).
 * registerDoctype(JobDef) primes Job. seedJobWorkflow inserts the 15 transition rows.
 */
async function seedHarness(store) {
  registerBootMeta();
  registerDoctype(JobDef);
  await seedJobWorkflow(store);
  // Insert a Customer row so the reqd Link 'customer' passes link validation
  // (validateLinks skips targets not in the registry, so this is only needed
  // if Customer IS registered; we're not registering it, so this is belt-and-
  // suspenders for future-proofing and doesn't hurt).
  await store.insert('tabCustomer', { name: CUST });
}

/** Shorthand: create a VIC Job as admin with sensible defaults.
 * status is passed explicitly: the engine does not auto-apply field `default`
 * on insert (Singles-only path in document.js:186); tests that verify the
 * `default:'Won'` contract check the meta def directly (test 6).
 */
async function newVICJob(store, extra = {}) {
  return createDoc(admin, 'Job', { entity: 'VIC', customer: CUST, status: 'Won', ...extra }, store);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Job workflow', () => {
  /** @type {MemoryStore} */
  let store;

  beforeEach(async () => {
    _resetRegistry();
    _resetWorkflowCache();
    // C-1 FIX: re-register prod Job::* hooks each test so they win over any
    // toy entry that workflow.test.js may have set in a prior test in the same worker.
    for (const [key, hook] of JOB_HOOK_ENTRIES) {
      WORKFLOW_HOOKS.set(key, hook);
    }
    store = new MemoryStore();
    await seedHarness(store);
  });

  afterEach(() => {
    // C-1 FIX: remove all Job::* keys so this file's hooks don't bleed into
    // workflow.test.js's toy suite when it runs after us in the same worker.
    for (const [key] of JOB_HOOK_ENTRIES) {
      WORKFLOW_HOOKS.delete(key);
    }
  });

  // -------------------------------------------------------------------------
  // Test 1 — Gated block + no audit row on condition failure
  // -------------------------------------------------------------------------
  it('blocks start_measure when deposit_pct < 5 and writes no audit row', async () => {
    // status: 'Won' is passed explicitly (engine does not auto-apply field defaults on insert).
    const j = await newVICJob(store, { deposit_pct: 0 });

    // Gate blocks: deposit_pct=0 < 5.
    await expect(
      transitionDoc(admin, 'Job', j.name, 'start_measure', store),
    ).rejects.toBeInstanceOf(StateError);

    // Status unchanged — read back from raw store (bypasses maskRead).
    const rows = await store.list('tabJob', {});
    const saved = rows.find((r) => r.name === j.name);
    expect(saved.status).toBe('Won');

    // No audit row — transition() threw before d.save() + audit insert
    // (workflow.js:145; MemoryStore.transaction is pass-through, so no rollback needed).
    const audit = await store.list('tabWorkflowAction', {});
    expect(audit).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 2 — Multi-role allowed path (UNTESTED by prove scripts — F-2)
  // -------------------------------------------------------------------------
  it('allows scheduler to fire to_scheduling once gates are cleared, and allowed encodes two roles', async () => {
    // Walk admin Job to Manufacturing: clear all gates along the way.
    const j = await newVICJob(store, { deposit_pct: 5, balance_pct: 45, mfg_paid: true });

    await transitionDoc(admin, 'Job', j.name, 'start_measure', store);
    await transitionDoc(admin, 'Job', j.name, 'start_signoff', store);
    await transitionDoc(admin, 'Job', j.name, 'to_manufacturing', store);

    // Scheduler fires to_scheduling (Manufacturing → Scheduling).
    const out = await transitionDoc(scheduler, 'Job', j.name, 'to_scheduling', store);
    expect(out.status).toBe('Scheduling');

    // Structural: idx-4 row encodes two roles via '\n', not one "admin, scheduler" string.
    const row4 = JOB_WORKFLOW_TRANSITIONS.find((r) => r.idx === 4);
    expect(row4.allowed.split('\n')).toStrictEqual(['admin', 'scheduler']);
  });

  // -------------------------------------------------------------------------
  // Test 3 — VIC/ACT naming + bad-entity fail-fast
  // -------------------------------------------------------------------------
  it('names VIC and ACT jobs correctly and rejects other entities before any write', async () => {
    const vic1 = await createDoc(admin, 'Job', { entity: 'VIC', customer: CUST }, store);
    expect(vic1.name).toMatch(/^VIC-\d{5}$/);

    const act1 = await createDoc(admin, 'Job', { entity: 'ACT', customer: CUST }, store);
    expect(act1.name).toMatch(/^ACT-\d{5}$/);

    // Two VIC jobs: counter increments independently of ACT counter.
    const vic2 = await createDoc(admin, 'Job', { entity: 'VIC', customer: CUST }, store);
    expect(vic2.name).toMatch(/^VIC-\d{5}$/);
    const n1 = parseInt(vic1.name.slice(4), 10);
    const n2 = parseInt(vic2.name.slice(4), 10);
    expect(n2).toBe(n1 + 1);

    // NSW / missing entity → throws before nextSeries advances.
    const beforeRows = await store.list('tabJob', {});
    await expect(
      createDoc(admin, 'Job', { entity: 'NSW', customer: CUST }, store),
    ).rejects.toThrow();
    const afterRows = await store.list('tabJob', {});
    expect(afterRows).toHaveLength(beforeRows.length); // no row written
  });

  // -------------------------------------------------------------------------
  // Test 4 — Hold → resume post-payment re-advance without re-payment (F-6)
  // -------------------------------------------------------------------------
  it('resumes from Hold to Measure and re-advances through gates without re-setting payment fields', async () => {
    const j = await newVICJob(store, { deposit_pct: 5, balance_pct: 45, mfg_paid: true });

    // Advance to Manufacturing.
    await transitionDoc(admin, 'Job', j.name, 'start_measure', store);
    await transitionDoc(admin, 'Job', j.name, 'start_signoff', store);
    await transitionDoc(admin, 'Job', j.name, 'to_manufacturing', store);

    // Hold from Manufacturing → Hold (idx-9, scheduler allowed).
    await transitionDoc(scheduler, 'Job', j.name, 'hold', store);
    const heldRows = await store.list('tabJob', {});
    expect(heldRows.find((r) => r.name === j.name).status).toBe('Hold');

    // Resume: Hold → Measure.
    await transitionDoc(scheduler, 'Job', j.name, 'resume', store);

    // Re-advance through start_signoff and to_scheduling WITHOUT modifying payment fields.
    await transitionDoc(admin, 'Job', j.name, 'start_signoff', store);
    await transitionDoc(admin, 'Job', j.name, 'to_manufacturing', store);
    const out = await transitionDoc(scheduler, 'Job', j.name, 'to_scheduling', store);

    expect(out.status).toBe('Scheduling');

    // Payment fields still set (no re-payment write happened).
    const finalRows = await store.list('tabJob', {});
    const finalDoc = finalRows.find((r) => r.name === j.name);
    expect(finalDoc.mfg_paid).toBe(true);
    expect(Number(finalDoc.deposit_pct)).toBeGreaterThanOrEqual(5);
    expect(Number(finalDoc.balance_pct)).toBeGreaterThanOrEqual(45);
  });

  // -------------------------------------------------------------------------
  // Test 5 — sales cannot transition (403 from write docperm gate)
  // -------------------------------------------------------------------------
  it('throws PermissionError when a sales ctx fires start_measure (no write docperm)', async () => {
    // Create the job as admin (sales.assertCanWrite rejects any field write since
    // sales has no write docperm — service.js:35 assertCanWrite on create payload).
    // What matters is that transitionDoc(sales, ...) hits assertCanMutate(write) → 403.
    const j = await newVICJob(store);

    // sales has no write docperm (JobDef: sales read+create only).
    // transitionDoc asserts write at service.js:100 before any DB load → PermissionError.
    await expect(
      transitionDoc(sales, 'Job', j.name, 'start_measure', store),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  // -------------------------------------------------------------------------
  // Test 6 — status defaults 'Won' on create; initial derived from idx-1 row
  // -------------------------------------------------------------------------
  it("status field default is 'Won' and workflow initial derives to 'Won'", async () => {
    // Verify the field default declaration in the meta (F-8 contract).
    // The engine applies field defaults only for Single doctypes on load (document.js:187);
    // for regular doctypes, the default is a UI/DDL hint. We test the declared value.
    const statusField = JobDef.fields.find((f) => f.fieldname === 'status');
    expect(statusField).toBeDefined();
    expect(statusField.default).toBe('Won');

    // Verify JOB_STATES[0] === 'Won' (initial state is first in the vocabulary).
    expect(JOB_STATES[0]).toBe('Won');

    // Verify workflow initial is derived from idx-1 row's state field.
    // This is confirmed by successfully transitioning from status:'Won' via start_measure.
    const j = await newVICJob(store, { deposit_pct: 5 }); // status:'Won' → can fire start_measure
    await transitionDoc(admin, 'Job', j.name, 'start_measure', store);
    const rows = await store.list('tabJob', {});
    const doc = rows.find((r) => r.name === j.name);
    // start_measure transitions Won → Measure (workflow.js:96: initial = transRows[0].state = 'Won').
    expect(doc.status).toBe('Measure');
  });

  // -------------------------------------------------------------------------
  // Test 7 — gate-key-resolves REGRESSION GUARD
  // -------------------------------------------------------------------------
  it('every gated action has a matching WORKFLOW_HOOKS entry and a matching transition row', () => {
    const gatedActions = ['start_measure', 'start_signoff', 'to_scheduling'];

    for (const action of gatedActions) {
      // Hook registered and condition is a function.
      const hook = getHooks('Job', action);
      expect(typeof hook.condition).toBe('function');

      // Matching transition row exists in the seed.
      const row = JOB_WORKFLOW_TRANSITIONS.find((r) => r.action === action);
      expect(row).toBeDefined();
    }

    // Inverse guard: no Job::* key in WORKFLOW_HOOKS lacks a matching transition row.
    for (const key of WORKFLOW_HOOKS.keys()) {
      if (!key.startsWith('Job::')) continue;
      const action = key.slice('Job::'.length);
      const row = JOB_WORKFLOW_TRANSITIONS.find((r) => r.action === action);
      expect(row, `WORKFLOW_HOOKS key '${key}' has no matching transition row — key typo silently ungates a gate`).toBeDefined();
    }
  });
});
