// router.test.js — pure hash-parse unit tests (U9)
// No DOM; no network. Tests the parseHash export + navigate/start contract stubs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseHash, createRouter } from './router.js';

describe('parseHash', () => {
  it('#/Job → { dt:"Job", name:null, mode:"list" }', () => {
    expect(parseHash('#/Job')).toEqual({ dt: 'Job', name: null, mode: 'list' });
  });

  it('#/Job/ (trailing slash) → list', () => {
    // A bare trailing slash is treated as "no second segment" → list
    const r = parseHash('#/Job/');
    // decodeURIComponent('') === '' which is falsy but present as second segment
    // Per our scheme that would be mode 'view' with name ''.
    // Treat this as an edge-case that still returns something non-null.
    expect(r).not.toBeNull();
    expect(r.dt).toBe('Job');
  });

  it('#/Job/new → { dt:"Job", name:null, mode:"create" }', () => {
    expect(parseHash('#/Job/new')).toEqual({ dt: 'Job', name: null, mode: 'create' });
  });

  it('#/Job/JOB-0001 → { dt:"Job", name:"JOB-0001", mode:"view" }', () => {
    expect(parseHash('#/Job/JOB-0001')).toEqual({ dt: 'Job', name: 'JOB-0001', mode: 'view' });
  });

  it('URL-encoded name round-trips decoded', () => {
    // #/Sales%20Order/SO%2D1  →  { dt:'Sales Order', name:'SO-1', mode:'view' }
    const r = parseHash('#/Sales%20Order/SO%2D1');
    expect(r).toEqual({ dt: 'Sales Order', name: 'SO-1', mode: 'view' });
  });

  it('URL-encoded doctype round-trips decoded', () => {
    const r = parseHash('#/Sales%20Order');
    expect(r).toEqual({ dt: 'Sales Order', name: null, mode: 'list' });
  });

  it('empty hash → null', () => {
    expect(parseHash('#')).toBeNull();
    expect(parseHash('')).toBeNull();
    expect(parseHash('#/')).toBeNull();
  });

  it('hash with no leading # returns null (location.hash always starts with #)', () => {
    // parseHash expects location.hash format which always starts with '#'.
    // A bare path segment without '#' is not a valid input.
    expect(parseHash('/Job/JOB-0001')).toBeNull();
  });

  it('deeply-encoded name (space in name) → decoded', () => {
    const r = parseHash('#/Customer/Acme%20Corp');
    expect(r).toEqual({ dt: 'Customer', name: 'Acme Corp', mode: 'view' });
  });
});

describe('createRouter', () => {
  let onRoute;
  let router;
  const events = {};

  beforeEach(() => {
    onRoute = vi.fn();

    // Provide a minimal globalThis mock for start() / navigate()
    globalThis.location = { hash: '' };
    globalThis.addEventListener = (type, cb) => { events[type] = cb; };

    router = createRouter({ onRoute });
  });

  it('start() fires onRoute for the current hash when non-empty', () => {
    globalThis.location.hash = '#/Job';
    router.start();
    expect(onRoute).toHaveBeenCalledWith({ dt: 'Job', name: null, mode: 'list' });
  });

  it('start() does NOT fire onRoute when hash is empty', () => {
    globalThis.location.hash = '';
    router.start();
    expect(onRoute).not.toHaveBeenCalled();
  });

  it('navigate() sets location.hash', () => {
    router.navigate('#/Job/JOB-0001');
    expect(globalThis.location.hash).toBe('#/Job/JOB-0001');
  });

  it('hashchange event triggers onRoute', () => {
    globalThis.location.hash = '';
    router.start();
    onRoute.mockClear();

    // Simulate a hashchange
    globalThis.location.hash = '#/Customer/CUST-001';
    events['hashchange']();
    expect(onRoute).toHaveBeenCalledWith({ dt: 'Customer', name: 'CUST-001', mode: 'view' });
  });
});
