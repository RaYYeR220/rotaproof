/**
 * Roster model → mixed-integer program.
 *
 * One binary per (person, day, shift). Everything else is a linear row over those
 * binaries, tagged with the id of the roster rule it came from so the solver's answers
 * can be translated back into sentences.
 *
 * Soft rules never become rows. They are priced into the objective — as a coefficient on
 * an existing binary where possible, and as a slack variable only where a shortfall has
 * to be measured. That keeps the feasibility question (which the deletion filter asks
 * hundreds of times) as small and as fast as it can be.
 */

import {
  type Assignment,
  type Constraint,
  type ConstraintId,
  type FairnessLedger,
  type RosterModel,
  type Slot,
  type StaffId,
  EMPTY_LEDGER,
  allSlots,
  SOFT_PENALTY_MODE,
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
import { type MipProblem, MipBuilder, lpName } from './mip.js';

/** Cost applied to every rostered shift, so nobody is scheduled for no reason. */
export const ASSIGNMENT_COST = 0.01;

export interface CompiledRoster {
  problem: MipProblem;
  /**
   * Constant added to the solver's objective to get the reported penalty. Comes from
   * writing "wants to work" preferences in penalty form (`w · (1 − x)`).
   */
  objectiveOffset: number;
  /** Decision variable name → the assignment it represents. */
  assignmentVars: Map<string, Assignment>;
  /** LP row name → the roster constraint that produced it. */
  rowSources: Map<string, ConstraintId>;
  stats: { variables: number; rows: number; slots: number };
}

export interface CompileOptions {
  ledger?: FairnessLedger;
  /** Drops the objective entirely; the program then only answers "is this possible?". */
  feasibilityOnly?: boolean;
}

export function compileRoster(model: RosterModel, options: CompileOptions = {}): CompiledRoster {
  const ledger = options.ledger ?? EMPTY_LEDGER;
  const feasibilityOnly = options.feasibilityOnly ?? false;
  const builder = new MipBuilder();
  const assignmentVars = new Map<string, Assignment>();
  const slots = allSlots(model);
  let objectiveOffset = 0;

  const varFor = (staff: StaffId, slot: Slot): string => lpName('x', staff, `d${slot.day}`, slot.shift);

  for (const person of model.staff) {
    for (const slot of slots) {
      const name = varFor(person.id, slot);
      builder.variable(name, 'binary');
      assignmentVars.set(name, { day: slot.day, shift: slot.shift, staff: person.id });
      if (!feasibilityOnly) builder.addObjective(name, ASSIGNMENT_COST);
    }
  }

  const penalty = (name: string, weight: number) => {
    if (!feasibilityOnly) builder.addObjective(name, weight);
  };

  /**
   * A penalty variable for a soft rule.
   *
   * Rules whose breach has a natural size - two people short, three days over - get a
   * continuous variable measuring it. Rules whose breach does not get a binary indicator.
   * `SOFT_PENALTY_MODE` records which is which, and the checker reads the same table, so
   * the objective and the reported soft cost end up being the same number.
   */
  const slack = (constraint: Constraint, suffix: string | number, upperBound: number): string => {
    const name = lpName('pen', constraint.id, suffix);
    const indicator = SOFT_PENALTY_MODE[constraint.kind] === 'count';
    builder.variable(name, indicator ? 'binary' : 'continuous', 0, indicator ? 1 : upperBound);
    penalty(name, constraint.weight ?? 1);
    return name;
  };

  /**
   * A binary that is 1 whenever the person works anything that day.
   *
   * Only `max_consecutive_days` needs it, and only because the checker counts *days* in a
   * run while the obvious compilation counts *shifts*. Without it the two disagree the
   * moment somebody could work twice in a day, and the solver reports "no schedule exists"
   * for a week the checker is perfectly happy with.
   */
  const dayWorkedVars = new Map<string, string>();
  const dayWorked = (staff: StaffId, day: number): string => {
    const key = `${staff}:${day}`;
    const existing = dayWorkedVars.get(key);
    if (existing) return existing;

    const name = lpName('works', staff, `d${day}`);
    builder.variable(name, 'binary');
    for (const shift of model.shiftTypes) {
      // x <= worked, so any shift that day forces the day flag on. Nothing rewards the
      // flag, so the solver leaves it at zero otherwise.
      builder.row(
        [
          [varFor(staff, { day, shift: shift.id }), 1],
          [name, -1],
        ],
        '<=',
        0,
      );
    }
    dayWorkedVars.set(key, name);
    return name;
  };

  for (const constraint of model.constraints) {
    const hard = constraint.hardness === 'hard';
    const weight = constraint.weight ?? 1;

    // A soft rule contributes nothing to a feasibility-only program.
    if (!hard && feasibilityOnly) continue;

    switch (constraint.kind) {
      case 'coverage': {
        for (const day of resolveDays(model, constraint.day)) {
          const slot: Slot = { day, shift: constraint.shift };
          const eligible = model.staff
            .filter((s) => !constraint.skill || s.skills.includes(constraint.skill))
            .map((s) => [varFor(s.id, slot), 1] as [string, number]);

          if (hard) {
            builder.row(eligible, '>=', constraint.min, constraint.id);
            if (constraint.max !== undefined) {
              builder.row(eligible, '<=', constraint.max, constraint.id);
            }
          } else {
            // Measure the shortfall so the objective can pay for it.
            const short = slack(constraint, `short_d${day}`, constraint.min);
            builder.row([...eligible, [short, 1]], '>=', constraint.min, constraint.id);
            if (constraint.max !== undefined) {
              // And the overshoot. An earlier version dropped this side entirely, which
              // left the checker billing for a ceiling the solver had no reason to keep.
              const over = slack(constraint, `over_d${day}`, model.staff.length);
              builder.row([...eligible, [over, -1]], '<=', constraint.max, constraint.id);
            }
          }
        }
        break;
      }

      case 'max_shifts': {
        for (const staff of resolveStaff(model, constraint.staff)) {
          const terms = slots.map((slot) => [varFor(staff, slot), 1] as [string, number]);
          if (hard) builder.row(terms, '<=', constraint.max, constraint.id);
          else {
            const over = slack(constraint, staff, slots.length);
            builder.row([...terms, [over, -1]], '<=', constraint.max, constraint.id);
          }
        }
        break;
      }

      case 'min_shifts': {
        for (const staff of resolveStaff(model, constraint.staff)) {
          const terms = slots.map((slot) => [varFor(staff, slot), 1] as [string, number]);
          if (hard) builder.row(terms, '>=', constraint.min, constraint.id);
          else {
            const under = slack(constraint, staff, constraint.min);
            builder.row([...terms, [under, 1]], '>=', constraint.min, constraint.id);
          }
        }
        break;
      }

      case 'one_shift_per_day': {
        for (const staff of resolveStaff(model, constraint.staff)) {
          for (let day = 0; day < model.horizon.days; day++) {
            const terms = model.shiftTypes.map(
              (shift) => [varFor(staff, { day, shift: shift.id }), 1] as [string, number],
            );
            if (hard) builder.row(terms, '<=', 1, constraint.id);
            else {
              const over = slack(constraint, `${staff}_d${day}`, model.shiftTypes.length - 1);
              builder.row([...terms, [over, -1]], '<=', 1, constraint.id);
            }
          }
        }
        break;
      }

      case 'min_rest': {
        const requiredMinutes = constraint.hours * 60;
        const pairs = conflictingPairs(model, slots, requiredMinutes);
        for (const [index, [a, b]] of pairs.entries()) {
          for (const staff of resolveStaff(model, constraint.staff)) {
            const terms: Array<[string, number]> = [
              [varFor(staff, a), 1],
              [varFor(staff, b), 1],
            ];
            if (hard) builder.row(terms, '<=', 1, constraint.id);
            else {
              const breach = slack(constraint, `${staff}_${index}`, 1);
              builder.row([...terms, [breach, -1]], '<=', 1, constraint.id);
            }
          }
        }
        break;
      }

      case 'max_consecutive_days': {
        const window = constraint.max + 1;
        if (window > model.horizon.days) break;
        for (const staff of resolveStaff(model, constraint.staff)) {
          for (let start = 0; start + window <= model.horizon.days; start++) {
            // Days worked, not shifts worked. The checker counts runs of days, and the two
            // only coincide when something else already forbids a double shift.
            const terms: Array<[string, number]> = [];
            for (let day = start; day < start + window; day++) terms.push([dayWorked(staff, day), 1]);

            if (hard) builder.row(terms, '<=', constraint.max, constraint.id);
            else {
              const over = slack(constraint, `${staff}_${start}`, window);
              builder.row([...terms, [over, -1]], '<=', constraint.max, constraint.id);
            }
          }
        }
        break;
      }

      case 'unavailable':
      case 'time_off': {
        if (constraint.kind === 'time_off' && constraint.status === 'declined') break;
        for (const slot of constraint.slots) {
          const name = varFor(constraint.staff, slot);
          if (hard) builder.row([[name, 1]], '=', 0, constraint.id);
          else penalty(name, weight);
        }
        break;
      }

      case 'anti_pair': {
        for (const slot of slots) {
          const terms: Array<[string, number]> = [
            [varFor(constraint.a, slot), 1],
            [varFor(constraint.b, slot), 1],
          ];
          if (hard) builder.row(terms, '<=', 1, constraint.id);
          else {
            const together = slack(constraint, slotKey(slot), 1);
            builder.row([...terms, [together, -1]], '<=', 1, constraint.id);
          }
        }
        break;
      }

      case 'pair': {
        for (const slot of slots) {
          const a = varFor(constraint.a, slot);
          const b = varFor(constraint.b, slot);
          if (hard) {
            builder.row(
              [
                [a, 1],
                [b, -1],
              ],
              '=',
              0,
              constraint.id,
            );
          } else {
            // |x_a - x_b| <= apart, priced once per slot they fail to share.
            const apart = slack(constraint, slotKey(slot), 1);
            builder.row(
              [
                [a, 1],
                [b, -1],
                [apart, -1],
              ],
              '<=',
              0,
              constraint.id,
            );
            builder.row(
              [
                [b, 1],
                [a, -1],
                [apart, -1],
              ],
              '<=',
              0,
              constraint.id,
            );
          }
        }
        break;
      }

      case 'must_work': {
        for (const slot of constraint.slots) {
          const name = varFor(constraint.staff, slot);
          if (hard) builder.row([[name, 1]], '=', 1, constraint.id);
          else {
            // w*(1 - x): a constant, minus a reward for actually rostering them.
            objectiveOffset += weight;
            penalty(name, -weight);
          }
        }
        break;
      }

      case 'preference': {
        for (const slot of constraint.slots) {
          const name = varFor(constraint.staff, slot);
          if (constraint.direction === 'avoid') {
            penalty(name, weight);
          } else {
            // w · (1 − x): a constant, minus a reward for actually rostering them.
            objectiveOffset += weight;
            penalty(name, -weight);
          }
        }
        break;
      }

      case 'fairness': {
        compileFairness(model, constraint.id, constraint.dimension, weight, ledger, builder, varFor, slots, penalty);
        break;
      }
    }
  }

  const problem = builder.build('min');
  const rowSources = new Map<string, ConstraintId>();
  for (const row of problem.rows) {
    if (row.source) rowSources.set(row.name, row.source);
  }

  return {
    problem,
    objectiveOffset,
    assignmentVars,
    rowSources,
    stats: { variables: problem.vars.length, rows: problem.rows.length, slots: slots.length },
  };
}

/**
 * Fairness as a minimax.
 *
 * `spread = busiest − quietest`, and the objective pays for the spread. Two continuous
 * variables and two rows per person is all it costs, and unlike a variance penalty it
 * stays linear, so the whole model remains a MIP the solver can prove optimal.
 *
 * Counts already carried from published weeks land on the right-hand side, which is why
 * someone who worked the last three weekends starts this week already "ahead".
 */
function compileFairness(
  model: RosterModel,
  id: ConstraintId,
  dimension: 'total' | 'nights' | 'weekends',
  weight: number,
  ledger: FairnessLedger,
  builder: MipBuilder,
  varFor: (staff: StaffId, slot: Slot) => string,
  slots: Slot[],
  penalty: (name: string, weight: number) => void,
): void {
  if (model.staff.length < 2) return;

  const relevant = slots.filter((slot) => {
    if (dimension === 'total') return true;
    if (dimension === 'weekends') return isWeekend(model.horizon, slot.day);
    const shift = shiftById(model, slot.shift);
    return shift ? isNightShift(shift) : false;
  });
  if (relevant.length === 0) return;

  const upper = lpName('fair', id, 'hi');
  const lower = lpName('fair', id, 'lo');
  const ceiling = relevant.length + maxHistory(ledger, dimension);
  builder.variable(upper, 'continuous', 0, ceiling);
  builder.variable(lower, 'continuous', 0, ceiling);
  penalty(upper, weight);
  penalty(lower, -weight);

  for (const person of model.staff) {
    const carried = ledger.history[person.id]?.[dimension] ?? 0;
    const terms = relevant.map((slot) => [varFor(person.id, slot), 1] as [string, number]);
    // upper >= carried + Σx   →   upper − Σx >= carried
    builder.row([[upper, 1], ...terms.map(([n]) => [n, -1] as [string, number])], '>=', carried, id);
    // lower <= carried + Σx   →   lower − Σx <= carried
    builder.row([[lower, 1], ...terms.map(([n]) => [n, -1] as [string, number])], '<=', carried, id);
  }
}

function maxHistory(ledger: FairnessLedger, dimension: 'total' | 'nights' | 'weekends'): number {
  const values = Object.values(ledger.history).map((h) => h[dimension] ?? 0);
  return values.length > 0 ? Math.max(...values) : 0;
}

/**
 * Slot pairs that cannot both be worked by one person given a required rest gap.
 *
 * Includes outright overlaps, which is what makes a night shift crossing midnight
 * conflict with the next morning without any special-casing of calendar days.
 */
function conflictingPairs(
  model: RosterModel,
  slots: Slot[],
  requiredMinutes: number,
): Array<[Slot, Slot]> {
  const ordered = [...slots].sort((a, b) => slotStart(model, a) - slotStart(model, b));
  const pairs: Array<[Slot, Slot]> = [];

  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const first = ordered[i]!;
      const second = ordered[j]!;
      const gap = slotStart(model, second) - slotEnd(model, first);
      if (gap >= requiredMinutes) break; // later slots are only further away
      if (slotKey(first) === slotKey(second)) continue;
      pairs.push([first, second]);
    }
  }
  return pairs;
}

/** Reads a solved variable vector back into assignments. */
export function scheduleFromSolution(
  compiled: CompiledRoster,
  values: Record<string, number>,
): Assignment[] {
  const out: Assignment[] = [];
  for (const [name, assignment] of compiled.assignmentVars) {
    if ((values[name] ?? 0) > 0.5) out.push(assignment);
  }
  return out.sort(
    (a, b) => a.day - b.day || a.shift.localeCompare(b.shift) || a.staff.localeCompare(b.staff),
  );
}

/** Groups LP row duals back onto the roster rules that produced them. */
export function shadowPricesByConstraint(
  compiled: CompiledRoster,
  duals: Record<string, number>,
): Record<ConstraintId, number> {
  const out: Record<ConstraintId, number> = {};
  for (const [rowName, constraintId] of compiled.rowSources) {
    const dual = duals[rowName];
    if (dual === undefined || Math.abs(dual) < 1e-9) continue;
    out[constraintId] = (out[constraintId] ?? 0) + Math.abs(dual);
  }
  return out;
}

export type { MipProblem };
export { staffById };
