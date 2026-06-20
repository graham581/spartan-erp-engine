// Vercel route: collection. GET -> list, POST -> create. Covers EVERY doctype.
import '../../src/bootstrap.js'; // register doctypes + perms at cold start
import { handle } from '../../src/api/handler.js';
import { SupabaseStore } from '../../src/runtime/supabase-store.js';
import { ctxFromRequest } from '../../src/api/context-from-request.js';
import { AuthError } from '../../src/runtime/errors.js';

let _store;
function store() {
  if (!_store) _store = SupabaseStore.fromEnv();
  return _store;
}

export default async function handler(req, res) {
  try {
    const doctype = decodeURIComponent(req.query.doctype);
    const ctx = await ctxFromRequest(req, store());
    const { status, body } = await handle(
      { method: req.method, doctype, name: null, body: req.body, query: req.query, ctx },
      store(),
    );
    res.status(status).json(body);
  } catch (err) {
    // ctxFromRequest runs outside handle(), so AuthError from token verification
    // or user resolution lands here rather than in handler.statusFor (§0.3).
    if (err instanceof AuthError) return res.status(401).json({ error: err.message, type: 'AuthError' });
    res.status(500).json({ error: err.message, type: 'ServerError' });
  }
}
