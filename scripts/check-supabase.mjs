// Verify engine Supabase credentials WITHOUT needing any app tables.
//   node --env-file=.env scripts/check-supabase.mjs
// 200 = credentials valid + project reachable. Prints only a MASKED key.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}
console.log('• URL:', url);
console.log('• service_role key:', key.slice(0, 6) + '…' + key.slice(-4), `(len ${key.length})`);

try {
  const res = await fetch(url.replace(/\/$/, '') + '/rest/v1/', {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const ok = res.status === 200;
  console.log('• REST root status:', res.status, ok ? '✓ credentials valid + reachable' : '(check URL/key)');
  process.exit(ok ? 0 : 2);
} catch (e) {
  console.error('✗ Network error:', e.message);
  process.exit(3);
}
