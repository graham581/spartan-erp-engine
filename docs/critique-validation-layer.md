# Critique: Validation Layer (Pass A) — verdict

- **Role:** critique (pure critic)
- **Date:** 2026-06-20
- **Design under test:** `docs/adr-validation-layer.md` + `diagrams/validation-layer-class.puml`
- **Method:** read the design + every live file it touches (`api/handler.js`, `api/service.js`,
  `runtime/validate.js`, `meta/{installer,loader,boot-meta}.js`, `runtime/{supabase-store,pg-admin}.js`),
  enumerated which of the 18 test files' bodies/defs flow through each proposed gate, and checked
  fieldtype usage + the env invocation points. zod confirmed installed at **4.4.3** (v4 — good).

---

## VERDICT: FAIL

Three **blocking** regressions to the 185-test suite, one **blocking** design-impossibility in the
def-schema refinement, and one **blocking** round-trip gap (the loader half of `depends_on` has no
writer). Several medium findings. Fixes are concrete and small; this is a "tighten the spec, not
rethink it" FAIL.

---

## BLOCKING findings

### B1 — `assertValidDef`'s "Table/fetchFrom target exists" refinement is un-implementable on a single def, and would reject every real def
**Where:** ADR §1b ("every `Table` field's `options` and every `fetchFrom` link-prefix should name a
field/doctype that exists") → `DocTypeDefSchema` refinement, invoked as `assertValidDef(def)` first
line of `installer.syncDoctype`.
**Why it breaks:** `assertValidDef(def)` receives **only the one def object** — it has no store and
no registry. Cross-doctype existence is not knowable from the def alone.
- `meta-as-data.integration.test.js` installs `GadgetDef` (line 29) via `seedViaLoader` →
  `syncDoctype` (confirmed `seed-via-loader.js:25` calls `syncDoctype` for **every** def). `GadgetDef`
  has `Table lines → 'GadgetLine'` and `Link customer → 'Customer'`. `GadgetLine`/`Customer` are not
  in the `GadgetDef` object, so a schema-level "target exists" refinement either can't see them or
  rejects them → **4 integration tests fail**.
- `installer.test.js` `sampleDef` (line 26) has `Table items → 'WidgetItem'`, and `WidgetItem` is
  **never installed at all** → would fail the refinement → **5 syncDoctype tests + 6 emitMigration
  tests fail** (emitMigration shares the def but would only break if it too calls assertValidDef;
  the design only hooks syncDoctype, so emitMigration is safe — but syncDoctype tests break).
**Fix:** Drop cross-doctype existence from `assertValidDef`. Keep it **purely structural**:
`Link`/`Table` must *have* a non-empty `options` string (shape only). Cross-doctype resolution
already lives in `loader.load` (the N1 "primed before load" throw at `loader.js:112-118`) — do not
duplicate it in the def schema. Update ADR §1b to say "Link/Table require a non-empty `options`
string; existence of the target is the loader's job (N1), not the def schema's."

### B2 — `loadEnv` making `DATABASE_URL` optional breaks `pg-admin.test.js`
**Where:** ADR §1c — `DATABASE_URL: nonempty (optional — only PgAdmin needs it)`; `PgAdmin.fromEnv`
rewritten to "read `loadEnv()` result".
**Why it breaks:** `pg-admin.test.js:21-27` deletes `DATABASE_URL` and asserts
`PgAdmin.fromEnv()` **throws** with a message matching `/DATABASE_URL/`. Two ways the rewrite breaks it:
1. If `loadEnv` treats `DATABASE_URL` as optional, `fromEnv()` no longer throws on its absence → test fails.
2. If `PgAdmin.fromEnv` calls the shared `loadEnv()` (which requires `SUPABASE_URL` +
   `SUPABASE_SERVICE_ROLE_KEY`), and the test env lacks those, `loadEnv` throws **first** with a
   non-`/DATABASE_URL/` message → test fails on the regex even though it threw.
**Fix:** `PgAdmin.fromEnv` must keep a **PgAdmin-specific** required check for `DATABASE_URL` (its own
one-key parse, or `loadEnv()` then assert the parsed `DATABASE_URL` is present, throwing the same
`/DATABASE_URL/` message). Do **not** route `PgAdmin.fromEnv` through a `loadEnv` that also demands
the two Supabase keys — PgAdmin doesn't need them. Equivalently: give PgAdmin its own tiny
`PgAdminEnvSchema = { DATABASE_URL: nonempty }` distinct from the Supabase `EnvSchema`.
(Note: `fromEnv` is a lazy static — confirmed `pg-admin.js:24` / `supabase-store.js:23` — so
concern #3 "env runs at import time / in MemoryStore tests" is **NOT** a problem; the only env
regression is this message/optionality one.)

### B3 — `depends_on` has a loader read but **no installer write** → it never round-trips
**Where:** ADR §2 "the loader's row→`FieldDef` map in `loader.load` gains two passthrough keys" and
module-layout marks `installer.js MOD` only as "assertValidDef first line".
**Why it's a hole:** `installer.syncDoctype` builds each `tabDocField` child row explicitly
(`installer.js:117-127`) with a **fixed key list** — `fieldname, fieldtype, reqd, options, permlevel,
read_only, unique, fetch_from, idx`. There is **no** `depends_on` / `mandatory_depends_on` in that map.
So even if `loader.load` reads `f.depends_on`, `syncDoctype` never writes it → it's always
`undefined` → the feature is dead through the real install path (the one `seedViaLoader` exercises).
The design's "boot-meta.js MOD (optional)" hedge makes this worse: if the `tabDocField` boot meta
doesn't declare the columns, the loader's `getChildren` may not surface them either.
**Fix:** `installer.syncDoctype` must add `depends_on: f.dependsOn ?? null` and
`mandatory_depends_on: f.mandatoryDependsOn ?? null` to the field-row map (camel→snake, mirroring
`fetch_from`). `loader.load` adds the reverse (`dependsOn: f.depends_on`, `mandatoryDependsOn:
f.mandatory_depends_on`). And the `tabDocField` **boot-meta** entry (`boot-meta.js:60-74`) must gain
`{ fieldname: 'depends_on', fieldtype: 'Code' }` and `{ fieldname: 'mandatory_depends_on',
fieldtype: 'Code' }` (or `'Text'`/`'JSON'`) — this is **not** "optional"; without it the columns are
invisible to the meta layer. Also: a DB column needs a migration — the design defers physical storage
to Pass D, which means Pass A ships a **read/write path to columns that don't exist in tabDocField**.
See open-question (b) ruling below — this deferral is **NOT** acceptable as written.

### B4 — request-envelope reserved-key REJECT: confirm `.strict()` scope, and that ActionBodySchema doesn't reject `submit/cancel`+patch
**Where:** ADR §1a — Create/Update reject `owner`/`docstatus`/`name`; ActionBodySchema =
`{ action: string }`.
**Regression check (passes, but pin it):** I enumerated every body that flows through
`handler.handle()`:
- `handler.test.js` POSTs: `{title,branch}` (33), `{title:'B'}` (65), `{margin:99}` (67),
  `{action:'submit'}` (73), `{action:'frobnicate'}` (76) — **no reserved key**, so the REJECT is safe here.
- `workflow.test.js` POSTs via `handle`: `{action:'start_measure'}` (146,151) — safe.
- `service.test.js` calls `createDoc` **directly** (57-59) and `store.insert('tabJob',{...docstatus:0})`
  (78) — both **bypass the handler envelope**, so the envelope check can't regress them.
**The real risk to nail down (currently under-specified):**
1. **`ActionBodySchema` must NOT be `.strict()`** — the handler dispatches `submit`/`cancel`/workflow
   actions on `body.action` (`handler.js:42-44`) but the client may legitimately send other envelope
   keys alongside (and §1a's table implies a bare `{action}`). A `.strict()` ActionBodySchema would
   400 any `{action, ...}`. Conversely an Update patch and an Action are **the same POST /name route**
   distinguished only by `body.action` — the design's selector "`POST name+action → ActionBodySchema`"
   is fine, but spell out that when `action` is present the patch keys are *ignored*, not validated as
   a patch (today `handler.js` ignores them — submit/cancel take no patch).
2. **CreatePayloadSchema/UpdatePatchSchema reserved-key reject must be `.strict()`-free for *other*
   keys** — it must reject only the three named reserved keys, while passing arbitrary business fields
   (`title`, `branch`, `margin`, `deposit_paid`, `kind`, `qty`, `sku`, …). The ADR says "permissive
   shells", so use an explicit refinement that fails iff `owner|docstatus|name` ∈ keys, **not**
   `z.object({...}).strict()` (which would reject every business field). State this explicitly in the
   spec so `implement` doesn't reach for `.strict()`.
**Fix:** ADR must specify, per schema, **strict vs passthrough** and the exact reserved set. Lock:
Create/Update = `z.record(...)` + refinement rejecting `owner/docstatus/name`, all other keys pass;
Action = `z.object({ action: z.string().min(1) }).passthrough()`; ListQuery = coercions + `f_*`
passthrough. Without this the `implement` agent's choice of `.strict()` is a coin-flip that breaks tests.

---

## MEDIUM findings

### M1 — def fieldtype enum is complete — VERIFIED, keep it exact
I grep'd every `fieldtype: '...'` literal in `src`. The full set in use is:
`Check, Code, Currency, Data, Date, Datetime, Float, Int, Link, Select, Table, Text` (12).
The ADR §1b enum lists exactly these 12. **No gap** — but note `Code` is real (used at
`ddl.test.js:30` and is the *fieldtype the depends_on columns themselves will be*, per B3). If the
implementer trims `Code` from the enum thinking it's unused, B3's boot-meta columns become invalid.
Add a comment in def-schema pinning the enum to "every fieldtype `pgTypeFor` handles in `ddl.js`".

### M2 — `DocPermDefSchema` must tolerate an extra `doctype` key on perm rows
`workflow.test.js:38-41` perms carry `doctype: 'Job'` inside each perm object; the integration test
perms (lines 38-42) do not. These reach `registerDoctype` (bypassing the def schema), so no test
breaks **today** — but if `DocPermDefSchema` is `.strict()` and any future/Pass-D def routes a
`doctype`-bearing perm through `syncDoctype`, it 400s. Make `DocPermDefSchema` `.passthrough()` or
explicitly allow `doctype?`. Low blast radius now; cheap to get right.

### M3 — `depends_on` evaluator edge cases the AST spec leaves open
ADR §2 evaluator is sound (closed op table, reads only `doc[field]`, unknown op throws — good,
no eval, Least-Privilege satisfied). Pin these before `implement`:
- **Empty group semantics:** `{all:[]}` should be `true`, `{any:[]}` should be `false` (standard
  vacuous-truth). State it, or a generated `{all:[]}` silently mis-gates.
- **`in`/`nin` with a non-array `value`:** define behaviour (throw vs coerce). A scalar `value` for
  `in` is an authoring bug → prefer **throw** (fail-fast, consistent with unknown-op).
- **Type coercion in `eq`:** Frappe's `doc.x == "1"` is loose. Decide strict `===` vs loose. A
  `Check` stored as `0/1` vs a condition `value:true` will mis-evaluate under strict `===`. Given
  `validate.js:31` already treats Check as `boolean|0|1`, the evaluator must normalise the same way or
  `mandatory_depends_on:{field:'is_active',op:'truthy'}` and an `eq:true` will disagree. **Specify the
  coercion rule and mirror `validate.js` Check handling.**
- **Recursion depth bound:** ADR says "bounded tree, authored data" but sets no limit. A generated
  cyclic-by-reference AST can't occur (it's a value tree, not a graph) so no infinite loop — acceptable,
  but add a defensive depth cap (e.g. 32) so a pathological generated def fails loud, not via stack overflow.

### M4 — relevance-gate ordering is CORRECT — verified against the open question
Open question #5 (a field BOTH `reqd` AND `depends_on`-false must be **skipped**): the proposed loop
(ADR §2 "How validateAgainstMeta uses it") puts the relevance `continue` **before** the
required-check — `if (f.dependsOn && !isRelevant(...)) continue;` precedes
`const required = f.reqd || ...`. So a hidden field is skipped regardless of `reqd`. **This matches
Frappe** (hidden ⇒ not validated) and is correct. Open question #6 (`effective-required = reqd ||
(mandatoryDependsOn && relevant)`) also correct — no double-require, no mis-skip. Keep as written.
One nit: the existing loop computes `empty` once; the new loop must keep `if (empty) continue;`
**after** the required-check (as drafted) so optional-empty fields still skip the type checks — drafted
correctly.

---

## Architect's 3 open questions — rulings

- **(a) reserved-key reject vs strip:** **REJECT is correct** (architect's lean). Stripping silently
  discards client intent and hides a misuse; rejecting fail-fasts at the door and is verified safe
  against all `handle()`-routed test bodies (B4). **Caveat:** the reject must target *only*
  `owner/docstatus/name` via a refinement, not `.strict()` (B4). Approved with B4's spec tightening.
- **(b) defer physical storage of dependsOn columns to Pass D:** **NOT acceptable as written.** B3
  shows Pass A wires a read (loader) + needs a write (installer) + needs boot-meta columns for a
  `tabDocField` column that **does not exist** until the deferred migration. Pass A would ship a
  feature that is dead (no column) or throws (PostgREST "column not found") the moment a def sets
  `dependsOn`. Either (i) include the `tabDocField` `depends_on`/`mandatory_depends_on` column
  migration **in Pass A**, or (ii) explicitly scope Pass A's `depends_on` to **in-memory FieldDef
  only** (validator + evaluator + def-schema), with installer/loader/boot-meta passthrough **and** the
  column migration **all** deferred together to Pass D — but then the evaluator is untestable through
  the real `seedViaLoader` round-trip in Pass A. Pick one and state it; the current half-split (loader
  reads, installer doesn't write, columns don't exist) is internally inconsistent.
- **(c) `read_only_depends_on` deferred (YAGNI):** **AGREE.** Server-side validate doesn't gate writes
  on UI read-only; that's `permlevel` territory (already modelled). Deferral is sound and the ADR
  flags it explicitly so a future reader won't "fix" it. Approved.

---

## What's already sound (no change needed)
- No-eval structured AST over a closed op table: correct Least-Privilege call; (a)>(b) reasoning holds.
- `parseOrThrow` single bridge (DRY) → `ValidationError` → 400 via existing `statusFor` (`handler.js:10`):
  no error-switch change needed. Correct.
- Envelope-only request schemas (locked principle intact): correct, per-field truth stays in meta.
- `isRelevant(undefined,doc)===true` keeps every existing `validate.test.js` meta passing: verified.
- `fromEnv` is lazy (static method, not import-time): concern #3 is a non-issue. Verified.
- fieldtype enum completeness: verified exact (M1).
- relevance-gate-before-required ordering: verified correct (M4).

---

## VERDICT: **FAIL** — fix B1–B4 and rule open-question (b); re-submit to critique. (Medium findings M1–M4 should be folded into the spec in the same pass so `implement` has no coin-flips.)

---
---

# REV-2 RE-REVIEW (critique, 2026-06-20)

**Scope:** ADR rev 2 (`docs/adr-validation-layer.md`) + PUML rev 2 (`diagrams/validation-layer-class.puml`),
checked against the live code and the 18 test files. Each rev-1 blocker re-verified for *genuine* closure.

## VERDICT: **PASS** (with one trivial spec-correction the implementer must apply — see R1)

### B1 — CLOSED (verified)
`DocFieldDefSchema` is now structural-only: `Link`/`Table` require a **non-empty `options` string**,
with **no** cross-doctype existence check (ADR §1b; PUML line 84). Traced both contested defs through
`assertValidDef`:
- integration `GadgetDef` — `Table lines → 'GadgetLine'`, `Link customer → 'Customer'`: both have
  non-empty `options` strings → **PASS** (schema never asks if the target exists).
- installer `sampleDef` — `Table items → 'WidgetItem'` (never installed): non-empty `options` → **PASS**.
Existence stays the loader's N1 throw (`loader.js:112-118`), unchanged. The ~9 tests B1 would have
broken stay green.

### B2 — CLOSED (verified)
Two separate env schemas (ADR §1c): `EnvSchema` = `{SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY}` only
(`DATABASE_URL` explicitly NOT in it); `PgAdminEnvSchema` = `{DATABASE_URL}` with its own
`loadPgAdminEnv`. `PgAdmin.fromEnv` keeps a PgAdmin-specific check and the thrown message still
matches `/DATABASE_URL/`, so `pg-admin.test.js:21-27` stays green; it does not pull in the two
Supabase keys. Confirmed against `pg-admin.js:24-28` / `supabase-store.js:23-28`.

### B3 — CLOSED (verified)
The whole `depends_on`/`mandatory_depends_on` chain is deferred out of Pass A (ADR §3). Module layout
marks `validate.js — UNCHANGED` and lists no loader/installer/boot-meta touch. Confirmed no active
Pass-A surface reads/writes a `depends_on` column: `installer.js` field-row map (117-127) not in MOD
list, `loader.js`/`boot-meta.js` not in MOD list, `validate.js` explicitly unchanged. The
inconsistent half-build is gone; the no-eval AST + M3 edge cases are parked intact in §3. No
`validate.test.js` regression risk (validator byte-for-byte unchanged).

### B4 / M2 — CLOSED (verified)
Strict-vs-passthrough pinned per schema (ADR §1a; PUML 69-71): Create/Update = `z.record` +
refinement rejecting only `owner/docstatus/name`, NO `.strict()`; Action = `.passthrough()`; DocPerm =
`.passthrough()`. Traced every `handle()`-routed body + every installed def:
- `handler.test.js`: `{title,branch}`(33), `{title:'B'}`(65), `{margin:99}`(67) pass Create/Update;
  `{action:'submit'}`(73), `{action:'frobnicate'}`(76) pass ActionBodySchema.
- `workflow.test.js`: `{action:'start_measure'}`(146,151) pass; perms carry `doctype:'Job'`(38-41) but
  reach `registerDoctype`, not `assertValidDef` (and would pass `.passthrough()` regardless).
- `service.test.js` direct `createDoc`(57-59) + `store.insert(...docstatus:0)`(78) bypass the envelope.
- installer/migrate/integration defs: perm shapes (incl. `delete:true`) accepted by `.passthrough()`.
All 185 stay green.

### M1 — CLOSED on content; R1 spec-correction on mechanism
Enum content exact: `Object.keys(PG_TYPE_MAP)` (11) + `'Table'` = the 12 required, `Code` kept.
Mechanism needs R1 (below).

### env lazy/cold-start — CLOSED (verified)
`loadEnv`/`loadPgAdminEnv` called only inside the static `fromEnv()` methods (`supabase-store.js:23`,
`pg-admin.js:24`), never import-time; throw plain `Error`. Hermetic MemoryStore tests never call
`fromEnv` → unaffected.

## Residual (non-blocking) — apply during implement

### R1 (LOW, spec-correction) — `PG_TYPE_MAP` is not exported from `ddl.js`
ADR §1b/§2 + PUML line 120 derive the enum via `Object.keys(PG_TYPE_MAP)` "imported from `ddl.js`",
but the module-layout table marks `ddl.js — unchanged`. **`PG_TYPE_MAP` is a module-private `const`
at `ddl.js:16` — only `pgTypeFor`/`createTableSql` are exported** (verified: no matching export). To
import it, `ddl.js` needs a one-line `export { PG_TYPE_MAP }`. One-line change, not a design hole, but
the "ddl.js unchanged" layout line is inaccurate. **Fix for `implement`:** export `PG_TYPE_MAP` from
`ddl.js` and import it in `def-schema.js`; do NOT inline a duplicate fieldtype array (that reintroduces
the M1 drift). Update the ADR layout line for `ddl.js` to "MOD — export `PG_TYPE_MAP` as the enum
source". The PUML already shows the `DefSchema ..> DdlMap` edge, so it is consistent; only the ADR
table line is stale.

## Net
B1–B4 genuinely closed against the live code + all 18 suites; M1/M2 closed on content; env invocation
confirmed lazy. Only residual is R1, a trivial export applied in the same change. Design is sound.

## REV-2 VERDICT: **PASS** → proceed to planner (carry R1 as an implement-time note; the deferred
`depends_on` mini-pass design is parked intact in ADR §3 with M3 edge cases preserved).
