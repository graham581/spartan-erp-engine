import { describe, it, expect } from 'vitest';
import { evalCondition, isRelevant } from './depends-on.js';

// ---------------------------------------------------------------------------
// isRelevant — undefined cond
// ---------------------------------------------------------------------------
describe('isRelevant — undefined condition', () => {
  it('returns true when cond is undefined', () => {
    expect(isRelevant(undefined, {})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Leaf ops — happy paths
// ---------------------------------------------------------------------------
describe('evalCondition — leaf ops (happy paths)', () => {
  const doc = { active: true, count: 5, code: 0, tag: 'vip', score: 10, name: 'Alice', empty: '' };

  it('eq — string match', () => {
    expect(evalCondition({ field: 'name', op: 'eq', value: 'Alice' }, doc)).toBe(true);
    expect(evalCondition({ field: 'name', op: 'eq', value: 'Bob' }, doc)).toBe(false);
  });

  it('neq — string mismatch', () => {
    expect(evalCondition({ field: 'name', op: 'neq', value: 'Bob' }, doc)).toBe(true);
    expect(evalCondition({ field: 'name', op: 'neq', value: 'Alice' }, doc)).toBe(false);
  });

  it('in — value present in list', () => {
    expect(evalCondition({ field: 'tag', op: 'in', value: ['vip', 'pro'] }, doc)).toBe(true);
    expect(evalCondition({ field: 'tag', op: 'in', value: ['basic'] }, doc)).toBe(false);
  });

  it('nin — value absent from list', () => {
    expect(evalCondition({ field: 'tag', op: 'nin', value: ['basic'] }, doc)).toBe(true);
    expect(evalCondition({ field: 'tag', op: 'nin', value: ['vip'] }, doc)).toBe(false);
  });

  it('gt / gte / lt / lte', () => {
    expect(evalCondition({ field: 'count', op: 'gt', value: 4 }, doc)).toBe(true);
    expect(evalCondition({ field: 'count', op: 'gt', value: 5 }, doc)).toBe(false);
    expect(evalCondition({ field: 'count', op: 'gte', value: 5 }, doc)).toBe(true);
    expect(evalCondition({ field: 'count', op: 'lt', value: 6 }, doc)).toBe(true);
    expect(evalCondition({ field: 'count', op: 'lt', value: 5 }, doc)).toBe(false);
    expect(evalCondition({ field: 'count', op: 'lte', value: 5 }, doc)).toBe(true);
  });

  it('truthy — boolean true', () => {
    expect(evalCondition({ field: 'active', op: 'truthy' }, doc)).toBe(true);
  });

  it('falsy — integer 0 (Check field)', () => {
    expect(evalCondition({ field: 'code', op: 'falsy' }, doc)).toBe(true);
    expect(evalCondition({ field: 'active', op: 'falsy' }, doc)).toBe(false);
  });

  it('set — non-empty value', () => {
    expect(evalCondition({ field: 'name', op: 'set' }, doc)).toBe(true);
    expect(evalCondition({ field: 'empty', op: 'set' }, doc)).toBe(false);
  });

  it('notset — empty/null/undefined value', () => {
    expect(evalCondition({ field: 'empty', op: 'notset' }, doc)).toBe(true);
    expect(evalCondition({ field: 'name', op: 'notset' }, doc)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compound ops — all / any / not
// ---------------------------------------------------------------------------
describe('evalCondition — compound all/any/not', () => {
  const doc = { x: 5, y: 'yes' };

  it('{all:[]} → true (vacuous)', () => {
    expect(evalCondition({ all: [] }, doc)).toBe(true);
  });

  it('{any:[]} → false (vacuous)', () => {
    expect(evalCondition({ any: [] }, doc)).toBe(false);
  });

  it('all — all must be true', () => {
    expect(evalCondition({ all: [
      { field: 'x', op: 'gt', value: 4 },
      { field: 'y', op: 'eq', value: 'yes' },
    ] }, doc)).toBe(true);

    expect(evalCondition({ all: [
      { field: 'x', op: 'gt', value: 4 },
      { field: 'y', op: 'eq', value: 'no' },
    ] }, doc)).toBe(false);
  });

  it('any — at least one true', () => {
    expect(evalCondition({ any: [
      { field: 'x', op: 'eq', value: 99 },
      { field: 'y', op: 'eq', value: 'yes' },
    ] }, doc)).toBe(true);

    expect(evalCondition({ any: [
      { field: 'x', op: 'eq', value: 99 },
      { field: 'y', op: 'eq', value: 'no' },
    ] }, doc)).toBe(false);
  });

  it('not — negates inner', () => {
    expect(evalCondition({ not: { field: 'x', op: 'eq', value: 99 } }, doc)).toBe(true);
    expect(evalCondition({ not: { field: 'x', op: 'eq', value: 5 } }, doc)).toBe(false);
  });

  it('nested: not(all[...])', () => {
    expect(evalCondition({
      not: { all: [
        { field: 'x', op: 'gt', value: 4 },
        { field: 'y', op: 'eq', value: 'yes' },
      ] }
    }, doc)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Missing field — no throw + fail-closed rules
// ---------------------------------------------------------------------------
describe('evalCondition — missing field (C-D3-2)', () => {
  const doc = {}; // no fields at all

  it('set → false (fail-closed)', () => {
    expect(evalCondition({ field: 'x', op: 'set' }, doc)).toBe(false);
  });

  it('truthy → false (fail-closed)', () => {
    expect(evalCondition({ field: 'x', op: 'truthy' }, doc)).toBe(false);
  });

  it('notset → true (fail-closed)', () => {
    expect(evalCondition({ field: 'x', op: 'notset' }, doc)).toBe(true);
  });

  it('falsy → true (fail-closed)', () => {
    expect(evalCondition({ field: 'x', op: 'falsy' }, doc)).toBe(true);
  });

  it('eq → false (fail-closed)', () => {
    expect(evalCondition({ field: 'x', op: 'eq', value: 'anything' }, doc)).toBe(false);
  });

  it('gt → false (fail-closed)', () => {
    expect(evalCondition({ field: 'x', op: 'gt', value: 0 }, doc)).toBe(false);
  });

  it('gte → false (fail-closed)', () => {
    expect(evalCondition({ field: 'x', op: 'gte', value: 0 }, doc)).toBe(false);
  });

  it('lt → false (fail-closed)', () => {
    expect(evalCondition({ field: 'x', op: 'lt', value: 100 }, doc)).toBe(false);
  });

  it('lte → false (fail-closed)', () => {
    expect(evalCondition({ field: 'x', op: 'lte', value: 100 }, doc)).toBe(false);
  });

  it('does NOT throw for any standard op', () => {
    const ops = ['eq','neq','gt','gte','lt','lte','truthy','falsy','set','notset'];
    for (const op of ops) {
      const v = (op === 'in' || op === 'nin') ? [] : 'x';
      expect(() => evalCondition({ field: 'missing', op, value: v }, doc)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Error cases — authoring bugs + depth cap
// ---------------------------------------------------------------------------
describe('evalCondition — error cases', () => {
  it('in non-array value → throws', () => {
    expect(() =>
      evalCondition({ field: 'x', op: 'in', value: 'not-an-array' }, { x: 1 })
    ).toThrow(/authoring bug/);
  });

  it('nin non-array value → throws', () => {
    expect(() =>
      evalCondition({ field: 'x', op: 'nin', value: 42 }, { x: 1 })
    ).toThrow(/authoring bug/);
  });

  it('unknown op → throws (closed table)', () => {
    expect(() =>
      evalCondition({ field: 'x', op: 'contains', value: 'foo' }, { x: 'foobar' })
    ).toThrow(/unknown op/);
  });

  it('unknown op does NOT silently return true', () => {
    try {
      evalCondition({ field: 'x', op: 'superPower', value: 1 }, { x: 1 });
      // If no throw, this test must fail explicitly.
      expect(true).toBe(false); // unreachable
    } catch (e) {
      expect(e.message).toMatch(/unknown op/);
    }
  });

  it('depth > 32 → throws RangeError', () => {
    // Build a deeply nested {not:{not:{not:...}}} that exceeds 32 levels.
    let cond = { field: 'x', op: 'eq', value: 1 };
    for (let i = 0; i < 34; i++) cond = { not: cond };
    expect(() => evalCondition(cond, { x: 1 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Check coercion — eq with boolean/0/1 agrees with truthy/falsy
// ---------------------------------------------------------------------------
describe('evalCondition — Check coercion (eq agrees with truthy)', () => {
  it('{op:"eq",value:true} agrees with {op:"truthy"} when doc.x===1', () => {
    const doc = { x: 1 };
    const byEq = evalCondition({ field: 'x', op: 'eq', value: true }, doc);
    const byTruthy = evalCondition({ field: 'x', op: 'truthy' }, doc);
    expect(byEq).toBe(byTruthy);
    expect(byEq).toBe(true);
  });

  it('{op:"eq",value:false} agrees with {op:"falsy"} when doc.x===0', () => {
    const doc = { x: 0 };
    const byEq = evalCondition({ field: 'x', op: 'eq', value: false }, doc);
    const byFalsy = evalCondition({ field: 'x', op: 'falsy' }, doc);
    expect(byEq).toBe(byFalsy);
    expect(byEq).toBe(true);
  });

  it('{op:"eq",value:true} vs doc.x===false → false', () => {
    const doc = { x: false };
    expect(evalCondition({ field: 'x', op: 'eq', value: true }, doc)).toBe(false);
  });

  it('{op:"neq",value:true} when doc.x===0 → true (0 coerces to false, neq true)', () => {
    const doc = { x: 0 };
    expect(evalCondition({ field: 'x', op: 'neq', value: true }, doc)).toBe(true);
  });
});
