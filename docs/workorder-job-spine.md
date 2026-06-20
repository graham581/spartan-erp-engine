# Work Order — Job Spine (first increment)

**Status:** GO (composition passed). Source: `docs/adr-job-spine.md` (frozen, critique PASS R1) + `docs/critique-job-spine.md` (7-test handoff).
**Date:** 2026-06-21 · **Author:** planner · **Repo:** `C:\Users\parrg\Documents\spartan-erp-engine`
**Build mode:** lead fans out one `implement` per unit where parallel-safe; serialize the collisions called out in §Collision. Live proof (`prove-job.mjs`) is **human-gated** — run with the user's go, never auto-deploy.

All line refs verified against source 2026-06-21: `workflow.js`, `hooks.js`, `naming.js`, `document.js`, `service.js`, `store.js`, `memory-store.js`, `installer.js`, `prove-quotation.mjs`, `prove-tx-rollback.mjs`, and the **pre-existing** `src/workflow/workflow.test.js`.

---

## 0. Ground-truth facts that shape the plan (read before building)

1. **No central controller-registration site exists.** `registerController` (document.js:168) is *defined* in the runtime and *called only inside prove scripts* (prove-tx-rollback.mjs:68,107). There is **no app bootstrap module** that wires controllers. → The JobController must self-register via an **import-time side-effect** in its own module (`registerController('Job', JobController)` at module top level), and **every consumer must import that module** (the prove script, and the runtime entry if/when one exists). This is FROZEN as Unit 2's contract. Do NOT invent a new central registry file (YAGNI) — match the existing self-register pattern.

2. **A pre-existing `src/workflow/workflow.test.js` already defines a TOY `Job`** (states `draft/measure/manufacture/complete`, field `deposit_paid` Check) and does `WORKFLOW_HOOKS.set('Job::start_measure', { condition: doc => doc.deposit_paid === true })` **at module scope**. `WORKFLOW_HOOKS` is a process-global `Map` (hooks.js:24). The prod hook sets the **same key** `Job::start_measure` to a **different** body (`deposit_pct >= 5`). **This is a global-state collision** — see §Collision C-1. It is the single biggest buildability risk; the plan resolves it explicitly.

3. **MemoryStore.transaction is a pass-through** (`store.js:44` base `async transaction(fn){ return fn(this) }`). MemoryStore has **no rollback** — a thrown error leaves writes in place. → The unit test for "block + rollback + no audit row" (critique test #1) can assert **no state change + no audit row** on MemoryStore (because `transition()` throws *before* `d.save()` and *before* the audit insert when the condition fails — workflow.js:145-157 — so nothing was written yet). True tx-rollback-on-partial-failure is the **live** proof's job (prove-job, on PgStore). State this split in both units.

4. **Initial state is derived from `transRows[0].state` after idx-sort** (workflow.js:68,97). idx-1 row must be `start_measure`/`state:'Won'`. The `status` field default `'Won'` (§2) is what makes a freshly-created Job sit in `Won` without the caller passing `status`.

5. **403 vs 409 mapping:** `PermissionError` → 403, `StateError` → 409 (handler.test.js convention; service raises `PermissionError` from `assertCanMutate`/`assertCan`, `transition()` raises `StateError` for blocked-condition and bad-action). Sales-cannot-transition (test #5) surfaces as **`PermissionError`** at `transitionDoc`'s `assertCanMutate(ctx,'Job','write')` (service.js:100) — assert `rejects.toBeInstanceOf(PermissionError)`.

---

## 1. Units (dependency-ordered)

| Unit | Deliverable | File(s) | Depends on | Parallel-safe? |
|---|---|---|---|---|
| **U1** | Job DocMeta def (meta-as-data) | `src/doctypes/job/job.def.js` (NEW) | — | ✅ yes (leaf) |
| **U2** | JobController + self-registration | `src/doctypes/job/job.controller.js` (NEW) | U1 (imports the def for nothing at runtime; needs the def's field names frozen) | ✅ yes — different file from U1; only needs U1's frozen field names |
| **U3** | 3 condition hooks | `src/doctypes/job/job.hooks.js` (NEW) | U1 (field names) | ✅ yes — own file |
| **U4** | Job Workflow seed (parent + 15 transition rows) as a reusable exported fn | `src/doctypes/job/job.workflow.seed.js` (NEW) | U1 (state vocabulary), U3 (action strings must match hook keys) | ✅ yes — own file |
| **U5** | Vitest unit suite (7 critique tests) | `src/doctypes/job/job.workflow.test.js` (NEW) | U1–U4 | ⚠ serialize after U1–U4 land (imports all of them); see §Collision C-1 |
| **U6** | `prove-job.mjs` LIVE proof | `scripts/prove-job.mjs` (NEW) | U1–U4 | ⚠ serialize after U1–U4; human-gated run |

**Build groups:**
- **Group A (parallel):** U1, U2, U3, U4 — four NEW files, no shared edits. U2/U3/U4 only consume **frozen interfaces** from §2 below (field names, action strings, state names), so they need the *contract*, not U1's landed code.
- **Group B (serial, after A):** U5 then U6 (or in parallel with each other — different files, both read-only consumers of A). Both import the def/controller/hooks/seed.

**No edits to existing engine files.** Every unit is a NEW file. `workflow.js`, `hooks.js`, `naming.js`, `document.js`, `service.js`, `installer.js`, `permissions.js` are **reuse-as-is** (ADR §6) — an `implement` that edits any of them is out of contract.

---

## 2. FROZEN interface contracts

### U1 — `src/doctypes/job/job.def.js`

Export a plain `DocMeta` object identical in shape to `QuotationDef` (prove-quotation.mjs:36). **FROZEN:**

```js
export const JOB_STATES = ['Won','Measure','Sign-off','Manufacturing','Scheduling','Install','Complete','Hold','Cancelled'];

export const JobDef = {
  doctype: 'Job',
  table: 'tabJob',
  submittable: false,            // status != docstatus (ADR §1)
  // NO autoname — JobController.insert() supplies the name (ADR §3 Option C).
  scopeFields: ['entity'],
  fields: [
    { fieldname: 'entity',        fieldtype: 'Select',   options: ['VIC','ACT'], reqd: true, permlevel: 0 },
    { fieldname: 'status',        fieldtype: 'Select',   options: JOB_STATES, default: 'Won', permlevel: 0 },
    { fieldname: 'customer',      fieldtype: 'Link',     options: 'Customer', reqd: true, permlevel: 0 },
    { fieldname: 'quotation',     fieldtype: 'Link',     options: 'Quotation', permlevel: 0 },
    { fieldname: 'site_address',  fieldtype: 'Text',     permlevel: 0 },
    { fieldname: 'job_value',     fieldtype: 'Currency', permlevel: 0 },
    { fieldname: 'deposit_pct',   fieldtype: 'Float',    permlevel: 0 },   // gate stub
    { fieldname: 'balance_pct',   fieldtype: 'Float',    permlevel: 0 },   // gate stub
    { fieldname: 'mfg_paid',      fieldtype: 'Check',    permlevel: 0 },   // gate stub
    { fieldname: 'klaes_ref',     fieldtype: 'Data',     permlevel: 0 },   // deferred seam — leave unwired
    { fieldname: 'signoff_doc',   fieldtype: 'Data',     permlevel: 0 },   // deferred seam — leave unwired
    { fieldname: 'hold_reason',   fieldtype: 'Text',     permlevel: 0 },
  ],
  permissions: [
    { role: 'admin',     doctype: 'Job', permlevel: 0, read: true, write: true, create: true },
    { role: 'scheduler', doctype: 'Job', permlevel: 0, read: true, write: true, create: false },
    { role: 'sales',     doctype: 'Job', permlevel: 0, read: true, write: false, create: true },
  ],
};
```

- `Select` `options` as an **array** matches the existing toy-Job test (workflow.test.js:32) and `validate.js` Select handling — confirm against `validate.js` if the generator expects a `\n` string for live DDL; the **live proof (U6) is the authority** — if `migrate` rejects an array, U1 switches `options` to a `\n`-joined string and U6 re-confirms. (Unit-test path uses `registerDoctype` directly, array is fine.)
- **Do NOT** add `autoname`. Naming is the controller's job; an `autoname` here would race the controller (resolveName short-circuits only when `doc.name` is already set, naming.js:14 — the controller sets it first, so leave `autoname` absent).
- **Done-criteria U1:** the def imports clean; field names match the hook reads (`deposit_pct`/`balance_pct`/`mfg_paid`) char-for-char; `JOB_STATES[0]==='Won'`; `status.default==='Won'`.

### U2 — `src/doctypes/job/job.controller.js`

**FROZEN:**

```js
import { Document, registerController } from '../../runtime/document.js';
import { nextSeries } from '../../runtime/naming.js';
import { ValidationError } from '../../runtime/errors.js';   // confirm error class name in errors.js; if absent use StateError

export class JobController extends Document {
  async insert() {
    if (!this.doc.name) {
      const e = this.doc.entity;
      if (e !== 'VIC' && e !== 'ACT') {
        throw new ValidationError('Job.entity must be VIC or ACT'); // fail-fast BEFORE nextSeries
      }
      this.doc.name = await nextSeries(`${e}-.#####`, this.store);
    }
    return super.insert();
  }
}

registerController('Job', JobController);   // import-time side-effect — see Ground-truth #1
```

- **Implementer must verify** the error class: `import { ... } from '../../runtime/errors.js'` — Ground-truth shows `StateError`, `NotFoundError`, `PermissionError` exist; **check whether `ValidationError` exists**. If not, the controller throws `StateError` (still maps to 409, still fail-fast, still rolls back). FREEZE the *behaviour* (throw before `nextSeries`, message contains "VIC or ACT"); the exact class is implementer's read-confirm.
- **Registration is a module side-effect** — U5 and U6 MUST `import '.../job.controller.js'` (even if they don't name an export) so `newDoc('Job', …)` returns a `JobController` (document.js:175). Document this in U5/U6.
- `nextSeries(`${e}-.#####`, store)` → prefix `VIC-`/`ACT-`, width 5 → `VIC-00001` (naming.js:38-53). Independent counters per prefix (separate `tab_series` keys).
- **Done-criteria U2:** `newDoc('Job', {entity:'VIC',…}, store).insert()` yields `name` matching `/^VIC-\d{5}$/`; `entity:'ACT'` → `/^ACT-\d{5}$/`; `entity:'NSW'` (or missing) throws before any `store.insert`/`nextSeries` call (assert the series counter did NOT advance and no row was written).

### U3 — `src/doctypes/job/job.hooks.js`

**FROZEN — char-for-char action strings (must match U4 row `action` values):**

```js
import { WORKFLOW_HOOKS } from '../../workflow/hooks.js';

WORKFLOW_HOOKS.set('Job::start_measure', { condition: (doc) => Number(doc.deposit_pct) >= 5 });
WORKFLOW_HOOKS.set('Job::start_signoff', { condition: (doc) => Number(doc.balance_pct) >= 45 });
WORKFLOW_HOOKS.set('Job::to_scheduling', { condition: (doc) => doc.mfg_paid === true });
```

- Module side-effect (like the existing toy test's `WORKFLOW_HOOKS.set`). Consumers import this module for the effect.
- `Number(...)` coercion is FROZEN (guards string-typed stub values).
- **Done-criteria U3:** after import, `getHooks('Job','start_measure').condition({deposit_pct:5})===true`, `({deposit_pct:4})===false`; `getHooks('Job','to_scheduling').condition({mfg_paid:true})===true`, `({mfg_paid:'true'})===false` (strict `=== true`).

### U4 — `src/doctypes/job/job.workflow.seed.js`

Export a function that seeds the parent + 15 transition rows into a given store (so both U5 MemoryStore and U6 live PgStore call the same seeder — DRY). **FROZEN parent row** (matches prove-tx-rollback.mjs:139 + loadWorkflow lookup workflow.js:55,95):

```js
export const JOB_WORKFLOW_NAME = 'Job Workflow';

export const JOB_WORKFLOW_PARENT = {
  name: JOB_WORKFLOW_NAME,
  document_type: 'Job',
  workflow_state_field: 'status',
  docstatus: 0,
  idx: 0,
};
```

**FROZEN 15 transition rows** (idx-ordered; idx-1 `state:'Won'` ⇒ `initial='Won'`). Every row carries the child-link columns `parent:'Job Workflow', parenttype:'Workflow', parentfield:'transitions', docstatus:0`. `allowed` is a **plain string** for single-role, **`'\n'`-joined** for multi-role (workflow.js:79 `split('\n')` — NEVER `'admin, scheduler'`):

| idx | name | action | state | next_state | allowed | guard |
|---|---|---|---|---|---|---|
| 1 | job-wf-trans-01 | start_measure | Won | Measure | `admin` | 5% deposit must clear before site measure. |
| 2 | job-wf-trans-02 | start_signoff | Measure | Sign-off | `admin` | 45% of contract must clear before final sign-off. |
| 3 | job-wf-trans-03 | to_manufacturing | Sign-off | Manufacturing | `admin` | (none) |
| 4 | job-wf-trans-04 | to_scheduling | Manufacturing | Scheduling | `admin\nscheduler` | Manufacturing payment must clear before scheduling. |
| 5 | job-wf-trans-05 | to_install | Scheduling | Install | `admin\nscheduler` | (none) |
| 6 | job-wf-trans-06 | complete | Install | Complete | `admin\nscheduler` | (none) |
| 7 | job-wf-trans-07 | hold | Measure | Hold | `admin\nscheduler` | (none) |
| 8 | job-wf-trans-08 | hold | Sign-off | Hold | `admin\nscheduler` | (none) |
| 9 | job-wf-trans-09 | hold | Manufacturing | Hold | `admin\nscheduler` | (none) |
| 10 | job-wf-trans-10 | hold | Scheduling | Hold | `admin\nscheduler` | (none) |
| 11 | job-wf-trans-11 | resume | Hold | Measure | `admin\nscheduler` | (none) |
| 12 | job-wf-trans-12 | cancel | Won | Cancelled | `admin` | (none) |
| 13 | job-wf-trans-13 | cancel | Measure | Cancelled | `admin` | (none) |
| 14 | job-wf-trans-14 | cancel | Sign-off | Cancelled | `admin` | (none) |
| 15 | job-wf-trans-15 | cancel | Hold | Cancelled | `admin` | (none) |

Seeder contract (FROZEN signature):

```js
export async function seedJobWorkflow(store) {
  await store.insert('tabWorkflow', JOB_WORKFLOW_PARENT);
  for (const row of JOB_WORKFLOW_TRANSITIONS) await store.insert('tabWorkflowTransition', row);
}
```

(`JOB_WORKFLOW_TRANSITIONS` = the 15 row objects above, each spelled with `parent/parenttype/parentfield/docstatus`. Reference: the verbatim shape at ADR §4.3.)
- **Done-criteria U4:** after `seedJobWorkflow(store)` + a `transition()` load, `getWorkflow('Job',store).initial==='Won'`; row idx-4 `allowed.split('\n')` → `['admin','scheduler']` (length 2, NOT 1); every `action` in the table appears in the §2 U3 hook keys *iff* it is a gated action (start_measure/start_signoff/to_scheduling) — see test #7.

---

## 3. Vitest spec (U5) — `src/doctypes/job/job.workflow.test.js`

**Run mode:** `npx vitest run src/doctypes/job/job.workflow.test.js` (and full suite `npx vitest run` before done).

**Harness (mirror workflow.test.js:101-111):** `beforeEach` → `_resetRegistry()`, `_resetWorkflowCache()`, `new MemoryStore()`, `registerBootMeta()`, `registerDoctype(JobDef)`, `seedJobWorkflow(store)`. Import `../../doctypes/job/job.controller.js` **and** `../../doctypes/job/job.hooks.js` for their side-effects. Contexts: `admin` (unrestricted), `scheduler` (roles `['scheduler']`), `sales` (roles `['sales']`).

The 7 critique tests (each maps to a `it(...)`):

1. **Gated block + no audit row (test #1).** Create VIC Job `deposit_pct:0` (status defaults `Won`). `transitionDoc(admin,'Job',name,'start_measure',store)` → `rejects.toBeInstanceOf(StateError)`. Assert: re-read `status==='Won'` (unchanged) AND `store.list('tabWorkflowAction',{})` length 0. *(MemoryStore note: condition throws before `d.save()`/audit insert — workflow.js:145, so nothing was written even without rollback; true partial-write rollback is U6's job.)*
2. **Multi-role `allowed` path (test #2 — UNTESTED by prove scripts).** Walk an admin Job to `Manufacturing` (set `deposit_pct:5, balance_pct:45, mfg_paid:true`; fire start_measure→start_signoff→to_manufacturing as admin). Then `transitionDoc(scheduler,'Job',name,'to_scheduling',store)` SUCCEEDS → `status==='Scheduling'`. Plus a direct unit assert: `JOB_WORKFLOW_TRANSITIONS.find(r=>r.idx===4).allowed.split('\n')` deep-equals `['admin','scheduler']`.
3. **VIC/ACT naming + bad-entity fail-fast (test #3).** Create `entity:'VIC'` → `/^VIC-\d{5}$/`; `entity:'ACT'` → `/^ACT-\d{5}$/`; two VIC jobs → counter increments independently of ACT. `createDoc(admin,'Job',{entity:'NSW',customer,…})` → rejects (ValidationError|StateError) AND no `tabJob` row written for it.
4. **Held → resumed post-payment re-advance (test #4, F-6).** Admin Job with `deposit_pct:5, balance_pct:45, mfg_paid:true` walked to `Manufacturing`; `hold` (idx-9, Manufacturing→Hold) as scheduler; `resume` (idx-11, Hold→Measure) as scheduler; then `start_signoff` (Measure→Sign-off) and on to `to_scheduling` SUCCEED **without re-setting any payment field** — assert final `status==='Scheduling'`, no re-payment write.
5. **sales-cannot-transition 403 (test #5).** sales-owned Job (sales has create). `transitionDoc(sales,'Job',name,'start_measure',store)` → `rejects.toBeInstanceOf(PermissionError)` (raised at `assertCanMutate(ctx,'Job','write')`, service.js:100 — before the transition's own `allowed` check). Confirms sales has no `write` docperm.
6. **Initial state + status default (test #6, F-8).** `createDoc(admin,'Job',{entity:'VIC',customer,…})` **omitting `status`** → created `status==='Won'` (field default). After first `transition`, `getWorkflow('Job',store).initial==='Won'`.
7. **Gate-keys-resolve REGRESSION GUARD (test #7).** For each gated action `['start_measure','start_signoff','to_scheduling']`: assert `getHooks('Job',action).condition` is a function (hook attached) AND that action exists as a row `action` in `JOB_WORKFLOW_TRANSITIONS`. Inverse guard: assert no `WORKFLOW_HOOKS` `Job::*` key lacks a matching transition row (catches a future key typo silently ungating a money gate).

**Done-criteria U5:** all 7 green via `npx vitest run`; **the full suite `npx vitest run` stays green** (this is where C-1 bites — see §Collision).

---

## 4. Live proof (U6) — `scripts/prove-job.mjs` (human-gated)

Mirror `prove-quotation.mjs` (install via `migrate`) + `prove-tx-rollback.mjs` case C (seed Workflow live, exercise transitions on PgStore). Header comment: HUMAN-GATED, requires `.env` (DATABASE_URL, DATABASE_URL_POOLER, SUPABASE_*), the `next_series` migration applied. Run: `node --env-file=.env scripts/prove-job.mjs`.

Sequence (each a `check(...)`):
1. `registerBootMeta()`; `import '../src/doctypes/job/job.controller.js'`; `import '../src/doctypes/job/job.hooks.js'`.
2. `migrate(JobDef, pgStore, { admin: pgAdmin })` → installs `tabJob` via auto-DDL (confirms the Job DATA TABLE is created by migrate, no hand-written migration — ADR §2/§6). `ensure('Job', sbStore)` to hydrate meta (Customer Link target).
3. `seedJobWorkflow(pgStore)` live (or pre-clean + seed, re-runnable like prove-tx-rollback.mjs:238-244).
4. Pick a live Customer (`pgStore.list('tabCustomer',{})[0].name`).
5. `createDoc(admin,'Job',{entity:'VIC',customer,job_value:10000})` → name `/^VIC-\d{5}$/`, `status==='Won'`.
6. **Gate BLOCK (the headline live proof):** `deposit_pct` still 0 → `transitionDoc(admin,'Job',name,'start_measure',pgStore)` THROWS `StateError`; re-read `status==='Won'`; `tabWorkflowAction` has **no** row for this name (tx rolled back on PgStore — the real atomicity proof MemoryStore can't give).
7. `updateDoc(admin,'Job',name,{deposit_pct:5},pgStore)` then `transitionDoc(... 'start_measure')` SUCCEEDS → `status==='Measure'`, one audit row.
8. Walk the rest of the gates live (`balance_pct:45`→start_signoff→Sign-off; to_manufacturing; `mfg_paid:true`→to_scheduling→Scheduling) to prove the full chain + multi-role on a real DB.
9. Cleanup test rows (delete tabJob/tabWorkflow*/tabWorkflowAction for the proof names), re-runnable.

**Done-criteria U6:** script exits 0 with all checks ✓; the gate block at step 6 leaves **zero** audit rows (live rollback confirmed). **Not run automatically** — lead runs it with the user's go.

---

## 5. File-collision analysis (every editable target → exactly one unit)

| Path | Unit | New/Edit | Note |
|---|---|---|---|
| `src/doctypes/job/job.def.js` | U1 | NEW | leaf |
| `src/doctypes/job/job.controller.js` | U2 | NEW | self-registers controller |
| `src/doctypes/job/job.hooks.js` | U3 | NEW | self-registers 3 hooks |
| `src/doctypes/job/job.workflow.seed.js` | U4 | NEW | parent + 15 rows + `seedJobWorkflow` |
| `src/doctypes/job/job.workflow.test.js` | U5 | NEW | the 7 tests |
| `scripts/prove-job.mjs` | U6 | NEW | live proof |

**No existing engine source file is edited.** Each unit owns one new file → Group A is fully parallel-safe at the file level.

### C-1 (CRITICAL) — global `WORKFLOW_HOOKS['Job::start_measure']` collision with the pre-existing toy test
`src/workflow/workflow.test.js:18` already sets `WORKFLOW_HOOKS.set('Job::start_measure', { condition: doc => doc.deposit_paid === true })` at **module scope**, and registers a toy `Job` doctype. The new `job.hooks.js` sets the **same global key** to `deposit_pct >= 5`. `WORKFLOW_HOOKS` is one process-wide `Map`; vitest runs files in the same worker can share module state. **Risk:** whichever module loads last wins the key — one suite's gate silently reads the wrong field, producing a flaky/false pass.

**Resolution (FROZEN, pick exactly one — recommend option (a)):**
- **(a) RECOMMENDED — isolate the toy test's hook in its own `beforeEach`/`afterEach`.** Edit `workflow.test.js` to `WORKFLOW_HOOKS.set(...)` inside `beforeEach` and `WORKFLOW_HOOKS.delete('Job::start_measure')` in `afterEach`, and have the **new** U5 do the same (set its prod hooks in `beforeEach` via importing `job.hooks.js` is a load-time effect — instead, U5 should re-assert/reset). Simplest robust form: **both** test files set their needed `Job::*` hooks in `beforeEach` and clear all `Job::*` keys in `afterEach`. This makes hook state per-test, killing the order dependency. *(This is the one allowed edit to an existing file — assign it to U5's implementer as part of U5, and call it out so it isn't flagged as out-of-contract.)*
- **(b) Alternative — rename the toy.** Rename the pre-existing toy `Job` (and its `Job::start_measure` hook key) to `ToyJob`/`ToyJob::start_measure` in `workflow.test.js`, freeing the `Job::*` namespace for prod. Larger diff to an existing test; only if (a) proves insufficient.

**Either way, `npx vitest run` (full suite) MUST be green** — this is the U5 done-criterion that catches the collision. The lead should run the full suite after U5 lands, not just the new file.

### C-2 — `_resetRegistry()` / `_resetWorkflowCache()` discipline
Both test suites must `_resetRegistry()` + `_resetWorkflowCache()` in `beforeEach` (workflow.test.js:104-108 already does). U5 must too, or a stale toy-`Job` meta/workflow leaks across files. FROZEN into the U5 harness.

---

## 6. Composition go/no-go

| Check | Result |
|---|---|
| Interfaces line up (hook keys ↔ row actions ↔ field names) | ✅ `start_measure`/`start_signoff`/`to_scheduling` match across U3/U4; fields `deposit_pct`/`balance_pct`/`mfg_paid` match U1↔U3 |
| No dependency cycles | ✅ U1 leaf; U2/U3/U4 depend only on U1's frozen names; U5/U6 are read-only consumers |
| Controller actually wired | ✅ self-register side-effect + consumers import the module (Ground-truth #1) — resolved, not assumed |
| Naming contract satisfied | ✅ controller sets `doc.name` before `super.insert()`; `resolveName` short-circuits (naming.js:14); no `autoname` on the def |
| Initial state derivation | ✅ idx-1 `state:'Won'` + `status` default `'Won'` (workflow.js:97 / U1) |
| Multi-role `allowed` encoding | ✅ `'admin\nscheduler'`, never comma (workflow.js:79) |
| Sales has no dead transition | ✅ sales not in any `allowed`; no write docperm (ADR §2 F-7) |
| Block + rollback testable | ✅ unit asserts no-write-on-throw (MemoryStore); live asserts true rollback (U6/PgStore) |
| All 7 critique tests covered | ✅ §3 maps 1:1 |
| Only-collision identified + resolved | ✅ C-1 (global hooks Map) with a frozen fix assigned to U5 |

**Verdict: GO.** The plan composes; the one real buildability hazard (C-1 global-hook collision) is identified with a frozen, assigned resolution. No NO-GO conditions.

---

## 7. Notes / deferred (do NOT build this increment)
- `klaes_ref`, `signoff_doc` fields present but **unwired** (deferred seams, ADR §5).
- No `onTransition` side-effects in v1 (the slot stays empty).
- `availableActions` cold-cache caveat (F-5): no UI this increment, so not exercised; future surfaces must `await getWorkflow('Job',store)` first.
- `entity` scopeField is the VIC/ACT row-isolation seam — present, not yet enforced beyond scope filtering.
