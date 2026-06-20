# Spartan ERP Engine

A **Frappe-base-level, self-describing metadata engine** in **plain JavaScript (ES2022 / ESM)** on
**Vercel + Supabase**. It reproduces the *core* of the Frappe framework — the DocType model, the
document lifecycle, server-authoritative permissions, and declarative workflow — with idiomatic JS
instead of Python. [`frappe/frappe`](https://github.com/frappe/frappe) is the behavioural authority:
every semantic decision (docstatus, permlevel, naming, `fetch_from`, workflow) is verified against
it, but the code is shaped for JS, not ported from it.

**Self-describing:** the engine stores its *own* metadata in the database — `DocType`, `DocField`,
`DocPerm`, `Role`, `Workflow` are rows in `tabDocType` etc., loaded at runtime. A doctype defined
entirely as data is fully usable (CRUD, naming, links, permissions, workflow) without a line of
hand-written code. *This is the soul of Frappe, and it is proven live against real Postgres* (see
`scripts/prove-customer-as-data.mjs`).

> **No build step.** Vercel runs the `.js` source directly. TypeScript is used *only* as an opt-in
> linter (`npm run check`, `noEmit`) on the keystone modules — it never compiles output.

## Why plain JS, not TypeScript

A metadata engine is dynamic and string-keyed (`doc[fieldname]`, `getMeta(doctype)`), so it runs as
plain JS with JSDoc types. The opt-in `tsc --checkJS` linter covers the load-bearing modules
(permissions, loader) where a silent key typo hurts most — best of both: zero runtime build,
type-checking where it matters.

## Architecture

```
                       ┌─────────────────────────── META (self-describing) ──────────────────────────┐
                       │ tabDocType · tabDocField · tabDocPerm · tabRole · tabWorkflow + Transition    │
                       │ + meta_version (cache-invalidation sentinel)                                  │
                       └───────────────┬─────────────────────────────────────────┬────────────────────┘
   handler.handle()                    │ MetaLoader.ensure() (per request)        │ Installer.syncDoctype()
   await ensure(doctype,store) ───────▶│  transitive Link+Table closure,          │  upserts meta rows via
   then the SYNC pipeline:             │  snake→camel, bool-coerce, child-first    │  Document.save() +
                                       ▼                                          ▼  emitMigration() (DDL→file)
   newDoc → validate → links → permissions → save  ◀── getMeta(doctype) (SYNC, cache-only, throws on miss)
```

- **Runtime** (`src/runtime/`) — `Document` / `SubmittableDocument` (lifecycle hooks, child tables,
  **docstatus 0→1→2** immutability), `naming` (atomic series), `validate` (meta-driven), `links`
  (`fetch_from` + existence), `Store` (base) / `MemoryStore` / `SupabaseStore`.
- **Meta** (`src/meta/`) — `Meta` (a doctype's definition + helpers), `MetaRegistry` (sync,
  cache-only, pinned boot set, version state), `boot-meta` (the 6 pinned meta-doctypes), `MetaLoader`
  (`ensure`/`load`/`ensureFresh`), `Installer` (sync to DB + emit DDL), `ddl` (pure DDL emitter).
- **Permissions** (`src/perms/`) — server-authoritative, read from meta:
  `can` / `visibleFields` / `maskRead` / `assertCanWrite` / `queryConditions`. Admin is unrestricted
  by an **explicit** context grant, never a `role==='admin'` short-circuit.
- **Workflow** (`src/workflow/`) — declarative states/transitions from `tabWorkflow` rows;
  `condition`/`onTransition` code hooks in a `WORKFLOW_HOOKS["Doctype::action"]` map. Coexists with
  docstatus.
- **API** (`src/api/` + `api/`) — a generic, perm-aware service + handler; **two Vercel routes cover
  every doctype**: `api/[doctype]/index.js` (list/create) and `api/[doctype]/[name].js`
  (get/update/`{action}`).

## The four permission layers (Frappe model)

| Layer | What it controls | Where |
|---|---|---|
| **docperm** | which ops a role may do (read/write/create/submit/cancel/delete) | `DocPerm` rows on the DocType |
| **permlevel** | which *fields* a role may read/write (e.g. hide `credit_limit`) | `field.permlevel` + per-level docperm |
| **row-scope** | which *rows* (branch / own-records) | `queryConditions(ctx, doctype)` |
| **explicit admin** | full access by grant, not by role | `ctx.unrestricted` |

## Layout

```
src/
  meta/        registry.js · meta.js · boot-meta.js · loader.js · installer.js · ddl.js
  runtime/     document.js · store.js · memory-store.js · supabase-store.js · naming.js · validate.js · links.js · errors.js
  perms/       context.js · permissions.js
  workflow/    workflow.js · hooks.js
  api/         service.js · handler.js · context-from-request.js
  bootstrap.js (cold-start: registerBootMeta + in-code doctypes)
  test-helpers/seed-via-loader.js
api/           [doctype]/index.js · [doctype]/[name].js · health.js   (Vercel functions)
public/        index.html  (status homepage)
supabase/migrations/  20260620000001_customer.sql · 20260620010000_meta_core.sql
docs/          adr-meta-as-data.md · critique-meta-as-data.md · workorder-meta-as-data.md
diagrams/      meta-as-data-class.puml
scripts/       check-supabase.mjs · prove-customer.mjs · prove-customer-as-data.mjs
```

## Develop

```bash
npm install
npm test            # vitest — 180 tests green (runtime, meta, perms, workflow, api, integration)
npm run check       # opt-in tsc --checkJS (noEmit) — never builds
npm run dev         # vercel dev (needs the Vercel CLI + .env)
```

The service/runtime layers are **store-injectable**, so almost everything is unit-tested against
`MemoryStore` with no live DB. `src/meta/meta-as-data.integration.test.js` proves the full
define-as-data → Installer → Loader → usable Document round-trip.

## Provisioning (the engine has its OWN isolated Supabase project)

1. A dedicated Supabase project (**not** the SpartanCRM prod DB). Put its keys in `.env`
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; see `.env.example`). Verify with
   `node --env-file=.env scripts/check-supabase.mjs`.
2. Apply migrations: `supabase link --project-ref <ref>` then `supabase db push`
   (creates the meta tables + any per-doctype data tables the Installer emits).
3. Live-verify: `node --env-file=.env scripts/prove-customer-as-data.mjs`.
4. Deploy: link the repo to its **own** Vercel project (not the CRM's), set the same env vars.
   Endpoints: `/` (status), `/api/health`, `/api/<Doctype>`.

> **Auth is a dev shim.** Requests carry identity via `x-spartan-*` headers
> (`context-from-request.js`) — **NOT secure**. Real token verification (Supabase Auth / Google
> idToken → role/branch lookup) is the next step; keep the deployment private until then.

## Status

**Frappe base: complete.** DocType-as-data · Document lifecycle + docstatus · naming/validate/links ·
four-layer permissions · declarative workflow · generic API · self-describing meta — all green and
verified live against real Postgres.

Built via a design pipeline (architect → critique → planner → implement specialists), with the
design recorded in `docs/` and `diagrams/`.

**Next (not "base"):** real auth · a generator (ERPNext DocType JSON → meta rows, to pour doctypes
in at scale) · Tier-2 batteries (timeline, todo, versioning, notifications, scheduler) · the Job
spine + its payment-gated status machine (the operational engine that replaces Ascora).
