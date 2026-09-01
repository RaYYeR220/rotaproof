'use client';

import { type RosterModel, type Schedule, dateOf, staffById } from '@rotaproof/core';

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });

function clock(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * The mark carried by the skill that a rule in this week actually turns on. Everything
 * else is a barista, which is the baseline rather than a qualification worth a badge.
 */
function marker(skills: readonly string[] | undefined): { glyph: string; said: string } {
  if (skills?.includes('keyholder')) return { glyph: 'K', said: ', keyholder' };
  if (skills?.includes('food_safety')) return { glyph: 'F', said: ', food-safety certificate' };
  return { glyph: '·', said: '' };
}

/**
 * The week as a table.
 *
 * Names appear here and nowhere an agent can reach: the page is the manager's own screen,
 * and the redaction boundary sits at the tool result, not at the pixel.
 *
 * A filled slot is a pad raised off the surface; an empty one is a hole in it. That is the
 * whole legend — you can see an unstaffed shift from across the room.
 */
export default function RosterGrid({
  model,
  schedule,
}: {
  model: RosterModel;
  schedule?: Schedule;
}) {
  const days = Array.from({ length: model.horizon.days }, (_, day) => day);

  const byCell = new Map<string, string[]>();
  for (const assignment of schedule ?? []) {
    const key = `${assignment.day}:${assignment.shift}`;
    const bucket = byCell.get(key);
    if (bucket) bucket.push(assignment.staff);
    else byCell.set(key, [assignment.staff]);
  }

  return (
    <table id="roster-grid" className="week">
      <caption>
        Week of {model.horizon.startDate}
        {schedule
          ? '. K marks a keyholder, F a food-safety certificate. An empty shift is sunk into the surface.'
          : ' — not solved yet'}
      </caption>
      <thead>
        <tr>
          <th scope="col">
            <span className="vh">Day</span>
          </th>
          {model.shiftTypes.map((shift) => (
            <th key={shift.id} scope="col">
              {shift.label}
              <span className="sub">
                {clock(shift.startMinutes)} · {shift.durationMinutes / 60}h
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {days.map((day) => {
          const date = dateOf(model.horizon, day);
          return (
            <tr key={day}>
              <th scope="row">
                <span className="pad">
                  <b>{WEEKDAY.format(new Date(`${date}T00:00:00Z`))}</b>
                  <i>
                    day {day} · {date}
                  </i>
                </span>
              </th>
              {model.shiftTypes.map((shift) => {
                const people = (byCell.get(`${day}:${shift.id}`) ?? []).sort();
                return (
                  <td key={shift.id}>
                    {people.length === 0 ? (
                      <span className="cell empty">
                        <span aria-hidden="true">—</span>
                        <span className="vh">Nobody rostered</span>
                      </span>
                    ) : (
                      <span className="cell">
                        {people.map((id) => {
                          const person = staffById(model, id);
                          const mark = marker(person?.skills);
                          return (
                            <span key={id} className="who">
                              <span className="badge" aria-hidden="true">
                                {mark.glyph}
                              </span>
                              <span className="sid">{id}</span>
                              {person?.name ?? 'unknown'}
                              {mark.said ? <span className="vh">{mark.said}</span> : null}
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
