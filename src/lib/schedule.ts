/**
 * Reading a day's schedule against a clock.
 *
 * All of it is arithmetic over start and stop instants, with no reference to
 * the DOM or to the database. That matters because both ends of the program
 * use it: the renderer collapses each column when it builds the page, and the
 * client re-collapses it against the real time once the page is open. If those
 * two disagreed, the guide would visibly rearrange itself a moment after it
 * appeared — so they share this file rather than each having their own copy.
 */

export interface Span {
  readonly startUtc: number;
  readonly stopUtc: number;
}

/** How many rows a collapsed column shows. */
export const WINDOW_SIZE = 3;

/** Below this a column is not worth collapsing: three rows out of four buys nothing. */
export const ALWAYS_SHOW_UP_TO = WINDOW_SIZE + 1;

/** Index of the span covering `nowUtc`, or `-1`. Spans must be in start order. */
export function liveIndex(spans: readonly Span[], nowUtc: number): number {
  return spans.findIndex((span) => span.startUtc <= nowUtc && nowUtc < span.stopUtc);
}

/**
 * The row a collapsed column should be built around.
 *
 * Whatever is on air wins. Everything else — a day that has not started, a day
 * that is over, the gap between two programmes, and the server, which has no
 * clock at all because it renders one document for everybody — falls back to
 * the start of prime time. That is a better guess than the first row of the
 * day: nobody opens a TV guide to find out what was on at ten past midnight.
 *
 * `nowUtc` is `undefined` precisely when the caller does not know the time,
 * which is the renderer's situation and not an error.
 */
export function windowAnchor(spans: readonly Span[], nowUtc: number | undefined, primeFromUtc: number): number {
  if (spans.length === 0) {
    return 0;
  }
  const live = nowUtc === undefined ? -1 : liveIndex(spans, nowUtc);
  if (live !== -1) {
    return live;
  }
  const prime = spans.findIndex((span) => span.stopUtc > primeFromUtc);
  return prime === -1 ? spans.length - 1 : prime;
}

/**
 * The slice a collapsed column shows, or `undefined` when it should show all.
 *
 * Twenty channels at full length is a twenty-thousand-pixel document on a
 * phone, so a column nobody is reading is worth about three rows: the anchor,
 * and what follows it. Near the end of the day the window slides backwards
 * instead of running short, so it is always the same height.
 */
export function collapsedWindow(
  spans: readonly Span[],
  anchor: number,
  size: number = WINDOW_SIZE,
): { readonly from: number; readonly to: number } | undefined {
  if (spans.length <= size + 1) {
    return undefined;
  }
  const to = Math.min(spans.length, Math.max(0, anchor) + size);
  return { from: Math.max(0, to - size), to };
}

/** How far through a span `nowUtc` is, as a percentage clamped to 0…100. */
export function progressPercent(span: Span, nowUtc: number): number {
  const length = span.stopUtc - span.startUtc;
  if (length <= 0) {
    return 0;
  }
  const done = ((nowUtc - span.startUtc) / length) * 100;
  return Math.min(100, Math.max(0, Math.round(done)));
}

/** `ещё 25 мин`, `ещё 1 ч 5 мин`. Rounded up, so it never reads as finished. */
export function remainingLabel(span: Span, nowUtc: number): string {
  const minutes = Math.max(0, Math.ceil((span.stopUtc - nowUtc) / 60));
  if (minutes < 60) {
    return `ещё ${minutes} мин`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `ещё ${hours} ч` : `ещё ${hours} ч ${rest} мин`;
}
