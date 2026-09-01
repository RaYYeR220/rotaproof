/**
 * The roster a first-time visitor lands on.
 *
 * A real week at a small café: ten people, three shifts a day, a keyholder required to
 * open and to close, a trainee who must not be left with the new starter, a student who
 * is at lectures on Tuesday and Thursday mornings, one keyholder away at a wedding, and a
 * fairness rule because somebody always ends up with every Saturday night.
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
    maxShifts: 2,
  },
  {
    id: 'S4',
    name: 'Daniel Okonkwo',
    notes: 'Studying - lectures Tue/Thu mornings.',
    hourlyRate: 15.5,
    skills: ['barista'],
    employment: 'part_time',
    maxShifts: 5,
  },
  {
    id: 'S5',
    name: 'Ana Kovac',
    notes: 'Trainee. Not signed off to close unsupervised.',
    hourlyRate: 14.0,
    skills: ['barista'],
    employment: 'part_time',
    maxShifts: 5,
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
    maxShifts: 4,
  },
  {
    id: 'S9',
    name: 'Lena Fischer',
    notes: 'Keyholder. Away Thursday and Friday for a wedding.',
    hourlyRate: 18.25,
    skills: ['keyholder', 'barista'],
    employment: 'full_time',
    minShifts: 3,
    maxShifts: 5,
  },
  {
    id: 'S10',
    name: 'Omar Haddad',
    notes: 'Covers mids; food-safety trained.',
    hourlyRate: 16.5,
    skills: ['barista', 'food_safety'],
    employment: 'part_time',
    maxShifts: 5,
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

/** Contracted ceilings, mirroring `Staff.maxShifts` so the rules are visible as rules. */
const CONTRACT_CAPS: Array<[string, number]> = [
  ['S1', 5],
  ['S2', 5],
  ['S3', 2],
  ['S4', 5],
  ['S5', 5],
  ['S6', 5],
  ['S7', 5],
  ['S8', 4],
  ['S9', 5],
  ['S10', 5],
];

/** Guaranteed minimums for the salaried staff. */
const CONTRACT_FLOORS: Array<[string, number]> = [
  ['S1', 4],
  ['S2', 4],
  ['S6', 3],
  ['S9', 3],
];

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
  ...CONTRACT_CAPS.map(
    ([staff, max]): Constraint => ({
      id: `C-contract-${staff}`,
      kind: 'max_shifts',
      label: `${staff} contracted to at most ${max} shifts`,
      hardness: 'hard',
      group: 'contracts',
      staff,
      max,
    }),
  ),
  ...CONTRACT_FLOORS.map(
    ([staff, min]): Constraint => ({
      id: `C-min-${staff}`,
      kind: 'min_shifts',
      label: `${staff} guaranteed ${min} shifts`,
      hardness: 'hard',
      group: 'contracts',
      staff,
      min,
    }),
  ),
  {
    id: 'C-unavail-S4-lectures',
    kind: 'unavailable',
    label: 'S4 has lectures Tuesday and Thursday mornings',
    hardness: 'hard',
    group: 'availability',
    staff: 'S4',
    reason: 'University lectures, 09:00-13:00.',
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
    slots: SHIFT_TYPES.map((shift) => ({ day: FRI, shift: shift.id })),
  },
  {
    id: 'C-unavail-S9-wedding',
    kind: 'unavailable',
    label: 'S9 is away Thursday and Friday',
    hardness: 'hard',
    group: 'availability',
    staff: 'S9',
    reason: "Sister's wedding, travelling Thursday morning.",
    slots: [THU, FRI].flatMap((day) => SHIFT_TYPES.map((shift) => ({ day, shift: shift.id }))),
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
    reason: 'New starter - no unsupervised evenings for the first month.',
    slots: Array.from({ length: 7 }, (_, day) => ({ day, shift: 'close' })),
  },
  {
    id: 'C-trainee-supervision',
    kind: 'anti_pair',
    label: 'The trainee and the new starter must not share a shift',
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
 * There are four keyholders. S6 never works Fridays and S9 is away at a wedding, so
 * Friday already rests on S1 and S2 — one opens, the other closes. Grant S2 the day off
 * and S1 would have to do both, which the eleven-hour rest rule forbids.
 *
 * Six rules, every one of them reasonable on its own, that cannot hold together. The
 * solver finds exactly those six and nothing else: the four unrelated absences that same
 * week are ruled out rather than listed. That is the demo's whole argument in one click.
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
