import { describe, expect, test } from 'bun:test';

import {
  ALWAYS_SHOW_UP_TO,
  collapsedWindow,
  liveIndex,
  progressPercent,
  remainingLabel,
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

  test('a day that has not started yet anchors on prime time, not on midnight', () => {
    // The old behaviour was "the next programme to start", which on tomorrow's
    // page meant opening at 00:10. Nobody plans an evening from that.
    expect(windowAnchor(day, -3600, PRIME)).toBe(36);
  });

  test('a day that is over anchors on prime time too', () => {
    expect(windowAnchor(day, 100 * 3600, PRIME)).toBe(36);
  });

  test('the server and the client agree on any day that is not today', () => {
    // This is the property that keeps the page from rearranging itself a
    // moment after it appears: the renderer passes undefined, the browser
    // passes a real instant outside the day, and both must land on the same row.
    for (const now of [-86_400, -1, 48 * 1800, 10 * 86_400]) {
      expect(windowAnchor(day, now, PRIME)).toBe(windowAnchor(day, undefined, PRIME));
    }
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

  test('slides back rather than running short at the end of the day', () => {
    const spans = spansOf(10);
    // Anchored on the very last row, the window keeps its height by moving up.
    expect(collapsedWindow(spans, 9)).toEqual({ from: 7, to: 10 });
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
    expect(collapsedWindow(spans, -5)).toEqual({ from: 0, to: 3 });
    expect(collapsedWindow(spans, 99)).toEqual({ from: 7, to: 10 });
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
