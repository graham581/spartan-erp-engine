# Supabase Migration Runbook

## History repair (out-of-sync migration history)

If `supabase db push` wants to re-run old migrations, the remote migration history
is out of sync.  Repair with:

```
supabase migration repair --status applied <version>
```

Run `--dry-run` first before any push that might conflict.

---

## Frozen runtime boot ordering

**Do not deviate from this sequence when provisioning a fresh database or adding
a new release to a running system.**

```
1. supabase db push
   Applies all pending DDL migrations in filename order, including:
     20260620010000_meta_core.sql     — 6 meta tables (tabDocType … tabWorkflowTransition, meta_version)
     20260620020000_next_series_fn.sql — next_series() Postgres RPC
     20260620030000_user_identity.sql  — tabUser + tabHasRole

2. node --env-file=.env scripts/seed-user-meta.mjs
   Writes User / Has Role DocMeta rows (tabDocType/tabDocField/tabDocPerm)
   and upserts the bootstrap admin tabUser + tabHasRole row.
   Requires: BOOTSTRAP_ADMIN_EMAIL env var (fails fast if unset).

3. Expose authenticated routes (deploy to Vercel / start the server).
```

**Why this order is frozen:**

- `tabUser` and `tabHasRole` must exist (step 1) before the seed script can
  write rows into them (step 2).
- `resolveUserToCtx` (src/perms/identity.js) calls `store.get('tabUser', …)` on
  every authenticated request.  A route serving an authenticated request before
  step 2 completes will throw AuthError for every real user, resulting in
  401s across the board.
- The Has Role DocMeta must be seeded BEFORE the User DocMeta inside the seed
  script (Table-target closure — MetaLoader throws if the child doctype meta
  is not primed; see src/meta/loader.js:112).

---

## Seed command (copy-paste)

```powershell
# Set your admin email, then run:
$env:BOOTSTRAP_ADMIN_EMAIL = "you@yourdomain.com"
node --env-file=.env scripts/seed-user-meta.mjs
```

The script is idempotent — re-running it on an already-seeded database is safe.
