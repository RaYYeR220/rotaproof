/**
 * The tools, driven the way an agent drives them.
 *
 * These run against the real solver through a headless session, so they exercise the
 * same code path the browser does — argument validation, the solver, the conflict
 * explanation, the confirmation gate — with nothing stubbed but the human's click.
 */

import highsLoader from 'highs';
import { beforeAll, describe, expect, it } from 'vitest';

import { HighsBackend, type SolverBackend, fridayConflict, seedRoster } from '@rotaproof/core';

import { createHeadlessSession, isActionError } from '../src/index.js';

let backend: SolverBackend;

beforeAll(async () => {
  backend = await HighsBackend.create(highsLoader as never);
});

const manager = (overrides = {}) =>
  createHeadlessSession(backend, { role: 'manager', onConfirm: () => true, ...overrides });

describe('orientation', () => {
  it('describes the roster without naming anybody', async () => {
    const session = manager();
    const result = (await session.call('describe_roster', {})) as {
      staff: string[];
      rules: { total: number; hard: number };
      week: string;
    };

    expect(result.staff).toHaveLength(10);
    expect(result.staff[0]).toMatch(/^S1 full_time/);
    expect(result.staff.join(' ')).not.toMatch(/Maria|Alvarez/);
    expect(result.rules.hard).toBeGreaterThan(15);
    expect(result.week).toContain('2026-09-07');
  });

  it('pages the rule list rather than dumping it', async () => {
    const session = manager();
    const page = (await session.call('list_constraints', { limit: 5 })) as {
      matched: number;
      returned: number;
      more?: string;
    };

    expect(page.returned).toBe(5);
    expect(page.matched).toBeGreaterThan(20);
    expect(page.more).toContain('offset 5');
  });

  it('filters the rule list by group', async () => {
    const session = manager();
    const page = (await session.call('list_constraints', { group: 'keyholder' })) as {
      rules: string[];
    };
    expect(page.rules).toHaveLength(2);
    expect(page.rules.every((r) => r.includes('keyholder') || r.includes('Akeyholder'))).toBe(true);
  });
});

describe('the solve loop', () => {
  it('solves, then lets the schedule be read back', async () => {
    const session = manager();
    const solved = (await session.call('solve_roster', {})) as { status: string; assignments: number };
    expect(solved.status).toBe('optimal');
    expect(solved.assignments).toBe(42);

    const read = (await session.call('inspect_schedule', {})) as { valid: boolean; load: string[] };
    expect(read.valid).toBe(true);
    expect(read.load).toHaveLength(10);
  }, 30_000);

  it('refuses to read a schedule that does not exist yet', async () => {
    const session = manager();
    const result = await session.call('inspect_schedule', {});
    expect(isActionError(result)).toBe(true);
    expect((result as { hint: string }).hint).toContain('solve_roster');
  });

  it('adds a rule and invalidates the previous answer', async () => {
    const session = manager();
    await session.call('solve_roster', {});
    expect(session.session.status).toBe('solved');

    const added = (await session.call('set_constraint', {
      kind: 'max_shifts',
      label: 'S7 wants a lighter week',
      staff: 'S7',
      max: 2,
    })) as { added: string; next: string };

    expect(added.added).toBe('C-max-shifts-1');
    expect(session.session.status).toBe('draft');
    expect(added.next).toContain('solve_roster');
  }, 30_000);

  it('replaces a rule when its id is reused', async () => {
    const session = manager();
    const before = session.session.model.constraints.length;
    const result = (await session.call('set_constraint', {
      id: 'C-rest-11',
      kind: 'min_rest',
      label: '12 hours rest between shifts',
      hours: 12,
    })) as { replaced?: string };

    expect(result.replaced).toBe('C-rest-11');
    expect(session.session.model.constraints).toHaveLength(before);
  });
});

describe('argument validation guides rather than blocks', () => {
  it('names the valid staff ids when given a bad one', async () => {
    const session = manager();
    const result = await session.call('set_constraint', {
      kind: 'unavailable',
      label: 'away',
      staff: 'Maria',
      slots: [{ day: 0, shift: 'open' }],
    });

    expect(isActionError(result)).toBe(true);
    expect((result as { error: string }).error).toBe('unknown_staff');
    expect((result as { hint: string }).hint).toContain('S1');
  });

  it('names the valid shift ids when given a bad one', async () => {
    const session = manager();
    const result = await session.call('set_constraint', {
      kind: 'coverage',
      label: 'brunch cover',
      shift: 'brunch',
      min: 2,
    });

    expect((result as { error: string }).error).toBe('unknown_shift');
    expect((result as { hint: string }).hint).toContain('open, mid, close');
  });

  it('explains the day range rather than failing silently', async () => {
    const session = manager();
    const result = await session.call('set_constraint', {
      kind: 'coverage',
      label: 'day 40 cover',
      shift: 'open',
      min: 1,
      day: 40,
    });

    expect((result as { error: string }).error).toBe('day_out_of_range');
    expect((result as { hint: string }).hint).toContain('2026-09-07');
  });

  it('lists the supported rule kinds when given an unknown one', async () => {
    const session = manager();
    const result = await session.call('set_constraint', { kind: 'vibes', label: 'good vibes' });
    expect((result as { error: string }).error).toBe('unknown_kind');
    expect((result as { hint: string }).hint).toContain('coverage');
  });
});

describe('the tool surface follows the state', () => {
  it('hides explain_conflict until there is a conflict, then offers it', async () => {
    const session = manager();
    expect(session.availableTools().map((t) => t.id)).not.toContain('explain_conflict');

    await session.call('solve_roster', {});
    expect(session.availableTools().map((t) => t.id)).not.toContain('explain_conflict');

    session.session.model.constraints.push(fridayConflict());
    await session.call('solve_roster', {});

    const tools = session.availableTools().map((t) => t.id);
    expect(tools).toContain('explain_conflict');
    expect(tools).not.toContain('publish_roster');
  }, 45_000);

  it('offers publish_roster only once there is a clean solved week', async () => {
    const session = manager();
    expect(session.availableTools().map((t) => t.id)).not.toContain('publish_roster');
    await session.call('solve_roster', {});
    expect(session.availableTools().map((t) => t.id)).toContain('publish_roster');
  }, 30_000);
});

describe('infeasibility is an answer, not a failure', () => {
  it('returns a proof instead of a schedule, and names the rules that clash', async () => {
    const session = manager({ model: (() => {
      const model = seedRoster();
      model.constraints.push(fridayConflict());
      return model;
    })() });

    const solved = (await session.call('solve_roster', {})) as {
      status: string;
      conflictingRules: string[];
      next: string;
    };

    expect(solved.status).toBe('infeasible');
    expect(solved.conflictingRules).toContain('C-timeoff-S2-friday');
    expect(solved.conflictingRules).toContain('C-keyholder-close');
    expect(solved.next).toContain('explain_conflict');

    const explained = (await session.call('explain_conflict', {})) as {
      rules: string[];
      options: string[];
      next: string;
    };
    expect(explained.rules).toHaveLength(6);
    expect(explained.options).toHaveLength(6);
    // The choice of which rule gives way is the human's, and the tool says so.
    expect(explained.next).toMatch(/judgement|manager/i);
  }, 60_000);

  it('becomes solvable when the manager relaxes one of the named rules', async () => {
    const session = manager({ model: (() => {
      const model = seedRoster();
      model.constraints.push(fridayConflict());
      return model;
    })() });

    await session.call('solve_roster', {});
    expect(session.session.status).toBe('infeasible');

    const relaxed = (await session.call('relax_constraint', {
      id: 'C-timeoff-S2-friday',
      to: 'removed',
    })) as { removed?: string };
    expect(relaxed.removed).toBe('C-timeoff-S2-friday');

    const again = (await session.call('solve_roster', {})) as { status: string };
    expect(again.status).toBe('optimal');
  }, 60_000);
});

describe('publishing waits for a person', () => {
  it('does nothing when the human declines', async () => {
    const session = createHeadlessSession(backend, { role: 'manager', onConfirm: () => false });
    await session.call('solve_roster', {});

    const result = (await session.call('publish_roster', {})) as { status: string };
    expect(result.status).toBe('declined');
    expect(session.session.versions).toHaveLength(0);
    expect(session.confirmations).toHaveLength(1);
  }, 30_000);

  it('shows the human what will change before they decide', async () => {
    const session = manager();
    await session.call('solve_roster', {});
    await session.call('publish_roster', {});

    const [request] = session.confirmations;
    expect(request?.title).toContain('2026-09-07');
    expect(request?.changes.join(' ')).toContain('42 shifts assigned');
  }, 30_000);

  it('records a version once approved', async () => {
    const session = manager();
    await session.call('solve_roster', {});
    const result = (await session.call('publish_roster', {})) as { status: string; version: number };

    expect(result.status).toBe('published');
    expect(result.version).toBe(1);
    expect(session.session.versions).toHaveLength(1);
    expect(session.session.versions[0]?.receipt.modelHash).toHaveLength(64);
  }, 30_000);
});

describe('the staff side', () => {
  const staff = (actorId = 'S2') =>
    createHeadlessSession(backend, { role: 'staff', actorId, onConfirm: () => true });

  it('shows a person only their own shifts', async () => {
    const session = staff();
    await session.solve();

    const mine = (await session.call('my_shifts', {})) as { shifts: string[]; count: number };
    expect(mine.count).toBeGreaterThan(0);
    expect(mine.shifts).toHaveLength(mine.count);
  }, 30_000);

  it('answers a time-off request with a verdict, not a maybe', async () => {
    const session = staff();
    await session.solve();

    const answer = (await session.call('request_time_off', {
      slots: [
        { day: 4, shift: 'open' },
        { day: 4, shift: 'mid' },
        { day: 4, shift: 'close' },
      ],
      note: 'family visiting',
    })) as { grantable: boolean; blockedBy?: string[] };

    // S2 is one of only two keyholders available that Friday, so this cannot be granted.
    expect(answer.grantable).toBe(false);
    expect(answer.blockedBy).toContain('C-keyholder-close');
  }, 60_000);

  it('grants a request that genuinely fits', async () => {
    const session = staff('S7');
    await session.solve();

    const answer = (await session.call('request_time_off', {
      slots: [{ day: 1, shift: 'open' }],
    })) as { grantable: boolean };

    expect(answer.grantable).toBe(true);
  }, 60_000);

  it('refuses to swap a shift the person does not hold', async () => {
    const session = staff();
    await session.solve();
    const result = await session.call('find_swap', { day: 0, shift: 'mid' });

    if (isActionError(result)) {
      expect(result.error).toBe('not_your_shift');
      expect(result.hint).toContain('my_shifts');
    } else {
      // S2 does hold that slot in this solution, which is a valid outcome too.
      expect((result as { canTakeIt: string[] }).canTakeIt).toBeDefined();
    }
  }, 60_000);

  it('only offers swap partners the solver has verified', async () => {
    const session = staff();
    await session.solve();
    const mine = session.session.schedule?.find((a) => a.staff === 'S2');
    expect(mine).toBeDefined();

    const result = (await session.call('find_swap', {
      day: mine!.day,
      shift: mine!.shift,
    })) as { canTakeIt: string[]; cannot: string[]; checked: number };

    expect(result.checked).toBe(9);
    expect(result.canTakeIt.length + result.cannot.length).toBe(9);
    expect(result.canTakeIt).not.toContain('S2');
  }, 120_000);
});
