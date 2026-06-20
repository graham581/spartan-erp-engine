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
