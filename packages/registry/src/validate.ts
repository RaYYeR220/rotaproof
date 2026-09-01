/**
 * Strict validation in code, loose validation in schema.
 *
 * The browser does not check tool arguments against `inputSchema` — the schema is a hint
 * for the model, not a gate. So every argument that reaches an action is validated here,
 * and every rejection comes back as a sentence plus the list of values that would have
 * worked. An agent that gets a shift id wrong should be able to fix it on the next call
 * without a human intervening.
 */

import {
  type Constraint,
  type ConstraintKind,
  type RosterModel,
  type Slot,
  CONSTRAINT_KINDS,
} from '@rotaproof/core';

import { type ActionError, actionError } from './types.js';

export type Validated<T> = { ok: true; value: T } | { ok: false; error: ActionError };

const ok = <T>(value: T): Validated<T> => ({ ok: true, value });
const fail = <T>(error: ActionError): Validated<T> => ({ ok: false, error });

function list(values: readonly string[], limit = 12): string {
  const shown = values.slice(0, limit);
  const suffix = values.length > limit ? `, … (${values.length} total)` : '';
  return shown.join(', ') + suffix;
}

export function requireStaff(model: RosterModel, value: unknown, field = 'staff'): Validated<string> {
  const ids = model.staff.map((s) => s.id);
  if (typeof value !== 'string') {
    return fail(
      actionError('invalid_argument', `"${field}" must be a staff id.`, `Valid staff ids: ${list(ids)}.`),
    );
  }
  if (!ids.includes(value)) {
    return fail(
      actionError('unknown_staff', `There is no staff member "${value}".`, `Valid staff ids: ${list(ids)}.`),
    );
  }
  return ok(value);
}

export function requireShift(model: RosterModel, value: unknown, field = 'shift'): Validated<string> {
  const ids = model.shiftTypes.map((s) => s.id);
  if (typeof value !== 'string' || !ids.includes(value)) {
    return fail(
      actionError(
        'unknown_shift',
        `"${field}" must be one of this roster's shift types; received ${JSON.stringify(value)}.`,
        `Valid shift ids: ${list(ids)}.`,
      ),
    );
  }
  return ok(value);
}

export function requireDay(model: RosterModel, value: unknown, field = 'day'): Validated<number> {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fail(
      actionError(
        'invalid_argument',
        `"${field}" must be a whole day index.`,
        `Days run 0 to ${model.horizon.days - 1}, where 0 is ${model.horizon.startDate}.`,
      ),
    );
  }
  if (value < 0 || value >= model.horizon.days) {
    return fail(
      actionError(
        'day_out_of_range',
        `Day ${value} is outside this roster.`,
        `Days run 0 to ${model.horizon.days - 1}, where 0 is ${model.horizon.startDate}.`,
      ),
    );
  }
  return ok(value);
}

export function requireSlots(model: RosterModel, value: unknown): Validated<Slot[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return fail(
      actionError(
        'invalid_argument',
        '"slots" must be a non-empty array of {day, shift}.',
        `For example [{"day": 4, "shift": "${model.shiftTypes[0]?.id ?? 'open'}"}].`,
      ),
    );
  }
  const out: Slot[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      return fail(
        actionError('invalid_argument', 'Each slot must be an object {day, shift}.', 'For example {"day": 4, "shift": "close"}.'),
      );
    }
    const { day, shift } = raw as { day?: unknown; shift?: unknown };
    const dayResult = requireDay(model, day);
    if (!dayResult.ok) return fail(dayResult.error);
    const shiftResult = requireShift(model, shift);
    if (!shiftResult.ok) return fail(shiftResult.error);
    out.push({ day: dayResult.value, shift: shiftResult.value });
  }
  return ok(out);
}

export function requireNumber(value: unknown, field: string, hint: string): Validated<number> {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(actionError('invalid_argument', `"${field}" must be a number.`, hint));
  }
  return ok(value);
}

export function requireConstraintId(model: RosterModel, value: unknown): Validated<string> {
  const ids = model.constraints.map((c) => c.id);
  if (typeof value !== 'string' || !ids.includes(value)) {
    return fail(
      actionError(
        'unknown_constraint',
        `There is no rule with id ${JSON.stringify(value)}.`,
        `Call list_constraints to see current ids. Currently: ${list(ids, 8)}.`,
      ),
    );
  }
  return ok(value);
}

/**
 * Turns a loosely-shaped tool argument object into a real `Constraint`.
 *
 * The schema advertised to agents is one flat object covering every rule kind, because a
 * discriminated union in JSON Schema is something models handle poorly. The cost of that
 * choice is paid here: each kind picks out and checks exactly the fields it needs, and
 * anything missing produces a hint naming the fields that kind requires.
 */
export function buildConstraint(model: RosterModel, raw: Record<string, unknown>): Validated<Constraint> {
  const kind = raw.kind;
  if (typeof kind !== 'string' || !CONSTRAINT_KINDS.includes(kind as ConstraintKind)) {
    return fail(
      actionError(
        'unknown_kind',
        `"kind" must be one of the supported rule kinds; received ${JSON.stringify(kind)}.`,
        `Supported kinds: ${list(CONSTRAINT_KINDS as readonly string[], 20)}.`,
      ),
    );
  }

  const label = typeof raw.label === 'string' && raw.label.trim().length > 0 ? raw.label.trim() : undefined;
  if (!label) {
    return fail(
      actionError(
        'invalid_argument',
        '"label" is required and is what a human will read in the roster.',
        'Write it the way a manager would say it out loud, for example "A keyholder must close".',
      ),
    );
  }

  const hardness = raw.hardness === 'soft' ? 'soft' : 'hard';
  const weight = typeof raw.weight === 'number' ? raw.weight : undefined;
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : freshId(model, kind as ConstraintKind);
  const group = typeof raw.group === 'string' ? raw.group : defaultGroup(kind as ConstraintKind);

  const base = { id, label, hardness, group } as const;
  const withWeight = weight === undefined ? base : { ...base, weight };

  switch (kind as ConstraintKind) {
    case 'coverage': {
      const shift = requireShift(model, raw.shift);
      if (!shift.ok) return fail(shift.error);
      const min = requireNumber(raw.min, 'min', 'How many people must be present, for example 2.');
      if (!min.ok) return fail(min.error);

      let day: number | '*' = '*';
      if (raw.day !== undefined && raw.day !== '*') {
        const parsed = requireDay(model, raw.day);
        if (!parsed.ok) return fail(parsed.error);
        day = parsed.value;
      }

      if (raw.skill !== undefined && !model.skills.includes(raw.skill as string)) {
        return fail(
          actionError(
            'unknown_skill',
            `There is no skill "${String(raw.skill)}".`,
            `Skills on this roster: ${list(model.skills)}.`,
          ),
        );
      }

      const constraint: Constraint = {
        ...withWeight,
        kind: 'coverage',
        day,
        shift: shift.value,
        min: min.value,
      };
      if (raw.skill !== undefined) (constraint as { skill?: string }).skill = raw.skill as string;
      if (typeof raw.max === 'number') (constraint as { max?: number }).max = raw.max;
      return ok(constraint);
    }

    case 'max_shifts':
    case 'min_shifts': {
      const staff = staffOrAll(model, raw.staff);
      if (!staff.ok) return fail(staff.error);
      const field = kind === 'max_shifts' ? 'max' : 'min';
      const bound = requireNumber(raw[field], field, `A shift count, for example 5.`);
      if (!bound.ok) return fail(bound.error);
      return ok(
        kind === 'max_shifts'
          ? { ...withWeight, kind: 'max_shifts', staff: staff.value, max: bound.value }
          : { ...withWeight, kind: 'min_shifts', staff: staff.value, min: bound.value },
      );
    }

    case 'one_shift_per_day': {
      const staff = staffOrAll(model, raw.staff);
      if (!staff.ok) return fail(staff.error);
      return ok({ ...withWeight, kind: 'one_shift_per_day', staff: staff.value });
    }

    case 'min_rest': {
      const staff = staffOrAll(model, raw.staff);
      if (!staff.ok) return fail(staff.error);
      const hours = requireNumber(raw.hours, 'hours', 'Hours of rest required between shifts, for example 11.');
      if (!hours.ok) return fail(hours.error);
      // A non-positive gap is not a weaker rule, it is a different one: the compiler would
      // still forbid overlapping shifts while the checker allowed them.
      if (hours.value <= 0) {
        return fail(
          actionError(
            'invalid_argument',
            `"hours" must be greater than zero; received ${hours.value}.`,
            'To allow back-to-back shifts, remove the rest rule with relax_constraint instead.',
          ),
        );
      }
      return ok({ ...withWeight, kind: 'min_rest', staff: staff.value, hours: hours.value });
    }

    case 'max_consecutive_days': {
      const staff = staffOrAll(model, raw.staff);
      if (!staff.ok) return fail(staff.error);
      const max = requireNumber(raw.max, 'max', 'Longest run of worked days allowed, for example 5.');
      if (!max.ok) return fail(max.error);
      return ok({ ...withWeight, kind: 'max_consecutive_days', staff: staff.value, max: max.value });
    }

    case 'unavailable':
    case 'must_work': {
      const staff = requireStaff(model, raw.staff);
      if (!staff.ok) return fail(staff.error);
      const slots = requireSlots(model, raw.slots);
      if (!slots.ok) return fail(slots.error);
      return ok({
        ...withWeight,
        kind: kind as 'unavailable' | 'must_work',
        staff: staff.value,
        slots: slots.value,
      });
    }

    case 'time_off': {
      const staff = requireStaff(model, raw.staff);
      if (!staff.ok) return fail(staff.error);
      const slots = requireSlots(model, raw.slots);
      if (!slots.ok) return fail(slots.error);
      const status =
        raw.status === 'granted' || raw.status === 'declined' || raw.status === 'requested'
          ? raw.status
          : 'requested';
      return ok({ ...withWeight, kind: 'time_off', staff: staff.value, slots: slots.value, status });
    }

    case 'anti_pair':
    case 'pair': {
      const a = requireStaff(model, raw.a, 'a');
      if (!a.ok) return fail(a.error);
      const b = requireStaff(model, raw.b, 'b');
      if (!b.ok) return fail(b.error);
      if (a.value === b.value) {
        return fail(
          actionError('invalid_argument', 'A pairing rule needs two different people.', 'Set "a" and "b" to different staff ids.'),
        );
      }
      return ok({ ...withWeight, kind: kind as 'pair' | 'anti_pair', a: a.value, b: b.value });
    }

    case 'preference': {
      const staff = requireStaff(model, raw.staff);
      if (!staff.ok) return fail(staff.error);
      const slots = requireSlots(model, raw.slots);
      if (!slots.ok) return fail(slots.error);
      const direction = raw.direction === 'want' ? 'want' : raw.direction === 'avoid' ? 'avoid' : undefined;
      if (!direction) {
        return fail(
          actionError(
            'invalid_argument',
            '"direction" must be "want" or "avoid".',
            'Use "want" when someone would like the shift, "avoid" when they would rather not.',
          ),
        );
      }
      return ok({ ...withWeight, hardness: 'soft', kind: 'preference', staff: staff.value, slots: slots.value, direction });
    }

    case 'fairness': {
      const dimension = raw.dimension;
      if (dimension !== 'total' && dimension !== 'nights' && dimension !== 'weekends') {
        return fail(
          actionError(
            'invalid_argument',
            '"dimension" must be "total", "nights" or "weekends".',
            'Use "weekends" to spread weekend work, "nights" for night shifts, "total" for overall load.',
          ),
        );
      }
      return ok({ ...withWeight, hardness: 'soft', kind: 'fairness', dimension });
    }
  }
}

function staffOrAll(model: RosterModel, value: unknown): Validated<string> {
  if (value === undefined || value === '*') return ok('*');
  return requireStaff(model, value);
}

function defaultGroup(kind: ConstraintKind): string {
  switch (kind) {
    case 'coverage':
      return 'coverage';
    case 'max_shifts':
    case 'min_shifts':
      return 'contracts';
    case 'one_shift_per_day':
    case 'min_rest':
    case 'max_consecutive_days':
      return 'working-time';
    case 'unavailable':
    case 'must_work':
      return 'availability';
    case 'time_off':
      return 'time-off';
    case 'pair':
    case 'anti_pair':
      return 'supervision';
    default:
      return kind;
  }
}

function freshId(model: RosterModel, kind: ConstraintKind): string {
  const prefix = `C-${kind.replace(/_/g, '-')}`;
  const taken = new Set(model.constraints.map((c) => c.id));
  for (let i = 1; ; i++) {
    const candidate = `${prefix}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
