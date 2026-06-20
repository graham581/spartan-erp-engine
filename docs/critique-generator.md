# Critique — Pass D (Generator / Single / depends_on)

- **Reviewer:** critique
- **Pass 1:** 2026-06-20 — D1 FAIL · D2 FAIL · D3 PASS(cond) → back to architect.
- **Pass 2:** 2026-06-20 — re-review of the revised ADR + diagram.
- **Design under test:** `docs/adr-generator.md` + `diagrams/generator-class.puml`

## PASS 2 VERDICT

| Sub-pass | Pass 1 | Pass 2 | Why |
|---|---|---|---|
| **D1 generator** | FAIL | **PASS** | Both blockers genuinely closed: closure ON-by-default + fail-at-generate guard; `mapField` is an explicit key-whitelist with spread FORBIDDEN, eval-strings dropped by construction, with a mandated test. |
| **D2 Single** | FAIL | **PASS** | Re-spec'd as the real 3-site change (loader read + Meta net-new field/getter + document.js branch) with the name-forced-before-`!doc.name` ordering explicit. |
| **D3 depends_on** | PASS(cond) | **PASS** | Evaluator untouched (already adversarially clean); all 3 ADR edits (C-D3-1/2/3) landed. |

**Overall: PASS → proceed to planner.** Planner/implement items flagged at the end (esp. the
D1-2 test as a hard done-criterion and the D1→D3 ship-ordering gate).

---

## D1 — verified CLOSED

### D1-1 (was BLOCKER) — closure ON by default + fail-at-generate — CLOSED
adr-generator.md:181-201 + diagram:73-81. The fix is **specified as behavior, not prose**:
- **(a) default:** `closureOver` expands seeds to full transitive closure before generating;
  `--no-closure` is the explicit leaf-only opt-out (CLI signature diagram:167 carries
  `[--no-closure]`, closure ON by default).
- **(b) guard:** when closure is off and a `Link`/`Table`/`Table MultiSelect` target falls
  **outside** the pinned set, the generator **throws at generate time naming the missing
  target** (adr:194-197) — never emits a def that would `NotFoundError` at runtime. This is the
  fail-at-generate I asked for, and it is concrete (not just "closure by default").
- Closure now correctly includes `Table MultiSelect` options as deps (adr:161, 177-179) —
  matches the ground truth (`Quotation.lost_reasons → "Quotation Lost Reason Detail"`).

### D1-2 (was BLOCKER, the security boundary) — verified HARD — CLOSED
adr-generator.md:86-109 + diagram:41-53, 200-205. This is the hole; it is now airtight:
- `mapField` is stated as an **EXPLICIT KEY-WHITELIST**, output carrying **only**
  `{ fieldname, fieldtype, reqd, readOnly, unique, permlevel, options, fetchFrom, idx }` — nine
  keys, none of them `dependsOn`/`mandatoryDependsOn`.
- **Spread is explicitly FORBIDDEN** ("`A spread ({ ...f, ... }) would silently re-admit them
  and is FORBIDDEN`", adr:106; diagram:50). This is the exact failure mode I named in pass 1
  (passthrough re-admitting the string), and it is now banned by name.
- The drop is **by construction**, not by a runtime filter: because the two ERPNext source keys
  are simply not on the allowlist, there is **no code path** that copies them. A whitelist that
  enumerates its output keys cannot leak an un-enumerated input key — this genuinely cannot leak
  a `depends_on` string. Confirmed against the real risk: 86 Selling-slice fields carry these
  strings (adr:100-101 cites the count and `account.json account_currency`), and none can reach
  the FieldDef.
- The **test is mandated and specified** (adr:106-108): feed a source def whose fields carry
  `depends_on`/`mandatory_depends_on` strings; assert **no** generated FieldDef has a
  `dependsOn`/`mandatoryDependsOn` key and none carries a string-typed condition. This is
  precise enough for the planner to make it a done-criterion (see Planner items).
- The whole thing is **PINNED as a frozen contract** and tied to C-D3-1 (D3 doesn't ship until
  this is frozen + tested). The diagram even draws the `<<security boundary>>` edge
  `MapField ..> DependsOn` (diagram:198) so the coupling is visible in the topology.

### D1-3 (was MAJOR) — CLOSED
- **Dynamic Link → Data with `options` STRIPPED** (adr:152-156: `mapField sets options =
  undefined for Dynamic Link`; diagram:52). Correct — ground truth confirmed Dynamic Link
  `options` is a sibling fieldname (`party_type`, `quotation_to`), not a doctype.
- **assertValidDef over EVERY closure def** (adr:199-201, 13: "run over EVERY closure def, not
  just the seeds"; diagram:80, 98). Closes the "unverified claim" gap from pass 1.

### D1-4 — tableNameFor still char-for-char with loader.js:135 — OK (re-confirmed).

---

## D2 — verified CLOSED

### D2-1 (was BLOCKER, half-build) — re-spec'd as the real 3-site change — CLOSED
adr-generator.md:224-234 + diagram:106-117, 138-143, 184-187. All three sites are present and
correctly anchored:
1. **`loader.load`** (loader.js:126-138 scalar step) reads `const issingle = !!(row.issingle)`
   and passes it into `new Meta({...})` (adr:228-230). Verified: today loader.js:131-138 builds
   Meta from `scopeFields/submittable/autoname/...` and never reads `issingle` — this is the
   missing read.
2. **`Meta`** (src/meta/meta.js) gains `this._issingle = Boolean(def.issingle ?? false)` + a
   `get issingle()` (adr:231-233). Verified net-new: meta.js:17 + :28 are exactly the
   `_submittable`/`get submittable()` pair the ADR says to mirror — the mirror is accurate and
   there is no `issingle` on Meta today.
3. **`document.js`** branches on `meta.issingle` (adr:234, 239-250; diagram:138-143). Present.

The pass-1 "one change in document.js" under-scope is gone; the design now explicitly states
"3-SITE change, NOT 'one change in document.js'" (adr:224) and the phasing section reflects it
(adr:374-376).

### D2-2 (was MAJOR, the duplicate-row bug) — ordering explicit — CLOSED
adr-generator.md:239-250. The fix is ordered precisely: at the **top** of the save/insert path,
**before any `!doc.name` test**, `if (this.meta.issingle) this.doc.name = this.meta.doctype;`
(adr:246-247). The ADR cites the exact two sites this must precede — insert's
`if (!this.doc.name) this.doc.name = await resolveName(...)` (document.js:53) and save's
`if (!this.doc.name) return this.insert()` (document.js:67) — both verified accurate. With the
name forced first, `resolveName` is never reached for a Single (adr:248-249), so the hash-branch
random-name → new-row-per-save bug (naming.js:13-14) cannot occur; `save()` takes the
fixed-name update branch → idempotent upsert, exactly one row. Correct.

### D2-3 (was MINOR) — empty-doc-on-absent still passes read-perm — CLOSED
adr:253-255: "the empty-doc-on-absent read still passes the normal read-perm filter — no
privileged short-circuit." Addressed. (Still an implement-verify item against the perms layer,
noted below — but the design now states the requirement rather than hand-waving it.)

### D2-4 — `createTableSql`/`emitMigration` unchanged + EAV rejection — OK (re-confirmed).

---

## D3 — verified the 3 ADR edits landed (evaluator untouched, already PASS)

### C-D3-1 — the false "no coupling" claim corrected in BOTH places — CLOSED
- The open-question section is now retitled **"RESOLVED as the D1→D3 boundary"** (adr:340) and
  states option (A) is "now ENFORCED, not merely recommended … a one-way security coupling
  D1→D3, not a free choice … D3 does NOT ship until D1-2's explicit-drop contract is frozen +
  tested" (adr:357-363).
- The phasing section's old "share no code, no coupling" claim is corrected:
  "**Correction (C-D3-1):** the phases do NOT 'share no code / have no coupling' — there is a
  one-way security coupling D1→D3 … D3 must not ship until D1-2's explicit-drop contract is
  frozen + tested" (adr:383-389).
- Both places corrected, as required. The diagram also carries it (diagram:197-205).

### C-D3-2 — missing field = no throw, fail-closed relevance — CLOSED
adr:303-309: a `cond.field` absent from `doc` reads as `undefined`, **no throw**; well-defined
and **fail-closed for relevance** (`set`/`truthy`⇒false, `notset`/`falsy`⇒true,
`eq`/`gt`/etc.⇒false) — a missing condition input makes the dependent field not-relevant
(skipped), never forces it required. Correctly distinguished from an *authoring* bug
(non-array `in`), which still throws (adr:309, 311). This is exactly the defined behavior I
asked be stated as a decision rather than left implicit. Diagram:135-136 mirrors it.

### C-D3-3 — ALTER rollback comment — CLOSED
adr:273-276: the migration carries the rollback comment at the top per repo convention
(`-- ROLLBACK: alter table "tabDocField" drop column if exists depends_on, drop column if
exists mandatory_depends_on;`). Matches the `emitMigration` rollback-comment style
(installer.js:72). Diagram:157-162 mirrors it.

The evaluator itself (the security surface that PASSED in pass 1) is unchanged — re-confirmed
no `eval`/`new Function`, closed op table, `doc[field]`-only reads, fail-closed on
unknown-op/non-array-in/over-depth.

---

## Items for planner / implement (PASS, but pin these)

1. **D1-2 test is a HARD done-criterion.** The mapField-drops-eval-strings test (adr:106-108)
   must be an explicit task acceptance check, not a "nice to have." Phrase it as: *given a
   source def whose fields carry `depends_on`/`mandatory_depends_on` strings, the generated
   def has zero `dependsOn`/`mandatoryDependsOn` keys and zero string-typed conditions.* D3 is
   blocked on this being green.
2. **Ship ordering / gate (C-D3-1).** Enforce D1 → (D2) → D3 with D3 explicitly gated on D1-2's
   frozen+tested whitelist. The planner should make D3's start blockedBy D1's whitelist test
   landing — this is the one real cross-phase dependency.
3. **D2 implement-verify (D2-3).** Confirm the synthesised empty-Single doc flows through the
   same read-perm filter as any other doc (no privileged short-circuit) — design states the
   requirement; implement must test it against the perms layer, not assume it.
4. **D1 closure test.** Add a test that generating a seed with cross-area Links (e.g.
   `Sales Order`) under closure-by-default produces a set the loader can fully prime (no
   `NotFoundError`), and that `--no-closure` with an outside target throws at generate time
   naming the target.
5. **PG_TYPE_MAP `Time → time`** remains a flagged non-blocking open item (adr:163-165) — fine
   to defer; implement's call.

## Contract scorecard (pass 2)
- **Fail-Fast:** the two pass-1 violations are fixed — closure now fails at generate (not late
  at runtime), and the Single name is forced before the duplicate-row path can trigger.
- **Completeness/atomicity:** D2 half-build resolved (3 sites enumerated); D3 chain still whole.
- **Least-Privilege/security:** the D1→D3 boundary is now explicit, enforced, and tested-by-
  mandate — the single RCE-class risk is designed out at both ends.

## Handoff
**planner** — full track. No findings back to architect.
