# Work Order: Supabase-native features (slice-1 Customer, end-to-end)

- **Planner:** planner
- **Date:** 2026-06-24
- **Source design:** `docs/adr-supabase-native-features.md` **Rev 3.1** (§A identity, §B constraint emission, "First slice — Customer")
- **Critique:** `docs/critique-supabase-native-features.md` — **PASS** (C1–C15 resolved/accepted; C13 read-only-User decided, C14 orphan-count folded, C8/A.6 left as planner-scoped)
- **Engine repo:** `C:\Users\parrg\Documents\spartan-erp-engine` (plain JS/ESM, Vercel + Supabase, no build step)
- **House-format precedent:** `docs/workorder-meta-as-data.md`
- **Invariant for the whole build:** `npx vitest run` stays green. New behaviour ships behind the contracts below; no consumer signature in `service.js`/`permissions.js`/`handler.js` changes shape.

---

## ★ COMPOSITION VERDICT: **GO**

The slice composes: interfaces line up, no cycles, the emitted RLS is a faithful projection of the
docperm/`scope_fields` meta the engine already reads, and the acceptance test is runnable against the
**LIVE** helpers once the cutover prerequisite (Unit 0) is satisfied. One contract decision had to be
frozen by the planner (the `territory`-vs-state-column ambiguity, see **Unit 4 / FROZEN-RULE**); it is a
sequencing/contract freeze, **not** a design hole, so it is resolved here rather than bounced.

### Cutover decision: **(A) — engine cuts over to the shared prod project `sedpmsgiscowohpqdjza`.**

**Why A, grounded against the probe (not assumed):**
- The engine today points at an **isolated** project: `.env` `SUPABASE_URL=https://hzcjbaktwofrhefrytln.supabase.co`,
  `supabase/.temp/project-ref = hzcjbaktwofrhefrytln`, `config.toml project_id = "spartan-erp-engine"`.
  This is **NOT** the shared prod `sedpmsgiscowohpqdjza`.
- The live `app.*` scope helpers (`20260624141500`), the `custom_access_token_hook`
  (`20260623130000`), `public.users` with u178 ids + `app_user_id`/`app_role` claims, and the
  `provisionSupabaseUser`/`mintSupabaseTokenHash` mint chokepoint (`api/_lib/supabase-session.js`, default
  URL `https://sedpmsgiscowohpqdjza.supabase.co`) **all live only on the shared project.**
- The ADR's identity stance is decisive: *"the engine does NOT own user identity — the CRM/auth system
  does. One entity, one home"* (§A.5/C13). Seeding option B would require **replicating** the hook + all
  seven `app.*` objects + a `public.users` stand-in **with matching u178 ids** + a claims-injecting harness
  into the isolated project, and then keeping them in sync forever — a second identity home, the exact
  thing C13 forbids. Option B also can't validate against the *real* `service_states` ceiling the live
  helper reads. The owner-keyspace back-fill (§A.4) further *assumes* "the engine's isolated dev project
  and the shared prod project use the **same** `public.users.id` space once the engine cuts over" — i.e.
  the ADR already presumes cutover.
- **A is therefore the only option that honours the design.** B is rejected as a second identity home.

**A is cleanly achievable (no NO-GO):** the engine's stores are env-driven
(`SupabaseStore.fromEnv()` reads `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`; `PgStore` reads
`DATABASE_URL_POOLER`). Cutover is a **config + migration-home** change, not a code rewrite. The shared
project already carries the helpers; the engine just needs its env re-pointed and its slice-1 tables +
policies migrated **into `spartancrm/supabase/migrations/`** (the single shared migration home, per
SpartanCRM CLAUDE.md §🗄), then `db push`. Unit 0 below makes that the first work-unit and the gate for
everything after it.

> **Human-gated steps inside this work order** (CLAUDE.md §1/§7 — agents surface, never self-run):
> the env re-point on the engine's Vercel project, every `supabase db push`, and the `provisionSupabaseUser`
> mint against prod. Each is called out at its unit.

---

## 0. Frozen vocabulary (used by every contract below)

```js
// Ctx — extended. ADD appUserId; keep user (email, for display/logging).
{ user, appUserId, roles, scopes, unrestricted }
//   user        : email (display/logging only — NO LONGER the owner-stamp source)
//   appUserId   : public.users.id  (the u178… text id from app.users_v / the app_user_id claim)
//   roles       : string[]  (seeded from the scalar public.users.role; admin via app.is_admin semantics)
//   scopes      : { <scopeField>: value }  (queryConditions row-scope; UNCHANGED mechanism)
//   unrestricted: boolean  (mirrors app.is_admin(): role==='admin' || branch==='All')

// UsersVRow — the app.users_v column set the engine depends on (FROZEN by 20260624141500:194-207)
{ id, email, role, branch, service_states, active, auth_user_id }

// CustomerDef — the slice-1 def (from scripts/prove-customer-as-data.mjs, carried as-is EXCEPT
// the RLS-intent metadata added in Unit 4). DO NOT change its fields/permissions shape.
{
  doctype: 'Customer', autoname: 'CUST-.#####', scopeFields: ['territory'],
  fields: [ customer_name(Data,reqd,pl0), territory(Data,pl0), email(Data,pl0), credit_limit(Currency,pl1) ],
  permissions: [ admin/pl0 RWCD, admin/pl1 RW, sales/pl0 RWC ],
  // ADDED in Unit 4: rlsPolicyName, permissionIntent, rlsStateColumn (null for Customer)
}
```

**FROZEN-RULE (the composition pivot the planner resolved):**
`CustomerDef.scopeFields = ['territory']` drives the engine's **JS `queryConditions`** row-scope
(unchanged). It must **NOT** be confused with an RLS **state-scope column**. The ADR §A.3 is explicit:
`tabCustomer` has no state/branch column, and `app.entity_state('customer',…)` deliberately returns NULL
(`20260623130000:83`). `territory` is a CRM territory, not a `service_states` state code. Therefore the
**RLS generator keys on a NEW, separate field — `rlsStateColumn`** (null for Customer) — **not** on
`scopeFields`. Customer → `rlsStateColumn = null` + plain read docperm → **`USING (true)`** (team-visible).
This keeps the two scopers (JS `queryConditions` on `scopeFields` vs RLS on `rlsStateColumn`) from
colliding. **Every doctype def gets `rlsStateColumn` (default null); the generator never reads
`scopeFields` for RLS.**

---

## Fan-out: this is a genuine multi-unit slice with shared frozen boundaries (identity ctx ↔ owner stamp ↔
queryConditions ↔ RLS policy ↔ acceptance test). Six work units; not over-ceremony.

---

## 1. Work units — dependency-ordered, each with a FROZEN contract

### Unit 0 — **Cutover prerequisite (PREREQUISITE; human-gated; blocks all others)**

**Goal:** establish that slice-1 builds where the live hook + `app.*` helpers + `public.users` u178 ids
already exist (decision A).

- **Tasks (agent prepares; human runs the gated steps):**
  1. Re-point the engine's Supabase env to the shared project: `SUPABASE_URL=https://sedpmsgiscowohpqdjza.supabase.co`,
     `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` (currently **empty** in `.env` — required for the
     Unit-5 anon probe), `DATABASE_URL_POOLER` for the shared project. On **Vercel** this is an env-var
     change on the engine project (**human-gated**).
  2. Relink the Supabase CLI: `supabase link --project-ref sedpmsgiscowohpqdjza` (replaces the
     `hzcjbaktwofrhefrytln` link). **Read-only confirm first:** `supabase migration list --linked`.
  3. **Migration home:** all slice-1 schema migrations (Units 3/4 SQL, the §A.4 back-fill, the meta-columns
     migration) are authored into **`spartancrm/supabase/migrations/`** (the shared single source of truth),
     **not** the engine repo's `supabase/migrations/`. Full-timestamp, idempotent, rollback comment.
  4. Assert the claim sentinel: the engine asserts `app.claims_version() === '2026-06-23.app_user_id+app_role'`
     at boot/probe (Consequences §). Add this assertion to the Unit-5 probe.
- **FROZEN:** after Unit 0, `SupabaseStore.fromEnv()` and `PgStore` resolve to `sedpmsgiscowohpqdjza`;
  `app.can_read_doc`/`app.is_admin`/`app.users_v`/the hook are reachable; the anon key is present.
- **vitest:** none (config/infra). **Verify:** `supabase migration list --linked` shows the shared history;
  a read-only `select app.claims_version();` via the pooler returns the frozen sentinel.
- **Done-criteria:** engine env + CLI point at `sedpmsgiscowohpqdjza`; `SUPABASE_ANON_KEY` populated;
  `app.claims_version()` returns the frozen string; **NO** slice-1 unit dispatched until this lands.
- **Assignment:** **lead** (config + the human-gated env/link). **This is the gate.**

> **PREREQUISITE CONFIRMATION NEEDED (flagged):** Unit 0 step 1/2 are human-gated (env re-point + relink to
> prod). The planner cannot self-run them. If the human declines the cutover, the slice falls back to option
> B (seed the helpers into the isolated project) — which the ADR/C13 reject as a second identity home, so a
> decline should bounce to `architect`, not be worked around here.

---

### Unit 1 — **Identity / context: owner keyed on `app_user_id`** (depends on Unit 0)

**Files:** `src/perms/context.js`, `src/perms/identity.js`, `src/api/context-from-request.js`,
`src/api/service.js`, `src/perms/permissions.js`; back-fill migration in `spartancrm/supabase/migrations/`.

**Frozen contract:**
- `context.js makeContext({ user, appUserId, roles, scopes, unrestricted })` — **adds `appUserId`**;
  `SYSTEM`/`GUEST` get `appUserId: null` (system/guest own nothing in the u178 keyspace).
- **NEW** `identity.js resolveActorToCtx(appUserId, store): Promise<Ctx>` — reads `app.users_v` **by id**
  (`store.get('app.users_v'-equivalent)` → use a raw `store.list('app.users_v',{filters:{id:appUserId}})`
  or a dedicated read; **must not** call `service.js`/`getDoc`, per the N5 rule already in `identity.js`).
  Sets `appUserId = row.id`, `user = row.email`, `roles = [row.role]` (scalar org role; §A.6),
  `unrestricted = (row.role === 'admin' || row.branch === 'All')` (mirrors `app.is_admin()`),
  `scopes` from `row.branch` as today. Throws `AuthError` if no row or `active === false`.
  `resolveUserToCtx(email,…)` (the Google-JWT transition path) **stays** but must also populate
  `appUserId` (resolve the email → `app.users_v.id`); a ctx without `appUserId` must never reach owner-stamp.
- `context-from-request.js ctxFromRequest` — the Supabase-bearer branch: verify `iss == Supabase auth URL`
  against Supabase JWKS, read `app_user_id` + `app_role` claims, call `resolveActorToCtx(app_user_id, store)`.
  The existing Google-JWKS branch stays as the transition path (calls the `appUserId`-populating
  `resolveUserToCtx`). **FROZEN:** `ctxFromRequest(req, store)` signature unchanged.
- **Owner stamp** — `service.js:34` becomes `const doc = { ...payload, owner: ctx.appUserId };`
  (was `ctx.user`). **FROZEN.**
- **queryConditions owner filter** — `permissions.js:155` `filter.owner = ctx.appUserId` (was `ctx.user`).
  The `can()` owner check `permissions.js:60` `doc.owner === ctx.appUserId` (was `ctx.user`). **FROZEN** —
  the engine's primary enforcer and the DB backstop now agree on keyspace (u178).
- **Back-fill (§A.4; idempotent; in `spartancrm/supabase/migrations/`):** map each existing
  `tab*.owner`/`tabUser.name` email → `public.users.id` via `app.users_v` join on `lower(email)`; UPDATE
  `owner` to the u178 id. **C14:** `RAISE NOTICE` the count of unmatched (orphan) owners.
  Re-runnable (u178-valued owners no longer match the email-join → no-op). Optional `owner_email_legacy`
  column for one release. **Greenfield note:** on the shared prod project every actor is a `public.users`
  row, so orphan count is expected ~0; the count is specced regardless (fail-loud).

**vitest:** `src/perms/identity.test.js` (extend) + `src/api/service.test.js` (extend).
- `resolveActorToCtx('u178…', store)` → ctx with `appUserId==='u178…'`, `user===email`,
  `roles===[role]`, `unrestricted` true for admin/`branch==='All'`, throws `AuthError` on missing/inactive.
- `createDoc` stamps `owner === ctx.appUserId` (NOT the email) — assert against a fake ctx with distinct
  `user`/`appUserId`.
- `queryConditions` owner filter (if_owner-only read grant) emits `{ owner: ctx.appUserId }`.
- Back-fill migration tested at Unit-5 live-verify (orphan count surfaced); a unit-level SQL fixture test
  is optional.

**Done-criteria:** ctx carries `appUserId`; owner stamped from it; `queryConditions`/`can()` owner checks
key on it; `resolveActorToCtx` reads `app.users_v` by id; existing `service.test.js`/`identity.test.js`
green after the keyspace switch (update fixtures to set `appUserId`).

**Assignment:** **Specialist 1 (identity).**

---

### Unit 2 — **User doctype READ-ONLY (writes docperm-denied)** (depends on Unit 1)

**Files:** the `User` doctype def / its docperm rows (seeded via `Installer.syncDoctype` or boot meta);
`src/perms/identity.js` (the resolve already lands in Unit 1 — this unit owns the **deny** contract + test).

**Frozen contract (C13 — decided, not a pick):**
- The `User` doctype's docperm grants **no** `create`/`write`/`submit`/`cancel`/`delete` row (a
  read-only-projection docperm). Reads resolve via `app.users_v` (Unit 1's `resolveActorToCtx`), **not**
  `store.get('tabUser', email)`.
- **Verified gate (no new code needed — the existing gate suffices):** `createDoc` calls
  `assertCan(ctx,'User','create')` first (`service.js:33`); `updateDoc`/`submitDoc`/`cancelDoc`/`transitionDoc`
  call `assertCanMutate(ctx,'User',…)` first (`service.js:59/72/84/100`). With no granting docperm,
  `hasPlainGrant`/`hasOwnerGrant` are both false (`permissions.js:16-40`), `can()` is false
  (`permissions.js:57-62`), `assertCan`/`assertCanMutate` throw `PermissionError` (`permissions.js:72/86`)
  → **403 before the store** (`handler.js statusFor`). No DELETE entry point exists in `handler.js`.
- User provisioning stays the CRM `provisionSupabaseUser(email)` mint — **never** a `POST /User`.
- **FROZEN:** no engine code path may write `User`. `app.users_v` stays SELECT-only (do not make it writable).

**vitest:** `src/meta/user-meta.test.js` (extend) / a new `src/perms/user-readonly.test.js`.
- With a User docperm that grants only `read`, `createDoc(ctx,'User',…)` throws `PermissionError`
  (assert 403 mapping), and the **store is never called** (spy/mock store `insert` asserted not-called).
- Same for `updateDoc`/`submitDoc`/`cancelDoc`/`transitionDoc` on `User`.
- A read path resolves a User via `app.users_v` by id (covered in Unit 1; cross-referenced here).

**Done-criteria:** every mutating entry point 403s on `User` before the store; reads go through
`app.users_v`; no production caller does `createDoc('User')`/`updateDoc('User')` (greenfield-confirmed —
only `*.test.js` seed helpers reference `tabUser`; those migrate to seeding `public.users`/`app.users_v`
fixtures or are dropped).

**Assignment:** **Specialist 2 (perms/User).** Small — can be folded into Specialist 1 if the lead prefers
3 specialists over 4 (Unit 1+2 share `identity.js`/`permissions.js`).

---

### Unit 3 — **DDL constraint emission (FK + UNIQUE + stamping trigger)** (depends on Unit 0; parallel with 1/2)

**Files:** `src/meta/ddl.js`, `src/meta/installer.js`; the stamping-trigger function migration +
Customer's emitted constraints in `spartancrm/supabase/migrations/`.

**Frozen contract (§B):**
- **FK from `Link` (§B.1, C10 guard):** for each `Link` field with a registered **non-stub** target,
  emit `constraint fk_<table>_<field> foreign key (<field>) references "<target.table>"(name) on delete
  restrict deferrable initially deferred`. **C10:** FK emission moves to a **later `alter table … add
  constraint` pass** (after all slice tables are created) OR table creation is topologically ordered — the
  guard (target-table-exists) **must exist in code** even though **slice-1 Customer has no outbound Link FK**
  (its fields are plain Data/Currency) so it emits **zero FKs**. Stub/soft-link targets → omit FK.
- **UNIQUE from `unique` flag (§B.2, C11 guard):** per `unique` field emit
  `create unique index if not exists uq_<table>_<field> on "<table>" (<field>);`. **C11:** adding UNIQUE to
  an already-populated field needs a **dedup precheck** first (else `create unique index` aborts the
  migration); the precheck **must exist in code**. `tabCustomer` has **no `unique` field** in `CustomerDef`
  → emits zero UNIQUE indexes in slice 1; the guard is exercised by a unit test, not by Customer.
- **Stamping trigger (§B.3, C12 benign):** create the doctype-agnostic
  `set_doc_stamps()` function **once** (its own migration). `ddl.js createTableSql`/`alterColumnsSql` append a
  `create trigger trg_<table>_stamps before insert or update on "<table>" for each row execute function
  set_doc_stamps();` line per emitted table. For `tabCustomer` (table already exists), emit the trigger via
  an `alter`/`create trigger` migration.
- **FROZEN:** `createTableSql(def)` / `alterColumnsSql(def, existingCols)` / `pgTypeFor(field)` signatures
  unchanged; additions are derived **from the field's meta**, no new *authored* rule. Pure (no I/O).

**vitest:** `src/meta/ddl.test.js` (extend).
- A def with a `unique` field → `createTableSql` (or a new `constraintsSql`) contains
  `create unique index if not exists uq_…`; a def with a `Link` field to a registered non-stub target →
  emits the FK in the **later constraint pass**; a Link to a **not-yet-emitted** target → guard suppresses
  the FK (or orders creation) and does **not** emit a dangling reference; every emitted table gets the
  `trg_<table>_stamps` line. `CustomerDef` → **no FK, no UNIQUE**, trigger line present.
- C11: a dedup-precheck helper exists and is asserted (e.g. emits/returns a precheck for a populated UNIQUE).
- Pure: no fs/DB touched (assert via the existing pure-function pattern).

**Done-criteria:** ddl.js emits FK (guarded), UNIQUE (guarded), and the per-table trigger from meta;
Customer's emitted SQL is `USING (true)`-compatible (no FK/UNIQUE, trigger present); the
`set_doc_stamps()` function migration authored once.

**Assignment:** **Specialist 3 (DDL).** Parallel with Units 1/2.

---

### Unit 4 — **RLS policy generator** (depends on Unit 3 for the emitter seam; Unit 1 for the owner keyspace)

**Files:** `src/meta/ddl.js` (or a sibling `src/meta/rls.js` — the SQL emitter seam), `src/meta/installer.js`
(carry the new meta columns onto the DocType row), a `tabDocType` meta-columns migration + Customer's RLS
policy migration in `spartancrm/supabase/migrations/`.

**Frozen contract (§A.3, with the FROZEN-RULE from §0):**
- **New `tabDocType` columns (C4):** `rls_policy_name text`, `permission_intent text`, **and**
  `rls_state_column text` (the planner-frozen separation — the RLS state-scope column, distinct from
  `scope_fields`; null when the doctype has no state column). Own idempotent `add column if not exists`
  migration; `installer.js:syncDoctype` carries `rlsPolicyName`/`permissionIntent`/`rlsStateColumn` onto the
  DocType row (one-line additions to the row builder at `installer.js:108-147`).
- **Generator rule (FROZEN — DRY projection of the same meta):**
  1. read docperm is **plain** (not if_owner-only) **AND** `rls_state_column` is null → emit
     **`USING (true)`** + a `service_role using(true) with check(true)` policy.
  2. `rls_state_column` is set → emit `using ( app.can_read_doc(owner, <rls_state_column>) )`.
  3. read docperm is **if_owner-only** (and `rls_state_column` null) → emit
     `using ( app.can_read_doc(owner, NULL) )` (owner-or-admin).
  Every policy table also gets the `service_role` policy + `alter table … enable row level security`.
  Bodies are **hand-written/generated SQL, never Drizzle** (Contract §6.1).
- **Customer resolves to rule (1):** read docperm is plain (admin pl0 read, sales pl0 read — no `if_owner`),
  `rls_state_column = null` → **`tabCustomer_read` = `USING (true)` for `authenticated`** + `tabCustomer_service`
  for `service_role`. `rls_policy_name='tabCustomer_read'`, `permission_intent='team-visible reference master'`,
  `rls_state_column=null`. **`scopeFields:['territory']` is NOT read by the generator** (FROZEN-RULE §0).

**vitest:** `src/meta/rls.test.js` (new) / `ddl.test.js`.
- plain-read + null state → `USING (true)` + service_role policy; `rls_state_column` set →
  `app.can_read_doc(owner, <col>)`; if_owner-only → `app.can_read_doc(owner, NULL)`.
- `CustomerDef` → exactly `tabCustomer_read USING (true)` + `tabCustomer_service`; assert the generator
  **does not** read `scopeFields` (a def with `scopeFields:['territory']` and `rls_state_column:null` still
  emits `USING (true)`).
- `installer.syncDoctype` writes `rls_policy_name`/`permission_intent`/`rls_state_column` (round-trip via
  MemoryStore + getMeta).

**Done-criteria:** the three-branch generator emits per the rule; Customer emits `USING (true)` +
service_role; the meta columns persist and load; no `scopeFields`→RLS coupling.

**Assignment:** **Specialist 3 (DDL)** (same owner as Unit 3 — shares the emitter seam) **or** a dedicated
**Specialist 4 (RLS)** if the lead wants the emitter and the policy generator built in parallel against a
frozen `ddl.js` export surface.

---

### Unit 5 — **Slice-1 acceptance test (RLS parity under a real JWT)** (depends on Units 0–4; human-gated push)

**Files:** `scripts/rls-probe.mjs` (new), reusing the CRM mint chokepoint.

**Frozen contract (§A.7 — the test is the sole RLS coverage, OUTSIDE the Store hierarchy):**
- A raw `@supabase/supabase-js` client using `SUPABASE_ANON_KEY` (populated in Unit 0).
- Mint a **real** session through the shared chokepoint: `provisionSupabaseUser(email)` +
  `mintSupabaseTokenHash(email)` → client `verifyOtp({ token_hash, type:'email' })` (NOT
  `signInWithIdToken` — that path is rejected, ADR Rejected §). The resulting JWT carries
  `app_user_id` + `app_role` (the hook).
- **Prove the Customer policy UNDER THAT JWT, never service-role (service-role bypasses RLS and would mask
  a broken policy — §A.7):**
  - a `public.users` actor (real `app_user_id`) **reads `tabCustomer` rows** (`USING (true)` → all rows).
  - an **anon** client (no `app_user_id`) reads **zero**.
  - assert `app.claims_version() === '2026-06-23.app_user_id+app_role'` (Unit 0 sentinel).
- Realtime smoke (§ First-slice step 3) is **optional** in slice 1; gate the publication with the same read
  policy if attempted. Embedding (step 2 / C8) — see **Open items** below; **out of slice-1 acceptance**.

**vitest:** the probe is a standalone `scripts/rls-probe.mjs` (run via `node --env-file=.env`), not a vitest
spec (it needs a live project + anon key). The lead runs it after the human pushes the migrations.

**Done-criteria:** authed `public.users` actor reads Customer rows; anon reads zero; service-role path
unaffected; claims sentinel matches; back-fill orphan count surfaced at `db push` and is ~0 on prod.

**Assignment:** **Specialist 5 (acceptance)** authors the probe; **lead** runs it post-push (human-gated).

---

## 2. Per-unit vitest + done-criteria (summary table)

| Unit | Spec file | Key assertions | Parallel group |
|---|---|---|---|
| 0 cutover | (none — infra) | `migration list --linked` = shared; `app.claims_version()` sentinel | **prereq (gate)** |
| 1 identity | `identity.test.js`, `service.test.js` (extend) | `resolveActorToCtx` reads `app.users_v` by id; owner stamped `ctx.appUserId`; queryConditions/can owner on `appUserId` | **W1 (after 0)** |
| 2 User read-only | `user-readonly.test.js` (new) | create/write/submit/cancel/transition on `User` → 403 before store; read via `app.users_v` | **W1 (after 1)** |
| 3 DDL | `ddl.test.js` (extend) | FK guarded (Customer: none); UNIQUE guarded (Customer: none); trigger line per table; pure | **W1 (after 0; ‖ 1/2)** |
| 4 RLS gen | `rls.test.js` (new) | 3-branch rule; Customer → `USING (true)`; ignores `scopeFields`; meta cols round-trip | **W2 (after 3; needs 1 keyspace)** |
| 5 acceptance | `scripts/rls-probe.mjs` | authed reads rows; anon reads zero; not service-role; sentinel | **W3 (after 0–4; human push)** |

---

## 3. Dependency order / parallelisable groups

```
Unit 0 (cutover, GATE, human)
   │
   ├── Unit 1 (identity/owner)  ─┐
   ├── Unit 2 (User read-only)   │  (2 after 1; 1‖3)
   └── Unit 3 (DDL constraints) ─┤
                                 │
                  Unit 4 (RLS generator)   (after 3 emitter seam + 1 owner keyspace)
                                 │
                  Unit 5 (acceptance, human push + run)
```

- **Wave 1 (after Unit 0):** Unit 1 ‖ Unit 3. Unit 2 follows Unit 1 (shared `identity.js`/`permissions.js`).
- **Wave 2:** Unit 4 (frozen `ddl.js`/`rls.js` export surface from Unit 3; owner keyspace from Unit 1).
- **Wave 3:** Unit 5 — lead runs after the human pushes the Unit 1/3/4 migrations to `sedpmsgiscowohpqdjza`.

---

## 4. Assembly + integration-test sequence

1. **Static gate:** `npx vitest run` — full suite green (Units 1–4 land their specs; fixtures updated for
   the `appUserId` keyspace). `node --check` each new file.
2. **Human pushes migrations** (to `spartancrm/supabase/migrations/` → `sedpmsgiscowohpqdjza`, dry-run first):
   the `set_doc_stamps()` function, the `tabDocType` meta columns, the `tabCustomer` trigger + RLS policies,
   the §A.4 owner back-fill. Confirm the orphan `RAISE NOTICE` count.
3. **Sync Customer meta + bump version:** `Installer.syncDoctype(CustomerDef, SupabaseStore)` writes
   `rls_policy_name`/`permission_intent`/`rls_state_column`; `bumpMetaVersion`.
4. **Run the acceptance probe (Unit 5):** `node --env-file=.env scripts/rls-probe.mjs` — authed actor reads
   Customer; anon reads zero; service-role unaffected; sentinel matches.
5. **Regression:** re-run `scripts/prove-customer-as-data.mjs` against the shared project to confirm the
   engine path (service-role) is unaffected by the new RLS.

---

## 5. Open items folded into the order (planner-scoped)

- **Embedding demonstrability on Customer (C8) — OUT of slice-1 acceptance, INVENTORIED in Unit 4/5 prep.**
  `loadDoc` assembles children per child-table field via `getChildren` on the
  `parent`/`parenttype`/`parentfield` triple with **no FK** (`document.js:194-197`). PostgREST embedding
  needs a real FK. **CustomerDef has no `Table` (child-table) field and no outbound `Link` FK** → there is
  **nothing on Customer to embed** in slice 1. Per the ADR's own fallback, **embedding drops to "later"**;
  slice 1 ships identity/RLS + constraint wins only. (Recorded so the next slice that adds a Customer child
  or a Link picks it up.) **Not a blocker, not in the acceptance gate.**
- **Multi-role un-defer trigger (A.6) — OUT of slice.** Slice-1 role set is `[public.users.role]` (+ admin →
  unrestricted via `app.is_admin` semantics). `tabHasRole` stays engine-internal; multi-role assignment is
  un-deferred only when a doctype first needs more than the scalar org role. **No slice-1 trigger.**

---

## 6. Composition go/no-go (buildability check, not a second design review)

- **Interfaces line up:** `ctxFromRequest`/`createDoc`/`getDoc`/`listDoc`/`queryConditions`/`can`/`assertCan`/
  `assertCanMutate`/`createTableSql`/`alterColumnsSql`/`pgTypeFor` signatures all **unchanged**; the only
  shape change is the additive `appUserId` on Ctx (with `SYSTEM`/`GUEST` defaulting it null) and three
  additive `tabDocType` columns. The owner-keyspace switch (`ctx.user`→`ctx.appUserId`) is a coordinated
  one-line change at three sites (`service.js:34`, `permissions.js:60`, `permissions.js:155`) — frozen here.
- **No cycles:** `identity.js` reads `app.users_v` via raw store (N5: never through `service.js`); the RLS
  generator reads meta the engine already loads; the DB predicate `app.can_read_doc` is a live platform
  object (no engine re-authoring). The §0 FROZEN-RULE breaks the only real collision risk (`scopeFields` vs
  RLS state column) by giving RLS its own `rls_state_column` field.
- **Contract-compliant:** service-role for the engine, anon/auth for the probe (two keys, §A.2);
  `queryConditions` and RLS guard **disjoint** caller sets (§A.8 — no false defense-in-depth claim); RLS
  emitted from meta (DRY); migrations land in the shared home + human `db push` (CLAUDE.md §1/§🗄). Customer's
  `USING (true)` is the honest least-privilege match to its plain-grant docperm (does not change the engine's
  own `queryConditions` behaviour).
- **The single contract the planner had to freeze** (`territory` is not a state column → RLS keys on a new
  `rls_state_column`, not `scopeFields`) is a sequencing freeze that **prevents** a behaviour-changing policy
  — resolved in-order, not a NO-GO.

### VERDICT: **GO** — release to the build phase, **gated on Unit 0** (the human-confirmed cutover to
`sedpmsgiscowohpqdjza` + the env/anon-key/relink). If the human declines the cutover, bounce to `architect`
(option B is a second identity home the design rejects), not back here.
