# Critique: Integrity Layer (Pass B) — atomic naming series + real transactions

- **Reviewer:** critique
- **Date:** 2026-06-20
- **Under test:** `docs/adr-integrity-layer.md` + `diagrams/integrity-layer-class.puml`
- **Method:** Read/Grep of the touched runtime + meta + api code; no codegraph (engine repo).

---

## VERDICT: **FAIL** — two make-or-break holes + one missed dependent must be resolved before planner.

Decision 1 (atomic `next_series`) is **sound and ships as designed**. Decision 2 (real
transactions) has the right *shape* (a `PgStore` that is a `Store` with a real `transaction(fn)`)
but the ADR **under-specifies the two seams that make atomicity real**, and **misses a third
multi-write op** that is just as non-atomic as the two it names. Findings F1–F3 are blocking;
F4–F7 are required fixes/clarifications; the open question is resolved below.

---

## What is sound (no change needed)

- **Decision 1 / `next_series`.** The single-statement `INSERT … ON CONFLICT DO UPDATE …
  RETURNING` is genuinely atomic, needs no advisory lock, and — crucially — needs **no direct-PG
  connection**: `SupabaseStore.nextSeries` via `sb.rpc('next_series',{prefix})` is correct and
  closes the race at `naming.js:38-48` exactly where the existing header comment (`naming.js:29-33`,
  `supabase-store.js:5-13`) promised. The additive `Store.nextSeries() => null` default + the
  `naming.js` "prefer-then-fallback" snippet keep MemoryStore and every existing caller working.
  `resolveName`/`Document.insert` untouched. **PASS.**
- **DDL ≠ data-tx separation.** Keeping DDL on the session pooler via the existing `PgAdmin`
  (`pg-admin.js`) and only wrapping row-writes in the transaction pooler is the right call;
  the `migrate()` ordering (DDL → tx'd rows → bump) preserves `installer.js:184-197`'s contract.
- **`prepare:false` on the transaction pooler.** Correct and mandatory for PgBouncer txn mode;
  `PgAdmin.fromEnv` (`pg-admin.js:30`) already proves the pattern.

---

## BLOCKING findings

### F1 (BLOCKING) — Transaction does not propagate into `onSubmit` side-effect docs. The "transaction" is a lie the moment a controller creates another doc.

This is the make-or-break seam (lead question 2) and the ADR does not close it.

The ADR's wiring (lines 181-192) wraps the submit thus:
```js
await store.transaction(async (txStore) => {
  const d = await loadInScope(ctx, doctype, name, txStore);
  await d.submit();
});
```
`loadInScope → loadDoc → newDoc(doctype, doc, txStore)` (`document.js:175`, `service.js:25-29`)
correctly binds **the submitted doc's** `this.store = txStore`. So `save()` (parent + children,
`document.js:53-77`) runs on the tx. Good — for *that* doc.

But `SubmittableDocument.submit()` calls `await this.onSubmit()` (`document.js:132`). `onSubmit`
is the documented place for **post-commit side-effects** — in Frappe these create OTHER documents
(GL entries, stock ledger, etc.). A real controller will do `await newDoc('GL Entry', …, ???).insert()`
inside `onSubmit`. **Nothing in the design specifies what store that side-effect `newDoc` receives.**
The base `Document` has no handle to "the store I was constructed with is the tx store" that an
`onSubmit` override can reach except `this.store` — and the ADR says **"Document … are unchanged."**

So an `onSubmit` author has two ways to get a store, both wrong-by-default:
- uses `this.store` → that IS `txStore` (works) — **but only if the design makes that contract
  explicit and the controller actually uses `this.store`, not a captured outer `store`**;
- captures the outer `store` from a closure / imports `SupabaseStore.fromEnv()` → commits
  **outside** the tx, so a later throw rolls back the parent but **not** the side-effect.

**The codebase makes this latent, not yet live:** `onSubmit()` is an empty hook (`document.js:34`)
and **no controller overrides it** (Grep: only the base definition + the call site exist). So no
test will catch this today — which is exactly why it must be nailed in the contract *now*, before
the first real `onSubmit` ships and silently half-commits.

**Required fix (architect):** State the propagation contract explicitly in the ADR + class diagram:
> Inside `transaction(fn)`, the doc and **every** `newDoc(...)` an `onSubmit`/`onTransition` hook
> creates MUST be constructed with the tx-bound store. The enforced rule is: **hooks obtain their
> store from `this.store` only** (never a captured outer `store`, never `*.fromEnv()`), and the
> service passes `txStore` as the `store` for any side-effect doc it creates on the doc's behalf.

Add this as a one-line invariant on `SubmittableDocument.onSubmit` in `document.js`'s JSDoc and a
note on the class diagram (currently the diagram says only "post-commit side-effects" at line 63,
which is now actively misleading — under a tx they are *in*-commit). Without this written
contract, F1 is unprovable and the atomicity claim in "Consequences" (ADR 287) is false.

### F2 (BLOCKING) — Missed dependent: `transitionDoc` / `workflow.transition()` is a 3-write op and is NOT wrapped.

The ADR explicitly lists `transitionDoc` among the ops that **stay on the plain `SupabaseStore`**
("All read paths … and `updateDoc`/`createDoc` … stay on the plain `SupabaseStore`", ADR 198;
the class diagram puts `transitionDoc` in `service` with no tx note). But `transition()` is
**multi-write and exactly as non-atomic as `submit()`**:

`src/workflow/workflow.js:133-155`:
- `await d.save();`                         (workflow.js:151) — parent row + delete/reinsert children
- `await t.onTransition(d.doc, ctx, store)` (workflow.js:152) — **side-effect hook**, same F1 problem
- `await store.insert(LOG_TABLE, …)`        (workflow.js:154) — writes `tabWorkflowAction`

If `onTransition` throws after `d.save()`, or the audit-log insert fails, the doc state has moved
but the side-effect and/or the audit row are missing — a half-applied transition, the very class
of bug Decision 2 exists to kill. The diagnosed root cause ("multi-write ops that must be
all-or-nothing") **applies to `transition()` and the ADR did not account for it.**

**Required fix (architect):** Either (a) wrap `transitionDoc` in `store.transaction` exactly like
`submitDoc` (preferred — DRY with F1's propagation rule, and `transition()` already threads `store`
to `onTransition` at workflow.js:152 so the txStore flows through), or (b) explicitly justify in
the ADR why a workflow transition is allowed to be non-atomic (it should not be). Update the
class diagram `service` note and the module-layout table (ADR 244-267) to include
`transitionDoc` + the workflow audit-log write.

### F3 (BLOCKING) — Store-selection ("how does the op get a `PgStore`?") is hand-wavy; the connection-split-mid-op question is unanswered.

Lead question 1. The handler (`handler.js:30`) receives **one** `store` and threads it into
every service call (`handler.js:52-65`). The ADR says "the handler stays the place that *chooses
the store*" and "for a write op it can hand the service a tx-capable store" (ADR 201-204) — but
**there is no concrete mechanism**. Three sub-gaps:

1. **Where does the `PgStore` come from at request time?** The handler is given a store by the
   Vercel route; the ADR never shows the route/handler constructing or selecting a `PgStore` vs
   `SupabaseStore` per op. "It can hand the service a tx-capable store" is aspiration, not design.
   Pin it: does `handle()` gain a second `txStore` param? Does it call `store.transaction` only
   when the store *is* PgStore? Does the route pass *both* stores?

2. **Connection split mid-op.** If reads stay on `SupabaseStore` and writes on `PgStore`, then
   inside `submitDoc` the ADR's own snippet does `loadInScope(ctx, …, txStore)` — i.e. the read
   ALSO runs on the PgStore tx connection. That's actually correct (read-your-writes within the
   tx), **but it contradicts** the ADR's repeated "reads stay on SupabaseStore" framing (ADR
   198-199, 121). The design must state plainly: **for a transactional op, the load happens on the
   tx connection too** (so it is NOT a connection split — the whole op is on PgStore). Right now
   the ADR asserts both things and the reader can't tell which is true. The class-diagram note
   "reads/simple CRUD stay on SupabaseStore" (line 49) needs the carve-out: *reads that are part
   of a transactional op run on the tx store.*

3. **`syncDoctype` store.** `installer.js:146-147` does `newDoc('DocType', …, store).save()`.
   For the meta-row tx, that `store` must be the PgStore/txStore. `migrate()` (`installer.js:184`)
   takes a single `store` param and also calls `bumpMetaVersion(store)` (195). Is `bumpMetaVersion`
   in or out of the tx? (It's a single write — probably out, but the ADR doesn't say, and if it's
   inside the wrapped `syncDoctype` boundary vs a separate call matters.) Specify the exact
   `store`/`txStore` threading through `migrate → syncDoctype → bumpMetaVersion`.

**Required fix (architect):** Add a short "store wiring" subsection with the concrete signatures:
how `handle`/the Vercel route obtains a `PgStore` (lazy singleton via `PgStore.fromEnv()` reading
`DATABASE_URL_POOLER`), which ops call `store.transaction`, and an explicit statement that a
transactional op runs its **load + all writes** on the tx-bound store (no split). This is the
seam the planner needs frozen before fan-out.

---

## REQUIRED fixes / clarifications (non-blocking but must land)

### F4 — Open question resolved: `SupabaseStore.transaction` must **THROW**, not no-op.

The ADR's design body picks the **no-op** (`fn(this)`, ADR 132-135, class diagram line 41 even
says "NOT supported -> delegates … see service wiring", which is inconsistent with the body's
`fn(this)`). The Open Question (ADR 295-303) leans throw. **Resolve to THROW.** Rationale tied to
this codebase:

- `Store` base already **throws** on every unimplemented method (`store.js:19-34`) — "fails loudly
  rather than silently no-op'ing a write" (store.js:14-16). A best-effort no-op `transaction`
  **violates the established contract of this very file.** Fail-Fast is the house style here.
- F1/F2/F3 all hinge on the *write path being wired to a PgStore*. A silent `SupabaseStore`
  no-op is precisely how a future caller (or a hurried `implement` agent) ships a "transactional"
  submit that isn't — the no-op makes the F1 lie invisible. Throwing makes mis-wiring a startup/
  request error, not a silent data-integrity bug.
- The base default stays `transaction(fn) => fn(this)` (so MemoryStore inherits a working
  no-op for tests — see F5), but **`SupabaseStore` overrides it to throw**
  `new Error('SupabaseStore has no transactions — route atomic ops through PgStore')`.

Update ADR Decision-2, the class diagram (line 41), and the module-layout table (ADR 251-252,
which currently says SupabaseStore.transaction is an "honest no-op") to THROW.

### F5 — MemoryStore.transaction must be a pass-through, or the 224 tests break (confirmed risk).

Lead question 4. I traced the existing submit/transition tests:
- `service.test.js:94-100` (`submitDoc` happy path) calls `submitDoc(manager, 'Job', …, store)`
  with a `MemoryStore`. With the ADR's `submitDoc` now wrapping in `store.transaction`, this
  test **only stays green if `MemoryStore.transaction(fn)` resolves `fn(this)`**.
- `immutability.test.js` and `document.test.js` call `doc.submit()`/`save()` directly on a doc
  bound to MemoryStore — they bypass the service wrapper, so they're unaffected by the wrapper
  itself, but any test that goes through `submitDoc`/`transitionDoc` (service.test, handler.test,
  workflow.test) **must** see a no-op pass-through.

So: **base `Store.transaction(fn) => fn(this)` and MemoryStore inherits it (or overrides
identically).** The ADR has this right (ADR 126-128, class diagram 28/35) — just confirming it is
load-bearing and must be stated as "MemoryStore pass-through is REQUIRED for the existing suite,"
not "acceptable." If F2 lands (wrap `transitionDoc`), re-confirm `workflow.test.js` (6 tests)
goes through MemoryStore.transaction as a pass-through too.

### F6 — New `DATABASE_URL_POOLER` env must go through the existing `env-schema.js` pattern.

The ADR introduces `DATABASE_URL_POOLER` (ADR 222-224) but does not mention
`src/validation/env-schema.js`, which is the established home for env validation and deliberately
keeps **two separate schemas** (`EnvSchema` for SupabaseStore, `PgAdminEnvSchema` for DATABASE_URL,
env-schema.js:3-22) with lazy `loadEnv`/`loadPgAdminEnv` throwing plain Errors. `PgStore.fromEnv`
must follow the same pattern: a `PgStoreEnvSchema`/`loadPgStoreEnv` validating `DATABASE_URL_POOLER`,
called lazily inside `fromEnv` (so MemoryStore-only tests are unaffected — validation.test.js:297
asserts `loadEnv` must NOT demand the PG var). **Required:** ADR module-layout must add the
`env-schema.js` MOD line and state PgStore.fromEnv uses a third lazy schema. Otherwise `implement`
will either bypass the validated-env discipline or break the B2 separation the suite enforces.

### F7 — PgStore parity surface is real and under-quantified; specify the row-shape contract.

Lead question 3. `PgStore` must implement the **full** `Store` contract via raw SQL:
`get`/`insert`/`update`/`list`/`getChildren`/`deleteChildren` (`store.js:17-35`) **plus**
`nextSeries`/`transaction`. Parity risks against `SupabaseStore` that the ADR doesn't address:

- **Return shapes.** `SupabaseStore.insert/update` return `…select().single()` — the **full row
  as stored** (`supabase-store.js:37,43`). `Document` relies on this in places and `createDoc`
  returns it via `maskRead`. Raw `postgres` lib returns rows from `RETURNING *`; PgStore must
  `INSERT … RETURNING *` / `UPDATE … RETURNING *` to match, not return the input row.
- **`get` null contract.** `SupabaseStore.get` returns `data ?? null` (supabase-store.js:33);
  PgStore must return `null` (not `undefined`, not `[]`) for a miss — `loadDoc` (document.js:167)
  and `save`'s existing-row check (document.js:58) branch on it.
- **`list` opts.** filters (eq), `order.desc`, `range` offset/limit with the same inclusive
  semantics as `supabase-store.js:48-59` (`range(off, off+limit-1)`); off-by-one here diverges
  from MemoryStore (memory-store.js:33-49) and the PostgREST path.
- **Child filters.** `getChildren`/`deleteChildren` filter on exactly `parent`+`parenttype`+
  `parentfield` (supabase-store.js:61-72) — the column names must match the meta machinery
  (`document.js:102-118` writes those columns).
- **Column quoting.** Tables are `tabXxx` and columns include reserved-ish words (`unique`,
  `read`, `write`, `create`, `submit`, `cancel`, `delete` on tabDocPerm — installer.js:132-143);
  raw SQL must quote identifiers. PostgREST hid this; raw PG won't.

**Required:** ADR must state PgStore is a **full parity reimplementation** (≥8 methods) with
`RETURNING *` on writes, `null`-on-miss, identical list/child semantics, and a parity test that
runs the **same assertions** against PgStore and SupabaseStore (or at least MemoryStore-equivalent
shape assertions). This is the largest single chunk of the build — planner should size it as its
own class with its own test, not a footnote to "transactions."

### F8 — Serverless pooling: mostly fine, two things to assert.

Lead question 5. `sql.begin` on the **transaction pooler (:6543)** with `prepare:false` is safe —
that is the supported PgBouncer-txn-mode pattern, and `PgAdmin` already uses `postgres()` with
`prepare:false` (pg-admin.js:30). The lazy module-scope singleton (`max:1`) is the right warm-lambda
pattern. Two assertions to add to the ADR:
- **`max:1` + a long-running tx can serialize concurrent invocations on a warm lambda.** With
  `max:1`, two overlapping requests on the same warm instance queue on the single client. For
  short submit txns this is acceptable, but state it (and consider `max` ≥ a small N, with
  `idle_timeout`, so warm concurrency isn't fully serialized). Not blocking, but name the tradeoff.
- **No `prepared statement does not exist`** risk *because* `prepare:false` — good. Just keep
  `PgStore.nextSeries`'s `SELECT next_series($1)` as a parameterized non-prepared query
  (the `postgres` lib does this with `prepare:false`); don't reintroduce `.prepare()`.

### F9 — Rollback proof is required and not yet specified (testing strategy gap).

Lead question 6. The hermetic story is fine: MemoryStore pass-through keeps the 224 green and
proves *logic*. But **nothing proves rollback actually rolls back** — and rollback is the entire
point of Decision 2. There is no `prove-*.mjs` named in the ADR. **Required:** the plan must
include a live rollback proof against the real transaction pooler — e.g. a script that submits a
doc whose `onSubmit` deliberately throws, then asserts the parent row + children are **absent**
(rolled back), and a second that asserts a successful submit committed all of them. Without this,
"submit becomes all-or-nothing" (ADR 287) is asserted, never demonstrated. Mark it a required
deliverable for `implement`, gated on human-confirmed DB access (CLAUDE.md §1 — the script
connects to prod-adjacent infra; surface it, don't auto-run).

---

## Minor / map-hygiene

- **Class-diagram line 41** (`SupabaseStore.transaction: NOT supported -> delegates …`) and the
  ADR body's `fn(this)` no-op **disagree**. F4 resolves both to THROW — make them consistent.
- **Class-diagram line 63** ("post-commit side-effects") becomes misleading once `submit` is in a
  tx (they're in-commit). Reword per F1.
- The `next_series` migration filename in the ADR is `<ts>_next_series_fn.sql` — confirm it uses a
  **full timestamp** (CLAUDE.md migrations rule: never date-only), and that `grant execute … to
  service_role` is present (ADR has it) so the `rpc()` path works under the service-role key.

---

## Contract compliance summary

| Clause | Verdict |
|---|---|
| DRY | OK — one `next_series`, one `Store` contract; F2 fix keeps tx wrapping DRY across submit/transition |
| KISS / YAGNI | OK — option (a) over (b); atomicity confined to the ops that need it (now correctly including transition, F2) |
| SOLID / SoC | OK in intent; F3 must make the store-selection seam concrete or SoC is only on paper |
| Least Privilege | OK — service_role already bypasses RLS; no new privilege surface (ADR 35-40 correct) |
| Idempotency | OK — `create or replace` + `on conflict`; DDL `IF NOT EXISTS` |
| Fail-Fast | **VIOLATED by the no-op** — F4 (SupabaseStore.transaction must throw) restores it |

---

## One-line verdict

**FAIL** — Decision 1 ships as-is; Decision 2 must (F1) write the onSubmit/onTransition store-
propagation invariant, (F2) wrap the missed `transitionDoc` multi-write op, and (F3) make store
selection concrete; resolve the open question to **THROW** (F4); plus F5–F9 required before planner.


---

# REV-2 RE-REVIEW (2026-06-20)

Against ADR rev 2 + class diagram rev 2, verified each finding against the live
`document.js`, `workflow.js`, `service.js`, `handler.js`, and the 19 test files.

## VERDICT: **FAIL** — one residual blocker (R1); everything else genuinely closed.

Rev 2 is a strong revision: F1, F2, F4, F6, F7, F8, F9 and the §2.7 deferral are all properly
closed against the code. But the F3 store-selector as specified **breaks `handler.test.js`** —
the F5 "224 stay green" claim was traced only at the service layer and misses the handler-layer
collision. One anchored blocker (R1) plus one must-fix consistency note (R2).

## RESIDUAL BLOCKER

### R1 (BLOCKING) — The F3 handler store-selector collides with F5: `handler.test.js` passes a MemoryStore through `handle()` and expects submit/action to work hermetically.

The seam the design froze in §2.4 / diagram line 107: for `submit`/`cancel`/`action`, **the handler
resolves `pgStore()` (lazy singleton -> `PgStore.fromEnv()` -> `loadPgStoreEnv(DATABASE_URL_POOLER)`)
and dispatches the service op with it, ignoring the passed store.** But the existing test does:

- `handler.test.js:30` — `store = new MemoryStore()`
- `handler.test.js:71-77` — `handle({…, body:{action:'submit'}, ctx: rep}, store)` expects **403**;
  `handle({…, body:{action:'frobnicate'}}, store)` expects **409** (StateError, no workflow).

If `handle()` unconditionally swaps to `pgStore()` for these ops, then in the hermetic test (no
`DATABASE_URL_POOLER` set) `pgStore()` throws at env-load (F6's `loadPgStoreEnv`), so the dispatch
gets a **500 env error**, not 403/409 — OR, if env happened to be set, it would open a real DB
socket in a unit test. Either way **handler.test.js breaks**, directly contradicting the F5
"224 stay green" guarantee. The rev-2 F5 trace (§2.6 / Testing strategy §1) only walked the
**service-layer** tests (which pass MemoryStore straight to `submitDoc` and ride the MemoryStore
pass-through). It did **not** walk the **handler-layer** test, where the selector overrides the
caller's store. The pass-through guarantee (F5) and the unconditional selector (F3) are mutually
exclusive at exactly this call site.

This is also a 403 case: `assertCan(ctx,'submit')` denies the rep **before any store access**. With
the selector resolving `pgStore()` *before* dispatch, the env throw happens before the perm gate
even runs — so a perm-denied request that should never touch the DB now fails on DB env. That is
both a test break and a real-world regression (a 403 turning into a 500).

**Required fix (architect) — make the selector respect the injected store. Options, anchored:**

- **(preferred) Selector only upgrades to `pgStore()` when the injected store does NOT support
  transactions (capability predicate); otherwise it uses the injected store as-is.** A MemoryStore
  passed by a test flows straight through to `submitDoc`, hits the MemoryStore `transaction`
  pass-through, and 403/409 still resolve correctly. Prod (SupabaseStore injected) gets upgraded to
  PgStore. This keeps F5 true AND F3 concrete. State the predicate explicitly — a capability flag
  (e.g. `store.supportsTransactions`) is cleaner than `instanceof SupabaseStore`.
- **(alt) Resolve `pgStore()` lazily inside the write branch only after the op is known to need a
  store, and never for a path that 403s first** — but that alone doesn't fix the MemoryStore test
  (the `frobnicate` case reaches dispatch for its 409). The capability predicate is the clean fix.

Whichever is chosen, the ADR must **re-trace `handler.test.js:71-77` explicitly** through the new
selector and show it yields 403/409 on a MemoryStore with no PG env. F5's "224 green" is not proven
until that specific trace is in the ADR.

## MUST-FIX CONSISTENCY (consequent on R1)

### R2 — The store-selector predicate must be the ONE documented rule; §2.4 prose reads as unconditional.

§2.4 says "the handler **selects** the PgStore for the atomic ops" and "the write branch … resolves
`const txCapable = pgStore()`" — as written that is unconditional and is what produces R1. Once R1's
capability predicate lands, reword §2.4 and diagram note (line 107) to the conditional form
("upgrade to pgStore() **only when** the injected store doesn't support transactions") so
`implement` builds the predicate, not the unconditional swap.

## CONFIRMED CLOSED (verified against code)

- **F1 — closed.** Mechanism holds against live code: `submit()` calls `this.save()` + `this.onSubmit()`
  (`document.js:131-132`); `cancel()` calls `this.save()` + `this.onCancel()` (`document.js:142-143`);
  `save()` writes via `this.store` throughout (`document.js:58-76`). Loading inside `transaction(fn)`
  with `txStore` => `d.store === txStore` => all three inherit the tx. `transition()` threads `store`
  to both `onTransition(d.doc,ctx,store)` (`workflow.js:152`) and the audit `store.insert(LOG_TABLE,…)`
  (`workflow.js:154`). The `this.store`-only / `onTransition`-store-arg-only invariant is written as a
  JSDoc code contract (§2.3) + diagram note (lines 78, 93). Diagram no longer says "post-commit".
  **Genuinely closed.**
- **F2 — closed.** Atomic-op set = submit, cancel, transition, syncDoctype-rows (§2.2 table).
  `transitionDoc` + `cancelDoc` wrapped exactly like `submitDoc`. The 3-write transition (save +
  onTransition + tabWorkflowAction) is correctly identified and wrapped.
- **F3.3 (migrate threading) — closed, with a noted-acceptable window.** DDL(PgAdmin) ->
  `transaction(syncDoctype rows)` -> `bumpMetaVersion` AFTER commit. **bumpMetaVersion-after-commit
  failing window:** if the row tx commits but `bumpMetaVersion` then fails, warm lambdas keep a
  **stale meta cache** until the next successful bump — but the rows ARE committed, so it's a
  cache-freshness lag, not corruption, and self-heals on the next migrate/bump. Bumping BEFORE commit
  would be worse (invalidate to a shape that then rolls back). Ordering is correct; the stale-cache
  window is **acceptable** — worth a one-line note in ADR consequences. Not blocking.
- **F4 — closed.** `SupabaseStore.transaction` THROWS; base `Store.transaction => await fn(this)`;
  MemoryStore inherits; PgStore real `sql.begin`. Consistent across body, diagram, layout; matches
  the `store.js:14-16` fail-loud house style.
- **F5 — closed at the SERVICE layer, BROKEN at the HANDLER layer (= R1).** Service/immutability/
  workflow/document traces correct (MemoryStore pass-through). Only the handler trace is missing and
  is the R1 break.
- **F6 — closed.** `loadPgStoreEnv(DATABASE_URL_POOLER)` as a third lazy schema alongside
  `EnvSchema`/`PgAdminEnvSchema`. `loadEnv` unchanged so `validation.test.js:297` stays green;
  lazy-in-fromEnv so MemoryStore-only tests are unaffected.
- **F7 — closed.** PgStore sized as its own class+test; full >=8-method parity with RETURNING * on
  insert/update, null-on-miss `get`, list eq/order.desc/range `off..off+limit-1`, getChildren/
  deleteChildren on parent+parenttype+parentfield, and **quoted reserved-word columns** — all parity
  risks I raised are named.
- **F8 — closed.** `:6543` + `prepare:false`; `max:1` warm-concurrency serialization named as a
  tunable tradeoff with the `max=N`/`idle_timeout` mitigation.
- **F9 — closed.** `scripts/prove-tx-rollback.mjs` is a required `implement` deliverable, human-gated
  per §1, covering (a) onSubmit-throw rolls back parent+children, (b) success commits all, (c)
  onTransition-throw leaves state unmoved + no audit row.
- **§2.7 child-write deferral — agree, sound, NOT a silent gap.** No side-effect hook spans the
  create/update child delete-then-reinsert (`document.js:71-76,102-118`), so the failure window is one
  store's consecutive writes (far narrower than the diagnosed hazard); wrapping them would force every
  write onto PgStore (rejected option-(b) blast radius); and the THROW (F4) guarantees a later
  revision can route them through `store.transaction` with no contract change and no silent
  half-enable. A deliberate YAGNI deferral, visible to the planner. **Approved.**

## REV-2 one-line verdict

**FAIL (one residual blocker)** — R1: the F3 handler store-selector as specified is unconditional and
breaks `handler.test.js:71-77` (MemoryStore through `handle()` -> submit/action), contradicting F5;
make the selector upgrade to `pgStore()` **only when the injected store lacks transactions**
(capability predicate), re-trace handler.test through it, then PASS. R2 is the consequent wording fix.
F1/F2/F3.3/F4/F6/F7/F8/F9 and the §2.7 deferral are genuinely closed.


---

# REV-3 RE-REVIEW (2026-06-20)

Scope: R1 + R2 only (the residual blocker + its wording consequence). F1/F2/F3.3/F4/F6/F7/F8/F9
and the §2.7 deferral were confirmed closed in the rev-2 re-review and are NOT re-litigated.

## VERDICT: **PASS** → planner.

### R1 — CLOSED. Capability predicate verified against the live code path.

- `supportsTransactions` added to the `Store` contract: base `false` (§2.4 / layout line 330;
  diagram 28), `MemoryStore = true` (332 / diagram 37), `PgStore = true` (341 / diagram 55),
  `SupabaseStore = false` (335 / diagram 45). Capability is the single source of truth — any future
  tx-capable store works without touching the handler.
- Selector is the predicate, not the unconditional swap: `const txStore = store.supportsTransactions
  ? store : pgStore();` (ADR 196, diagram note 112). The ternary **short-circuits** — for a
  `MemoryStore` (`true`) the `pgStore()` arm is never evaluated, so `PgStore.fromEnv()` /
  `loadPgStoreEnv(DATABASE_URL_POOLER)` is never reached. This is exactly the fix R1 required.
- **§2.4 re-trace of `handler.test.js:71-77` (ADR 212-220) is correct and matches live code.**
  Verified against `handler.test.js:30` (injects `new MemoryStore()`) and `:71-77` (submit→403,
  `frobnicate`→409, no `DATABASE_URL_POOLER`):
  - `MemoryStore.supportsTransactions === true` → `txStore = store` → `pgStore()` never called → no
    env read, no throw.
  - `submitDoc` wraps in `txStore.transaction(fn)`; MemoryStore's inherited pass-through is
    `await fn(this)` (§2.6 base default), so `fn` runs in place. The first line inside `fn` is
    `assertCan(ctx, …, 'submit')` (ADR 227; live `service.js:70` does `assertCan` before
    `loadInScope`), which throws `PermissionError` for the rep → `handler.statusFor` →
    **403** (`handler.js:9, 68`). ✔
  - The illegal `frobnicate` action routes via `transitionDoc` → `transition()` with no registered
    workflow → `StateError` → **409** (`handler.js:11`). assertCan('write') gates first; still no PG
    resolve. ✔
  - Both resolve hermetically with **no PG connection and no 500**. The rev-2 break is gone.
- **Non-atomic ops unchanged (verified):** `get`/`list`/`create`/`update` keep using the injected
  `store` (ADR 203, diagram note 112 "get/list/create/update -> injected store (unchanged)"). They
  never enter the predicate branch, so a test or prod request keeps its passed store. The 13
  service/handler CRUD+list tests (service.test.js 7, handler.test.js create/list/get/update cases)
  are untouched. ✔
- **Perm-gate-before-PG-resolve ordering holds** because (a) the ternary short-circuits before any
  `pgStore()` call for transactional stores, and (b) for a non-transactional store the wrap is
  `store.transaction(fn)` with `assertCan` as the first line of `fn` — but note for prod
  (SupabaseStore) the `pgStore()` *is* resolved by the selector before dispatch; that's correct in
  prod (the env exists) and is exactly the case the predicate intends. A perm-denied prod submit
  resolving a pooled PG singleton before the 403 is harmless (lazy singleton, no per-request cost)
  and only happens where the connection is configured. The test-breaking path (MemoryStore) no
  longer touches it. ✔

### R2 — CLOSED. Wording is consistent across body + diagram + edge.

- §2.4 body reworded from rev-2's unconditional `const txCapable = pgStore()` to the predicate, with
  an explicit "Why a predicate, not `instanceof` or unconditional `pgStore()`" rationale (ADR
  205-210).
- Diagram handler note (line 112) states the capability predicate and "pgStore() resolved ONLY when
  injected store can't transact -> no 500 in tests".
- Diagram edge (line 150) reworded: `handler ..> PgStore : pgStore() ONLY when
  !store.supportsTransactions (R1)`. No residual "unconditional swap" language remains.

### F3.3 consequence note — present as requested.

ADR 248-253: bump-after-commit failure = a **stale-cache-only** window (new rows live, warm lambdas
serve the prior `meta_version` until the next bump), never a torn/partial schema; self-heals on the
next set-not-append bump; **bounded by `META_VERSION_TTL_MS`**; correctly justified as the right side
to fail on. Matches the F3.3 note I asked for.

## REV-3 one-line verdict

**PASS** — R1 closed by the `supportsTransactions` capability predicate (selector short-circuits so
`pgStore()`/`loadPgStoreEnv` resolves only for a non-transactional injected store; the
`handler.test.js:71-77` re-trace yields 403/409 hermetically with no 500, and create/list/get/update
keep flowing on their injected store); R2 wording consistent across body/diagram/edge; F3.3 note
present and bounded by `META_VERSION_TTL_MS`. All prior findings remain closed. → **planner**.
