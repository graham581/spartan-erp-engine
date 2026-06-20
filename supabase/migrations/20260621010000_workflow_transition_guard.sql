-- workflow_transition_guard: add the `guard` column to tabWorkflowTransition.
-- workflow.js loadWorkflow reads `t.guard` (the human-readable block reason shown when a
-- transition's condition fails), but meta_core created the table without it. Forward-only
-- ALTER (meta_core is already applied). Idempotent.
--
-- ROLLBACK: alter table "tabWorkflowTransition" drop column if exists guard;

alter table "tabWorkflowTransition" add column if not exists guard text;
