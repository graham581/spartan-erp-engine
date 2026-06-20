# Work Order: Identity Layer (Pass C) — Google idToken auth + User model + `if_owner`

- **Planner:** planner
- **Source design:** `docs/adr-identity-layer.md` (REV 2, frozen) + `diagrams/identity-layer-class.puml`
- **Critique verdict:** PASS (2 passes) — `docs/critique-identity-layer.md`
- **Repo:** `spartan-erp-engine` (NOT the CRM repo)
- **Composition gate:** **GO** (see §6). Fan-out gate: full work order (8 source files + 4 test
  migrations + 1 migration unit across ≥2 boundaries) → full ceremony warranted.
- **Run mode:** `npx vitest run` (never watch). Auth/identity tests are network-free (mocked JWKS).

---

## 0. Ground-truth notes that change the plan (verified by Read, 2026-06-20)

These differ from or sharpen the ADR's layout — implement specialists MUST honor them:

1. **`tabDocPerm.if_owner` already exists** in `supabase/migrations/20260620010000_meta_core.sql:79`
   (`if_owner boolean not null default false`) AND `loader.js:105` already maps it to `ifOwner`.
   **No schema/loader/registry change for the flag.** This pass only *consumes* it. ✅ matches ADR.
2. **`tabUser` / `tabHasRole` tables do NOT exist.** They must be created by a migration (mirroring
   `tabRole` in meta_core) BEFORE the meta-rows + admin user can be seeded. This is the real ordering
   dependency (U6). `Role` is pinned in `boot-meta.js`; `User`/`Has Role` are **installed by
   migration, NOT pinned** (ADR N5).
3. **Both route files ALREADY call `ctxFromRequest(req)`** (`api/[doctype]/index.js:16`,
   `api/[doctype]/[name].js:17`) but **synchronously and without the `store` arg**, and each has its
   **own outer try/catch returning 500**. Because `ctxFromRequest` is called *outside* `handle()`, an
   `AuthError` thrown by the async resolver lands in the **route's** catch, not `handle()`'s
   `statusFor`. → The routes need their **own** `AuthError → 401` mapping (U5); adding it only to
   `handler.statusFor` is **necessary but not sufficient**. Both are in scope.
4. **Installer seed path is established:** `emitMigration → (human db push) → syncDoctype →
   bumpMetaVersion` (`src/meta/installer.js`). The `User`/`Has Role` meta-doc rows seed via this exact
   path; `def.permissions[].ifOwner` is already carried (`installer.js:135`).
5. **The 4 test seeds use `permlevel: 0` plain perms + `ownerOnly: true` ctx.** Confirmed at
   `perms.test.js:28,37`, `service.test.js:26,34`, `handler.test.js:18,24`, `workflow.test.js:18,97`.

---

## 1. FROZEN interface contracts (specialists MUST NOT diverge)

Each signature below is the boundary between units. Changing one re-opens a critique blocker.

```js
// U1 — src/perms/auth.js  (NEW)
export class AuthError extends EngineError {}              // -> 401  (lives in errors.js, see U0)
export async function verifyGoogleIdToken(token: string): Promise<{
  email: string, email_verified: boolean, sub: string, aud: string, iss: string
}>
//  jose: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
//  jwtVerify(token, jwks, { issuer:['https://accounts.google.com','accounts.google.com'],
//                           audience: loadAuthEnv().GOOGLE_OAUTH_CLIENT_IDS, clockTolerance:'5s' })
//  email_verified !== true        -> throw AuthError
//  ANY non-AuthError throw (JWKS outage, verify fail) -> wrap as AuthError  (N4 fail-closed)

// U0 — src/runtime/errors.js  (MODIFIED)
export class AuthError extends EngineError {}              // name='AuthError'; statusFor -> 401

// U2 — src/validation/env-schema.js  (MODIFIED, lazy)
export function loadAuthEnv(env = process.env): {
  GOOGLE_OAUTH_CLIENT_IDS: string[],   // comma-split, >=1 required, throws plain Error if absent
  devAuth: boolean                     // DEV_AUTH via z.enum(['true','1']); else false (N6 fail-closed)
}

// U3 — src/perms/identity.js  (NEW)
export async function resolveUserToCtx(email: string, store): Promise<Ctx>
//  RAW store.get('tabUser', email)  — NEVER getDoc (N5 no recursion)
//  missing OR enabled===false       -> throw AuthError
//  roles  = store.getChildren('tabHasRole', email, 'User', 'roles').map(r => r.role)
//  branch = user.branch; scopes = branch ? { branch } : {}
//  unrestricted = applyScopePolicy(roles)   // policy LIVES HERE; admin -> unrestricted
//  return makeContext({ user: email, roles, scopes, unrestricted })   // NO ownerOnly

// U4 — src/perms/permissions.js  (MODIFIED)
export function can(ctx, doctype, op, doc?): boolean       // optional doc (F1/F2/F4)
export function assertCan(ctx, doctype, op, doc?): void    // mirrors optional doc
export function assertCanMutate(ctx, doctype, op): void    // NEW cheap pre-load probe (U7 — paired)
export function queryConditions(ctx, doctype): Record<string, any>   // if_owner-derived owner filter
//  helpers (module-private):
//   hasPlainGrant(ctx,dt,op): some permlevel-0 docperm p, p.role∈roles, p[op]===true, p.ifOwner!==true
//   hasOwnerGrant(ctx,dt,op): op!=='create' && some permlevel-0 p, p.role∈roles, p[op]===true, p.ifOwner===true
//  can() formula (Frappe permissions.py L300-345):
//    if hasPlainGrant            -> true
//    if !hasOwnerGrant           -> false
//    if doc !== undefined        -> doc.owner === ctx.user
//    return op === 'read'
//  queryConditions: add { owner: ctx.user } iff hasOwnerGrant(ctx,dt,'read') && !hasPlainGrant(ctx,dt,'read')
//    (REPLACES the removed `if (ctx?.ownerOnly)` line)

// U5 — src/api/context-from-request.js  (MODIFIED, now async)
export async function ctxFromRequest(req, store): Promise<Ctx>
//  bearer = parse 'Authorization: Bearer <jwt>'
//  no bearer: loadAuthEnv().devAuth ? devCtxFromHeaders(req) : GUEST
//  bearer: payload = await verifyGoogleIdToken(bearer); return await resolveUserToCtx(payload.email, store)
//  devCtxFromHeaders(req): the OLD x-spartan-* logic moved verbatim, private fn

// U5 — src/perms/context.js  (MODIFIED)
export function makeContext({ user, roles, scopes, unrestricted }): Ctx   // ownerOnly REMOVED
export const SYSTEM: Ctx   // no ownerOnly
export const GUEST: Ctx    // no ownerOnly
// + Ctx typedef: drop @property ownerOnly

// U5 — src/api/handler.js  (MODIFIED)
function statusFor(err)     // + if (err instanceof AuthError) return 401

// U5 — api/[doctype]/index.js  + api/[doctype]/[name].js  (MODIFIED)
const ctx = await ctxFromRequest(req, store());   // was sync, no store arg
// route catch: if (err instanceof AuthError) res.status(401)...  (see §0.3)
```

---

## 2. Units, dependency order, parallel groups

`tabDocPerm.if_owner` + `loader` already wired (§0.1), so the perms/service work has **no schema
blocker**. The auth/identity work has a **migration ordering** dependency (U6). File-collision groups
are called out (the bit that bit us before — multiple units want `permissions.js` / `context.js` /
`service.js` / `env-schema.js` / `errors.js`).

### Dependency graph (frozen-interface edges from §1)

```
U0 errors.AuthError ──> U1 auth.js, U3 identity.js, U5 routes/ctxFromRequest
U2 loadAuthEnv ───────> U1 auth.js (audience), U5 ctxFromRequest (devAuth)
U1 verifyGoogleIdToken ─> U5 ctxFromRequest
U3 resolveUserToCtx ───> U5 ctxFromRequest         (U3 needs context.makeContext w/o ownerOnly = U5a)
U4 can/queryConditions ─> U8 service.js, U9 test migrations
U6 migration (tabUser/HasRole DDL + meta rows + admin) — independent of U1-U5 code; gates RUNTIME only
```

### Group ordering (specialists)

| Wave | Unit | File(s) — FROZEN owner | Depends on | Parallel-safe with |
|---|---|---|---|---|
| **W0** | **U0** `AuthError` | `src/runtime/errors.js` | — | U2, U6-DDL |
| **W0** | **U2** `loadAuthEnv` | `src/validation/env-schema.js` | — | U0, U6-DDL |
| **W0** | **U4** `if_owner` perms | `src/perms/permissions.js` | — | U0, U2 (diff files) |
| **W0** | **U5a** ctx field removal | `src/perms/context.js` | — | U0, U2, U4 (diff files) |
| **W1** | **U1** `verifyGoogleIdToken` | `src/perms/auth.js` (NEW) | U0, U2 | U3 |
| **W1** | **U3** `resolveUserToCtx` | `src/perms/identity.js` (NEW) | U0, **U5a** | U1 |
| **W1** | **U8** service doc-checks | `src/api/service.js` | **U4** (assertCanMutate/assertCan doc) | U1, U3 |
| **W2** | **U5b** request+routes wiring | `context-from-request.js`, `handler.js`, both route files | U1, U3, U2, U5a | — |
| **W2** | **U9** test migrations + new tests | `perms.test.js`, `service.test.js`, `handler.test.js`, `workflow.test.js` | U4, U5a, U8 | U6-meta |
| **W3** | **U6** migration: tabUser/HasRole DDL + meta-rows seed + admin | `supabase/migrations/*.sql` + a seed script | U5a (makeContext) for runtime only | — |

### FILE-COLLISION serialization (MUST obey — do not parallelize within a row)

- **`src/perms/permissions.js`** — **ONLY U4** touches it. U8 *consumes* its exports, never edits it.
  ✅ no collision.
- **`src/perms/context.js`** — **ONLY U5a** touches it (ownerOnly removal). U3 *imports* `makeContext`,
  never edits it. So **U5a must land before U3** can run green (U3 calls `makeContext` w/o ownerOnly).
  → U5a is W0; U3 is W1. ✅ serialized by wave.
- **`src/api/service.js`** — **ONLY U8** touches it. ✅ no collision.
- **`src/validation/env-schema.js`** — **ONLY U2** touches it. ✅ no collision.
- **`src/runtime/errors.js`** — **ONLY U0** touches it. U1/U3/U5 *import* `AuthError`. ✅ no collision.
- **`src/api/context-from-request.js` + `handler.js` + 2 route files** — **ONLY U5b** touches them,
  as ONE unit (they are a single transport seam). ✅ no collision.
- **The 4 test files** — **ONLY U9** touches them, as ONE unit. ✅ no collision.

> Net: every editable file has **exactly one owning unit**. No two specialists write the same file.
> The only cross-unit ordering is wave-gating (consumers run after producers), enforced by the table.

---

## 3. assertCanMutate — ONE indivisible unit (U7, folded into U4+U8)

**Critique-flagged item #2.** The cheap pre-load probe and the authoritative post-load check are a
**single contract** — shipping the probe without the post-load `assertCan(...,d.doc)` re-opens F1/F3.

- The **probe** (`assertCanMutate` in `permissions.js`) is authored in **U4**.
- The **caller wiring** (post-load `assertCan(ctx,dt,op,d.doc)` after `loadInScope`) is authored in **U8**.
- **Pin:** U8 is **not "done"** until BOTH calls exist for all 4 mutating ops, AND U4's
  `assertCanMutate` exists. Reviewer/lead MUST reject a U8 PR that adds the probe but omits the
  post-load authoritative check (or vice-versa). They ship together or not at all.

`service.js` shape for each of `updateDoc / submitDoc / cancelDoc / transitionDoc`
(submit/cancel/transition keep their `store.transaction` wrapper; updateDoc has none):

```js
assertCanMutate(ctx, dt, op);                 // cheap pre-load 403: throws unless hasPlainGrant||hasOwnerGrant
const d = await loadInScope(ctx, dt, name, txStore);
assertCan(ctx, dt, op, d.doc);                // AUTHORITATIVE owner check (F2/F3)
```

- `op` per fn: updateDoc→`'write'`, submitDoc→`'submit'`, cancelDoc→`'cancel'`, transitionDoc→`'write'`.
- The EXISTING bare `assertCan(ctx, dt, op)` (no doc) at the top of each fn is **REPLACED** by
  `assertCanMutate` (not kept alongside) — a bare `assertCan('write')` now returns **false** for an
  owner-only grant (R-A) and would 403 a legitimate owner before load. `createDoc` / `getDoc` /
  `listDocs` are **unchanged** (R-B; read uses row-filter).

---

## 4. Per-unit spec sketch + done-criteria

### U0 — `AuthError` (`src/runtime/errors.js`)
- **Build:** `export class AuthError extends EngineError {}`.
- **Test:** none new (covered via U1/U5b 401 assertions).
- **Done:** `new AuthError('x').name === 'AuthError'`; existing `errors` imports unbroken.

### U2 — `loadAuthEnv` (`src/validation/env-schema.js`)
- **Build:** `AuthEnvSchema` = `{ GOOGLE_OAUTH_CLIENT_IDS: z.string().min(1)` (comma-split to ≥1 in a
  `.transform`), `DEV_AUTH: z.enum(['true','1']).optional()` coerced to boolean `devAuth }`. Lazy
  (called inside verify/resolve, never at import). Throws plain `Error` (not `ValidationError`) on
  missing client ids, matching `loadPgStoreEnv` style.
- **Test (add to `src/validation/validation.test.js` or a new `env-schema.test.js`):**
  - `loadAuthEnv({ GOOGLE_OAUTH_CLIENT_IDS: 'a,b' })` → `{ GOOGLE_OAUTH_CLIENT_IDS:['a','b'], devAuth:false }`.
  - missing `GOOGLE_OAUTH_CLIENT_IDS` → throws `/GOOGLE_OAUTH_CLIENT_IDS/`.
  - **N6:** `DEV_AUTH:'false'` → `devAuth===false`; `'0'`/unset/`''` → `false`; `'true'`/`'1'` → `true`.
- **Done:** all above green; not invoked at import (no top-level call).

### U4 — `if_owner` enforcement (`src/perms/permissions.js`)
- **Build:** add `hasPlainGrant` / `hasOwnerGrant` (permlevel-0, `hasOwnerGrant` excludes `create`);
  rewrite `can(ctx,dt,op,doc?)` to the §1 formula; `assertCan` gains optional `doc`; add
  `assertCanMutate(ctx,dt,op)` (throws `PermissionError` unless `hasPlainGrant||hasOwnerGrant`);
  rewrite `queryConditions` owner clause to `hasOwnerGrant('read') && !hasPlainGrant('read')` and
  **delete** the `if (ctx?.ownerOnly)` line. No other fn changes (`visibleFields`/`maskRead`/
  `assertCanWrite` untouched).
- **Test (in `perms.test.js`, U9 owns the file — but U4 specifies the assertions):**
  - **F1:** role with owner-only write: `can(ctx,'Job','write')` (no doc) === **false**;
    `can(ctx,'Job','write', {owner:'rep@x'})` === true; `…,{owner:'other@x'})` === false.
  - **R-A read:** owner-only read, no doc → `can(...,'read')` === true.
  - **N1 union (plain wins):** ctx roles `['repA','repB']`, repA plain-write + repB owner-only-write →
    `can(ctx,'Job','write')` (no doc) === **true** (plain wins; owner ignored).
  - **F4 create:** `if_owner:true` on a create docperm → `can(ctx,'Job','create')` honors a plain
    create grant only; owner flag ignored.
  - **queryConditions:** owner-only-read (no plain read) → filter has `{owner:ctx.user}`; plain read →
    no `owner` key.
- **Done:** above green; `grep ownerOnly src/perms/permissions.js` → no matches.

### U5a — `ownerOnly` removal (`src/perms/context.js`)
- **Build:** drop `ownerOnly` from `makeContext` destructure+return, from `SYSTEM`, `GUEST`, and the
  `Ctx` typedef. (N7 — delete, not deprecate.)
- **Test:** none new; the suite's removal of `ownerOnly:true` seeds (U9) covers it.
- **Done:** `grep ownerOnly src/perms/context.js` → no matches; `makeContext({user,roles})` returns a
  ctx with no `ownerOnly` key.

### U1 — `verifyGoogleIdToken` (`src/perms/auth.js`, NEW)
- **Build:** §1 contract. Import `createRemoteJWKSet, jwtVerify` from `jose` (confirm `jose` is a dep —
  see §6 probe note), `loadAuthEnv` from env-schema, `AuthError` from errors. Module-scope memoized
  `jwks` (one `createRemoteJWKSet`). Wrap any non-`AuthError` throw → `AuthError` (N4).
- **Test (`src/perms/auth.test.js`, NEW — network-free):** mock `jose` via `vi.mock('jose', …)`:
  - valid payload (`email_verified:true`) → returns `{email,…}`.
  - `email_verified:false` → throws `AuthError`.
  - `jwtVerify` rejects (bad sig / expiry) → throws `AuthError`.
  - JWKS factory throws (outage) → throws `AuthError` (N4, **not** a bare Error/500).
- **Done:** above green; **no real network call** in the test (mocked).

### U3 — `resolveUserToCtx` (`src/perms/identity.js`, NEW)
- **Build:** §1 contract. RAW `store.get('tabUser', email)` + `store.getChildren('tabHasRole', email,
  'User', 'roles')`. `applyScopePolicy(roles)` = `roles.includes('admin')` → `unrestricted:true`
  (module-private; the role→scope policy lives here). Reject missing/`enabled===false` → `AuthError`.
- **Test (`src/perms/identity.test.js`, NEW — `MemoryStore`):**
  - seed `tabUser`/`tabHasRole` rows; `resolveUserToCtx('rep@x', store)` → `{user:'rep@x',
    roles:['rep'], scopes:{branch:'VIC'}, unrestricted:false}` and **no `ownerOnly` key**.
  - admin user → `unrestricted:true`.
  - missing user → `AuthError`; `enabled:false` user → `AuthError`.
  - **N5 guard:** the resolver imports from `runtime/store` / `context`, **not** from `service.js`
    (assert by code, not test) — no `getDoc` import. Reviewer checks the import list.
- **Done:** above green; no `service.js`/`getDoc` import in `identity.js`.

### U8 — service doc-level checks (`src/api/service.js`)
- **Build:** per §3 — replace the bare top-of-fn `assertCan(ctx,dt,op)` with `assertCanMutate(ctx,dt,op)`
  and add post-load `assertCan(ctx,dt,op,d.doc)` after each `loadInScope`, for
  `updateDoc/submitDoc/cancelDoc/transitionDoc`. Import `assertCanMutate`. `createDoc/getDoc/listDocs`
  unchanged.
- **Test (assertions specified here; live in `service.test.js`, U9 owns file):**
  - **F3 breach:** plain-read + owner-only-write rep `updateDoc`-ing a co-worker's in-branch doc →
    rejects `PermissionError` (403).
  - owner updating their own doc → succeeds.
  - no-grant role (`viewer` writing) → `PermissionError` from `assertCanMutate` **before** any load
    (assert the doc was never loaded — e.g. spy `loadDoc` not called, or simply 403).
- **Done:** above green; both calls present for all 4 ops; reviewer confirms the **pair** (§3 pin).

### U5b — request + routes wiring (`context-from-request.js`, `handler.js`, both route files)
- **Build:**
  - `context-from-request.js` → async per §1; move old `x-spartan-*` logic into private
    `devCtxFromHeaders(req)` **verbatim** (it still sets the old derived fields EXCEPT `ownerOnly` —
    drop that line, since context.js no longer accepts it); bearer path
    verify→resolve; no-bearer path `devAuth ? devCtxFromHeaders : GUEST`.
  - `handler.js` `statusFor` → `+ AuthError → 401`.
  - both route files → `const ctx = await ctxFromRequest(req, store());` AND add
    `if (err instanceof AuthError) return res.status(401).json({error:err.message,type:'AuthError'})`
    to the route catch (import `AuthError`). (§0.3 — the route catch, not just `statusFor`.)
- **Test (`src/api/handler.test.js` additions, U9 owns file + an optional route smoke):**
  - **N6 dead-shim:** with `devAuth=false` (no `DEV_AUTH`), a request with `x-spartan-*` headers and
    no bearer → `ctxFromRequest` returns `GUEST` (header path dead). Assert via a direct
    `ctxFromRequest` call with a stub store (no bearer).
  - `devAuth=true` + `x-spartan-*` → builds the dev ctx (back-compat for the suite).
  - `statusFor(new AuthError('x')) === 401`.
- **Done:** above green; routes compile with `await` + 401 mapping; **full suite** (`npx vitest run`)
  green.

### U9 — test migrations + new tests (4 files, ONE unit)
- **Build — migrate the 4 `rep` seeds (critique-flagged item #3 — SWAP, don't add):**
  In each of `perms.test.js`, `service.test.js`, `handler.test.js`, `workflow.test.js`:
  1. change the `rep` docperm from `{permlevel:0, read:true, write:true, create:true}` to **three**
     rows: `{read:true, ifOwner:true}` + `{write:true, ifOwner:true}` + `{create:true}` (create stays
     plain — R-B). **The read perm is REPLACED by owner-only read** (not owner-read added alongside a
     plain read) — else `hasPlainGrant('read')` stays true, the `{owner}` filter vanishes, and
     `service.test.js:62` "rep sees only own+branch → `['rep-vic']`" breaks.
  2. drop `ownerOnly:true` from the `rep` ctx (now `{user:'rep@x', roles:['rep'], scopes:{branch:'VIC'}}`).
  - **Assertions UNCHANGED** — same `['rep-vic']`, same NotFound-out-of-scope, same masking. They now
    pass via `if_owner`-derived filtering instead of `ctx.ownerOnly`.
- **Build — add new tests** (per U4/U8/U5b specs above): F1, N1 union, F4, F3 cross-owner-update→403,
  N6 dead-shim. (Auth-only F1/N1/F4 → `perms.test.js`; F3 → `service.test.js`; N6 → `handler.test.js`.)
- **Done:** `npx vitest run` green for these 4 files; `grep -r ownerOnly src/` returns **only** any
  intentional comment, no live reads (per critique L57-60 there are none outside the edited sites).

### U6 — migration: `tabUser`/`tabHasRole` + meta rows + bootstrap admin (critique-flagged item #1)
- **Build (ordered — this IS the ordering fix):**
  1. **DDL migration** `supabase/migrations/<ts>_user_identity.sql`: `create table if not exists
     "tabUser"` (framework cols + `email text`, `full_name text`, `branch text`, `enabled boolean not
     null default true`) and `"tabHasRole"` (framework cols + `parent/parenttype/parentfield`, `role
     text`) mirroring `tabRole`/child-table shape in `meta_core.sql`. Idempotent, rollback comment,
     `grant all … to service_role`.
  2. **Meta-rows seed** (a seed script `scripts/seed-user-meta.mjs` or a bootstrap step): call
     `installer.syncDoctype(USER_DEF, store)` + `syncDoctype(HAS_ROLE_DEF, store)` + `bumpMetaVersion`
     where `USER_DEF` = the `User`/`Has Role` DocMeta defs (autoname `field:email`; `roles` Table →
     `Has Role`; `Has Role` child with `role` Link→Role). **`Has Role` must be synced before/with
     `User`** (Table-target closure — loader throws if the child meta isn't primed; see
     `loader.js:112`).
  3. **Bootstrap admin user**: same script inserts one `tabUser` row + a `tabHasRole` child with
     `role:'admin'`. **Admin email source (DECISION):** an env var `BOOTSTRAP_ADMIN_EMAIL` read by the
     seed script (KISS, no new schema, ops-supplied). Document it; the script is idempotent
     (upsert-by-email). Fail-fast if unset.
- **ORDERING (frozen): DDL `db push` → meta-rows seed → admin seed → ONLY THEN expose routes.** A
  route serving an authenticated request before `tabUser` meta+rows exist would 401 every real user
  (resolver `store.get('tabUser', …)` → missing → AuthError). State this in the migration runbook.
- **Test (`src/meta/installer.test.js` style or a new `user-meta.test.js` over `MemoryStore`):**
  - `syncDoctype(HAS_ROLE_DEF)` then `syncDoctype(USER_DEF)` → `getMeta('User')` resolves, `roles`
    child table present.
  - after seeding a `tabUser` + `tabHasRole(admin)`, `resolveUserToCtx(adminEmail, store)` →
    `unrestricted:true` (end-to-end U3↔U6 compose check).
  - **DDL idempotency** (if the repo's `migrations-idempotent` harness applies): the new migration is
    re-runnable.
- **Done:** tables created (dry-run clean), meta resolves, admin resolves to unrestricted, runbook
  ordering note added. **`supabase db push` is HUMAN-RUN** (CLAUDE.md §1/§7 — deploy is not
  agent-initiated): implement emits the migration + seed script and **surfaces the push to the human**.

---

## 5. Assembly + integration sequence

1. **W0 (parallel):** U0, U2, U4, U5a land + unit-green individually.
2. **W1 (parallel):** U1, U3, U8 land on top of W0 (U3 needs U5a's `makeContext`; U8 needs U4's
   exports). Unit-green.
3. **W2:** U5b wires the seam; U9 migrates the 4 seeds + adds new tests. Run **full** `npx vitest run`
   — the whole suite (incl. the migrated 4) must be green. This is the integration gate for the code
   half.
4. **W3:** U6 emits the DDL migration + seed script; unit-test the meta+admin resolve over MemoryStore;
   **surface `supabase db push` + seed run to the human** (not agent-run). Add the runbook ordering note.
5. **Final:** full `npx vitest run` green; confirm `grep -r ownerOnly src/` has no live readers;
   implement finalizes the BugWiki page + flips the registry entry + updates any `salesAppTopo2.puml`
   edge if the engine is mapped there (it is a separate repo — likely no CRM-vault edge; note in
   diary if so).

---

## 6. Composition go/no-go

**GO.** Buildability confirmed:

- **Interfaces line up:** every §1 signature has exactly one producer and named consumers; the
  dependency edges (§2 graph) are acyclic. `AuthError` (U0) is the only shared new type and is
  producer-first.
- **No file collision:** §2 proves every editable file has a single owning unit; cross-unit order is
  wave-gating, not co-editing. The previously-biting case (multiple units on
  `permissions.js`/`context.js`/`service.js`/`env-schema.js`) is resolved by assigning each file to
  ONE unit and having consumers *import*, not edit.
- **Contract-compliant:** the `can()` formula matches Frappe (critique re-verified); `assertCanMutate`
  is pinned as an indivisible pair with the post-load check (§3); the 4-seed migration is a SWAP not an
  ADD (§4 U9 done-criteria); migration ordering is sequenced with a concrete admin-email source (§4 U6).
- **No cycle:** U3 reads the raw store, never `getDoc` (N5) — the auth-resolution recursion is
  designed out and enforced by an import check.

**One probe to confirm before W1 (read-only, ≤1 min, implement or lead):** verify `jose` is a declared
dependency — `Select-String '"jose"' C:\Users\parrg\Documents\spartan-erp-engine\package.json`. If
absent, U1 gains a sub-step "add `jose` to deps" (an `npm i jose` is a normal dev action, not a
deploy). This does not change the GO — it's a known, contained pre-step.

---

## 7. Per-unit assignment for `implement` specialists

| Unit | File(s) | Wave | Spawn note |
|---|---|---|---|
| U0 | `src/runtime/errors.js` | W0 | tiny — could fold into whoever takes U2 |
| U2 | `src/validation/env-schema.js` | W0 | + env tests |
| U4 | `src/perms/permissions.js` | W0 | the core `if_owner` formula; assertions specified, file owned by U9 |
| U5a | `src/perms/context.js` | W0 | `ownerOnly` removal only |
| U1 | `src/perms/auth.js` (NEW) + `auth.test.js` | W1 | mock `jose`; confirm `jose` dep first |
| U3 | `src/perms/identity.js` (NEW) + `identity.test.js` | W1 | RAW store only; no `getDoc` import |
| U8 | `src/api/service.js` | W1 | §3 pin — probe + post-load check ship together |
| U5b | `context-from-request.js`, `handler.js`, both route files | W2 | route catch needs its OWN 401 (§0.3) |
| U9 | 4 test files | W2 | SWAP read perm (§4 item 3); add F1/N1/F4/F3/N6 |
| U6 | `supabase/migrations/*.sql` + seed script | W3 | `db push` + seed = HUMAN-RUN; `BOOTSTRAP_ADMIN_EMAIL` |

> **Lead:** W0 = up to 4 parallel specialists; W1 = up to 3; W2 = 2 (U5b then/with U9); W3 = 1.
> Enforce the §3 pin on U8 review and the §4-U9 SWAP-not-ADD on U9 review — those two are the
> regression traps. `supabase db push` (U6) requires explicit human confirmation (CLAUDE.md §1/§7).
