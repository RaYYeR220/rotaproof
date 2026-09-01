'use client';

/**
 * The manager's week.
 *
 * Every control here dispatches a registry action through `runAction`, the same objects the
 * WebMCP binding registers as tools. Nothing on this page knows how to change a roster; it
 * knows how to ask.
 */

import { Fragment, useRef, useState } from 'react';

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

/**
 * The status line, in pieces.
 *
 * Joining `parts` with ' · ' reproduces the sentence exactly; it is split only so the
 * status word can be set as a word and the figures as figures. `state` drives the colour
 * of the pip and nothing else.
 */
function statusParts(
  status: string,
  lastResult: SolveResult | undefined,
  solving: boolean,
): { state: string; parts: string[] } {
  if (solving) return { state: 'pending', parts: ['Solving…'] };
  if (!lastResult) return { state: 'pending', parts: ['Not solved yet.'] };

  const parts: string[] = [lastResult.status];
  if (lastResult.objective !== undefined) parts.push(`objective ${lastResult.objective.toFixed(2)}`);
  parts.push(`${Math.round(lastResult.wallMs)}ms`);
  if (status === 'published') parts.push('published');
  return { state: lastResult.status, parts };
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
  const showConflict = Boolean(conflict) && status === 'infeasible';
  /** Rule ids in the live clash, so the board below can press the same six in. */
  const inConflict = new Set(showConflict ? (conflict?.constraintIds ?? []) : []);

  const { state, parts } = statusParts(status, lastResult, solving);

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
      {/* ── the solve band ───────────────────────────────────────────────── */}
      <section aria-labelledby="manager-heading" className="band">
        <div className="mod-head">
          <h1 id="manager-heading">Manager</h1>
          <p className="count-tag">
            week of {model.horizon.startDate} · {model.horizon.days} days
          </p>
        </div>

        <div className="btnrow band-controls">
          <button
            id="solve"
            type="button"
            className="btn btn-primary"
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
            className="btn"
            disabled={!solving}
            onClick={() => solveAbort.current?.abort()}
          >
            Cancel
          </button>

          <button
            type="button"
            className="btn"
            disabled={!canPublish || busy !== null}
            onClick={() => dispatch('publish', publishRoster, {})}
          >
            Publish
          </button>

          <button
            id="start-next-week"
            type="button"
            className="btn"
            disabled={!canRollForward || busy !== null}
            onClick={rollForward}
          >
            Start next week
          </button>

          <button
            type="button"
            className="btn"
            disabled={!hydrated || solving}
            onClick={addFridayRequest}
          >
            Add S2&rsquo;s Friday request
          </button>

          <button
            id="reset"
            type="button"
            className="btn btn-danger"
            disabled={!hydrated || solving}
            onClick={() => dispatch('reset', resetWeek, {})}
          >
            Reset to the seeded week
          </button>
        </div>

        <p id="solve-status" aria-live="polite" className="solve-line" data-state={state}>
          <span className="pip" aria-hidden="true" />
          {parts.map((part, index) => (
            <Fragment key={part}>
              {index > 0 ? (
                <span className="sep" aria-hidden="true">
                  {' · '}
                </span>
              ) : null}
              <span className={index === 0 ? 'word' : 'fig'}>{part}</span>
            </Fragment>
          ))}
        </p>

        {solverStatus === 'failed' ? (
          <p role="alert" className="alert">
            The solver could not start: {solverError}
          </p>
        ) : null}
      </section>

      {/* ── the conflict: six rules in one mould ─────────────────────────── */}
      {showConflict && conflict ? (
        <section id="conflict" aria-labelledby="conflict-heading" className="mod hero">
          <div className="mod-head">
            <h2 id="conflict-heading">Why this week is impossible</h2>
            <p className="count-tag">
              {conflict.suggestions.length} rules · irreducible
            </p>
          </div>

          {/*
            The count leads. The solver's narrative names all six rules in a sentence and
            the mould below names them again — setting that at display size buried the one
            fact the manager actually acts on.
          */}
          <div id="conflict-sufficiency" className="verdict">
            <p className="verdict-lead">
              {sufficient.length} of {conflict.suggestions.length} would be enough on their own.
            </p>
            <p className="verdict-rest">
              Relaxing one of the others still leaves the week impossible.
            </p>
          </div>

          <p className="hero-narr">{conflict.narrative}</p>

          {conflict.inconclusive > 0 ? (
            <p id="conflict-caveat" className="hero-caveat">
              {conflict.inconclusive} probe{conflict.inconclusive === 1 ? '' : 's'} did not finish,
              so this list is an upper bound rather than a proof — the real clash may be smaller
              than what is shown. Recheck for a settled answer.
            </p>
          ) : null}

          <div className="mould">
            <h3 className="vh">The rules in the clash, and what relaxing each one would buy</h3>

            {/*
              Ordered by what actually helps, and shaped by it too. A rule that is enough on
              its own sits proud of the mould and rises when you reach for it; a rule that
              would leave a second blocker behind stays pressed in and does not move. The
              elevation is the argument.
            */}
            <ul id="conflict-rules" className="switches">
              {[...sufficient, ...insufficient].map((suggestion) => (
                <li
                  key={suggestion.constraintId}
                  data-rule={suggestion.constraintId}
                  data-sufficient={String(suggestion.sufficient)}
                  className={`switch ${suggestion.sufficient ? 'switch--lift' : 'switch--stuck'}`}
                >
                  <p className="switch-id">{suggestion.constraintId}</p>
                  <h4 className="switch-label">{suggestion.label}</h4>
                  <p className="switch-effect">{suggestion.effect}</p>

                  <p className="switch-state">
                    <span className="dot" aria-hidden="true" />
                    {suggestion.sufficient ? 'Enough on its own' : 'Not enough alone'}
                  </p>

                  {suggestion.sufficient ? null : (
                    <p className="switch-why">
                      Another blocker is left behind, and the week is still impossible.
                    </p>
                  )}

                  <button
                    type="button"
                    className="btn btn-sm switch-act"
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
          </div>

          <div className="judge">
            <p>Choosing which rule gives way is a judgement about people, not a scheduling problem.</p>
            <span className="seam" aria-hidden="true" />
            <p className="judge-foot">
              <span>
                Found in {conflict.probes} solver probes, {Math.round(conflict.wallMs)}ms.
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void recheckConflict()}>
                Recheck
              </button>
            </p>
          </div>
        </section>
      ) : null}

      {/* ── the week ─────────────────────────────────────────────────────── */}
      <section aria-labelledby="grid-heading" className="mod">
        <div className="mod-head">
          <h2 id="grid-heading">The week</h2>
          <p className="mod-note">
            Three shifts a day across the horizon. A staffed slot sits on the surface; an empty
            one is sunk into it.
          </p>
        </div>
        <div className="scroll" tabIndex={0} role="region" aria-label="Week grid">
          <RosterGrid model={model} {...(schedule ? { schedule } : {})} />
        </div>
      </section>

      {/* ── rules on the board ───────────────────────────────────────────── */}
      <section aria-labelledby="rules-heading" className="mod">
        <div className="mod-head">
          <h2 id="rules-heading">Rules in force</h2>
          <p className="mod-note">
            Hard rules cannot be broken. Soft rules are priced into the objective instead.
            {showConflict ? ' The rules pressed into the surface are the ones in the clash.' : ''}
          </p>
          <p className="count-tag">{model.constraints.length} rules</p>
        </div>

        <ul className="rules">
          {model.constraints.map((constraint) => {
            const member = inConflict.has(constraint.id);
            return (
              <li
                key={constraint.id}
                data-rule={constraint.id}
                className={`rule${member ? ' rule--member' : ''}`}
              >
                <span className="rule-id">{constraint.id}</span>

                <span className="rule-label">
                  {constraint.label}
                  <span className="rule-sub">{constraint.kind}</span>
                  {member ? <span className="rule-member-note">In the conflict set</span> : null}
                </span>

                <span
                  className={`pill ${constraint.hardness === 'hard' ? 'pill-hard' : 'pill-soft'}`}
                >
                  <span className="sq" aria-hidden="true" />
                  {constraint.hardness}
                </span>

                <span className="rule-acts">
                  {constraint.hardness === 'hard' ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={solving}
                      aria-label={`Soften rule: ${constraint.label}`}
                      onClick={() =>
                        dispatch('relax', relaxConstraint, { id: constraint.id, to: 'soft' })
                      }
                    >
                      Soften
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={solving}
                    aria-label={`Remove rule: ${constraint.label}`}
                    onClick={() =>
                      dispatch('relax', relaxConstraint, { id: constraint.id, to: 'removed' })
                    }
                  >
                    Remove
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── what the roll-forward dropped ────────────────────────────────── */}
      {cleared !== null ? (
        <section aria-labelledby="cleared-heading" className="mod">
          <div className="mod-head">
            <h2 id="cleared-heading">Cleared when the week rolled forward</h2>
            <p className="mod-note">
              These rules were tied to last week&rsquo;s dates and have been dropped. Re-add any
              that still apply.
            </p>
          </div>

          <ul id="cleared-rules" className="stack">
            {cleared.length === 0 ? (
              <li className="empty-note">
                Nothing was pinned to a particular day, so nothing was cleared.
              </li>
            ) : (
              cleared.map((rule) => (
                <li key={rule} className="row row--quiet">
                  <span className="mono">{rule}</span>
                </li>
              ))
            )}
          </ul>

          <div className="btnrow gap-top">
            <button type="button" className="btn btn-sm" onClick={() => setCleared(null)}>
              Dismiss
            </button>
          </div>
        </section>
      ) : null}

      {/* ── published versions ───────────────────────────────────────────── */}
      {session.versions.length > 0 ? (
        <section aria-labelledby="versions-heading" className="mod">
          <div className="mod-head">
            <h2 id="versions-heading">Published</h2>
            <p className="mod-note">
              Every version carries a receipt: a hash over the exact model that produced it.
            </p>
          </div>

          <ul className="stack">
            {session.versions.map((version) => (
              <li key={version.version} className="row">
                <span className="grow">
                  Version {version.version} — {version.schedule.length} shifts, {version.added}{' '}
                  added, {version.removed} removed
                </span>
                <span className="mono push">receipt {version.receipt.modelHash.slice(0, 12)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── the raw result ───────────────────────────────────────────────── */}
      <section aria-labelledby="output-heading" className="mod">
        <div className="mod-head">
          <h2 id="output-heading">Last action result</h2>
          <p className="mod-note">
            Exactly what the action returned — the same payload an agent receives.
          </p>
        </div>

        <p aria-live="polite" className="mod-note">
          {busy ? `Running ${busy}…` : output === null ? 'Nothing run yet.' : ''}
        </p>

        {output !== null ? (
          <pre className="well gap-top">
            {JSON.stringify(output, null, 2)}
          </pre>
        ) : null}

        {isActionError(output) ? (
          <p role="alert" className="alert">
            {output.message} {output.hint}
          </p>
        ) : null}
      </section>
    </div>
  );
}
