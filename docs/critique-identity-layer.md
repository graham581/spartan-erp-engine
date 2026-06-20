# Critique: Identity Layer (Pass C) — Google idToken auth + User model + `if_owner`

- **Reviewer:** critique
- **Design under test:** `docs/adr-identity-layer.md` + `diagrams/identity-layer-class.puml`
- **Method:** read-only — design read, current code read (`permissions.js`, `context.js`,
  `context-from-request.js`, `service.js`, `handler.js`, `env-schema.js`, `loader.js`, the 4
  perm/service/handler/workflow tests), Frappe ground truth fetched live via
  `gh api repos/frappe/frappe/contents/...` (`permissions.py` L300-345, `db_query.py`
  `requires_owner_constraint`).

---

# PASS 2 VERDICT (REV 2) — 2026-06-20

## VERDICT: **PASS** → proceed to planner

REV 2 closes all five Pass-1 blockers genuinely (re-verified against Frappe source + the current
code, not just reworded). The `can()` formula now matches Frappe's `perms[ptype]` semantics exactly,
`service.js` is a first-class edited file with a concrete per-call-site table, the F3 breach traces
to a 403 at the post-load check independent of the list filter, `create` is guarded, and `ownerOnly`
is removed engine-wide with the 4 seeds migrated. The architect's TOCTOU open question is adjudicated
**sound**. Two items handed to the planner.

## Per-blocker re-verification

**F1 — CLOSED.** `can()` REV 2 formula (ADR §5 L199-205, puml L165-170):
`hasPlainGrant→true; else !hasOwnerGrant→false; else doc!==undefined→doc.owner===ctx.user; else op==='read'`.
Line-for-line match of Frappe `permissions.py` L334 `perms[ptype] = 1 if ptype in ("select","read")
else 0` for the owner-only case: a no-doc probe of an owner-only **mutating** op now returns `false`
(no longer the no-op over-grant), only `read` stays `true` for list reachability.
**N1 (union/plain-wins):** `hasPlainGrant` is checked first and returns `true` before the owner path
is consulted, and both helpers scan *all* the ctx's roles' docperms — so role-A-plain +
role-B-owner-only yields plain-wins, matching Frappe's `has_permission_without_if_owner_enabled`
union. Correct.

**F2 — CLOSED.** `service.js` is now in the blast radius (ADR §3 L389, Consequences L327-331) with a
concrete table (L234-239) adding `assertCan(ctx, dt, op, d.doc)` **after** `loadInScope` for
`updateDoc`/`submitDoc`/`cancelDoc`/`transitionDoc`. The doc-level branch of `can()` is now
reachable — the doc is in hand at the call site. `getDoc` correctly omits the post-load check (read
reachability + row filter is Frappe-faithful); `createDoc` correctly unchanged (R-B).

**F3 — CLOSED.** Re-traced (ADR L268-279): plain-read + owner-only-write rep editing a co-worker's
doc → `queryConditions` adds no owner filter (plain read exists, correct) → `loadInScope` loads the
in-branch doc → **post-load `assertCan(ctx,dt,'write',d.doc)` evaluates `doc.owner===ctx.user` →
false → 403.** Enforcement is at the doc level, **independent of the read-derived list filter** —
exactly the gap Pass 1 flagged. Closed.

**F4 — CLOSED.** `hasOwnerGrant` carries `op !== 'create'` (ADR L191-192, puml L162); create is
granted iff a plain `create:true` docperm exists, matching today's `can()` and Frappe L332.

**F5 — CLOSED.** `ctx.ownerOnly` is **removed** (not deprecated): deleted from
`makeContext`/`SYSTEM`/`GUEST`/typedef (ADR §5 L291, layout L388) and the `if(ctx?.ownerOnly)` line
dropped from `queryConditions` (L289). The 4 named seeds are migrated to `if_owner` docperms with
assertions unchanged (L294-307), and the false "261 unaffected" claim is corrected to an explicit
caveat (L132-137): auth half neutral, if_owner half is *owned churn*. **Grep for stranded readers
(run this pass):** the only remaining `ownerOnly` occurrences in `src/` are the exact sites the work
order says to edit — `context.js:3,6,15,16,24,27` (removal target), `permissions.js:79,91` (the
`queryConditions` line to drop + its comment), `context-from-request.js:31` (dev shim being
replaced), and the 4 test files (migration targets). **No reader survives the removal that the work
order doesn't already touch.** Confirmed clean.

## Adjudication — the two-call mutating-op pattern (architect's open question)

**Recommendation: the REV 2 resolution is SOUND. Keep the two-call shape as specified.** No TOCTOU,
no contradiction.

The earlier draft (pre-load `assertCan('write')` no-doc, which R-A makes `false` for owner-only)
*would* have been a contradiction — it would 403 a legitimate owner before the doc loads. The
architect caught this themselves (ADR L247-255) and resolved it correctly: the **pre-load call is
`assertCanMutate` = a cheap "any grant" probe (`hasPlainGrant || hasOwnerGrant`)**, NOT the
authoritative `can()`:

- **Pre-load `assertCanMutate`** answers *"could this user ever do this op to some doc?"* — passes
  for any plain-or-owner grant, 403s a user with **no** grant of any kind before touching PG.
  Preserves the "no PG work on a wholly-unauthorized op" invariant the `service.js` comments rely on.
- **Post-load `assertCan(ctx,dt,op,d.doc)`** is the **single authoritative decision** — it sees the
  real `doc.owner` and is the only check that can deny on ownership.

**No TOCTOU.** The classic TOCTOU risk is check-then-use on *stale* state. Here the authoritative
check (`doc.owner === ctx.user`) runs on the **same loaded doc** that is then mutated, and for
submit/cancel/transition it runs **inside `store.transaction`** on the tx-store
(`service.js:70-101`), so the owner can't change between check and write. The pre-load probe is
deliberately *weaker* than the post-load check (a strict superset of grants), so a "pass-then-deny"
is the **intended narrowing**, not a race — it never grants something the post-load check denies. The
only observable effect of pre-load-pass → post-load-deny is a 403 issued after a single in-tx read
instead of before it, which is correct (you can't know the owner without loading the doc) and leaks
nothing (a 403 with no body reveals no more than a NotFound).

**Is "403 before PG work" worth keeping vs a single post-load check?** Yes — but understand what it
now buys. With `assertCanMutate` as the pre-load probe, the fast-fail catches the **no-grant-at-all**
case (e.g. a `viewer` attempting `write`) before PG. A user *with* an owner-only grant mutating a doc
they don't own still pays one `loadInScope` read before the 403 — unavoidable (ownership is data) and
cheap (one indexed get). A post-load-only design would lose the fast-fail and do a PG read for every
denied request, including the common abuse case. **The two-call shape is the right trade. Sound; no
change required.**

## Non-blocking fixes — all landed

- **N2 (permlevel-0 guard):** both helpers specified permlevel-0 (ADR L188-195, puml L161-162),
  mirroring `can()`'s existing `(p.permlevel ?? 0) === 0`. Landed.
- **N3 (clock skew):** `clockTolerance: '5s'` added to `jwtVerify` (ADR L45,50-52). Landed.
- **N4 (JWKS fail-closed → 401 not 500):** `verifyGoogleIdToken` wraps any non-`AuthError` JWKS/verify
  throw into `AuthError` so an outage is 401, never a 500 read as "auth skipped" (ADR L55-59). Landed.
- **N5 (raw-store resolver, no recursion):** `resolveUserToCtx` reads via **raw `store.get`**, never
  `getDoc`; stated with the recursion rationale (ADR L107-112). Landed.
- **N6 (DEV_AUTH enum coercion):** only `"true"`/`"1"` enable the shim; `"false"`/`"0"`/unset →
  `false`, with a test asserting `DEV_AUTH="false"` is dead (ADR L66-70). Landed.
- **N7 (ownerOnly removal):** done as part of F5 above. Landed.

## Handoff to planner — 2 items to carry

1. **Migration ordering (N5):** `User`/`Has Role` DocType meta + the **first admin user** must be
   seeded **before the first authenticated request** (ADR L110-112, L338-339, L395). `Role` is pinned
   in boot-meta; `User`/`Has Role` are *installed by migration*, not pinned — so the planner must
   sequence the seed migration ahead of any route exposure, and decide how the bootstrap admin's
   email is supplied (env? fixed seed?). The one genuine ordering hazard left.
2. **`assertCanMutate` naming/placement:** the contract is fixed (cheap any-grant pre-load probe in
   `permissions.js`; authoritative `assertCan(...,d.doc)` post-load); the *name* is implement's to
   finalize (ADR L263-266). Planner should pin it as **one** work item so the two-call shape lands as
   a pair — splitting risks shipping the pre-load probe without the authoritative post-load check,
   which would re-open F1/F3.

## One note for implement (not blocking)

The migrated `service.test.js` assertion at `:56-69` ("rep sees only own+branch" → `['rep-vic']`)
relies on owner-only-read-with-no-plain-read driving the `{owner:'rep@x'}` filter via
`queryConditions`. This holds **only if** the migrated seed gives rep an owner-only read *replacing*
the plain read (not an owner read *alongside* a plain read). Implement must ensure the migration
swaps the read docperm, or `hasPlainGrant('read')` stays true, the filter vanishes, and the assertion
breaks. Flagged in the work order (L302-307) — confirm at build time.

---

<details>
<summary><b>PASS 1 VERDICT (REV 1) — FAIL — superseded by REV 2; retained for history</b></summary>

## VERDICT: **FAIL**

The auth half (token verification, User-DocType identity, async ctx, DEV_AUTH gate) is sound. The
`if_owner` half had three soundness/correctness holes plus a factual contradiction about the suite.

### F1 — `if_owner` capability-probe semantics inverted vs Frappe for non-read ops (OVER-GRANT)
Service gates every single-doc op with `assertCan(ctx, dt, op)` and NO doc
(`service.js:43,59,71,82,97`). REV-1 said a bare `can()` with an owner-only grant returns
"potentially granted" (truthy) → the op-gate is a no-op for owner-only write/submit/cancel. Frappe
(`permissions.py` L329-337) sets `perms[ptype] = 1 if ptype in ("select","read") else 0` — i.e. a
bare owner-only **mutating** check is FALSE. Design had it backwards.
**Fix direction:** no-doc owner-only read → true; no-doc owner-only mutate → false; doc present →
`hasOwnerGrant && doc.owner === ctx.user`; and the mutators must pass the loaded doc post-`loadInScope`.

### F2 — doc-level `can()` added but never called with a doc (DEAD ENFORCEMENT)
REV-1 added the optional `doc` param but didn't list `service.js` as edited ("audit during
implement"). The doc-level branch was unreachable; enforcement fell entirely on `queryConditions`.
**Fix direction:** explicit `service.js` work order — `assertCan(ctx, dt, op, d.doc)` after
`loadInScope` for the mutating ops; list it in the blast radius.

### F3 — `queryConditions` owner filter is read-gated; mutating ops not owner-scoped by it
`requires_owner_constraint` (Frappe) keys the list filter on read/select only — correct for lists.
But `queryConditions` also gates `loadInScope` for mutators, derived from the *read* grant. Plain
read + owner-only write → no owner filter → `loadInScope` loads any in-branch doc → (per F1/F2)
`assertCan('write')` waves it through → **rep writes a co-worker's doc. Over-grant.**
**Fix direction:** keep `queryConditions` read-gated; add the per-op doc-level owner gate (F2).

### F4 — `create` must be excluded from `if_owner`
Frappe excludes create (`ptype != "create"`, L332). REV-1 `hasOwnerGrant`/`can()` had no guard.
**Fix direction:** `op !== 'create'` guard; create granted iff a plain `create:true` docperm exists.

### F5 — CONTRADICTION: deprecating `ownerOnly` breaks 4 of the "261 unaffected" tests
`perms.test.js:37`, `service.test.js:34` (asserts `:56-69`, `:71-73`), `handler.test.js:24`,
`workflow.test.js:97` build rep ctx with `ownerOnly:true` and assert owner-scoping via
`queryConditions`. REV-1 removed the `if(ctx?.ownerOnly)` line with no `if_owner` docperm in those
seeds → filter vanishes → `service.test.js` "rep sees only own+branch" fails. The "suite stays green"
claim was false, and §3 contradicted §5.
**Fix direction:** (a) migrate the 4 seeds to `if_owner` and correct the claim, or (b) keep
`ownerOnly` as back-compat (contradicts the DRY argument). Architect must pick one.

### Non-blocking (Pass 1): N1 multi-role union test; N2 permlevel-0 guard; N3 clockTolerance; N4
JWKS fail-closed→401; N5 raw-store resolver + migration ordering; N6 DEV_AUTH enum coercion; N7
remove `ownerOnly` field once nothing reads it.

### What PASSED in Pass 1 (not re-litigated): User DocType over a lean table; async `ctxFromRequest`
+ route `await` + `AuthError→401`; DEV_AUTH-gated header shim; lazy `loadAuthEnv`; `db_query`
read-gated owner filter direction.

</details>
