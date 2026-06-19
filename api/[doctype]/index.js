// Vercel route: collection. GET -> list, POST -> create. Covers EVERY doctype.
import { handle } from '../../src/api/handler.js';
import { SupabaseStore } from '../../src/runtime/supabase-store.js';
import { ctxFromRequest } from '../../src/api/context-from-request.js';

let _store;
function store() {
  if (!_store) _store = SupabaseStore.fromEnv();
  return _store;
}

export default async function handler(req, res) {
  try {
    const doctype = decodeURIComponent(req.query.doctype);
    const ctx = ctxFromRequest(req);
    const { status, body } = await handle(
      { method: req.method, doctype, name: null, body: req.body, query: req.query, ctx },
      store(),
    );
    res.status(status).json(body);
  } catch (err) {
    res.status(500).json({ error: err.message, type: 'ServerError' });
  }
}
