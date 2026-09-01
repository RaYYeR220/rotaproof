/**
 * A tiny mixed-integer-programming intermediate representation, and a writer for
 * CPLEX LP format.
 *
 * Keeping the compiler honest about its output format matters more than it looks: LP is
 * what HiGHS, GLPK, SCIP and CBC all read, so the roster compiler is not married to a
 * particular WebAssembly build. Swapping the backend swaps one adapter, not the model.
 *
 * Every row carries the id of the roster constraint that produced it. That tag is what
 * lets a dual value or a dropped row be reported back as "the keyholder rule", rather
 * than as row 1174.
 */

import type { ConstraintId } from './model.js';

export type VarType = 'binary' | 'integer' | 'continuous';

export interface MipVar {
  name: string;
  type: VarType;
  lb: number;
  ub: number;
  /** Objective coefficient. Omitted means zero. */
  obj?: number;
}

export type Sense = '<=' | '>=' | '=';

export interface MipRow {
  name: string;
  coeffs: Array<[varName: string, coefficient: number]>;
  sense: Sense;
  rhs: number;
  /** The roster constraint this row came from, for explanations and shadow prices. */
  source?: ConstraintId;
}

export interface MipProblem {
  sense: 'min' | 'max';
  vars: MipVar[];
  rows: MipRow[];
}

/**
 * Builder that keeps variable names unique and rows numbered.
 *
 * Row names are `r0, r1, …` rather than anything descriptive, because LP row names have
 * awkward character rules and some solvers silently rename collisions. The mapping back
 * to a human meaning lives in `row.source`.
 */
export class MipBuilder {
  private readonly varIndex = new Map<string, MipVar>();
  private readonly rowList: MipRow[] = [];

  variable(name: string, type: VarType, lb = 0, ub = type === 'binary' ? 1 : Infinity): MipVar {
    const existing = this.varIndex.get(name);
    if (existing) return existing;
    const created: MipVar = { name, type, lb, ub };
    this.varIndex.set(name, created);
    return created;
  }

  /** Adds to a variable's objective coefficient rather than replacing it. */
  addObjective(name: string, coefficient: number): void {
    const variable = this.varIndex.get(name);
    if (!variable) throw new Error(`unknown variable in objective: ${name}`);
    variable.obj = (variable.obj ?? 0) + coefficient;
  }

  row(
    coeffs: Array<[string, number]>,
    sense: Sense,
    rhs: number,
    source?: ConstraintId,
  ): MipRow | undefined {
    // A row with no terms is either trivially true or trivially false. The false case is
    // a genuine infeasibility and must be kept; the true case is noise and is dropped.
    if (coeffs.length === 0) {
      const trueByDefault =
        (sense === '<=' && rhs >= 0) || (sense === '>=' && rhs <= 0) || (sense === '=' && rhs === 0);
      if (trueByDefault) return undefined;
    }
    const created: MipRow = { name: `r${this.rowList.length}`, coeffs, sense, rhs };
    if (source !== undefined) created.source = source;
    this.rowList.push(created);
    return created;
  }

  build(sense: 'min' | 'max' = 'min'): MipProblem {
    return { sense, vars: [...this.varIndex.values()], rows: [...this.rowList] };
  }

  get variableCount(): number {
    return this.varIndex.size;
  }

  get rowCount(): number {
    return this.rowList.length;
  }
}

/** Drops the objective, leaving a pure feasibility question. Much faster to decide. */
export function stripObjective(problem: MipProblem): MipProblem {
  return {
    sense: problem.sense,
    rows: problem.rows,
    vars: problem.vars.map(({ obj: _obj, ...rest }) => rest),
  };
}

/** Relaxes integrality so the LP duals become available. */
export function relaxIntegrality(problem: MipProblem): MipProblem {
  return {
    sense: problem.sense,
    rows: problem.rows,
    vars: problem.vars.map((v) => (v.type === 'continuous' ? v : { ...v, type: 'continuous' as const })),
  };
}

const LP_SENSE: Record<Sense, string> = { '<=': '<=', '>=': '>=', '=': '=' };

/**
 * Writes CPLEX LP format.
 *
 * Two details that cost an afternoon if you get them wrong: a term's sign has to be
 * separated from its coefficient (`- 2 x` not `-2 x` is safest across parsers), and any
 * variable that appears nowhere in a row still has to be declared in `Bounds` or the
 * solver never learns it exists.
 */
export function toLpFormat(problem: MipProblem): string {
  const lines: string[] = [];

  lines.push(problem.sense === 'min' ? 'Minimize' : 'Maximize');
  const objectiveTerms = problem.vars
    .filter((v) => v.obj !== undefined && v.obj !== 0)
    .map((v) => [v.name, v.obj as number] as [string, number]);
  lines.push(` obj: ${objectiveTerms.length > 0 ? renderTerms(objectiveTerms) : '0'}`);

  lines.push('Subject To');
  for (const row of problem.rows) {
    lines.push(` ${row.name}: ${renderTerms(row.coeffs)} ${LP_SENSE[row.sense]} ${formatNumber(row.rhs)}`);
  }

  lines.push('Bounds');
  for (const v of problem.vars) {
    if (v.type === 'binary') continue; // declared in the Binary section instead
    const lower = v.lb === -Infinity ? '-inf' : formatNumber(v.lb);
    const upper = v.ub === Infinity ? '+inf' : formatNumber(v.ub);
    lines.push(` ${lower} <= ${v.name} <= ${upper}`);
  }

  const binaries = problem.vars.filter((v) => v.type === 'binary');
  if (binaries.length > 0) {
    lines.push('Binary');
    for (const chunk of chunked(binaries.map((v) => v.name), 12)) {
      lines.push(` ${chunk.join(' ')}`);
    }
  }

  const integers = problem.vars.filter((v) => v.type === 'integer');
  if (integers.length > 0) {
    lines.push('General');
    for (const chunk of chunked(integers.map((v) => v.name), 12)) {
      lines.push(` ${chunk.join(' ')}`);
    }
  }

  lines.push('End');
  return lines.join('\n');
}

function renderTerms(terms: Array<[string, number]>): string {
  if (terms.length === 0) return '0';
  return terms
    .map(([name, coefficient], i) => {
      const sign = coefficient < 0 ? '-' : '+';
      const magnitude = Math.abs(coefficient);
      const value = magnitude === 1 ? '' : `${formatNumber(magnitude)} `;
      // The first term drops a leading plus for readability.
      if (i === 0) return coefficient < 0 ? `- ${value}${name}` : `${value}${name}`;
      return `${sign} ${value}${name}`;
    })
    .join(' ');
}

/**
 * LP parsers are unforgiving about exponent notation, so numbers are written in plain
 * decimal with the trailing zeros trimmed.
 */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** LP-safe identifier: letters, digits and underscores, never starting with a digit. */
export function lpName(...parts: (string | number)[]): string {
  const joined = parts.map((p) => String(p).replace(/[^A-Za-z0-9_]/g, '_')).join('_');
  return /^[A-Za-z_]/.test(joined) ? joined : `v_${joined}`;
}
