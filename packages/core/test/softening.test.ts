/**
 * Softening a rule has to actually soften it.
 *
 * Five constraint kinds used to compile to hard rows whatever their `hardness` said, which
 * made `relax_constraint … to: "soft"` a no-op for exactly the rules an infeasible week
 * most often turns on. Worse, a soft rule could then make a week infeasible while being
 * invisible to the conflict explanation, because feasibility probes drop soft rules — so
 * the page would name every hard rule in the model as the culprit.
 *
 * These tests pin the behaviour for every kind, so the recovery path the tools advertise
 * is the recovery path that exists.
 */

import highsLoader from 'highs';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  type Constraint,
  type RosterModel,
  type SolverBackend,
  ASSIGNMENT_COST,
  HighsBackend,
  check,
  compileRoster,
  explainConflict,
  fridayConflict,
  seedRoster,
  solveRoster,
} from '../src/index.js';

let backend: SolverBackend;

beforeAll(async () => {
  backend = await HighsBackend.create(highsLoader as never);
});

function soften(model: RosterModel, id: string, weight = 5): RosterModel {
  return {
    ...model,
    constraints: model.constraints.map((c) =>
      c.id === id ? ({ ...c, hardness: 'soft', weight } as Constraint) : c,
    ),
  };
}

const SOFTENABLE = [
  'C-one-per-day',
  'C-rest-11',
  'C-max-consecutive',
  'C-trainee-supervision',
  'C-cover-open',
  'C-contract-S3',
  'C-min-S1',
  'C-unavail-S6-friday',
];

describe('a soft rule is genuinely soft', () => {
  it.each(SOFTENABLE)('%s emits no unrelaxable row once softened', (id) => {
    const compiled = compileRoster(soften(seedRoster(), id));

    // A soft rule may still emit rows, but each must carry a penalty variable, so none of
    // them can make the model infeasible on its own.
    const unrelaxable = compiled.problem.rows.filter(
      (row) => row.source === id && !row.coeffs.some(([name]) => name.startsWith('pen_')),
    );
    expect(unrelaxable, `${id} still emits ${unrelaxable.length} unrelaxable rows`).toEqual([]);
  });

  it.each(SOFTENABLE)('%s still costs something once softened', (id) => {
    // Softening must not silently discard the rule. Some kinds pay through a penalty
    // variable, others through a coefficient on an assignment binary; either way the
    // objective has to differ from the model with the rule removed altogether.
    const softened = compileRoster(soften(seedRoster(), id));
    const removed = compileRoster({
      ...seedRoster(),
      constraints: seedRoster().constraints.filter((c) => c.id !== id),
    });

    const cost = (problem: ReturnType<typeof compileRoster>) =>
      problem.problem.vars.reduce((sum, v) => sum + Math.abs(v.obj ?? 0), 0) +
      problem.objectiveOffset;

    expect(cost(softened)).toBeGreaterThan(cost(removed));
  });

  it.each(SOFTENABLE)('%s disappears entirely from a feasibility probe', (id) => {
    const softened = soften(seedRoster(), id);
    const probe = compileRoster(softened, { feasibilityOnly: true });
    expect([...probe.rowSources.values()].filter((source) => source === id)).toEqual([]);
  });
});

describe('the documented recovery path works', () => {
  /** The seed plus the request that makes the week impossible. */
  function conflicted(): RosterModel {
    const model = seedRoster();
    model.constraints.push(fridayConflict());
    return model;
  }

  it('softening the keyholder rule makes the impossible week solvable', async () => {
    const result = await solveRoster(soften(conflicted(), 'C-keyholder-close'), backend, {
      explain: false,
    });
    expect(result.status).toBe('optimal');
  }, 45_000);

  it('and the resulting schedule pays for the breach rather than hiding it', async () => {
    const model = soften(conflicted(), 'C-keyholder-close', 5);
    const result = await solveRoster(model, backend, { explain: false });
    const verdict = check(model, result.schedule ?? []);

    expect(verdict.ok).toBe(true);
    expect(verdict.softViolations.some((v) => v.constraintId === 'C-keyholder-close')).toBe(true);
    expect(verdict.softPenalty).toBeGreaterThan(0);
  }, 45_000);

  /**
   * Minimality within the reported set is a weaker statement than it sounds, and this is
   * the case that shows it. Every one of the six is load-bearing, but relaxing the rest
   * rule alone still leaves the week impossible, because `one_shift_per_day` independently
   * forbids the same Friday double shift and was ruled out of the conflict as "not to
   * blame". Telling a manager to shorten the rest period would have wasted their time.
   */
  it('says which single relaxations are actually enough, and which are not', async () => {
    const model = conflicted();
    const conflict = await explainConflict(model, backend);

    const enough = conflict.suggestions.filter((s) => s.sufficient).map((s) => s.constraintId);
    const notEnough = conflict.suggestions.filter((s) => !s.sufficient).map((s) => s.constraintId);

    expect(notEnough).toEqual(['C-rest-11']);
    expect(enough).toHaveLength(5);
    expect(conflict.narrative).toContain('5 of the 6');
  }, 120_000);

  it('and every claim it makes about sufficiency is true of the real model', async () => {
    const model = conflicted();
    const conflict = await explainConflict(model, backend);

    for (const option of conflict.suggestions) {
      const relaxed = await solveRoster(soften(model, option.constraintId), backend, {
        explain: false,
      });
      const solvable = relaxed.status !== 'infeasible';
      expect(
        solvable,
        `${option.constraintId} was reported sufficient=${option.sufficient} but relaxing it gives ${relaxed.status}`,
      ).toBe(option.sufficient);
    }
  }, 120_000);

  it('reports nothing inconclusive when every probe finishes', async () => {
    const conflict = await explainConflict(conflicted(), backend);
    expect(conflict.inconclusive).toBe(0);
    expect(conflict.narrative).not.toContain('did not finish');
  }, 60_000);
});

describe('a soft rule can no longer produce a nonsense explanation', () => {
  /**
   * Previously a soft `pair` compiled to hard equality rows. It could then make the week
   * infeasible while being excluded from every probe, so the filter blamed all thirty hard
   * rules and asserted each was load-bearing.
   */
  it('does not make the week infeasible at all', async () => {
    const model = seedRoster();
    model.constraints.push({
      id: 'C-soft-pair',
      kind: 'pair',
      label: 'S1 and S3 would like to work together',
      hardness: 'soft',
      weight: 2,
      group: 'supervision',
      a: 'S1',
      b: 'S3',
    });

    const result = await solveRoster(model, backend, { explain: false });
    expect(result.status).toBe('optimal');
  }, 45_000);
});

describe('objective and reported soft cost are the same quantity', () => {
  /**
   * The solver minimises one number and the checker reports another. If they are not the
   * same thing, nothing independently verifies the cost the tools quote — so this pins the
   * identity: objective = soft penalty + a flat charge per assignment.
   */
  it('agrees on the seeded week', async () => {
    const model = seedRoster();
    const result = await solveRoster(model, backend);
    const verdict = check(model, result.schedule ?? []);

    const expected = verdict.softPenalty + ASSIGNMENT_COST * (result.schedule?.length ?? 0);
    expect(result.objective).toBeCloseTo(expected, 4);
  }, 45_000);

  it('agrees when a ledger is carried', async () => {
    const model = seedRoster();
    const ledger = { history: { S7: { total: 6, nights: 1, weekends: 4 } } };
    const result = await solveRoster(model, backend, { ledger });
    const verdict = check(model, result.schedule ?? [], ledger);

    const expected = verdict.softPenalty + ASSIGNMENT_COST * (result.schedule?.length ?? 0);
    expect(result.objective).toBeCloseTo(expected, 4);
  }, 45_000);

  it('agrees when a hard rule has been softened and is being broken', async () => {
    const model = soften(seedRoster(), 'C-pref-S1-no-late-mondays', 3);
    const result = await solveRoster(model, backend);
    const verdict = check(model, result.schedule ?? []);

    const expected = verdict.softPenalty + ASSIGNMENT_COST * (result.schedule?.length ?? 0);
    expect(result.objective).toBeCloseTo(expected, 4);
  }, 45_000);
});

describe('the checker and the compiler agree about consecutive days', () => {
  /**
   * The compiler used to bound *shifts* in a window while the checker counted *days* in a
   * run. They only coincide when something else forbids a double shift, so a roster using
   * `max_consecutive_days` on its own got false "no schedule exists" answers.
   */
  it('allows three shifts in one day when only the consecutive-day rule is in force', async () => {
    const model: RosterModel = {
      horizon: { startDate: '2026-09-07', days: 3 },
      shiftTypes: [
        { id: 'a', label: 'A', startMinutes: 0, durationMinutes: 60 },
        { id: 'b', label: 'B', startMinutes: 120, durationMinutes: 60 },
        { id: 'c', label: 'C', startMinutes: 240, durationMinutes: 60 },
      ],
      skills: [],
      staff: [{ id: 'S1', name: 'Solo', skills: [], employment: 'full_time' }],
      constraints: [
        {
          id: 'C-cons',
          kind: 'max_consecutive_days',
          label: 'at most 2 days in a row',
          hardness: 'hard',
          staff: '*',
          max: 2,
        },
        {
          id: 'C-cover-a',
          kind: 'coverage',
          label: 'someone on A day 0',
          hardness: 'hard',
          day: 0,
          shift: 'a',
          min: 1,
        },
        {
          id: 'C-cover-b',
          kind: 'coverage',
          label: 'someone on B day 0',
          hardness: 'hard',
          day: 0,
          shift: 'b',
          min: 1,
        },
        {
          id: 'C-cover-c',
          kind: 'coverage',
          label: 'someone on C day 0',
          hardness: 'hard',
          day: 0,
          shift: 'c',
          min: 1,
        },
      ],
    };

    // One person, three shifts, all on the same day. That is one consecutive day.
    expect(check(model, [
      { day: 0, shift: 'a', staff: 'S1' },
      { day: 0, shift: 'b', staff: 'S1' },
      { day: 0, shift: 'c', staff: 'S1' },
    ]).ok).toBe(true);

    const result = await solveRoster(model, backend, { explain: false });
    expect(result.status).toBe('optimal');
  }, 30_000);
});

describe('a soft ceiling is respected', () => {
  it('charges for overshooting a soft coverage maximum, and the solver avoids it', async () => {
    const model: RosterModel = {
      horizon: { startDate: '2026-09-07', days: 1 },
      shiftTypes: [{ id: 'a', label: 'A', startMinutes: 0, durationMinutes: 60 }],
      skills: [],
      staff: [
        { id: 'S1', name: 'One', skills: [], employment: 'casual' },
        { id: 'S2', name: 'Two', skills: [], employment: 'casual' },
        { id: 'S3', name: 'Three', skills: [], employment: 'casual' },
      ],
      constraints: [
        {
          id: 'C-floor',
          kind: 'min_shifts',
          label: 'everyone works',
          hardness: 'hard',
          staff: '*',
          min: 1,
        },
        {
          id: 'C-ceiling',
          kind: 'coverage',
          label: 'ideally at most one on A',
          hardness: 'soft',
          weight: 4,
          day: 0,
          shift: 'a',
          min: 0,
          max: 1,
        },
      ],
    };

    const compiled = compileRoster(model);
    // Both sides of a soft range have to be priced; the ceiling used to be dropped.
    expect(compiled.problem.vars.some((v) => v.name.includes('over_d0'))).toBe(true);

    const result = await solveRoster(model, backend);
    const verdict = check(model, result.schedule ?? []);
    expect(verdict.softViolations.some((v) => v.constraintId === 'C-ceiling')).toBe(true);
    expect(result.objective).toBeCloseTo(
      verdict.softPenalty + ASSIGNMENT_COST * (result.schedule?.length ?? 0),
      4,
    );
  }, 30_000);
});
