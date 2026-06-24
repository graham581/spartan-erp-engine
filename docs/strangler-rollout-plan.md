# Strangler rollout plan — migrating SpartanCRM onto the ERP engine

- **Status:** Plan (for review during the pause) — not started
- **Date:** 2026-06-24
- **Pattern:** Strangler fig (Fowler) — the engine grows *inside* the live CRM, one entity at a time; the old path keeps running until each piece is proven and retired. Mandated by the engine's Architecture Contract §7.2 ("no big-bang rewrite") and §7.3 ("one new hard thing at a time").
- **Goal:** every CRM entity (Customer → Contact → Lead → Deal → Job → Money) is read/written *through* the engine's doctype API, the legacy direct-Supabase/localStorage paths are retired, and the two repos become one — without ever taking the live site down or losing data.

---

## The safety backbone (these make every step reversible)

1. **Feature-flag facade.** A thin per-entity data-access shim in the CRM (`dataSource(entity)` → engine API | legacy), gated by a flag map (per entity, per env, per user). Default off. **Every cutover is a flag flip; every rollback is the same flag flipped back — instant, no redeploy.**
2. **The per-entity cycle.** Every entity follows the *same* six beats:
   **build → shadow-read → cutover reads → dual-write → cutover writes → retire legacy.** Customer (Phase 1) does it the long way as the template; later entities compress it because the harness + facade already exist.
3. **Behaviour-changing cutovers go in a Friday-night low-traffic window**, with monitoring; inert/prep steps go any time.
4. **Never retire a legacy path until a soak period with zero unexplained parity diffs.**
5. **Five testing layers, applied at every step that warrants them:**
   - **vitest** — engine entity logic (CRUD, transitions, validation, naming).
   - **parity harness** — runs the same op through engine *and* legacy, diffs the result. The core oracle.
   - **anon-JWT RLS probe** (`scripts/rls-probe.mjs`) — proves row-level isolation matches legacy (never service-role, which bypasses RLS).
   - **Playwright e2e** — the *real* workflow (Laura's scheduler path, sales-rep lead→deal, customer lookup), the regression oracle.
   - **manual device smoke** — for mobile-surfaced flows (sales app + installer app).

---

## Phase 0 — Foundations & safety rails  *(≈ Weeks 1–2)*

1. **Friday: cut the engine over to shared prod** (Unit 0 of the slice-1 work order) — re-point env, relink CLI, set `SUPABASE_ANON_KEY`, migration home → `spartancrm/supabase/migrations/`. *Test:* engine boots, `app.current_uid()` resolves a real session; smoke spaartan.tech — no CRM regression.
2. **Verify identity** — engine reads `public.users` via `app.users_v` (real u178 ids), owner stamps `app_user_id`. *Test:* engine returns the logged-in user's ctx + scope correctly for 3 sample roles.
3. **Build the strangler facade** — `dataSource(entity)` shim + flag map (config table / `ui_prefs`), default all-legacy. *Test:* flags off → 100% legacy, Playwright baselines unchanged.
4. **Build the parity harness** — same-input diff of engine vs legacy (reads now, writes later). *Test:* legacy-vs-legacy run = zero diff (sanity).
5. **Capture Playwright e2e baselines** for the workflows to be migrated. *Test:* all baselines green on current prod.
6. **Rehearse rollback** — flip a flag on then off. *Test:* round-trips to legacy with zero residue.

## Phase 1 — Customer (the pilot & reusable template)  *(≈ Weeks 3–5)*

7. Implement Customer doctype on the engine (slice-1 work order Units 1–4). *Test:* vitest green — CRUD + naming.
8. Emit Customer table + constraints (FK/UNIQUE/stamping trigger) via `ddl.js`. *Test:* migration dry-run clean; objects applied (Friday).
9. Attach Customer RLS (`USING(true)` + service_role policy). *Test:* anon-JWT probe — authenticated reads, anon denied.
10. Parity: harness diffs engine GET vs legacy across a real-customer sample. *Test:* zero read-diffs.
11. Wire CRM Customer read-shim behind flag (off). *Test:* flag off → legacy unchanged.
12. **Shadow-read** — flag off, CRM also fires the engine read in background and logs diffs (no user impact). Deploy. *Test:* shadow runs in prod, diffs logged.
13. Soak shadow-read ~1 week under real traffic. *Test:* zero / explained diffs over the soak.
14. **Canary** — flip Customer reads to engine for one user (you). *Test:* your customer screens render from engine; Playwright + manual smoke green.
15. **Friday: cutover Customer reads** for all users; monitor. *Test:* e2e baselines green; error rate flat.
16. **Dual-write** — writes hit engine *and* legacy; harness compares persisted rows. *Test:* stores converge, zero write-diffs.
17. Soak dual-write ~1 week under real edits. *Test:* zero write-diffs.
18. **Friday: cutover Customer writes**; legacy becomes a read-only shadow mirror. *Test:* edits persist via engine; mirror matches.
19. Soak ~1 week, then **retire** the legacy Customer path + remove its shim branch. *Test:* legacy gone, e2e green, flag retired.

## Phase 2 — Contact  *(≈ Weeks 6–7)*

20. Build Contact doctype + tests (Link → Customer). *Test:* vitest green; Link FK resolves.
21. RLS + parity harness for Contact reads. *Test:* anon-JWT probe + zero read-diffs.
22. Shadow-read soak Contact ~1 week. *Test:* zero diffs.
23. **Friday: cutover Contact reads → dual-write → soak.** *Test:* e2e green, write parity.
24. **Friday: cutover Contact writes; retire legacy.** *Test:* green, legacy removed.

## Phase 3 — Lead  *(≈ Weeks 8–9)*  — first state-scoped entity

25. Build Lead doctype + status enum + qualification guard (located address, valid phone, valid email). *Test:* vitest — illegal transitions rejected, guard enforced.
26. RLS state-scoped (`can_read_doc(owner, state)`) + parity. *Test:* anon-JWT probe — state isolation matches legacy `branchInScope`; zero read-diffs.
27. Shadow-read soak Lead ~1 week. *Test:* zero diffs incl. state-scoping parity.
28. **Friday: cutover Lead reads → dual-write → soak.** *Test:* e2e (sales-rep lead list) green.
29. **Friday: cutover Lead writes; retire legacy.** *Test:* green.

## Phase 4 — Deal + the Lead→Deal transition  *(≈ Weeks 10–12)*  — canonical measure-booking rule

30. Build Deal doctype + the **lead→deal transition** (reuse `_executeLead2Deal`; booking the measure converts lead→deal). *Test:* vitest — transition idempotent (no double-deal), data preserved.
31. RLS state-scoped + parity for Deal. *Test:* anon-JWT probe + zero read-diffs.
32. Shadow-read soak Deal **and shadow the transition** (compute the new-path result, compare, don't commit). *Test:* transition parity — engine produces the same Deal as legacy.
33. Canary the lead→deal transition for one user. *Test:* booking a measure as you converts correctly via the engine.
34. **Friday: cutover Deal reads + transition → dual-write → soak.** *Test:* e2e (book measure → deal appears) green.
35. **Friday: cutover Deal writes; retire legacy Deal + legacy transition.** *Test:* green; one transition owner (engine).

## Phase 5 — Job (the spine)  *(≈ Weeks 13–16)*  — highest coupling; the installer app reads jobs

36. Build Job doctype + `createJobFromWonDeal` (reuse R4 guards: defensive guards, payment-method normalization, trimCutList carry-forward). *Test:* vitest — won-deal→job idempotent, guards fire.
37. RLS state-scoped + parity for Job. *Test:* anon-JWT probe + zero read-diffs.
38. Shadow-read soak Job + shadow `createJobFromWonDeal`. *Test:* job-creation parity.
39. Canary Job for one user/branch. *Test:* deal won → job created via engine, matches legacy.
40. **Friday: cutover Job reads + creation → dual-write → soak (~2 weeks** — installer app depends on jobs). *Test:* CRM e2e **and installer-app job reads** green.
41. **Friday: cutover Job writes; retire legacy Job spine.** *Test:* green; installer app unaffected.

## Phase 6 — Money: Quote / Invoice / Commission  *(≈ Weeks 17–20)*

42. Build QuickQuote doctype (`quick_quotes` already CRM-owned). *Test:* vitest + **pricing parity** vs legacy quote API.
43. Shadow → **Friday cutover** QuickQuote reads/writes; retire legacy. *Test:* pricing e2e green.
44. Build Invoice doctype (mind the installer-owned `cl_final→invoice` trigger). *Test:* vitest; trigger still fires with the engine as writer.
45. Shadow → **Friday cutover** Invoice; retire legacy. *Test:* invoice-on-signoff e2e green.
46. Build Commission doctype (moves off localStorage → DB — the S-053 fix; pay-run approval gate). *Test:* vitest — splits + manager-approval gate.
47. Shadow → **Friday cutover** Commission; retire the legacy localStorage path. *Test:* commission e2e green.

## Phase 7 — Decommission & consolidation  *(≈ Weeks 21–22)*

48. **Pull the engine code across into the CRM repo** via `git subtree` (history preserved), now that slices are proven. *Test:* build/deploy from one repo; engine vitest runs in CRM CI; e2e green.
49. Merge the two Vercel projects → one deploy under spaartan.tech; engine API served same-origin. *Test:* every `/api/[doctype]` reachable same-origin; full e2e suite green.
50. Remove the strangler facade + all flags + legacy data-access modules; final full regression + RLS audit. *Test:* full Playwright suite + permission tests green; **no legacy path remains — one repo, one deploy, the engine is the spine.**

---

## Schedule at a glance

| Phase | Entity | ~Duration | Cutovers |
|---|---|---|---|
| 0 | Foundations | Weeks 1–2 | 1 (engine→prod, Fri) |
| 1 | Customer (template) | Weeks 3–5 | 2 (reads, writes) |
| 2 | Contact | Weeks 6–7 | 2 |
| 3 | Lead | Weeks 8–9 | 2 |
| 4 | Deal + transition | Weeks 10–12 | 2 |
| 5 | Job (spine) | Weeks 13–16 | 2 (longer soak) |
| 6 | Quote/Invoice/Commission | Weeks 17–20 | 3 |
| 7 | Consolidation | Weeks 21–22 | 1 (repo+deploy merge) |

**≈ 5 months, deliberately slow** — it's strangling a live business, so soak time and Friday windows are features, not delays. The pace is "one entity in flight at a time" (Contract §7.3); never start the next entity's cutover while the previous one is still soaking. Weeks are relative to resume (Week 1 = whenever you restart), not fixed dates.

## Principles to hold the line

- **Parity before progress.** No cutover without a green parity diff; no retirement without a clean soak.
- **One entity at a time.** The flag map can have many entities defined, but only one should be mid-cycle.
- **Friday for behaviour; any time for prep.** Builds, shadow wiring, and harness work are safe mid-week; read/write cutovers wait for the window.
- **The legacy path is the safety net until it's provably redundant.** Dual-write + shadow-mirror keep a fallback through every cutover.
