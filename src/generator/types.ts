/** The subset of the ERPNext DocType JSON shape the generator reads. */
export interface DocField {
  fieldname?: string;
  label?: string;
  fieldtype: string;
  options?: string;
  reqd?: 0 | 1;
  default?: string;
  unique?: 0 | 1;
}

export interface DocType {
  name: string;
  istable?: 0 | 1;
  is_submittable?: 0 | 1;
  autoname?: string;
  fields: DocField[];
}
