/**
 * End-to-end solver behaviour against the real HiGHS WebAssembly build.
 *
 * These are not mocked. If the solver is not actually solving, or the deletion filter is
 * not actually minimal, these fail.
 */

import highsLoader from 'highs';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  type RosterModel,
  type SolverBackend,
  HighsBackend,
  check,
  explainConflict,
  fridayConflict,
  seedRoster,
  solveRoster,
} from '../src/index.js';

let backend: SolverBackend;

beforeAll(async () => {
  backend = await HighsBackend.create(highsLoader as never);
});

describe('solving the seeded week', () => {
  it('finds a provably optimal roster', async () => {
    const model = seedRoster();
    const result = await solveRoster(model, backend);

    expect(result.status).toBe('optimal');
    expect(result.schedule).toBeDefined();
    expect(result.objective).toBeTypeOf('number');
  }, 30_000);

  it('produces a schedule the independent checker accepts', async () => {
    const model = seedRoster();
    const result = await solveRoster(model, backend);

    // The solver's own answer, re-derived from scratch by code that shares none of its
    // machinery. Disagreement here would mean the roster is wrong in a way a manager
    // would only discover on the shop floor.
    const verdict = check(model, result.schedule ?? []);
    expect(verdict.hardViolations).toEqual([]);
    expect(verdict.ok).toBe(true);
  }, 30_000);

  it('covers every shift it promised to cover', async () => {
    const model = seedRoster();
    const result = await solveRoster(model, backend);
    expect(check(model, result.schedule ?? []).stats.uncovered).toEqual([]);
  }, 30_000);

  it('honours every contracted ceiling and floor', async () => {
    const model = seedRoster();
    const result = await solveRoster(model, backend);
    const stats = check(model, result.schedule ?? []).stats;

    // S3 studies on weekdays and is capped at two shifts; S8 is a casual capped at four.
    expect(stats.perStaff.S3?.total ?? 0).toBeLessThanOrEqual(2);
    expect(stats.perStaff.S8?.total ?? 0).toBeLessThanOrEqual(4);
    // The salaried staff have guaranteed minimums that must also hold.
    expect(stats.perStaff.S1?.total ?? 0).toBeGreaterThanOrEqual(4);
    expect(stats.perStaff.S2?.total ?? 0).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it('keeps people out of the slots they said they could not work', async () => {
    const model = seedRoster();
    const result = await solveRoster(model, backend);
    const schedule = result.schedule ?? [];

    // S9 is at a wedding on Thursday and Friday; S6 never works a Friday.
    expect(schedule.some((a) => a.staff === 'S9' && (a.day === 3 || a.day === 4))).toBe(false);
    expect(schedule.some((a) => a.staff === 'S6' && a.day === 4)).toBe(false);
    // S8 is days-only while onboarding.
    expect(schedule.some((a) => a.staff === 'S8' && a.shift === 'close')).toBe(false);
  }, 30_000);

  it('is deterministic — the same rules give the same receipt', async () => {
    const first = await solveRoster(seedRoster(), backend);
    const second = await solveRoster(seedRoster(), backend);

    expect(second.receipt.modelHash).toBe(first.receipt.modelHash);
    expect(second.receipt.scheduleHash).toBe(first.receipt.scheduleHash);
    expect(second.objective).toBeCloseTo(first.objective ?? 0, 6);
  }, 45_000);

  it('prices the binding rules from the relaxation', async () => {
    const result = await solveRoster(seedRoster(), backend);
    expect(result.shadowPrices).toBeDefined();
    expect(Object.keys(result.shadowPrices ?? {}).length).toBeGreaterThan(0);
  }, 30_000);
});

describe('when the week is impossible', () => {
  /** The seed week plus the one time-off request that cannot be granted. */
  function conflicted(): RosterModel {
    const model = seedRoster();
    model.constraints.push(fridayConflict());
    return model;
  }

  it('reports infeasible rather than inventing a schedule', async () => {
    const result = await solveRoster(conflicted(), backend);
    expect(result.status).toBe('infeasible');
    expect(result.schedule).toBeUndefined();
  }, 45_000);

  it('names a conflict that actually involves the new request', async () => {
    const result = await solveRoster(conflicted(), backend);
    expect(result.conflict).toBeDefined();
    expect(result.conflict!.constraintIds).toContain('C-timeoff-S2-friday');
  }, 45_000);

  it('returns a genuinely minimal set — dropping any one rule makes it solvable', async () => {
    const model = conflicted();
    const conflict = await explainConflict(model, backend);
    expect(conflict.constraintIds.length).toBeGreaterThan(1);

    // Minimality, checked rather than asserted. Removing everything outside the reported
    // conflict must leave it still impossible, and removing any single member of it must
    // make it possible. Both halves are what "irreducible" means.
    const core: RosterModel = {
      ...model,
      constraints: model.constraints.filter(
        (c) => c.hardness !== 'hard' || conflict.constraintIds.includes(c.id),
      ),
    };
    expect((await solveRoster(core, backend, { explain: false })).status).toBe('infeasible');

    for (const id of conflict.constraintIds) {
      const without: RosterModel = {
        ...core,
        constraints: core.constraints.filter((c) => c.id !== id),
      };
      const relaxed = await solveRoster(without, backend, { explain: false });
      expect(
        relaxed.status,
        `dropping "${id}" should make the week solvable if the conflict is irreducible`,
      ).not.toBe('infeasible');
    }
  }, 90_000);

  it('names the rules that actually clash and leaves the unrelated absences out', async () => {
    const conflict = await explainConflict(conflicted(), backend);
    expect(conflict.constraintIds.sort()).toEqual(
      [
        'C-keyholder-open',
        'C-keyholder-close',
        'C-rest-11',
        'C-unavail-S6-friday',
        'C-unavail-S9-wedding',
        'C-timeoff-S2-friday',
      ].sort(),
    );

    // Four other people are also away that week for reasons that have nothing to do
    // with the clash. A group-level answer would have implicated all of them.
    expect(conflict.constraintIds).not.toContain('C-unavail-S3-weekdays');
    expect(conflict.constraintIds).not.toContain('C-unavail-S4-lectures');
    expect(conflict.constraintIds).not.toContain('C-unavail-S8-nights');
  }, 60_000);

  it('explains itself quickly enough to be interactive', async () => {
    const started = Date.now();
    const conflict = await explainConflict(conflicted(), backend);
    expect(conflict.probes).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it('offers a concrete relaxation for every rule in the conflict', async () => {
    const conflict = await explainConflict(conflicted(), backend);
    expect(conflict.suggestions.length).toBe(conflict.constraintIds.length);
    for (const suggestion of conflict.suggestions) {
      expect(suggestion.effect.length).toBeGreaterThan(10);
    }
  }, 45_000);

  it('becomes solvable again once the request is withdrawn', async () => {
    const model = conflicted();
    model.constraints = model.constraints.filter((c) => c.id !== 'C-timeoff-S2-friday');
    const result = await solveRoster(model, backend);
    expect(result.status).toBe('optimal');
  }, 30_000);
});

describe('negative control', () => {
  /**
   * A model that must fail. Without it a green suite proves only that nothing was
   * checked: if this ever reports optimal, the infeasibility path is not being exercised
   * and every other passing test above is suspect.
   */
  it('cannot staff a shift with more people than exist', async () => {
    const model = seedRoster();
    model.constraints.push({
      id: 'C-impossible',
      kind: 'coverage',
      label: 'Eleven people on the Monday open',
      hardness: 'hard',
      group: 'impossible',
      day: 0,
      shift: 'open',
      min: 11, // the whole team is ten people, so this cannot be met by any schedule
    });

    const result = await solveRoster(model, backend, { explain: false });
    expect(result.status).toBe('infeasible');
  }, 30_000);
});
