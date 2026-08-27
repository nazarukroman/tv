import { describe, expect, test } from 'bun:test';

import { CHANNELS } from '../src/config/channels.ts';
import { openDatabase } from '../src/db/schema.ts';
import {
  countProgrammes,
  finishRun,
  horizonUtc,
  lastValidators,
  programmesForDay,
  provenance,
  pruneBefore,
  replaceProgrammes,
  SanityError,
  startRun,
} from '../src/db/store.ts';
import { mskDay, mskDayStartUtc } from '../src/lib/time.ts';

import type { Database } from 'bun:sqlite';
import type { Programme } from '../src/lib/types.ts';

const TNT = 'tnt';
const MATCH = 'matchtv';
const DAY = '2026-08-26';
const NEXT = '2026-08-27';

/**
 * A real database, in memory.
 *
 * The write path's whole job is a transaction boundary, and a mocked one proves
 * nothing about it — what is being tested is which rows SQLite is left holding.
 */
function fresh(): Database {
  return openDatabase(':memory:');
}

function prog(channelSlug: string, startUtc: number, minutes: number, title: string): Programme {
  return {
    channelSlug,
    startUtc,
    stopUtc: startUtc + minutes * 60,
    day: mskDay(startUtc),
    title,
    description: undefined,
  };
}

/** A batch large enough to clear any sanity floor a test is not about. */
function padded(programmes: readonly Programme[], to: number): Programme[] {
  const filler = Array.from({ length: Math.max(0, to - programmes.length) }, (_, index) =>
    prog('muztv', mskDayStartUtc(DAY) + index * 600, 10, `Заполнитель ${index}`),
  );
  return [...programmes, ...filler];
}

describe('replaceProgrammes', () => {
  test('refuses a batch below the floor without touching what is stored', () => {
    // A transfer cut short arrives as a valid, short document. Committing it
    // would replace a healthy guide with a fragment of one.
    const db = fresh();
    const good = padded([], 50);
    replaceProgrammes(db, good, 10);
    expect(countProgrammes(db)).toBe(50);

    expect(() => replaceProgrammes(db, good.slice(0, 3), 10)).toThrow(SanityError);
    expect(countProgrammes(db)).toBe(50);
    db.close();
  });

  test('deletes only the (channel, day) pairs the batch refills', () => {
    // The invariant the whole write path exists for: a feed that silently drops
    // a channel must leave that channel's stored rows alone rather than turning
    // its column blank.
    const db = fresh();
    const start = mskDayStartUtc(DAY) + 10 * 3600;
    replaceProgrammes(db, padded([prog(TNT, start, 30, 'Старое ТНТ'), prog(MATCH, start, 30, 'Матч')], 20), 10);

    // Second run carries ТНТ only — as if Матч ТВ vanished from the feed.
    replaceProgrammes(db, padded([prog(TNT, start, 30, 'Новое ТНТ')], 20), 10);

    const rows = programmesForDay(db, DAY);
    expect(rows.find((row) => row.channelSlug === TNT)?.title).toBe('Новое ТНТ');
    // Untouched, not blanked.
    expect(rows.find((row) => row.channelSlug === MATCH)?.title).toBe('Матч');
    db.close();
  });

  test('leaves another day of the same channel alone', () => {
    const db = fresh();
    const today = mskDayStartUtc(DAY) + 12 * 3600;
    const tomorrow = mskDayStartUtc(NEXT) + 12 * 3600;
    replaceProgrammes(db, padded([prog(TNT, today, 30, 'Сегодня'), prog(TNT, tomorrow, 30, 'Завтра')], 20), 10);

    replaceProgrammes(db, padded([prog(TNT, today, 30, 'Сегодня, заново')], 20), 10);

    expect(programmesForDay(db, DAY).find((row) => row.channelSlug === TNT)?.title).toBe('Сегодня, заново');
    expect(programmesForDay(db, NEXT).find((row) => row.channelSlug === TNT)?.title).toBe('Завтра');
    db.close();
  });

  test('reports the horizon it wrote', () => {
    const db = fresh();
    const start = mskDayStartUtc(DAY) + 20 * 3600;
    const summary = replaceProgrammes(db, padded([prog(TNT, start, 90, 'Вечер')], 20), 10);

    expect(summary.horizonUtc).toBe(Math.max(start + 90 * 60, horizonUtc(db)));
    expect(horizonUtc(db)).toBe(summary.horizonUtc);
    db.close();
  });
});

describe('programmesForDay', () => {
  test('carries over the broadcast that was still running at midnight', () => {
    // Filed under the day it starts on, so 23:40 -> 01:15 belongs to yesterday.
    // Asking for `day = $day` alone left the top of every column empty for as
    // long as it ran: nothing was marked live, and the «Сейчас в эфире» strip
    // had nothing to show for the first stretch of every single day.
    const db = fresh();
    const lateNight = mskDayStartUtc(DAY) + 23 * 3600 + 40 * 60;
    replaceProgrammes(db, padded([prog(TNT, lateNight, 95, 'Ночной эфир')], 20), 10);

    const next = programmesForDay(db, NEXT);
    const carried = next.find((row) => row.title === 'Ночной эфир');

    expect(carried).toBeDefined();
    // It keeps its own day, which is what stops it being indexed and linked
    // twice — it is shown here, but it is listed under yesterday.
    expect(carried?.day).toBe(DAY);
    expect(next.filter((row) => row.channelSlug === TNT)).toHaveLength(1);
  });

  test('does not carry over one that had already finished', () => {
    const db = fresh();
    const evening = mskDayStartUtc(DAY) + 22 * 3600;
    replaceProgrammes(db, padded([prog(TNT, evening, 60, 'Закончилось до полуночи')], 20), 10);

    expect(programmesForDay(db, NEXT).some((row) => row.title === 'Закончилось до полуночи')).toBe(false);
  });

  test('returns a day that has no carry-over unchanged', () => {
    const db = fresh();
    const noon = mskDayStartUtc(DAY) + 12 * 3600;
    replaceProgrammes(db, padded([prog(TNT, noon, 30, 'Полдень')], 20), 10);

    const rows = programmesForDay(db, DAY);
    expect(rows.every((row) => row.day === DAY)).toBe(true);
    db.close();
  });
});

describe('pruneBefore', () => {
  test('drops what has aged out and nothing else', () => {
    const db = fresh();
    const old = mskDayStartUtc('2026-08-01') + 12 * 3600;
    const recent = mskDayStartUtc(DAY) + 12 * 3600;
    replaceProgrammes(db, padded([prog(TNT, old, 30, 'Древнее'), prog(TNT, recent, 30, 'Свежее')], 20), 10);

    const removed = pruneBefore(db, mskDayStartUtc('2026-08-20'));

    expect(removed).toBe(1);
    expect(programmesForDay(db, DAY).some((row) => row.title === 'Свежее')).toBe(true);
    db.close();
  });
});

describe('provenance', () => {
  const validators = { etag: undefined, lastModified: undefined };

  test('is empty on a database nothing has ever been written to', () => {
    const db = fresh();
    expect(provenance(db)).toEqual({ source: undefined, confirmedAtUtc: undefined });
    db.close();
  });

  test('names the feed whose body was last written, not the last one to answer', () => {
    // The distinction that makes the footer honest: after a fallback run, the
    // primary coming back with a 304 confirms its own file is unchanged — it
    // does not mean the guide is built from it.
    const db = fresh();
    finishRun(db, startRun(db, 'iptvx.one', 100), 110, {
      ok: true,
      notModified: false,
      programmes: 3000,
      horizonUtc: 999,
      etag: 'a',
      lastModified: undefined,
      error: undefined,
    });
    finishRun(db, startRun(db, 'epg.one', 200), 210, {
      ok: true,
      notModified: true,
      programmes: 0,
      horizonUtc: undefined,
      etag: 'b',
      lastModified: undefined,
      error: undefined,
    });

    expect(provenance(db).source).toBe('iptvx.one');
    // ...but a 304 does update *when* the data was last confirmed current.
    expect(provenance(db).confirmedAtUtc).toBe(210);
    db.close();
  });

  test('ignores a failed run entirely', () => {
    const db = fresh();
    finishRun(db, startRun(db, 'epg.one', 100), 110, {
      ok: false,
      notModified: false,
      programmes: 0,
      horizonUtc: undefined,
      etag: undefined,
      lastModified: undefined,
      error: 'HTTP 503',
    });

    expect(provenance(db)).toEqual({ source: undefined, confirmedAtUtc: undefined });
    db.close();
  });

  test('lastValidators keeps a Last-Modified-only answer', () => {
    // Requiring an ETag silently gave up conditional requests against any source
    // that answers with Last-Modified alone, costing a full download every run
    // to discover nothing had changed.
    const db = fresh();
    finishRun(db, startRun(db, 'iptvx.one', 100), 110, {
      ok: true,
      notModified: false,
      programmes: 3000,
      horizonUtc: 999,
      etag: undefined,
      lastModified: 'Wed, 26 Aug 2026 04:15:00 GMT',
      error: undefined,
    });

    expect(lastValidators(db, 'iptvx.one')).toEqual({
      etag: undefined,
      lastModified: 'Wed, 26 Aug 2026 04:15:00 GMT',
    });
    expect(lastValidators(db, 'epg.one')).toEqual({ etag: undefined, lastModified: undefined });
    db.close();
  });

  test('every configured channel survives the schema sync', () => {
    const db = fresh();
    const rows = db.query<{ slug: string }, []>('SELECT slug FROM channel ORDER BY sort_order').all();
    expect(rows.map((row) => row.slug)).toEqual(CHANNELS.map((channel) => channel.slug));
    db.close();
  });

  test('validators are ignored unless the stored rows came from that same source', () => {
    // Not a store concern but the invariant the store's data feeds: a database
    // holding the fallback's rows must not let the primary 304 its way out of
    // re-downloading, or the guide stays on the fallback for as long as the
    // primary's file sits unchanged — precisely when it has recovered.
    const db = fresh();
    finishRun(db, startRun(db, 'iptvx.one', 100), 110, {
      ok: true,
      notModified: false,
      programmes: 3000,
      horizonUtc: 999,
      etag: 'fallback-etag',
      lastModified: undefined,
      error: undefined,
    });

    expect(provenance(db).source).not.toBe('epg.one');
    expect(lastValidators(db, 'epg.one')).toEqual(validators);
    db.close();
  });
});
