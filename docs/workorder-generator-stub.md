# Work Order — Pass E: closure-bounding + link-stubbing + Frappe-core handling

- **Source design (FROZEN):** `docs/adr-generator-stub.md` (REV 2) + `docs/critique-generator-stub.md` (PASS 2).
- **Planner:** this document. Date: 2026-06-21. **Composition: GO** (see §Compose-check).
- **Repo:** `C:\Users\parrg\Documents\spartan-erp-engine`.
- **Build phase:** the LEAD spawns one `implement` specialist per UNIT below. Units flagged
  *serialize* share a file and must NOT run in parallel with their stated sibling.
- **Run mode:** `npx vitest run <file>` (never watch). Migration is **author-only** (deploy-gated).

This work order **adds** a bounded install mode; it does not supersede `docs/workorder-generator.md`.

---

## 0. Registry / S-A-I tie-back

This is an **engine enhancement** (`spartan-erp-engine`), not a SpartanCRM `S/A/I` bug. No
`BUGS-*.md` row. Done-criteria here become the *How to verify* section of the engine's own ADR
trail (`adr-generator-stub.md` → this work order → the per-unit vitest specs). Planning lessons
append to `lessons_learned\generator-stub.md` in this repo's docs trail if one is kept; none filed
this pass (no overrun).

---

## 1. Unit map — every editable file → exactly ONE owning unit

| Unit | Owns (files) | Parallel-safe with | Serialize against |
|---|---|---|---|
| **U-EXTRACT** | `src/generator/select-doctypes.js` (NEW `depsByKind` + NEW `planInstall`; `_depsOf`/`closureOver` untouched) | U-STUBDEF, U-MARKER, U-LINK, U-RESERVED | — |
| **U-STUBDEF** | `src/generator/erpnext-to-def.js` (NEW `makeStubDef`) | U-EXTRACT, U-MARKER, U-LINK, U-RESERVED | — |
| **U-MARKER** | `src/meta/boot-meta.js`, `src/meta/installer.js` (**syncDoctype write + migrate 4-way branch — SAME unit**), `src/meta/loader.js`, `src/meta/meta.js`, `src/meta/registry.js` | U-EXTRACT, U-STUBDEF, U-LINK, U-RESERVED | — (this unit is the sole writer of all 5 marker-chain files **and** `installer.migrate`) |
| **U-LINK** | `src/runtime/links.js` (soft-link guard) | all | — |
| **U-RESERVED** | `src/validation/request-schemas.js` (add `is_stub` to `RESERVED_KEYS`) | all | — |
| **U-CLI** | `scripts/generate-doctypes.mjs` (`--stub-deps` mode) | — | **after** U-EXTRACT + U-STUBDEF + U-MARKER land (consumes all three) |
| **U-MIGRATION** | `supabase/migrations/<ts>_doctype_is_stub.sql` (ALTER tabDocType) — **AUTHOR ONLY, deploy-gated** | all | — (no code import) |

**The collision call-out (the bit that bites):** `src/meta/installer.js` is touched by BOTH the
marker-chain `syncDoctype` write (add `is_stub: def.isStub ?? false` to `docTypeRow`) AND the
`migrate` 4-way branch. These are **one owning unit (U-MARKER)** — never split across two
specialists. The marker chain also spans `boot-meta.js / loader.js / meta.js / registry.js`
(mirrors how `depends_on` (U9) and `issingle` (U6) threaded the same five files). U-MARKER owns
all six edits as one atomic change so the round-trip (write → read → getter → typedef) lands
coherent.

---

## 2. Dependency order / parallel groups

```
GROUP A (all parallel — no shared files, no import cycles):
   U-EXTRACT     (select-doctypes.js : depsByKind + planInstall)
   U-STUBDEF     (erpnext-to-def.js  : makeStubDef)
   U-MARKER      (boot-meta + installer{sync+migrate} + loader + meta + registry)
   U-LINK        (links.js           : soft-link guard)
   U-RESERVED    (request-schemas.js : is_stub reserved key)

GROUP B (after GROUP A — integration owner):
   U-CLI         (generate-doctypes.mjs : --stub-deps; imports planInstall + makeStubDef + migrate)

AUTHOR-ONLY (any time; NOT applied by an agent — human db push):
   U-MIGRATION   (ALTER tabDocType ADD is_stub)
```

**Why GROUP A is fully parallel:** the five files have no overlap and no new import edges between
them. `links.js` reads `meta.isStub` at *runtime* (the getter U-MARKER adds) — that is a data
dependency satisfied by the meta round-trip at run time, not a build/import dependency, so the two
units compile and unit-test independently (U-LINK's test stubs a meta with `isStub:true`).
**Why U-CLI is GROUP B:** it imports `planInstall` (U-EXTRACT), `makeStubDef` (U-STUBDEF), and
calls `migrate` with stub defs (U-MARKER) — it cannot integration-pass until all three exist.

---

## 3. FROZEN interface contracts

Specialists MUST NOT diverge from these signatures/returns.

### 3.1 U-EXTRACT — `src/generator/select-doctypes.js`

**(a) `depsByKind(json) → { links: string[], tables: string[] }` — NEW (this is the critique
E3-reuse TASK; do NOT assume `_depsOf` splits kinds — it returns a flat list).**

```js
/**
 * Split a DocType JSON's direct deps by edge kind.
 * Link            → links[]
 * Table | Table MultiSelect → tables[]
 * Dynamic Link    → excluded (options is a sibling field name, not a doctype).
 * Mirrors the loader's split (loader.js:206-211) but for raw JSON.
 * @param {object} json  parsed DocType JSON
 * @returns {{ links: string[], tables: string[] }}  de-duped within each list; trimmed; non-empty only
 */
export function depsByKind(json)
```
- Reuse `_depsOf`'s field-guard idiom (typeof options === 'string' && trim() !== '') per field.
- `'Table'` and `'Table MultiSelect'` → `tables`; `'Link'` → `links`. Nothing else contributes.

**(b) `planInstall(seeds, root, opts) → { full: string[], stubs: string[] }` — NEW.**

```js
/**
 * Bounded install plan: Table targets FULL (transitive to fixed point),
 * Link targets STUBBED.
 *   full  = seeds ∪ ALL transitive Table/Table-MultiSelect targets (BFS on Table edges)
 *   stubs = union of Link targets over EVERY def in `full`, MINUS full (disjoint by construction)
 * Depth bound applies to LINK edges only; Table edges followed to closure.
 * Dead-end guard: a Table/Table-MultiSelect target with NO JSON under root → THROW
 *   (Error naming the missing child) — never silently stubbed.
 * Visited-set guards a Table self/mutual cycle (A→B→A JSON) — reuse closureOver's pattern.
 * @param {string[]} seeds  seed doctype names
 * @param {string}   root   erpnext source root
 * @param {object}   [opts] reserved (no options consumed v1)
 * @returns {{ full: string[], stubs: string[] }}
 */
export function planInstall(seeds, root, opts)
```
- **Algorithm (frozen):**
  1. Build the name→file index (reuse the existing `_buildIndex(root)`).
  2. `full` = BFS from `seeds` following **`tables`** (from `depsByKind`) only, to a fixed point.
     Carry a `visited` Set (mirror `closureOver` select-doctypes.js:157) — a Table edge whose
     target is already in `visited` is not re-enqueued (cycle terminates).
  3. **Dead-end guard, INSIDE the BFS:** when a Table/Table-MultiSelect target has no entry in the
     index → `throw new Error('planInstall: Table child "<child>" (referenced by "<parent>") has no JSON under root — cannot be made full and must not be stubbed')`. (Seeds themselves with no JSON: keep the existing `closureOver` lenience of skipping unknown — but a *Table child* dead-end MUST throw. Match the ADR: the guard fires for a JSON-less **Table child**, not for a missing seed.)
  4. `stubs` = for every name in `full`, read its JSON, union all `depsByKind(json).links`; then
     subtract `full`. Result is disjoint from `full` by construction.
  5. Return `{ full: [...], stubs: [...] }` (arrays; order not contractual).
- **MUST reuse** (do not rewrite): `_buildIndex`, the per-field guard from `_depsOf`. `closureOver`
  and `_depsOf` themselves stay **unchanged** (kept behind `--closure`).

### 3.2 U-STUBDEF — `src/generator/erpnext-to-def.js`

```js
/**
 * Synthesize a stub def from a doctype NAME alone (no source JSON).
 * table formula MUST equal loader.js:138 and erpnextJsonToDef: 'tab'+name.replace(/\s+/g,'').
 * @param {string} name  target doctype name (a LINK target only — never a Table child)
 * @returns {{ doctype:string, table:string, isStub:true, submittable:false, issingle:false,
 *             istable:false, fields:[], permissions:[], scopeFields:[] }}
 */
export function makeStubDef(name)
```
- Returns EXACTLY the ADR §1 shape. `fields:[]`, `permissions:[]` (least privilege),
  `isStub:true`. No `module`/`autoname`/`naming_rule` (synthesized — none known).
- Pure; no I/O. Must pass `assertValidDef` (zero-field array is valid; `isStub` is stripped by
  the schema's strip-unknown — harmless).

### 3.3 U-MARKER — the `is_stub` round-trip (5 files) + `migrate` 4-way branch (installer.js)

**Marker chain (mirror `issingle` exactly — one line per site):**

1. `src/meta/boot-meta.js` — in the **DocType** meta entry (boot-meta.js:31-43, the `fields` array),
   add `{ fieldname: 'is_stub', fieldtype: 'Check' }` alongside `issingle`/`istable`.
2. `src/meta/installer.js` `syncDoctype` — in `docTypeRow` (installer.js:108-119), add
   `is_stub: def.isStub ?? false,` alongside `issingle`/`istable`/`is_submittable`.
3. `src/meta/loader.js` `load` — add `const isStub = !!(row.is_stub);` (mirror `issingle`
   loader.js:135) and pass `isStub` into `new Meta({ ..., isStub })` (loader.js:141).
4. `src/meta/meta.js` — `this._isStub = Boolean(def.isStub ?? false);` (mirror `_issingle` :18)
   and `get isStub() { return this._isStub; }` (mirror :30).
5. `src/meta/registry.js` — add `@property {boolean} [isStub]` to the `DocMeta` typedef (after :42).

**`migrate(def, store, opts)` — 4-way branch (FROZEN). Replaces the body of installer.js:186-199.**
Return type extends today's: `{ ddl, applied, migrationPath?, skipped? }`.

```
async function migrate(def, store, opts = {}):
  // 0. Read authoritative prior state from the meta row (no DDL introspection — ruling 2)
  const cur     = await store.get('tabDocType', def.doctype);
  const exists  = !!cur;
  const wasStub = !!(cur && cur.is_stub);
  const wantStub = def.isStub === true;

  // 3. DOWNGRADE NO-OP  (exists && !wasStub && wantStub) — condition (a)
  if (exists && !wasStub && wantStub) {
    return { ddl: '', applied: false, skipped: 'downgrade-refused' };
    // NO DDL, NO is_stub re-flip over a full table.
  }

  // 1. UPGRADE  (exists && wasStub && !wantStub) — stub → full
  if (exists && wasStub && !wantStub) {
    const ddl = alterColumnsSql(def, []);          // existingCols=[] SAFE: ADD COLUMN IF NOT EXISTS
    let applied = false; let migrationPath;
    if (opts.admin) { await opts.admin.applyDDL(ddl); applied = true; }
    else            { migrationPath = emitMigration(def, { writer: opts.writer }); }
    await store.transaction((tx) => syncDoctype(def, tx));   // rewrites meta with is_stub=false
    await bumpMetaVersion(store);
    return { ddl, applied, migrationPath };
  }

  // 2/4. FRESH (!exists) OR RE-INSTALL FULL (exists && !wasStub && !wantStub)
  //      OR FRESH STUB (!exists && wantStub) — all take CREATE TABLE IF NOT EXISTS
  const ddl = createTableSql(def);                  // existing path, unchanged
  let applied = false; let migrationPath;
  if (opts.admin) { await opts.admin.applyDDL(ddl); applied = true; }
  else            { migrationPath = emitMigration(def, { writer: opts.writer }); }
  await store.transaction((tx) => syncDoctype(def, tx));
  await bumpMetaVersion(store);
  return { ddl, applied, migrationPath };
```

- **Branch-coverage note:** `wantStub && !exists` (fresh stub install) and `wantStub && wasStub`
  (re-install a stub) both correctly fall to branch 2/4 — `createTableSql` on a stub def emits
  framework-cols-only (ddl.js), idempotent. Only `wantStub && exists && !wasStub` is the refused
  downgrade.
- **`alterColumnsSql` import** already present (installer.js:19). `emitMigration` is local.
- **PRESERVE the tx-wrap:** `syncDoctype` MUST stay inside `store.transaction(tx => syncDoctype(def, tx))`
  in every write branch (the existing parent+field+perm atomicity), and `bumpMetaVersion` stays
  OUTSIDE the tx, AFTER commit (ADR F3.3 — unchanged).
- **Do NOT add `columnsOf` to PgAdmin** (condition (b)) — PgAdmin stays write-only.

### 3.4 U-LINK — `src/runtime/links.js` `validateLinks`

ONE line, INSIDE the loop, immediately AFTER `const target = tryMeta(f.options);`:

```js
const target = tryMeta(f.options);
if (!target) continue;            // (existing) target not modelled at all — skip
if (target.isStub) continue;      // NEW — SOFT link: target is a stub (empty table), trust value
const row = await store.get(target.table, String(v));
if (!row) throw new ValidationError(`${meta.doctype}.${f.fieldname}: linked ${f.options} '${v}' does not exist`);
```

- The empty-value short-circuit (links.js:41 `if (v === undefined || null || '') continue;`) stays
  ABOVE this — so a `reqd` Link into a stub still needs a non-empty value (ruling 3 /
  `validateAgainstMeta` enforces required-ness independently). The soft branch only skips
  *existence*, never *presence*.
- Gated on **`target.isStub`** (the TARGET), never the source doctype — a stub can never soften a
  Link into a full target.

### 3.5 U-RESERVED — `src/validation/request-schemas.js`

ONE line (request-schemas.js:14):

```js
const RESERVED_KEYS = new Set(['owner', 'docstatus', 'name', 'is_stub']);
```

- `rejectReservedKeys` is already wired into BOTH `CreatePayloadSchema` (:34) and
  `UpdatePatchSchema` (:39) via `superRefine` — one Set entry rejects `is_stub` on create AND
  update. No other edit.

### 3.6 U-CLI — `scripts/generate-doctypes.mjs` `--stub-deps` mode

- Add `--stub-deps` flag to `parseArgs` (new bool `stubDeps`). The three modes
  (`--stub-deps` / `--closure` / `--no-closure`) are **mutually exclusive** — error+exit if >1.
  **LEAD ruling: do NOT flip the default. Current default behaviour (closure path) is unchanged
  this pass** — `--stub-deps` is opt-in.
- Import `planInstall` + `makeStubDef` (alongside existing `closureOver`, `erpnextJsonToDef`).
- When `stubDeps`:
  1. `const { full, stubs } = planInstall(seeds, root);` (let its throw bubble to the existing
     try/catch that prints `closureOver failed:` — reword the catch label to be mode-agnostic,
     e.g. `plan failed:`).
  2. For each name in `full`: locate JSON (`_findJsonForDoctype`), `erpnextJsonToDef`,
     `assertValidDef`, collect warnings — exactly the existing full-def loop.
  3. For each name in `stubs`: `const def = makeStubDef(name); assertValidDef(def);` — NO JSON
     lookup (stubs have none, by definition; that is the whole point).
  4. Emit/apply: feed BOTH full defs and stub defs through the existing emit/apply dispatch
     (`emitMigration` for `--emit`, `migrate(def, pgStore, {admin})` for `--apply`). `migrate`'s
     4-way branch handles stub vs full correctly via `def.isStub`.
- The non-`--stub-deps` path stays byte-for-byte as today (closure/no-closure via `closureOver`).

### 3.7 U-MIGRATION — `supabase/migrations/<full-ts>_doctype_is_stub.sql` (AUTHOR-ONLY)

```sql
-- ROLLBACK: alter table "tabDocType" drop column if exists is_stub;
alter table "tabDocType" add column if not exists is_stub boolean default false;
```

- Full-timestamp filename (`supabase migration new doctype_is_stub`). Idempotent.
- **DEPLOY-GATED:** authored by the specialist, **applied by the human** via `supabase db push`
  (§1/§7). Until pushed, `row.is_stub` reads `undefined` → `!!undefined === false` → every doctype
  reads non-stub (safe degrade to all-hard links). The specialist does **not** run `db push`.

---

## 4. Per-unit vitest specs + done-criteria

Each unit ships its test file (`<file>.test.js` beside the source, matching repo convention) and
runs green under `npx vitest run <file>`. The critique's test list (items 1–8) is distributed below
and each item is tagged `[CRIT-n]`.

### U-EXTRACT — `src/generator/select-doctypes.test.js` (extend)
- **`depsByKind` split [CRIT-2]:** a JSON with a Link, a Table, a Table MultiSelect, a Dynamic
  Link, and a Data field → `{ links:['<L>'], tables:['<T>','<TM>'] }`; Dynamic Link and Data
  excluded; empty/whitespace options dropped.
- **`planInstall` full-set is transitive [CRIT-1]:** seed `Quotation` (real ERPNext root) →
  `full` contains `Quotation` + `Quotation Item` (+ its grandchildren if any); a child's own Table
  children are full.
- **`planInstall` stubs are Link targets minus full [CRIT-1]:** `stubs` contains `Currency`/`User`
  etc. (Link targets) and is **disjoint** from `full` (assert `full ∩ stubs === ∅`).
- **Table-BFS visited-set / cycle termination [CRIT-3]:** a contrived fixture root with Table
  A→B→A → `planInstall(['A'], fixtureRoot)` **terminates** and returns `full ⊇ {A,B}` (use a temp
  fixture dir, not the real erpnext root).
- **Dead-end guard throws [CRIT-7]:** a fixture seed whose Table child has NO JSON →
  `expect(() => planInstall(['Seed'], fixtureRoot)).toThrow(/Table child .* has no JSON/)` naming
  the child.
- **Done:** all green; `_depsOf`/`closureOver` untouched (diff shows only additions).

### U-STUBDEF — `src/generator/erpnext-to-def.test.js` (extend)
- `makeStubDef('Currency')` → `{ doctype:'Currency', table:'tabCurrency', isStub:true,
  fields:[], permissions:[], submittable:false, issingle:false, istable:false, scopeFields:[] }`.
- Space-name table formula: `makeStubDef('Print Format').table === 'tabPrintFormat'`.
- `assertValidDef(makeStubDef('Currency'))` does NOT throw (zero-field def is structurally valid).
- **Done:** all green; `erpnextJsonToDef`/`mapField` untouched.

### U-MARKER — `src/meta/installer.test.js` + `src/meta/loader.test.js` (extend)
- **Round-trip:** `syncDoctype` a def with `isStub:true` → `loader.load` → `meta.isStub === true`;
  a def without it → `meta.isStub === false`. (MemoryStore; the test seeds `tabDocType.is_stub`.)
- **`migrate` FRESH (!exists):** new full def → `createTableSql` DDL, `applied`/`migrationPath`
  per `opts`, `is_stub=false` persisted.
- **`migrate` UPGRADE [CRIT-8]:** pre-seed `tabDocType.<name>.is_stub=true` (a stub) → `migrate`
  the full def → DDL is `alterColumnsSql(fullDef, [])` (assert it contains `add column if not
  exists` for the real fields, NOT `create table`), then `is_stub` flips to `false`. Confirm
  `alterColumnsSql` was called with `existingCols=[]` (no `columnsOf` on PgAdmin).
- **`migrate` DOWNGRADE NO-OP [CRIT-6]:** pre-seed a FULL row (`is_stub=false`) → `migrate(makeStubDef(name))`
  → returns `{ applied:false, skipped:'downgrade-refused' }`; assert NO DDL ran (spy on
  `admin.applyDDL` / no migration file written) and `is_stub` is STILL `false` (no re-flip).
- **`migrate` RE-INSTALL FULL idempotent:** full over an existing full row → `createTableSql`
  no-op, `syncDoctype` re-runs, no error.
- **tx-wrap preserved:** `syncDoctype` is invoked through `store.transaction` in each write branch
  (assert via a transaction spy, or that parent+children persist atomically).
- **Done:** all green; the 5 marker-chain edits present; `issingle`/`depends_on` behaviour
  unchanged (existing tests still pass).

### U-LINK — `src/runtime/links.test.js` (extend) — soft-link 3-case matrix [CRIT-5]
- **(a) stub-target skips:** meta with a Link to a stub target (`tryMeta(target).isStub===true`),
  doc has a non-existent value → `validateLinks` resolves (no throw), `store.get` NOT called for
  that field.
- **(b) full-target enforces / re-hardens:** same edge, but target meta `isStub===false` and value
  has no row → `validateLinks` THROWS `ValidationError` (proves the soft window closes once the
  target is full).
- **(c) target-scoped gating:** doc with TWO Links — one into a stub (bad value, accepted) and one
  into a full target (bad value) → THROWS for the full one only (proves gating is on the *target*,
  not the source).
- **reqd presence still enforced (ruling 3):** the soft branch is BELOW the empty-value
  short-circuit, so an empty value into a `reqd` stub Link is still caught by `validateAgainstMeta`
  (cross-check: a missing value is rejected upstream, not softened here).
- **Done:** green; `resolveFetchFrom` untouched (already safe on empty stub table).

### U-RESERVED — `src/validation/request-schemas.test.js` (extend) [CRIT-4]
- `CreatePayloadSchema.safeParse({ is_stub:true, title:'x' })` → `success===false`, message
  contains `is_stub`.
- `UpdatePatchSchema.safeParse({ is_stub:false })` → `success===false` (both envelopes).
- A normal business field (`{ title:'x', branch:'y' }`) still passes (no regression).
- **Integration (acceptance, in the handler test if present):** `POST /DocType/<name>
  { is_stub:true }` ⇒ **400** `reserved key(s) not allowed: is_stub`.
- **Done:** green; existing reserved-key tests (`owner`/`docstatus`/`name`) still pass.

### U-CLI — `scripts/generate-doctypes.test.js` (extend, or a thin invocation test)
- `parseArgs(['--root','r','--seed','Quotation','--stub-deps','--emit'])` → `{ stubDeps:true }`.
- Mutual-exclusion: `--stub-deps --closure` (or `--no-closure`) → exit(1) / error.
- **Integration (the gating E3 round-trip [CRIT-1]):** run the CLI in `--stub-deps --emit` against
  the real erpnext root for `Quotation` → among emitted migrations there is one for
  `tabQuotationItem` **WITH its data columns** (`item_code`, `qty`, `rate`), and the Link targets
  (`Currency`, …) appear as **stub** migrations (framework cols only). Then a create of a Quotation
  with a line item round-trips with no silent column drop (if a live/Pg path is available; else
  assert the emitted DDL shape). Author may stage this against `PgStore`+`PgAdmin` per the existing
  `--apply` gating — do NOT auto-run `--apply` against a live DB (CLI header rule).
- **Done:** green; the non-stub-deps path byte-identical (diff shows only additive `--stub-deps`).

### U-MIGRATION — author-only
- **Done (author):** migration file exists, idempotent (`add column if not exists`), rollback
  comment present, full-timestamp filename. **NOT applied by the agent.** Live-verify
  (`db push` + a `select is_stub from "tabDocType" limit 1`) is the human's deploy step — surface
  it in the result note, do not run it.

---

## 5. Assembly + integration-test sequence (LEAD)

1. **Fan out GROUP A** (5 specialists in parallel): U-EXTRACT, U-STUBDEF, U-MARKER, U-LINK,
   U-RESERVED. Author U-MIGRATION any time (no code dep).
2. **Each GROUP-A unit green in isolation** (its own `npx vitest run <file>`).
3. **Fan out U-CLI** (GROUP B) once U-EXTRACT + U-STUBDEF + U-MARKER have landed — it imports all
   three.
4. **Full suite:** `npx vitest run` — the whole engine suite green (regression gate: `issingle`,
   `depends_on`, closure/no-closure modes, existing reserved-key + links behaviour all unchanged).
5. **Surface U-MIGRATION to the human** for `db push` + the live `is_stub` column check. Until
   pushed, the engine safe-degrades to all-hard links (documented fail-safe) — so the code suite is
   green without the column.

---

## 6. Compose-check (go/no-go)

| Check | Result |
|---|---|
| Interfaces line up | **PASS** — `planInstall`→`{full,stubs}` consumed by U-CLI; `makeStubDef`→def consumed by U-CLI + `migrate`; `migrate` reads `def.isStub` (U-STUBDEF/U-CLI supply it) + `cur.is_stub` (U-MARKER persists it); `validateLinks` reads `meta.isStub` (U-MARKER getter). |
| No import cycles | **PASS** — GROUP A files have no new cross-imports; U-CLI imports downward only (generator + installer). `links.js` reads `meta.isStub` at runtime (data dep, not import). |
| No file owned by two units | **PASS** — `installer.js` (sync write + migrate) is ONE unit (U-MARKER); every other editable file maps to exactly one unit (§1). |
| Contract-compliant (DRY/KISS/SoC/Least-Priv/Idempotent/Fail-Fast) | **PASS** — reuses `_buildIndex`/`closureOver` pattern/`alterColumnsSql`/`rejectReservedKeys`; stub = framework table + boolean; PgAdmin write-only; `is_stub` reserved (installer-only); every `migrate` branch idempotent; dead-end + downgrade fail-fast/no-op; absent column ⇒ all-hard safe-degrade. |
| Critique precision items covered | **PASS** — E3-reuse = explicit `depsByKind` task (U-EXTRACT 3.1a, test CRIT-2); E3-termination = visited-set + cycle test (3.1b, CRIT-3). |
| LEAD rulings honored | **PASS** — no default flip (U-CLI), re-validation sweep DEFERRED (not in scope), reqd-into-stub still needs a value (U-LINK). |

**VERDICT: GO.** Release the work order; fan out GROUP A.

---

## 7. Fan-out gate note

This clears the fan-out gate (7 units, 5 in parallel against shared boundaries — the `is_stub`
round-trip + the `planInstall`/`makeStubDef`→CLI contract). The full work order earns its keep:
the file-collision on `installer.js` (sync write vs migrate branch) is precisely the kind of
shared-boundary hazard the work order exists to serialize into one owner.
