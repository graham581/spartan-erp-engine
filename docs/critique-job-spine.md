# Critique — Job Spine (first increment)

**Verdict: PASS** (R1, 2026-06-21). The R1 ADR (`docs/adr-job-spine.md`) + both PUMLs address all blocking findings from the R0 FAIL. The architecture was already sound (crux holds — gate blocks and rolls back the tx); R1 fixes were spec-vs-runtime-vocabulary alignment, and all four landed *genuinely* (verified against the runtime source, not just reworded). Proceed to `planner`.

**Verified against source** (read 2026-06-21): `src/workflow/workflow.js`, `src/workflow/hooks.js`, `src/runtime/naming.js`, `src/runtime/document.js`, `src/api/service.js`, `src/perms/permissions.js`, and the proven seed shapes in `scripts/prove-tx-rollback.mjs` (case C) + `scripts/prove-quotation.mjs`.

---

## R1 re-verification — the four blocking fixes

### F-1 (was BLOCKING) — Seed-row vocabulary → **LANDED**
§4 is now written in the engine's real row columns. Cross-checked against `loadWorkflow` (workflow.js:78-89, reads `t.state`/`t.next_state`/`t.action`/`t.allowed`/`t.guard`) and the only proven seed shape (prove-tx-rollback.mjs:147-158):
- §4.1 parent row: `document_type:'Job'`, `workflow_state_field:'status'`, `name:'Job Workflow'` — matches `loadWorkflow`'s lookup (workflow.js:55) + the runtime's `wfRow.workflow_state_field` read (workflow.js:95). ✅
- §4.3 verbatim transition rows carry **every column the loader reads** plus the child-link columns: `action`, `state`, `next_state`, `allowed`, `guard`, `idx`, `parent:'Job Workflow'`, `parenttype:'Workflow'`, `parentfield:'transitions'`, `docstatus:0`. `store.getChildren(transTable, wfRow.name, 'Workflow', 'transitions')` (workflow.js:60-65) will find them. **Literally buildable.** ✅
- Initial state: idx 1 = `start_measure`, `state:'Won'`; `loadWorkflow` sorts by idx (workflow.js:68) and sets `initial = transRows[0].state` (workflow.js:96) → `initial='Won'`. ✅
- Class PUML `JobWf` block rewritten to the real columns; no `from`/`to` remains. ✅

### F-2 (was BLOCKING) — `\n`-delimited roles → **LANDED**
`loadWorkflow` parses `t.allowed.split('\n')` (workflow.js:79). Swept §4.2 (all 15 rows), §4.3 examples, the §4 callout, and the class PUML: every multi-role value is `'admin\nscheduler'`; single-role is plain `'admin'`. **No comma-separated role string remains anywhere.** The ADR explicitly documents the encoding + flags the multi-role path as untested by the prove scripts (carried to the implement test list). ✅

### F-3 / F1b (LEAD ruling) — mfg gate moved to `to_scheduling` → **LANDED**
- Hooks block: `WORKFLOW_HOOKS.set('Job::to_scheduling', { condition: (doc) => doc.mfg_paid === true })`; `to_manufacturing` hook removed. ✅
- idx 4 (`to_scheduling`, Manufacturing→Scheduling) carries the gate; idx 3 (`to_manufacturing`) is ungated. ✅
- **Hook key matches the action char-for-char:** `"Job::to_scheduling"` ↔ idx-4 `action:'to_scheduling'`. `getHooks` does `WORKFLOW_HOOKS.get(`${doctype}::${action}`)` (hooks.js:35), so it resolves. ✅
- Guard text moved to the idx-4 row ("Manufacturing payment must clear before scheduling."). ✅
- §4.4, §9 (F1b marked RESOLVED), both PUMLs consistent. ✅

### F-7 (clarify-or-block) — sales dropped from all `allowed` → **LANDED + coherent**
- Docperm: sales = read + create, **no write** (§2). ✅
- Swept every transition's `allowed` (idx 1-15): only `admin` and `admin\nscheduler`. **No transition lists `sales`.** ✅
- Cross-check allowed-role vs write-docperm: admin has write, scheduler has write. **No transition's `allowed` names a role lacking `write` → no dead 403 transitions.** This closes the exact incoherence F-7 raised (transitionDoc asserts write first, service.js:100). ✅
- Internally consistent: §2/§5 state sales *creates* the Job (status `Won` via default), admin advances the chain, scheduler drives the back half. ✅

---

## Crux survived the edits (re-confirmed)

The three gates still match their transition `action` values exactly and read the right Job fields:

| Hook key | matches row action (idx) | reads field | threshold |
|---|---|---|---|
| `Job::start_measure` | `start_measure` (idx 1) | `deposit_pct` | `Number(...) >= 5` |
| `Job::start_signoff` | `start_signoff` (idx 2) | `balance_pct` | `Number(...) >= 45` |
| `Job::to_scheduling` | `to_scheduling` (idx 4) | `mfg_paid` | `=== true` |

Field names match the §2 Job def exactly (`deposit_pct`/`balance_pct`/`mfg_paid`). The block-and-rollback machinery is unchanged: condition runs before the state save and throws `StateError` on false (workflow.js:145-148); `transitionDoc` wraps in `store.transaction` (service.js:99-105) — proven by prove-tx-rollback case (c). status≠docstatus still clean (Job `submittable:false` → docstatus 0 → save immutability guard at document.js:79 never fires). ✅

## Non-blocking items — all present in R1
- **F-4** entity-before-naming: §3 + class PUML note — controller's VIC/ACT guard protects `nextSeries`, meta `reqd` is a later backstop. ✅
- **F-5** cold-cache `availableActions` returns `[]`: §5 + class PUML annotation. ✅
- **F-6** resume→Measure re-crosses gates (no money lost) + implement-test flag: §4.4. ✅
- **F-8** `status` field default `'Won'`: §2 field table + attributes + sequence PUML create note. ✅

## Contract scan (R1)
| Clause | Result |
|---|---|
| DRY | ✅ |
| KISS | ✅ |
| YAGNI | ✅ |
| SOLID/SoC | ✅ |
| Least Privilege | ✅ (F-7 resolved — sales create-only, no dead transitions) |
| Idempotency | ✅ |
| Fail-Fast | ✅ |

---

## Handoff to `planner` — implement test list (carry forward)

Load-bearing behaviours the prove scripts did NOT cover; the build must add coverage:

1. **Gated-transition block + rollback** — `start_measure` with `deposit_pct < 5` throws `StateError` (→409), state stays `Won`, **no `tabWorkflowAction` row** written (tx rolled back). Mirror prove-tx-rollback case (c).
2. **Multi-role `allowed` path** (UNTESTED by prove scripts — F-2) — a `scheduler`-role ctx can fire `to_scheduling`/`to_install`/`complete`/`hold`/`resume`; assert `allowed:'admin\nscheduler'` parses to two roles (not one dead `"admin, scheduler"` string).
3. **VIC/ACT naming** — a `VIC` Job → `VIC-#####`, an `ACT` Job → `ACT-#####`, independent counters; a Job with `entity` neither VIC nor ACT throws before any write (controller fail-fast).
4. **Held → resumed post-payment re-advance** (F-6) — a Job held from Manufacturing/Scheduling resumes to Measure and re-advances through `start_signoff`/`to_scheduling` **without re-payment** (`mfg_paid` Check + `*_pct` persist).
5. **sales-cannot-transition 403** — a `sales`-role ctx calling `transitionDoc(... 'start_measure')` gets `PermissionError` at the write-gate (service.js:100) before the transition's own `allowed` check.
6. **Initial state + status default** — a Job created with `status` omitted lands in `'Won'` (field default, F-8); `loadWorkflow` derives `initial='Won'` from idx-1 `state`.
7. **gate keys resolve** — the 3 `WORKFLOW_HOOKS` keys match their seed-row `action` strings so the conditions actually attach (a regression guard against a future key typo silently ungating a money gate).

Architecture verified sound; no further critique rounds expected.
