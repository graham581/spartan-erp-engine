// env-schema.js — Lazy env validation for startup boundaries.
//
// THREE SEPARATE schemas (B2 / ADR §1c):
//   EnvSchema         — SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (for SupabaseStore.fromEnv)
//   PgAdminEnvSchema  — DATABASE_URL only (for PgAdmin.fromEnv)
//   PgStoreEnvSchema  — DATABASE_URL_POOLER only (for PgStore.fromEnv, transaction pooler :6543)
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

// DATABASE_URL_POOLER is the transaction pooler (:6543) connection string (B2)
const PgStoreEnvSchema = z.object({
  DATABASE_URL_POOLER: z.string().min(1),
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

/**
 * Validate and return DATABASE_URL_POOLER for PgStore (transaction pooler :6543).
 * Throws a plain Error matching /DATABASE_URL_POOLER/ on missing/malformed key.
 *
 * @param {Record<string, string|undefined>} [env]  defaults to process.env
 * @returns {{ DATABASE_URL_POOLER: string }}
 */
export function loadPgStoreEnv(env = process.env) {
  const r = PgStoreEnvSchema.safeParse(env);
  if (!r.success) {
    throw new Error('PgStore: set DATABASE_URL_POOLER (Supabase transaction pooler connection string, port 6543)');
  }
  return r.data;
}

// AuthEnvSchema — Google OAuth client IDs + devAuth flag.
//   GOOGLE_OAUTH_CLIENT_IDS: comma-separated list of >=1 OAuth client ID strings.
//   DEV_AUTH_COERCED: pre-normalised to 'true'|'1'|undefined (N6 fail-closed).
const AuthEnvSchema = z.object({
  GOOGLE_OAUTH_CLIENT_IDS: z.string().min(1).transform(v => v.split(',').map(s => s.trim()).filter(Boolean)),
  DEV_AUTH_COERCED:        z.enum(['true', '1']).optional(),
});

/**
 * Validate and return Google auth env vars.
 * Throws a plain Error matching /GOOGLE_OAUTH_CLIENT_IDS/ on missing/empty client IDs.
 * DEV_AUTH is fail-closed: only 'true'/'1' enable it; anything else (unset, 'false', '0', '') -> false (N6).
 * LAZY: never called at import time.
 *
 * @param {Record<string, string|undefined>} [env]  defaults to process.env
 * @returns {{ GOOGLE_OAUTH_CLIENT_IDS: string[], devAuth: boolean }}
 */
export function loadAuthEnv(env = process.env) {
  // N6 fail-closed: normalise DEV_AUTH so only 'true'/'1' reach the enum validator;
  // 'false', '0', '', and anything else are treated as absent (undefined).
  const devAuthRaw = env.DEV_AUTH;
  const coerced = {
    GOOGLE_OAUTH_CLIENT_IDS: env.GOOGLE_OAUTH_CLIENT_IDS,
    DEV_AUTH_COERCED: (devAuthRaw === 'true' || devAuthRaw === '1') ? devAuthRaw : undefined,
  };
  const r = AuthEnvSchema.safeParse(coerced);
  if (!r.success) {
    throw new Error('Auth: set GOOGLE_OAUTH_CLIENT_IDS (comma-separated Google OAuth client ID strings)');
  }
  return {
    GOOGLE_OAUTH_CLIENT_IDS: r.data.GOOGLE_OAUTH_CLIENT_IDS,
    devAuth: r.data.DEV_AUTH_COERCED !== undefined,
  };
}
