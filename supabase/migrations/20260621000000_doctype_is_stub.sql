-- ROLLBACK: alter table "tabDocType" drop column if exists is_stub;
alter table "tabDocType" add column if not exists is_stub boolean default false;
