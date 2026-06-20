# Work Order: Integrity Layer (Pass B) — atomic naming series + real transactions

- **Planner:** planner (pipeline LEAD spawns one `implement` per unit per §8)
- **Date:** 2026-06-20
- **Authoritative design:** `docs/adr-integrity-layer.md` (rev 3, PASS) + `diagrams/integrity-layer-class.puml` (rev 3)
- **Critique:** `docs/critique-integrity-layer.md` — **PASS → planner** (R1/R2 closed; F1–F9 + §2.7 closed)
- **Composition gate:** **GO** (see §Composition go/no-go at the end)
- **Repo:** `spartan-erp-engine` (separate from CWD). Test runner: `npx vitest run` (NEVER watch).
- **Invariant for ALL units:** the existing **224 tests stay green**. Row shapes returned by
  `PgStore` must match `SupabaseStore` / `MemoryStore` **exactly** (Loader/Document branch on them).

---

## Fan-out gate

NOT a 1–2-class fix. Scope spans 5 build units across runtime stores, env validation, service/handler
wiring, meta-migration threading, and a live-proof script — built in parallel against shared frozen
contracts. Full work order earns its keep. Proceed with fan-out.

---

## Frozen seams (the contract every unit builds to — DO NOT diverge)

These four additions to the `Store` contract are **frozen**. All four concrete stores and every
consumer build to exactly these signatures.

```js
// src/runtime/store.js — Store base (additive, no existing consumer breaks)
/** Atomically allocate the next counter for a naming-series prefix.
 *  @param {string} prefix
 *  @returns {Promise<number|null>}  new value, or null if no atomic counter (caller falls back). */
async nextSeries(prefix) { return null; }                 // base default

/** Run fn in a transaction; the arg is a tx-bound Store (read-your-writes).
 *  Base is a PASS-THROUGH (no real tx) — load-bearing for MemoryStore tests.
 *  @template T @param {(txStore: Store) => Promise<T>} fn @returns {Promise<T>} */
async transaction(fn) { return await fn(this); }          // base pass-through

/** Capability flag — true iff transaction(fn) gives real (or pass-through-correct) atomicity.
 *  Base false; subclasses override. The handler selector reads THIS, never instanceof. */
supportsTransactions = false;                              // base default
```

**Row-shape contract (frozen — from `supabase-store.js`, the parity target):**
- `get(table, name)` → the full stored row, or **`null`** on miss (never `undefined`/`[]`).
- `insert(table, row)` → the **full stored row** (`RETURNING *` / `.select().single()`).
- `update(table, name, row)` → the **full stored row** (`RETURNING *`).
- `list(table, opts)` → `Row[]`; filters = exact-match eq; `order` → `ORDER BY field [DESC]`;
  `range` → inclusive `off .. off+limit-1` (default offset 0, default limit 1000).
- `getChildren(table, parent, parenttype, parentfield)` → `Row[]` filtered on those 3 columns.
- `deleteChildren(table, parent, parenttype, parentfield)` → `void`, filtered on those 3 columns.

---

## Build units (per-class YAML front-matter, dependency-ordered)

### Unit A — `next_series` migration + Store.nextSeries (3 stores) + naming.js

```yaml
unit: A
title: Atomic naming series (Decision 1, ADR §1 — PASSED unchanged)
target_files:
  - supabase/migrations/20260620020000_next_series_fn.sql   # NEW
  - src/runtime/store.js          # MOD: + nextSeries(prefix) base default (=> null)
  - src/runtime/supabase-store.js # MOD: + nextSeries via sb.rpc
  - src/runtime/memory-store.js   # MOD: + nextSeries in-memory Map++
  - src/runtime/naming.js         # MOD: prefer store.nextSeries, keep read-inc-write fallback
frozen_interface:
  migration: |
    -- 20260620020000_next_series_fn.sql  (FULL timestamp per CLAUDE.md migrations rule)
    -- ROLLBACK: drop function if exists next_series(text);
    create or replace function next_series(prefix text)
    returns bigint language sql as $$
      insert into tab_series (name, current) values (prefix, 1)
      on conflict (name) do update set current = tab_series.current + 1
      returning current;
    $$;
    grant execute on function next_series(text) to service_role;
  store_base: "async nextSeries(prefix) { return null; }"
  supabase: |
    async nextSeries(prefix) {
      const { data, error } = await this.sb.rpc('next_series', { prefix });
      if (error) throw new Error(`SupabaseStore.nextSeries ${prefix}: ${error.message}`);
      return data == null ? null : Number(data);
    }
  memory: |
    // private field: #series = new Map();
    async nextSeries(prefix) {
      const n = (this.#series.get(prefix) ?? 0) + 1;
      this.#series.set(prefix, n);
      return n;
    }
  naming_js: |
    // inside nextSeries(pattern, store), AFTER computing width/prefix/key, BEFORE read-inc-write:
    if (typeof store.nextSeries === 'function') {
      const n = await store.nextSeries(key);
      if (n != null) return prefix + String(n).padStart(width, '0');
    }
    // existing read-inc-write stays as the fallback (untouched)
dependencies: []   # leaf — depends on nothing in this work order
vitest:
  - file: src/runtime/naming.test.js   # EXISTING — must stay green (MemoryStore now returns a number, takes the fast path)
  - file: src/runtime/store-nextseries.test.js   # NEW
    assertions:
      - "base Store.nextSeries() resolves null (fallback contract)"
      - "MemoryStore.nextSeries('SO-') returns 1 then 2 then 3 on repeated calls"
      - "naming.nextSeries('SO-.#####', memStore) yields 'SO-00001' then 'SO-00002' (width-padded)"
      - "naming falls back to read-inc-write when store.nextSeries returns null (stub store)"
  - supabase_nextSeries: "hermetic — inject a fake sb with rpc() returning {data:7} ; assert returns 7 and calls rpc('next_series',{prefix})"
done_criteria:
  - "npx vitest run src/runtime/naming.test.js src/runtime/store-nextseries.test.js  → all green"
  - "naming.js still returns the read-inc-write result for a store whose nextSeries() => null"
  - "migration file uses the 14-digit timestamp prefix and includes the grant"
  - "MIGRATION IS NOT db push'ed by the agent — surface to human (CLAUDE.md §1). create-or-replace is idempotent; auto-appliable later via PgAdmin OR human db push."
registry: "S/A/I — link the naming-race finding; flip Status on landed fix per _GUIDE.md"
```

### Unit B — env-schema `loadPgStoreEnv` (third lazy schema, F6)

```yaml
unit: B
title: PgStore env validation (F6) — third lazy schema
target_files:
  - src/validation/env-schema.js   # MOD: + PgStoreEnvSchema + loadPgStoreEnv
frozen_interface:
  add: |
    const PgStoreEnvSchema = z.object({ DATABASE_URL_POOLER: z.string().min(1) });
    /** Validate DATABASE_URL_POOLER for PgStore (transaction pooler :6543).
     *  Throws a plain Error matching /DATABASE_URL_POOLER/ on missing key. LAZY — call inside fromEnv only.
     *  @returns {{ DATABASE_URL_POOLER: string }} */
    export function loadPgStoreEnv(env = process.env) {
      const r = PgStoreEnvSchema.safeParse(env);
      if (!r.success) throw new Error('PgStore: set DATABASE_URL_POOLER (Supabase transaction pooler :6543 connection string WITH the DB password)');
      return r.data;
    }
  hard_constraint: "loadEnv() MUST NOT demand DATABASE_URL_POOLER (validation.test.js:297 asserts loadEnv ignores PG vars). loadPgAdminEnv unchanged."
dependencies: []   # leaf — independent of Unit A
vitest:
  - file: src/validation/validation.test.js   # EXISTING — stays green (esp. :297, loadEnv must NOT demand the PG var)
  - new_cases:
      - "loadPgStoreEnv() throws /DATABASE_URL_POOLER/ when the var is unset"
      - "loadPgStoreEnv() returns { DATABASE_URL_POOLER } when set"
      - "loadEnv() succeeds with DATABASE_URL_POOLER absent (regression guard for the B2 separation)"
done_criteria:
  - "npx vitest run src/validation/validation.test.js  → all green incl. new cases"
  - "three independent lazy schemas coexist: loadEnv / loadPgAdminEnv / loadPgStoreEnv"
```

### Unit C — PgStore (THE big unit, F7/F8) — full parity + real transaction

```yaml
unit: C
title: PgStore — direct-PG Store with real transaction(fn) (F7/F8)
target_files:
  - src/runtime/pg-store.js   # NEW
frozen_interface:
  class: "export class PgStore extends Store"
  constructor: |
    /** @param {import('postgres').Sql} sql  a `postgres` tagged-template client (or an injected fake for tests) */
    constructor(sql) { super(); this.sql = sql; this.supportsTransactions = true; }
  fromEnv: |
    static fromEnv() {
      const { DATABASE_URL_POOLER } = loadPgStoreEnv();   // Unit B
      const sql = postgres(DATABASE_URL_POOLER, { prepare: false, max: 1, idle_timeout: 5 });
      return new PgStore(sql);
    }
  methods_full_parity:   # ≥8 methods — row shapes MUST match SupabaseStore exactly
    get:           "SELECT * FROM <tbl> WHERE name = $1  → rows[0] ?? null"
    insert:        "INSERT INTO <tbl> (<cols>) VALUES (<$n>) RETURNING *  → rows[0]"
    update:        "UPDATE <tbl> SET <col=$n,...> WHERE name = $k RETURNING *  → rows[0]"
    list:          "SELECT * FROM <tbl> [WHERE eq AND ...] [ORDER BY <field> [DESC]] [LIMIT lim OFFSET off]  → rows (inclusive off..off+limit-1 == LIMIT limit OFFSET offset)"
    getChildren:   "SELECT * FROM <tbl> WHERE parent=$1 AND parenttype=$2 AND parentfield=$3  → rows"
    deleteChildren:"DELETE FROM <tbl> WHERE parent=$1 AND parenttype=$2 AND parentfield=$3  → void"
    nextSeries:    "SELECT next_series($1) AS current  → Number(rows[0].current)  (parameterized, NON-prepared; joins the open tx)"
    transaction:   "return this.sql.begin(tx => fn(this.#bind(tx)));"
  bind: "#bind(tx) returns a PgStore-like whose sql === tx (every method runs on the tx connection). Simplest: `new PgStore(tx)` — its methods all use this.sql."
  identifier_quoting: |
    Tables are tabXxx; columns include reserved words. QUOTE all identifiers with double-quotes.
    MUST quote (tabDocPerm cols, installer.js:132-143): "unique" "read" "write" "create" "submit" "cancel" "delete".
    Also quote table + every column name uniformly to be safe. Values are ALWAYS parameters ($1..$n), never interpolated.
  pooling_F8: 'prepare:false MANDATORY (PgBouncer txn mode); max:1 (named warm-concurrency-serialization tradeoff — tunable to small N + idle_timeout); NEVER reintroduce .prepare()'
dependencies:
  - B   # PgStore.fromEnv calls loadPgStoreEnv (compile-time import; fromEnv is lazy at runtime)
  # NOTE: A's migration defines next_series() in the DB; PgStore.nextSeries CALLS it. Code-build of C does NOT
  #       depend on A landing (the fake-sql test stubs the result). The LIVE proof (Unit E) needs A applied.
vitest:
  - file: src/runtime/pg-store.test.js   # NEW — HERMETIC, no real DB
    strategy: |
      PgStore CANNOT use MemoryStore. Test via an INJECTED fake `sql` (mirror pg-admin's injectable
      _exec, pg-admin.test.js:5-11). The fake is a tagged-template function (and exposes .begin and
      .unsafe as needed) that:
        (1) RECORDS each query (the SQL string fragments + the param array), and
        (2) RETURNS canned rows so parity logic can be asserted.
      Construct `new PgStore(fakeSql)` directly (bypass fromEnv — no env needed).
    assertions:
      - "insert returns the canned RETURNING * row (FULL row, not the input)"
      - "update returns the canned RETURNING * row; WHERE targets name; SET excludes name-as-target"
      - "get returns null when the fake yields [] (null-on-miss, not undefined/[])"
      - "list with filters emits eq predicates; order.desc emits ORDER BY ... DESC; range emits LIMIT/OFFSET with off..off+limit-1 semantics matching SupabaseStore"
      - "getChildren/deleteChildren filter on parent + parenttype + parentfield (params in that order)"
      - "reserved-word columns are emitted DOUBLE-QUOTED (assert the recorded SQL contains \\\"submit\\\", \\\"read\\\", \\\"create\\\", \\\"unique\\\", etc.)"
      - "nextSeries emits SELECT next_series($1) with [prefix] and returns Number(current); query is NOT prepared"
      - "transaction(fn) calls sql.begin and passes a tx-bound store; a write inside fn goes to the tx, not the outer sql"
      - "supportsTransactions === true"
  - parity_cross_check: "OPTIONAL but recommended — a shared assertion table run against MemoryStore AND PgStore(fakeSql) to prove identical return shapes for insert/get/list."
done_criteria:
  - "npx vitest run src/runtime/pg-store.test.js  → all green"
  - "≥8 methods present; insert/update use RETURNING *; get null-on-miss; list inclusive off..off+limit-1; child filters on the 3 columns; reserved cols quoted"
  - "fromEnv builds postgres() with prepare:false, max:1; no .prepare() anywhere"
  - "NO real DB connection in the unit test (fully hermetic via injected sql)"
notes:
  - "LIVE DB parity + rollback is proven by Unit E (human-gated), NOT here."
```

### Unit D — SupabaseStore.transaction THROWS + MemoryStore pass-through + supportsTransactions flags (F4/F5/R1)

```yaml
unit: D
title: Transaction capability on existing stores (F4/F5/R1) — the 224-green guarantee
target_files:
  - src/runtime/store.js          # MOD: + transaction(fn) base pass-through; + supportsTransactions = false
  - src/runtime/memory-store.js   # MOD: + supportsTransactions = true  (INHERIT base pass-through — do NOT override transaction)
  - src/runtime/supabase-store.js # MOD: + transaction OVERRIDE -> THROW; + supportsTransactions = false
frozen_interface:
  store_base: |
    async transaction(fn) { return await fn(this); }   // pass-through (load-bearing for MemoryStore tests)
    supportsTransactions = false;
  memory: |
    supportsTransactions = true;
    // transaction: INHERITED — DO NOT override (the base pass-through is exactly right for single-threaded tests)
  supabase: |
    supportsTransactions = false;
    async transaction(fn) {
      throw new Error('SupabaseStore has no transactions — route atomic ops through PgStore');
    }
rationale: "Throwing (not no-op) matches store.js:14-16 fail-loud house style; makes mis-wiring a loud error, never a silent half-commit. The R1 predicate (Unit E) means THROW is reached only on a genuine mis-wire."
dependencies: []   # leaf — but see SEQUENCING: D MUST land BEFORE/WITH E (E's service wrap calls store.transaction)
vitest:
  - file: src/runtime/store-transaction.test.js   # NEW
    assertions:
      - "base Store.transaction(fn) resolves fn(this) (pass-through)"
      - "MemoryStore.supportsTransactions === true AND new MemoryStore().transaction(async s => s) resolves the same store (inherited pass-through)"
      - "SupabaseStore.supportsTransactions === false"
      - "SupabaseStore.transaction(fn) throws /no transactions/ (does NOT call fn)"
  - regression_guard: "after D lands, ALL existing service/handler/workflow/document/immutability tests still pass UNCHANGED (D adds capability, changes no existing behavior). Run full suite: npx vitest run"
done_criteria:
  - "npx vitest run  → full 224 still green (D is purely additive)"
  - "MemoryStore does NOT define its own transaction (inherits base)"
  - "SupabaseStore.transaction throws; supportsTransactions flags correct on all three stores"
```

### Unit E — Wiring: handler predicate + service tx-wraps + migrate threading + JSDoc invariants (F1/F2/F3/F3.3/R1/R2)

```yaml
unit: E
title: Atomic-op wiring — capability-predicate selector, tx-wrapped service ops, migrate threading
target_files:
  - src/api/handler.js     # MOD: capability-predicate store selector for atomic ops
  - src/api/service.js     # MOD: submitDoc/cancelDoc/transitionDoc wrap (load+writes) in store.transaction
  - src/meta/installer.js  # MOD: syncDoctype runs inside store.transaction; bumpMetaVersion OUTSIDE; migrate threading
  - src/runtime/document.js# MOD: JSDoc-ONLY F1 invariant on onSubmit/onCancel (NO behavioral change)
  - src/workflow/workflow.js# MOD: JSDoc-ONLY F1 invariant at the onTransition call site (NO behavioral change)
frozen_interface:
  handler_selector: |
    // In handle(): for the ATOMIC ops only (submit / cancel / non-submit action), pick a tx-capable store.
    // Lazy module-scope singleton, resolved ONLY when the injected store can't transact (R1 short-circuit):
    let _pg;                                   // module scope
    function pgStore() { return (_pg ??= PgStore.fromEnv()); }
    // ...inside the POST/name branch, before calling submit/cancel/transition:
    const txStore = store.supportsTransactions ? store : pgStore();
    // submit  -> submitDoc(ctx, doctype, name, txStore)
    // cancel  -> cancelDoc(ctx, doctype, name, txStore)
    // action  -> transitionDoc(ctx, doctype, name, action, txStore)
    // get/list/create/update -> keep the INJECTED store (NO upgrade) — unchanged
  service_submit: |
    export async function submitDoc(ctx, doctype, name, store) {
      return store.transaction(async (txStore) => {
        assertCan(ctx, doctype, 'submit');                       // FIRST line inside fn -> 403 before any PG work
        const d = await loadInScope(ctx, doctype, name, txStore);// load on tx (read-your-writes; d.store === txStore)
        if (typeof d.submit !== 'function') throw new StateError(`${doctype} is not submittable`);
        await d.submit();                                        // save + onSubmit on the tx
        return maskRead(ctx, doctype, d.doc);
      });
    }
  service_cancel: "identical shape: store.transaction(async txStore => { assertCan(...,'cancel'); load on txStore; d.cancel(); maskRead })"
  service_transition: |
    export async function transitionDoc(ctx, doctype, name, action, store) {
      return store.transaction(async (txStore) => {
        assertCan(ctx, doctype, 'write');                        // FIRST -> 403 before PG; 'frobnicate' reaches transition -> StateError -> 409
        const d = await loadInScope(ctx, doctype, name, txStore);
        await transition(ctx, d, action, txStore);               // save + onTransition + tabWorkflowAction all on the tx
        return maskRead(ctx, doctype, d.doc);
      });
    }
  installer_threading: |
    // syncDoctype gains a store arg used for the meta-row writes (signature compatible — callers already pass a store).
    // migrate(def, store, opts):
    //   DDL (PgAdmin or emitMigration) — UNCHANGED, separate, idempotent (§2.5)
    //   await store.transaction(tx => syncDoctype(def, tx));     // parent + N field + M perm rows = ONE unit
    //   await bumpMetaVersion(store);                            // SINGLE write, OUTSIDE the tx, AFTER commit (F3.3)
    // syncDoctype builds newDoc('DocType', row, store).save() with the passed (tx) store — already does; just receives tx.
  jsdoc_F1_invariant: |
    On SubmittableDocument.onSubmit / onCancel (document.js) and at the onTransition call site (workflow.js:152):
    /** F1 INVARIANT: inside a transactional op this runs ON THE TX. A hook that creates another doc MUST
     *  construct it with `this.store` (onSubmit/onCancel) or the passed `store` arg (onTransition) — the
     *  tx-bound store. NEVER capture an outer store, NEVER call *.fromEnv(); either commits OUTSIDE the tx
     *  and breaks atomicity. */
    # JSDoc/comment ONLY — zero behavioral change. (Hooks are empty no-ops today; Grep confirms no overrides.)
dependencies:
  - C   # handler imports PgStore (pgStore() singleton)
  - D   # service ops call store.transaction; MUST have base pass-through + supportsTransactions to be green
must_land_with_or_after: [C, D]
vitest:
  - file: src/api/handler.test.js     # EXISTING — RE-TRACE must hold:
    critical_assertions:
      - "handler.test.js:71-77 (MemoryStore injected, no DATABASE_URL_POOLER): submit by rep -> 403 (NOT 500); frobnicate -> 409 (NOT 500). MemoryStore.supportsTransactions===true so pgStore() is NEVER called (ternary short-circuits)."
      - "all 8 existing handler cases stay green (create/list/get/update/405 unchanged on injected store)"
  - file: src/api/service.test.js     # EXISTING — submit/cancel happy paths now ride MemoryStore.transaction pass-through; must stay green
  - file: src/workflow/workflow.test.js  # EXISTING (6 tests) — transition now via transitionDoc-style wrap path; re-confirm green through pass-through
  - file: src/meta/migrate.test.js    # EXISTING — migrate via MemoryStore.transaction pass-through; both cases must stay green (rows + version still land)
  - file: src/meta/installer.test.js  # EXISTING — syncDoctype via tx pass-through; stays green
  - new_case_optional: "an in-tx-rollback unit test using MemoryStore is NOT meaningful (pass-through doesn't roll back) — real rollback is Unit E-live (F9). Do NOT fake it with MemoryStore."
done_criteria:
  - "npx vitest run  → full 224 green (handler 403/409 hermetic, no 500; service/workflow/migrate/installer all green)"
  - "submitDoc/cancelDoc/transitionDoc each wrap in store.transaction with the perm gate as the FIRST line inside fn and load on txStore (no connection split)"
  - "migrate: DDL -> store.transaction(syncDoctype rows) -> bumpMetaVersion OUTSIDE the tx"
  - "handler atomic-op selector is the capability predicate `store.supportsTransactions ? store : pgStore()`; get/list/create/update use the injected store unchanged"
  - "F1 JSDoc invariant present on onSubmit/onCancel + onTransition call site; class-diagram 'post-commit' wording already corrected in rev-3 puml (no diagram churn needed)"
registry: "flip the transaction/atomicity finding(s) Status + Verified: + History + STATUS INDEX row per _GUIDE.md once E lands and the live proof (E-live) passes"
```

### Unit E-live — `scripts/prove-tx-rollback.mjs` (F9, HUMAN-GATED deliverable)

```yaml
unit: E-live
title: Live rollback proof (F9) — REQUIRED deliverable, HUMAN-GATED (CLAUDE.md §1)
target_files:
  - scripts/prove-tx-rollback.mjs   # NEW
authoring: "implement AUTHORS the script (PgStore.fromEnv against DATABASE_URL_POOLER). It is NOT auto-run."
proof_cases:
  - "(a) submit a doc whose onSubmit deliberately throws -> assert the parent row AND children are ABSENT (rolled back)"
  - "(b) a successful submit -> assert all rows (parent + children) PRESENT (committed)"
  - "(c) a transition whose onTransition throws -> assert the state field did NOT move AND no tabWorkflowAction row exists"
dependencies: [A, C, E]   # needs next_series applied (A), PgStore (C), wired ops (E), AND DATABASE_URL_POOLER live
human_gate: |
  Connects to prod-adjacent infra (DATABASE_URL_POOLER, transaction pooler :6543). Per CLAUDE.md §1 the
  agent SURFACES it for human-confirmed DB access; it NEVER auto-runs the script, and NEVER db push'es Unit A's
  migration. Deliverable = the committed script + a one-paragraph run instruction for the human.
done_criteria:
  - "script exists, is self-contained, asserts (a)/(b)/(c), and prints PASS/FAIL per case"
  - "agent reports it as a HUMAN-RUN deliverable in its result note; does NOT mark the rollback claim 'Verified' until a human runs it green"
```

---

## Dependency graph & parallelisable groups

```
Leaves (no intra-order deps) — build in parallel:
  A  (next_series + nextSeries on 3 stores + naming.js)
  B  (loadPgStoreEnv)
  D  (transaction pass-through + THROW + supportsTransactions flags)

Then:
  C  (PgStore)        depends on B (fromEnv import)        — can start as soon as B lands
  E  (wiring)         depends on C + D                     — the integration unit

Then (human-gated, last):
  E-live (rollback proof)  depends on A + C + E + live DATABASE_URL_POOLER
```

**Parallel group 1 (spawn together):** A, B, D — three independent `implement` specialists.
**Parallel group 2:** C (after B). D should already be green.
**Sequential tail:** E (after C **and** D), then E-live (human-gated).

**Critical 224-green ordering (F5/R1):** **D MUST land before or in the same integration step as E.**
E's service ops call `store.transaction`; without D's base pass-through + `supportsTransactions=true` on
MemoryStore, the moment E wraps `submitDoc` the suite goes red. D is purely additive (changes no existing
behavior), so it is safe to land first and keep everything green; E then flips the call sites.

---

## Assembly + integration-test sequence

1. **Land A, B, D in parallel.** After each: run that unit's new test + the full suite.
   - A: `npx vitest run src/runtime/naming.test.js src/runtime/store-nextseries.test.js`
   - B: `npx vitest run src/validation/validation.test.js`
   - D: `npx vitest run`  (full — D is additive; must stay 224 green)
2. **Land C** (PgStore, hermetic fake-sql): `npx vitest run src/runtime/pg-store.test.js`.
3. **Land E** (wiring): run the full suite — the integration gate.
   `npx vitest run`  → **224 green is the pass bar**, with special attention to:
   - `handler.test.js` (403/409 hermetic, no 500 — the R1 re-trace),
   - `service.test.js`, `workflow.test.js`, `migrate.test.js`, `installer.test.js` (all via MemoryStore pass-through).
4. **Author E-live**, then **surface to human** for the live rollback proof (do not auto-run, do not db push A).
5. **On all-green + human-run E-live green:** flip registry Status (+ `Verified:` + History + STATUS INDEX),
   finalize the BugWiki page (Solution + How-to-verify = these done-criteria), append lessons to
   `lessons_learned\<ID>.md`, and confirm no core PUML edge changed (the rev-3 `integrity-layer-class.puml`
   already reflects the design; topology edges unchanged — new `next_series` fn + PgStore→pooler are
   additive write paths to note in `salesAppTopo2.puml` only if that vault map tracks the engine repo).

---

## Composition go/no-go

**GO.** The plan composes:

- **Interfaces line up.** All four `Store` additions are frozen identically across base + 3 concrete
  stores; consumers (naming, service, handler, installer) call only the frozen signatures. Row shapes
  are pinned to the `SupabaseStore` parity target that Loader/Document already depend on.
- **No cycles.** Dependency DAG is `A,B,D → C → E → E-live` (B→C, C&D→E, A&C&E→E-live). Acyclic.
- **Contract-compliant** (re-checked, not re-designed): DRY (one `next_series`, one tx-wrap shape across
  submit/cancel/transition, one capability predicate), KISS/YAGNI (PgStore confined to atomic ops;
  create/update child-tx deferred per §2.7 with a clean upgrade path), Fail-Fast (SupabaseStore.transaction
  THROWS), Idempotency (create-or-replace + on-conflict). Least Privilege unchanged (both paths already
  service_role).
- **224-green is sequenced, not hoped for.** D (additive capability) lands before E (the wrap), so the
  suite never goes red; the handler R1 short-circuit is re-traced against live `handler.test.js:71-77`
  and yields 403/409 with no PG resolve.

No NO-GO. No hand-back to architect. **Release the work order to the build phase.**
