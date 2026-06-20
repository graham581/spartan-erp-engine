// job.def.js — DocMeta definition for the Job doctype (meta-as-data).
//
// FROZEN: field names, types, defaults, and permissions are the contracts
// that job.controller.js (naming), job.hooks.js (gate conditions), and
// job.workflow.seed.js (state vocabulary) all depend on — change only
// through ADR revision.
//
// scopeFields: ['entity'] — VIC / ACT row-isolation seam; not yet
// enforced beyond scope filtering (deferred to a future increment).
//
// submittable: false — Job status is a workflow field, not docstatus.
// NO autoname — JobController.insert() derives the name (ADR §3 Option C).

export const JOB_STATES = [
  'Won',
  'Measure',
  'Sign-off',
  'Manufacturing',
  'Scheduling',
  'Install',
  'Complete',
  'Hold',
  'Cancelled',
];

export const JobDef = {
  doctype: 'Job',
  table: 'tabJob',          // REQUIRED: createTableSql reads def.table directly
  submittable: false,        // status != docstatus (ADR §1)
  scopeFields: ['entity'],

  fields: [
    // --- identity / scope -----------------------------------------------
    { fieldname: 'entity',       fieldtype: 'Select',   options: ['VIC', 'ACT'], reqd: true,  permlevel: 0 },

    // --- workflow state (initial 'Won'; workflow.js:97 reads this default) --
    { fieldname: 'status',       fieldtype: 'Select',   options: JOB_STATES, default: 'Won', permlevel: 0 },

    // --- links ----------------------------------------------------------
    { fieldname: 'customer',     fieldtype: 'Link',     options: 'Customer',   reqd: true,  permlevel: 0 },
    { fieldname: 'quotation',    fieldtype: 'Link',     options: 'Quotation',               permlevel: 0 },

    // --- core job data --------------------------------------------------
    { fieldname: 'site_address', fieldtype: 'Text',                                          permlevel: 0 },
    { fieldname: 'job_value',    fieldtype: 'Currency',                                      permlevel: 0 },

    // --- gate stubs (condition hooks read these by name) ----------------
    { fieldname: 'deposit_pct',  fieldtype: 'Float',                                         permlevel: 0 },
    { fieldname: 'balance_pct',  fieldtype: 'Float',                                         permlevel: 0 },
    { fieldname: 'mfg_paid',     fieldtype: 'Check',                                         permlevel: 0 },

    // --- deferred seams (leave unwired) ---------------------------------
    { fieldname: 'klaes_ref',    fieldtype: 'Data',                                          permlevel: 0 },
    { fieldname: 'signoff_doc',  fieldtype: 'Data',                                          permlevel: 0 },

    // --- hold management ------------------------------------------------
    { fieldname: 'hold_reason',  fieldtype: 'Text',                                          permlevel: 0 },
  ],

  permissions: [
    // admin: full access including delete
    { role: 'admin',     doctype: 'Job', permlevel: 0, read: true, write: true,  create: true,  delete: true },
    // scheduler: back-half mutations, no create/delete
    { role: 'scheduler', doctype: 'Job', permlevel: 0, read: true, write: true,  create: false },
    // sales: read + create (won deals arrive here), no write/submit
    { role: 'sales',     doctype: 'Job', permlevel: 0, read: true, write: false, create: true  },
  ],
};
