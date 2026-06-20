// Cold-start registration for the deployed API.
// registerBootMeta() pins the 6 meta-doctypes (DocType/DocField/DocPerm/Role/
// Workflow/Workflow Transition) so the meta-as-data path works; business
// doctypes are loaded lazily from the DB by MetaLoader.ensure() per request.
// Customer stays hand-registered in-code until it's migrated to data via the
// Installer (then it loads from tabDocType like any other doctype).
import { registerDoctype } from './meta/registry.js';
import { registerBootMeta } from './meta/boot-meta.js';

registerBootMeta();

registerDoctype({
  doctype: 'Customer',
  table: 'tabCustomer',
  autoname: 'CUST-.#####',
  scopeFields: ['territory'],
  fields: [
    { fieldname: 'customer_name', fieldtype: 'Data', reqd: true, permlevel: 0 },
    { fieldname: 'territory', fieldtype: 'Data', permlevel: 0 },
    { fieldname: 'email', fieldtype: 'Data', permlevel: 0 },
    { fieldname: 'credit_limit', fieldtype: 'Currency', permlevel: 1 },
  ],
  childTables: [],
  // Permissions inline on the def (read by getMeta('Customer').getDocPerms()).
  permissions: [
    { role: 'admin', doctype: 'Customer', permlevel: 0, read: true, write: true, create: true, delete: true },
    { role: 'admin', doctype: 'Customer', permlevel: 1, read: true, write: true },
    { role: 'sales', doctype: 'Customer', permlevel: 0, read: true, write: true, create: true },
  ],
});
