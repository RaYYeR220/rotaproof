'use client';

/**
 * The one place the week is kept.
 *
 * A module-level store rather than React state, because the WebMCP tool closures are
 * created once at registration and must never go stale: re-registering an existing tool
 * name is rejected by the browser, so a closure that captured a render's props would
 * either lie or force a re-registration on every render.
 *
 * Everything an action needs — `update`, `solve`, `confirm` — is implemented here and
 * handed to actions through `ActionContext`, which is why a button and a tool call reach
 * exactly the same code.
 */

import { EMPTY_LEDGER, type SolveResult, seedRoster, solveRoster } from '@rotaproof/core';
import type {
  ActionContext,
  ActionDefinition,
  ActionResult,
  BindingEvent,
  ConfirmRequest,
  Role,
  RosterSession,
  StaffId,
} from '@rotaproof/registry';
import { create } from 'zustand';

import { clearStoredSessions, loadSession, saveSession } from './persist';
import { explainInWorker, solverBackend, warmSolver } from './solverClient';

export const DEFAULT_TIME_LIMIT_MS = 10_000;

export interface ActivityEntry extends BindingEvent {
  /** Monotonic, so React keys stay stable as entries scroll off. */
  key: number;
  at: string;
}

export interface PendingConfirm {
  id: string;
  request: ConfirmRequest;
  /** The tool waiting on this answer, when an agent asked. Absent for a button press. */
  toolName?: string;
}

export type SolverStatus = 'warming' | 'ready' | 'failed';

interface WebStore {
  session: RosterSession;
  /** False until the stored week has been read back, so the first render matches the server. */
  hydrated: boolean;
  solverStatus: SolverStatus;
  solverWarmupMs?: number;
  solverError?: string;
  pendingConfirm: PendingConfirm | null;
  activity: ActivityEntry[];
  /** The agent tool currently executing, used to attach a confirmation to its call. */
  activeTool: string | null;
  registered: { total: number; read: number; write: number };

  update: ActionContext['update'];
  solve: ActionContext['solve'];
  dryRun: ActionContext['dryRun'];
  confirm: ActionContext['confirm'];
  answerConfirm: (id: string, approved: boolean) => void;
  cancelConfirm: (id: string) => void;
  signInAs: (staff: StaffId | undefined) => void;
  noteEvent: (event: BindingEvent) => void;
  setRegistered: (counts: { total: number; read: number; write: number }) => void;
  recheckConflict: () => Promise<void>;
}

function freshSession(role: Role): RosterSession {
  return {
    model: seedRoster(),
    ledger: EMPTY_LEDGER,
    status: 'draft',
    swaps: [],
    versions: [],
    role,
    solving: false,
  };
}

const MAX_ACTIVITY = 40;

let activityKey = 0;
let confirmSeq = 0;
/** Settle functions for confirmations still on screen, keyed by pending id. */
const confirmResolvers = new Map<string, (approved: boolean) => void>();

/**
 * Chrome never tells the page that an agent has abandoned a call, so the page keeps its
 * own handle on the binding and cancels from this side.
 */
let cancelToolCall: ((toolName: string) => boolean) | undefined;

export function setToolCanceller(cancel: ((toolName: string) => boolean) | undefined): void {
  cancelToolCall = cancel;
}

export const useWebStore = create<WebStore>()((set, get) => ({
  session: freshSession('manager'),
  hydrated: false,
  solverStatus: 'warming',
  pendingConfirm: null,
  activity: [],
  activeTool: null,
  registered: { total: 0, read: 0, write: 0 },

  /**
   * Actions assign whole fields on the draft — never element-wise — so a shallow copy of
   * the session and its model is enough to give React a new reference to render from.
   */
  update: (mutate) => {
    set((state) => {
      const draft: RosterSession = { ...state.session, model: { ...state.session.model } };
      mutate(draft);
      return { session: draft };
    });
  },

  solve: async (options = {}) => {
    set((state) => ({ session: { ...state.session, solving: true } }));
    try {
      const { model, ledger } = get().session;
      const result = await solveRoster(model, solverBackend, {
        ledger,
        timeLimitMs: options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      set((state) => {
        const session: RosterSession = { ...state.session, lastResult: result };
        if (result.status === 'infeasible') {
          session.status = 'infeasible';
          session.schedule = undefined;
        } else if (result.schedule) {
          session.status = 'solved';
          session.schedule = result.schedule;
        }
        return { session };
      });

      return result;
    } finally {
      set((state) => ({ session: { ...state.session, solving: false } }));
    }
  },

  /**
   * Answers a hypothetical without touching the week.
   *
   * "Could this person take that shift?" is decided by solving a model that is not the
   * real one, so none of it is written back: the working schedule survives the question,
   * and an infeasible probe does not erase it.
   */
  dryRun: (constraints, options = {}) =>
    solveRoster({ ...get().session.model, constraints }, solverBackend, {
      ledger: get().session.ledger,
      timeLimitMs: DEFAULT_TIME_LIMIT_MS,
      explain: false,
      ...options,
    }),

  /**
   * The human-in-the-loop primitive. The promise is what the agent's tool call is waiting
   * on, and only a click resolves it.
   */
  confirm: (request, signal) =>
    new Promise<boolean>((resolve) => {
      if (signal?.aborted) {
        resolve(false);
        return;
      }

      const id = `confirm-${++confirmSeq}`;
      let settled = false;

      const finish = (approved: boolean) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        confirmResolvers.delete(id);
        set((state) => (state.pendingConfirm?.id === id ? { pendingConfirm: null } : {}));
        resolve(approved);
      };

      const onAbort = () => finish(false);
      signal?.addEventListener('abort', onAbort, { once: true });
      confirmResolvers.set(id, finish);

      const toolName = get().activeTool;
      set({ pendingConfirm: { id, request, ...(toolName ? { toolName } : {}) } });
    }),

  answerConfirm: (id, approved) => {
    confirmResolvers.get(id)?.(approved);
  },

  /**
   * Withdraws a confirmation the page no longer believes in. Aborting the tool call is
   * the part that matters: without it the agent's `execute` stays open forever.
   */
  cancelConfirm: (id) => {
    const pending = get().pendingConfirm;
    if (pending?.id === id && pending.toolName) cancelToolCall?.(pending.toolName);
    confirmResolvers.get(id)?.(false);
  },

  /** Picking a person is also what puts the session on the staff surface. */
  signInAs: (staff) => {
    set((state) => ({ session: { ...state.session, role: 'staff', actorId: staff } }));
  },

  noteEvent: (event) => {
    set((state) => ({
      activeTool: event.phase === 'start' ? event.toolName : null,
      activity: [
        ...state.activity.slice(-(MAX_ACTIVITY - 1)),
        { ...event, key: ++activityKey, at: new Date().toISOString().slice(11, 23) },
      ],
    }));
  },

  setRegistered: (counts) => set({ registered: counts }),

  /**
   * Recomputes the conflict against the rules as they stand now.
   *
   * After relaxing a rule the displayed explanation is about a model that no longer
   * exists. Deciding that again costs only feasibility probes, a fraction of what a fresh
   * optimal solve would cost, so it is offered separately from Solve.
   */
  recheckConflict: async () => {
    const { session } = get();
    if (!session.lastResult) return;
    try {
      const conflict = await explainInWorker(session.model, session.ledger);
      set((state) => {
        if (!state.session.lastResult) return {};
        const lastResult: SolveResult = { ...state.session.lastResult, conflict };
        return { session: { ...state.session, lastResult } };
      });
    } catch (error) {
      set({ solverError: error instanceof Error ? error.message : String(error) });
    }
  },
}));

/**
 * The context every action runs with, whether a person or an agent started it.
 *
 * `session` is a live getter rather than a snapshot: an action that updates and then reads
 * must see its own write, which is how the headless session in the registry behaves too.
 */
export function makeActionContext(signal?: AbortSignal): ActionContext {
  const store = useWebStore.getState();
  return {
    get session() {
      return useWebStore.getState().session;
    },
    update: store.update,
    solve: store.solve,
    dryRun: store.dryRun,
    confirm: store.confirm,
    ...(signal ? { signal } : {}),
  };
}

/**
 * Runs a registry action from the page.
 *
 * The single entry point for every control in the UI. Nothing in `components/` implements
 * an operation itself, so a button and the tool of the same name cannot disagree.
 */
export async function runAction<Args, Result>(
  action: ActionDefinition<Args, Result>,
  args: Args,
  options: { signal?: AbortSignal } = {},
): Promise<ActionResult<Result>> {
  return action.run(args, makeActionContext(options.signal));
}

// ---------------------------------------------------------------------------
// Boot: hydration, persistence, and warming the solver
// ---------------------------------------------------------------------------

/** `/staff` is the staff surface; everything else, the inspector included, is the manager's. */
function roleForPath(pathname: string): Role {
  return pathname.startsWith('/staff') ? 'staff' : 'manager';
}

let persisting = false;

function startPersisting(): void {
  if (persisting) return;
  persisting = true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous = useWebStore.getState().session;

  useWebStore.subscribe((state) => {
    if (state.session === previous) return;
    previous = state.session;
    if (timer) clearTimeout(timer);
    // Coalesced: a single solve writes the session three times in a few milliseconds.
    timer = setTimeout(() => void saveSession(previous.role, previous), 250);
  });
}

let booted: Promise<void> | undefined;

/** Who the staff view signs you in as before you pick somebody else. */
const DEFAULT_ACTOR: StaffId = 'S7';

/**
 * Gives the staff surface something to be about.
 *
 * A staff member looking at an unsolved week has nothing to ask: no shifts to read, no
 * shift to offer, nothing to swap. So the first visit lands on a published week and a swap
 * board with one offer on it. The week is solved here rather than shipped as a constant, so
 * it is always the roster the current rules actually produce.
 */
async function seedStaffSession(): Promise<void> {
  const store = useWebStore.getState();
  if (!store.session.actorId) store.signInAs(DEFAULT_ACTOR);

  if (useWebStore.getState().session.versions.length === 0) {
    const result = await store.solve();
    const schedule = result.schedule;
    if (!schedule || schedule.length === 0) return;

    store.update((draft) => {
      draft.versions = [
        {
          version: 1,
          schedule: [...schedule],
          receipt: result.receipt,
          publishedAt: new Date().toISOString(),
          added: schedule.length,
          removed: 0,
        },
      ];
      draft.status = 'published';
    });
  }

  const session = useWebStore.getState().session;
  if (session.swaps.length > 0) return;

  const published = session.versions.at(-1)?.schedule ?? session.schedule ?? [];
  const offered = published.find((assignment) => assignment.staff !== session.actorId);
  if (!offered) return;

  store.update((draft) => {
    draft.swaps = [
      {
        id: 'SW-seed',
        from: offered.staff,
        day: offered.day,
        shift: offered.shift,
        status: 'open',
        note: 'Swapping this one if anybody wants it.',
        createdAt: new Date().toISOString(),
      },
    ];
  });
}

/**
 * Reads the stored week back and starts the solver warming.
 *
 * `?reset=1` drops everything first. Eval runners open a fresh page per case against the
 * same browser profile, so without it the third case would inherit whatever the second
 * one did.
 */
export function bootSession(): Promise<void> {
  booted ??= (async () => {
    if (typeof window === 'undefined') return;

    const role = roleForPath(window.location.pathname);
    const reset = new URLSearchParams(window.location.search).get('reset') === '1';

    if (reset) await clearStoredSessions();

    // Records are kept per role, but a staff member with no record of their own should see
    // the week the manager published rather than a blank one, so the manager's record is
    // the fallback. It is not symmetric: the manager's week is the source.
    const stored = reset
      ? undefined
      : ((await loadSession(role)) ?? (role === 'staff' ? await loadSession('manager') : undefined));

    useWebStore.setState({
      session: stored ? { ...stored, role, solving: false } : freshSession(role),
      hydrated: true,
    });

    startPersisting();

    // Deliberately not awaited on the manager side: the seeded week renders immediately,
    // and the Solve button says so until the WebAssembly module has compiled.
    const warming = warmSolver().then(
      (info) => useWebStore.setState({ solverStatus: 'ready', solverWarmupMs: info.warmupMs }),
      (error: unknown) =>
        useWebStore.setState({
          solverStatus: 'failed',
          solverError: error instanceof Error ? error.message : String(error),
        }),
    );

    if (role === 'staff') {
      // The staff surface is the exception: which of its tools exist depends on having a
      // roster, so the week is settled before anything is registered.
      await warming;
      try {
        await seedStaffSession();
      } catch {
        // A solver that cannot start leaves the staff view empty rather than broken; the
        // page already reports the failure.
      }
    }
  })();

  return booted;
}
