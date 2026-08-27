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

/** How many rows a collapsed column shows — always this many, never fewer. */
export const WINDOW_SIZE = 5;

/** Below this a column is not worth collapsing: five rows out of six buys nothing. */
export const ALWAYS_SHOW_UP_TO = WINDOW_SIZE + 1;

/**
 * How many of the *next* day's rows travel with every column.
 *
 * The day ends at midnight and the evening does not. At half past eleven the
 * rows worth reading are tomorrow's, and they are on another page — the one
 * moment nobody wants to navigate. So the column carries them, and they are
 * ordinary rows: the window runs into them when it reaches the end of the day,
 * which is what keeps it five rows tall at 23:50 instead of sliding backwards
 * into an evening that has already been on.
 *
 * Eight, and the number follows from that: five so the window can be filled
 * entirely from the next day once today has run out, three more so «Ещё» has
 * something to open past midnight. Beyond that the day tab for tomorrow is one
 * click away and is the honest answer. They cost bytes, not layout — the fold
 * keeps them out of the document's height until the window arrives.
 */
export const TAIL_SIZE = 8;

/** Index of the span covering `nowUtc`, or `-1`. Spans must be in start order. */
export function liveIndex(spans: readonly Span[], nowUtc: number): number {
  return spans.findIndex((span) => span.startUtc <= nowUtc && nowUtc < span.stopUtc);
}

/**
 * The row a collapsed column should be built around.
 *
 * One rule: the first row that has not finished by the reference instant. That
 * is the clock when the caller has one, and the start of prime time when it does
 * not — `nowUtc` is `undefined` precisely in the renderer, which serves one
 * document to everybody and genuinely does not know the time.
 *
 * The single rule covers every case that used to need its own. Something on
 * air: that row, because it has not finished. A gap between two programmes: the
 * one about to start. A page for another day: the start of the evening, which is
 * a better guess than ten past midnight — nobody opens a TV guide to find out
 * what was on then. And today's schedule exhausted: the next day's first row,
 * because those travel with the column now. Only when the reference instant is
 * past everything does it fall back to the last row.
 */
export function windowAnchor(spans: readonly Span[], nowUtc: number | undefined, primeFromUtc: number): number {
  if (spans.length === 0) {
    return 0;
  }
  const from = nowUtc ?? primeFromUtc;
  const next = spans.findIndex((span) => span.stopUtc > from);
  return next === -1 ? spans.length - 1 : next;
}

/**
 * The slice a collapsed column shows, or `undefined` when it should show all.
 *
 * Twenty channels at full length is a twenty-thousand-pixel document on a
 * phone, so a column nobody is reading is worth about five rows: the anchor,
 * and what follows it.
 *
 * It slides backwards rather than running short, so a column is always the same
 * height — but that is the last resort, not the usual answer at the end of the
 * day: the next day's rows are in `spans` too, so at 23:50 there is still
 * something after the anchor and the window keeps going forwards, across
 * midnight. Sliding back only happens when even those have run out.
 */
export function collapsedWindow(
  spans: readonly Span[],
  anchor: number,
): { readonly from: number; readonly to: number } | undefined {
  if (spans.length <= WINDOW_SIZE + 1) {
    return undefined;
  }
  const to = Math.min(spans.length, Math.max(0, anchor) + WINDOW_SIZE);
  return { from: Math.max(0, to - WINDOW_SIZE), to };
}

/**
 * The same window after «Ещё», which grows forwards and only forwards.
 *
 * The base window slides backwards near the end of the day, because a column
 * that kept its height reads better than one that runs short. Growing it must
 * not do the same thing, and that is not a detail: at half past nine the window
 * is already against the end of the evening, so a wider one computed the same
 * way would answer "show me more" by uncovering the afternoon that has already
 * been on — while the rows actually being asked for stayed hidden.
 *
 * So `from` is pinned where the base window put it and only `to` moves. When
 * `to` reaches the end there is nothing further to offer, and the button that
 * calls this has no reason to be on screen; the unfold checkbox is what shows
 * the earlier rows, and it says so.
 */
export function extendedWindow(
  spans: readonly Span[],
  anchor: number,
  extra: number,
): { readonly from: number; readonly to: number } | undefined {
  const base = collapsedWindow(spans, anchor);
  if (base === undefined || extra <= 0) {
    return base;
  }
  return { from: base.from, to: Math.min(spans.length, base.from + WINDOW_SIZE + extra) };
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
