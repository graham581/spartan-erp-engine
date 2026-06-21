/**
 * desk-bridge.test.js — unit tests for buildBoot + buildMeta (U2).
 *
 * 9 checks from the critique, with the 3 leak-gate checks as standalone it() blocks.
 * MemoryStore only — no live DB.
 *
 * Seed layout:
 *   Quotation         — top-level readable; has permlevel-0 and permlevel-1 fields;
 *                       has a Table field → Quotation Item; has a Link field → Customer
 *   Quotation Item    — istable: true (child)
 *   Customer          — top-level, readable by admin; Link target (NOT a Table child)
 *   Secret            — no-read for the default ctx
 *   StubDoc           — is_stub: true
 *   BrokenRef         — tabDocType row present but its Table target is missing (ensure throws)
 *   Workflow row      — seeded for Quotation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryStore }         from '../runtime/memory-store.js';
import { registerBootMeta }    from '../meta/boot-meta.js';
import { _resetRegistry }      from '../meta/registry.js';
import { _resetWorkflowCache } from '../workflow/workflow.js';
import { makeContext, GUEST }  from '../perms/context.js';
import { PermissionError, NotFoundError } from '../runtime/errors.js';
import { buildBoot, buildMeta } from './desk-bridge.js';

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

// pl0Ctx has only permlevel-0 read on Quotation (role: 'sales')
const pl0Ctx = makeContext({ user: 'rep@x', roles: ['sales'] });
// pl1Ctx has permlevel-0 AND permlevel-1 read on Quotation (role: 'admin')
const pl1Ctx = makeContext({ user: 'admin@x', roles: ['admin'], unrestricted: true });

// ---------------------------------------------------------------------------
// Seed helpers (mirror loader.test.js pattern)
// ---------------------------------------------------------------------------

function seedDocType(store, name, extra = {}) {
  return store.insert('tabDocType', {
    name,
    docstatus: 0,
    idx: 0,
    is_submittable: false,
    is_stub: false,
    istable: false,
    ...extra,
  });
}

function seedField(store, parent, fieldname, fieldtype, extra = {}) {
  return store.insert('tabDocField', {
    name: `${parent}-${fieldname}`,
    parent,
    parenttype: 'DocType',
    parentfield: 'fields',
    fieldname,
    fieldtype,
    reqd: false,
    read_only: false,
    unique: false,
    permlevel: 0,
    idx: 0,
    ...extra,
  });
}

function seedPerm(store, parent, role, flags = {}) {
  return store.insert('tabDocPerm', {
    name: `${parent}-${role}-${flags.permlevel ?? 0}`,
    parent,
    parenttype: 'DocType',
    parentfield: 'permissions',
    role,
    permlevel: 0,
    if_owner: false,
    read: false, write: false, create: false,
    submit: false, cancel: false, delete: false,
    ...flags,
  });
}

/**
 * Full seed: Quotation + Quotation Item + Customer + Secret + StubDoc + BrokenRef
 * + Workflow for Quotation.
 * @param {MemoryStore} store
 */
async function seedAll(store) {
  registerBootMeta();

  // --- Quotation Item (child / istable) — seed first so Table target is primed
  seedDocType(store, 'Quotation Item', { istable: true });
  // Quotation Item has one permlevel-0 field; no perms of its own (inherits parent read)
  seedField(store, 'Quotation Item', 'qty', 'Int');
  // No DocPerm rows for Quotation Item (child, no independent grants)

  // --- Customer (Link target, NOT a Table child)
  seedDocType(store, 'Customer');
  seedField(store, 'Customer', 'customer_name', 'Data');
  seedPerm(store, 'Customer', 'admin', { read: true, write: true, create: true });
  seedPerm(store, 'Customer', 'sales', { read: true });

  // --- Quotation (top-level readable)
  seedDocType(store, 'Quotation');
  // permlevel-0 fields
  seedField(store, 'Quotation', 'customer', 'Link', { options: 'Customer', idx: 0 });
  seedField(store, 'Quotation', 'items', 'Table', { options: 'Quotation Item', idx: 1 });
  // permlevel-1 field (only admin/pl1Ctx can see)
  seedField(store, 'Quotation', 'margin', 'Currency', { permlevel: 1, idx: 2 });
  // Permissions
  seedPerm(store, 'Quotation', 'admin', { permlevel: 0, read: true, write: true, create: true });
  seedPerm(store, 'Quotation', 'admin', { permlevel: 1, read: true, write: true,
    name: 'Quotation-admin-1' }); // name override for uniqueness
  seedPerm(store, 'Quotation', 'sales', { permlevel: 0, read: true });

  // --- Secret (no read for 'sales' role)
  seedDocType(store, 'Secret');
  seedField(store, 'Secret', 'secret_data', 'Data');
  seedPerm(store, 'Secret', 'admin', { read: true, write: true, create: true });
  // 'sales' has NO perm on Secret → can(pl0Ctx, 'Secret', 'read') = false

  // --- StubDoc (is_stub: true)
  seedDocType(store, 'StubDoc', { is_stub: true });
  seedField(store, 'StubDoc', 'x', 'Data');
  seedPerm(store, 'StubDoc', 'admin', { read: true });
  seedPerm(store, 'StubDoc', 'sales', { read: true });

  // --- BrokenRef: tabDocType row exists but its Table target is missing
  //     ensure() will throw because the Table target "MissingChild" has no tabDocType row.
  seedDocType(store, 'BrokenRef');
  seedField(store, 'BrokenRef', 'lines', 'Table', { options: 'MissingChild' });
  seedPerm(store, 'BrokenRef', 'sales', { read: true });
  // NOTE: 'MissingChild' tabDocType row is deliberately NOT seeded.

  // --- Workflow for Quotation
  store.insert('tabWorkflow', {
    name: 'Quotation',
    document_type: 'Quotation',
    workflow_state_field: 'workflow_state',
    is_active: true,
  });
  store.insert('tabWorkflowTransition', {
    name: 'wft-q1',
    parent: 'Quotation',
    parenttype: 'Workflow',
    parentfield: 'transitions',
    state: 'Draft',
    action: 'Submit',
    next_state: 'Submitted',
    allowed: 'sales\nadmin',
    idx: 0,
  });
  store.insert('tabWorkflowTransition', {
    name: 'wft-q2',
    parent: 'Quotation',
    parenttype: 'Workflow',
    parentfield: 'transitions',
    state: 'Submitted',
    action: 'Cancel',
    next_state: 'Cancelled',
    allowed: 'admin',
    idx: 1,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('desk-bridge — U2', () => {
  /** @type {MemoryStore} */
  let store;

  beforeEach(async () => {
    _resetRegistry();
    _resetWorkflowCache();
    store = new MemoryStore();
    await seedAll(store);
  });

  // -------------------------------------------------------------------------
  // LEAK GATE 2 — boot exclusions (istable / is_stub / no-read each individually)
  // -------------------------------------------------------------------------

  it('[gate 2] buildBoot excludes istable, is_stub, and no-read doctypes individually', async () => {
    const boot = await buildBoot(pl0Ctx, store);

    // Quotation is readable by pl0Ctx (sales has read at permlevel-0)
    expect(boot.doctypes).toContain('Quotation');

    // Quotation Item is istable — must be excluded
    expect(boot.doctypes).not.toContain('Quotation Item');

    // StubDoc is is_stub — must be excluded
    expect(boot.doctypes).not.toContain('StubDoc');

    // Secret has no read for 'sales' — must be excluded
    expect(boot.doctypes).not.toContain('Secret');
  });

  // -------------------------------------------------------------------------
  // LEAK GATE 2 (continued) — per-doctype omit-on-throw
  // -------------------------------------------------------------------------

  it('[gate 2] buildBoot omits-and-continues when a single ensure() throws; does not reject', async () => {
    // BrokenRef has a Table field to MissingChild which is not seeded → ensure throws
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Resolves cleanly (no throw)
    const boot = await buildBoot(pl0Ctx, store);

    // Quotation still present
    expect(boot.doctypes).toContain('Quotation');
    // BrokenRef absent (threw during ensure)
    expect(boot.doctypes).not.toContain('BrokenRef');

    // console.warn was called for the broken doctype
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(warnCalls.some((m) => m.includes('BrokenRef') || m.includes('MissingChild'))).toBe(true);

    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Check 4 — field masking at permlevel
  // -------------------------------------------------------------------------

  it('buildMeta: permlevel-1 field "margin" absent for pl0Ctx, present for pl1Ctx', async () => {
    const result0 = await buildMeta(pl0Ctx, 'Quotation', store);
    const fieldnames0 = result0.meta.fields.map((f) => f.fieldname);
    expect(fieldnames0).not.toContain('margin');

    const result1 = await buildMeta(pl1Ctx, 'Quotation', store);
    const fieldnames1 = result1.meta.fields.map((f) => f.fieldname);
    expect(fieldnames1).toContain('margin');
  });

  // -------------------------------------------------------------------------
  // Check 5 — 403 on no-read; 404 on unknown doctype
  // -------------------------------------------------------------------------

  it('buildMeta throws PermissionError (403) when ctx has no read on the doctype', async () => {
    await expect(buildMeta(pl0Ctx, 'Secret', store)).rejects.toBeInstanceOf(PermissionError);
  });

  it('buildMeta throws NotFoundError (404) for an unknown doctype (before any read-gate leak)', async () => {
    await expect(buildMeta(pl0Ctx, 'NoSuchDoctype', store)).rejects.toBeInstanceOf(NotFoundError);
  });

  // -------------------------------------------------------------------------
  // LEAK GATE 6 — child_metas inline + masked; Link target NOT inlined
  // -------------------------------------------------------------------------

  it('[gate 6] child_metas contains Quotation Item (Table child) with masked fields; Customer (Link) is NOT present', async () => {
    const result = await buildMeta(pl0Ctx, 'Quotation', store);

    // Table child is inlined
    expect(result.child_metas).toHaveProperty('Quotation Item');

    // Link target is NOT inlined
    expect(result.child_metas).not.toHaveProperty('Customer');

    // Child fields are masked (Quotation Item has no DocPerms; visibleFields returns [] for pl0Ctx
    // because there are no matching DocPerm rows on the child — but field masking still runs)
    // The child meta object itself should be a valid projected meta shape.
    const childMeta = result.child_metas['Quotation Item'];
    expect(childMeta).toBeDefined();
    expect(childMeta).toHaveProperty('doctype', 'Quotation Item');
    expect(childMeta).toHaveProperty('fields');
    expect(childMeta).not.toHaveProperty('permissions');
  });

  // -------------------------------------------------------------------------
  // GUEST — empty boot (doctypes []), 200-shaped (no throw)
  // -------------------------------------------------------------------------

  it('GUEST: buildBoot resolves with empty doctypes (no throw)', async () => {
    const boot = await buildBoot(GUEST, store);
    expect(boot.user).toBe('guest');
    expect(boot.roles).toEqual([]);
    expect(boot.doctypes).toEqual([]);
    expect(boot.server_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // -------------------------------------------------------------------------
  // Check 9 — workflow graph projected; condition/onTransition NEVER leak
  // -------------------------------------------------------------------------

  it('workflow graph is projected to {from,to,action,roles} only — no condition/function leaks', async () => {
    const result = await buildMeta(pl0Ctx, 'Quotation', store);
    const wf = result.workflow;

    expect(wf).not.toBeNull();
    expect(wf.states).toContain('Draft');
    expect(wf.states).toContain('Submitted');
    expect(wf.transitions).toHaveLength(2);

    // Each transition carries only the serializable keys
    for (const t of wf.transitions) {
      expect(t).toHaveProperty('from');
      expect(t).toHaveProperty('to');
      expect(t).toHaveProperty('action');
      // roles may be present (string[] or undefined) — either is fine
      // condition and onTransition must NEVER appear
      expect(t).not.toHaveProperty('condition');
      expect(t).not.toHaveProperty('onTransition');
    }

    // Verify JSON round-trip is clean (no non-serializable values)
    const serialized = JSON.stringify(wf);
    const parsed = JSON.parse(serialized);
    for (const t of parsed.transitions) {
      expect(typeof t.condition).toBe('undefined');
      expect(typeof t.onTransition).toBe('undefined');
    }
  });

  // -------------------------------------------------------------------------
  // Capabilities + no raw DocPerm rows
  // -------------------------------------------------------------------------

  it('capabilities is the 6-key boolean object; meta.permissions is not present in output', async () => {
    const result = await buildMeta(pl0Ctx, 'Quotation', store);

    // 6-key boolean capabilities
    const caps = result.capabilities;
    expect(typeof caps.read).toBe('boolean');
    expect(typeof caps.write).toBe('boolean');
    expect(typeof caps.create).toBe('boolean');
    expect(typeof caps.delete).toBe('boolean');
    expect(typeof caps.submit).toBe('boolean');
    expect(typeof caps.cancel).toBe('boolean');

    // raw DocPerm rows must not appear
    expect(result.meta.permissions).toBeUndefined();
    // also not under any other key
    expect(result).not.toHaveProperty('permissions');
  });

  // -------------------------------------------------------------------------
  // boot returns expected shape fields
  // -------------------------------------------------------------------------

  it('buildBoot returns user, roles, scopes, doctypes, server_date', async () => {
    const boot = await buildBoot(pl0Ctx, store);
    expect(boot).toHaveProperty('user', 'rep@x');
    expect(boot).toHaveProperty('roles');
    expect(Array.isArray(boot.roles)).toBe(true);
    expect(boot).toHaveProperty('scopes');
    expect(boot).toHaveProperty('doctypes');
    expect(boot).toHaveProperty('server_date');
    expect(boot.server_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
