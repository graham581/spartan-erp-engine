# Ops Manual Coverage & Architecture Decisions

**Source of truth checked:** `Full_Operations_Manual Version 31 25-1-26` (Spartan Master Operations Manual v3.1, 125 pp).
**Checked on:** 2026-06-18. **Against:** the Option-2 ERPNext-derived engine plan + Selling-slice class diagram (`diagrams/selling-slice-class.puml`).

---

## The decisive finding

The manual does **not** describe a greenfield business. It describes a workflow orchestrated across **four existing systems**, and the real operational centre of gravity is a **Job**, not a Sales Order:

| System | Role in the manual |
|---|---|
| **Pipedrive** | Sales CRM. Ops begins when a deal is marked **WON** (Ch.1 §1, p.1). |
| **Ascora** | The operational **spine**: the Job record, the **~15-state status machine**, calendar/bookings, document storage. |
| **Klaes** | Window-industry CAD/manufacturing. **Owns** manufacturing — produces Cut / Glass / Profile / Assembly / E-Control lists + BOM (Ch.2 §1; Ch.3 §2). |
| **Xero** (+ Zip Money) | Accounting & payment clearance (Ch.1 §1.2, §3.1). |

~80% of the manual is genuine operational process (good ERP fit); ~20% (Ch.6 Accountability) is HR policy, out of scope.

## Decisions taken (2026-06-18)

1. **Engine role = REPLACE ASCORA / become the Job spine.** The engine becomes the operational system of record, owning the Job + status machine, eventually retiring Ascora. Pipedrive / Klaes / Xero remain as feeders/integrations. (Aligns with the existing "replace Pipedrive" trajectory and the SpartanCRM + installer apps.)
2. **Build order = finish Selling-slice masters FIRST (Phases 1–7) to prove the generator + lifecycle runtime, THEN build Job on top.** Validate the toolchain on low-risk masters before betting it on the real spine.

## Architecture implications (carry these into the Job phase)

- **Job is the operational parent**; Sales Order is the **quote artifact** that sits beneath it. The Selling-slice work is NOT wasted — Customer/Item/UOM/Company masters + Sales Order are still needed, re-parented under Job later.
- **Status machine ≠ `docstatus`.** Frappe's 0/1/2 submit/cancel lifecycle (what the current class diagram models) cannot represent the ~15 operational states (`a`, `b`, `c.2`, `d.1`–`d.5`, `d.11`, `e`/`e.1`, `f`, `g`). Job needs a **first-class custom `status` workflow**.
- **Payment-gated transitions** are core domain logic: 5% deposit before measure, 45% before sign-off, manufacturing payment before scheduling. Status cannot advance until money clears (Xero integration).
- **Two legal entities** (Spartan VIC / Spartan ACT) drive financial routing + job-ID prefixes (`VIC-`/`ACT-`) + separate Job Travelers. Multi-company routing logic from day one.
- **Do NOT rebuild Manufacturing/MRP** — Klaes owns it. Build a **Klaes document-ingest + production-status** layer instead. This shrinks scope significantly.
- **Integrate, don't duplicate** existing Spartan systems: `factory_red_tags` (Red Tag), installer punches/geofence/SWMS, Documenso (Final Sign-Off), Smart Clusters.
- **Document-centric workflow**: nearly every step is "generate PDF → rename exactly → upload → delete old version." Strict naming/versioning is a first-class requirement.
- **Window-domain data** absent from the current model: opening direction, glass/safety-glass type, transom/mullion dims, reveal calcs (Vario 2/3-track offsets), trim codes, handle heights, frame config. The measurement **code dictionary** ("Page 1") is in image/form pages — needs separate capture to become structured Item attributes.

## Recommended module order AFTER the Selling slice

1. **Job + status state machine** (NEW custom core — the spine).
2. **Accounts** — staged invoicing + payment gating (5%/45%/mfg/final).
3. **Buying** — "open-order (no-date) → call-off (lock date)" PO lifecycle.
4. **Stock** — dispatch/packing/bays + profile allocation ("Blue Tape" holds).
5. **Scheduling/Projects** — Wednesday revenue-planner selection, Job Traveler zone sign-off, bookings, crew.
6. **Klaes integration** — document ingest + production-status tracking (NOT an MRP rebuild).
7. **Support/Maintenance** — Service Fast Lane (triage, Two-Order rule, scheduling).
8. **Skip/defer** — full Manufacturing MRP (Klaes owns), HR/Accountability (Ch.6), anything live in the installer app.

## Process → coverage summary (condensed)

| Process | Verdict |
|---|---|
| P1 entity routing | IN SELLING SLICE |
| P2/P3 staged invoicing | DEFERRED-ERPNEXT (custom milestone triggers) |
| P4 site measurement | NOT IN ERPNEXT (custom; overlaps installer app) |
| P5 final sign-off | SPARTAN-SPECIFIC (Documenso) |
| P6 date change | NOT IN ERPNEXT (3-system sync) |
| P7 variation | DEFERRED-ERPNEXT + custom hold/red-tag |
| P8/P12 Klaes design & docs | NOT IN ERPNEXT — Klaes owns; we ingest |
| P9/P11 procurement | DEFERRED-ERPNEXT + custom open-order/call-off |
| P13 production status | NOT IN ERPNEXT as-is — custom state machine |
| P14 red tag | SPARTAN-SPECIFIC (`factory_red_tags`) |
| P15/P16 dispatch/pack | DEFERRED-ERPNEXT + custom checklists/bays |
| P17 site protocol | SPARTAN-SPECIFIC (installer app) |
| P18 KPIs/HR | NOT IN ERPNEXT / out of ERP scope |
| P19/P20/P21 service | DEFERRED-ERPNEXT + heavy custom |
| P22 accountability | NOT ERP (HR policy) |
