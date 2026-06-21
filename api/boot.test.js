/**
 * boot.test.js — route unit tests for api/boot.js (U3).
 *
 * Checks per work order §3 U3:
 *   Check 7 — GUEST ctx → 200 + boot object {user,roles,scopes,doctypes,server_date}
 *   Check 8 — AuthError from ctxFromRequest → 401 (NOT swallowed to 200 or 500)
 *   Method gate — non-GET → 405
 *
 * Strategy: vi.mock the two I/O boundaries (ctxFromRequest + buildBoot) so the
 * test drives pure route logic without a live store or token verifier.
 * The SupabaseStore singleton is also stubbed so the module loads cleanly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthError } from '../src/runtime/errors.js';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before the dynamic import so vi.mock hoisting
// rewrites them before the route module is evaluated.
// ---------------------------------------------------------------------------

vi.mock('../src/bootstrap.js', () => ({}));

vi.mock('../src/runtime/supabase-store.js', () => ({
  SupabaseStore: { fromEnv: () => ({}) },
}));

vi.mock('../src/api/context-from-request.js', () => ({
  ctxFromRequest: vi.fn(),
}));

vi.mock('../src/api/desk-bridge.js', () => ({
  buildBoot: vi.fn(),
}));

// Import the mocks so tests can configure them per-case.
import { ctxFromRequest } from '../src/api/context-from-request.js';
import { buildBoot }      from '../src/api/desk-bridge.js';

// Import the route handler AFTER mocks are wired.
const { default: handler } = await import('./boot.js');

// ---------------------------------------------------------------------------
// Helpers — minimal fake req / res
// ---------------------------------------------------------------------------

function makeReq(method = 'GET', headers = {}) {
  return { method, headers };
}

function makeRes() {
  const res = {
    _status: null,
    _body:   null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body   = body; return this; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('api/boot.js — route handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Check 7 — GUEST empty boot → 200
  // -------------------------------------------------------------------------
  it('Check 7: GUEST ctx → 200 with boot object shape', async () => {
    const guestCtx  = { user: 'guest', roles: [], scopes: {} };
    const bootBody  = { user: 'guest', roles: [], scopes: {}, doctypes: [], server_date: '2026-06-21' };
    ctxFromRequest.mockResolvedValue(guestCtx);
    buildBoot.mockResolvedValue(bootBody);

    const req = makeReq('GET');
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({
      user:        'guest',
      roles:       [],
      scopes:      {},
      doctypes:    [],
      server_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  // -------------------------------------------------------------------------
  // Check 8 — LEAK GATE: AuthError from ctxFromRequest → 401 (standalone)
  // -------------------------------------------------------------------------
  it('Check 8 (LEAK GATE): AuthError from ctxFromRequest → 401, not 200 or 500', async () => {
    ctxFromRequest.mockRejectedValue(new AuthError('invalid token'));

    const req = makeReq('GET');
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ type: 'AuthError' });
    // Explicitly assert it was NOT swallowed into a 200 or 500.
    expect(res._status).not.toBe(200);
    expect(res._status).not.toBe(500);
  });

  // -------------------------------------------------------------------------
  // Method gate — non-GET → 405
  // -------------------------------------------------------------------------
  it('non-GET → 405', async () => {
    const req = makeReq('POST');
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(405);
    expect(res._body).toMatchObject({ type: 'MethodNotAllowed' });
    // ctxFromRequest and buildBoot must not be called for non-GET.
    expect(ctxFromRequest).not.toHaveBeenCalled();
    expect(buildBoot).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Unexpected error (e.g. buildBoot throws non-Auth) → 500
  // -------------------------------------------------------------------------
  it('unexpected error from buildBoot → 500', async () => {
    ctxFromRequest.mockResolvedValue({ user: 'admin@x', roles: ['admin'], scopes: {} });
    buildBoot.mockRejectedValue(new Error('db exploded'));

    const req = makeReq('GET');
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._body).toMatchObject({ type: 'ServerError' });
  });
});
