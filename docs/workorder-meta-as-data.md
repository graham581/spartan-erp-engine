# Work Order: Meta-as-Data

- **Planner:** planner
- **Date:** 2026-06-20
- **Source design:** `docs/adr-meta-as-data.md` (Rev 2) + `diagrams/meta-as-data-class.puml` (Rev 2)
- **Critique:** `docs/critique-meta-as-data.md` — **PASS rev 2** (C1–C5, M1–M4 all CLOSED; 2 non-blocking notes N1/N2 folded in below)
- **Engine repo:** `C:\Users\parrg\Documents\spartan-erp-engine` (plain JS/ESM, Vercel + Supabase, no build step)
- **Invariant for the whole build:** the existing suite (`npx vitest run`) must stay green. It currently has **56 tests across 9 files**. The migration plan (§3) is ordered so the suite never goes red for more than one PR at a time.

> **Fan-out note:** this is genuinely multi-class with shared frozen boundaries (6 new modules + 6 consumer refactors + 1 migration + 1 test helper). The full work order earns its keep — not over-ceremony.

---

## 0. Frozen vocabulary (used by every contract below)

```js
// FieldDef — camelCase, the in-memory shape the runtime already consumes (registry.js typedef)
{ fieldname, fieldtype, reqd?, options?, permlevel?, readOnly?, unique?, fetchFrom?, idx? }

// ChildTableDef — what document.js / loadDoc consume
{ field, doctype, table }

// DocPerm — exactly what permissions.js reads (all JS booleans)
{ role, doctype, permlevel, read, write, create, submit, cancel, delete, ifOwner? }

// DocMeta (legacy plain object) — what getMeta() returns TODAY; the new Meta class
// must be DUCK-COMPATIBLE with it (same readable props) so sync consumers don't change.
{ doctype, table, submittable?, autoname?, fields, childTables, scopeFields?, permissions? }
```

**Hard rule for all modules:** the in-memory shapes are camelCase; the DB columns are snake_case. The **only** place snake→camel + 0/1→bool mapping happens is `MetaLoader.load()` (§5 of ADR). No other module touches raw DB column names.

---

## 1. Modules — dependency-ordered, each with a FROZEN contract

Legend: **sync** = returns a value, never a Promise; **async** = returns a Promise. "throws" lists the throw behavior that callers depend on.

### Build Unit A — meta core (no deps beyond `errors.js`)

#### A1. `src/meta/meta.js` — **NEW** — the `Meta` class
```js
export class Meta {
  /** @param {DocMeta} def  a plain DocMeta (from boot seed OR assembled by the loader) */
  constructor(def)            // stores doctype, table, submittable, autoname, fields[],
                              //   childTables[], scopeFields[], permissions[]
  get doctype(): string
  get table(): string
  get submittable(): boolean
  get autoname(): string|undefined
  get fields(): FieldDef[]
  get childTables(): ChildTableDef[]
  get scopeFields(): string[]
  get permissions(): DocPerm[]
  getField(fieldname): FieldDef|undefined   // SYNC
  childTablesList(): ChildTableDef[]         // SYNC (alias of .childTables; ADR calls it childTables())
  getDocPerms(): DocPerm[]                    // SYNC — returns this.permissions
}
```
- **FROZEN:** `meta.fields`, `meta.childTables`, `meta.table`, `meta.scopeFields`, `meta.submittable`, `meta.autoname` must be **directly readable as properties** (getters or own props) — `document.js:27/72/103/159/170`, `permissions.js:44/52/65/89`, `naming.js:14/21`, `links.js:15/38` read these by property access. `getDocPerms()` must exist as a method (new — permissions.js will call it).
- **Construction contract:** `new Meta(def)` accepts a plain `DocMeta` and is total (defaults: `fields:[]`, `childTables:[]`, `permissions:[]`, `scopeFields:[]`). Must NOT do DB I/O.
- **throws:** none (pure wrapper).
- **deps:** none.

#### A2. `src/meta/registry.js` — **MODIFY** → `MetaRegistry`
Keep the file path (consumers import `getMeta` from here). Replace the plain `META` object with a module-scope registry that the loader feeds.
```js
// Module-scope singleton state (the warm-lambda cache):
//   cache: Map<string, Meta>
//   pinned: Set<string>
//   version: string|null
//   versionCheckedAt: number

export function getMeta(doctype): Meta            // SYNC, cache-only; throws NotFoundError on miss
export function hasMeta(doctype): boolean         // SYNC
export function setMeta(doctype, meta, pinned=false): void
export function allDoctypes(): string[]
export function primeFrom(metas, pinned=false): void   // metas: DocMeta[] | Meta[]; wrap plain defs in Meta
export function invalidate(doctype?): void        // clears NON-pinned only; doctype omitted = clear all non-pinned
export function _resetRegistry(): void            // test only — clears cache AND pinned

// version helpers (used by MetaLoader.ensureFresh — keep state co-located with the cache):
export function getVersionState(): { version, versionCheckedAt }
export function setVersionState(version, checkedAt): void
```
- **FROZEN — the load-bearing contract (C1):** `getMeta(doctype)` is **SYNC, cache-only, throws `NotFoundError` on a miss** (never touches the DB). This is what keeps every sync consumer unchanged. Message format: keep `Unknown doctype: <doctype>` (matches current `registry.js:44`, asserted by handler/service NotFound tests).
- **FROZEN (C2):** `invalidate()` **never evicts a pinned entry**. `primeFrom(metas, true)` marks every entry pinned.
- `getMeta` must return a **`Meta` instance**. `setMeta`/`primeFrom` accept either a `Meta` or a plain `DocMeta` and wrap plain ones via `new Meta(def)`.
- **Backward-compat:** keep the legacy `FieldDef`/`ChildTableDef`/`DocMeta` JSDoc typedefs in this file (other modules `import('../meta/registry.js').DocMeta`).
- **RETIRE:** `registerDoctype` is **removed** (callers migrate — §3). Do NOT keep it as a shim; that would skip the loader (the bug C4/C5 close).
- **deps:** A1 (`Meta`), `errors.js`.

#### A3. `src/meta/boot-meta.js` — **NEW** — pinned seed
```js
export const META_DOCTYPES        // DocMeta[] for the 6 meta-doctypes (hand-written)
export function registerBootMeta() // calls primeFrom(META_DOCTYPES, /*pinned*/ true)
```
- **The 6 pinned meta-doctypes** (each a `DocMeta` whose `.table` and `.fields` describe the meta tables themselves):
  - `DocType` → table `tabDocType`; childTables: `fields`→`DocField` (table `tabDocField`), `permissions`→`DocPerm` (table `tabDocPerm`).
  - `DocField` → table `tabDocField` (child, `istable`-style; no children).
  - `DocPerm` → table `tabDocPerm` (child; no children).
  - `Role` → table `tabRole`; `autoname: 'field:role_name'`.
  - `Workflow` → table `tabWorkflow`; childTables: `transitions`→`Workflow Transition` (table `tabWorkflowTransition`).
  - `Workflow Transition` → table `tabWorkflowTransition` (child; no children).
- **FROZEN (C2):** these 6 are the **permanent cold-boot key**. The fields list for `DocType`/`DocField`/`DocPerm` must name exactly the snake_case columns the base migration (§A7) creates, so `store.getChildren('tabDocField', …)` and the loader's snake→camel map line up.
- **deps:** A1 (`Meta`), A2 (`primeFrom`).

> **Build Unit A is buildable in one PR; A1→A2→A3 in that internal order.** After A, `getMeta('DocType')` returns the pinned meta synchronously.

---

### Build Unit B — pure SQL emitter (NO deps; fully parallel with A)

#### B1. `src/meta/ddl.js` — **NEW** — `DDLEmitter` (pure functions)
```js
export function createTableSql(def): string
   // 'create table if not exists "<def.table>" ( name text primary key, owner text,
   //   docstatus int not null default 0, idx int not null default 0,
   //   creation timestamptz, modified timestamptz, <field columns...> );
   //  grant all on "<def.table>" to service_role;'
export function alterColumnsSql(def, existingCols): string
   // 'alter table "<def.table>" add column if not exists <col> <type>;' for each field not in existingCols
export function pgTypeFor(field): string   // FieldDef.fieldtype -> postgres type (see table below)
```
- **fieldtype → pg type map (FROZEN):**
  | fieldtype | pg type |
  |---|---|
  | `Data`/`Text`/`Code`/`Select`/`Link` | `text` |
  | `Int` | `bigint` |
  | `Float`/`Currency` | `numeric` |
  | `Check`/`reqd`/all DocPerm flags | `boolean` |
  | `Date` | `date` |
  | `Datetime` | `timestamptz` |
  | `Table` (child fields) | **no column** — child rows live in the child's own table |
- **FROZEN:** pure — **no DB access, no fs**. Returns strings only. Idempotent SQL (`if not exists`). Quote table names (`"tabFoo"`) to match the existing migration style (`20260620000001_customer.sql`).
- **deps:** none.

---

### Build Unit C — the loader (depends on A; coordinate freeze with A's contracts)

#### C1. `src/meta/loader.js` — **NEW** — `MetaLoader`
```js
export async function ensure(doctype, store): Promise<void>
export async function load(doctype, store): Promise<Meta>
export async function ensureFresh(store): Promise<void>
```

**`ensure(doctype, store)` — the per-request PRIME (C1).** FROZEN behavior:
1. `await ensureFresh(store)` first.
2. Compute the **transitive closure** starting from `{doctype}`: for each member, after its DocType row is read, add every `options` target of its `Link` **and** `Table` fields; repeat to a fixed point. **Visited-set guards** self/mutual reference (terminates — confirmed by critique).
3. Load each uncached, **non-pinned** member into the cache. **(N2 — keep two concerns separate):** order the **Table-edge** targets child-first (so `getMeta(options).table` is available at parent assembly, M4); **Link-edge** targets only need to be *present* in the cache (membership), order-free.
4. After `ensure` returns, **no sync `getMeta` the pipeline touches can miss** (closure = union of `links.js:22/42` `tryMeta(options)` + `document.js:170` child loads + assembly-time `getMeta(field.options).table`).

**`load(doctype, store)` — hydrate one Meta (C4/C5/M4).** FROZEN behavior:
1. `row = await store.get('tabDocType', doctype)` (DocType meta is pinned → resolves table name sync). If null → throw `NotFoundError`.
2. `fields = await store.getChildren('tabDocField', doctype, 'DocType', 'fields')` → map each snake→camel per the §5 table; coerce `reqd/readOnly/unique` via `!!`, `permlevel/idx` via `Number()`.
3. `perms = await store.getChildren('tabDocPerm', doctype, 'DocType', 'permissions')` → map `parent→doctype` (rename), `!!` each of read/write/create/submit/cancel/delete + ifOwner, `Number(permlevel)`.
4. Derive `childTables` from `fields` where `fieldtype==='Table'`: `{ field: f.fieldname, doctype: f.options, table: getMeta(f.options).table }`. **(N1 — fail loud):** assert `hasMeta(f.options)` before reading `.table`; throw a clear dev error if the Table target wasn't primed (catches a future closure regression instead of silently producing `table: undefined`).
5. `scopeFields` from the DocType row's `scope_fields` (text[] → string[]); `submittable` from `is_submittable` (`!!`); `autoname` from `autoname`.
6. `meta = new Meta({...})`; `setMeta(doctype, meta, /*pinned*/ false)`; return it.

**`ensureFresh(store)` — version poll, TTL-bounded (M1/M2).** FROZEN behavior:
- Read `META_VERSION_TTL_MS` (default **5000**; `0` = read-every-request). If `now - versionCheckedAt < TTL`, return without a DB read.
- Else `row = await store.get('meta_version', 'meta_version')` (single-row table, name pk = `'meta_version'`); if `row.version !== cachedVersion`, call `invalidate()` (non-pinned only) and store the new version; set `versionCheckedAt = now`.
- **Cost (honest, M2):** at most one version read per TTL window per warm lambda; ~5–30 ms. Not Frappe parity (poll not push) — stated in ADR.
- **deps:** A1 (`Meta`), A2 (`getMeta/setMeta/hasMeta/invalidate/version state`), the Store contract (`get`, `getChildren`).

> **Snake→camel + 0/1→bool map is reproduced verbatim from ADR §5 — implement exactly that table. It is the single source of the mapping (DRY).**

---

### Build Unit D — installer (depends on A, B, and the Document.save pipeline)

#### D1. `src/meta/installer.js` — **NEW** — `Installer`
```js
export async function syncDoctype(def, store): Promise<void>
export function emitMigration(def): string          // returns the migration file PATH written
export async function bumpMetaVersion(store): Promise<void>
```
- **`syncDoctype(def, store)` (C3 — rows only):** upsert the `tabDocType` parent + `tabDocField` (`fields`) + `tabDocPerm` (`permissions`) children through the **existing `Document.save()` child-replace pipeline** (`newDoc('DocType', row, store).save()`). Idempotent by `name`. **Never runs DDL, never creates tables.**
- **`emitMigration(def)` (C3 — DDL emit-only):** call `DDLEmitter.createTableSql(def)` (+ `alterColumnsSql` when extending), write to `supabase/migrations/<ts>_<doctype>.sql`. A **human runs `supabase db push`** (CLAUDE.md §1). Returns the path. **Never executes SQL.**
- **`bumpMetaVersion(store)`:** `store.update('meta_version', 'meta_version', { name:'meta_version', version:<new> })` — a **set, not append** (idempotent). Insert if absent.
- **FROZEN ordering (C3):** for a new doctype the caller sequence is `emitMigration → human db push → (schema cache reload) → syncDoctype → bumpMetaVersion`. Document this in the file header.
- **deps:** A1/A2, B1 (`DDLEmitter`), `document.js` (`newDoc`), Store contract.

---

### Build Unit E — base migration (NO code deps; parallel with everything; needed before live-verify)

#### E1. `supabase/migrations/<ts>_meta_doctypes.sql` — **NEW**
- `create table if not exists "tabDocType"` — cols: `name text pk, owner, docstatus int, idx int, creation, modified, istable boolean, issingle boolean, is_submittable boolean, autoname text, naming_rule text, module text, scope_fields text[]`.
- `create table if not exists "tabDocField"` — child cols + `parent text, parenttype text, parentfield text, fieldname text, fieldtype text, reqd boolean, options text, permlevel int, read_only boolean, unique boolean, fetch_from text` (note: reserve word `unique` → quote the column).
- `create table if not exists "tabDocPerm"` — child cols + `parent text, parenttype text, parentfield text, role text, permlevel int, if_owner boolean, read boolean, write boolean, create boolean, submit boolean, cancel boolean, delete boolean` (quote reserved `create`, `cancel`, etc.).
- `create table if not exists "tabRole"` — `name text pk, owner, docstatus, idx, creation, modified, role_name text`.
- `create table if not exists "tabWorkflow"` — `name text pk, …, document_type text, workflow_state_field text, is_active boolean`.
- `create table if not exists "tabWorkflowTransition"` — child cols + `parent, parenttype, parentfield, state text, action text, next_state text, allowed text, idx int`.
- `create table if not exists meta_version ( name text primary key, version text not null );` then `insert … values ('meta_version','1') on conflict do nothing`.
- `grant all on <each table> to service_role;`
- **FROZEN:** all boolean-ish columns are Postgres `boolean` (ADR §1 C5 decision). Rollback comment at the top per CLAUDE.md §🗄.
- **deps:** none (but column names must match A3 boot-meta fields + the §5 snake map exactly — coordinate the freeze).

---

### Build Unit F — consumer refactors (depend on A; retire old registries)

#### F1. `src/perms/permissions.js` — **MODIFY**
- Replace `import { getDocPerms } from './registry.js'` → read from meta: `getMeta(doctype).getDocPerms()`.
- `can()` `:18`, `levels()` `:34` iterate `getMeta(doctype).getDocPerms()` instead of `getDocPerms(doctype)`. **Logic unchanged** (`p[op] === true` holds — loader guarantees booleans).
- `visibleFields/maskRead/assertCanWrite/queryConditions` already use `getMeta` — **unchanged**.
- **FROZEN:** public signatures of `can/assertCan/visibleFields/maskRead/assertCanWrite/queryConditions` are unchanged.
- **deps:** A (Meta.getDocPerms). **RETIRES** `src/perms/registry.js`.

#### F2. `src/perms/registry.js` — **DELETE**
- Remove the file. All imports migrate to `getMeta(dt).getDocPerms()` (F1) or `seedViaLoader` (test helper, §G).

#### F3. `src/workflow/hooks.js` — **NEW**
```js
export const WORKFLOW_HOOKS  // Map<"Doctype::action", { condition?, onTransition? }>
export function getHooks(doctype, action): { condition?, onTransition? }   // SYNC; {} if none
```
- Holds the in-code closures over `(doc, ctx, store)` that can't be DB rows (ADR §6).
- **deps:** none.

#### F4. `src/workflow/workflow.js` — **MODIFY**
- Replace `import { getWorkflow } from './registry.js'` with a **local `getWorkflow(doctype)`** that:
  1. Assembles the declarative `WorkflowDef` from `getMeta('Workflow')`-described rows — i.e. read the `Workflow` doc for this `document_type` + its `transitions` children (already on the loaded Meta as a child table, or loaded via the workflow doc). Map rows → `{ doctype, stateField, initial, states, transitions:[{from,to,action,roles,guard}] }`.
  2. For each transition, look up `getHooks(doctype, t.action)` and set `t.condition`/`t.onTransition`. Undefined hooks → transition has none (as today).
- `transition()` `:20` and `availableActions()` `:61` bodies are **unchanged** — they consume the assembled+rehydrated def exactly as before.
- **FROZEN:** `transition(ctx, d, action, store)` and `availableActions(ctx, d)` signatures unchanged.
- **deps:** A, F3 (`getHooks`). **RETIRES** `src/workflow/registry.js`.

> **Workflow data source note (resolve at build):** the Workflow declarative def can be sourced either (a) by loading the `Workflow` doc keyed by `document_type` via the store, or (b) cached as a Meta-like entry. The ADR keeps `getWorkflow` SYNC-shaped today (`workflow.js` calls it synchronously inside `transition`, which is itself async). **Decision for implement:** `getWorkflow` may be made **async** (it is only ever awaited from inside the already-async `transition`/called before `availableActions` — verify `availableActions` callers). If any caller of `availableActions` is sync, prime the workflow def in `MetaLoader.ensure` alongside the doctype and keep `getWorkflow` sync cache-only. **This is the one open seam — see §7 composition note W1.**

#### F5. `src/workflow/registry.js` — **DELETE**

#### F6. `src/api/handler.js` — **MODIFY**
- Add as the **first line inside `try`** of `handle()` (`:28`): `await MetaLoader.ensure(doctype, store);`
- Nothing else changes; `handle` is already async and already destructures `doctype` + `store`.
- **FROZEN:** `handle({method,doctype,name,body,query,ctx}, store)` signature unchanged.
- **deps:** C1 (`MetaLoader.ensure`).

#### F7. `src/bootstrap.js` — **MODIFY**
- Replace `registerDoctype(Customer)` + `registerRolePerm(...)` with `registerBootMeta()` (seed the 6 pinned meta-doctypes).
- Customer becomes **rows** (installed via `Installer.syncDoctype` against the live store, or seeded for tests via `seedViaLoader`). For the cold-start path, `bootstrap.js` only needs `registerBootMeta()`; Customer is hydrated on first request via `MetaLoader.ensure('Customer', store)`.
- **deps:** A3 (`registerBootMeta`).

---

## 2. Per-module vitest spec + done-criteria

| Module | Spec file | Key assertions / done-criteria | Parallel group |
|---|---|---|---|
| A1 `meta.js` | `src/meta/meta.test.js` (NEW) | `new Meta(def)` exposes fields/childTables/table/scopeFields as props; `getField` returns the field; `getDocPerms()` returns `permissions`; defaults empty arrays | **A** |
| A2 `registry.js` | extend usage via existing tests + `src/meta/registry.test.js` (NEW) | `getMeta` throws `NotFoundError` (`Unknown doctype:`) on miss; `primeFrom(metas,true)` then `invalidate()` keeps pinned, drops non-pinned; `getMeta` returns a `Meta` | **A** |
| A3 `boot-meta.js` | `src/meta/boot-meta.test.js` (NEW) | after `registerBootMeta()`, `getMeta('DocType').table==='tabDocType'`, `getMeta('Workflow').childTables` includes `Workflow Transition`; all 6 present and pinned | **A** |
| B1 `ddl.js` | `src/meta/ddl.test.js` (NEW) | `createTableSql(customerDef)` contains `create table if not exists "tabCustomer"`, `customer_name text`, `credit_limit numeric`, `grant all … service_role`; `pgTypeFor` maps Check→boolean, Int→bigint; `alterColumnsSql` skips existing cols; **no fs/DB touched** | **B (parallel w/ A)** |
| C1 `loader.js` | `src/meta/loader.test.js` (NEW) | round-trip via MemoryStore: insert tabDocType/Field/Perm rows → `load('Customer')` yields camelCase `fetchFrom`/`readOnly`; perms come back JS booleans; `childTables[].table` correct; `ensure` primes the transitive Link/Table closure; mutual A↔B Links terminate; **N1**: missing Table target throws loud | **C (after A)** |
| D1 `installer.js` | `src/meta/installer.test.js` (NEW) | `syncDoctype` upserts rows readable by `getChildren`; re-run is idempotent (no dup children); `emitMigration` writes a file containing `create table if not exists`; `bumpMetaVersion` sets (not appends) the version row | **D (after A,B)** |
| E1 base migration | `npx supabase db push --dry-run` (live-verify §4) | dry-run clean; all 7 tables + meta_version row appear after push | **E (parallel)** |
| F1 `permissions.js` | existing `src/perms/perms.test.js` (re-seeded via helper) | all current perms assertions pass off **loaded** perms (not hand-registered) | **F (after A,C,G)** |
| F3/F4 workflow | existing `src/workflow/workflow.test.js` (re-seeded) | transition advances on role+condition pass; blocks on condition fail; appends log row — all via `WORKFLOW_HOOKS['Job::start_measure']` | **F (after A,C,G)** |
| F6 `handler.js` | existing `src/api/handler.test.js` | all handler tests pass with `ensure` primed via the test store | **F** |
| F7 `bootstrap.js` | existing suite cold-start | suite boots with `registerBootMeta()`; no `registerDoctype` import remains anywhere | **F** |

---

## 3. The 56-test migration plan (suite never red > 1 PR)

**The problem:** 7 test files prime via `registerDoctype` / `registerRolePerm` / `registerWorkflow` and reset via `_resetRegistry` / `_resetPerms` / `_resetWorkflows` in `beforeEach`. Retiring `perms/registry.js` + `workflow/registry.js` breaks their imports. M3 forbids a naive shim (it would skip the loader and defeat C4/C5).

**The ordering (each step is one PR; suite green after each):**

1. **PR-1 (Unit A + Unit B):** add `meta.js`, the new `MetaRegistry`, `boot-meta.js`, `ddl.js`. **Keep `registerDoctype` as a thin wrapper over `primeFrom` TEMPORARILY** so existing tests keep importing it and stay green. New module tests added. *Suite green.*
2. **PR-2 (Unit C + the test helper G):** add `loader.js` and the `seedViaLoader` helper (§G). No consumer changes yet. New loader/installer-round-trip tests added. *Suite green.*
3. **PR-3 (Unit D + Unit E):** add `installer.js` + the base migration file. *Suite green* (migration not pushed yet; pure-additive code).
4. **PR-4 (perms migration):** migrate `src/perms/perms.test.js` and `src/api/service.test.js` + `handler.test.js` priming from `registerRolePerm`/`registerDoctype` → `seedViaLoader(defs)` (which routes through `Installer`+`MetaLoader` into a MemoryStore). Land `permissions.js` F1 change (`getMeta().getDocPerms()`) **in the same PR**. **DELETE `perms/registry.js`** here. *Suite green — the perm tests now exercise the loader.*
5. **PR-5 (workflow migration):** add `hooks.js` (F3), move the `workflow.test.js` inline `condition` closure to `WORKFLOW_HOOKS['Job::start_measure']`, migrate the workflow test seeding to `seedViaLoader` + hooks, land `workflow.js` F4. **DELETE `workflow/registry.js`**. *Suite green.*
6. **PR-6 (handler prime + bootstrap + drop the temporary shim):** land `handler.js` F6 (`await MetaLoader.ensure`), `bootstrap.js` F7 (`registerBootMeta`), and **remove the temporary `registerDoctype` wrapper** from `registry.js`. Migrate any remaining test priming (`document.test.js`, `immutability.test.js`, `links.test.js`, `naming.test.js`, `validate.test.js`) to `seedViaLoader` / `MetaRegistry.primeFrom`. *Suite green — `registerDoctype` no longer exists anywhere.*

**Rule:** at no point are two registries half-deleted. The temporary `registerDoctype` wrapper (PR-1) is the bridge that keeps PR-1→PR-3 green; it is removed only in PR-6 once every caller has migrated.

**Test-seed policy (M3):**
- **Pure-logic tests** (validate, links, naming, document, immutability) — may seed via `MetaRegistry.primeFrom([def], false)` (fast, in-cache; they test logic not loading).
- **Hydration tests** (perms, service, handler, workflow + the new loader/installer tests) — seed via **`seedViaLoader`** so snake→camel (C4), 0/1→bool (C5), parent→doctype (C5), and `childTables[].table` (M4) are exercised by the real loader.

---

### G. Test helper — `seedViaLoader` (build in PR-2, before any consumer migration)
File: `src/test-helpers/seed-via-loader.js` (NEW)
```js
export async function seedViaLoader(defs, store = new MemoryStore()): Promise<MemoryStore>
   // 1. registerBootMeta()  (pin the 6)
   // 2. for each def: Installer.syncDoctype(def, store)   (upsert meta rows into the store)
   // 3. for each def: await MetaLoader.load(def.doctype, store)   (hydrate through the REAL loader)
   // returns the store so the test can reuse it for doc CRUD
```
- **FROZEN:** must route through `Installer` + `MetaLoader.load` (NOT a re-implemented `registerDoctype`). This is the M3 requirement — it's what gives the new hydration path coverage.
- For perms: accept a `defs` shape where each def carries its `permissions:[DocPerm…]` children (so `syncDoctype` writes `tabDocPerm` rows). The old `registerRolePerm` calls in tests become `permissions:[…]` on the def.
- `MemoryStore` already implements `getChildren`/`deleteChildren` (verified `memory-store.js:51,57`) — round-trip is viable.

---

## 4. Integration + live-verify sequence

Run after the unit PRs land, against the engine's **own isolated Supabase project** (not the shared prod CRM project).

1. **Static gate:** `npx vitest run` — all 56 (+ new) tests green. `node --check` on each new file (no build step).
2. **Push base migration (human):** `supabase db push --dry-run` then `supabase db push` for `<ts>_meta_doctypes.sql`. Confirm `tabDocType/Field/Perm/Role/Workflow/WorkflowTransition` + `meta_version` exist and `service_role` is granted. *(Deploy = human-confirmed per CLAUDE.md §1.)*
3. **Round-trip a doctype DEFINED-AS-DATA end-to-end:**
   a. `Installer.emitMigration(CustomerDef)` → writes `<ts>_customer.sql` (already exists as `20260620000001_customer.sql` — assert the emitter reproduces equivalent DDL).
   b. (table already pushed) `Installer.syncDoctype(CustomerDef, SupabaseStore)` → meta rows land in `tabDocType/tabDocField/tabDocPerm`.
   c. `Installer.bumpMetaVersion(store)`.
   d. A request through `handler.handle({method:'POST', doctype:'Customer', body:{customer_name:'Acme', territory:'NSW'}, ctx:adminCtx}, store)` → `MetaLoader.ensure('Customer')` hydrates Customer **from the rows just written** (NOT from `bootstrap.js` code), `createDoc` succeeds, returns a masked row.
   e. `GET` the same Customer back → confirms the doctype is being read **as data**, the redeploy-free path works.
4. **Invalidation check:** bump `meta_version`, wait > `META_VERSION_TTL_MS`, issue a request → `ensureFresh` re-reads and re-hydrates.

---

## 5. Critique non-blocking notes — folded in

- **N1 (fail loud on closure regression):** in `MetaLoader.load` step 4, assert `hasMeta(f.options)` before `getMeta(f.options).table`; throw a clear dev error rather than producing `table: undefined`. Keep `links.js` `tryMeta`'s catch. (Specified in C1 above + the loader test asserts the throw.)
- **N2 (Table-ordering vs Link-membership):** in `MetaLoader.ensure`, treat **Table-edge ordering** (load child-first, needed for `.table`) separately from **Link-edge membership** (only needs to be present in the cache, order-free). Do not conflate into one "deepest-child-first" pass. (Specified in C1 §ensure step 3.)

---

## 6. Per-module assignment (fewest parallel-safe build units)

Group into **4 parallel build units for PR-1/PR-2**, then sequential consumer PRs. Each unit = one `implement` specialist.

| Unit | Specialist builds | Files | Depends on | Parallel with |
|---|---|---|---|---|
| **U-A (meta core)** | `Meta`, `MetaRegistry`, `boot-meta` + temp `registerDoctype` shim | `meta/meta.js`, `meta/registry.js`, `meta/boot-meta.js` + 3 test files | — | U-B, U-E |
| **U-B (ddl)** | `DDLEmitter` (pure) | `meta/ddl.js` + `ddl.test.js` | — | U-A, U-E |
| **U-E (base migration)** | base migration SQL | `supabase/migrations/<ts>_meta_doctypes.sql` | column-name freeze w/ U-A | U-A, U-B |
| **U-C (loader + helper)** | `MetaLoader`, `seedViaLoader` | `meta/loader.js`, `test-helpers/seed-via-loader.js` + `loader.test.js` | U-A | (after U-A) |
| **U-D (installer)** | `Installer` | `meta/installer.js` + `installer.test.js` | U-A, U-B | U-C |
| **U-F (consumers)** | perms+workflow+handler+bootstrap refactors + test migration | `perms/permissions.js` (del `perms/registry.js`), `workflow/{hooks,workflow}.js` (del `workflow/registry.js`), `api/handler.js`, `bootstrap.js` + migrate 7 test files | U-A, U-C, U-G(helper) | split internally: perms ‖ workflow can be 2 specialists |

**Recommended dispatch:**
- **Wave 1 (parallel):** U-A, U-B, U-E.
- **Wave 2 (parallel after A):** U-C (includes the `seedViaLoader` helper), U-D.
- **Wave 3 (sequential, suite-green per PR-4/5/6):** U-F as 2 specialists — one for perms (PR-4), one for workflow (PR-5) — then the lead lands handler+bootstrap+shim-removal (PR-6) and runs integration §4.

---

## 7. Composition go/no-go

**Checks performed:**
- **Interfaces line up:** `getMeta` stays sync/throw-on-miss (every consumer in `document.js`, `permissions.js`, `service.js`, `naming.js`, `links.js` keeps verbatim calls — verified by Read). `Meta` exposes the exact props those read. `handler.handle` is already async + has `doctype`/`store` — the prime insertion point is real (`handler.js:27-28`).
- **No cycles:** boot seed pins DocType/Field/Perm → loader reads `tabDocType` via the pinned meta (no re-entry). Transitive closure has a visited-set guard (terminates on mutual Links — critique verified). Table edges are acyclic (Frappe forbids child cycles).
- **Contract-compliant:** Store stays PostgREST-only; DDL is emit-to-file + human `db push` (CLAUDE.md §1 honored). Loader is the single snake→camel/0-1→bool site (DRY). 56-test green-per-PR ordering holds because of the temporary `registerDoctype` shim bridge.

**One open seam — W1 (workflow data source, F4):** whether `getWorkflow` becomes async or is primed sync inside `MetaLoader.ensure`. This is an **implementation choice within a frozen public contract** (`transition`/`availableActions` signatures don't change either way), **not** a composition failure — `availableActions` is only called from `service`/UI paths that can prime in `ensure`. Flagged for the workflow specialist to resolve at build; both options compose. Not a NO-GO.

### VERDICT: **GO** — the plan composes. Interfaces align, no cycles, every consumer's sync contract is preserved by the per-request prime, the Store/DDL split honors the migration rule, and the test-migration ordering keeps the suite green one PR at a time. Release to the build phase.
