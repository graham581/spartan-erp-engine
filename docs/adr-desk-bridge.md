# ADR: Desk Bridge — read-only metadata + boot projection

- **Status:** Revised after critique FAIL (C-1/C-2/C-3 addressed) — for re-critique
- **Date:** 2026-06-21
- **Component:** `spartan-erp-engine`
- **Diagram:** `diagrams/desk-bridge-class.puml`

## Problem

A generic, metadata-driven **Desk** client (separate client, same Vercel
instance, single origin) must render its own forms, lists, and workflow-action
buttons from data it *fetches* — it never imports engine internals; it talks to
the engine only over HTTP. The engine today exposes authoritative CRUD at
`/api/[doctype]` but has **no read endpoint that publishes the permission-masked
metadata** a generic client needs to render itself. This is the engine's analog
of Frappe's `get_bootinfo` (`frappe/boot.py`) and `getdoctype` /
`get_meta_bundle` (`frappe/desk/form/load.py` + `frappe/desk/form/meta.py`,
verified on `develop` 2026-06-21).

## Decision

Add **two read-only HTTP endpoints** and **one thin projection service**, all
composing *existing* primitives. No new write or trust surface.

### Route layout (mirrors existing `api/[doctype]` Vercel pattern)

| Route | File | Frappe analog |
|---|---|---|
| `GET /api/boot` | `api/boot.js` | `get_bootinfo` |
| `GET /api/meta/<doctype>` | `api/meta/[doctype].js` | `getdoctype` / `get_meta_bundle` |

Both route files mirror `api/[doctype]/index.js`/`[name].js` exactly: lazy
`store()` singleton, `ctx = await ctxFromRequest(req, store())`, delegate to the
service, `res.status(status).json(body)`, and the **same outer `catch`** that
maps `AuthError -> 401` (because `ctxFromRequest` runs *outside* the service, so
its `AuthError` lands in the route, per the existing §0.3 pattern).

The only new *projection* logic lives in `src/api/desk-bridge.js`:
`buildBoot(ctx, store)` and `buildMeta(ctx, doctype, store)`.

### Build scope — `istable` read-path plumb (C-1, part of this work)

The bridge must read `meta.istable` to exclude child/table doctypes from the
boot list. **`istable` is written but not read today**, so the boot `!istable`
filter would silently be a no-op and child/meta doctypes (`DocField`, `DocPerm`,
`Sales Order Item`, …) would leak into boot `doctypes[]`. Verified:

- The `istable` **column exists** on `tabDocType`
  (`supabase/migrations/20260620010000_meta_core.sql:31` — `boolean not null
  default false`) and `installer.syncDoctype` **writes** it (`installer.js:116`).
  **No migration is needed.**
- But `loader.js` (`load()`, ~:142) builds `Meta` **without** reading
  `row.istable`, and `meta.js` has **no `istable` getter** — so today
  `meta.istable === undefined` and `!meta.istable` is true for every row.

This build therefore includes two tiny read-path edits, mirroring the existing
`issingle`/`isStub` pattern **exactly** (DRY — the pattern is right there in the
same lines):

1. `loader.js`: add `const istable = !!(row.istable);` and pass it into
   `new Meta({ doctype, table, submittable, issingle, isStub, istable, autoname,
   fields, childTables, scopeFields, permissions })`.
2. `meta.js`: add `this._istable = Boolean(def.istable ?? false);` in the
   constructor and `get istable() { return this._istable; }`.

These are the only edits outside the two routes + the bridge service.

### 1. `GET /api/boot` — the lean boot object

```jsonc
{
  "user":    "laura@…",            // ctx.user
  "roles":   ["sales"],            // ctx.roles
  "scopes":  { "branch": "VIC" },  // ctx.scopes (row-scope values)
  "doctypes": ["Customer", "Sales Order", …],   // permitted (read) only
  "server_date": "2026-06-21"      // Frappe bootinfo.server_date parity
}
```

- **LEAN** — identity + roles + scopes + the **names** of permitted doctypes.
  NOT every doctype's full meta (that is lazy-fetched per-doctype via endpoint
  2). Matches Frappe's `get_bootinfo` shape (user + sysdefaults + module list,
  not bundled metas).
- **`doctypes` lists only what the ctx can read** — `permittedDoctypes(ctx,
  store)` enumerates the known doctype universe and keeps `dt` iff
  `!meta.istable && can(ctx, dt, 'read')`. **Never list a doctype the user
  cannot read** (it would leak the existence of the doctype), and **never list a
  child/table doctype** (Desk doesn't navigate to `DocField`/`Sales Order Item`).
- **GUEST** gets a lean *empty* boot (`{ user:'guest', roles:[], scopes:{},
  doctypes:[], server_date }`) with **status 200** — never a 500. `ctxFromRequest`
  returns `GUEST` for an unauthenticated request (no bearer, dev-auth off); the
  empty boot falls out naturally because `can(GUEST, …, 'read')` is false for
  every doctype.

### 2. `GET /api/meta/<doctype>` — permission-masked meta bundle

```jsonc
{
  "doctype": "Sales Order",
  "capabilities": {                 // COSMETIC — drives show/hide of buttons
    "read": true, "write": true, "create": true,
    "delete": false, "submit": true, "cancel": false
  },
  "meta": {                         // the masked parent meta
    "doctype": "Sales Order",
    "autoname": "SO-.#####",
    "submittable": true,
    "issingle": false,
    "istable": false,
    "isStub": false,
    "fields": [ /* permlevel-masked field defs */ ],
    "childTables": [ { "field": "items", "doctype": "Sales Order Item", … } ],
    "scopeFields": ["branch"]
  },
  "child_metas": {                  // INLINE — one round-trip (Frappe bundle)
    "Sales Order Item": { /* masked meta of the child */ }
  },
  "workflow": {                     // full graph (or null)
    "stateField": "workflow_state",
    "states": ["Draft","Submitted","Cancelled"],
    "transitions": [ { "from":"Draft","to":"Submitted","action":"Submit","roles":["sales"] }, … ]
  }
}
```

Behaviour, in order:

1. `await ensure(doctype, store)` — prime the meta + its Link/Table closure
   (required: `getMeta` is sync, cache-only, throws on a miss). An unknown
   doctype throws `NotFoundError` -> **404**.
2. **`if (!can(ctx, doctype, 'read')) throw PermissionError` -> 403.** You cannot
   fetch the meta of a doctype you cannot read. Mirrors `getDoc`'s gate
   (`service.js` `assertCan(ctx, doctype, 'read')`).
3. **Fields masked to the user's permlevel** by reusing `visibleFields(ctx,
   doctype)` (the same primitive `maskRead` uses): keep only fields whose
   `fieldname` is in `visibleFields`. A field above the user's read permlevel is
   **never returned** — same guarantee documents get.
4. **Capability summary** from `can(ctx, dt, op)` for each of
   read/write/create/delete/submit/cancel. This is **cosmetic** (lets Desk
   show/hide buttons); the engine re-checks authority on every real call to
   `/api/[doctype]`.
5. **Inline child metas** for every `meta.childTables` entry, each itself run
   through `projectMeta` (so a child's fields are masked too). See F3 for the
   "childTables only" rule.
6. **Workflow** via `getWorkflow(doctype, store)` (null if the doctype has none).

**Raw `DocPerm` rows are never projected** — they collapse into `capabilities`
(+ the masked field set). The engine's permission internals do not leave it.

## Options considered

### A. Bundle vs lazy child metas (transitive Table fields)

- **A1 (chosen): inline `child_metas` in one round-trip.** Frappe's
  `get_meta_bundle` does exactly this — `bundle = [get_meta(dt)] +
  [get_meta(df.options) for table-fields]`. The closure is *already* primed by
  `ensure()` (it primes the Link/Table closure), so projecting the children is
  free — no extra DB reads. One round-trip; the Desk form renders without a
  waterfall of fetches.
- A2 (rejected): return only `childTables` pointers and make Desk fetch each via
  `/api/meta/<child>`. More round-trips, a render waterfall, and diverges from
  Frappe. The only upside (smaller first payload) is marginal because the child
  metas are already in memory.
- **Recommendation: A1.** Inline the children, driven by `meta.childTables`
  only — see F3 for why that is also the security boundary.

### B. Workflow: full graph vs role-filtered transitions

- **B1 (recommended): return the FULL workflow** — all states and all
  transitions, each carrying its `roles[]`. This matches Frappe (which ships the
  Workflow doc and gates at render/action time) and lets Desk render the whole
  state graph and gray-out actions the user can't fire. The engine re-gates the
  transition on the real `POST … {action}` call (`transition()` enforces
  `t.roles`), so exposing the graph is not an authority leak — it is the same
  state-machine shape any user of that doctype shares.
- B2 (rejected for now): role-filter transitions to the user's roles
  (least-privilege). Hides the full graph but breaks Desk's ability to show "you
  could do X if you had role Y" and to render the complete diagram. **FORK F2** —
  flagged for the LEAD: if the workflow graph itself is considered sensitive
  (e.g. transition names leak business process to a low-priv user), switch to B2.
  Note `availableActions()` is **not** usable here — it needs a *loaded doc*
  (current state); meta has no doc, so the bridge returns the static graph.

> **LEAD ruling (this revision): F2 = full workflow graph (B1).**

## Forks (LEAD rulings folded in)

- **FORK F1 — how `permittedDoctypes` enumerates the universe.** `allDoctypes()`
  returns only the **warm cache** (boot-pinned + lazily-loaded this lambda), not
  every installed doctype. The authoritative universe is the `tabDocType` rows in
  the store. **LEAD ruling:** source = `store.list('tabDocType', { filters:{
  is_stub:false } })`, then for each candidate `dt` keep it iff **`!meta.istable
  && can(ctx, dt, 'read')`** (the `istable` read-path plumb above makes
  `meta.istable` real — without it the `!istable` test is a no-op). The
  in-code/pinned boot doctypes from `allDoctypes()` (`Customer`, the 6
  meta-doctypes) are **unioned in but run through the SAME
  `!istable && !isStub && can(read)` filter** — otherwise pinned meta-doctypes
  (`DocType`, `DocField`, …) re-pollute the list.

  **C-3 — fail-closed, skip-with-omit (this revision).** `ensure(dt)` can throw
  (NotFoundError / a malformed-row Error) for one bad doctype. The enumeration
  loop wraps **each** doctype's `ensure()` + filter in its own `try/catch`:
  on error it **omits that one doctype and logs it**, and continues. One bad row
  must never 500 the whole boot for a user who can read 40 others.

  Concern: iterating + `ensure()`-ing every candidate on each cold-lambda
  `/api/boot` is O(N doctypes) DB work. Mitigations to weigh (deferred — not
  built, YAGNI): (a) the `!istable`/`is_stub` filters already prune child + stub
  rows; (b) cache the permitted-doctype list per ctx for the warm-lambda TTL
  window; (c) a future `is_in_desk`/module flag. **The cost mitigation remains a
  fork**, but the *source* and *filter* are now ruled. This is the one place the
  design reaches past a named primitive (`store.list('tabDocType')`) — a plain,
  perm-filtered read, **not** a new trust path.

- **FORK F2 — full vs role-filtered workflow** (see Option B). **LEAD ruling:
  full graph.** Decide later only if the graph itself is deemed sensitive.

- **FORK F3 — inline child metas: the boundary is "childTables only".** **LEAD
  ruling: inherit-parent-read for `childTables`, with per-child field masking.**
  Rationale and the structural guarantee:
  - A child/table doctype (e.g. `Sales Order Item`) typically has **no
    independent DocPerm rows** — its visibility is governed by the parent's
    doc-level read (this is why `maskRead` always keeps child-table fields). So
    gating each child meta with `can('read')` would wrongly 403/empty a child the
    parent legitimately exposes.
  - The read-bypass risk (could a Link target leak through the bundle?) is
    **already prevented structurally**: `meta.childTables` is derived **only** from
    `fieldtype === 'Table'` rows (`loader.js:111`), so **Link targets are never in
    `childTables`**. The earlier "`istable === true`" wording on children was both
    wrong (`meta.istable` was always undefined — see C-1) and unnecessary.
  - **Correct rule:** project inline child metas by iterating **`meta.childTables`
    ONLY** — never walk a parent's `fields` Link targets, and never walk the
    `ensure()` closure. Each child meta is still run through `visibleFields`
    masking. This is a deliberate, *scoped* exception to the 403-on-no-read rule:
    it applies only to Table children of an already-read-permitted parent. If a
    child doctype is ever given its own DocPerm rows, revisit.

## Invariants (honoured, stated explicitly)

- **READ-ONLY.** Neither endpoint mutates. Meta **editing** stays on the
  authoritative write path — `POST /api/DocType` (the `DocType` doctype is
  perm-gated, `is_stub` reserved). The bridge does **not** call it. (The C-1
  `istable` plumb is a read-path-only change to `loader.js`/`meta.js`; it adds no
  write.)
- **NO NEW AUTHORITY.** The bridge composes only `ctxFromRequest`, `ensure`,
  `getMeta`, `can`, `visibleFields`, `getWorkflow`, and the shared error
  classes + `statusFor`. It reimplements none of them. The single place it
  reaches past a named primitive (`store.list('tabDocType')` for enumeration) is
  a plain read, flagged as **F1** rather than a new trust path.
- **Least Privilege.** 403 on no-read; permlevel field masking via
  `visibleFields`; raw `DocPerm` rows never leave the engine; `doctypes` in boot
  lists only `!istable` readable doctypes; child metas reached **only** via
  `childTables` (Table edges), never Link edges.
- **Fail-Fast / Fail-Closed.** Unknown doctype -> `NotFoundError` -> 404; no
  read grant -> `PermissionError` -> 403; an invalid bearer -> `AuthError` ->
  401. GUEST -> lean empty boot (200), never a 500. **A malformed doctype during
  boot enumeration is omitted-and-logged, never propagated (C-3).**
- **Idempotency / SoC / DRY.** Pure GET projections (idempotent). The bridge owns
  *projection only*; authority stays in `permissions.js`/`service.js`; meta
  hydration stays in `loader.js`. Masking logic is reused, not duplicated; the
  `istable` plumb reuses the `issingle`/`isStub` pattern verbatim.
- **KISS / YAGNI.** Two routes + one service + a 2-line read-path plumb. No
  caching layer, no new doctype flags shipped now (F1 cost mitigations are
  deferred options, not built).

## Consequences

- Desk can render any doctype it's allowed to see from `GET /api/boot` (what
  exists) + `GET /api/meta/<dt>` (how to render it), with child forms and the
  workflow graph in a single meta fetch — Frappe-accurate.
- A user sees only top-level, readable doctypes (no child/table or stub rows) and
  only fields/capabilities consistent with their grants; cosmetic capability flags
  never become an authority bypass (engine re-checks).
- The `/api/boot` enumeration **cost** (F1) is the one remaining
  performance/shape question; its **source, filter, and fail-closed behaviour are
  now decided**. Everything else composes existing, tested primitives.
- New code is small and projection-only (plus the 2-line `istable` plumb), so
  blast radius is contained: the bridge is downstream of perms/meta/workflow and
  upstream of nothing — changing it cannot affect the CRUD authority path. The
  `istable` plumb is additive (a new getter + one more constructor field), so it
  cannot change existing behaviour for callers that don't read it.

## Frappe citations

- `frappe/boot.py` → `get_bootinfo()` — lean boot: user, sysdefaults,
  server_date, module list (NOT bundled metas). (`develop`, 2026-06-21)
- `frappe/desk/form/load.py` → `getdoctype()` + `get_meta_bundle()` — returns the
  doctype meta **plus each table-field child meta inline**, one round-trip.
- `frappe/desk/form/meta.py` → `get_meta()` — the masked meta projection Frappe
  ships to the client.
