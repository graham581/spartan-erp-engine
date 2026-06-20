// erpnext-to-def.js — Pure transform: ERPNext DocType JSON → engine def shape.
//
// D1-2 security boundary: depends_on / mandatory_depends_on are NEVER read and
// NEVER written. The whitelist below is exhaustive — no {…f} spread anywhere.
//
// Depends on U1: src/generator/fieldtype-map.js

import { mapFieldtype } from './fieldtype-map.js';

/**
 * Guard: true iff json is a real ERPNext DocType JSON (not a fixture, not a
 * module descriptor, not a DocField, etc.).
 *
 * @param {object} json
 * @returns {boolean}
 */
export function isRealDoctype(json) {
  return json.doctype === 'DocType';
}

/** fieldtypes that keep their options string (target doctype name / enum). */
const OPTIONS_KEEP = new Set(['Link', 'Table', 'Table MultiSelect', 'Select']);

/**
 * Map one ERPNext field object to a FieldDef, or return null for layout fields.
 *
 * EXPLICIT KEY-WHITELIST — object is built key-by-key. {…f} spread is forbidden.
 * Output carries ONLY: fieldname, fieldtype, reqd, readOnly, unique, permlevel,
 *                      options, fetchFrom, idx.
 * NEVER carries dependsOn / mandatoryDependsOn (D1-2 boundary — dropped by construction).
 *
 * @param {object} f  one ERPNext field object
 * @returns {{ fieldname:string, fieldtype:string, reqd?:boolean, readOnly?:boolean,
 *             unique?:boolean, permlevel?:number, options?:string,
 *             fetchFrom?:string, idx?:number } | null}
 */
export function mapField(f) {
  const classified = mapFieldtype(f.fieldtype);

  // Layout fields carry no data — skip entirely.
  if (classified.kind === 'layout') {
    return null;
  }

  // Resolved engine fieldtype (mapped or unsupported-demoted).
  const engineFieldtype = classified.fieldtype;

  // options: kept verbatim for Link/Table/Table MultiSelect/Select;
  //          STRIPPED (undefined) for Dynamic Link (D1-3);
  //          undefined for everything else.
  const options = OPTIONS_KEEP.has(f.fieldtype) ? f.options : undefined;

  // Build the FieldDef key-by-key — no spread.
  const def = {
    fieldname:  f.fieldname,
    fieldtype:  engineFieldtype,
    reqd:       !!f.reqd,
    readOnly:   !!f.read_only,
    unique:     !!f.unique,
    permlevel:  Number(f.permlevel ?? 0),
    options:    options,
    fetchFrom:  f.fetch_from,
    idx:        Number(f.idx ?? 0),
  };

  return def;
}

/**
 * Map one ERPNext permission object to the camel DocPerm shape installer.js reads.
 *
 * @param {object} p  ERPNext permission object
 * @returns {{ role:string, permlevel?:number, ifOwner?:boolean, read?:boolean,
 *             write?:boolean, create?:boolean, submit?:boolean, cancel?:boolean,
 *             delete?:boolean, idx?:number }}
 */
export function mapPermission(p) {
  return {
    role:       p.role,
    permlevel:  Number(p.permlevel ?? 0),
    ifOwner:    !!p.if_owner,
    read:       !!p.read,
    write:      !!p.write,
    create:     !!p.create,
    submit:     !!p.submit,
    cancel:     !!p.cancel,
    delete:     p.delete !== undefined ? !!p.delete : undefined,
    idx:        Number(p.idx ?? 0),
  };
}

/**
 * Synthesize a stub def from a doctype NAME alone (no source JSON).
 * table formula MUST equal loader.js:138 and erpnextJsonToDef: 'tab'+name.replace(/\s+/g,'').
 * @param {string} name  target doctype name (a LINK target only — never a Table child)
 * @returns {{ doctype:string, table:string, isStub:true, submittable:false, issingle:false,
 *             istable:false, fields:[], permissions:[], scopeFields:[] }}
 */
export function makeStubDef(name) {
  return {
    doctype:     name,
    table:       'tab' + name.replace(/\s+/g, ''),
    isStub:      true,
    submittable: false,
    issingle:    false,
    istable:     false,
    fields:      [],
    permissions: [],
    scopeFields: [],
  };
}

/**
 * Transform a parsed ERPNext DocType JSON into an engine def object that
 * installer.syncDoctype / assertValidDef accept.
 *
 * table formula: "tab" + name.replace(/\s+/g, "")   — must equal loader.js:136
 * scopeFields is always [] (seeded empty; CRM adds entries separately).
 * depends_on / mandatory_depends_on are never read (D1-2 security boundary).
 *
 * @param {object} json  a parsed ERPNext DocType JSON (json.doctype === 'DocType')
 * @returns {object} def
 */
export function erpnextJsonToDef(json) {
  const name = json.name;

  return {
    doctype:      name,
    table:        'tab' + name.replace(/\s+/g, ''),
    module:       json.module,
    submittable:  !!json.is_submittable,
    issingle:     !!json.issingle,
    istable:      !!json.istable,
    autoname:     json.autoname,
    naming_rule:  json.naming_rule,
    scopeFields:  [],
    fields:       (json.fields ?? []).map(mapField).filter(Boolean),
    permissions:  (json.permissions ?? []).map(mapPermission),
  };
}
