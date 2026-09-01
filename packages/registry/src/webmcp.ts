/**
 * The WebMCP binding.
 *
 * Takes the action registry and keeps `document.modelContext` in sync with it, so the
 * set of tools an agent can see is always exactly the set of things that are possible in
 * the current state of the page. Tools appear when they become useful and disappear when
 * they stop being — a manager's session and a staff session expose different surfaces,
 * `explain_conflict` only exists while the roster is actually impossible, and
 * `publish_roster` only exists once there is something worth publishing.
 *
 * Notes on the API, since several of these are easy to get wrong:
 *
 *  - The object is `document.modelContext`. `navigator.modelContext` is a legacy alias.
 *  - There is no `unregisterTool`. An `AbortController` passed at registration is the
 *    only way to remove a tool, and aborting does not disturb a call already running.
 *  - Registering a name that is already registered *rejects*; it does not replace. So a
 *    changed definition has to be aborted first.
 *  - `execute` receives `(input, { signal })` and nothing else. There is no client
 *    object and no confirmation API, which is why human-in-the-loop here is a promise
 *    this page resolves on a real click.
 *  - Only two annotations exist: `readOnlyHint` and `untrustedContentHint`.
 */

import { boundResult } from '@rotaproof/core';

import { type ActionContext, type ActionDefinition, type RosterSession, isActionError } from './types.js';

// --- Minimal typings for the parts of the API this file touches. ------------------

interface WebMcpAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

interface WebMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMcpAnnotations;
  execute: (input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>;
}

interface WebMcpRegisterOptions {
  signal?: AbortSignal;
  exposedTo?: string[];
}

export interface RegisteredToolInfo {
  name: string;
  description?: string;
  annotations?: WebMcpAnnotations;
}

interface ModelContext {
  registerTool: (tool: WebMcpToolDefinition, options?: WebMcpRegisterOptions) => Promise<void>;
  getTools?: (options?: { fromOrigins?: string[] }) => Promise<RegisteredToolInfo[]>;
  executeTool?: (
    tool: RegisteredToolInfo,
    input?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<string>;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
  interface Navigator {
    modelContext?: ModelContext;
  }
}

/**
 * Resolves the model-context object, preferring the specified `document` surface and
 * falling back to the legacy `navigator` alias some builds still ship.
 */
export function getModelContext(): ModelContext | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.modelContext ?? (typeof navigator !== 'undefined' ? navigator.modelContext : undefined);
}

export function isWebMcpSupported(): boolean {
  return typeof getModelContext()?.registerTool === 'function';
}

export interface BindingEvent {
  toolName: string;
  phase: 'start' | 'end' | 'error';
  /** Milliseconds, present on `end` and `error`. */
  durationMs?: number;
  message?: string;
}

export interface BindingOptions {
  /** Reads the live session whenever a tool runs, so no stale snapshot is captured. */
  getSession: () => RosterSession;
  /** Builds the context an action runs with. */
  makeContext: (signal: AbortSignal) => ActionContext;
  /**
   * Called around every tool invocation. The page uses it to show that an agent is
   * driving — WebMCP has no imperative "a tool was called" event, so the fact that
   * `execute` is running *is* the signal.
   */
  onEvent?: (event: BindingEvent) => void;
  /** Origins allowed to see and call these tools, when composing across sites. */
  exposedTo?: string[];
}

interface LiveTool {
  controller: AbortController;
  /** Guards against re-registering an unchanged definition. */
  fingerprint: string;
}

/**
 * Keeps the registered tool set equal to the available action set.
 *
 * `sync()` is idempotent and cheap: it diffs by fingerprint, so calling it on every
 * state change costs nothing when nothing relevant moved.
 */
export class WebMcpBinding {
  private readonly live = new Map<string, LiveTool>();
  private readonly actions: ActionDefinition<never, unknown>[];
  private readonly options: BindingOptions;
  private disposed = false;

  constructor(actions: ActionDefinition<never, unknown>[], options: BindingOptions) {
    // Registration order is chosen, not incidental: models show positional bias toward
    // tools that appear earlier, so orientation and reads come before writes.
    this.actions = [...actions].sort((a, b) => a.order - b.order);
    this.options = options;
  }

  /** Names currently registered, in registration order. */
  get registered(): string[] {
    return [...this.live.keys()];
  }

  async sync(): Promise<void> {
    if (this.disposed) return;
    const context = getModelContext();
    if (!context?.registerTool) return;

    const session = this.options.getSession();
    const wanted = this.actions.filter(
      (action) => !action.agentExempt && action.roles.includes(session.role) && action.available(session),
    );
    const wantedNames = new Set(wanted.map((a) => a.id));

    for (const [name, tool] of this.live) {
      if (!wantedNames.has(name)) {
        tool.controller.abort();
        this.live.delete(name);
      }
    }

    for (const action of wanted) {
      const fingerprint = fingerprintOf(action);
      const existing = this.live.get(action.id);
      if (existing) {
        if (existing.fingerprint === fingerprint) continue;
        // A changed definition cannot be registered over the old one, so drop it first.
        existing.controller.abort();
        this.live.delete(action.id);
      }
      await this.registerOne(action, fingerprint, context);
    }
  }

  private async registerOne(
    action: ActionDefinition<never, unknown>,
    fingerprint: string,
    context: ModelContext,
  ): Promise<void> {
    const controller = new AbortController();
    const annotations: WebMcpAnnotations = {};
    if (action.readOnly) annotations.readOnlyHint = true;
    if (action.untrustedContent) annotations.untrustedContentHint = true;

    const registerOptions: WebMcpRegisterOptions = { signal: controller.signal };
    if (this.options.exposedTo) registerOptions.exposedTo = this.options.exposedTo;

    try {
      // The literal call. Everything above exists to decide *when* this runs and with
      // *what*; this is the whole of the integration with the browser.
      await document.modelContext!.registerTool(
        {
          name: action.id,
          description: action.description,
          inputSchema: action.inputSchema,
          annotations,
          execute: (input, options) => this.invoke(action, input, options.signal),
        },
        registerOptions,
      );
      this.live.set(action.id, { controller, fingerprint });
    } catch (error) {
      controller.abort();
      this.options.onEvent?.({
        toolName: action.id,
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Runs an action on behalf of an agent.
   *
   * Errors never escape as raw exceptions. A thrown error would reach the model as an
   * opaque failure; an `ActionError` reaches it as a sentence plus a hint about what to
   * try instead, which is the difference between an agent that recovers and one that
   * gives up or invents.
   */
  private async invoke(
    action: ActionDefinition<never, unknown>,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const started = Date.now();
    this.options.onEvent?.({ toolName: action.id, phase: 'start' });

    try {
      const context = this.options.makeContext(signal);
      const result = await action.run(input as never, context);
      const bounded = boundResult(
        result,
        isActionError(result)
          ? 'Narrow the request and try again.'
          : `Ask ${action.id} for a narrower slice — for example a single day or a single person.`,
      );
      this.options.onEvent?.({ toolName: action.id, phase: 'end', durationMs: Date.now() - started });
      return bounded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onEvent?.({
        toolName: action.id,
        phase: 'error',
        durationMs: Date.now() - started,
        message,
      });
      return {
        error: 'tool_failed',
        message,
        hint: 'This is a bug in the page, not in the request. Report what you were trying to do.',
      };
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const tool of this.live.values()) tool.controller.abort();
    this.live.clear();
  }
}

/** Only the parts of a definition the browser actually sees. */
function fingerprintOf(action: ActionDefinition<never, unknown>): string {
  return JSON.stringify([
    action.id,
    action.description,
    action.inputSchema,
    action.readOnly,
    action.untrustedContent ?? false,
  ]);
}

/**
 * Reads back what the browser believes is registered.
 *
 * Used by the tool inspector page, so a reviewer can see the live surface — names,
 * descriptions, read/write split — without an agent, an extension or an account.
 */
export async function listRegisteredTools(): Promise<RegisteredToolInfo[]> {
  const context = getModelContext();
  if (!context?.getTools) return [];
  try {
    return await context.getTools();
  } catch {
    return [];
  }
}

/**
 * Invokes a registered tool the way an agent would.
 *
 * Chrome 151 expects the arguments as a JSON *string* rather than an object, so the
 * inspector serialises before calling and both shapes are attempted.
 */
export async function invokeRegisteredTool(
  tool: RegisteredToolInfo,
  args: Record<string, unknown>,
): Promise<string> {
  const context = getModelContext();
  if (!context?.executeTool) throw new Error('This browser cannot invoke tools from the page.');
  try {
    return await context.executeTool(tool, JSON.stringify(args));
  } catch {
    return await context.executeTool(tool, args);
  }
}
