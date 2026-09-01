'use client';

/**
 * The human in the loop.
 *
 * WebMCP has no confirmation API — user prompting is still an open question in the spec —
 * so this is ours: the action awaits a promise, this card goes up, and nothing happens
 * until a person clicks. The agent's tool call simply stays open in the meantime.
 *
 * Cancel is the third button because of a real gap in Chrome 151: when an agent abandons a
 * call, the agent side rejects with an AbortError and the page is never told. Without a way
 * to withdraw from this side, the card would sit here waiting for a click that has stopped
 * meaning anything.
 *
 * Visually it is the one thing that leaves the surface: a modal floating well off the
 * putty, over a blurred dim of the same putty. Everything else on the page is moulded into
 * the ground; this is the moment that is not.
 */

import { useEffect, useRef } from 'react';

import { useWebStore } from '@/lib/store';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export default function ConfirmOverlay() {
  const pending = useWebStore((state) => state.pendingConfirm);
  const answerConfirm = useWebStore((state) => state.answerConfirm);
  const cancelConfirm = useWebStore((state) => state.cancelConfirm);
  const approveRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  /** Whatever had focus when the card went up, so it can be handed back. */
  const returnTo = useRef<HTMLElement | null>(null);

  const pendingId = pending?.id;

  useEffect(() => {
    if (!pendingId) return;

    /*
     * Capture the opener, but never the body. A button that opens this card disables
     * itself for the duration of its own call, and disabling the focused element drops
     * focus to the body before this effect ever runs — so `document.activeElement` is
     * often already gone. Remembering the body would mean "return focus to nowhere".
     */
    const opener = document.activeElement;
    returnTo.current =
      opener && opener !== document.body && opener !== document.documentElement
        ? (opener as HTMLElement)
        : null;

    approveRef.current?.focus();

    return () => {
      const target = returnTo.current;
      returnTo.current = null;

      /* Focus must land somewhere real; the top of the main region is the honest floor. */
      const fallback = () => document.getElementById('main')?.focus();
      if (!target) return fallback();

      /*
       * The opener may still be mid-action when the card closes, and focusing a disabled
       * control silently drops focus onto the body — the exact thing returning focus is
       * meant to prevent. Wait for it to come back before handing over.
       */
      let frames = 0;
      const hand = () => {
        if (!target.isConnected) return fallback();
        if (!(target as HTMLButtonElement).disabled) return void target.focus();
        if (frames++ < 60) requestAnimationFrame(hand);
        else fallback();
      };
      hand();
    };
  }, [pendingId]);

  useEffect(() => {
    if (!pendingId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        answerConfirm(pendingId, false);
        return;
      }

      // A modal that a Tab can walk out of is not a modal.
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;

      const stops = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (stops.length === 0) return;

      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pendingId, answerConfirm]);

  if (!pending) return null;

  const { id, request, toolName } = pending;

  return (
    <>
      <div className="backdrop" aria-hidden="true" />

      <div
        id="hitl-card"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hitl-title"
        aria-describedby="hitl-detail"
        className="dialog"
      >
        <p className="dialog-kicker">
          <span>Waiting on you</span>
          {toolName ? <span className="tool">{toolName}</span> : null}
        </p>

        <h2 id="hitl-title">{request.title}</h2>

        <p id="hitl-detail" className="sub">
          {request.detail}
        </p>

        <ul id="hitl-changes" className="changes">
          {request.changes.map((change) => (
            <li key={change}>
              <span className="nub" aria-hidden="true" />
              <span>{change}</span>
            </li>
          ))}
        </ul>

        <div className="acts">
          <button
            id="hitl-approve"
            ref={approveRef}
            type="button"
            className="btn btn-primary"
            onClick={() => answerConfirm(id, true)}
          >
            {request.confirmLabel}
          </button>
          <button
            id="hitl-decline"
            type="button"
            className="btn btn-danger"
            onClick={() => answerConfirm(id, false)}
          >
            Decline
          </button>
          <button
            id="hitl-cancel"
            type="button"
            className="btn"
            onClick={() => cancelConfirm(id)}
          >
            Cancel the call
          </button>
        </div>

        <p className="tail">Nothing is written until you choose. Escape declines.</p>
      </div>
    </>
  );
}
