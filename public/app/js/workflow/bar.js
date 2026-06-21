/**
 * WorkflowBar — U10
 *
 * Exports:
 *   fireableTransitions(workflow, currentState, userRoles) -> transition[]   (PURE)
 *   renderWorkflowBar({ dt, name, doc, metaBundle, boot, apiClient, mountEl, onChanged })   (DOM)
 *
 * N1 (load-bearing): t.roles === undefined means open to ALL users, not no-one.
 */

/**
 * Return the subset of workflow transitions that are fireable from currentState
 * by a user with the given roles.
 *
 * N1: a transition with roles === undefined is open to every user regardless of roles.
 *
 * @param {{ stateField: string, states: string[], transitions: Array<{from,to,action,roles?}> }} workflow
 * @param {string} currentState
 * @param {string[]} userRoles
 * @returns {Array<{from,to,action,roles?}>}
 */
export function fireableTransitions(workflow, currentState, userRoles) {
  if (!workflow || !workflow.transitions) return [];
  return workflow.transitions.filter((t) => {
    if (t.from !== currentState) return false;
    // N1: undefined roles = open to all
    if (t.roles === undefined) return true;
    return t.roles.some((r) => userRoles.includes(r));
  });
}

/**
 * Mount a workflow action bar into mountEl.
 *
 * DC2: current state = doc[workflow.stateField]
 * DC3: button click → apiClient.action(dt, name, t.action) then onChanged()
 * DC4: submit/cancel additionally gated by capabilities.submit/cancel
 * DC5: 409 StateError → surface engine error.message inline verbatim
 * DC6: no fireable transitions → render nothing
 *
 * @param {{
 *   dt: string,
 *   name: string,
 *   doc: object,
 *   metaBundle: { workflow: object|null, capabilities: object },
 *   boot: { roles: string[] },
 *   apiClient: object,
 *   mountEl: HTMLElement,
 *   onChanged: () => void,
 * }} params
 */
export function renderWorkflowBar({
  dt,
  name,
  doc,
  metaBundle,
  boot,
  apiClient,
  mountEl,
  onChanged,
}) {
  // Clear any prior render
  mountEl.innerHTML = '';

  const workflow = metaBundle.workflow;
  // DC6: no workflow → nothing
  if (!workflow) return;

  const currentState = doc[workflow.stateField];
  const userRoles = (boot && boot.roles) ? boot.roles : [];
  const capabilities = metaBundle.capabilities || {};

  const fireable = fireableTransitions(workflow, currentState, userRoles);

  // DC4: filter submit/cancel by capabilities
  const buttons = fireable.filter((t) => {
    if (t.action === 'submit') return !!capabilities.submit;
    if (t.action === 'cancel') return !!capabilities.cancel;
    return true;
  });

  // DC6: no buttons to show → nothing
  if (buttons.length === 0) return;

  const bar = document.createElement('div');
  bar.className = 'workflow-bar';

  // Inline error element for DC5
  const errEl = document.createElement('span');
  errEl.className = 'workflow-bar-error';
  errEl.style.display = 'none';
  errEl.style.color = 'red';
  errEl.style.marginLeft = '1em';

  buttons.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t.label || t.action;
    btn.dataset.action = t.action;

    btn.addEventListener('click', async () => {
      errEl.style.display = 'none';
      errEl.textContent = '';
      btn.disabled = true;
      try {
        await apiClient.action(dt, name, t.action);
        onChanged();
      } catch (err) {
        // DC5: 409 StateError → surface engine error verbatim
        if (err && err.status === 409 && err.body && err.body.error) {
          errEl.textContent = err.body.error;
          errEl.style.display = 'inline';
        } else {
          errEl.textContent = err.message || String(err);
          errEl.style.display = 'inline';
        }
        btn.disabled = false;
      }
    });

    bar.appendChild(btn);
  });

  bar.appendChild(errEl);
  mountEl.appendChild(bar);
}
