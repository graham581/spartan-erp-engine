// request-schemas.js — Zod envelope schemas for API handler boundaries.
//
// LOCKED PRINCIPLE: these validate the ENVELOPE SHAPE only — not per-field
// business rules. Per-field truth stays in tabDocField / validateAgainstMeta.
//
// Strict/passthrough is pinned per schema (B4 / ADR §1a — no coin-flip):
//   Create/Update = z.record(...) + refinement rejecting owner/docstatus/name, NO .strict()
//   Action        = z.object({ action }).passthrough()   — must NOT be .strict()
//   ListQuery     = coercions + f_* passthrough

import { z } from 'zod';

// The three system-managed fields clients must never send
const RESERVED_KEYS = new Set(['owner', 'docstatus', 'name', 'is_stub']);

/**
 * Refinement that rejects a record if it contains any reserved system key.
 * All other keys — business fields (title, branch, margin, …) — pass freely.
 */
const rejectReservedKeys = (data, ctx) => {
  const found = Object.keys(data).filter(k => RESERVED_KEYS.has(k));
  if (found.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `reserved key(s) not allowed: ${found.join(', ')}`,
      path: [],
    });
  }
};

/**
 * POST /<doctype> body — any business field passes; only owner/docstatus/name rejected.
 */
export const CreatePayloadSchema = z.record(z.string(), z.unknown()).superRefine(rejectReservedKeys);

/**
 * POST /<doctype>/<name> body (no action) — same envelope as Create.
 */
export const UpdatePatchSchema = z.record(z.string(), z.unknown()).superRefine(rejectReservedKeys);

/**
 * POST /<doctype>/<name> with body.action present.
 * Must NOT be .strict() — client may send other envelope keys alongside action.
 * When action is present, handler ignores patch keys (submit/cancel take no patch).
 */
export const ActionBodySchema = z.object({
  action: z.string().min(1),
}).passthrough();

/**
 * GET /<doctype> query string.
 * limit/offset coerce to non-negative int; order ∈ asc|desc; order_by string;
 * f_* filter keys passthrough (record catches them).
 */
export const ListQuerySchema = z.object({
  limit:    z.coerce.number().int().nonnegative().optional(),
  offset:   z.coerce.number().int().nonnegative().optional(),
  order:    z.enum(['asc', 'desc']).optional(),
  order_by: z.string().optional(),
}).catchall(z.string());  // f_* and any other query params pass through
