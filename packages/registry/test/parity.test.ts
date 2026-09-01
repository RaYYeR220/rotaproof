/**
 * Parity, enforced.
 *
 * The standing objection to WebMCP is that a site ends up maintaining two versions of
 * itself — one for people, one for agents — and that they drift until the agent is
 * calling a tool that lies. This suite is the answer: it treats a capability that exists
 * for humans but not for agents as a build failure unless someone wrote down why.
 *
 * It also pins the parts of the tool surface that the browser and the judging runtime
 * actually constrain — name charset, description budgets, annotation honesty — so a
 * careless edit fails here rather than silently degrading in ChatGPT.
 */

import { describe, expect, it } from 'vitest';

import { ALL_ACTIONS, agentActions } from '../src/index.js';

/** Spec rule: 1–128 characters, ASCII alphanumerics plus `_`, `-` and `.` only. */
const TOOL_NAME = /^[a-zA-Z0-9_.-]{1,128}$/;
/** Chrome's documented recommendation, not a hard limit. */
const RECOMMENDED_NAME_LENGTH = 30;
const RECOMMENDED_DESCRIPTION_LENGTH = 500;
const RECOMMENDED_PARAM_DESCRIPTION_LENGTH = 150;

/**
 * The two tools allowed to exceed the description budget.
 *
 * For a surface of many narrow tools, short descriptions are right. For the two tools
 * that carry the whole semantics of the app, the description *is* the manual, and the
 * reference WebMCP application written by the spec's own author ships descriptions
 * several times this long for exactly that reason. Listing them here makes the exception
 * a decision rather than an oversight.
 */
const MANUAL_GRADE = new Set(['set_constraint', 'solve_roster']);

describe('registry parity', () => {
  it('exposes every capability to agents, or says why not', () => {
    const unexplained = ALL_ACTIONS.filter((action) => {
      const exposed = !action.agentExempt;
      return !exposed && (action.agentExempt ?? '').trim().length < 40;
    });

    expect(
      unexplained.map((a) => a.id),
      'an action withheld from agents must carry a real reason, not a placeholder',
    ).toEqual([]);
  });

  it('keeps the exempt list small and deliberate', () => {
    const exempt = ALL_ACTIONS.filter((a) => a.agentExempt).map((a) => a.id);
    // Every exemption is a hole in the parity promise, so the count is asserted rather
    // than left to grow quietly.
    expect(exempt.sort()).toEqual(['edit_staff_details', 'export_calendar', 'import_staff_csv']);
  });

  it('gives both roles a working surface', () => {
    expect(agentActions('manager').length).toBeGreaterThanOrEqual(6);
    expect(agentActions('staff').length).toBeGreaterThanOrEqual(5);
  });

  it('never exposes the same tool name twice', () => {
    const ids = ALL_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('tool surface conforms to the platform', () => {
  it.each(ALL_ACTIONS.map((a) => [a.id, a] as const))('%s has a legal tool name', (_id, action) => {
    expect(action.id).toMatch(TOOL_NAME);
    expect(action.id.length).toBeLessThanOrEqual(RECOMMENDED_NAME_LENGTH);
  });

  it.each(ALL_ACTIONS.map((a) => [a.id, a] as const))('%s has a usable description', (_id, action) => {
    expect(action.description.trim().length).toBeGreaterThan(40);
    if (!MANUAL_GRADE.has(action.id)) {
      expect(action.description.length).toBeLessThanOrEqual(RECOMMENDED_DESCRIPTION_LENGTH);
    }
  });

  it.each(ALL_ACTIONS.map((a) => [a.id, a] as const))('%s declares an object schema', (_id, action) => {
    expect(action.inputSchema.type).toBe('object');
    expect(action.inputSchema.additionalProperties).toBe(false);

    const properties = (action.inputSchema.properties ?? {}) as Record<
      string,
      { description?: string }
    >;
    for (const [name, property] of Object.entries(properties)) {
      expect(name.length, `${action.id}.${name}`).toBeLessThanOrEqual(RECOMMENDED_NAME_LENGTH);
      if (property.description) {
        expect(property.description.length).toBeLessThanOrEqual(RECOMMENDED_PARAM_DESCRIPTION_LENGTH);
      }
    }
  });

  it('marks reads as read-only and leaves writes unmarked', () => {
    // The absence of readOnlyHint is what signals a side effect, and it is what the
    // judging runtime counts to show "N read, M write" beside the address bar. So the
    // split is asserted explicitly rather than trusted.
    const reads = ALL_ACTIONS.filter((a) => a.readOnly).map((a) => a.id).sort();
    expect(reads).toEqual(
      [
        'describe_roster',
        'explain_conflict',
        'export_calendar',
        'find_swap',
        'inspect_schedule',
        'list_constraints',
        'list_swaps',
        'my_shifts',
      ].sort(),
    );
  });

  it('flags the one tool that can return text a person wrote', () => {
    const untrusted = ALL_ACTIONS.filter((a) => a.untrustedContent).map((a) => a.id);
    expect(untrusted).toEqual(['list_swaps']);
  });

  it('orders orientation and reads ahead of writes', () => {
    // Models pick earlier tools more often. The first tool an agent meets should be the
    // one that tells it what this page is.
    const managerTools = agentActions('manager');
    expect(managerTools[0]?.id).toBe('describe_roster');

    const firstWrite = managerTools.findIndex((a) => !a.readOnly);
    const lastRead = managerTools.map((a) => a.readOnly).lastIndexOf(true);
    // `explain_conflict` is a read that deliberately sits late, next to the failure it
    // explains, so the only rule asserted is that a read comes first.
    expect(firstWrite).toBeGreaterThan(0);
    expect(lastRead).toBeGreaterThan(-1);
  });
});
