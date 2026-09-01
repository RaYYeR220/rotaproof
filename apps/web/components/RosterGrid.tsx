'use client';

import { type RosterModel, type Schedule, dateOf, staffById } from '@rotaproof/core';

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });

function clock(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * The week as a table.
 *
 * Names appear here and nowhere an agent can reach: the page is the manager's own screen,
 * and the redaction boundary sits at the tool result, not at the pixel.
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
    <table id="roster-grid" className="w-full border text-left">
      <caption className="py-2 text-left">
        Week of {model.horizon.startDate}
        {schedule ? '' : ' — not solved yet'}
      </caption>
      <thead>
        <tr>
          <th scope="col" className="border p-2">
            Day
          </th>
          {model.shiftTypes.map((shift) => (
            <th key={shift.id} scope="col" className="border p-2">
              {shift.label}
              <span className="block font-normal">
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
              <th scope="row" className="border p-2">
                {WEEKDAY.format(new Date(`${date}T00:00:00Z`))}
                <span className="block font-normal">
                  day {day} · {date}
                </span>
              </th>
              {model.shiftTypes.map((shift) => {
                const people = (byCell.get(`${day}:${shift.id}`) ?? []).sort();
                return (
                  <td key={shift.id} className="border p-2 align-top">
                    {people.length === 0 ? (
                      <span>—</span>
                    ) : (
                      <ul>
                        {people.map((id) => (
                          <li key={id}>
                            {id} · {staffById(model, id)?.name ?? 'unknown'}
                          </li>
                        ))}
                      </ul>
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
