# Work Order: Desk Bridge — read-only `/api/boot` + `/api/meta/<doctype>`

- **Status:** GO (composition check passed) — release to BUILD PHASE
- **Planner:** planner
- **Date:** 2026-06-21
- **Source design:** `docs/adr-desk-bridge.md` (frozen) + `docs/critique-desk-bridge.md` (PASS, 2 passes)
- **Repo:** `spartan-erp-engine`
- **Run mode:** `npx vitest run` (never watch). Live proof: `node --env-file=.env scripts/prove-bridge.mjs`.

---

## 0. Planner findings beyond the ADR (READ — these change the unit boundaries)

Two reuse facts the design assumed but did NOT spell out, both verified against code:

1. **`getWorkflow` is NOT exported today.** `src/workflow/workflow.js` exports only
   `_resetWorkflowCache`, `transition`, `availableActions` (Grep `^export` → lines 117/133/178).
   `getWorkflow` is a private `async function getWorkflow(doctype, store)` at `:111`. `buildMeta`
   calls it (ADR §2 step 6), so the build MUST add `export` to it. This is **additive** (a new
   export of an existing pure-read function) — no behaviour change. It joins **Unit 1** (the
   reuse-enabling edits) so it lands before the service that consumes it.

2. **Route folder shape is confirmed.** `/api/boot` → `api/boot.js` (no dynamic segment).
   `/api/meta/<doctype>` → `api/meta/[doctype].js` (Vercel dynamic segment read as
   `req.query.doctype`, decoded with `decodeURIComponent`, exactly like
   `api/[doctype]/index.js:15`). Both mirror the existing route file verbatim (lazy
   `SupabaseStore.fromEnv()` singleton, `ctxFromRequest`, outer `catch` → `AuthError`=401 / else
   500). The service decides 403/404/200, the route maps `AuthError`→401.

Everything else in the ADR is accurate (istable column exists, no migration; `visibleFields`,
`can`, `ensure`, `getMeta`, `store.list` all present with the signatures the design names).

---

## 1. Unit map + file-collision analysis (every file → exactly ONE unit)

| Unit | Files (EXISTING = edit, NEW = create) | Kind | Depends on |
|---|---|---|---|
| **U1 — reuse-enabling plumb** | `src/meta/loader.js` (EDIT), `src/meta/meta.js` (EDIT), `src/meta/registry.js` (EDIT — DocMeta typedef only), `src/workflow/workflow.js` (EDIT — add `export`) | additive read-path | — |
| **U2 — projection service** | `src/api/desk-bridge.js` (NEW) | new logic | U1 |
| **U3 — boot route** | `api/boot.js` (NEW) | new route | U2 |
| **U4 — meta route** | `api/meta/[doctype].js` (NEW) | new route | U2 |
| **U5 — live proof** | `scripts/prove-bridge.mjs` (NEW) | live verify | U1, U2 |

**No file appears in two units.** U1 owns ALL edits to existing files (the istable plumb +
the `getWorkflow` export); U2–U5 are net-new files. There are no shared-file write collisions, so
the only sequencing constraint is the dependency edges, not file contention.

### Dependency order / parallel groups

```
U1 (plumb + export)              ← MUST land first (U2 reads m.istable; calls getWorkflow)
   │
   └─► U2 (desk-bridge.js)       ← MUST land before U3/U4/U5 (they import buildBoot/buildMeta)
          ├─► U3 (api/boot.js)        ┐
          ├─► U4 (api/meta/[doctype].js) ├─ PARALLEL-SAFE with each other (3 separate new files,
          └─► U5 (scripts/prove-bridge.mjs) ┘  no shared file, all import U2 read-only)
```

- **Serialize:** U1 → U2. (U2's boot filter dereferences `m.istable`; U2's `buildMeta` imports
  `getWorkflow`. Building U2 before U1 lands = `m.istable` undefined / import miss.)
- **Parallel-safe:** U3, U4, U5 may be built by three `implement` specialists simultaneously once
  U2 is merged — they touch disjoint files and only consume U2's frozen interface.
- **Fan-out verdict:** 5 units, the build phase legitimately fans out (U3/U4/U5 parallel) — the
  full work order earns its keep. U1+U2 are the serialized spine.

---

## 2. FROZEN interface contracts

Specialists MUST NOT diverge from these signatures or return shapes.

### U1 — `src/meta/meta.js` : `istable` getter (verbatim mirror of `isStub`)

```js
// in constructor, after this._isStub (meta.js:19):
this._istable = Boolean(def.istable ?? false);

// in getters, after get isStub() (meta.js:32):
get istable() { return this._istable; }
```

### U1 — `src/meta/loader.js` : read `istable` (verbatim mirror of `isStub`, loader.js:136/142)

```js
// after  const isStub = !!(row.is_stub);  (loader.js:136):
const istable = !!(row.istable);

// in the new Meta({...}) call (loader.js:142) — add istable to the arg object:
const meta = new Meta({ doctype, table, submittable, issingle, isStub, istable, autoname, fields, childTables, scopeFields, permissions });
```

### U1 — `src/meta/registry.js` : DocMeta typedef (doc-only; add the line)

```js
// in the @typedef DocMeta block (registry.js:39-49), alongside @property {boolean} [isStub]:
 * @property {boolean} [istable]
```

### U1 — `src/workflow/workflow.js` : export the existing function (one word)

```js
// workflow.js:111 — change:
async function getWorkflow(doctype, store) { ... }
// to:
export async function getWorkflow(doctype, store) { ... }
```
Signature UNCHANGED: `getWorkflow(doctype, store) → Promise<WorkflowDef|null>`, where
`WorkflowDef = { doctype, stateField, initial, states: string[], transitions: WorkflowTransitionDef[] }`
and each transition is `{ from, to, action, roles?, guard?, condition?, onTransition? }`.
**The bridge must NOT serialize `condition`/`onTransition` (functions) — project transitions to
`{ from, to, action, roles }` only.**

### U2 — `src/api/desk-bridge.js` : the projection service (FROZEN)

```js
/**
 * @param {import('../perms/context.js').Ctx} ctx
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<{user:string, roles:string[], scopes:Record<string,any>,
 *                     doctypes:string[], server_date:string}>}
 */
export async function buildBoot(ctx, store) { ... }

/**
 * @param {import('../perms/context.js').Ctx} ctx
 * @param {string} doctype
 * @param {import('../runtime/store.js').Store} store
 * @returns {Promise<{
 *   doctype: string,
 *   capabilities: {read:boolean, write:boolean, create:boolean, delete:boolean, submit:boolean, cancel:boolean},
 *   meta: { doctype, autoname, submittable, issingle, istable, isStub,
 *           fields: FieldDef[], childTables: ChildTableDef[], scopeFields: string[] },
 *   child_metas: Record<string, projectedMeta>,
 *   workflow: { stateField, states:string[], transitions:Array<{from,to,action,roles}> } | null
 * }>}
 * @throws PermissionError (→403) if !can(read); NotFoundError (→404) if unknown doctype
 */
export async function buildMeta(ctx, doctype, store) { ... }
```

**`buildBoot` algorithm (FROZEN):**
1. `server_date = new Date().toISOString().slice(0,10)`.
2. GUEST / no-read everywhere falls out naturally — do NOT special-case GUEST; the filter yields `[]`.
3. `rows = await store.list('tabDocType', { filters: { is_stub: false } })` → candidate names = `rows.map(r => r.name)`.
4. Union with `allDoctypes()` (pinned/warm names), de-duped — the union runs through the SAME filter (step 6).
5. `doctypes = []`. For EACH candidate name, in its OWN `try { ... } catch (e) { console.warn(...); continue; }`:
   `await ensure(name, store)`; `const m = getMeta(name)`; keep iff `!m.istable && !m.isStub && can(ctx, name, 'read')` → push `name`.
6. Return `{ user: ctx.user, roles: ctx.roles, scopes: ctx.scopes ?? {}, doctypes, server_date }`.
   - **A thrown `ensure`/`getMeta` for ONE candidate MUST be swallowed per-candidate (omit + log) — never propagate, never 500.**

**`buildMeta` algorithm (FROZEN), in order:**
1. `await ensure(doctype, store)` — unknown doctype throws `NotFoundError` → 404 (BEFORE the read gate; no partial leak).
2. `if (!can(ctx, doctype, 'read')) throw new PermissionError(...)` → 403.
3. `const m = getMeta(doctype)`.
4. `capabilities` = `{ read, write, create, delete, submit, cancel }` each = `can(ctx, doctype, <op>)`.
5. `meta` = `projectMeta(ctx, doctype)` (internal helper, below).
6. `child_metas` = `{}`; for EACH `c of m.childTables`: `child_metas[c.doctype] = projectMeta(ctx, c.doctype)`.
   **Iterate `m.childTables` ONLY — never walk `m.fields` Link targets, never walk the ensure() closure.**
   (Children are already primed by `ensure`; no per-child `can` gate — inherit-parent-read.)
7. `const wf = await getWorkflow(doctype, store)`; `workflow` = `wf ? { stateField: wf.stateField, states: wf.states, transitions: wf.transitions.map(t => ({from:t.from, to:t.to, action:t.action, roles:t.roles})) } : null`.
8. Return `{ doctype, capabilities, meta, child_metas, workflow }`.

**`projectMeta(ctx, dt)` internal helper (FROZEN shape):**
- `const allowed = new Set(visibleFields(ctx, dt))`; `const m = getMeta(dt)`.
- `fields = m.fields.filter(f => allowed.has(f.fieldname))` — a field above the ctx's read permlevel is DROPPED.
- Return `{ doctype: m.doctype, autoname: m.autoname, submittable: m.submittable, issingle: m.issingle, istable: m.istable, isStub: m.isStub, fields, childTables: m.childTables, scopeFields: m.scopeFields }`.
- **NEVER include `m.permissions` / `getDocPerms()` — raw DocPerm rows never leave the engine.**

### U3 — `api/boot.js` (FROZEN — mirror `api/[doctype]/index.js`)

```js
import '../src/bootstrap.js';
import { buildBoot } from '../src/api/desk-bridge.js';
import { SupabaseStore } from '../src/runtime/supabase-store.js';
import { ctxFromRequest } from '../src/api/context-from-request.js';
import { AuthError } from '../src/runtime/errors.js';

let _store; function store() { if (!_store) _store = SupabaseStore.fromEnv(); return _store; }

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only', type: 'MethodNotAllowed' });
    const ctx = await ctxFromRequest(req, store());
    const body = await buildBoot(ctx, store());
    res.status(200).json(body);
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: err.message, type: 'AuthError' });
    res.status(500).json({ error: err.message, type: 'ServerError' });
  }
}
```
**Import depth note:** `api/boot.js` is ONE level under `api/` (like a flat route), so imports are
`../src/...` (one `../`), NOT `../../src/...`. Verify against the actual file location.

### U4 — `api/meta/[doctype].js` (FROZEN — mirror `api/[doctype]/[name].js`)

```js
import '../../src/bootstrap.js';
import { buildMeta } from '../../src/api/desk-bridge.js';
import { SupabaseStore } from '../../src/runtime/supabase-store.js';
import { ctxFromRequest } from '../../src/api/context-from-request.js';
import { AuthError, NotFoundError, PermissionError } from '../../src/runtime/errors.js';

let _store; function store() { if (!_store) _store = SupabaseStore.fromEnv(); return _store; }

function statusFor(err) {
  if (err instanceof AuthError) return 401;       // belt-and-braces; outer-catch also handles
  if (err instanceof PermissionError) return 403;
  if (err instanceof NotFoundError) return 404;
  return 500;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only', type: 'MethodNotAllowed' });
    const doctype = decodeURIComponent(req.query.doctype);
    const ctx = await ctxFromRequest(req, store());        // AuthError lands in outer catch → 401
    try {
      const body = await buildMeta(ctx, doctype, store()); // 403/404 from here
      res.status(200).json(body);
    } catch (err) {
      res.status(statusFor(err)).json({ error: err.message, type: err.name });
    }
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: err.message, type: 'AuthError' });
    res.status(500).json({ error: err.message, type: 'ServerError' });
  }
}
```
**Why the nested try:** `ctxFromRequest` throws `AuthError` OUTSIDE the service → must hit the
outer catch → 401 (the Pass-C lesson; do NOT let an invalid bearer collapse into a 200 empty boot
or a generic 500). `buildMeta`'s `PermissionError`/`NotFoundError` map via `statusFor` in the
inner catch. `api/[doctype]/*` does this by delegating to `handle()`'s `statusFor`; here the
service throws directly, so the route owns the inner `statusFor`. **The dynamic segment is named
`doctype`** — the file is `[doctype].js`, so `req.query.doctype` is correct.

---

## 3. Per-unit vitest specs + done-criteria (the 9 critique checks; 3 leak gates EXPLICIT)

> Each test file resets module state in `beforeEach`: `_resetRegistry()` (registry.js),
> `_resetWorkflowCache()` (workflow.js), and seeds via `MemoryStore` (mirror the existing
> `loader.test.js` setup). No live DB in unit tests.

### U1 — `src/meta/loader.test.js` (extend) — **Check 1: istable plumb round-trip**

- **Spec:** seed a `tabDocType` row with `istable: true`; `await ensure(dt, store)`;
  assert `getMeta(dt).istable === true`. Seed a second with `istable: false` → `=== false`.
  Seed a third with the column ABSENT → `=== false` (real boolean, not `undefined`).
- Mirror the existing `is_stub round-trip` test (the `U-MARKER` test in `loader.test.js`).
- **Done:** all three assertions green; `getMeta(dt).istable` is `typeof === 'boolean'`.

### U1 — `src/workflow/workflow.test.js` (extend, or a 1-liner import test) — export check

- **Spec:** `import { getWorkflow } from '../workflow/workflow.js'` resolves (not `undefined`);
  for a seeded Workflow, `getWorkflow(dt, store)` returns the `{stateField, states, transitions}`
  graph; for a doctype with no Workflow row returns `null`.
- **Done:** import is defined; both branches assert correctly.

### U2 — `src/api/desk-bridge.test.js` (NEW) — Checks 2,3,4,5,6,9 + masking

Seed (MemoryStore): a top-level readable doctype `Quotation` (with a `Table` field → child
`Quotation Item`, and a permlevel-1 field e.g. `margin`), a child `Quotation Item` (`istable:true`),
a `is_stub:true` row, a no-read-for-this-ctx doctype `Secret`, and a doctype `Quotation` Workflow.

- **Check 2 (LEAK GATE — boot exclusions):** `buildBoot(ctx)` `doctypes` INCLUDES `Quotation`;
  EXCLUDES `Quotation Item` (istable), the `is_stub:true` row, and `Secret` (no read). Assert each
  exclusion individually (not just length).
- **Check 3 (LEAK GATE — per-doctype omit-on-throw):** seed a candidate whose `ensure()` throws
  (e.g. a `tabDocType` row referencing a missing Table target so `load` throws); assert
  `buildBoot(ctx)` STILL returns the other readable doctypes, the bad one is absent, and it does
  NOT reject (resolves, no throw). Spy on `console.warn` to assert it was logged.
- **Check 4 (field masking):** `buildMeta(permlevel0Ctx, 'Quotation')` → `meta.fields` has NO
  field named `margin` (permlevel 1); `buildMeta(permlevel1Ctx, 'Quotation')` → `margin` PRESENT.
- **Check 5 (403 / 404):** `buildMeta(ctx, 'Secret')` rejects with `PermissionError`;
  `buildMeta(ctx, 'NoSuchDoctype')` rejects with `NotFoundError` (assert the unknown-doctype
  throw comes from `ensure`, i.e. before any read-gate leak).
- **Check 6 (LEAK GATE — child inline masked, Link NOT inlined):** `buildMeta(ctx, 'Quotation')`
  → `child_metas['Quotation Item']` present and its `fields` are `visibleFields`-masked; assert the
  Link target `Customer` (a `Link` field on Quotation, NOT a `Table`) is NOT a key in `child_metas`.
- **Check 9 (full workflow graph):** `buildMeta(ctx, 'Quotation')` → `workflow.states` has all
  seeded states; `workflow.transitions` has every transition each carrying `roles[]`; assert NO
  `condition`/`onTransition` keys leak into the projected transitions.
- **Capabilities + no-DocPerm:** `capabilities` is the 6-key boolean object; assert
  `meta.permissions === undefined` and no `getDocPerms` output anywhere in the payload.
- **Done:** all of the above green; the three leak-gate assertions are standalone `it(...)` blocks.

### U3 — `api/boot.test.js` (NEW) — **Check 7 (GUEST empty boot) + Check 8 (AuthError→401)**

Invoke the route handler with a mock `req/res` (the existing route-test pattern — fake `res` with
`status`/`json` spies). Stub `ctxFromRequest` per case (or drive via headers + GUEST).

- **Check 7 (GUEST empty boot):** no bearer, dev-auth off → `ctxFromRequest` returns GUEST →
  `res.status(200)` with `{ user:'guest', roles:[], scopes:{}, doctypes:[], server_date:<YYYY-MM-DD> }`.
- **Check 8 (LEAK GATE — AuthError→401):** make `ctxFromRequest` throw `AuthError`
  (present-but-invalid bearer) → `res.status(401)`, body `{type:'AuthError'}`. **MUST NOT** become a
  200 empty boot or a 500. Standalone `it(...)`.
- **Method gate:** non-GET → 405.
- **Done:** 200-guest, 401-autherror, 405-non-GET all asserted.

### U4 — `api/meta/[doctype].test.js` (NEW) — route mapping

- 200 happy path (mock `buildMeta` resolves) → `res.status(200)` with the body.
- `buildMeta` throws `PermissionError` → 403; `NotFoundError` → 404 (inner statusFor).
- `ctxFromRequest` throws `AuthError` → 401 (outer catch — NOT swallowed).
- non-GET → 405. `decodeURIComponent` applied to `req.query.doctype` (test a space-containing name
  e.g. `Sales%20Order`).
- **Done:** 200/403/404/401/405 + decode all asserted.

### U5 — `scripts/prove-bridge.mjs` (NEW) — LIVE proof (Check: masking + boot exclusions on the real DB)

Mirror `scripts/prove-quotation.mjs` (constructed admin ctx, `registerBootMeta()`,
`PgStore.fromEnv()`, `migrate(...)` to install a fixture doctype with a permlevel-1 field + a Table
child, `ensure`). Then, with `makeContext`:

- `const admin = makeContext({ user:'admin@spartan', roles:['admin'], unrestricted:true })`.
- `const restricted = makeContext({ user:'rep@spartan', roles:['sales'] })` where `sales` has
  permlevel-0 read only (so a permlevel-1 field is masked) and NO read on a chosen `Secret` doctype.
- **Proof A (admin full):** `buildMeta(admin, 'Job', store)` returns ALL Job fields (incl. the
  permlevel-1 field) → log `✓`.
- **Proof B (restricted masked):** `buildMeta(restricted, 'Job', store)` `meta.fields` OMITS the
  above-permlevel field → log `✓`.
- **Proof C (403 no-read):** `buildMeta(restricted, 'Secret', store)` throws `PermissionError` →
  catch + log `✓`.
- **Proof D (boot list):** `buildBoot(admin, store)` `doctypes` includes `Job`, `Customer`,
  `Quotation`; does NOT include `DocField`, `Quotation Item` (istable child), or any `is_stub` row.
- **Run:** `node --env-file=.env scripts/prove-bridge.mjs`; `process.exit(pass?0:1)`.
- **Done:** all four proofs `✓` against the engine's isolated Supabase. The deployed-HTTP curl
  smoke with a real Google idToken is an **OPTIONAL human follow-up — NOT auto-run** by `implement`.

> Note: if `Job`/`Secret` fixtures aren't already installed in the engine DB, U5 installs them via
> `migrate(...)` first (like prove-quotation installs Quotation). Pick whatever top-level doctype
> with a permlevel-1 field is convenient; `Job` per the lead's brief if it exists, else install one.

---

## 4. Critique 9-check → unit coverage matrix

| # | Critique check | Covered by |
|---|---|---|
| 1 | istable plumb round-trip | U1 loader.test |
| 2 | **LEAK** boot excludes istable/stub/no-read | U2 Check 2 + U5 Proof D |
| 3 | **LEAK** boot per-doctype omit-on-throw (200, not 500) | U2 Check 3 |
| 4 | /api/meta field masking at permlevel | U2 Check 4 + U5 Proof A/B |
| 5 | 403-on-no-read; unknown→404 | U2 Check 5 + U4 + U5 Proof C |
| 6 | **LEAK** child inline masked; Link NOT inlined | U2 Check 6 |
| 7 | GUEST empty boot (200) | U3 Check 7 |
| 8 | **LEAK** AuthError→401 NOT swallowed | U3 Check 8 + U4 |
| 9 | full workflow graph (+roles) | U2 Check 9 |

All three leak-class gates (2, 6, 8) are standalone `it(...)` assertions, not folded into a
happy-path test, per the critique's note.

---

## 5. Composition go/no-go

- **Interfaces line up:** `buildBoot`/`buildMeta` consume only `ctxFromRequest` output + named
  primitives (`ensure`, `getMeta`, `can`, `visibleFields`, `getWorkflow`, `store.list`,
  `allDoctypes`). All exist with the assumed signatures; `getWorkflow` becomes exported in U1.
- **No cycles:** U1 (meta/workflow) → U2 (bridge) → U3/U4/U5. The bridge is downstream of
  perms/meta/workflow and upstream of nothing in the CRUD path; cannot affect authority.
- **Contract-compliant:** READ-ONLY (no mutate); no raw DocPerm projected; permlevel masking
  reused not reimplemented; istable plumb mirrors isStub verbatim (DRY); fail-closed
  (404/403/401, GUEST→200 empty, per-doctype omit-on-throw).
- **No file collisions:** every file maps to exactly one unit; all edits to existing files are in U1.

**VERDICT: GO.** Release U1 first (serial), then U2 (serial), then fan out U3 + U4 + U5 in parallel.

---

## 6. Build-phase dispatch (for the LEAD)

1. Spawn ONE `implement` for **U1** — land + green `loader.test`/`workflow.test`.
2. Then ONE `implement` for **U2** — land `desk-bridge.js` + green `desk-bridge.test`.
3. Then fan out THREE `implement` in parallel — **U3**, **U4**, **U5**.
4. LEAD runs integration + the full `npx vitest run` suite, then runs
   `node --env-file=.env scripts/prove-bridge.mjs` (the live masking proof) itself.
5. `implement` finalizes the BugWiki page + flips registry/PUML per CLAUDE.md §9 (the bridge is a
   feature, not a registry bug — record a BugWiki solution page if the lead wants one; no S/A/I
   row unless a defect surfaces).
