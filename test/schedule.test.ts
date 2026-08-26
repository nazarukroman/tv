import { describe, expect, test } from 'bun:test';

import { msUntilNextRefresh } from '../src/main.ts';

/** A UTC instant for the given Moscow wall clock on 2026-08-26. */
function msk(hour: number, minute = 0): number {
  return Date.UTC(2026, 7, 26, hour - 3, minute, 0);
}

const MINUTE = 60_000;

describe('msUntilNextRefresh', () => {
  test('waits for the morning slot when the day has not reached it', () => {
    expect(msUntilNextRefresh(msk(3, 0))).toBe(75 * MINUTE);
    expect(msUntilNextRefresh(msk(0, 0))).toBe((4 * 60 + 15) * MINUTE);
  });

  test('moves to the afternoon slot once the morning one has passed', () => {
    expect(msUntilNextRefresh(msk(5, 0))).toBe((9 * 60 + 15) * MINUTE);
    expect(msUntilNextRefresh(msk(14, 14))).toBe(1 * MINUTE);
  });

  test('wraps to tomorrow morning after the last slot', () => {
    // 15:00 -> 04:15 next day is 13h15m away. Getting this wrong by a day is
    // the classic failure, and it presents as a guide that simply stops
    // updating rather than as a crash.
    expect(msUntilNextRefresh(msk(15, 0))).toBe((13 * 60 + 15) * MINUTE);
    expect(msUntilNextRefresh(msk(23, 59))).toBe((4 * 60 + 16) * MINUTE);
  });

  test('never returns zero or a negative wait, even exactly on a slot', () => {
    // A zero wait would spin: setTimeout(0) fires, ingest 304s, and we are back
    // on the same instant. The boundary is strict for that reason.
    for (const at of [msk(4, 15), msk(14, 15), msk(0, 0), msk(12, 0)]) {
      expect(msUntilNextRefresh(at)).toBeGreaterThan(0);
    }
    expect(msUntilNextRefresh(msk(4, 15))).toBe(10 * 60 * MINUTE);
  });

  test('always lands on a slot, whatever the starting minute', () => {
    for (let minutes = 0; minutes < 24 * 60; minutes += 7) {
      const from = msk(0, 0) + minutes * MINUTE;
      const landing = new Date(from + msUntilNextRefresh(from) + 3 * 3600_000);
      expect(landing.getUTCMinutes()).toBe(15);
      expect([4, 14]).toContain(landing.getUTCHours());
    }
  });
});
