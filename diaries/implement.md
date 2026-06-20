## 2026-06-21T00:00Z — spartan-erp-engine Job Spine U4 (job.workflow.seed.js)

- Examined: docs/workorder-job-spine.md (U4 frozen contract), docs/adr-job-spine.md §4.1/§4.2/§4.3 (15-transition table + verbatim seed rows), scripts/prove-tx-rollback.mjs case C (proven seed shape: sbStore.insert('tabWorkflow',…) + sbStore.insert('tabWorkflowTransition',…)), src/workflow/workflow.js loadWorkflow (columns read: state/next_state/action/allowed/guard/idx + parent/parenttype/parentfield; initial=transRows[0].state; allowed.split('\n')).
- Found: src/doctypes/job/job.def.js and job.controller.js already landed (U1/U2). No existing seed file. MemoryStore.insert(table, row) keyed by row.name — store.getChildren filters on parent/parenttype/parentfield.
- Built: src/doctypes/job/job.workflow.seed.js — exports JOB_WORKFLOW_NAME, JOB_WORKFLOW_PARENT, JOB_WORKFLOW_TRANSITIONS (15 rows), and seedJobWorkflow(store). All 15 rows use the frozen column names (state/next_state/action/allowed/guard/idx/parent/parenttype/parentfield/docstatus). Multi-role rows use '\n'-joined allowed ('admin\nscheduler'). idx-1 row has state:'Won' so loadWorkflow derives initial='Won'. Function is insert-once (callers that re-seed must pre-delete, per prove-tx-rollback.mjs:238-244 pattern).
- Verified: 17/17 scratch checks green over MemoryStore — parent row present + document_type/workflow_state_field correct, 15 child rows, idx-1 state=Won, idx-4 allowed='admin\nscheduler' splits to ['admin','scheduler'], all 15 idx values 1-15 contiguous, guard strings present on gated rows, no comma-space in any allowed field. Scratch deleted.
- Handed off: result note to team-lead (U4 done, ready for U5 to import).
- Open questions: None. All U4 done-criteria met.

## 2026-06-20T00:00Z — spartan-erp-engine Pass B Unit E (transaction wiring)

- Examined: docs/workorder-integrity-layer.md Unit E, docs/adr-integrity-layer.md §2.3/§2.4, all target source files (handler.js, service.js, workflow.js, installer.js, document.js, store.js, memory-store.js, pg-store.js), all relevant tests (handler.test.js, service.test.js, migrate.test.js, installer.test.js, store-transaction.test.js).
- Found: Units A/B/C/D already landed. store.js has nextSeries/transaction/supportsTransactions. memory-store.js has supportsTransactions=true and nextSeries. pg-store.js is complete. MemoryStore inherits base transaction pass-through. Baseline: 261 tests green across 22 files.
- Built:
  - handler.js: added PgStore import, lazy `_pg`/`pgStore()` module-scope singleton, capability-predicate txStore for atomic ops (submit/cancel/action). get/list/create/update keep the injected store unchanged.
  - service.js: wrapped submitDoc/cancelDoc/transitionDoc in store.transaction(async txStore => { ... }). assertCan is first line inside fn (403 before any PG work). load via txStore (no connection split, d.store===txStore). All writes on the tx.
  - installer.js: migrate() now wraps syncDoctype in store.transaction(tx => syncDoctype(def, tx)); bumpMetaVersion runs OUTSIDE the tx after commit (ADR F3.3).
  - document.js: added F1 JSDoc invariant on onSubmit/onCancel (JSDoc-only, no behavioral change).
  - workflow.js: added F1 JSDoc invariant comment at the onTransition call site (JSDoc-only, no behavioral change).
  - scripts/prove-tx-rollback.mjs: authored (HUMAN-GATED, do not auto-run). Three cases: (a) onSubmit throws -> docstatus rolled back; (b) success -> docstatus=1 committed; (c) transition tx throws midway -> state unmoved, no tabWorkflowAction row.
- Concluded: All 261 tests green. R1 re-traced: handler.test.js:71-77 returns 403/409 hermetically (MemoryStore.supportsTransactions===true -> txStore===store -> pgStore() never called -> perm/state gate fires first inside pass-through). No behavioral change on MemoryStore paths — the tx wrap is transparent.
- Handed off: result note to team-lead. prove-tx-rollback.mjs is a HUMAN-RUN deliverable (needs DATABASE_URL_POOLER live).
- Open questions: None. All done-criteria met.
