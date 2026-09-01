/**
 * Solve, and — when there is nothing to solve — explain.
 *
 * The interesting half of this file is `explainConflict`. When a roster is impossible,
 * a language model will happily produce a plausible-looking schedule anyway. This page
 * cannot: it runs a deletion filter over the hard constraints and returns a *minimal*
 * set that cannot hold together. Minimal in the precise sense — drop any one member and
 * the rest become satisfiable. That set is a fact about the model, not an opinion about
 * it, and it is what turns "no" into something a human can act on.
 *
 * The backend is kept behind an interface so the deletion filter, the receipts and the
 * tests are all independent of which WebAssembly solver is loaded underneath.
 */

import { type CheckResult, check } from './check.js';
import {
  type Constraint,
  type ConstraintId,
  type FairnessLedger,
  type RosterModel,
  type Schedule,
  EMPTY_LEDGER,
  canonicalize,
} from './model.js';

export type SolveStatus = 'optimal' | 'feasible' | 'infeasible' | 'timeout' | 'error';

export interface SolveOptions {
  /** Wall-clock budget for a single solve. Deletion filtering gets its own, smaller budget. */
  timeLimitMs?: number;
  signal?: AbortSignal;
  /** Carried over from previously published weeks so fairness compounds correctly. */
  ledger?: FairnessLedger;
  /** Skip conflict explanation. Used by the deletion filter itself to avoid recursion. */
  explain?: boolean;
}

export const DEFAULT_TIME_LIMIT_MS = 10_000;
/** Each probe inside the deletion filter is cheap; a low cap keeps explanations interactive. */
export const CONFLICT_PROBE_TIME_LIMIT_MS = 1_500;

/** What a solver backend must be able to do. Deliberately small. */
export interface SolverBackend {
  /** Reported in receipts, so a result can be reproduced against the same build. */
  readonly version: string;
  solve(model: RosterModel, options: BackendOptions): Promise<BackendResult>;
}

export interface BackendOptions {
  timeLimitMs: number;
  signal?: AbortSignal;
  ledger: FairnessLedger;
  /** When true the objective is dropped and only feasibility is decided. Much faster. */
  feasibilityOnly?: boolean;
}

export interface BackendResult {
  status: SolveStatus;
  schedule?: Schedule;
  objective?: number;
  /** Optimality gap for a MIP stopped early. */
  gap?: number;
  /**
   * Cost of the binding soft constraints, from the LP relaxation's duals. This is the
   * number a model cannot invent: what one more unit of a rule actually costs.
   */
  shadowPrices?: Record<ConstraintId, number>;
  message?: string;
}

/** A relaxation the human could make, and what it would buy. */
export interface ConflictSuggestion {
  constraintId: ConstraintId;
  label: string;
  /** Agent-safe description of what changes if this rule is dropped or loosened. */
  effect: string;
  /**
   * Whether relaxing *only* this rule makes the real roster solvable.
   *
   * The conflict set is minimal within itself, which is weaker than it sounds: a rule can
   * be load-bearing for this clash and still leave a second, independent one behind when
   * it goes. Telling a manager to relax it and watching the week fail again is the worst
   * outcome this product has, so every option is tested against the whole model.
   */
  sufficient: boolean;
}

export interface ConflictExplanation {
  /** Minimal set: remove any one of these and the remaining hard rules are satisfiable. */
  constraintIds: ConstraintId[];
  groups: string[];
  /** One sentence a human can read out loud. */
  narrative: string;
  suggestions: ConflictSuggestion[];
  /** Solves spent finding it, quoted in the UI so the cost of "why not?" is visible. */
  probes: number;
  /**
   * Probes that neither proved nor disproved anything: a timeout, a solver error or a
   * cancellation. Anything above zero means the set is an upper bound rather than a proof,
   * and the narrative says so instead of claiming a minimality it cannot support.
   */
  inconclusive: number;
  wallMs: number;
}

export interface Receipt {
  /** SHA-256 over the canonical model. Same model in, same hash out. */
  modelHash: string;
  solverVersion: string;
  status: SolveStatus;
  objective?: number;
  scheduleHash?: string;
  conflictHash?: string;
  wallMs: number;
  createdAt: string;
  timeLimitMs: number;
}

export interface SolveResult {
  status: SolveStatus;
  schedule?: Schedule;
  objective?: number;
  gap?: number;
  shadowPrices?: Record<ConstraintId, number>;
  conflict?: ConflictExplanation;
  /** The solved schedule re-checked against the model, as a self-audit. */
  verification?: CheckResult;
  wallMs: number;
  receipt: Receipt;
  message?: string;
}

/**
 * Solves a roster and, when it cannot, explains why.
 *
 * The returned schedule is always fed back through `check()` before it is handed out.
 * If the checker and the solver ever disagree the result is downgraded to `error` rather
 * than returned — a wrong roster presented confidently is worse than no roster.
 */
export async function solveRoster(
  model: RosterModel,
  backend: SolverBackend,
  options: SolveOptions = {},
): Promise<SolveResult> {
  const started = now();
  const timeLimitMs = options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
  const ledger = options.ledger ?? EMPTY_LEDGER;

  let result: BackendResult;
  try {
    result = await backend.solve(model, { timeLimitMs, signal: options.signal, ledger });
  } catch (error) {
    const wallMs = now() - started;
    return {
      status: 'error',
      wallMs,
      message: error instanceof Error ? error.message : String(error),
      receipt: await makeReceipt(model, backend, 'error', undefined, undefined, undefined, wallMs, timeLimitMs),
    };
  }

  if (result.status === 'infeasible' && options.explain !== false) {
    const conflict = await explainConflict(model, backend, options);
    const wallMs = now() - started;
    return {
      status: 'infeasible',
      conflict,
      wallMs,
      receipt: await makeReceipt(
        model,
        backend,
        'infeasible',
        undefined,
        undefined,
        conflict,
        wallMs,
        timeLimitMs,
      ),
    };
  }

  const verification = result.schedule ? check(model, result.schedule) : undefined;
  const wallMs = now() - started;

  // The solver claimed a schedule the checker rejects. Trust neither; report the mismatch.
  if (verification && !verification.ok) {
    return {
      status: 'error',
      schedule: result.schedule,
      verification,
      wallMs,
      message:
        'The solver returned a schedule that fails the independent checker. This is a bug; the schedule is not safe to publish.',
      receipt: await makeReceipt(model, backend, 'error', result.objective, result.schedule, undefined, wallMs, timeLimitMs),
    };
  }

  return {
    status: result.status,
    schedule: result.schedule,
    objective: result.objective,
    gap: result.gap,
    shadowPrices: result.shadowPrices,
    verification,
    wallMs,
    message: result.message,
    receipt: await makeReceipt(
      model,
      backend,
      result.status,
      result.objective,
      result.schedule,
      undefined,
      wallMs,
      timeLimitMs,
    ),
  };
}

/**
 * Deletion filtering, in two passes.
 *
 * Start from the full hard set, which is known infeasible. Take each candidate in turn
 * and ask whether the model is *still* impossible without it. If it is, that candidate
 * was not to blame and stays out permanently. If dropping it makes the model solvable,
 * it is load-bearing and goes back in. What survives is irreducible: remove any single
 * member and the rest are satisfiable.
 *
 * The first pass runs over named groups — coverage, keyholder cover, working time,
 * contracts — which is cheap, because there are far fewer groups than rules. The second
 * pass then filters the individual rules inside the surviving groups. Without it the
 * answer stays technically minimal but reads badly: "availability" would implicate every
 * absence in the week, including the four that have nothing to do with the clash. With
 * it, the result is the sentence a manager would have said themselves.
 */
export async function explainConflict(
  model: RosterModel,
  backend: SolverBackend,
  options: SolveOptions = {},
): Promise<ConflictExplanation> {
  const started = now();
  const ledger = options.ledger ?? EMPTY_LEDGER;
  const probeOptions: BackendOptions = {
    timeLimitMs: CONFLICT_PROBE_TIME_LIMIT_MS,
    signal: options.signal,
    ledger,
    feasibilityOnly: true,
  };

  const hard = model.constraints.filter((c) => c.hardness === 'hard');
  let probes = 0;
  let inconclusive = 0;

  /** Solves a trial model, counting anything that is not a clean verdict. */
  const decide = async (trial: RosterModel): Promise<'infeasible' | 'solvable' | 'unknown'> => {
    probes++;
    // A backend can throw rather than return: an LP parse error surfaces as an exception,
    // not a status.
    let outcome: BackendResult;
    try {
      outcome = await backend.solve(trial, probeOptions);
    } catch {
      inconclusive++;
      return 'unknown';
    }
    if (outcome.status === 'infeasible') return 'infeasible';
    if (outcome.status === 'optimal' || outcome.status === 'feasible') return 'solvable';
    // A timeout proves nothing either way.
    inconclusive++;
    return 'unknown';
  };

  /** Group key for a constraint that is still a candidate; unique per constraint otherwise. */
  const groupOf = (c: Constraint) => c.group ?? c.id;

  /** Runs one deletion-filter pass over `candidates`, keyed by `keyOf`. */
  const filter = async <T>(
    candidates: T[],
    keyOf: (candidate: T) => string,
    memberOf: (constraint: Constraint) => string | undefined,
  ): Promise<Set<string>> => {
    const suspects = new Set(candidates.map(keyOf));
    for (const key of [...suspects]) {
      if (options.signal?.aborted) {
        // Everything not yet examined stays in, and the caller is told the answer is
        // incomplete rather than handed a short list that looks like a proof.
        inconclusive++;
        break;
      }
      const trial: RosterModel = {
        ...model,
        constraints: model.constraints.filter((c) => {
          if (c.hardness !== 'hard') return true;
          const member = memberOf(c);
          return member !== undefined && suspects.has(member) && member !== key;
        }),
      };
      // Still impossible without it, so it was not the cause: leave it out for good.
      // Anything inconclusive keeps the candidate in, so the answer comes out broader than
      // necessary rather than wrong, which is the right way round for a proof.
      if ((await decide(trial)) === 'infeasible') suspects.delete(key);
    }
    return suspects;
  };

  const survivingGroups = await filter([...new Set(hard.map(groupOf))], (g) => g, groupOf);

  // Second pass: only the rules inside the groups that survived are still candidates, and
  // each is now tested on its own. Constraints from groups that were ruled out map to
  // undefined, which excludes them from every trial rather than letting them back in.
  const narrowed = hard.filter((c) => survivingGroups.has(groupOf(c)));
  const survivingIds = await filter(
    narrowed,
    (c) => c.id,
    (c) => (survivingGroups.has(groupOf(c)) ? c.id : undefined),
  );

  const involved = narrowed.filter((c) => survivingIds.has(c.id));
  const groups = [...new Set(involved.map(groupOf))];

  // Third pass, and the one that makes the advice safe to follow. Minimality *within* the
  // reported set does not mean dropping a member fixes the *real* roster: another rule
  // outside the set can independently block the same thing. Each option is therefore tried
  // against the whole model, so the page never tells somebody to relax a rule that will
  // leave them exactly where they started.
  const suggestions: ConflictSuggestion[] = [];
  for (const constraint of involved) {
    const withoutIt: RosterModel = {
      ...model,
      constraints: model.constraints.filter((c) => c.id !== constraint.id),
    };
    const verdict = options.signal?.aborted ? 'unknown' : await decide(withoutIt);
    suggestions.push({ ...suggest(constraint), sufficient: verdict === 'solvable' });
  }

  return {
    constraintIds: involved.map((c) => c.id),
    groups,
    narrative: narrate(involved, groups, suggestions, inconclusive),
    suggestions,
    probes,
    inconclusive,
    wallMs: now() - started,
  };
}

function narrate(
  involved: Constraint[],
  groups: string[],
  suggestions: ConflictSuggestion[],
  inconclusive: number,
): string {
  if (involved.length === 0) {
    return 'The roster is impossible, but no single group of rules explains it. That usually means a constraint references staff or shifts that do not exist.';
  }

  // An unfinished probe means the set could not be narrowed all the way. Saying so is the
  // difference between a proof and a shrug, and a reader is entitled to know which one
  // they are holding.
  const caveat =
    inconclusive > 0
      ? ` ${inconclusive} check${inconclusive === 1 ? '' : 's'} did not finish, so this list may be wider than it needs to be.`
      : '';

  if (involved.length === 1) {
    return `"${involved[0]!.label}" cannot be satisfied on its own.${caveat}`;
  }

  const labels = involved.map((c) => `"${c.label}"`);
  const last = labels.pop();
  const groupNote = groups.length > 1 ? ` (${groups.join(', ')})` : '';
  const opening = `These rules cannot all hold at once${groupNote}: ${labels.join(', ')} and ${last}.`;

  if (inconclusive > 0) return `${opening} Every one of them is part of the clash.${caveat}`;

  const enough = suggestions.filter((option) => option.sufficient).length;
  if (enough === suggestions.length) {
    return `${opening} Every one of them is needed for the clash, and relaxing any single one makes the week work.`;
  }
  if (enough === 0) {
    return `${opening} Every one is needed, but none of them is enough on its own: another rule blocks the same thing, so more than one will have to give.`;
  }
  return `${opening} Every one of them is needed for the clash, and ${enough} of the ${suggestions.length} would be enough alone. The rest leave a second blocker behind.`;
}

function suggest(constraint: Constraint): Omit<ConflictSuggestion, 'sufficient'> {
  const base = { constraintId: constraint.id, label: constraint.label };
  switch (constraint.kind) {
    case 'coverage':
      return {
        ...base,
        effect: `Lower the minimum from ${constraint.min} on ${constraint.shift}, or widen who counts towards it.`,
      };
    case 'max_shifts':
      return { ...base, effect: `Raise ${constraint.staff}'s cap above ${constraint.max} shifts.` };
    case 'min_shifts':
      return { ...base, effect: `Reduce ${constraint.staff}'s guaranteed minimum below ${constraint.min} shifts.` };
    case 'min_rest':
      return { ...base, effect: `Shorten the required rest below ${constraint.hours} hours, for this week only.` };
    case 'max_consecutive_days':
      return { ...base, effect: `Allow more than ${constraint.max} consecutive days.` };
    case 'unavailable':
      return { ...base, effect: `Ask ${constraint.staff} whether any of these ${constraint.slots.length} slots can open up.` };
    case 'must_work':
      return { ...base, effect: `Stop requiring ${constraint.staff} on those ${constraint.slots.length} slots.` };
    case 'time_off':
      return { ...base, effect: `Decline or shorten ${constraint.staff}'s time-off request.` };
    case 'one_shift_per_day':
      return { ...base, effect: 'Permit a double shift for one person on one day.' };
    case 'anti_pair':
      return { ...base, effect: `Allow ${constraint.a} and ${constraint.b} to share a shift.` };
    case 'pair':
      return { ...base, effect: `Stop requiring ${constraint.a} and ${constraint.b} to work together.` };
    default:
      return { ...base, effect: 'Relax or remove this rule.' };
  }
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * A receipt is the claim "this model produced this answer" reduced to something a third
 * party can re-run. `verify-receipt` in the repo re-solves from the same model hash and
 * asserts the same status and objective come back.
 */
async function makeReceipt(
  model: RosterModel,
  backend: SolverBackend,
  status: SolveStatus,
  objective: number | undefined,
  schedule: Schedule | undefined,
  conflict: ConflictExplanation | undefined,
  wallMs: number,
  timeLimitMs: number,
): Promise<Receipt> {
  const receipt: Receipt = {
    modelHash: await sha256(canonicalize(model)),
    solverVersion: backend.version,
    status,
    wallMs,
    createdAt: new Date().toISOString(),
    timeLimitMs,
  };
  if (objective !== undefined) receipt.objective = objective;
  if (schedule) receipt.scheduleHash = await sha256(canonicalize(sortSchedule(schedule)));
  if (conflict) receipt.conflictHash = await sha256(canonicalize([...conflict.constraintIds].sort()));
  return receipt;
}

/** Assignment order is not meaningful, so it must not change the hash. */
function sortSchedule(schedule: Schedule): Schedule {
  return [...schedule].sort(
    (a, b) => a.day - b.day || a.shift.localeCompare(b.shift) || a.staff.localeCompare(b.staff),
  );
}

export async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
