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

import { type Schedule, shiftById, staffById } from '@rotaproof/core';
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
      <h1 className="text-lg font-semibold">Staff</h1>

      <section aria-labelledby="who-heading" className="mt-4">
        <h2 id="who-heading" className="text-xs font-semibold uppercase tracking-wide">
          Who are you?
        </h2>

        <p className="mt-1">
          <label htmlFor="actor-picker">Signed in as</label>{' '}
          <select
            id="actor-picker"
            className="border px-2 py-1"
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
      </section>

      <section aria-labelledby="shifts-heading" className="mt-6">
        <h2 id="shifts-heading" className="text-xs font-semibold uppercase tracking-wide">
          My shifts {published ? `(published version ${published.version})` : '(unpublished draft)'}
        </h2>

        <ul id="my-shifts" className="mt-2">
          {!actorId ? (
            <li>Pick who you are to see your shifts.</li>
          ) : mine.length === 0 ? (
            <li>Nothing rostered for you this week.</li>
          ) : (
            mine
              .slice()
              .sort((a, b) => a.day - b.day)
              .map((assignment) => (
                <li key={`${assignment.day}:${assignment.shift}`} data-day={assignment.day}>
                  day {assignment.day} · {shiftById(model, assignment.shift)?.label ?? assignment.shift}
                </li>
              ))
          )}
        </ul>
      </section>

      <section aria-labelledby="ask-heading" className="mt-6">
        <h2 id="ask-heading" className="text-xs font-semibold uppercase tracking-wide">
          Ask about a shift
        </h2>

        <div className="mt-2 flex flex-wrap items-end gap-2">
          <p>
            <label htmlFor="pick-day" className="block">
              Day
            </label>
            <select
              id="pick-day"
              className="border px-2 py-1"
              value={day}
              onChange={(event) => setDay(Number(event.target.value))}
            >
              {Array.from({ length: model.horizon.days }, (_, index) => (
                <option key={index} value={index}>
                  day {index}
                </option>
              ))}
            </select>
          </p>

          <p>
            <label htmlFor="pick-shift" className="block">
              Shift
            </label>
            <select
              id="pick-shift"
              className="border px-2 py-1"
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

          <p className="grow">
            <label htmlFor="pick-note" className="block">
              Note for the manager (optional)
            </label>
            <input
              id="pick-note"
              type="text"
              className="w-full border px-2 py-1"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </p>
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className="border px-3 py-1"
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
            className="border px-3 py-1"
            disabled={!actorId || solving || busy !== null}
            onClick={() => dispatch('find-swap', findSwap, { day, shift })}
          >
            Who could take this shift?
          </button>

          <button
            type="button"
            className="border px-3 py-1"
            disabled={!actorId || solving || busy !== null}
            onClick={() =>
              dispatch('offer-swap', offerSwap, { day, shift, ...(note ? { note } : {}) })
            }
          >
            Offer this shift
          </button>
        </div>
      </section>

      <section aria-labelledby="swaps-heading" className="mt-6">
        <h2 id="swaps-heading" className="text-xs font-semibold uppercase tracking-wide">
          Open swaps ({openSwaps.length})
        </h2>

        <ul className="mt-2">
          {openSwaps.length === 0 ? (
            <li>Nobody has offered a shift.</li>
          ) : (
            openSwaps.map((swap) => (
              <li key={swap.id} data-swap={swap.id} className="border-b py-1">
                {swap.from} · day {swap.day}{' '}
                {shiftById(model, swap.shift)?.label ?? swap.shift}
                {swap.note ? ` — “${swap.note}”` : ''}{' '}
                <button
                  type="button"
                  className="border px-2"
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
          <button
            type="button"
            className="mt-2 border px-3 py-1"
            disabled={busy !== null}
            onClick={() => dispatch('list-swaps', listSwaps, {})}
          >
            Read the swap board as an agent would
          </button>
        ) : null}
      </section>

      <section aria-labelledby="staff-output-heading" className="mt-6">
        <h2 id="staff-output-heading" className="text-xs font-semibold uppercase tracking-wide">
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

      <p className="mt-6">
        {staffById(model, actorId ?? '')
          ? 'Your name, notes and pay rate stay in this tab. An agent driving this page sees ids, skills and counts only.'
          : ''}
      </p>
    </div>
  );
}
