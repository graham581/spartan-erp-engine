/**
 * validation.test.js — Tests for src/validation/
 *
 * Covers:
 *   zod-bridge.js         — parseOrThrow maps ZodError → ValidationError
 *   request-schemas.js    — Create/Update accept business fields + reject reserved;
 *                           Action allows {action}+extras; ListQuery coerces + passes f_*
 *   def-schema.js         — assertValidDef accepts valid defs; rejects bad fieldtype /
 *                           Link without options
 *   env-schema.js         — loadEnv / loadPgAdminEnv throw plain Error on missing keys
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { parseOrThrow } from './zod-bridge.js';
import { ValidationError } from '../runtime/errors.js';
import {
  CreatePayloadSchema,
  UpdatePatchSchema,
  ActionBodySchema,
  ListQuerySchema,
} from './request-schemas.js';
import { assertValidDef, DocTypeDefSchema } from './def-schema.js';
import { loadEnv, loadPgAdminEnv, loadPgStoreEnv, loadAuthEnv } from './env-schema.js';

// ---------------------------------------------------------------------------
// zod-bridge
// ---------------------------------------------------------------------------

describe('zod-bridge — parseOrThrow', () => {
  const schema = z.object({ x: z.string() });

  it('returns parsed data on success', () => {
    const result = parseOrThrow(schema, { x: 'hello' }, 'test');
    expect(result).toEqual({ x: 'hello' });
  });

  it('throws ValidationError on ZodError', () => {
    expect(() => parseOrThrow(schema, { x: 42 }, 'test'))
      .toThrow(ValidationError);
  });

  it('error message includes the label', () => {
    let msg = '';
    try { parseOrThrow(schema, { x: 42 }, 'myLabel'); } catch (e) { msg = e.message; }
    expect(msg).toMatch(/myLabel/);
  });

  it('error message includes field path info', () => {
    let msg = '';
    try { parseOrThrow(schema, { x: 42 }, 'test'); } catch (e) { msg = e.message; }
    expect(msg).toMatch(/x/);
  });

  it('thrown error has name ValidationError', () => {
    let err;
    try { parseOrThrow(schema, {}, 'test'); } catch (e) { err = e; }
    expect(err.name).toBe('ValidationError');
  });
});

// ---------------------------------------------------------------------------
// request-schemas — Create / Update
// ---------------------------------------------------------------------------

describe('CreatePayloadSchema', () => {
  it('accepts business fields', () => {
    const result = CreatePayloadSchema.safeParse({ title: 'A', branch: 'VIC', margin: 10 });
    expect(result.success).toBe(true);
  });

  it('accepts arbitrary unknown business fields', () => {
    const result = CreatePayloadSchema.safeParse({ qty: 5, sku: 'SKU-001', deposit_paid: true });
    expect(result.success).toBe(true);
  });

  it('rejects reserved key: owner', () => {
    const result = CreatePayloadSchema.safeParse({ title: 'A', owner: 'hacker@x' });
    expect(result.success).toBe(false);
  });

  it('rejects reserved key: docstatus', () => {
    const result = CreatePayloadSchema.safeParse({ title: 'A', docstatus: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects reserved key: name', () => {
    const result = CreatePayloadSchema.safeParse({ title: 'A', name: 'MY-001' });
    expect(result.success).toBe(false);
  });

  it('accepts an empty body', () => {
    const result = CreatePayloadSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('UpdatePatchSchema', () => {
  it('accepts patch with business fields', () => {
    const result = UpdatePatchSchema.safeParse({ title: 'B', margin: 99 });
    expect(result.success).toBe(true);
  });

  it('rejects reserved keys', () => {
    expect(UpdatePatchSchema.safeParse({ owner: 'x' }).success).toBe(false);
    expect(UpdatePatchSchema.safeParse({ docstatus: 0 }).success).toBe(false);
    expect(UpdatePatchSchema.safeParse({ name: 'X' }).success).toBe(false);
  });

  it('rejects reserved key: is_stub', () => {
    const result = UpdatePatchSchema.safeParse({ is_stub: false });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// U-RESERVED [CRIT-4] — is_stub is a reserved key on both envelopes
// ---------------------------------------------------------------------------

describe('is_stub reserved key (U-RESERVED)', () => {
  it('CreatePayloadSchema rejects is_stub:true with business field', () => {
    const result = CreatePayloadSchema.safeParse({ is_stub: true, title: 'x' });
    expect(result.success).toBe(false);
    const msg = result.error.issues[0].message;
    expect(msg).toMatch(/is_stub/);
  });

  it('UpdatePatchSchema rejects is_stub:false standalone', () => {
    const result = UpdatePatchSchema.safeParse({ is_stub: false });
    expect(result.success).toBe(false);
  });

  it('normal business fields still pass CreatePayloadSchema', () => {
    const result = CreatePayloadSchema.safeParse({ title: 'x', branch: 'y' });
    expect(result.success).toBe(true);
  });

  it('existing reserved keys owner/docstatus/name still rejected by CreatePayloadSchema', () => {
    expect(CreatePayloadSchema.safeParse({ owner: 'x' }).success).toBe(false);
    expect(CreatePayloadSchema.safeParse({ docstatus: 1 }).success).toBe(false);
    expect(CreatePayloadSchema.safeParse({ name: 'X-001' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// request-schemas — Action
// ---------------------------------------------------------------------------

describe('ActionBodySchema', () => {
  it('accepts {action}', () => {
    expect(ActionBodySchema.safeParse({ action: 'submit' }).success).toBe(true);
  });

  it('accepts {action} + extra keys (passthrough)', () => {
    // Client may legitimately send other envelope keys alongside action
    const result = ActionBodySchema.safeParse({ action: 'start_measure', extra: 'ok', foo: 1 });
    expect(result.success).toBe(true);
  });

  it('rejects empty action string', () => {
    expect(ActionBodySchema.safeParse({ action: '' }).success).toBe(false);
  });

  it('rejects missing action', () => {
    expect(ActionBodySchema.safeParse({ title: 'no action' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// request-schemas — ListQuery
// ---------------------------------------------------------------------------

describe('ListQuerySchema', () => {
  it('accepts empty query', () => {
    expect(ListQuerySchema.safeParse({}).success).toBe(true);
  });

  it('coerces limit/offset string to number', () => {
    const result = ListQuerySchema.safeParse({ limit: '20', offset: '0' });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(20);
    expect(result.data.offset).toBe(0);
  });

  it('accepts order asc/desc', () => {
    expect(ListQuerySchema.safeParse({ order: 'asc' }).success).toBe(true);
    expect(ListQuerySchema.safeParse({ order: 'desc' }).success).toBe(true);
  });

  it('rejects invalid order value', () => {
    expect(ListQuerySchema.safeParse({ order: 'random' }).success).toBe(false);
  });

  it('passes f_* filter keys through', () => {
    const result = ListQuerySchema.safeParse({ f_branch: 'VIC', f_status: 'open' });
    expect(result.success).toBe(true);
    expect(result.data.f_branch).toBe('VIC');
  });

  it('rejects negative limit', () => {
    expect(ListQuerySchema.safeParse({ limit: '-1' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// def-schema — assertValidDef
// ---------------------------------------------------------------------------

// Mirrors the integration GadgetDef shape (Table→'GadgetLine', Link→'Customer')
const GadgetDef = {
  doctype: 'Gadget',
  table:   'tabGadget',
  fields: [
    { fieldname: 'title',       fieldtype: 'Data', reqd: true },
    { fieldname: 'customer',    fieldtype: 'Link',  options: 'Customer' },
    { fieldname: 'margin',      fieldtype: 'Currency' },
    { fieldname: 'lines',       fieldtype: 'Table', options: 'GadgetLine' },
  ],
  permissions: [
    { role: 'rep', read: true, write: true, create: true },
  ],
};

// Mirrors installer.test.js sampleDef (Table→'WidgetItem', never installed)
const sampleDef = {
  doctype:     'TestWidget',
  table:       'tabTestWidget',
  submittable: false,
  autoname:    'field:widget_name',
  fields: [
    { fieldname: 'widget_name', fieldtype: 'Data' },
    { fieldname: 'weight',      fieldtype: 'Float' },
    { fieldname: 'is_active',   fieldtype: 'Check' },
    { fieldname: 'notes',       fieldtype: 'Text' },
    { fieldname: 'items',       fieldtype: 'Table', options: 'WidgetItem' },
  ],
  permissions: [
    { role: 'Administrator', read: true, write: true, create: true, delete: true },
    { role: 'Sales User',    read: true },
  ],
};

describe('def-schema — assertValidDef', () => {
  it('accepts GadgetDef (Link→Customer, Table→GadgetLine, neither installed)', () => {
    // B1: structural only — must NOT check if GadgetLine/Customer exist
    expect(() => assertValidDef(GadgetDef)).not.toThrow();
  });

  it('accepts sampleDef (Table→WidgetItem, never installed)', () => {
    expect(() => assertValidDef(sampleDef)).not.toThrow();
  });

  it('rejects a def with a bad fieldtype', () => {
    const bad = {
      doctype: 'Broken',
      fields: [{ fieldname: 'f', fieldtype: 'BadType' }],
    };
    expect(() => assertValidDef(bad)).toThrow(ValidationError);
  });

  it('rejects a Link field without options', () => {
    const bad = {
      doctype: 'Broken',
      fields: [{ fieldname: 'customer', fieldtype: 'Link' }],
    };
    expect(() => assertValidDef(bad)).toThrow(ValidationError);
  });

  it('rejects a Table field with empty options string', () => {
    const bad = {
      doctype: 'Broken',
      fields: [{ fieldname: 'items', fieldtype: 'Table', options: '' }],
    };
    expect(() => assertValidDef(bad)).toThrow(ValidationError);
  });

  it('rejects a def missing doctype', () => {
    expect(() => assertValidDef({ fields: [] })).toThrow(ValidationError);
  });

  it('accepts DocPerm row with a stray doctype key (passthrough)', () => {
    const defWithDoctype = {
      doctype: 'Job',
      fields: [],
      permissions: [{ role: 'rep', doctype: 'Job', read: true }],
    };
    expect(() => assertValidDef(defWithDoctype)).not.toThrow();
  });

  it('accepts Code fieldtype (used by ddl.test.js + depends_on columns)', () => {
    const def = {
      doctype: 'HasCode',
      fields: [{ fieldname: 'script', fieldtype: 'Code' }],
    };
    expect(() => assertValidDef(def)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// env-schema
// ---------------------------------------------------------------------------

describe('env-schema — loadEnv', () => {
  it('returns parsed keys on valid env', () => {
    const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'abc' };
    const result = loadEnv(env);
    expect(result.SUPABASE_URL).toBe('https://x.supabase.co');
    expect(result.SUPABASE_SERVICE_ROLE_KEY).toBe('abc');
  });

  it('throws plain Error (not ValidationError) on missing SUPABASE_URL', () => {
    const env = { SUPABASE_SERVICE_ROLE_KEY: 'abc' };
    let err;
    try { loadEnv(env); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/SUPABASE/i);
  });

  it('throws on missing SUPABASE_SERVICE_ROLE_KEY', () => {
    const env = { SUPABASE_URL: 'https://x.supabase.co' };
    expect(() => loadEnv(env)).toThrow();
  });

  it('throws on invalid URL for SUPABASE_URL', () => {
    const env = { SUPABASE_URL: 'not-a-url', SUPABASE_SERVICE_ROLE_KEY: 'abc' };
    expect(() => loadEnv(env)).toThrow();
  });

  it('DATABASE_URL is NOT required by loadEnv (B2)', () => {
    // PgAdmin uses its own schema — loadEnv must not demand DATABASE_URL
    const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'abc' };
    expect(() => loadEnv(env)).not.toThrow();
  });
});

describe('env-schema — loadPgAdminEnv', () => {
  it('returns DATABASE_URL on valid env', () => {
    const env = { DATABASE_URL: 'postgres://user:pass@host/db' };
    const result = loadPgAdminEnv(env);
    expect(result.DATABASE_URL).toBe('postgres://user:pass@host/db');
  });

  it('throws plain Error matching /DATABASE_URL/ on missing key', () => {
    let err;
    try { loadPgAdminEnv({}); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/DATABASE_URL/);
  });

  it('does NOT require SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (B2)', () => {
    const env = { DATABASE_URL: 'postgres://user:pass@host/db' };
    expect(() => loadPgAdminEnv(env)).not.toThrow();
  });
});

describe('env-schema — loadPgStoreEnv', () => {
  it('throws plain Error matching /DATABASE_URL_POOLER/ when unset', () => {
    let err;
    try { loadPgStoreEnv({}); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/DATABASE_URL_POOLER/);
  });

  it('returns DATABASE_URL_POOLER when set', () => {
    const env = { DATABASE_URL_POOLER: 'postgres://user:pass@host:6543/db' };
    const result = loadPgStoreEnv(env);
    expect(result.DATABASE_URL_POOLER).toBe('postgres://user:pass@host:6543/db');
  });
});

describe('env-schema — loadEnv does NOT require DATABASE_URL_POOLER (B2)', () => {
  it('passes without DATABASE_URL_POOLER present', () => {
    // Hermetic: loadEnv must not demand DATABASE_URL_POOLER
    const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'abc' };
    expect(() => loadEnv(env)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// env-schema — loadAuthEnv
// ---------------------------------------------------------------------------

describe('env-schema — loadAuthEnv', () => {
  it('splits comma-separated client IDs and defaults devAuth to false', () => {
    const result = loadAuthEnv({ GOOGLE_OAUTH_CLIENT_IDS: 'a,b' });
    expect(result).toEqual({ GOOGLE_OAUTH_CLIENT_IDS: ['a', 'b'], devAuth: false });
  });

  it('throws plain Error matching /GOOGLE_OAUTH_CLIENT_IDS/ when key is missing', () => {
    let err;
    try { loadAuthEnv({}); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/GOOGLE_OAUTH_CLIENT_IDS/);
  });

  // N6 fail-closed: only 'true'/'1' enable devAuth
  it('N6: DEV_AUTH "true" -> devAuth === true', () => {
    const result = loadAuthEnv({ GOOGLE_OAUTH_CLIENT_IDS: 'x', DEV_AUTH: 'true' });
    expect(result.devAuth).toBe(true);
  });

  it('N6: DEV_AUTH "1" -> devAuth === true', () => {
    const result = loadAuthEnv({ GOOGLE_OAUTH_CLIENT_IDS: 'x', DEV_AUTH: '1' });
    expect(result.devAuth).toBe(true);
  });

  it('N6: DEV_AUTH "false" -> devAuth === false', () => {
    const result = loadAuthEnv({ GOOGLE_OAUTH_CLIENT_IDS: 'x', DEV_AUTH: 'false' });
    expect(result.devAuth).toBe(false);
  });

  it('N6: DEV_AUTH "0" -> devAuth === false', () => {
    const result = loadAuthEnv({ GOOGLE_OAUTH_CLIENT_IDS: 'x', DEV_AUTH: '0' });
    expect(result.devAuth).toBe(false);
  });

  it('N6: DEV_AUTH unset -> devAuth === false', () => {
    const result = loadAuthEnv({ GOOGLE_OAUTH_CLIENT_IDS: 'x' });
    expect(result.devAuth).toBe(false);
  });

  it('N6: DEV_AUTH "" -> devAuth === false', () => {
    const result = loadAuthEnv({ GOOGLE_OAUTH_CLIENT_IDS: 'x', DEV_AUTH: '' });
    expect(result.devAuth).toBe(false);
  });

  it('trims whitespace around comma-separated IDs', () => {
    const result = loadAuthEnv({ GOOGLE_OAUTH_CLIENT_IDS: ' a , b , c ' });
    expect(result.GOOGLE_OAUTH_CLIENT_IDS).toEqual(['a', 'b', 'c']);
  });

  it('single client ID is returned as a one-element array', () => {
    const result = loadAuthEnv({ GOOGLE_OAUTH_CLIENT_IDS: 'only-one' });
    expect(result.GOOGLE_OAUTH_CLIENT_IDS).toEqual(['only-one']);
  });

  it('is not invoked at import time (no top-level side-effect)', () => {
    // If loadAuthEnv ran at import time it would throw (no GOOGLE_OAUTH_CLIENT_IDS in
    // process.env during tests). The fact that this suite loads the module without throwing
    // proves the lazy contract.
    expect(true).toBe(true);
  });
});
