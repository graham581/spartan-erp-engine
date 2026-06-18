import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createSalesOrder } from '../../src/api/service';
import { sendError } from '../../src/api/http';

// POST /api/sales-order  — create + validate a Sales Order
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }
    const payload = (req.body ?? {}) as Record<string, unknown>;
    const doc = await createSalesOrder(payload);
    return res.status(201).json({ ok: true, doc });
  } catch (e) {
    return sendError(res, e);
  }
}
