/**
 * HiGHS, compiled to WebAssembly, as the solver backend.
 *
 * HiGHS is a real branch-and-cut MIP solver — the same one that sits under a lot of
 * production optimisation work — and it reads CPLEX LP format, which is why the compiler
 * targets that rather than any vendor's object model. Nothing here is aware of rosters;
 * it takes a `RosterModel`, hands the compiler's LP text to the solver, and translates
 * the answer back.
 *
 * The whole thing runs in the visitor's browser. No model, no schedule and no name is
 * ever sent anywhere.
 */

import {
  type CompiledRoster,
  compileRoster,
  scheduleFromSolution,
  shadowPricesByConstraint,
} from './compile.js';
import { relaxIntegrality, toLpFormat } from './mip.js';
import type { RosterModel } from './model.js';
import type { BackendOptions, BackendResult, SolveStatus, SolverBackend } from './solve.js';

/** The subset of the HiGHS result this code reads. */
interface HighsColumn {
  Primal?: number;
  Dual?: number;
}

interface HighsRow {
  Name?: string;
  Dual?: number;
}

interface HighsResult {
  Status: string;
  ObjectiveValue: number | null;
  Columns: Record<string, HighsColumn>;
  Rows: HighsRow[];
}

export interface HighsInstance {
  solve: (lp: string, options?: Record<string, unknown>) => HighsResult;
}

/** Matches the default export of the `highs` package. */
export type HighsLoader = (options?: Record<string, unknown>) => Promise<HighsInstance>;

/**
 * HiGHS reports status as prose. Anything not recognised is treated as an error rather
 * than quietly folded into "infeasible" — reporting "no schedule exists" when the truth
 * is "the solver fell over" would be exactly the kind of confident wrong answer this
 * whole design exists to avoid.
 */
function mapStatus(status: string): SolveStatus {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'optimal') return 'optimal';
  if (normalized === 'infeasible' || normalized === 'primal infeasible') return 'infeasible';
  if (normalized.includes('time limit') || normalized.includes('iteration limit')) return 'timeout';
  if (normalized === 'feasible' || normalized.includes('solution limit')) return 'feasible';
  return 'error';
}

export interface HighsBackendOptions {
  /** Version string recorded in receipts. */
  version?: string;
}

export class HighsBackend implements SolverBackend {
  readonly version: string;
  private readonly highs: HighsInstance;

  constructor(highs: HighsInstance, options: HighsBackendOptions = {}) {
    this.highs = highs;
    this.version = options.version ?? 'highs-wasm';
  }

  /** Loads the WebAssembly module. `locateFile` is needed when the wasm is served separately. */
  static async create(loader: HighsLoader, options: Record<string, unknown> = {}): Promise<HighsBackend> {
    const instance = await loader(options);
    return new HighsBackend(instance, {
      version: typeof options.version === 'string' ? options.version : 'highs-wasm@1.15',
    });
  }

  async solve(model: RosterModel, options: BackendOptions): Promise<BackendResult> {
    if (options.signal?.aborted) return { status: 'error', message: 'cancelled' };

    const compiled = compileRoster(model, {
      ledger: options.ledger,
      ...(options.feasibilityOnly ? { feasibilityOnly: true } : {}),
    });

    const result = this.run(compiled, options.timeLimitMs);
    const status = mapStatus(result.Status);

    if (status === 'infeasible') return { status: 'infeasible' };
    if (status === 'error') {
      return { status: 'error', message: `solver reported "${result.Status}"` };
    }

    const values = primalValues(result);
    const schedule = scheduleFromSolution(compiled, values);
    const objective =
      result.ObjectiveValue === null ? undefined : result.ObjectiveValue + compiled.objectiveOffset;

    const out: BackendResult = { status, schedule };
    if (objective !== undefined) out.objective = objective;

    // Duals only exist for a linear program, so shadow prices come from solving the
    // relaxation separately. They answer "what is this rule costing?" — which is a
    // different and cheaper question than "what is the best roster?".
    if (!options.feasibilityOnly) {
      const prices = this.shadowPrices(compiled);
      if (prices) out.shadowPrices = prices;
    }

    return out;
  }

  private run(compiled: CompiledRoster, timeLimitMs: number): HighsResult {
    return this.highs.solve(toLpFormat(compiled.problem), {
      output_flag: false,
      // HiGHS takes seconds; the floor keeps a very small budget from rounding to zero.
      time_limit: Math.max(0.05, timeLimitMs / 1000),
    });
  }

  /**
   * Prices the binding rules from the LP relaxation.
   *
   * Reported honestly as relaxation duals: they are the marginal cost of a rule in the
   * continuous problem, which is a good guide to which rule is expensive and is *not*
   * the same as the exact cost in the integer problem. Failure is silent by design —
   * an unavailable shadow price should not sink a solve that otherwise succeeded.
   */
  private shadowPrices(compiled: CompiledRoster): Record<string, number> | undefined {
    try {
      const relaxed = this.highs.solve(toLpFormat(relaxIntegrality(compiled.problem)), {
        output_flag: false,
        time_limit: 2,
      });
      if (mapStatus(relaxed.Status) === 'error') return undefined;

      const duals: Record<string, number> = {};
      for (const row of relaxed.Rows) {
        if (row.Name && typeof row.Dual === 'number') duals[row.Name] = row.Dual;
      }
      const prices = shadowPricesByConstraint(compiled, duals);
      return Object.keys(prices).length > 0 ? prices : undefined;
    } catch {
      return undefined;
    }
  }
}

function primalValues(result: HighsResult): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [name, column] of Object.entries(result.Columns)) {
    values[name] = column.Primal ?? 0;
  }
  return values;
}
