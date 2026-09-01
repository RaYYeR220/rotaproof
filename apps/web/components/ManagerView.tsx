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
  startNextWeek,
} from '@rotaproof/registry';

import RosterGrid from '@/components/RosterGrid';
import { resetWeek } from '@/lib/actions';
import { runAction, useWebStore } from '@/lib/store';

function statusLine(status: string, lastResult: SolveResult | undefined, solving: boolean): string {
  if (solving) return 'Solving…';
  if (!lastResult) return 'Not solved yet.';
  const parts: string[] = [lastResult.status];
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
  /** Rules the roll-forward dropped, kept on screen until the manager has dealt with them. */
  const [cleared, setCleared] = useState<string[] | null>(null);
  const solveAbort = useRef<AbortController | null>(null);

  const { model, schedule, lastResult, status, solving } = session;
  const conflict = lastResult?.conflict;
  const canPublish = publishRoster.available(session);
  const canRollForward = startNextWeek.available(session);
  const sufficient = (conflict?.suggestions ?? []).filter((s) => s.sufficient);
  const insufficient = (conflict?.suggestions ?? []).filter((s) => !s.sufficient);

  async function dispatch<Args, Result>(
    label: string,
    action: ActionDefinition<Args, Result>,
    args: Args,
    signal?: AbortSignal,
  ) {
    setBusy(label);
    try {
      const result = await runAction(action, args, signal ? { signal } : {});
      setOutput(result);
      return result;
    } catch (error) {
      const failure = {
        error: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
      setOutput(failure);
      return failure;
    } finally {
      setBusy(null);
    }
  }

  /**
   * Rolling into the next week drops every rule pinned to a particular day, because a
   * rule that looks weekly is indistinguishable in the data from a one-off. The list of
   * what went is the point of the action, so it gets its own place on the page rather
   * than being left in the result panel.
   */
  async function rollForward() {
    const result = await dispatch('next-week', startNextWeek, {});
    const dropped = (result as { cleared?: unknown })?.cleared;
    setCleared(Array.isArray(dropped) ? (dropped as string[]) : []);
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
            id="start-next-week"
            type="button"
            className="border px-3 py-1"
            disabled={!canRollForward || busy !== null}
            onClick={rollForward}
          >
            Start next week
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

          {conflict.inconclusive > 0 ? (
            <p id="conflict-caveat" className="mt-2">
              {conflict.inconclusive} probe{conflict.inconclusive === 1 ? '' : 's'} did not finish,
              so this list is an upper bound rather than a proof — the real clash may be smaller
              than what is shown. Recheck for a settled answer.
            </p>
          ) : null}

          <p id="conflict-sufficiency" className="mt-2">
            {sufficient.length} of {conflict.suggestions.length} would be enough on their own.
            Relaxing one of the others still leaves the week impossible.
          </p>

          {/*
            Ordered by what actually helps. A rule can be load-bearing for this clash and
            still leave a second, independent one behind when it goes, and sending a manager
            to relax one of those wastes their afternoon.
          */}
          <ul id="conflict-rules" className="mt-2 list-disc pl-5">
            {[...sufficient, ...insufficient].map((suggestion) => (
              <li
                key={suggestion.constraintId}
                data-rule={suggestion.constraintId}
                data-sufficient={String(suggestion.sufficient)}
              >
                <strong>{suggestion.label}</strong> — {suggestion.effect}{' '}
                <em>
                  {suggestion.sufficient
                    ? 'Relaxing this one alone makes the week work.'
                    : 'Not enough on its own: another blocker is left behind.'}
                </em>{' '}
                <button
                  type="button"
                  className="border px-2"
                  disabled={solving}
                  aria-label={`Soften rule: ${suggestion.label}`}
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

      {cleared !== null ? (
        <section aria-labelledby="cleared-heading" className="mt-6 border p-3">
          <h2 id="cleared-heading" className="text-xs font-semibold uppercase tracking-wide">
            Cleared when the week rolled forward
          </h2>
          <p className="mt-2">
            These rules were tied to last week&rsquo;s dates and have been dropped. Re-add any
            that still apply.
          </p>
          <ul id="cleared-rules" className="mt-2 list-disc pl-5">
            {cleared.length === 0 ? (
              <li>Nothing was pinned to a particular day, so nothing was cleared.</li>
            ) : (
              cleared.map((rule) => <li key={rule}>{rule}</li>)
            )}
          </ul>
          <button
            type="button"
            className="mt-2 border px-2"
            onClick={() => setCleared(null)}
          >
            Dismiss
          </button>
        </section>
      ) : null}

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
