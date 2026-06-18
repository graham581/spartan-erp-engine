/**
 * ERPNext fieldtype -> { Postgres column type, TypeScript type }.
 * This is the contract documented in diagrams/selling-slice-class.puml.
 */

/** Layout-only fieldtypes — no column, no TS field. */
export const LAYOUT_FIELDTYPES = new Set<string>([
  'Section Break',
  'Column Break',
  'Tab Break',
  'HTML',
  'Button',
  'Heading',
  'Fold',
]);

/** Relationship fieldtypes — become child tables, not columns. */
export const TABLE_FIELDTYPES = new Set<string>(['Table', 'Table MultiSelect']);

export interface TypeMapping {
  pg: string;
  ts: string;
}

/** Map a scalar (non-layout, non-table) fieldtype to pg + ts types. */
export function scalarType(fieldtype: string): TypeMapping {
  switch (fieldtype) {
    case 'Int':
      return { pg: 'integer', ts: 'number' };
    case 'Check':
      return { pg: 'boolean', ts: 'boolean' };
    case 'Currency':
    case 'Float':
    case 'Percent':
    case 'Duration':
      return { pg: 'numeric', ts: 'number' };
    case 'Date':
      return { pg: 'date', ts: 'string' };
    case 'Datetime':
      return { pg: 'timestamptz', ts: 'string' };
    case 'Time':
      return { pg: 'time', ts: 'string' };
    case 'JSON':
      return { pg: 'jsonb', ts: 'unknown' };
    // Data, Small Text, Text, Text Editor, Long Text, Code, Read Only,
    // Link, Dynamic Link, Select, Password, Attach, Attach Image, Image,
    // Barcode, Color, Signature, Autocomplete, Geolocation -> text
    default:
      return { pg: 'text', ts: 'string' };
  }
}
