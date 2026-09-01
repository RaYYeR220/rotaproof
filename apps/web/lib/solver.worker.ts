/**
 * The solver, off the UI thread.
 *
 * HiGHS is synchronous once it starts: a `solve()` call runs to completion inside the
 * WebAssembly module and nothing else on that thread gets a turn. On the main thread that
 * would freeze the page for the length of every solve, and a conflict explanation runs
 * nineteen of them back to back.
 *
 * Two consequences shape this file. The module is instantiated exactly once and cached,
 * because the loader re-fetches and re-compiles all 3.4 MB on every call. And a cancel
 * message can only be seen between solves, so the in-worker deletion filter yields to the
 * task queue before each probe — without that, `cancel` sits in the queue until the whole
 * explanation has finished, by which point cancelling means nothing.
 */

import highsLoader from 'highs';

import {
  type BackendOptions,
  type BackendResult,
  type HighsLoader,
  type RosterModel,
  type SolverBackend,
  HighsBackend,
  explainConflict,
} from '@rotaproof/core';

import { type SolverMessage, type SolverRequest, SOLVER_VERSION } from './solverProtocol';

/**
 * Typed by hand rather than through `lib.webworker`, whose globals collide with the DOM
 * lib the rest of the app compiles against.
 */
const scope = self as unknown as {
  postMessage(message: SolverMessage): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<SolverRequest>) => void): void;
};

/**
 * Next serves `public/` from the base path, and `locateFile` has to agree with it or the
 * module aborts having failed both the streaming and the ArrayBuffer fetch.
 */
function wasmUrl(): string {
  const basePath = typeof process !== 'undefined' ? (process.env.NEXT_PUBLIC_BASE_PATH ?? '') : '';
  return `${basePath}/highs.wasm`;
}

let backendPromise: Promise<HighsBackend> | undefined;

function solverBackend(): Promise<HighsBackend> {
  backendPromise ??= HighsBackend.create(highsLoader as unknown as HighsLoader, {
    locateFile: () => wasmUrl(),
    version: SOLVER_VERSION,
  });
  return backendPromise;
}

/** Jobs whose caller has gone away. Checked before and between solves. */
const cancelled = new Set<string>();

/**
 * Hands the event loop back so a queued `cancel` message can be delivered.
 *
 * A `MessageChannel` ping is a task, like an incoming message, but without `setTimeout`'s
 * one-millisecond clamp — across nineteen probes that difference is most of the budget.
 */
function yieldToTaskQueue(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Makes a run of back-to-back solves interruptible between them. */
class InterruptibleBackend implements SolverBackend {
  readonly version: string;

  constructor(
    private readonly inner: SolverBackend,
    private readonly jobId: string,
  ) {
    this.version = inner.version;
  }

  async solve(model: RosterModel, options: BackendOptions): Promise<BackendResult> {
    await yieldToTaskQueue();
    if (cancelled.has(this.jobId)) return { status: 'error', message: 'cancelled' };
    return this.inner.solve(model, options);
  }
}

function reply(message: SolverMessage): void {
  scope.postMessage(message);
}

scope.addEventListener('message', (event) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelled.add(request.id);
    return;
  }
  void handle(request);
});

async function handle(request: Exclude<SolverRequest, { type: 'cancel' }>): Promise<void> {
  try {
    const backend = await solverBackend();
    if (cancelled.has(request.id)) {
      reply({ id: request.id, ok: false, error: 'cancelled' });
      return;
    }

    if (request.type === 'solve') {
      const options: BackendOptions = { timeLimitMs: request.timeLimitMs, ledger: request.ledger };
      if (request.feasibilityOnly) options.feasibilityOnly = true;
      reply({ id: request.id, ok: true, result: await backend.solve(request.model, options) });
      return;
    }

    const conflict = await explainConflict(
      request.model,
      new InterruptibleBackend(backend, request.id),
      { ledger: request.ledger, timeLimitMs: request.timeLimitMs },
    );
    reply({ id: request.id, ok: true, result: conflict });
  } catch (error) {
    reply({
      id: request.id,
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  } finally {
    cancelled.delete(request.id);
  }
}

// Compiling the module is most of a cold start, so it begins before anything is asked of
// it and the page is told when the Solve button will actually do something.
void (async () => {
  const started = performance.now();
  try {
    const backend = await solverBackend();
    reply({
      id: '@ready',
      ok: true,
      result: { version: backend.version, warmupMs: Math.round(performance.now() - started) },
    });
  } catch (error) {
    reply({
      id: '@ready',
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
})();
