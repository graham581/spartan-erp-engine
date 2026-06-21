// MetaCache — per-session memoized MetaBundle cache (U2)
// Injects apiClient (U1); stays doctype-agnostic (issingle gate lives in U9).

export function createMetaCache(apiClient) {
  // Map<dt, Promise<MetaBundle>> — stores the in-flight or resolved promise.
  // Rejected promises are removed on rejection so the next call retries (DC2).
  const promises = new Map();

  // Map<dt, MetaBundle> — resolved values only, for sync peek().
  const resolved = new Map();

  return {
    /**
     * meta(dt) — returns a Promise<MetaBundle>.
     * DC1: first call fetches; subsequent calls for the same dt return the
     *      cached promise (concurrent callers share one in-flight fetch).
     * DC2: a rejected fetch is NOT cached; the next meta(dt) call retries.
     * DC3: caching is doctype-agnostic; issingle routing gate lives in U9.
     */
    meta(dt) {
      if (promises.has(dt)) {
        return promises.get(dt);
      }
      const p = apiClient.meta(dt).then(
        (bundle) => {
          resolved.set(dt, bundle);
          return bundle;
        },
        (err) => {
          // DC2 — evict so the next caller triggers a fresh fetch.
          promises.delete(dt);
          return Promise.reject(err);
        }
      );
      promises.set(dt, p);
      return p;
    },

    /**
     * peek(dt) — sync snapshot, no fetch.
     * Returns the MetaBundle if already resolved, otherwise undefined.
     */
    peek(dt) {
      return resolved.get(dt);
    },

    /**
     * clear() — wipe all cached bundles (e.g. on sign-out).
     */
    clear() {
      promises.clear();
      resolved.clear();
    },
  };
}
