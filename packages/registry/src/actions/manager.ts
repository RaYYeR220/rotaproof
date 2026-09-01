/**
 * The manager surface.
 *
 * Orientation first, then reads, then the engine, then writes — the order tools are
 * registered in, because models pick earlier tools more often and that bias is worth
 * spending deliberately.
 *
 * Two of these carry long, manual-grade descriptions. `set_constraint` and `solve_roster`
 * are the only tools with real semantics behind them, and for those the description is
 * the entire documentation an agent will ever read. The rest stay terse.
 */

import {
  type Constraint,
  type RosterModel,
  type Slot,
  type PublicStaff,
  advanceHorizon,
  boundList,
  check,
  dateOf,
  foldIntoLedger,
  ledgerSpread,
  publicConstraint,
  publicRoster,
  shiftById,
} from '@rotaproof/core';

import {
  type ActionContext,
  type ActionResult,
  type RosterSession,
  actionError,
  defineAction,
} from '../types.js';
import { buildConstraint, requireConstraintId, requireDay, requireStaff } from '../validate.js';

const NEVER_SOLVED = 'Call solve_roster first; there is no schedule yet.';

/** `"06:00"` from minutes past midnight. */
function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** `"S1 full_time 4-5 [keyholder,barista]"` — one person on one short line. */
function staffLine(person: PublicStaff): string {
  const bounds =
    person.minShifts !== undefined || person.maxShifts !== undefined
      ? ` ${person.minShifts ?? 0}-${person.maxShifts ?? '∞'}`
      : '';
  return `${person.id} ${person.employment}${bounds} [${person.skills.join(',')}]`;
}

/**
 * One rule on one line, with its private text stripped first.
 *
 * A label is written to be read by people and is safe. A `reason` or a `note` is not:
 * "away Thursday" is scheduling, "away Thursday for chemotherapy" is not.
 */
function constraintLine(constraint: Constraint): string {
  const safe = publicConstraint(constraint);
  return `${safe.id} ${safe.hardness} ${safe.kind}: ${safe.label}`;
}

function slotName(model: RosterModel, slot: Slot): string {
  return `d${slot.day} ${shiftById(model, slot.shift)?.label ?? slot.shift}`;
}

// ---------------------------------------------------------------------------

export const describeRoster = defineAction<Record<string, never>, unknown>({
  id: 'describe_roster',
  title: 'Roster overview',
  order: 1,
  readOnly: true,
  roles: ['manager'],
  available: () => true,
  description:
    'Start here. Returns the shape of the roster being planned: the week, the shift types and their hours, the team as anonymous ids with their skills and contracted shift counts, and a summary of the rules in force. Staff are identified only by id — this page never sends names, notes or pay rates to an agent.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, { session }): Promise<ActionResult> {
    const { model } = session;
    const lastDay = dateOf(model.horizon, model.horizon.days - 1);
    const hard = model.constraints.filter((c) => c.hardness === 'hard').length;

    // Everything below is derived from the redacted projection rather than from the model
    // directly, so a private field added later cannot reach this result by being copied.
    const view = publicRoster(model);

    return {
      week: `${model.horizon.startDate} to ${lastDay} (${model.horizon.days} days, day 0 = ${model.horizon.startDate})`,
      shifts: view.shiftTypes.map(
        (s) => `${s.id} "${s.label}" ${clock(s.startMinutes)} +${s.durationMinutes / 60}h`,
      ),
      skills: view.skills,
      staff: view.staff.map(staffLine),
      rules: {
        total: model.constraints.length,
        hard,
        soft: model.constraints.length - hard,
        groups: [...new Set(model.constraints.map((c) => c.group ?? c.id))],
      },
      status: session.status,
      next:
        session.status === 'infeasible'
          ? 'The current rules cannot all hold. Call explain_conflict.'
          : session.schedule
            ? 'A schedule exists. Call inspect_schedule to read it.'
            : 'No schedule yet. Call solve_roster.',
    };
  },
});

export const listConstraints = defineAction<
  { group?: string; kind?: string; offset?: number; limit?: number },
  unknown
>({
  id: 'list_constraints',
  title: 'Rules in force',
  order: 2,
  readOnly: true,
  roles: ['manager'],
  available: () => true,
  description:
    'Lists the scheduling rules with their ids, so they can be referenced by set_constraint or relax_constraint. Filter by group or kind, and page with offset and limit. Ids are stable.',
  inputSchema: {
    type: 'object',
    properties: {
      group: { type: 'string', description: 'Only rules in this group, e.g. "coverage".' },
      kind: { type: 'string', description: 'Only rules of this kind, e.g. "min_rest".' },
      offset: { type: 'integer', minimum: 0, description: 'Skip this many rules.' },
      limit: { type: 'integer', minimum: 1, maximum: 40, description: 'Rules to return. Default 12.' },
    },
    additionalProperties: false,
  },
  async run(args, { session }): Promise<ActionResult> {
    const all = session.model.constraints.filter((c) => {
      if (args.group && (c.group ?? c.id) !== args.group) return false;
      if (args.kind && c.kind !== args.kind) return false;
      return true;
    });

    const offset = Math.max(0, args.offset ?? 0);
    const limit = Math.min(Math.max(1, args.limit ?? 12), 40);
    const page = all.slice(offset, offset + limit);

    // Trimmed to the output budget as well as to the requested page, and the result says
    // which happened, so a model that asked for forty and got nine knows why.
    const bounded = boundList(page, constraintLine, 'Filter by group or kind, or lower limit.');
    const shown = bounded.items.length;

    return {
      matched: all.length,
      offset,
      returned: shown,
      rules: bounded.items,
      ...(bounded.truncation ? { trimmed: bounded.truncation.hint } : {}),
      more:
        offset + shown < all.length
          ? `${all.length - offset - shown} more; call again with offset ${offset + shown}.`
          : undefined,
    };
  },
});

export const inspectSchedule = defineAction<{ day?: number; staff?: string }, unknown>({
  id: 'inspect_schedule',
  title: 'Read the schedule',
  order: 3,
  readOnly: true,
  roles: ['manager'],
  available: (session) => session.schedule !== undefined,
  description:
    'Reads the current schedule: who is on which shift, how the load is spread, and any rule the schedule breaks. Narrow with day or staff when the whole week does not fit.',
  inputSchema: {
    type: 'object',
    properties: {
      day: { type: 'integer', minimum: 0, description: 'Only this day index.' },
      staff: { type: 'string', description: 'Only this staff id.' },
    },
    additionalProperties: false,
  },
  async run(args, { session }): Promise<ActionResult> {
    const { model, schedule } = session;
    if (!schedule) return actionError('no_schedule', 'Nothing has been scheduled yet.', NEVER_SOLVED);

    if (args.day !== undefined) {
      const parsed = requireDay(model, args.day);
      if (!parsed.ok) return parsed.error;
    }
    if (args.staff !== undefined) {
      const parsed = requireStaff(model, args.staff);
      if (!parsed.ok) return parsed.error;
    }

    const filtered = schedule.filter(
      (a) =>
        (args.day === undefined || a.day === args.day) &&
        (args.staff === undefined || a.staff === args.staff),
    );

    const result = check(model, schedule);
    const grouped = new Map<string, string[]>();
    for (const a of filtered) {
      const key = slotName(model, a);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(a.staff);
      else grouped.set(key, [a.staff]);
    }

    return {
      scope: args.day !== undefined || args.staff ? 'filtered' : 'full week',
      assignments: [...grouped].map(([slot, people]) => `${slot}: ${people.sort().join(' ')}`),
      load: Object.entries(result.stats.perStaff)
        .filter(([id]) => !args.staff || id === args.staff)
        .map(([id, s]) => `${id} ${s.total} shifts (${s.nights}n ${s.weekends}we)`),
      breaks: result.hardViolations.map((v) => `${v.constraintId}: ${v.message}`),
      softCost: Number(result.softPenalty.toFixed(2)),
      valid: result.ok,
    };
  },
});

export const setConstraint = defineAction<Record<string, unknown>, unknown>({
  id: 'set_constraint',
  title: 'Add or change a rule',
  order: 4,
  readOnly: false,
  roles: ['manager'],
  available: (session) => !session.solving,
  description: [
    'Adds a scheduling rule, or replaces an existing one when you reuse its id. Rules are the only way the roster changes; assignments are never edited directly, they are derived by solve_roster.',
    '',
    'Every rule needs kind, label and hardness. A hard rule must hold or the roster is impossible; a soft rule is priced into the objective with weight (default 1) and can be traded off.',
    '',
    'Fields by kind:',
    'coverage — shift, min, optional max, optional skill, optional day (a day index, or omit for every day).',
    'max_shifts / min_shifts — staff (or omit for everyone), max / min.',
    'one_shift_per_day — staff (or omit for everyone).',
    'min_rest — hours, staff optional.',
    'max_consecutive_days — max, staff optional.',
    'unavailable / must_work — staff, slots as [{day, shift}]. One keeps a person off those slots, the other pins them onto them.',
    'time_off — staff, slots, and status: requested | granted | declined.',
    'pair / anti_pair — a, b (two staff ids).',
    'preference — staff, slots, direction: want | avoid. Always soft.',
    'fairness — dimension: total | nights | weekends. Always soft.',
    '',
    'Adding a hard rule can make the week impossible. That is not an error: solve_roster will return infeasible and name the smallest set of rules that cannot coexist.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Reuse an existing id to replace that rule; omit to create one.' },
      kind: {
        type: 'string',
        enum: [
          'coverage',
          'max_shifts',
          'min_shifts',
          'one_shift_per_day',
          'min_rest',
          'max_consecutive_days',
          'unavailable',
          'must_work',
          'time_off',
          'pair',
          'anti_pair',
          'preference',
          'fairness',
        ],
      },
      label: { type: 'string', description: 'How a manager would say this rule out loud.' },
      hardness: { type: 'string', enum: ['hard', 'soft'], description: 'Default hard.' },
      weight: { type: 'number', description: 'Objective weight for a soft rule. Default 1.' },
      staff: { type: 'string', description: 'A staff id, or omit to apply to everyone.' },
      a: { type: 'string' },
      b: { type: 'string' },
      day: { description: 'Day index, or omit for every day.' },
      shift: { type: 'string' },
      skill: { type: 'string' },
      min: { type: 'number' },
      max: { type: 'number' },
      hours: { type: 'number' },
      direction: { type: 'string', enum: ['want', 'avoid'] },
      dimension: { type: 'string', enum: ['total', 'nights', 'weekends'] },
      status: { type: 'string', enum: ['requested', 'granted', 'declined'] },
      slots: {
        type: 'array',
        items: {
          type: 'object',
          properties: { day: { type: 'integer' }, shift: { type: 'string' } },
          required: ['day', 'shift'],
        },
      },
    },
    required: ['kind', 'label'],
    additionalProperties: false,
  },
  async run(args, { session, update }): Promise<ActionResult> {
    const built = buildConstraint(session.model, args);
    if (!built.ok) return built.error;
    const constraint = built.value;

    const replaced = session.model.constraints.some((c) => c.id === constraint.id);
    // Counted inside the updater. Reading it afterwards is right against an immutable
    // store and off by one against a mutable one, and this registry supports both.
    let totalRules = 0;
    update((draft) => {
      draft.model.constraints = replaced
        ? draft.model.constraints.map((c) => (c.id === constraint.id ? constraint : c))
        : [...draft.model.constraints, constraint];
      totalRules = draft.model.constraints.length;
      // Any schedule that existed was solved against different rules.
      draft.status = 'draft';
      delete draft.lastResult;
    });

    return {
      [replaced ? 'replaced' : 'added']: constraint.id,
      rule: constraintLine(constraint),
      totalRules,
      next: 'The previous schedule no longer matches these rules. Call solve_roster.',
    };
  },
});

export const relaxConstraint = defineAction<{ id: string; to?: 'soft' | 'removed'; weight?: number }, unknown>({
  id: 'relax_constraint',
  title: 'Relax a rule',
  order: 5,
  readOnly: false,
  roles: ['manager'],
  available: (session) => !session.solving,
  description:
    'Softens a hard rule so it can be traded off, or removes it entirely. This is what resolves an infeasible week: explain_conflict names the rules that clash, and exactly one of them has to give.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The rule id, from list_constraints or explain_conflict.' },
      to: { type: 'string', enum: ['soft', 'removed'], description: 'Default "soft".' },
      weight: { type: 'number', description: 'Objective weight when softening. Default 5.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async run(args, { session, update }): Promise<ActionResult> {
    const found = requireConstraintId(session.model, args.id);
    if (!found.ok) return found.error;

    const target = session.model.constraints.find((c) => c.id === args.id)!;
    const mode = args.to ?? 'soft';

    if (mode === 'soft' && target.hardness === 'soft') {
      return actionError(
        'already_soft',
        `"${target.label}" is already a soft rule.`,
        'Pass to: "removed" to drop it, or lower its weight with set_constraint.',
      );
    }

    update((draft) => {
      draft.model.constraints =
        mode === 'removed'
          ? draft.model.constraints.filter((c) => c.id !== args.id)
          : draft.model.constraints.map((c) =>
              c.id === args.id ? ({ ...c, hardness: 'soft', weight: args.weight ?? 5 } as Constraint) : c,
            );
      draft.status = 'draft';
      delete draft.lastResult;
    });

    return {
      [mode === 'removed' ? 'removed' : 'softened']: target.id,
      was: constraintLine(target),
      next: 'Call solve_roster to see whether the week now works.',
    };
  },
});

export const solveRosterAction = defineAction<{ timeLimitMs?: number }, unknown>({
  id: 'solve_roster',
  title: 'Solve',
  order: 6,
  readOnly: false,
  roles: ['manager'],
  available: (session) => !session.solving,
  description: [
    'Runs the exact solver over the current rules and returns one of three answers.',
    '',
    'optimal — a schedule exists and no better one exists under these rules. The objective is the total soft-rule cost; lower is better. Read the schedule with inspect_schedule.',
    '',
    'infeasible — no schedule can satisfy the hard rules. Nothing is returned that looks like a schedule, because none exists. Call explain_conflict for the smallest set of rules that cannot coexist, then relax exactly one of them.',
    '',
    'timeout — the time limit was reached before optimality was proved. Any schedule returned is valid but may not be the best.',
    '',
    'The result is deterministic: the same rules always produce the same answer, and every run returns a receipt containing a hash of the model and of the schedule, so a result can be reproduced and checked later.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      timeLimitMs: {
        type: 'integer',
        minimum: 200,
        maximum: 30000,
        description: 'Solver time budget in milliseconds. Default 10000.',
      },
    },
    additionalProperties: false,
  },
  async run(args, context: ActionContext): Promise<ActionResult> {
    const options: { signal?: AbortSignal; timeLimitMs?: number } = {};
    if (context.signal) options.signal = context.signal;
    if (args.timeLimitMs) options.timeLimitMs = args.timeLimitMs;

    const result = await context.solve(options);

    if (result.status === 'infeasible') {
      return {
        status: 'infeasible',
        message: 'No schedule satisfies these rules. This is a proof, not a failure to find one.',
        conflict: result.conflict?.narrative,
        conflictingRules: result.conflict?.constraintIds,
        probes: result.conflict?.probes,
        receipt: result.receipt.modelHash.slice(0, 12),
        next: 'Call explain_conflict for what each rule costs, then relax_constraint on one of them.',
      };
    }

    if (result.status === 'error') {
      return actionError(
        'solver_error',
        result.message ?? 'The solver failed.',
        'Try a smaller time limit, or check that recently added rules reference staff and shifts that exist.',
      );
    }

    const stats = result.verification?.stats;
    return {
      status: result.status,
      objective: result.objective !== undefined ? Number(result.objective.toFixed(3)) : undefined,
      solvedInMs: Math.round(result.wallMs),
      assignments: result.schedule?.length ?? 0,
      spread: stats
        ? Object.entries(stats.perStaff)
            .map(([id, s]) => `${id}:${s.total}`)
            .join(' ')
        : undefined,
      softCost: result.verification ? Number(result.verification.softPenalty.toFixed(2)) : undefined,
      receipt: result.receipt.modelHash.slice(0, 12),
      next: 'Read it with inspect_schedule, then publish_roster when it looks right.',
    };
  },
});

export const explainConflictAction = defineAction<Record<string, never>, unknown>({
  id: 'explain_conflict',
  title: 'Why is this impossible?',
  order: 7,
  readOnly: true,
  roles: ['manager'],
  // Exists only while there is a conflict to explain. The tool list is the app's state.
  available: (session) => session.status === 'infeasible' && session.lastResult?.conflict !== undefined,
  description:
    'Returns the minimal set of rules that cannot all hold at once, and what relaxing each one would buy. Minimal is exact: drop any single rule from this set and the rest become satisfiable.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, { session }): Promise<ActionResult> {
    const conflict = session.lastResult?.conflict;
    if (!conflict) {
      return actionError(
        'no_conflict',
        'There is no conflict to explain — the roster is not currently infeasible.',
        'Call solve_roster first.',
      );
    }

    return {
      narrative: conflict.narrative,
      rules: conflict.constraintIds,
      groups: conflict.groups,
      // Each option says whether relaxing it *alone* fixes the real roster. Some rules are
      // load-bearing for the clash and still leave a second blocker behind, and sending a
      // manager to relax one of those wastes their afternoon.
      options: conflict.suggestions.map(
        (s) => `${s.constraintId} — ${s.effect}${s.sufficient ? '' : ' (not enough on its own)'}`,
      ),
      enoughOnItsOwn: conflict.suggestions.filter((s) => s.sufficient).map((s) => s.constraintId),
      foundIn: `${conflict.probes} solver probes, ${Math.round(conflict.wallMs)}ms`,
      ...(conflict.inconclusive > 0
        ? { caveat: `${conflict.inconclusive} probe(s) did not finish, so this list may be wider than necessary.` }
        : {}),
      next: 'Choosing which rule gives way is a judgement about people, not a scheduling problem. Ask the manager.',
    };
  },
});

export const publishRoster = defineAction<{ note?: string }, unknown>({
  id: 'publish_roster',
  title: 'Publish',
  order: 8,
  readOnly: false,
  roles: ['manager'],
  // Only offered once there is a valid schedule to publish.
  available: (session) =>
    session.schedule !== undefined &&
    session.status === 'solved' &&
    (session.lastResult?.verification?.ok ?? false),
  description:
    'Publishes the current schedule to the team. This is the one action that changes what people see, so it pauses for the manager to approve it in the page — the tool call stays open until they do, and returns declined if they say no.',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string', description: 'Optional note shown with the published roster.' } },
    additionalProperties: false,
  },
  async run(args, context: ActionContext): Promise<ActionResult> {
    const { session } = context;
    const schedule = session.schedule;
    const result = session.lastResult;
    if (!schedule || !result) {
      return actionError('nothing_to_publish', 'There is no solved schedule to publish.', NEVER_SOLVED);
    }

    const previous = session.versions.at(-1);
    const diff = diffSchedules(previous?.schedule ?? [], schedule);

    const approved = await context.confirm(
      {
        title: `Publish week of ${session.model.horizon.startDate}?`,
        detail: previous
          ? `This replaces version ${previous.version}, which the team can already see.`
          : 'This is the first published version of this week.',
        confirmLabel: 'Publish roster',
        changes: [
          `${schedule.length} shifts assigned`,
          `${diff.added} added, ${diff.removed} removed since the last published version`,
          `Objective ${result.objective?.toFixed(2) ?? 'n/a'}, solved in ${Math.round(result.wallMs)}ms`,
        ],
      },
      context.signal,
    );

    if (!approved) {
      return {
        status: 'declined',
        message: 'The manager declined. Nothing was published and the team sees no change.',
      };
    }

    // The rules can move while the card is on screen — an agent or a second tab can add a
    // constraint mid-confirmation. Publishing the pre-confirmation schedule then would
    // mark a roster "published" that no longer satisfies the model it claims to.
    const stillCurrent =
      context.session.lastResult?.receipt.modelHash === result.receipt.modelHash &&
      context.session.schedule === schedule;
    if (!stillCurrent) {
      return actionError(
        'roster_changed',
        'The rules changed while the confirmation was open, so nothing was published.',
        'Call solve_roster again and re-publish once you have looked at the new week.',
      );
    }

    const version = (previous?.version ?? 0) + 1;
    context.update((draft) => {
      draft.versions = [
        ...draft.versions,
        {
          version,
          schedule: [...schedule],
          receipt: result.receipt,
          publishedAt: new Date().toISOString(),
          added: diff.added,
          removed: diff.removed,
        },
      ];
      draft.status = 'published';
    });

    return {
      status: 'published',
      version,
      shifts: schedule.length,
      changed: `${diff.added} added, ${diff.removed} removed`,
      receipt: result.receipt.modelHash.slice(0, 12),
    };
  },
});

export const startNextWeek = defineAction<Record<string, never>, unknown>({
  id: 'start_next_week',
  title: 'Start next week',
  order: 9,
  readOnly: false,
  roles: ['manager'],
  // Only once this week has actually been published; rolling forward from a draft would
  // fold a roster nobody is working into everybody's history.
  available: (session) => session.versions.length > 0,
  description:
    'Moves on to the following week. What everybody worked is folded into the fairness history, so the next roster starts from those totals rather than from zero, and rules pinned to particular days are cleared and listed for you to re-add.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, { session, update }): Promise<ActionResult> {
    const published = session.versions.at(-1);
    if (!published) {
      return actionError(
        'nothing_published',
        'This week has not been published yet.',
        'Publish the roster first, then start the next week.',
      );
    }

    const ledger = foldIntoLedger(session.ledger, session.model, published.schedule);
    const { model, dropped } = advanceHorizon(session.model);
    const spread = ledgerSpread(ledger, 'weekends');

    update((draft) => {
      draft.ledger = ledger;
      draft.model = model;
      draft.status = 'draft';
      draft.swaps = [];
      delete draft.schedule;
      delete draft.lastResult;
    });

    return {
      week: model.horizon.startDate,
      carried: `${published.schedule.length} shifts folded into the fairness history`,
      weekendSpread: `${spread.min} to ${spread.max} across the team`,
      cleared: dropped.map((d) => `${d.id}: ${d.label}`),
      note: 'Absences and preferences were tied to last week and have been cleared. Re-add any that still apply — a rule that looks weekly, like somebody who never works Fridays, is indistinguishable from a one-off in the data.',
      next: 'Call solve_roster for the new week.',
    };
  },
});

/**
 * Editing a person's name, private notes or pay rate has no agent equivalent, and that
 * is the point rather than an omission: those fields are the reason this page keeps the
 * agent at arm's length. The parity test requires the reason to be stated, not implied.
 */
export const editStaffDetails = defineAction<never, never>({
  id: 'edit_staff_details',
  title: 'Edit personal details',
  order: 90,
  readOnly: false,
  roles: ['manager'],
  available: () => true,
  description: 'Human-only. Edits names, private notes and pay rates.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  agentExempt:
    'Names, private notes and pay rates are exactly the data this page keeps from agents. Exposing a tool that reads or writes them would undo the boundary the rest of the design exists to hold.',
  async run() {
    return actionError('human_only', 'This action is not available to agents.', 'A person edits these details in the page.');
  },
});

/**
 * Importing staff needs a file the browser will only hand over in response to a real
 * user gesture, so there is nothing an agent could pass.
 */
export const importStaffCsv = defineAction<never, never>({
  id: 'import_staff_csv',
  title: 'Import team from CSV',
  order: 91,
  readOnly: false,
  roles: ['manager'],
  available: () => true,
  description: 'Human-only. Loads a team from a CSV file on this device.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  agentExempt:
    'Requires a file picker, which browsers only open from a genuine user gesture. There is no argument an agent could supply.',
  async run() {
    return actionError('human_only', 'This action is not available to agents.', 'A person picks the file in the page.');
  },
});

export function diffSchedules(
  before: { day: number; shift: string; staff: string }[],
  after: { day: number; shift: string; staff: string }[],
): { added: number; removed: number } {
  const key = (a: { day: number; shift: string; staff: string }) => `${a.day}:${a.shift}:${a.staff}`;
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  let added = 0;
  let removed = 0;
  for (const k of afterKeys) if (!beforeKeys.has(k)) added++;
  for (const k of beforeKeys) if (!afterKeys.has(k)) removed++;
  return { added, removed };
}

export const MANAGER_ACTIONS = [
  describeRoster,
  listConstraints,
  inspectSchedule,
  setConstraint,
  relaxConstraint,
  solveRosterAction,
  explainConflictAction,
  publishRoster,
  startNextWeek,
  editStaffDetails,
  importStaffCsv,
];

export type { RosterSession };
