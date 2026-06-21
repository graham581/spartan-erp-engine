# Critique: Desk Bridge — read-only boot + meta projection

- **Verdict: PASS** (re-critique after architect revision — all three FAIL findings landed)
- **Reviewer:** critique
- **Date:** 2026-06-21
- **Design under test:** `docs/adr-desk-bridge.md` + `diagrams/desk-bridge-class.puml` (revised)
- **Prior verdict:** FAIL (C-1 blocker + C-2/C-3 must-fix). This revision resolves all three.

The revised design closes the one real leak hole (C-1) and tightens the two contract gaps
(C-2/C-3) concretely, with code-verified line references. Everything that passed the first
round survived the edits. Proceed to `planner`.

---

## Re-verification of the three FAIL findings

### C-1 (was BLOCKER) — `istable` plumb — RESOLVED

The revision adds the read-path plumb to **build scope** (ADR §"Build scope", diagram
`LoaderEdit`/`MetaEdit` classes), and I confirmed every load-bearing claim against the code:

- **Column exists, no migration:** `supabase/migrations/20260620010000_meta_core.sql:31` —
  `istable boolean not null default false`. Verified by Read. ✓
- **It is written:** `src/meta/installer.js:116` — `istable: def.istable ?? false`. ✓
- **It is NOT read today (the gap):** `loader.js:142` builds `Meta` without `istable`;
  `meta.js` has no `istable` getter — confirmed round 1 (Grep of loader.js for istable →
  no matches). ✓
- **The plumb is specified concretely and mirrors `isStub` verbatim:** loader gets
  `const istable = !!(row.istable)` passed into `new Meta({…, issingle, isStub, istable, …})`
  (ADR step 1, diagram :142-143); meta.js gets `this._istable = Boolean(def.istable ?? false)`
  + `get istable()` (ADR step 2, diagram :153-154). This is the exact existing pattern at
  `meta.js:18-19`/`:31-32` (issingle/isStub) — DRY. ✓
- **The boot filter is now `!m.istable && !m.isStub && can(ctx, dt, 'read')`** (ADR §F1
  ruling lines 191-198, diagram :105) — with `m.istable` now real, child/table doctypes
  (`DocField`, `DocPerm`, `Sales Order Item`) are **excluded** from boot `doctypes[]` instead
  of leaking. ✓
- **Additive / no behaviour change:** a new getter + one constructor field; callers that
  don't read `istable` are unaffected (ADR Consequences lines 280-281). ✓

### C-2 (was MUST-FIX) — F3 restated to "childTables only" — RESOLVED

ADR §FORK F3 (lines 218-236) and diagram `child_metas` note (:120-124) now state the rule
exactly as required:
- The `istable === true` child-gate wording is **GONE** — explicitly called out as "both
  wrong (`meta.istable` was always undefined) and unnecessary" (ADR line 230). ✓
- The stated rule is **iterate `meta.childTables` ONLY**, which is Table-derived
  (`loader.js:111`) so **Link targets are never present** — "never walk a parent's `fields`
  Link targets, and never walk the `ensure()` closure" (ADR lines 231-233, diagram :121-122). ✓
- Per-child `visibleFields` masking retained; inherit-parent-read justified (children carry
  no own DocPerm rows) (ADR lines 233-235, diagram :123-124). ✓

This matches the code: `meta.childTables` is the Link-safe boundary, and the closure set
(which *does* include Link targets, loader.js:224) is correctly excluded as the inline source.

### C-3 (was MUST-FIX) — fail-closed boot loop — RESOLVED

ADR §F1 "C-3 — fail-closed, skip-with-omit" (lines 200-204) and diagram (:101-107) now wrap
**each** doctype's `ensure() + filter` in its own `try/catch` that **omits-and-logs** the
offending doctype and continues. One malformed `tabDocType` row can no longer reject the whole
`/api/boot` promise → no self-inflicted 500/DoS on the new public surface. It is also folded
into the **Fail-Fast/Fail-Closed invariant** (ADR lines 256-257) and the diagram's invariant
header (:19-20). ✓

### Edge note (was non-blocking) — union runs through the same filter — RESOLVED

The `allDoctypes()` union now passes through the **same** `!istable && !isStub && can(read)`
filter as the store rows (ADR lines 195-198: "unioned in but run through the SAME filter …
otherwise pinned meta-doctypes re-pollute"; diagram :100-105: `candidates = union(...)` then
the single filter applied to all). Pinned meta-doctypes (`DocType`, `DocField`, …) can no
longer re-pollute. ✓

---

## Previously-passed checks — survived the revision

Re-read in the revised diagram/ADR; none regressed:

- **Field masking (parent):** `projectMeta` still filters `meta.fields` to
  `visibleFields(ctx, dt)` (diagram :110-112) — permlevel-gated names/types dropped. PASS.
- **403-on-no-read:** `buildMeta` `ensure()` → `if(!can(read)) throw PermissionError` →
  `statusFor` 403 (diagram :82). PASS.
- **Unknown doctype → 404:** `ensure()`→`load()`→null row→`NotFoundError`→404, before the
  read-gate (no partial leak). PASS.
- **GUEST → empty 200 / meta 403:** GUEST roles `[]` ⇒ `can(read)` false everywhere ⇒
  `permittedDoctypes` `[]` naturally (diagram :73, ADR lines 89-93). PASS.
- **Raw DocPerm never projected:** `projectMeta` output enumerated (diagram :115-118) is
  `{doctype, autoname, submittable, issingle, istable, isStub, fields, childTables,
  scopeFields}` — no `permissions`/`getDocPerms()`; `capabilities` is `can()`-booleans only.
  (`istable`/`isStub` in the projected meta are non-sensitive structural flags, not perm rows
  — correct to expose.) PASS.
- **Full workflow graph (F2):** `getWorkflow` full `{stateField, states, transitions[+roles]}`,
  re-gated server-side in `transition()`; no field/permlevel data in the workflow view
  (diagram :126-131). PASS.
- **Read-only / no new authority:** bridge composes only the named reuse primitives; explicit
  `<<does NOT call>>` write-path edge (diagram :216-220); the istable plumb is read-path-only
  (ADR lines 242-244, invariant header :12). PASS.
- **AuthError→401 outer-catch:** both new routes carry the
  `catch{ AuthError→401 ; else→500 }` mirroring `api/[doctype]/*` (diagram :36, :50). PASS.

---

## Hand-off → `planner`

**PASS.** Carry this test list into the work order (each is a concrete acceptance check):

1. **istable plumb round-trip** — seed a `tabDocType` row with `istable:true`;
   `getMeta(dt).istable === true` (and `false`/absent → `false`, real boolean). Mirror the
   existing `isStub` round-trip test (`loader.test.js` "is_stub round-trip" U-MARKER).
2. **Boot excludes istable/stub/no-read** — boot `doctypes[]` omits a `istable:true` child
   (`Sales Order Item`), a `is_stub:true` row, and any doctype the ctx lacks `read` on;
   includes a readable top-level doctype.
3. **Boot per-doctype omit-on-throw** — a malformed doctype whose `ensure()` throws is omitted
   from `doctypes[]`, the rest of the list still returns, status 200 (not 500).
4. **/api/meta field masking** — a permlevel-1 field's name/type is absent for a permlevel-0
   ctx; present for a permlevel-1 ctx.
5. **403-on-no-read** — `/api/meta/<dt>` with no read grant → 403; unknown doctype → 404
   (before the read-gate).
6. **Child-meta inline masked** — `child_metas[<Table child>]` present and its fields run
   through `visibleFields`; a Link target is NOT inlined.
7. **GUEST empty boot** — no bearer (dev-auth off) → `{user:'guest', roles:[], scopes:{},
   doctypes:[], server_date}`, status 200.
8. **AuthError→401** — present-but-invalid bearer → 401 from the route outer-catch (NOT
   swallowed into an empty-200 boot).
9. **Full workflow graph** — `/api/meta/<dt with workflow>` returns all states + all
   transitions with `roles[]`; engine still re-gates the real POST action.

Note for planner: items 2/6/8 are the leak-class checks — keep them as explicit gates, not
folded into a generic happy-path test.
