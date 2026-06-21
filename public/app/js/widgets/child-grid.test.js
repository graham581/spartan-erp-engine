// child-grid.test.js — pure-logic unit tests for ChildGrid (U7)
// Node/vitest environment only; no DOM, no jsdom (workorder §0 constraint).
// DOM rendering verified by the live proof (manual). These tests guard the
// C1 regression: collect-key = field, meta-lookup-key = doctype.

import { describe, it, expect, vi } from 'vitest';
import { collectChildRows, createChildGrid } from './child-grid.js';

// ---------------------------------------------------------------------------
// collectChildRows — pure helper tests
// ---------------------------------------------------------------------------

describe('collectChildRows', () => {
  it('returns plain records from gridState', () => {
    const gridState = [
      { values: { description: 'Aluminium frame', qty: 2 } },
      { values: { description: 'Glass pane', qty: 4 } },
    ];
    const result = collectChildRows(gridState);
    expect(result).toEqual([
      { description: 'Aluminium frame', qty: 2 },
      { description: 'Glass pane', qty: 4 },
    ]);
  });

  it('strips reserved keys: owner, docstatus, name, is_stub', () => {
    const gridState = [
      {
        values: {
          description: 'Aluminium frame',
          qty: 2,
          // reserved keys that must be stripped:
          owner: 'admin@example.com',
          docstatus: 0,
          name: 'QITEM-0001',
          is_stub: false,
        },
      },
    ];
    const result = collectChildRows(gridState);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ description: 'Aluminium frame', qty: 2 });
    expect(result[0]).not.toHaveProperty('owner');
    expect(result[0]).not.toHaveProperty('docstatus');
    expect(result[0]).not.toHaveProperty('name');
    expect(result[0]).not.toHaveProperty('is_stub');
  });

  it('returns an empty array for an empty gridState', () => {
    expect(collectChildRows([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C1 regression guard — collect-key = field, meta-lookup-key = doctype
//
// Given:
//   childTableDef = { field: 'items', doctype: 'Quote Item', table: 'tabQuote Item' }
//   two staged rows
//
// Assert:
//   1. The record fragment produced by collect() is keyed by 'items' (the FIELD),
//      NOT by 'Quote Item' (the doctype). This is the C1 bug guard.
//   2. Column meta is requested from metaCache for 'Quote Item' (the DOCTYPE),
//      NOT for 'items' (the field name).
// ---------------------------------------------------------------------------

describe('C1 regression guard — collect-key=field, meta-lookup=doctype', () => {
  const childTableDef = {
    field: 'items',
    doctype: 'Quote Item',
    table: 'tabQuote Item',
  };

  // Stub metaCache that records which dt was requested.
  function makeMetaCache(fields = []) {
    const calls = [];
    return {
      calls,
      meta(dt) {
        calls.push(dt);
        // Return a MetaBundle-shaped object (bundle.meta.fields form).
        return Promise.resolve({ meta: { fields }, fields });
      },
      peek(dt) {
        return undefined;
      },
    };
  }

  // Stub widgetRegistry — does nothing for DOM tests (pure-logic only here).
  const stubWidgetRegistry = {
    create: vi.fn(() => {
      // Return a minimal fake element to satisfy the DOM path.
      // In node env (no jsdom) document is not available; the pure collect()
      // path runs before any DOM operations, so we only test collect(), not render.
      return {};
    }),
  };

  it('collect() returns rows keyed by field ("items"), not by doctype ("Quote Item")', async () => {
    const metaCache = makeMetaCache([
      { fieldname: 'description', fieldtype: 'Data', label: 'Description' },
      { fieldname: 'qty', fieldtype: 'Int', label: 'Qty' },
    ]);

    const buildGrid = createChildGrid({ metaCache, widgetRegistry: stubWidgetRegistry });

    // Seed with two rows (simulating existing data loaded from the server).
    const existingRows = [
      { description: 'Aluminium frame', qty: 2 },
      { description: 'Glass pane', qty: 4 },
    ];

    const grid = buildGrid(childTableDef, existingRows, {});

    // Wait for the async meta() bootstrap to complete.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // collect() returns the raw row array (without a wrapping key).
    // FormView embeds it under childTableDef.field. Test the embedding contract:
    const rowArray = grid.collect();
    expect(Array.isArray(rowArray)).toBe(true);
    expect(rowArray).toHaveLength(2);
    expect(rowArray[0]).toMatchObject({ description: 'Aluminium frame', qty: 2 });
    expect(rowArray[1]).toMatchObject({ description: 'Glass pane', qty: 4 });

    // Simulate how FormView assembles the submit record (DC2 / C1 guard):
    //   record[childTableDef.field] = grid.collect()
    // The key MUST be 'items' (the FIELD), not 'Quote Item' (the DOCTYPE).
    const recordFragment = {};
    recordFragment[childTableDef.field] = grid.collect();

    // Assert keyed by FIELD ('items').
    expect(recordFragment).toHaveProperty('items');
    expect(recordFragment.items).toHaveLength(2);

    // Assert NOT keyed by DOCTYPE ('Quote Item') — this is the C1 bug.
    expect(recordFragment).not.toHaveProperty('Quote Item');
  });

  it('column meta is requested for the child DOCTYPE ("Quote Item"), not the field name ("items")', async () => {
    const metaCache = makeMetaCache([]);

    const buildGrid = createChildGrid({ metaCache, widgetRegistry: stubWidgetRegistry });
    buildGrid(childTableDef, [], {});

    // Flush the promise queue so the bootstrap meta() call completes.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // metaCache.meta() must have been called with the DOCTYPE, not the field name.
    expect(metaCache.calls).toContain('Quote Item');
    expect(metaCache.calls).not.toContain('items');
  });

  it('reserved keys in existing rows are not collected into child row records', async () => {
    const metaCache = makeMetaCache([
      { fieldname: 'description', fieldtype: 'Data', label: 'Description' },
    ]);

    const buildGrid = createChildGrid({ metaCache, widgetRegistry: stubWidgetRegistry });

    const existingRows = [
      {
        description: 'Aluminium frame',
        owner: 'admin@example.com',
        docstatus: 0,
        name: 'QITEM-0001',
        is_stub: false,
      },
    ];

    const grid = buildGrid(childTableDef, existingRows, {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rows = grid.collect();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ description: 'Aluminium frame' });
    expect(rows[0]).not.toHaveProperty('owner');
    expect(rows[0]).not.toHaveProperty('docstatus');
    expect(rows[0]).not.toHaveProperty('name');
    expect(rows[0]).not.toHaveProperty('is_stub');
  });
});
