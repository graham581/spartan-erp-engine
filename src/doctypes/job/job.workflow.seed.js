/**
 * Job Workflow seed — parent tabWorkflow row + 15 tabWorkflowTransition child rows.
 *
 * Call seedJobWorkflow(store) from:
 *   - unit tests (MemoryStore) — U5 job.workflow.test.js
 *   - live proof (PgStore/SupabaseStore) — U6 prove-job.mjs
 *
 * Idempotency: this function is insert-once — it does not upsert or delete-then-
 * reinsert. Re-running against a store that already has 'Job Workflow' will fail
 * with a duplicate-name error on the parent insert. Callers that need idempotent
 * re-seeds (e.g. prove-job.mjs) must pre-delete the rows before calling, as shown
 * in prove-tx-rollback.mjs:238-244. The unit-test harness resets to a fresh
 * MemoryStore in beforeEach, so re-running there is naturally safe.
 *
 * Row shape confirmed against:
 *   - prove-tx-rollback.mjs case C (sbStore.insert seed pattern)
 *   - workflow.js:loadWorkflow (columns read: state/next_state/action/allowed/guard/idx
 *     + parent/parenttype/parentfield for getChildren)
 *   - ADR §4.1/§4.2/§4.3 (frozen contract)
 */

export const JOB_WORKFLOW_NAME = 'Job Workflow';

/** Parent tabWorkflow row — one per doctype. */
export const JOB_WORKFLOW_PARENT = {
  name:                 JOB_WORKFLOW_NAME,
  document_type:        'Job',
  workflow_state_field: 'status',
  docstatus:            0,
  idx:                  0,
};

/**
 * The 15 transition rows, idx-ordered.
 *
 * idx-1 row has state:'Won' so loadWorkflow derives initial='Won'
 * (workflow.js:96 — initial = transRows[0].state after idx-sort).
 *
 * allowed encoding: single-role = plain string ('admin'),
 * multi-role = '\n'-joined ('admin\nscheduler') — workflow.js:79 splits on '\n'.
 * NEVER use a comma-separated value; 'admin, scheduler' would be parsed as one
 * unknown role and 403 everyone including admin.
 *
 * guard text lives on the row and is surfaced by transition() when the condition
 * hook returns false (workflow.js:147).
 */
export const JOB_WORKFLOW_TRANSITIONS = [
  // ── forward path ──────────────────────────────────────────────────────────
  {
    name:        'job-wf-trans-01',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'start_measure',
    state:       'Won',
    next_state:  'Measure',
    allowed:     'admin',
    guard:       '5% deposit must clear before site measure.',
    idx:         1,
    docstatus:   0,
  },
  {
    name:        'job-wf-trans-02',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'start_signoff',
    state:       'Measure',
    next_state:  'Sign-off',
    allowed:     'admin',
    guard:       '45% of contract must clear before final sign-off.',
    idx:         2,
    docstatus:   0,
  },
  {
    name:        'job-wf-trans-03',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'to_manufacturing',
    state:       'Sign-off',
    next_state:  'Manufacturing',
    allowed:     'admin',
    guard:       null,
    idx:         3,
    docstatus:   0,
  },
  {
    name:        'job-wf-trans-04',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'to_scheduling',
    state:       'Manufacturing',
    next_state:  'Scheduling',
    allowed:     'admin\nscheduler',       // multi-role — NEWLINE-delimited (ADR F-2)
    guard:       'Manufacturing payment must clear before scheduling.',
    idx:         4,
    docstatus:   0,
  },
  {
    name:        'job-wf-trans-05',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'to_install',
    state:       'Scheduling',
    next_state:  'Install',
    allowed:     'admin\nscheduler',
    guard:       null,
    idx:         5,
    docstatus:   0,
  },
  {
    name:        'job-wf-trans-06',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'complete',
    state:       'Install',
    next_state:  'Complete',
    allowed:     'admin\nscheduler',
    guard:       null,
    idx:         6,
    docstatus:   0,
  },
  // ── hold (one row per holdable from-state — engine matches by (state, action)) ──
  {
    name:        'job-wf-trans-07',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'hold',
    state:       'Measure',
    next_state:  'Hold',
    allowed:     'admin\nscheduler',
    guard:       null,
    idx:         7,
    docstatus:   0,
  },
  {
    name:        'job-wf-trans-08',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'hold',
    state:       'Sign-off',
    next_state:  'Hold',
    allowed:     'admin\nscheduler',
    guard:       null,
    idx:         8,
    docstatus:   0,
  },
  {
    name:        'job-wf-trans-09',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'hold',
    state:       'Manufacturing',
    next_state:  'Hold',
    allowed:     'admin\nscheduler',
    guard:       null,
    idx:         9,
    docstatus:   0,
  },
  {
    name:        'job-wf-trans-10',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'hold',
    state:       'Scheduling',
    next_state:  'Hold',
    allowed:     'admin\nscheduler',
    guard:       null,
    idx:         10,
    docstatus:   0,
  },
  // ── resume — returns to Measure (v1 simplification; ADR §4.4) ─────────────
  {
    name:        'job-wf-trans-11',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'resume',
    state:       'Hold',
    next_state:  'Measure',
    allowed:     'admin\nscheduler',
    guard:       null,
    idx:         11,
    docstatus:   0,
  },
  // ── cancel — admin-only, early/held states only (Manufacturing+ is out of scope v1) ──
  {
    name:        'job-wf-trans-12',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'cancel',
    state:       'Won',
    next_state:  'Cancelled',
    allowed:     'admin',
    guard:       null,
    idx:         12,
    docstatus:   0,
  },
  {
    name:        'job-wf-trans-13',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'cancel',
    state:       'Measure',
    next_state:  'Cancelled',
    allowed:     'admin',
    guard:       null,
    idx:         13,
    docstatus:   0,
  },
  {
    name:        'job-wf-trans-14',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'cancel',
    state:       'Sign-off',
    next_state:  'Cancelled',
    allowed:     'admin',
    guard:       null,
    idx:         14,
    docstatus:   0,
  },
  {
    name:        'job-wf-trans-15',
    parent:      JOB_WORKFLOW_NAME,
    parenttype:  'Workflow',
    parentfield: 'transitions',
    action:      'cancel',
    state:       'Hold',
    next_state:  'Cancelled',
    allowed:     'admin',
    guard:       null,
    idx:         15,
    docstatus:   0,
  },
];

/**
 * Seed the Job Workflow parent row + all 15 transition rows into the given store.
 *
 * @param {import('../../runtime/store.js').Store} store
 * @returns {Promise<void>}
 */
export async function seedJobWorkflow(store) {
  await store.insert('tabWorkflow', JOB_WORKFLOW_PARENT);
  for (const row of JOB_WORKFLOW_TRANSITIONS) {
    await store.insert('tabWorkflowTransition', row);
  }
}
