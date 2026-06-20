# SpartanCRM — DocType-in-JS Build Backlog

*A synthesis of the architectural decisions from this thread, written as a sequenced build backlog. Not a research doc — every point comes from decisions we reasoned through together. Work it top to bottom: points 1–8 are the first shippable slice; everything after is explicitly later.*

---

> **⚠ THE ONE GAP — fill point 3 before you start.**
> Point 3 is the qualification rule ("the X") — the single thing only you can supply. The whole slice is a test of *one real guard*; a status flip with no rule proves nothing you didn't already have. Drop your actual rule into point 3 (a valid phone? a logged site visit? a confirmed measure appointment?) and the backlog is complete.

---

## Phase 1 — Slice One: raw lead → qualified, end to end, in the existing app (build this week)

1. Define the Lead DocType module: one JS file as the canonical source for the Lead entity — its fields, types, status enum, validation, and metadata. The single home every piece of Lead logic derives from.

2. Specify the status field as an enum, raw → qualified as the first transition. Status is the spine of the slice; encode the allowed values and the one legal transition explicitly, never as free-floating strings.

3. **Encode the qualification rule (THE X):** a raw lead cannot become qualified unless **[ FILL IN — e.g. valid phone? address? confirmed appointment? ]**. This single guard is the real test of the whole architecture.

4. Write the Zod schema for Lead, derived from the DocType field definitions. Runtime validation rejects bad data, and the same schema runs server-side and in the React form — one definition enforced at both ends.

5. Hand-write the Drizzle schema for Lead first, as a stand-in for the future emitter. Get the entire loop working against this hand-written file before building any generator — test the architecture before the machinery.

6. Wire Drizzle Kit: generate and apply one migration that creates the leads table in your scratch/dev Supabase. The migration runs once, deliberately, as a manual or CI step — never inside the Vercel build.

7. Build the qualify transition function server-side: read the lead, run the guard from point 3, flip the status, write via Drizzle. This is the only path that qualifies a lead, with the rule enforced in exactly one place.

8. Build the screen — a new React component inside the existing app: lead detail plus a Qualify button that calls the transition and either succeeds or shows the rep precisely why the rule blocked it. Slice one is done.

## Phase 2 — Harden the foundation and lock the conventions

9. JSDoc-type the Lead module and the transition in plain .js using `@type` annotations. The files stay runnable JavaScript; the TypeScript language server reads the comments and surfaces drift as red squiggles.

10. Turn on `checkJs` in jsconfig/tsconfig so the type checker actually watches the .js files. Without this the JSDoc types are decoration; with it, they catch renames and shape drift the way TypeScript would.

11. Add `tsc --noEmit` as a CI gate so a type error blocks a merge. This is the teeth — JSDoc only delivers if checking is enforced rather than optional. Get a five-minute agreement on it with Phoenix and Santosh.

12. Write tests for the qualify guard: qualifying with the rule satisfied succeeds; without it, it fails. These tests are what make drift *catchable* later — they scream the instant a renamed field breaks the guard.

13. Define the DocType convention explicitly and write it down: the exact shape every DocType file takes — fields, status, validation, the API it exposes. This written convention is the contract that makes modules bolt-on-able.

14. Establish the boundary rule: each entity's logic lives in its own module, and nothing reaches into another's internals. This is the anti-spaghetti discipline — it answers "where does this go?" before you have to decide.

15. Build the DocType → Drizzle emitter now that the hand-written Lead schema is the concrete target to reproduce. Author the entity once and the schema falls out; Drizzle Kit still owns the dangerous migration diffing.

16. Decide RLS deliberately: hand-write the policies in SQL alongside the schema, with the DocType declaring intent in one line and naming the policy. Don't generate RLS — it's slow, leaky, and a generator bug is a security hole.

## Phase 3 — Extend the pipeline: the cross-entity hand-off and remaining pre-job states

17. Slice two: qualified lead → Deal. The first *cross-entity* hand-off, where one entity spawns the next via lifecycle_id. This tests the lifecycle model itself, on an entity you've already proven works.

18. Define the Deal DocType module — its own fields, status enum, validation. Keep it minimal at first: a Deal that just exists. Resist building quoting here; quoting is a subsystem, not a status flip, and it can wait.

19. Encode the lead → deal hand-off: create the Deal from the qualified Lead, link by lifecycle_id, set original_sales_rep as the commission anchor, append an audit entry. Separate tables linked, not one row drifting.

20. Add the measured-lead state between qualified and deal if your flow needs it. It's a within-entity status step on Lead — cheap once the status machine exists. Mirror the qualify-guard pattern from slice one.

21. Build the Deal status states: deal → quoted → checked → final design. Note that quoted and final design are subsystems (pricing, e-sign), not flips — stub the status now and build those subsystems later, deliberately.

22. Define the Job DocType module for the pre-order job state — the third entity, same DocType shape. The deal → job hand-off mirrors lead → deal: lifecycle_id, audit entry, commission anchor all preserved across it.

23. Encode the final-design-deal → pre-order-job hand-off. This is the second cross-entity moment, and by now the hand-off is a known pattern — reuse it rather than reinventing the wiring for each new transition.

24. Build a generic transition helper once the pattern is proven across two or three transitions: read, guard, write, audit. DRY the thing only after you've hand-written it enough times to actually see its true shape.

25. Build the generic `useDocType('Lead')` React hook *after* one specific screen exists. A uniform API shape lets one hook serve every entity — the frontend payoff, banked once it's earned, not built speculatively up front.

26. Make your own API shape uniform across entities so the generic hook works: every DocType read and written through the same-shaped endpoint. This is the real prize Frappe UI was pointing at — and you build it yourself.

## Phase 4 — Comms layer: second major slice, hung off the clean foundation

27. Build comms only after a pipeline slice is proven and in use. It *rides* the clean structure; it does not *test* the DocType architecture. Never lead a desperation rebuild with the integration-heaviest, swampiest piece.

28. Define a TwilioSettings DocType at app level: Account SID, Auth Token, account-wide config — one record. Steal ERPNext's pattern directly: integration settings live in a DocType, exactly like any other entity does.

29. Define per-agent voice settings — each rep's caller ID, Twilio number, device choice — kept separate from the app-level record. This split kills the entire "works for me, broken for them" caller-ID and device bug class.

30. Build the single Twilio module: the ONLY file in the whole codebase that imports the Twilio SDK. All E.164 formatting, Device init, and call/SMS firing lives behind this one door — nothing else ever touches Twilio.

31. Have pipeline code call the Twilio module by intent — "send this SMS to this deal's contact" — knowing nothing about E.164. That boundary is the thing that stops Twilio logic smearing back across the monolith again.

32. Move your hard-won Twilio knowledge into the module: E.164 normalisation, outbound caller-ID config, Australian geographic permissions, Device setup. The understanding is already done — this just gives it a clean home.

33. Define one known webhook URL for Twilio inbound (calls, status), wired to TwilioSettings — mirroring ERPNext's fixed voice endpoint. Inbound lands in a single place instead of scattering across ad-hoc handlers.

34. Log every comm against its entity: an SMS or call attaches to the Deal or Lead it concerns. This is how comms enters the system — hung off entities that already work, not floating free as its own swamp.

35. Add SMS first, then email, then calendar — one channel at a time, each behind its own boundary. Don't build all of comms at once; the per-channel boundary is what keeps each one independently fixable later.

36. Keep the Twilio module the single place to look when a call bugs out. That's the real payoff of the one-door rule: a flaky external service fails in one known file, not somewhere across a grep of the whole codebase.

## Phase 5 — Integrations, Pipedrive cutover, Ascora

37. Plan the Ascora hand-off: job data flows from SpartanCRM into Ascora automatically once a sale lands, replacing manual entry. Treat Ascora exactly like the Twilio module — one boundary, one door, called by intent.

38. Answer the six Ascora foundational questions first — transport, handoff trigger, sync direction, data contract, build ownership, deduplication — before writing any migration steps. Those decisions gate the whole plan.

39. Build the Ascora integration behind a single module, the only thing importing its client. Same discipline as Twilio: pipeline code says "push this job to Ascora" and knows nothing whatsoever about the actual API.

40. Sequence the Pipedrive cutover as vertical slices, not a big bang. Each pipeline stage ships and goes into use before the next is built — there's never a moment where nothing works. This is the deadline-safe path.

41. Keep the existing app running throughout the rebuild. The clean DocType core grows *inside* it and eats it slice by slice. July survives precisely because you ship usable slices instead of betting on one cutover.

42. Carry forward the rep-tracking model: current rep per record, original_sales_rep as commission anchor, audit trail via appendAuditEntry. Preserve the three-layer approach the live code has already proven correct.

43. Reuse the verified lifecycle architecture: separate tables for leads, deals, jobs, and invoices, linked by lifecycle_id (Option B). The fresh start re-expresses a known-good model — it is not a brand-new guess.

44. Watch egress as you build: avoid select('*') over wide ranges, throttle realtime echo handlers, page large reads. The 540GB overrun was structural — bake those fixes into the new data layer from the very first day.

## Phase 6 — Modularity, mobile, team, discipline

45. Treat modularity as a consequence, never a feature. A system of clean boundaries is bolt-on-able by definition. Do *not* build a "module system" — do the anti-spaghetti work well and the modularity falls out for free.

46. Keep DocType definitions portable: pure JS with no environment assumptions, so Lead/Deal/Job rules run on the server, the web, and the Capacitor app from one source. Database access stays server-side only, always.

47. Do NOT switch Capacitor → React Native mid-rebuild. The framework is RN-capable someday, but acting now staples a second from-scratch rebuild onto the first. Bank the portability and keep the mobile app you have.

48. Frontend stays the existing React app plus the Tailwind you already use. No new framework, no vanilla-JS rewrite. Mid-rebuild, "introduce no second frontend paradigm" is the correct, boring, genuinely right call.

49. The real success criterion is the team using it. A working screen with the old bugs gone wins buy-in — not a clean repo. Build the most *visible* slice and let Phoenix and Santosh feel the difference for themselves.

50. One new hard thing at a time. The project can carry exactly one — the DocType architecture. Every slice adds a single capability, ships, and proves itself. The discipline that fixes the spaghetti *is* the slice itself.

---

*Slice one (1–8) is the whole game right now. Everything below it is correct, sequenced, and waiting — but none of it counts until a rep can click Qualify and the rule holds. Fill in point 3 and start.*
