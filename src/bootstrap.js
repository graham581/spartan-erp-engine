// Registers the doctypes + permissions the deployed API serves. Imported for
// its side effects by the Vercel routes at cold start. Until the generator is
// rebuilt (ERPNext JSON -> generated/meta.js), doctypes are hand-registered
// here; the generator will replace this file.
import { registerDoctype } from './meta/registry.js';
import { registerRolePerm } from './perms/registry.js';

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
});
registerRolePerm({ role: 'admin', doctype: 'Customer', permlevel: 0, read: true, write: true, create: true, delete: true });
registerRolePerm({ role: 'admin', doctype: 'Customer', permlevel: 1, read: true, write: true });
registerRolePerm({ role: 'sales', doctype: 'Customer', permlevel: 0, read: true, write: true, create: true });
