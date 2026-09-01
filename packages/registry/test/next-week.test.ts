/**
 * Rolling on to the following week.
 *
 * This is what makes the fairness ledger load-bearing rather than decorative: publishing a
 * week and starting the next one folds what everybody worked into the history, so the new
 * roster begins from those totals instead of from zero.
 */

import highsLoader from 'highs';
import { beforeAll, describe, expect, it } from 'vitest';

import { HighsBackend, type SolverBackend } from '@rotaproof/core';

import { createHeadlessSession, isActionError } from '../src/index.js';

let backend: SolverBackend;

beforeAll(async () => {
  backend = await HighsBackend.create(highsLoader as never);
});

const manager = () =>
  createHeadlessSession(backend, { role: 'manager', onConfirm: () => true });

describe('start_next_week', () => {
  it('is not offered until something has been published', async () => {
    const session = manager();
    expect(session.availableTools().map((t) => t.id)).not.toContain('start_next_week');

    await session.call('solve_roster', {});
    expect(session.availableTools().map((t) => t.id)).not.toContain('start_next_week');

    await session.call('publish_roster', {});
    expect(session.availableTools().map((t) => t.id)).toContain('start_next_week');
  }, 60_000);

  it('refuses when nothing has been published, rather than inventing a history', async () => {
    const session = manager();
    const result = await session.call('start_next_week', {});
    expect(isActionError(result)).toBe(true);
    expect((result as { error: string }).error).toBe('nothing_published');
  }, 30_000);

  it('moves the week on and folds the published roster into the history', async () => {
    const session = manager();
    await session.call('solve_roster', {});
    await session.call('publish_roster', {});

    const worked = session.session.versions.at(-1)!.schedule.length;
    const result = (await session.call('start_next_week', {})) as {
      week: string;
      cleared: string[];
    };

    expect(result.week).toBe('2026-09-14');
    expect(session.session.model.horizon.startDate).toBe('2026-09-14');

    const carried = Object.values(session.session.ledger.history).reduce(
      (sum, entry) => sum + entry.total,
      0,
    );
    expect(carried).toBe(worked);
  }, 60_000);

  it('clears the rules that were pinned to last week and says which', async () => {
    const session = manager();
    await session.call('solve_roster', {});
    await session.call('publish_roster', {});

    const result = (await session.call('start_next_week', {})) as { cleared: string[] };
    const ids = session.session.model.constraints.map((c) => c.id);

    expect(result.cleared.join(' ')).toContain('C-unavail-S9-wedding');
    expect(ids).not.toContain('C-unavail-S9-wedding');
    // The rules that describe the business survive.
    expect(ids).toContain('C-keyholder-close');
    expect(ids).toContain('C-fair-weekends');
  }, 60_000);

  it('leaves a week that still solves, and starts it from a draft', async () => {
    const session = manager();
    await session.call('solve_roster', {});
    await session.call('publish_roster', {});
    await session.call('start_next_week', {});

    expect(session.session.status).toBe('draft');
    expect(session.session.schedule).toBeUndefined();

    const next = (await session.call('solve_roster', {})) as { status: string };
    expect(next.status).toBe('optimal');
  }, 90_000);

  it('carries the history far enough to change the second week', async () => {
    const session = manager();
    await session.call('solve_roster', {});
    await session.call('publish_roster', {});
    await session.call('start_next_week', {});

    // Whoever took the most weekends last week starts the new one already ahead, so the
    // fairness term has something to push against.
    const weekendLeader = Object.entries(session.session.ledger.history).sort(
      (a, b) => b[1].weekends - a[1].weekends,
    )[0];
    expect(weekendLeader?.[1].weekends).toBeGreaterThan(0);

    const solved = await session.solve();
    expect(solved.status).toBe('optimal');
    // The objective now includes the carried spread, so it is not the same number as a
    // first week solved from nothing.
    expect(solved.objective).toBeGreaterThan(0);
  }, 90_000);
});
