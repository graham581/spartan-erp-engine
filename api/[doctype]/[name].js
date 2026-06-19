// Vercel route: single record. GET -> get, POST -> update / {action:submit|cancel}.
import '../../src/bootstrap.js'; // register doctypes + perms at cold start
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
    const name = decodeURIComponent(req.query.name);
    const ctx = ctxFromRequest(req);
    const { status, body } = await handle(
      { method: req.method, doctype, name, body: req.body, query: req.query, ctx },
      store(),
    );
    res.status(status).json(body);
  } catch (err) {
    res.status(500).json({ error: err.message, type: 'ServerError' });
  }
}
