/* =====================================================================
 * Generated DocType runtime metadata  (DO NOT EDIT)
 * Drives the document runtime (table names, child tables, submittable).
 * Regenerate: npm run generate
 * ===================================================================== */

export interface ChildTableMeta {
  field: string;
  doctype: string;
  table: string;
}

export interface DocMeta {
  doctype: string;
  table: string;
  istable: boolean;
  submittable: boolean;
  autoname: string;
  childTables: ChildTableMeta[];
}

export const META: Record<string, DocMeta> = {
  "Currency": {
    "doctype": "Currency",
    "table": "currency",
    "istable": false,
    "submittable": false,
    "autoname": "field:currency_name",
    "childTables": []
  },
  "UOM": {
    "doctype": "UOM",
    "table": "uom",
    "istable": false,
    "submittable": false,
    "autoname": "field:uom_name",
    "childTables": []
  },
  "Company": {
    "doctype": "Company",
    "table": "company",
    "istable": false,
    "submittable": false,
    "autoname": "field:company_name",
    "childTables": []
  },
  "Customer": {
    "doctype": "Customer",
    "table": "customer",
    "istable": false,
    "submittable": false,
    "autoname": "naming_series:",
    "childTables": []
  },
  "Item": {
    "doctype": "Item",
    "table": "item",
    "istable": false,
    "submittable": false,
    "autoname": "field:item_code",
    "childTables": []
  },
  "Sales Order": {
    "doctype": "Sales Order",
    "table": "sales_order",
    "istable": false,
    "submittable": true,
    "autoname": "naming_series:",
    "childTables": [
      {
        "field": "items",
        "doctype": "Sales Order Item",
        "table": "sales_order_item"
      }
    ]
  },
  "Sales Order Item": {
    "doctype": "Sales Order Item",
    "table": "sales_order_item",
    "istable": true,
    "submittable": false,
    "autoname": "hash",
    "childTables": []
  },
  "Window": {
    "doctype": "Window",
    "table": "window",
    "istable": false,
    "submittable": false,
    "autoname": "hash",
    "childTables": []
  }
};
