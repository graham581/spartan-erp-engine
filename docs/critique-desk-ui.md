# Critique — Generic Desk UI client (`adr-desk-ui.md` + `desk-ui-class.puml`)

Reviewer: critique
Date: 2026-06-21
Verified against engine source (not the ADR's prose): `src/api/handler.js`,
`src/validation/request-schemas.js`, `api/[doctype]/index.js`, `api/[doctype]/[name].js`,
`src/api/desk-bridge.js`, `api/boot.js`, `api/meta/[doctype].js`,
`src/api/context-from-request.js`, `src/meta/registry.js`.

## VERDICT: **PASS (conditional)** — proceed to `planner`

The load-bearing contract — the request envelope and the masking/untrusted-client discipline —
is **correct against source**. I tried hard to break the envelope and could not: every row of
the ADR §4.3 table matches `handler.js` + `request-schemas.js` exactly. The design is sound and
honours KISS / SoC / Least-Privilege / Fail-Safe.

Four findings below are **must-fix-in-planner-brief** (one is a real bug in the design as written),
the rest are notes. None require re-architecting, so I am not bouncing to `architect` — but the
planner MUST fold C1–C4 into the work orders or the ChildGrid unit will ship broken and a couple
of UX edges will misbehave.

---

## Envelope contract — VERIFIED CORRECT (the thing most likely to silently break)

Confirmed line-by-line against `handler.js:37-94` and `request-schemas.js`:

- **create** = `POST /api/<dt>`, body = flat record. `handle()` line 47 → `CreatePayloadSchema`
  = `z.record(...).superRefine(rejectReservedKeys)`. ✓ No `{data:…}` wrapper. ✓
- **update** = `POST /api/<dt>/<name>`, body = flat patch. Line 50 → `UpdatePatchSchema` (same
  shape). ✓ `name` in URL, never body. ✓
- **action vs update disambiguated by `body.action`** — `const action = body && body.action`
  (line 44); same URL. ✓ Matches ADR §4.3 + diagram `ApiClient.action`/`update`.
- **submit/cancel = `{action:'submit'|'cancel'}`** — lines 70-71. ✓ Any other action string →
  `transitionDoc` (line 72, declarative transition). ✓
- **reserved keys** `owner, docstatus, name, is_stub` rejected — `RESERVED_KEYS`
  (`request-schemas.js:14`). ADR §4.3 + diagram both say strip pre-send. ✓
- **list filters** `f_<field>=<value>`, plus `limit/offset/order/order_by` — `listOpts`
  (`handler.js:84-94`) reads exactly these; `ListQuerySchema.catchall(z.string())` lets `f_*`
  through. ✓
- **error→status map** `401/403/404/409/400/500` with `{error,type}` — `statusFor`
  (`handler.js:14-21`) + catch (line 79) + the route AuthError catches. ✓

This is the part a generic client gets wrong silently. It is right. Good.

---

## Findings the planner MUST fold in

### C1 (BUG in the design) — ChildGrid collect keys on the wrong field

ADR §4.6 / diagram `ChildGrid`: *"the row array is embedded under the **parent fieldname**"*, and
*"columns from `child_metas[child.doctype].fields`"*. These reference two **different** keys and
the ADR blurs them:

- `ChildTableDef` (`registry.js:22-26`) = `{ field, doctype, table }`. The **parent fieldname**
  that holds the rows is **`c.field`**.
- `buildMeta` keys `child_metas` by **`c.doctype`** (`desk-bridge.js:153`: `child_metas[c.doctype] = …`).

So on collect, the record must embed rows under **`childTableDef.field`** (the parent fieldname),
while the column meta is looked up under **`childTableDef.doctype`**. If an implementer follows the
diagram literally and keys the submitted record by `child.doctype`, the engine receives an unknown
field and the child rows are silently dropped/rejected. **Planner: state explicitly — collect key =
`field`, meta lookup key = `doctype`.** (Also: `meta.childTables` is the authoritative list of
child fields; `meta.fields` does **not** contain the `Table` fields as renderable widgets — see C3.)

### C2 — FormView/ListView read child tables from `meta.childTables`, NOT from a `Table` fieldtype in `meta.fields`

The widget map (ADR §4.6 / diagram) routes `fieldtype:'Table'` → `ChildGrid`. But `projectMeta`
returns `fields` (filtered to visible) **and** a separate `childTables` array; the masked `fields`
list is the parent's own DocFields. Whether a `Table`-type FieldDef appears in `meta.fields` is an
engine detail the ADR assumes. The robust, source-aligned design is: **iterate `meta.childTables`
to render child grids, and `meta.fields` for scalar/Link widgets** — do not rely on a `Table`
entry being present in `meta.fields`. Planner should pin this so FormView doesn't miss child tables
on doctypes where the Table field isn't surfaced in `fields`. (If the engine *does* put Table in
`fields`, the two must be cross-referenced by fieldname → childTables entry; either way, name the
source of truth as `meta.childTables`.)

### C3 — `boot` carries `scopes` and `server_date`; meta carries `submittable/issingle/istable/isStub/scopeFields` — the design ignores fields it will want

`buildBoot` returns `{user, roles, scopes, doctypes, server_date}` (`desk-bridge.js:90-96`); the
ADR/diagram only consume `doctypes` + `roles`. That's fine for v1, **but** `projectMeta`
(`desk-bridge.js:39-49`) returns `issingle` and `submittable` — and a **Single** doctype
(`issingle:true`) has no list and no `<name>` in the URL (it's a singleton). The ADR's routing
(`#/<dt>` → ListView, `#/<dt>/<name>` → FormView) has **no story for issingle doctypes** — ListView
on a Single will fetch a collection that doesn't behave like one. **Planner: add a note —
issingle handling is either explicitly out-of-scope-for-v1 (and such doctypes hidden/landed
straight to a singleton form) or a defined route.** Don't let it fall through to a broken ListView.

### C4 — Link picker: target-meta 403 path is named but the cap is not, and the engine's filter can't do "contains"

The brief asks two things the ADR half-answers:
- **Cap / many-row degradation:** ADR §4.6 LinkPicker does `GET /api/<target>?f_..&limit=…` but
  **never states the cap value** or what happens when the target has more rows than the cap. F5
  notes the equality-only filter gap correctly, but the v1 behaviour must be stated: *"capped at
  first N (e.g. 50) ordered by name; typeahead is client-side filter over that page; a target with
  >N rows shows only the first N — accepted for v1, escalated to diagnose as F5."* Planner: pin N
  and the "first-N is all you get" UX caveat.
- **Unreadable Link target:** if the user can read the parent doctype but **not** the Link target,
  `GET /api/meta/<target>` → 403 and `GET /api/<target>` → 403 (the engine read-gates both). The
  LinkPicker must **degrade to a plain text input (store raw name)**, not throw/whiteout the form.
  The ADR does not address this. Planner: state the 403-on-target fallback explicitly. (This is a
  real path — `buildMeta` throws `PermissionError`→403 at `desk-bridge.js:129`.)

---

## Notes for the planner (not blockers)

- **N1 — WorkflowBar reads `doc[workflow.stateField]`**: correct. `buildMeta` returns
  `workflow.stateField` (`desk-bridge.js:159`) and transitions `{from,to,action,roles}` with
  `roles` possibly `undefined` (`t.roles` passed straight through, line 165). The `fireable`
  rule "`roles` undefined OR intersects user roles" matches the source — `roles:undefined` means
  open to all. ✓ Keep that branch; don't treat `undefined` as "no one".
- **N2 — `capabilities.submit/cancel` gate the submit/cancel buttons**, but submit/cancel are
  *also* `body.action` calls routed through the same `transitionDoc`/`submitDoc` path. Engine
  re-checks (`can(...,'submit')`). Cosmetic gating is correct per the invariant. ✓
- **N3 — `order_by` is required for ordering**: `listOpts` only sets `opts.order` when
  `query.order_by` is present (`handler.js:88`); sending `order=desc` alone is a no-op. The client
  must send `order_by` to order. Minor — note in the ListView work order.
- **N4 — 401 re-auth retry-once**: the silent `google.accounts.id.prompt()` → button fallback is
  reasonable. One caution for the planner: GIS `prompt()` is not guaranteed to return a credential
  synchronously (FedCM/one-tap may be suppressed). The "retry the in-flight request once" must
  **time-box / fall back to SignInGate** rather than hang the request forever. State a bounded
  wait, then SignInGate. Avoids the white-screen the brief warns about.
- **N5 — token hygiene**: ADR commits to in-mem + sessionStorage, server re-verify, no 3rd-party
  scripts beyond GIS. Confirm the planner's work order forbids logging the token and putting it in
  any URL/query (it's only ever an `Authorization` header). The design says so; make it a checklist
  item in the ApiClient unit.
- **N6 — separation invariant holds**: the module layout (ADR §4.1) imports nothing from engine
  `src/` — every class reaches the engine through `ApiClient`'s `fetch('/api/...')`. The diagram's
  bottom note states it. ✓ No leak found.
- **N7 — Vercel static serving**: `public/` already serves `/` (landing) alongside `api/*`
  functions; `public/app/` → `/app` is additive and does not shadow `api/*` (functions take
  routing precedence; `/api/*` are filesystem routes under `api/`). Hash routing (F1) means **no
  rewrite** is needed, so there is **no risk** of a catch-all swallowing `/api/*`. If the LEAD
  ever picks history routing, the rewrite MUST be scoped `"/app/(.*)"` only — a bare `"/(.*)"`
  would break `/api/*` and `/`. The ADR already says this (§4.1). ✓ Confirm any added `vercel.json`
  does not introduce a global rewrite.

---

## Contract check
- **KISS** ✓ no build / no framework / hash routing.
- **SoC** ✓ auth / transport / meta / render / workflow are separate modules; one egress seam.
- **Least Privilege** ✓ renders only masked `meta.fields`; capabilities cosmetic; engine
  re-checks (`buildMeta` masks via `visibleFields`, `can()` re-checked server-side).
- **Fail-Safe** ✓ every non-2xx → typed error; **except** the LinkPicker 403-target and the
  401-prompt-hang edges (C4, N4) which the planner must close.

## Handoff
→ `planner`. Fold **C1–C4** into the unit work orders (C1 is a literal bug in the design text;
C2–C4 are under-specified edges that will bite). N1–N7 are guidance. Envelope + masking discipline
need no further change.
