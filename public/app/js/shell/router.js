// Router — hash-based SPA router (U9)
// Pure; no DOM import required beyond globalThis.location and globalThis.addEventListener.
// Contract frozen per docs/workorder-desk-ui.md §U9.
//
// Hash scheme:
//   #/<dt>           → { dt, name: null, mode: 'list' }
//   #/<dt>/new       → { dt, name: null, mode: 'create' }
//   #/<dt>/<name>    → { dt, name,       mode: 'view' }
//   (URL-encoded dt/name are decoded before returning)

/**
 * Parse a location.hash string into a route object.
 * Exported for unit testing.
 *
 * @param {string} hash  e.g. '#/Job/JOB-0001' or '#/Job'
 * @returns {{ dt: string|null, name: string|null, mode: 'list'|'create'|'view' }|null}
 *   null if the hash doesn't match the expected scheme.
 */
export function parseHash(hash) {
  // Strip leading '#' and any leading '/'
  const raw = hash.replace(/^#\/?/, '');
  if (!raw) return null;

  const parts = raw.split('/');
  if (parts.length === 0 || !parts[0]) return null;

  const dt = decodeURIComponent(parts[0]);

  if (parts.length === 1) {
    // #/<dt>
    return { dt, name: null, mode: 'list' };
  }

  const second = decodeURIComponent(parts[1]);

  if (second === 'new') {
    // #/<dt>/new
    return { dt, name: null, mode: 'create' };
  }

  // #/<dt>/<name>  — name may itself contain encoded slashes; join the rest back
  const name = parts.slice(1).map(decodeURIComponent).join('/');
  return { dt, name, mode: 'view' };
}

/**
 * createRouter({ onRoute })
 *
 * @param {{ onRoute: (route: { dt: string, name: string|null, mode: string }) => void }} opts
 * @returns {{ navigate(hash: string): void, start(): void }}
 */
export function createRouter({ onRoute }) {
  /** Fire onRoute for the current hash if it parses. */
  function _dispatch() {
    const route = parseHash(globalThis.location ? globalThis.location.hash : '');
    if (route) {
      onRoute(route);
    }
  }

  /**
   * Navigate to a new hash.  Sets location.hash which triggers the hashchange
   * listener (and therefore onRoute) automatically.
   * @param {string} hash  e.g. '#/Job/JOB-0001'
   */
  function navigate(hash) {
    if (globalThis.location) {
      globalThis.location.hash = hash;
    }
  }

  /**
   * Start listening for hashchange events and fire onRoute for the current hash.
   */
  function start() {
    if (globalThis.addEventListener) {
      globalThis.addEventListener('hashchange', _dispatch);
    }
    _dispatch();
  }

  return { navigate, start };
}
