# ADR: Identity Layer (Pass C) — Google idToken auth, User model, ctx resolution, `if_owner`

- **Status:** Proposed — REV 2 (post critique FAIL on the `if_owner` half; auth half PASSED unchanged)
- **Date:** 2026-06-20
- **Scope:** `spartan-erp-engine` — replace the dev `x-spartan-*` header shim with verified
  Google-idToken identity, resolve identity → roles + branch → `Ctx`, and enforce the
  `if_owner` docperm flag that the loader already reads but nobody consumes.
- **Companion diagram:** `diagrams/identity-layer-class.puml`
- **REV 2 changelog:** §5 rewritten to fix F1 (inverted owner capability), F2 (dead doc-level
  enforcement — now an explicit `service.js` work order), F3 (the breach trace), F4 (exclude
  `create`), F5 (the §3/§5 contradiction — option (a): migrate the 4 seeds, churn owned). Non-blocking
  N1–N7 folded into §5/§6. Auth half (§1–§4) unchanged except the test-story caveat in §3.

---

## 1. Problem

Today `ctxFromRequest` (`src/api/context-from-request.js`) **trusts the caller**: it reads
`x-spartan-user / -roles / -branch` straight off the request and builds the `Ctx` the whole
permission engine relies on. Any client can claim any user, any roles, and admin/`unrestricted`.
The shim's own header says it: *"NOT secure on its own… replace with verified-token resolution."*

Two things are missing for a real deployment:

1. **Authentication** — proof the caller is who they claim. The CRM, CAD, and mobile clients
   already sign in with **Google**; the engine just needs to verify the idToken they already hold.
2. **`if_owner` enforcement** — `tabDocPerm.if_owner` is mapped to `DocPerm.ifOwner` by the loader
   (`src/meta/loader.js:105`) and typed in the registry, but `permissions.js` never reads it. A
   role whose grant is `if_owner` should reach a doc **only when it owns it** — the Frappe rule.

Constraint: the hermetic tests build `Ctx` directly via `makeContext` and never traverse the
request/auth path, so **token verification** is test-neutral. The `if_owner` rework is **not**
test-neutral — see §3 caveat and §5 F5.

---

## 2. Decisions — auth half (PASSED critique, unchanged)

### §1 — Token verification (LOCKED: Google idTokens via `jose`)

New module **`src/perms/auth.js`** exporting `verifyGoogleIdToken(token) → Promise<{email, email_verified, sub, aud, iss}>`:

- `createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))` — `jose` fetches
  Google's signing keys once and caches/rotates them internally (no manual cache needed).
- `jwtVerify(token, jwks, { issuer, audience, clockTolerance: '5s' })`:
  - **issuer** = `['https://accounts.google.com', 'accounts.google.com']` (Google emits both).
  - **audience** = **a list** of allowed Google OAuth client ids (`GOOGLE_OAUTH_CLIENT_IDS`).
    CRM, CAD, and mobile may each have their own client id, so audience is an array — `jose`
    accepts a token whose `aud` matches **any** entry.
  - **`clockTolerance: '5s'`** (N3) — `jose`'s default is 0, which 401s tokens at the edge of expiry
    on a slow cold lambda. A small skew window avoids spurious rejects without materially weakening
    expiry.
- Throws **`AuthError`** (new, → HTTP 401) on bad signature / issuer / audience / expiry, or when
  `email_verified !== true`. One identity across CRM/CAD/engine, no Supabase Auth.
- **Fail-closed JWKS (N4):** `createRemoteJWKSet` fetches lazily on first verify; a cold-lambda
  network failure rejects *inside* `jwtVerify`. `verifyGoogleIdToken` lets that reject propagate **as
  `AuthError`** (wrap any non-`AuthError` throw from the JWKS/verify call into `AuthError`), so a
  JWKS outage yields **401, never a 500 that could be read as "auth skipped."** The route try/catch +
  `statusFor(AuthError)→401` then surface it correctly.

**Env (lazy pattern)** — add `loadAuthEnv()` to `src/validation/env-schema.js`, mirroring
`loadPgStoreEnv`: an `AuthEnvSchema` with `GOOGLE_OAUTH_CLIENT_IDS` (comma-split, ≥1 required) and
`DEV_AUTH` (see N6). **Lazy** — called inside verify/resolve, never at import — so MemoryStore-only
tests that never authenticate are unaffected.

- **N6 — `DEV_AUTH` parse must fail closed.** `Boolean(process.env.DEV_AUTH)` makes the string
  `"false"` truthy — a prod footgun. Specify in the schema that **only an explicit `"true"` or `"1"`
  enables the header shim** (`z.enum(['true','1']).optional()`, coerced to a boolean `devAuth`);
  unset / empty / `"false"` / `"0"` ⇒ `false`. Add a test asserting `DEV_AUTH="false"` ⇒ header path
  dead.

### §2 — Identity model: a **`User` DocType** (meta-as-data), not a lean table

**Decision: model identity as a Frappe-faithful `User` DocType with a `Has Role` child table**,
stored as ordinary rows in `tabUser` / `tabHasRole`, loaded by the **same** `MetaLoader.ensure()`
path as every other doctype. Not a bespoke `users` table.

`User` fields: `name` = email (`autoname: 'field:email'` — email is the Frappe key), `email`,
`full_name`, `branch` (the row-scope value → `ctx.scopes.branch`), `enabled` (Check), and
`roles` (Table → `Has Role`). `Has Role` holds `parent → User`, `role → Role`.

**Justification:**
- **Frappe-faithful:** Frappe's `User` DocType carries roles via the **"Has Role"** child table
  (`frappe/core/doctype/user/user.json` → `roles` field; `frappe/core/doctype/has_role`). The engine
  is explicitly Frappe-faithful (boot-meta.js cites the same JSON); `User` is the consistent next
  member of the meta set.
- **DRY / one access pattern:** identity loads through the existing `store.get` + child-table
  machinery — no second query path, no parallel CRUD, no new RLS surface. `Role` already exists in
  boot-meta, so `Has Role → Role` reuses it.
- **SOLID/SoC:** the meta layer owns "what a User is"; the resolver owns "email → ctx."
- **Lean `users` table rejected:** introduces a bespoke schema + query the rest of the engine
  doesn't share, diverges from Frappe, and still needs a roles representation. The DocType is the
  *smaller* net addition.

### §2 (cont.) — The ctx resolver + scope policy

New module **`src/perms/identity.js`** exporting `resolveUserToCtx(email, store) → Promise<Ctx>`:

1. **raw** `store.get('tabUser', email)` → reject (`AuthError`) if missing or `enabled === false`.
2. roles = the user's `Has Role` child rows → `[role_name, …]`.
3. branch = `User.branch`; `scopes = branch ? { branch } : {}`.
4. `unrestricted = applyScopePolicy(roles)` — **the role→scope policy lives in the identity layer**,
   exactly where the dev shim and `context.js` say it must (`unrestricted` is an explicit grant,
   never a `role === 'admin'` short-circuit inside the evaluator). `admin → unrestricted`.
5. `return makeContext({ user: email, roles, scopes, unrestricted })`.

**N5 — raw-store, no recursion (explicit):** `resolveUserToCtx` reads via **raw `store.get`,
never via the perm-gated `getDoc` service path.** Resolving a user must not itself require a resolved
user — routing it through `getDoc` would create an auth-resolution recursion. Implement MUST keep it
on the raw store. `Role` is pinned in boot-meta; `User`/`Has Role` DocType meta + the first admin
user are installed by migration, which **must run before the first authenticated request** (ordering
flagged for planner).

`ctx.ownerOnly` is **not** set here — see §5 (it is being removed entirely, N7).

### §3 — Replace the dev shim; dev/test story

`ctxFromRequest(req, store)` becomes **async** and:

- parses `Authorization: Bearer <jwt>`;
- **no bearer** → if `devAuth` (from `loadAuthEnv`, N6) is true, fall back to
  `devCtxFromHeaders(req)` (the *old* `x-spartan-*` logic, moved verbatim into a private fn);
  otherwise return `GUEST`;
- with a bearer → `await verifyGoogleIdToken` → `await resolveUserToCtx(payload.email, store)`.

**No silent insecure fallback.** The `x-spartan-*` path runs **only** when `DEV_AUTH` is explicitly
truthy. With it unset (prod default), an unauthenticated request is `GUEST`, an invalid token is 401.

**Test story:** token verification is test-neutral (the hermetic tests never hit `ctxFromRequest` /
`auth.js` / `identity.js`); new auth/identity unit tests are additive and network-free.

> **Caveat — the `if_owner` half is deliberately NOT test-neutral.** The original draft's blanket
> "all 261 tests unaffected" is true for the auth half but **false for the `if_owner` half**: 4 tests
> build a `rep` ctx with `ownerOnly: true` and assert owner-scoping. §5 (F5, option a) migrates those
> seeds to `if_owner` docperms — an **intended, owned** edit, listed in the §6 work order, not a
> silent regression. The net expectation after Pass C: the auth-half count holds; the 4 owner-scope
> tests are *rewritten* (same assertions, `if_owner`-driven seeds) and stay green.

### §4 — Routes await the async ctx

`api/[doctype]/[name].js` and `api/[doctype]/index.js` change `const ctx = ctxFromRequest(req)` to
`const ctx = await ctxFromRequest(req, store())` and map `AuthError → 401` (the route already has a
try/catch; `statusFor` in `handler.js` also learns `AuthError → 401`). `handle()` itself is
unchanged — it already receives a fully-built `ctx`.

---

## 3. Decisions — `if_owner` half (REV 2, rewritten)

### §5 — `if_owner` enforcement, Frappe-faithful

Frappe ground truth (`permissions.py:get_role_permissions`, L300–345, verified live 2026-06-20):

```python
def is_perm_applicable(perm):
    return perm.role in roles and cint(perm.permlevel) == 0          # N2: permlevel-0 only
def has_permission_without_if_owner_enabled(ptype):
    return any(p.get(ptype, 0) and not p.get("if_owner", 0)          # N1: union across all perms
               for p in applicable_permissions)
...
for ptype in get_rights(doctype):
    pvalue = any(p.get(ptype, 0) for p in applicable_permissions)
    perms[ptype] = cint(pvalue)
    if (pvalue and has_if_owner_enabled
        and not has_permission_without_if_owner_enabled(ptype)
        and ptype != "create"):                                      # F4: create excluded
        perms["if_owner"][ptype] = cint(pvalue and is_owner)
        perms[ptype] = 1 if ptype in ("select", "read") else 0       # F1: read=1, mutate=0
```

The three rules the design must encode, verbatim from the above:

- **R-A (F1 — capability for an owner-only op):** when a ptype is granted *only* via `if_owner`,
  Frappe sets the bare capability `perms[ptype] = 1` **for read/select only**, and `= 0` for every
  mutating op (write/submit/cancel/delete). So a no-doc capability probe of an owner-only **mutating**
  op is **FALSE**; only read stays reachable (so the user can open the list, which is then
  owner-filtered).
- **R-B (F4 — create excluded):** `if_owner` never applies to `create` (`ptype != "create"`) — you
  can't own a not-yet-existing doc. An `if_owner` flag on a create docperm is ignored; create is
  granted iff some applicable permlevel-0 docperm has `create:true` (today's `can()` behaviour).
- **R-C (N1 — plain wins, union):** `has_permission_without_if_owner_enabled` is computed across
  **all** applicable perms. Role A plain-write + role B owner-only-write ⇒ a plain grant exists ⇒ no
  owner restriction at all. `if_owner` only bites when *no* plain grant for that op exists.

#### Helpers in `permissions.js` (permlevel-0 only — N2)

```
hasPlainGrant(ctx, dt, op):
  some permlevel-0 docperm p where p.role ∈ ctx.roles && p[op]===true && p.ifOwner!==true
hasOwnerGrant(ctx, dt, op):
  op !== 'create'                                   // R-B
  && some permlevel-0 docperm p where p.role ∈ ctx.roles && p[op]===true && p.ifOwner===true
```

(Both mirror the existing `can()` `(p.permlevel ?? 0) === 0` guard — N2.)

#### `can(ctx, doctype, op, doc?)` — the corrected formula (F1 + F2 + F4)

```
if hasPlainGrant(ctx,dt,op):                 return true        // R-C: plain wins, owner ignored
if !hasOwnerGrant(ctx,dt,op):                return false       // deny-by-default (R-B folds in here)
// owner-only grant from here:
if doc !== undefined:                        return doc.owner === ctx.user   // F2 doc-level check
return op === 'read'                                            // R-A: no-doc -> true ONLY for read
```

- **No-doc owner-only `read`** → `true` (list reachability; the row filter does the rest).
- **No-doc owner-only `write/submit/cancel/delete`** → `false` (Frappe `perms[ptype]=0`). This is the
  F1 fix — the bare op-gate is no longer a no-op for owner-only mutations.
- **Doc present** → `doc.owner === ctx.user` for *any* owner-only op. This is the F2 enforcement
  point.

`assertCan(ctx, dt, op, doc?)` mirrors the new optional `doc`.

#### `queryConditions(ctx, doctype)` — list owner filter (F3, Frappe `requires_owner_constraint`)

Keep it **read-gated** (Frappe `db_query.requires_owner_constraint`, L1472–1487: owner constraint
applies only when read/select is *not* available without being owner):

```
add { owner: ctx.user }  iff  hasOwnerGrant(ctx,dt,'read') && !hasPlainGrant(ctx,dt,'read')
```

This replaces today's `if (ctx?.ownerOnly) filter.owner = ctx.user`. It is correct **for lists** and
for the `loadInScope` of mutating ops *when read is owner-only*. It is **NOT** sufficient on its own
when read is plain but write is owner-only — that gap is closed by F2/F3 below, not by this filter.

#### F2 — the doc-level check must actually run (explicit `service.js` work order)

The doc-level branch of `can()` is **dead code unless `service.js` passes the loaded doc.** REV 2
makes this an explicit contract change (a planner work order, **not** "audit during implement").
After `loadInScope(...)`, each mutating single-doc op calls `assertCan(ctx, doctype, op, d.doc)`:

| `service.js` fn | line (current) | add after `loadInScope` |
|---|---|---|
| `updateDoc`     | ~`assertCan(ctx,dt,'write')` then `loadInScope` | `assertCan(ctx, dt, 'write', d.doc)` |
| `submitDoc`     | `assertCan(ctx,dt,'submit')` then `loadInScope` | `assertCan(ctx, dt, 'submit', d.doc)` |
| `cancelDoc`     | `assertCan(ctx,dt,'cancel')` then `loadInScope` | `assertCan(ctx, dt, 'cancel', d.doc)` |
| `transitionDoc` | `assertCan(ctx,dt,'write')` then `loadInScope` | `assertCan(ctx, dt, 'write', d.doc)` |

The existing **pre-load** `assertCan(ctx, dt, op)` (no doc) stays as the fast 403 (R-A returns false
for an owner-only mutating grant before any PG work — preserving the "403 before any PG work"
invariant the comments call out). The **post-load** `assertCan(ctx, dt, op, d.doc)` is the owner
check against the real doc. `getDoc` needs no post-load check (read reachability + the row filter are
sufficient and Frappe-faithful). `createDoc` is unchanged (R-B: `create` is never owner-gated).

> Note the two-call shape is intentional: pre-load gives fast-fail + keeps the "no PG work on a
> denied op" property; post-load gives the real owner enforcement. A role with **plain** write sees
> both calls pass trivially (R-C). A role with **owner-only** write fails the pre-load call unless it
> *might* own a doc — and here is the subtlety: pre-load `assertCan('write')` with no doc returns
> **false** under R-A, which would 403 a legitimate owner before the doc is even loaded. **Resolution
> (chosen):** for the mutating ops the pre-load call is **dropped to the no-PG-cheap existence of any
> grant** — i.e. pre-load uses `hasPlainGrant || hasOwnerGrant` (a "could this user ever do this op?"
> probe), and the **authoritative** decision is the post-load `assertCan(...,d.doc)`. Concretely:

```
// service.js mutating op, REV 2 shape:
if (!hasPlainGrant(ctx,dt,op) && !hasOwnerGrant(ctx,dt,op))  -> 403   // cheap, no PG
const d = await loadInScope(ctx, dt, name, txStore);
assertCan(ctx, dt, op, d.doc);                                        // authoritative owner check
```

To avoid leaking that helper pair across the service layer, `permissions.js` exposes a small
`assertCanMutate(ctx, dt, op)` (the cheap pre-load probe: throws unless `hasPlainGrant||hasOwnerGrant`)
so `service.js` keeps calling two named functions, not poking helpers. (Naming is implement's to
finalize; the *contract* is: cheap any-grant probe pre-load, authoritative doc check post-load.)

#### F3 — the breach this closes (trace, confirmed)

Role with **plain read + owner-only write** (a common "reps see the branch, edit only their own"
shape):

1. `queryConditions` adds **no** owner filter — plain read exists (correct, Frappe-faithful).
2. `loadInScope` for `updateDoc` loads any in-branch doc (correct — read is branch-wide).
3. **Pre-REV-2:** `assertCan('write')` (no doc) returned "potentially granted" (truthy) ⇒ the write
   sailed through ⇒ **rep writes a co-worker's doc.** Over-grant.
4. **REV 2:** the cheap pre-load probe passes (the user *does* have an owner-only write grant), but
   the **post-load `assertCan(ctx,dt,'write',d.doc)`** evaluates `doc.owner === ctx.user` → **false
   for a co-worker's doc → 403.** Breach closed by F2, independently of the read-derived list filter.

#### F5 — `ownerOnly` removed; the 4 seeds migrated to `if_owner` (option a, owned)

**Decision: remove `ctx.ownerOnly` entirely (N7) and drive owner-scope from `if_owner` docperms.**
The dev shim's `ownerOnly = roles.includes('rep')` was a hardcoded stand-in for exactly the
data-driven `if_owner` rule. Keeping both (option b) is two sources of truth (DRY violation) and
leaves a field nothing writes — a latent trap (someone reads `ctx.ownerOnly`, gets `false`, assumes
"not owner-scoped"). So:

- `queryConditions` drops the `if (ctx?.ownerOnly)` line (replaced by the `if_owner`-derived filter
  above).
- `ctx.ownerOnly` is **deleted** from `makeContext` / `SYSTEM` / `GUEST` / the `Ctx` typedef (N7) —
  not left as a dead "deprecated" field.

**The 4 tests that build `rep` with `ownerOnly:true` are migrated (intended churn, owned here):**

- `src/perms/perms.test.js:37`
- `src/api/service.test.js:34` (assertions at `:56-69` "rep sees only own+branch", `:71-73`
  out-of-scope→NotFound)
- `src/api/handler.test.js:24`
- `src/workflow/workflow.test.js:97`

Migration per seed: the `rep` docperm changes from plain `{read:true, write:true, create:true}` to
`{read:true, ifOwner:true}` + `{write:true, ifOwner:true}` + `{create:true}` (create stays plain,
R-B), and the `rep` ctx drops `ownerOnly:true` (it now carries only `roles:['rep'], scopes:{branch}`).
The **assertions are unchanged** — `service.test.js`'s "rep sees only own+branch" → `['rep-vic']`
still holds, because owner-only read with no plain read now drives the same `{owner:'rep@x'}` filter.
This is the *data-driven truth* and is the reason option (a) is chosen over (b).

**New tests to add (N1 + N3 + N6, flagged for planner/implement):**
- N1: two roles, one plain-write + one owner-only-write, asserting the owner is **not** restricted
  (R-C union, Frappe-faithful, currently untested).
- F1: a role with owner-only write — bare `can(ctx,dt,'write')` (no doc) is **false**;
  `can(ctx,dt,'write',ownDoc)` true, `can(ctx,dt,'write',otherDoc)` false.
- F3: end-to-end `updateDoc` of a co-worker's doc by a plain-read+owner-only-write rep → 403.
- N6: `DEV_AUTH="false"` ⇒ header path dead.

`DocPerm.ifOwner` is **already** loaded (`loader.js:105`) and typed (`registry.js` `DocPerm`) — this
pass only newly *consumes* it; no loader/registry change.

---

## 4. Consequences

- **Security:** the engine stops trusting client-asserted identity; roles/branch/admin come from a
  verified Google email mapped to a server-side `User` doc. Owner-scope is data-driven and enforced
  at the doc for mutations (F2/F3), not just via the read-derived list filter.
- **Blast radius (REV 2 — now includes `service.js`):** new files `auth.js`, `identity.js`; edits to
  `context-from-request.js` (async), both route files (`await` + 401), `env-schema.js`
  (`loadAuthEnv` + `DEV_AUTH` parse), `errors.js` (`AuthError`), `permissions.js` (`if_owner` in
  `can`/`assertCan` + `queryConditions` + new `assertCanMutate`), and **`service.js`** (post-load
  `assertCan(...,d.doc)` + cheap pre-load probe for the 4 mutating ops). `handle()` and the meta layer
  are untouched.
- **`can()` signature** gains an **optional** `doc` — existing 2-arg callers still compile; the
  *behaviour* for owner-only mutating ops changes (F1), which is the point. The `service.js` edits
  are the callers that must pass the doc (no longer deferred — F2).
- **Test churn (owned):** the 4 owner-scope seeds are migrated to `if_owner` (F5); `ownerOnly` is
  deleted everywhere (N7); ~4 new tests added (N1/F1/F3/N6). Net: same assertions, `if_owner`-driven.
- **Migration dependency:** seeding `User`/`Has Role` DocType meta + an admin user must run before
  the first authenticated request (N5 ordering); flagged for `planner`.
- **Perf:** one extra raw `store.get('tabUser', email)` per request (cacheable later — YAGNI). JWKS
  fetched once, cached by `jose`.

---

## 5. Design-contract compliance

- **DRY** — owner-scope has ONE source (`if_owner` docperms); `ownerOnly` removed, not duplicated.
- **KISS / YAGNI** — reuse `jose` + existing loader; no token cache, no Supabase Auth, no new RLS.
- **SOLID / SoC** — verify (auth.js) ≠ resolve+policy (identity.js) ≠ evaluate (permissions.js) ≠
  gate (service.js) ≠ transport (routes). The evaluator still never role-short-circuits.
- **Least Privilege** — `if_owner` *narrows* (owner-only when no plain grant), never widens; an
  owner-only mutating grant no longer over-grants via a no-op capability probe (F1); `create` is
  never owner-gated (F4, can't be narrower than "may create"); no `DEV_AUTH` ⇒ no header trust.
- **Fail-Fast / Fail-Closed** — invalid/forged token, JWKS outage, unknown/disabled user → `AuthError`
  (401) before any doc work (N4); cheap pre-load 403 keeps "no PG work on a denied op"; `loadAuthEnv`
  throws loudly on missing client ids; `DEV_AUTH` fails closed on `"false"` (N6).
- **Idempotency** — verification + resolution are pure reads; the doc-level owner check is a pure
  comparison; no state mutation in the gate.

---

## 6. Frappe citations (authority, verified live 2026-06-20)

- `frappe/permissions.py:get_role_permissions` (L300–345) — `is_perm_applicable` permlevel-0 guard
  (N2); `has_permission_without_if_owner_enabled` union (N1/R-C); `and ptype != "create"` (F4/R-B);
  `perms[ptype] = 1 if ptype in ("select","read") else 0` (F1/R-A); `perms["if_owner"][ptype] =
  cint(pvalue and is_owner)` (the doc-level owner check, F2).
- `frappe/permissions.py` — `is_user_owner` (L234), `if_owner` override block (L254–267).
- `frappe/model/db_query.py:requires_owner_constraint` (L1472–1487) — owner list-filter applies only
  when read/select is NOT available without being owner (F3 / `queryConditions` read-gating).
- `frappe/core/doctype/user/user.json` + `frappe/core/doctype/has_role` — `User` carries roles via
  the `Has Role` child table (§2 model basis).

---

## 7. New / changed module layout

```
src/perms/auth.js              NEW  verifyGoogleIdToken (jose JWKS + jwtVerify, clockTolerance 5s,
                                    fail-closed -> AuthError)
src/perms/identity.js          NEW  resolveUserToCtx (RAW store.get; role->scope policy; admin->unrestricted)
src/validation/env-schema.js   +loadAuthEnv (lazy; GOOGLE_OAUTH_CLIENT_IDS list; DEV_AUTH enum-coerced, fail-closed)
src/runtime/errors.js          +AuthError (->401)
src/api/context-from-request.js  async; Bearer->verify->resolve; x-spartan-* behind DEV_AUTH only
src/perms/permissions.js       can/assertCan gain optional doc (F1/F2/F4); hasPlainGrant + hasOwnerGrant
                               (permlevel-0, create-excluded); assertCanMutate (cheap pre-load probe);
                               queryConditions read-gated if_owner filter; ownerOnly references removed
src/perms/context.js           REMOVE ownerOnly from makeContext/SYSTEM/GUEST/typedef (N7)
src/api/service.js             4 mutating ops: cheap pre-load probe + post-load assertCan(...,d.doc) (F2)
api/[doctype]/[name].js        await ctxFromRequest(req, store); AuthError->401
api/[doctype]/index.js         await ctxFromRequest(req, store); AuthError->401
src/api/handler.js             statusFor: AuthError->401
TESTS  perms.test.js / service.test.js / handler.test.js / workflow.test.js — migrate rep seed to
       if_owner docperms + drop ownerOnly:true (F5); + new tests N1/F1/F3/N6
+ migration: seed User / Has Role DocType meta + initial admin user, BEFORE first auth request (N5/planner)
```
