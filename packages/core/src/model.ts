/**
 * The roster domain model.
 *
 * Two rules govern everything in this file:
 *
 *  1. Fields marked `@private` never leave the browser tab. They are stripped at the
 *     tool boundary (see `redact.ts`) so an agent driving this page sees structure,
 *     never people. `privacy.test.ts` proves it with a property test.
 *
 *  2. Every constraint carries a stable `id` and a human `label`. When the model is
 *     infeasible the solver returns a minimal set of these ids, so the page can say
 *     *which* rules collide instead of guessing at a schedule that does not exist.
 */

export type StaffId = string;
export type ShiftTypeId = string;
export type SkillId = string;
export type ConstraintId = string;

/** A single schedulable cell: day index within the horizon, plus a shift type. */
export interface Slot {
  day: number;
  shift: ShiftTypeId;
}

export interface ShiftType {
  id: ShiftTypeId;
  label: string;
  /** Minutes past midnight on the shift's own day. */
  startMinutes: number;
  durationMinutes: number;
}

export type EmploymentType = 'full_time' | 'part_time' | 'casual';

export interface Staff {
  id: StaffId;
  /** @private Display name. Never crosses the tool boundary. */
  name: string;
  /** @private Free text the manager keeps about this person. */
  notes?: string;
  /** @private Pay rate, used only for local cost reporting. */
  hourlyRate?: number;
  skills: SkillId[];
  employment: EmploymentType;
  /** Contractual bounds over the whole horizon. */
  minShifts?: number;
  maxShifts?: number;
}

export interface Horizon {
  /** ISO date (YYYY-MM-DD) of day 0. */
  startDate: string;
  days: number;
}

/**
 * Hard constraints must hold; a model that cannot satisfy them is INFEASIBLE and the
 * solver reports the minimal conflicting subset. Soft constraints are priced into the
 * objective instead, which is what makes shadow prices meaningful.
 */
export type Hardness = 'hard' | 'soft';

interface ConstraintBase {
  id: ConstraintId;
  label: string;
  hardness: Hardness;
  /** Objective weight. Ignored when `hardness === 'hard'`. */
  weight?: number;
  /**
   * Constraints sharing a group are dropped together during deletion filtering, which
   * keeps conflict explanations at the level a human reasons about ("weekend coverage")
   * rather than at the level of individual matrix rows.
   */
  group?: string;
}

/** Staffing level required in a shift, optionally restricted to holders of a skill. */
export interface CoverageConstraint extends ConstraintBase {
  kind: 'coverage';
  /** `'*'` applies the rule to every day in the horizon. */
  day: number | '*';
  shift: ShiftTypeId;
  skill?: SkillId;
  min: number;
  max?: number;
}

/** Upper bound on shifts worked across the whole horizon. */
export interface MaxShiftsConstraint extends ConstraintBase {
  kind: 'max_shifts';
  staff: StaffId | '*';
  max: number;
}

/** Lower bound on shifts worked across the whole horizon. */
export interface MinShiftsConstraint extends ConstraintBase {
  kind: 'min_shifts';
  staff: StaffId | '*';
  min: number;
}

/** At most one shift per calendar day. Separate from `max_shifts` so conflicts read clearly. */
export interface OneShiftPerDayConstraint extends ConstraintBase {
  kind: 'one_shift_per_day';
  staff: StaffId | '*';
}

/** Minimum gap between the end of one shift and the start of the next. */
export interface MinRestConstraint extends ConstraintBase {
  kind: 'min_rest';
  staff: StaffId | '*';
  hours: number;
}

/** Cap on consecutive worked days. */
export interface MaxConsecutiveConstraint extends ConstraintBase {
  kind: 'max_consecutive_days';
  staff: StaffId | '*';
  max: number;
}

/** Slots a person cannot work. `reason` is private and never reaches an agent. */
export interface UnavailableConstraint extends ConstraintBase {
  kind: 'unavailable';
  staff: StaffId;
  slots: Slot[];
  /** @private Why the person is unavailable. Local display only. */
  reason?: string;
}

/**
 * Pins a person onto specific slots.
 *
 * The mirror of `unavailable`. Mostly used to ask a hypothetical — "if this person took
 * that shift, would the week still work?" — which is a question about one named individual
 * and cannot be expressed as a coverage floor, because a floor is satisfied by anybody.
 */
export interface MustWorkConstraint extends ConstraintBase {
  kind: 'must_work';
  staff: StaffId;
  slots: Slot[];
}

/** Two people who must not share a shift. */
export interface AntiPairConstraint extends ConstraintBase {
  kind: 'anti_pair';
  a: StaffId;
  b: StaffId;
}

/** Two people who must be rostered together whenever either one works. */
export interface PairConstraint extends ConstraintBase {
  kind: 'pair';
  a: StaffId;
  b: StaffId;
}

/** A requested absence. Hard when granted, soft while it is still a request. */
export interface TimeOffConstraint extends ConstraintBase {
  kind: 'time_off';
  staff: StaffId;
  slots: Slot[];
  status: 'requested' | 'granted' | 'declined';
  /** @private The note the person wrote when asking. */
  note?: string;
}

/** A soft wish to work (or avoid) particular slots. */
export interface PreferenceConstraint extends ConstraintBase {
  kind: 'preference';
  staff: StaffId;
  slots: Slot[];
  direction: 'want' | 'avoid';
}

/**
 * Spreads a burden evenly. Modelled as a minimax: the objective pays for the gap
 * between the busiest and the least busy person along `dimension`.
 */
export interface FairnessConstraint extends ConstraintBase {
  kind: 'fairness';
  dimension: 'total' | 'nights' | 'weekends';
}

export type Constraint =
  | CoverageConstraint
  | MaxShiftsConstraint
  | MinShiftsConstraint
  | OneShiftPerDayConstraint
  | MinRestConstraint
  | MaxConsecutiveConstraint
  | UnavailableConstraint
  | MustWorkConstraint
  | AntiPairConstraint
  | PairConstraint
  | TimeOffConstraint
  | PreferenceConstraint
  | FairnessConstraint;

export type ConstraintKind = Constraint['kind'];

/**
 * How a soft breach is priced.
 *
 * `magnitude` charges per unit past the limit — two people short of a coverage minimum
 * costs twice one. `count` charges once per breach, because the shortfall has no natural
 * unit: a rest period nine hours too short is one broken rule, not nine.
 *
 * Both the checker and the MIP compiler read this table, which is what keeps the objective
 * the solver minimises and the soft cost the checker reports the same quantity.
 * `objective.test.ts` asserts they agree on the seeded week.
 */
export const SOFT_PENALTY_MODE: Record<ConstraintKind, 'magnitude' | 'count'> = {
  coverage: 'magnitude',
  max_shifts: 'magnitude',
  min_shifts: 'magnitude',
  one_shift_per_day: 'magnitude',
  max_consecutive_days: 'magnitude',
  min_rest: 'count',
  unavailable: 'count',
  must_work: 'count',
  time_off: 'count',
  anti_pair: 'count',
  pair: 'count',
  preference: 'count',
  fairness: 'magnitude',
};

export const CONSTRAINT_KINDS: readonly ConstraintKind[] = [
  'coverage',
  'max_shifts',
  'min_shifts',
  'one_shift_per_day',
  'min_rest',
  'max_consecutive_days',
  'unavailable',
  'must_work',
  'anti_pair',
  'pair',
  'time_off',
  'preference',
  'fairness',
] as const;

/** One person working one shift on one day. */
export interface Assignment {
  day: number;
  shift: ShiftTypeId;
  staff: StaffId;
}

export type Schedule = Assignment[];

export interface RosterModel {
  horizon: Horizon;
  shiftTypes: ShiftType[];
  staff: Staff[];
  skills: SkillId[];
  constraints: Constraint[];
}

/**
 * Carried alongside a model across weeks. Feeds the fairness objective so that someone
 * who covered the last three weekends is not asked to cover a fourth.
 */
export interface FairnessLedger {
  /** staffId -> counts accumulated in *previous*, already-published horizons. */
  history: Record<StaffId, { total: number; nights: number; weekends: number }>;
}

export const EMPTY_LEDGER: FairnessLedger = { history: {} };

// ---------------------------------------------------------------------------
// Derived helpers. Kept pure so both the solver compiler and the checker agree.
// ---------------------------------------------------------------------------

export function shiftById(model: RosterModel, id: ShiftTypeId): ShiftType | undefined {
  return model.shiftTypes.find((s) => s.id === id);
}

export function staffById(model: RosterModel, id: StaffId): Staff | undefined {
  return model.staff.find((s) => s.id === id);
}

/** Absolute start time of a slot, in minutes from the start of day 0. */
export function slotStart(model: RosterModel, slot: Slot): number {
  const shift = shiftById(model, slot.shift);
  if (!shift) throw new Error(`unknown shift type: ${slot.shift}`);
  return slot.day * 1440 + shift.startMinutes;
}

/** Absolute end time of a slot, in minutes from the start of day 0. */
export function slotEnd(model: RosterModel, slot: Slot): number {
  const shift = shiftById(model, slot.shift);
  if (!shift) throw new Error(`unknown shift type: ${slot.shift}`);
  return slotStart(model, slot) + shift.durationMinutes;
}

/** True when a shift runs past midnight into the following day. */
export function crossesMidnight(shift: ShiftType): boolean {
  return shift.startMinutes + shift.durationMinutes > 1440;
}

/** Day-of-week for a horizon day index, 0 = Sunday, matching `Date.getUTCDay`. */
export function dayOfWeek(horizon: Horizon, day: number): number {
  const start = new Date(`${horizon.startDate}T00:00:00Z`);
  return new Date(start.getTime() + day * 86_400_000).getUTCDay();
}

export function isWeekend(horizon: Horizon, day: number): boolean {
  const d = dayOfWeek(horizon, day);
  return d === 0 || d === 6;
}

/** ISO date string for a horizon day index. */
export function dateOf(horizon: Horizon, day: number): string {
  const start = new Date(`${horizon.startDate}T00:00:00Z`);
  return new Date(start.getTime() + day * 86_400_000).toISOString().slice(0, 10);
}

/** A shift counts as a night when it starts at or after 22:00, or ends after midnight. */
export function isNightShift(shift: ShiftType): boolean {
  return shift.startMinutes >= 22 * 60 || crossesMidnight(shift);
}

export function allSlots(model: RosterModel): Slot[] {
  const out: Slot[] = [];
  for (let day = 0; day < model.horizon.days; day++) {
    for (const shift of model.shiftTypes) out.push({ day, shift: shift.id });
  }
  return out;
}

export function slotKey(slot: Slot): string {
  return `${slot.day}:${slot.shift}`;
}

export function assignmentKey(a: Assignment): string {
  return `${a.day}:${a.shift}:${a.staff}`;
}

/** Expands a `'*'` staff selector into concrete ids. */
export function resolveStaff(model: RosterModel, selector: StaffId | '*'): StaffId[] {
  return selector === '*' ? model.staff.map((s) => s.id) : [selector];
}

/** Expands a `'*'` day selector into concrete day indices. */
export function resolveDays(model: RosterModel, selector: number | '*'): number[] {
  if (selector === '*') return Array.from({ length: model.horizon.days }, (_, i) => i);
  return [selector];
}

/**
 * Deterministic JSON with sorted keys. The receipt hash is taken over this, so an
 * identical model always produces an identical hash regardless of key insertion order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}
