/**
 * Unit tests for ApiClient (U1).
 * Node env — no DOM, no network.
 * All assertions per docs/workorder-desk-ui.md §U1 done-criteria.
 */
import { describe, it, expect, vi } from 'vitest';
import { ApiError, ForbiddenError, NotFoundError, createApiClient } from './client.js';

const TOKEN = 'test-token-abc123';

function makeMock(responses) {
  // responses: array of { status, body } objects consumed in order
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const resp = responses.shift() ?? { status: 200, body: {} };
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      statusText: String(resp.status),
      json: async () => resp.body,
    };
  });
  return { fetchImpl, calls };
}

function makeClient(responses, { onAuthExpired } = {}) {
  const { fetchImpl, calls } = makeMock(responses);
  const authExpiredMock = onAuthExpired ?? vi.fn(async () => {});
  const client = createApiClient({
    getToken: () => TOKEN,
    onAuthExpired: authExpiredMock,
    fetchImpl,
  });
  return { client, calls, fetchImpl, authExpiredMock };
}

// ---------------------------------------------------------------------------
// Envelope — exact (url, method, headers, body) per DC1
// ---------------------------------------------------------------------------

describe('create envelope', () => {
  it('POSTs to /api/<dt>, flat body, correct method + auth header', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { name: 'CUST-001' } }]);
    await client.create('Customer', { title: 'Acme', branch: 'VIC' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/Customer');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0].init.body)).toEqual({ title: 'Acme', branch: 'VIC' });
  });

  it('URL-encodes the doctype', async () => {
    const { client, calls } = makeClient([{ status: 200, body: {} }]);
    await client.create('Sales Order', { title: 'x' });
    expect(calls[0].url).toBe('/api/Sales%20Order');
  });
});

describe('update envelope', () => {
  it('POSTs to /api/<dt>/<name>, flat patch, name URL-encoded', async () => {
    const { client, calls } = makeClient([{ status: 200, body: {} }]);
    await client.update('Customer', 'CUST 001', { branch: 'NSW' });
    expect(calls[0].url).toBe('/api/Customer/CUST%20001');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ branch: 'NSW' });
  });
});

describe('action envelope', () => {
  it('POSTs to /api/<dt>/<name>, body is {action}', async () => {
    const { client, calls } = makeClient([{ status: 200, body: {} }]);
    await client.action('Sales Order', 'SO-0001', 'approve');
    expect(calls[0].url).toBe('/api/Sales%20Order/SO-0001');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ action: 'approve' });
  });

  it('submit sends {action:"submit"}', async () => {
    const { client, calls } = makeClient([{ status: 200, body: {} }]);
    await client.submit('Sales Order', 'SO-0001');
    expect(JSON.parse(calls[0].init.body)).toEqual({ action: 'submit' });
  });

  it('cancel sends {action:"cancel"}', async () => {
    const { client, calls } = makeClient([{ status: 200, body: {} }]);
    await client.cancel('Sales Order', 'SO-0001');
    expect(JSON.parse(calls[0].init.body)).toEqual({ action: 'cancel' });
  });
});

describe('list envelope', () => {
  it('with order_by: URL has f_branch + limit + order_by + order', async () => {
    const { client, calls } = makeClient([{ status: 200, body: [] }]);
    await client.list('Customer', {
      filters: { branch: 'VIC' },
      order_by: 'modified',
      order: 'desc',
      limit: 50,
    });
    const url = calls[0].url;
    expect(url).toContain('f_branch=VIC');
    expect(url).toContain('limit=50');
    expect(url).toContain('order_by=modified');
    expect(url).toContain('order=desc');
    expect(calls[0].init.method).toBe('GET');
  });

  it('without order_by: URL has NO order/order_by params (N2)', async () => {
    const { client, calls } = makeClient([{ status: 200, body: [] }]);
    await client.list('Customer', { limit: 20 });
    const url = calls[0].url;
    expect(url).not.toContain('order_by');
    expect(url).not.toContain('order=');
  });

  it('no options: URL is just /api/<dt> with no query string', async () => {
    const { client, calls } = makeClient([{ status: 200, body: [] }]);
    await client.list('Customer');
    expect(calls[0].url).toBe('/api/Customer');
  });

  it('offset is included in query when supplied', async () => {
    const { client, calls } = makeClient([{ status: 200, body: [] }]);
    await client.list('Customer', { offset: 10 });
    expect(calls[0].url).toContain('offset=10');
  });
});

// ---------------------------------------------------------------------------
// DC3 — reserved key stripping
// ---------------------------------------------------------------------------

describe('DC3 reserved key stripping', () => {
  it('strips name, owner from create body; name only appears in URL for update', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);

    // create: name + owner in the record must be stripped
    await client.create('Customer', { name: 'CUST-001', owner: 'admin', title: 'Acme' });
    const createBody = JSON.parse(calls[0].init.body);
    expect(createBody).not.toHaveProperty('name');
    expect(createBody).not.toHaveProperty('owner');
    expect(createBody.title).toBe('Acme');

    // update: name only in URL, not in patch body
    await client.update('Customer', 'CUST-001', { name: 'CUST-001', owner: 'admin', branch: 'VIC' });
    const updateBody = JSON.parse(calls[1].init.body);
    expect(updateBody).not.toHaveProperty('name');
    expect(updateBody).not.toHaveProperty('owner');
    expect(updateBody.branch).toBe('VIC');
    expect(calls[1].url).toBe('/api/Customer/CUST-001');
  });

  it('strips docstatus and is_stub from body', async () => {
    const { client, calls } = makeClient([{ status: 200, body: {} }]);
    await client.create('Customer', {
      title: 'X',
      docstatus: 1,
      is_stub: true,
    });
    const body = JSON.parse(calls[0].init.body);
    expect(body).not.toHaveProperty('docstatus');
    expect(body).not.toHaveProperty('is_stub');
    expect(body.title).toBe('X');
  });
});

// ---------------------------------------------------------------------------
// DC2 — token safety: token must never appear in any URL
// ---------------------------------------------------------------------------

describe('DC2 token safety', () => {
  it('token never appears in the URL passed to fetchImpl', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: [] },
      { status: 200, body: {} },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    await client.list('Customer', { filters: { branch: 'VIC' } });
    await client.create('Customer', { title: 'A' });
    await client.update('Customer', 'C-001', { title: 'B' });
    await client.action('Customer', 'C-001', 'approve');

    for (const call of calls) {
      expect(call.url).not.toContain(TOKEN);
    }
  });

  it('Authorization header carries the correct Bearer value', async () => {
    const { client, calls } = makeClient([{ status: 200, body: {} }]);
    await client.boot();
    expect(calls[0].init.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// DC4 + DC5 — 401 retry logic
// ---------------------------------------------------------------------------

describe('DC4/DC5 401 retry', () => {
  it('401 once then 200: calls onAuthExpired exactly once, resolves', async () => {
    const { client, calls, authExpiredMock } = makeClient(
      [
        { status: 401, body: { error: 'token expired', type: 'AuthError' } },
        { status: 200, body: { name: 'CUST-001' } },
      ],
    );
    const result = await client.get('Customer', 'CUST-001');
    expect(authExpiredMock).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ name: 'CUST-001' });
  });

  it('401 twice: throws ApiError with status 401 (no infinite loop)', async () => {
    const { client, calls, authExpiredMock } = makeClient(
      [
        { status: 401, body: { error: 'expired', type: 'AuthError' } },
        { status: 401, body: { error: 'still expired', type: 'AuthError' } },
      ],
    );
    await expect(client.get('Customer', 'CUST-001')).rejects.toThrow(ApiError);
    await expect(
      makeClient([
        { status: 401, body: {} },
        { status: 401, body: {} },
      ]).client.get('Customer', 'x'),
    ).rejects.toMatchObject({ status: 401 });
    // Exactly 2 fetch calls on the first client (original + one retry)
    expect(calls).toHaveLength(2);
    expect(authExpiredMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// DC4 — 403, 404, 409 error mapping
// ---------------------------------------------------------------------------

describe('DC4 error mapping', () => {
  it('403 throws ForbiddenError', async () => {
    const { client: c1 } = makeClient([
      { status: 403, body: { error: 'no permission', type: 'PermissionError' } },
    ]);
    await expect(c1.get('Customer', 'C-001')).rejects.toThrow(ForbiddenError);
    const { client: c2 } = makeClient([
      { status: 403, body: { error: 'no permission', type: 'PermissionError' } },
    ]);
    await expect(c2.get('Customer', 'C-001')).rejects.toMatchObject({ status: 403 });
  });

  it('404 throws NotFoundError', async () => {
    const { client } = makeClient([
      { status: 404, body: { error: 'not found', type: 'NotFoundError' } },
      { status: 404, body: { error: 'not found', type: 'NotFoundError' } },
    ]);
    await expect(client.get('Customer', 'C-NONE')).rejects.toThrow(NotFoundError);
    await expect(client.get('Customer', 'C-NONE')).rejects.toMatchObject({ status: 404 });
  });

  it('409 throws ApiError with .body.error verbatim', async () => {
    const engineError = 'Cannot transition: already approved';
    const { client } = makeClient([
      { status: 409, body: { error: engineError, type: 'StateError' } },
    ]);
    let err;
    try {
      await client.action('Sales Order', 'SO-001', 'approve');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.body.error).toBe(engineError);
  });

  it('400 throws ApiError', async () => {
    const { client } = makeClient([
      { status: 400, body: { error: 'title is required', type: 'ValidationError' } },
    ]);
    await expect(client.create('Customer', {})).rejects.toThrow(ApiError);
    await expect(
      makeClient([{ status: 400, body: { error: 'bad', type: 'ValidationError' } }]).client.create('Customer', {}),
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------
// boot + meta passthrough
// ---------------------------------------------------------------------------

describe('boot and meta', () => {
  it('boot: GET /api/boot', async () => {
    const bootData = { user: 'graham', roles: ['admin'], doctypes: [] };
    const { client, calls } = makeClient([{ status: 200, body: bootData }]);
    const result = await client.boot();
    expect(calls[0].url).toBe('/api/boot');
    expect(calls[0].init.method).toBe('GET');
    expect(result).toEqual(bootData);
  });

  it('meta: GET /api/meta/<dt>', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { doctype: 'Customer' } }]);
    await client.meta('Customer');
    expect(calls[0].url).toBe('/api/meta/Customer');
    expect(calls[0].init.method).toBe('GET');
  });

  it('meta URL-encodes doctype', async () => {
    const { client, calls } = makeClient([{ status: 200, body: {} }]);
    await client.meta('Sales Order');
    expect(calls[0].url).toBe('/api/meta/Sales%20Order');
  });
});
