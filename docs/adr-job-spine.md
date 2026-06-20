# ADR — Job Spine (first increment)

**Status:** Revised post-critique (FAIL → addressed; design only — awaiting re-critique)
**Date:** 2026-06-21
**Author:** architect
**Doctype:** `Job` — the operational system-of-record that replaces Ascora.
**Scope:** First increment. Simplified ~7-state lifecycle + 3 payment gates as stubs.
Real Xero/Zip, Klaes ingest, Documenso, scheduling integration are **deferred seams**.

**Revision note (R1, 2026-06-21):** addresses `docs/critique-job-spine.md` — F-1 (seed-row
vocabulary now `state`/`next_state`/`action`/`allowed`/`guard` with a verbatim seed example),
F-2 (`allowed` is `\n`-delimited, stated explicitly), F-3/F1b (mfg gate moved to `to_scheduling`),
F-7 (sales dropped from all transition `allowed` lists — sales is create-only), F-4/F-5/F-6/F-8
(folded as notes). Architecture unchanged (9 states, 3 gates as condition hooks, JobController
naming override, integrate-don't-rebuild seams).

---

## 1. Context & problem

`docs/ops-manual-coverage.md` (validated vs Ops Manual v3.1, 2026-06-18) establishes that the
real centre of gravity is a **Job**, not a Sales Order. Ascora today owns the Job record, a
**~15-state status machine**, and the document/booking spine. The engine's role is to **replace
Ascora** and become the Job spine; Pipedrive/Klaes/Xero remain feeders.

Two facts from the coverage doc are load-bearing and constrain the design:

- **Status machine ≠ `docstatus`.** Frappe's 0/1/2 submit/cancel axis cannot represent the
  operational states. The Job needs a **first-class custom `status` workflow** — exactly what the
  engine's `workflow.js` (data-driven `tabWorkflow`/`tabWorkflowTransition` + code hooks) provides.
  Job is therefore **NOT submittable** (`submittable: false`).
- **Payment-gated transitions** are core domain logic: 5% deposit before measure, 45% before
  sign-off, manufacturing payment before scheduling (coverage doc §"Architecture implications";
  Ops Manual Ch.1 §1.2, §3.1). These map directly onto the workflow's `condition` hooks.

This increment proves the engine's first **live business workflow** on the real spine, after the
Selling-slice masters proved the generator/runtime (`prove-quotation.mjs`, `prove-tx-rollback.mjs`).

---

## 2. The Job doctype (meta-as-data def)

Defined as a plain `DocMeta` and installed via `installer.migrate(JobDef, store, …)` —
identical shape/path to `prove-quotation.mjs`'s `QuotationDef`.

| Field | Type | Notes |
|---|---|---|
| `entity` | Select `VIC`/`ACT`, **reqd** | Drives the job-ID prefix (§3) + future financial routing. Also the row-scope field. |
| `status` | Select (workflow states), **default `'Won'`** | The workflow `stateField`. **NOT** `docstatus`. The explicit field default `'Won'` makes creation deterministic (F-8) and matches the workflow's derived initial state. |
| `customer` | Link → `Customer`, **reqd** | Existing Selling-slice master. |
| `quotation` | Link → `Quotation` | The quote artifact sits **beneath** the Job (coverage doc §"Architecture implications"). Optional — a Job can predate a formal quote. |
| `site_address` | Text | Install site. |
| `job_value` | Currency | Contract value; basis for the % gates. |
| `deposit_pct` | Float | **Gate stub** — % of deposit cleared. Real Xero feed deferred. |
| `balance_pct` | Float | **Gate stub** — % of contract cleared before sign-off. |
| `mfg_paid` | Check | **Gate stub** — manufacturing payment cleared. |
| `klaes_ref` | Data | **Deferred seam** — future Klaes ingest. Leave the field, don't wire it. |
| `signoff_doc` | Data | **Deferred seam** — future Documenso sign-off ref. |
| `hold_reason` | Text | Set on the `hold` transition. |

**Doctype attributes:** `submittable: false`, `autoname: <none>` (controller-driven — fork F1),
`scopeFields: ['entity']`. The `status` Select options are the 9 workflow states (§4); its
**default is `'Won'`** so a created Job lands in the initial state without the caller needing to
pass `status` explicitly (F-8).

**Payment-gate field set — rationale.** Three stub fields, one per gate, named for what they
gate, not for the eventual integration. `deposit_pct`/`balance_pct` are Floats (the manual gates
on percentages: 5%, 45%); `mfg_paid` is a boolean (the manufacturing gate is a cleared/not-cleared
event, not a percentage). This is the **smallest** set that expresses all three gates (KISS/YAGNI);
when Xero lands, these become fetched/computed rather than hand-set — the condition hooks don't
change.

### Docperms (permlevel 0)

| Role | read | write | create | transitions allowed (via transition-row `allowed`) |
|---|---|---|---|---|
| `admin` | ✓ | ✓ | ✓ | all |
| `scheduler` | ✓ | ✓ | — | `to_scheduling`, `to_install`, `complete`, `hold`, `resume` |
| `sales` | ✓ | — | ✓ | **none** — sales is create-only (F-7) |

**Two-layer gate, and why sales fires no transitions (F-7).** Doc-level create/write is the
docperm; **per-transition** role-gating is the transition row's `allowed` column (enforced inside
`transition()` at workflow.js:141). A role needs **both** `write` on the doctype **and** to be in
the transition's `allowed` list — and `transitionDoc` asserts `write` **first**
(`assertCanMutate(ctx,'Job','write')`, service.js:100) before the transition's own `allowed` check.
Sales has **create + read only, no `write`**, so any transition listing `sales` would 403 at the
write-gate before the `allowed` check ever runs — a dead transition. Therefore **sales appears in
no `allowed` list**: sales *creates* the Job (status `Won`); **admin** advances the whole chain and
**scheduler** drives the back half. (LEAD ruling F-7.)

`entity` as a `scopeField` is the seam for later VIC/ACT row-isolation (mirrors SpartanCRM's
`branchInScope`); admin runs `unrestricted`.

---

## 3. VIC/ACT-prefixed naming — decision

**Requirement:** `VIC-#####` vs `ACT-#####` chosen by `doc.entity` (coverage doc §"two legal
entities … job-ID prefixes").

**Constraint (verified in source).** `naming.js:resolveName` takes the doctype's **one static**
`meta.autoname` pattern; `Document.insert()` (document.js:54) calls it as
`if (!this.doc.name) this.doc.name = await resolveName(...)` **before** `beforeSave()` (line 61)
and before `#runChecks()`/`validate()` (line 60). **No controller hook fires before naming**, so a
`beforeSave`/`validate` override cannot influence the name.

**Options considered:**

| Option | Verdict |
|---|---|
| **A. Two doctypes** (`Job VIC` / `Job ACT`), each a static `autoname`. | Rejected — duplicates the whole def, workflow, perms (DRY violation); splits the spine in two. |
| **B. Teach `naming.js` an entity-conditional rule** (e.g. `entity:VIC-.#####\|ACT-.#####`). | Rejected for v1 — an engine fork to the shared naming contract for one doctype's quirk; widens blast radius (every doctype's autoname parse changes). YAGNI until a second doctype needs it. |
| **C. `JobController.insert()` sets `doc.name` from `nextSeries(prefix)` before `super.insert()`.** | **CHOSEN.** |

**Decision — Option C.** A `JobController extends Document`, registered via
`registerController('Job', JobController)`. Its `insert()` override:

```js
async insert() {
  if (!this.doc.name) {
    const e = this.doc.entity;
    if (e !== 'VIC' && e !== 'ACT') throw new ValidationError('Job.entity must be VIC or ACT'); // fail-fast
    this.doc.name = await nextSeries(`${e}-.#####`, this.store);
  }
  return super.insert();
}
```

Because `resolveName` short-circuits when `doc.name` is already set (naming.js:14 /
document.js:54), `super.insert()` keeps its full validate/link/child pipeline untouched.
`nextSeries` is already exported and directly callable (naming.js:38) and already has the atomic
per-prefix counter (separate `VIC-`/`ACT-` series keys, race-safe via the store RPC).

**Entity-reqd ordering (F-4) — the controller guard, not meta `reqd`, protects naming.** The
controller's explicit `e !== 'VIC' && e !== 'ACT'` check rejects a missing/empty/invalid `entity`
**before** the `nextSeries` call (fail-fast). The meta `reqd: true` on `entity` is enforced later,
inside `super.insert()` → `#runChecks()` → `validateAgainstMeta` (document.js:60/97) — i.e. **after**
naming. So `reqd` is a **second backstop**, not the guard that protects `nextSeries`. The
implementer must keep the controller's VIC/ACT guard; relying on meta `reqd` alone would let an
empty entity reach the prefix template.

**Why C satisfies the contract.** SoC (naming quirk lives in the Job controller, not the shared
runtime), Least surface (no engine fork), DRY (one Job def), Fail-Fast (rejects a bad entity
before any write), Idempotency-neutral (series counter is the existing atomic one). The controller
pattern is already proven live (`prove-tx-rollback.mjs` registers controllers via
`registerController`).

> **FORK F1 (flagged for LEAD):** Option C needs **no** `naming.js` change, but it does assume a
> controller may run code *before* `resolveName`. Today the only seam for that is overriding
> `insert()` wholesale (there is no `beforeNaming`/`autoname()` hook). If `critique`/LEAD prefers a
> narrower seam, the minimal engine touch is a `Document.autoname()` hook called inside `insert()`
> just before the `resolveName` line — an additive, opt-in change. **Recommendation: ship C as-is
> (no fork); revisit a named hook only if a 2nd doctype needs entity-conditional naming.**

---

## 4. The status workflow AS DATA (seed `tabWorkflow` + `tabWorkflowTransition`)

> **Vocabulary (F-1).** This section is written in the engine's **real row columns** as read by
> `loadWorkflow` (workflow.js:78-89): a transition row is keyed on **`state`** (the from-state),
> **`next_state`** (the to-state), **`action`**, **`allowed`**, **`guard`** — *not* `from`/`to`.
> Seed literally in these columns or no transition resolves.

### 4.1 The parent Workflow row (`tabWorkflow`)

Confirmed against `prove-tx-rollback.mjs` case C (the only proven seed shape):

```js
// tabWorkflow — one parent row
{
  name:                 'Job Workflow',
  document_type:        'Job',      // loadWorkflow's lookup key (workflow.js:55)
  workflow_state_field: 'status',   // the Job field the runtime reads/writes
  docstatus:            0,
  idx:                  0,
}
```

### 4.2 The transition rows (`tabWorkflowTransition`)

Each row is a child of the parent Workflow row (`parent:'Job Workflow'`,
`parenttype:'Workflow'`, `parentfield:'transitions'`). `loadWorkflow` sorts by `idx`, derives the
initial state from the **lowest-idx row's `state`** (workflow.js:68,96), so the `start_measure`
row MUST be `idx=1` for `initial='Won'`.

> **`allowed` encoding (F-2) — NEWLINE-delimited, not comma.** `loadWorkflow` parses roles with
> `t.allowed.split('\n')` (workflow.js:79). A multi-role value MUST be a `\n`-joined string —
> e.g. `"admin\nscheduler"`. A literal `"admin, scheduler"` parses as ONE role named
> `"admin, scheduler"` that nobody holds, 403-ing the transition for everyone including admin.
> The prove script only exercised single-role (`allowed:'admin'`), so the multi-role path is
> **untested** — implement must add coverage. Single-role rows are a plain string (`'admin'`).

| idx | action | state (from) | next_state (to) | allowed (`\n`-delimited) | gate (condition hook) |
|---|---|---|---|---|---|
| 1 | `start_measure` | Won | Measure | `admin` | **deposit_pct ≥ 5** |
| 2 | `start_signoff` | Measure | Sign-off | `admin` | **balance_pct ≥ 45** |
| 3 | `to_manufacturing` | Sign-off | Manufacturing | `admin` | — |
| 4 | `to_scheduling` | Manufacturing | Scheduling | `admin\nscheduler` | **mfg_paid === true** |
| 5 | `to_install` | Scheduling | Install | `admin\nscheduler` | — |
| 6 | `complete` | Install | Complete | `admin\nscheduler` | — |
| 7 | `hold` | Measure | Hold | `admin\nscheduler` | — |
| 8 | `hold` | Sign-off | Hold | `admin\nscheduler` | — |
| 9 | `hold` | Manufacturing | Hold | `admin\nscheduler` | — |
| 10 | `hold` | Scheduling | Hold | `admin\nscheduler` | — |
| 11 | `resume` | Hold | Measure | `admin\nscheduler` | — |
| 12 | `cancel` | Won | Cancelled | `admin` | — |
| 13 | `cancel` | Measure | Cancelled | `admin` | — |
| 14 | `cancel` | Sign-off | Cancelled | `admin` | — |
| 15 | `cancel` | Hold | Cancelled | `admin` | — |

### 4.3 Verbatim seed-row examples (so implement seeds them literally)

```js
// idx 1 — start_measure (Won -> Measure), single-role, payment-gated.
{
  name:        'job-wf-trans-01',          // any stable unique id
  parent:      'Job Workflow',
  parenttype:  'Workflow',
  parentfield: 'transitions',
  action:      'start_measure',
  state:       'Won',                       // FROM  (not `from`)
  next_state:  'Measure',                   // TO    (not `to`)
  allowed:     'admin',                     // single role -> plain string
  guard:       '5% deposit must clear before site measure.',
  idx:         1,
  docstatus:   0,
}

// idx 4 — to_scheduling (Manufacturing -> Scheduling), MULTI-role, mfg-payment-gated.
{
  name:        'job-wf-trans-04',
  parent:      'Job Workflow',
  parenttype:  'Workflow',
  parentfield: 'transitions',
  action:      'to_scheduling',
  state:       'Manufacturing',
  next_state:  'Scheduling',
  allowed:     'admin\nscheduler',          // F-2: NEWLINE-delimited, never 'admin, scheduler'
  guard:       'Manufacturing payment must clear before scheduling.',
  idx:         4,
  docstatus:   0,
}
```

The other 13 rows follow the same shape with the values from the §4.2 table. The general transition
row contract is therefore:
`{name, parent:'Job Workflow', parenttype:'Workflow', parentfield:'transitions', action, state, next_state, allowed:'role\nrole', guard, idx, docstatus:0}`.

### 4.4 Notes

- **The 3 gates sit on the manual's clearance points:** 5% → entering Measure (`start_measure`),
  45% → entering Sign-off (`start_signoff`), **manufacturing payment → entering Scheduling
  (`to_scheduling`, idx 4)** — per LEAD ruling F1b. This matches the field semantics: `mfg_paid` =
  "manufacturing payment cleared," gated *before you can schedule the install*, not before
  manufacturing starts. (`to_manufacturing`, idx 3, is now ungated.)
- **`hold` is multi-row** (one per holdable from-state) because the engine matches transitions by
  `(state, action)` (workflow.js:138) — there is no wildcard `state`. `resume` returns to
  `Measure` as the v1 simplification (a fuller machine would resume to the pre-hold state —
  deferred). **F-6 side effect:** a Job held from Manufacturing/Scheduling resumes to Measure and
  re-crosses the `start_signoff`/`to_scheduling` gates. No money is lost — `mfg_paid` is a Check
  that stays `true` and `deposit_pct`/`balance_pct` persist — so the gates re-pass in practice.
  **Implement must add a test:** a held-then-resumed post-payment Job re-advances through the gates
  without re-payment.
- **`cancel`** is admin-only and reachable from the early/held states. Once `Manufacturing`+,
  cancel is intentionally **not** offered in v1 (money/material committed — a variation/red-tag
  path, deferred per coverage doc P7).
- The full ~15-operational-state machine (the manual's `a`/`b`/`c.2`/`d.1`–`d.5`/`e`/`f`/`g`) is a
  **later extension** — these 9 states are the locked first increment.
- **Initial state is derived, not declared (F-8).** `loadWorkflow` sets `initial =
  transRows[0].state` after sorting by `idx`. Keeping `start_measure` at `idx=1` yields
  `initial='Won'`. This is fragile to idx reordering, which is *why* §2 sets the `status` field
  **default `'Won'`**: creation sets the state deterministically from the field default rather than
  relying on `wf.initial` (which `transition()` only uses as a nullish backstop, workflow.js:137).

### Condition hooks AS CODE (`workflow/hooks.js`)

The declarative parts are rows; the gate **closures** live in `WORKFLOW_HOOKS`
(keyed `"Job::<action>"`). Guard text lives on the transition **row** (`guard` column), surfaced by
`transition()` when the condition returns false (workflow.js:147).

```js
WORKFLOW_HOOKS.set('Job::start_measure', { condition: (doc) => Number(doc.deposit_pct) >= 5 });
WORKFLOW_HOOKS.set('Job::start_signoff', { condition: (doc) => Number(doc.balance_pct) >= 45 });
WORKFLOW_HOOKS.set('Job::to_scheduling', { condition: (doc) => doc.mfg_paid === true }); // F-3: moved off to_manufacturing
```

| Hook key | Condition | Guard message (on the matching row) |
|---|---|---|
| `Job::start_measure` | `deposit_pct >= 5` | "5% deposit must clear before site measure." |
| `Job::start_signoff` | `balance_pct >= 45` | "45% of contract must clear before final sign-off." |
| `Job::to_scheduling` | `mfg_paid === true` | "Manufacturing payment must clear before scheduling." |

The hook key's action string must match the seed row's `action` **character-for-character**
(`getHooks` does `WORKFLOW_HOOKS.get(`${doctype}::${action}`)`, hooks.js:35) — so `to_scheduling`
in both the hook and the idx-4 row.

`Number(...)` coercion guards against a string-typed stub value. No `onTransition` side-effects in
v1 (the deferred seams — Klaes enqueue, Documenso send, scheduling — are where those hooks land
later; the slot exists, we leave it empty). When Xero/Zip integration lands, the **condition body**
can read a payment ledger via the `store` arg (cross-doc gate, exactly the pattern workflow.js:146
passes `store` for) — the hook signature already supports it; no contract change.

---

## 5. Entry & integration seams

**Creation (status = Won).** A Job is created via `createDoc(ctx, 'Job', {…})` from a **Won deal**
(Pipedrive/Sales). With `status` defaulting to `'Won'` (§2/F-8), the caller need only set `entity`,
`customer` (Link, required), and optionally `quotation` (the quote artifact re-parented beneath the
Job per coverage doc). This is the ordinary service-layer create path — no special entry point —
with the JobController supplying the VIC/ACT name (§3).

**`availableActions` cold-cache caveat (F-5).** `availableActions` (workflow.js:178) reads the
module-scope cache **synchronously** and returns `[]` if no `transition()` has loaded the Job
workflow into that lambda instance yet. Out of scope this increment (no UI), but the planner must
note: any future surface listing actions must first `await getWorkflow('Job', store)` (or have
fired a transition) — otherwise it silently shows no actions on a cold lambda.

**Deferred seams (leave the Link/slot, do NOT build now):**

| Seam | Where it attaches | Deferred to |
|---|---|---|
| Klaes manufacturing ingest | `klaes_ref` field + a future `onTransition` on `to_manufacturing` | coverage doc module 6 (Klaes integration — ingest, not MRP rebuild) |
| Documenso final sign-off | `signoff_doc` field + future `onTransition` on `start_signoff` | P5 / Final Sign-Off tool |
| `factory_red_tags` | a future cancel/variation path from Manufacturing+ | P14 (integrate existing table, don't rebuild) |
| Scheduling / Job Traveler / bookings | `to_scheduling`/`to_install` onTransition | coverage doc module 5 |
| Real payment gates (Xero/Zip) | the 3 condition bodies (read ledger via `store`) | coverage doc module 2 (Accounts) |

Each is a clean attach-point: a field already present, or an empty `onTransition`/`condition` slot
the runtime already calls. **No half-built integration ships this increment.**

---

## 6. Reuse vs new map

| Concern | Status | Evidence |
|---|---|---|
| `transitionDoc` (tx-wrapped, role+scope gate) | **reuse as-is** | service.js:98-106; proven in prove-tx-rollback case C |
| `transition()` runtime (role-gate → condition-gate → save → onTransition → audit) | **reuse as-is** | workflow.js:133-168 |
| `tabWorkflowAction` audit row | **reuse as-is** | workflow.js:157-166 |
| Workflow def loaded from `tabWorkflow`/`tabWorkflowTransition` | **reuse as-is** | workflow.js:48-103 |
| `getHooks('Job', action)` reattach by key | **reuse as-is** | workflow.js:84, hooks.js:34 |
| `installer.migrate` / `syncDoctype` / `emitMigration` | **reuse as-is** | installer.js; prove-quotation |
| `nextSeries` atomic series | **reuse as-is** | naming.js:38 |
| docperm role + scope gating | **reuse as-is** | permissions.js |
| **Job DocMeta def** | **NEW** | this ADR §2 |
| **JobController (entity naming)** | **NEW** | §3, fork F1 |
| **Job Workflow rows (seed)** | **NEW (data)** | §4 — parent + 15 transitions |
| **Job condition hooks** | **NEW (code)** | §4 |

**Engine gaps the Job spine needs that don't exist yet:** *none that block this increment.* The
only candidate is the optional `Document.autoname()` hook (fork F1) — and Option C deliberately
avoids needing it. Everything else (workflow runtime, audit, naming series, perms, installer) is
already built and proven. This increment is the **first live proof** of the workflow runtime on a
real domain doctype — and the first exercise of the **multi-role `allowed`** path (F-2), which the
prove scripts never covered.

---

## 7. Design-contract compliance

- **DRY** — one Job def/workflow/perm set; entity prefix via series keys, not duplicated doctypes.
- **KISS** — 9 states, 3 gates, one controller override. No speculative integration code.
- **YAGNI** — gate fields are stubs; Klaes/Documenso/Xero are empty seams, not built.
- **SOLID/SoC** — declarative workflow in data, gate logic in code hooks, naming quirk in the
  controller, perms in docperms; each concern in its own layer, none leaking into the runtime.
- **Least Privilege** — sales create-only (fires no transitions, F-7), scheduler scoped to the back
  half, cancel admin-only; `entity` scopeField seams VIC/ACT isolation.
- **Idempotency** — install path is idempotent (CREATE IF NOT EXISTS, upsert-by-name, set version);
  series counter is the existing atomic one.
- **Fail-Fast** — controller rejects a non-VIC/ACT entity before any write; condition gates throw
  `StateError` (→ 409) with the row's guard text and roll the tx back (proven: prove-tx-rollback).

---

## 8. Citations

- **Job-is-the-spine, status≠docstatus, payment gates, VIC/ACT prefixes, integrate-don't-rebuild:**
  `docs/ops-manual-coverage.md` §"The decisive finding", §"Architecture implications" (Ops Manual
  v3.1 Ch.1 §1/§1.2/§3.1, Ch.2 §1, Ch.3 §2).
- **Replace Ascora / Job spine module order:** coverage doc §"Decisions taken (2026-06-18)",
  §"Recommended module order".
- **Frappe workflow model (data rows + code hooks, state field separate from docstatus):** engine
  `workflow.js`/`hooks.js` — the Frappe `tabWorkflow`/`tabWorkflowTransition` + `WORKFLOW_HOOKS`
  pattern. Proven live in `scripts/prove-tx-rollback.mjs` (case C) and `scripts/prove-quotation.mjs`.

## 9. Forks (for LEAD)

- **F1 — entity-conditional naming via controller `insert()` override.** Recommended as-is (no
  engine change). Alternative narrower seam (`Document.autoname()` hook) flagged but **not**
  recommended for v1. *Decision needed: accept Option C, or request the hook.*
- **~~F1b — mfg-gate placement.~~ RESOLVED (LEAD ruling F-3):** the mfg-payment gate is on
  **`to_scheduling`** (Manufacturing → Scheduling, idx 4) — "manufacturing payment before
  scheduling." `to_manufacturing` is ungated. Reflected in §4.2/§4.4 and the hooks block.
