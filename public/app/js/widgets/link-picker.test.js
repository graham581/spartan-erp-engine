// link-picker.test.js — unit tests for loadLinkOptions (pure helper, DOM-free).
// node-env vitest: mocked apiClient only. DOM typeahead verified by live proof.

import { describe, it, expect, vi } from 'vitest';
import { loadLinkOptions } from './link-picker.js';

// ---------------------------------------------------------------------------
// Helpers: build minimal mock errors matching ApiClient's error class shapes
// ---------------------------------------------------------------------------
function makeForbiddenError() {
  const e = new Error('Forbidden');
  e.name = 'ForbiddenError';
  return e;
}

function makeNotFoundError() {
  const e = new Error('Not Found');
  e.name = 'NotFoundError';
  return e;
}

// ---------------------------------------------------------------------------
// loadLinkOptions
// ---------------------------------------------------------------------------

describe('loadLinkOptions', () => {
  it('returns mode:list with rows when apiClient.list resolves', async () => {
    const rows = [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }];
    const apiClient = {
      list: vi.fn().mockResolvedValue(rows),
    };

    const result = await loadLinkOptions(apiClient, 'Customer');

    expect(result.mode).toBe('list');
    expect(result.rows).toEqual(rows);
    // Verify the correct fetch params (DC1: ordered by name, capped at 50)
    expect(apiClient.list).toHaveBeenCalledWith('Customer', {
      order_by: 'name',
      order: 'asc',
      limit: 50,
    });
  });

  it('caps rows at 50 even if apiClient.list returns more', async () => {
    // Build 60 rows
    const rows = Array.from({ length: 60 }, (_, i) => ({ name: `Doc-${String(i).padStart(3, '0')}` }));
    const apiClient = {
      list: vi.fn().mockResolvedValue(rows),
    };

    const result = await loadLinkOptions(apiClient, 'BigTable');

    expect(result.mode).toBe('list');
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0].name).toBe('Doc-000');
    expect(result.rows[49].name).toBe('Doc-049');
  });

  it('returns mode:text on ForbiddenError (DC3 / C4b)', async () => {
    const apiClient = {
      list: vi.fn().mockRejectedValue(makeForbiddenError()),
    };

    const result = await loadLinkOptions(apiClient, 'RestrictedDoctype');

    expect(result).toEqual({ mode: 'text' });
  });

  it('returns mode:text on NotFoundError (DC3 / C4b)', async () => {
    const apiClient = {
      list: vi.fn().mockRejectedValue(makeNotFoundError()),
    };

    const result = await loadLinkOptions(apiClient, 'UnknownDoctype');

    expect(result).toEqual({ mode: 'text' });
  });

  it('propagates unexpected errors (network failure, 500, etc.)', async () => {
    const networkErr = new Error('Network failure');
    const apiClient = {
      list: vi.fn().mockRejectedValue(networkErr),
    };

    await expect(loadLinkOptions(apiClient, 'SomeDoctype')).rejects.toBe(networkErr);
  });

  it('uses target from argument — no hard-coded doctype name (DC4)', async () => {
    const apiClient = { list: vi.fn().mockResolvedValue([]) };

    await loadLinkOptions(apiClient, 'ArbitraryTarget');

    expect(apiClient.list).toHaveBeenCalledWith(
      'ArbitraryTarget',
      expect.objectContaining({ order_by: 'name' }),
    );
  });
});
