-- Customer master + naming-series table for the live one-doctype proof.
-- Applied to the engine's OWN isolated Supabase project via `supabase db push`.

create table if not exists tab_series (
  name    text primary key,
  current bigint not null default 0
);

create table if not exists "tabCustomer" (
  name          text primary key,
  owner         text,
  docstatus     int  not null default 0,
  idx           int  not null default 0,
  creation      timestamptz,
  modified      timestamptz,
  customer_name text,
  territory     text,
  email         text,
  credit_limit  numeric
);

grant all on tab_series    to service_role;
grant all on "tabCustomer" to service_role;
