/**
 * boot-meta.js — the pinned cold-boot seed for the 6 meta-doctypes.
 *
 * These hand-written DocMeta definitions describe the tables that hold all
 * other metadata (tabDocType, tabDocField, tabDocPerm, tabRole, tabWorkflow,
 * tabWorkflowTransition). They are the permanent cold-boot key: primed once
 * at module load via registerBootMeta(), never evicted by invalidate(), never
 * read from tabDocType itself (that would be circular — a Meta that needs its
 * own meta to be described is a deadlock).
 *
 * Field names match the snake_case DB columns from the base migration
 * (supabase/migrations/<ts>_meta_doctypes.sql) AND Frappe's canonical
 * fieldnames (verified via frappe/core/doctype/{doctype,docfield,docperm,role}
 * DocType JSON on 2026-06-20).
 *
 * DO NOT add logic here — this is pure data.
 */

import { primeFrom } from './registry.js';

/** @type {import('./registry.js').DocMeta[]} */
export const META_DOCTYPES = [
  // ------------------------------------------------------------------
  // DocType — describes other doctypes; children: fields + permissions
  // ------------------------------------------------------------------
  {
    doctype: 'DocType',
    table: 'tabDocType',
    submittable: false,
    autoname: undefined,
    fields: [
      { fieldname: 'name',           fieldtype: 'Data' },
      { fieldname: 'istable',        fieldtype: 'Check' },
      { fieldname: 'issingle',       fieldtype: 'Check' },
      { fieldname: 'is_submittable', fieldtype: 'Check' },
      { fieldname: 'autoname',       fieldtype: 'Data' },
      { fieldname: 'naming_rule',    fieldtype: 'Data' },
      { fieldname: 'module',         fieldtype: 'Data' },
      { fieldname: 'scope_fields',   fieldtype: 'Data' },  // text[] stored as jsonb/text[]
      // child-table pointer fields
      { fieldname: 'fields',         fieldtype: 'Table', options: 'DocField' },
      { fieldname: 'permissions',    fieldtype: 'Table', options: 'DocPerm' },
    ],
    childTables: [
      { field: 'fields',       doctype: 'DocField', table: 'tabDocField' },
      { field: 'permissions',  doctype: 'DocPerm',  table: 'tabDocPerm'  },
    ],
    scopeFields:  [],
    permissions:  [],
  },

  // ------------------------------------------------------------------
  // DocField — child table of DocType; describes a single field column
  // ------------------------------------------------------------------
  {
    doctype: 'DocField',
    table: 'tabDocField',
    submittable: false,
    autoname: 'hash',
    fields: [
      { fieldname: 'name',        fieldtype: 'Data' },
      { fieldname: 'parent',      fieldtype: 'Link', options: 'DocType' },
      { fieldname: 'parenttype',  fieldtype: 'Data' },
      { fieldname: 'parentfield', fieldtype: 'Data' },
      { fieldname: 'fieldname',   fieldtype: 'Data' },
      { fieldname: 'fieldtype',   fieldtype: 'Data' },
      { fieldname: 'reqd',        fieldtype: 'Check' },
      { fieldname: 'options',     fieldtype: 'Text' },
      { fieldname: 'permlevel',   fieldtype: 'Int' },
      { fieldname: 'read_only',   fieldtype: 'Check' },
      { fieldname: 'unique',      fieldtype: 'Check' },
      { fieldname: 'fetch_from',  fieldtype: 'Data' },
      { fieldname: 'idx',         fieldtype: 'Int' },
      { fieldname: 'depends_on',           fieldtype: 'Code' },
      { fieldname: 'mandatory_depends_on', fieldtype: 'Code' },
    ],
    childTables: [],
    scopeFields:  [],
    permissions:  [],
  },

  // ------------------------------------------------------------------
  // DocPerm — child table of DocType; one permission row per role
  // ------------------------------------------------------------------
  {
    doctype: 'DocPerm',
    table: 'tabDocPerm',
    submittable: false,
    autoname: 'hash',
    fields: [
      { fieldname: 'name',        fieldtype: 'Data' },
      { fieldname: 'parent',      fieldtype: 'Link', options: 'DocType' },
      { fieldname: 'parenttype',  fieldtype: 'Data' },
      { fieldname: 'parentfield', fieldtype: 'Data' },
      { fieldname: 'role',        fieldtype: 'Link', options: 'Role' },
      { fieldname: 'permlevel',   fieldtype: 'Int' },
      { fieldname: 'if_owner',    fieldtype: 'Check' },
      { fieldname: 'read',        fieldtype: 'Check' },
      { fieldname: 'write',       fieldtype: 'Check' },
      { fieldname: 'create',      fieldtype: 'Check' },
      { fieldname: 'submit',      fieldtype: 'Check' },
      { fieldname: 'cancel',      fieldtype: 'Check' },
      { fieldname: 'delete',      fieldtype: 'Check' },
    ],
    childTables: [],
    scopeFields:  [],
    permissions:  [],
  },

  // ------------------------------------------------------------------
  // Role — system roles; autoname driven by role_name field
  // ------------------------------------------------------------------
  {
    doctype: 'Role',
    table: 'tabRole',
    submittable: false,
    autoname: 'field:role_name',
    fields: [
      { fieldname: 'name',      fieldtype: 'Data' },
      { fieldname: 'role_name', fieldtype: 'Data' },
    ],
    childTables: [],
    scopeFields:  [],
    permissions:  [],
  },

  // ------------------------------------------------------------------
  // Workflow — declarative state machine; child: transitions
  // ------------------------------------------------------------------
  {
    doctype: 'Workflow',
    table: 'tabWorkflow',
    submittable: false,
    autoname: undefined,
    fields: [
      { fieldname: 'name',                   fieldtype: 'Data' },
      { fieldname: 'document_type',          fieldtype: 'Link', options: 'DocType' },
      { fieldname: 'workflow_state_field',   fieldtype: 'Data' },
      { fieldname: 'is_active',              fieldtype: 'Check' },
      { fieldname: 'transitions',            fieldtype: 'Table', options: 'Workflow Transition' },
    ],
    childTables: [
      { field: 'transitions', doctype: 'Workflow Transition', table: 'tabWorkflowTransition' },
    ],
    scopeFields:  [],
    permissions:  [],
  },

  // ------------------------------------------------------------------
  // Workflow Transition — child table of Workflow
  // ------------------------------------------------------------------
  {
    doctype: 'Workflow Transition',
    table: 'tabWorkflowTransition',
    submittable: false,
    autoname: 'hash',
    fields: [
      { fieldname: 'name',        fieldtype: 'Data' },
      { fieldname: 'parent',      fieldtype: 'Link', options: 'Workflow' },
      { fieldname: 'parenttype',  fieldtype: 'Data' },
      { fieldname: 'parentfield', fieldtype: 'Data' },
      { fieldname: 'state',       fieldtype: 'Data' },
      { fieldname: 'action',      fieldtype: 'Data' },
      { fieldname: 'next_state',  fieldtype: 'Data' },
      { fieldname: 'allowed',     fieldtype: 'Data' },
      { fieldname: 'idx',         fieldtype: 'Int' },
    ],
    childTables: [],
    scopeFields:  [],
    permissions:  [],
  },
];

/**
 * Prime the MetaRegistry with the 6 meta-doctypes as pinned entries.
 * Call once at module load (bootstrap.js), before any request arrives.
 */
export function registerBootMeta() {
  primeFrom(META_DOCTYPES, true);
}
