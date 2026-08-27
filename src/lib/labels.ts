/**
 * Russian date wording, shared by the renderer and the client bundle.
 *
 * It lives in `lib/` rather than in `render/` for one reason: search results
 * are built in the browser from a JSON reply, and they show the same "ср 26
 * авг" the day tabs show. Two copies of a month table is exactly the kind of
 * duplication that drifts silently — one file spells "мая", the other "май",
 * and nothing fails.
 */

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** `26 авг` from `2026-08-26`. */
export function humanDay(day: string): string {
  const [, month, date] = day.split('-').map(Number);
  return `${date} ${MONTHS[month! - 1]}`;
}

/** `ср` from `2026-08-26`. */
export function weekday(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(year!, month! - 1, date!)).getUTCDay()] ?? '';
}

/** `ср 26 авг`, the form both the day tabs and the search results use. */
export function dayLabel(day: string): string {
  return `${weekday(day)} ${humanDay(day)}`;
}

/**
 * Russian plural agreement: 1 передача, 2 передачи, 5 передач.
 *
 * Needed because the programme count beside a channel name is a bare number on
 * screen, and a bare number is meaningless read aloud. The screen reader gets
 * the counted noun; the eye still gets the digits.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) {
    return many;
  }
  if (mod10 === 1) {
    return one;
  }
  return mod10 >= 2 && mod10 <= 4 ? few : many;
}
