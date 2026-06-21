// main.js — Desk UI entry point (U9 assembly)
// Wires: Session → ApiClient → MetaCache → WidgetRegistry → Router → views.
// Pure frontend; no engine src/ import.
//
// Frozen interface:
//   export function start()
//
// DC3: SignInGate FIRST — if Session.getToken() === null, render the gate and
//      block all views until signed in.
// DC4: Register createLinkPicker under 'link' and createChildGrid under 'table'
//      into WidgetRegistry at startup (OCP — U4 stays free of those imports).
// DC2: C3 — issingle doctypes excluded from sidebar/list routing.
// Boot note: boot.roles must flow into renderFormView → renderWorkflowBar.

import { createSession }      from './auth/session.js';
import { createApiClient }    from './api/client.js';
import { createMetaCache }    from './meta/cache.js';
import { WidgetRegistry }     from './widgets/registry.js';
import { createLinkPicker }   from './widgets/link-picker.js';
import { createChildGrid }    from './widgets/child-grid.js';
import { renderListView }     from './views/list-view.js';
import { renderFormView }     from './views/form-view.js';
import { renderWorkflowBar }  from './workflow/bar.js';
import { createRouter }       from './shell/router.js';

// GIS client id (DC1 of U3 — pinned verbatim per §0)
const GIS_CLIENT_ID =
  '54203725419-2ad869ea9p81lcmf6osm5htos0maoepl.apps.googleusercontent.com';

/**
 * start() — boot the Desk UI.
 * Called from public/app/index.html <script type="module">.
 */
export function start() {
  // Mount roots — must exist in index.html
  const sidebarEl = document.getElementById('desk-sidebar');
  const viewEl    = document.getElementById('desk-view');
  const gateEl    = document.getElementById('desk-gate');
  const appEl     = document.getElementById('desk-app');

  // The gate and the app are BOTH full-height (100vh) blocks in normal flow, so exactly
  // ONE must be shown. (Bug: the gate was only emptied, not hidden, after sign-in — its
  // empty 100vh white block then covered the viewport while the app sat below the fold.)
  const _showGate = () => { if (appEl)  appEl.style.display  = 'none'; if (gateEl) gateEl.style.display = ''; };
  const _showApp  = () => { if (gateEl) gateEl.style.display = 'none'; if (appEl)  appEl.style.display  = ''; };

  // ------------------------------------------------------------------
  // 1. Session (U3)
  // ------------------------------------------------------------------
  const session = createSession({ clientId: GIS_CLIENT_ID });

  // ------------------------------------------------------------------
  // 2. ApiClient (U1) — injects Session's token + reauth
  // ------------------------------------------------------------------
  const apiClient = createApiClient({
    getToken:       () => session.getToken(),
    onAuthExpired:  () => session.reauth(),
  });

  // ------------------------------------------------------------------
  // 3. MetaCache (U2)
  // ------------------------------------------------------------------
  const metaCache = createMetaCache(apiClient);

  // ------------------------------------------------------------------
  // 4. WidgetRegistry — register Link + ChildGrid factories (DC4 / OCP)
  // ------------------------------------------------------------------
  const linkPickerFactory = createLinkPicker({ apiClient, metaCache });
  WidgetRegistry.register('link', linkPickerFactory);

  const childGridFactory = createChildGrid({ metaCache, widgetRegistry: WidgetRegistry });
  WidgetRegistry.register('table', childGridFactory);

  // ------------------------------------------------------------------
  // Helper: clear the view mount and render into it.
  // boot is captured in the router callback closure once boot() resolves.
  // ------------------------------------------------------------------
  let _boot = null;

  function navigate(hash) {
    router.navigate(hash);
  }

  // ------------------------------------------------------------------
  // 5. Router (U9)
  // ------------------------------------------------------------------
  const router = createRouter({
    onRoute({ dt, name, mode }) {
      viewEl.innerHTML = '';

      if (mode === 'list') {
        renderListView({ dt, metaCache, apiClient, mountEl: viewEl, navigate });
      } else {
        // mode 'view' or 'create'.
        // WorkflowBar needs boot.roles to gate transitions. The frozen renderFormView
        // interface has no `boot` param (U8 note); wire it via a closure wrapper so
        // FormView's call to workflowBar() receives the live _boot value.
        const workflowBarWithBoot = (opts) =>
          renderWorkflowBar({ ...opts, boot: _boot });

        renderFormView({
          dt,
          name,
          mode,
          metaCache,
          apiClient,
          widgetRegistry: WidgetRegistry,
          workflowBar:    workflowBarWithBoot,
          mountEl:        viewEl,
          navigate,
        });
      }
    },
  });

  // ------------------------------------------------------------------
  // 6. Boot + SignInGate + sidebar (DC3 SignInGate first)
  // ------------------------------------------------------------------
  function _buildSidebar(boot) {
    sidebarEl.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'desk-sidebar-heading';
    heading.textContent = 'Desk';
    sidebarEl.appendChild(heading);

    const nav = document.createElement('nav');
    nav.className = 'desk-sidebar-nav';
    sidebarEl.appendChild(nav);

    // DC2 / C3: fetch meta for each doctype; skip issingle
    for (const dt of boot.doctypes) {
      // Speculatively fetch meta so the cache is warm; skip Singles.
      metaCache.meta(dt).then((bundle) => {
        // C3: issingle — excluded from v1 sidebar/list routing
        const meta = bundle && (bundle.meta || bundle);
        if (meta && meta.issingle) {
          // Render nothing for Singles in v1
          return;
        }

        const a = document.createElement('a');
        a.className = 'desk-sidebar-link';
        a.href = '#/' + encodeURIComponent(dt);
        a.textContent = dt;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          navigate('#/' + encodeURIComponent(dt));
        });
        nav.appendChild(a);
      }).catch(() => {
        // If meta fails we just skip the doctype in the sidebar.
      });
    }

    // Sign-out link
    const signOutBtn = document.createElement('button');
    signOutBtn.className = 'desk-signout-btn';
    signOutBtn.textContent = 'Sign out';
    signOutBtn.addEventListener('click', () => {
      session.signOut();
      // Hard reset to a clean signed-out state (re-runs start() → gate shows).
      location.reload();
    });
    sidebarEl.appendChild(signOutBtn);
  }

  function _afterSignIn() {
    // Boot the engine to get doctypes + roles
    apiClient.boot().then((boot) => {
      _boot = boot;
      _buildSidebar(boot);
      // Start the router once we have the doctype list
      router.start();
    }).catch((err) => {
      viewEl.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'desk-error';
      p.textContent = `Boot failed: ${err.message}`;
      viewEl.appendChild(p);
    });
  }

  // DC3: SignInGate — check token before any view renders
  if (!session.getToken()) {
    _showGate();
    session.renderGate(gateEl);
    // Once signed in, hide the gate and show the app.
    session.onSignedIn(() => {
      _showApp();
      _afterSignIn();
    });
  } else {
    _showApp();
    _afterSignIn();
  }
}

// Auto-start when this module is the entry point (index.html loads it directly)
start();
