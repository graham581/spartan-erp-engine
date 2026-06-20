// def-schema.js — Structural-only Zod schema for doctype definitions.
//
// LOCKED PRINCIPLE: structural validation ONLY.
//   - Link/Table require a non-empty options STRING (the target doctype name).
//   - Cross-doctype target EXISTENCE is NOT checked here — that is the loader's
//     N1 job (loader.js:112-118). assertValidDef sees only one def, has no
//     store/registry.
//   - DocPermDefSchema is .passthrough() — tolerate a stray `doctype` key
//     (some defs carry doctype inside each perm row, e.g. workflow.test.js:38-41).
//
// Fieldtype enum — SINGLE SOURCE (M1 / R1):
//   Derived from Object.keys(PG_TYPE_MAP) imported from ddl.js PLUS 'Table'.
//   ddl.js is the one source of the type map; def-schema.js must not duplicate it.
//   'Table' has no column (pgTypeFor returns undefined) but IS a valid fieldtype
//   for child-table links. 'Code' IS real (used at ddl.test.js:30).

import { z } from 'zod';
import { PG_TYPE_MAP } from '../meta/ddl.js';
import { parseOrThrow } from './zod-bridge.js';

// Derive enum from the single source — Object.keys(PG_TYPE_MAP) + 'Table'
// PG_TYPE_MAP has: Data, Text, Code, Select, Link, Int, Float, Currency, Check, Date, Datetime (11)
// Plus Table = 12 valid fieldtypes total
const FIELDTYPE_VALUES = /** @type {[string, ...string[]]} */ (
  [...Object.keys(PG_TYPE_MAP), 'Table']
);

const DocFieldDefSchema = z.object({
  fieldname:  z.string().min(1),
  fieldtype:  z.enum(FIELDTYPE_VALUES),
  reqd:       z.boolean().optional(),
  readOnly:   z.boolean().optional(),
  unique:     z.boolean().optional(),
  permlevel:  z.number().int().optional(),
  // options is a string or array of strings — Link/Table require a non-empty string
  options:    z.union([z.string(), z.array(z.string())]).optional(),
  fetchFrom:  z.string().optional(),
  idx:        z.number().int().optional(),
}).superRefine((field, ctx) => {
  // B1 structural cross-field refinement: Link and Table must have a non-empty options STRING
  if (field.fieldtype === 'Link' || field.fieldtype === 'Table') {
    if (typeof field.options !== 'string' || field.options.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field.fieldtype} field "${field.fieldname}" requires a non-empty options string (the target doctype name)`,
        path: ['options'],
      });
    }
  }
});

// DocPermDefSchema — .passthrough() to tolerate stray keys like `doctype`
const DocPermDefSchema = z.object({
  role:       z.string().min(1),
  permlevel:  z.number().int().optional(),
  ifOwner:    z.boolean().optional(),
  read:       z.boolean().optional(),
  write:      z.boolean().optional(),
  create:     z.boolean().optional(),
  submit:     z.boolean().optional(),
  cancel:     z.boolean().optional(),
  delete:     z.boolean().optional(),
}).passthrough();

const DocTypeDefSchema = z.object({
  doctype:      z.string().min(1),
  table:        z.string().optional(),
  fields:       z.array(DocFieldDefSchema),
  permissions:  z.array(DocPermDefSchema).optional(),
  submittable:  z.boolean().optional(),
  issingle:     z.boolean().optional(),
  istable:      z.boolean().optional(),
  autoname:     z.string().optional(),
  naming_rule:  z.string().optional(),
  module:       z.string().optional(),
  scopeFields:  z.array(z.string()).optional(),
});

export { DocTypeDefSchema, DocFieldDefSchema, DocPermDefSchema };

/**
 * Assert that a doctype definition is structurally valid.
 * Throws ValidationError (via zod-bridge) if validation fails.
 *
 * @param {unknown} def
 * @returns {void}
 */
export function assertValidDef(def) {
  parseOrThrow(DocTypeDefSchema, def, 'doctype definition');
}
