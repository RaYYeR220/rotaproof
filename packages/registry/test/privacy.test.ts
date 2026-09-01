/**
 * The privacy boundary, tested as a property rather than asserted as a policy.
 *
 * Every private field in the roster — names, absence reasons, time-off notes, pay rates
 * — is replaced with a unique random token. Then every tool an agent can reach is called,
 * many times, with both sensible and deliberately hostile arguments, and every byte that
 * comes back is searched for those tokens. One hit fails the build.
 *
 * A green run of this file is the evidence behind the claim that an agent driving this
 * page gets structure and never people. The negative control at the bottom is what makes
 * that evidence mean anything: it plants a leak on purpose and requires the detector to
 * catch it, so a pass can never be vacuous.
 */

import highsLoader from 'highs';
import { beforeAll, describe, expect, it } from 'vitest';

import { HighsBackend, type RosterModel, type SolverBackend, privateStrings, seedRoster } from '@rotaproof/core';

import { ALL_ACTIONS, createHeadlessSession } from '../src/index.js';

let backend: SolverBackend;

beforeAll(async () => {
  backend = await HighsBackend.create(highsLoader as never);
});

/** Deterministic pseudo-random source, so a failure can be reproduced exactly. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

let tokenCounter = 0;
function token(): string {
  tokenCounter += 1;
  // Distinctive enough that a substring search cannot collide with real output.
  return `ZQ${tokenCounter.toString(36).toUpperCase().padStart(4, 'X')}KTOKEN`;
}

/** The seeded week with every private field replaced by a traceable marker. */
function tokenisedRoster(): { model: RosterModel; tokens: string[] } {
  const model = seedRoster();
  const tokens: string[] = [];

  for (const person of model.staff) {
    person.name = token();
    tokens.push(person.name);
    person.notes = token();
    tokens.push(person.notes);
    // Pay rates are numeric, so they get an improbable value rather than a string.
    person.hourlyRate = 7654.321;
  }

  for (const constraint of model.constraints) {
    const withText = constraint as { reason?: string; note?: string };
    if ('reason' in withText && withText.reason !== undefined) {
      withText.reason = token();
      tokens.push(withText.reason);
    }
    if ('note' in withText && withText.note !== undefined) {
      withText.note = token();
      tokens.push(withText.note);
    }
  }

  return { model, tokens };
}

/**
 * Arguments to try for each tool: the shape it expects, plus nonsense, so error paths
 * are covered too. Error messages are the likeliest place for a leak, because they are
 * where a developer reaches for something human-readable.
 */
function argumentsFor(toolName: string, random: () => number): Record<string, unknown>[] {
  const day = Math.floor(random() * 7);
  const staff = `S${1 + Math.floor(random() * 10)}`;
  const shift = ['open', 'mid', 'close'][Math.floor(random() * 3)]!;

  const nonsense: Record<string, unknown>[] = [
    {},
    { staff: 'S999' },
    { day: 99 },
    { shift: 'brunch' },
    { id: 'C-nope' },
    { swapId: 'SW-nope' },
    { staff: null, day: 'tomorrow' },
  ];

  const sensible: Record<string, Record<string, unknown>[]> = {
    describe_roster: [{}],
    list_constraints: [{}, { group: 'availability' }, { kind: 'unavailable' }, { offset: 5, limit: 40 }],
    inspect_schedule: [{}, { day }, { staff }, { day, staff }],
    set_constraint: [
      { kind: 'coverage', label: 'extra cover', shift, min: 1, day },
      { kind: 'unavailable', label: 'away', staff, slots: [{ day, shift }] },
      { kind: 'time_off', label: 'holiday', staff, slots: [{ day, shift }], status: 'requested' },
      { kind: 'preference', label: 'prefers', staff, slots: [{ day, shift }], direction: 'avoid' },
      { kind: 'min_rest', label: 'rest', hours: 12 },
    ],
    relax_constraint: [{ id: 'C-rest-11' }, { id: 'C-unavail-S6-friday', to: 'removed' }],
    solve_roster: [{}, { timeLimitMs: 2000 }],
    explain_conflict: [{}],
    publish_roster: [{}, { note: 'weekly roster' }],
    my_shifts: [{}, { from: 0, to: 3 }],
    request_time_off: [{ slots: [{ day, shift }] }, { slots: [{ day, shift }], note: 'personal' }],
    find_swap: [{ day, shift }],
    offer_swap: [{ day, shift }, { day, shift, note: 'swap please' }],
    list_swaps: [{}],
    accept_swap: [{ swapId: 'SW-nope' }],
  };

  return [...(sensible[toolName] ?? [{}]), ...nonsense];
}

describe('no private data reaches an agent', () => {
  it.each(['manager', 'staff'] as const)(
    'holds across every %s tool, with sensible and hostile arguments',
    async (role) => {
      const { model, tokens } = tokenisedRoster();
      const random = makeRandom(role === 'manager' ? 20260903 : 90320262);

      const headless = createHeadlessSession(backend, {
        role,
        model,
        ...(role === 'staff' ? { actorId: 'S2' as const } : {}),
        // Approve everything, so the paths behind a confirmation are exercised too.
        onConfirm: () => true,
      });

      // Swap notes are private too, and they live in the session rather than the model.
      // Seeding one here is what makes the sweep cover `list_swaps`, which is precisely
      // where a note was once interpolated straight into a tool result.
      const swapNote = token();
      tokens.push(swapNote);
      headless.session.swaps.push({
        id: 'SW-seeded',
        from: 'S3',
        day: 5,
        shift: 'mid',
        status: 'open',
        note: swapNote,
        createdAt: new Date().toISOString(),
      });

      // Reach a solved state first, then an infeasible one, so state-gated tools such as
      // explain_conflict and publish_roster are actually reachable during the sweep.
      await headless.solve();

      const transcript: string[] = [];
      const toolNames = ALL_ACTIONS.filter((a) => !a.agentExempt && a.roles.includes(role)).map(
        (a) => a.id,
      );

      for (const pass of [0, 1]) {
        if (pass === 1) {
          // Force the week into conflict so the failure paths run too.
          await headless.call('set_constraint', {
            kind: 'time_off',
            label: 'S2 asked for Friday off',
            staff: 'S2',
            status: 'granted',
            slots: [
              { day: 4, shift: 'open' },
              { day: 4, shift: 'mid' },
              { day: 4, shift: 'close' },
            ],
          });
          await headless.solve();
        }

        for (const toolName of toolNames) {
          for (const args of argumentsFor(toolName, random)) {
            let output: unknown;
            try {
              output = await headless.call(toolName, args);
            } catch (error) {
              // A thrown error is still output an agent could see.
              output = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            }
            transcript.push(JSON.stringify(output ?? null));
          }
        }
      }

      expect(transcript.length).toBeGreaterThan(60);

      const haystack = transcript.join('\n');
      const leaked = tokens.filter((t) => haystack.includes(t));
      expect(leaked, 'these private values reached an agent-visible result').toEqual([]);
      expect(haystack).not.toContain('7654.321');
    },
    180_000,
  );

  it('lists every private field so nothing new escapes the sweep by being forgotten', () => {
    const { model, tokens } = tokenisedRoster();
    // `privateStrings` is what the test above trusts to know what to look for. If a new
    // private field is added to the model and not registered there, this catches it.
    const collected = privateStrings(model);
    for (const t of tokens) expect(collected).toContain(t);
  });

  it('accepts the private text that lives outside the model', () => {
    const { model } = tokenisedRoster();
    // Swap notes are written by colleagues and live in the session. They were missing from
    // an earlier version of this sweep, which is how a leak got through.
    expect(privateStrings(model, ['a swap note'])).toContain('a swap note');
  });
});

describe('negative control', () => {
  /**
   * A green privacy suite means nothing unless the detector can fail. This plants a real
   * name in a result and requires the same check to catch it.
   */
  it('catches a leak when one is deliberately introduced', async () => {
    const { model, tokens } = tokenisedRoster();
    const headless = createHeadlessSession(backend, { role: 'manager', model });

    const leaky = async () => ({
      staff: model.staff.map((s) => `${s.id} (${s.name})`), // the mistake, on purpose
    });

    const output = JSON.stringify(await leaky());
    const caught = tokens.filter((t) => output.includes(t));

    expect(caught.length).toBeGreaterThan(0);

    // And the real tool, called the same way, does not leak.
    const clean = JSON.stringify(await headless.call('describe_roster', {}));
    expect(tokens.filter((t) => clean.includes(t))).toEqual([]);
  }, 30_000);
});
