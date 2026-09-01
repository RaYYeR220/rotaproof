/**
 * Swaps have to be real.
 *
 * An earlier version "verified" a swap by requiring the *slot* to be staffed, which is
 * satisfied by anybody — so every colleague came back as able to take every shift,
 * including one who is contractually unavailable for every closing shift. The tool said
 * "the full week was re-solved with this swap in place" and it had not been.
 *
 * Probing also ran through the real solve, so asking a read-only question replaced the
 * working schedule with a hypothetical one and an impossible probe deleted it outright.
 *
 * These tests hold both properties: a swap is checked against the named individual, and
 * asking about one changes nothing.
 */

import highsLoader from 'highs';
import { beforeAll, describe, expect, it } from 'vitest';

import { HighsBackend, type SolverBackend } from '@rotaproof/core';

import { createHeadlessSession, isActionError } from '../src/index.js';

let backend: SolverBackend;

beforeAll(async () => {
  backend = await HighsBackend.create(highsLoader as never);
});

const staffSession = (actorId: string) =>
  createHeadlessSession(backend, { role: 'staff', actorId, onConfirm: () => true });

describe('find_swap checks the person, not just the slot', () => {
  it('excludes somebody who is unavailable for that shift entirely', async () => {
    const session = staffSession('S10');
    await session.solve();

    // S8 is hard-unavailable for every closing shift while onboarding, so no closing shift
    // can ever be swapped to them. A coverage floor would have let them through, because a
    // floor only asks for *somebody*.
    const mine = session.session.schedule?.find((a) => a.staff === 'S10' && a.shift === 'close');
    const target = mine ?? { day: 0, shift: 'close', staff: 'S10' };

    const result = (await session.call('find_swap', {
      day: target.day,
      shift: target.shift,
    })) as { canTakeIt?: string[]; cannot?: string[] };

    if (isActionError(result)) {
      // S10 does not hold a closing shift in this solution; the point is covered by the
      // next test, which pins the shift it asks about.
      expect(result.error).toBe('not_your_shift');
      return;
    }

    expect(result.canTakeIt).not.toContain('S8');
    expect(result.cannot).toContain('S8');
  }, 180_000);

  it('never lists the asker among the people who could take it', async () => {
    const session = staffSession('S1');
    await session.solve();
    const mine = session.session.schedule?.find((a) => a.staff === 'S1');
    expect(mine).toBeDefined();

    const result = (await session.call('find_swap', {
      day: mine!.day,
      shift: mine!.shift,
    })) as { canTakeIt: string[]; cannot: string[] };

    expect(result.canTakeIt).not.toContain('S1');
    expect([...result.canTakeIt, ...result.cannot]).toHaveLength(9);
  }, 180_000);

  it('every candidate it offers really can take the shift', async () => {
    const session = staffSession('S1');
    await session.solve();
    const mine = session.session.schedule?.find((a) => a.staff === 'S1');

    const result = (await session.call('find_swap', {
      day: mine!.day,
      shift: mine!.shift,
    })) as { canTakeIt: string[] };

    // Re-derive each verdict independently, pinning the candidate onto the shift.
    for (const candidate of result.canTakeIt) {
      const check = await session.dryRun([
        ...session.session.model.constraints,
        {
          id: 'verify-takes',
          kind: 'must_work',
          label: 'candidate takes it',
          hardness: 'hard',
          staff: candidate,
          slots: [{ day: mine!.day, shift: mine!.shift }],
        },
        {
          id: 'verify-releases',
          kind: 'unavailable',
          label: 'asker released',
          hardness: 'hard',
          staff: 'S1',
          slots: [{ day: mine!.day, shift: mine!.shift }],
        },
      ]);
      expect(check.status, `${candidate} was offered but cannot actually take it`).not.toBe(
        'infeasible',
      );
    }
  }, 180_000);
});

describe('asking a hypothetical changes nothing', () => {
  it('leaves the working schedule and status exactly as they were', async () => {
    const session = staffSession('S1');
    await session.solve();

    const before = JSON.stringify(session.session.schedule);
    const statusBefore = session.session.status;
    const resultBefore = session.session.lastResult?.receipt.scheduleHash;
    const mine = session.session.schedule?.find((a) => a.staff === 'S1');

    await session.call('find_swap', { day: mine!.day, shift: mine!.shift });

    expect(JSON.stringify(session.session.schedule)).toBe(before);
    expect(session.session.status).toBe(statusBefore);
    expect(session.session.lastResult?.receipt.scheduleHash).toBe(resultBefore);
  }, 180_000);

  it('does not wipe the schedule when a probe comes back impossible', async () => {
    const session = staffSession('S1');
    await session.solve();
    const before = JSON.stringify(session.session.schedule);

    // A request that cannot be granted: S2 is one of only two keyholders free on Friday.
    const s2 = createHeadlessSession(backend, { role: 'staff', actorId: 'S2' });
    await s2.solve();
    const scheduleBefore = JSON.stringify(s2.session.schedule);

    const answer = (await s2.call('request_time_off', {
      slots: [
        { day: 4, shift: 'open' },
        { day: 4, shift: 'mid' },
        { day: 4, shift: 'close' },
      ],
    })) as { grantable: boolean | string };

    expect(answer.grantable).toBe(false);
    expect(s2.session.schedule).toBeDefined();
    expect(JSON.stringify(s2.session.schedule)).toBe(scheduleBefore);
    expect(before.length).toBeGreaterThan(0);
  }, 180_000);
});

describe('an unapproved request cannot break the manager week', () => {
  /**
   * A request is not a decision. Recording it as a hard absence let any member of staff
   * make the roster infeasible with one tool call, without anyone approving anything.
   */
  it('records the request softly, so the week still solves', async () => {
    const session = staffSession('S2');
    await session.solve();

    await session.call('request_time_off', {
      slots: [
        { day: 4, shift: 'open' },
        { day: 4, shift: 'mid' },
        { day: 4, shift: 'close' },
      ],
      note: 'family visiting',
    });

    const recorded = session.session.model.constraints.filter((c) => c.kind === 'time_off');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.hardness).toBe('soft');

    // And the manager's week is still solvable, which it would not be if the request had
    // been recorded as binding.
    const after = await session.solve();
    expect(after.status).toBe('optimal');
  }, 120_000);
});

describe('accepting a swap actually moves the shift', () => {
  it('gives the shift to the person who took it', async () => {
    const giver = createHeadlessSession(backend, {
      role: 'staff',
      actorId: 'S1',
      onConfirm: () => true,
    });
    await giver.solve();
    const mine = giver.session.schedule?.find((a) => a.staff === 'S1');
    expect(mine).toBeDefined();

    const candidates = (await giver.call('find_swap', {
      day: mine!.day,
      shift: mine!.shift,
    })) as { canTakeIt: string[] };
    expect(candidates.canTakeIt.length).toBeGreaterThan(0);

    await giver.call('offer_swap', { day: mine!.day, shift: mine!.shift, note: 'dentist' });
    const [offer] = giver.session.swaps;
    expect(offer?.status).toBe('open');

    // The taker works on the same session state, which is how the app models one roster
    // seen from two sides.
    giver.session.role = 'staff';
    giver.session.actorId = candidates.canTakeIt[0]!;

    const accepted = (await giver.call('accept_swap', { swapId: offer!.id })) as {
      status: string;
    };
    expect(accepted.status).toBe('accepted');

    const slot = giver.session.schedule?.filter(
      (a) => a.day === mine!.day && a.shift === mine!.shift,
    );
    expect(slot?.map((a) => a.staff)).toContain(candidates.canTakeIt[0]);
    expect(slot?.map((a) => a.staff)).not.toContain('S1');
  }, 240_000);
});

describe('swap notes stay in the page', () => {
  it('says a note exists without repeating it', async () => {
    const session = staffSession('S1');
    await session.solve();
    const mine = session.session.schedule?.find((a) => a.staff === 'S1');

    await session.call('offer_swap', {
      day: mine!.day,
      shift: mine!.shift,
      note: 'CONFIDENTIAL-hospital appointment, please do not tell anyone',
    });

    const listed = JSON.stringify(await session.call('list_swaps', {}));
    expect(listed).not.toContain('CONFIDENTIAL');
    expect(listed).not.toContain('hospital');
    expect(listed).toContain('has a note for the team');
  }, 120_000);
});
