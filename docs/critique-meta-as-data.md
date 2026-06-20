# Critique: Meta-as-Data design

- **Reviewer:** critique
- **Date:** 2026-06-20
- **Design under test:** `docs/adr-meta-as-data.md` + `diagrams/meta-as-data-class.puml`
- **Authority cross-check:** Frappe (`frappe/model/meta.py`, core doctype JSON)
- **Method:** Read on the live engine (`src/**`, `supabase/migrations/**`, `*.test.js`); no codegraph (repo not indexed).

## Verdict summary

**FAIL** — two blocker-class holes (C1, C2) make the design un-buildable as written, plus three
high-severity correctness/contract gaps (C3–C5) and four medium gaps. The *direction* is sound
and Frappe-faithful; the holes are in the seams the ADR labels "unchanged contract" but which are
not. All are concretely fixable; this is a re-architect-the-seams pass, not a redesign of the idea.

---

## BLOCKER findings

### C1 — The runtime reads meta **synchronously**; the design's loader is **async**. "Unchanged contract" is false. (BLOCKER)

The ADR (§Module layout) and class diagram both claim `Document`, `permissions.js`, `service.js`
keep an "unchanged contract" via `this.meta = getMeta(doctype)` / `MetaRegistry.get(doctype)`. That
is the central load-bearing claim and it does not hold.

Every current meta consumer is **synchronous**:
- `runtime/document.js:27` — `this.meta = getMeta(doctype)` in a **constructor** (cannot be async).
- `runtime/document.js:159` `newDoc`, `:166` `loadDoc` — call `getMeta` sync.
- `perms/permissions.js:43,50,65,86` — `visibleFields/maskRead/assertCanWrite/queryConditions` all
  call `getMeta(doctype)` sync, and these run *inside* sync functions called by `service.js`.
- `api/service.js:51` `listDocs` — `getMeta(doctype)` sync.
- `runtime/validate.js`, `runtime/links.js`, `runtime/naming.js` — receive `meta` as an argument
  (fine) but their callers obtained it synchronously.

The design's `MetaLoader.load(doctype): Promise<Meta>` and `MetaRegistry.get()` that may trigger a
DB read **cannot** satisfy a synchronous `getMeta`. You cannot lazily hydrate from Postgres inside a
synchronous constructor or inside `maskRead`. Something must give, and the ADR never says what.

**Fix direction (pick one, state it explicitly):**
- **(a) Per-request prime (recommended, smallest blast radius):** keep `getMeta`/`MetaRegistry.get`
  **synchronous, cache-only**. Add one async step at the top of each `api/handler.js` request that
  resolves the doctype's meta into the cache *before* dispatch — `await MetaRegistry.ensure(doctype)`
  (and its child/link target doctypes). After that, all the sync consumers read from a warm cache
  unchanged. This is the only option that genuinely preserves the "unchanged contract" claim — but
  the ADR must add the prime step and enumerate which doctypes to prime (the requested one **plus**
  every `Link`/`Table` target `links.js`/`document.js` will touch, or `getMeta` throws mid-pipeline).
- **(b) Make the whole chain async** — `getMeta→await`, `Document.meta` resolved in an async factory
  not the constructor, `permissions.js` functions become async. This is a large contract change to
  ~6 files and ~56 tests and directly contradicts "unchanged contract."

Until the ADR picks and specifies this, the design cannot be planned. **This is the #1 hold.**

### C2 — `boot-meta.js` seeds rows, but **nothing in the seed lets the loader read a doctype whose Link/Table targets aren't yet cached**, and the cold-start *order* is under-specified for self-reference. (BLOCKER, partial overlap with finding #8)

The chicken-and-egg story (§2) is correct in spirit (DocType IS a DocType) but the cold-start trace
is asserted, not traced. Two concrete gaps:

1. **Self-reference resolution order.** `registerBootMeta()` primes `DocType, DocField, DocPerm,
   Role, Workflow, WorkflowTransition`. But `MetaLoader.load('DocType')` from the DB would itself
   need `DocType`'s meta to read `tabDocType` — which is only present because the boot seed provided
   it. So the meta-doctypes must be served **from the boot seed forever**, never re-loaded from their
   own rows, or you re-enter the egg. The ADR says the seed "is also itself sync-able … the seed is
   just the cold-boot key" — that's ambiguous: if a sync ever bumps `meta_version` and
   `ensureFresh()` invalidates the cache, the **next** `get('DocType')` is a miss and tries
   `MetaLoader.load('DocType')` → reads `tabDocField` rows for `DocType` → needs `DocField` meta →
   which was *also* invalidated. **The boot-seeded six must be exempt from `invalidate()`** (pin
   them). State that rule explicitly; otherwise a single sync deadlocks the next cold request.

2. **The base migration that creates the meta tables is named but its contents/ordering vs the seed
   is unverified.** See C3.

**Fix direction:** add to §2 an explicit invariant — *"the six meta-doctypes are served only from
the boot seed; `MetaRegistry.invalidate()` never evicts them; `MetaLoader` never reads `tabDocType`
to describe DocType itself."* And give the actual cold-start call sequence as an ordered list, not a
paragraph.

---

## HIGH findings

### C3 — DDL **cannot run through the Store**, and the design never resolves the emit-vs-execute split for `Installer`. (HIGH — confirms LEAD finding #6)

Confirmed against `runtime/supabase-store.js`: the store is **pure PostgREST** (`this.sb.from(table)
.insert/update/...`). There is **no** path to `CREATE TABLE`/`ALTER TABLE` — PostgREST can't run DDL,
and the service-role key here is a REST key, not a SQL connection. Yet:
- ADR §4.2 says the Installer "creates/alters the data table `tab<Doctype>` via `DDLEmitter`" and the
  class diagram shows `Installer --> Store : upserts meta rows + data tables`. The "+ data tables"
  edge is **impossible** through `Store`.
- `DDLEmitter` returning SQL strings (`createTableSql/alterColumnsSql`) is correct — but the ADR
  doesn't say **who applies them**. §4 ends "the engine emits the SQL; applying it stays under … the
  existing `supabase db push` discipline" — good, but that contradicts the diagram edge and §4.2's
  "creates/alters the data table," which read as runtime execution.

**Fix direction:** make the split explicit and one-directional:
- `Installer` upserts **meta rows only** through `Store`/`Document.save()` (this part is valid).
- `DDLEmitter` **emits SQL to a migration file** under `supabase/migrations/<ts>_<doctype>.sql`; a
  **human/CLI runs `supabase db push`** (per the project's hard rule — CLAUDE.md §1, "Migration file
  → db push. Nothing else"). The Installer must NEVER attempt DDL.
- Remove/relabel the class-diagram edge `Installer --> Store : … + data tables` → `Installer -->
  DDLEmitter : emits migration SQL (human db push)`.
- Sequencing: the data-row upsert for a new doctype's meta is fine pre-DDL, but **inserting actual
  business rows** into `tab<Doctype>` will 404 in PostgREST until the table exists and PostgREST's
  schema cache reloads. Note the ordering: emit+push DDL **first**, then sync meta rows.

### C4 — Field-name casing mismatch: current `FieldDef` is **camelCase** (`readOnly`, `fetchFrom`); the ADR's columns are **snake_case** (`read_only`, `fetch_from`). This silently breaks `links.js` and field-perm logic. (HIGH)

The ADR §1 says columns "mirror Frappe's `fieldname`s exactly" and lists `read_only`, `fetch_from`,
`naming_rule`, etc. But the **live code consumes camelCase**:
- `runtime/links.js:16-17` reads `f.fetchFrom` (`if (!f.fetchFrom) continue; … f.fetchFrom.split('.')`).
- `meta/registry.js` typedef declares `readOnly`, `fetchFrom`.
- Bootstrap/customer meta use `permlevel` (matches) and `fetchFrom` would be camelCase.

If `MetaLoader` builds `FieldDef` straight from snake_case DB columns, `f.fetchFrom` is `undefined`
and **fetch_from silently stops working** — a fail-*silent*, the worst kind (violates Fail-Fast).
The ADR's claim "These map 1:1 onto the existing `FieldDef` typedef" is **false** for `read_only`
and `fetch_from`.

**Fix direction:** the `MetaLoader` must **map DB snake_case → in-code camelCase** when assembling
`FieldDef` (`read_only→readOnly`, `fetch_from→fetchFrom`), OR the codebase migrates to snake_case
field props (larger, touches `links.js`, validate, typedef, every test). State which. A mapping
layer in `MetaLoader.load()` is the DRY choice; spell out the exact column→prop table in the ADR.

### C5 — DocPerm / Check boolean semantics: Frappe stores **0/1 ints**; `permissions.js` checks **`=== true`**. Loading raw DB rows breaks every permission. (HIGH — confirms LEAD finding #7)

`perms/permissions.js` is strict-boolean throughout:
- `can()` `:20` — `p[op] === true`
- `levels()` `:35` — `p[op] === true`

The current in-memory `DocPerm` rows are JS booleans (`read: true`), so this works. But the ADR
models DocPerm as **rows in `tabDocPerm` mirroring Frappe**, and Frappe stores perm flags (and
`Check` fields) as **integer 0/1** (`docperm.json`; Frappe's `Check` fieldtype = int). A Postgres
column for `read/write/create/...` will most naturally be `int`/`smallint` or `boolean`. If it comes
back as `1` (int) or even Postgres `boolean` surfaced by PostgREST as `true` (ok) vs the migration
declaring `int`, `1 === true` is **`false`** → **all permissions silently deny** (or, worse, an int
`0` that someone coerces becomes truthy). Note `validate.js:31` already had to special-case
`Check` as `typeof v !== 'boolean' && v !== 0 && v !== 1` — proving the int/bool ambiguity is
already a known footgun here.

**Fix direction:** decide the on-disk type for perm flags and `Check` fields and **normalize in the
loader**. Recommended: store as `boolean` in Postgres (PostgREST returns real JS booleans, `=== true`
holds) — but then the ADR's "mirror Frappe 0/1" must be amended. If stored as `int`, `MetaLoader`
must coerce `!!row.read` when assembling `DocPerm`. Either way, add a test asserting `can()` works
off loaded (not hand-registered) perms. Also: the current `DocPerm` typedef keys on `doctype`;
the ADR keys children on `parent` (= DocType) — `getDocPerms()` must map `parent→doctype` (or
`permissions.js` must read `parent`). Spell out the field-rename map (mirror of C4).

---

## MEDIUM findings

### M1 — `ensureFresh()` granularity is coarse and its placement is unspecified. (MEDIUM — LEAD #2/#3)

§3 bumps a single global `meta_version` on **any** sync, so one doctype change invalidates **all**
cached meta on every warm lambda. For a one-doctype engine that's fine; the ADR should still (a)
acknowledge it's bump-all and (b) note the cheap upgrade path (per-doctype `meta_version` map) as
YAGNI-deferred, so a future planner doesn't treat coarse invalidation as a bug. More importantly,
**where `ensureFresh()` is called is undefined** — "once per request" needs a home. With fix (a)
from C1, the natural home is the per-request prime in `api/handler.js`. State it.

### M2 — The per-request `meta_version` read cost is asserted "acceptable" without the Frappe comparison the LEAD asked for. (MEDIUM — LEAD #3)

Frappe's `get_meta(cached=True)` (`meta.py:72`) does **not** hit the DB per call — it reads a
process/redis `client_cache` and only rebuilds on miss; invalidation is **push** (`clear_meta_cache`
deletes keys on change), not **poll**. The ADR's design is **poll-per-request** (one DB round-trip
every request to compare versions), which is strictly more DB traffic than Frappe. That's a
defensible serverless trade-off (stateless lambdas can't be signalled), but the ADR should say so
honestly rather than claim parity, and should offer the bounded-staleness alternative (cache the
version for N seconds → at most one version read per lambda per N s) as the explicit tuning knob.
On Vercel a warm lambda serving bursts pays the extra read on *every* call; quantify: ~1 extra
PostgREST round-trip (~5–30ms) per request. Acceptable for low QPS; call it out, don't hand-wave.

### M3 — Test-migration plan is hand-waved; 56 tests prime via `registerDoctype`/`registerRolePerm`/`registerWorkflow`. (MEDIUM — LEAD #4)

Confirmed: 9 test files prime the registries directly (handler 5, service 9, perms 9, document 3,
immutability 2, links 2, workflow 6 calls; plus `_resetRegistry/_resetPerms/_resetWorkflows` in
`beforeEach`). The ADR retires `perms/registry.js`/`workflow/registry.js` and says tests "will need
a test helper … flag for planner/implement." That is a punt, not a plan. The risk: a naive helper
that just re-implements `registerDoctype` into the new `MetaRegistry` **preserves the bug surface
but not the coverage** — the new code path is *DB-load → assemble Meta*, and if tests still seed via
an in-code shortcut, the loader/casing/coercion logic (C4, C5) is **never exercised by tests**.

**Fix direction:** the ADR should commit to a helper that seeds via **`MemoryStore` + `Installer`/
`MetaLoader`** (i.e. insert meta rows into MemoryStore, then load them through the real loader), so
tests exercise the actual hydration path. At minimum, keep `MetaRegistry.primeFrom(metas)` for the
pure-logic tests (perms/validate) **and** add loader round-trip tests for the new code. Name both.
Note `MemoryStore` must implement `getChildren`/`deleteChildren` (it's referenced in the diagram as
`Store <|-- MemoryStore` — verify it has the child-table methods the loader needs; not read here).

### M4 — Child-table derivation is plausible but the `ChildTableDef.table` source is unspecified. (MEDIUM — LEAD #9)

`document.js`/`loadDoc` consume `meta.childTables` as `{ field, doctype, table }` (`document.js:72,
103, 170`). The ADR §1 derives child tables from `DocField` rows with `fieldtype==='Table'`, where
`options` = child doctype. That yields `field` (=`fieldname`) and `doctype` (=`options`) — but
**`table`** (the child's physical `tab<Doctype>` name) is **not** on the DocField row. It must be
resolved by looking up the child doctype's own `tabDocType` row (`table` column) — which means
building a parent Meta **requires the child doctype's meta to already be loadable** (ties back to
C1/C2: the prime step must include child-table target doctypes). State the derivation precisely:
`childTables[i].table = getMeta(field.options).table`, and ensure that target is primed first.

---

## What's right (so the re-architect keeps it)

- Relational `tabDocType`+`tabDocField`+`tabDocPerm` over JSON-blob is the correct, Frappe-faithful,
  DRY choice (Options-considered #2/#3 reasoning is sound).
- Reusing `Document.save()` child-replace pipeline for meta-row upserts is genuinely idempotent
  (`document.js:71-76` delete-then-insert) — valid.
- The workflow code-hook split (LEAD #1) is **correct SoC**: declarative states/transitions/roles to
  data, `condition`/`onTransition` JS fns stay in an in-code controller map. `workflow.js:32-39`
  shows these are real closures over store/ctx — they genuinely can't be rows. This matches Frappe's
  data-vs-server-script split. **PASS on that question** — keep it; just specify the controller-map
  key (`(doctype, action)`) and how `getWorkflow` re-attaches hooks to the loaded declarative def.
- Lazy per-doctype load + module-scope cache is the right serverless analogue. The *idea* is sound;
  only the sync/async seam (C1) and invalidation honesty (M2) need work.

---

## Required before PASS (hand back to architect)

1. **C1** — pick and fully specify sync-cache + per-request prime (option a) vs full-async; the
   "unchanged contract" claim must be made true or dropped.
2. **C2** — pin the six boot-meta doctypes (exempt from invalidate); give the ordered cold-start
   sequence.
3. **C3** — make DDL emit-to-migration-file + human `db push`; remove the `Installer→Store: data
   tables` edge; specify DDL-before-rows ordering.
4. **C4** — specify the snake_case-DB → camelCase-prop mapping table in `MetaLoader`.
5. **C5** — decide perm/Check on-disk type and normalize in loader so `=== true` holds; map
   `parent→doctype` for `getDocPerms()`.
6. **M1–M4** — address inline (granularity note, honest cost + caching knob, concrete test-seed via
   MemoryStore+loader, precise child-table `table` derivation + prime order).

---

## VERDICT: **FAIL** — sound direction, but C1 (sync vs async meta) and C2/C3 (bootstrap + DDL-via-store) are build-blockers; C4/C5 are silent-correctness traps. Re-architect the seams and return.

---

# REV-2 RE-REVIEW (critique, 2026-06-20)

Re-reviewed `docs/adr-meta-as-data.md` Revision 2 + `diagrams/meta-as-data-class.puml` rev-2
against the live engine src. Each prior finding re-checked concretely below.

## Per-finding closure

### C1 (sync/async) — **CLOSED.** The most ruthless check, and it holds.
- `getMeta`/`MetaRegistry.get` stay **sync, cache-only, throw-on-miss** (ADR §3, PUML
  MetaRegistry `get(): SYNC, throw on miss`). This makes the "unchanged contract" claim genuinely
  true: `document.js:27` ctor, `permissions.js:43/50/65/86`, `service.js:51` are untouched.
- Hydration is `await MetaLoader.ensure(doctype, store)` as the first line of `handle()` — and
  `handler.js:27 handle()` **is already `async` and already receives `doctype` + `store`**, so the
  insertion point is real, not invented.
- **Transitive-closure completeness (the one I was told to be ruthless on): VERIFIED SUFFICIENT.**
  I traced every sync `getMeta` the pipeline reaches for a request:
  - `links.js:42 validateLinks` -> `tryMeta(f.options)` for each `Link` field.
  - `links.js:21-23 resolveFetchFrom` -> `tryMeta(linkDef.options)` for each `fetchFrom` source.
  - `document.js:170-173 loadDoc` -> reads `meta.childTables` (assembled, not a fresh `getMeta`).
  - child-table `.table` derivation at **assembly** time -> `getMeta(field.options).table` (M4).
  The ADR §3.2 closure = `{doctype}` + all `Link` **and** `Table` `options` targets, repeated to
  a fixed point, loaded deepest-child-first. That set is **exactly** the union of the above. After
  `ensure`, no sync `getMeta` in the pipeline can miss. **Closure is complete.**
- **Important nuance the architect got right for the right reason:** the failure mode of a missed
  Link target is NOT a throw — `links.js:50-51 tryMeta` swallows the miss (`try/catch -> null`),
  so `validateLinks`/`resolveFetchFrom` **silently skip** (`if (!target) continue`). That means an
  incomplete closure would be a **silent-correctness** bug (a Link to a non-existent row passes
  validation; `fetch_from` comes back empty), not a visible crash. So the closure's completeness
  is load-bearing for *correctness*, not just to dodge exceptions — and the rev-2 closure covers
  it. (Recommend the implementer keep `tryMeta`'s catch but add a one-line dev assertion that the
  target WAS in the prime set, so a future closure regression fails loud not silent — NON-BLOCKING
  nit, not a FAIL.)

### C2 (pinned boot doctypes + ordered cold-start) — **CLOSED.**
ADR §2 states the hard invariant: the six are served only from the boot seed; `invalidate()`
never evicts a pinned entry (PUML `MetaRegistry.invalidate: clears NON-pinned only`,
`pinned: Set<string>`); `MetaLoader` never reads `tabDocType` to describe DocType itself. The
ordered cold-start (§2 steps 1-4) is deterministic and shows `store.get('tabDocType', D)` resolving
via the **pinned** DocType meta — no loader re-entry, no deadlock on a post-sync `get('DocType')`.

### C3 (DDL emit-only, never via Store; DDL-before-rows) — **CLOSED.**
ADR §4 + PUML: Store is PostgREST-only (cannot DDL); `Installer.emitMigration(def)` writes SQL to
`supabase/migrations/<ts>_<dt>.sql`; **human runs `supabase db push`** (CLAUDE.md §1 honored);
Installer NEVER runs DDL. The impossible `Installer->Store: data tables` edge is gone, replaced by
`Installer->DDLEmitter: emits migration SQL -> file -> human db push`. Ordering stated: emit -> push
-> schema-cache reload -> upsert rows -> bump version. Correct, and it respects the project rule.

### C4 (snake->camel mapping) — **CLOSED.** Mapping table in §5 is complete: `read_only->readOnly`,
`fetch_from->fetchFrom`, plus `reqd/options/permlevel/unique/idx/fieldname/fieldtype`. Matches the
live `FieldDef` typedef and `links.js:16 f.fetchFrom` consumption exactly. Single mapping site in
`MetaLoader` (DRY).

### C5 (perm flags boolean + coercion; parent->doctype; exact DocPerm set) — **CLOSED.**
On-disk type decided as Postgres `boolean` (ADR §1 "On-disk type decision"), with **defensive `!!`
coercion** in the loader anyway so `1`/`0`/NULL can't flip a perm. §5 table renames `parent->doctype`
and emits exactly `{ role, doctype, permlevel, read, write, create, submit, cancel, delete }` as JS
booleans — precisely what `permissions.js:20,35 p[op] === true` and `levels()` consume. The Frappe
0/1 divergence is explicitly stated and justified (citations updated). Closed.

### M1 (ensureFresh home) — CLOSED: lives inside `ensure()`, the per-request prime point (§3).
### M2 (cost honesty + TTL) — CLOSED: ADR no longer claims Frappe parity; states poll-not-push,
~5-30ms/round-trip, `META_VERSION_TTL_MS` default 5s as the knob. Honest.
### M3 (test seed) — CLOSED & verified: `seedViaLoader` via `MemoryStore` + real `MetaLoader.load`;
the naive shortcut is explicitly rejected. ADR cites `memory-store.js:51,57` for
`getChildren`/`deleteChildren` — **I verified both methods exist at those lines.** The round-trip is
viable and exercises C4/C5/M4. Required assertions named (can() off loaded perms, fetchFrom after
round-trip, childTables[].table).
### M4 (child-table .table) — CLOSED: `childTables[i].table = getMeta(field.options).table`, with
deepest-child-first prime ordering guaranteeing the target is cached first.

## The 3 new architect questions

1. **`META_VERSION_TTL_MS = 5s` default** — **Fine.** Bounded staleness of <=5s for a meta change
   is acceptable for a low-QPS admin-synced engine; the knob (0 = read-every-request) is exposed.
   No objection.
2. **Visited-set guard sufficient for mutual/cyclic Links (A->B, B->A)?** — **Yes, sufficient — no
   infinite loop, no miss.** A fixed-point closure with a visited-set is the standard safe pattern:
   A is visited -> discover B -> B visited -> discover A -> **A already in visited, not re-queued**
   -> set stops growing -> terminate. Both A and B end up in the prime set, so neither sync
   `getMeta` misses. One caveat to hand to the implementer (NON-BLOCKING): the **deepest-child-first
   load order** is well-defined for the *child-table (Table)* DAG (Frappe forbids child-table
   cycles), but a **Link** cycle has no topological order. That's fine because `childTables[].table`
   only needs the *Table* target primed first (M4), and Table relationships are acyclic; **Link**
   targets only need to be *present in the cache* (for `validateLinks`/`fetchFrom`),
   order-independent. So: load Table targets child-first; Link targets can load in any order within
   the closure. The ADR's single "deepest-child-first" phrasing conflates the two but the *outcome*
   is correct — recommend the implementer treat Table-edge ordering and Link-edge membership as
   separate concerns. Not a blocker.
3. **`scope_fields text[]` on `tabDocType` as a Frappe extension** — **Clean.** It's an additive
   column backing the existing `meta.scopeFields` (`permissions.js:89 queryConditions`), already a
   first-class concept in the live engine. Postgres `text[]` maps cleanly to the JS `string[]` the
   code already expects (PostgREST returns a JS array). Documented as "our row-scope extension"
   (§1). Diverging additively from Frappe here is justified and isolated. No problem.

## Residual (all NON-BLOCKING — for the planner/implementer, not a re-architect)
- N1: keep `tryMeta`'s catch but add a dev-mode assertion that a Link target was in the prime set,
  so a future closure regression fails loud (silent-skip is the risk surface, per C1 nuance).
- N2: in the loader, treat **Table-edge ordering** (child-first, for `.table`) separately from
  **Link-edge membership** (order-free) — the ADR's single "deepest-child-first" phrasing is
  outcome-correct but slightly conflates them.
These are implementation notes; neither changes the design.

## REV-2 VERDICT: **PASS** — all five blockers/highs (C1-C5) and all four mediums (M1-M4) are
genuinely closed against the live src (not merely asserted); the three new questions resolve clean.
The transitive-closure prime is complete for every sync `getMeta` the pipeline touches, the cyclic
guard terminates without missing, and DDL/Store separation honors the project's migration rule.
Two non-blocking implementation notes (N1, N2) for the planner. **Proceed to planner.**
