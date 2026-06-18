# Spartan ERP Engine

A lean **TypeScript** business engine on **Vercel + Supabase**. Its data model and
document lifecycle are **generated from ERPNext's DocType JSON** (the source of truth
for *data entities*), while the operational workflow (the **Job** + its ~15-state
status machine) is designed from the Spartan operations manual. Long term, this engine
**replaces Ascora** as the operational system of record.

See `docs/ops-manual-coverage.md` for the architecture decisions and `diagrams/` for
the class model.

## Layout

```
src/
  slice.config.ts          # which DocTypes to materialize + ERPNext root path
  generator/               # DocType JSON -> Supabase migration + TS types
    fieldMap.ts            #   ERPNext fieldtype -> { pg type, ts type }
    resolve.ts             #   locate a DocType's JSON by name
    generate.ts            #   core: one DocType -> SQL + TS interface
    cli.ts                 #   entrypoint (npm run generate)
    synthetic/             #   framework doctypes not in the erpnext app (Currency)
generated/                 # OUTPUT (regenerate, don't hand-edit)
  migrations/0001_selling_slice.sql
  types.ts
api/health.ts              # Vercel health-check function
diagrams/                  # PlantUML class model
docs/                      # coverage map + decisions
```

## Generate the schema

```bash
npm install
npm run generate     # reads ERPNext DocType JSON -> generated/
npm run typecheck    # tsc --noEmit
```

The generator turns each in-slice DocType into:
- a Postgres `CREATE TABLE` (base columns + scalar fields; child tables for `Table` fields in-slice),
- a TypeScript interface (`extends BaseDoc` / `ChildDoc`; `Select` -> string-literal unions; `Link` -> string with target noted).

## What the generator does NOT do (yet)

- No FK constraints (Link = plain text + comment) — added later once the full master set exists.
- No `ALTER TABLE` for added columns — v1 is create-only; drop & recreate in dev.
- `reqd` is enforced in the TS/controller layer, not as `NOT NULL` (rows may be drafts).

## Phases

| Phase | What | State |
|---|---|---|
| 0 | Scaffold (TS, Vercel, Supabase) | ✅ |
| 1 | Schema generator (DocType JSON -> SQL + types) | ✅ |
| 2 | Minimal Selling doctype set generated | ✅ (Currency/UOM/Company/Customer/Item/Sales Order/+Item/Window) |
| 3 | Document lifecycle runtime (load/save/submit) | ✅ (`src/runtime/`, swappable store, 3 tests green) |
| 4–5 | Sales Order controller (validate, submit/cancel) | ✅ (`src/controllers/`, 7 tests; totals + status machine) |
| 6 | Vercel API + thin UI | next |
| 7 | Prove it generalizes (2nd doctype) | |
| 8+ | **Job spine + status machine** (replaces Ascora) | the real engine |

## Provisioning (manual, human steps)

1. Create a **new** Supabase project (not the SpartanCRM prod DB). Put its keys in `.env` (see `.env.example`).
2. Apply `generated/migrations/0001_selling_slice.sql` (Supabase CLI `db push` or SQL editor in the new project).
3. Link the repo to a new Vercel project; set the same env vars.
