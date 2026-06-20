# ADR: Validation Layer (Pass A) — Zod at fixed boundaries

- **Status:** Proposed — **Revision 2** (architect, after critique FAIL) → critique
- **Date:** 2026-06-20
- **Context repo:** `spartan-erp-engine`
- **Relates to:** `docs/adr-meta-as-data.md` (the meta IS data; per-doctype field
  rules live in `tabDocField`, not in code). This ADR is the **complement**: it adds
  Zod only where shapes are **fixed and code-known**.
- **Rev-2 changelog:** addresses critique B1–B4 + M1–M4.
  - **SCOPE (lead ruling on open-Q-b / B3):** the entire `depends_on` /
    `mandatory_depends_on` chain is **deferred out of Pass A** — it is not
    half-built here. **Pass A = Zod boundaries ONLY.** The no-eval AST design is
    parked intact in §3 (Deferred) for the future mini-pass to reuse.
  - **B1:** `assertValidDef` is now **purely structural** — `Link`/`Table` require a
    non-empty `options` **string** only; cross-doctype target existence is the
    loader's N1 job (`loader.js:112`), not the def schema's.
  - **B2:** `PgAdmin.fromEnv` keeps its **own** `DATABASE_URL` check; it is **not**
    routed through the shared `loadEnv` (which validates only the two Supabase keys).
  - **B4 / M2:** strict-vs-passthrough is pinned **per schema** (Create/Update =
    refinement rejecting only the 3 reserved keys, no `.strict()`; Action & DocPerm
    = `.passthrough()`).
  - **M1:** the fieldtype enum is pinned to the single source `ddl.js` `PG_TYPE_MAP`.

## Problem

Three of the engine's input boundaries have **fixed, code-known shapes** but no
structural validation:

1. **Request envelopes.** `handler.handle()` (`api/handler.js`) takes
   `{ method, doctype, name, body, query }` and passes `body`/`query` straight into
   `service.createDoc/updateDoc/listDocs`. A malformed body, a non-object payload,
   a junk query string, or a client smuggling a reserved system field
   (`owner`/`docstatus`/`name`) reaches the service and either mis-behaves or fails
   as a cryptic downstream error rather than a clean `400`.
2. **The doctype definition (`def`).** `installer.syncDoctype()` / `migrate()` accept
   a `def` plain object with **no structural check** — a malformed def (missing
   `fieldtype`, a bad fieldtype string, a `Link`/`Table` field with no `options`)
   surfaces as an opaque Postgres/PostgREST error at install, not a loud, located
   validation error.
3. **Env.** `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are read ad-hoc in
   `SupabaseStore.fromEnv` with a bespoke `throw`; `DATABASE_URL` likewise in
   `PgAdmin.fromEnv`.

### LOCKED principle (not relitigated)

**Zod is for FIXED, code-known boundaries only** — request envelopes, the
meta-schema (the schema *for* the meta), and env. It is **not** per-doctype field
validation; that stays meta-driven in `validate.js`, where the schema is **data**.

## Decision

A new package `src/validation/` holds Zod schemas as `const` data plus a single
bridge mapping `ZodError → ValidationError`. `zod` v4 is installed (4.4.3, verified).

### 1. Zod at the boundaries

#### 1a. Request envelopes — `src/validation/request-schemas.js`

Schemas describe the **envelope shape**, not per-field business rules. **Per-schema
strict/passthrough is pinned** (B4) so `implement` has no `.strict()` coin-flip:

| Schema | Validates | Shape & strictness (LOCKED) |
|---|---|---|
| `CreatePayloadSchema` | POST `/<doctype>` body | `z.record(z.string(), z.unknown())` **+ a refinement that fails iff any of `owner` / `docstatus` / `name` is a key**. **NO `.strict()`** — every business field (`title`, `branch`, `margin`, `deposit_paid`, `kind`, `qty`, `sku`, …) passes. |
| `UpdatePatchSchema` | POST `/<doctype>/<name>` body (no `action`) | same as Create: record + reserved-key refinement, no `.strict()`. |
| `ActionBodySchema` | POST `/<doctype>/<name>` with `action` | `z.object({ action: z.string().min(1) }).passthrough()` — **must NOT be `.strict()`**: the client may send other envelope keys alongside `action`, and when `action` is present the handler ignores patch keys (`handler.js:42-44`; submit/cancel/workflow take no patch). |
| `ListQuerySchema` | GET `/<doctype>` query | `limit`/`offset` coerce to non-negative int; `order` ∈ `asc\|desc`; `order_by` string; `f_*` filter keys **passthrough**. |

The reserved-key reject is a **refinement, not `.strict()`** — `.strict()` would 400
every legitimate business field (B4). It rejects **only** `owner` / `docstatus` /
`name`, hardening the `owner: ctx.user` invariant in `service.createDoc`
(`service.js:34`) against client override. These are **permissive shells**: they
reject *malformed envelopes*, not unknown business fields — per-field truth stays in
`tabDocField` / `validateAgainstMeta` (locked principle).

**Where invoked:** inside `handler.handle()` in the existing `try` block, **after**
`await ensure(doctype, store)` and **before** the dispatch branch — select the schema
by `(method, name, body.action)`:

```
GET  collection        -> parseOrThrow(ListQuerySchema, query, 'query')
POST collection        -> parseOrThrow(CreatePayloadSchema, body, 'body')
POST name + action     -> parseOrThrow(ActionBodySchema, body, 'body')
POST name (no action)  -> parseOrThrow(UpdatePatchSchema, body, 'body')
GET  name              -> (no body/query schema)
```

When `action` is present, the patch keys are **ignored, not validated as a patch**
(matches today's `handler.js` — submit/cancel/workflow actions take no patch). A
reject throws `ValidationError` (via the bridge), which `statusFor()`
(`handler.js:10`) already maps to `400` — **no change to the error-mapping switch**.

#### 1b. The meta-schema ("schema for the meta") — `src/validation/def-schema.js`

The highest-value Zod use. A doctype **definition** (the `def` passed to
`installer.syncDoctype`/`migrate`) is a fixed, code-known shape. Validate it
**purely structurally** before any write:

- `DocFieldDefSchema` — `fieldname` (non-empty string), `fieldtype` ∈ the **closed
  set pinned to `ddl.js` `PG_TYPE_MAP` keys + `Table`** (M1, see below),
  `reqd?`/`readOnly?`/`unique?` booleans, `permlevel?` int, `options?` (string or
  `string[]`), `fetchFrom?` string, `idx?` int. **B1 cross-field refinement
  (structural only):** if `fieldtype` is `Link` **or** `Table`, `options` **must be
  a non-empty string** (the target *doctype name*). The schema does **NOT** check
  that the target doctype exists — `assertValidDef(def)` sees only the one def, has
  no store/registry, and cross-doctype existence is the **loader's N1 job**
  (`loader.load` throws at `loader.js:112-118` when a `Table` target wasn't primed).
- `DocPermDefSchema` — `role` required; the six action flags
  (`read`/`write`/`create`/`submit`/`cancel`/`delete`) + `permlevel?`/`ifOwner?`.
  **`.passthrough()`** (M2) — tolerate a stray `doctype` key (some defs carry
  `doctype` inside each perm row, e.g. `workflow.test.js:38-41`); a `.strict()` here
  would 400 those.
- `DocTypeDefSchema` — `doctype` (non-empty), `table?` (or derivable),
  `fields: DocFieldDefSchema[]`, `permissions?: DocPermDefSchema[]`,
  `submittable?`/`issingle?`/`istable?`/`autoname?`/`naming_rule?`/`module?`/`scopeFields?`.
  **No cross-doctype refinement** (B1).
- `assertValidDef(def)` = `parseOrThrow(DocTypeDefSchema, def, 'doctype definition')`.

**Fieldtype enum — single source (M1).** The enum is the keys of `ddl.js`
`PG_TYPE_MAP` **plus** `'Table'` (which `pgTypeFor` returns `undefined` for — it has
no column). That is exactly:
`Check, Code, Currency, Data, Date, Datetime, Float, Int, Link, Select, Table, Text`
(12). `def-schema.js` derives the enum from `Object.keys(PG_TYPE_MAP)` (imported from
`ddl.js`) `.concat('Table')` so the two **cannot drift**, with a comment pinning the
rationale. **`Code` is real** (used at `ddl.test.js:30`) — do not trim it.

**Where invoked:** `installer.syncDoctype(def, store)` calls `assertValidDef(def)` as
its **first line**, before `registerBootMeta()` and any `newDoc('DocType', ...)`.
`migrate()` inherits it through `syncDoctype`. Because the refinement is structural
only, the existing install-path defs all pass: the integration `GadgetDef`
(`Table lines → 'GadgetLine'`, `Link customer → 'Customer'`) and the installer test
`sampleDef` (`Table items → 'WidgetItem'`, never installed) both have non-empty
`options` strings, so they validate — the schema never asks whether the target
exists (B1).

#### 1c. Env — `src/validation/env-schema.js`

Two **separate** schemas (B2) — PgAdmin does not need the Supabase keys, and the
existing tests pin each error message:

- `EnvSchema` = `{ SUPABASE_URL: z.string().url(), SUPABASE_SERVICE_ROLE_KEY:
  z.string().min(1) }`. `loadEnv(env = process.env)` parses and returns the typed
  pair, throwing one clear error on misconfig. `SupabaseStore.fromEnv` calls
  `loadEnv()` and reads the parsed result instead of touching `process.env` directly.
  **`DATABASE_URL` is NOT in `EnvSchema`** (B2).
- `PgAdminEnvSchema` = `{ DATABASE_URL: z.string().min(1) }`, with its own
  `loadPgAdminEnv(env = process.env)`. `PgAdmin.fromEnv` keeps a **PgAdmin-specific**
  required check for `DATABASE_URL` — it does **not** route through `loadEnv`
  (which would demand the two Supabase keys PgAdmin doesn't need, and would throw a
  non-`/DATABASE_URL/` message first). The thrown message **must still match
  `/DATABASE_URL/`** so `pg-admin.test.js:21-27` (deletes `DATABASE_URL`, asserts a
  `/DATABASE_URL/` throw) stays green. (Equivalently, PgAdmin may keep its current
  inline `if (!url) throw new Error('PgAdmin: set DATABASE_URL …')` — the Zod schema
  is optional sugar there; what matters is the message and that it doesn't pull in
  the Supabase keys.)

Env failures are operator/startup errors, **not** request `400`s — `loadEnv` /
`loadPgAdminEnv` throw a plain `Error`, **not** `ValidationError`, so a misconfigured
deployment never masquerades as client input. This is the one place Zod failures do
**not** route through the request bridge. Both calls stay **lazy / cold-start**
(inside the existing static `fromEnv()` methods, `supabase-store.js:23` /
`pg-admin.js:24`) — **not import-time** — so MemoryStore-only tests that never call
`fromEnv` are unaffected.

#### 1d. The single bridge — `src/validation/zod-bridge.js`

```
parseOrThrow(schema, value, label) -> T
  const r = schema.safeParse(value)
  if (!r.success) throw new ValidationError(`${label}: ${flatten(r.error)}`)
  return r.data
```

`flatten` renders Zod's issue list into one readable message
(`field "x": expected …`). **One** module owns the `ZodError → ValidationError`
translation (DRY); every request/def boundary calls `parseOrThrow`. Because
`ValidationError` already maps to `400` (`errors.js` / `handler.statusFor`), no
handler change beyond the call sites above. (Env does **not** use this bridge — §1c.)

### 2. Module layout (to-be) — Pass A

```
src/validation/                NEW package
  request-schemas.js   NEW  CreatePayloadSchema / UpdatePatchSchema (record + reserved-key
                            refinement, NO .strict()) / ActionBodySchema (.passthrough()) /
                            ListQuerySchema (coercions + f_* passthrough)
  def-schema.js        NEW  DocTypeDefSchema / DocFieldDefSchema (Link|Table => options string,
                            STRUCTURAL only) / DocPermDefSchema (.passthrough()) ;
                            assertValidDef(def) ; fieldtype enum = Object.keys(PG_TYPE_MAP)+['Table']
  env-schema.js        NEW  EnvSchema (SUPABASE_URL + SERVICE_ROLE_KEY) + loadEnv() ;
                            PgAdminEnvSchema (DATABASE_URL) + loadPgAdminEnv() ; throw plain Error
  zod-bridge.js        NEW  parseOrThrow(schema, value, label) : ZodError -> ValidationError
src/api/
  handler.js           MOD  parseOrThrow(<envelope schema>, body|query) after ensure(), before dispatch
src/meta/
  installer.js         MOD  assertValidDef(def) as FIRST line of syncDoctype()
  ddl.js               —    unchanged (PG_TYPE_MAP is imported by def-schema as the enum source)
src/runtime/
  supabase-store.js    MOD  fromEnv() reads loadEnv() result (Supabase keys only)
  pg-admin.js          MOD  fromEnv() reads loadPgAdminEnv() (DATABASE_URL only; /DATABASE_URL/ msg kept)
  errors.js            —    unchanged (ValidationError -> 400 already)
  validate.js          —    UNCHANGED in Pass A (depends_on deferred — §3)
```

### 3. Deferred: `depends_on` / `mandatory_depends_on` (NOT in Pass A)

**Lead ruling (B3 / open-Q-b):** the conditional-relevance chain is **deferred to its
own mini-pass**. It is not half-built in Pass A. The reason is round-trip integrity:
the feature only works if **all** of these ship **together** —

1. a `tabDocField` **ALTER migration** adding `depends_on` / `mandatory_depends_on`
   columns (without it, the loader/installer read/write columns that don't exist →
   PostgREST "column not found");
2. **boot-meta** declaring those two columns on the `DocField` meta entry
   (`boot-meta.js:60-74`), fieldtype `Code` (so the meta layer can *see* them);
3. **installer** `syncDoctype` writing them on each field row (camel→snake:
   `depends_on: f.dependsOn ?? null`, `mandatory_depends_on: f.mandatoryDependsOn ?? null`,
   mirroring `fetch_from`);
4. **loader** `load` reading them back (`dependsOn: f.depends_on`,
   `mandatoryDependsOn: f.mandatory_depends_on`);
5. **validator** `validateAgainstMeta` evaluating them (the relevance gate + effective-
   required).

Shipping a subset (e.g. loader reads + installer doesn't write + no column) is
internally inconsistent and dead — which is exactly what critique B3 flagged. So the
whole chain moves out.

**Parked design (reuse intact in the mini-pass) — the SAFE, no-eval model:**

> **SECURITY:** Frappe's `depends_on` / `mandatory_depends_on` / `read_only_depends_on`
> are `fieldtype: "Code"` (verified live 2026-06-20 from
> `frappe/core/doctype/docfield/docfield.json` — labels "… (JS)"), evaluated
> server-side via `frappe.safe_eval` (restricted-globals eval — see
> `frappe/model/base_document.py` `_evaluate_virtual_field_options`). **We do NOT
> eval strings (RCE surface).** The condition is **structured DATA** evaluated by a
> **closed operator table.**

```
Condition :=
    { field: string, op: Op, value?: JSONScalar | JSONScalar[] }   // leaf
  | { all: Condition[] }                                            // AND  ({all:[]} -> true)
  | { any: Condition[] }                                            // OR   ({any:[]} -> false)
  | { not: Condition }                                              // NOT
Op := 'eq'|'neq'|'in'|'nin'|'gt'|'gte'|'lt'|'lte'|'truthy'|'falsy'|'set'|'notset'
```

Evaluator (`depends-on.js`, pure fns): `evalCondition(cond, doc)` /
`isRelevant(cond, doc)` (undefined cond ⇒ `true`). Reads **only** `doc[cond.field]` —
no property paths, no calls, no globals. **Edge cases pinned by critique M3 (carry
into the mini-pass):**
- empty groups vacuous: `{all:[]}` ⇒ `true`, `{any:[]}` ⇒ `false`;
- `in`/`nin` with a non-array `value` ⇒ **throw** (authoring bug, fail-fast);
- **`eq`/`neq` coercion must mirror `validate.js:31` Check handling** (a `Check`
  stored `0/1` vs a condition `value:true`) — normalise the same way so
  `op:'truthy'` and `op:'eq' value:true` agree;
- defensive recursion **depth cap (e.g. 32)** ⇒ fail loud, not stack overflow;
- unknown `op` ⇒ **throw**.

Validator integration (M4 — verified correct, keep as drafted): relevance `continue`
**before** the required-check, so a `depends_on`-false field is skipped regardless of
`reqd` (matches Frappe: hidden ⇒ not validated); `required = f.reqd ||
(f.mandatoryDependsOn && isRelevant(f.mandatoryDependsOn, doc))`; `if (empty)
continue;` stays **after** the required-check.

**`read_only_depends_on`** stays YAGNI-deferred (critique agreed): server-side
validate doesn't gate writes on UI read-only — that's `permlevel` territory, already
modelled.

## Options considered

1. **No Zod; keep ad-hoc checks** — rejected: malformed defs/bodies stay cryptic; the
   generator (Pass D) has no firm contract to fail against.
2. **Zod everywhere, including per-doctype field rules** — rejected: violates the
   locked principle and creates a second, code-bound source of field truth that
   drifts from `tabDocField`.
3. **`assertValidDef` checks cross-doctype target existence** — rejected (B1):
   un-implementable on a single def (no store/registry) and would reject every real
   def; existence is the loader's N1 job.
4. **Route `PgAdmin.fromEnv` through the shared `loadEnv`** — rejected (B2): pulls in
   the two Supabase keys PgAdmin doesn't need and breaks the `/DATABASE_URL/`
   message contract.
5. **Half-build `depends_on` in Pass A (loader read only)** — rejected (B3): dead /
   inconsistent without the migration + boot-meta + installer write; deferred whole.
6. **Zod at the three fixed boundaries, structural-only def schema, separate env
   schemas, depends_on deferred** — **chosen.**

## Design-contract compliance

- **DRY:** one `zod-bridge.parseOrThrow` owns `ZodError→ValidationError`; the def
  fieldtype enum is derived from the single `ddl.js` `PG_TYPE_MAP` (no drift, M1).
- **KISS / YAGNI:** envelope-only request schemas; structural-only def schema; the
  conditional-relevance chain deferred until it can ship whole; `read_only_depends_on`
  deferred.
- **SOLID / SoC:** Zod schemas (const data) vs `parseOrThrow` (pure fn) vs
  `assertValidDef` (installer hook) vs env loaders are distinct; request-envelope
  validation is cleanly separated from meta-driven field validation.
- **Least Privilege:** the reserved-key reject blocks client override of
  `owner/docstatus/name`; env failures throw plain `Error`, never a client `400`.
- **Idempotency:** schemas/validators are pure — same input, same verdict, no state.
- **Fail-Fast:** malformed request → `400` before the service; malformed def →
  located `ValidationError` before any DDL/row write; bad env → clear `/DATABASE_URL/`
  or Supabase-key throw at cold start.

## Consequences

- Every request pays one cheap `safeParse` of its envelope (microseconds). Reserved-key
  smuggling on create/patch is rejected at the door.
- A doctype def is validated **structurally** once at install, not discovered broken
  via a Postgres error — Pass D's generator gets a hard *shape* contract (target
  existence remains the loader's runtime guarantee, N1).
- `PgAdmin.fromEnv` and `SupabaseStore.fromEnv` keep their distinct env contracts;
  `pg-admin.test.js` / store tests stay green.
- `validate.js` is **untouched** in Pass A; the no-eval AST design is preserved in §3
  for the deferred mini-pass.

## Frappe citations

- `frappe/core/doctype/docfield/docfield.json` — `depends_on`,
  `mandatory_depends_on`, `read_only_depends_on` all `fieldtype: "Code"` (labels
  "… (JS)"). Verified live 2026-06-20. (Relevant only to the deferred §3.)
- `frappe/model/base_document.py` — `_validate_mandatory()` iterates effective
  `reqd == 1` fields; `_evaluate_virtual_field_options` shows the server-side
  `frappe.safe_eval(code=…, eval_globals=get_safe_globals(), eval_locals={"doc": self})`
  mechanism we **replace with a structured AST** (no eval) in the deferred §3.
