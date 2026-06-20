// LEAD integration proof — a doctype defined ENTIRELY AS DATA is installed via the
// real Installer, hydrated via the real MetaLoader, and then fully usable through
// the Document pipeline. This is the end-to-end "meta-as-data" round-trip; it also
// verifies C4 (snake→camel), C5 (perm-flag booleans), and M4 (childTables[].table)
// survive a real Installer-write → Loader-read trip.
import { describe, it, expect, beforeEach } from 'vitest';
import { seedViaLoader } from '../test-helpers/seed-via-loader.js';
import { getMeta, _resetRegistry } from './registry.js';
import { newDoc, loadDoc } from '../runtime/document.js';

const CustomerDef = {
  doctype: 'Customer', autoname: 'CUST-.#####',
  fields: [
    { fieldname: 'customer_name', fieldtype: 'Data', reqd: true },
    { fieldname: 'territory', fieldtype: 'Data' },
  ],
  permissions: [],
};

const GadgetLineDef = {
  doctype: 'GadgetLine',
  fields: [
    { fieldname: 'item', fieldtype: 'Data', reqd: true },
    { fieldname: 'qty', fieldtype: 'Int' },
  ],
  permissions: [],
};

const GadgetDef = {
  doctype: 'Gadget', autoname: 'GAD-.#####', scopeFields: ['territory'],
  fields: [
    { fieldname: 'gizmo_name', fieldtype: 'Data', reqd: true, permlevel: 0 },
    { fieldname: 'customer', fieldtype: 'Link', options: 'Customer', permlevel: 0 },
    { fieldname: 'customer_territory', fieldtype: 'Data', fetchFrom: 'customer.territory', permlevel: 0 },
    { fieldname: 'cost', fieldtype: 'Currency', permlevel: 1 },
    { fieldname: 'lines', fieldtype: 'Table', options: 'GadgetLine', permlevel: 0 },
  ],
  permissions: [
    { role: 'admin', permlevel: 0, read: true, write: true, create: true, submit: true, cancel: true, delete: true },
    { role: 'admin', permlevel: 1, read: true, write: true },
    { role: 'sales', permlevel: 0, read: true, write: true, create: true },
  ],
};

describe('meta-as-data round-trip (Installer → DB rows → Loader → usable Document)', () => {
  /** @type {import('../runtime/memory-store.js').MemoryStore} */
  let store;
  beforeEach(async () => {
    _resetRegistry();
    store = await seedViaLoader([CustomerDef, GadgetLineDef, GadgetDef]); // targets before Gadget
  });

  it('loads field metadata from DB rows with snake→camel mapping intact (C4)', () => {
    const m = getMeta('Gadget');
    expect(m.getField('customer_territory').fetchFrom).toBe('customer.territory');
    expect(m.getField('gizmo_name').reqd).toBe(true);
    expect(m.getField('cost').permlevel).toBe(1);
  });

  it('resolves childTables[].table from the target doctype (M4)', () => {
    const m = getMeta('Gadget');
    const lines = (m.childTables || []).find((c) => c.field === 'lines');
    expect(lines).toBeTruthy();
    expect(lines.table).toBe('tabGadgetLine');
  });

  it('returns DocPerm rows as real booleans, keyed by doctype (C5)', () => {
    const perms = getMeta('Gadget').getDocPerms();
    const adminL0 = perms.find((p) => p.role === 'admin' && (p.permlevel ?? 0) === 0);
    expect(adminL0).toBeTruthy();
    expect(adminL0.read).toBe(true);
    expect(typeof adminL0.create).toBe('boolean');
    expect(adminL0.doctype).toBe('Gadget'); // parent→doctype rename
  });

  it('a doctype defined as data is fully usable: create with Link-fetch + child rows + naming', async () => {
    const cust = newDoc('Customer', { customer_name: 'Acme', territory: 'VIC' }, store);
    await cust.insert();

    const g = newDoc('Gadget', { gizmo_name: 'Widget', customer: cust.doc.name, lines: [{ item: 'A', qty: 2 }] }, store);
    await g.insert();

    expect(g.doc.name).toMatch(/^GAD-\d{5}$/);        // naming series from DB-loaded meta
    expect(g.doc.customer_territory).toBe('VIC');      // fetch_from resolved via the Link target's DB-loaded meta

    const reloaded = await loadDoc('Gadget', g.doc.name, store);
    expect(reloaded.doc.lines).toHaveLength(1);        // child table persisted + reloaded
    expect(reloaded.doc.lines[0].item).toBe('A');
  });
});
