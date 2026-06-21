/**
 * U3 — Session + SignInGate
 *
 * createSession({ clientId, gis, storage }) → { getToken, reauth, onSignedIn, renderGate, signOut }
 *
 * Token safety rule (N5/N7): the idToken is ONLY ever returned via getToken() for use as
 * Authorization: Bearer. It is never logged, never placed in a URL, never written to a
 * DOM attribute. The module-scope variable is the sole owner; sessionStorage is the mirror.
 *
 * Storage note (F2): sessionStorage ONLY — localStorage is never used.
 */

const STORAGE_KEY = 'desk.idToken';
const REAUTH_TIMEOUT_MS = 3000;

/**
 * @param {{ clientId: string, gis?: object, storage?: Storage }} opts
 * @returns {{ getToken(): string|null, reauth(): Promise<void>, onSignedIn(cb: Function): void, renderGate(mountEl: Element): void, signOut(): void }}
 */
export function createSession({
  clientId,
  gis,
  storage = globalThis.sessionStorage,
} = {}) {
  // The GSI script is async/defer, so globalThis.google may not exist yet when
  // createSession() runs (during start()). Resolve GIS LAZILY at every use — the old
  // `gis = globalThis.google` default froze it as undefined and the sign-in button
  // silently never rendered (white screen). Tests inject `gis` (override wins).
  const resolveGis = () => gis || globalThis.google;

  // Module-scope token owner — the ONLY place the raw string lives.
  let _token = null;
  const _listeners = [];

  // DC2 — rehydrate from sessionStorage on construct (tab-refresh resilience).
  // Guarded: storage may not be available in test environments unless injected.
  if (storage) {
    const stored = storage.getItem(STORAGE_KEY);
    if (stored) {
      _token = stored;
    }
  }

  /** Persist a new credential (idToken string). */
  function _setToken(idToken) {
    _token = idToken;
    if (storage) {
      storage.setItem(STORAGE_KEY, idToken);
    }
    for (const cb of _listeners) {
      cb(idToken);
    }
  }

  /** Clear the token from memory and storage. */
  function _clearToken() {
    _token = null;
    if (storage) {
      storage.removeItem(STORAGE_KEY);
    }
  }

  /**
   * Returns the current idToken, or null when signed out.
   * DC4: never log the return value — the caller (ApiClient) uses it only as a
   * Bearer header value.
   */
  function getToken() {
    return _token;
  }

  /**
   * Register a callback that fires with the idToken whenever a fresh credential arrives.
   * @param {Function} cb
   */
  function onSignedIn(cb) {
    _listeners.push(cb);
  }

  /**
   * Renders the GIS Sign-In button inside mountEl (a DOM element).
   * DC1: clientId is wired verbatim from the argument — never hard-coded here.
   * DC5: blocks the app until signed in; clears the gate once a credential arrives.
   *
   * @param {Element} mountEl
   */
  function renderGate(mountEl, _attempt = 0) {
    // DOM operations — no-op in node (test) environment.
    if (typeof document === 'undefined') return;
    const g = resolveGis();
    if (!g || !g.accounts || !g.accounts.id) {
      // GIS (async/defer) hasn't finished loading yet — retry briefly until it has, so the
      // button appears once google.accounts.id is ready (instead of a permanent white gate).
      if (_attempt < 50) {                               // ~50 × 150ms ≈ 7.5s
        setTimeout(() => renderGate(mountEl, _attempt + 1), 150);
      } else if (mountEl) {
        mountEl.innerHTML = '<p>Google Sign-In failed to load — refresh to retry.</p>';
      }
      return;
    }

    mountEl.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'desk-signin-gate';

    const heading = document.createElement('p');
    heading.textContent = 'Sign in to continue';
    wrapper.appendChild(heading);

    const buttonEl = document.createElement('div');
    wrapper.appendChild(buttonEl);
    mountEl.appendChild(wrapper);

    g.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        if (response && response.credential) {
          _setToken(response.credential);
          // DC5: remove the gate once signed in.
          wrapper.remove();
        }
      },
    });

    g.accounts.id.renderButton(buttonEl, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
    });
  }

  /**
   * Attempt a silent re-authentication via google.accounts.id.prompt().
   * DC3 / N3 / N4: bounded to REAUTH_TIMEOUT_MS (3 s). If no credential arrives within
   * the timeout, falls back to renderGate() so the app is never left in a white-screen
   * state. MUST resolve or reject within the timeout — never hangs.
   *
   * @returns {Promise<void>} Resolves when a fresh token is set; rejects if GIS
   *   unavailable. After the timeout, falls back to renderGate() (which itself resolves
   *   asynchronously when the user signs in), but the reauth() Promise settles within the
   *   timeout so callers (ApiClient retry loop) are never left hanging.
   */
  function reauth() {
    return new Promise((resolve, reject) => {
      const g = resolveGis();
      if (!g || !g.accounts || !g.accounts.id) {
        reject(new Error('GIS not available'));
        return;
      }

      let settled = false;

      // One-shot listener: fires if silent prompt delivers a credential before the timeout.
      const unsubscribe = (() => {
        const cb = (idToken) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            _listeners.splice(_listeners.indexOf(cb), 1);
            resolve();
          }
        };
        _listeners.push(cb);
        return () => {
          const idx = _listeners.indexOf(cb);
          if (idx !== -1) _listeners.splice(idx, 1);
        };
      })();

      // Timeout — fall back to renderGate() so the user can sign in manually.
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          unsubscribe();
          // Fall back: show the gate. reauth() resolves immediately so ApiClient
          // isn't left waiting; the user will sign in via the gate in their own time.
          // Guard: document is only available in browser context.
          if (typeof document !== 'undefined') {
            const mountEl = document.getElementById('desk-app') || document.body;
            renderGate(mountEl);
          }
          resolve();
        }
      }, REAUTH_TIMEOUT_MS);

      // Fire silent prompt. GIS may call our callback synchronously or asynchronously.
      g.accounts.id.prompt((notification) => {
        // If GIS explicitly says it can't sign in silently we can skip the timeout wait.
        if (
          notification &&
          (notification.isNotDisplayed() || notification.isSkippedMoment())
        ) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            if (typeof document !== 'undefined') {
              const mountEl = document.getElementById('desk-app') || document.body;
              renderGate(mountEl);
            }
            resolve();
          }
        }
        // If GIS delivers a credential it goes through the normal initialize() callback,
        // which calls _setToken() → fires the listener → resolve() above.
      });
    });
  }

  /**
   * Sign the user out: clears the token and shows the SignInGate.
   * DC5: getToken() returns null after signOut().
   */
  function signOut() {
    _clearToken();
    // Re-render gate if we have a DOM mount point (browser context only).
    if (typeof document !== 'undefined') {
      const mountEl = document.getElementById('desk-app') || document.body;
      renderGate(mountEl);
    }
    const g = resolveGis();
    if (g && g.accounts && g.accounts.id) {
      g.accounts.id.disableAutoSelect();
    }
  }

  return { getToken, reauth, onSignedIn, renderGate, signOut };
}
