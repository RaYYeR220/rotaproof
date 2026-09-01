/**
 * A headless session.
 *
 * The same registry that drives the browser, running with no browser at all: a plain
 * object for state, a solver backend of your choosing, and a confirmation handler you
 * supply. It exists for three reasons — the test suite drives real actions through it,
 * the privacy property test needs to call every tool without a DOM, and anybody
 * embedding this roster engine elsewhere needs a way in that is not a React store.
 */

import {
  type FairnessLedger,
  type RosterModel,
  type SolveResult,
  type SolverBackend,
  EMPTY_LEDGER,
  seedRoster,
  solveRoster,
} from '@rotaproof/core';

import { ALL_ACTIONS } from './actions/index.js';
import type {
  ActionContext,
  ActionDefinition,
  ActionResult,
  ConfirmRequest,
  Role,
  RosterSession,
  StaffId,
} from './types.js';

export interface HeadlessOptions {
  role?: Role;
  actorId?: StaffId;
  model?: RosterModel;
  ledger?: FairnessLedger;
  /**
   * Decides confirmations. Defaults to declining, so a test that forgets to wire this
   * cannot silently publish a roster — the safe default is "nothing happened".
   */
  onConfirm?: (request: ConfirmRequest) => boolean | Promise<boolean>;
}

export interface HeadlessSession {
  readonly session: RosterSession;
  /** Confirmations that were requested, in order, for assertions. */
  readonly confirmations: ConfirmRequest[];
  /** Actions available to an agent right now, honouring role and state. */
  availableTools(): ActionDefinition<never, unknown>[];
  run<Args, Result>(
    action: ActionDefinition<Args, Result>,
    args: Args,
    options?: { signal?: AbortSignal },
  ): Promise<ActionResult<Result>>;
  /** Runs by tool name, the way an agent would. */
  call(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  solve(): Promise<SolveResult>;
}

export function createHeadlessSession(
  backend: SolverBackend,
  options: HeadlessOptions = {},
): HeadlessSession {
  const session: RosterSession = {
    model: options.model ?? seedRoster(),
    ledger: options.ledger ?? EMPTY_LEDGER,
    status: 'draft',
    swaps: [],
    versions: [],
    role: options.role ?? 'manager',
    solving: false,
    ...(options.actorId ? { actorId: options.actorId } : {}),
  };

  const confirmations: ConfirmRequest[] = [];

  const solve: ActionContext['solve'] = async (solveOptions) => {
    session.solving = true;
    try {
      const result = await solveRoster(session.model, backend, {
        ledger: session.ledger,
        ...solveOptions,
      });
      session.lastResult = result;
      if (result.status === 'infeasible') {
        session.status = 'infeasible';
        delete session.schedule;
      } else if (result.schedule) {
        session.status = 'solved';
        session.schedule = result.schedule;
      }
      return result;
    } finally {
      session.solving = false;
    }
  };

  const makeContext = (signal?: AbortSignal): ActionContext => ({
    session,
    update: (mutate) => mutate(session),
    solve,
    confirm: async (request) => {
      confirmations.push(request);
      return (await options.onConfirm?.(request)) ?? false;
    },
    ...(signal ? { signal } : {}),
  });

  return {
    session,
    confirmations,
    availableTools: () =>
      ALL_ACTIONS.filter(
        (action) =>
          !action.agentExempt && action.roles.includes(session.role) && action.available(session),
      ).sort((a, b) => a.order - b.order),
    run: (action, args, runOptions) =>
      action.run(args, makeContext(runOptions?.signal)) as never,
    call: async (toolName, args) => {
      const action = ALL_ACTIONS.find((a) => a.id === toolName);
      if (!action) throw new Error(`no such tool: ${toolName}`);
      return action.run(args as never, makeContext());
    },
    solve: () => solve(),
  };
}
