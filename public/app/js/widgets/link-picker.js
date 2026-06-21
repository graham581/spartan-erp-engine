// LinkPicker — Link-field widget for the Desk UI.
// U6 of the Desk UI build. Pure frontend; no engine src/ import.
// C4 is the load-bearing concern: capped fetch (DC1) + degrade-on-403/404 (DC3).
//
// Registered into WidgetRegistry under 'link' by U9 at startup.

// ---------------------------------------------------------------------------
// loadLinkOptions — pure fetch+degrade helper (the part vitest covers)
// ---------------------------------------------------------------------------

/**
 * Fetch the first 50 rows of `target` ordered by name.
 * Returns { mode:'list', rows } on success or
 *          { mode:'text' }     when the user may not access the target
 *                               (ForbiddenError or NotFoundError — DC3 / C4b).
 *
 * @param {{ list: Function }} apiClient
 * @param {string} target  the target doctype (from fieldDef.options — DC4)
 * @returns {Promise<{mode:'list', rows: object[]}|{mode:'text'}>}
 */
export async function loadLinkOptions(apiClient, target) {
  try {
    const rows = await apiClient.list(target, {
      order_by: 'name',
      order: 'asc',
      limit: 50,
    });
    // Cap at 50 — engine may return ≤50; guard in case it returns more.
    return { mode: 'list', rows: rows.slice(0, 50) };
  } catch (err) {
    // DC3 / C4b: degrade to plain-text when the user can't access the target.
    if (err && (err.name === 'ForbiddenError' || err.name === 'NotFoundError')) {
      return { mode: 'text' };
    }
    // All other errors (network, 500, etc.) propagate — these are unexpected
    // failures the caller should handle, not silent degrades.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// createLinkPicker — factory (injected deps, returned function is the widget factory)
// ---------------------------------------------------------------------------

/**
 * createLinkPicker({ apiClient, metaCache })
 *
 * Returns a widget factory: (fieldDef, value, opts) -> HTMLElement.
 * Registered into WidgetRegistry under 'link' by U9 at startup.
 *
 * @param {{ list: Function, meta: Function }} apiClient
 * @param {object} metaCache  (reserved for future meta pre-checks; not used in v1)
 * @returns {(fieldDef: object, value: any, opts?: object) => HTMLElement}
 */
export function createLinkPicker({ apiClient, metaCache }) {
  /**
   * @param {{ options: string, readOnly?: boolean, read_only?: boolean, label?: string }} fieldDef
   * @param {string|null} value   current linked doc name (or null/undefined)
   * @param {{ readOnly?: boolean, onChange?: Function }} [opts]
   * @returns {HTMLElement}
   */
  return function makeLinkPickerWidget(fieldDef, value, opts = {}) {
    // DC4: target comes only from fieldDef.options — never hard-coded.
    const target = fieldDef.options;
    const ro = !!(opts.readOnly || fieldDef.readOnly || fieldDef.read_only);

    // --- read-only display ---
    if (ro) {
      const span = document.createElement('span');
      span.className = 'widget-display widget-link-display';
      span.textContent = value ?? '';
      return span;
    }

    // --- container wraps both the lazy-loaded picker and the fallback text input ---
    const container = document.createElement('div');
    container.className = 'widget-link-container';

    // Internal state
    let _currentValue = value ?? '';
    let _mode = null;       // 'list' | 'text' — set after async load
    let _rows = [];         // cached rows from loadLinkOptions
    let _listOpen = false;

    // ---- shared setter: notifies onChange and reflects in whichever input is live ----
    function setValue(v) {
      _currentValue = v;
      if (opts.onChange) opts.onChange(v);
    }

    // ---- render a plain text input (degrade mode or fallback) ----
    function buildTextInput(initialVal) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'widget-input widget-link-text';
      input.value = initialVal ?? '';
      input.placeholder = target ? `Type ${target} name…` : 'Type name…';
      // DC2: store the raw name as the value (degrade path)
      input.addEventListener('change', () => setValue(input.value));
      return input;
    }

    // ---- render the dropdown list widget ----
    function buildListWidget(initialVal, rows) {
      const wrap = document.createElement('div');
      wrap.className = 'widget-link-list-wrap';

      // The trigger input (shows selected name; user types to filter)
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'widget-input widget-link-trigger';
      input.value = initialVal ?? '';
      input.placeholder = target ? `Search ${target}…` : 'Search…';
      input.setAttribute('autocomplete', 'off');

      // Dropdown list element
      const dropdown = document.createElement('ul');
      dropdown.className = 'widget-link-dropdown';
      dropdown.style.display = 'none';
      dropdown.setAttribute('role', 'listbox');

      // Populate dropdown from (filtered) rows
      function renderDropdown(filter) {
        dropdown.innerHTML = '';
        const q = (filter ?? '').toLowerCase();
        const visible = q
          ? rows.filter(r => String(r.name ?? '').toLowerCase().includes(q))
          : rows;
        if (visible.length === 0) {
          const li = document.createElement('li');
          li.className = 'widget-link-no-results';
          li.textContent = 'No results';
          dropdown.appendChild(li);
        } else {
          for (const row of visible) {
            const li = document.createElement('li');
            li.className = 'widget-link-option';
            li.setAttribute('role', 'option');
            li.textContent = row.name;
            li.addEventListener('mousedown', (e) => {
              // mousedown fires before blur; prevent blur from closing the list first
              e.preventDefault();
              // DC2: store the linked doc's `name` as the value
              setValue(row.name);
              input.value = row.name;
              closeDropdown();
            });
            dropdown.appendChild(li);
          }
        }
      }

      function openDropdown() {
        _listOpen = true;
        renderDropdown(input.value);
        dropdown.style.display = 'block';
      }

      function closeDropdown() {
        _listOpen = false;
        dropdown.style.display = 'none';
      }

      input.addEventListener('focus', () => openDropdown());
      input.addEventListener('input', () => {
        renderDropdown(input.value);
        if (!_listOpen) openDropdown();
      });
      input.addEventListener('blur', () => {
        // Small delay so mousedown on a li can fire first
        setTimeout(() => closeDropdown(), 150);
      });

      wrap.appendChild(input);
      wrap.appendChild(dropdown);
      return wrap;
    }

    // ---- async load: fetch options, then swap in the right widget ----
    // Start with a temporary loading input so the form is never blank.
    const loadingInput = document.createElement('input');
    loadingInput.type = 'text';
    loadingInput.className = 'widget-input widget-link-loading';
    loadingInput.value = _currentValue;
    loadingInput.placeholder = 'Loading…';
    loadingInput.disabled = true;
    container.appendChild(loadingInput);

    loadLinkOptions(apiClient, target).then((result) => {
      _mode = result.mode;
      container.innerHTML = '';
      if (result.mode === 'list') {
        _rows = result.rows;
        const listWidget = buildListWidget(_currentValue, _rows);
        container.appendChild(listWidget);
      } else {
        // DC3: degrade to plain text input — must not throw or whiteout the form
        const textInput = buildTextInput(_currentValue);
        container.appendChild(textInput);
      }
    }).catch(() => {
      // Unexpected error path: fall back to plain text so the form stays usable.
      container.innerHTML = '';
      const textInput = buildTextInput(_currentValue);
      container.appendChild(textInput);
    });

    return container;
  };
}
