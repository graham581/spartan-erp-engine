# ADR: Integrity Layer — atomic naming series + real transactions

- **Status:** Proposed — **Revision 3** (architect, after critique FAIL on R1) → critique
- **Date:** 2026-06-20
- **Context repo:** `spartan-erp-engine`
- **Relates to:** ADR Meta-as-Data (the row/child machinery this builds on);
  `src/runtime/{naming.js,document.js,store.js,supabase-store.js,memory-store.js}`,
  `src/api/{handler.js,service.js}`, `src/workflow/workflow.js`,
  `src/meta/{installer.js,pg-admin.js}`, `src/validation/env-schema.js`.
- **Rev-2 changelog:** Decision 1 (`next_series`) PASSED unchanged. Decision 2 rewritten to close
  critique F1–F9: tx-store propagation invariant (F1), missed `transitionDoc` dependent wrapped (F2),
  concrete store-selection (F3), open question → THROW (F4), MemoryStore pass-through load-bearing
  (F5), `DATABASE_URL_POOLER` via the `env-schema.js` pattern (F6), PgStore full-parity reimpl (F7),
  `max:1` tradeoff named (F8), live rollback proof (F9); child-write scope decided in §2.7 (defer).
- **Rev-3 changelog:** closes the single residual blocker **R1** — the §2.4 store-selector is now a
  **capability predicate** (`store.supportsTransactions ? store : pgStore()`), not an unconditional
  swap, so a hermetic `MemoryStore` test flows through untouched (no `pgStore()`, no env load, no
  500); the perm/state gate still fires first, so `handler.test.js:71-77` keeps returning 403/409.
  **R2:** §2.4 + diagram reworded from "selects the PgStore" to the conditional predicate. Plus the
  F3.3 bump-after-commit consequence note. **F1/F2/F4/F6/F7/F8/F9 + §2.7 are unchanged from rev 2.**

## Problem

Two write-integrity holes remain after the meta-as-data work:

1. **Naming series is not atomic.** `naming.nextSeries` (`naming.js:38-48`) does read-inc-write
   through `store.get('tab_series')` + `store.update/insert`. Concurrent serverless invocations can
   both read `current=N` and both write `N+1`, minting a duplicate document name. **(PASSED — §1.)**

2. **No real transaction around multi-write operations.** Several ops span multiple store writes
   that must be all-or-nothing. PostgREST (`supabase-js`) has **no cross-call transaction**, so
   `SupabaseStore` literally cannot make them atomic. The full set of affected ops (corrected per
   critique F2) is:
   - `SubmittableDocument.submit()` — `save()` (parent + delete-then-reinsert children) **then**
     `onSubmit()` side-effects (`document.js:124-134`).
   - `SubmittableDocument.cancel()` — `save()` **then** `onCancel()` (`document.js:136-145`).
   - `workflow.transition()` — `d.save()` **then** `onTransition(...)` **then** an audit
     `store.insert('tabWorkflowAction', ...)` (`workflow.js:151-154`): a **3-write** op, every bit
     as non-atomic as submit. (The rev-1 ADR wrongly left this on the plain store — fixed in §2.2.)
   - `Installer.syncDoctype()` — `tabDocType` parent + N `tabDocField` + M `tabDocPerm` children
     (`installer.js:99-148`).

**Constraint already in force:** `SupabaseStore` uses the **service_role key over PostgREST, which
bypasses RLS**. The engine's permission model is therefore already **app-level**
(`service.js`/`permissions.js`), not RLS. Moving some writes onto a direct-PG path changes **nothing**
about the security model — both paths run as a privileged role behind the same app-level gate.

---

## Decision 1 — Atomic naming series (PASSED, unchanged)

A single-statement UPSERT-and-return Postgres function makes the increment atomic at the database.

```sql
-- migration: 20260620020000_next_series_fn.sql   (FULL timestamp — CLAUDE.md migrations rule)
-- ROLLBACK: drop function if exists next_series(text);
create or replace function next_series(prefix text)
returns bigint
language sql
as $$
  insert into tab_series (name, current)
       values (prefix, 1)
  on conflict (name)
       do update set current = tab_series.current + 1
  returning current;
$$;

grant execute on function next_series(text) to service_role;
```

- `tab_series` already exists (`20260620000001_customer.sql:4`); this migration only adds the
  function. The INSERT-or-bump-and-RETURNING is **one statement**, so Postgres row-locks the
  conflicting row and concurrent callers serialize to distinct values — no advisory lock, no
  `SELECT ... FOR UPDATE`.
- **Auto-appliable via `PgAdmin`** (`create or replace function` is idempotent) **or** human
  `supabase db push`. `grant execute ... to service_role` is required so the `rpc()` path works.

### Store contract addition

One additive optional capability on `Store` (`store.js`), no existing consumer breaks:

```js
/** Atomically allocate the next counter for a naming-series prefix.
 *  Returns the new value, or null if this store has no atomic counter
 *  (caller falls back to read-inc-write). */
async nextSeries(prefix) { return null; }   // base default
```

- **`SupabaseStore.nextSeries`** → `sb.rpc('next_series', { prefix })` — **no direct-PG needed.**
- **`MemoryStore.nextSeries`** → in-memory `Map<prefix,number>` `++` (single-threaded; fine for tests).
- **`PgStore.nextSeries`** → `SELECT next_series($1)` on its connection (parameterized,
  non-prepared under `prepare:false`, F8) so the counter joins the surrounding tx when one is open.

### naming.js change (minimal)

`nextSeries(pattern, store)` (`naming.js:38`) prefers the capability, keeps the fallback:

```js
const prefix = pattern.replace(/\.?#+/, '');
const key = prefix || 'NS';
if (typeof store.nextSeries === 'function') {
  const n = await store.nextSeries(key);
  if (n != null) return prefix + String(n).padStart(width, '0');
}
// fallback: existing read-inc-write (MemoryStore / store without the capability)
```

`resolveName`/`Document.insert` untouched.

---

## Decision 2 — Real transactions (rev 3)

### 2.1 Shape: `PgStore` (full `Store` impl) + `transaction(fn)`; SupabaseStore stays for non-atomic ops

Introduce a direct-PG implementation of the **same `Store` contract**, `PgStore`, whose
distinguishing feature is a working `transaction(fn)`. Route the **atomic-op set** (submit, cancel,
transition, syncDoctype-rows) through a tx; reads and non-atomic single-row writes
(`getDoc`/`listDocs`/`createDoc`/`updateDoc`) stay on the PostgREST `SupabaseStore`. Rationale for
option (a) over (b) "PgStore-everywhere" (storage rewrite, large blast radius — kept as a *future*
consolidation, not this ADR) and (c) a one-off wrapper (duplicates connection mgmt, doesn't
generalize) is unchanged from rev 1 and confirmed by critique (KISS/YAGNI).

### 2.2 The atomic-op set (F2 — `transition` added)

| Op | Service entry | Writes that must be one unit |
|---|---|---|
| submit | `submitDoc` (`service.js:69`) | `save()` (parent+children) + `onSubmit()` side-effects |
| cancel | `cancelDoc` (`service.js:78`) | `save()` (parent+children) + `onCancel()` side-effects |
| transition | `transitionDoc` (`service.js:91`) | `d.save()` + `onTransition()` + `insert('tabWorkflowAction')` audit |
| meta sync | `Installer.syncDoctype` (`installer.js:99`) | `tabDocType` + `tabDocField` + `tabDocPerm` rows |

`transition()` (`workflow.js:133-155`) is a genuine 3-write op; leaving it non-atomic would allow a
half-applied transition (state moved, side-effect or audit row missing) — the exact bug Decision 2
exists to kill. It already threads `store` to `onTransition` (`workflow.js:152`) and to the audit
insert (`workflow.js:154`), so once `transitionDoc` is wrapped, the txStore flows through both.

### 2.3 The tx-store propagation invariant (F1 — make-or-break)

A transaction is a **lie** unless side-effect docs created by hooks also run on the tx connection.
The mechanism + contract:

- **The service op rebinds the loaded doc to the tx store for the duration.** Because
  `loadInScope → loadDoc → newDoc(doctype, doc, txStore)` (`document.js:175`, `service.js:25-29`)
  constructs the doc with whatever store it's handed, loading **inside** the `transaction(fn)` with
  `txStore` makes `d.store === txStore`. So `d.save()`, `d.onSubmit()`, `d.onCancel()` all see the
  tx store via `this.store`.
- **Hard contract for hook authors (written into the code now, before the first hook ships):**

  > Inside a transactional op, a controller hook (`onSubmit`/`onCancel`/`onTransition`) that creates
  > another document MUST construct it with **`this.store`** — e.g.
  > `await newDoc('GL Entry', data, this.store).insert()`. It MUST NOT capture an outer `store`
  > from a closure and MUST NOT call `SupabaseStore.fromEnv()` / any `*.fromEnv()`. Only `this.store`
  > is guaranteed to be the tx-bound store; any other handle commits **outside** the tx and breaks
  > atomicity.

  For `onTransition`, which receives `store` as its 3rd argument (`workflow.js:152` —
  `t.onTransition(d.doc, ctx, store)`), the same rule applies to **that** `store` parameter: it is
  the txStore, and side-effect docs must be created with it (not a captured/`fromEnv` store).

- **Where it's enforced as a code-level contract comment:** a one-line invariant on
  `SubmittableDocument.onSubmit`/`onCancel` JSDoc (`document.js:34-35`) and on
  `transition()`'s `onTransition` call site (`workflow.js:152`), plus the class-diagram note. The
  rev-1 diagram's "post-commit side-effects" label is now **misleading** (under a tx they are
  *in-commit*) and is reworded to "in-commit side-effects — create docs via `this.store` only".

Hooks are empty today (`onSubmit`/`onCancel`/`onTransition` are no-op bases; Grep confirms no
controller overrides), so no test catches a violation yet — which is precisely why the contract is
frozen now, before the first real hook half-commits.

### 2.4 Store wiring — capability-predicate selection, no connection split (F3 + R1/R2)

**Store selector (the frozen seam):**

```
op kind                         store used
------------------------------  --------------------------------------------
GET (get/list)                  the injected store (SupabaseStore in prod; no tx)
POST create / update            the injected store (single logical write; §2.7)
POST submit / cancel / action   tx-capable store: the injected store if it can
                                transact, else pgStore()  (atomic-op set; via transaction)
admin migrate (syncDoctype)     tx-capable store (atomic meta-row unit)
```

- **The selector is a CAPABILITY PREDICATE, not an unconditional swap (R1).** Add a boolean
  `supportsTransactions` to the `Store` contract; the injected `store` is **upgraded to a `PgStore`
  only when it cannot transact itself.**
  - **`MemoryStore.supportsTransactions = true`** — its inherited `transaction(fn) => await fn(this)`
    pass-through is correct for hermetic tests (no real rollback needed there).
  - **`PgStore.supportsTransactions = true`** — real `sql.begin`.
  - **`SupabaseStore.supportsTransactions = false`** — its `transaction` THROWS (§2.6).

  The atomic-op branch in `handle()` (`handler.js:30`) selects:

  ```js
  const txStore = store.supportsTransactions ? store : pgStore();
  ```

  `pgStore()` is a **lazy module-scope singleton** calling `PgStore.fromEnv()` (reading
  `DATABASE_URL_POOLER`, §2.6) once per warm lambda. **It is resolved ONLY when the injected store
  can't transact** — i.e. in prod, where the route injected a `SupabaseStore`
  (`supportsTransactions === false`). The `migrate` admin route obtains a tx-capable store the same
  way. `get`/`list`/`create`/`update` keep using the injected `store` (no upgrade).

  **Why a predicate, not `store instanceof PgStore` or an unconditional `pgStore()`:** an
  unconditional swap (rev-2's `const txCapable = pgStore()`) resolves the DB connection **before the
  perm gate** — turning a would-be 403 into a 500 — and breaks hermetic tests that pass a
  `MemoryStore` with no `DATABASE_URL_POOLER` (`pgStore()` throws at env-load). The predicate keeps
  **capability the single source of truth** (any future tx-capable store works without touching the
  handler) and defers `pgStore()` to the one case that needs it.

- **Re-trace of `handler.test.js:71-77` under the predicate (R1 — must hold hermetically):** those
  tests inject a `MemoryStore` (`handler.test.js:30`) and expect **403** (perm-denied submit) and
  **409** (illegal action), with **no `DATABASE_URL_POOLER` set**. Trace:
  `MemoryStore.supportsTransactions === true` → `txStore = store` (the MemoryStore) → `pgStore()` is
  **never called** (no env read, no throw) → `submitDoc` runs inside the MemoryStore pass-through →
  `assertCan(ctx, …, 'submit')` throws `PermissionError` → handler `statusFor` maps to **403**; an
  illegal action throws `StateError` → **409**. Both resolve **without** a PG connection and
  **without** a 500. Because the wrap is `store.transaction(fn)` and the gate is the first line
  *inside* `fn`, the perm/state check still fires first. ✔

- **No connection split mid-op.** A transactional op runs its **load AND all writes on the tx
  store** — one connection, one transaction. `submitDoc` becomes:

  ```js
  return store.transaction(async (txStore) => {
    assertCan(ctx, doctype, 'submit');
    const d = await loadInScope(ctx, doctype, name, txStore);  // load on tx (read-your-writes)
    if (typeof d.submit !== 'function') throw new StateError(...);
    await d.submit();                                          // save + onSubmit on tx
    return maskRead(ctx, doctype, d.doc);
  });
  ```

  where `store` here is the tx-capable store the handler selected. This resolves the rev-1
  self-contradiction: the framing is **not** "reads always stay on SupabaseStore" — it is "**reads
  that are part of a transactional op run on the tx store**; only non-transactional reads/CRUD use
  the injected SupabaseStore." The class-diagram note is corrected accordingly.
- **`cancelDoc` / `transitionDoc`** are wrapped identically (load + writes on txStore).
- **`migrate → syncDoctype → bumpMetaVersion` threading (F3.3):**
  - `syncDoctype(def, txStore)` runs its `newDoc('DocType', ..., txStore).save()` **inside**
    `store.transaction` → the parent + child rows are one unit.
  - `bumpMetaVersion` is a **single write** and runs **outside** the tx (after it commits). It is a
    cache-invalidation sentinel, not part of the meta-row atomic unit; bumping it only after the rows
    commit is correct (warm lambdas must not invalidate to a shape that then rolls back). So
    `migrate()` becomes: DDL (PgAdmin, separate, §2.5) → `store.transaction(tx => syncDoctype(def, tx))`
    → `bumpMetaVersion(store)`.
  - **Consequence note (critique F3.3):** if `bumpMetaVersion` fails *after* the row tx commits, the
    new meta rows are live but warm lambdas keep serving the prior `meta_version` until the next
    successful bump — a **stale-cache-only window**, never a torn/partial schema. It **self-heals** on
    the next sync/bump (set-not-append) and is bounded by `META_VERSION_TTL_MS`. This is the correct
    side to fail on: bumping *before* commit would invalidate caches to a shape that could then roll
    back (serving meta for rows that don't exist). Acceptable as designed.

### 2.5 DDL ≠ data-tx (unchanged, confirmed by critique)

Postgres **auto-commits DDL**, and mixing DDL + data across two pooler modes in one unit is fragile.
So the DDL (`create table if not exists` / `create or replace function`) stays a **separate,
idempotent step** applied by `PgAdmin` on the **session pooler** *before* any rows, exactly as today
(`installer.js:188-193`, `pg-admin.js`). The realistic atomic unit is the **row writes** (§2.4). A
committed-then-re-applied idempotent DDL after a rolled-back row tx is harmless.

### 2.6 `SupabaseStore.transaction` THROWS; MemoryStore inherits a pass-through (F4 + F5)

- **Base `Store.transaction(fn) => await fn(this)`** — the working pass-through. **MemoryStore
  inherits it unchanged** and sets `supportsTransactions = true` (R1). This is **load-bearing and
  required**: `service.test.js:94-100` and the handler/workflow submit/transition tests call the
  service ops with a `MemoryStore`; once `submitDoc`/`cancelDoc`/`transitionDoc` wrap in
  `store.transaction`, they only stay green because MemoryStore resolves `fn(this)` (and the selector
  never upgrades it, R1). (224 tests stay green — confirmed against `service.test.js`,
  `immutability.test.js` (bypasses the wrapper, unaffected), `workflow.test.js` (6 tests, now through
  the pass-through), `document.test.js`, `handler.test.js`.)
- **`SupabaseStore.transaction` OVERRIDES the base to THROW** and sets `supportsTransactions = false`:
  `throw new Error('SupabaseStore has no transactions — route atomic ops through PgStore')`.
  Rationale tied to this file: `Store` already throws on every unimplemented method
  (`store.js:19-34`, "fails loudly rather than silently no-op'ing a write" `store.js:14-16`). A
  best-effort no-op `transaction` would violate that house style and make the F1 lie invisible —
  a future caller could ship a "transactional" submit that isn't. Throwing turns mis-wiring into a
  loud request error, not a silent data-integrity bug (Fail-Fast). (The R1 predicate means the THROW
  is reached only on a genuine mis-wire — normal prod selects a `PgStore` before calling
  `transaction`.)
- **`PgStore.transaction(fn)`** → real: `return this.sql.begin(tx => fn(this.#bind(tx)));` where
  `#bind(tx)` returns a `Store` whose every method runs on the `tx` connection; `supportsTransactions
  = true`. Mirrors Frappe's `frappe.db.begin/commit/rollback` (`database.py:1176-1216`).

### 2.7 Child-table writes in create/update — DEFERRED (lead's explicit question)

`createDoc`/`updateDoc` go through `Document.insert()`/`save()`, which write parent row +
**delete-then-reinsert children** (`document.js:71-76, 102-118`) — multi-write, so a failure between
the child deletes and the re-inserts *can* half-apply. **Decision: DEFER making these transactional,
do not wrap them now.** Justification:

- **No side-effect hook spans the child writes.** Unlike submit/cancel/transition, there is no
  controller hook between the delete and the re-insert that can throw arbitrary business logic; the
  failure window is a single store's consecutive writes, far narrower than the diagnosed hazard
  (a hook creating other docs).
- **Wrapping them forces every create/update onto PgStore**, widening the per-request direct-PG
  connection surface to **all** writes — the option-(b) blast radius this ADR deliberately rejected
  (KISS/YAGNI). The diagnosed root cause is the hook-bearing + meta-row ops, not bare child rewrites.
- **Clean upgrade path exists.** Because `transaction(fn)` is now on the contract and SupabaseStore
  **throws**, a later revision can route `createDoc`/`updateDoc` through `store.transaction` (with the
  same R1 predicate) with no contract change — the THROW guarantees we can't silently half-enable it.
  Recorded here as a YAGNI-deferred choice so the planner treats it as deliberate, not an oversight.

### 2.8 Serverless connection model (F8)

| Use | Pooler | Port | Why |
|---|---|---|---|
| Per-request `submit`/`cancel`/`transition`/sync txns | **Transaction pooler (PgBouncer)** | `:6543` | One pooled backend per *transaction*; right granularity for short serverless txns. |
| DDL (`create table`, `create function`) | **Session pooler** | `:5432` | DDL needs a stable session (`PgAdmin`, `pg-admin.js:11`). |

- **`prepare:false` mandatory** on the transaction pooler (PgBouncer txn mode rejects prepared
  statements; `PgAdmin` already proves it, `pg-admin.js:30`). Keep `PgStore.nextSeries`'s
  `SELECT next_series($1)` parameterized-but-not-prepared; never reintroduce `.prepare()`.
- **Cold start** ~50–150 ms per socket open → lazy module-scope singleton client, reused warm.
- **`max:1` serialization tradeoff (named, F8):** with `max:1`, two overlapping requests on the
  same warm instance **queue on the single client** — fine for short submit txns, but a long tx
  serializes warm concurrency. Mitigation option for the planner: `max` = a small N (e.g. 3) with a
  short `idle_timeout`, trading a few more pooled backends for warm-concurrency. Stated as a tunable
  tradeoff, not blocking.

---

## Module layout (new / changed) — rev 3

```
src/runtime/
  store.js          MOD  + nextSeries(prefix) default (=>null)
                          + transaction(fn) default (=> await fn(this))   [pass-through base]
                          + supportsTransactions = false  [base default; subclasses override] (R1)
  memory-store.js   MOD  + nextSeries (in-memory Map ++); INHERITS transaction pass-through (F5);
                          + supportsTransactions = true  (R1 — selector leaves it untouched)
  supabase-store.js MOD  + nextSeries (sb.rpc('next_series',{prefix}))
                          + transaction OVERRIDE -> THROWS (F4)
                          + supportsTransactions = false  (R1 — selector upgrades to PgStore)
  pg-store.js       NEW  PgStore extends Store — FULL >=8-method parity reimpl (F7):
                          get(null-on-miss) / insert(RETURNING *) / update(RETURNING *) /
                          list(eq filters, order.desc, range off..off+limit-1) /
                          getChildren / deleteChildren (parent+parenttype+parentfield) /
                          nextSeries(SELECT next_series($1)) / transaction(sql.begin);
                          supportsTransactions = true (R1);
                          QUOTED reserved-word columns (unique/read/write/create/submit/cancel/
                          delete on tabDocPerm); transaction pooler :6543, prepare:false,
                          lazy singleton (max:1, idle_timeout); #bind(tx) -> tx-bound Store
  naming.js         MOD  prefer store.nextSeries(prefix); keep read-inc-write fallback
  document.js       MOD  JSDoc-only: tx-store propagation invariant on onSubmit/onCancel (F1);
                          NO behavioral change (this.store flows the tx store in)
src/workflow/
  workflow.js       MOD  JSDoc-only invariant at the onTransition call site (F1);
                          transition() body UNCHANGED (store threaded in is the txStore)
src/api/
  service.js        MOD  submitDoc/cancelDoc/transitionDoc wrap (load + writes) in
                          store.transaction (F2/F3); load on txStore (no split)
  handler.js        MOD  store selector (R1 PREDICATE): atomic ops ->
                          (store.supportsTransactions ? store : pgStore() lazy singleton);
                          get/list/create/update -> injected store unchanged
src/meta/
  installer.js      MOD  syncDoctype runs inside store.transaction; bumpMetaVersion OUTSIDE the tx;
                          migrate(): DDL (PgAdmin) -> tx'd rows -> bump (F3.3)
  pg-admin.js       --   UNCHANGED (session pooler, DDL-only)
src/validation/
  env-schema.js     MOD  + PgStoreEnvSchema + loadPgStoreEnv (DATABASE_URL_POOLER), LAZY,
                          third schema alongside EnvSchema / PgAdminEnvSchema (F6);
                          loadEnv must NOT demand the PG var (validation.test.js:297)
supabase/migrations/
  20260620020000_next_series_fn.sql  NEW  create or replace function next_series(prefix)
                                          + grant execute to service_role
scripts/
  prove-tx-rollback.mjs  NEW (deliverable for implement, F9) -- HUMAN-GATED live rollback proof
```

---

## Testing strategy (F5 + F7 + F9)

1. **Hermetic suite stays green (F5 + R1):** base `Store.transaction(fn) => await fn(this)`;
   MemoryStore inherits it and `supportsTransactions = true`, so the selector never tries to upgrade
   it to a `PgStore` (no `DATABASE_URL_POOLER`, no 500). All service/handler/workflow
   submit/cancel/transition tests pass through the pass-through, and `handler.test.js:71-77` returns
   403/409 hermetically (re-traced §2.4). Re-confirm `workflow.test.js` (6 tests) after
   `transitionDoc` is wrapped.
2. **PgStore parity test (F7):** PgStore is the **largest single build chunk** — its own class with
   its own test, **not** a footnote. The test runs the same shape assertions as
   `SupabaseStore`/`MemoryStore`: `insert/update` return the **full stored row** (`RETURNING *`),
   `get` returns `null` on miss, `list` honors filters/`order.desc`/`range` with the same inclusive
   `off..off+limit-1` semantics, `getChildren`/`deleteChildren` filter on
   `parent`+`parenttype`+`parentfield`, and reserved-word columns are quoted. (Can run against a
   MemoryStore-equivalent assertion set hermetically; full DB parity under the F9 gate.)
3. **Live rollback proof (F9 — required, human-gated):** `scripts/prove-tx-rollback.mjs` —
   (a) submit a doc whose `onSubmit` deliberately throws → assert the parent row **and** children
   are **absent** (rolled back); (b) a successful submit → assert all rows present; (c) a transition
   whose `onTransition` throws → assert state did **not** move and no `tabWorkflowAction` row exists.
   It connects to prod-adjacent infra (`DATABASE_URL_POOLER`), so per CLAUDE.md §1 it is
   **surfaced for human-confirmed DB access, never auto-run.** Without it, "submit becomes
   all-or-nothing" is asserted, never demonstrated.

---

## Design-contract compliance

- **DRY:** one `next_series`; one `Store` contract; the tx wrap is identical across
  submit/cancel/transition (F2 keeps it DRY); one `#bind(tx)` rather than per-op connection code;
  one capability predicate rather than per-op store-type checks (R1).
- **KISS / YAGNI:** option (a) over (b); atomicity confined to the ops that need it (now correctly
  including transition); create/update child-tx **deferred** with a clean upgrade path (§2.7).
- **SOLID / SoC:** persistence atomicity in the store layer; the tx **boundary** in the service op
  that owns the lifecycle; DDL in `PgAdmin`; naming in `naming.js`; the store-selector seam made
  concrete via a capability predicate (F3/R1) so SoC is real, not paper, and adding a tx-capable
  store later needs no handler change (Open/Closed).
- **Least Privilege:** unchanged — both paths already run as service_role (RLS bypassed by design);
  no new privilege surface. DDL stays admin/CLI-gated; the rollback proof is human-gated.
- **Idempotency:** `next_series` via `create or replace` + `on conflict`; DDL `IF NOT EXISTS`;
  re-applying committed DDL after a rolled-back row tx is safe.
- **Fail-Fast:** `SupabaseStore.transaction` **THROWS** (F4) — restoring the `store.js` house style
  and making mis-wiring loud; a failed `onSubmit`/`onTransition` now **rolls the whole op back**
  instead of half-committing; the propagation invariant (F1) is frozen in code before the first hook.
  The R1 predicate ensures the THROW only fires on a real mis-wire, not on a perm-denied request.

## Consequences

- submit / cancel / transition / meta-row sync become all-or-nothing; partial-write and
  half-transition states are gone.
- Naming collisions under concurrency are structurally impossible.
- New prod env var `DATABASE_URL_POOLER` (transaction-pooler `:6543`) via a third lazy
  `env-schema.js` schema; a new `postgres` client on the write path (one socket per warm lambda),
  resolved lazily and **only** when the injected store can't transact (R1) — so hermetic tests and
  perm-denied/illegal requests never touch it.
- `PgStore` is a full parity reimplementation — the planner sizes it as its own class + test, not a
  transaction footnote.
- `SupabaseStore.transaction` throwing means atomic ops **must** be wired to a tx-capable store; the
  handler capability predicate (§2.4) is the contract that guarantees it without breaking tests.
- `bumpMetaVersion` failing after the row tx commits leaves a self-healing stale-cache-only window,
  bounded by `META_VERSION_TTL_MS` — the correct side to fail on (§2.4 F3.3 note).
- A human-gated `scripts/prove-tx-rollback.mjs` is a required `implement` deliverable.

## Frappe citations

- `frappe/database/database.py:1176` `begin`, `:1181` `commit`, `:1201` `rollback(save_point=...)`,
  `:1224` `savepoint`/`release_savepoint`; `:1581` the `savepoint(catch=...)` context manager —
  request-scoped transaction + per-block savepoint model. We scope the tx to the **op** (not the
  whole request) for serverless pooler hygiene.
- `frappe/model/document.py:1708` `submit` → `_submit` (save then on_submit, atomic because the
  request transaction wraps it — our `PgStore.transaction(fn)` is the per-op analogue).
- `frappe/model/document.py:1934-1935` `db_set(..., commit=True)` — per-write commit is the
  *exception*; normal writes ride the request transaction (so side-effect docs must share the tx —
  the F1 invariant).
