# ADR — Generic, metadata-driven Desk UI client

Status: **Proposed** (design only — awaiting `critique`, then `planner`)
Date: 2026-06-21
Author: architect
Companion diagram: `diagrams/desk-ui-class.puml`
Related: `docs/adr-desk-bridge.md` (the server side this client consumes)

---

## 1. Problem

`spartan-erp-engine` is a headless Frappe-base-level metadata engine. It publishes,
per identity, a complete description of every doctype the user may touch — fields
(permission-masked), capabilities, child metas, and workflow graph — plus CRUD and
workflow-action endpoints under `/api`. There is **no UI**. We need a single frontend
that can render **list / form / create / edit / workflow-action** views for **any
doctype**, driven purely by that published metadata — so adding a new doctype to the
engine requires **zero** Desk changes (the Frappe "Desk renders from meta" property).

## 2. Hard architectural constraint (the invariant)

The engine is the authoritative headless "bench" at `/api/*`. The Desk is a **separate
client** that talks to the engine **only over HTTP `/api`** and **never imports any
engine `src/` module**. This is the Frappe "Desk is just a client" invariant: the Desk
is untrusted; every permission and business rule is re-checked server-side on every
call. The Desk renders only what `/api/meta` chooses to return.

Plain HTML/JS/CSS, **no build step** — ES modules via `<script type="module">`,
matching the engine's no-build ethos. No bundler, no transpile, no framework runtime.

## 3. Options considered

| # | Option | Verdict |
|---|--------|---------|
| A | Embed Desk views inside the engine's `api/` functions (SSR HTML from `src/`) | **Rejected** — violates the invariant (Desk would import `src/`); couples UI lifecycle to function cold-starts. |
| B | Separate repo + separate Vercel project for the Desk | **Rejected for v1** — introduces CORS, a second deploy, and cross-origin token handling for no benefit; the engine project already serves static assets. |
| C | **Static SPA in the SAME Vercel project, served from `/app`, HTTP-only to `/api`** | **Chosen** — single origin (no CORS), one deploy, honours the invariant, no build step. |

## 4. Decision

### 4.1 Where it is served — `/app`, single origin

Vercel serves the engine project's `public/` directory as the static root **alongside**
the `api/*` functions (confirmed live: `public/index.html` is the existing landing page
served at `/`, and `api/health.js` etc. are functions). To leave `/` undisturbed, the
Desk ships as static files under **`public/app/`**, reachable at **`/app`**.

Because it is a hash-routed SPA (§4.4), a single `public/app/index.html` is the only
HTML entry — `#/...` fragments never hit the server, so **no SPA rewrite rule is
required**. A minimal `vercel.json` is added only to (a) keep `public/` as the static
root explicitly and (b) optionally redirect `/app` → `/app/` (trailing slash). If
history routing is chosen instead (fork F1), a rewrite `{ "source": "/app/(.*)",
"destination": "/app/index.html" }` becomes mandatory — another reason to default to
hash routing.

No-build module layout under `public/app/`:

```
public/app/
  index.html                 ' loads main.js as type="module" + GIS <script>
  css/desk.css
  js/
    main.js                  ' App.start() — bootstraps shell
    shell/router.js          ' Router, Workspace
    auth/session.js          ' Session (GIS wrapper), SignInGate
    api/client.js            ' ApiClient, ApiError/ForbiddenError/NotFoundError
    meta/cache.js            ' MetaCache
    views/list-view.js       ' ListView
    views/form-view.js       ' FormView
    widgets/registry.js      ' WidgetRegistry + simple widgets
    widgets/link-picker.js   ' LinkPicker
    widgets/child-grid.js    ' ChildGrid
    workflow/bar.js          ' WorkflowBar
```

### 4.2 Auth — Google Sign-In → Bearer idToken

The engine consumes `Authorization: Bearer <google idToken>`
(`src/api/context-from-request.js`: bearer → `verifyGoogleIdToken` → `resolveUserToCtx`).
The Desk therefore:

1. Loads **Google Identity Services** (`https://accounts.google.com/gsi/client`) and
   renders the Sign-In button with client id
   `54203725419-2ad869ea9p81lcmf6osm5htos0maoepl.apps.googleusercontent.com`.
2. On sign-in, GIS returns a **`credential`** — that string **is** the Google idToken.
   `Session` holds it and attaches it as `Authorization: Bearer <credential>` on every
   `/api` call (via `ApiClient`).
3. **Same origin** (`/app` and `/api` share the host) → no CORS, no preflight concerns.

**Token storage (fork F2 — recommend in-memory + sessionStorage mirror):** keep the
idToken in a module-scope variable for the live session, mirrored to `sessionStorage`
so a tab refresh doesn't force a re-sign-in. Trade-off: `sessionStorage` is readable by
any same-origin script, so it carries XSS exposure — but the token is short-lived
(~1h), the Desk has no third-party script surface beyond GIS, and the engine re-verifies
every token server-side. `localStorage` is rejected (persists across sessions, larger
theft window). A pure-memory option (no mirror) is the most conservative but re-prompts
on every refresh — flag for the LEAD.

**Expiry / 401 handling:** Google idTokens expire ~1h. The Desk does **not** track
expiry proactively; instead `ApiClient` treats any **401** as "token dead" → ask
`Session` to refresh. `Session` first attempts a **silent** `google.accounts.id.prompt()`
(one-tap / auto-select if the user is still signed in to Google); if that yields no
credential, it falls back to the full `SignInGate`. The in-flight request is retried once
with the new token. Signed-out state = `SignInGate` blocks all views.

### 4.3 API client — the single egress, exact envelopes

One module (`ApiClient`) is the **only** code that calls `fetch('/api/...')`. It injects
the Bearer, sends the engine's exact request envelopes, and normalizes responses.

**Request envelopes (verified against `src/api/handler.js` + `src/validation/request-schemas.js`):**

| Op | HTTP | Body / query |
|----|------|--------------|
| boot | `GET /api/boot` | — |
| meta | `GET /api/meta/<dt>` | — |
| list | `GET /api/<dt>` | query: `limit`, `offset`, `order` (`asc`\|`desc`), `order_by`, and filters as **`f_<field>=<value>`** |
| get | `GET /api/<dt>/<name>` | — |
| create | `POST /api/<dt>` | **bare record** of business fields: `{ title, branch, … }` |
| update | `POST /api/<dt>/<name>` | **bare record** patch: `{ <changed fields> }` |
| action | `POST /api/<dt>/<name>` | `{ "action": "<transition\|submit\|cancel>" }` |

Critical envelope facts the client MUST honour:
- Create/Update bodies are a **flat record**, *not* wrapped (no `{data:…}`). Any business
  field passes.
- **Reserved keys** `owner`, `docstatus`, `name`, `is_stub` are **rejected** by the engine
  (`request-schemas.js` `RESERVED_KEYS`). `ApiClient.collect`/strip must never include
  them — the document `name` goes in the **URL**, never the body.
- Action vs update is disambiguated **by the presence of `body.action`** (handler line
  `const action = body && body.action`). So `ApiClient.action()` and `ApiClient.update()`
  hit the *same* URL; only the body differs.
- `submit` and `cancel` are just actions (`{action:"submit"}` / `{action:"cancel"}`);
  any other `action` value is a declarative workflow transition.

**Response / error mapping (verified against `handler.js` `statusFor` + the route catches):**
all errors return `{ error, type }` with status: **401** AuthError, **403** PermissionError,
**404** NotFoundError, **409** StateError, **400** ValidationError, **500** otherwise.
`ApiClient` maps: 401 → re-auth (§4.2); 403 → `ForbiddenError` (forbidden UI); 404 →
`NotFoundError`; 400/409 → `ApiError` carrying `{error,type}` for the form/guard UI to
surface **verbatim** (the engine's message — e.g. the Job 5% gate `StateError` — is the
user-facing text).

### 4.4 Routing (fork F1 — recommend hash)

Hash routing (`#/<dt>`, `#/<dt>/new`, `#/<dt>/<name>`). Routes resolve client-side, so a
deep link or refresh never 404s and **no Vercel rewrite is needed**. History routing
(`/app/<dt>/...`) gives cleaner URLs but requires a catch-all rewrite to
`public/app/index.html` and careful base-path handling. Recommend hash for v1 simplicity;
escalate to LEAD if clean URLs are a hard requirement.

### 4.5 Generic renderers (render from meta, never hard-code a doctype)

- **`MetaCache`** memoizes `GET /api/meta/<dt>` for the session — the single source of
  "what fields exist". The bundle shape (from `buildMeta`):
  `{ doctype, capabilities{read,write,create,delete,submit,cancel}, meta{fields[masked],
  childTables}, child_metas{<childDt>:meta}, workflow{stateField,states,transitions[]}|null }`.
- **`ListView`** = `meta` + `GET /api/<dt>` → table. Display columns chosen from the masked
  fields with a small heuristic (first ~5 non-`Table` fields; honour `idx` ordering). Row
  click → `#/<dt>/<name>`. "New" button shown iff `capabilities.create`.
- **`FormView`** = `meta` + (`GET /api/<dt>/<name>` for read/edit, or blank for create) →
  one widget per field via the registry. Save calls `ApiClient.create`/`update` with the
  collected **bare record**. On **400 ValidationError**, map the engine's issue paths to
  per-field inline messages.

### 4.6 Fieldtype → widget map (the heavy layer)

Driven by `FieldDef.fieldtype` (`src/meta/registry.js`):

| fieldtype | widget |
|-----------|--------|
| `Data` | text input |
| `Text`, `Code` | textarea |
| `Int`, `Float`, `Currency` | number input |
| `Check` | checkbox |
| `Date` | `<input type=date>` |
| `Datetime` | `<input type=datetime-local>` |
| `Select` | `<select>`; options from `field.options` (**array OR `\n`-delimited string** — normalize both) |
| `Link` | **`LinkPicker`** — typeahead querying the target doctype's list endpoint |
| `Table` | **`ChildGrid`** — editable child rows |

`WidgetRegistry` is a `fieldtype → factory` map (open for new types, closed for edits —
OCP). `readOnly` fields render display-only even in edit mode. (`dependsOn` /
`mandatoryDependsOn` conditional visibility is **out of scope for increment 1** — flag F4.)

**`LinkPicker`:** `field.options` is the target doctype. Typeahead → `GET
/api/<target>?f_<displayfield>=<q>&limit=…` → user picks a row; the widget stores the
linked doc's **`name`** as the value. (Server-side filter semantics are simple equality
via `f_*`; a "contains" search may need an engine enhancement — flag F5 for diagnose.)

**`ChildGrid`:** a `childTables` entry. Columns come from
`child_metas[child.doctype].fields`; rows are add/remove editable; each cell reuses
`WidgetRegistry`. On collect, the row array is embedded under the **parent fieldname** in
the create/update record (the engine inlines child metas precisely so the client can do
this without a second meta fetch). **Staging (fork F3 — recommend):** ship `ChildGrid` as
increment 2; increment 1 can render child tables read-only. Heaviest single widget; let
`planner` decide the cut.

### 4.7 Workflow-action rendering + guard UX

`WorkflowBar` reads `metaBundle.workflow` + the doc's current state
(`doc[workflow.stateField]`) + `boot.roles`. It shows **only** transitions whose `from`
equals the current state **and** whose `roles` is undefined or intersects the user's roles
(matching the engine's transition shape `{from,to,action,roles}` from `buildMeta`). A
click fires `ApiClient.action(dt,name,action)`. On **409 StateError** (a guard/gate block,
e.g. the Job 5% gate), the engine's `error` message is surfaced **inline, verbatim** — the
guard text is the UX. `submit`/`cancel` buttons are additionally gated by
`capabilities.submit`/`cancel`.

### 4.8 Untrusted-client / masking invariant (stated explicitly)

- The Desk renders **only** fields present in `meta.fields` (already permlevel-masked by
  `buildMeta`/`projectMeta`). It **never** assumes a field exists or hard-codes one.
- `capabilities` and `workflow.roles` drive **show/hide only** — purely cosmetic. The
  engine re-checks permission, validation, and workflow guards on **every** real call
  (`can()` in the service layer); a hidden button is a UX nicety, not a security boundary.
- The Desk holds **no** business logic and **no** doctype-specific code paths. The only
  doctype names it ever knows are the ones the engine handed it in `boot.doctypes`.

## 5. Consequences

**Positive**
- New doctypes appear in the Desk with **zero** client changes (meta-driven).
- Single origin, single deploy, no CORS, no build step — minimal ops surface.
- One egress seam (`ApiClient`) → auth, envelope, and error handling live in exactly one
  place (DRY, SoC).
- Clean increment story: shell+auth+list+read-only form first; edit/create; widgets;
  child grid; workflow — each shippable.

**Negative / risks**
- idToken in `sessionStorage` carries XSS exposure (mitigated: short-lived, server
  re-verifies, no third-party scripts beyond GIS) — fork F2.
- `LinkPicker` search depends on `f_*` filter expressiveness (equality only today) — may
  surface an engine gap (F5).
- `ChildGrid` is the heaviest piece; staging it (F3) keeps increment 1 small.
- Hash routing gives `#/`-style URLs (F1).

## 6. Design-contract check (CLAUDE.md §7)

- **DRY** — one `ApiClient`, one `WidgetRegistry`, one `MetaCache`; no per-doctype code.
- **KISS** — no framework, no build, hash routing, plain DOM.
- **YAGNI** — `dependsOn`, full-text Link search, history routing all deferred behind forks.
- **SOLID** — `FieldWidget` interface + registry (OCP/LSP); each view single-responsibility.
- **SoC** — auth / transport / meta / render / workflow are separate modules.
- **Least Privilege** — Desk is untrusted; renders only masked meta; engine re-checks all.
- **Idempotency** — GET/meta/list are safe; create/update carry no client-minted `name`
  (engine names) so retries don't duplicate identity.
- **Fail-Fast** — `ApiClient` normalizes every non-2xx into a typed error immediately;
  no silent swallow.

## 7. Forks for the LEAD

- **F1 — Routing:** hash (recommended, no rewrite) vs history (clean URLs, needs rewrite).
- **F2 — Token storage:** in-memory+sessionStorage mirror (recommended) vs pure-memory
  (re-prompt on refresh) vs localStorage (rejected).
- **F3 — `ChildGrid`:** ship in increment 1, or stage to increment 2 with read-only child
  tables first (recommended stage).
- **F4 — Conditional fields:** implement `dependsOn`/`mandatoryDependsOn` now, or defer
  (recommended defer).
- **F5 — Link search:** `f_*` equality may be insufficient for typeahead "contains" — may
  need an engine query enhancement; flag to `diagnose` rather than assume.
- **F6 — Styling depth:** minimal utilitarian CSS for v1 (recommended) vs a designed theme.
