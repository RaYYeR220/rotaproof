/**
 * Fairness across weeks.
 *
 * A single week solved in isolation can be perfectly fair and still be unjust. Spread the
 * weekends evenly every week and the same person can still end up on every fourth Saturday
 * forever, because each week starts from zero and has no idea what happened before it.
 *
 * The ledger is the memory. Publishing a week folds its counts in; the next week's
 * fairness objective starts from those totals rather than from nothing. Somebody who
 * covered the last three weekends begins the new week already ahead, and the solver spends
 * its fairness budget pulling them back down.
 *
 * `compileFairness` in `compile.ts` puts these carried counts on the right-hand side of the
 * minimax rows, which is why the mechanism costs nothing at solve time.
 */

import { check } from './check.js';
import {
  type FairnessLedger,
  type Horizon,
  type RosterModel,
  type Schedule,
  type StaffId,
  dateOf,
} from './model.js';

export interface LedgerEntry {
  total: number;
  nights: number;
  weekends: number;
}

/**
 * Adds a published week's counts to the ledger.
 *
 * Pure: returns a new ledger rather than mutating, so folding the same week twice by
 * mistake is visible in a diff rather than silently doubling somebody's history.
 */
export function foldIntoLedger(
  ledger: FairnessLedger,
  model: RosterModel,
  schedule: Schedule,
): FairnessLedger {
  const stats = check(model, schedule).stats;
  const history: Record<StaffId, LedgerEntry> = {};

  for (const person of model.staff) {
    const carried = ledger.history[person.id] ?? { total: 0, nights: 0, weekends: 0 };
    const week = stats.perStaff[person.id] ?? { total: 0, nights: 0, weekends: 0 };
    history[person.id] = {
      total: carried.total + week.total,
      nights: carried.nights + week.nights,
      weekends: carried.weekends + week.weekends,
    };
  }

  // People who have left the team keep their history: removing them would quietly reset
  // anyone who comes back, and the counts cost nothing.
  for (const [id, entry] of Object.entries(ledger.history)) {
    if (!(id in history)) history[id] = entry;
  }

  return { history };
}

/** The spread the ledger currently carries, which is what the next week starts from. */
export function ledgerSpread(
  ledger: FairnessLedger,
  dimension: keyof LedgerEntry = 'total',
): { min: number; max: number; gap: number; leader?: StaffId } {
  const entries = Object.entries(ledger.history);
  if (entries.length === 0) return { min: 0, max: 0, gap: 0 };

  let min = Infinity;
  let max = -Infinity;
  let leader: StaffId | undefined;

  for (const [id, entry] of entries) {
    const value = entry[dimension];
    if (value < min) min = value;
    if (value > max) {
      max = value;
      leader = id;
    }
  }

  const result: { min: number; max: number; gap: number; leader?: StaffId } = {
    min,
    max,
    gap: max - min,
  };
  if (leader !== undefined) result.leader = leader;
  return result;
}

/**
 * Moves the model on to the following horizon.
 *
 * Structural rules — coverage, contracts, working time, who can do what — carry over
 * unchanged, because they describe the business rather than the week. Anything pinned to
 * particular days does not: an absence for last Thursday means nothing next Thursday, and
 * silently keeping it would produce a roster nobody could explain.
 *
 * Recurring absences are the awkward case. "S6 cannot work Fridays" is genuinely weekly,
 * while "S9 is away Thursday and Friday" is not, and nothing in the data distinguishes
 * them. Rather than guess, day-pinned rules are dropped and returned to the caller so the
 * page can show what was cleared and let a person re-add what still applies.
 */
export function advanceHorizon(model: RosterModel): {
  model: RosterModel;
  dropped: Array<{ id: string; label: string }>;
} {
  const nextStart = dateOf(model.horizon, model.horizon.days);
  const horizon: Horizon = { startDate: nextStart, days: model.horizon.days };

  const dropped: Array<{ id: string; label: string }> = [];
  const kept = model.constraints.filter((constraint) => {
    const pinned =
      constraint.kind === 'unavailable' ||
      constraint.kind === 'time_off' ||
      constraint.kind === 'preference' ||
      (constraint.kind === 'coverage' && constraint.day !== '*');

    if (!pinned) return true;
    dropped.push({ id: constraint.id, label: constraint.label });
    return false;
  });

  return { model: { ...model, horizon, constraints: kept }, dropped };
}
