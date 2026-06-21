// WidgetRegistry — fieldtype → widget key mapping + factory registry.
// U4 of the Desk UI build. Pure module; no engine src/ import.
// Link (U6) and Table (U7) factories are registered externally by U9 startup.

// ---------------------------------------------------------------------------
// Fieldtype → widget key map (FROZEN per workorder-desk-ui.md §U4)
// ---------------------------------------------------------------------------
const FIELDTYPE_MAP = {
  // text
  Data:             'data',
  Text:             'textarea',
  Code:             'textarea',
  // numeric
  Int:              'number',
  Float:            'number',
  Currency:         'number',
  // boolean
  Check:            'check',
  // date/time
  Date:             'date',
  Datetime:         'datetime',
  // choice
  Select:           'select',
  // reference / child — factories registered at startup by U9
  Link:             'link',
  Table:            'table',
};

/**
 * Returns the widget key for a given fieldDef.
 * Unknown fieldtype → 'data' (fail-soft text fallback, DC1).
 * @param {{ fieldtype: string }} fieldDef
 * @returns {string}
 */
export function widgetFor(fieldDef) {
  return FIELDTYPE_MAP[fieldDef.fieldtype] ?? 'data';
}

// ---------------------------------------------------------------------------
// normalizeSelectOptions (DC2)
// Accepts either an array of strings OR a '\n'-delimited string.
// Trims blank entries from both forms.
// ---------------------------------------------------------------------------

/**
 * @param {string[]|string} options
 * @returns {string[]}
 */
export function normalizeSelectOptions(options) {
  if (Array.isArray(options)) {
    return options.map(o => String(o).trim()).filter(o => o.length > 0);
  }
  return String(options)
    .split('\n')
    .map(o => o.trim())
    .filter(o => o.length > 0);
}

// ---------------------------------------------------------------------------
// Simple widget factories (text / textarea / number / check / date / datetime / select)
// Each factory: (fieldDef, value, opts) -> HTMLElement
// DC3: readOnly flag (opts.readOnly || fieldDef.readOnly || fieldDef.read_only) → display-only
// DC4: no doctype name hard-coded anywhere
// ---------------------------------------------------------------------------

/** Helper: resolve the effective readOnly state. */
function isReadOnly(fieldDef, opts = {}) {
  return !!(opts.readOnly || fieldDef.readOnly || fieldDef.read_only);
}

function makeTextWidget(fieldDef, value, opts = {}) {
  const ro = isReadOnly(fieldDef, opts);
  if (ro) {
    const span = document.createElement('span');
    span.className = 'widget-display';
    span.textContent = value ?? '';
    return span;
  }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'widget-input widget-text';
  input.value = value ?? '';
  if (opts.onChange) input.addEventListener('change', () => opts.onChange(input.value));
  return input;
}

function makeTextareaWidget(fieldDef, value, opts = {}) {
  const ro = isReadOnly(fieldDef, opts);
  if (ro) {
    const pre = document.createElement('pre');
    pre.className = 'widget-display widget-pre';
    pre.textContent = value ?? '';
    return pre;
  }
  const ta = document.createElement('textarea');
  ta.className = 'widget-input widget-textarea';
  ta.value = value ?? '';
  if (opts.onChange) ta.addEventListener('change', () => opts.onChange(ta.value));
  return ta;
}

function makeNumberWidget(fieldDef, value, opts = {}) {
  const ro = isReadOnly(fieldDef, opts);
  if (ro) {
    const span = document.createElement('span');
    span.className = 'widget-display';
    span.textContent = value ?? '';
    return span;
  }
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'widget-input widget-number';
  input.value = value ?? '';
  if (opts.onChange) input.addEventListener('change', () => opts.onChange(Number(input.value)));
  return input;
}

function makeCheckWidget(fieldDef, value, opts = {}) {
  const ro = isReadOnly(fieldDef, opts);
  if (ro) {
    const span = document.createElement('span');
    span.className = 'widget-display';
    span.textContent = value ? 'Yes' : 'No';
    return span;
  }
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'widget-input widget-check';
  input.checked = !!(value);
  if (opts.onChange) input.addEventListener('change', () => opts.onChange(input.checked));
  return input;
}

function makeDateWidget(fieldDef, value, opts = {}) {
  const ro = isReadOnly(fieldDef, opts);
  if (ro) {
    const span = document.createElement('span');
    span.className = 'widget-display';
    span.textContent = value ?? '';
    return span;
  }
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'widget-input widget-date';
  input.value = value ?? '';
  if (opts.onChange) input.addEventListener('change', () => opts.onChange(input.value));
  return input;
}

function makeDatetimeWidget(fieldDef, value, opts = {}) {
  const ro = isReadOnly(fieldDef, opts);
  if (ro) {
    const span = document.createElement('span');
    span.className = 'widget-display';
    span.textContent = value ?? '';
    return span;
  }
  const input = document.createElement('input');
  input.type = 'datetime-local';
  input.className = 'widget-input widget-datetime';
  input.value = value ?? '';
  if (opts.onChange) input.addEventListener('change', () => opts.onChange(input.value));
  return input;
}

function makeSelectWidget(fieldDef, value, opts = {}) {
  const ro = isReadOnly(fieldDef, opts);
  const choices = normalizeSelectOptions(fieldDef.options ?? '');
  if (ro) {
    const span = document.createElement('span');
    span.className = 'widget-display';
    span.textContent = value ?? '';
    return span;
  }
  const select = document.createElement('select');
  select.className = 'widget-input widget-select';
  // blank sentinel
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '';
  select.appendChild(blank);
  for (const choice of choices) {
    const opt = document.createElement('option');
    opt.value = choice;
    opt.textContent = choice;
    if (choice === value) opt.selected = true;
    select.appendChild(opt);
  }
  if (opts.onChange) select.addEventListener('change', () => opts.onChange(select.value));
  return select;
}

// ---------------------------------------------------------------------------
// WidgetRegistry
// ---------------------------------------------------------------------------

// Internal factory map: fieldtype string → factory function
const _factories = new Map();

// Register the simple widgets that U4 owns.
// 'link' and 'table' are intentionally absent here — U9 registers those at startup.
_factories.set('data',     makeTextWidget);
_factories.set('textarea', makeTextareaWidget);
_factories.set('number',   makeNumberWidget);
_factories.set('check',    makeCheckWidget);
_factories.set('date',     makeDateWidget);
_factories.set('datetime', makeDatetimeWidget);
_factories.set('select',   makeSelectWidget);

export const WidgetRegistry = {
  /**
   * Register a factory for a widget key.
   * Called by U9 at startup for 'link' and 'table'.
   * @param {string} fieldtype  widget key (e.g. 'link', 'table')
   * @param {Function} factory  (fieldDef, value, opts) -> HTMLElement
   */
  register(fieldtype, factory) {
    _factories.set(fieldtype, factory);
  },

  /**
   * Create a widget element for the given fieldDef + value.
   * Unknown key falls back to the 'data' (text) widget (fail-soft, DC1).
   * @param {{ fieldtype: string, options?: any, readOnly?: boolean, read_only?: boolean }} fieldDef
   * @param {*} value
   * @param {{ readOnly?: boolean, onChange?: Function }} [opts]
   * @returns {HTMLElement}
   */
  create(fieldDef, value, opts = {}) {
    const key = widgetFor(fieldDef);
    const factory = _factories.get(key) ?? _factories.get('data');
    return factory(fieldDef, value, opts);
  },

  /**
   * Returns true if a factory is registered for the given widget key.
   * @param {string} fieldtype  widget key
   * @returns {boolean}
   */
  has(fieldtype) {
    return _factories.has(fieldtype);
  },
};
