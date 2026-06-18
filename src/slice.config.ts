/**
 * Which DocTypes the generator materializes, and where ERPNext lives.
 *
 * SOURCE OF TRUTH: ERPNext DocType JSON. We extract the *nouns* (data model)
 * from here; the *verbs* (Job + status machine) are designed from the ops
 * manual later (see ../docs/ops-manual-coverage.md).
 *
 * Currency is resolved from src/generator/synthetic/ (it lives in the Frappe
 * framework, not the erpnext app), so the generator treats it uniformly.
 */
export const ERPNEXT_ROOT =
  process.env.ERPNEXT_ROOT ||
  'C:/Users/parrg/Documents/erpnext-develop/erpnext-develop/erpnext';

export const SELLING_SLICE: string[] = [
  'Currency',
  'UOM',
  'Company',
  'Customer',
  'Item',
  'Sales Order',
  'Sales Order Item',
  'Window',
];
