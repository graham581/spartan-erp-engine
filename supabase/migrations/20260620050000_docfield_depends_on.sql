-- ROLLBACK: alter table "tabDocField" drop column if exists depends_on, drop column if exists mandatory_depends_on;
alter table "tabDocField" add column if not exists depends_on text;
alter table "tabDocField" add column if not exists mandatory_depends_on text;
