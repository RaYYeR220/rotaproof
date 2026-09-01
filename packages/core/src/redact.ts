/**
 * The trust boundary.
 *
 * Everything an agent receives from this page passes through here first. The rule is
 * simple and absolute: an agent gets *structure* — ids, roles, skills, counts, shapes —
 * and never *people*. Names, private notes, absence reasons and pay rates stay in the tab.
 *
 * This is not decoration. `privacy.test.ts` seeds a roster with unique random tokens in
 * every private field, drives every tool with random arguments, and fails the build if a
 * single token ever appears in a tool result.
 *
 * The 1450-character output ceiling matches the limit Chrome documents for tool output
 * (1.5K). Truncation is explicit and self-describing, so a model reading a trimmed result
 * knows it is trimmed and can ask for a narrower slice instead of assuming it saw
 * everything.
 */

import type { RosterModel, Staff, StaffId } from './model.js';

/** Chrome documents a 1.5K per-tool-output budget; we stay just under it. */
export const MAX_OUTPUT_CHARACTERS = 1450;

/** Fields that must never cross the boundary, by name. Enforced structurally below. */
export const PRIVATE_STAFF_FIELDS = ['name', 'notes', 'hourlyRate'] as const;

/** What an agent is allowed to know about a person. */
export interface PublicStaff {
  id: StaffId;
  skills: string[];
  employment: Staff['employment'];
  minShifts?: number;
  maxShifts?: number;
}

/**
 * Projects a person down to the agent-visible fields.
 *
 * Written as an explicit allow-list rather than a delete-list: adding a private field to
 * `Staff` later cannot silently leak, because it simply is not copied here.
 */
export function publicStaff(staff: Staff): PublicStaff {
  const out: PublicStaff = {
    id: staff.id,
    skills: [...staff.skills],
    employment: staff.employment,
  };
  if (staff.minShifts !== undefined) out.minShifts = staff.minShifts;
  if (staff.maxShifts !== undefined) out.maxShifts = staff.maxShifts;
  return out;
}

export function publicRoster(model: RosterModel): {
  horizon: RosterModel['horizon'];
  shiftTypes: RosterModel['shiftTypes'];
  skills: string[];
  staff: PublicStaff[];
} {
  return {
    horizon: model.horizon,
    shiftTypes: model.shiftTypes,
    skills: [...model.skills],
    staff: model.staff.map(publicStaff),
  };
}

/**
 * Constraints carry private text too — an absence `reason`, a time-off `note`. Strip
 * those and keep the mechanics, so an agent can reason about *that* a slot is blocked
 * without learning *why* someone is at a funeral.
 */
export function publicConstraint<T extends { id: string; label: string }>(
  constraint: T,
): Omit<T, 'reason' | 'note'> {
  const { ...rest } = constraint as T & { reason?: unknown; note?: unknown };
  delete (rest as { reason?: unknown }).reason;
  delete (rest as { note?: unknown }).note;
  return rest;
}

export interface TruncationInfo {
  truncated: true;
  shown: number;
  total: number;
  hint: string;
}

/**
 * Trims a list to fit the output budget and says so in a way a model can act on.
 *
 * Chrome's guidance is that a tool result should read as an answer, not a fragment.
 * A bare truncated array is ambiguous; `{ shown, total, hint }` tells the agent exactly
 * what it is missing and what to call instead.
 */
export function boundList<T>(
  items: T[],
  render: (item: T) => string,
  hint: string,
): { items: string[]; truncation?: TruncationInfo } {
  const rendered: string[] = [];
  let budget = MAX_OUTPUT_CHARACTERS;

  for (const item of items) {
    const line = render(item);
    if (line.length + 1 > budget) break;
    rendered.push(line);
    budget -= line.length + 1;
  }

  if (rendered.length === items.length) return { items: rendered };
  return {
    items: rendered,
    truncation: {
      truncated: true,
      shown: rendered.length,
      total: items.length,
      hint,
    },
  };
}

/**
 * Final gate applied to every tool result.
 *
 * Serialises, and if the payload still exceeds the budget after the tool did its own
 * bounding, replaces it with an honest overflow object rather than a silently clipped
 * JSON string. A clipped string would be unparseable; an overflow object is actionable.
 */
export function boundResult(value: unknown, hint: string): unknown {
  const serialized = JSON.stringify(value);
  if (serialized !== undefined && serialized.length <= MAX_OUTPUT_CHARACTERS) return value;
  return {
    error: 'result_too_large',
    message: `This result is ${serialized?.length ?? 0} characters, over the ${MAX_OUTPUT_CHARACTERS} character limit for a single tool output.`,
    hint,
  };
}

/**
 * Test-only helper: collects every private string in a model so the privacy property
 * test can assert none of them survive a round trip through a tool.
 */
export function privateStrings(model: RosterModel): string[] {
  const out: string[] = [];
  for (const staff of model.staff) {
    out.push(staff.name);
    if (staff.notes) out.push(staff.notes);
    if (staff.hourlyRate !== undefined) out.push(String(staff.hourlyRate));
  }
  for (const constraint of model.constraints) {
    const withText = constraint as { reason?: string; note?: string };
    if (withText.reason) out.push(withText.reason);
    if (withText.note) out.push(withText.note);
  }
  return out.filter((s) => s.length > 0);
}
