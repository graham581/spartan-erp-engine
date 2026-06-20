/**
 * job.hooks.js — condition hooks for the Job workflow's 3 payment gates.
 *
 * Import this module for its side-effect (WORKFLOW_HOOKS.set calls).
 * Every consumer that exercises Job transitions must import this file
 * so the gates are registered before any transition() call.
 *
 * Keys must match the transition row `action` values in job.workflow.seed.js
 * character-for-character — a key typo silently un-gates a money transition.
 *
 * Guard text lives on the transition row (`guard` column), not here.
 * Condition signature: (doc, ctx, store) => boolean — extra args are unused
 * for these stub gates but the slot is open for future cross-doc reads (e.g.
 * reading a payment ledger via `store` when Xero integration lands).
 */

import { WORKFLOW_HOOKS } from '../../workflow/hooks.js';

// Gate 1 — 5% deposit must clear before the site measure visit is scheduled.
WORKFLOW_HOOKS.set('Job::start_measure', {
  condition: (doc) => Number(doc.deposit_pct) >= 5,
});

// Gate 2 — 45% of contract must clear before final sign-off.
WORKFLOW_HOOKS.set('Job::start_signoff', {
  condition: (doc) => Number(doc.balance_pct) >= 45,
});

// Gate 3 — manufacturing payment must clear before scheduling the install.
// (F-3 LEAD ruling: gate sits on to_scheduling, not to_manufacturing.)
WORKFLOW_HOOKS.set('Job::to_scheduling', {
  condition: (doc) => doc.mfg_paid === true,
});
