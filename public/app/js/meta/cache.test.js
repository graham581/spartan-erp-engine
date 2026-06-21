// MetaCache unit tests (node-env, no DOM)
import { describe, it, expect, vi } from 'vitest';
import { createMetaCache } from './cache.js';

const BUNDLE = { doctype: 'SalesOrder', meta: { fields: [] }, capabilities: {} };

function makeStub(bundle = BUNDLE) {
  const stub = {
    callCount: 0,
    meta: vi.fn((_dt) => {
      stub.callCount++;
      return Promise.resolve(bundle);
    }),
  };
  return stub;
}

// ── DC1: memoize — two calls → one fetch ─────────────────────────────────────
describe('DC1 — memoize resolved promise', () => {
  it('two sequential meta(dt) calls trigger only one fetch', async () => {
    const stub = makeStub();
    const cache = createMetaCache(stub);

    const r1 = await cache.meta('SalesOrder');
    const r2 = await cache.meta('SalesOrder');

    expect(stub.callCount).toBe(1);
    expect(r1).toBe(r2); // same object reference
  });

  it('concurrent meta(dt) calls share one in-flight fetch', async () => {
    const stub = makeStub();
    const cache = createMetaCache(stub);

    // Fire both without awaiting in between — they must share the one promise.
    const [r1, r2] = await Promise.all([
      cache.meta('SalesOrder'),
      cache.meta('SalesOrder'),
    ]);

    expect(stub.callCount).toBe(1);
    expect(r1).toBe(r2);
  });

  it('different doctypes each get their own fetch', async () => {
    const stub = makeStub();
    const cache = createMetaCache(stub);

    await cache.meta('SalesOrder');
    await cache.meta('Customer');

    expect(stub.callCount).toBe(2);
  });

  it('peek returns undefined before any fetch', () => {
    const stub = makeStub();
    const cache = createMetaCache(stub);
    expect(cache.peek('SalesOrder')).toBeUndefined();
  });

  it('peek returns the bundle after meta resolves', async () => {
    const stub = makeStub();
    const cache = createMetaCache(stub);
    await cache.meta('SalesOrder');
    expect(cache.peek('SalesOrder')).toBe(BUNDLE);
  });

  it('clear wipes both the promise cache and resolved map', async () => {
    const stub = makeStub();
    const cache = createMetaCache(stub);

    await cache.meta('SalesOrder');
    cache.clear();

    expect(cache.peek('SalesOrder')).toBeUndefined();

    // After clear a fresh fetch should happen.
    await cache.meta('SalesOrder');
    expect(stub.callCount).toBe(2);
  });
});

// ── DC2: rejection is NOT memoized ───────────────────────────────────────────
describe('DC2 — rejected fetch is not cached', () => {
  it('a rejection is evicted; the next meta(dt) call retries', async () => {
    let failOnce = true;
    const stub = {
      callCount: 0,
      meta: vi.fn((_dt) => {
        stub.callCount++;
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error('network failure'));
        }
        return Promise.resolve(BUNDLE);
      }),
    };
    const cache = createMetaCache(stub);

    // First call rejects.
    await expect(cache.meta('SalesOrder')).rejects.toThrow('network failure');

    // Second call must trigger a new fetch (not return the cached rejection).
    const result = await cache.meta('SalesOrder');
    expect(stub.callCount).toBe(2);
    expect(result).toBe(BUNDLE);
  });

  it('peek returns undefined after a rejection (nothing stored)', async () => {
    const stub = {
      callCount: 0,
      meta: vi.fn(() => {
        stub.callCount++;
        return Promise.reject(new Error('fail'));
      }),
    };
    const cache = createMetaCache(stub);

    await expect(cache.meta('SalesOrder')).rejects.toThrow();
    expect(cache.peek('SalesOrder')).toBeUndefined();
  });
});

// ── DC3: issingle is cached without special-casing ───────────────────────────
describe('DC3 — issingle bundles are cached generically', () => {
  it('returns and caches a bundle with meta.issingle === true', async () => {
    const singleBundle = { doctype: 'SystemSettings', meta: { issingle: true, fields: [] }, capabilities: {} };
    const stub = { callCount: 0, meta: vi.fn(() => { stub.callCount++; return Promise.resolve(singleBundle); }) };
    const cache = createMetaCache(stub);

    const r1 = await cache.meta('SystemSettings');
    const r2 = await cache.meta('SystemSettings');

    expect(stub.callCount).toBe(1);
    expect(r1).toStrictEqual(singleBundle);
    expect(r2).toBe(r1);
    expect(cache.peek('SystemSettings')).toBe(singleBundle);
  });
});
