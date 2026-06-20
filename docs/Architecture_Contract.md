# SpartanCRM — Architecture Contract

**Status:** binding on all contributors (Graham, Phoenix, Santosh).
**Purpose:** keep the DocType architecture intact under pressure. The spaghetti happened because there was no agreed law and no enforcement. This is the law, and every rule below names how it is enforced. A rule without teeth is a suggestion, and suggestions rot — so there are no toothless rules here.
**How to use it:** Section 9 is the pull-request checklist. Nothing merges that fails it.

---

## 0. The Prime Directive

> **One entity, one definition, one home.** Every business entity (Lead, Deal, Job, Invoice…) is defined once, in one DocType module, and all of that entity's rules live there. If logic for an entity exists anywhere else, it is a bug, regardless of whether it "works."

Every other rule in this contract exists to protect the Prime Directive. When two rules seem to conflict, the one that better serves "one entity, one home" wins.

---

## 1. The DocType Contract

**1.1** Every entity is a single JS module that is the canonical source for that entity. It declares: field definitions (name, type, nullability, default), the status enum and its legal transitions, the validation schema, and field metadata (label, list position).
*Enforced by:* code review — a new entity introduced as scattered columns + ad-hoc handlers is rejected.

**1.2** Every DocType module has the **same shape**. The structure of `Lead.js` and `Deal.js` is identical down to section order and export names. Uniformity is not aesthetic — it is what makes the generic API hook and bolt-on modules possible.
*Enforced by:* a reference template in the repo (`/doctypes/_TEMPLATE.js`); review checks new modules match it.

**1.3** A DocType module declares **what it is**, never **how the app renders it**. No React, no DOM, no HTTP, no SDK imports inside a DocType module. It is pure, portable JS.
*Enforced by:* lint rule banning UI/SDK imports from `/doctypes/**`; CI fails on violation.

**1.4** Status is always an explicit enum with explicit legal transitions. Status is never a free-text string and a transition that isn't declared legal cannot be performed.
*Enforced by:* the transition function rejects undeclared transitions at runtime (fail-fast); review confirms.

---

## 2. Source of Truth & Code Generation

**2.1** The DocType is canonical. The Drizzle schema is **emitted from** it, never authored by hand. Drizzle Kit owns migration diffing.
*Enforced by:* generated schema files carry a `// GENERATED — DO NOT EDIT` header; CI fails if a generated file is edited by hand (checksum check).

**2.2** Migrations run **once, deliberately** — as a CI step or a manual gated step — and **never inside the Vercel build**. Build and schema-change are separate acts.
*Enforced by:* no migrate command in the Vercel build config; review rejects any attempt to add one.

**2.3** Drizzle connects via the Supabase **pooled** connection string (transaction mode, port 6543), never the direct connection, in any serverless context.
*Enforced by:* connection string sourced from one config module; review checks the port.

**2.4** No raw SQL strings for entity reads/writes in application code. Go through Drizzle so the typo-in-a-string failure mode is impossible. (RLS, functions, triggers in SQL are the deliberate exception — see Section 6.)
*Enforced by:* lint rule flagging raw SQL template literals outside the migrations/RLS directories.

---

## 3. Typing & Enforcement — the teeth

**3.1** All code is plain `.js` with JSDoc types. No `.ts` source files (team is committed to vanilla JS), and no untyped JS either.
*Enforced by:* review; CI type gate (3.3) catches the absence of types as errors.

**3.2** `checkJs` is on. The type checker watches every `.js` file.
*Enforced by:* `jsconfig.json` / `tsconfig.json` committed with `checkJs: true`; changing it requires an amendment (Section 10).

**3.3** **`tsc --noEmit` is a required CI gate. A type error blocks the merge.** This is the single most important enforcement rule in the contract — it is the difference between JSDoc that protects you and JSDoc that decorates broken code.
*Enforced by:* CI; the gate is a required status check on the protected branch. Not optional, not skippable.

**3.4** Types are inferred from the source of truth, not hand-duplicated. Entity types come from the DocType/Zod (`z.infer`); query types come from Drizzle inference. If you typed a shape by hand that a tool could infer, that's a defect.
*Enforced by:* review.

---

## 4. Validation

**4.1** Zod is the **only** validation mechanism. Validation rules are Zod schemas, never scattered `if` checks across components and routes.
*Enforced by:* review rejects hand-rolled field validation that duplicates what a schema should own.

**4.2** Each entity's validation schema lives in its DocType module and **is** that entity's rule set (e.g. the Lead qualification guard: address located, valid phone, valid email).
*Enforced by:* the Prime Directive + review.

**4.3** The **same schema** validates client-side (form feedback) and server-side (enforcement). The server never trusts the client; the client never invents its own rules.
*Enforced by:* one imported schema used in both places; review checks the import, not a re-declaration.

**4.4** A failed validation returns a precise, field-level reason that the UI surfaces to the user. No silent rejections, no generic "invalid" with no cause.
*Enforced by:* transition/handler contract returns Zod's error detail; review.

---

## 5. Boundaries & Integrations — the one-door rule

**5.1** Each entity's logic lives in its own module and **never reaches into another entity's internals**. Cross-entity work goes through declared, named interfaces (e.g. a lifecycle hand-off function), not by poking at another module's guts.
*Enforced by:* review; module structure makes internals un-exported by default.

**5.2** **Every external integration sits behind a single module that is the only file in the codebase importing that integration's SDK.** Twilio, Ascora, Documenso — one door each.
*Enforced by:* lint rule — the integration's package may only be imported from its one designated module; CI fails on a second importer. This is structurally checkable, so it is structurally enforced.

**5.3** Application code calls an integration **by intent** ("send this SMS to this contact", "push this job to Ascora") and knows nothing of the integration's internals (E.164, API shapes, auth). The integration's quirks stop at its door.
*Enforced by:* review; 5.2 makes leakage hard by construction.

**5.4** Integration settings are split: **app-level** settings (account credentials, account-wide config) in one settings DocType; **per-agent** settings (per-rep caller ID, number, device) in a per-user record. The two are never conflated.
*Enforced by:* review; the split is part of the integration module's defined shape.

**5.5** Each integration has **one** inbound webhook entry point per concern, wired to its settings DocType. Inbound never scatters across ad-hoc handlers.
*Enforced by:* review; route inventory.

---

## 6. Permissions (RLS)

**6.1** RLS is **hand-written in SQL**, deliberately, alongside the schema. It is **never generated** from DocType metadata. (Generated RLS is slow on every-row reads, leaky, and a generator bug becomes a security hole.)
*Enforced by:* review; RLS lives in a designated SQL directory owned by humans.

**6.2** The DocType **declares permission intent** in one human-readable line (e.g. "owner-only", "team-visible") and **names** the policy that enforces it. The DocType documents the guard; it does not write the guard.
*Enforced by:* review checks the declared intent matches the named policy.

**6.3** Every permission rule has a test proving who can and cannot access a record ("Bob must not see Alice's deal"). Permission changes ship with their tests.
*Enforced by:* CI test suite; review rejects RLS changes without coverage.

**6.4** Every RLS policy is written with its per-row cost in mind, because it runs on every read. A correct-but-slow policy is a defect, not a detail.
*Enforced by:* review; egress/perf watch (8.4).

---

## 7. Build Discipline

**7.1** Build in **vertical slices** — one transition, end to end (DocType → validation → screen) — not horizontal layers. A slice isn't done until a user can perform it and the rule holds.
*Enforced by:* slice definition in the backlog; "done" means demoable.

**7.2** The clean core grows **inside the existing app** (strangler pattern). The existing app keeps running throughout. **No big-bang rewrite, no from-scratch frontend, no mobile-platform switch mid-rebuild.**
*Enforced by:* this contract; any proposal to rebuild a whole layer at once requires an amendment (Section 10) and a stated reason.

**7.3** **One new hard thing at a time.** The project's one hard thing is the DocType architecture. A slice may add one new capability; it may not also introduce a second large unknown (new framework, new platform, new paradigm).
*Enforced by:* review of slice scope.

**7.4** `quoted`, `final design`, and similar are **subsystems** (pricing, e-sign), not status flips. Their status may be stubbed early; the subsystem is built later, deliberately, as its own slice.
*Enforced by:* review; backlog sequencing.

---

## 8. Design Principles (applied, not abstract)

Each principle below has a concrete meaning **for this project**. They are tie-breakers and review lenses, not slogans.

**8.1 DRY** — One definition per entity. If a rule exists in two places, one is wrong. (This is the Prime Directive wearing its principle name.)

**8.2 KISS** — Prefer the boring option. Thin Drizzle over a heavy ORM; the existing React app over a new framework; a specific screen before a generic one.

**8.3 YAGNI** — Don't build the module system, the generic hook, or the emitter before a concrete case forces it. Build the specific thing first; generalise only when you've written it by hand enough to see its true shape.

**8.4 SOLID** — Each module has one responsibility; entities depend on declared interfaces, not each other's internals. (Operationalised by Sections 1 and 5.)

**8.5 Separation of Concerns** — Schema (Drizzle) ≠ validation (Zod) ≠ rendering (React) ≠ permissions (SQL/RLS) ≠ integration (one-door module). Each concern has exactly one home.

**8.6 Least Privilege** — RLS grants the minimum access required. Per-agent settings expose only that agent's data. Default to closed.

**8.7 Idempotency** — Transitions and integration calls are safe to retry. A hand-off that runs twice must not create two Deals or double-fire a webhook action.
*Enforced by:* review; dedup keys on cross-entity hand-offs and outbound integration calls.

**8.8 Fail-Fast** — Invalid data and illegal transitions are rejected at the boundary, loudly, with a precise reason — never swallowed, never patched downstream.

---

## 9. Pull-Request Checklist — what blocks a merge

A PR merges only if **all** of these are true. CI enforces the starred ones automatically; reviewers verify the rest.

- [ ] ★ `tsc --noEmit` passes (no type errors). **(3.3)**
- [ ] ★ Test suite passes, including permission tests for any RLS change. **(6.3)**
- [ ] ★ No hand-edits to `// GENERATED` files. **(2.1)**
- [ ] ★ No second importer of any integration SDK. **(5.2)**
- [ ] ★ No migrate command added to the Vercel build. **(2.2)**
- [ ] Any new entity is a DocType module matching `_TEMPLATE.js`. **(1.1, 1.2)**
- [ ] No UI/HTTP/SDK imports inside `/doctypes/**`. **(1.3)**
- [ ] Validation is Zod in the DocType module; no scattered field checks. **(4.1, 4.2)**
- [ ] Same schema used client- and server-side. **(4.3)**
- [ ] Integration code is called by intent; settings split app-level vs per-agent. **(5.3, 5.4)**
- [ ] RLS hand-written; DocType declares intent and names the policy. **(6.1, 6.2)**
- [ ] Slice is vertical and demoable; scope adds one hard thing, not two. **(7.1, 7.3)**
- [ ] Cross-entity hand-offs and outbound calls are idempotent (dedup key present). **(8.7)**

---

## 10. Amendments

This contract is **living, not sacred** — but it changes deliberately, not by drift.

**10.1** Any contributor may propose a change. It takes effect only when Graham, Phoenix, and Santosh agree, and the change is committed to this file with a one-line reason.

**10.2** "We were in a hurry" is not a reason to break a rule — it's a reason to ship a smaller slice. The contract exists precisely for the moments when the pressure to cut a corner is highest.

**10.3** If a rule is being routinely worked around, that's a signal to fix the rule openly here — not to keep quietly ignoring it. A rule everyone bypasses is worse than no rule, because it teaches the team that the contract is theatre.

---

*The contract governs the code. The code still has to get written. The first thing it governs is slice one: a Lead that cannot qualify unless it has a located address, a valid phone, and a valid email.*
