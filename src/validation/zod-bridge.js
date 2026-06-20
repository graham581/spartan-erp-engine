// zod-bridge.js — THE single ZodError → ValidationError mapping point.
// Every request/def boundary calls parseOrThrow; env does NOT use this bridge
// (env errors are plain Error, not ValidationError, so a bad config never
// masquerades as a client 400).

import { ValidationError } from '../runtime/errors.js';

/**
 * Flatten a ZodError into a single readable message.
 * Produces lines like: field "x": expected string, received number
 *
 * @param {import('zod').ZodError} zodError
 * @returns {string}
 */
function flatten(zodError) {
  return zodError.issues
    .map(issue => {
      const path = issue.path.length ? `field "${issue.path.join('.')}"` : 'value';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Parse value against schema; on failure, throw a ValidationError (→ 400).
 *
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} value
 * @param {string} [label]   — identifies the boundary in the error message
 * @returns {T}
 */
export function parseOrThrow(schema, value, label = 'input') {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ValidationError(`${label}: ${flatten(r.error)}`);
  }
  return r.data;
}
