/**
 * Unit tests for pickListColumns (pure, DOM-free).
 * DOM rendering verified by the manual live proof.
 */

import { describe, it, expect } from 'vitest';
import { pickListColumns } from './list-view.js';

describe('pickListColumns', () => {
  it('returns an empty array for empty fields', () => {
    expect(pickListColumns([])).toEqual([]);
  });

  it('returns an empty array for non-array input', () => {
    expect(pickListColumns(null)).toEqual([]);
    expect(pickListColumns(undefined)).toEqual([]);
  });

  it('excludes Table fieldtype entries', () => {
    const fields = [
      { fieldname: 'name', fieldtype: 'Data' },
      { fieldname: 'items', fieldtype: 'Table' },
      { fieldname: 'status', fieldtype: 'Select' },
    ];
    const result = pickListColumns(fields);
    expect(result.map((f) => f.fieldname)).toEqual(['name', 'status']);
  });

  it('returns at most 5 columns', () => {
    const fields = [
      { fieldname: 'a', fieldtype: 'Data' },
      { fieldname: 'b', fieldtype: 'Data' },
      { fieldname: 'c', fieldtype: 'Int' },
      { fieldname: 'd', fieldtype: 'Date' },
      { fieldname: 'e', fieldtype: 'Select' },
      { fieldname: 'f', fieldtype: 'Data' },
      { fieldname: 'g', fieldtype: 'Data' },
    ];
    const result = pickListColumns(fields);
    expect(result.length).toBe(5);
    expect(result.map((f) => f.fieldname)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('preserves idx order (array order)', () => {
    const fields = [
      { fieldname: 'z', fieldtype: 'Data' },
      { fieldname: 'a', fieldtype: 'Data' },
      { fieldname: 'm', fieldtype: 'Data' },
    ];
    const result = pickListColumns(fields);
    expect(result.map((f) => f.fieldname)).toEqual(['z', 'a', 'm']);
  });

  it('skips multiple Table entries and still caps at 5', () => {
    const fields = [
      { fieldname: 'f1', fieldtype: 'Data' },
      { fieldname: 't1', fieldtype: 'Table' },
      { fieldname: 'f2', fieldtype: 'Data' },
      { fieldname: 't2', fieldtype: 'Table' },
      { fieldname: 'f3', fieldtype: 'Data' },
      { fieldname: 'f4', fieldtype: 'Date' },
      { fieldname: 'f5', fieldtype: 'Int' },
      { fieldname: 'f6', fieldtype: 'Data' }, // would be 6th non-Table — excluded
    ];
    const result = pickListColumns(fields);
    expect(result.length).toBe(5);
    expect(result.every((f) => f.fieldtype !== 'Table')).toBe(true);
    expect(result.map((f) => f.fieldname)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
  });

  it('returns all fields when fewer than 5 non-Table exist', () => {
    const fields = [
      { fieldname: 'only', fieldtype: 'Data' },
      { fieldname: 'child', fieldtype: 'Table' },
    ];
    const result = pickListColumns(fields);
    expect(result.length).toBe(1);
    expect(result[0].fieldname).toBe('only');
  });
});
