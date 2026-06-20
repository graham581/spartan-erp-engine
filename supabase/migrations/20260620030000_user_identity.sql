-- user_identity: create tabUser + tabHasRole for the identity/auth layer.
-- tabUser stores CRM users; tabHasRole is the child role-assignment table.
-- Shape mirrors tabRole / tabDocField in meta_core.sql: framework cols + domain cols.
-- Frappe fieldnames verified via frappe/core/doctype/user/user.json
-- and frappe/core/doctype/has_role/has_role.json.
--
-- ROLLBACK:
--   drop table if exists "tabHasRole";
--   drop table if exists "tabUser";

-- ── tabUser ───────────────────────────────────────────────────────────────────
-- Frappe framework cols (name PK, owner, creation, modified, docstatus, idx)
-- plus the CRM identity fields identity.js reads: email, full_name, branch, enabled.
-- name = email (Frappe convention for User: autoname field:email).

create table if not exists "tabUser" (
  name             text primary key,
  owner            text,
  docstatus        int  not null default 0,
  idx              int  not null default 0,
  creation         timestamptz,
  modified         timestamptz,
  email            text,
  full_name        text,
  branch           text,
  enabled          boolean not null default true
);

-- ── tabHasRole ────────────────────────────────────────────────────────────────
-- Child table of tabUser (parent/parenttype/parentfield links to owning User).
-- Mirrors the child-table shape in meta_core.sql (e.g. tabDocField, tabDocPerm).
-- role links to tabRole.name.

create table if not exists "tabHasRole" (
  name             text primary key,
  owner            text,
  docstatus        int  not null default 0,
  idx              int  not null default 0,
  creation         timestamptz,
  modified         timestamptz,
  parent           text,
  parenttype       text,
  parentfield      text,
  role             text
);

-- ── Grants ────────────────────────────────────────────────────────────────────
grant all on "tabUser"    to service_role;
grant all on "tabHasRole" to service_role;
