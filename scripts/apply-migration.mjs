// Apply ONE SQL migration file to the engine DB via the direct-PG (PgAdmin) path.
//
//   node --env-file=.env scripts/apply-migration.mjs supabase/migrations/<file>.sql
//
// Uses DATABASE_URL from .env (Supabase Session pooler, port 5432, WITH the DB password).
// This is the engine's OWN isolated Supabase project — NEVER the shared prod CRM project.
// Migrations are idempotent (IF NOT EXISTS), so re-running is safe. Note: this path does
// NOT write Supabase's migration history; see supabase/MIGRATION_RUNBOOK.md for the
// `supabase migration repair --status applied <version>` reconciliation if you later link.
import { readFile } from 'node:fs/promises';
import { PgAdmin } from '../src/meta/pg-admin.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node --env-file=.env scripts/apply-migration.mjs <path-to-migration.sql>');
  process.exit(1);
}

const sql = await readFile(file, 'utf8');
await PgAdmin.fromEnv().applyDDL(sql);
console.log(`OK: applied ${file}`);
