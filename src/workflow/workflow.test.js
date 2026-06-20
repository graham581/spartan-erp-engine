import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../runtime/memory-store.js';
import { registerDoctype, _resetRegistry } from '../meta/registry.js';
import { registerBootMeta } from '../meta/boot-meta.js';
import { WORKFLOW_HOOKS, getHooks } from './hooks.js';
import { _resetWorkflowCache } from './workflow.js';
import { makeContext } from '../perms/context.js';
import { createDoc, transitionDoc } from '../api/service.js';
import { handle } from '../api/handler.js';
import { PermissionError, StateError } from '../runtime/errors.js';

const STATES = ['draft', 'measure', 'manufacture', 'complete'];

// ---------------------------------------------------------------------------
// Condition closure registered as a code hook (ADR §6 / F3).
// "Job::start_measure" requires the deposit to be paid before starting measure.
// ---------------------------------------------------------------------------
WORKFLOW_HOOKS.set('Job::start_measure', {
  condition: async (doc) => doc.deposit_paid === true,
});

function seed(store) {
  // Prime meta-doctypes (pinned boot seed) + the Job doctype.
  registerBootMeta();
  registerDoctype({
    doctype: 'Job',
    table: 'tabJob',
    scopeFields: ['branch'],
    fields: [
      { fieldname: 'title',        fieldtype: 'Data',   reqd: true },
      { fieldname: 'branch',       fieldtype: 'Data' },
      { fieldname: 'status',       fieldtype: 'Select', options: STATES },
      { fieldname: 'deposit_paid', fieldtype: 'Check' },
    ],
    childTables: [],
    // Permissions are inline on the def (not via registerRolePerm).
    permissions: [
      { role: 'admin',     doctype: 'Job', permlevel: 0, read: true, write: true, create: true },
      { role: 'scheduler', doctype: 'Job', permlevel: 0, read: true, write: true, create: true },
      { role: 'factory',   doctype: 'Job', permlevel: 0, read: true, write: true, create: true },
      { role: 'rep',       doctype: 'Job', permlevel: 0, read: true,  ifOwner: true },
      { role: 'rep',       doctype: 'Job', permlevel: 0, write: true, ifOwner: true },
      { role: 'rep',       doctype: 'Job', permlevel: 0, create: true },
    ],
  });

  // Seed the declarative Workflow definition as data rows in the store.
  // This is the "Workflow stored as data" the F4 contract specifies.
  // tabWorkflow: one row per workflow (keyed by name = "Job")
  store.insert('tabWorkflow', {
    name:                 'Job',
    document_type:        'Job',
    workflow_state_field: 'status',
    is_active:            true,
  });

  // tabWorkflowTransition: child rows (parent = 'Job', parenttype = 'Workflow', parentfield = 'transitions')
  // The 'allowed' column holds newline-separated role names.
  // The 'guard' column provides the blocked-transition message.
  store.insert('tabWorkflowTransition', {
    name:        'wft-1',
    parent:      'Job',
    parenttype:  'Workflow',
    parentfield: 'transitions',
    state:       'draft',
    action:      'start_measure',
    next_state:  'measure',
    allowed:     'scheduler\nadmin',
    guard:       'deposit not paid',
    idx:         0,
  });
  store.insert('tabWorkflowTransition', {
    name:        'wft-2',
    parent:      'Job',
    parenttype:  'Workflow',
    parentfield: 'transitions',
    state:       'measure',
    action:      'release',
    next_state:  'manufacture',
    allowed:     'scheduler\nadmin',
    idx:         1,
  });
  store.insert('tabWorkflowTransition', {
    name:        'wft-3',
    parent:      'Job',
    parenttype:  'Workflow',
    parentfield: 'transitions',
    state:       'manufacture',
    action:      'complete',
    next_state:  'complete',
    allowed:     'factory\nadmin',
    idx:         2,
  });
}

const admin     = makeContext({ user: 'a@x',     roles: ['admin'],     unrestricted: true });
const scheduler = makeContext({ user: 'laura@x', roles: ['scheduler'], scopes: { branch: 'VIC' } });
const factory   = makeContext({ user: 'f@x',     roles: ['factory'],   scopes: { branch: 'VIC' } });
const rep       = makeContext({ user: 'rep@x',   roles: ['rep'],       scopes: { branch: 'VIC' } });

describe('workflow', () => {
  /** @type {MemoryStore} */
  let store;
  beforeEach(() => {
    _resetRegistry();
    _resetWorkflowCache();
    store = new MemoryStore();
    seed(store);
  });

  const newJob = (ctx, extra = {}) => createDoc(ctx, 'Job', { title: 'J', branch: 'VIC', ...extra }, store);

  it('advances when role + condition pass, and appends a transition-log row', async () => {
    const j = await newJob(admin, { deposit_paid: true });
    const out = await transitionDoc(scheduler, 'Job', j.name, 'start_measure', store);
    expect(out.status).toBe('measure');
    const log = await store.list('tabWorkflowAction', {});
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ ref_name: j.name, from_state: 'draft', to_state: 'measure', actor: 'laura@x' });
  });

  it('blocks the transition when the payment-gate condition fails', async () => {
    const j = await newJob(admin, { deposit_paid: false });
    await expect(transitionDoc(scheduler, 'Job', j.name, 'start_measure', store)).rejects.toBeInstanceOf(StateError);
  });

  it('blocks when the ctx lacks the transition role', async () => {
    const j = await newJob(rep, { deposit_paid: true }); // rep-owned so it passes row-scope; role gate still rejects
    await expect(transitionDoc(rep, 'Job', j.name, 'start_measure', store)).rejects.toBeInstanceOf(PermissionError);
  });

  it('rejects an action not valid from the current state', async () => {
    const j = await newJob(admin, { deposit_paid: true });
    await expect(transitionDoc(scheduler, 'Job', j.name, 'complete', store)).rejects.toBeInstanceOf(StateError);
  });

  it('runs the full chain with role hand-offs, logging each step', async () => {
    const j = await newJob(admin, { deposit_paid: true });
    await transitionDoc(scheduler, 'Job', j.name, 'start_measure', store); // draft -> measure
    await transitionDoc(scheduler, 'Job', j.name, 'release', store);       // measure -> manufacture
    const done = await transitionDoc(factory, 'Job', j.name, 'complete', store); // manufacture -> complete
    expect(done.status).toBe('complete');
    expect(await store.list('tabWorkflowAction', {})).toHaveLength(3);
  });

  it('routes through the generic handler: POST {action} -> workflow', async () => {
    const j = await newJob(scheduler, { deposit_paid: true }); // owner laura@x, VIC
    const ok = await handle({ method: 'POST', doctype: 'Job', name: j.name, body: { action: 'start_measure' }, ctx: scheduler }, store);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('measure');

    const rj = await newJob(rep, { deposit_paid: true }); // owner rep@x — rep can see it, but lacks the role
    const denied = await handle({ method: 'POST', doctype: 'Job', name: rj.name, body: { action: 'start_measure' }, ctx: rep }, store);
    expect(denied.status).toBe(403);
  });
});
