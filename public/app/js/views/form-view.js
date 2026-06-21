// FormView — read/edit/create form (U8)
// Assembles widgets + child grids + workflow bar for a single doc.
// Pure frontend module; no engine src/ import.
//
// Critical key distinction inherited from U7 (C1/C2):
//   Child columns:  looked up by childTableDef.doctype (meta-key)
//   Child rows:     embedded under childTableDef.field  (collect-key)
// Reserved keys (owner/docstatus/name/is_stub) are NEVER sent in any body.

// Keys that must never appear in a submitted record (§1, invariant 1).
const RESERVED = new Set(['owner', 'docstatus', 'name', 'is_stub']);

// ---------------------------------------------------------------------------
// buildSubmitRecord — PURE helper (vitest covers this; no DOM)
// ---------------------------------------------------------------------------

/**
 * Assemble the flat record object to POST to the engine.
 *
 * @param {Array<{ fieldname: string }>} fields          — meta.fields for scalar/Link widgets
 * @param {object} scalarValues                           — { [fieldname]: value }
 * @param {Array<{ def: { field: string }, grid: { collect(): object[] } }>} childGrids
 *   — each entry carries the childTableDef (def) and the live ChildGrid instance (grid).
 *   Rows are embedded under def.field (the parent fieldname — C1 collect-key).
 * @returns {object}  flat record ready for apiClient.create / apiClient.update
 *
 * DC3 (C1): children embedded under childTableDef.field, NOT doctype.
 * DC3:       reserved keys stripped from scalars.
 */
export function buildSubmitRecord(fields, scalarValues, childGrids) {
  const record = {};

  // Scalar fields — keyed by fieldname, reserved keys excluded.
  for (const f of fields) {
    const key = f.fieldname;
    if (RESERVED.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(scalarValues, key)) {
      record[key] = scalarValues[key];
    }
  }

  // Child grids — keyed by field (NOT doctype). C1.
  for (const { def, grid } of childGrids) {
    if (!RESERVED.has(def.field)) {
      record[def.field] = grid.collect();
    }
  }

  return record;
}

// ---------------------------------------------------------------------------
// renderFormView — DOM factory
// ---------------------------------------------------------------------------

/**
 * Render a read/edit/create form into mountEl.
 *
 * @param {{
 *   dt:              string,
 *   name:            string|null,       — null in 'create' mode
 *   mode:            'view'|'edit'|'create',
 *   metaCache:       object,            — U2 MetaCache instance
 *   apiClient:       object,            — U1 ApiClient instance
 *   widgetRegistry:  object,            — U4 WidgetRegistry instance
 *   workflowBar:     function,          — U10 renderWorkflowBar
 *   mountEl:         HTMLElement,
 *   navigate:        (hash: string) => void,
 * }} params
 */
export async function renderFormView({
  dt,
  name,
  mode,
  metaCache,
  apiClient,
  widgetRegistry,
  workflowBar,
  mountEl,
  navigate,
}) {
  mountEl.innerHTML = '';

  // --- fetch meta + (for view/edit) the live doc ---
  const bundle = await metaCache.meta(dt);
  const meta = bundle.meta || bundle; // handle both MetaBundle shapes

  let doc = null;
  if (mode !== 'create') {
    doc = await apiClient.get(dt, name);
  }

  // --- build the form shell ---
  const form = document.createElement('form');
  form.className = 'form-view';
  form.dataset.dt = dt;
  if (name) form.dataset.name = name;
  form.dataset.mode = mode;

  // DC5: WorkflowBar in view mode (transitions on the persisted doc).
  const workflowEl = document.createElement('div');
  workflowEl.className = 'form-workflow';
  form.appendChild(workflowEl);

  // --- inline error container for 400/409 form-level messages ---
  const formErrEl = document.createElement('div');
  formErrEl.className = 'form-error';
  formErrEl.style.display = 'none';
  form.appendChild(formErrEl);

  // --- scalar/Link widgets (DC1, DC2) ---
  // Fields whose fieldtype === 'Table' are rendered as ChildGrids below (DC2 C2).
  const scalarFields = (meta.fields || []).filter((f) => f.fieldtype !== 'Table');
  const scalarValues = {}; // live values tracked here; collect at submit time

  // Per-field error elements (DC4)
  const fieldErrEls = {};

  for (const fieldDef of scalarFields) {
    const fieldRow = document.createElement('div');
    fieldRow.className = 'form-field-row';

    const label = document.createElement('label');
    label.className = 'form-field-label';
    label.textContent = fieldDef.label || fieldDef.fieldname;
    fieldRow.appendChild(label);

    // DC6: readOnly fields render display-only even in edit mode.
    const isReadOnly = mode === 'view'
      || !!(fieldDef.readOnly || fieldDef.read_only);

    const initVal = doc ? (doc[fieldDef.fieldname] ?? '') : '';
    scalarValues[fieldDef.fieldname] = initVal;

    const widget = widgetRegistry.create(fieldDef, initVal, {
      readOnly: isReadOnly,
      onChange(val) {
        scalarValues[fieldDef.fieldname] = val;
      },
    });
    fieldRow.appendChild(widget);

    // Per-field error span (DC4)
    const errEl = document.createElement('span');
    errEl.className = 'form-field-error';
    errEl.style.display = 'none';
    errEl.style.color = 'red';
    fieldRow.appendChild(errEl);
    fieldErrEls[fieldDef.fieldname] = errEl;

    form.appendChild(fieldRow);
  }

  // --- child grids (DC2 C2): iterate meta.childTables, NOT meta.fields ---
  // Each ChildGrid's el starts null (async meta bootstrap); we mount a container
  // element immediately and the grid populates it once metaCache.meta() resolves.
  const childGrids = []; // [{ def, grid }]
  const childTables = meta.childTables || [];

  for (const childTableDef of childTables) {
    const section = document.createElement('div');
    section.className = 'form-child-section';
    section.dataset.field = childTableDef.field;

    const sectionLabel = document.createElement('div');
    sectionLabel.className = 'form-child-label';
    sectionLabel.textContent = childTableDef.field;
    section.appendChild(sectionLabel);

    // Container div — the ChildGrid will append its el here asynchronously.
    const gridContainer = document.createElement('div');
    gridContainer.className = 'form-child-grid-container';
    section.appendChild(gridContainer);

    const isReadOnly = mode === 'view';
    const existingRows = (doc && doc[childTableDef.field]) || [];

    // buildGrid returns { el (null-until-async), collect() }
    const buildGrid = widgetRegistry.create(
      // Table-type fieldDef matching how U9 registers ChildGrid under 'table'
      { fieldtype: 'Table', fieldname: childTableDef.field, options: childTableDef.doctype },
      existingRows,
      { readOnly: isReadOnly },
    );

    // The grid's el is populated asynchronously; attach container now and let
    // metaCache.meta() callback append el when it resolves.
    // We poll via a MutationObserver-free approach: after the meta promise settles
    // the grid writes to its own el getter — we simply check at submit time.
    // For DOM mounting we use the resolved promise from metaCache directly.
    metaCache.meta(childTableDef.doctype).then(() => {
      // el is now non-null (ChildGrid sets it inside .then())
      if (buildGrid.el && typeof document !== 'undefined') {
        gridContainer.appendChild(buildGrid.el);
      }
    });

    childGrids.push({ def: childTableDef, grid: buildGrid });
    form.appendChild(section);
  }

  // --- save / submit button (edit + create modes) ---
  if (mode !== 'view') {
    const footer = document.createElement('div');
    footer.className = 'form-footer';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'form-save-btn';
    saveBtn.textContent = mode === 'create' ? 'Create' : 'Save';

    saveBtn.addEventListener('click', async () => {
      // Clear previous errors
      formErrEl.style.display = 'none';
      formErrEl.textContent = '';
      for (const el of Object.values(fieldErrEls)) {
        el.style.display = 'none';
        el.textContent = '';
      }

      // DC3 (C1): assemble the submit record — scalars keyed by fieldname +
      // child rows keyed by childTableDef.field (NOT doctype).
      const record = buildSubmitRecord(scalarFields, scalarValues, childGrids);

      try {
        let saved;
        if (mode === 'create') {
          saved = await apiClient.create(dt, record);
        } else {
          saved = await apiClient.update(dt, name, record);
        }
        // Navigate to view mode after successful save.
        navigate('#/' + encodeURIComponent(dt) + '/' + encodeURIComponent(saved.name));
      } catch (err) {
        // DC4: 400 ValidationError → map issue paths to per-field inline messages.
        if (err && err.status === 400 && err.body) {
          const issues = err.body.issues || [];
          if (issues.length > 0) {
            for (const issue of issues) {
              const field = issue.path && issue.path[0];
              if (field && fieldErrEls[field]) {
                fieldErrEls[field].textContent = issue.message || err.body.error || String(err);
                fieldErrEls[field].style.display = 'inline';
              } else {
                // Fall back to form-level message
                formErrEl.textContent = err.body.error || String(err);
                formErrEl.style.display = 'block';
              }
            }
          } else {
            formErrEl.textContent = err.body.error || String(err);
            formErrEl.style.display = 'block';
          }
        } else if (err && err.status === 409) {
          // DC4: 409 StateError → surface verbatim
          formErrEl.textContent = (err.body && err.body.error) || err.message || String(err);
          formErrEl.style.display = 'block';
        } else {
          formErrEl.textContent = err.message || String(err);
          formErrEl.style.display = 'block';
        }
      }
    });

    footer.appendChild(saveBtn);

    if (mode === 'edit') {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'form-cancel-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        navigate('#/' + encodeURIComponent(dt) + '/' + encodeURIComponent(name));
      });
      footer.appendChild(cancelBtn);
    }

    form.appendChild(footer);
  } else {
    // view mode: Edit button
    const footer = document.createElement('div');
    footer.className = 'form-footer';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'form-edit-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      navigate('#/' + encodeURIComponent(dt) + '/' + encodeURIComponent(name) + '/edit');
    });
    footer.appendChild(editBtn);
    form.appendChild(footer);
  }

  mountEl.appendChild(form);

  // DC5: mount WorkflowBar in view mode.
  if (mode === 'view' && workflowBar && bundle.workflow) {
    workflowBar({
      dt,
      name,
      doc,
      metaBundle: bundle,
      boot: null, // caller must pass boot if available — workflowBar receives it via closure in U9
      apiClient,
      mountEl: workflowEl,
      onChanged() {
        // Re-render the form after a workflow transition.
        renderFormView({ dt, name, mode: 'view', metaCache, apiClient, widgetRegistry, workflowBar, mountEl, navigate });
      },
    });
  }
}
