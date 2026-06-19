// Public health check — no DB or auth required, never touches secrets.
// GET /api/health -> liveness + whether the Supabase env is wired.
export default function handler(req, res) {
  res.status(200).json({
    status: 'ok',
    engine: 'spartan-erp-engine',
    time: new Date().toISOString(),
    node: process.version,
    // booleans only — confirms the env is present without revealing values
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
  });
}
