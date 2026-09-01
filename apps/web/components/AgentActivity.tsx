'use client';

/**
 * What the agent is doing, as it happens.
 *
 * WebMCP has no imperative "a tool was called" event, so the fact that `execute` is running
 * is the only signal there is. The binding reports it and this strip renders it, which is
 * the difference between a page an agent drives and a page that appears to change by itself.
 *
 * Most recent first: the interesting call is always the one that just happened.
 */

import { useWebStore } from '@/lib/store';

const PHASE_LABEL: Record<string, string> = {
  start: 'running',
  end: 'done',
  error: 'failed',
};

export default function AgentActivity() {
  const activity = useWebStore((state) => state.activity);
  const registered = useWebStore((state) => state.registered);
  const hydrated = useWebStore((state) => state.hydrated);

  return (
    <section aria-labelledby="activity-heading" className="mod">
      <div className="mod-head">
        <h2 id="activity-heading">Agent activity</h2>
        <p className="mod-note">Most recent first.</p>
      </div>

      <p className="chip">
        <span className="live" aria-hidden="true" />
        <span id="site-tools-count" className="txt">
          {hydrated
            ? `${registered.total} tools registered — ${registered.read} read, ${registered.write} write`
            : 'Loading the week…'}
        </span>
      </p>

      <ol id="agent-activity" aria-live="polite" aria-relevant="additions" className="calls">
        {activity.length === 0 ? (
          <li className="empty-note">No tool calls yet.</li>
        ) : (
          activity
            .slice()
            .reverse()
            .map((entry) => (
              <li key={entry.key} className="call" data-tool={entry.toolName} data-phase={entry.phase}>
                <span className="nib" aria-hidden="true" />
                <span className="when">{entry.at}</span> {entry.toolName}{' '}
                <span className="verb">{PHASE_LABEL[entry.phase] ?? entry.phase}</span>
                {entry.durationMs !== undefined ? ` in ${entry.durationMs}ms` : ''}
                {entry.message ? ` — ${entry.message}` : ''}
              </li>
            ))
        )}
      </ol>
    </section>
  );
}
