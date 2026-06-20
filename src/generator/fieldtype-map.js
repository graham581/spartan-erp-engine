// fieldtype-map.js — 3-bucket ERPNext fieldtype classification (ADR §1b).
//
// Bucket (i)  LAYOUT_TYPES   → { kind: 'layout' }         (no column, skip)
// Bucket (ii) ERP_TO_ENGINE  → { kind: 'mapped', fieldtype } (engine fieldtype ∈ PG_TYPE_MAP ∪ {Table})
// Bucket (iii) UNSUPPORTED_TO_TEXT → { kind: 'unsupported', fieldtype: 'Data'|'Text', warn }
//
// Anything in none of the 3 buckets → throws (fail-fast).

// TODO(PG_TYPE_MAP): add Time->time, then move Time to ERP_TO_ENGINE
// (critique #5 — do NOT add Time→time in this pass; Time rides unsupported→text+warn)

/** Layout / structural-only ERPNext fieldtypes — carry no data; no column emitted. */
export const LAYOUT_TYPES = new Set([
  'Section Break',
  'Column Break',
  'Tab Break',
  'HTML',
  'Button',
  'Fold',
  'Heading',
]);

/**
 * Supported ERPNext fieldtype → engine fieldtype mapping (ADR §1b table (ii)).
 * Engine fieldtype must be ∈ Object.keys(PG_TYPE_MAP) ∪ {'Table'}.
 *
 * @type {Record<string,string>}
 */
export const ERP_TO_ENGINE = {
  // Data-like
  'Data':               'Data',
  'Small Text':         'Data',
  'Read Only':          'Data',

  // Text-like
  'Text':               'Text',
  'Text Editor':        'Text',
  'Markdown Editor':    'Text',
  'HTML Editor':        'Text',

  // Code gets its own engine fieldtype
  'Code':               'Code',

  // Enumerated / reference
  'Select':             'Select',
  'Link':               'Link',

  // Numeric
  'Int':                'Int',
  'Float':              'Float',
  'Percent':            'Float',    // ADR §1b: Percent → Float
  'Currency':           'Currency',

  // Boolean
  'Check':              'Check',

  // Temporal
  'Date':               'Date',
  'Datetime':           'Datetime',

  // Child table
  'Table':              'Table',
  'Table MultiSelect':  'Table',    // ADR §1b: Table MultiSelect → Table
};

/**
 * ERPNext data-bearing types with no direct PG equivalent — demoted to Data/Text with a
 * non-empty warning (ADR §1b table (iii)).
 *
 * @type {Record<string,'Data'|'Text'>}
 */
export const UNSUPPORTED_TO_TEXT = {
  'Time':          'Data',
  'Duration':      'Data',
  'Dynamic Link':  'Data',   // options MUST be stripped by U2 (mapField); not done here
  'Attach':        'Data',
  'Attach Image':  'Data',
  'Image':         'Data',
  'Signature':     'Data',
  'Color':         'Data',
  'Rating':        'Data',
  'Geolocation':   'Text',   // may be large (JSON blob) → Text
  'JSON':          'Text',
  'Barcode':       'Data',
  'Password':      'Data',
  'Phone':         'Data',
  'Long Text':     'Text',
};

/**
 * Classify one ERPNext fieldtype into one of three buckets.
 *
 * @param {string} erpFieldtype
 * @returns {{ kind: 'layout' }
 *          | { kind: 'mapped', fieldtype: string }
 *          | { kind: 'unsupported', fieldtype: 'Data'|'Text', warn: string }}
 * @throws {Error} for a fieldtype in none of the 3 buckets (fail-fast).
 */
export function mapFieldtype(erpFieldtype) {
  if (LAYOUT_TYPES.has(erpFieldtype)) {
    return { kind: 'layout' };
  }

  const engineFieldtype = ERP_TO_ENGINE[erpFieldtype];
  if (engineFieldtype !== undefined) {
    return { kind: 'mapped', fieldtype: engineFieldtype };
  }

  const textFallback = UNSUPPORTED_TO_TEXT[erpFieldtype];
  if (textFallback !== undefined) {
    return {
      kind:     'unsupported',
      fieldtype: textFallback,
      warn:     `ERPNext fieldtype "${erpFieldtype}" has no native PG equivalent — demoted to "${textFallback}". Add a PG_TYPE_MAP entry to promote it.`,
    };
  }

  throw new Error(`Unknown ERPNext fieldtype: ${erpFieldtype}`);
}
