# Work Order — Pass D: Generator (D1) / Single (D2) / depends_on (D3)

- **Author:** planner
- **Date:** 2026-06-20
- **Inputs:** `docs/adr-generator.md` (frozen design, critique PASS-2), `docs/critique-generator.md`
  (the 5 pinned items + the D1→D3 security gate).
- **Composition gate:** **GO** (see §6). Interfaces line up, no cycles, contract-compliant.
- **Repo:** `C:\Users\parrg\Documents\spartan-erp-engine` (engine — separate from CRM CWD).
- **Test runner:** `npx vitest run <file>` (run mode only — never watch).

> **Reading order for implement specialists:** this work order is the source of truth for
> the FROZEN interface at each boundary. Do not diverge from a signature here. If a frozen
> interface won't compile against the real code, STOP and hand back to the lead — do not
> improvise a different shape.

---

## 0. Phase / blast-radius summary

| Phase | What | Blast radius | Ships |
|---|---|---|---|
| **D1** | Generator (`src/generator/` + `scripts/`) | **purely additive** — no existing runtime file edited | first |
| **D2** | Single doctypes — 3 runtime sites | loader.js + meta.js + document.js | second |
| **D3** | depends_on round-trip (5 parts) + ALTER + no-eval evaluator | migration + boot-meta.js + installer.js + loader.js + registry.js + validate.js + new depends-on.js | last, **gated on D1-U3 green** |

**The one cross-phase dependency (critique #2 / C-D3-1):** D3's depends_on column must not go
live until D1's whitelist-drop test (**U3**) is green. Encoded below as `D3 blockedBy U3`.

---

## 1. FILE-COLLISION MAP (the bit that has bitten us before)

Every editable file mapped to **exactly one owning unit**. Where D2 and D3 both need a file,
the units are **serialized** (never two specialists writing the same file concurrently).

| File | D1 | D2 | D3 | Owning unit(s) | Concurrency rule |
|---|---|---|---|---|---|
| `src/generator/*.js` (new) | ✅ create | — | — | U1, U2 | new files, no collision |
| `scripts/generate-doctypes.mjs` (new) | ✅ create | — | — | U4 | new file |
| `src/runtime/document.js` | — | ✅ edit | — | **U6 only** | D2-only — safe |
| `src/meta/meta.js` | — | ✅ edit | — | **U6 only** | D2-only — safe |
| `src/meta/loader.js` | — | ✅ edit (step 5: read `issingle`) | ✅ edit (step 2: read `depends_on`) | **U6 (D2) → U9 (D3)** | **SERIALIZE: U9 starts after U6 lands.** Two different edit regions but same file. |
| `src/meta/boot-meta.js` | — | — | ✅ edit (DocField cols) | **U9 only** | D3-only — safe |
| `src/meta/installer.js` | — | — | ✅ edit (syncDoctype write) | **U9 only** | D3-only — safe |
| `src/meta/registry.js` | — | — | ✅ edit (FieldDef typedef) | **U9 only** | D3-only (doc-comment only) — safe |
| `src/runtime/validate.js` | — | — | ✅ edit (relevance gate) | **U10 only** | D3-only — safe |
| `src/runtime/depends-on.js` (new) | — | — | ✅ create | **U10** | new file |
| `supabase/migrations/<ts>_docfield_depends_on.sql` (new) | — | — | ✅ create | **U8** | new file |

**Collision conclusion:** the only shared editable file across phases is **`src/meta/loader.js`**
(D2 site #1 and D3 site #4). Because D3 is already gated to start after D1, and D2 ships *before*
D3 anyway (§0 ordering), U6's loader edit lands before U9's loader edit — **serial by phase
ordering, no extra gate needed beyond the existing D2-before-D3 sequence.** No other file is
co-edited. boot-meta/installer/meta are NOT co-edited despite the brief's worry: meta.js is D2-only,
boot-meta.js + installer.js are D3-only.

---

## 2. UNITS — dependency-ordered, with FROZEN interfaces, specs, and done-criteria

Units are labelled **U1…U10**. "Parallel group" tags say what may run concurrently.

### ── PHASE D1 (additive generator) ──

#### U1 — fieldtype map  `src/generator/fieldtype-map.js`
**Parallel group A** (no deps). FROZEN interface:

```js
// LAYOUT_TYPES: Section Break, Column Break, Tab Break, HTML, Button, Fold, Heading
export const LAYOUT_TYPES;            // Set<string>
// ERP_TO_ENGINE: supported ERPNext fieldtype -> engine fieldtype (the §1b table (ii))
export const ERP_TO_ENGINE;           // Record<string,string>
// UNSUPPORTED_TO_TEXT: ERPNext-only data types mapped to Data/Text with warn (§1b (iii))
export const UNSUPPORTED_TO_TEXT;     // Record<string,'Data'|'Text'>

/**
 * @param {string} erpFieldtype
 * @returns {{ kind:'layout' } | { kind:'mapped', fieldtype:string }
 *          | { kind:'unsupported', fieldtype:'Data'|'Text', warn:string }}
 * Throws Error('Unknown ERPNext fieldtype: <x>') for a type in none of the 3 buckets (fail-fast).
 */
export function mapFieldtype(erpFieldtype);
```

- **3-bucket rule (ADR §1b):** Layout→`{kind:'layout'}` (skip); supported→`{kind:'mapped',...}`
  with engine fieldtype ∈ `Object.keys(PG_TYPE_MAP) ∪ {Table}`; unsupported-data→`{kind:'unsupported',...}`.
- `Table` and `Table MultiSelect` → `{kind:'mapped',fieldtype:'Table'}`.
- `Percent`→`Float`; `Read Only`/`Small Text`→`Data`; `Text Editor`/`Code`/`Markdown Editor`/
  `HTML Editor`→`Text`/`Code` per §1b(ii).
- `Dynamic Link`→`{kind:'unsupported',fieldtype:'Data',...}` (options handled by U2, not here).

**Spec** `src/generator/fieldtype-map.test.js` — key assertions:
- every engine `fieldtype` returned for a `mapped` bucket is in `[...Object.keys(PG_TYPE_MAP),'Table']`
  (import `PG_TYPE_MAP` from `../meta/ddl.js` — single source).
- `Section Break`/`Column Break`/`Tab Break`/`HTML`/`Button` → `kind:'layout'`.
- `Time`,`Attach`,`Image`,`Dynamic Link` → `kind:'unsupported'` with a non-empty `warn`.
- an invented type throws.

**Done-criteria:** `npx vitest run src/generator/fieldtype-map.test.js` green; no engine
fieldtype outside the `def-schema` enum can be emitted.

---

#### U2 — pure transform  `src/generator/erpnext-to-def.js`
**Parallel group A** but **depends on U1's exported contract** (import only — can co-develop, must
land after U1). FROZEN interface:

```js
/** @param {object} json  a parsed ERPNext DocType JSON */
export function isRealDoctype(json);   // -> json.doctype === 'DocType'

/**
 * @param {object} f   one ERPNext field object
 * @returns {FieldDef|null}   null for layout fields (skipped)
 * EXPLICIT KEY-WHITELIST — builds the object key-by-key. SPREAD ({...f}) IS FORBIDDEN.
 * Output carries ONLY: { fieldname, fieldtype, reqd, readOnly, unique, permlevel,
 *                        options, fetchFrom, idx }
 * NEVER carries dependsOn / mandatoryDependsOn (D1-2 security boundary).
 */
export function mapField(f);

/** @param {object} p  ERPNext permission -> camel DocPerm the installer reads */
export function mapPermission(p);

/**
 * @param {object} json  a real ERPNext DocType JSON (json.doctype === 'DocType')
 * @returns {object} def  the camelCase def shape installer.syncDoctype / assertValidDef eat
 */
export function erpnextJsonToDef(json);
```

**mapField rules (FROZEN, ADR §1-2 / §1b):**
- `fieldname` verbatim; `fieldtype` = U1 `mapFieldtype` result (layout ⇒ return `null`).
- renames: `read_only`→`readOnly`, `fetch_from`→`fetchFrom`.
- booleans coerced `!!` (ERPNext 0/1): `reqd`, `readOnly`, `unique`.
- `permlevel` = `Number(f.permlevel ?? 0)`; `idx` = `Number(f.idx ?? 0)`.
- `options`: kept verbatim for `Link`/`Table`/`Table MultiSelect`/`Select`; **STRIPPED
  (`undefined`) for `Dynamic Link`** (D1-3); `undefined` for everything else.
- `depends_on` / `mandatory_depends_on` keys are **not read and not written** — dropped by
  construction (whitelist). No `{...f}` spread anywhere in the module.

**erpnextJsonToDef field map (ADR §1 table):** `doctype`←`json.name`; `table`←
`"tab"+name.replace(/\s+/g,"")` (**must equal loader.js:135**); `module` verbatim;
`submittable`←`!!is_submittable`; `issingle`←`!!issingle`; `istable`←`!!istable`;
`autoname`/`naming_rule` passthrough; `scopeFields`←`[]`; `fields`←`json.fields.map(mapField).filter(Boolean)`;
`permissions`←`json.permissions.map(mapPermission)`.

**Spec** `src/generator/erpnext-to-def.test.js` — key assertions:
- `isRealDoctype({doctype:'DocType'})===true`; fixture-shaped JSON ⇒ false.
- `table` for `"Sales Order"` === `"tabSalesOrder"`.
- a layout field ⇒ `mapField` returns `null`; the def's `fields` excludes it.
- `Dynamic Link` field ⇒ `options===undefined`.
- **`erpnextJsonToDef(json)` output passes `assertValidDef` (import from
  `../validation/def-schema.js`).**

**Done-criteria:** spec green; output of `erpnextJsonToDef` over a real Selling JSON passes
`assertValidDef`.

---

#### U3 — **THE PINNED DROP-TEST (critique #1, HARD done-criterion; D3 gate)**
**Owned alongside U2** (same module under test) but is a **separate, named acceptance test** so
the lead can gate D3 on it explicitly. File: `src/generator/erpnext-to-def.drop.test.js`.

**FROZEN assertion (verbatim intent):** *given a source ERPNext field-set whose fields carry
`depends_on` and `mandatory_depends_on` `"eval:..."` strings, the generated def has ZERO
`dependsOn`/`mandatoryDependsOn` keys and ZERO string-typed conditions.*

```js
// build a JSON whose fields each carry depends_on:'eval:doc.is_group==0'
//   and mandatory_depends_on:'eval:doc.x=="y"'
const def = erpnextJsonToDef(json);
for (const f of def.fields) {
  expect(f).not.toHaveProperty('dependsOn');
  expect(f).not.toHaveProperty('mandatoryDependsOn');
  expect(Object.values(f).some(v => typeof v === 'string' && v.startsWith('eval:'))).toBe(false);
}
```

**Done-criteria (HARD):** `npx vitest run src/generator/erpnext-to-def.drop.test.js` green.
**D3 (U8/U9/U10) is `blockedBy` this test landing green.** No D3 column goes live before it.

---

#### U4 — selector + closure  `src/generator/select-doctypes.js`
**Parallel group A** (no deps on U1/U2 except importing `mapFieldtype`/closure helpers). FROZEN:

```js
/** @param {string} root  erpnext source root  @returns {string[]} absolute JSON file paths */
export function listAllDoctypeFiles(root);

/**
 * @param {string[]} seeds        doctype NAMES to start from
 * @param {string}   root         erpnext source root
 * @param {{ noClosure?: boolean }} [opts]
 * @returns {string[]}  the doctype names to generate (seeds ∪ transitive Link/Table/
 *          Table MultiSelect targets when closure on; just seeds when noClosure)
 * Throws (fail-AT-GENERATE) when noClosure===true AND a Link/Table/Table MultiSelect target
 *   falls OUTSIDE the seed set, naming the missing target (D1-1 guard rail).
 */
export function closureOver(seeds, root, opts);
```

- **Closure ON by default (D1-1).** BFS over `Link`/`Table`/`Table MultiSelect` `options`
  (derive deps via U2 `mapField` so Dynamic-Link strip is honoured — a Dynamic Link is NOT a dep).
- `isRealDoctype` filters the 635 files (`json.doctype==='DocType'`).

**Spec** `src/generator/select-doctypes.test.js` (uses an in-memory/fixture FS or a tmp dir):
- closure over a seed with a cross-target includes the target.
- `noClosure:true` with an outside Link/Table target **throws naming the target**.
- a Dynamic Link field does NOT add a closure dep.

**Done-criteria:** spec green.

---

#### U5 — the CLI  `scripts/generate-doctypes.mjs`
**Depends on U2 + U4** (composition). FROZEN CLI contract:

```
node scripts/generate-doctypes.mjs --root <erpnextRoot> --seed "<Doctype>" [--seed ...]
     [--no-closure] (--emit | --apply)
```

- Reads files (the I/O layer — generator fns stay pure).
- `closureOver(seeds, root, {noClosure})` → for each name: parse JSON → `erpnextJsonToDef` →
  **`assertValidDef` over EVERY def in the closure (not just seeds, D1-3)**.
- `--emit` → `installer.emitMigration(def)` per def (file for human `db push`).
- `--apply` → `installer.migrate(def, pgStore, { admin: pgAdmin })` — **PgStore + PgAdmin only**
  (SupabaseStore.transaction throws — ADR verified-facts). Document this in a header comment.
- Warnings from `mapFieldtype` unsupported bucket are collected and printed (named field + type).

**Spec / done-criteria (the closure live-check, critique #4):**
- `src/generator/generate-doctypes.test.mjs` (or driving the pure pipeline from a test): generate
  `Sales Order` under **closure-by-default**, prime the produced set into a MemoryStore via
  `syncDoctype` for each def, then `ensure('Sales Order', store)` — assert **no `NotFoundError`**.
- `--no-closure` with `Sales Order` (which Links outside the seed) ⇒ throws at generate time
  naming a missing target.
- (CLI argv parsing may be smoke-tested; the pipeline correctness is the real gate.)

> **Note (non-blocking, critique #5):** `PG_TYPE_MAP` `Time → time` is a deferred open item.
> Do NOT add it in this pass; `Time` rides the unsupported→text bucket with a warning. Leave a
> `// TODO(PG_TYPE_MAP): add Time->time, then move Time to ERP_TO_ENGINE` near U1's map.

---

### ── PHASE D2 (Single — one owning unit, all 3 sites) ──

#### U6 — Single doctype, 3 sites  `loader.js` + `meta.js` + `document.js`
**One unit, one specialist** (the 3 sites are interdependent; splitting them invites the
half-build critique flagged as D2-1). **Parallel with all of D1** (independent code). Must land
its `loader.js` edit **before U9** (file-collision serialization, §1).

**FROZEN site 1 — `loader.js` step 5 (loader.js:131-138):** read the flag and pass it:
```js
const issingle = !!(row.issingle);                 // NEW
// ...
const meta = new Meta({ doctype, table, submittable, issingle, autoname,
                        fields, childTables, scopeFields, permissions });   // + issingle
```

**FROZEN site 2 — `meta.js` (mirror `_submittable`/`get submittable()`):**
```js
this._issingle = Boolean(def.issingle ?? false);   // in constructor, net-new
get issingle() { return this._issingle; }           // net-new getter
```

**FROZEN site 3 — `document.js` Single branch.** At the **TOP** of `insert()` AND `save()`,
**before** any `!this.doc.name` test (document.js:53 and :67):
```js
if (this.meta.issingle) this.doc.name = this.meta.doctype;   // before the !doc.name checks
```
Consequence (FROZEN): `resolveName` is NEVER reached for a Single; `save()` takes the fixed-name
update branch ⇒ idempotent upsert, exactly one row. **Do NOT touch `naming.js`** (SoC — naming
stays ignorant of Singles; confirmed correct per ADR open-item resolution).

**Load-absent → empty doc:** the Single read uses the existing `loadDoc(doctype, name=doctype, store)`
path; when `store.get` returns nothing for a Single, return an **empty doc with defaults** (Singles
"always exist" config holders) rather than `NotFoundError`. Implement the absent-Single branch in
the same `loadDoc`/read path **without** a privileged short-circuit (see U7).

**Spec** `src/runtime/single-doctype.test.js` (MemoryStore) — key assertions:
- a hand-written Single def (`issingle:true`) saved twice ⇒ `store.list(table)` has **exactly one
  row** whose `name === doctype` (the duplicate-row regression, D2-2).
- `Meta` for a Single returns `issingle===true`; a normal doctype returns `false`.
- saving a Single never calls `resolveName` (assert the row name equals the doctype, not a
  `tab…-<hash>`).
- reading an absent Single returns an empty doc (defaults), not a throw.

**Done-criteria:** spec green; full suite still green (`npx vitest run`).

---

#### U7 — D2-3 perms-layer verification (critique #3)  `src/runtime/single-perms.test.js`
**Owned by U6's specialist** (same concern) but a **separate named test** so the security
requirement is an explicit acceptance gate. **No new source file** — it exercises the existing
`src/perms/permissions.js` (`can`/`assertCan`/`maskRead`) through the Single read.

**FROZEN assertion:** the synthesised empty-Single doc flows through the **same** read-perm
filter as any other doc — **no privileged short-circuit.**
- a context WITHOUT read perm on the Single is denied (same denial as any doctype) — assert via
  the perms entry point the read path actually uses (`assertCan(ctx, doctype, 'read', doc)` /
  `maskRead`), confirmed against `permissions.js`.
- a context WITH read perm gets the empty-defaults doc.

**Done-criteria:** spec green — proves the empty-on-absent read is perm-gated, not assumed.

---

### ── PHASE D3 (depends_on — ship WHOLE, gated on U3) ──

> **D3 GATE:** U8, U9, U10 are all **`blockedBy U3`** (the whitelist drop-test green). D3 ships as
> ONE atomic PR (all 5 parts + evaluator + migration) — never a subset (§3 convention).

#### U8 — ALTER migration  `supabase/migrations/<ts>_docfield_depends_on.sql`
**blockedBy U3.** **Parallel with U9/U10** (new file). FROZEN content:
```sql
-- ROLLBACK: alter table "tabDocField" drop column if exists depends_on, drop column if exists mandatory_depends_on;
alter table "tabDocField" add column if not exists depends_on text;
alter table "tabDocField" add column if not exists mandatory_depends_on text;
```
- Full-timestamp filename (`supabase migration new docfield_depends_on` — never date-only).
- Idempotent; rollback comment at top (critique C-D3-3 / repo convention).
- **DO NOT `db push`** — surface to the human (deploy gate, §1/§7). Done = file authored + dry-run
  reasoning noted.

**Done-criteria:** migration file present, idempotent, rollback comment first line; `supabase db
push --dry-run` is a **human-gated** follow-up (not run by the specialist).

---

#### U9 — round-trip wiring  `boot-meta.js` + `installer.js` + `loader.js` + `registry.js`
**blockedBy U3 AND U6** (U6 edits the same `loader.js` field-map region first, §1 serialization).
**This unit serializes after U6.** FROZEN edits:

1. **`boot-meta.js`** — add to the `DocField` meta entry (boot-meta.js:60-74) two fields:
   `{ fieldname:'depends_on', fieldtype:'Code' }`, `{ fieldname:'mandatory_depends_on', fieldtype:'Code' }`.
2. **`installer.js` syncDoctype** (the field-row map, installer.js:121-131) — add:
   `depends_on: f.dependsOn ?? null`, `mandatory_depends_on: f.mandatoryDependsOn ?? null`.
3. **`loader.js` step 2** (loader.js:81-91 field map) — add read-back:
   `dependsOn: f.depends_on`, `mandatoryDependsOn: f.mandatory_depends_on`.
4. **`registry.js` FieldDef typedef** (registry.js:9-19) — add `@property {object} [dependsOn]`
   and `@property {object} [mandatoryDependsOn]` (structured Condition, NOT a string — doc only).

**Spec** `src/meta/depends-on-roundtrip.test.js` (MemoryStore):
- a def with a field carrying a structured `dependsOn` Condition → `syncDoctype` → `loader.load`
  → the loaded FieldDef's `dependsOn` deep-equals the original Condition (round-trip intact).
- the boot DocField meta now exposes `depends_on`/`mandatory_depends_on` columns.

**Done-criteria:** round-trip spec green; existing installer/loader specs still green.

---

#### U10 — the NO-EVAL evaluator + validator integration  `src/runtime/depends-on.js` + `validate.js`
**blockedBy U3.** **Parallel with U8 and U9** (depends-on.js is a new file; validate.js is
D3-only and not co-edited). This is the security-sensitive core. FROZEN interface:

```js
/**
 * Condition := { field, op, value? } | { all:[] } | { any:[] } | { not: }
 * Op := 'eq'|'neq'|'in'|'nin'|'gt'|'gte'|'lt'|'lte'|'truthy'|'falsy'|'set'|'notset'
 * NO eval, NO new Function. Reads ONLY doc[cond.field] — no paths, no calls, no globals.
 */
export function evalCondition(cond, doc, depth = 0);   // -> boolean
export function isRelevant(cond, doc);                  // undefined cond -> true
```

**FROZEN rules (ADR §3, pinned):**
- `undefined` cond ⇒ `true`.
- **missing field (C-D3-2):** `doc[field]===undefined` ⇒ NO throw; fail-closed for relevance
  (`set`/`truthy`⇒false, `notset`/`falsy`⇒true, `eq`/`gt`/…⇒false).
- `{all:[]}`⇒true; `{any:[]}`⇒false.
- `in`/`nin` non-array `value` ⇒ **throw** (authoring bug).
- `eq`/`neq` Check coercion mirrors `validate.js:31` (0/1 ↔ true/false agree with `truthy`).
- recursion **depth cap 32** ⇒ throw.
- **unknown `op` ⇒ throw** (closed table — nothing falls through to true).

**FROZEN `validate.js` integration** (validate.js:14-19, inside the `for (const f of meta.fields)`
loop, BEFORE the required check):
```js
import { isRelevant } from './depends-on.js';
// at the top of the loop body:
if (f.dependsOn && !isRelevant(f.dependsOn, doc)) continue;       // relevance gate FIRST
const v = doc[f.fieldname];
const empty = v === undefined || v === null || v === '';
const required = f.reqd || (f.mandatoryDependsOn && isRelevant(f.mandatoryDependsOn, doc));
if (required && empty) throw new ValidationError(`${meta.doctype}: '${f.fieldname}' is required`);
if (empty) continue;
/* ...existing Select / numeric / Check / unique checks UNCHANGED... */
```
(Replaces the current `if (f.reqd && empty) throw …` line with the relevance-gated + effective-
required form. Everything else in the loop is untouched.)

**Spec** `src/runtime/depends-on.test.js` (the adversarial suite — pure, no store):
- leaf ops happy paths (`eq`/`in`/`gt`/`truthy`/`set`/…).
- `all`/`any`/`not` nesting; empty-group vacuity (`{all:[]}`→true, `{any:[]}`→false).
- **missing field ⇒ no throw**, relevance fail-closed per rule.
- `in` non-array ⇒ throws; depth>32 ⇒ throws; unknown op ⇒ throws.
- Check coercion: `{field:'x',op:'eq',value:true}` agrees with `{field:'x',op:'truthy'}` when
  `doc.x===1`.

**Spec** `src/runtime/validate-depends-on.test.js`:
- a field with `mandatoryDependsOn` true ⇒ required when empty (throws); false ⇒ skipped.
- a field with `dependsOn` false ⇒ not validated even if `reqd` (relevance before required).

**Done-criteria:** both specs green; full suite green; no `eval`/`new Function` anywhere
(grep the new file).

---

## 3. DEPENDENCY ORDER / PARALLELISABLE GROUPS

```
PHASE D1 (additive — start immediately, parallel with D2):
  Group A (parallel): U1 (fieldtype-map) │ U4 (selector)
  then:               U2 (transform, imports U1) ── U3 (drop-test, same module)  [U2,U3 after U1]
  then:               U5 (CLI + closure live-check, imports U2+U4)

PHASE D2 (independent of D1 — parallel with all of D1):
  U6 (Single 3-site) ── U7 (perms verify, same specialist)

PHASE D3 (GATED — does not start until U3 is GREEN; and U9 waits for U6's loader edit):
  U8 (ALTER migration)   ─┐ blockedBy U3
  U10 (evaluator+validate)─┤ blockedBy U3            (U8, U10 parallel)
  U9 (round-trip wiring)  ─┘ blockedBy U3 AND U6     (serial after U6 — shared loader.js)
```

**Maximum parallelism the lead can dispatch at once (wave 1):** U1, U4, U6 (3 specialists).
Then U2/U3 (one specialist on the transform module), then U5. D2's U6→U7 runs alongside.
**D3 dispatched only after U3 green + U6 landed.**

**Task dependency encoding for the lead (TaskUpdate `addBlockedBy`):**
- U2 blockedBy U1; U3 blockedBy U1; U5 blockedBy U2, U4.
- U7 blockedBy U6.
- U8 blockedBy U3; U10 blockedBy U3; **U9 blockedBy U3, U6.**

---

## 4. ASSEMBLY + INTEGRATION-TEST SEQUENCE

1. **D1 land + verify:** run `npx vitest run src/generator/` — all generator specs green,
   **including U3 (the drop-test) and U5 (closure-by-default primes Sales Order with no
   NotFoundError; `--no-closure` throws naming the target).**
2. **Flip the D3 gate:** confirm U3 green on `main` (or the integration branch). Only now dispatch D3.
3. **D2 land + verify:** `npx vitest run src/runtime/single-doctype.test.js
   src/runtime/single-perms.test.js`; then full suite.
4. **D3 land (atomic) + verify:** `npx vitest run src/runtime/depends-on.test.js
   src/runtime/validate-depends-on.test.js src/meta/depends-on-roundtrip.test.js`; grep new
   evaluator for `eval(`/`new Function` (must be absent).
5. **Full integration:** `npx vitest run` (whole suite) green after each phase merges.
6. **Human deploy gate:** U8's migration `supabase db push` and any `--apply` generator run are
   **human-confirmed** (§1/§7) — never auto-run by a specialist.

---

## 5. PINNED-ITEM TRACEABILITY (critique's 5 items → units)

| Critique item | Unit | Done-criterion |
|---|---|---|
| #1 D1-2 drop-test = HARD | **U3** | `erpnext-to-def.drop.test.js` green; zero dependsOn keys / zero eval-strings |
| #2 D1→D3 ship gate | **U8/U9/U10 blockedBy U3** | D3 dispatched only after U3 green |
| #3 D2-3 perms-through test | **U7** | empty-Single read perm-gated via `permissions.js`, no short-circuit |
| #4 D1 closure test | **U5** | Sales Order closure-by-default primes (no NotFoundError); `--no-closure` throws |
| #5 PG_TYPE_MAP Time→time | **U1 (deferred)** | NOT built; TODO left; Time rides unsupported→text+warn |

---

## 6. COMPOSITION GO / NO-GO

**Verdict: GO.**

- **Interfaces line up:** generator output (U2) feeds the *unchanged* `installer.syncDoctype` /
  `assertValidDef` (verified shapes match — installer reads camel keys `readOnly`/`fetchFrom`/
  `submittable`/`scopeFields`; `mapField` emits exactly those). `table` derivation matches
  loader.js:135 char-for-char.
- **No cycles:** D1 additive; D2 3-site edits are local; D3 round-trip closes through
  installer→loader (existing direction). The one cross-phase edge (D1→D3 via U3) is a one-way
  gate, not a cycle.
- **File collisions resolved:** the only co-edited file (`loader.js`, U6+U9) is serialized by the
  existing D2-before-D3 phase order; no two specialists write the same file concurrently (§1).
- **Contract-compliant:** whitelist drop is by-construction (no leak path); no-eval evaluator is a
  closed op table; Single is one storage path (DRY/KISS); fail-fast at generate (closure) and at
  the unknown-op/non-array-in/over-depth boundaries.

No NO-GO conditions. **Release to BUILD PHASE.**

---

## 7. PER-UNIT ASSIGNMENT (for the lead's `implement` fan-out)

| Unit | Files | Specialist focus | May start |
|---|---|---|---|
| U1 | `generator/fieldtype-map.js` (+test) | the 3-bucket map | immediately (wave 1) |
| U2 | `generator/erpnext-to-def.js` (+test) | pure transform / whitelist | after U1 |
| U3 | `generator/erpnext-to-def.drop.test.js` | THE drop-test (gate) | after U1 (with U2) |
| U4 | `generator/select-doctypes.js` (+test) | selector + closure | immediately (wave 1) |
| U5 | `scripts/generate-doctypes.mjs` (+test) | CLI + closure live-check | after U2, U4 |
| U6 | `runtime/document.js`, `meta/meta.js`, `meta/loader.js` (+test) | Single 3-site | immediately (wave 1) |
| U7 | `runtime/single-perms.test.js` | D2-3 perms verify | after U6 |
| U8 | `migrations/<ts>_docfield_depends_on.sql` | ALTER | after U3 green |
| U9 | `meta/boot-meta.js`, `meta/installer.js`, `meta/loader.js`, `meta/registry.js` (+test) | round-trip wiring | after U3 green AND U6 landed |
| U10 | `runtime/depends-on.js`, `runtime/validate.js` (+tests) | no-eval evaluator + integration | after U3 green |
