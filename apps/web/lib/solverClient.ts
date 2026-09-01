'use client';

/**
 * The page's half of the solver.
 *
 * `solverBackend` satisfies `SolverBackend` from the core package, so `solveRoster` and
 * `explainConflict` run against it with no knowledge that the work happens in a worker.
 *
 * Cancellation is the part worth reading. A solve already inside the WebAssembly module
 * cannot be interrupted by a message, because the worker's event loop is blocked until it
 * returns. So an abort asks nicely first and, if the job has not settled shortly after,
 * terminates the worker outright. The next request starts a fresh one; the wasm comes back
 * from the HTTP cache, so the cost of that is a recompile rather than a download.
 */

import type {
  BackendOptions,
  BackendResult,
  ConflictExplanation,
  FairnessLedger,
  RosterModel,
  SolverBackend,
} from '@rotaproof/core';

import {
  type SolverMessage,
  type SolverRequest,
  type SolverResponse,
  SOLVER_VERSION,
} from './solverProtocol.js';

/** How long a polite cancel gets before the worker is killed. */
const HARD_CANCEL_AFTER_MS = 150;

interface PendingJob {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<string, PendingJob>();

/** Resolves once the WebAssembly module has compiled, so the UI can stop saying "warming". */
let readySettle: ((info: { version: string; warmupMs: number }) => void) | undefined;
let readyFail: ((error: Error) => void) | undefined;
let readyPromise: Promise<{ version: string; warmupMs: number }> | undefined;

function freshReadyPromise(): void {
  readyPromise = new Promise((resolve, reject) => {
    readySettle = resolve;
    readyFail = reject;
  });
  // Nothing may await this before `solverReady()` is called, and an unhandled rejection
  // in that window would surface as a page error.
  readyPromise.catch(() => undefined);
}

function ensureWorker(): Worker {
  if (worker) return worker;
  freshReadyPromise();

  // Turbopack rewrites this exact form into a bundled worker chunk; the `type: 'module'`
  // hint is stripped in the process, so nothing here may rely on module-worker semantics.
  worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });

  worker.addEventListener('message', (event: MessageEvent<SolverMessage>) => {
    const message = event.data;

    if (message.id === '@ready') {
      if (message.ok) readySettle?.(message.result as { version: string; warmupMs: number });
      else readyFail?.(new Error(message.error));
      return;
    }

    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    if (message.ok) job.resolve((message as Extract<SolverResponse, { ok: true }>).result);
    else job.reject(new Error(message.error));
  });

  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'the solver worker failed to start');
    readyFail?.(error);
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  });

  return worker;
}

/** Kills a worker that is stuck inside a solve. Everything in flight is rejected. */
function terminateWorker(reason: string): void {
  worker?.terminate();
  worker = undefined;
  const error = new Error(reason);
  for (const job of pending.values()) job.reject(error);
  pending.clear();
  readyFail?.(error);
  readyPromise = undefined;
}

/** Warms the worker without asking it for anything. Safe to call more than once. */
export function warmSolver(): Promise<{ version: string; warmupMs: number }> {
  ensureWorker();
  return readyPromise ?? Promise.reject(new Error('the solver worker is not running'));
}

export function isSolverRunning(): boolean {
  return worker !== undefined;
}

function send<T>(
  request: Exclude<SolverRequest, { type: 'cancel' }>,
  signal?: AbortSignal,
): Promise<T> {
  const active = ensureWorker();

  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let hardCancel: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      const cancel: SolverRequest = { id: request.id, type: 'cancel' };
      active.postMessage(cancel);
      // The polite cancel only lands between solves. If the worker is inside one, nothing
      // short of terminating it will stop the wasm.
      hardCancel = setTimeout(() => {
        if (pending.has(request.id)) terminateWorker('the solve was cancelled');
      }, HARD_CANCEL_AFTER_MS);
    };

    const cleanup = () => {
      if (hardCancel) clearTimeout(hardCancel);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    pending.set(request.id, {
      resolve: (value) => {
        cleanup();
        resolve(value as T);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    });

    active.postMessage(request);
  });
}

function abortError(): Error {
  return new DOMException('the solve was cancelled', 'AbortError') as unknown as Error;
}

/**
 * A `SolverBackend` whose work happens in a worker.
 *
 * An abort is reported the same way the in-process HiGHS backend reports it — as an error
 * result rather than a thrown exception — because that is what the deletion filter in
 * `explainConflict` is written against: an inconclusive probe leaves its candidate in the
 * suspect set, which keeps the answer sound rather than silently narrowing it.
 */
export const solverBackend: SolverBackend = {
  version: SOLVER_VERSION,

  async solve(model: RosterModel, options: BackendOptions): Promise<BackendResult> {
    if (options.signal?.aborted) return { status: 'error', message: 'cancelled' };

    const request: SolverRequest = {
      id: `s${nextId++}`,
      type: 'solve',
      model,
      ledger: options.ledger,
      timeLimitMs: options.timeLimitMs,
      ...(options.feasibilityOnly ? { feasibilityOnly: true } : {}),
    };

    try {
      return await send<BackendResult>(request, options.signal);
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  },
};

/**
 * Runs the whole deletion filter inside the worker.
 *
 * Same function as the page would run — `explainConflict` from the core package — just
 * executed where the solver already lives, which turns nineteen round trips into one. Used
 * to refresh a stale explanation after a rule has been relaxed, where a full optimal solve
 * would cost far more than the feasibility probes it needs.
 */
export function explainInWorker(
  model: RosterModel,
  ledger: FairnessLedger,
  options: { timeLimitMs?: number; signal?: AbortSignal } = {},
): Promise<ConflictExplanation> {
  return send<ConflictExplanation>(
    {
      id: `e${nextId++}`,
      type: 'explain',
      model,
      ledger,
      timeLimitMs: options.timeLimitMs ?? 1_500,
    },
    options.signal,
  );
}
