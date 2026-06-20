// erpnext-to-def.drop.test.js — U3: THE PINNED DROP-TEST (D3 gate).
//
// Criterion (HARD, §2-U3): given a source ERPNext field-set where every field
// carries depends_on and mandatory_depends_on "eval:…" strings, the generated
// def MUST contain ZERO dependsOn / mandatoryDependsOn keys and ZERO string-
// typed "eval:…" values anywhere in the field objects.
//
// D3 column (U8/U9/U10) is blockedBy this test landing green.

import { describe, it, expect } from 'vitest';
import { erpnextJsonToDef } from './erpnext-to-def.js';

// Build a JSON whose fields each carry depends_on and mandatory_depends_on
// with "eval:…" strings — exactly as seen in real ERPNext JSONs.
const POISON_JSON = {
  doctype: 'DocType',
  name: 'Poison Test',
  module: 'Testing',
  is_submittable: 0,
  issingle: 0,
  istable: 0,
  fields: [
    {
      fieldname: 'alpha',
      fieldtype: 'Data',
      reqd: 1,
      read_only: 0,
      unique: 0,
      permlevel: 0,
      idx: 1,
      depends_on: 'eval:doc.is_group==0',
      mandatory_depends_on: 'eval:doc.x=="y"',
    },
    {
      fieldname: 'beta',
      fieldtype: 'Int',
      reqd: 0,
      read_only: 0,
      unique: 0,
      permlevel: 0,
      idx: 2,
      depends_on: 'eval:doc.beta_flag==1',
      mandatory_depends_on: 'eval:doc.z!="skip"',
    },
    {
      fieldname: 'gamma',
      fieldtype: 'Select',
      options: 'A\nB\nC',
      reqd: 0,
      read_only: 1,
      unique: 0,
      permlevel: 0,
      idx: 3,
      depends_on: 'eval:doc.show_gamma',
      mandatory_depends_on: 'eval:doc.gamma_required',
    },
    {
      fieldname: 'delta',
      fieldtype: 'Link',
      options: 'Customer',
      reqd: 0,
      read_only: 0,
      unique: 0,
      permlevel: 0,
      idx: 4,
      depends_on: 'eval:doc.is_group==0',
      mandatory_depends_on: 'eval:doc.customer_required',
    },
  ],
  permissions: [],
};

describe('U3 drop-test — depends_on / mandatory_depends_on never reaches the def', () => {
  it('no field carries dependsOn, mandatoryDependsOn, or any eval: string value', () => {
    const def = erpnextJsonToDef(POISON_JSON);

    // Sanity: there are output fields (layout-only input would be a vacuous pass)
    expect(def.fields.length).toBeGreaterThan(0);

    for (const f of def.fields) {
      // D1-2 boundary: camelCase keys must not exist
      expect(f).not.toHaveProperty('dependsOn');
      expect(f).not.toHaveProperty('mandatoryDependsOn');

      // Belt-and-suspenders: no string value anywhere in the field object
      // may begin with 'eval:' (catches any future spread or passthrough regression).
      const hasEvalString = Object.values(f).some(
        v => typeof v === 'string' && v.startsWith('eval:'),
      );
      expect(hasEvalString).toBe(false);
    }
  });
});
