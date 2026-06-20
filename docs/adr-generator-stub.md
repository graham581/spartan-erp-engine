# ADR — Pass E: Closure-bounding + link-stubbing + Frappe-core handling

- **Status:** Design REV 2 — post critique pass 1 (E3 FAIL / E1·E2·E4·E5 PASS with 2 conditions).
  Author: architect. Date: 2026-06-21. Awaiting critique pass 2.
- **Extends** `docs/adr-generator.md` (Pass D generator, frozen + critique-PASS-2) and reuses
  `docs/workorder-generator.md` interfaces. **Does not supersede** it — it adds a *bounded*
  install mode alongside the existing closure-by-default mode.
- **Critique:** `docs/critique-generator-stub.md`.
- **Diagram:** `diagrams/generator-stub-class.puml`.

## Problem (proven live 2026-06-21)

Pass D made closure **ON by default** for correctness: the loader's `_primeLinkTarget` /
`load` (Table-target guard) **throw `NotFoundError`** the instant a Link/Table target isn't
primed, so a def installed without its targets can't load. That is correct for a *small* slice
(Sales Order = 35 targets) but **explodes** for a rich doctype: **Quotation's full transitive
Link/Table closure = 298 doctypes**, and **20 of those are Frappe-core** (Currency, User,
Country, Address, Contact, Role, Language, Salutation, Print Format, Letter Head, Email
Account/Template, Auto Repeat, Payment Gateway, UTM Source/Medium/Campaign, Gender, DocType).
Those 20 live in the **`frappe` repo, not `erpnext/`**, and **there is no local frappe repo**
(confirmed) — so closure-by-default **cannot** install a rich doctype: it both pulls the whole
ERP and dead-ends on core targets with no JSON source.

**Goal:** install a SEED doctype (and create/submit it) **without** pulling the whole ERP — by
generating the seed(s) **and their data-bearing children** FULLY, and **stubbing** their Link
targets.

## Verified facts (read 2026-06-21)

- `validateLinks` (links.js:37-47) already **skips** the existence check when `tryMeta(options)`
  returns `null` (target not registered). **But a stub IS registered** (it has a Meta), so the
  skip will NOT fire — it would run `store.get(stubTable, value)` against an **empty** stub
  table and **throw** `ValidationError`. This is the crux: a stub is *present-but-empty*, a
  state the existing skip doesn't cover.
- `resolveFetchFrom` (links.js:14-27) also reads the target table, but is **already safe**: an
  empty stub table returns no row → silent no-op. No change needed.
- `createTableSql` (ddl.js:52-90) is `CREATE TABLE IF NOT EXISTS` and **always emits the 9
  framework columns** (`name, owner, docstatus, idx, creation, modified, parent, parenttype,
  parentfield`). A stub with **zero data fields** therefore yields a structurally valid table —
  enough for a Link to resolve structurally and for `_primeLinkTarget` to load its (empty) meta.
- `alterColumnsSql` (ddl.js:100-115) emits `ADD COLUMN IF NOT EXISTS` per missing field — the
  exact primitive needed to upgrade a stub table to full (CREATE TABLE IF NOT EXISTS will NOT
  add columns to an existing table).
- **`#saveChildren` (document.js:117-132)** inserts each child row's keys straight into
  `ct.table`. If that child table is a **stub** (framework cols only), the data columns
  (`item_code`, `qty`, …) don't exist → hard error / silent data loss. **This is why a Table
  child can never be a stub** (E3 blocker, below).
- **The loader already splits edge kinds** (loader.js:203-211 / 249-255): Table targets and Link
  targets are collected into separate lists. `planInstall` mirrors that split — Table → full,
  Link → stub.
- The loader's Table guard (loader.js:111-126) throws only when a Table target is **not primed**;
  a *stubbed* child **is** primed (`hasMeta(options)===true`), so the guard does **not** catch a
  wrongly-stubbed child — confirming the split must happen at plan time, not be caught at load.
- **`RESERVED_KEYS` (request-schemas.js:14)** = `owner, docstatus, name`; both `CreatePayloadSchema`
  and `UpdatePatchSchema` run `rejectReservedKeys` (request-schemas.js:20-29, 34/39). The generic
  handler (handler.js:37-73) dispatches **any** doctype through this path → a privilege-bearing
  key must be added here or a client can set it (E2-trust condition, below).
- The `depends_on`/`issingle` chains prove the **meta round-trip pattern** for a new DocType-row
  attribute: boot-meta DocField/DocType entry → `syncDoctype` write → `loader.load` read →
  `Meta` field+getter. A stub marker rides the **same** rails.
- `def-schema.assertValidDef` enforces a fieldtype enum + Link/Table `options` refinement. A
  stub def has **no fields**, so it passes trivially.

---

## Decision 1 — the STUB DEF shape and its MARKER (E1) — PASSED

### Stub def shape (synthesized — no source JSON required)

`makeStubDef(doctypeName)` (NEW, in `erpnext-to-def.js`) returns the **minimal** def the
installer + loader already eat:

```js
{
  doctype:    doctypeName,
  table:      'tab' + doctypeName.replace(/\s+/g, ''),   // MUST match loader.js:138
  isStub:     true,        // the marker (Decision 1b)
  submittable: false,
  issingle:    false,
  fields:      [],         // ZERO data fields — framework cols only (createTableSql)
  permissions: [],         // inherits no perms; see Decision 1c
  scopeFields: [],
}
```

A stub needs **no source JSON** — its shape is fully *synthesized* from just the name. That is
what lets the 20 Frappe-core targets (no local JSON) become stubs (Decision 4). **A stub is
only ever made for a LINK target** (Decision 3) — never for a Table child.

### Decision 1b — how a stub is MARKED: `is_stub` boolean on the DocType row

A single `is_stub` Check column on `tabDocType`, threaded through the meta round-trip exactly
like `issingle`/`depends_on`:

1. **boot-meta.js** — add `{ fieldname: 'is_stub', fieldtype: 'Check' }` to the **DocType** meta
   entry (boot-meta.js:31-43).
2. **installer.js `syncDoctype`** — add `is_stub: def.isStub ?? false` to `docTypeRow`
   (installer.js:108-119, alongside `issingle`/`istable`).
3. **loader.js `load`** — read `const isStub = !!(row.is_stub);` (mirroring `issingle`,
   loader.js:135) and pass it into `new Meta({ ..., isStub })`.
4. **meta.js** — `this._isStub = Boolean(def.isStub ?? false)` + `get isStub()` (mirrors
   `_issingle`, meta.js:18/:30).
5. **registry.js** — add `@property {boolean} [isStub]` to the `DocMeta` typedef.

**Why a DocType-row flag and not inference** ("stub = zero fields"): inference is fragile — a
legitimately field-less child/config doctype would be misread as a stub, silently softening its
Links. An explicit, persisted boolean is **fail-safe and unambiguous**, one line per site.
Rejected: a separate `tabStub` registry table (SoC/KISS — a per-doctype attribute belongs on the
doctype row).

### Decision 1c — stub permissions

A stub carries **`permissions: []`**. It is never *operated* directly; it exists only so a Link
resolves structurally. Empty perms = least privilege. Raw closure-priming reads
(`_primeLinkTarget` → `store.getChildren`) are not perm-gated, so priming still works.

### Decision 1d — the base `tabDocType` migration (deploy-gated)

`is_stub` is a real column on `tabDocType`, so it needs an idempotent
`ALTER TABLE "tabDocType" ADD COLUMN IF NOT EXISTS is_stub boolean default false;` migration
(rollback comment at top, full-timestamp filename), **human-`db push`-gated** (§1/§7). Until
pushed, `row.is_stub` reads `undefined` → `!!undefined === false` → every doctype reads as
non-stub (safe degrade: hard links everywhere, the pre-Pass-E behaviour).

---

## Decision 2 — THE CRUX: Link validation into a stub (E2) — PASSED, +1 trust condition

**Decision: a Link whose TARGET doctype is a stub is a SOFT link — `validateLinks` SKIPS the
row-existence check and trusts the value. A Link into a fully-generated (non-stub) target keeps
the HARD existence check, unchanged.**

```js
// links.js validateLinks, inside the loop, after `const target = tryMeta(f.options);`
if (!target) continue;            // (existing) target not modelled at all — skip
if (target.isStub) continue;      // NEW — SOFT link: target is a stub (empty table), trust value
const row = await store.get(target.table, String(v));
if (!row) throw new ValidationError(...);   // (existing) HARD check for fully-generated targets
```

### E2-trust CONDITION (folded in — privilege hole, confirmed)

`is_stub` is **privilege-bearing**: it softens link integrity for a whole doctype. But it was
**not** in `RESERVED_KEYS` (request-schemas.js:14, which had only `owner/docstatus/name`).
Because the generic handler (handler.js:37-73) dispatches **any** doctype, a
`POST /DocType/<name> { is_stub: true }` would flow through `updateDoc` and **silently soften
every Link into that doctype**. **FIX (folded into this design, frozen):**

- Add **`is_stub`** to `RESERVED_KEYS` in `src/validation/request-schemas.js:14` — same class as
  `docstatus`. One line: `const RESERVED_KEYS = new Set(['owner', 'docstatus', 'name', 'is_stub']);`
- A data-doc write can then **never** set `is_stub`; only the installer/generator
  (`syncDoctype`, which bypasses the request envelope) writes it.
- **Test (acceptance):** `POST /DocType/<name>` (or any doctype) with `{ is_stub: true }` ⇒
  **400** (`reserved key(s) not allowed: is_stub`). Add alongside the existing reserved-key tests.

### Why this shape, and the integrity trade-off

- **(A) Soft-link on stub target — CHOSEN.** Skip existence when `target.isStub`. **Trade-off:**
  while a target is a stub, the engine accepts any non-empty value for a Link into it
  (`Quotation.currency = 'AUD'` accepted without a Currency row). The referential guarantee for
  *that one edge* is **deferred**, not abandoned, and is **scoped to the target**: every Link
  into a fully-generated doctype keeps its hard check. The soft branch is gated on
  `target.isStub`, not on the *source* doctype — so a stub can **never** soften a Link into a
  fully-generated doctype.
- **(B) Seed stub rows.** Rejected: you don't know the value set ahead of time; reintroduces the
  data-sourcing problem; a hand-seeded row masquerades as real data.
- **(C) Make the field optional.** Rejected: corrupts the generated meta, loses the `reqd` fact,
  and a *provided* value still hits the existence check anyway.

### How integrity is RECOVERED

When a stub is fully generated + populated (Decision 5), `is_stub` flips to `false`. The next
`validateLinks` for any doc touching that edge takes the **hard** branch again — the soft window
closes automatically, no historical-row migration required. **Optional companion** (open fork):
an offline re-validation sweep that re-runs `validateLinks` over rows that linked to the now-full
target. Reporting tool, not a blocker.

**Fail-safe property:** with the `is_stub` column absent or every target full, `target.isStub`
is `false` everywhere and `validateLinks` behaves exactly as today (all hard). Soft behaviour
can only appear for a target a human deliberately installed as a stub.

---

## Decision 3 — closure-bounding strategy + CLI surface (E3) — REVISED (split the edge kinds)

> **What REV 1 got wrong (critique blocker, confirmed with ground truth):** it stubbed *all*
> direct Link **and Table** targets together. But a **Table / Table MultiSelect** target is a
> **CHILD doctype whose ROWS ARE the seed's own data** — Quotation has **8 direct Table children
> carrying real fields** (Quotation Item = 56 fields `item_code`/`qty`/`rate`/`amount`, Packed
> Item 28, Sales Taxes and Charges 21, …). Stubbing a child → `makeStubDef` `fields:[]` →
> `createTableSql` emits **framework cols only** → the data columns don't exist → `#saveChildren`
> (document.js:117-132) inserts each child row's keys into `ct.table` → hard error / **silent
> data loss**, AND the loader's Table guard (loader.js:111-126) does **not** catch it (a stubbed
> child *is* primed, so `hasMeta(options)` is true). **Table targets MUST be full. Only Link
> targets may be stubbed.**

### The corrected rule — split by edge kind (the loader already separates them, loader.js:203-211)

- **seeds → FULL** (generated via `erpnextJsonToDef`).
- **Table / Table MultiSelect targets → FULL and TRANSITIVELY** — follow Table edges to a fixed
  point. A full child's **own** Table children (grandchildren) are also full. These tables hold
  the seed's data; their real columns must exist.
- **Link targets → STUBBED** — both the seed's Links **and** each FULL doctype's Links (including
  every full child's Links). A Link is a *reference* to a master, not embedded data, so soft-link
  (Decision 2) covers it.
- **The depth bound applies to LINK edges ONLY.** Table edges are followed to closure; Link edges
  are cut at the full-set boundary (a full doctype's Link targets are stubbed, and a stub — having
  no fields — has no Links to follow further).

`planInstall(seeds, root, opts)` (NEW, in `select-doctypes.js`) returns an `InstallPlan`:

```js
{ full:  string[],   // seeds ∪ ALL transitive Table/Table-MultiSelect targets (generated FULLY)
  stubs: string[] }  // every Link target of any FULL doctype, MINUS the full set (stubbed)
```

**Algorithm (reuses the existing extractors — DRY):**
1. `full` = BFS from `seeds` following **Table / Table MultiSelect** `options` only, to a fixed
   point. This is `closureOver`'s BFS restricted to the Table edge-kinds — reuse the existing
   `_depsOf` split (it already distinguishes Link from Table), do **not** rewrite the walk.
2. `stubs` = union of **Link** `options` over **every** def in `full`, minus `full` itself.
3. `full` and `stubs` are **disjoint** by construction (step 2 subtracts `full`).

**Re-derived Quotation set:** ~**9 full** (Quotation + its 8 Table children) + its Link targets
**stubbed** (tens, not 298) — finite and reasonable. The 298 explosion came entirely from
recursing **Link** targets transitively; cutting Links at the full-set boundary while keeping
Table children full is what bounds it.

> **Dead-end guard (fail-fast):** if a Table/Table-MultiSelect target has **no JSON under
> `root`**, it cannot be made full and must **not** be stubbed (its rows would lose columns).
> `planInstall` **throws** naming the missing child. Ground truth today: none of Quotation's 8
> children, and none of the 20 Frappe-core targets, is an erpnext Table child without JSON — so
> this guard does not fire for the v1 seeds (Decision 4 caveat). It exists so a future seed with
> a JSON-less child fails loudly rather than losing data.

### CLI surface

Add a **bounded mode** to `generate-doctypes.mjs` alongside the existing modes:

| Mode | Flag | Behaviour |
|---|---|---|
| **Bounded (NEW, recommended default)** | `--stub-deps` | `planInstall`: seeds + Table children full; Link targets stubbed. Finite, small. |
| Full transitive (existing) | `--closure` | `closureOver` (Pass D closure-by-default) — pulls everything; only viable for small slices fully present in `erpnext/`. |
| Self-contained leaf (existing) | `--no-closure` | seeds only; throws (fail-AT-generate) on any outside Link/Table target. |

The three modes are **mutually exclusive**; recommended default = `--stub-deps`. `closureOver`
and `erpnextJsonToDef` are **reused unchanged** (see §Reuse map).

> **Open fork for the LEAD:** flip the default to `--stub-deps` now, or ship opt-in?
> Recommendation: make it default — closure-by-default is proven non-viable for rich doctypes.

---

## Decision 4 — Frappe-core targets as stubs (E4) — PASSED, +caveat

The 20 Frappe-core targets have **no local JSON**, so they cannot be generated via
`erpnextJsonToDef`. **They become stubs via the same mechanism** — `makeStubDef(name)`
synthesizes the def from the name alone. Under the corrected E3 rule they fall into the **Link**
edge-kind (step 2), so they are stubbed naturally.

> **Caveat (the corrected E3 makes this load-bearing):** Frappe-core-as-stub works **only because
> all 20 core targets are LINK edges** (a Quotation/child Link to Currency, User, Country, …) —
> **none of the 20 is an erpnext Table child**. Under the corrected rule a Frappe-core **Table
> child** would have to be FULL but has **no JSON** = the dead-end guard (Decision 3) fires and
> `planInstall` throws. Ground truth 2026-06-21: none of the 20 is a child, so this is **safe
> today**. If a future seed embeds a Frappe-core doctype as a Table child, the gh-source
> enhancement below becomes a prerequisite, not optional.

> **Future enhancement (OUT OF SCOPE v1, flag for LEAD):** source the *real* core defs from the
> frappe repo via `gh api repos/frappe/frappe/contents/<path> --jq '.content' | base64 -d`, run
> them through `erpnextJsonToDef`, and install them as **full** doctypes (the stub→full upgrade of
> Decision 5 makes this a clean later migration). Not needed to install + create + submit a seed
> today, so YAGNI for v1 — **unless** a Frappe-core Table child appears (caveat above).

---

## Decision 5 — stub → full upgrade path (E5) — PASSED, +2 conditions

Installing a doctype FULLY that was previously a stub must work and be **idempotent**.
`createTableSql` is `CREATE TABLE IF NOT EXISTS`, so it will **not** add the full columns to an
existing stub table. The upgrade uses the **already-existing `alterColumnsSql`** primitive.

**`migrate(fullDef, store, opts)` gains a stub→full branch** (the only behavioural edit to
`migrate`). **Stub-state is read from `tabDocType.is_stub` — authoritative, no DDL introspection
(condition (b)):**

```
0. Read the current meta row: const cur = await store.get('tabDocType', fullDef.doctype);
   const wasStub = !!(cur && cur.is_stub);
   const exists  = !!cur;   // a prior install (stub or full) wrote this row

1. UPGRADE  (exists && wasStub && fullDef.isStub !== true):
     admin.applyDDL(alterColumnsSql(fullDef, []))   // existingCols=[] is SAFE — ADD COLUMN IF NOT EXISTS
                                                     // (condition (b): PgAdmin is write-only; NO columnsOf needed)
     syncDoctype(fullDef, store)                     // rewrites meta with is_stub=false
     bumpMetaVersion(store)                           // warm lambdas invalidate -> next load sees is_stub=false

2. FRESH    (!exists):
     admin.applyDDL(createTableSql(fullDef))          // existing path, unchanged
     syncDoctype(fullDef, store); bumpMetaVersion(store)

3. DOWNGRADE NO-OP  (exists && !wasStub && fullDef.isStub === true):  ← condition (a), CONCRETE branch
     return { applied:false, skipped:'downgrade-refused' }
     // NEVER apply DDL, NEVER flip is_stub back to true over a full table.

4. RE-INSTALL FULL  (exists && !wasStub && fullDef.isStub !== true):
     admin.applyDDL(createTableSql(fullDef))          // CREATE TABLE IF NOT EXISTS -> no-op on table
     syncDoctype(fullDef, store); bumpMetaVersion(store)  // idempotent re-sync
```

### Condition (a) — DOWNGRADE GUARD is a concrete hard branch (not just intent)

Branch **3** above. A **stub install whose target row has `is_stub=false`** (already full) is a
**NO-OP**: no DDL, no flip of `is_stub` back to `true`, no column drop. This is an explicit code
path with a definite return value, not a comment — so an accidental `makeStubDef`-then-`migrate`
over a full table can never silently soften a populated doctype.

### Condition (b) — DROP the `columnsOf` requirement (open fork 2 resolved)

`PgAdmin` is **write-only** (`applyDDL`, fire-and-forget; it exposes **no** `columnsOf`). We do
**not** need it: `alterColumnsSql(fullDef, [])` with an **empty** `existingCols` is safe because
every emitted statement is `ADD COLUMN IF NOT EXISTS` — re-adding an already-present framework
column is a no-op at the DB. So the upgrade passes `existingCols=[]` and lets the DB's
`IF NOT EXISTS` do the diffing. **`PgAdmin` stays write-only (SoC) — no read surface added.**

**Idempotency:** `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` safe to re-run;
`syncDoctype` upsert-by-name; `bumpMetaVersion` set-not-append. Every branch is a no-op on
re-run.

**Effect:** stub Currency for Quotation today; tomorrow `migrate(fullCurrencyDef, …)` adds
Currency's real columns (branch 1), clears the stub flag, and every Link into Currency
**re-hardens** on its next save (Decision 2's recovery) — soft window closes, no historical-row
migration.

---

## Reuse map (reuse-not-rewrite)

| Need | Reused symbol | New/edit |
|---|---|---|
| Find direct deps, split Link vs Table | `select-doctypes._depsOf` (already splits edge kinds) | reuse |
| Full def from JSON | `erpnext-to-def.erpnextJsonToDef` | reuse |
| Stub def from name | — | **NEW** `makeStubDef` (Link targets only) |
| Bounded plan (Table→full, Link→stub) | `_depsOf` split + BFS-on-Table | **NEW** `planInstall` |
| Stub table DDL | `ddl.createTableSql` (framework cols) | reuse |
| Stub→full DDL | `ddl.alterColumnsSql` (existingCols=[]) | reuse |
| Marker round-trip | the `issingle`/`depends_on` pattern | **EDIT** 1 line each: boot-meta, installer, loader, meta, registry |
| Reserved key | `request-schemas.RESERVED_KEYS` | **EDIT** 1 line (add `is_stub`) |
| Soft-link | `links.validateLinks` | **EDIT** 1 line (`if (target.isStub) continue;`) |
| Upgrade + downgrade-no-op | `installer.migrate` | **EDIT** 4-branch stub/full/downgrade/reinstall |
| Full-closure mode | `select-doctypes.closureOver` | reuse (kept behind `--closure`) |

Net new files: **0** (edits + `makeStubDef` + `planInstall`). Net new migrations: **1** (the
`is_stub` ALTER on `tabDocType`, deploy-gated).

---

## Design-contract compliance

- **DRY:** stub marker reuses the proven `issingle`/`depends_on` rails; bounded plan reuses
  `_depsOf`'s edge-kind split; upgrade reuses `alterColumnsSql`; reserved-key reuses the existing
  `rejectReservedKeys` refinement; full-closure mode untouched.
- **KISS:** a stub = framework-cols table + a boolean; soft-link = one `if`; reserved key = one
  Set entry; upgrade = a 4-way branch on two booleans (`exists`, `wasStub`). No EAV, no
  value pre-seeding, no DB read surface on PgAdmin.
- **YAGNI:** Frappe-core stays a stub (no gh-sourcing v1 — caveat noted); no re-validation sweep
  v1; no `columnsOf` on PgAdmin.
- **SOLID / SoC:** synthesizer (pure) ⟂ planner (pure) ⟂ CLI (I/O) ⟂ installer (persist) ⟂
  validator (gate); PgAdmin stays write-only.
- **Least Privilege:** stub carries empty perms; `is_stub` is reserved so no client can set it —
  only the installer writes it.
- **Idempotency:** synthesizer pure; ALTER/CREATE `IF NOT EXISTS`; syncDoctype upsert;
  bumpMetaVersion set-not-append; every migrate branch is no-op on re-run; downgrade is an
  explicit no-op.
- **Fail-Fast / Fail-Safe:** soft-link gated on `target.isStub` (absent flag ⇒ all-hard, today's
  behaviour); a Table child without JSON throws at plan time (no silent column loss); a downgrade
  over a full table is an explicit refusal; `is_stub` write attempt ⇒ 400.

## Open forks (for the LEAD / critique pass 2)

1. **Default mode** — flip the CLI default to `--stub-deps` now, or ship opt-in first?
   (Recommend: default — closure-by-default is a proven-broken default for rich doctypes.)
2. ~~Stub-detect predicate / `columnsOf`~~ — **RESOLVED** by E5 condition (b): read
   `tabDocType.is_stub`; pass `existingCols=[]` to `alterColumnsSql`; PgAdmin stays write-only.
3. ~~Downgrade guard~~ — **RESOLVED** by E5 condition (a): concrete branch 3, no-op, never DDL.
4. **Post-upgrade re-validation sweep** — ship as an offline reporting tool now or defer?
   (Recommend defer to when the first stub is upgraded.)
5. **`validate.js reqd` interaction** — a `reqd` Link into a stub still requires a *non-empty
   value* (only *existence* is softened). Confirm intended (recommend: yes — required-ness is the
   source doctype's contract; existence is the target's).

## Frappe citations

- Frappe Link existence validation lives in `frappe/model/document.py`
  (`validate_links` / `_validate_links`) — the server-side equivalent of `links.validateLinks`;
  our soft-on-stub is an engine-specific relaxation for incremental install, a deliberate
  divergence.
- The 20 core targets are `frappe`-app doctypes (e.g. `frappe/core/doctype/{user,role,...}`,
  `frappe/contacts/doctype/{contact,address}`) — no source under `erpnext/`, synthesized as
  stubs (Decision 4). All are referenced as **Link** edges, never Table children (E4 caveat).
- ERPNext child doctypes (`istable:1`, e.g. `selling/doctype/quotation_item/quotation_item.json`)
  carry the line-item fields whose rows are the parent's data — confirming Table targets must be
  full (E3).
