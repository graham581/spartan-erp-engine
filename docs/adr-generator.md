# ADR — Pass D: Generator layer, Single doctypes, depends_on mini-pass

- **Status:** Revised after critique pass 1 (D1 FAIL / D2 FAIL / D3 PASS) - design only, awaiting critique pass 2
- **Author:** architect
- **Date:** 2026-06-20
- **Supersedes nothing; extends** `docs/adr-validation-layer.md` §3 (parked depends_on design).
- **Diagram:** `diagrams/generator-class.puml`

## Problem

The engine has a frozen, working **installer path** (`emitMigration` / `syncDoctype` /
`migrate`) that consumes a hand-authored `DocMeta` *def* object. Today every def is written by
hand. ERPNext ships **635 DocType JSON files**; we want to drive the engine's meta from those
files instead of hand-transcribing them. Three concerns, all blocked behind "we have no
generator":

1. **Generator** — turn an ERPNext DocType JSON into the def shape the installer already eats.
2. **Single / Settings doctypes** (`issingle=1`) — one-record doctypes (e.g. *Selling
   Settings*). The meta layer carries `issingle` (installer.js:115, def-schema, boot-meta) but
   the **runtime can't load/save a Single** (no naming, exactly one row).
3. **`depends_on` mini-pass** — the conditional-relevance chain parked in
   `adr-validation-layer.md` §3, deferred because it must ship whole.

## Verified facts (read 2026-06-20)

- A **real** DocType def is `<area>/doctype/<name>/<name>.json` with top-level
  `"doctype": "DocType"`. The other ~hundreds of `*.json` under `*/doctype/` are fixtures /
  chart-of-accounts templates and have a different/absent top-level `doctype`. **Filter rule:
  `json.doctype === "DocType"`.** (e.g. `accounts/doctype/account/account.json` ✓.)
- **Flags observed live:** `selling_settings.json` → `issingle:1`; `sales_team.json` →
  `istable:1`; `sales_order.json` → `is_submittable:1`, `autoname:"naming_series:"`,
  `naming_rule:"By \"Naming Series\" field"`.
- **Fieldtype frequency across the Selling slice** (the real spread the generator must handle):
  Link 148, Section Break 114, Column Break 89, Currency 72, Check 57, Float 51, Data 45,
  Select 25, Tab Break 22, Table 21, Text Editor 17, Small Text 12, Date 11, Button 7,
  Text 5, Percent 5, Read Only 4, HTML 4, Dynamic Link 4, Int 3, Code 3, Time 2,
  Table MultiSelect 2, Image 2, Attach 2, Attach Image 1.
- **Frozen reuse path** (the generator must produce defs that pass through *unchanged*):
  `installer.syncDoctype` (installer.js:99-148) maps **camelCase** def keys (`readOnly`,
  `fetchFrom`, `submittable`, `scopeFields`) → snake DB columns; `def-schema.assertValidDef`
  enforces a fieldtype **enum derived from `PG_TYPE_MAP` + `Table`** (def-schema.js:24-26);
  `loader.load` derives the table name as `tab${doctype.replace(/\s+/g,'')}` (loader.js:135).
- **`migrate()` needs a transaction-capable store** (`store.transaction`, installer.js:194).
  `SupabaseStore.transaction` throws (Pass B lesson) → the `--apply` path uses **PgStore +
  PgAdmin**; the `--emit` path (file → human `db push`) has no such constraint.

---

## Decision 1 — the GENERATOR (D1)

### Module layout

```
src/generator/
  erpnext-to-def.js   erpnextJsonToDef(json) -> def ; isRealDoctype(json)
  fieldtype-map.js    ERP_TO_ENGINE / LAYOUT_TYPES / mapFieldtype()
  select-doctypes.js  listAllDoctypeFiles(root) ; closureOver(seeds, root)
scripts/
  generate-doctypes.mjs   thin CLI -> Selector -> Gen -> installer.emitMigration|migrate
```

Generator functions are **pure** (JSON in, def out — no I/O). The **CLI** owns file reads and
the installer call. This keeps the contract testable with in-memory JSON (mirrors how
`installer`/`loader` are tested with MemoryStore).

### `erpnextJsonToDef(json)` mapping

| def key | source | rule |
|---|---|---|
| `doctype` | `json.name` | verbatim |
| `table` | derived | `"tab" + name.replace(/\s+/g,"")` — **must match loader.js:135** |
| `module` | `json.module` | verbatim (nullable) |
| `submittable` | `json.is_submittable` | `!!` |
| `issingle` | `json.issingle` | `!!` |
| `istable` | `json.istable` | `!!` |
| `autoname` + `naming_rule` | `json.autoname` / `json.naming_rule` | passthrough (see Decision 1c) |
| `scopeFields` | — | **`[]`** — ERPNext has no row-scope concept; the CRM sets per-doctype scope (e.g. `['branch']`) in a later curation step, not the generator |
| `fields` | `json.fields` | `.map(mapField).filter(Boolean)` — drops layout + unmapped |
| `permissions` | `json.permissions` | `.map(mapPermission)` |

`mapPermission` is a straight rename to the camel keys `syncDoctype` reads
(`ifOwner`←`if_owner`, `delete`←`delete`, etc.); ERPNext extras (`email`, `print`, `report`,
`export`, `import`, `share`, `select`) are **dropped** — the engine's DocPerm model
(boot-meta.js:83-102) doesn't carry them (YAGNI).

**`mapField` is an EXPLICIT KEY-WHITELIST - never a spread of the ERPNext field (D1-2, the
D1->D3 security boundary).** It builds the FieldDef key-by-key from a fixed allowlist and copies
**nothing** else. The output object carries **only**:

```
{ fieldname, fieldtype, reqd, readOnly, unique, permlevel, options, fetchFrom, idx }
```

Renames: `read_only`->`readOnly`, `fetch_from`->`fetchFrom`; the rest keep their name. Select
`options` (newline string) is kept **as-is** - `validate.optionList` already splits on newline
(validate.js:43-46). Booleans: ERPNext stores `0/1`; coerce with `!!`.

> **FROZEN CONTRACT - D1->D3 SECURITY BOUNDARY (PINNED):** a generated FieldDef **NEVER**
> carries `dependsOn` / `mandatoryDependsOn`. The ERPNext source fields `depends_on` /
> `mandatory_depends_on` are **raw `"eval:..."` strings** - **86 of them in the Selling slice**
> (e.g. `account.json` `account_currency.depends_on = "eval:doc.is_group==0"`). Because
> `mapField` is a whitelist and those two keys are **not on it**, the strings are dropped *by
> construction* - there is no path for a raw eval-string into the FieldDef. This is precisely
> what stops a raw string flowing into `isRelevant(string, doc)` the instant D3 makes the column
> live. **A spread (`{ ...f, ... }`) would silently re-admit them and is FORBIDDEN.** A test
> MUST assert the contract: feed a source def whose fields carry `depends_on` /
> `mandatory_depends_on` strings, assert **no** generated FieldDef has a
> `dependsOn`/`mandatoryDependsOn` key and none carries a string-typed condition. (Ties to
> C-D3-1: D3 does not ship until this contract is frozen + tested.)

### Decision 1b — fieldtype mapping & unsupported-type policy

The engine fieldtype **must be one of the enum** (`PG_TYPE_MAP` keys + `Table`), or
`assertValidDef` rejects the def. Three buckets:

**(i) Layout — SKIP (no column, `mapField` returns `null`, log at debug):**
`Section Break`, `Column Break`, `Tab Break`, `HTML`, `Button`, `Fold`, `Heading`.
Justification: they carry no data; emitting a column for them is wrong and they have no
`fieldname` worth persisting. *Keeping* them would pollute every table with empty columns —
rejected.

**(ii) Supported — map to an existing engine fieldtype:**

| ERPNext | engine fieldtype | PG type (via PG_TYPE_MAP) |
|---|---|---|
| Data, Small Text, Read Only | `Data` | text |
| Text, Text Editor, Code, Markdown Editor, HTML Editor | `Text` / `Code` | text |
| Select | `Select` | text |
| Link | `Link` | text (options = target doctype) |
| Int | `Int` | bigint |
| Float, **Percent** | `Float` | numeric |
| Currency | `Currency` | numeric |
| Check | `Check` | boolean |
| Date | `Date` | date |
| Datetime | `Datetime` | timestamptz |
| Table, **Table MultiSelect** | `Table` | (no column; child rows) |

**(iii) Unsupported / ERPNext-only data types — MAP-TO-TEXT-with-warn:**
`Time`, `Duration`, `Dynamic Link`, `Attach`, `Attach Image`, `Image`, `Signature`,
`Color`, `Rating`, `Geolocation`, `JSON`, `Barcode`, `Password`, `Phone`,
`Long Text` → emit as engine **`Data`/`Text`** (text column) and **log a warning** naming the
field and the original type.

**Policy rationale (fail-open for *data*, fail-closed for *structure*):**
- Layout types are pure UI → **drop** (no data lost).
- A data-bearing type we don't model yet → **map to text, warn**, never silently drop the
  column. Dropping a column loses data the source clearly intends to persist; a text column
  preserves the value round-trip and the warning is the backlog item to add a real PG type.
  *Reject* (throw) was rejected because one exotic field would block generating an otherwise
  fine doctype — the engine should be permissive at generate time and tighten via PG_TYPE_MAP
  extensions later.
- **Dynamic Link -> `Data`, and its `options` MUST be STRIPPED (D1-3):** ERPNext's Dynamic Link
  `options` is a **sibling FIELDNAME** (e.g. `"party_type"`) that holds the target doctype at
  runtime - it is **not** a doctype name. Carrying it would be a `Data` field with a bogus
  `options` and risk being mistaken for a closure dependency. `mapField` sets `options =
  undefined` for Dynamic Link. Modelling Dynamic Link FK semantics is YAGNI now.

**`options` carry-through:** `Link`/`Table` set `options = json field's options` (the target
doctype name) — required by `assertValidDef`'s Link/Table refinement and consumed by
`loader._primeDoctype` for the transitive closure. **`Table MultiSelect`** also carries
`options` (its child doctype) → treated as `Table`. **All three (`Link`, `Table`, `Table MultiSelect`) options ARE closure dependencies** - they feed `closureOver` (D1-1).

**Recommended PG_TYPE_MAP extensions (flagged, not done here — implement's call):** add
`Time → time` and `Datetime → timestamptz` is already present; `Time` is the one genuinely
missing native type worth adding rather than text. Listed as an open item, not blocking D1.

### Decision 1c — autoname / naming

Passthrough `autoname` + `naming_rule` verbatim into the def; `syncDoctype` already persists
both (installer.js:113-114) and the runtime naming logic interprets them. The generator does
**not** invent naming — it transcribes ERPNext's. Singles (`issingle`) carry no naming (Decision 2).

### Decision 1d - selection, closure & filtering (D1-1: closure ON BY DEFAULT)

- `isRealDoctype(json)` = `json.doctype === "DocType"` - the hard filter over the 635 files.
- `listAllDoctypeFiles(root)` walks `<area>/doctype/<name>/<name>.json`.
- `closureOver(seeds, root)` - **BFS dependency closure** over `Link` / `Table` / `Table
  MultiSelect` `options`: a doctype is not self-consistent for the loader without every target
  it references.

**D1-1 DECISION: closure is ON BY DEFAULT (closure-by-default).** Ground truth: `Sales Order`
Links/Tables to **35 distinct target doctypes** (verified 2026-06-20), most of them **outside
`selling/`** - `Address`, `Company`, `Project`, `Warehouse`, `Cost Center`, `Currency`,
`Contact`, `Terms and Conditions`, ... The loader's `_primeLinkTarget`
(loader.js:233-243) and `load`'s Table-target guard (loader.js:112-118) **throw
`NotFoundError` at runtime** on the first missing target. So generating `["Sales Order"]`
*without* closure installs a def that **cannot load** - shipping broken. "Closure can be large"
is not a reason to ship a def that fails on first request.

Two acceptable shapes; **(a) is the default, (b) is the guard rail:**
- **(a) closure-by-default:** the generator expands the seed set to its full transitive closure
  before generating. `--no-closure` exists only for the deliberate "I am generating a
  self-contained leaf" case.
- **(b) fail-AT-GENERATE:** if a caller pins an explicit set and a `Link`/`Table` target falls
  **outside** that set, the generator **throws at generate time** naming the missing target
  (never emits a def that would `NotFoundError` at runtime). This is the fail-fast backstop
  whenever closure is off.

**Validate the whole closure:** the work order/CLI runs `assertValidDef` over **every** def in
the produced closure, not just the seeds (D1-3). (The accounts+selling closure happens to have
no empty-options `Link`/`Table`, but the run must *prove* it, not assume it.)

Output target: `--emit` -> `installer.emitMigration` (file for `db push`); `--apply` ->
`installer.migrate(def, pgStore, { admin: pgAdmin })` (direct DDL - **PgStore required**;
SupabaseStore.transaction throws).

---

## Decision 2 — Single / Settings doctypes (D2)

**Model: a single-row data table, fixed well-known `name = <doctype>`.** *Not* a Frappe-style
`tabSingles` key/value EAV store.

Frappe stores Singles in `tabSingles(doctype, field, value)` — a vertical key/value table —
because its ORM predates cheap JSON columns and wants one physical table for all Singles. **We
reject that** for the engine:

- It would need a *parallel* read/write path (pivot rows ↔ object) that diverges from the
  `Document.save()` / `store.get` pipeline every other doctype uses → **SoC / KISS violation**.
- A `tab<Single>` table with exactly one row reuses **the entire existing path** unchanged:
  `createTableSql` already emits the right columns; `store.get(table, name)` reads it;
  `Document.save()` writes it. The only specialisation is **naming**.

**Runtime gap - this is a 3-SITE change, NOT "one change in document.js" (D2-1).** The runtime
cannot even *detect* a Single today: `Meta` has no `issingle` (verified - meta.js:14-33 has no
such field/getter) and the loader never reads it. All three sites ship together:

1. **`loader.load`** (loader.js:126-138, the scalar-columns step) - read `issingle` off the
   DocType row: `const issingle = !!(row.issingle);` and pass it into the `new Meta({...})`
   call. Without this, the flag never reaches runtime.
2. **`Meta`** (src/meta/meta.js) - add `this._issingle = Boolean(def.issingle ?? false)` in the
   constructor and a `get issingle()` getter (mirrors the existing `submittable` field exactly,
   meta.js:17 + :28). There is **no** `issingle` on Meta today - this is net-new.
3. **`document.js`** - branch on `meta.issingle` for naming + load (below).

A Single has **no naming series and exactly one record**, so its `name` is the **doctype name
itself** (Frappe convention: a Single's `name` == its doctype).

**D2-2 (the save bug to design out): force `name = meta.doctype` BEFORE the `!doc.name` check,
and NEVER call `resolveName` for a Single.** Today both `insert` (document.js:53,
`if (!this.doc.name) this.doc.name = await resolveName(...)`) and `save` (document.js:67,
`if (!this.doc.name) return this.insert()`) key off `doc.name` being absent. For a Single,
`resolveName` falls to the `hash` branch (naming.js:13-14, `meta.autoname || 'hash'`) and mints
a **random** name -> a **brand-new row on every save**. The fix:

- at the **top** of the save/insert path, **before** any `!doc.name` test:
  `if (this.meta.issingle) this.doc.name = this.meta.doctype;`
- `resolveName` is therefore **never reached** for a Single (its name is already set), and
  `save()` takes the update branch (existing row by fixed name) -> idempotent upsert, exactly
  one row.

**On load:** `store.get(table, meta.doctype)`; if absent, return an empty doc (Singles are
"always exist" config holders - return defaults rather than 404). **D2-3:** the empty-doc-on-
absent read still passes the normal read-perm filter - **no privileged short-circuit**; a caller
without read perm on the Single gets the same denial it would for any doctype.

`emitMigration` / `createTableSql` need **no change** - a one-row table is still a table.
`def-schema` / `boot-meta` / `installer` already carry `issingle` end-to-end (verified). This is
the smallest model that fixes the diagnosed gap (KISS + DRY: one storage path for all doctypes).

> Open item for `implement`: confirm the `if (meta.issingle) name=doctype` guard belongs at the
> top of `save()`/`insert()` in `document.js` (it does per document.js:53/:67) and not inside
> `naming.js` - keeping `naming.js` ignorant of Singles is cleaner SoC (naming computes names;
> a Single has no name to compute).

---

## Decision 3 — depends_on mini-pass (D3) — ship the WHOLE chain

Reuse `adr-validation-layer.md` §3 **intact**. The five-part chain (all ship together or the
round-trip is broken):

1. **`tabDocField` ALTER migration** — add `depends_on text`, `mandatory_depends_on text`
   columns, idempotent (`ALTER TABLE "tabDocField" ADD COLUMN IF NOT EXISTS ...`). **MUST
   carry a rollback comment at the top per repo convention (C-D3-3):**
   `-- ROLLBACK: alter table "tabDocField" drop column if exists depends_on, drop column if exists mandatory_depends_on;`
2. **boot-meta** — add two fields to the `DocField` meta entry (boot-meta.js:60-74),
   `fieldtype: 'Code'` (so the meta layer *sees* the columns; `Code → text`).
3. **installer `syncDoctype`** — write them per field row (camel→snake, mirroring `fetch_from`):
   `depends_on: f.dependsOn ?? null`, `mandatory_depends_on: f.mandatoryDependsOn ?? null`.
4. **loader `load`** — read them back into the FieldDef (`dependsOn: f.depends_on`,
   `mandatoryDependsOn: f.mandatory_depends_on`); add both to the `registry.js` FieldDef typedef.
5. **validator** `validateAgainstMeta` — relevance gate + effective-required (below).

### The critical/risky part — the NO-EVAL evaluator (`src/runtime/depends-on.js`)

**Hard rule: no `eval`, no `new Function`.** ERPNext's `depends_on` is `fieldtype:"Code"`,
server-evaluated via `frappe.safe_eval` (restricted-globals **eval** — RCE surface). We do
**not** eval. The condition is **structured DATA** evaluated by a **closed operator table**:

```
Condition :=
    { field: string, op: Op, value?: JSONScalar | JSONScalar[] }   // leaf
  | { all: Condition[] }                                            // AND  ({all:[]} -> true)
  | { any: Condition[] }                                            // OR   ({any:[]} -> false)
  | { not: Condition }                                              // NOT
Op := 'eq'|'neq'|'in'|'nin'|'gt'|'gte'|'lt'|'lte'|'truthy'|'falsy'|'set'|'notset'
```

**Allowlist & fail-closed rules (carried from §3, pinned by critique M3):**
- Pure functions `evalCondition(cond, doc)` / `isRelevant(cond, doc)`; **undefined cond ⇒ `true`**.
- Reads **only** `doc[cond.field]` — no property paths, no calls, no globals, no prototype walk.
- **Non-existent / missing field (C-D3-2):** a `cond.field` absent from `doc` reads as
  `undefined` (the same as an unset value) - **no throw**. Consequences are well-defined and
  **fail-closed for relevance**: `set`/`truthy` ⇒ false, `notset`/`falsy` ⇒ true,
  `eq`/`gt`/etc. against `undefined` ⇒ false. Net effect: a `depends_on` referencing a field
  the doc doesn't have makes the dependent field **not relevant** (skipped) rather than
  erroring - a missing condition input never forces a field required. (Distinct from an
  *authoring* bug like a non-array `in` value, which DOES throw.)
- Empty groups vacuous: `{all:[]} ⇒ true`, `{any:[]} ⇒ false`.
- `in`/`nin` with a non-array `value` ⇒ **throw** (authoring bug, fail-fast).
- `eq`/`neq` coercion **mirrors `validate.js:31` Check handling** — normalise `0/1`↔`true/false`
  so `op:'truthy'` and `op:'eq' value:true` agree on a Check field.
- Recursion **depth cap 32** ⇒ throw (no stack-overflow DoS).
- **Unknown `op` ⇒ throw** (closed table; nothing falls through to "true").

### Validator integration (where it runs — `validate.js`)

Relevance is gated **before** the required check, so a hidden (depends_on-false) field is never
required (matches Frappe: hidden ⇒ not validated):

```
for (const f of meta.fields) {
  if (f.dependsOn && !isRelevant(f.dependsOn, doc)) continue;   // NEW — relevance first
  const v = doc[f.fieldname];
  const empty = v === undefined || v === null || v === '';
  const required = f.reqd ||
    (f.mandatoryDependsOn && isRelevant(f.mandatoryDependsOn, doc));  // NEW — effective required
  if (required && empty) throw new ValidationError(...);
  if (empty) continue;
  /* ...existing Select/numeric/Check/unique checks unchanged... */
}
```

**`read_only_depends_on` stays YAGNI-deferred** (server validate doesn't gate writes on UI
read-only — that's `permlevel` territory, already modelled). Agreed in §3.

---

## ERPNext depends_on STRING vs engine Condition — RESOLVED as the D1->D3 boundary (was open)

ERPNext stores `depends_on` as a **string** (`"eval:doc.is_group==0"`,
`"eval:(doc.report_type == 'Profit and Loss' && !doc.is_group)"`, or a bare fieldname). The D3
evaluator consumes the engine's **structured Condition** object. These are two different
representations. Two ways to bridge — **recommend deferring the bridge**:

- **(A) — recommended:** D3 ships the structured-Condition path end-to-end; the **generator
  does NOT translate** ERPNext eval-strings. Seed/CRM authors write Conditions directly. A
  safe ERPNext-expr→Condition parser (the inverse of the no-eval evaluator: tokenise
  `doc.field op literal`, `&& || ()`, `in`) is a **separate, later** sub-pass. Rationale:
  parsing arbitrary ERPNext JS-expression strings safely is its own non-trivial,
  security-sensitive surface; coupling it into D3 risks the whole mini-pass. KISS/YAGNI.
- **(B):** build the string→Condition parser now, inside the generator, so generated defs carry
  ready Conditions. More complete, but expands D3's risky surface and blocks shipping the
  evaluator on getting the parser perfect.

**RESOLVED: (A), and it is now ENFORCED, not merely recommended.** Per critique C-D3-1 the
string-vs-Condition gap is a **one-way security coupling D1->D3**, not a free choice: the
generator's D1-2 whitelist **drops** every ERPNext eval-string by construction, so no raw
string can reach the structured evaluator D3 makes live. **D3 does NOT ship until D1-2's
explicit-drop contract is frozen + tested.** Ship the evaluator + structured model now; the
safe eval-string->Condition translator remains a separate later sub-pass (reuses this
allowlist grammar, inverted).

---

## One work order vs phased — RECOMMENDATION: **phased D1 / D2 / D3, in that order**

They are independently shippable and have **different blast radii**:

- **D1 (generator)** — purely **additive** (`src/generator/`, `scripts/`). Touches no existing
  runtime; its only contract is "output passes `assertValidDef` and feeds `installer`". Lowest
  risk; unblocks generating the Selling slice. **Ship first.**
- **D2 (Single)** — a **3-site** runtime change (loader.load reads `issingle`, `Meta` gains
  `issingle` field+getter, `document.js` naming/load branch - D2-1). Independent of D1 and D3 (a
  hand-written Single def already works through installer). Small, isolated. **Ship second.**
- **D3 (depends_on)** — the **5-part round-trip chain** + a migration + the security-sensitive
  evaluator. Highest risk, must ship whole, **and is gated on D1-2's frozen drop-contract**
  (C-D3-1). **Ship last, as one atomic work order** (the whole chain in one PR — never a subset,
  per §3).

Phasing keeps each `implement` specialist on a frozen, single-concern contract (SoC) and lets
critique review the risky evaluator without the generator noise. **Correction (C-D3-1):** the
phases do NOT "share no code / have no coupling" - there is a **one-way security coupling
D1->D3**. The generator (D1) must guarantee no eval-string reaches the `dependsOn` field D3
makes live (the D1-2 frozen whitelist contract). Therefore **D3 must not ship until D1-2's
explicit-drop contract is frozen + tested.** D2 remains independent of both. Beyond that one
boundary, the phases couple only through the already-frozen installer/loader/validate
interfaces.

---

## Design-contract compliance

- **DRY:** generator emits the *same* def shape installer already eats — no second meta format;
  fieldtype enum stays sourced from `PG_TYPE_MAP`; Singles reuse the one storage path.
- **KISS:** Single = one-row table (not EAV); pure-function generator + thin CLI. (Closure is
  ON BY DEFAULT for correctness, D1-1 - not a KISS exception but a fail-fast necessity.)
- **YAGNI:** drop unmodelled DocPerm flags; Dynamic Link → Data; eval-string translator
  deferred; `read_only_depends_on` deferred.
- **SOLID / SoC:** generator (pure transform) ⟂ selector (FS walk) ⟂ CLI (I/O) ⟂ installer
  (persist); evaluator (pure) ⟂ validator (orchestration).
- **Least Privilege / security:** **NO eval / NO new Function** — closed operator table,
  field-only reads, fail-closed on unknown op AND on missing field (C-D3-2); the generator's
  D1-2 whitelist drops every ERPNext eval-string so none reaches the evaluator (the D1->D3
  boundary). The single deliberate RCE-class risk is designed out at both ends.
- **Idempotency:** generator pure; `migrate`/`syncDoctype` already idempotent; Single save is an
  upsert on a fixed name; the ALTER is `ADD COLUMN IF NOT EXISTS`.
- **Fail-Fast:** unsupported *data* type warns (fail-open, no data loss) but layout/unknown-op/
  non-array-`in`/over-depth all **throw**; generator output is `assertValidDef`-gated before any
  write.

## Frappe citations

- `frappe/core/doctype/docfield/docfield.json` — `depends_on`/`mandatory_depends_on`/
  `read_only_depends_on` are `fieldtype:"Code"`, labelled "… (JS)" (verified 2026-06-20, §3).
- `frappe/model/base_document.py` `_evaluate_virtual_field_options` — server-side
  `frappe.safe_eval` (the eval path we deliberately do **not** copy).
- Frappe Single storage = `tabSingles` key/value (the EAV model we deliberately do **not** copy).
- `is_submittable` / `autoname:"naming_series:"` / `naming_rule` shapes confirmed on
  `erpnext/selling/doctype/sales_order/sales_order.json`.
