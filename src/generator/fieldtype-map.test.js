// fieldtype-map.test.js — U1 spec assertions (workorder §2-U1)
//
// Key assertions:
//   - every 'mapped' engine fieldtype ∈ [...Object.keys(PG_TYPE_MAP), 'Table']
//   - layout types → { kind: 'layout' }
//   - unsupported data types → { kind: 'unsupported', non-empty warn }
//   - an invented type throws

import { describe, it, expect } from 'vitest';
import { PG_TYPE_MAP } from '../meta/ddl.js';
import {
  LAYOUT_TYPES,
  ERP_TO_ENGINE,
  UNSUPPORTED_TO_TEXT,
  mapFieldtype,
} from './fieldtype-map.js';

const VALID_ENGINE_FIELDTYPES = new Set([...Object.keys(PG_TYPE_MAP), 'Table']);

// ── Bucket (ii): every ERP_TO_ENGINE value is a valid engine fieldtype ─────────

describe('ERP_TO_ENGINE — all mapped values are valid engine fieldtypes', () => {
  it('every value in ERP_TO_ENGINE is within PG_TYPE_MAP keys ∪ {Table}', () => {
    for (const [erp, engine] of Object.entries(ERP_TO_ENGINE)) {
      expect(
        VALID_ENGINE_FIELDTYPES.has(engine),
        `ERP_TO_ENGINE["${erp}"] = "${engine}" is not a valid engine fieldtype`,
      ).toBe(true);
    }
  });

  it('mapFieldtype returns mapped kind with a valid fieldtype for every ERP_TO_ENGINE key', () => {
    for (const erp of Object.keys(ERP_TO_ENGINE)) {
      const result = mapFieldtype(erp);
      expect(result.kind).toBe('mapped');
      expect(VALID_ENGINE_FIELDTYPES.has(result.fieldtype)).toBe(true);
    }
  });
});

// ── Bucket (i): layout types ────────────────────────────────────────────────────

describe('mapFieldtype — layout bucket (§2-U1 spec)', () => {
  const layoutCases = [
    'Section Break',
    'Column Break',
    'Tab Break',
    'HTML',
    'Button',
    'Fold',
    'Heading',
  ];

  it('LAYOUT_TYPES contains all 7 layout fieldtypes', () => {
    for (const t of layoutCases) {
      expect(LAYOUT_TYPES.has(t), `LAYOUT_TYPES missing "${t}"`).toBe(true);
    }
    expect(LAYOUT_TYPES.size).toBe(layoutCases.length);
  });

  for (const t of layoutCases) {
    it(`"${t}" → { kind: 'layout' }`, () => {
      expect(mapFieldtype(t)).toEqual({ kind: 'layout' });
    });
  }
});

// ── Bucket (iii): unsupported-data types ────────────────────────────────────────

describe('mapFieldtype — unsupported bucket (§2-U1 spec)', () => {
  const unsupportedCases = ['Time', 'Attach', 'Image', 'Dynamic Link'];

  for (const t of unsupportedCases) {
    it(`"${t}" → kind: 'unsupported' with a non-empty warn`, () => {
      const result = mapFieldtype(t);
      expect(result.kind).toBe('unsupported');
      expect(['Data', 'Text']).toContain(result.fieldtype);
      expect(typeof result.warn).toBe('string');
      expect(result.warn.length).toBeGreaterThan(0);
    });
  }

  it('every UNSUPPORTED_TO_TEXT value is "Data" or "Text"', () => {
    for (const [erp, fallback] of Object.entries(UNSUPPORTED_TO_TEXT)) {
      expect(
        ['Data', 'Text'].includes(fallback),
        `UNSUPPORTED_TO_TEXT["${erp}"] = "${fallback}" must be "Data" or "Text"`,
      ).toBe(true);
    }
  });
});

// ── Fail-fast: invented type throws ─────────────────────────────────────────────

describe('mapFieldtype — fail-fast (§2-U1 spec)', () => {
  it('throws Error("Unknown ERPNext fieldtype: …") for an invented type', () => {
    expect(() => mapFieldtype('InventedType_XYZ')).toThrow(
      'Unknown ERPNext fieldtype: InventedType_XYZ',
    );
  });

  it('throws for an empty string', () => {
    expect(() => mapFieldtype('')).toThrow('Unknown ERPNext fieldtype: ');
  });
});

// ── Specific mapping spot-checks ────────────────────────────────────────────────

describe('mapFieldtype — spot-checks for named ADR §1b mappings', () => {
  it('Percent → Float', () => {
    expect(mapFieldtype('Percent')).toEqual({ kind: 'mapped', fieldtype: 'Float' });
  });

  it('Read Only → Data', () => {
    expect(mapFieldtype('Read Only')).toEqual({ kind: 'mapped', fieldtype: 'Data' });
  });

  it('Small Text → Data', () => {
    expect(mapFieldtype('Small Text')).toEqual({ kind: 'mapped', fieldtype: 'Data' });
  });

  it('Text Editor → Text', () => {
    expect(mapFieldtype('Text Editor')).toEqual({ kind: 'mapped', fieldtype: 'Text' });
  });

  it('Code → Code', () => {
    expect(mapFieldtype('Code')).toEqual({ kind: 'mapped', fieldtype: 'Code' });
  });

  it('Markdown Editor → Text', () => {
    expect(mapFieldtype('Markdown Editor')).toEqual({ kind: 'mapped', fieldtype: 'Text' });
  });

  it('HTML Editor → Text', () => {
    expect(mapFieldtype('HTML Editor')).toEqual({ kind: 'mapped', fieldtype: 'Text' });
  });

  it('Table → Table', () => {
    expect(mapFieldtype('Table')).toEqual({ kind: 'mapped', fieldtype: 'Table' });
  });

  it('Table MultiSelect → Table', () => {
    expect(mapFieldtype('Table MultiSelect')).toEqual({ kind: 'mapped', fieldtype: 'Table' });
  });
});
