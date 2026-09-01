/**
 * The roster a first-time visitor lands on.
 *
 * A real week at a small café: eight people, three shifts a day, a keyholder required to
 * open and to close, one barista trainee who cannot close alone, a student who is at
 * lectures on Tuesday and Thursday mornings, and a fairness rule because somebody always
 * ends up with every Saturday night.
 *
 * It is deliberately *tight but satisfiable*. One extra request tips it into infeasible,
 * which is the point — the interesting behaviour of this app is what it does when the
 * answer is "no", and a visitor should be able to reach that in one step.
 */

import type { Constraint, RosterModel, ShiftType, Staff } from './model.js';

export const SHIFT_TYPES: ShiftType[] = [
  { id: 'open', label: 'Open', startMinutes: 6 * 60, durationMinutes: 8 * 60 },
  { id: 'mid', label: 'Mid', startMinutes: 12 * 60, durationMinutes: 7 * 60 },
  { id: 'close', label: 'Close', startMinutes: 17 * 60, durationMinutes: 8 * 60 },
];

export const SKILLS = ['keyholder', 'barista', 'food_safety'] as const;

const STAFF: Staff[] = [
  {
    id: 'S1',
    name: 'Maria Alvarez',
    notes: 'Shift lead. Prefers not to close two nights running.',
    hourlyRate: 19.5,
    skills: ['keyholder', 'barista', 'food_safety'],
    employment: 'full_time',
    minShifts: 4,
    maxShifts: 5,
  },
  {
    id: 'S2',
    name: 'Tom Beckett',
    notes: 'Second keyholder. Back from parental leave.',
    hourlyRate: 18.0,
    skills: ['keyholder', 'barista'],
    employment: 'full_time',
    minShifts: 4,
    maxShifts: 5,
  },
  {
    id: 'S3',
    name: 'Priya Nair',
    notes: 'Weekend availability only until term ends.',
    hourlyRate: 16.25,
    skills: ['barista', 'food_safety'],
    employment: 'part_time',
    maxShifts: 3,
  },
  {
    id: 'S4',
    name: 'Daniel Okonkwo',
    notes: 'Studying — lectures Tue/Thu mornings.',
    hourlyRate: 15.5,
    skills: ['barista'],
    employment: 'part_time',
    maxShifts: 4,
  },
  {
    id: 'S5',
    name: 'Ana Kovač',
    notes: 'Trainee. Not signed off to close unsupervised.',
    hourlyRate: 14.0,
    skills: ['barista'],
    employment: 'part_time',
    maxShifts: 4,
  },
  {
    id: 'S6',
    name: 'Yusuf Demir',
    notes: 'Keyholder. Cannot work Fridays (second job).',
    hourlyRate: 18.75,
    skills: ['keyholder', 'food_safety'],
    employment: 'full_time',
    minShifts: 3,
    maxShifts: 5,
  },
  {
    id: 'S7',
    name: 'Grace Lindqvist',
    notes: 'Happy to pick up extra nights.',
    hourlyRate: 16.0,
    skills: ['barista', 'food_safety'],
    employment: 'casual',
    maxShifts: 5,
  },
  {
    id: 'S8',
    name: 'Ravi Chandran',
    notes: 'New starter, days only for the first month.',
    hourlyRate: 15.0,
    skills: ['barista'],
    employment: 'casual',
    maxShifts: 3,
  },
];

/** Day indices are relative to `startDate`, which is a Monday. */
const MON = 0;
const TUE = 1;
const WED = 2;
const THU = 3;
const FRI = 4;
const SAT = 5;
const SUN = 6;

const CONSTRAINTS: Constraint[] = [
  {
    id: 'C-cover-open',
    kind: 'coverage',
    label: 'Two people on every opening shift',
    hardness: 'hard',
    group: 'coverage',
    day: '*',
    shift: 'open',
    min: 2,
  },
  {
    id: 'C-cover-mid',
    kind: 'coverage',
    label: 'Two people on every mid shift',
    hardness: 'hard',
    group: 'coverage',
    day: '*',
    shift: 'mid',
    min: 2,
  },
  {
    id: 'C-cover-close',
    kind: 'coverage',
    label: 'Two people on every closing shift',
    hardness: 'hard',
    group: 'coverage',
    day: '*',
    shift: 'close',
    min: 2,
  },
  {
    id: 'C-keyholder-open',
    kind: 'coverage',
    label: 'A keyholder must open',
    hardness: 'hard',
    group: 'keyholder',
    day: '*',
    shift: 'open',
    skill: 'keyholder',
    min: 1,
  },
  {
    id: 'C-keyholder-close',
    kind: 'coverage',
    label: 'A keyholder must close',
    hardness: 'hard',
    group: 'keyholder',
    day: '*',
    shift: 'close',
    skill: 'keyholder',
    min: 1,
  },
  {
    id: 'C-food-safety-mid',
    kind: 'coverage',
    label: 'Food-safety trained staff on every mid shift',
    hardness: 'hard',
    group: 'compliance',
    day: '*',
    shift: 'mid',
    skill: 'food_safety',
    min: 1,
  },
  {
    id: 'C-one-per-day',
    kind: 'one_shift_per_day',
    label: 'Nobody works two shifts in one day',
    hardness: 'hard',
    group: 'working-time',
    staff: '*',
  },
  {
    id: 'C-rest-11',
    kind: 'min_rest',
    label: '11 hours rest between shifts',
    hardness: 'hard',
    group: 'working-time',
    staff: '*',
    hours: 11,
  },
  {
    id: 'C-max-consecutive',
    kind: 'max_consecutive_days',
    label: 'At most 5 days in a row',
    hardness: 'hard',
    group: 'working-time',
    staff: '*',
    max: 5,
  },
  {
    id: 'C-contract-S1',
    kind: 'max_shifts',
    label: 'S1 contracted to at most 5 shifts',
    hardness: 'hard',
    group: 'contracts',
    staff: 'S1',
    max: 5,
  },
  {
    id: 'C-contract-S2',
    kind: 'max_shifts',
    label: 'S2 contracted to at most 5 shifts',
    hardness: 'hard',
    group: 'contracts',
    staff: 'S2',
    max: 5,
  },
  {
    id: 'C-contract-S3',
    kind: 'max_shifts',
    label: 'S3 part-time, at most 3 shifts',
    hardness: 'hard',
    group: 'contracts',
    staff: 'S3',
    max: 3,
  },
  {
    id: 'C-contract-S4',
    kind: 'max_shifts',
    label: 'S4 part-time, at most 4 shifts',
    hardness: 'hard',
    group: 'contracts',
    staff: 'S4',
    max: 4,
  },
  {
    id: 'C-contract-S5',
    kind: 'max_shifts',
    label: 'S5 part-time, at most 4 shifts',
    hardness: 'hard',
    group: 'contracts',
    staff: 'S5',
    max: 4,
  },
  {
    id: 'C-contract-S6',
    kind: 'max_shifts',
    label: 'S6 contracted to at most 5 shifts',
    hardness: 'hard',
    group: 'contracts',
    staff: 'S6',
    max: 5,
  },
  {
    id: 'C-contract-S7',
    kind: 'max_shifts',
    label: 'S7 casual, at most 5 shifts',
    hardness: 'hard',
    group: 'contracts',
    staff: 'S7',
    max: 5,
  },
  {
    id: 'C-contract-S8',
    kind: 'max_shifts',
    label: 'S8 casual, at most 3 shifts',
    hardness: 'hard',
    group: 'contracts',
    staff: 'S8',
    max: 3,
  },
  {
    id: 'C-min-S1',
    kind: 'min_shifts',
    label: 'S1 guaranteed 4 shifts',
    hardness: 'hard',
    group: 'contracts',
    staff: 'S1',
    min: 4,
  },
  {
    id: 'C-min-S2',
    kind: 'min_shifts',
    label: 'S2 guaranteed 4 shifts',
    hardness: 'hard',
    group: 'contracts',
    staff: 'S2',
    min: 4,
  },
  {
    id: 'C-min-S6',
    kind: 'min_shifts',
    label: 'S6 guaranteed 3 shifts',
    hardness: 'hard',
    group: 'contracts',
    staff: 'S6',
    min: 3,
  },
  {
    id: 'C-unavail-S4-lectures',
    kind: 'unavailable',
    label: 'S4 has lectures Tuesday and Thursday mornings',
    hardness: 'hard',
    group: 'availability',
    staff: 'S4',
    reason: 'University lectures, 09:00–13:00.',
    slots: [
      { day: TUE, shift: 'open' },
      { day: THU, shift: 'open' },
    ],
  },
  {
    id: 'C-unavail-S6-friday',
    kind: 'unavailable',
    label: 'S6 cannot work Fridays',
    hardness: 'hard',
    group: 'availability',
    staff: 'S6',
    reason: 'Second job on Friday evenings.',
    slots: [
      { day: FRI, shift: 'open' },
      { day: FRI, shift: 'mid' },
      { day: FRI, shift: 'close' },
    ],
  },
  {
    id: 'C-unavail-S3-weekdays',
    kind: 'unavailable',
    label: 'S3 is weekends-only this term',
    hardness: 'hard',
    group: 'availability',
    staff: 'S3',
    reason: 'Term-time study commitment Monday to Friday.',
    slots: [MON, TUE, WED, THU, FRI].flatMap((day) =>
      SHIFT_TYPES.map((shift) => ({ day, shift: shift.id })),
    ),
  },
  {
    id: 'C-unavail-S8-nights',
    kind: 'unavailable',
    label: 'S8 is days-only during onboarding',
    hardness: 'hard',
    group: 'availability',
    staff: 'S8',
    reason: 'New starter — no unsupervised evenings for the first month.',
    slots: Array.from({ length: 7 }, (_, day) => ({ day, shift: 'close' })),
  },
  {
    id: 'C-trainee-supervision',
    kind: 'anti_pair',
    label: 'The trainee must not close with the new starter',
    hardness: 'hard',
    group: 'supervision',
    a: 'S5',
    b: 'S8',
  },
  {
    id: 'C-fair-total',
    kind: 'fairness',
    label: 'Spread shifts evenly across the team',
    hardness: 'soft',
    weight: 6,
    dimension: 'total',
  },
  {
    id: 'C-fair-weekends',
    kind: 'fairness',
    label: 'Spread weekend work evenly',
    hardness: 'soft',
    weight: 10,
    dimension: 'weekends',
  },
  {
    id: 'C-pref-S1-no-late-mondays',
    kind: 'preference',
    label: 'S1 would rather not close on Monday',
    hardness: 'soft',
    weight: 2,
    staff: 'S1',
    direction: 'avoid',
    slots: [{ day: MON, shift: 'close' }],
  },
  {
    id: 'C-pref-S7-nights',
    kind: 'preference',
    label: 'S7 is happy to take weekend nights',
    hardness: 'soft',
    weight: 3,
    staff: 'S7',
    direction: 'want',
    slots: [
      { day: SAT, shift: 'close' },
      { day: SUN, shift: 'close' },
    ],
  },
];

/** The Monday the demo week starts on. Fixed so screenshots and receipts reproduce. */
export const SEED_START_DATE = '2026-09-07';

export function seedRoster(): RosterModel {
  return {
    horizon: { startDate: SEED_START_DATE, days: 7 },
    shiftTypes: SHIFT_TYPES.map((s) => ({ ...s })),
    skills: [...SKILLS],
    staff: STAFF.map((s) => ({ ...s, skills: [...s.skills] })),
    constraints: CONSTRAINTS.map((c) => structuredClone(c)),
  };
}

/**
 * The one extra request that makes the seed week impossible.
 *
 * S6 already cannot work Fridays; granting S2 the Friday off leaves S1 as the only
 * keyholder for both the Friday open and the Friday close, which the 11-hour rest rule
 * forbids. Three rules, all individually reasonable, that cannot hold at once — the
 * demo's whole argument in one click.
 */
export function fridayConflict(): Constraint {
  return {
    id: 'C-timeoff-S2-friday',
    kind: 'time_off',
    label: 'S2 asked for Friday off',
    hardness: 'hard',
    group: 'time-off',
    staff: 'S2',
    status: 'granted',
    note: 'Family visiting from out of town.',
    slots: [
      { day: FRI, shift: 'open' },
      { day: FRI, shift: 'mid' },
      { day: FRI, shift: 'close' },
    ],
  };
}
