// env-schema.js — Lazy env validation for startup boundaries.
//
// TWO SEPARATE schemas (B2 / ADR §1c):
//   EnvSchema       — SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (for SupabaseStore.fromEnv)
//   PgAdminEnvSchema — DATABASE_URL only (for PgAdmin.fromEnv)
//
// Env failures are operator/startup errors, NOT request 400s.
// These functions throw a plain Error, never a ValidationError.
// They must stay LAZY (called inside fromEnv(), never at import time)
// so MemoryStore-only tests that never call fromEnv are unaffected.

import { z } from 'zod';

const EnvSchema = z.object({
  SUPABASE_URL:              z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

// DATABASE_URL is deliberately NOT in EnvSchema (B2)
const PgAdminEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

/**
 * Validate and return the Supabase env vars.
 * Throws a plain Error (not ValidationError) on missing/malformed keys.
 *
 * @param {Record<string, string|undefined>} [env]  defaults to process.env
 * @returns {{ SUPABASE_URL: string, SUPABASE_SERVICE_ROLE_KEY: string }}
 */
export function loadEnv(env = process.env) {
  const r = EnvSchema.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`SupabaseStore env: ${msg}`);
  }
  return r.data;
}

/**
 * Validate and return DATABASE_URL for PgAdmin.
 * Throws a plain Error matching /DATABASE_URL/ on missing/malformed key.
 *
 * @param {Record<string, string|undefined>} [env]  defaults to process.env
 * @returns {{ DATABASE_URL: string }}
 */
export function loadPgAdminEnv(env = process.env) {
  const r = PgAdminEnvSchema.safeParse(env);
  if (!r.success) {
    // Message must match /DATABASE_URL/ — pg-admin.test.js:21-27 asserts this
    throw new Error('PgAdmin: set DATABASE_URL (Supabase Postgres connection string WITH the DB password, session mode)');
  }
  return r.data;
}
