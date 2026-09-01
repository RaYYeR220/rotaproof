import { describe, expect, it } from 'vitest';

import {
  type RosterModel,
  ASSIGNMENT_COST,
  compileRoster,
  scheduleFromSolution,
  seedRoster,
  shadowPricesByConstraint,
  toLpFormat,
} from '../src/index.js';

function twoByTwo(): RosterModel {
  return {
    horizon: { startDate: '2026-09-07', days: 2 },
    shiftTypes: [
      { id: 'day', label: 'Day', startMinutes: 8 * 60, durationMinutes: 8 * 60 },
      { id: 'night', label: 'Night', startMinutes: 22 * 60, durationMinutes: 8 * 60 },
    ],
    skills: ['keyholder'],
    staff: [
      { id: 'S1', name: 'Alpha', skills: ['keyholder'], employment: 'full_time' },
      { id: 'S2', name: 'Beta', skills: [], employment: 'casual' },
    ],
    constraints: [],
  };
}

describe('compileRoster', () => {
  it('creates one binary per person, day and shift', () => {
    const compiled = compileRoster(twoByTwo());
    // 2 staff × 2 days × 2 shifts
    expect(compiled.assignmentVars.size).toBe(8);
    expect(compiled.stats.slots).toBe(4);
    for (const v of compiled.problem.vars) expect(v.type).toBe('binary');
  });

  it('prices every assignment so nobody is rostered for no reason', () => {
    const compiled = compileRoster(twoByTwo());
    for (const v of compiled.problem.vars) expect(v.obj).toBe(ASSIGNMENT_COST);
  });

  it('drops the objective in feasibility-only mode', () => {
    const compiled = compileRoster(twoByTwo(), { feasibilityOnly: true });
    for (const v of compiled.problem.vars) expect(v.obj).toBeUndefined();
  });

  it('tags each row with the rule that produced it', () => {
    const model = twoByTwo();
    model.constraints.push({
      id: 'C-cover',
      kind: 'coverage',
      label: 'one on days',
      hardness: 'hard',
      day: '*',
      shift: 'day',
      min: 1,
    });

    const compiled = compileRoster(model);
    const sources = [...compiled.rowSources.values()];
    expect(sources).toHaveLength(2); // one row per day
    expect(new Set(sources)).toEqual(new Set(['C-cover']));
  });

  it('restricts a skill-qualified coverage row to qualified staff', () => {
    const model = twoByTwo();
    model.constraints.push({
      id: 'C-key',
      kind: 'coverage',
      label: 'keyholder on days',
      hardness: 'hard',
      day: 0,
      shift: 'day',
      skill: 'keyholder',
      min: 1,
    });

    const compiled = compileRoster(model);
    const row = compiled.problem.rows.find((r) => r.source === 'C-key');
    expect(row?.coeffs.map(([name]) => name)).toEqual(['x_S1_d0_day']);
  });

  it('forbids a night followed by the next morning under an 11-hour rest rule', () => {
    const model = twoByTwo();
    model.constraints.push({
      id: 'C-rest',
      kind: 'min_rest',
      label: '11h rest',
      hardness: 'hard',
      staff: '*',
      hours: 11,
    });

    const compiled = compileRoster(model);
    const rows = compiled.problem.rows.filter((r) => r.source === 'C-rest');
    const pairs = rows.map((r) => r.coeffs.map(([name]) => name).sort().join('+'));

    // Night on day 0 ends at 06:00 on day 1; the day shift starts at 08:00. Two hours.
    expect(pairs).toContain('x_S1_d0_night+x_S1_d1_day');
    // The same person cannot work both shifts on day 0 either — they overlap.
    expect(pairs).toContain('x_S1_d0_day+x_S1_d0_night');
    // Day 0 morning against day 1 morning is 24 hours apart and must not be restricted.
    expect(pairs).not.toContain('x_S1_d0_day+x_S1_d1_day');
  });

  it('pins an unavailable slot to zero', () => {
    const model = twoByTwo();
    model.constraints.push({
      id: 'C-away',
      kind: 'unavailable',
      label: 'S2 away day 1',
      hardness: 'hard',
      staff: 'S2',
      reason: 'private',
      slots: [{ day: 1, shift: 'day' }],
    });

    const compiled = compileRoster(model);
    const row = compiled.problem.rows.find((r) => r.source === 'C-away');
    expect(row?.sense).toBe('=');
    expect(row?.rhs).toBe(0);
    expect(row?.coeffs).toEqual([['x_S2_d1_day', 1]]);
  });

  it('turns a soft preference into an objective coefficient, not a row', () => {
    const model = twoByTwo();
    model.constraints.push({
      id: 'C-avoid',
      kind: 'preference',
      label: 'S1 avoids nights',
      hardness: 'soft',
      weight: 5,
      staff: 'S1',
      direction: 'avoid',
      slots: [{ day: 0, shift: 'night' }],
    });

    const compiled = compileRoster(model);
    expect(compiled.problem.rows.filter((r) => r.source === 'C-avoid')).toHaveLength(0);
    const variable = compiled.problem.vars.find((v) => v.name === 'x_S1_d0_night');
    expect(variable?.obj).toBeCloseTo(ASSIGNMENT_COST + 5, 6);
  });

  it('writes a "wants to work" preference in penalty form with a matching offset', () => {
    const model = twoByTwo();
    model.constraints.push({
      id: 'C-want',
      kind: 'preference',
      label: 'S1 wants day 0',
      hardness: 'soft',
      weight: 4,
      staff: 'S1',
      direction: 'want',
      slots: [{ day: 0, shift: 'day' }],
    });

    const compiled = compileRoster(model);
    expect(compiled.objectiveOffset).toBe(4);
    const variable = compiled.problem.vars.find((v) => v.name === 'x_S1_d0_day');
    expect(variable?.obj).toBeCloseTo(ASSIGNMENT_COST - 4, 6);
  });

  it('carries a fairness ledger onto the right-hand side', () => {
    const model = twoByTwo();
    model.constraints.push({
      id: 'C-fair',
      kind: 'fairness',
      label: 'even totals',
      hardness: 'soft',
      weight: 3,
      dimension: 'total',
    });

    const compiled = compileRoster(model, {
      ledger: { history: { S1: { total: 7, nights: 0, weekends: 0 } } },
    });

    const rows = compiled.problem.rows.filter((r) => r.source === 'C-fair');
    // Two rows per person: one pinning the ceiling, one pinning the floor.
    expect(rows).toHaveLength(4);
    expect(rows.some((r) => r.rhs === 7)).toBe(true);
    expect(rows.some((r) => r.rhs === 0)).toBe(true);
  });

  it('reads a solution vector back into assignments', () => {
    const compiled = compileRoster(twoByTwo());
    const schedule = scheduleFromSolution(compiled, {
      x_S1_d0_day: 1,
      x_S2_d0_day: 0.0001,
      x_S2_d1_night: 0.9999,
    });

    expect(schedule).toEqual([
      { day: 0, shift: 'day', staff: 'S1' },
      { day: 1, shift: 'night', staff: 'S2' },
    ]);
  });

  it('maps row duals back onto roster rules', () => {
    const model = twoByTwo();
    model.constraints.push({
      id: 'C-cover',
      kind: 'coverage',
      label: 'one on days',
      hardness: 'hard',
      day: '*',
      shift: 'day',
      min: 1,
    });

    const compiled = compileRoster(model);
    const [firstRow, secondRow] = compiled.problem.rows;
    const prices = shadowPricesByConstraint(compiled, {
      [firstRow!.name]: -0.25,
      [secondRow!.name]: 0.75,
    });

    expect(prices['C-cover']).toBeCloseTo(1.0, 6);
  });
});

describe('LP writer', () => {
  it('emits every section a solver needs', () => {
    const model = twoByTwo();
    model.constraints.push({
      id: 'C-cover',
      kind: 'coverage',
      label: 'one on days',
      hardness: 'hard',
      day: 0,
      shift: 'day',
      min: 1,
    });

    const lp = toLpFormat(compileRoster(model).problem);

    expect(lp).toMatch(/^Minimize/m);
    expect(lp).toMatch(/^Subject To/m);
    expect(lp).toMatch(/^Binary/m);
    expect(lp.trimEnd().endsWith('End')).toBe(true);
    expect(lp).toContain('r0: x_S1_d0_day + x_S2_d0_day >= 1');
  });

  it('separates signs from coefficients and avoids exponent notation', () => {
    const model = twoByTwo();
    model.constraints.push({
      id: 'C-fair',
      kind: 'fairness',
      label: 'even totals',
      hardness: 'soft',
      weight: 2,
      dimension: 'total',
    });

    const lp = toLpFormat(compileRoster(model).problem);
    expect(lp).not.toMatch(/e[+-]\d/i);
    expect(lp).toMatch(/- x_S1_d0_day/);
  });

  it('handles the full seeded week without producing an empty program', () => {
    const compiled = compileRoster(seedRoster());
    expect(compiled.stats.variables).toBeGreaterThan(160);
    expect(compiled.stats.rows).toBeGreaterThan(100);
    const lp = toLpFormat(compiled.problem);
    expect(lp.length).toBeGreaterThan(1000);
    expect(lp).toContain('End');
  });
});
