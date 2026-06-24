# Critique: Supabase-native features design

- **Reviewer:** critique
- **Date:** 2026-06-24
- **Design under test:** `docs/adr-supabase-native-features.md`
- **Authority cross-check:** live engine src (`src/runtime/**`, `src/perms/**`, `src/meta/**`), `supabase/migrations/**`, `Architecture_Contract.md` §2/§3/§6, Frappe identity/permission model.
- **Method:** Read on the live engine; no codegraph (repo not indexed). Every ADR claim re-grounded against code, not the ADR's own description.

## Verdict summary

**FAIL** — one blocker (C1) guts the headline decision as written, plus three high-severity correctness/contract gaps (C2–C4) and four mediums (C5–C8). The *direction* (hybrid, JS-primary, RLS-as-backstop, DDL-emitter-not-Drizzle, prove-on-Customer) is sound and well-argued. But the ADR's central promise — "RLS is the safety net for the access paths the engine can't police" — **does not hold against the code**, because the engine establishes identity from a **Google ID token mapped to `tabUser` by email** (`src/perms/auth.js`, `src/perms/identity.js`), and **nothing in that path produces a Supabase/GoTrue JWT that Postgres RLS can read** (`auth.uid()` / `auth.jwt()` are empty). The backstop is not just untested-by-construction — for the very callers it is meant to protect, it has **no identity to enforce against**. That must be resolved before planner.

Secondary but important: the ADR under-uses several Supabase built-ins that would do real work / absorb real risk the engine currently carries in JS (FK, NOT NULL/UNIQUE/CHECK as a Fail-Fast backstop, trigger-stamped `modified`/`creation`), and it repeats a **stale "naming is not atomic" worry** that the shipped `next_series` function already fixed.

---

## BLOCKER

### C1 — The RLS backstop has **no identity to enforce against**: the engine uses a Google ID token, not a Supabase (GoTrue) JWT, so `auth.uid()`/`auth.jwt()` are empty. The headline decision is un-buildable as written. (BLOCKER)

This is the make-or-break the brief flagged, and the code settles it against the ADR.

**Evidence:**
- Identity is a **Google OIDC token**, verified against Google's JWKS: `src/perms/auth.js:32 verifyGoogleIdToken` — `issuer: ['https://accounts.google.com', …]`, `audience: GOOGLE_OAUTH_CLIENT_IDS`. It returns `{ email, sub, … }` from **Google's** `sub`, not a Supabase user id.
- The verified email is then looked up in the engine's own table: `src/api/context-from-request.js:30-31` → `verifyGoogleIdToken(bearer)` → `resolveUserToCtx(payload.email, store)`; `src/perms/identity.js:26` `store.get('tabUser', email)`. Roles come from `tabHasRole` (`identity.js:32`). The whole permission context (`{user, roles, scopes, unrestricted}`) is **assembled in app code** from engine tables.
- `tabUser` has **no `auth_user_id` / `auth.uid()` linkage** — `supabase/migrations/20260620030000_user_identity.sql:16-27` defines `name=email, email, full_name, branch, enabled` and nothing tying a row to a GoTrue `auth.users.id`.

**Why this breaks the ADR.** Postgres' `auth.uid()` and `auth.jwt()` are populated **only** when a request arrives at PostgREST/`supabase-js` carrying a **GoTrue-issued** JWT (the anon/authenticated key flow). The ADR's §RLS says "any non-engine access … must use an anon/authenticated key so RLS applies," and §First-slice step 1 says author "a hand-written policy (owner/branch-scoped to match the existing `queryConditions` logic)." But:
- `queryConditions` (`src/perms/permissions.js:146`) scopes by `ctx.scopes.branch` and `owner === ctx.user`, where `ctx.user` is the **engine email** and `branch` came from the `tabUser` row. **None of that is in a GoTrue JWT** for a non-engine caller, because those callers never authenticated through GoTrue in this system — there is no Supabase Auth user at all yet.
- So a policy written as `owner = auth.jwt()->>'email'` or `branch = (auth.jwt()->>'branch')` has **no claim to read**. A browser/installer caller using the anon key has `auth.uid() = NULL`; using a GoTrue authenticated key requires a GoTrue user + custom claims (`branch`, role) that **do not exist** in this engine's identity model.

**The hole, precisely:** the ADR claims RLS makes the DB "safe even when reached outside the engine," but the only safety a `NULL`-identity policy can provide is **deny-all** (which is real defense-in-depth, but is *not* "owner/branch-scoped to match `queryConditions`" — it can't see the user). The "parity with `queryConditions`" test in step 1 is therefore **unsatisfiable** as written: there is no anon/auth key that carries an owner/branch identity to test the *positive* case ("Alice sees her own record"), only the negative ("a no-identity caller sees zero rows").

**Fix direction (architect must pick one and specify it):**
- **(a) Deny-by-default backstop only (smallest, honest).** Scope the slice-1 claim down: the RLS policy is `USING (false)` / `TO authenticated USING (false)` for non-`service_role` — i.e. "no non-engine caller reads `tabCustomer` at all; the engine (service_role) is the only door." This is genuinely valuable least-privilege defense-in-depth and is **testable** (anon key → 0 rows; service_role → all rows). Drop the "owner/branch-scoped to match `queryConditions`" parity claim entirely for slice 1 — you cannot match a model the DB can't see.
- **(b) Adopt GoTrue as the identity source (the real fix, larger).** Make Supabase Auth the issuer (or mint a Supabase JWT with custom `branch`/`role` claims after the Google verify), add `auth_user_id` to `tabUser`, and write RLS against `auth.jwt()` custom claims. This is exactly the "Supabase Auth (GoTrue) as identity source" candidate the brief asked to evaluate — and **it is the prerequisite** for any RLS that reproduces `queryConditions`, not an optional upgrade. If the project wants owner/branch RLS parity *ever*, this is the gate; the ADR currently lists GoTrue nowhere.
- **State the chosen path in the ADR.** Until it does, "RLS backstop matching `queryConditions`" is a claim the code cannot honour, and the slice-1 acceptance test cannot be written.

---

## HIGH

### C2 — The "RLS test-key trap" is worse than the ADR frames it: there is **no non-service-role code path in the engine at all**, so the backstop is untested *and unreachable* by the engine's own test harness. (HIGH)

The ADR's open question says "permission tests must run under an anon/auth key, not service-role." Correct — but the code shows the gap is total, not partial:
- The only Supabase client constructor is `SupabaseStore.fromEnv()` (`src/runtime/supabase-store.js:35-39`), which **only** reads `SUPABASE_SERVICE_ROLE_KEY`. There is no anon-key client, no `SUPABASE_ANON_KEY` reference anywhere in `src/` (grep: none).
- `PgStore` connects via `DATABASE_URL_POOLER` (`src/runtime/pg-store.js:37`) — a **direct Postgres role**, which also bypasses RLS (RLS applies to the `authenticated`/`anon` PostgREST roles, not a superuser/owner SQL connection).

So **every** engine path — including the test suite — bypasses RLS by construction. A permission test "under an anon key" would have to instantiate a client the engine **does not have a class for**. Quantify the gap: the RLS backstop would ship with **zero** engine-exercised coverage; its only test would be a bespoke raw-`supabase-js` anon probe written outside the Store abstraction.

**Fix:** the ADR must (a) add a thin anon/auth `supabase-js` client *for tests only* (or a documented raw probe in `scripts/`), and (b) state explicitly that this probe is the *sole* RLS coverage and lives outside the Store hierarchy. Pair with C4 — without it, Contract §6.3 ("every permission rule has a test") **cannot be met** for any doctype.

### C3 — A bug in `queryConditions` is **structurally un-maskable by RLS in tests, and un-caught in prod** — but the inverse risk (RLS masking a JS bug) the ADR worries about can't happen for the engine, because the engine always bypasses RLS. The ADR's open-question framing is backwards. (HIGH)

The ADR open question asks whether a `queryConditions` bug is "masked by RLS during tests (service-role bypasses it) but bites a non-engine caller in prod." Grounded in code, the actual risk profile is:
- **Engine path:** service_role / direct-PG → RLS never runs → a `queryConditions` bug (e.g. `permissions.js:146` failing to add the `branch` filter) leaks rows **in prod and in tests alike**, with no RLS net under it. RLS cannot mask it because RLS is never in the engine's path. The net the ADR imagines ("RLS catches the JS bug") **does not exist for the engine's own callers** — the very callers that run `queryConditions`.
- **Non-engine path:** these callers don't run `queryConditions` at all (it's engine-internal JS); their only protection *is* RLS — which per C1 is currently identity-less.

So the two concerns are about **disjoint caller sets**, and neither gets the cross-check the ADR implies. **Fix:** reframe the consequence honestly — RLS protects non-engine callers (and per C1 can only deny-all them today); `queryConditions` protects engine callers and has **no DB backstop**. They are not defense-in-depth for the *same* request. State this so the planner doesn't assume an engine-path `queryConditions` regression is caught by RLS — it is not.

### C4 — Contract §6.2/§6.3 compliance is asserted but **unreachable** for slice 1 given C1+C2; the "name the policy from the DocType row" mechanism has no field to live in. (HIGH)

The ADR §RLS says "each doctype's DocType row declares the permission *intent* in one line and **names** the policy" (mirroring Contract §6.2). But:
- There is **no `permission_intent` / `rls_policy_name` column** on `tabDocType` (`meta_core.sql` / `installer.js:108-120` show `module, autoname, naming_rule, issingle, istable, is_stub, is_submittable, scope_fields` — none for RLS intent/policy name). The DDL emitter (`ddl.js:createTableSql`) emits no RLS and no place to record a policy name.
- Per C2, the §6.3 test ("Bob must not see Alice's record") needs an anon-key path that doesn't exist.

So two Contract clauses the ADR leans on are **not satisfiable without new schema + a new client**. **Fix:** the ADR must add (a) the `tabDocType` columns to hold intent + named policy (a meta change with its own migration), and (b) the test-client from C2. Otherwise §6.2/§6.3 are documented-but-unenforceable for the first doctype — exactly the "build against the wrong law" failure §Problem warns about.

---

## MEDIUM

### C5 — Stale premise: "naming series is NOT atomic" is **already fixed** in the shipped function; the ADR (and the store doc-comment) repeat a worry that no longer applies, risking redundant work. (MEDIUM)

The ADR §Decision table lists naming as "Postgres (already) — keep," which is correct, but the surrounding store comments still flag a race. The shipped function is **atomic**:
- `supabase/migrations/20260620020000_next_series_fn.sql:4-13` — `insert … on conflict (name) do update set current = current + 1 returning current`. A single statement; concurrent calls serialize on the row lock. **Race-safe.**
- `SupabaseStore.nextSeries` (`supabase-store.js:24-28`) and `PgStore.nextSeries` (`pg-store.js:131-138`) both call it. **The only non-atomic path is the JS fallback** in `naming.js:47-52` (read-inc-write), which runs **only** for a store with no `nextSeries` method (i.e. a bare `MemoryStore` in tests).
- **Stale doc-comments to fix (flag, don't relitigate):** `supabase-store.js:9-13` ("currently does read-inc-write via get/update, which is NOT atomic … wire `nextSeriesRpc()` once that migration lands") and `naming.js:31-36` ("SupabaseStore *will* back this with an atomic RPC") both describe a not-yet-done state that **is already done**. These are stale-map-edge findings: the ADR should note the comments lag the code, and the implementer should correct them. **No new work on naming atomicity is needed** — the brief's "is the naming RPC actually race-safe?" answer is **yes**.

### C6 — The DDL emitter throws away every Postgres constraint the brief asks about — `reqd`→NOT NULL, `unique`→UNIQUE, Link→FK, Select→CHECK — leaving them JS-only. This is the single biggest "let Postgres do work / absorb risk for us" miss, and the ADR doesn't mention it. (MEDIUM, high-value)

`src/meta/ddl.js:createTableSql` emits **bare typed columns** — `customer_name text`, etc. — with **no** `not null`, **no** `unique`, **no** FK, **no** CHECK, even though the meta carries `reqd`, `unique`, `Link.options`, and `Select.options`:
- `reqd` is consumed only in JS validation; `unique` is written to `tabDocField` (`installer.js:130 unique: f.unique`) but **never emitted as a constraint** — naming uniqueness and field uniqueness rest entirely on app logic.
- Link existence is checked in JS (`src/runtime/links.js:37 validateLinks` → `store.get(target.table, v)`), a **read-then-write race** (TOCTOU): the target can be deleted between the existence check and the insert. A Postgres FK enforces this atomically and for free.
- `tabCustomer` (`20260620000001_customer.sql`) is the proof: all domain columns are nullable, unconstrained `text`/`numeric`.

This is precisely the DRY-vs-Fail-Fast tension the brief named: adding `NOT NULL`/`UNIQUE`/`FK`/`CHECK` puts the rule in **two homes** (Zod/meta *and* a constraint). The right call is **backstop, not relocate** — keep JS validation as the user-facing, field-level-error path (Contract §4.4), add the constraint as the *last-line* integrity guarantee for non-engine writers and concurrency races. See the ranked table below for the slice-1 vs later split. **Fix:** the ADR should add a section deciding which constraints the DDL emitter emits as a backstop, and explicitly accept the dual-home cost for the integrity/atomicity it buys (FK and UNIQUE especially — they close real races JS cannot).

### C7 — `modified`/`creation` stamping is in JS (`document.js`); the brief's trigger-stamping candidate is unaddressed. A trigger is a clean backstop for non-engine writers. (MEDIUM)

`src/runtime/document.js:58-59,70,129-130` stamp `creation ??=` / `modified =` in JS (`nowISO()`). A non-engine writer (the access path RLS is meant to cover) would **not** stamp `modified`, leaving the audit field stale — the CRM precedent (`stock_items.on_hand` trigger-derived) shows the house pattern. A `BEFORE INSERT/UPDATE` trigger setting `modified = now()` (and `creation` on insert) is a low-risk, doctype-agnostic backstop. **Cost/caveat:** the engine already sets these, so the trigger must be a coalesce/override that doesn't fight the engine's ISO string (note `document.js` uses JS `toISOString()`, a trigger uses `now()` — pick one canonical source; a trigger that always wins is simplest and makes the engine's stamping redundant-but-harmless). **Fix:** add to the ADR's decision table; it's a slice-1-cheap win that hardens exactly the non-engine path the ADR cares about.

### C8 — PostgREST embedding (slice-1 step 2) is under-specified for the engine's child-table shape and the multi-FK case; "replacing a JS link-resolution loop" mischaracterises what `fetch_from` does. (MEDIUM)

Two precision gaps:
1. **What embedding replaces.** The ADR step 2 says embedding replaces "a JS link-resolution loop … confirm parity with the engine's `fetch_from` result." But `fetch_from` (`src/runtime/links.js:14 resolveFetchFrom`) is a **write-time field copy** (set `me.territory` from `customer.territory`), not a read-time join — and the ADR's own decision table correctly scopes embedding to **reads**. Embedding a Customer with a child table is a different operation from `fetch_from`. The parity target is wrong; the real read to optimise is `Document.loadDoc`'s child-table assembly (`getChildren` per child field), not `fetch_from`. **Fix:** restate step 2 as "embed child rows in the Customer read, parity with `loadDoc`'s `getChildren` assembly."
2. **Multi-FK disambiguation.** The ADR open question is right to flag `select('start_scan:scans!fk')`. But the engine's child tables are linked by the **generic `parent`/`parenttype`/`parentfield` triple** (`supabase-store.js:73-78 getChildren`), **not** a per-child named FK — and there is **no FK at all** today (C6). PostgREST embedding **requires a real FK relationship** (or an explicit hint) to embed; with the generic-triple shape and no FK, `select('tabCustomer(*, tabAddress(*))')` **will not auto-resolve**. **Fix:** the ADR must state that embedding child tables requires *first* declaring an FK on `parent` (ties to C6) or accept that embedding works only for `Link`-FK reads, not the `parent`-triple child reads — and inventory which slice-1 read actually benefits. As written, step 2 may not be demonstrable on Customer at all if Customer has no FK'd child.

---

## Supabase built-ins: do-work-for-us / handle-risk-for-us (ranked)

Ranked by (risk/work removed ÷ cost). "Slice" = whether it belongs in the Customer first slice or later.

| # | Built-in | Engine does this in JS today | What it removes | Cost / caveat | Slice |
|---|---|---|---|---|---|
| 1 | **FK constraint** (Link → `tab<Target>(name)`) | `links.js:37 validateLinks` read-then-write existence check | Atomic referential integrity; closes the TOCTOU race; protects non-engine writers | Dual home (DRY) with `validateLinks`; FK target must exist before child table; stub-target soft-links (`links.js:44`) need FK deferred/omitted | **Slice 1** (Customer→territory/Link if any) |
| 2 | **`UNIQUE` constraint** (field `unique`, naming) | `unique` stored in meta but never enforced; naming uniqueness is app-logic | DB-guaranteed uniqueness under concurrency (two reps can't create the same customer code) | Dual home; needs a partial/standard index; conflicts surface as PG errors the engine must map to `ValidationError` | **Slice 1** |
| 3 | **GoTrue (Supabase Auth) as identity for RLS** | Google token → `tabUser` lookup, ctx built in `identity.js` | The **prerequisite** that makes any owner/branch RLS actually enforceable (resolves C1 path b) | Large: new auth flow or claim-minting, `auth_user_id` on `tabUser`, custom JWT claims; only needed if RLS must match `queryConditions` (vs deny-all) | Later (decision now) |
| 4 | **`modified`/`creation` trigger** | `document.js:58-59,129-130` JS stamping | Audit-field correctness for non-engine writers; makes stamping doctype-agnostic | Must not fight engine's ISO stamp — make trigger authoritative | **Slice 1** (cheap) |
| 5 | **`NOT NULL` (reqd) / `CHECK` (Select options)** | Zod/meta validation only | Last-line integrity for non-engine writers; cheap Fail-Fast at the boundary | Dual home; `reqd` semantics vs `fetch_from`-populated fields (don't NOT-NULL a fetched field that's set post-insert) | Slice 1 for NOT NULL on clear-required; CHECK later |
| 6 | **RLS deny-all backstop** (`service_role` only) | service-role bypass; no DB row security | Real least-privilege: non-engine callers get **0 rows** until explicitly allowed | Honest scope only (not `queryConditions` parity) until #3 lands | **Slice 1** (this is the achievable version of the ADR's step 1) |
| 7 | **Realtime CDC** | no app-layer change dispatch | Live floor/status transport with no polling infra | Realtime respects RLS on the `authenticated` role — needs #3 or a publishable view; smoke-only in slice 1 is fine | Later (smoke in slice 1) |
| 8 | **Database Webhooks / `pg_net`** | app-layer hooks | Out-of-band side effects (geocode-style) without engine round-trip; CRM already uses `pg_net` | Fire-and-forget; idempotency/retry is on you; not needed for Customer | Later |
| 9 | **`pg_cron`** | no scheduled work yet | Series reset / inventory sweeps without an external scheduler | YAGNI until a concrete recurring job exists | Later |
| 10 | **Storage** (File doctype) | none (no File fieldtype yet) | Frappe File doctype attachments without a blob column | No File fieldtype in the engine yet — pure YAGNI | Later |

**Note (naming/`next_series`): NOT on this list** — already adopted and **already atomic** (C5). No work to do.

---

## README-vs-Contract reconciliation assessment

The ADR's §Consequences amendment list (§2.1/§2.3/§3.4/§8.3) is **directionally correct and mostly complete**, but **misses two clauses** and slightly mis-scopes one:

- **§2.1 — correct.** "Drizzle schema emitted from it / Drizzle Kit owns diffing" → "the DocType DDL emitter (`ddl.js` + `Installer.emitMigration`) owns emission/diffing." Grounded: `installer.js:64 emitMigration`, `ddl.js`. Good.
- **§2.3 — correct but expand.** Restate Drizzle's pooled-connection rule as the engine's connection rule. Grounded: `PgStore` uses `DATABASE_URL_POOLER` (`:6543`, `prepare:false`, `max:1`) — `pg-store.js:35-43`. The amendment should explicitly name **both** stores (`PgStore` direct-PG pooler **and** `SupabaseStore` PostgREST service-role) since the engine has two connection mechanisms, not one.
- **§3.4 — correct.** "query types from Drizzle inference" → drop; generic `Document` is string-keyed. Grounded.
- **§8.3 — correct.** Acknowledge the generic engine+emitter as chosen architecture.
- **MISSED — §2.4.** "No raw SQL strings for entity reads/writes … go through Drizzle." The engine **does** use raw SQL strings for entity reads/writes — `PgStore` (`pg-store.js:49,67,100,113` `this.sql.unsafe(...)`). §2.4's lint rule ("flag raw SQL template literals outside migrations/RLS dirs") would **fail the entire `PgStore`**. The amendment **must** rewrite §2.4 to bless the Store layer's parameterised SQL (it *is* the engine's typo-proof door, with positional params, never interpolated values — `pg-store.js:20-22` documents this). Without this, the Contract forbids the engine's own store.
- **MISSED — §3.1/§4.1 (Zod).** The ADR's decision table says "Validation (Zod / meta-driven) — JS engine, unchanged," but the engine validates with `assertValidDef`/`validate.js`, and the brief/codebase show no Zod dependency in the engine. If the engine is **not** using Zod, Contract §4.1 ("Zod is the only validation mechanism") is another clause the README-canon violates. **Flag for the amendment** — either confirm Zod is in use or amend §4.1 to name the engine's actual validation mechanism. (Did not fully ground the Zod question — see open question O1.)
- **Scope correct overall:** amending the Contract (§10) to make the runtime meta-as-data engine canon, keeping §6's hand-written-RLS rule, is the right resolution. But the amendment set is **incomplete** until §2.4 (and likely §4.1) are added.

---

## What's right (keep it)

- **Hybrid split** (JS authority for docstatus/workflow/validation; Postgres for atomicity/scheduling/transport) is sound SoC and matches the code.
- **DDL-emitter-not-Drizzle** is correct and already built (`ddl.js`, `installer.js`) — no second schema source of truth. (One caveat: `installer.js:187 migrate` *can* execute DDL directly via `opts.admin` (PgAdmin) — so "the Installer NEVER executes DDL" is true only for the emit path, not the admin path. Minor; note it so the README amendment is accurate.)
- **Reject PostgREST auto-API / business logic in PG functions** — correct, preserves the one-entity-one-home Prime Directive.
- **Prove-on-Customer first** is the right low-risk slice — *once* step 1's claim is corrected per C1 and step 2's parity target per C8.

---

## Required before PASS (hand back to architect)

1. **C1** — choose the identity story for RLS: deny-all backstop (path a, no `queryConditions` parity claim) **or** adopt GoTrue (path b) as the prerequisite for owner/branch RLS. State which; rewrite slice-1 step 1 accordingly.
2. **C2/C4** — specify the anon/auth test client (outside the Store hierarchy) and the `tabDocType` columns for permission-intent + named policy; without them Contract §6.2/§6.3 are unenforceable.
3. **C3** — reframe the defense-in-depth consequence: RLS and `queryConditions` guard **disjoint** caller sets; an engine-path `queryConditions` bug has no DB net.
4. **C6/C7** — add a decision on which constraints (FK, UNIQUE, NOT NULL, CHECK) and the `modified`/`creation` trigger the DDL emitter emits as a backstop; accept the dual-home cost explicitly.
5. **C8** — restate embedding parity vs `loadDoc` child assembly (not `fetch_from`); resolve that child-table embedding needs an FK (ties to C6) or is limited to Link-FK reads.
6. **C5** — correct the stale "not atomic" doc-comments; confirm no naming work is needed.
7. **README/Contract** — add §2.4 (bless `PgStore` parameterised SQL) and resolve §4.1 (Zod) to the amendment set.

## Open questions (time-boxed, not graded)

- **O1:** Is the engine actually using Zod anywhere, or is validation hand-rolled in `validate.js`/`def-schema.js`? Did not fully ground; affects whether Contract §4.1 needs amendment. (Architect to confirm.)

---

## VERDICT: **FAIL** — direction sound, but C1 (RLS has no identity to enforce — Google token, not GoTrue JWT) makes the headline backstop un-buildable as claimed; C2–C4 are the structural consequences (no anon path, disjoint guard sets, unenforceable §6.2/§6.3); C5–C8 are correctness/under-use gaps including the FK/constraint/trigger work Postgres should absorb. Re-architect the identity-for-RLS decision and the constraint-backstop scope, complete the §2.4/§4.1 amendments, and return.

---

## Round 2 (Rev-2 re-critique)

- **Reviewer:** critique (round 2)
- **Date:** 2026-06-24
- **Design under test:** `docs/adr-supabase-native-features.md` **Rev 2** + `diagrams/adr-supabase-native-rev2.puml`
- **Method:** every Rev-2 claim re-grounded against live engine src + the **shipped** CRM hook migration (`crm-worktrees/scratch03/supabase/migrations/20260623130000_app_schema_and_identity.sql`, now in-tree — not just the spec). Code is ground truth.

### Round-1 finding disposition (one line each)

- **C1** (RLS no identity) — **partially.** GoTrue is adopted (good), but the claim shape the RLS depends on does **not** match the shipped CRM hook. New blocker **C9**.
- **C2** (no anon path / untestable) — **resolved.** `scripts/rls-probe.mjs` raw anon-key client, stated as sole coverage, outside the Store hierarchy. Correct.
- **C3** (defense-in-depth backwards) — **resolved.** §A.5 + Consequences reframe RLS/`queryConditions` as disjoint guard sets honestly.
- **C4** (no home for policy name/intent) — **resolved.** `rls_policy_name` + `permission_intent` columns on `tabDocType`, own migration, carried by `installer.js:syncDoctype`.
- **C5** (stale "not atomic") — **resolved.** Filed as implementer doc-cleanup; `next_series` confirmed atomic; no naming work.
- **C6** (constraints dropped) — **resolved** for the locked scope (FK + UNIQUE emitted; NOT NULL/CHECK deferred with sound reasons). Minor new edges in **C10/C11**.
- **C7** (JS-only stamping) — **resolved.** `set_doc_stamps()` trigger authoritative, `creation` coalesced, JS redundant-but-harmless. Grounded against `document.js:57-59,129-130`.
- **C8** (embedding parity wrong) — **resolved.** Restated against `loadDoc`/`getChildren`; embedding declared dependent on the `parent` FK; honest "drops to later if not demonstrable" fallback.
- **§2.4 / §4.1 (O1)** — **resolved.** §2.4 re-blesses `PgStore` parameterised `sql.unsafe`; O1 ground-checked: Zod = def-structure (`def-schema.js`) + request envelopes (`request-schemas.js`) only, entity data is hand-rolled (`validate.js`/`links.js`). §4.1 amendment is correct.

So 7 of 8 round-1 findings are genuinely closed. The exception is C1 — and it re-opens as a **harder, code-confirmed blocker** because Rev-2 now commits to a specific claim contract that the *shipped* CRM hook contradicts.

### BLOCKER

#### C9 — The engine RLS policy reads claims the shared CRM hook does not produce, and joins on the wrong keyspace. The CRM-spec alignment claim does NOT check out against the shipped hook. (BLOCKER)

The ADR headline is "reuse the CRM one shared `custom_access_token_hook`; RLS reads `auth.jwt()->>'branch'` / `->>'app_user_id'` / `->>'role'`." Ground truth (the hook is **live in this repo migrations**, `20260623130000_app_schema_and_identity.sql:160-188`) breaks this three ways:

1. **No `branch` claim exists.** The shipped hook injects exactly `app_user_id` and `app_role` (`:179-180`) — and nothing else. The ADR §A.3 predicate `branch = (auth.jwt()->>'branch')` reads a claim that is **always NULL**. Worse, the CRM deliberately does **not** carry branch as a JWT claim: branch scoping in the CRM is a `SECURITY DEFINER` function `app.branch_in_scope(...)` (`:100-148`) that re-reads `public.users` by `id = app.current_uid()` and computes a multi-state ceiling from `service_states` (a JSONB array, e.g. `["VIC","ACT"]`). A single scalar `branch` claim **cannot express** that model. So the engine "reuses the CRM hook" but then needs a claim the CRM hook intentionally omits — the hook would have to be *extended*. The ADR open item "likely the same row set, verify before cutover" was the right instinct; the answer is **no**.

2. **`role` vs `app_role` name mismatch.** Hook writes `app_role` (`:180`); ADR policy reads `auth.jwt()->>'role'` (§A.1, §A.3 `(auth.jwt()->>'role') = 'admin'`). Reads NULL → the admin escape hatch never fires.

3. **`app_user_id` is the wrong keyspace for `owner`.** Hook sets `app_user_id = public.users.id` = the `u1782…` text id (`:179`). The engine stamps `owner = ctx.user` = the **email** (`service.js:34`; `ctx.user` is the email from `identity.js:40`). So the ADR policy `owner = (auth.jwt()->>'app_user_id')` compares an email column against a `u1782…` id — **never matches**. The owner predicate is dead on arrival. The ADR §A.2 assertion "`app_user_id` (= `tabUser.name`)" is **false against the shipped hook** — the hook keys `app_user_id` to `public.users.id`, not to `tabUser.name`/email, and there is no established mapping between the two id spaces in the engine.

**Why this is a blocker, not a nit:** the slice-1 acceptance test (§First-slice step 1: "branch-A user sees branch-A + own rows, excludes branch-B") **cannot pass** against the shipped hook — the branch claim is absent, the role claim is misnamed, and the owner claim is a different keyspace. Either every predicate silently reads NULL (→ accidental deny-all, i.e. C1 round-1 path (a) by accident, not the claimed `queryConditions` parity), or the positive case fails. The "one identity, reuse the CRM hook" alignment is asserted but contradicted by the code it claims to align with.

**Fix direction (architect, pick and specify):**
- **Reconcile the claim contract against the *shipped* hook, not the spec prose.** Either (i) adopt the CRM actual model — a `SECURITY DEFINER` `branch_in_scope`-style function keyed on `app.current_uid()` reading the user branch/`service_states`, so the engine RLS calls the *same* function shape rather than reading a scalar `branch` claim; or (ii) extend the shared hook to also inject `branch` (and decide whether multi-state `service_states` collapses to a scalar — it cannot losslessly, so (i) is likely correct). State which.
- **Fix the keyspace for `owner`.** Either stamp engine `owner` with the `u1782…` id (large — changes identity model, contradicts §A.2 "email stays canonical"), or have RLS resolve `app_user_id` → email via a function/join before comparing to `owner`. The ADR must specify the join; "= tabUser.name" is not it.
- **Fix the `app_role` claim name** in every policy snippet.
- **Confirm `public.users` vs `tabUser` are the same row set** for the hook lookup — the hook reads `public.users` (CRM table); the engine reads `tabUser`. On the shared project these may be different tables with different ids. If so, "one identity" is aspirational, not built.

This is the same C1 hole relocated into the claim/keyspace layer — the mint path is now plausibly specified (server-mediated `generateLink`/`verifyOtp`, or `signInWithIdToken` since the engine has an id_token — both viable, correctly left as a planner decision, **not** a blocker), but the *claims the policy enforces against* are wrong, so RLS still enforces the wrong thing (or nothing).

### MEDIUM (new edges, non-blocking but planner must carry)

#### C10 — §B FK emission has an ordering hole the stub-skip does not cover. (MEDIUM)
The emitter skips FK for `isStub`/unregistered targets (matches `links.js:43-44` — verified). But a Link to a target that **is** registered in meta yet whose **table has not been emitted/migrated yet** would emit `references "tabTarget"(name)` against a non-existent table → the migration fails at `db push`. `validateLinks` tolerates this (`tryMeta` returns the meta even with no table); the FK does not. The "registered, non-stub" gate is necessary but not sufficient — it needs an **emission-ordering / target-table-exists** guard (emit FK in a later `alter table` pass, or topologically order table creation). Self-referential Links are fine with deferrable FK but should be called out. Slice-1 Customer likely has no such Link, so this is a planner note, not a slice-1 blocker — but specify it before any multi-doctype slice.

#### C11 — UNIQUE back-fill on existing data can fail the migration. (MEDIUM, minor)
`create unique index if not exists` is idempotent against *re-runs*, but not against *existing duplicate rows* — if any emitted table already holds duplicate values in a newly-`unique` field, the `create unique index` throws and the migration aborts. `tabCustomer` is freshly proven so slice 1 is safe, but the ADR should note adding UNIQUE to an already-populated field needs a dedup precheck first. Fail-fast is correct; just flag it so a later doctype migration is not a surprise.

#### C12 — Stamping trigger / JS double-write: confirmed harmless. (resolved — recorded for the planner)
Verified `document.js`: insert sets `creation ??= t; modified = t` (`:57-59`), children set `creation ??= nowISO(); modified = nowISO()` (`:129-130`). Trigger `coalesce(new.creation, now())` preserves the engine `creation`; `modified := now()` overrides the engine value. Both serialise to `timestamptz`. The only divergence is `modified` differing by request latency between JS `Date` and PG `now()` — cosmetic, trigger-authoritative is the right call. No action; not a hole.

### Supabase-built-ins lens (Rev-2 still on the table)
GoTrue adoption now makes two more built-ins cheap that Rev-2 did not pull in — non-blocking, note for the planner:
- **`auth.uid()`/claim for `owner` defaulting** — once the keyspace is reconciled (C9), `owner` could default from the JWT at the DB edge as a backstop for non-engine inserts. YAGNI for slice 1 but cheap later.
- **RLS on the meta tables themselves** (`tabDocType`/`tabDocField`/`tabUser`) — these now hold `auth_user_id` and permission-intent; a non-engine anon caller can currently read all meta. Least-Privilege says deny-all anon on the meta tables. Cheap; flag for the slice that adds the columns.
- **Auth-event webhooks** for `auth_user_id` back-fill observability — optional, matches CRM telemetry phase-3; YAGNI now.

### Design-contract gate (Rev-2)
DRY/KISS/YAGNI/SOLID/SoC/Least-Privilege/Idempotency/Fail-Fast — Rev-2 is materially better. The DRY "rule in meta → emitted to both JS + DB" stance **does hold**: confirmed both `validateAgainstMeta`/`validateLinks` and the proposed `ddl.js` emission read the *same* `tabDocField` rows — one authored source, two derived outputs, not a second source of truth. The contract gaps left are **Least Privilege on meta tables** (above) and the C9 correctness break (a policy that enforces the wrong thing is a Fail-Fast violation — it fails *open* by reading NULL claims, not closed-with-error).

### VERDICT (Round 2): **FAIL**

Direction is now solidly right and 7/8 round-1 findings are genuinely closed — but **C9 is a hard, code-confirmed blocker**: the engine RLS policy enforces against claims (`branch`, `role`) the shipped CRM hook does not produce and a keyspace (`app_user_id` = `u1782…` id) that does not match the engine `owner` (= email). The "reuse the one shared hook / one identity" alignment the ADR headline rests on **does not check out against the live `20260623130000_app_schema_and_identity.sql`**. Reconcile the claim contract + owner keyspace against the *shipped* hook (not the spec prose), fix the `app_role` name, confirm `public.users` vs `tabUser` are the same row set, and return. C10/C11 are planner-carry mediums; C12 is confirmed harmless.

---

## Round 3 (Rev-3, focused: back-fill / tabUser-write / Customer policy)

- **Reviewer:** critique
- **Date:** 2026-06-24 (Rev-3)
- **Scope (narrow, by lead's brief):** ONLY the three new Rev-3 correctness-risk decisions. C1-C12 are settled/accepted and NOT re-opened.
- **Method:** Read on live engine src + the shipped/live SQL helpers (`20260624141500_engine_auth_scope_helpers.sql`, `20260623130000_app_schema_and_identity.sql`); the two CRM customer migrations; the engine's `tabCustomer`/`User` defs. No codegraph (engine repo not indexed).

### Empirical answer to the make-or-break question: does the engine write the User doctype?

**Yes - by construction, the generic API write path will write whatever table the `User` doctype's `meta.table` points at, and there is no read-only-doctype concept anywhere in the engine.**

- `api/handler.js:46-73` is a **fully generic dispatcher with NO doctype allow-list**: `POST /User` -> `createDoc(ctx,'User',body,store)`; `POST /User/<name>` (no action) -> `updateDoc(ctx,'User',name,body,store)`.
- `api/service.js:32-39` (`createDoc`) and `:58-67` (`updateDoc`) call `newDoc(...).insert()` / `loadInScope(...).save()` for **any** doctype.
- `runtime/document.js:62` (`insert`) and `:82,:84` (`save`) unconditionally do `await this.store.insert(this.meta.table, ...)` / `store.update(this.meta.table, ...)`. There is **no** branch that treats a doctype as read-only.
- Today there is no *User-specific* controller and no production caller doing `createDoc('User')` (the only `tabUser` writes in the tree are in `*.test.js` seed helpers). **But the capability is unconditional** - the moment the `User` doctype is registered with `meta.table = app.users_v` and `getMeta('User')` resolves (Rev-3 §A.5 explicitly registers it; `meta/user-meta.test.js` already proves `getMeta('User')` resolves), `POST /User` or `POST /User/<name>` is a live write into the view. Nothing gates it shut.

### C13 (HIGH - make-or-break for item 2) - sub-option (i) points `meta.table` at `app.users_v`, a view the engine's write path will INSERT/UPDATE into, and the view is NOT set up to accept writes.

`app.users_v` (`20260624141500:194-207`) is `CREATE ... VIEW ... WITH (security_invoker = true)`, `GRANT SELECT ... TO authenticated, anon, service_role` - **SELECT only, no INSTEAD OF triggers, no INSERT/UPDATE grant.** A single-base-table view *can* be auto-updatable in Postgres, but: (a) the engine connects on the **service-role** key for writes (§A.2), and service-role has only the granted privileges -> **no INSERT/UPDATE privilege on `app.users_v`** = permission-denied; (b) even with privilege, an auto-updatable-view INSERT would need every NOT-NULL base column the engine doesn't supply, and the engine writes Frappe framework columns (`docstatus`, `idx`, `modified`, `creation`) that **do not exist on `public.users`** -> column-does-not-exist error. So **sub-option (i) breaks every write of the User doctype**, and the ADR proposes **no INSTEAD OF triggers** to make the view writable.

The ADR's framing that (i) vs (ii) is "for the planner, not a blocker" is **wrong for (i)** as written: (i) is only sound if the engine never writes User. It will (capability is unconditional, §A.5 registers the doctype). **Fix required (back to architect, narrow):** Rev-3 must either (1) mandate sub-option (ii) (engine-internal `tabUser` projection for any User *write*, `app.users_v` for reads), or (2) keep (i) **read-only** by adding INSTEAD OF INSERT/UPDATE/DELETE triggers on `app.users_v` AND the service-role write grant AND a column-mapping that drops Frappe framework columns - a non-trivial design the ADR doesn't carry, or (3) explicitly forbid User writes through the engine (deny `create`/`write` docperm on User so `assertCan` 403s before the store is touched) and state that user provisioning stays the CRM `supabase-session.js` path. Option (3) is the cleanest and matches reality (the CRM already owns user provisioning via `provisionSupabaseUser`), but it must be **stated as a hard constraint**, not left as "planner's pick (i)". As written, the ADR's *recommendation* is (i) - which is unsound.

### C14 (MEDIUM - item 1, back-fill orphans) - orphan-owner invisibility is acknowledged but the "every prod actor is a public.users row" premise is asserted, not proven, and the fail-mode is silent-invisibility, not fail-fast.

§A.4 step 3 correctly *names* the orphan case (an `owner` email with no `public.users` match keeps the email, so `owner = app.current_uid()` (a u178 id) never matches -> row visible only to admin/state). That is the right hazard. Two residual holes:

1. **The mitigating premise is unverified.** "on the shared prod project every actor is a `public.users` row" is asserted. The back-fill joins on `lower(email)` via `app.users_v`, and **`app.users_v` has NO `active` filter** (confirmed: `20260624141500:194-205` selects all `public.users` rows regardless of `active`) - so the *back-fill* join will actually match inactive users too (good for back-fill coverage). BUT the runtime hook (`20260623130000:171-175`) and `app.user_state_ceiling` (`:93`) both require `AND active` - so a row back-filled to an **inactive** user's u178 id becomes invisible to that (now-inactive) user anyway and to everyone except admin. This is acceptable *if* called out, but the ADR conflates "users_v has no active filter" (true, and fine for the back-fill) with runtime visibility (which DOES require active). Net: the orphan/inactive set is **least-privilege-correct (fail-closed)** but the ADR should state that back-filled-to-inactive rows are admin-only by design, not a bug.
2. **Fail-fast gap:** the back-fill leaves orphan rows with an email-valued `owner` and "flags for manual reconciliation" - but no mechanism is specified. For a proof slice this is fine; as a migration it should **emit a count of unmatched rows** (RAISE NOTICE) so the operator sees the orphan set rather than discovering invisible rows later. **Not a blocker** - the engine is greenfield/isolated (`tabCustomer` is on the engine's own project, `20260620000001`), so the back-fill is **moot for slice-1 acceptance** (no real prod rows yet); it only bites at the eventual shared-project cutover, which §A.4 itself defers to the planner. Idempotency holds: the email->u178 update is one-way and re-runnable (a u178 `owner` won't match the email-join, no-ops).

### C15 (HOLDS - item 3, Customer policy) - `tabCustomer` is a SEPARATE engine table; `USING (true)` is a faithful, non-over-exposing projection of the plain-grant docperm.

- **Separate tables, confirmed:** the engine's `Customer` doctype = `tabCustomer` on the engine's **own isolated project** (`spartan-erp-engine/supabase/migrations/20260620000001_customer.sql`: `customer_name, territory, email, credit_limit`, no state column). The CRM's `public.customers` is a **different** table (`20260605000510_customers_table_crm_owned.sql`: caller-ID identity, `full_name/phone/email`). The cutover does **not** map `tabCustomer` onto `public.customers`. **No RLS conflict** - `USING (true)` lands on `tabCustomer`, never on the CRM's `public.customers`. (And even if they later converge, the CRM's own `public.customers` SELECT policy is *already* `USING (true)` - `20260605000510:58` `customers_select_v1` - so the intent is identical: customer identity is org-visible. The ADR's "team-visible reference master" reasoning matches the CRM's shipped posture exactly.)
- **Parity is real, not assumed:** the engine's `queryConditions` (`permissions.js:146-157`) adds an `owner` filter **only** when the sole read grant is `if_owner` (`hasOwnerGrant && !hasPlainGrant`). A plain Customer read docperm -> `queryConditions` returns `{}` (no owner filter; no state filter since `tabCustomer` has no `scopeFields`). So the engine's own enforcer shows a rep **all** customers. `USING (true)` for `authenticated` is therefore the **honest match**, and emitting `can_read_doc(owner, NULL)` (owner-or-admin) would *narrow* it below the engine's own behaviour - the ADR's reasoning (§A.3) is correct. Least-privilege: the policy is scoped `to authenticated` (§A.3 emitted SQL), and **anon is a separate Postgres role**, so anon (no `app_user_id`) is correctly excluded. No over-exposure. **HOLDS.**

### Per-item verdict

1. **Owner-keyspace back-fill** - **HOLDS with a caveat (C14, non-blocking):** orphan-invisibility is fail-closed/least-privilege-correct and the back-fill is idempotent + moot for greenfield slice-1; add a fail-loud unmatched-count and state the inactive-row admin-only consequence. Not a blocker.
2. **`tabUser` -> `app.users_v` sub-option (i)** - **PROBLEM (C13, blocking):** the engine's generic write path WILL write the User doctype (no allow-list, no read-only-doctype concept), and `app.users_v` is a SELECT-only, no-INSTEAD-OF, no-write-grant view -> sub-option (i) as *recommended* breaks all User writes. ADR must mandate (ii), or read-only-trigger (i), or hard-deny User writes - not leave (i) as the recommended planner pick.
3. **Customer `USING (true)`** - **HOLDS (C15):** separate engine table, no CRM-RLS conflict, faithful least-privilege projection of the plain-grant docperm, parity proven against `queryConditions`, `to authenticated` correctly excludes anon.

### VERDICT (Round 3): FAIL - single blocker C13.

Items 1 and 3 hold (C14 is a non-blocking polish note; C15 is clean). **C13 is a code-confirmed blocker:** Rev-3 §A.5 *recommends* sub-option (i) (point `User.meta.table` at `app.users_v`), but the engine's write path (`handler.js` -> `service.js:createDoc/updateDoc` -> `document.js:insert/save` -> `store.insert/update(meta.table)`) is unconditional and has no read-only guard, so a `POST /User` write hits the view - which is SELECT-only with no INSTEAD OF triggers and no service-role write grant -> all User writes break. Back to architect: pick (ii) (engine-internal projection for writes), or make (i) genuinely read-only (INSTEAD OF triggers + grant + framework-column mapping), or hard-deny User create/write docperm so `assertCan` 403s before the store. Narrow fix; everything else in Rev-3's three items is sound.
