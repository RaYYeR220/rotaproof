'use client';

/**
 * The other half of the product.
 *
 * A person asking "can I have Friday off?" or "will anyone take my Saturday night?" is
 * asking a combinatorial question about a roster they cannot see all of. Every control here
 * runs the same registry action an agent would, and each of those reaches its answer by
 * re-solving — so a yes is a proof rather than an encouraging guess.
 */

import { useState } from 'react';

import { type RosterModel, type Schedule, dateOf, shiftById, staffById } from '@rotaproof/core';
import {
  type ActionDefinition,
  acceptSwap,
  findSwap,
  isActionError,
  listSwaps,
  offerSwap,
  requestTimeOff,
} from '@rotaproof/registry';

import { runAction, useWebStore } from '@/lib/store';

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' });

/** "Friday" rather than "day 4" — the person reading this thinks in weekdays. */
function dayName(model: RosterModel, day: number): string {
  return WEEKDAY.format(new Date(`${dateOf(model.horizon, day)}T00:00:00Z`));
}

export default function StaffView() {
  const session = useWebStore((state) => state.session);
  const hydrated = useWebStore((state) => state.hydrated);
  const signInAs = useWebStore((state) => state.signInAs);

  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<unknown>(null);
  const [day, setDay] = useState(4);
  const [shift, setShift] = useState(session.model.shiftTypes[0]?.id ?? 'open');
  const [note, setNote] = useState('');

  const { model, actorId, solving } = session;
  const published = session.versions.at(-1);
  const schedule: Schedule = published?.schedule ?? session.schedule ?? [];
  const mine = schedule.filter((assignment) => assignment.staff === actorId);
  const openSwaps = session.swaps.filter((swap) => swap.status === 'open');

  async function dispatch<Args, Result>(
    label: string,
    action: ActionDefinition<Args, Result>,
    args: Args,
  ) {
    setBusy(label);
    try {
      setOutput(await runAction(action, args));
    } catch (error) {
      setOutput({ error: 'failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {/* ── who is at the counter ────────────────────────────────────────── */}
      <section aria-labelledby="staff-heading" className="band">
        <div className="mod-head band-head">
          <h1 id="staff-heading">Staff</h1>
          <p className="count-tag">week of {model.horizon.startDate}</p>

          <p className="field field--inline push">
            <label htmlFor="actor-picker">Signed in as</label>
            <select
              id="actor-picker"
              className="control"
              value={actorId ?? ''}
              disabled={!hydrated}
              onChange={(event) => signInAs(event.target.value || undefined)}
            >
              <option value="">Nobody</option>
              {model.staff.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.id} · {person.name}
                </option>
              ))}
            </select>
          </p>
        </div>
      </section>

      <div className="duo duo--aside">
        {/* ── my shifts ──────────────────────────────────────────────────── */}
        <section aria-labelledby="shifts-heading" className="mod">
        <div className="mod-head">
          <h2 id="shifts-heading">My shifts</h2>
          <p className="count-tag">
            {published ? `published version ${published.version}` : 'unpublished draft'}
          </p>
        </div>

        <ul id="my-shifts" className="stack">
          {!actorId ? (
            <li className="empty-note">Pick who you are to see your shifts.</li>
          ) : mine.length === 0 ? (
            <li className="empty-note">Nothing rostered for you this week.</li>
          ) : (
            mine
              .slice()
              .sort((a, b) => a.day - b.day)
              .map((assignment) => (
                <li
                  key={`${assignment.day}:${assignment.shift}`}
                  data-day={assignment.day}
                  className="row"
                >
                  <span className="grow">
                    {dayName(model, assignment.day)} ·{' '}
                    {shiftById(model, assignment.shift)?.label ?? assignment.shift}
                  </span>
                  <span className="mono push">day {assignment.day}</span>
                </li>
              ))
          )}
        </ul>
      </section>

        {/* ── ask about a shift ──────────────────────────────────────────── */}
        <section aria-labelledby="ask-heading" className="mod">
        <div className="mod-head">
          <h2 id="ask-heading">Ask about a shift</h2>
          <p className="mod-note">
            Every answer here is a fresh solve, so a yes is a proof rather than a guess.
          </p>
        </div>

        <div className="fieldrow">
          <p className="field">
            <label htmlFor="pick-day">Day</label>
            <select
              id="pick-day"
              className="control"
              value={day}
              onChange={(event) => setDay(Number(event.target.value))}
            >
              {Array.from({ length: model.horizon.days }, (_, index) => (
                <option key={index} value={index}>
                  {dayName(model, index)} · day {index}
                </option>
              ))}
            </select>
          </p>

          <p className="field">
            <label htmlFor="pick-shift">Shift</label>
            <select
              id="pick-shift"
              className="control"
              value={shift}
              onChange={(event) => setShift(event.target.value)}
            >
              {model.shiftTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.label}
                </option>
              ))}
            </select>
          </p>

          <p className="field grow">
            <label htmlFor="pick-note">Note for the manager (optional)</label>
            <input
              id="pick-note"
              type="text"
              className="control"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </p>
        </div>

        <div className="btnrow gap-top">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!actorId || solving || busy !== null}
            onClick={() =>
              dispatch('time-off', requestTimeOff, {
                slots: [{ day, shift }],
                ...(note ? { note } : {}),
              })
            }
          >
            Request this slot off
          </button>

          <button
            type="button"
            className="btn"
            disabled={!actorId || solving || busy !== null}
            onClick={() => dispatch('find-swap', findSwap, { day, shift })}
          >
            Who could take this shift?
          </button>

          <button
            type="button"
            className="btn"
            disabled={!actorId || solving || busy !== null}
            onClick={() =>
              dispatch('offer-swap', offerSwap, { day, shift, ...(note ? { note } : {}) })
            }
          >
            Offer this shift
          </button>
        </div>
        </section>
      </div>

      <div className="duo">
        {/* ── the swap board ─────────────────────────────────────────────── */}
        <section aria-labelledby="swaps-heading" className="mod">
        <div className="mod-head">
          <h2 id="swaps-heading">Open swaps</h2>
          <p className="count-tag">{openSwaps.length} offered</p>
        </div>

        <ul className="stack">
          {openSwaps.length === 0 ? (
            <li className="empty-note">Nobody has offered a shift.</li>
          ) : (
            openSwaps.map((swap) => (
              <li key={swap.id} data-swap={swap.id} className="row">
                <span className="grow">
                  {swap.from} · {dayName(model, swap.day)}{' '}
                  {shiftById(model, swap.shift)?.label ?? swap.shift}
                  {swap.note ? ` — “${swap.note}”` : ''}
                </span>
                <button
                  type="button"
                  className="btn btn-sm push"
                  disabled={!actorId || swap.from === actorId || solving || busy !== null}
                  aria-label={`Take day ${swap.day} ${shiftById(model, swap.shift)?.label ?? swap.shift} from ${swap.from}`}
                  onClick={() => dispatch('accept-swap', acceptSwap, { swapId: swap.id })}
                >
                  Take it
                </button>
              </li>
            ))
          )}
        </ul>

        {openSwaps.length > 0 ? (
          <div className="btnrow gap-top">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => dispatch('list-swaps', listSwaps, {})}
            >
              Read the swap board as an agent would
            </button>
          </div>
        ) : null}
        </section>

        {/* ── the raw result ─────────────────────────────────────────────── */}
        <section aria-labelledby="staff-output-heading" className="mod">
        <div className="mod-head">
          <h2 id="staff-output-heading">Last action result</h2>
          <p className="mod-note">
            Exactly what the action returned — the same payload an agent receives.
          </p>
        </div>

        <p aria-live="polite" className="mod-note">
          {busy ? `Running ${busy}…` : output === null ? 'Nothing run yet.' : ''}
        </p>

        {output !== null ? (
          <pre className="well gap-top">{JSON.stringify(output, null, 2)}</pre>
        ) : null}

        {isActionError(output) ? (
          <p role="alert" className="alert">
            {output.message} {output.hint}
          </p>
        ) : null}
        </section>
      </div>

      {/* The product claim, given the weight it earns. */}
      {staffById(model, actorId ?? '') ? (
        <div className="claim">
          <p>Your name, notes and pay rate stay in this tab.</p>
          <span className="seam" aria-hidden="true" />
          <p className="claim-foot">An agent driving this page sees ids, skills and counts only.</p>
        </div>
      ) : null}
    </div>
  );
}
