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
1. ALL DDL migrations (in filename order — apply EVERY one before step 2):
     20260620010000_meta_core.sql          — 6 meta tables (tabDocType … tabWorkflowTransition, meta_version)
     20260620020000_next_series_fn.sql      — next_series() Postgres RPC
     20260620030000_user_identity.sql       — tabUser + tabHasRole
     20260620040000_workflow_action_log.sql — tabWorkflowAction (workflow transition audit log)
     20260620050000_docfield_depends_on.sql — tabDocField.depends_on + mandatory_depends_on columns
   Via `supabase db push` (applies all in filename order) when the folder is linked,
   OR individually via the direct-PG helper — see "Direct-PG apply path" below.

2. node --env-file=.env scripts/seed-user-meta.mjs
   Writes User / Has Role DocMeta rows (tabDocType/tabDocField/tabDocPerm)
   and upserts the bootstrap admin tabUser + tabHasRole row.
   Requires: BOOTSTRAP_ADMIN_EMAIL env var (fails fast if unset).

3. Expose authenticated routes (deploy to Vercel / start the server).
```

**Why this order is frozen:**

- `tabUser` and `tabHasRole` must exist (step 1) before the seed script can
  write rows into them (step 2).
- **The `depends_on` ALTER (`20260620050000`) MUST be applied before ANY meta
  sync, including the step-2 seed.** `installer.syncDoctype` writes
  `depends_on`/`mandatory_depends_on` to every `tabDocField` row unconditionally
  (as `null` when unused), so a seed run before that column exists fails with
  `Could not find the 'depends_on' column of 'tabDocField'`. With `supabase db
  push` this is automatic (filename order puts `…050000` before step 2); when
  applying migrations INDIVIDUALLY you must run the `depends_on` ALTER before the
  seed yourself.
- `resolveUserToCtx` (src/perms/identity.js) calls `store.get('tabUser', …)` on
  every authenticated request.  A route serving an authenticated request before
  step 2 completes will throw AuthError for every real user, resulting in
  401s across the board.
- The Has Role DocMeta must be seeded BEFORE the User DocMeta inside the seed
  script (Table-target closure — MetaLoader throws if the child doctype meta
  is not primed; see src/meta/loader.js:112).

---

## Direct-PG apply path (when the engine folder is NOT linked for `db push`)

The engine self-provisions over a direct Postgres connection (`DATABASE_URL` in
`.env`, Supabase Session pooler :5432) — the same path `Installer.migrate` uses.
Use it to apply a single migration file without `supabase link`:

```powershell
cd C:\Users\parrg\Documents\spartan-erp-engine
node --env-file=.env scripts/apply-migration.mjs supabase/migrations/<file>.sql
```

**Targets the engine's OWN isolated Supabase only** (whatever `DATABASE_URL`
points at) — NEVER the shared prod CRM project. Migrations are idempotent, so
re-running is safe. Because you apply files one at a time here, **respect the
filename order** — in particular apply `…050000_docfield_depends_on.sql` BEFORE
running `seed-user-meta.mjs` (see "Why this order is frozen" above).

This path does NOT write Supabase's `supabase_migrations` history; if you later
`supabase link` the folder, run `supabase migration repair --status applied
<version>` for each already-applied migration before the next `db push`.

PostgREST (supabase-js) caches the schema: after a direct-PG `ALTER`, Supabase
reloads the cache within a second or two. If a script fails immediately after an
ALTER with a `schema cache` message, wait ~10s and re-run (idempotent) — it is
cache lag, not a real error.

---

## Seed command (copy-paste)

```powershell
# Set your admin email, then run:
$env:BOOTSTRAP_ADMIN_EMAIL = "you@yourdomain.com"
node --env-file=.env scripts/seed-user-meta.mjs
```

The script is idempotent — re-running it on an already-seeded database is safe.
