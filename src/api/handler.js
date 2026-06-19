import { createDoc, getDoc, listDocs, updateDoc, submitDoc, cancelDoc } from './service.js';
import { ValidationError, NotFoundError, PermissionError, StateError } from '../runtime/errors.js';

/** Map an EngineError subclass to an HTTP status. */
function statusFor(err) {
  if (err instanceof PermissionError) return 403;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof StateError) return 409;
  if (err instanceof ValidationError) return 400;
  return 500;
}

/**
 * Generic dispatcher for one doctype request. The Vercel route parses
 * (method, doctype, name, body, query) + builds a verified ctx, then calls this.
 * Never throws — every error maps to { status, body:{ error, type } }.
 *
 *   GET  /<doctype>            -> listDocs
 *   POST /<doctype>            -> createDoc            (body = payload)
 *   GET  /<doctype>/<name>     -> getDoc
 *   POST /<doctype>/<name>     -> updateDoc            (body = patch)
 *        body.action 'submit'  -> submitDoc
 *        body.action 'cancel'  -> cancelDoc
 *
 * @returns {Promise<{status:number, body:any}>}
 */
export async function handle({ method, doctype, name, body = {}, query = {}, ctx }, store) {
  try {
    const m = (method || 'GET').toUpperCase();
    const action = body && body.action;
    let data;

    if (!name) {
      if (m === 'GET') data = await listDocs(ctx, doctype, listOpts(query), store);
      else if (m === 'POST') data = await createDoc(ctx, doctype, body, store);
      else return { status: 405, body: { error: `${m} not allowed on a collection`, type: 'MethodNotAllowed' } };
    } else if (m === 'GET') {
      data = await getDoc(ctx, doctype, name, store);
    } else if (m === 'POST') {
      if (action === 'submit') data = await submitDoc(ctx, doctype, name, store);
      else if (action === 'cancel') data = await cancelDoc(ctx, doctype, name, store);
      else if (action) return { status: 400, body: { error: `Unknown action '${action}'`, type: 'ValidationError' } };
      else data = await updateDoc(ctx, doctype, name, body, store);
    } else {
      return { status: 405, body: { error: `${m} not allowed`, type: 'MethodNotAllowed' } };
    }
    return { status: 200, body: data };
  } catch (err) {
    return { status: statusFor(err), body: { error: err.message, type: err.name } };
  }
}

/** Translate query-string params into store list options. */
function listOpts(query) {
  /** @type {import('../runtime/store.js').ListOpts} */
  const opts = {};
  if (query.limit) opts.range = { offset: Number(query.offset) || 0, limit: Number(query.limit) };
  if (query.order_by) opts.order = { field: query.order_by, desc: query.order === 'desc' };
  /** @type {Record<string, any>} */
  const filters = {};
  for (const [k, v] of Object.entries(query)) if (k.startsWith('f_')) filters[k.slice(2)] = v;
  if (Object.keys(filters).length) opts.filters = filters;
  return opts;
}
