/**
 * Meta — wraps a plain DocMeta definition and exposes the stable
 * property + method surface that all runtime consumers read.
 *
 * Duck-compatible with the legacy plain DocMeta object: the same
 * property names (doctype, table, submittable, autoname, fields,
 * childTables, scopeFields, permissions) are directly readable so
 * document.js / permissions.js / naming.js / links.js need no changes.
 */
export class Meta {
  /**
   * @param {import('./registry.js').DocMeta} def  plain DocMeta (from boot seed or the loader)
   */
  constructor(def) {
    this._doctype     = def.doctype;
    this._table       = def.table;
    this._submittable = Boolean(def.submittable ?? false);
    this._issingle    = Boolean(def.issingle    ?? false);   // NEW (U6)
    this._isStub      = Boolean(def.isStub      ?? false);   // NEW (U-MARKER)
    this._istable     = Boolean(def.istable     ?? false);   // NEW (U1)
    this._autoname    = def.autoname;
    this._fields      = def.fields      ?? [];
    this._childTables = def.childTables ?? [];
    this._scopeFields = def.scopeFields ?? [];
    this._permissions = def.permissions ?? [];
  }

  // ---- plain-property getters (duck-compat with legacy DocMeta) ----
  get doctype()     { return this._doctype; }
  get table()       { return this._table; }
  get submittable() { return this._submittable; }
  get issingle()    { return this._issingle; }               // NEW (U6)
  get isStub()      { return this._isStub; }                 // NEW (U-MARKER)
  get istable()     { return this._istable; }               // NEW (U1)
  get autoname()    { return this._autoname; }
  get fields()      { return this._fields; }
  get childTables() { return this._childTables; }
  get scopeFields() { return this._scopeFields; }
  get permissions() { return this._permissions; }

  // ---- methods ----

  /**
   * Look up a field definition by fieldname.
   * @param {string} fieldname
   * @returns {import('./registry.js').FieldDef|undefined}
   */
  getField(fieldname) {
    return this._fields.find((f) => f.fieldname === fieldname);
  }

  /**
   * Alias of .childTables (matches the ADR method name childTables()).
   * @returns {import('./registry.js').ChildTableDef[]}
   */
  childTablesList() {
    return this._childTables;
  }

  /**
   * Return the permissions array (DocPerm[]). Called by permissions.js
   * after the F1 consumer refactor; safe to call today on the plain-perm path too.
   * @returns {import('./registry.js').DocPerm[]}
   */
  getDocPerms() {
    return this._permissions;
  }
}
