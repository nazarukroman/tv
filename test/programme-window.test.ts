import { describe, expect, test } from 'bun:test';

import {
  ALWAYS_SHOW_UP_TO,
  collapsedWindow,
  extendedWindow,
  liveIndex,
  progressPercent,
  remainingLabel,
  TAIL_SIZE,
  windowAnchor,
  WINDOW_SIZE,
} from '../src/lib/schedule.ts';

import type { Span } from '../src/lib/schedule.ts';

/** `count` half-hour spans back to back, starting at `startAt`. */
function spansOf(count: number, startAt = 0, length = 1800): Span[] {
  return Array.from({ length: count }, (_, index) => ({
    startUtc: startAt + index * length,
    stopUtc: startAt + (index + 1) * length,
  }));
}

/** What a caller actually does: pick the anchor, then slice around it. */
function windowAt(spans: readonly Span[], now: number | undefined, primeFrom: number) {
  return collapsedWindow(spans, windowAnchor(spans, now, primeFrom));
}

describe('liveIndex', () => {
  test('finds the span that covers the instant', () => {
    const spans = spansOf(5);
    expect(liveIndex(spans, 1800)).toBe(1);
    expect(liveIndex(spans, 900)).toBe(0);
  });

  test('the start boundary belongs to the span starting there, not the one before', () => {
    const spans = spansOf(3); // boundaries at 0, 1800, 3600, 5400
    expect(liveIndex(spans, 1800)).toBe(1);
    expect(liveIndex(spans, 1799)).toBe(0);
  });

  test('returns -1 in a gap between spans', () => {
    const spans: Span[] = [
      { startUtc: 0, stopUtc: 100 },
      { startUtc: 200, stopUtc: 300 },
    ];
    expect(liveIndex(spans, 150)).toBe(-1);
  });

  test('returns -1 before the first span, and at or after the last stop', () => {
    const spans = spansOf(3);
    expect(liveIndex(spans, -1)).toBe(-1);
    expect(liveIndex(spans, 5400)).toBe(-1); // stop of the last span is exclusive
  });
});

describe('windowAnchor', () => {
  const PRIME = 18 * 3600;
  /** A full day of half-hour programmes, so index 36 is the one starting at 18:00. */
  const day = spansOf(48);

  test('whatever is on air wins over prime time', () => {
    expect(windowAnchor(day, 9 * 3600, PRIME)).toBe(18);
  });

  test('no clock at all falls back to prime time', () => {
    // This is the renderer's case, and it is not an error: one document is
    // cached for everybody, so it genuinely does not know the time.
    expect(windowAnchor(day, undefined, PRIME)).toBe(36);
  });

  test('a gap in the schedule anchors on what is about to start', () => {
    const spans: Span[] = [
      { startUtc: 0, stopUtc: 100 },
      { startUtc: 200, stopUtc: 300 },
    ];
    expect(windowAnchor(spans, 150, PRIME)).toBe(1);
  });

  test('a schedule the clock is past entirely anchors on the last row', () => {
    // Production never asks this — the client passes a clock only while the day
    // on screen is today — but the answer has to be inside the array.
    expect(windowAnchor(day, 100 * 3600, PRIME)).toBe(47);
  });

  test('the renderer and the client agree on any day that is not today', () => {
    // This is the property that keeps the page from rearranging itself a moment
    // after it appears, and it holds by construction: the client passes a clock
    // only for today (`today ? now : undefined`), so on every other day both
    // callers make this exact call.
    expect(windowAnchor(day, undefined, PRIME)).toBe(36);
  });

  test('once the day has run out, the anchor is the next day’s first row', () => {
    // The whole point of carrying the next day's rows: at 23:50 the evening is
    // over, and what the column should be built around is what comes after
    // midnight — not the afternoon, which is where the old prime-time fallback
    // sent it.
    const evening = spansOf(4, 20 * 3600); // 20:00 through 22:00
    const tomorrow = spansOf(3, 24 * 3600 + 600); // 00:10 onwards
    const spans = [...evening, ...tomorrow];

    expect(windowAnchor(spans, 23 * 3600, PRIME)).toBe(4);
  });

  test('a day whose programmes all end before prime time anchors on the last row', () => {
    const short = spansOf(4); // 00:00-02:00, nothing anywhere near 18:00
    expect(windowAnchor(short, undefined, PRIME)).toBe(3);
  });

  test('an empty column does not produce a negative index', () => {
    expect(windowAnchor([], undefined, PRIME)).toBe(0);
  });
});

describe('collapsedWindow', () => {
  const PRIME = 18 * 3600;

  test('shows everything when the column is at most one row longer than the window', () => {
    // Collapsing 4 rows to 3 buys nothing and costs a button, so the cut-off
    // is deliberately one row above the window size.
    expect(collapsedWindow(spansOf(ALWAYS_SHOW_UP_TO), 0)).toBeUndefined();
    expect(collapsedWindow(spansOf(ALWAYS_SHOW_UP_TO + 1), 0)).toBeDefined();
  });

  test('the window always contains what is on air, swept across a whole day', () => {
    const spans = spansOf(10); // contiguous, so every instant below is live somewhere
    for (let now = 0; now < 18_000; now += 300) {
      const live = liveIndex(spans, now);
      expect(live).not.toBe(-1);
      const window = windowAt(spans, now, PRIME)!;
      expect(window.from).toBeLessThanOrEqual(live);
      expect(live).toBeLessThan(window.to);
    }
  });

  test('slides back rather than running short at the end of everything', () => {
    const spans = spansOf(10);
    // Anchored on the very last row, the window keeps its height by moving up.
    expect(collapsedWindow(spans, 9)).toEqual({ from: 5, to: 10 });
  });

  test('crosses midnight instead of sliding back, because the next day is in the list', () => {
    // Sliding back is the last resort, not what happens every evening: the
    // column carries the next day's first rows, so at 23:50 there is still
    // something after the anchor and the five rows carry on past midnight
    // rather than backing up into an afternoon that has already been on.
    const evening = spansOf(4, 20 * 3600);
    const tomorrow = spansOf(TAIL_SIZE, 24 * 3600 + 600);
    const spans = [...evening, ...tomorrow];

    const anchor = windowAnchor(spans, 21 * 3600 + 1800, 18 * 3600); // 21:30, on air
    expect(collapsedWindow(spans, anchor)).toEqual({ from: 3, to: 8 });
  });

  test('never returns a slice outside the array, across many lengths and times', () => {
    for (let count = ALWAYS_SHOW_UP_TO + 1; count <= 30; count += 1) {
      const spans = spansOf(count);
      const dayEnd = count * 1800;
      for (let now = -3600; now <= dayEnd + 3600; now += 900) {
        const window = windowAt(spans, now, PRIME);
        if (window === undefined) {
          continue;
        }
        expect(window.from).toBeGreaterThanOrEqual(0);
        expect(window.to).toBeLessThanOrEqual(spans.length);
        expect(window.to - window.from).toBe(WINDOW_SIZE);
      }
    }
  });

  test('an anchor outside the array is clamped rather than trusted', () => {
    const spans = spansOf(10);
    expect(collapsedWindow(spans, -5)).toEqual({ from: 0, to: 5 });
    expect(collapsedWindow(spans, 99)).toEqual({ from: 5, to: 10 });
  });
});

describe('extendedWindow', () => {
  test('grows forwards, leaving the top of the window where it was', () => {
    const spans = spansOf(20);
    expect(extendedWindow(spans, 4, 0)).toEqual({ from: 4, to: 9 });
    expect(extendedWindow(spans, 4, WINDOW_SIZE)).toEqual({ from: 4, to: 14 });
    expect(extendedWindow(spans, 4, WINDOW_SIZE * 2)).toEqual({ from: 4, to: 19 });
  });

  test('never uncovers a row above the window, least of all at the end of the day', () => {
    // The bug this pins down: growing the base window by handing it a larger
    // size took `to` to the end of the day and then computed `from = to - size`,
    // so "show me more" answered by revealing the afternoon that had already
    // been on — with nothing new below at all. On a column whose window already
    // sits at the end, more of it is simply nothing.
    const spans = spansOf(10);
    const base = collapsedWindow(spans, 9)!;
    for (const extra of [WINDOW_SIZE, WINDOW_SIZE * 3, 100]) {
      const grown = extendedWindow(spans, 9, extra)!;
      expect(grown.from).toBe(base.from);
      expect(grown.to).toBe(spans.length);
    }
  });

  test('stops at the last row rather than running past the array', () => {
    const spans = spansOf(12);
    expect(extendedWindow(spans, 0, 100)).toEqual({ from: 0, to: 12 });
  });

  test('has nothing to grow on a column that was never folded', () => {
    // The button is not rendered at all in that case, and the client asks
    // anyway on every tick — so this has to answer the same "show everything"
    // the base window does rather than inventing a slice.
    expect(extendedWindow(spansOf(ALWAYS_SHOW_UP_TO), 0, WINDOW_SIZE)).toBeUndefined();
  });
});

describe('progressPercent', () => {
  test('clamps to 0 before the span starts and 100 after it ends', () => {
    const span: Span = { startUtc: 1000, stopUtc: 2000 };
    expect(progressPercent(span, 500)).toBe(0);
    expect(progressPercent(span, 2500)).toBe(100);
  });

  test('reports the fraction elapsed in between', () => {
    expect(progressPercent({ startUtc: 0, stopUtc: 100 }, 25)).toBe(25);
  });

  test('a zero-length span does not divide by zero', () => {
    expect(progressPercent({ startUtc: 1000, stopUtc: 1000 }, 1000)).toBe(0);
  });
});

describe('remainingLabel', () => {
  const HOUR: Span = { startUtc: 0, stopUtc: 3600 };

  test('minutes only, under an hour', () => {
    expect(remainingLabel(HOUR, 3600 - 25 * 60)).toBe('ещё 25 мин');
  });

  test('a whole hour with no remainder', () => {
    expect(remainingLabel(HOUR, 0)).toBe('ещё 1 ч');
  });

  test('hours and minutes together', () => {
    // stop - now = 3900s = 65 minutes.
    expect(remainingLabel(HOUR, -300)).toBe('ещё 1 ч 5 мин');
  });

  test('clamps to zero once the span is over, rather than going negative', () => {
    expect(remainingLabel(HOUR, 4000)).toBe('ещё 0 мин');
  });
});
