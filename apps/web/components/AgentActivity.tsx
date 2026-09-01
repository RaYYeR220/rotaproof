'use client';

/**
 * What the agent is doing, as it happens.
 *
 * WebMCP has no imperative "a tool was called" event, so the fact that `execute` is running
 * is the only signal there is. The binding reports it and this strip renders it, which is
 * the difference between a page an agent drives and a page that appears to change by itself.
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
    <section aria-labelledby="activity-heading" className="mt-10 border-t pt-3">
      <h2 id="activity-heading" className="text-xs font-semibold uppercase tracking-wide">
        Agent activity
      </h2>

      <p id="site-tools-count" className="mt-1">
        {hydrated
          ? `${registered.total} tools registered — ${registered.read} read, ${registered.write} write`
          : 'Loading the week…'}
      </p>

      <ol
        id="agent-activity"
        aria-live="polite"
        aria-relevant="additions"
        className="mt-2 max-h-40 overflow-y-auto"
      >
        {activity.length === 0 ? (
          <li>No tool calls yet.</li>
        ) : (
          activity
            .slice()
            .reverse()
            .map((entry) => (
              <li key={entry.key} data-tool={entry.toolName} data-phase={entry.phase}>
                <span className="tabular-nums">{entry.at}</span> {entry.toolName}{' '}
                {PHASE_LABEL[entry.phase] ?? entry.phase}
                {entry.durationMs !== undefined ? ` in ${entry.durationMs}ms` : ''}
                {entry.message ? ` — ${entry.message}` : ''}
              </li>
            ))
        )}
      </ol>
    </section>
  );
}
