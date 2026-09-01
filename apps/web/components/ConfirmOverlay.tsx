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
 */

import { useEffect, useRef } from 'react';

import { useWebStore } from '@/lib/store';

export default function ConfirmOverlay() {
  const pending = useWebStore((state) => state.pendingConfirm);
  const answerConfirm = useWebStore((state) => state.answerConfirm);
  const cancelConfirm = useWebStore((state) => state.cancelConfirm);
  const approveRef = useRef<HTMLButtonElement>(null);

  const pendingId = pending?.id;

  useEffect(() => {
    if (!pendingId) return;
    approveRef.current?.focus();
  }, [pendingId]);

  useEffect(() => {
    if (!pendingId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') answerConfirm(pendingId, false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pendingId, answerConfirm]);

  if (!pending) return null;

  const { id, request, toolName } = pending;

  return (
    <div
      id="hitl-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hitl-title"
      className="fixed bottom-4 right-4 z-50 w-80 border bg-white p-4 shadow-lg dark:bg-black"
    >
      <p className="text-xs uppercase tracking-wide">
        {toolName ? `Waiting on you — ${toolName}` : 'Waiting on you'}
      </p>

      <h2 id="hitl-title" className="mt-1 font-semibold">
        {request.title}
      </h2>

      <p className="mt-1">{request.detail}</p>

      <ul id="hitl-changes" className="mt-2 list-disc pl-5">
        {request.changes.map((change) => (
          <li key={change}>{change}</li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          id="hitl-approve"
          ref={approveRef}
          type="button"
          className="border px-3 py-1"
          onClick={() => answerConfirm(id, true)}
        >
          {request.confirmLabel}
        </button>
        <button
          id="hitl-decline"
          type="button"
          className="border px-3 py-1"
          onClick={() => answerConfirm(id, false)}
        >
          Decline
        </button>
        <button
          id="hitl-cancel"
          type="button"
          className="border px-3 py-1"
          onClick={() => cancelConfirm(id)}
        >
          Cancel the call
        </button>
      </div>
    </div>
  );
}
