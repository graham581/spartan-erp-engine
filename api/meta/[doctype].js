// Vercel route: GET /api/meta/<doctype> — returns masked meta + capabilities + workflow.
import '../../src/bootstrap.js'; // register doctypes + perms at cold start
import { buildMeta } from '../../src/api/desk-bridge.js';
import { SupabaseStore } from '../../src/runtime/supabase-store.js';
import { ctxFromRequest } from '../../src/api/context-from-request.js';
import { AuthError, NotFoundError, PermissionError } from '../../src/runtime/errors.js';

let _store;
function store() {
  if (!_store) _store = SupabaseStore.fromEnv();
  return _store;
}

function statusFor(err) {
  if (err instanceof AuthError) return 401;       // belt-and-braces; outer-catch also handles
  if (err instanceof PermissionError) return 403;
  if (err instanceof NotFoundError) return 404;
  return 500;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only', type: 'MethodNotAllowed' });
    const doctype = decodeURIComponent(req.query.doctype);
    const ctx = await ctxFromRequest(req, store());        // AuthError lands in outer catch → 401
    try {
      const body = await buildMeta(ctx, doctype, store()); // 403/404 from here
      res.status(200).json(body);
    } catch (err) {
      res.status(statusFor(err)).json({ error: err.message, type: err.name });
    }
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: err.message, type: 'AuthError' });
    res.status(500).json({ error: err.message, type: 'ServerError' });
  }
}
