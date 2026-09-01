import { describe, expect, it } from 'vitest';

import {
  type Assignment,
  type RosterModel,
  type Schedule,
  check,
  isNightShift,
  isWeekend,
  seedRoster,
  shiftById,
} from '../src/index.js';

/** A model small enough that every expected violation can be reasoned about by hand. */
function tinyModel(): RosterModel {
  return {
    horizon: { startDate: '2026-09-07', days: 3 },
    shiftTypes: [
      { id: 'day', label: 'Day', startMinutes: 8 * 60, durationMinutes: 8 * 60 },
      { id: 'night', label: 'Night', startMinutes: 22 * 60, durationMinutes: 8 * 60 },
    ],
    skills: ['keyholder'],
    staff: [
      { id: 'S1', name: 'Alpha', skills: ['keyholder'], employment: 'full_time' },
      { id: 'S2', name: 'Beta', skills: [], employment: 'part_time' },
    ],
    constraints: [],
  };
}

function at(day: number, shift: string, staff: string): Assignment {
  return { day, shift, staff };
}

describe('check', () => {
  it('reports an empty schedule as clean when there are no constraints', () => {
    const result = check(tinyModel(), []);
    expect(result.ok).toBe(true);
    expect(result.hardViolations).toEqual([]);
    expect(result.stats.assignments).toBe(0);
  });

  it('flags a coverage shortfall and says how short it is', () => {
    const model = tinyModel();
    model.constraints.push({
      id: 'C1',
      kind: 'coverage',
      label: 'two on days',
      hardness: 'hard',
      day: '*',
      shift: 'day',
      min: 2,
    });

    const result = check(model, [at(0, 'day', 'S1')]);

    expect(result.ok).toBe(false);
    // Three days in the horizon: one is short by 1, two are short by 2.
    expect(result.hardViolations).toHaveLength(3);
    expect(result.hardViolations[0]?.overBy).toBe(1);
    expect(result.hardViolations[1]?.overBy).toBe(2);
  });

  it('honours a skill qualifier when counting coverage', () => {
    const model = tinyModel();
    model.horizon.days = 1;
    model.constraints.push({
      id: 'C-key',
      kind: 'coverage',
      label: 'keyholder on days',
      hardness: 'hard',
      day: '*',
      shift: 'day',
      skill: 'keyholder',
      min: 1,
    });

    // S2 has no keyholder skill, so the shift is staffed but not covered.
    expect(check(model, [at(0, 'day', 'S2')]).ok).toBe(false);
    expect(check(model, [at(0, 'day', 'S1')]).ok).toBe(true);
  });

  it('catches a night-then-morning rest breach', () => {
    const model = tinyModel();
    model.constraints.push({
      id: 'C-rest',
      kind: 'min_rest',
      label: '11h rest',
      hardness: 'hard',
      staff: '*',
      hours: 11,
    });

    // Night on day 0 runs 22:00–06:00; the day shift on day 1 starts at 08:00.
    // That is two hours of rest, well under eleven.
    const schedule: Schedule = [at(0, 'night', 'S1'), at(1, 'day', 'S1')];
    const result = check(model, schedule);

    expect(result.ok).toBe(false);
    expect(result.hardViolations[0]?.kind).toBe('min_rest');
    expect(result.hardViolations[0]?.message).toContain('S1');
    // Two hours of rest against eleven required leaves nine hours short.
    expect(result.hardViolations[0]?.overBy).toBeCloseTo(9, 5);
  });

  it('allows a night followed by a rest day', () => {
    const model = tinyModel();
    model.constraints.push({
      id: 'C-rest',
      kind: 'min_rest',
      label: '11h rest',
      hardness: 'hard',
      staff: '*',
      hours: 11,
    });

    expect(check(model, [at(0, 'night', 'S1'), at(2, 'day', 'S1')]).ok).toBe(true);
  });

  it('rejects two shifts on the same day', () => {
    const model = tinyModel();
    model.constraints.push({
      id: 'C-one',
      kind: 'one_shift_per_day',
      label: 'one a day',
      hardness: 'hard',
      staff: '*',
    });

    const result = check(model, [at(0, 'day', 'S1'), at(0, 'night', 'S1')]);
    expect(result.ok).toBe(false);
    expect(result.hardViolations[0]?.kind).toBe('one_shift_per_day');
  });

  it('keeps unavailability reasons out of the violation message', () => {
    const model = tinyModel();
    model.constraints.push({
      id: 'C-unavail',
      kind: 'unavailable',
      label: 'S1 away',
      hardness: 'hard',
      staff: 'S1',
      reason: 'Hospital appointment',
      slots: [{ day: 0, shift: 'day' }],
    });

    const result = check(model, [at(0, 'day', 'S1')]);
    expect(result.ok).toBe(false);
    expect(result.hardViolations[0]?.message).not.toContain('Hospital');
    expect(result.hardViolations[0]?.message).not.toContain('Alpha');
  });

  it('separates soft breaches from hard ones and prices them', () => {
    const model = tinyModel();
    model.constraints.push({
      id: 'C-pref',
      kind: 'preference',
      label: 'S1 avoids nights',
      hardness: 'soft',
      weight: 4,
      staff: 'S1',
      direction: 'avoid',
      slots: [{ day: 0, shift: 'night' }],
    });

    const result = check(model, [at(0, 'night', 'S1')]);
    expect(result.ok).toBe(true);
    expect(result.softViolations).toHaveLength(1);
    expect(result.softPenalty).toBe(4);
  });

  it('counts nights and weekends per person', () => {
    const model = tinyModel();
    model.horizon.days = 7;
    // 2026-09-07 is a Monday, so day 5 is Saturday.
    const result = check(model, [at(0, 'night', 'S1'), at(5, 'day', 'S1'), at(5, 'day', 'S2')]);

    expect(result.stats.perStaff.S1).toEqual({ total: 2, nights: 1, weekends: 1 });
    expect(result.stats.perStaff.S2).toEqual({ total: 1, nights: 0, weekends: 1 });
  });
});

describe('calendar helpers', () => {
  it('treats 2026-09-07 as a Monday, so days 5 and 6 are the weekend', () => {
    const horizon = { startDate: '2026-09-07', days: 7 };
    expect(isWeekend(horizon, 0)).toBe(false);
    expect(isWeekend(horizon, 4)).toBe(false);
    expect(isWeekend(horizon, 5)).toBe(true);
    expect(isWeekend(horizon, 6)).toBe(true);
  });

  it('classifies late and midnight-crossing shifts as nights', () => {
    const model = tinyModel();
    expect(isNightShift(shiftById(model, 'night')!)).toBe(true);
    expect(isNightShift(shiftById(model, 'day')!)).toBe(false);
  });
});

describe('the seeded café week', () => {
  it('is internally consistent — every constraint references things that exist', () => {
    const model = seedRoster();
    const staffIds = new Set(model.staff.map((s) => s.id));
    const shiftIds = new Set(model.shiftTypes.map((s) => s.id));

    for (const constraint of model.constraints) {
      const withStaff = constraint as { staff?: string; a?: string; b?: string };
      for (const ref of [withStaff.staff, withStaff.a, withStaff.b]) {
        if (ref && ref !== '*') expect(staffIds.has(ref)).toBe(true);
      }
      const withSlots = constraint as { slots?: { day: number; shift: string }[] };
      for (const slot of withSlots.slots ?? []) {
        expect(shiftIds.has(slot.shift)).toBe(true);
        expect(slot.day).toBeGreaterThanOrEqual(0);
        expect(slot.day).toBeLessThan(model.horizon.days);
      }
      if (constraint.kind === 'coverage') {
        expect(shiftIds.has(constraint.shift)).toBe(true);
        if (constraint.skill) expect(model.skills).toContain(constraint.skill);
      }
    }
  });

  it('gives every constraint a unique id', () => {
    const ids = seedRoster().constraints.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
