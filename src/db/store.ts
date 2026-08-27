import { TAIL_SIZE } from '../lib/schedule.ts';
import { mskDay, mskDayStartUtc } from '../lib/time.ts';

import type { Database } from 'bun:sqlite';

import type { CacheValidators } from '../lib/fetch.ts';
import type { Programme } from '../lib/types.ts';

/**
 * Writing and reading the schedule.
 *
 * The write path has one job beyond speed: never leave a reader looking at a
 * half-imported day, and never let a degraded upstream response delete a good
 * snapshot. Both are handled by scope rather than by care — the transaction
 * deletes only the (channel, day) pairs the batch is about to repopulate, so a
 * feed that silently drops a channel leaves yesterday's rows for that channel
 * untouched instead of blanking the column.
 */

interface ProgrammeRow {
  readonly channel_slug: string;
  readonly start_utc: number;
  readonly stop_utc: number;
  readonly day: string;
  readonly title: string;
  readonly description: string | null;
}

export interface ReplaceSummary {
  readonly programmes: number;
  readonly days: number;
  readonly channels: number;
  /** Latest `stop_utc` written — how far forward the guide can now show. */
  readonly horizonUtc: number;
}

export class SanityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SanityError';
  }
}

/**
 * Replaces every (channel, day) the batch covers, atomically.
 *
 * `minProgrammes` is the same guard as the docs generators' min-lines rule: a
 * run that comes back suspiciously small is refused outright rather than
 * committed over a healthy snapshot. A feed truncated mid-transfer is the
 * realistic case, and it arrives as a valid-looking short document.
 */
export function replaceProgrammes(
  db: Database,
  programmes: readonly Programme[],
  minProgrammes: number,
): ReplaceSummary {
  if (programmes.length < minProgrammes) {
    throw new SanityError(
      `ingest produced ${programmes.length} programmes, expected at least ${minProgrammes} — refusing to overwrite`,
    );
  }

  const pairs = new Set<string>();
  const days = new Set<string>();
  const channels = new Set<string>();
  let horizonUtc = 0;

  for (const programme of programmes) {
    pairs.add(`${programme.channelSlug}\0${programme.day}`);
    days.add(programme.day);
    channels.add(programme.channelSlug);
    if (programme.stopUtc > horizonUtc) {
      horizonUtc = programme.stopUtc;
    }
  }

  const deleteDay = db.prepare('DELETE FROM programme WHERE channel_slug = $slug AND day = $day');
  const insert = db.prepare(`
    INSERT INTO programme (channel_slug, start_utc, stop_utc, day, title, description)
    VALUES ($slug, $start, $stop, $day, $title, $description)
    ON CONFLICT(channel_slug, start_utc) DO UPDATE SET
      stop_utc    = excluded.stop_utc,
      day         = excluded.day,
      title       = excluded.title,
      description = excluded.description
  `);

  db.transaction(() => {
    for (const pair of pairs) {
      const [slug, day] = pair.split('\0');
      deleteDay.run({ slug: slug!, day: day! });
    }

    for (const programme of programmes) {
      insert.run({
        slug: programme.channelSlug,
        start: programme.startUtc,
        stop: programme.stopUtc,
        day: programme.day,
        title: programme.title,
        description: programme.description ?? null,
      });
    }
  })();

  return { programmes: programmes.length, days: days.size, channels: channels.size, horizonUtc };
}

/** Drops programmes that ended before `cutoffUtc`, keeping the file small. */
export function pruneBefore(db: Database, cutoffUtc: number): number {
  const result = db.prepare('DELETE FROM programme WHERE stop_utc < $cutoff').run({ cutoff: cutoffUtc });
  return Number(result.changes);
}

/**
 * Cache validators from the last run that came back with either of them.
 *
 * Either, not just an ETag. Requiring `etag IS NOT NULL` silently gave up
 * conditional requests against any source that answers with `Last-Modified`
 * alone — which is a normal thing for a CDN serving a static `.gz` to do, and
 * costs a 25 MB download every run to discover nothing changed.
 */
export function lastValidators(db: Database, source: string): CacheValidators {
  const row = db
    .query<{ etag: string | null; last_modified: string | null }, { source: string }>(
      `SELECT etag, last_modified FROM ingest_run
       WHERE source = $source AND ok = 1 AND (etag IS NOT NULL OR last_modified IS NOT NULL)
       ORDER BY id DESC LIMIT 1`,
    )
    .get({ source });

  return {
    etag: row?.etag ?? undefined,
    lastModified: row?.last_modified ?? undefined,
  };
}

/** Where the rows in this database came from, and when that was last confirmed. */
export interface Provenance {
  /** Name of the feed whose body was last written. Absent on an empty database. */
  readonly source: string | undefined;
  /** Unix seconds of the last successful check, 304s included. */
  readonly confirmedAtUtc: number | undefined;
}

/**
 * Two different questions, and they have two different answers.
 *
 * *Which feed* the guide is built from is the last run that actually wrote rows
 * — a 304 confirms a body without replacing one, so it cannot change the
 * answer. That matters now that the fallback works: the page should say when it
 * is showing the secondary feed.
 *
 * *When* it was last confirmed current does count a 304, because that is
 * precisely what a 304 means: the source was reachable and said what we hold is
 * still the current file.
 *
 * Neither is "when the process started". `buildSnapshot` runs on every boot with
 * no feed involved, and reporting that as freshness let a container restarted
 * against three-day-old rows print the current time underneath them.
 */
export function provenance(db: Database): Provenance {
  const wrote = db
    .query<{ source: string }, []>(
      `SELECT source FROM ingest_run
       WHERE ok = 1 AND not_modified = 0 AND finished_at IS NOT NULL
       ORDER BY finished_at DESC, id DESC LIMIT 1`,
    )
    .get();

  const confirmed = db
    .query<{ finished_at: number }, []>(
      `SELECT finished_at FROM ingest_run
       WHERE ok = 1 AND finished_at IS NOT NULL
       ORDER BY finished_at DESC, id DESC LIMIT 1`,
    )
    .get();

  return { source: wrote?.source, confirmedAtUtc: confirmed?.finished_at };
}

export function startRun(db: Database, source: string, nowUtc: number): number {
  const result = db
    .prepare('INSERT INTO ingest_run (source, started_at) VALUES ($source, $started)')
    .run({ source, started: nowUtc });
  return Number(result.lastInsertRowid);
}

export interface FinishRun {
  readonly ok: boolean;
  readonly notModified: boolean;
  readonly programmes: number;
  readonly horizonUtc: number | undefined;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
  readonly error: string | undefined;
}

export function finishRun(db: Database, id: number, nowUtc: number, outcome: FinishRun): void {
  db.prepare(
    `UPDATE ingest_run SET
       finished_at = $finished, ok = $ok, not_modified = $notModified,
       programmes = $programmes, horizon_utc = $horizon,
       etag = $etag, last_modified = $lastModified, error = $error
     WHERE id = $id`,
  ).run({
    id: id,
    finished: nowUtc,
    ok: outcome.ok ? 1 : 0,
    notModified: outcome.notModified ? 1 : 0,
    programmes: outcome.programmes,
    horizon: outcome.horizonUtc ?? null,
    etag: outcome.etag ?? null,
    lastModified: outcome.lastModified ?? null,
    error: outcome.error ?? null,
  });
}

/**
 * Every programme a viewer looking at `day` should see, in render order.
 *
 * Three things, and only the first is the day itself.
 *
 * Whatever was still running when the day began comes with it. A programme is
 * filed under the day it *starts* on, so a broadcast from 23:40 to 01:15
 * belongs to yesterday — and asking for `day = $day` alone left the top of
 * every column empty for as long as it ran. Nothing was on air according to the
 * page, so no row was marked live and the «Сейчас в эфире» strip had nothing to
 * show, every night, for the first stretch of the day.
 *
 * And the first `TAIL_SIZE` rows of the next day come with it too, because at
 * 23:30 those are the only rows anyone is reading and they would otherwise be
 * one navigation away.
 *
 * Both keep their own `day`, which is what lets the renderer and the search
 * index tell them apart from a row of this day: they are shown here, but they
 * are listed and linked under the day they belong to. That is also why the tail
 * is not a third query's worth of special cases downstream — `day` already says
 * everything about it.
 */
export function programmesForDay(db: Database, day: string): Programme[] {
  const dayStart = mskDayStartUtc(day);
  const rows = db
    .query<ProgrammeRow, { day: string; previous: string; dayStart: number }>(
      `SELECT channel_slug, start_utc, stop_utc, day, title, description
       FROM programme
       WHERE day = $day OR (day = $previous AND stop_utc > $dayStart)
       ORDER BY channel_slug, start_utc`,
    )
    .all({ day, previous: mskDay(dayStart - 1), dayStart });

  // Ranked in SQL rather than fetched and sliced here: the next day is another
  // six hundred rows, and this reads sixty. `programme_by_day` is
  // (day, channel_slug, start_utc), which is exactly this partition and order.
  const tail = db
    .query<ProgrammeRow, { next: string; keep: number }>(
      `SELECT channel_slug, start_utc, stop_utc, day, title, description
       FROM (
         SELECT channel_slug, start_utc, stop_utc, day, title, description,
                ROW_NUMBER() OVER (PARTITION BY channel_slug ORDER BY start_utc) AS rn
         FROM programme
         WHERE day = $next
       )
       WHERE rn <= $keep
       ORDER BY channel_slug, start_utc`,
    )
    .all({ next: mskDay(dayStart + 86_400), keep: TAIL_SIZE });

  return [...rows, ...tail].map((row) => ({
    channelSlug: row.channel_slug,
    startUtc: row.start_utc,
    stopUtc: row.stop_utc,
    day: row.day,
    title: row.title,
    description: row.description ?? undefined,
  }));
}

/** How far forward the stored schedule reaches. Zero when the table is empty. */
export function horizonUtc(db: Database): number {
  const row = db.query<{ horizon: number | null }, []>('SELECT MAX(stop_utc) AS horizon FROM programme').get();
  return row?.horizon ?? 0;
}

export function countProgrammes(db: Database): number {
  const row = db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM programme').get();
  return row?.total ?? 0;
}
