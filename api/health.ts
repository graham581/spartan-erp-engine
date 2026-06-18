// Vercel serverless function — health check (Phase 0 scaffold).
// Confirms the deployment is live and whether Supabase env is wired.
export const config = { runtime: 'nodejs' };

export default function handler(_req: unknown, res: any) {
  res.status(200).json({
    ok: true,
    service: 'spartan-erp-engine',
    phase: '0-1 (scaffold + generator)',
    supabaseConfigured: Boolean(process.env.SUPABASE_URL),
  });
}
