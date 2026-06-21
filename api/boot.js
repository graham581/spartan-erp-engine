// Vercel route: GET /api/boot — lean boot object (identity + permitted doctype names).
import '../src/bootstrap.js';
import { buildBoot } from '../src/api/desk-bridge.js';
import { SupabaseStore } from '../src/runtime/supabase-store.js';
import { ctxFromRequest } from '../src/api/context-from-request.js';
import { AuthError } from '../src/runtime/errors.js';

let _store;
function store() {
  if (!_store) _store = SupabaseStore.fromEnv();
  return _store;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only', type: 'MethodNotAllowed' });
    const ctx = await ctxFromRequest(req, store());
    const body = await buildBoot(ctx, store());
    res.status(200).json(body);
  } catch (err) {
    // ctxFromRequest runs outside buildBoot, so AuthError from token verification
    // or user resolution lands here (§0.3 — same pattern as api/[doctype]/index.js).
    if (err instanceof AuthError) return res.status(401).json({ error: err.message, type: 'AuthError' });
    res.status(500).json({ error: err.message, type: 'ServerError' });
  }
}
