# Critique — Pass E (closure-bounding + link-stubbing + Frappe-core-as-stub)

- **Reviewer:** critique
- **Pass 1:** 2026-06-21 — E3 FAIL · E1/E2/E4/E5 PASS(2 conditions) → back to architect.
- **Pass 2:** 2026-06-21 — re-review of REV 2.
- **Design under test:** `docs/adr-generator-stub.md` + `diagrams/generator-stub-class.puml`

## PASS 2 VERDICT

| Decision | Pass 1 | Pass 2 | Why |
|---|---|---|---|
| **E3 closure-bounding** | FAIL | **PASS** | Re-spec genuinely closes the data-loss hole: Table targets → FULL transitively, only Link targets stubbed; dead-end guard THROWs concretely. Two precision items for planner (below) — neither is a hole. |
| E1 marker chain | PASS(cond) | **PASS** | Chain intact; the trust condition is folded in. |
| E2 soft-link + trust | PASS(cond) | **PASS** | `is_stub` → RESERVED_KEYS specified with the exact one-liner; covers create + update. |
| E4 Frappe-core stubs | PASS | **PASS** | Load-bearing caveat now stated explicitly. |
| E5 upgrade | PASS(minor) | **PASS** | Downgrade no-op is a concrete branch; `columnsOf` dropped; PgAdmin stays write-only. |

**Overall: PASS → proceed to planner.** Two precision items (E3-reuse, E3-termination) are
done-criteria for the planner/implement, NOT findings back to architect — the corrected
*behaviour* is right; only a DRY *claim* and an unstated *guard* need tightening.

---

## E3 — verified the data-loss hole is GENUINELY closed

### The fix is real, not reworded
adr §3:184-234 + reuse map:341-344. The rule now splits by edge kind exactly as required:
- **seeds → FULL**; **Table / Table MultiSelect targets → FULL and TRANSITIVELY** (BFS on Table
  edges to a fixed point — children AND grandchildren full, adr:200-202, 218-219); **Link
  targets → STUBBED** (the seed's and every full doctype's Links, adr:203-205); **depth bound on
  LINK edges only, Table edges followed to closure** (adr:206-208).
- `InstallPlan` (adr:212-215): `full = seeds ∪ all transitive Table targets`,
  `stubs = Link targets of every full def − full`, disjoint by construction.

**The child's data columns now exist** → no `#saveChildren` loss. I confirmed the mechanism end
to end: a FULL child runs through `erpnextJsonToDef` → real `fields` → `createTableSql` emits the
data columns → `document.js #saveChildren` (document.js:117-132) inserts item_code/qty/rate into
columns that now exist. The pass-1 silent-data-loss path is eliminated. The ADR's own
"Verified facts" now cite `#saveChildren` (adr:44-47) and the loader edge-split (adr:48-53) as
the grounding — accurate.

### Dead-end guard — concretely specified (fail-fast)
adr:229-234: a Table/Table-MultiSelect target with **no JSON under `root`** **THROWS** at plan
time naming the missing child — never silently stubbed (which would lose its columns). This is
the right fail-fast: a JSON-less child is unrecoverable, so loud-at-plan beats silent-at-write.
Stated as a throw, not a comment. Good.

### Re-derived Quotation set — finite, confirmed
adr:224-227: ~9 full (Quotation + its 8 Table children) + Link targets stubbed (tens, not 298).
Matches my pass-1 ground truth (the 8 children have no further Table children, so the Table
closure is shallow here — but the rule is correctly transitive regardless). The 298 explosion
came entirely from recursing Link targets; cutting Links at the full-set boundary bounds it.
Correct.

### Two PRECISION items for the planner (not architect findings — the behaviour is sound)

**E3-reuse (DRY claim is inaccurate):** the ADR says twice (adr:220, 341) that `planInstall`
reuses "the existing `_depsOf` split (it already distinguishes Link from Table)." It does **not**
— verified: `_depsOf` (select-doctypes.js:100-112) returns a **flat `string[]`** of all
Link/Table/Table-MultiSelect options with **no fieldtype tag**. The loader splits the kinds
(loader.js:206-211, correctly cited), but the generator's `_depsOf` does not. So `planInstall`
can't get the edge-kind split *from `_depsOf` as it stands*. The fix is small and additive — a
`_depsOf` variant returning `{ links, tables }` (or a thin per-field walk mirroring
loader.js:206-211) — but the implementer must NOT assume an existing split. Planner: make
"`_depsOf` (or a sibling) returns edge-kind-tagged deps" an explicit task, not an assumed reuse.

**E3-termination (unstated guard):** the ADR says "BFS … to a fixed point" (adr:218) but never
names a **visited-set** against a Table self/mutual cycle. `closureOver` already proves the
pattern (a `visited` Set, select-doctypes.js:157-178) and `planInstall` should reuse it. The
loader's "Frappe forbids a child referencing its ancestor as Table" invariant (loader.js
comment) protects the *primed-graph* walk — but `planInstall` walks **JSON**, where a malformed
or unexpected self-reference would loop without an explicit visited-set. Planner/implement:
require a visited-set in the Table BFS (reuse `closureOver`'s) and a termination test (a
contrived Table A→B→A JSON pair terminates). Low risk given the Frappe invariant, but the guard
must be in the code, not implied.

---

## E2-trust — verified the reserved-key fix landed

adr §2:141-154. `is_stub` is to be added to `RESERVED_KEYS`, with the **exact one-liner**
specified: `const RESERVED_KEYS = new Set(['owner', 'docstatus', 'name', 'is_stub']);`
(adr:150). I confirmed the current state: `RESERVED_KEYS` today is `['owner','docstatus','name']`
(request-schemas.js:14) — so the edit is real and necessary. Coverage is **both create and
update**: `rejectReservedKeys` is wired into both `CreatePayloadSchema` (request-schemas.js:34)
and `UpdatePatchSchema` (request-schemas.js:39) via `superRefine`, so a single Set entry
rejects `is_stub` on **both** POST-create and POST-update envelopes — verified against the
source. Only `syncDoctype` (which builds `docTypeRow` directly, bypassing the request envelope)
can write it. The acceptance test is specified (adr:153-154): `POST /DocType/<name>
{is_stub:true}` ⇒ 400. Trust hole closed.

---

## E5 — verified both conditions landed

### Condition (a) — downgrade guard is a CONCRETE branch
adr §5:287-316. `migrate` now has an explicit 4-way branch on `(exists, wasStub, fullDef.isStub)`
where **branch 3 (DOWNGRADE NO-OP)** — `exists && !wasStub && fullDef.isStub === true` — returns
`{ applied:false, skipped:'downgrade-refused' }` with **no DDL and no `is_stub` re-flip**
(adr:302-304, 311-316). This is a real code path with a definite return value, not prose. A
`makeStubDef`-then-`migrate` over a full table can never soften a populated doctype. Confirmed.
Stub-state is read authoritatively from `tabDocType.is_stub` (adr:288-289) — no DDL
introspection, per ruling 2.

### Condition (b) — columnsOf dropped, PgAdmin stays write-only
adr:318-324. The upgrade passes `alterColumnsSql(fullDef, [])` and lets the DB's `ADD COLUMN IF
NOT EXISTS` do the diffing — safe because re-adding an existing framework column is a DB no-op.
I re-confirmed `PgAdmin` is write-only (pg-admin.js: only `applyDDL`, injected `exec` is
`(ddl)=>Promise<void>`, can't return rows), so this correctly avoids adding a read surface (SoC).
Open fork 2 is marked RESOLVED (adr:383-384). Correct.

Idempotency holds across all four branches (`IF NOT EXISTS` DDL, upsert-by-name sync,
set-not-append version). Confirmed.

---

## E4 — caveat now explicit

adr §4:254-273. The load-bearing caveat is stated: Frappe-core-as-stub works **only because all
20 core targets are LINK edges** — a JSON-less core **Table child** would hit the E3 dead-end
guard and throw. Ground truth (none of the 20 is an erpnext child) is cited as making it safe
today, with the gh-source enhancement correctly scoped as the prerequisite *if* that ever
changes. Sound.

---

## LEAD rulings — all respected (not relitigated)
- **(1) No default-flip this pass** — the ADR still recommends the flip as an open fork
  (adr:249-250, 381-382) but does not enact it; `--stub-deps` is the new recommended mode
  alongside the kept `--closure` default. Consistent with the ruling (the flip is a fast-follow).
- **(4) Post-upgrade sweep deferred** — offered as an optional reporting tool, not a gate
  (adr:174-176, 386-387). Respected.
- **(5) reqd Link into a stub still requires a non-empty value** — confirmed: existence is
  softened, required-ness is not (adr:167-168, 388-390; `validateAgainstMeta` enforces the value
  independently of `validateLinks`).

---

## Items for planner / implement (PASS — carry these)
1. **E3 is the gating change** — `planInstall`: Table targets full (transitive), Link targets
   stubbed. Test: generating `Quotation` under `--stub-deps` produces `tabQuotationItem` WITH its
   data columns; creating a Quotation with line items round-trips (no silent drop).
2. **E3-reuse (NEW):** do NOT assume `_depsOf` splits Link/Table — it returns a flat list. Add a
   `{links, tables}` extractor (or per-field walk mirroring loader.js:206-211). Make it an
   explicit task.
3. **E3-termination (NEW):** the Table BFS must carry a visited-set (reuse `closureOver`'s); add
   a termination test (contrived Table A→B→A JSON terminates).
4. **`is_stub` ∈ RESERVED_KEYS** — one-line add; test `POST /DocType {is_stub:true}` ⇒ 400 (both
   create + update envelopes).
5. **Soft-link 3-case matrix** — (a) Link into stub + nonexistent value → accepted; (b) same after
   target upgraded to full → rejected (re-hardened); (c) Link into a full target with a bad value
   → rejected even while OTHER targets are stubs (proves target-scoped gating).
6. **Downgrade no-op test** — stub install over a full table → `{applied:false}`, columns +
   `is_stub=false` intact, no DDL.
7. **Dead-end guard test (NEW):** a seed whose Table child has no JSON → `planInstall` throws
   naming the child.
8. **E5 `alterColumnsSql(def, [])`** — pass empty `existingCols`; do not add a read method to
   `PgAdmin`.

## Contract scorecard (pass 2)
- **Fail-Fast / Integrity:** the data-loss path is closed (Table children full); dead-end and
  downgrade both throw/no-op explicitly; `is_stub` write ⇒ 400.
- **DRY:** mostly exemplary — the one inaccuracy is the `_depsOf`-splits claim (E3-reuse), a
  documentation/spec gap, not a logic flaw.
- **KISS/SoC/Least-Privilege:** stub = framework table + boolean; PgAdmin stays write-only;
  `is_stub` reserved (installer-only). Sound.

## Handoff
**planner** — full track. No findings back to architect; the two E3 precision items are
planner/implement done-criteria, not design defects.
