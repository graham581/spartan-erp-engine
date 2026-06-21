import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthError, NotFoundError, PermissionError } from '../../src/runtime/errors.js';

// Mock the two async collaborators so the test is pure-unit (no DB, no token verify).
vi.mock('../../src/api/desk-bridge.js', () => ({ buildMeta: vi.fn() }));
vi.mock('../../src/api/context-from-request.js', () => ({ ctxFromRequest: vi.fn() }));
// bootstrap.js side-effects are not needed in this route-unit test.
vi.mock('../../src/bootstrap.js', () => ({}));
// SupabaseStore is lazy-init; stub it out so fromEnv() never runs.
vi.mock('../../src/runtime/supabase-store.js', () => ({
  SupabaseStore: { fromEnv: vi.fn(() => ({})) },
}));

import { buildMeta } from '../../src/api/desk-bridge.js';
import { ctxFromRequest } from '../../src/api/context-from-request.js';
// Import after mocks are registered.
const { default: handler } = await import('./[doctype].js');

// ---------------------------------------------------------------------------
// Minimal fake req/res helpers
// ---------------------------------------------------------------------------
function makeReq(method = 'GET', doctype = 'Quotation') {
  return {
    method,
    query: { doctype },
    headers: {},
  };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

const fakeMeta = {
  doctype: 'Quotation',
  capabilities: { read: true, write: true, create: true, delete: false, submit: false, cancel: false },
  meta: { doctype: 'Quotation', autoname: 'QTN-.#####', submittable: false, issingle: false, istable: false, isStub: false, fields: [], childTables: [], scopeFields: [] },
  child_metas: {},
  workflow: null,
};

const fakeCtx = { user: 'rep@x', roles: ['rep'], scopes: {} };

describe('GET /api/meta/[doctype] route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctxFromRequest.mockResolvedValue(fakeCtx);
    buildMeta.mockResolvedValue(fakeMeta);
  });

  it('200 happy path — valid ctx + readable doctype → res.status(200) with body', async () => {
    const req = makeReq('GET', 'Quotation');
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual(fakeMeta);
    expect(buildMeta).toHaveBeenCalledWith(fakeCtx, 'Quotation', expect.anything());
  });

  it('403 — buildMeta throws PermissionError → inner catch maps to 403', async () => {
    buildMeta.mockRejectedValue(new PermissionError('no read'));
    const req = makeReq('GET', 'Secret');
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(403);
    expect(res._body.type).toBe('PermissionError');
  });

  it('404 — buildMeta throws NotFoundError → inner catch maps to 404', async () => {
    buildMeta.mockRejectedValue(new NotFoundError('unknown doctype'));
    const req = makeReq('GET', 'NoSuch');
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(404);
    expect(res._body.type).toBe('NotFoundError');
  });

  it('401 — ctxFromRequest throws AuthError → outer catch maps to 401 (NOT 403/404)', async () => {
    ctxFromRequest.mockRejectedValue(new AuthError('bad token'));
    const req = makeReq('GET', 'Quotation');
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._body.type).toBe('AuthError');
    // buildMeta must NOT have been called — AuthError stops before the inner try
    expect(buildMeta).not.toHaveBeenCalled();
  });

  it('405 — non-GET method → 405 before any ctx or service call', async () => {
    const req = makeReq('POST', 'Quotation');
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(ctxFromRequest).not.toHaveBeenCalled();
    expect(buildMeta).not.toHaveBeenCalled();
  });

  it('decodeURIComponent — encoded doctype name is decoded before passing to buildMeta', async () => {
    const req = makeReq('GET', 'Sales%20Order');
    const res = makeRes();
    await handler(req, res);
    expect(buildMeta).toHaveBeenCalledWith(fakeCtx, 'Sales Order', expect.anything());
  });
});
