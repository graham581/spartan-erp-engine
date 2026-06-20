# ADR: Meta-as-Data — the engine stores and reads its own metadata from the DB

- **Status:** Proposed — **Revision 2** (architect, after critique FAIL) → critique
- **Date:** 2026-06-20
- **Context repo:** `spartan-erp-engine`
- **Supersedes:** in-code `src/meta/registry.js` hand-fed `META`, plus the separate
  `src/perms/registry.js` and `src/workflow/registry.js` row stores.
- **Rev-2 changelog:** addresses critique C1–C5 + M1–M4. The seams previously called
  "unchanged contract" are now specified, not asserted: sync `getMeta` is kept and fed by a
  **per-request async prime** (C1); the six meta-doctypes are **pinned** (C2); DDL is
  **emit-to-migration-file only**, never run through the Store (C3); the Loader does an explicit
  **snake_case→camelCase + 0/1→boolean** mapping (C4/C5). Mediums folded in inline.

## Problem

Today the engine's metadata is **code, not data**. `registerDoctype()` is called by
`src/bootstrap.js` at module load; docperm rows live in a parallel in-memory array
(`perms/registry.js`); workflow defs in another (`workflow/registry.js`). Adding or
changing a doctype means a **redeploy**, and the metadata is scattered across three
registries that the runtime (`Document`, `permissions.js`, `workflow.js`) reads from
independently. Frappe — the behavioral authority — does the opposite: a doctype is a **row**
in `tabDocType` with `tabDocField`/`tabDocPerm` children, and `Meta` is itself a `Document`
of doctype `DocType` (`frappe/model/meta.py:130 class Meta(Document)`). We mirror that
semantic so doctypes become data, hydrated at runtime and changed by sync, not by deploy.

## Decision

### 1. The meta-doctype model (self-describing)

Store metadata as rows in data tables, exactly like any other doc, following the existing
`tab<Doctype>` shape (`name` pk, `owner`, `docstatus`, `idx`, `creation`, `modified`, +
fields) proven by `20260620000001_customer.sql`:

| Meta-doctype | Table | Children | Frappe source |
|---|---|---|---|
| `DocType` (parent) | `tabDocType` | `fields` → DocField, `permissions` → DocPerm | `core/doctype/doctype/doctype.json` |
| `DocField` (child) | `tabDocField` | — | `core/doctype/docfield/docfield.json` (`autoname: hash`) |
| `DocPerm` (child) | `tabDocPerm` | — | `core/doctype/docperm/docperm.json` (`autoname: hash`) |
| `Role` | `tabRole` | — | `core/doctype/role/role.json` (`autoname: field:role_name`, unique) |
| `Workflow` (parent) | `tabWorkflow` | `transitions` → Workflow Transition | `core/doctype/workflow/workflow.json` |
| `Workflow Transition` (child) | `tabWorkflowTransition` | — | `.../workflow_transition` |

DB columns mirror Frappe's `fieldname`s (snake_case on disk), but the **in-memory `FieldDef`
/`DocPerm` shapes stay camelCase** — the Loader maps between them (§5, C4/C5). The on-disk
columns:

- **DocType:** `name` (the doctype name), `istable`, `issingle`, `is_submittable`,
  `autoname`, `naming_rule`, `module`, `scope_fields` (text[] — our row-scope extension).
- **DocField:** `parent` (= owning DocType `name`), `fieldname`, `fieldtype`, `reqd`,
  `options`, `permlevel`, `read_only`, `unique`, `fetch_from`, `idx`.
- **DocPerm:** `parent` (= DocType `name`), `role`, `permlevel`, `if_owner`, `read`, `write`,
  `create`, `submit`, `cancel`, `delete`.

**On-disk type decision (C5):** all boolean-ish columns (`reqd`, `read_only`, `unique`,
`istable`, `issingle`, `is_submittable`, `if_owner`, and the six DocPerm flags) are declared
**Postgres `boolean`**, NOT Frappe's `int 0/1`. PostgREST returns real JS booleans, so the
existing `p[op] === true` checks (`permissions.js:20,35`) hold. This is a deliberate, stated
**divergence from Frappe's 0/1 ints** — we keep Frappe's *semantics* (a Check is a yes/no
flag) but choose the JS-native on-disk type. The Loader **still normalizes defensively**
(`!!row.read`, §5) so a future `int` column or a NULL can't silently flip a permission to
deny. (Rationale: `validate.js:31` already special-cases `Check` as
`typeof v !== 'boolean' && v !== 0 && v !== 1` — the int/bool ambiguity is a known footgun
here, so we close it at the disk boundary.)

A doctype's **child-table relationships** are derived from DocField rows whose
`fieldtype === 'Table'` (the `options` names the child doctype), exactly how Frappe derives
`get_table_fields()`. The child's physical table name is **not** on the DocField row, so it is
resolved from the child doctype's own DocType row: `childTables[i].table =
getMeta(field.options).table` (M4). This is why the prime step (§3) must load child-table
target doctypes **before** assembling the parent Meta.

### 2. Bootstrap (chicken-and-egg) — pinned seed + ordered cold start (C2)

To read `tabDocType`, the loader must already know the **shape** of `tabDocType`. Frappe
solves this with `load_doctype_from_file` for core doctypes and the fact that `Meta` is a
`Document` (`meta.py:104 load_meta`, `:112 load_doctype_from_file`, `:130 class Meta(Document)`).
We mirror it with a **minimal in-code seed** — `src/meta/boot-meta.js` exporting
`META_DOCTYPES`: hand-written `DocMeta` for `DocType`, `DocField`, `DocPerm`, `Role`,
`Workflow`, `WorkflowTransition`.

**Hard invariant (C2):** the six meta-doctypes are served **only from the boot seed**.
`MetaRegistry.invalidate()` **never evicts a pinned entry**, and `MetaLoader` **never reads
`tabDocType` to describe `DocType` itself** (or any of the other five). Without this, a single
sync that bumps `meta_version` would invalidate the cache, and the next `get('DocType')` would
miss → `MetaLoader.load('DocType')` → need `DocType`'s meta to read its own rows →
**deadlock**. Pinning makes the seed the permanent cold-boot key. The six are also written as
rows into `tabDocType`/etc. during install (so the DB is complete and admins can *see* them),
but those rows are never the **source** the engine reads its own meta from — they exist for
introspection/UX, the pinned seed is authoritative for the meta-doctypes.

**Ordered cold-start sequence** (deterministic, no re-entry):

```
1. module load: registerBootMeta()
     -> MetaRegistry.primeFrom(META_DOCTYPES) with pinned=true for all six
     (cache now holds DocType, DocField, DocPerm, Role, Workflow, WorkflowTransition)
2. request arrives at handler.handle({doctype:'Customer', ...}, store)
3. handler awaits MetaLoader.ensure('Customer', store)   <-- the prime (§3)
     a. ensureFresh(store): one version check (bounded-staleness, §3/M2)
     b. resolve transitive set: 'Customer' + every Link/Table target it references
     c. for each not-yet-cached, non-pinned doctype D in the set, deepest child first:
          MetaLoader.load(D, store):
            - store.get('tabDocType', D)                    (DocType meta is PINNED -> sync hit)
            - store.getChildren('tabDocField', D, 'DocType', 'fields')
            - store.getChildren('tabDocPerm',  D, 'DocType', 'permissions')
            - map columns -> FieldDef/DocPerm (snake->camel, 0/1->bool)  (§5)
            - derive childTables (fieldtype==='Table'); .table = get(options).table  (M4)
            - MetaRegistry.set(D, meta, pinned=false)
4. sync pipeline runs: newDoc/loadDoc -> getMeta('Customer') is now a CACHE HIT (sync)
     Document ctor, permissions.js, service.js all read warm cache, UNCHANGED.
```

Step 3 reading `tabDocType`/`tabDocField`/`tabDocPerm` works because step 1 pinned their meta
— `store.get('tabDocType', ...)` resolves the table name from the pinned `DocType` meta
without re-entering the loader.

### 3. Sync `getMeta` + per-request async PRIME (C1 — the #1 hold)

**Decision: option (a). `getMeta` / `MetaRegistry.get(doctype)` stay SYNCHRONOUS and
cache-only** — they read the module-scope cache and throw `NotFoundError` on a miss (never hit
the DB). A miss is a *programming error* (something wasn't primed), surfaced fail-fast, not a
lazy DB read inside a constructor. This is what makes the "unchanged contract" claim **true**:
`document.js:27` ctor, `permissions.js:43/50/65/86`, `service.js:51`, `loadDoc`/`newDoc`,
`links.js`/`validate.js`/`naming.js` all keep calling sync `getMeta` verbatim.

The hydration moves to **one async step at the request boundary**, mirroring Frappe loading
meta at request start:

- **Where:** `api/handler.js` `handle()` is **already `async`** and already receives `doctype`
  + `store`. Add, as the first line inside `try`, `await MetaLoader.ensure(doctype, store)`
  before any `listDocs/createDoc/...` dispatch. (For the workflow/submit paths the doctype is
  the same one already in scope.)
- **`MetaLoader.ensure(doctype, store)`** resolves the **transitive prime set** and loads any
  missing members into the cache:
  1. `await ensureFresh(store)` (§ staleness check below).
  2. Compute the closure: start with `{doctype}`; for each member, after its DocType row is
     read, add every `options` target of its `Link` and `Table` fields; repeat until the set
     stops growing. This is exactly the set the sync pipeline will touch —
     `links.js:22/42 tryMeta(linkDef.options)`, `document.js:170` child loads,
     `links.js resolveFetchFrom` — so after `ensure`, **no sync `getMeta` inside the pipeline
     can miss.** (Bounded: a doctype graph is small; a visited-set guards self/mutual reference.)
  3. Load each uncached, non-pinned member **deepest-child-first** so `getMeta(options).table`
     (M4) is available when the parent assembles its `childTables`.

The transitive closure is the load-bearing detail critique demanded: priming only the top
doctype would let `validateLinks`/`resolveFetchFrom`/child-load throw mid-pipeline on a sync
`getMeta` miss for a target. `ensure` pre-warms the whole touched set.

**Stateless caching + staleness knob (M1/M2 — honest, not over-claimed):** the `MetaRegistry`
cache is a **module-scope `Map`** living for the warm lambda — the serverless analogue of a
per-process cache. **This is NOT Frappe parity:** Frappe's `get_meta(cached=True)`
(`meta.py:72`) reads a process/redis cache and is **push-invalidated** (`clear_meta_cache`
deletes keys on change, `meta.py:96`); stateless Vercel lambdas can't be signalled, so we
**poll** a `meta_version` row instead. Cost: ~1 extra PostgREST round-trip (~5–30 ms). To
avoid paying it on *every* request of a warm burst, `ensureFresh()` caches the version for a
**bounded-staleness window `META_VERSION_TTL_MS` (default 5 s)**: it only re-reads the version
row if more than the TTL has elapsed since the last check. So a warm lambda pays at most one
version read per TTL window, and a synced change propagates within `META_VERSION_TTL_MS`. The
TTL is the explicit tuning knob (set 0 for read-every-request, higher for fewer reads / more
staleness). `ensureFresh()` lives inside `ensure()` (M1: that is its home — the per-request
prime point).

**Invalidation granularity (M1):** a sync bumps a **single global `meta_version`**, so any
sync invalidates **all non-pinned** cached meta on next check. For a small engine this is fine;
the cheap upgrade (a per-doctype version map) is **YAGNI-deferred** and noted here so a future
planner treats coarse invalidation as a deliberate choice, not a bug. Pinned meta-doctypes are
never invalidated (§2).

### 4. Sync / install ("migrate" equivalent) — DDL emit-only, rows via Store (C3)

The Store is **pure PostgREST** (`supabase-store.js` — `this.sb.from(table).insert/update`):
it **cannot run DDL**. So the Installer's two jobs are split one-directionally:

1. **Data-row upserts via the Store / `Document.save()` pipeline (valid).** `Installer`
   upserts `tabDocType` (parent) + `tabDocField` + `tabDocPerm` children through the existing
   `Document.save()` child-replace path (`document.js:71-76` delete-then-insert) → idempotent
   by `name`.
2. **DDL is EMITTED to a migration file, never executed.** `DDLEmitter` is a **pure function**
   returning SQL strings (`createTableSql` / `alterColumnsSql`, `create table if not exists` +
   `alter table ... add column if not exists`). `Installer.emitMigration(def)` writes them to
   `supabase/migrations/<ts>_<doctype>.sql`. A **human runs `supabase db push`** per the
   project hard rule (CLAUDE.md §1: "Migration file → db push. Nothing else"). **The Installer
   never attempts DDL** and never touches the Store for table creation.

**Ordering (C3):** DDL **first**, rows **second**. Inserting business rows (or even the meta
rows for a brand-new `tab<Doctype>`) 404s in PostgREST until the table exists *and* PostgREST's
schema cache reloads. So the sequence for a new doctype is: emit migration → human `db push`
→ (schema cache reload) → then `Installer` upserts the meta rows. `bumpMetaVersion(store)` runs
last so warm lambdas invalidate only after the new shape is live.

Idempotency is structural: upsert-by-name + `IF NOT EXISTS` DDL + a version bump that is a
**set, not append**. Sync runs from a **guarded admin route / CLI only**, never the request
path (Least Privilege).

### 5. Loader mapping — snake_case→camelCase + 0/1→boolean (C4 + C5)

`MetaLoader.load()` does **not** hand raw DB rows to the runtime. It maps each row into the
in-memory shapes the live code already consumes (camelCase), closing the silent-failure traps:

**DocField row → `FieldDef`** (camelCase, matches `meta/registry.js` typedef +
`links.js:16 f.fetchFrom`):

| DB column (snake) | `FieldDef` prop (camel) | coercion |
|---|---|---|
| `fieldname` | `fieldname` | — |
| `fieldtype` | `fieldtype` | — |
| `reqd` | `reqd` | `!!` |
| `options` | `options` | — (string or `\n`-split kept as today) |
| `permlevel` | `permlevel` | `Number()` (default 0) |
| `read_only` | `readOnly` | `!!` |
| `unique` | `unique` | `!!` |
| `fetch_from` | `fetchFrom` | — |
| `idx` | `idx` | `Number()` |

**DocPerm row → `DocPerm`** (the exact field set `permissions.js` reads, all booleans):

| DB column | `DocPerm` prop | coercion |
|---|---|---|
| `parent` | `doctype` | **rename** (C5: child rows key on `parent` = DocType `name`; `permissions.js` reads `doctype`) |
| `role` | `role` | — |
| `permlevel` | `permlevel` | `Number()` (default 0) |
| `read`/`write`/`create`/`submit`/`cancel`/`delete` | same | `!!` each (so `p[op] === true` holds even if a flag comes back `1`/`0`/NULL) |
| `if_owner` | `ifOwner` | `!!` (reserved; not yet read by `permissions.js`) |

So `getMeta(dt).getDocPerms()` returns rows of exactly
`{ role, doctype, permlevel, read, write, create, submit, cancel, delete }` as JS booleans —
satisfying `can()`/`levels()` unchanged. The mapping lives in **one place** (`MetaLoader`),
the DRY choice over migrating every consumer to snake_case.

### 6. Perms / workflow reconciliation

- **DocPerm:** `perms/registry.js` is **retired**. DocPerm rows become `DocType.permissions`
  children, carried on the loaded `Meta` as `permissions: DocPerm[]` (mapped per §5).
  `permissions.js` reads `getMeta(doctype).getDocPerms()` — `can()`, `levels()`,
  `visibleFields()`, `maskRead()`, `assertCanWrite()`, `queryConditions()` are **unchanged in
  logic**; only the source moves and the parent→doctype / 0/1→bool mapping (§5) makes the data
  match what they expect. `Role` becomes `tabRole` data; `context.js` still reads `ctx.roles`
  (no change).
- **Workflow (critique PASS — keep the split, specify the key):** `workflow/registry.js` is
  retired. The **declarative** parts (states, `from`/`to`/`action`, allowed `roles`,
  `stateField`, `initial`, `guard` text) come from `tabWorkflow` + `tabWorkflowTransition`
  rows and are assembled into the existing `WorkflowDef` shape by the loader. The **code hooks**
  — `condition` and `onTransition`, which `workflow.js:32-39` shows are real closures over
  `(doc, ctx, store)` and genuinely cannot be DB rows — stay in an **in-code controller map
  keyed by `(doctype, action)`**: `WORKFLOW_HOOKS["<Doctype>::<action>"] = { condition?,
  onTransition? }`. `getWorkflow(doctype)` returns the declarative def **re-attached** with its
  hooks: for each transition `t`, look up `WORKFLOW_HOOKS["<doctype>::"+t.action]` and set
  `t.condition`/`t.onTransition` from it (undefined hooks → the transition simply has none, as
  today). This matches Frappe's data-vs-server-script split: declarative state machine in data,
  imperative logic in code.

### Module layout (to-be)

```
src/meta/
  boot-meta.js      NEW  META_DOCTYPES seed + registerBootMeta() (pinned; chicken-and-egg)
  registry.js       MOD  -> MetaRegistry: module-scope cache, pinned set, version+TTL,
                         SYNC get()/has() (cache-only, throw on miss), invalidate (skips pinned)
  meta.js           NEW  Meta class (wraps DocType doc + assembled fields/perms/childTables)
  loader.js         NEW  MetaLoader: ensure(doctype,store) [prime: transitive closure],
                         load(doctype,store) [map snake->camel, 0/1->bool, derive childTables],
                         ensureFresh(store) [version poll w/ TTL]
  installer.js      NEW  Installer: upsert meta rows (Store/save), emitMigration (DDL->file),
                         bumpMetaVersion(store). NEVER runs DDL.
  ddl.js            NEW  DDLEmitter (pure: createTableSql / alterColumnsSql)
src/perms/
  registry.js       DEL  (DocPerm now DocType.permissions children)
  permissions.js    MOD  reads getMeta(doctype).getDocPerms() (unchanged logic)
  context.js        —    unchanged
src/workflow/
  registry.js       DEL  (Workflow now tabWorkflow rows)
  workflow.js       MOD  getWorkflow assembles declarative def from rows + re-attaches
                         WORKFLOW_HOOKS[(doctype,action)] closures; transition() unchanged
  hooks.js          NEW  WORKFLOW_HOOKS map (condition/onTransition closures, in-code)
src/api/
  handler.js        MOD  await MetaLoader.ensure(doctype, store) as first step in handle()
  service.js        —    unchanged (sync getMeta reads warm cache)
src/runtime/
  document.js       —    unchanged (this.meta = getMeta(doctype), sync)
  links.js,validate.js,naming.js,store.js,supabase-store.js,memory-store.js — unchanged
src/bootstrap.js    MOD  registerBootMeta() seed; Customer becomes rows after install
supabase/migrations/
  <ts>_meta_doctypes.sql  NEW  tabDocType/tabDocField/tabDocPerm/tabRole/tabWorkflow/
                               tabWorkflowTransition (boolean flag cols) + meta_version 1-row
```

### Test strategy (M3 — concrete, not a punt)

The 9 test files that prime via `registerDoctype`/`registerRolePerm`/`registerWorkflow` migrate
in two tiers so the **new hydration path gets coverage**:

1. **Pure-logic tests** (perms, validate, links) may keep a fast in-cache seed via
   `MetaRegistry.primeFrom(metas)` — they test logic, not loading.
2. **Hydration round-trip tests (new, required):** a helper `seedViaLoader(defs)` that
   `Installer`-upserts the meta rows into a **`MemoryStore`** then `MetaLoader.load`s them back
   through the **real loader** — so snake→camel (C4), 0/1→bool (C5), parent→doctype (C5), and
   child-table `.table` derivation (M4) are all exercised. Add at least: `can()` works off
   loaded (not hand-registered) perms; `fetchFrom` resolves after a loader round-trip;
   `childTables[].table` is correct. `MemoryStore` already implements
   `getChildren`/`deleteChildren` (verified `memory-store.js:51,57`), so the round-trip is
   viable. (The naive "re-implement registerDoctype into MetaRegistry" helper is explicitly
   rejected — it would preserve the API but skip the loader, exactly the code C4/C5 break.)

## Options considered

1. **Keep in-code registries, generate from ERPNext JSON at build** — rejected: still requires
   a redeploy to change a doctype, and the project has **no build step**; not meta-as-data.
2. **Store meta as JSON blobs (whole def in a `jsonb`)** — rejected: diverges from Frappe's
   relational DocField/DocPerm model, loses queryability, breaks the "doctype is a doc with
   child tables" self-description (DRY: should reuse the same parent/child machinery).
3. **Relational tabDocType + tabDocField + tabDocPerm children, sync cache-only `getMeta` fed
   by a per-request transitive prime, DDL emitted-to-migration** — **chosen.** Faithful to
   Frappe semantics, preserves every sync consumer unchanged, honors the Store contract and the
   `db push` discipline.
4. **(C1 option b) Make the whole meta chain async** — rejected: turns `Document.meta` into an
   async factory and `permissions.js` into async functions, a ~6-file + ~56-test contract
   change that contradicts the "unchanged contract" goal. The per-request prime achieves the
   same correctness with the blast radius confined to `handler.js` + the new meta modules.

## Design-contract compliance

- **DRY:** meta uses the same Document/Store/child-table pipeline as user docs; three scattered
  registries collapse into one loaded `Meta`; one mapping layer in the Loader.
- **KISS / YAGNI:** sync cache-only `getMeta`, lazy per-doctype prime, coarse global version
  (per-doctype map deferred), no distributed cache.
- **SOLID / SoC:** `MetaLoader` (hydrate/prime) vs `MetaRegistry` (cache) vs `Installer` (write
  rows + emit SQL) vs `DDLEmitter` (pure SQL) are separate; stateful classes vs pure-fn modules
  kept distinct; declarative workflow data vs in-code hooks split.
- **Least Privilege:** sync/DDL admin/CLI-gated; DDL never auto-run; deploy stays human-gated.
- **Idempotency:** upsert-by-name + `IF NOT EXISTS` DDL + set-not-append version bump.
- **Fail-Fast:** sync `getMeta` **throws** on an un-primed miss (a bug, surfaced immediately,
  not a silent lazy read); the Loader's `!!` coercions stop a `1`/`0`/NULL from silently
  denying a permission; pinned meta-doctypes can't be invalidated into a deadlock.

## Consequences

- A new doctype ships by **emit migration → human `db push` → sync meta rows → version bump**,
  not redeploying code (except code hooks: controller subclasses + workflow
  `condition`/`onTransition`, in-code by design).
- One bounded version read per `META_VERSION_TTL_MS` per warm lambda (default 5 s) — honest
  extra DB traffic vs Frappe's push-invalidation; the TTL is the knob.
- `perms/registry.js` and `workflow/registry.js` are deleted; tests migrate per the M3 tiers,
  adding loader round-trip coverage.
- The per-request `ensure()` adds an async hop at the top of every request; it is the only
  place hydration happens, keeping the rest of the pipeline synchronous and unchanged.

## Frappe citations

- `frappe/model/meta.py:72` `get_meta(doctype, cached=True)` over `client_cache`
  `doctype_meta::<doctype>`; `:96` `clear_meta_cache` (**push**-invalidation — we poll instead,
  M2); `:104` `load_meta`; `:112` `load_doctype_from_file` (bootstrap of core doctypes from
  file — our pinned seed); `:130` `class Meta(Document)` (Meta is itself a Document — the
  self-describing pattern).
- `core/doctype/doctype/doctype.json` — DocType has child tables `fields`/`permissions`, flags
  `istable`/`issingle`/`is_submittable`, `autoname`/`naming_rule`.
- `core/doctype/docfield/docfield.json`, `.../docperm/docperm.json` — `autoname: hash`; DocPerm
  columns role/if_owner/permlevel/read/write/create/delete/submit/cancel/amend (Frappe stores
  these as **int 0/1** — we diverge to Postgres `boolean` + normalize, C5).
- `core/doctype/role/role.json` — `autoname: field:role_name`, unique role_name.
- `core/doctype/workflow/workflow.json` (+ `workflow_transition`, `workflow_document_state`) —
  Workflow as a doctype with transition children; declarative states/transitions in data,
  server-script/controller code separate (our in-code hook map).
