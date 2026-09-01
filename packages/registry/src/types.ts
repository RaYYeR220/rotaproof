/**
 * One registry, two surfaces.
 *
 * Every capability of this application is declared exactly once, here, as an
 * `ActionDefinition`. The React UI renders its controls from the registry, and the
 * WebMCP layer registers its tools from the same registry. There is no second code path
 * for agents, so the two surfaces cannot drift apart — the failure mode where "the UI
 * changes and a tool doesn't, and the agent calls a tool that lies" is not reachable.
 *
 * `parity.test.ts` enforces the remaining half of that promise: every action is either
 * exposed to agents or carries an explicit `agentExempt` reason. Silence is not allowed.
 */

import type {
  Constraint,
  ConstraintId,
  FairnessLedger,
  Receipt,
  RosterModel,
  Schedule,
  SolveResult,
  StaffId,
} from '@rotaproof/core';

export type Role = 'manager' | 'staff';

/** A swap offered by one person and claimed by another, once the solver allows it. */
export interface SwapRequest {
  id: string;
  /** Who wants to give the shift away. */
  from: StaffId;
  day: number;
  shift: string;
  /** Set once someone has taken it. */
  takenBy?: StaffId;
  status: 'open' | 'accepted' | 'withdrawn';
  /** @private Free text written by a person. Never returned to an agent unredacted. */
  note?: string;
  createdAt: string;
}

/** A published roster, kept so changes can be diffed and audited. */
export interface RosterVersion {
  version: number;
  schedule: Schedule;
  receipt: Receipt;
  publishedAt: string;
  /** What changed against the previous version, in assignment terms. */
  added: number;
  removed: number;
}

export type SessionStatus = 'draft' | 'solved' | 'infeasible' | 'published';

/**
 * Everything both surfaces read. Deliberately plain data: the registry never touches
 * React, and the tests can drive a whole session without a browser.
 */
export interface RosterSession {
  model: RosterModel;
  ledger: FairnessLedger;
  status: SessionStatus;
  /** The working schedule — solved, imported or hand-edited. */
  schedule?: Schedule;
  lastResult?: SolveResult;
  swaps: SwapRequest[];
  versions: RosterVersion[];
  /** Which side of the product this session is on. Drives which tools exist. */
  role: Role;
  /** Set when `role === 'staff'`; the person whose roster this is. */
  actorId?: StaffId;
  /** True while a solve is running, so mutating tools can decline cleanly. */
  solving: boolean;
}

/** A consequential action waiting on a real human click in the page. */
export interface ConfirmRequest {
  title: string;
  /** Rendered as the body of the confirmation card. */
  detail: string;
  /** Short label for the affirmative button. */
  confirmLabel: string;
  /** Rows of "what exactly will change", shown before anyone clicks. */
  changes: string[];
}

/**
 * What an action can do to the world.
 *
 * `confirm` is the human-in-the-loop primitive. WebMCP has no confirmation API — the
 * spec lists user prompting as an open question — so this is ours: the action awaits a
 * promise, the page renders a card, and nothing happens until a person clicks. The
 * agent's tool call simply stays open in the meantime.
 */
export interface ActionContext {
  session: RosterSession;
  /** Applies a change to the session. Implemented by the host (React store or a test). */
  update: (mutate: (session: RosterSession) => void) => void;
  /** Runs the solver against the current model, and records the result in the session. */
  solve: (options?: { signal?: AbortSignal; timeLimitMs?: number }) => Promise<SolveResult>;
  /**
   * Answers a hypothetical without touching the session.
   *
   * "Could this person take that shift?" has to be asked by solving a model that is not
   * the real one. Routing it through `solve` would leave the working schedule replaced by
   * a fabricated one, and an infeasible probe would wipe it altogether — which is how a
   * read-only tool ended up silently rewriting the roster.
   */
  dryRun: (
    constraints: Constraint[],
    options?: { signal?: AbortSignal; timeLimitMs?: number; explain?: boolean },
  ) => Promise<SolveResult>;
  /** Blocks until a human accepts or declines. Resolves `false` if the call is aborted. */
  confirm: (request: ConfirmRequest, signal?: AbortSignal) => Promise<boolean>;
  /** Cancellation from the agent or the page. */
  signal?: AbortSignal;
}

/**
 * Actions return data, not prose. The host serialises it; `redact.ts` bounds it.
 *
 * A failure is an `ActionError`, which always carries a `hint` — Chrome's guidance is
 * that a tool result should be a guide rather than a dead end, so an agent that gets an
 * id wrong is told which ids exist instead of being told "not found".
 */
export type ActionResult<T = unknown> = T | ActionError;

export interface ActionError {
  error: string;
  message: string;
  /** Concrete next step. Often a list of valid values. */
  hint: string;
}

export function isActionError(value: unknown): value is ActionError {
  return typeof value === 'object' && value !== null && 'error' in value && 'hint' in value;
}

export function actionError(error: string, message: string, hint: string): ActionError {
  return { error, message, hint };
}

/** JSON Schema, kept loose on purpose — the strict validation happens in `run`. */
export type JsonSchema = Record<string, unknown>;

export interface ActionDefinition<Args = Record<string, unknown>, Result = unknown> {
  /**
   * Doubles as the WebMCP tool name, so it must match `/^[a-zA-Z0-9_.-]{1,128}$/`.
   * Chrome recommends staying under 30 characters.
   */
  id: string;
  /** Human label for the button that runs this action. */
  title: string;
  /**
   * Agent-facing description.
   *
   * Length is a deliberate, per-tool decision rather than a house style. Chrome
   * recommends 500 characters; Shopify's guidance says 200; the reference WebMCP app
   * from the spec's own author ships 2,500-character descriptions on its two engine
   * tools. The reconciliation used here: leaf tools stay terse, and the two tools that
   * carry real semantics — `set_constraint` and `solve` — get manual-grade descriptions,
   * because for those the description *is* the documentation an agent has.
   */
  description: string;
  inputSchema: JsonSchema;
  /** Mirrors the WebMCP annotation. Absence of it is what marks a tool as a write. */
  readOnly: boolean;
  /** Set when a result can contain text a person typed. */
  untrustedContent?: boolean;
  /** Which side of the product may run this. */
  roles: Role[];
  /**
   * State predicate. Returning false unregisters the tool, so the agent's tool list is
   * always exactly the set of things that are possible right now.
   */
  available: (session: RosterSession) => boolean;
  run: (args: Args, context: ActionContext) => Promise<ActionResult<Result>>;
  /**
   * Registration order. Models show positional bias — tools earlier in the list are
   * picked more often — so the order is chosen rather than incidental: orientation
   * first, then reads, then the engine, then writes.
   */
  order: number;
  /**
   * Set only when an action deliberately has no agent equivalent. The parity test fails
   * on any action that is neither exposed nor exempt, which is what keeps the two
   * surfaces honest as the app grows.
   */
  agentExempt?: string;
}

/** Narrow helper so each action file keeps its argument types. */
export function defineAction<Args, Result>(
  definition: ActionDefinition<Args, Result>,
): ActionDefinition<Args, Result> {
  return definition;
}

export type AnyAction = ActionDefinition<never, unknown>;

export type { Constraint, ConstraintId, RosterModel, Schedule, SolveResult, StaffId };
