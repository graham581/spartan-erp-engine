import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSalesOrder, transitionSalesOrder } from '../../src/api/service';
import { sendError } from '../../src/api/http';

// GET  /api/sales-order/:name           — load a Sales Order
// POST /api/sales-order/:name { action } — action = 'submit' | 'cancel'
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const name = String(req.query.name);
  try {
    if (req.method === 'GET') {
      const doc = await getSalesOrder(name);
      return res.status(200).json({ ok: true, doc });
    }
    if (req.method === 'POST') {
      const body = (req.body ?? {}) as { action?: string };
      const action = body.action;
      if (action !== 'submit' && action !== 'cancel') {
        return res.status(400).json({ ok: false, error: "action must be 'submit' or 'cancel'" });
      }
      const doc = await transitionSalesOrder(name, action);
      return res.status(200).json({ ok: true, doc });
    }
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    return sendError(res, e);
  }
}
