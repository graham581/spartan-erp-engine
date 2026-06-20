import { describe, it, expect, beforeEach } from 'vitest';
import { _resetRegistry, getMeta, hasMeta, invalidate } from './registry.js';
import { META_DOCTYPES, registerBootMeta } from './boot-meta.js';

beforeEach(() => {
  _resetRegistry();
});

describe('META_DOCTYPES', () => {
  it('exports exactly 6 meta-doctypes', () => {
    expect(META_DOCTYPES).toHaveLength(6);
  });

  it('includes all 6 required doctype names', () => {
    const names = META_DOCTYPES.map((d) => d.doctype);
    expect(names).toContain('DocType');
    expect(names).toContain('DocField');
    expect(names).toContain('DocPerm');
    expect(names).toContain('Role');
    expect(names).toContain('Workflow');
    expect(names).toContain('Workflow Transition');
  });
});

describe('registerBootMeta', () => {
  it('primes all 6 meta-doctypes into the registry', () => {
    registerBootMeta();
    expect(hasMeta('DocType')).toBe(true);
    expect(hasMeta('DocField')).toBe(true);
    expect(hasMeta('DocPerm')).toBe(true);
    expect(hasMeta('Role')).toBe(true);
    expect(hasMeta('Workflow')).toBe(true);
    expect(hasMeta('Workflow Transition')).toBe(true);
  });

  it('getMeta("DocType").table === "tabDocType"', () => {
    registerBootMeta();
    expect(getMeta('DocType').table).toBe('tabDocType');
  });

  it('getMeta("DocField").table === "tabDocField"', () => {
    registerBootMeta();
    expect(getMeta('DocField').table).toBe('tabDocField');
  });

  it('getMeta("DocPerm").table === "tabDocPerm"', () => {
    registerBootMeta();
    expect(getMeta('DocPerm').table).toBe('tabDocPerm');
  });

  it('getMeta("Role").table === "tabRole"', () => {
    registerBootMeta();
    expect(getMeta('Role').table).toBe('tabRole');
  });

  it('getMeta("Workflow").table === "tabWorkflow"', () => {
    registerBootMeta();
    expect(getMeta('Workflow').table).toBe('tabWorkflow');
  });

  it('getMeta("Workflow Transition").table === "tabWorkflowTransition"', () => {
    registerBootMeta();
    expect(getMeta('Workflow Transition').table).toBe('tabWorkflowTransition');
  });

  it('DocType childTables includes DocField and DocPerm', () => {
    registerBootMeta();
    const m = getMeta('DocType');
    const childDoctypes = m.childTables.map((ct) => ct.doctype);
    expect(childDoctypes).toContain('DocField');
    expect(childDoctypes).toContain('DocPerm');
  });

  it('Workflow childTables includes Workflow Transition', () => {
    registerBootMeta();
    const m = getMeta('Workflow');
    const childDoctypes = m.childTables.map((ct) => ct.doctype);
    expect(childDoctypes).toContain('Workflow Transition');
  });

  it('Role has autoname "field:role_name"', () => {
    registerBootMeta();
    expect(getMeta('Role').autoname).toBe('field:role_name');
  });

  it('pinned: all 6 survive invalidate()', () => {
    registerBootMeta();
    invalidate();
    expect(hasMeta('DocType')).toBe(true);
    expect(hasMeta('DocField')).toBe(true);
    expect(hasMeta('DocPerm')).toBe(true);
    expect(hasMeta('Role')).toBe(true);
    expect(hasMeta('Workflow')).toBe(true);
    expect(hasMeta('Workflow Transition')).toBe(true);
  });
});
