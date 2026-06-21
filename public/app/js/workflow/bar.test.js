import { describe, it, expect } from 'vitest';
import { fireableTransitions } from './bar.js';

// Pure unit tests for fireableTransitions only.
// DOM render + 409 surfacing are verified by the live proof (jsdom not installed).

const makeWorkflow = (transitions) => ({
  stateField: 'status',
  states: ['Open', 'Won', 'Lost'],
  transitions,
});

describe('fireableTransitions', () => {
  it('returns the matching transition when user has the required role', () => {
    const workflow = makeWorkflow([
      { from: 'Open', to: 'Won', action: 'win', roles: ['sales'] },
    ]);
    const result = fireableTransitions(workflow, 'Open', ['sales']);
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('win');
  });

  it('returns empty when user does not have the required role', () => {
    const workflow = makeWorkflow([
      { from: 'Open', to: 'Won', action: 'win', roles: ['sales'] },
    ]);
    const result = fireableTransitions(workflow, 'Open', ['ops']);
    expect(result).toHaveLength(0);
  });

  it('N1 guard: roles===undefined means open to ALL — returned for any roles', () => {
    const workflow = makeWorkflow([
      { from: 'Open', to: 'Won', action: 'win' }, // no roles key at all
    ]);
    expect(fireableTransitions(workflow, 'Open', ['ops'])).toHaveLength(1);
    expect(fireableTransitions(workflow, 'Open', ['sales'])).toHaveLength(1);
    expect(fireableTransitions(workflow, 'Open', [])).toHaveLength(1);
  });

  it('N1 guard: roles===undefined transition is included even with empty roles array', () => {
    const workflow = makeWorkflow([
      { from: 'Open', to: 'Won', action: 'win', roles: undefined },
    ]);
    const result = fireableTransitions(workflow, 'Open', []);
    expect(result).toHaveLength(1);
  });

  it('excludes a transition whose from !== currentState', () => {
    const workflow = makeWorkflow([
      { from: 'Won', to: 'Lost', action: 'lose', roles: ['sales'] },
    ]);
    const result = fireableTransitions(workflow, 'Open', ['sales']);
    expect(result).toHaveLength(0);
  });

  it('returns only the transitions that match current state (mixed set)', () => {
    const workflow = makeWorkflow([
      { from: 'Open', to: 'Won', action: 'win', roles: ['sales'] },
      { from: 'Open', to: 'Lost', action: 'lose', roles: ['sales'] },
      { from: 'Won', to: 'Lost', action: 'abandon', roles: ['admin'] },
    ]);
    const result = fireableTransitions(workflow, 'Open', ['sales']);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.action)).toEqual(expect.arrayContaining(['win', 'lose']));
  });

  it('returns empty when workflow has no transitions', () => {
    const workflow = makeWorkflow([]);
    expect(fireableTransitions(workflow, 'Open', ['sales'])).toHaveLength(0);
  });

  it('returns empty when workflow is null', () => {
    expect(fireableTransitions(null, 'Open', ['sales'])).toHaveLength(0);
  });
});
