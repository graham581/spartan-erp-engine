# Work order — Generic Desk UI client (`/app`)

Status: **GO** (composition checked — see §6)
Date: 2026-06-21
Planner. Consumes: `docs/adr-desk-ui.md` (frozen design) + `docs/critique-desk-ui.md` (PASS, conditionals C1–C4 + notes N1–N7).
Build phase: LEAD spawns one `implement` specialist per UNIT below, parallel where §5 allows.

> **Scope of v1 (frozen):** static no-build SPA under `public/app/` → served at `/app`, single
> origin, HTTP-only to `/api`. Hash routing (LEAD F1). Token in-mem + `sessionStorage` mirror
> (LEAD F2). Editable `ChildGrid` IS in v1 as its own unit (LEAD F3). `dependsOn` deferred (LEAD F4).
> LinkPicker = capped fetch + client-side filter (LEAD F5). Minimal CSS (LEAD F6).
> **`issingle` doctypes are OUT OF SCOPE for v1** (C3 resolution — see U2 + U5).

---

## 0. Environment facts the build must respect (verified live)

| Fact | Evidence | Consequence for the build |
|---|---|---|
| `public/index.html` already serves `/` (engine landing) | `public/index.html` exists | Desk is **additive** under `public/app/` — never touch `public/index.html`. |
| **No `vercel.json`** in the repo | root listing | Hash routing ⇒ none required. **Do NOT add a global `"/(.*)"` rewrite** (would swallow `/api/*`, N7). If a `vercel.json` is added at all, it must NOT contain a catch-all rewrite. Recommendation: **add none.** |
| **jsdom is NOT installed**; vitest runs node-env only | `node_modules/jsdom` absent; no `vitest.config.js` | Unit tests must exercise **pure, DOM-free logic** with mocked `fetch`. **Do NOT introduce a jsdom dependency** (no-build / minimal-dep ethos). DOM rendering is verified by the **live proof**, not vitest. |
| **Playwright is NOT installed** | `node_modules/@playwright` absent | Live-proof acceptance is **manual** (LEAD drives). Do NOT add Playwright in v1 unless LEAD asks. |
| Tests co-locate as `*.test.js` next to source | `src/api/*.test.js`, `api/*.test.js` | Desk unit tests live beside their module: `public/app/js/.../<mod>.test.js`. `npm test` = `vitest run` already globs them. |
| Routes decode `req.query.doctype` / `req.query.name` and pass `req.body`/`req.query` straight to `handle()` | `api/[doctype]/index.js`, `api/[doctype]/[name].js` | Doctype + name go in the **URL path** (URL-encode them). Body is the **flat record**. Query carries `f_*`/`limit`/`offset`/`order`/`order_by`. |
| GIS client id | ADR §4.2 | `54203725419-2ad869ea9p81lcmf6osm5htos0maoepl.apps.googleusercontent.com` — pin verbatim in U3. |

**Hard rule (N5/N7):** the idToken is ONLY ever an `Authorization: Bearer` header. NEVER log it, NEVER place it in a URL/query string, NEVER pass it into a DOM attribute.

---

## 1. The envelope contract (FROZEN — verified against source, do not diverge)

Pinned against `src/api/handler.js:37-94` + `src/validation/request-schemas.js` + the route files. Every `implement` unit treats this as immutable:

| Op | Method + URL | Body / query |
|---|---|---|
| boot | `GET /api/boot` | — → `{user, roles, scopes, doctypes[], server_date}` |
| meta | `GET /api/meta/<dt>` | — → `{doctype, capabilities{read,write,create,delete,submit,cancel}, meta{...,fields[],childTables[]}, child_metas{<childDt>:meta}, workflow{stateField,states,transitions[]}\|null}` |
| list | `GET /api/<dt>` | query: `limit`, `offset`, `order` (`asc`\|`desc`), `order_by`, filters `f_<field>=<value>` |
| get | `GET /api/<dt>/<name>` | — |
| create | `POST /api/<dt>` | **flat record** `{title, branch, …}` — NO `{data:…}` wrapper |
| update | `POST /api/<dt>/<name>` | **flat patch** `{<changed fields>}` |
| action | `POST /api/<dt>/<name>` | `{ "action": "<transition\|submit\|cancel>" }` (+ may carry other keys; engine ignores patch on action) |

Invariants every unit honours:
1. **Reserved keys `owner`, `docstatus`, `name`, `is_stub` are NEVER sent** in any body (engine rejects → 400). The document `name` lives in the URL only.
2. **action vs update disambiguated by presence of `body.action`** — same URL `POST /api/<dt>/<name>`; only the body differs (`handler.js:44,48,50`).
3. **`submit`/`cancel` are just actions** (`{action:'submit'}` / `{action:'cancel'}`); any other action string is a declarative transition.
4. **list ordering needs `order_by`** — `order=desc` alone is a no-op (`handler.js:88`, N2). Always send `order_by` to order.
5. **error→status**: 401 AuthError · 403 PermissionError · 404 NotFoundError · 409 StateError · 400 ValidationError · 500 else. Body `{error, type}`. (`handler.js:14-21`.)

---

## 2. UNITS — frozen interfaces, dependencies, tests, done-criteria

Each unit = one file (one `implement` specialist). Interfaces below are **FROZEN**; specialists must not change signatures. All paths under `C:\Users\parrg\Documents\spartan-erp-engine\`.

---

### U1 — ApiClient (foundational, egress seam)
- **File:** `public/app/js/api/client.js`
- **Exports (FROZEN):**
  ```js
  export class ApiError extends Error { constructor(message, {status, type, body}) ; status; type; body; }
  export class ForbiddenError extends ApiError {}   // 403
  export class NotFoundError  extends ApiError {}   // 404
  // factory takes injected deps so it is unit-testable without DOM/network:
  //   getToken: () => string|null        (Session.getToken)
  //   onAuthExpired: () => Promise<void>  (Session.reauth — resolves when a fresh token is available)
  //   fetchImpl: typeof fetch             (default globalThis.fetch; tests inject a mock)
  export function createApiClient({ getToken, onAuthExpired, fetchImpl = globalThis.fetch });
  // returned object (FROZEN method set):
  //   boot(): Promise<BootObj>
  //   meta(dt): Promise<MetaBundle>
  //   list(dt, { limit, offset, order, order_by, filters } = {}): Promise<Row[]>
  //   get(dt, name): Promise<Doc>
  //   create(dt, record): Promise<Doc>
  //   update(dt, name, patch): Promise<Doc>
  //   action(dt, name, action): Promise<Doc>        // POST {action}
  //   submit(dt, name): Promise<Doc>                // = action(dt,name,'submit')
  //   cancel(dt, name): Promise<Doc>                // = action(dt,name,'cancel')
  ```
- **Dependencies:** none on other Desk units (Session injected as `getToken`/`onAuthExpired`). Pure + network only.
- **Behaviour (done-criteria):**
  - DC1 Builds the **exact** envelope per §1: `create`→`POST /api/<encodeURIComponent(dt)>` flat body; `update`→`POST /api/<dt>/<encodeURIComponent(name)>` flat body; `action`→same URL, body `{action}`; `list`→`GET /api/<dt>?limit=&offset=&order=&order_by=&f_<k>=<v>` (only sets `order` params when `order_by` present — **N2**).
  - DC2 Attaches `Authorization: Bearer <getToken()>` on every call. **Never** logs the token or puts it in the URL/query — **N5** (test asserts the token never appears in the constructed URL).
  - DC3 **Never** includes reserved keys `owner/docstatus/name/is_stub` in any body — strips them defensively before send (invariant 1). `name` is only ever URL-encoded into the path.
  - DC4 Error mapping (invariant 5): non-2xx → parse `{error,type}` → throw typed error. 401 → call `onAuthExpired()` then **retry the request once**; if the retry is still 401 → throw `ApiError(401)`. 403 → `ForbiddenError`. 404 → `NotFoundError`. 400/409 → `ApiError` carrying `{error,type}` verbatim (so the form/guard UI surfaces the engine message as-is).
  - DC5 401 re-auth retry is **bounded** — it awaits `onAuthExpired()` (which Session time-boxes, U3/N4); ApiClient itself does not loop more than the single retry.
- **vitest:** `public/app/js/api/client.test.js`. Inject a **mock `fetchImpl`** + stub `getToken`/`onAuthExpired`. **Key assertions:**
  - create/update/action/list each produce the exact `(url, {method, headers, body})` — assert URL string, method, `Authorization` header value, and `JSON.parse(body)` shape.
  - list with `{filters:{branch:'VIC'}, order_by:'modified', order:'desc', limit:50}` → URL contains `f_branch=VIC&limit=50&order_by=modified&order=desc`; list with no `order_by` → URL has **no** `order`/`order_by`.
  - create with a record containing `name`/`owner` → those keys are stripped from the sent body; `name` only in URL for update/action.
  - mock 401 once then 200 → exactly one `onAuthExpired()` call + one retry → resolves. mock 401 twice → throws `ApiError` with `status===401`. 403→`ForbiddenError`, 404→`NotFoundError`, 409→`ApiError` with `.body.error` === the engine message verbatim.
  - assert the token string never appears in any URL passed to `fetchImpl`.

---

### U2 — MetaCache (foundational)
- **File:** `public/app/js/meta/cache.js`
- **Exports (FROZEN):**
  ```js
  export function createMetaCache(apiClient);
  //   meta(dt): Promise<MetaBundle>   // memoized per dt for the session
  //   peek(dt): MetaBundle|undefined  // sync, no fetch
  //   clear(): void
  ```
- **Dependencies:** U1 (ApiClient injected).
- **Done-criteria:**
  - DC1 First `meta(dt)` calls `apiClient.meta(dt)`; subsequent calls for the same `dt` return the cached bundle without a second fetch (memoize the resolved promise, so concurrent callers share one in-flight fetch).
  - DC2 A rejected fetch is **not** cached (next `meta(dt)` retries).
  - DC3 **C3 / issingle:** if `bundle.meta.issingle === true`, `meta(dt)` still returns the bundle (caching is doctype-agnostic), but the **router/sidebar must not route Singles to ListView** — see U9. MetaCache itself stays generic; the issingle gate lives in routing.
- **vitest:** `public/app/js/meta/cache.test.js` with a stub apiClient counting calls. Assert one fetch for two `meta(dt)` calls; assert a rejection isn't memoized.

---

### U3 — Session + SignInGate (auth, foundational)
- **File:** `public/app/js/auth/session.js`
- **Exports (FROZEN):**
  ```js
  export function createSession({ clientId, gis = globalThis.google, storage = globalThis.sessionStorage });
  //   getToken(): string|null
  //   reauth(): Promise<void>     // bounded: silent google.accounts.id.prompt() then SignInGate; resolves when a fresh token is set, OR rejects/blocks per DC
  //   onSignedIn(cb): void        // fires with the credential after sign-in
  //   renderGate(mountEl): void   // SignInGate — renders GIS button, blocks the app until signed in
  //   signOut(): void
  ```
- **Dependencies:** none on other Desk units. GIS injected (testable seam) but the GIS-driven DOM path is verified by the live proof, not vitest.
- **Done-criteria:**
  - DC1 Loads GIS, renders the button with `clientId` = `54203725419-2ad869ea9p81lcmf6osm5htos0maoepl.apps.googleusercontent.com` (verbatim).
  - DC2 On credential, stores the idToken in a **module-scope variable** mirrored to `sessionStorage` (key e.g. `desk.idToken`); on construct, **rehydrates** from `sessionStorage` so a tab refresh does not force re-sign-in (F2). **localStorage is NOT used.**
  - DC3 `reauth()` is **bounded (N3/N4)**: attempt a silent `google.accounts.id.prompt()`; if no credential arrives within a fixed timeout (e.g. **3 s**), fall back to `renderGate()` (full SignInGate). **It MUST resolve or reject within the timeout — never hang** (prevents the white-screen the brief warns about).
  - DC4 **N5/N7:** never logs the token, never puts it in a URL. The only consumer of the raw token is `ApiClient` via `getToken()`.
  - DC5 Signed-out state ⇒ `getToken()` returns `null` and the app shows the SignInGate (U9 wires the gate before any view renders).
- **vitest:** `public/app/js/auth/session.test.js` — test the **token-store + bound-timeout logic only** (inject a fake `gis` whose `prompt` never calls back → assert `reauth()` rejects/falls back within the timeout; inject `storage` to assert rehydrate + that the token is never passed to a logger/URL). Do NOT test GIS DOM rendering in vitest.

---

### U4 — WidgetRegistry + simple widgets (render layer)
- **File:** `public/app/js/widgets/registry.js`
- **Exports (FROZEN):**
  ```js
  // pure mapping (the part vitest covers):
  export function widgetFor(fieldDef);  // → a widget key string: 'data'|'textarea'|'number'|'check'|'date'|'datetime'|'select'|'link'|'table'
  // factory map (DOM): fieldtype -> (fieldDef, value, { readOnly, onChange }) -> HTMLElement
  export const WidgetRegistry;          // { register(fieldtype, factory), create(fieldDef, value, opts): HTMLElement, has(fieldtype) }
  export function normalizeSelectOptions(options); // array OR '\n'-delimited string -> string[]
  ```
- **Dependencies:** U6 LinkPicker + U7 ChildGrid are **registered into** WidgetRegistry by the assembling code (U9) — registry knows the keys but does not import those widgets (OCP: open to registration, closed to edits). So U4 itself depends on nothing.
- **Fieldtype → widget (FROZEN, ADR §4.6):** `Data`→text · `Text`,`Code`→textarea · `Int`,`Float`,`Currency`→number · `Check`→checkbox · `Date`→date · `Datetime`→datetime-local · `Select`→select (options via `normalizeSelectOptions`) · `Link`→`'link'` (LinkPicker) · `Table`→`'table'` (ChildGrid).
- **Done-criteria:**
  - DC1 `widgetFor` returns the correct key for every fieldtype above; unknown fieldtype → `'data'` (safe text fallback, fail-soft).
  - DC2 `normalizeSelectOptions` handles both `['A','B']` and `"A\nB"` → `['A','B']`; trims blanks.
  - DC3 `readOnly:true` (or `fieldDef.readOnly`/`read_only`) ⇒ widget renders **display-only** even in edit mode (DOM behaviour — covered by live proof).
  - DC4 Registry `create` is generic — **no doctype name appears anywhere** (Least-Privilege / meta-driven invariant).
- **vitest:** `public/app/js/widgets/registry.test.js` — **pure** assertions on `widgetFor` (every fieldtype row) and `normalizeSelectOptions` (array + `\n`-string + blank-trim). DOM `create` output verified by live proof.

---

### U5 — ListView (render layer)
- **File:** `public/app/js/views/list-view.js`
- **Exports (FROZEN):** `export function renderListView({ dt, metaCache, apiClient, mountEl, navigate });`
- **Dependencies:** U1, U2, U9 router `navigate`.
- **Done-criteria:**
  - DC1 Fetches `metaCache.meta(dt)`; chooses display columns from **`meta.fields`** — first ~5 non-`Table` fields, honouring `idx`/order (do NOT read child tables here).
  - DC2 Fetches rows via `apiClient.list(dt, { order_by:<a sensible sort field, e.g. 'modified' if present else first column>, order:'desc', limit:<page, e.g. 50> })` — **always passes `order_by`** so ordering takes effect (**N2**).
  - DC3 Row click → `navigate('#/' + dt + '/' + encodeURIComponent(row.name))`.
  - DC4 "New" button shown **iff** `bundle.capabilities.create`; click → `navigate('#/' + dt + '/new')`.
  - DC5 **C3 / issingle:** `renderListView` must **never** be reached for an `issingle` doctype — the router (U9) routes Singles away and the sidebar (U9) does not emit a list link for them. If somehow invoked on a Single, render a one-line "Single doctype — no list view (v1)" notice rather than fetching a collection. (State this; the real gate is in U9.)
  - DC6 On `ForbiddenError`/`NotFoundError` from list, render the typed error inline (not a whiteout).
- **vitest:** none required (pure column-pick heuristic MAY be factored to a tiny exported `pickListColumns(fields)` and unit-tested; otherwise covered by live proof). If factored, test `pickListColumns` returns ≤5 non-Table fields in idx order.

---

### U6 — LinkPicker (render layer)
- **File:** `public/app/js/widgets/link-picker.js`
- **Exports (FROZEN):** `export function createLinkPicker({ apiClient, metaCache }); // (fieldDef, value, opts) -> HTMLElement` (registered into WidgetRegistry under key `'link'`).
- **Dependencies:** U1, U2, U4.
- **Done-criteria (C4 — pin both edges):**
  - DC1 Target doctype = `fieldDef.options`. On open, fetch the target list **capped at the first N = 50** ordered by `name` (`apiClient.list(target, { order_by:'name', order:'asc', limit:50 })`). Typeahead is a **client-side filter over that page** (F5). **UX caveat surfaced:** a target with >50 rows shows only the first 50 — accepted for v1, F5 escalated to `diagnose` (engine `f_*` is equality-only, can't do "contains").
  - DC2 User picks a row → the widget stores the linked doc's **`name`** as the value.
  - DC3 **403-on-target degrade (C4b):** if `apiClient.meta(target)` OR `apiClient.list(target)` throws `ForbiddenError` (user may read the parent but not the Link target — `desk-bridge.js:129`), the widget **degrades to a plain text input storing the raw name** — it MUST NOT throw or whiteout the form. NotFoundError on target → same plain-text degrade.
  - DC4 No doctype name hard-coded — target comes only from `fieldDef.options`.
- **vitest:** `public/app/js/widgets/link-picker.test.js` — if the fetch+filter+degrade decision is factored into a pure helper (recommended: `async function loadLinkOptions(apiClient, target)` returning `{ mode:'list', rows }` or `{ mode:'text' }` on 403/404), unit-test: 200 list → `mode:'list'` with rows capped at 50; `ForbiddenError`→`mode:'text'`; `NotFoundError`→`mode:'text'`. DOM typeahead verified by live proof.

---

### U7 — ChildGrid (render layer — heaviest; C1/C2 critical)
- **File:** `public/app/js/widgets/child-grid.js`
- **Exports (FROZEN):**
  ```js
  export function createChildGrid({ metaCache, widgetRegistry }); // (childTableDef, rows, opts) -> { el: HTMLElement, collect(): object[] }
  // pure collect helper (the part vitest MUST cover):
  export function collectChildRows(gridState); // -> array of plain row records
  ```
  Registered into WidgetRegistry under key `'table'`. FormView (U8) drives collection — see C1.
- **Dependencies:** U2, U4.
- **Done-criteria (C1 + C2 are the load-bearing fixes — state explicitly):**
  - DC1 **C2 — render from `meta.childTables`, NOT from a `Table` entry in `meta.fields`.** FormView (U8) iterates `bundle.meta.childTables` (authoritative) to decide which child grids to render. ChildGrid is given the `childTableDef = { field, doctype, table }`.
  - DC2 **C1 (collect key) — column meta is looked up under the child DOCTYPE; rows are collected under the parent FIELD name.** Columns come from `metaCache.peek/meta(childTableDef.doctype).fields` (i.e. `child_metas[childTableDef.doctype]` on the parent bundle — `desk-bridge.js:153` keys by `c.doctype`). When FormView assembles the submit record, it embeds the row array under **`childTableDef.field`** (the parent fieldname — `registry.js` `ChildTableDef.field`), **NOT** under `childTableDef.doctype`. **collect-key = `field`; meta-lookup-key = `doctype`.** (Following the ADR text literally — both as the parent fieldname — drops/rejects the rows; this DC is the correction.)
  - DC3 Rows are add/remove editable; each cell reuses `WidgetRegistry.create` for the child field's fieldtype. Reserved keys are never collected into a child row (children also flow through the engine record).
  - DC4 No doctype name hard-coded — both keys come from the `childTableDef`.
- **vitest:** `public/app/js/widgets/child-grid.test.js` — **pure** test of `collectChildRows` and the FormView embed contract: given a `childTableDef = {field:'items', doctype:'Quote Item', table:'tabQuote Item'}` and two staged rows, assert the produced record fragment is `{ items: [ {...}, {...} ] }` (keyed by **`field`**, not `'Quote Item'`), and assert column meta is requested for **`'Quote Item'`** (the doctype). This test is the guard against the C1 bug.

---

### U8 — FormView (render layer)
- **File:** `public/app/js/views/form-view.js`
- **Exports (FROZEN):**
  ```js
  export function renderFormView({ dt, name, mode, metaCache, apiClient, widgetRegistry, workflowBar, mountEl, navigate });
  // mode: 'view' | 'edit' | 'create'
  ```
- **Dependencies:** U1, U2, U4, U7 (child grids), U9 (`navigate`), U10 (WorkflowBar mounted into the form).
- **Done-criteria:**
  - DC1 `create` mode → blank form from `meta.fields`; `view`/`edit` → `apiClient.get(dt,name)` then one widget per field via `WidgetRegistry`.
  - DC2 **C2:** render scalar/Link widgets from `meta.fields`; render child grids by iterating `meta.childTables` (authoritative) — one `ChildGrid` per entry.
  - DC3 **Collect (C1):** build the submit record = scalar field values keyed by fieldname **+** each child grid's rows keyed by **`childTableDef.field`**. Strip reserved keys. Call `apiClient.create(dt, record)` (create) or `apiClient.update(dt, name, patch)` (edit).
  - DC4 On **400 ValidationError**, map the engine's issue paths → per-field inline messages (surface the engine `error` text). On **409 StateError** from a save, surface verbatim.
  - DC5 Mounts `WorkflowBar` (U10) at the top/bottom of the form in `view` mode (transitions act on the persisted doc).
  - DC6 Read-only fields (`readOnly`/`read_only`) render display-only even in edit mode.
- **vitest:** none mandatory (DOM-heavy); the collect contract is already guarded by U7's `collectChildRows` test + U1's create/update envelope test. If the record assembler is factored to a pure `buildSubmitRecord(fields, scalarValues, childGrids)`, unit-test it embeds children under `field` and strips reserved keys.

---

### U9 — Shell: Router + Workspace + App.start (assembly)
- **Files:** `public/app/js/shell/router.js` + `public/app/js/main.js` + `public/app/index.html` + `public/app/css/desk.css`
- **Exports (FROZEN):**
  ```js
  // router.js
  export function createRouter({ onRoute }); // parses hash → { dt, name, mode }; navigate(hash); start()
  // main.js
  export function start();  // wires Session→ApiClient→MetaCache→WidgetRegistry(+Link+Child)→Router→views; renders SignInGate first
  ```
- **Dependencies:** ALL of U1–U8, U10. This is the integrator.
- **Done-criteria:**
  - DC1 Hash routes (F1): `#/<dt>` → ListView; `#/<dt>/new` → FormView(create); `#/<dt>/<name>` → FormView(view). Deep link / refresh never 404s. **No `vercel.json` rewrite added.**
  - DC2 Builds the workspace sidebar from `boot.doctypes` (the only doctype names the Desk ever knows). **C3:** for each doctype, fetch/peek meta; **`issingle` doctypes are excluded from the v1 sidebar/list routing** (out of scope, F-resolution) — render nothing for them, or a disabled "Single (v1: no UI)" entry. They are NOT routed to ListView.
  - DC3 **SignInGate first:** if `Session.getToken()` is null, render the gate (U3) and block all views until signed in. Wires `ApiClient.onAuthExpired = Session.reauth` (bounded, N4).
  - DC4 Registers `LinkPicker` (U6) under `'link'` and `ChildGrid` (U7) under `'table'` into `WidgetRegistry` (U4) at startup — keeping U4 free of those imports (OCP).
  - DC5 `index.html` loads `main.js` as `<script type="module">` + the GIS `<script src="https://accounts.google.com/gsi/client" async defer>`; links `css/desk.css`. **Does not modify `public/index.html`.**
  - DC6 `desk.css` = minimal utilitarian CSS (F6) — no framework.
- **vitest:** `public/app/js/shell/router.test.js` — **pure** hash-parse: `#/Job` → `{dt:'Job', name:null, mode:'list'}`; `#/Job/new` → `{mode:'create'}`; `#/Job/JOB-0001` → `{dt:'Job', name:'JOB-0001', mode:'view'}`; URL-encoded names round-trip. `navigate` sets `location.hash`. DOM wiring in `main.js` verified by live proof.

---

### U10 — WorkflowBar (render layer)
- **File:** `public/app/js/workflow/bar.js`
- **Exports (FROZEN):**
  ```js
  // pure filter (vitest MUST cover):
  export function fireableTransitions(workflow, currentState, userRoles); // -> transitions[]
  // DOM:
  export function renderWorkflowBar({ dt, name, doc, metaBundle, boot, apiClient, mountEl, onChanged });
  ```
- **Dependencies:** U1; reads `metaBundle.workflow` + `metaBundle.capabilities` + `boot.roles`.
- **Done-criteria (N1 is load-bearing):**
  - DC1 `fireableTransitions` returns only transitions where `t.from === currentState` **AND** (`t.roles === undefined` **OR** `t.roles` intersects `userRoles`). **N1:** `roles === undefined` means **open to all** — do NOT treat undefined as "no one". (Matches `desk-bridge.js:165` passing `t.roles` straight through.)
  - DC2 Current state read from `doc[workflow.stateField]` (N1).
  - DC3 A transition button click → `apiClient.action(dt, name, t.action)` then `onChanged()` (re-render form with the new doc).
  - DC4 `submit`/`cancel` buttons additionally gated by `capabilities.submit`/`cancel` (cosmetic, N2) — the engine re-checks regardless.
  - DC5 **409 StateError on action ⇒ surface the engine's `error` message inline VERBATIM** (e.g. the Job 5%-deposit gate text). This guard text IS the UX. (`ApiClient` already carries `{error,type}` on the 409 `ApiError` — U1 DC4.)
  - DC6 No transitions for the current state ⇒ render nothing (no empty bar clutter).
- **vitest:** `public/app/js/workflow/bar.test.js` — **pure** `fireableTransitions`:
  - state `Open`, transitions `[{from:'Open',to:'Won',action:'win',roles:['sales']}]`, roles `['sales']` → returns it; roles `['ops']` → empty.
  - `roles:undefined` transition → returned for ANY roles (incl. `[]`) — the **N1 guard**.
  - transition whose `from` ≠ currentState → excluded.

---

## 3. Dependency order / parallelisable groups

```
GROUP A (foundational — build FIRST, fully parallel; no inter-deps):
  U1 ApiClient      U3 Session/SignInGate      U4 WidgetRegistry
        │
GROUP B (depends on A; parallel within the group):
  U2 MetaCache  (needs U1)
  U10 WorkflowBar (needs U1)     ← can also start in A (only U1 dep)
        │
GROUP C (render views/widgets — parallel within the group):
  U5 ListView    (U1,U2)
  U6 LinkPicker  (U1,U2,U4)
  U7 ChildGrid   (U2,U4)
  U8 FormView    (U1,U2,U4,U7,U10)   ← needs U7+U10 → start U8 after U7/U10 land
        │
GROUP D (assembly — LAST, single owner):
  U9 Shell/Router/main.js/index.html/css  (integrates U1–U8,U10)
```

**Practical fan-out:** Wave 1 = U1, U3, U4, U10 (4 parallel). Wave 2 = U2, U5, U6, U7 (4 parallel; U5 tolerates a stubbed MetaCache during dev but lands after U2). Wave 3 = U8 (after U7). Wave 4 = U9 (assembly, serialized).

---

## 4. Assembly + integration-test sequence

1. After Group A+B+C land: run `npm test` (`vitest run`) — all pure-logic unit tests green (U1, U2, U3-token, U4, U6-helper, U7-collect, U9-router, U10-filter).
2. U9 assembles `main.js` + `index.html`; wires Session→ApiClient(onAuthExpired=reauth)→MetaCache→WidgetRegistry(register link+table)→Router.
3. **LIVE-PROOF acceptance (manual — Playwright NOT installed; LEAD drives):**
   - a. `vercel dev` (or deployed `/app`); open `/app`.
   - b. **Sign in** with Google → SignInGate clears; sidebar populates from `boot.doctypes`.
   - c. Open **Job** → generic FormView renders from meta (no Job-specific code).
   - d. With deposit at 0%, click **`start_measure`** (or the relevant transition) → **the engine's 5%-deposit GATE 409 message is shown inline VERBATIM** (the headline demo — proves WorkflowBar + 409 surfacing).
   - e. Set deposit ≥5%, save → advance the transition succeeds (state moves).
   - f. **Scalar round-trip:** create a simple scalar doctype (e.g. Customer) → fill fields → save → reopen → values persisted; edit one field → save → persisted (proves ApiClient create/update envelope end-to-end).
   - g. **ChildGrid round-trip:** on a doctype with a child table, add a row → save → reopen → child row persisted (proves C1 collect-key=`field`).
4. Full suite green + the 7 live-proof steps pass ⇒ Desk v1 accepted.

> If LEAD wants the live proof automated later, add Playwright as a devDep then (`scripts\` spec, navigate-to-known-start-state per CLAUDE.md §4). NOT in v1.

---

## 5. File-collision map (parallel-safe vs serialize)

| File | Unit(s) | Collision risk |
|---|---|---|
| `public/app/js/api/client.js` | U1 | none (sole owner) |
| `public/app/js/meta/cache.js` | U2 | none |
| `public/app/js/auth/session.js` | U3 | none |
| `public/app/js/widgets/registry.js` | U4 | none |
| `public/app/js/views/list-view.js` | U5 | none |
| `public/app/js/widgets/link-picker.js` | U6 | none |
| `public/app/js/widgets/child-grid.js` | U7 | none |
| `public/app/js/views/form-view.js` | U8 | none |
| `public/app/js/workflow/bar.js` | U10 | none |
| `public/app/js/shell/router.js` | U9 | none |
| **`public/app/js/main.js`** | U9 | **single owner (U9)** — integrates everyone; do NOT let other units write it |
| **`public/app/index.html`** | U9 | **single owner (U9)** — serialize; co-touched only by U9 |
| `public/app/css/desk.css` | U9 (+ U4/U5/U6/U7/U8 may want classes) | **U9 owns the file**; other units must use class names but NOT edit `desk.css` — they hand U9 the classes they need, or U9 ships a flat utility set. Serialize CSS edits through U9. |
| `public/index.html` (engine landing) | **NONE** | **must not be touched by any unit** |
| `vercel.json` | NONE (recommend not creating) | if created, NO global rewrite (N7) |

**Parallel-safe:** every `js/` module file has a single owner — Groups A/B/C fan out cleanly. **Serialize:** `main.js`, `index.html`, `desk.css` — all owned by U9 (assembly). Every unit's `*.test.js` is owned by that unit (no collision).

---

## 6. Composition go/no-go — **GO**

- **Interfaces line up:** ApiClient is the sole egress; MetaCache wraps it; Session injects `getToken`/`onAuthExpired` into ApiClient (no circular import — Session depends on nothing, ApiClient receives Session's methods as params). Views/widgets depend only on ApiClient/MetaCache/WidgetRegistry. WidgetRegistry stays free of LinkPicker/ChildGrid imports (they self-register at U9 startup — OCP).
- **No cycles:** A → B → C → D is a DAG. The only would-be cycle (WidgetRegistry needing LinkPicker/ChildGrid) is broken by registration-at-startup (U9), not import.
- **Contract-compliant:** every envelope detail is pinned to verified source (§1); the four critique bugs are folded into concrete done-criteria — C1 (U7 DC2 + U8 DC3, with a vitest guard), C2 (U7 DC1 + U8 DC2), C3 (U2 DC3 + U5 DC5 + U9 DC2, scoped OUT for v1), C4 (U6 DC1 cap + DC3 degrade). Notes N1 (U10 DC1), N2 (U1 DC1 + U5 DC2), N3/N4 (U3 DC3 + U1 DC5), N5/N7 (U1 DC2 + U3 DC4 + §0 + §5).
- **Testability holds without new deps:** all critical logic is factored DOM-free and tested in node-vitest with mocked fetch; DOM/GIS rendering deferred to the manual live proof — no jsdom, no Playwright added (respects no-build/minimal-dep).
- **Buildability:** every unit is one file + one test file, single-owner, fan-out-able in 4 waves.

**Verdict: GO.** Release to BUILD.

---

## 7. Planning notes / lessons (for `lessons_learned`)
- The ADR's `public/app/` assumption checked out (landing page at `public/index.html`, no `vercel.json`) — but jsdom + Playwright are BOTH absent, which reshapes the test plan: the unit layer MUST be pure-logic + mocked-fetch, and the DOM/GIS proof is manual. Future Desk-style work orders should factor view logic into pure helpers (`pickListColumns`, `loadLinkOptions`, `buildSubmitRecord`, `collectChildRows`, `fireableTransitions`) precisely so node-vitest can guard the contract without a DOM env.
- C1 is the one bug that would silently ship: ADR text said both keys = parent fieldname; source (`desk-bridge.js:153` keys `child_metas` by `c.doctype`; `registry.js` `ChildTableDef.field` is the parent fieldname) proves collect-key=`field`, meta-key=`doctype`. The U7 `collectChildRows` vitest is the regression guard — do not let it be cut.
