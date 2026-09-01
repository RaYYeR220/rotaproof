'use client';

/**
 * Where this page meets the browser's agent surface.
 *
 * Renders nothing. It lives in the root layout rather than in a page because a client-side
 * navigation would otherwise tear the whole tool surface down and build it again — and a
 * `publish_roster` call waiting on a human click would be lost the moment they wandered
 * over to the inspector.
 *
 * The action registry decides *what* exists; this component decides *when*. Every relevant
 * change to the session re-runs `sync()`, which diffs by fingerprint, so the registered
 * tools are always exactly the actions that are possible right now.
 */

import { useEffect } from 'react';

import { ALL_ACTIONS, WebMcpBinding, getModelContext, isWebMcpSupported } from '@rotaproof/registry';

import { bootSession, makeActionContext, setToolCanceller, useWebStore } from '@/lib/store';

declare global {
  interface Window {
    /** Flipped once the week is loaded and the first registration pass has finished. */
    __ROTAPROOF_READY__?: boolean;
  }
}

/**
 * The one tool this file registers directly, rather than through the registry.
 *
 * It is deliberately the cheapest possible call: a single sentence about what the page is,
 * and the name of the tool that actually answers questions. An agent that lands here with
 * no context should be able to orient itself for the price of one read.
 */
const ABOUT_TOOL = {
  name: 'about_rotaproof',
  description:
    'One sentence about what this page is. Call describe_roster for the actual roster: the week, the shifts, the team and the rules in force.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  // Chrome 151 calls execute with exactly one argument, so the second is read defensively
  // and never destructured. Nothing here throws: a thrown error reaches the agent as an
  // opaque "invocation failed" with the message discarded.
  execute: async () => ({
    about:
      'RotaProof plans a week of café shifts in the browser with an exact solver, and proves why a week is impossible when it is.',
    next: 'Call describe_roster.',
  }),
};

/**
 * Registering a name that is already taken is rejected rather than replaced, and React
 * StrictMode mounts, cleans up and mounts again — so the abort from the first pass can land
 * after the second has already tried. Waiting for it to settle and retrying is the fix.
 */
async function registerAbout(signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (signal.aborted) return false;
    try {
      await document.modelContext!.registerTool(ABOUT_TOOL, { signal });
      return true;
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (!/InvalidStateError|Duplicate tool name/i.test(message)) return false;
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
  return false;
}

/**
 * The parts of the session that change which tools exist.
 *
 * `sync()` is cheap, but it is still an await per registration, so it runs on a signature
 * rather than on every keystroke-sized change to the model.
 */
function toolSignature(): string {
  const { session } = useWebStore.getState();
  return [
    session.role,
    session.actorId ?? '-',
    session.status,
    session.solving ? 'solving' : 'idle',
    session.schedule ? 'scheduled' : 'none',
    session.lastResult?.conflict ? 'conflict' : 'clear',
    session.lastResult?.verification?.ok ? 'valid' : 'unverified',
    session.swaps.filter((swap) => swap.status === 'open').length,
    session.versions.length,
  ].join('|');
}

export default function ModelContextBridge() {
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    const binding = new WebMcpBinding(ALL_ACTIONS, {
      getSession: () => useWebStore.getState().session,
      makeContext: (signal) => makeActionContext(signal),
      onEvent: (event) => useWebStore.getState().noteEvent(event),
    });

    setToolCanceller((toolName) => binding.cancel(toolName));

    let aboutRegistered = false;

    const publishCounts = () => {
      const names = binding.registered;
      const read = names.filter(
        (name) => ALL_ACTIONS.find((action) => action.id === name)?.readOnly,
      ).length;
      useWebStore.getState().setRegistered({
        total: names.length + (aboutRegistered ? 1 : 0),
        read: read + (aboutRegistered ? 1 : 0),
        write: names.length - read,
      });
    };

    let signature = '';
    let syncing = Promise.resolve();

    const sync = () => {
      syncing = syncing.then(async () => {
        if (disposed) return;
        await binding.sync();
        publishCounts();
      });
      return syncing;
    };

    void (async () => {
      // The week has to be loaded first: which tools exist depends on the role and on
      // whether there is a schedule, and registering the wrong set then correcting it
      // would show an agent a surface that was never true.
      await bootSession();
      if (disposed) return;

      // Registration order is what an agent sees, and orientation belongs first.
      if (isWebMcpSupported()) aboutRegistered = await registerAbout(controller.signal);

      signature = toolSignature();
      await sync();

      if (!disposed) window.__ROTAPROOF_READY__ = true;
    })();

    const unsubscribe = useWebStore.subscribe(() => {
      const next = toolSignature();
      if (next === signature) return;
      signature = next;
      void sync();
    });

    return () => {
      disposed = true;
      unsubscribe();
      setToolCanceller(undefined);
      controller.abort();
      binding.dispose();
      window.__ROTAPROOF_READY__ = false;
    };
  }, []);

  return null;
}

/** Whether the browser exposes the API at all. Used by the inspector's unsupported state. */
export function webMcpAvailable(): boolean {
  return getModelContext() !== undefined;
}
