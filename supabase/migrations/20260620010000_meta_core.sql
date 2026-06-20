-- meta_core: create the six meta tables + meta_version cache-invalidation row.
-- These tables are the schema for the meta-as-data feature (ADR §1 / workorder-meta-as-data.md §E1).
-- All columns use snake_case to match the snake→camel map in MetaLoader.load().
-- All boolean-ish columns are Postgres BOOLEAN (C5 decision — no 0/1 int flags here).
--
-- ROLLBACK:
--   drop table if exists "tabWorkflowTransition";
--   drop table if exists "tabWorkflow";
--   drop table if exists "tabRole";
--   drop table if exists "tabDocPerm";
--   drop table if exists "tabDocField";
--   drop table if exists "tabDocType";
--   drop table if exists meta_version;

-- ── tabDocType ──────────────────────────────────────────────────────────────
-- Frappe fieldnames verified via frappe/core/doctype/doctype/doctype.json
-- Framework cols: owner, docstatus, idx, creation, modified (standard on every table)
-- Spartan extension: scope_fields text[] (not a Frappe field — ADR §1 extension)

create table if not exists "tabDocType" (
  name             text primary key,
  owner            text,
  docstatus        int  not null default 0,
  idx              int  not null default 0,
  creation         timestamptz,
  modified         timestamptz,
  module           text,
  autoname         text,
  naming_rule      text,
  issingle         boolean not null default false,
  istable          boolean not null default false,
  is_submittable   boolean not null default false,
  scope_fields     text[]
);

-- ── tabDocField ──────────────────────────────────────────────────────────────
-- Child table — parent/parenttype/parentfield links to the owning DocType.
-- Frappe fieldnames verified via frappe/core/doctype/docfield/docfield.json
-- "unique" and "create" are SQL reserved words — must be quoted.

create table if not exists "tabDocField" (
  name             text primary key,
  owner            text,
  docstatus        int  not null default 0,
  idx              int  not null default 0,
  creation         timestamptz,
  modified         timestamptz,
  parent           text,
  parenttype       text,
  parentfield      text,
  fieldname        text,
  fieldtype        text,
  label            text,
  options          text,
  reqd             boolean not null default false,
  "unique"         boolean not null default false,
  read_only        boolean not null default false,
  permlevel        int  not null default 0,
  fetch_from       text
);

-- ── tabDocPerm ──────────────────────────────────────────────────────────────
-- Child table — parent/parenttype/parentfield links to the owning DocType.
-- Frappe fieldnames verified via frappe/core/doctype/docperm/docperm.json
-- "create", "delete", "cancel" are SQL reserved words — must be quoted.

create table if not exists "tabDocPerm" (
  name             text primary key,
  owner            text,
  docstatus        int  not null default 0,
  idx              int  not null default 0,
  creation         timestamptz,
  modified         timestamptz,
  parent           text,
  parenttype       text,
  parentfield      text,
  role             text,
  permlevel        int  not null default 0,
  if_owner         boolean not null default false,
  read             boolean not null default false,
  write            boolean not null default false,
  "create"         boolean not null default false,
  submit           boolean not null default false,
  "cancel"         boolean not null default false,
  "delete"         boolean not null default false
);

-- ── tabRole ──────────────────────────────────────────────────────────────────
-- Frappe fieldnames verified via frappe/core/doctype/role/role.json
-- role_name is the human-readable label; name (pk) is the programmatic key.

create table if not exists "tabRole" (
  name             text primary key,
  owner            text,
  docstatus        int  not null default 0,
  idx              int  not null default 0,
  creation         timestamptz,
  modified         timestamptz,
  role_name        text
);

-- ── tabWorkflow ───────────────────────────────────────────────────────────────
-- Frappe fieldnames verified via frappe/workflow/doctype/workflow/workflow.json
-- condition/onTransition are NOT columns — they are code hooks in hooks.js (ADR §6).

create table if not exists "tabWorkflow" (
  name                  text primary key,
  owner                 text,
  docstatus             int  not null default 0,
  idx                   int  not null default 0,
  creation              timestamptz,
  modified              timestamptz,
  document_type         text,
  workflow_state_field  text,
  is_active             boolean not null default false
);

-- ── tabWorkflowTransition ─────────────────────────────────────────────────────
-- Child table — parent/parenttype/parentfield links to the owning Workflow.
-- Frappe fieldnames verified via frappe/workflow/doctype/workflow_transition/workflow_transition.json
-- state/action/next_state map to Frappe's Link fields of the same names.
-- allowed = role name (Link → Role in Frappe; stored as text here).

create table if not exists "tabWorkflowTransition" (
  name             text primary key,
  owner            text,
  docstatus        int  not null default 0,
  idx              int  not null default 0,
  creation         timestamptz,
  modified         timestamptz,
  parent           text,
  parenttype       text,
  parentfield      text,
  state            text,
  action           text,
  next_state       text,
  allowed          text
);

-- ── meta_version ─────────────────────────────────────────────────────────────
-- Single-row cache-invalidation sentinel.  MetaLoader.ensureFresh() reads this.
-- version is text (not bigint) — bumped by Installer.bumpMetaVersion as a string
-- (matches workorder §E1: "version text not null").

create table if not exists meta_version (
  name             text primary key,
  version          text not null
);

-- Seed the single row; idempotent (on conflict do nothing).
insert into meta_version (name, version)
  values ('meta_version', '1')
  on conflict do nothing;

-- ── Grants ────────────────────────────────────────────────────────────────────
grant all on "tabDocType"           to service_role;
grant all on "tabDocField"          to service_role;
grant all on "tabDocPerm"           to service_role;
grant all on "tabRole"              to service_role;
grant all on "tabWorkflow"          to service_role;
grant all on "tabWorkflowTransition" to service_role;
grant all on meta_version           to service_role;
