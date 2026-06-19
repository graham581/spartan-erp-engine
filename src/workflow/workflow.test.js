import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../runtime/memory-store.js';
import { registerDoctype, _resetRegistry } from '../meta/registry.js';
import { registerRolePerm, _resetPerms } from '../perms/registry.js';
import { registerWorkflow, _resetWorkflows } from './registry.js';
import { makeContext } from '../perms/context.js';
import { createDoc, transitionDoc } from '../api/service.js';
import { handle } from '../api/handler.js';
import { PermissionError, StateError } from '../runtime/errors.js';

const STATES = ['draft', 'measure', 'manufacture', 'complete'];

function seed() {
  registerDoctype({
    doctype: 'Job',
    table: 'tabJob',
    scopeFields: ['branch'],
    fields: [
      { fieldname: 'title', fieldtype: 'Data', reqd: true },
      { fieldname: 'branch', fieldtype: 'Data' },
      { fieldname: 'status', fieldtype: 'Select', options: STATES },
      { fieldname: 'deposit_paid', fieldtype: 'Check' },
    ],
    childTables: [],
  });
  for (const role of ['admin', 'scheduler', 'factory', 'rep']) {
    registerRolePerm({ role, doctype: 'Job', permlevel: 0, read: true, write: true, create: true });
  }
  registerWorkflow({
    doctype: 'Job',
    stateField: 'status',
    initial: 'draft',
    states: STATES,
    transitions: [
      // payment-gated: can't start measure until the deposit is paid (cross-field/doc condition)
      { from: 'draft', to: 'measure', action: 'start_measure', roles: ['scheduler', 'admin'], condition: async (doc) => doc.deposit_paid === true, guard: 'deposit not paid' },
      { from: 'measure', to: 'manufacture', action: 'release', roles: ['scheduler', 'admin'] },
      { from: 'manufacture', to: 'complete', action: 'complete', roles: ['factory', 'admin'] },
    ],
  });
}

const admin = makeContext({ user: 'a@x', roles: ['admin'], unrestricted: true });
const scheduler = makeContext({ user: 'laura@x', roles: ['scheduler'], scopes: { branch: 'VIC' } });
const factory = makeContext({ user: 'f@x', roles: ['factory'], scopes: { branch: 'VIC' } });
const rep = makeContext({ user: 'rep@x', roles: ['rep'], scopes: { branch: 'VIC' }, ownerOnly: true });

describe('workflow', () => {
  /** @type {MemoryStore} */
  let store;
  beforeEach(() => { _resetRegistry(); _resetPerms(); _resetWorkflows(); seed(); store = new MemoryStore(); });

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
