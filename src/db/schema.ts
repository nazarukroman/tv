import { Database } from 'bun:sqlite';

import { CHANNELS } from '../config/channels.ts';

/**
 * Schema and connection setup.
 *
 * The database is small — twenty channels over a fifteen-day window is under
 * ten thousand rows — so it lives entirely in the page cache and none of this
 * needs to be clever. What it does need is to be safe to rewrite twice a day
 * while the server is reading, which is what WAL plus a single writer buys.
 *
 * The file must sit on local disk, never NFS: WAL needs real POSIX locking,
 * and the failure mode over NFS is a silently read-only database rather than
 * an error at startup.
 */

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE channel (
    slug       TEXT PRIMARY KEY,
    source_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    mux        INTEGER NOT NULL,
    sort_order INTEGER NOT NULL
  );

  -- Clustered on the read path: the grid asks for one day, and 'what is on
  -- now' seeks by (channel, start). WITHOUT ROWID keeps the row in the index
  -- rather than one indirection away.
  CREATE TABLE programme (
    channel_slug TEXT NOT NULL REFERENCES channel(slug) ON DELETE CASCADE,
    start_utc    INTEGER NOT NULL,
    stop_utc     INTEGER NOT NULL,
    day          TEXT NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT,
    PRIMARY KEY (channel_slug, start_utc)
  ) WITHOUT ROWID;

  -- Serves the day grid in render order, so no sort is needed at read time.
  CREATE INDEX programme_by_day ON programme (day, channel_slug, start_utc);

  -- One row per attempt, successful or not. This is the staleness signal the
  -- alert reads: a run that 304s still counts as the source being reachable.
  CREATE TABLE ingest_run (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    ok            INTEGER NOT NULL DEFAULT 0,
    not_modified  INTEGER NOT NULL DEFAULT 0,
    programmes    INTEGER NOT NULL DEFAULT 0,
    horizon_utc   INTEGER,
    etag          TEXT,
    last_modified TEXT,
    error         TEXT
  );
  `,
  // A channel no longer has *a* source id — it has one per feed, and the pins
  // live in config where they are type-checked against the source list. The
  // column only ever mirrored epg.one's, was read by nothing, and would now be
  // a third place to forget when a pin moves.
  `
  ALTER TABLE channel DROP COLUMN source_id;
  `,
  // The staleness answer is "when did a feed last confirm this", which is a scan
  // of every run ordered by finish time. Cheap either way at a few hundred rows,
  // but it is asked on every snapshot build.
  `
  CREATE INDEX ingest_run_good ON ingest_run (ok, finished_at);
  `,
];

/** Applies any migration the database has not seen, using `user_version`. */
function migrate(db: Database): void {
  const current = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) {
      continue;
    }
    db.transaction(() => {
      db.exec(sql);
      // PRAGMA does not accept a binding, and `version` is a loop counter, not input.
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}

/** Mirrors the channel config into the database so joins and cascades work. */
function syncChannels(db: Database): void {
  const upsert = db.prepare(`
    INSERT INTO channel (slug, name, mux, sort_order)
    VALUES ($slug, $name, $mux, $order)
    ON CONFLICT(slug) DO UPDATE SET
      name       = excluded.name,
      mux        = excluded.mux,
      sort_order = excluded.sort_order
  `);

  // `strict: true` binds by bare name: the SQL keeps its `$` placeholders, the
  // object must not repeat the sigil.
  db.transaction(() => {
    CHANNELS.forEach((channel, index) => {
      upsert.run({
        slug: channel.slug,
        name: channel.name,
        mux: channel.mux,
        order: index,
      });
    });
  })();
}

/** Opens the database, applies migrations and syncs the channel list. */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });

  // WAL lets the server keep reading while ingest rewrites a day.
  db.exec('PRAGMA journal_mode = WAL');
  // NORMAL is the right trade with WAL: a crash can lose the last commit, and
  // the last commit here is a schedule we can simply fetch again.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Ingest and the server can overlap; wait rather than throwing SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);
  syncChannels(db);
  return db;
}
