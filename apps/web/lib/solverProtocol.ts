/**
 * The wire format between the page and the solver worker.
 *
 * Kept in its own module with no imports beyond types, so the worker entry can share it
 * with the client without dragging the client's module graph into the worker bundle.
 */

import type {
  BackendResult,
  ConflictExplanation,
  FairnessLedger,
  RosterModel,
} from '@rotaproof/core';

/** Recorded in receipts. Fixed here so the page and the worker cannot disagree. */
export const SOLVER_VERSION = 'highs-wasm@1.15.2';

export interface SolveRequest {
  id: string;
  type: 'solve';
  model: RosterModel;
  ledger: FairnessLedger;
  timeLimitMs: number;
  /** Drops the objective; the program then only answers "is this possible?". */
  feasibilityOnly?: boolean;
}

export interface ExplainRequest {
  id: string;
  type: 'explain';
  model: RosterModel;
  ledger: FairnessLedger;
  timeLimitMs: number;
}

/** Cooperative cancellation. Lands between solves, never during one. */
export interface CancelRequest {
  id: string;
  type: 'cancel';
}

export type SolverRequest = SolveRequest | ExplainRequest | CancelRequest;

export interface SolverSuccess<T = unknown> {
  id: string;
  ok: true;
  result: T;
}

export interface SolverFailure {
  id: string;
  ok: false;
  error: string;
}

export type SolverResponse = SolverSuccess<BackendResult | ConflictExplanation> | SolverFailure;

/** Sent once the WebAssembly module has compiled, so the page can enable Solve. */
export interface SolverReady {
  id: '@ready';
  ok: true;
  result: { version: string; warmupMs: number };
}

export type SolverMessage = SolverResponse | SolverReady;
