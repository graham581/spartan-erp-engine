# ADR: Supabase-native features — what the engine pushes into Postgres vs. keeps in JS

- **Status:** Proposed — **Revision 3.1** (architect, after Round-3 critique FAIL on C13; narrow §A.5 re-scope) → critique
- **Date:** 2026-06-24 (Rev 3.1)
- **Context repo:** `spartan-erp-engine` (shares the one prod Supabase project `sedpmsgiscowohpqdjza` with SpartanCRM, the installer app, and the customer portal)
- **Decision owner:** Graham
- **Relates to:** [`adr-meta-as-data.md`](adr-meta-as-data.md), [`Architecture_Contract.md`](Architecture_Contract.md) §2, §3, §4, §6, §8.3; SpartanCRM [`docs/_design/supabase-auth-adoption-spec.md`](../../crm-worktrees/scratch03/docs/_design/supabase-auth-adoption-spec.md); **LIVE shared helpers** `20260624141500_engine_auth_scope_helpers.sql` + the shipped identity hook `20260623130000_app_schema_and_identity.sql` (both applied to prod `sedpmsgiscowohpqdjza`)

## Rev-3 changelog (how Round-2 C9 + the Round-2 mediums are resolved against LIVE facts)

Round 2 returned **FAIL** on a single hard blocker — **C9** — with three mediums (C10/C11
non-blocking, C12 confirmed benign). Since Rev-2, the platform side was **grounded and shipped**:
`20260624141500_engine_auth_scope_helpers.sql` is **live on prod** (`app.can_read_doc`,
`app.state_in_scope`, `app.user_state_ceiling`, `app.is_admin`, `app.user_role`, `app.users_v`,
`app.claims_version`). Rev-3 designs to those **frozen, live signatures** — not to the Rev-2 spec
prose the round-2 critique correctly found contradicted by the code. The Rev-2 §A is **replaced**
in full; §B (constraint emission) is carried forward with the C10/C11 guards added.

### Rev-3.1 (architect, after Round-3 C13 — narrow re-scope)

Round 3 returned **FAIL** on a single blocker — **C13** — and one non-blocking polish — **C14**.
Items 1 and 3 (owner-keyspace back-fill, Customer `USING (true)`) **HOLD** and are unchanged. The
**only** Rev-3.1 edits are §A.5 (rewritten) and §A.4 step 3 (the C14 polish folded in):

- **C13 (BLOCKER) — `User` doctype is now READ-ONLY-DENY, not "point `meta.table` at `app.users_v`".**
  *Resolved by making the `User` doctype mutation-denied.* Rev-3's §A.5 *recommended* sub-option (i)
  — point `User.meta.table` at the SELECT-only `app.users_v` view — which the engine's **unconditional**
  generic write path (`handler.js` → `service.js:createDoc/updateDoc` → `document.js:insert/save` →
  `store.insert/update(meta.table)`) would INSERT/UPDATE into, breaking every User write (view is
  SELECT-only, no INSTEAD OF triggers, no service-role write grant, and the engine emits Frappe framework
  columns `docstatus/idx/modified/creation` absent from `public.users`). **Decision: the engine does NOT
  own user identity — the CRM/auth system does (one entity, one home). The `User` doctype is READ-ONLY:**
  reads resolve via `app.users_v` keyed by `app_user_id`; **create/write/delete are denied at the docperm
  level** so the engine's existing `assertCan`/`assertCanMutate` gate returns **403 before the store is
  ever touched** (verified — see §A.5). Any user *provisioning* the engine needs goes through the existing
  CRM `provisionSupabaseUser(email)` mint (`api/_lib/supabase-session.js`), never a doctype write. This is
  the cleanest of the critique's three options and matches reality; sub-option (i)/(ii) are **withdrawn**.
- **C14 (polish, non-blocking) — back-fill orphan visibility.** *Folded into §A.4 step 3.* The owner
  back-fill now (a) emits a **fail-loud `RAISE NOTICE` count of unmatched (orphan) owners**, and
  (b) states explicitly that rows back-filled to an **inactive** user are **admin-only by design**
  (runtime resolve requires `AND active`, though `app.users_v` itself has no active filter — so the
  back-fill *join* matches inactive users, but their rows are then visible only to admin/state).

- **C9 (BLOCKER) — engine RLS read claims the hook does not produce, joined on the wrong keyspace.**
  *Resolved against the shipped hook.* Three concrete corrections, each verified against live SQL:
  1. **No `branch` claim; state is read live, not from a claim.** The hook injects **only**
     `app_user_id` + `app_role` (`20260623130000_…:179-180`). Branch/state scoping is **not** a JWT
     claim — it is computed live inside `SECURITY DEFINER` helpers (K7). The engine therefore does
     **not** read `auth.jwt()->>'branch'`; it calls **`app.can_read_doc(owner, <state-col>)`**, which
     internally resolves the user's `service_states` ceiling via `app.state_in_scope` /
     `app.user_state_ceiling`. One shared definition, no scalar-branch claim, no per-policy re-inline.
  2. **`app_role` name + role model.** The engine's admin/`unrestricted` escape maps to
     **`app.is_admin()`** (the single live definition of `role='admin' OR branch='All'`, read live) —
     it never reads a `role`/`app_role` claim string in a policy. The Rev-2 `auth.jwt()->>'role'`
     snippets are deleted. See **§A.3** + role-model **§A.6**.
  3. **`owner` keyspace fixed to `app_user_id` (u178 id), not email.** Ground truth: the engine today
     stamps `owner = ctx.user = email` (`service.js:34`, `identity.js:40`), while the hook sets
     `app_user_id = public.users.id` = the `u178…` text id (`…:179`). The owner predicate was dead on
     arrival. *Fix:* the engine stamps **`owner = ctx.appUserId`** (the u178 id), the ctx carries that
     id, and existing email-keyed `owner` rows are **back-filled** (§A.4). RLS then compares
     `owner` (u178) against `app.current_uid()` (u178) — same keyspace.
  4. **`public.users` vs `tabUser` are different row sets — resolved by retiring `tabUser` as the
     identity source.** The engine's `User` doctype is **re-pointed at `public.users` via the live
     `app.users_v` view**; identity resolution reads `app.users_v` keyed by the claim's `app_user_id`,
     not `store.get('tabUser', email)`. `tabUser` is no longer the canonical actor table. See **§A.5**.
- **C1 scope decision (ratification pending) — engine RLS covers `public.users` actors ONLY.**
  Installers/customers carry **no** `app_user_id` claim, so every `app.current_uid()` predicate denies
  them by construction. Multi-actor identity is an explicit **out-of-scope** cross-app design. Stated
  in **§A.1**; this is the basis Rev-3 builds on (per `engine-auth-platform-implementation.md` §C1).
- **C10 (MEDIUM) — FK emission ordering hole.** *Carried + guarded.* §B.1 now requires a
  **target-table-exists** guard: FK is emitted in a **later `alter table` pass** (after all slice
  tables are created), or table creation is topologically ordered. Slice-1 Customer has no outbound
  Link FK, so slice 1 is safe; the guard is mandatory **before any multi-doctype slice**. See **§B.1**.
- **C11 (MEDIUM) — UNIQUE on populated data.** *Carried + guarded.* §B.2 now states: adding a UNIQUE
  index to an **already-populated** field needs a **dedup precheck** first, else `create unique index`
  aborts the migration. `tabCustomer` is freshly proven → slice 1 safe. See **§B.2**.
- **C12 (resolved/benign) — stamping trigger vs JS double-write.** Confirmed harmless by round 2:
  `coalesce(new.creation, now())` preserves the engine `creation`; `modified := now()` is
  trigger-authoritative; both serialise to `timestamptz`. No action. See **§B.3**.
- **README/Contract reconciliation (§2.1/§2.3/§2.4/§3.4/§4.1/§8.3).** *Carried forward unchanged from
  Rev-2 — already accepted by round 2.* See **§README-vs-Contract**.

> **Rev-2 changelog retained below for provenance** (round-1 C1–C8 + §2.4/§4.1 are all still closed;
> only C9's claim/keyspace layer is re-designed in Rev-3).

### Rev-2 changelog (round-1 findings — retained, still closed)

- **C1** (RLS had no identity) — GoTrue adopted as the identity source (round 2 graded this *partial*;
  Rev-3 closes the residual claim/keyspace break as **C9** above).
- **C2** (no anon code path) — `scripts/rls-probe.mjs` raw anon-key client, sole RLS coverage, outside
  the Store hierarchy. *Closed.* See **§A.7**.
- **C3** (defense-in-depth backwards) — RLS and `queryConditions` guard **disjoint** caller sets; an
  engine-path `queryConditions` bug has **no** DB net. *Closed.* See **§A.8** + Consequences.
- **C4** (no home for policy name/intent) — `rls_policy_name` + `permission_intent` columns on
  `tabDocType`, own migration, carried by `installer.js:syncDoctype`. *Closed.* See **§A.3**.
- **C5** (stale "naming not atomic") — `next_series` confirmed atomic; stale comments filed as
  implementer doc-cleanup; no naming work. *Closed.* See **§Doc-cleanup**.
- **C6** (DDL drops constraints) — FK + UNIQUE + stamping trigger emitted; NOT NULL/CHECK deferred with
  reasons. *Closed.* See **§B**.
- **C7** (JS-only stamping) — `set_doc_stamps()` trigger authoritative. *Closed.* See **§B.3**.
- **C8** (embedding parity wrong) — restated against `loadDoc`'s `getChildren`; embedding gated on a
  `parent` FK; honest "drops to later" fallback. *Closed.* See **§First slice step 2**.
- **§2.4 / §4.1 (O1)** — §2.4 re-blesses `PgStore` parameterised `sql.unsafe`; O1 settled (Zod = def
  structure + request envelopes only; entity data is hand-rolled meta-driven JS). *Closed.*

---

## Problem

The engine is a faithful Frappe-in-JS runtime. As built, `SupabaseStore` connects with the
**service-role key**, which **bypasses RLS entirely**, reads with `.select('*')`, and uses **no
triggers** (except the `next_series` RPC) and **no realtime**. Supabase is currently *dumb storage*;
Frappe's runtime behaviours (links, permissions, child-table assembly) are reimplemented in JS.

Two consequences force this ADR:

1. **No row security outside the engine.** Because the engine uses service-role, RLS is off. The
   prod project is shared across CRM + installer + portal, so **any DB access that does not go
   through the engine** has **zero** row-level protection. `Architecture_Contract.md` §6.1 mandates
   hand-written RLS; the engine as built does not honour it.
2. **A doctrinal contradiction.** The README describes a *runtime* meta-as-data engine; the Contract
   (§2 codegen-from-Drizzle, §4.1 Zod-only validation, §6.1 hand-written RLS, §8.3 YAGNI on the
   generic hook) describes a different shape. One canon must win; the other must be amended (§10).

The trigger question — "implement a DocType system using Supabase's features" — is half-answered:
the DocType system **exists** (`adr-meta-as-data.md`). The open question is **how much of the Frappe
runtime to push into Postgres** versus keep in the JS engine. **Rev-1 answered "RLS as a backstop"
but the backstop had no identity to enforce against** (C1). Rev-2 adopted GoTrue but mis-stated the
**claim contract** (C9). **Rev-3 designs to the live, shipped platform** — the engine consumes the
already-deployed `app.*` helpers rather than re-authoring the CRM's scoping model.

## Decision

**Hybrid, not either/or.** The JS engine remains the authority for genuinely Frappe-semantic logic;
specific Supabase features are adopted only where they are *strictly better and low-risk*.

| ERPNext / DocType concept | Authority after this ADR | Mechanism |
|---|---|---|
| docstatus `0→1→2`, workflow transitions | **JS engine** | `SubmittableDocument`, workflow hooks — too stateful for SQL |
| Def-structure validation | **JS engine (Zod)** | `def-schema.js` `assertValidDef` — unchanged |
| Request-envelope validation | **JS engine (Zod)** | `request-schemas.js` — unchanged |
| Entity/document data validation (reqd, Select, numeric, **unique**, Link-exists) | **JS engine (hand-rolled, meta-driven)** | `validate.js:validateAgainstMeta`, `links.js:validateLinks` — **not** Zod (O1) |
| Naming series | **Postgres** (already, **atomic** — C5) | `next_series` RPC — keep, no work |
| Link existence | **Postgres FK (backstop) + JS (friendly msg)** | emit FK from `Link.options`; `validateLinks` keeps the field-level error (§B.1) |
| Field uniqueness | **Postgres UNIQUE (backstop) + JS** | emit UNIQUE from `unique` flag; `validateAgainstMeta` keeps friendly error (§B.2) |
| `modified`/`creation` stamping | **Postgres trigger (authoritative)** | per-table `BEFORE INSERT/UPDATE` trigger (§B.3); JS stamp becomes redundant-but-harmless |
| **Identity for RLS** | **GoTrue session via the shared `supabase-session.js` chokepoint** | Google → `provisionSupabaseUser`/`mintSupabaseTokenHash` → GoTrue JWT with `app_user_id`+`app_role` claims → `app.current_uid()` (§A) |
| **Row-scope enforcement (non-engine callers)** | **LIVE `app.can_read_doc(owner,state)` helper** | one generated SELECT policy per doctype calls the shared predicate (§A.3) |
| docperm (read/write/submit per role) | **JS primary + RLS owner/state backstop** | `queryConditions` stays primary (engine callers); RLS = `app.can_read_doc` for non-engine callers (§A) |
| Live floor / status updates | **Postgres → client** | Realtime CDC (smoke only in slice 1; gate with the read policy) |
| Generic CRUD API | **JS engine** | keep the custom `api/[doctype]` handler — *not* PostgREST auto-API |
| Static typing | **JS + JSDoc** | unchanged — `QueryData` TS inference rejected (Contract §3.1) |

---

## §A. Identity → perm-context → RLS (resolves C1, C9, and carries C2/C3/C4)

**Decision: identity flows through GoTrue via the shared CRM session chokepoint, and the engine
consumes the LIVE shared `app.*` scope helpers — it does not re-author the CRM's scoping model.**
This is the round-2 correction: Rev-2 read claims (`branch`, `role`) the hook never produces and
joined on the wrong keyspace (`owner=email` vs `app_user_id=u178`). Rev-3 binds to the **shipped**
contract.

### A.1 Scope — `public.users` actors ONLY (C1 ratification basis)

The shared hook stamps `app_user_id` **only** for `public.users` rows (matched on `lower(email)`,
`20260623130000_…:171-183`). Installers authenticate via `auth.uid() = public.installers.auth_user_id`
and receive **no** `app_user_id` claim, so every `app.current_uid()`-based predicate returns NULL and
**denies them by construction** (fail-closed — correct). **Engine RLS is therefore scoped to
`public.users` actors only.** Serving installers/customers from the engine is a **separate cross-app
identity design** (the hook would need an `app_actor_kind` + kind-specific id, or a unioned resolver)
and is **explicitly out of scope** here — not retrofitted. (Per `engine-auth-platform-implementation.md`
§C1; pending only formal ratification by the decision owner.)

### A.2 The flow (sign-in → Supabase JWT → claims → `app.current_uid()` → RLS)

```
Google sign-in  ──►  reuse CRM chokepoint api/_lib/supabase-session.js:
                       provisionSupabaseUser(email)  (idempotent)
                       mintSupabaseTokenHash(email)  → client verifyOtp({token_hash})
                       │  (NO signInWithIdToken path — Rev-2 was wrong; the shipped
                       │   pattern is cookie→token_hash→verifyOtp)
                     GoTrue issues a session JWT; custom_access_token_hook injects
                       claims = { app_user_id = public.users.id (u178),  app_role }   (FROZEN)
                       │
        ┌──────────────┴───────────────────────────────────────────┐
        │ ENGINE SERVER PATH (Vercel funcs, trusted)                │ NON-ENGINE PATH
        │                                                           │ (browser / installer / portal)
        │ ctxFromRequest verifies the bearer:                       │ carries the GoTrue JWT to PostgREST
        │   • iss == Supabase auth URL → Supabase JWKS,             │   • request.jwt.claims POPULATED
        │     read app_user_id (u178) + app_role                    │   • app.current_uid() = u178
        │   • else → existing Google JWKS path (transition)         │   • RLS policy calls
        │   → resolveActorToCtx(app_user_id) reads app.users_v      │       app.can_read_doc(owner,state)
        │   → Ctx{ user, appUserId, roles, scopes, unrestricted }   │   • state/branch read LIVE inside
        │ uses SERVICE_ROLE key → RLS bypassed;                     │     the SECURITY DEFINER helper (K7)
        │   queryConditions is the enforcer here                    │   RLS is the ONLY enforcer here
        └───────────────────────────────────────────────────────────┘
```

**Two keys, two homes** (unchanged from Rev-2, the boundary C1/C2 demand be explicit):

- **Service-role** key — engine server paths only (`SupabaseStore.fromEnv`, `PgStore` via
  `DATABASE_URL_POOLER`). RLS is bypassed; `queryConditions` (`permissions.js:146`) is authoritative.
- **Anon/authenticated** key + GoTrue JWT — every non-engine caller. RLS via `app.can_read_doc`.

**No `branch`/`role` claim is read in any policy** — that was the C9 break. State is read **live**
inside the SECURITY DEFINER helpers from `public.users.service_states` (a JSONB array of state codes),
so a permission edit applies immediately (K7), and the multi-state ceiling the CRM uses survives
losslessly (a scalar claim could not carry `["VIC","ACT"]`).

### A.3 RLS that calls the LIVE `app.can_read_doc` helper (resolves C9, C4)

The engine emits **one SELECT policy per doctype**, calling the shared, already-deployed predicate
with the row's `owner` column (now the u178 id — §A.4) and the doctype's **state-scope column**
(named by `scope_fields` on the DocType row; NULL when the doctype has no state column):

```sql
-- service_role (the engine) is the trusted server door — unconditionally allowed.
alter table "tabCustomer" enable row level security;
create policy "tabCustomer_service" on "tabCustomer"
  to service_role using (true) with check (true);

-- non-engine authenticated callers: the generated one-liner that calls the shared predicate.
create policy "tabCustomer_read" on "tabCustomer" for select to authenticated
  using ( app.can_read_doc(owner, NULL) );      -- Customer has NO state column → owner-or-admin
```

`app.can_read_doc(p_owner, p_state)` (live) is fail-closed: readable iff there **is** an identity AND
(`app.is_admin()` OR `p_owner = app.current_uid()` OR `p_state` is in the user's live ceiling). The
engine never re-authors owner/state/admin logic — it inherits any future platform fix to the predicate
for free, and CRM + engine provably share **one** enforcement definition.

**Why `NULL` state for Customer (the owner-vs-team-visible reasoning the brief demands):**
`tabCustomer` has **no state/branch column** (verified: `20260620000001_customer.sql` defines only
`customer_name, territory, email, credit_limit`), and the platform's `app.entity_state('customer',…)`
**deliberately returns NULL** (`20260623130000_…:83` — "customers has no state/branch column"). So
Customer is **not** state-scoped in either app. The decision is between:
- **(a) owner-scoped:** `app.can_read_doc(owner, NULL)` → collapses to **owner-or-admin** (a rep sees
  only customers they created; admins see all), or
- **(b) team-visible:** a `USING (true)` policy (every authenticated staff user sees every customer).

**Decision: (b) team-visible — `USING (true)` for `tabCustomer`, NOT `can_read_doc`.** Reasoning
grounded in docperm *intent*, not a reflexive policy bolt-on: a sales **Customer** master is a shared
reference entity (any rep books a deal against any existing customer; caller-ID lookup spans the whole
org — cf. CRM `customers` is the caller-ID identity table). The engine's `queryConditions`
(`permissions.js:146`) only adds an `owner` filter when the **sole** read grant is `if_owner`; a normal
Customer read docperm is a **plain grant** → `queryConditions` returns `{}` (no owner filter). Emitting
`can_read_doc(owner, NULL)` (owner-or-admin) would therefore **change behaviour** vs the engine's own
primary enforcer — exactly the "don't bolt on a policy that changes behaviour" trap the brief flags.
So Customer's non-engine RLS is the **honest least-privilege match to its plain-grant docperm**:
authenticated staff read all (`USING (true)`); anon/installer (no `app_user_id`) read none. The
generator's rule: **a doctype whose read docperm is plain (not `if_owner`) and which has no
`scope_fields` emits `USING (true)`; a doctype with `scope_fields` emits `can_read_doc(owner, <state-col>)`;
a doctype whose read docperm is `if_owner`-only emits `can_read_doc(owner, NULL)` (owner-or-admin).**
This keeps the emitted policy a faithful projection of the same docperm/`scope_fields` meta the engine
already reads — DRY, not a second-authored rule.

**New `tabDocType` columns (C4 — the policy name/intent had no home):**

- `rls_policy_name text` — the named policy this doctype's emitted SQL declares.
- `permission_intent text` — the one-line intent (Contract §6.2), e.g. `"team-visible reference master"`.

These ship in their own meta migration (idempotent `add column if not exists`), and
`installer.js:syncDoctype` carries them onto the DocType row (one-line addition to the row builder).
RLS policy bodies remain **hand-written/generated SQL, never Drizzle-generated** (Contract §6.1).

### A.4 Owner keyspace — stamp `owner = app_user_id` (u178), and back-fill (resolves C9.3)

Ground truth: `createDoc` stamps `owner = ctx.user` and `ctx.user` is the **email** (`service.js:34`;
`identity.js:40 makeContext({ user: email })`). The hook's `app_user_id` is the **u178 id**. To make
`app.can_read_doc`'s `p_owner = app.current_uid()` ever match:

1. **Carry the u178 id on the ctx.** `resolveActorToCtx` (§A.5) sets `ctx.appUserId = <u178 id>` (from
   `app.users_v.id`). `ctx.user` may stay the email for logging/display, but **`owner` is stamped from
   `ctx.appUserId`**, not `ctx.user`.
2. **Change the stamp.** `service.js:34` becomes `const doc = { ...payload, owner: ctx.appUserId };`.
   The `queryConditions` owner filter (`permissions.js:155 filter.owner = ctx.user`) likewise switches
   to `ctx.appUserId`, so the engine's primary enforcer and the DB backstop agree on keyspace.
3. **Back-fill existing rows.** A one-off, idempotent migration maps each existing `owner`/`tabUser.name`
   email to its `public.users.id` via `app.users_v` (join on `lower(email)`), and updates
   `tab*.owner`. Additive + reversible (keep the email in an `owner_email_legacy` column for one
   release if rollback insurance is wanted). Rows whose email has no `public.users` match keep the
   email value and are flagged for manual reconciliation (they are pre-migration test rows on the
   engine's isolated project; **on the shared prod project every actor is a `public.users` row**).
   - **Fail-loud orphan count (C14).** The migration **`RAISE NOTICE`s the count of unmatched (orphan)
     `owner` values** — those with no `public.users` match on `lower(email)` — so the operator *sees*
     the orphan set at `db push` time rather than discovering invisible rows later. Idempotency holds:
     the email→u178 update is one-way and re-runnable (a u178-valued `owner` no longer matches the
     email-join, so re-runs no-op).
   - **Inactive-owner rows are admin-only by design (C14).** `app.users_v` itself has **no `active`
     filter** (it selects all `public.users` rows), so the back-fill *join* will match **inactive**
     users too — good for back-fill coverage. But the runtime resolve path requires `AND active`
     (`app.current_uid()` via the hook + `app.user_state_ceiling`), so a row back-filled to a now-inactive
     user's u178 id becomes visible **only to admin/state**, not to that user. This is **least-privilege-
     correct (fail-closed), not a bug** — stated explicitly so the orphan/inactive set is understood as
     intentional, not surprising.
   *Assumption (stated, low-risk):* the engine's isolated dev project and the shared prod project use
   the **same** `public.users.id` space once the engine cuts over to the shared project; the back-fill
   runs at cutover. If the engine stays on its own isolated project indefinitely, the u178 ids must be
   seeded there — an **open question for the planner**, not a slice-1 blocker (slice-1 acceptance runs
   against whichever project carries the live hook + helpers).

### A.5 `User` doctype is READ-ONLY; identity reads via `app.users_v`, writes are docperm-denied (resolves C9.4, C13)

`tabUser` (`20260620030000_user_identity.sql`) is keyed by **email** and is a **different row set** from
`public.users` (keyed by u178). Keeping both is two identities. The deeper principle the Round-3 critique
(C13) surfaced: **the engine does NOT own user identity — the CRM/auth system does. One entity, one home.**
So the engine's `User` doctype is a **read-only projection**, never a write target.

**The C13 blocker (why Rev-3's recommended sub-option (i) was unsound).** Rev-3 recommended pointing the
`User` doctype's `meta.table` at the live `app.users_v` view. But the engine's write path is **unconditional
and has no read-only-doctype concept**: `handler.js` (POST `/User` → `createDoc`; POST `/User/<name>` →
`updateDoc`) → `service.js:createDoc/updateDoc` → `document.js:insert()/save()` →
`store.insert/update(this.meta.table, …)`. Nothing gates a doctype shut by table. And `app.users_v`
(`20260624141500:194-207`) is `security_invoker`, **`GRANT SELECT` only** — no INSTEAD OF triggers, no
service-role write grant — and the engine emits Frappe framework columns (`docstatus/idx/modified/creation`)
that **do not exist on `public.users`**. So sub-option (i) breaks **every** User write (permission-denied,
then column-does-not-exist). Sub-options (i) and (ii) are therefore **withdrawn**.

**Decision (the fix): the `User` doctype is READ-ONLY.**

- **Reads** resolve via `app.users_v`. `identity.js` is rewritten as `resolveActorToCtx(app_user_id, store)`:
  read `app.users_v` by `id = app_user_id` (the claim), **not** `store.get('tabUser', email)`. The ctx's
  `appUserId = id`, `user = email` (display), `roles` derived from `role` (§A.6), `unrestricted` from
  `app.is_admin()` semantics (`role='admin' OR branch='All'`). `tabUser` is **retired as the canonical
  actor table** — it is no longer the identity source.
- **Writes are denied at the docperm level.** The `User` doctype's docperm grants **no** `create`/`write`/
  `submit`/`cancel`/`delete` row. The engine's existing op gate then returns **403 before the store is ever
  touched** — verified in code:
  - `createDoc` (`src/api/service.js:33`) calls **`assertCan(ctx, doctype, 'create')` as its first
    statement, before** `newDoc(...).insert()` (`service.js:36-37`). `assertCan` (`permissions.js:72-76`)
    throws `PermissionError` when `can()` is false, and `can()` (`permissions.js:57-62`) is false when no
    docperm row grants `create` (`hasPlainGrant`/`hasOwnerGrant` both false). `PermissionError → HTTP 403`
    (`handler.js:16` `statusFor`). **The store is never reached.**
  - `updateDoc` (`service.js:59`), `submitDoc` (`service.js:72`), `cancelDoc` (`service.js:84`),
    `transitionDoc` (`service.js:100`) each call **`assertCanMutate(ctx, doctype, …)` first, before**
    `loadInScope`/`d.save()`. `assertCanMutate` (`permissions.js:86-90`) throws `PermissionError` (→ 403)
    when the ctx holds neither a plain nor an owner grant for the op. **No store write is attempted.**
  - There is **no DELETE** entry point in the handler (`handler.js` dispatches only GET/POST; any other
    method → 405), so the only mutating paths are the five gated calls above. A deny-all `User` docperm
    closes every one of them at the gate.
- **User provisioning stays the CRM mint, not a doctype write.** Any user the engine needs created/updated
  goes through the existing `provisionSupabaseUser(email)` chokepoint in
  `api/_lib/supabase-session.js` (idempotent) — the CRM/auth system's single write home — **never** a
  `POST /User`. This is the "one entity, one home" boundary the Prime Directive requires.

**No current engine feature depends on writing `User` (greenfield, confirmed).** The only `tabUser` writes
in the tree are `*.test.js` seed helpers; there is **no production caller** doing `createDoc('User')`/
`updateDoc('User')`. So denying User writes removes a *capability that was never exercised*, not a feature.
(If a future slice genuinely needs an engine-internal Frappe-shaped writable User projection, that is a
*new* design decision — re-open it then with an explicit writable `tabUser` synced from `public.users`,
reads via `app.users_v`; do **not** make `app.users_v` itself writable.)

- **Open question (stated):** whether the engine's other tables that today FK/Link to `tabUser.name`
  (none in slice-1 Customer) must re-point to the u178 id. Resolve per-doctype during each slice; the
  back-fill (§A.4) already converts `owner`. `tabHasRole` disposition: see §A.6.

### A.6 Role model — scalar `app_role` vs multi-role `tabHasRole` (resolves C9.2, the role mismatch)

The platform's role is **scalar** (`public.users.role`, surfaced live by `app.user_role()` and
`app.is_admin()`). The engine's `tabHasRole` is **multi-role** (`identity.js:32` reads N role rows).
This is a confirmed model mismatch. Resolution:

- **Admin / `unrestricted` maps to `app.is_admin()`** — the single live definition (`role='admin' OR
  branch='All'`). The engine's `applyScopePolicy(roles).includes('admin')` (`identity.js:13`) is
  replaced for the **unrestricted** decision by the `app.is_admin()` semantics computed from the
  `app.users_v` row (`role === 'admin' || branch === 'All'`). RLS uses `app.is_admin()` directly; the
  engine ctx mirrors it so `queryConditions` and RLS agree.
- **`tabHasRole` is kept engine-internal (NOT retired, NOT the identity source).** Frappe docperm is
  genuinely multi-role and the engine's `getDocPerms()`/`can()` machinery
  (`permissions.js:18,37,96`) needs a role **set**, which a scalar `public.users.role` cannot express.
  So: the **scalar `app_role`/`public.users.role` seeds the engine's role set** (the primary org role),
  and `tabHasRole` remains the engine-internal store of *additional* doctype-permission roles where a
  user needs more than their org role. For slice-1 Customer the role set is `[public.users.role]` (plus
  admin → unrestricted via `app.is_admin()`); richer multi-role assignment is **deferred** until a
  doctype actually needs it (YAGNI). *Decision: defer multi-role, keep `tabHasRole` engine-internal,
  do not block slice 1 on it.*

### A.7 The test client — the *sole* RLS coverage, outside the Store hierarchy (carries C2)

`scripts/rls-probe.mjs` is a raw `supabase-js` client using `SUPABASE_ANON_KEY` that **mints a real
session through the shared `supabase-session.js` chokepoint** (`provisionSupabaseUser` +
`mintSupabaseTokenHash` → `verifyOtp`) so it carries a **real JWT with `app_user_id`+`app_role`
claims**, then probes `tabCustomer`. It is the **only** RLS coverage and lives **outside**
`src/runtime/*-store.js` (the engine has no anon client by construction — Least Privilege). This makes
Contract §6.3 satisfiable: the positive case is now testable **because the JWT carries `app_user_id`
and the helper reads state live**. **Service-role bypasses RLS and would mask a broken policy — the
parity test MUST run under the anon/auth JWT** (per `engine-auth-platform-implementation.md` §3).

### A.8 Honest defense-in-depth framing (carries C3)

RLS and `queryConditions` protect **disjoint caller sets**:

- **Engine callers** run `queryConditions`; they use service-role and **bypass RLS** — a
  `queryConditions` bug leaks rows in prod *and* tests with **no DB net** under it.
- **Non-engine callers** never run `queryConditions` (engine-internal JS); their **only** protection is
  the RLS `app.can_read_doc` policy.

They are **not** a cross-check on the same request. The planner must not assume an engine-path
`queryConditions` regression is caught by RLS — it is not. (Engine-path `queryConditions` coverage
stays a JS unit-test concern.)

---

## §B. Slice-1 Postgres constraint wins — emitted from the same meta (resolves C6, C7; carries C10/C11)

**DRY / one-entity-one-home stance:** a `reqd`/`unique`/Link rule lives in the **meta rows** — the
single source of truth. From those *same* rows we derive **two outputs**: (1) the JS validator
(`validateAgainstMeta`/`validateLinks`) gives the **friendly, field-level message**; (2) the DDL
emitter emits a **DB constraint** as the **fail-fast / least-privilege net** for non-engine writers and
concurrency races. The constraint is **emitted from the meta, not authored a second time** — not a DRY
violation. Same shape the CRM uses (`stock_items.on_hand` trigger-derived).

### B.1 FK from `Link` (closes the `validateLinks` TOCTOU race; C10 ordering guard)

`validateLinks` (`links.js:37`) does a read-then-write existence check (TOCTOU). `ddl.js` emits, for
each `Link` field with a registered, **non-stub** target whose **table already exists**:

```
constraint fk_<table>_<fieldname>
  foreign key (<fieldname>) references "<target.table>"(name)
  on delete restrict deferrable initially deferred
```

- **C10 ordering guard (NEW).** "Registered + non-stub" is necessary but **not sufficient**: a Link to
  a target whose **table has not been emitted/migrated yet** would reference a non-existent table and
  fail at `db push`. So FK emission moves to a **later `alter table … add constraint` pass** (after all
  tables in the migration are created), or table creation is **topologically ordered**. Self-referential
  Links are fine with the deferrable FK but are explicitly called out. **Slice-1 Customer has no
  outbound Link FK** (its fields are plain text/numeric) → slice 1 is safe; the guard is **mandatory
  before any multi-doctype slice.**
- **Stub / soft-link targets** (`links.js:43-44`): **omit the FK** (no table to reference), mirroring
  `validateLinks`' own skip conditions.
- `validateLinks` **stays** as the friendly-error path; PG 23503 → `ValidationError` at the handler.

### B.2 UNIQUE from the `unique` flag (C6; C11 populated-table guard)

`unique` is written to `tabDocField` (`installer.js:129`) and enforced **only** in JS today. `ddl.js`
emits, per `unique` field:

```
create unique index if not exists uq_<table>_<fieldname> on "<table>" (<fieldname>);
```

- **C11 guard (NEW).** `create unique index if not exists` is idempotent against **re-runs** but **not**
  against **existing duplicate rows** — on an already-populated field with dupes it **aborts the
  migration**. So adding UNIQUE to a populated field requires a **dedup precheck** first. `tabCustomer`
  is freshly proven → slice 1 safe; flag for any later doctype migration.
- `validateAgainstMeta` keeps the friendly message; PG 23505 → `ValidationError`.

### B.3 Standard stamping trigger (resolves C7; C12 confirmed benign)

One doctype-agnostic trigger function + a per-table trigger:

```sql
create or replace function set_doc_stamps() returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT') then new.creation := coalesce(new.creation, now()); end if;
  new.modified := now();          -- AUTHORITATIVE (always wins; engine JS stamp is redundant-but-harmless)
  return new;
end; $$;
-- per emitted table:
create trigger trg_<table>_stamps before insert or update on "<table>"
  for each row execute function set_doc_stamps();
```

Function created **once** (slice-1 / meta migration); each emitted table gets the `create trigger` line
from `ddl.js`. **C12 (round-2, confirmed harmless):** `coalesce(new.creation, now())` preserves the
engine `creation`; `modified := now()` overrides; both serialise to `timestamptz`; the only divergence
is request-latency on `modified` — cosmetic, trigger-authoritative is correct.

### B.4 Deferred constraints (C6, with reasons — not silently dropped)

- **`NOT NULL` from `reqd`** — **deferred.** `reqd` interacts with `fetchFrom`-populated fields and
  `dependsOn`/`mandatoryDependsOn` conditional-required (`validate.js:20`). A blunt column `NOT NULL`
  would reject a row whose required field is satisfied conditionally/by fetch. Per-field analysis is
  not no-regret. JS `validateAgainstMeta` remains the enforcer.
- **`CHECK` from `Select.options`** — **deferred.** Options live in meta and change without a migration;
  a `CHECK` would need re-emission per option edit, fighting meta-as-data. JS keeps it.

### ddl.js emission summary (what changes)

`createTableSql` / `alterColumnsSql` gain, **derived from the field's meta**: a UNIQUE index per
`unique` field (with the C11 populated-table caveat); an FK per non-stub registered Link target emitted
in a **later constraint pass** with the C10 target-exists guard; and a `create trigger` line per table
referencing the shared `set_doc_stamps()`. No new *authored* rules.

---

## Schema tooling — DDL emitter, not Drizzle (unchanged from Rev 1)

**No Drizzle.** The `tabDocType`/`tabDocField` meta rows are the schema source of truth; `ddl.js` +
`Installer.emitMigration()` emit `supabase/migrations/<ts>_<slug>.sql`. Hand-written SQL is reserved
for the meta bootstrap tables, the **RLS policies** (§A, never Drizzle-generated), the **stamping
trigger function** (§B.3, authored once), and the **`tabDocType` permission-meta columns** (§A.3). The
**`app.*` scope helpers and the hook are LIVE platform objects the engine consumes, not engine-authored**
(`20260624141500` + `20260623130000`). Business doctype tables — now *with* FK/UNIQUE/trigger and an
emitted RLS policy — are emitted from meta.

## Rejected / deferred

- **PostgREST auto-API as the API** — rejected; keep the custom handler (docstatus/workflow live there).
- **Business logic in Postgres functions** — rejected; entity logic stays in the DocType module.
- **TS `QueryData` inference** — rejected; conflicts with the no-`.ts`-source rule.
- **`NOT NULL`/`CHECK` constraint emission in slice 1** — deferred with reasons (§B.4).
- **Re-implementing the CRM's owner/state/admin scoping in engine SQL** — rejected; consume the LIVE
  `app.can_read_doc`/`app.is_admin`/`app.state_in_scope` helpers (one shared definition).
- **`signInWithIdToken` mint path** — rejected; the shipped chokepoint is cookie→token_hash→verifyOtp
  (`supabase-session.js`). Rev-2's `signInWithIdToken` claim was wrong.
- **Multi-actor (installer/customer) engine RLS** — out of scope (§A.1); separate cross-app design.
- **A scalar `branch` JWT claim** — rejected; cannot carry the multi-state `service_states` ceiling;
  state is read live in the SECURITY DEFINER helpers (K7).
- **A synced-copy `tabUser` as a second identity** — rejected; map `User` onto `public.users` via
  `app.users_v` (§A.5).

## First slice — prove it on the **Customer** doctype (revised per C9, C8)

`Customer` is already proven as data (`scripts/prove-customer-as-data.mjs`; `tabCustomer` at
`20260620000001_customer.sql`). The slice extends it end-to-end:

1. **GoTrue identity + owner stamping + team-visible RLS on `tabCustomer`.**
   - Stamp `owner = ctx.appUserId` (u178 id), carried by `resolveActorToCtx` reading `app.users_v`
     (§A.4/§A.5); switch `queryConditions`' owner filter to `ctx.appUserId`.
   - Back-fill existing email-keyed `owner` rows to u178 ids (§A.4).
   - Author the named **`tabCustomer_read` policy = `USING (true)` for authenticated** (team-visible
     reference master — §A.3 reasoning) + the `service_role using(true)` policy; record
     `rls_policy_name`/`permission_intent` on the DocType row.
   - **Acceptance (now satisfiable against the LIVE helpers — C9 closed):** via `scripts/rls-probe.mjs`,
     a `public.users` actor signed in through `supabase-session.js` (real `app_user_id` claim) **reads
     `tabCustomer` rows**; an **anon** client (no `app_user_id`) reads **zero**; the engine's
     service-role path is unaffected. (For an `if_owner`-scoped doctype later, the same probe proves a
     non-owner reads zero via `app.can_read_doc(owner, NULL)`.) **The probe runs under the anon/auth JWT
     — service-role would mask a broken policy.**
2. **PostgREST embedding read — parity with `loadDoc`'s `getChildren` assembly** (per C8). The target is
   `loadDoc`'s per-child-field `getChildren` round-trips (`document.js:194-197`), **not** `fetch_from`.
   **Precondition (C8):** child embedding needs a real FK; child rows link by the generic
   `parent`/`parenttype`/`parentfield` triple with **no FK**. So slice 1 emits a **`parent` FK** on the
   child table (with the §B.1 C10 ordering guard) **or**, if Customer has no FK'd child, demonstrates
   embedding on a **`Link` FK** read instead — and inventories which slice-1 read benefits. If neither
   is demonstrable on Customer, embedding **drops to "later"** and slice 1 ships identity/RLS +
   constraint wins only.
3. **Realtime smoke** — subscribe to `tabCustomer` changes; confirm a CDC event fires on update. Gate
   the publication with the **same** read policy (the subscription gate == the read gate, per
   `engine-auth-platform-implementation.md` §C2 template); `app.current_uid()` is documented to work in
   the Realtime context (reads `request.jwt.claims`, not `auth.jwt()`) — confirm on first use. Smoke only.

A migration accompanies each schema change (full-timestamp, idempotent, rollback comment) and goes in
**`spartancrm/supabase/migrations/`** — the single source of truth for the shared project.

## §README-vs-Contract reconciliation (completed per Rev-2 critique — carried forward unchanged)

Amend the Contract (§10) to make the runtime meta-as-data engine canon, **keeping §6's
hand-written-RLS rule** (this ADR honours it). Clauses to fix:

- **§2.1** — "Drizzle schema emitted / Drizzle Kit owns diffing" → "the DocType DDL emitter
  (`ddl.js` + `Installer.emitMigration`) owns emission/diffing from the meta rows."
- **§2.3** — restate the connection rule as the engine's **two** stores: `PgStore` (direct-PG pooler,
  `DATABASE_URL_POOLER`, `:6543`) **and** `SupabaseStore` (PostgREST, service-role).
- **§2.4** — "No raw SQL strings for entity reads/writes / go through Drizzle" would **fail the entire
  `PgStore`** (`this.sql.unsafe(...)`, `pg-store.js`). Re-bless the Store layer's **parameterised** SQL
  (positional params, never interpolated values); keep the lint flagging raw template-literal SQL
  **outside** the Store/migrations/RLS dirs.
- **§3.4** — "query types from Drizzle inference" → drop (generic `Document` is string-keyed, JSDoc-typed).
- **§4.1 (O1 RESOLVED).** "Zod is the only validation mechanism" is **false**. Zod validates **def
  structure** (`def-schema.js:assertValidDef`) and **request envelopes** (`request-schemas.js`); entity
  data is hand-rolled meta-driven JS (`validate.js:validateAgainstMeta`, `links.js:validateLinks`).
  Amend §4.1 accordingly.
- **§8.3** — acknowledge the generic engine + emitter as the chosen architecture.
- **Accuracy note:** `installer.js:migrate` *can* execute DDL directly via `opts.admin` (PgAdmin). So
  "the Installer NEVER executes DDL" is true only for the **emit** path; the amendment should say "the
  Installer emits DDL to a migration file on the human `db push` path, and executes DDL **only** via the
  explicit admin/CLI path."

## §Doc-cleanup task (C5 — no design work, flagged for implementer)

`next_series` is **already atomic** (`20260620020000_next_series_fn.sql:4-13`). The stale "NOT atomic"
comments in `supabase-store.js:9-13` and `naming.js:31-36` describe a done state as not-done.
Implementer corrects the comments. **No naming work.**

## Consequences

- **Positive:** the shared prod DB gains *real* row security for non-engine access because identity
  flows through GoTrue and the engine consumes the **one** live `app.can_read_doc` predicate (CRM +
  engine share one enforcement definition — a future platform fix propagates for free); FK closes the
  `validateLinks` TOCTOU race; UNIQUE closes the field-uniqueness race; the stamping trigger keeps audit
  fields correct for non-engine writers; child/Link reads can embed in one round-trip; the floor gains a
  live transport — all without rewriting the engine core or its API.
- **Cost / boundaries to keep straight:**
  - **Two keys** (service-role for the engine; anon/auth elsewhere) — §A.2 is the source of truth.
  - **Disjoint guard sets (C3):** an engine-path `queryConditions` bug has **no** DB backstop. Keep
    `queryConditions` unit-tested in JS.
  - **`public.users`-only scope (C1):** installers/customers are denied by construction; multi-actor RLS
    is a separate cross-app design.
  - **Owner-keyspace migration (C9):** `owner` becomes the u178 id; existing email-keyed rows back-fill.
    The engine's `User` doctype maps onto `public.users` via `app.users_v` (`tabUser` retired as the
    identity source).
  - **Role-model gap (C9.2):** scalar `app_role` seeds the engine role set; multi-role `tabHasRole`
    kept engine-internal, multi-role assignment deferred (YAGNI). Admin = `app.is_admin()`.
  - **Dual *expression* of one rule (DRY):** each `unique`/Link rule has a JS message *and* a DB
    constraint — both **emitted from one meta source**. Accepted for the integrity bought.
  - Every doctype owes an emitted RLS policy + the §A.7 probe test (Contract §6.3).
  - **Dependency on LIVE platform objects:** the engine consumes `app.can_read_doc`/`app.is_admin`/
    `app.state_in_scope`/`app.users_v` (all live) and the shared hook + `supabase-session.js` mint.
    `app.claims_version()` = `'2026-06-23.app_user_id+app_role'` is the change sentinel the engine asserts
    against to detect a claim-shape change.
- **Must resolve before build:** the Contract amendments (§2.1/§2.3/§2.4/§3.4/§4.1/§8.3); formal
  ratification of the §A.1 `public.users`-only scope. (§A.5 is now **decided** — `User` is read-only,
  writes docperm-denied — and no longer a planner pick; Rev-3.1/C13.)

## Open questions for critique / planner

- **Engine project vs shared project (A.4).** Does the engine cut over to the shared prod
  `sedpmsgiscowohpqdjza` (where the hook + helpers + `public.users` u178 ids live), or stay on its
  isolated project (requiring the hook + helpers + u178 ids be seeded there)? Slice-1 acceptance runs on
  whichever project carries the live hook + helpers. Planner decision; not a design blocker.
- **`User` doctype mapping (A.5) — RESOLVED in Rev-3.1 (C13).** Decided, not a planner pick: the `User`
  doctype is **read-only** (reads via `app.users_v`; create/write/delete docperm-denied so `assertCan`/
  `assertCanMutate` 403 before the store). Provisioning stays the CRM `provisionSupabaseUser` mint. The
  earlier sub-option (i)/(ii) framing is withdrawn (sub-option (i) broke every User write — view is
  SELECT-only). No open question remains here.
- **Embedding demonstrability on Customer (C8).** Whether `tabCustomer` has an FK'd child to embed in
  slice 1, or step 2 demonstrates on a Link-FK read — resolved during slice-1 inventory.
- **Multi-role need (A.6).** When a doctype first needs more than the scalar org role, `tabHasRole`
  multi-role assignment is un-deferred. No slice-1 trigger.
