/**
 * ListView — renders a paginated list for a given doctype.
 * Pure frontend; no engine src/ import.
 * Frozen interface per docs/workorder-desk-ui.md §U5.
 */

import { ForbiddenError, NotFoundError } from '../api/client.js';

/**
 * pickListColumns(fields) — pure helper, unit-testable.
 *
 * Returns the first ≤5 non-Table fields from `fields`, preserving
 * the array order (which reflects the idx ordering from meta).
 *
 * @param {Array<{fieldname:string, fieldtype:string}>} fields
 * @returns {Array<{fieldname:string, fieldtype:string}>}
 */
export function pickListColumns(fields) {
  if (!Array.isArray(fields)) return [];
  const cols = [];
  for (const f of fields) {
    if (f.fieldtype === 'Table') continue;
    cols.push(f);
    if (cols.length >= 5) break;
  }
  return cols;
}

/**
 * renderListView({ dt, metaCache, apiClient, mountEl, navigate })
 *
 * DC1  Columns from meta.fields — first ~5 non-Table, idx order.
 * DC2  Always passes order_by to apiClient.list (N2).
 * DC3  Row click → navigate('#/<dt>/<encodeURIComponent(row.name)>').
 * DC4  "New" button iff bundle.capabilities.create.
 * DC5  issingle doctype → one-line notice, no collection fetch.
 * DC6  ForbiddenError / NotFoundError from list → inline typed error.
 */
export async function renderListView({ dt, metaCache, apiClient, mountEl, navigate }) {
  mountEl.innerHTML = '';

  // Loading placeholder
  const loading = document.createElement('p');
  loading.textContent = 'Loading…';
  mountEl.appendChild(loading);

  let bundle;
  try {
    bundle = await metaCache.meta(dt);
  } catch (err) {
    mountEl.innerHTML = '';
    const msg = document.createElement('p');
    msg.className = 'desk-error';
    msg.textContent = `Failed to load meta for ${dt}: ${err.message}`;
    mountEl.appendChild(msg);
    return;
  }

  // DC5 — issingle guard (router should have prevented this, but be defensive)
  if (bundle.meta && bundle.meta.issingle) {
    mountEl.innerHTML = '';
    const notice = document.createElement('p');
    notice.textContent = 'Single doctype — no list view (v1)';
    mountEl.appendChild(notice);
    return;
  }

  // DC1 — pick display columns from meta.fields
  const cols = pickListColumns(bundle.meta.fields || []);

  // DC2 — choose order_by: prefer 'modified' if present, else first column, else 'name'
  const fieldNames = (bundle.meta.fields || []).map((f) => f.fieldname);
  const orderBy = fieldNames.includes('modified')
    ? 'modified'
    : (cols[0] && cols[0].fieldname) || 'name';

  let rows;
  try {
    rows = await apiClient.list(dt, { order_by: orderBy, order: 'desc', limit: 50 });
  } catch (err) {
    mountEl.innerHTML = '';
    const msg = document.createElement('p');
    msg.className = 'desk-error';
    // DC6 — typed error message inline
    if (err instanceof ForbiddenError) {
      msg.textContent = `Access denied: you do not have permission to list ${dt}.`;
    } else if (err instanceof NotFoundError) {
      msg.textContent = `Doctype not found: ${dt}.`;
    } else {
      msg.textContent = `Error loading ${dt}: ${err.message}`;
    }
    mountEl.appendChild(msg);
    return;
  }

  // Build the view
  mountEl.innerHTML = '';

  // Header row: title + optional "New" button
  const header = document.createElement('div');
  header.className = 'desk-list-header';

  const title = document.createElement('h2');
  title.textContent = dt;
  header.appendChild(title);

  // DC4 — "New" button iff capabilities.create
  if (bundle.capabilities && bundle.capabilities.create) {
    const newBtn = document.createElement('button');
    newBtn.className = 'desk-btn desk-btn-primary';
    newBtn.textContent = 'New';
    newBtn.addEventListener('click', () => navigate('#/' + dt + '/new'));
    header.appendChild(newBtn);
  }

  mountEl.appendChild(header);

  if (!rows || rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'desk-list-empty';
    empty.textContent = 'No records found.';
    mountEl.appendChild(empty);
    return;
  }

  // Table
  const table = document.createElement('table');
  table.className = 'desk-list-table';

  // thead
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of cols) {
    const th = document.createElement('th');
    th.textContent = col.label || col.fieldname;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // tbody — DC3 row click → navigate
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = 'desk-list-row';
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () =>
      navigate('#/' + dt + '/' + encodeURIComponent(row.name))
    );
    for (const col of cols) {
      const td = document.createElement('td');
      const val = row[col.fieldname];
      td.textContent = val == null ? '' : String(val);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  mountEl.appendChild(table);
}
