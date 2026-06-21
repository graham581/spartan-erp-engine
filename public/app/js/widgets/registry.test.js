// U4 unit tests — pure logic only (node env, no DOM).
// Covers widgetFor (DC1) and normalizeSelectOptions (DC2).
// DOM create() output is verified by the live proof, not here.

import { describe, it, expect } from 'vitest';
import { widgetFor, normalizeSelectOptions, WidgetRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// widgetFor — every fieldtype row + unknown fallback (DC1)
// ---------------------------------------------------------------------------
describe('widgetFor', () => {
  const cases = [
    // text
    ['Data',     'data'],
    ['Text',     'textarea'],
    ['Code',     'textarea'],
    // numeric
    ['Int',      'number'],
    ['Float',    'number'],
    ['Currency', 'number'],
    // boolean
    ['Check',    'check'],
    // date/time
    ['Date',     'date'],
    ['Datetime', 'datetime'],
    // choice
    ['Select',   'select'],
    // reference / child
    ['Link',     'link'],
    ['Table',    'table'],
  ];

  it.each(cases)('fieldtype %s → key %s', (fieldtype, expected) => {
    expect(widgetFor({ fieldtype })).toBe(expected);
  });

  it('unknown fieldtype → data (fail-soft fallback)', () => {
    expect(widgetFor({ fieldtype: 'SomeFutureType' })).toBe('data');
    expect(widgetFor({ fieldtype: '' })).toBe('data');
    expect(widgetFor({ fieldtype: undefined })).toBe('data');
  });
});

// ---------------------------------------------------------------------------
// normalizeSelectOptions — array + '\n'-string + blank-trim (DC2)
// ---------------------------------------------------------------------------
describe('normalizeSelectOptions', () => {
  it('passes an array through, trimming blanks', () => {
    expect(normalizeSelectOptions(['A', 'B'])).toEqual(['A', 'B']);
  });

  it('trims whitespace from array entries', () => {
    expect(normalizeSelectOptions(['  A  ', ' B'])).toEqual(['A', 'B']);
  });

  it('removes blank array entries', () => {
    expect(normalizeSelectOptions(['A', '', 'B', '  '])).toEqual(['A', 'B']);
  });

  it('splits a newline-delimited string into array', () => {
    expect(normalizeSelectOptions('A\nB')).toEqual(['A', 'B']);
  });

  it('trims whitespace from string segments', () => {
    expect(normalizeSelectOptions('  A  \n  B  ')).toEqual(['A', 'B']);
  });

  it('removes blank string segments', () => {
    expect(normalizeSelectOptions('A\n\nB\n  ')).toEqual(['A', 'B']);
  });

  it('handles an empty string → empty array', () => {
    expect(normalizeSelectOptions('')).toEqual([]);
  });

  it('handles an empty array → empty array', () => {
    expect(normalizeSelectOptions([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WidgetRegistry.has / register — keys present + deferred keys absent until registered
// ---------------------------------------------------------------------------
describe('WidgetRegistry', () => {
  it('has all simple widget keys registered', () => {
    for (const key of ['data', 'textarea', 'number', 'check', 'date', 'datetime', 'select']) {
      expect(WidgetRegistry.has(key)).toBe(true);
    }
  });

  it('does NOT have link or table registered before U9 registers them', () => {
    // Fresh module state: link and table are not pre-registered by U4.
    // (If another test in this file calls register first this check would fail —
    //  but we don't, so this documents the OCP contract.)
    expect(WidgetRegistry.has('link')).toBe(false);
    expect(WidgetRegistry.has('table')).toBe(false);
  });

  it('register adds a key and has() returns true after', () => {
    const stub = () => {};
    WidgetRegistry.register('link', stub);
    expect(WidgetRegistry.has('link')).toBe(true);
  });
});
