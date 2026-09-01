'use client';

/**
 * The manager's week.
 *
 * Every control here dispatches a registry action through `runAction`, the same objects the
 * WebMCP binding registers as tools. Nothing on this page knows how to change a roster; it
 * knows how to ask.
 */

import { useRef, useState } from 'react';

import { type SolveResult, type TimeOffConstraint, fridayConflict } from '@rotaproof/core';
import {
  type ActionDefinition,
  isActionError,
  publishRoster,
  relaxConstraint,
  setConstraint,
  solveRosterAction,
} from '@rotaproof/registry';

import RosterGrid from '@/components/RosterGrid';
import { resetWeek } from '@/lib/actions';
import { runAction, useWebStore } from '@/lib/store';

function statusLine(status: string, lastResult: SolveResult | undefined, solving: boolean): string {
  if (solving) return 'Solving…';
  if (!lastResult) return 'Not solved yet.';
  const parts = [lastResult.status];
  if (lastResult.objective !== undefined) parts.push(`objective ${lastResult.objective.toFixed(2)}`);
  parts.push(`${Math.round(lastResult.wallMs)}ms`);
  if (status === 'published') parts.push('published');
  return parts.join(' · ');
}

export default function ManagerView() {
  const session = useWebStore((state) => state.session);
  const hydrated = useWebStore((state) => state.hydrated);
  const solverStatus = useWebStore((state) => state.solverStatus);
  const solverError = useWebStore((state) => state.solverError);
  const recheckConflict = useWebStore((state) => state.recheckConflict);

  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<unknown>(null);
  const solveAbort = useRef<AbortController | null>(null);

  const { model, schedule, lastResult, status, solving } = session;
  const conflict = lastResult?.conflict;
  const canPublish = publishRoster.available(session);

  async function dispatch<Args, Result>(
    label: string,
    action: ActionDefinition<Args, Result>,
    args: Args,
    signal?: AbortSignal,
  ) {
    setBusy(label);
    try {
      setOutput(await runAction(action, args, signal ? { signal } : {}));
    } catch (error) {
      setOutput({ error: 'failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function solve() {
    const controller = new AbortController();
    solveAbort.current = controller;
    try {
      await dispatch('solve', solveRosterAction, {}, controller.signal);
    } finally {
      solveAbort.current = null;
    }
  }

  function addFridayRequest() {
    const request = fridayConflict() as TimeOffConstraint;
    return dispatch('friday', setConstraint, {
      id: request.id,
      kind: request.kind,
      label: request.label,
      hardness: request.hardness,
      group: request.group,
      staff: request.staff,
      status: request.status,
      slots: request.slots,
    });
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Manager</h1>

      <section aria-labelledby="solve-heading" className="mt-4">
        <h2 id="solve-heading" className="text-xs font-semibold uppercase tracking-wide">
          Solve
        </h2>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            id="solve"
            type="button"
            className="border px-3 py-1"
            disabled={!hydrated || solving || solverStatus === 'failed'}
            onClick={solve}
          >
            {solving
              ? 'Solving…'
              : solverStatus === 'warming'
                ? 'Solve (warming the solver…)'
                : 'Solve'}
          </button>

          <button
            type="button"
            className="border px-3 py-1"
            disabled={!solving}
            onClick={() => solveAbort.current?.abort()}
          >
            Cancel
          </button>

          <button
            type="button"
            className="border px-3 py-1"
            disabled={!canPublish || busy !== null}
            onClick={() => dispatch('publish', publishRoster, {})}
          >
            Publish
          </button>

          <button
            id="reset"
            type="button"
            className="border px-3 py-1"
            disabled={!hydrated || solving}
            onClick={() => dispatch('reset', resetWeek, {})}
          >
            Reset to the seeded week
          </button>

          <button
            type="button"
            className="border px-3 py-1"
            disabled={!hydrated || solving}
            onClick={addFridayRequest}
          >
            Add S2&rsquo;s Friday request
          </button>
        </div>

        <p id="solve-status" aria-live="polite" className="mt-2">
          {statusLine(status, lastResult, solving)}
        </p>

        {solverStatus === 'failed' ? (
          <p role="alert" className="mt-1">
            The solver could not start: {solverError}
          </p>
        ) : null}
      </section>

      {conflict && status === 'infeasible' ? (
        <section id="conflict" aria-labelledby="conflict-heading" className="mt-6 border p-3">
          <h2 id="conflict-heading" className="text-xs font-semibold uppercase tracking-wide">
            Why this week is impossible
          </h2>

          <p className="mt-2">{conflict.narrative}</p>

          <ul id="conflict-rules" className="mt-2 list-disc pl-5">
            {conflict.suggestions.map((suggestion) => (
              <li key={suggestion.constraintId} data-rule={suggestion.constraintId}>
                <strong>{suggestion.label}</strong> — {suggestion.effect}{' '}
                <button
                  type="button"
                  className="border px-2"
                  disabled={solving}
                  onClick={() =>
                    dispatch('relax', relaxConstraint, { id: suggestion.constraintId, to: 'soft' })
                  }
                >
                  Soften
                </button>
              </li>
            ))}
          </ul>

          <p className="mt-2">
            Found in {conflict.probes} solver probes, {Math.round(conflict.wallMs)}ms.{' '}
            <button type="button" className="border px-2" onClick={() => void recheckConflict()}>
              Recheck
            </button>
          </p>
        </section>
      ) : null}

      <section aria-labelledby="grid-heading" className="mt-6">
        <h2 id="grid-heading" className="text-xs font-semibold uppercase tracking-wide">
          The week
        </h2>
        <div className="mt-2 overflow-x-auto">
          <RosterGrid model={model} {...(schedule ? { schedule } : {})} />
        </div>
      </section>

      <section aria-labelledby="rules-heading" className="mt-6">
        <h2 id="rules-heading" className="text-xs font-semibold uppercase tracking-wide">
          Rules in force ({model.constraints.length})
        </h2>

        <ul className="mt-2">
          {model.constraints.map((constraint) => (
            <li key={constraint.id} data-rule={constraint.id} className="border-b py-1">
              <span className="font-mono">{constraint.id}</span> {constraint.hardness}{' '}
              {constraint.kind} — {constraint.label}{' '}
              {constraint.hardness === 'hard' ? (
                <button
                  type="button"
                  className="border px-2"
                  disabled={solving}
                  aria-label={`Soften rule: ${constraint.label}`}
                  onClick={() => dispatch('relax', relaxConstraint, { id: constraint.id, to: 'soft' })}
                >
                  Soften
                </button>
              ) : null}{' '}
              <button
                type="button"
                className="border px-2"
                disabled={solving}
                aria-label={`Remove rule: ${constraint.label}`}
                onClick={() => dispatch('relax', relaxConstraint, { id: constraint.id, to: 'removed' })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      {session.versions.length > 0 ? (
        <section aria-labelledby="versions-heading" className="mt-6">
          <h2 id="versions-heading" className="text-xs font-semibold uppercase tracking-wide">
            Published
          </h2>
          <ul className="mt-2">
            {session.versions.map((version) => (
              <li key={version.version}>
                Version {version.version} — {version.schedule.length} shifts, {version.added} added,{' '}
                {version.removed} removed, receipt{' '}
                <span className="font-mono">{version.receipt.modelHash.slice(0, 12)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="output-heading" className="mt-6">
        <h2 id="output-heading" className="text-xs font-semibold uppercase tracking-wide">
          Last action result
        </h2>
        <p aria-live="polite" className="mt-1">
          {busy ? `Running ${busy}…` : output === null ? 'Nothing run yet.' : ''}
        </p>
        {output !== null ? (
          <pre className="mt-1 overflow-x-auto border p-2 text-xs">
            {JSON.stringify(output, null, 2)}
          </pre>
        ) : null}
        {isActionError(output) ? (
          <p role="alert" className="mt-1">
            {output.message} {output.hint}
          </p>
        ) : null}
      </section>
    </div>
  );
}
