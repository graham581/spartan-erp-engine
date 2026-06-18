import type { VercelRequest, VercelResponse } from '@vercel/node';

// Health check — confirms the deployment is live and whether Supabase is wired.
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    ok: true,
    service: 'spartan-erp-engine',
    supabaseConfigured: Boolean(process.env.SUPABASE_URL),
  });
}
