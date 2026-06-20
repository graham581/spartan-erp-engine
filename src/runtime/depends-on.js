// depends-on.js — NO-EVAL condition evaluator for ERPNext-style dependsOn / mandatoryDependsOn.
//
// SECURITY CONTRACT (ADR §3, frozen):
//   - NO eval(), NO new Function(), NO dynamic dispatch on attacker data.
//   - Reads ONLY doc[cond.field] — no nested paths, no method calls, no globals.
//   - Unknown op → THROW (closed operator table; nothing falls through to true).
//   - Recursion depth capped at 32 → THROW.

const MAX_DEPTH = 32;

/**
 * Coerce a doc field value the same way validate.js:31 does for Check fields:
 * 0 and false are falsy; 1 and true are truthy. Used so eq/neq comparisons
 * against boolean literals agree with the truthy/falsy ops.
 *
 * @param {*} v
 * @returns {boolean}
 */
function toBoolean(v) {
  return v === true || v === 1;
}

/**
 * Evaluate a single leaf condition `{ field, op, value? }` against doc.
 * Missing field (doc[field] === undefined) never throws — see fail-closed rules below.
 *
 * @param {{ field: string, op: string, value?: * }} cond
 * @param {Record<string, *>} doc
 * @returns {boolean}
 */
function evalLeaf(cond, doc) {
  const { field, op, value } = cond;
  const raw = doc[field]; // undefined when field absent — no throw (C-D3-2)

  // Validate authoring constraints up front.
  if ((op === 'in' || op === 'nin') && !Array.isArray(value)) {
    throw new TypeError(`depends-on: op '${op}' requires an array value (authoring bug)`);
  }

  switch (op) {
    case 'truthy':
      // Missing field: raw===undefined → toBoolean(undefined)===false → correct fail-closed.
      return toBoolean(raw);

    case 'falsy':
      // Missing field: raw===undefined → !toBoolean(undefined)===true → correct fail-closed.
      return !toBoolean(raw);

    case 'set':
      // Missing field → false (fail-closed).
      return raw !== undefined && raw !== null && raw !== '';

    case 'notset':
      // Missing field → true (fail-closed).
      return raw === undefined || raw === null || raw === '';

    case 'eq':
      // Missing field: raw===undefined → compare fails → false (fail-closed).
      // Check coercion: compare booleans after toBoolean when either side is boolean/0/1.
      if (typeof value === 'boolean' || value === 0 || value === 1) {
        return toBoolean(raw) === toBoolean(value);
      }
      return raw === value;

    case 'neq':
      if (typeof value === 'boolean' || value === 0 || value === 1) {
        return toBoolean(raw) !== toBoolean(value);
      }
      return raw !== value;

    case 'in':
      // Array-ness already asserted above. Missing field → raw===undefined → not in list → false.
      return value.includes(raw);

    case 'nin':
      return !value.includes(raw);

    case 'gt':
      // Missing field: undefined > value → false (fail-closed).
      return raw !== undefined && raw > value;

    case 'gte':
      return raw !== undefined && raw >= value;

    case 'lt':
      return raw !== undefined && raw < value;

    case 'lte':
      return raw !== undefined && raw <= value;

    default:
      throw new TypeError(`depends-on: unknown op '${op}' (closed operator table)`);
  }
}

/**
 * Evaluate a condition expression against a document.
 *
 * Condition forms:
 *   { field, op, value? }       — leaf
 *   { all: Condition[] }        — conjunction; empty → true
 *   { any: Condition[] }        — disjunction; empty → false
 *   { not: Condition }          — negation
 *
 * @param {object} cond
 * @param {Record<string, *>} doc
 * @param {number} [depth=0]  — internal recursion guard; callers pass 0 (default)
 * @returns {boolean}
 */
export function evalCondition(cond, doc, depth = 0) {
  if (depth > MAX_DEPTH) {
    throw new RangeError(`depends-on: condition tree exceeds max depth (${MAX_DEPTH})`);
  }

  if ('all' in cond) {
    // Vacuous truth: {all:[]} → true.
    return cond.all.every((c) => evalCondition(c, doc, depth + 1));
  }

  if ('any' in cond) {
    // Vacuous falsity: {any:[]} → false.
    return cond.any.some((c) => evalCondition(c, doc, depth + 1));
  }

  if ('not' in cond) {
    return !evalCondition(cond.not, doc, depth + 1);
  }

  // Leaf condition — must have `field` and `op`.
  return evalLeaf(cond, doc);
}

/**
 * Convenience wrapper: `undefined` condition → always relevant (true).
 * All other conditions are forwarded to `evalCondition`.
 *
 * @param {object|undefined} cond
 * @param {Record<string, *>} doc
 * @returns {boolean}
 */
export function isRelevant(cond, doc) {
  if (cond === undefined) return true;
  return evalCondition(cond, doc, 0);
}
