import { describe, expect, test } from 'bun:test';

import { CHANNELS } from '../src/config/channels.ts';
import { openDatabase } from '../src/db/schema.ts';
import { replaceProgrammes } from '../src/db/store.ts';
import { buildSnapshot, searchSnapshot } from '../src/server.ts';

import type { Database } from 'bun:sqlite';
import type { Programme } from '../src/lib/types.ts';

/**
 * A fresh in-memory database, seeded with hand-built fixtures.
 *
 * Real SQLite rather than a mock: `buildSnapshot` does the folding and the
 * chronological sort while flattening rows out of the database, and a mocked
 * store would just re-assert whatever this file already believes about that
 * process. The database is `:memory:` and built from scratch per call, so
 * nothing here touches the real `data/tvguide.db`.
 */
function seed(programmes: readonly Programme[]): Database {
  const db = openDatabase(':memory:');
  replaceProgrammes(db, programmes, 1);
  return db;
}

function sec(y: number, m: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, m - 1, d, h, mi, 0) / 1000;
}

function prog(channelSlug: string, day: string, startUtc: number, title: string): Programme {
  return { channelSlug, day, startUtc, stopUtc: startUtc + 1800, title, description: undefined };
}

const [CH1, CH2] = CHANNELS;
const SLUG_A = CH1!.slug;
const SLUG_B = CH2!.slug;

/** Well before every fixture, so "everything is upcoming" unless a test says otherwise. */
const DAWN = sec(2026, 8, 20, 0, 0);

const mixed = await buildSnapshot(
  seed([
    // Title carries ё; a visitor who types the plain 'е' form must find it.
    prog(SLUG_A, '2026-08-26', sec(2026, 8, 26, 7, 0), 'Ёлки'),
    // Title carries plain е; a visitor who types the ё form must still find it,
    // which only works because both sides fold through the same table.
    prog(SLUG_A, '2026-08-26', sec(2026, 8, 26, 9, 0), 'Полет нормальный'),
    // For the case-insensitivity check, independent of ё/е.
    prog(SLUG_B, '2026-08-26', sec(2026, 8, 26, 6, 0), 'Земля до начала времён'),
    // Three 'Новости' hits, inserted out of chronological order, over two days.
    prog(SLUG_A, '2026-08-26', sec(2026, 8, 26, 21, 0), 'Новости дня'),
    prog(SLUG_A, '2026-08-26', sec(2026, 8, 26, 6, 0), 'Новости спорта'),
    prog(SLUG_A, '2026-08-27', sec(2026, 8, 27, 4, 0), 'Новости утра'),
  ]),
);

describe('searchSnapshot', () => {
  test('folds ё in the title so a query typed with plain е still matches', () => {
    const hits = searchSnapshot(mixed.search, 'елки', DAWN);
    expect(hits).toEqual([{ d: '2026-08-26', s: sec(2026, 8, 26, 7, 0), c: SLUG_A, t: 'Ёлки' }]);
  });

  test('folds ё in the query so it still matches a title spelled with plain е', () => {
    const hits = searchSnapshot(mixed.search, 'полёт', DAWN);
    expect(hits).toEqual([{ d: '2026-08-26', s: sec(2026, 8, 26, 9, 0), c: SLUG_A, t: 'Полет нормальный' }]);
  });

  test('is case-insensitive', () => {
    const hits = searchSnapshot(mixed.search, 'ЗЕМЛЯ', DAWN);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.t).toBe('Земля до начала времён');
  });

  test('a query shorter than 2 characters returns nothing', () => {
    expect(searchSnapshot(mixed.search, 'н', DAWN)).toEqual([]);
    expect(searchSnapshot(mixed.search, '', DAWN)).toEqual([]);
  });

  test('a 2-character query is accepted', () => {
    // Pins the boundary itself, not just "short queries fail".
    expect(searchSnapshot(mixed.search, 'ел', DAWN)).toHaveLength(1);
  });

  test('results come back in chronological order, across days and regardless of insertion order', () => {
    const hits = searchSnapshot(mixed.search, 'новости', DAWN);
    expect(hits.map((hit) => hit.t)).toEqual(['Новости спорта', 'Новости дня', 'Новости утра']);
    expect(hits.map((hit) => hit.s)).toEqual([...hits.map((hit) => hit.s)].sort((a, b) => a - b));
  });

  test('a result that has already finished still comes back, after the upcoming ones', () => {
    // Nothing is dropped for being in the past — the store deliberately keeps
    // several days behind, and "when was that on?" is a real question.
    const hits = searchSnapshot(mixed.search, 'новости', sec(2026, 8, 26, 12, 0));
    expect(hits.map((hit) => hit.t)).toEqual(['Новости спорта', 'Новости дня', 'Новости утра']);
  });
});

// 61 matching programmes on one channel and one day, each with its own
// minute-spaced start so the primary key (channel_slug, start_utc) stays unique.
const base = sec(2026, 8, 26, 0, 0);
const many = await buildSnapshot(
  seed(Array.from({ length: 61 }, (_, index) => prog(SLUG_A, '2026-08-26', base + index * 60, `Финал ${index}`))),
);

describe('searchSnapshot cap', () => {
  test('caps the result count even when more titles match', () => {
    expect(searchSnapshot(many.search, 'финал', DAWN)).toHaveLength(60);
  });

  test('with everything still to come, the cap drops the furthest-off match', () => {
    const hits = searchSnapshot(many.search, 'финал', DAWN);
    expect(hits[0]?.t).toBe('Финал 0');
    expect(hits[59]?.t).toBe('Финал 59');
    expect(hits.some((hit) => hit.t === 'Финал 60')).toBe(false);
  });

  /**
   * The failure this guards against is the one that matters most in practice.
   *
   * The index spans eight days behind and six ahead, and a common word matches
   * hundreds of times. Filling the sixty slots from the start of the index —
   * which is what a plain `break` after sixty does — returns nothing but
   * programmes that finished days ago, so a search for «новости» could never
   * show tonight's.
   */
  test('mid-day, the cap keeps what is still to come and backfills with the most recent past', () => {
    const hits = searchSnapshot(many.search, 'финал', base + 30 * 60);
    expect(hits).toHaveLength(60);
    // «Финал 0» is the oldest and is the one dropped; «Финал 60», the furthest
    // in the future, survives — the opposite of index order.
    expect(hits[0]?.t).toBe('Финал 1');
    expect(hits[59]?.t).toBe('Финал 60');
    expect(hits.map((hit) => hit.s)).toEqual([...hits.map((hit) => hit.s)].sort((a, b) => a - b));
  });

  test('once every match is in the past, the most recent ones are kept', () => {
    const hits = searchSnapshot(many.search, 'финал', base + 10 * 86_400);
    expect(hits).toHaveLength(60);
    expect(hits[0]?.t).toBe('Финал 1');
    expect(hits[59]?.t).toBe('Финал 60');
  });
});
