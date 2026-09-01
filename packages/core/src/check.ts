/**
 * The deterministic checker.
 *
 * `check()` takes any schedule — one the solver produced, one a manager dragged around
 * by hand, one an agent invented — and reports exactly which constraints it breaks.
 * It shares its slot arithmetic with the MIP compiler (`model.ts` helpers) so the two
 * can never disagree about what "11 hours of rest" means.
 *
 * Every violation carries an agent-safe `message`. Nothing here reads `Staff.name`.
 */

import {
  type Assignment,
  type Constraint,
  type ConstraintId,
  type RosterModel,
  type Schedule,
  type Slot,
  type StaffId,
  isNightShift,
  isWeekend,
  resolveDays,
  resolveStaff,
  shiftById,
  slotEnd,
  slotKey,
  slotStart,
  staffById,
} from './model.js';

export interface Violation {
  constraintId: ConstraintId;
  kind: Constraint['kind'];
  hardness: Constraint['hardness'];
  /** Agent-safe, uses staff ids only. */
  message: string;
  /** Slots or staff implicated, so a UI can highlight them. */
  slots?: Slot[];
  staff?: StaffId[];
  /** How far past the limit, where the constraint is numeric. */
  overBy?: number;
}

export interface CheckResult {
  ok: boolean;
  hardViolations: Violation[];
  softViolations: Violation[];
  /** Sum of `weight` over broken soft constraints — comparable to the solver objective. */
  softPenalty: number;
  stats: ScheduleStats;
}

export interface ScheduleStats {
  assignments: number;
  perStaff: Record<StaffId, { total: number; nights: number; weekends: number }>;
  /** Slots whose coverage minimum is unmet, keyed by `day:shift`. */
  uncovered: string[];
}

/** Indexes a schedule for the repeated lookups every rule below needs. */
class ScheduleIndex {
  readonly byStaff = new Map<StaffId, Assignment[]>();
  readonly bySlot = new Map<string, Assignment[]>();
  readonly present = new Set<string>();

  constructor(schedule: Schedule) {
    for (const a of schedule) {
      const staffList = this.byStaff.get(a.staff);
      if (staffList) staffList.push(a);
      else this.byStaff.set(a.staff, [a]);

      const key = slotKey(a);
      const slotList = this.bySlot.get(key);
      if (slotList) slotList.push(a);
      else this.bySlot.set(key, [a]);

      this.present.add(`${key}:${a.staff}`);
    }
    for (const list of this.byStaff.values()) {
      list.sort((x, y) => x.day - y.day || x.shift.localeCompare(y.shift));
    }
  }

  worksSlot(staff: StaffId, slot: Slot): boolean {
    return this.present.has(`${slotKey(slot)}:${staff}`);
  }

  forStaff(staff: StaffId): Assignment[] {
    return this.byStaff.get(staff) ?? [];
  }

  inSlot(slot: Slot): Assignment[] {
    return this.bySlot.get(slotKey(slot)) ?? [];
  }
}

export function check(model: RosterModel, schedule: Schedule): CheckResult {
  const index = new ScheduleIndex(schedule);
  const violations: Violation[] = [];

  for (const constraint of model.constraints) {
    violations.push(...checkOne(model, constraint, index));
  }

  const hardViolations = violations.filter((v) => v.hardness === 'hard');
  const softViolations = violations.filter((v) => v.hardness === 'soft');
  const weightOf = new Map(model.constraints.map((c) => [c.id, c.weight ?? 1]));
  const softPenalty = softViolations.reduce(
    (sum, v) => sum + (weightOf.get(v.constraintId) ?? 1) * (v.overBy ?? 1),
    0,
  );

  return {
    ok: hardViolations.length === 0,
    hardViolations,
    softViolations,
    softPenalty,
    stats: statsFor(model, schedule, index),
  };
}

/** Violations produced by a single constraint. Exported for the deletion filter. */
export function checkOne(
  model: RosterModel,
  constraint: Constraint,
  index: ScheduleIndex,
): Violation[] {
  const out: Violation[] = [];
  const base = {
    constraintId: constraint.id,
    kind: constraint.kind,
    hardness: constraint.hardness,
  } as const;

  switch (constraint.kind) {
    case 'coverage': {
      for (const day of resolveDays(model, constraint.day)) {
        const slot: Slot = { day, shift: constraint.shift };
        const present = index.inSlot(slot).filter((a) => {
          if (!constraint.skill) return true;
          return staffById(model, a.staff)?.skills.includes(constraint.skill) ?? false;
        });
        const qualifier = constraint.skill ? ` with skill "${constraint.skill}"` : '';
        if (present.length < constraint.min) {
          out.push({
            ...base,
            message: `${slotLabel(model, slot)} has ${present.length} staff${qualifier}, needs at least ${constraint.min}.`,
            slots: [slot],
            overBy: constraint.min - present.length,
          });
        } else if (constraint.max !== undefined && present.length > constraint.max) {
          out.push({
            ...base,
            message: `${slotLabel(model, slot)} has ${present.length} staff${qualifier}, allows at most ${constraint.max}.`,
            slots: [slot],
            overBy: present.length - constraint.max,
          });
        }
      }
      break;
    }

    case 'max_shifts': {
      for (const staff of resolveStaff(model, constraint.staff)) {
        const worked = index.forStaff(staff).length;
        if (worked > constraint.max) {
          out.push({
            ...base,
            message: `${staff} works ${worked} shifts, limit is ${constraint.max}.`,
            staff: [staff],
            overBy: worked - constraint.max,
          });
        }
      }
      break;
    }

    case 'min_shifts': {
      for (const staff of resolveStaff(model, constraint.staff)) {
        const worked = index.forStaff(staff).length;
        if (worked < constraint.min) {
          out.push({
            ...base,
            message: `${staff} works ${worked} shifts, minimum is ${constraint.min}.`,
            staff: [staff],
            overBy: constraint.min - worked,
          });
        }
      }
      break;
    }

    case 'one_shift_per_day': {
      for (const staff of resolveStaff(model, constraint.staff)) {
        const perDay = new Map<number, Assignment[]>();
        for (const a of index.forStaff(staff)) {
          const list = perDay.get(a.day);
          if (list) list.push(a);
          else perDay.set(a.day, [a]);
        }
        for (const [day, list] of perDay) {
          if (list.length > 1) {
            out.push({
              ...base,
              message: `${staff} is rostered ${list.length} times on day ${day}; only one shift per day is allowed.`,
              staff: [staff],
              slots: list.map((a) => ({ day: a.day, shift: a.shift })),
              overBy: list.length - 1,
            });
          }
        }
      }
      break;
    }

    case 'min_rest': {
      const required = constraint.hours * 60;
      for (const staff of resolveStaff(model, constraint.staff)) {
        const worked = index.forStaff(staff);
        for (let i = 0; i < worked.length; i++) {
          for (let j = i + 1; j < worked.length; j++) {
            const first = worked[i]!;
            const second = worked[j]!;
            const gap = restBetween(model, first, second);
            if (gap === null || gap >= required) continue;
            out.push({
              ...base,
              message: `${staff} gets ${(gap / 60).toFixed(1)}h rest between ${slotLabel(model, first)} and ${slotLabel(model, second)}; ${constraint.hours}h required.`,
              staff: [staff],
              slots: [
                { day: first.day, shift: first.shift },
                { day: second.day, shift: second.shift },
              ],
              overBy: (required - gap) / 60,
            });
          }
        }
      }
      break;
    }

    case 'max_consecutive_days': {
      for (const staff of resolveStaff(model, constraint.staff)) {
        const days = [...new Set(index.forStaff(staff).map((a) => a.day))].sort((a, b) => a - b);
        let runStart = 0;
        for (let i = 0; i <= days.length; i++) {
          const broken = i === days.length || (i > 0 && days[i]! !== days[i - 1]! + 1);
          if (!broken) continue;
          const runLength = i - runStart;
          if (runLength > constraint.max) {
            out.push({
              ...base,
              message: `${staff} works ${runLength} days in a row (days ${days[runStart]}–${days[i - 1]}); limit is ${constraint.max}.`,
              staff: [staff],
              overBy: runLength - constraint.max,
            });
          }
          runStart = i;
        }
      }
      break;
    }

    case 'unavailable': {
      for (const slot of constraint.slots) {
        if (index.worksSlot(constraint.staff, slot)) {
          out.push({
            ...base,
            message: `${constraint.staff} is rostered on ${slotLabel(model, slot)} but is unavailable.`,
            staff: [constraint.staff],
            slots: [slot],
            overBy: 1,
          });
        }
      }
      break;
    }

    case 'time_off': {
      if (constraint.status === 'declined') break;
      for (const slot of constraint.slots) {
        if (index.worksSlot(constraint.staff, slot)) {
          out.push({
            ...base,
            message: `${constraint.staff} is rostered on ${slotLabel(model, slot)} during ${constraint.status} time off.`,
            staff: [constraint.staff],
            slots: [slot],
            overBy: 1,
          });
        }
      }
      break;
    }

    case 'anti_pair': {
      for (const slot of sharedSlots(model, index, constraint.a, constraint.b)) {
        out.push({
          ...base,
          message: `${constraint.a} and ${constraint.b} share ${slotLabel(model, slot)} but must not work together.`,
          staff: [constraint.a, constraint.b],
          slots: [slot],
          overBy: 1,
        });
      }
      break;
    }

    case 'pair': {
      for (const person of [constraint.a, constraint.b] as const) {
        const partner = person === constraint.a ? constraint.b : constraint.a;
        for (const a of index.forStaff(person)) {
          const slot: Slot = { day: a.day, shift: a.shift };
          if (!index.worksSlot(partner, slot)) {
            out.push({
              ...base,
              message: `${person} works ${slotLabel(model, slot)} without ${partner}; they must be rostered together.`,
              staff: [person, partner],
              slots: [slot],
              overBy: 1,
            });
          }
        }
      }
      break;
    }

    case 'preference': {
      for (const slot of constraint.slots) {
        const works = index.worksSlot(constraint.staff, slot);
        const satisfied = constraint.direction === 'want' ? works : !works;
        if (!satisfied) {
          out.push({
            ...base,
            message:
              constraint.direction === 'want'
                ? `${constraint.staff} asked to work ${slotLabel(model, slot)} but is not rostered.`
                : `${constraint.staff} asked to avoid ${slotLabel(model, slot)} but is rostered.`,
            staff: [constraint.staff],
            slots: [slot],
            overBy: 1,
          });
        }
      }
      break;
    }

    case 'fairness': {
      const spread = fairnessSpread(model, index, constraint.dimension);
      if (spread.gap > 1) {
        out.push({
          ...base,
          message: `${constraint.dimension} load ranges from ${spread.min} to ${spread.max} across the team (gap ${spread.gap}).`,
          overBy: spread.gap - 1,
        });
      }
      break;
    }
  }

  return out;
}

/**
 * Minutes of rest between two assignments, or `null` when they are the same assignment
 * or overlap outright (overlap is caught by `one_shift_per_day`).
 */
function restBetween(model: RosterModel, a: Assignment, b: Assignment): number | null {
  const first = slotStart(model, a) <= slotStart(model, b) ? a : b;
  const second = first === a ? b : a;
  const gap = slotStart(model, second) - slotEnd(model, first);
  return gap < 0 ? 0 : gap;
}

function sharedSlots(
  model: RosterModel,
  index: ScheduleIndex,
  a: StaffId,
  b: StaffId,
): Slot[] {
  const out: Slot[] = [];
  for (const assignment of index.forStaff(a)) {
    const slot: Slot = { day: assignment.day, shift: assignment.shift };
    if (index.worksSlot(b, slot)) out.push(slot);
  }
  return out;
}

function fairnessSpread(
  model: RosterModel,
  index: ScheduleIndex,
  dimension: 'total' | 'nights' | 'weekends',
): { min: number; max: number; gap: number } {
  const counts = model.staff.map((s) => countFor(model, index.forStaff(s.id), dimension));
  if (counts.length === 0) return { min: 0, max: 0, gap: 0 };
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return { min, max, gap: max - min };
}

function countFor(
  model: RosterModel,
  assignments: Assignment[],
  dimension: 'total' | 'nights' | 'weekends',
): number {
  if (dimension === 'total') return assignments.length;
  if (dimension === 'nights') {
    return assignments.filter((a) => {
      const shift = shiftById(model, a.shift);
      return shift ? isNightShift(shift) : false;
    }).length;
  }
  return assignments.filter((a) => isWeekend(model.horizon, a.day)).length;
}

function statsFor(model: RosterModel, schedule: Schedule, index: ScheduleIndex): ScheduleStats {
  const perStaff: ScheduleStats['perStaff'] = {};
  for (const s of model.staff) {
    const worked = index.forStaff(s.id);
    perStaff[s.id] = {
      total: countFor(model, worked, 'total'),
      nights: countFor(model, worked, 'nights'),
      weekends: countFor(model, worked, 'weekends'),
    };
  }

  const uncovered: string[] = [];
  for (const constraint of model.constraints) {
    if (constraint.kind !== 'coverage') continue;
    for (const day of resolveDays(model, constraint.day)) {
      const slot: Slot = { day, shift: constraint.shift };
      const present = index.inSlot(slot).filter((a) => {
        if (!constraint.skill) return true;
        return staffById(model, a.staff)?.skills.includes(constraint.skill) ?? false;
      });
      if (present.length < constraint.min) uncovered.push(slotKey(slot));
    }
  }

  return { assignments: schedule.length, perStaff, uncovered: [...new Set(uncovered)] };
}

/** `"Tue day 2 · Night"` — readable, and free of anybody's name. */
export function slotLabel(model: RosterModel, slot: Slot | Assignment): string {
  const shift = shiftById(model, slot.shift);
  return `day ${slot.day} ${shift?.label ?? slot.shift}`;
}

export { ScheduleIndex };
