-- workflow_action_log: create tabWorkflowAction, the append-only transition audit log.
-- workflow.js transition() inserts one row per successful workflow transition; the table
-- was referenced by code but never provisioned (meta_core created tabWorkflow +
-- tabWorkflowTransition but not this log). Columns mirror the workflow.js insert exactly.
--
-- ROLLBACK:
--   drop table if exists "tabWorkflowAction";

create table if not exists "tabWorkflowAction" (
  name         text primary key,
  ref_doctype  text,
  ref_name     text,
  action       text,
  from_state   text,
  to_state     text,
  actor        text,
  timestamp    timestamptz
);

grant all on "tabWorkflowAction" to service_role;
