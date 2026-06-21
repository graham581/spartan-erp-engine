/**
 * ApiClient — egress seam for the Desk UI.
 * Pure fetch + plain JS; no engine src/ import.
 * Envelope contract frozen per docs/workorder-desk-ui.md §1.
 */

export class ApiError extends Error {
  constructor(message, { status, type, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.body = body;
  }
}

export class ForbiddenError extends ApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends ApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'NotFoundError';
  }
}

// Keys the engine rejects — strip these from every body (DC3, invariant 1).
const RESERVED_KEYS = ['owner', 'docstatus', 'name', 'is_stub'];

function stripReserved(record) {
  if (!record || typeof record !== 'object') return record;
  const out = { ...record };
  for (const k of RESERVED_KEYS) delete out[k];
  return out;
}

/**
 * createApiClient({ getToken, onAuthExpired, fetchImpl })
 *
 * @param {object} opts
 * @param {() => string|null}           opts.getToken       - returns the current Bearer token
 * @param {() => Promise<void>}         opts.onAuthExpired  - called on 401; resolves when a fresh token is available
 * @param {typeof globalThis.fetch}    [opts.fetchImpl]     - injectable for tests; defaults to globalThis.fetch
 * @returns {{ boot, meta, list, get, create, update, action, submit, cancel }}
 */
export function createApiClient({
  getToken,
  onAuthExpired,
  fetchImpl = globalThis.fetch,
}) {
  // Core request helper — builds headers, parses response, maps errors.
  // retried: true on the single 401 retry (DC5).
  async function _request(url, init, retried = false) {
    const token = getToken();
    const headers = {
      'Content-Type': 'application/json',
      // DC2: token ONLY in Authorization header, never in URL/query.
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    };

    const res = await fetchImpl(url, { ...init, headers });

    if (res.ok) {
      return res.json();
    }

    // DC4 + DC5 error handling.
    if (res.status === 401) {
      if (retried) {
        throw new ApiError('Unauthorized', { status: 401 });
      }
      await onAuthExpired();
      return _request(url, init, true);
    }

    let errBody;
    try {
      errBody = await res.json();
    } catch {
      errBody = {};
    }
    const message = errBody.error || res.statusText || String(res.status);

    if (res.status === 403) {
      throw new ForbiddenError(message, { status: 403, type: errBody.type, body: errBody });
    }
    if (res.status === 404) {
      throw new NotFoundError(message, { status: 404, type: errBody.type, body: errBody });
    }
    // 400, 409, 500, etc.
    throw new ApiError(message, { status: res.status, type: errBody.type, body: errBody });
  }

  function _enc(s) {
    return encodeURIComponent(s);
  }

  // GET /api/boot
  function boot() {
    return _request('/api/boot', { method: 'GET' });
  }

  // GET /api/meta/<dt>
  function meta(dt) {
    return _request(`/api/meta/${_enc(dt)}`, { method: 'GET' });
  }

  // GET /api/<dt>?limit=&offset=&f_<k>=<v>[&order_by=&order=]
  // DC1/N2: order/order_by only added when order_by is present.
  function list(dt, { limit, offset, order, order_by, filters } = {}) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    // DC1/N2: only set order params when order_by is present.
    if (order_by !== undefined) {
      params.set('order_by', order_by);
      if (order !== undefined) params.set('order', order);
    }
    if (filters && typeof filters === 'object') {
      for (const [k, v] of Object.entries(filters)) {
        params.set(`f_${k}`, String(v));
      }
    }
    const qs = params.toString();
    const url = `/api/${_enc(dt)}${qs ? `?${qs}` : ''}`;
    return _request(url, { method: 'GET' });
  }

  // GET /api/<dt>/<name>
  function get(dt, name) {
    return _request(`/api/${_enc(dt)}/${_enc(name)}`, { method: 'GET' });
  }

  // POST /api/<dt>  flat body (DC1, DC3)
  function create(dt, record) {
    return _request(`/api/${_enc(dt)}`, {
      method: 'POST',
      body: JSON.stringify(stripReserved(record)),
    });
  }

  // POST /api/<dt>/<name>  flat patch (DC1, DC3)
  function update(dt, name, patch) {
    return _request(`/api/${_enc(dt)}/${_enc(name)}`, {
      method: 'POST',
      body: JSON.stringify(stripReserved(patch)),
    });
  }

  // POST /api/<dt>/<name>  { action } (DC1, invariant 2)
  function action(dt, name, actionName) {
    return _request(`/api/${_enc(dt)}/${_enc(name)}`, {
      method: 'POST',
      body: JSON.stringify({ action: actionName }),
    });
  }

  // Conveniences — just alias action (invariant 3).
  function submit(dt, name) {
    return action(dt, name, 'submit');
  }

  function cancel(dt, name) {
    return action(dt, name, 'cancel');
  }

  return { boot, meta, list, get, create, update, action, submit, cancel };
}
