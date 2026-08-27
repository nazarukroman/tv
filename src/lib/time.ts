/**
 * Moscow time, done by arithmetic rather than by a timezone library.
 *
 * This is safe here and nowhere near as fragile as it looks. Moscow has been a
 * fixed UTC+3 with no daylight saving since 2014, Saint Petersburg shares it,
 * and every timestamp in the feed already carries an explicit '+0300' offset.
 * Converting through UTC and back — or through `toLocaleString` with a timezone
 * — is the only way to introduce a bug in this file, so we do not.
 *
 * The one thing we must respect is that a feed timestamp may declare an offset
 * other than +0300 (the format allows it), so the offset is parsed, not assumed.
 */

const MSK_OFFSET_SECONDS = 3 * 3600;

/** `YYYYMMDDHHMMSS +HHMM` — the XMLTV timestamp format. */
const XMLTV_TIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?$/;

/**
 * Parses an XMLTV timestamp to unix seconds, honouring the offset it declares.
 * Returns undefined for anything malformed, so one bad row cannot abort a run.
 */
export function parseXmltvTime(raw: string): number | undefined {
  const match = XMLTV_TIME.exec(raw.trim());
  if (match === null) {
    return undefined;
  }

  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = match;
  const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (Number.isNaN(utcMs)) {
    return undefined;
  }

  // No offset in the string means the time is already UTC, per the XMLTV DTD.
  let offsetSeconds = 0;
  if (sign !== undefined && offsetHours !== undefined && offsetMinutes !== undefined) {
    offsetSeconds = (Number(offsetHours) * 3600 + Number(offsetMinutes) * 60) * (sign === '-' ? -1 : 1);
  }

  return Math.floor(utcMs / 1000) - offsetSeconds;
}

/**
 * The Moscow calendar day a programme belongs to, `YYYY-MM-DD`.
 *
 * Shifting the instant by the fixed offset and then reading UTC fields is the
 * whole conversion — no locale, no DST table.
 */
export function mskDay(unixSeconds: number): string {
  const shifted = new Date((unixSeconds + MSK_OFFSET_SECONDS) * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Moscow midnight that opens `day` (`YYYY-MM-DD`), as unix seconds. */
export function mskDayStartUtc(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year!, month! - 1, date!) / 1000 - MSK_OFFSET_SECONDS;
}

/** `HH:MM` in Moscow time, the only clock the guide ever shows. */
export function mskClock(unixSeconds: number): string {
  const shifted = new Date((unixSeconds + MSK_OFFSET_SECONDS) * 1000);
  const hours = String(shifted.getUTCHours()).padStart(2, '0');
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}
