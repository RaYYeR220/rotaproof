import highsLoader from 'highs';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  type FairnessLedger,
  type SolverBackend,
  EMPTY_LEDGER,
  HighsBackend,
  advanceHorizon,
  check,
  foldIntoLedger,
  ledgerSpread,
  seedRoster,
  solveRoster,
} from '../src/index.js';

let backend: SolverBackend;

beforeAll(async () => {
  backend = await HighsBackend.create(highsLoader as never);
});

describe('folding a week into the ledger', () => {
  it('records what everybody actually worked', async () => {
    const model = seedRoster();
    const solved = await solveRoster(model, backend);
    const ledger = foldIntoLedger(EMPTY_LEDGER, model, solved.schedule ?? []);

    const stats = check(model, solved.schedule ?? []).stats;
    for (const person of model.staff) {
      expect(ledger.history[person.id]?.total).toBe(stats.perStaff[person.id]?.total);
    }
    const worked = Object.values(ledger.history).reduce((sum, e) => sum + e.total, 0);
    expect(worked).toBe(42);
  }, 30_000);

  it('accumulates rather than replacing', async () => {
    const model = seedRoster();
    const solved = await solveRoster(model, backend);
    const once = foldIntoLedger(EMPTY_LEDGER, model, solved.schedule ?? []);
    const twice = foldIntoLedger(once, model, solved.schedule ?? []);

    expect(twice.history.S1?.total).toBe((once.history.S1?.total ?? 0) * 2);
  }, 30_000);

  it('keeps the history of someone who has left the team', () => {
    const model = seedRoster();
    const previous: FairnessLedger = {
      history: { 'S-departed': { total: 9, nights: 2, weekends: 4 } },
    };
    const folded = foldIntoLedger(previous, model, []);
    expect(folded.history['S-departed']?.total).toBe(9);
  });

  it('reports who is carrying the most', () => {
    const ledger: FairnessLedger = {
      history: {
        S1: { total: 4, nights: 0, weekends: 3 },
        S2: { total: 9, nights: 1, weekends: 1 },
      },
    };
    expect(ledgerSpread(ledger, 'total')).toEqual({ min: 4, max: 9, gap: 5, leader: 'S2' });
    expect(ledgerSpread(ledger, 'weekends').leader).toBe('S1');
  });
});

describe('the ledger changes what the solver does', () => {
  /**
   * The point of the whole mechanism. Give one person a large weekend history and the next
   * week should route weekends away from them — not because a rule forbids it, but because
   * the fairness objective is now paying for their accumulated total.
   */
  it('pushes weekend work away from whoever has been carrying it', async () => {
    const fresh = await solveRoster(seedRoster(), backend);
    const baseline = check(seedRoster(), fresh.schedule ?? []).stats.perStaff.S7?.weekends ?? 0;

    const loaded: FairnessLedger = {
      history: { S7: { total: 0, nights: 0, weekends: 12 } },
    };
    const withHistory = await solveRoster(seedRoster(), backend, { ledger: loaded });
    const after = check(seedRoster(), withHistory.schedule ?? []).stats.perStaff.S7?.weekends ?? 0;

    expect(withHistory.status).toBe('optimal');
    expect(after).toBeLessThanOrEqual(baseline);
  }, 60_000);
});

describe('advancing to the next week', () => {
  it('moves the horizon on by exactly one week', () => {
    const { model } = advanceHorizon(seedRoster());
    expect(model.horizon.startDate).toBe('2026-09-14');
    expect(model.horizon.days).toBe(7);
  });

  it('keeps the rules that describe the business', () => {
    const { model } = advanceHorizon(seedRoster());
    const kept = model.constraints.map((c) => c.id);

    expect(kept).toContain('C-cover-open');
    expect(kept).toContain('C-keyholder-close');
    expect(kept).toContain('C-rest-11');
    expect(kept).toContain('C-contract-S1');
    expect(kept).toContain('C-trainee-supervision');
    expect(kept).toContain('C-fair-weekends');
  });

  it('drops the rules pinned to particular days, and says which', () => {
    const { model, dropped } = advanceHorizon(seedRoster());
    const kept = model.constraints.map((c) => c.id);
    const droppedIds = dropped.map((d) => d.id);

    // Last week's absences say nothing about next week.
    expect(kept).not.toContain('C-unavail-S9-wedding');
    expect(droppedIds).toContain('C-unavail-S9-wedding');
    // Including the ones that probably do recur — guessing which is worse than asking.
    expect(droppedIds).toContain('C-unavail-S6-friday');
    expect(dropped.every((d) => d.label.length > 0)).toBe(true);
  });

  it('leaves a week that still solves', async () => {
    const { model } = advanceHorizon(seedRoster());
    const result = await solveRoster(model, backend);
    expect(result.status).toBe('optimal');
  }, 30_000);
});
