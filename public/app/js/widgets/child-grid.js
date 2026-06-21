// ChildGrid — editable child-table widget (U7)
// Pure frontend module; no engine src/ import.
//
// Critical key distinction (C1 — the regression guard):
//   meta-lookup-key = childTableDef.doctype  (child_metas are keyed by doctype)
//   collect-key     = childTableDef.field    (rows are embedded under the parent fieldname)
// Following the ADR text literally (both as parent fieldname) silently drops child rows.

// Reserved keys that are never collected into a child row (engine rejects them on write).
const RESERVED_KEYS = new Set(['owner', 'docstatus', 'name', 'is_stub']);

// ---------------------------------------------------------------------------
// collectChildRows — PURE helper (vitest covers this; no DOM)
// ---------------------------------------------------------------------------

/**
 * Collect the current grid state into an array of plain row records.
 * Reserved keys are stripped. The caller (FormView / collect()) embeds the
 * resulting array under childTableDef.field — NOT under childTableDef.doctype.
 *
 * @param {Array<{ values: object }>} gridState  — array of row state objects
 * @returns {object[]}  array of plain row records (reserved keys stripped)
 */
export function collectChildRows(gridState) {
  return gridState.map((rowState) => {
    const record = {};
    for (const [key, val] of Object.entries(rowState.values)) {
      if (!RESERVED_KEYS.has(key)) {
        record[key] = val;
      }
    }
    return record;
  });
}

// ---------------------------------------------------------------------------
// _seedGridState — PURE helper (vitest covers this via createChildGrid tests)
// Converts raw rows (from the server) into mutable gridState entries.
// Reserved keys are stripped at seed time.
//
// @param {object[]} rows
// @returns {Array<{ values: object, cellEls: Map }>}
// ---------------------------------------------------------------------------
export function _seedGridState(rows) {
  return rows.map((row) => {
    const values = {};
    for (const [k, v] of Object.entries(row)) {
      if (!RESERVED_KEYS.has(k)) {
        values[k] = v;
      }
    }
    return { values, cellEls: new Map() };
  });
}

// ---------------------------------------------------------------------------
// createChildGrid (DOM factory — DOM access is deferred to render time,
// inside metaCache.meta().then(), so the factory is safe to call in node tests.)
// ---------------------------------------------------------------------------

/**
 * Factory — curried with shared deps, returns a per-field factory function.
 *
 * @param {{ metaCache: object, widgetRegistry: object }} deps
 * @returns {(childTableDef: { field: string, doctype: string, table: string },
 *            rows: object[],
 *            opts?: { readOnly?: boolean }) => { el: HTMLElement|null, collect(): object[] }}
 */
export function createChildGrid({ metaCache, widgetRegistry }) {
  /**
   * @param {{ field: string, doctype: string, table: string }} childTableDef
   *   field   — parent fieldname; collect key when FormView assembles the record.
   *   doctype — child DOCTYPE; meta-lookup key into child_metas / metaCache.
   *   table   — raw table name (reference; grid does not use it directly).
   * @param {object[]} [rows]  — existing row records (may be empty)
   * @param {{ readOnly?: boolean }} [opts]
   * @returns {{ el: HTMLElement|null, collect(): object[] }}
   */
  return function buildGrid(childTableDef, rows = [], opts = {}) {
    const { field, doctype } = childTableDef;
    const readOnly = !!(opts && opts.readOnly);

    // gridState tracks cell values. It is seeded synchronously from rows.
    // DC2 (C1): meta-lookup-key = doctype. Seeding from rows is pure (no DOM).
    const gridState = _seedGridState(rows);

    // el starts null so node-env callers (tests) never touch document.
    // DOM construction happens only inside the metaCache.meta() callback.
    let el = null;

    // Async: resolve column meta for the child DOCTYPE, then build DOM.
    // DC2 (C1): meta is requested for childTableDef.doctype, NOT childTableDef.field.
    metaCache.meta(doctype).then((bundle) => {
      // Handle both MetaBundle shapes: { meta: { fields } } or flat { fields }.
      const childFields = (bundle && bundle.meta && bundle.meta.fields)
        ? bundle.meta.fields
        : (bundle && bundle.fields) || [];

      // Guard: in node test environments document is not defined.
      if (typeof document === 'undefined') return;

      el = document.createElement('div');
      el.className = 'child-grid';
      el.dataset.field = field;
      el.dataset.doctype = doctype;

      renderGrid(el, gridState, childFields, doctype, readOnly);
    });

    return {
      /**
       * el — the grid's HTMLElement. Null until the async meta() call resolves.
       * FormView should mount it after awaiting setup, or mount the container
       * and let the grid populate it asynchronously.
       */
      get el() { return el; },

      /**
       * collect() — returns the row array for embedding under childTableDef.field.
       * DC2 (C1 — the critical key): collect-key = field (NOT doctype).
       * Returns plain records with reserved keys stripped.
       * This method is synchronous and DOM-free — safe to call in tests.
       */
      collect() {
        return collectChildRows(gridState);
      },
    };
  };

  // ---------------------------------------------------------------------------
  // renderGrid — DOM mutation; called after metaCache.meta() resolves.
  // ---------------------------------------------------------------------------
  function renderGrid(el, gridState, childFields, doctype, readOnly) {
    el.innerHTML = '';

    // --- header row ---
    const header = document.createElement('div');
    header.className = 'child-grid-header';
    for (const f of childFields) {
      const th = document.createElement('span');
      th.className = 'child-grid-th';
      th.textContent = f.label || f.fieldname;
      header.appendChild(th);
    }
    if (!readOnly) {
      const th = document.createElement('span');
      th.className = 'child-grid-th child-grid-th-action';
      header.appendChild(th);
    }
    el.appendChild(header);

    // --- data rows ---
    for (let i = 0; i < gridState.length; i++) {
      const rowState = gridState[i];
      const rowEl = document.createElement('div');
      rowEl.className = 'child-grid-row';

      for (const f of childFields) {
        const cell = document.createElement('div');
        cell.className = 'child-grid-cell';
        const cellWidget = widgetRegistry.create(f, rowState.values[f.fieldname], {
          readOnly,
          onChange(val) {
            // DC3 — each cell delegates to widgetRegistry; update local value on change.
            rowState.values[f.fieldname] = val;
          },
        });
        cell.appendChild(cellWidget);
        rowState.cellEls.set(f.fieldname, cell);
        rowEl.appendChild(cell);
      }

      if (!readOnly) {
        const removeCell = document.createElement('div');
        removeCell.className = 'child-grid-cell child-grid-cell-action';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'child-grid-remove-btn';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => {
          gridState.splice(i, 1);
          metaCache.meta(doctype).then((bundle) => {
            const fields = (bundle && bundle.meta && bundle.meta.fields)
              ? bundle.meta.fields
              : (bundle && bundle.fields) || [];
            renderGrid(el, gridState, fields, doctype, readOnly);
          });
        });
        removeCell.appendChild(removeBtn);
        rowEl.appendChild(removeCell);
      }

      el.appendChild(rowEl);
    }

    // --- Add row button ---
    if (!readOnly) {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'child-grid-add-btn';
      addBtn.textContent = 'Add row';
      addBtn.addEventListener('click', () => {
        const blankValues = {};
        for (const f of childFields) {
          blankValues[f.fieldname] = '';
        }
        gridState.push({ values: blankValues, cellEls: new Map() });
        renderGrid(el, gridState, childFields, doctype, readOnly);
      });
      el.appendChild(addBtn);
    }
  }
}
