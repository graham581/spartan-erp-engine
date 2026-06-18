import type { VercelResponse } from '@vercel/node';
import { ValidationError } from '../runtime/errors';

/** Map a thrown error to a sensible HTTP status + JSON body. */
export function sendError(res: VercelResponse, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  let status = 500;
  if (e instanceof ValidationError) status = 400;
  else if (/not found/i.test(message)) status = 404;
  res.status(status).json({ ok: false, error: message });
}
