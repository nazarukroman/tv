import { describe, expect, test } from 'bun:test';

import { dayLabel, humanDay, weekday } from '../src/lib/labels.ts';

describe('humanDay', () => {
  test('renders day and month without a leading zero on the date', () => {
    expect(humanDay('2026-08-05')).toBe('5 авг');
    expect(humanDay('2026-08-26')).toBe('26 авг');
  });

  test('uses the genitive month form, not the nominative', () => {
    // 'мая' (genitive), not 'май' (nominative) — a one-letter slip a native
    // speaker reads immediately as broken, and the table is the only place
    // that could introduce it.
    expect(humanDay('2026-05-01')).toBe('1 мая');
  });
});

describe('weekday', () => {
  // A real week, 2026-08-23 (Sunday) through 2026-08-29 (Saturday), checked
  // against the calendar rather than recomputed with Date.UTC the way the
  // function itself does it — an off-by-one in WEEKDAYS would agree with a
  // self-referential expectation and still be wrong.
  test.each([
    ['2026-08-23', 'вс'],
    ['2026-08-24', 'пн'],
    ['2026-08-25', 'вт'],
    ['2026-08-26', 'ср'],
    ['2026-08-27', 'чт'],
    ['2026-08-28', 'пт'],
    ['2026-08-29', 'сб'],
  ])('%s is %s', (day, expected) => {
    expect(weekday(day)).toBe(expected);
  });
});

describe('dayLabel', () => {
  test('combines weekday and human date', () => {
    expect(dayLabel('2026-08-26')).toBe('ср 26 авг');
  });
});
