import { openDatabase } from './db/schema.ts';
import { horizonUtc } from './db/store.ts';
import { ingest } from './ingest.ts';
import { startServer } from './server.ts';

import type { Database } from 'bun:sqlite';

/**
 * Container entrypoint: serve immediately, fetch on a schedule.
 *
 * The order matters. The server comes up first and answers from whatever is
 * already stored, so a slow or unreachable feed delays freshness rather than
 * startup. Ingest then runs only if the stored schedule is actually short of
 * runway, which keeps a container restart from hammering the source.
 */

const DEFAULT_DB_PATH = '/app/data/tv.db';
const DEFAULT_PORT = 4300;

/** Moscow wall-clock times to refresh at. Both are clear of the host backups. */
const REFRESH_HOURS = [4, 14] as const;
const REFRESH_MINUTE = 15;

/** Below this much runway the data is stale enough to fetch at startup. */
const MIN_RUNWAY_SECONDS = 36 * 3600;

const RETRY_DELAYS_MS = [60_000, 300_000, 900_000];

function nowUtc(): number {
  return Math.floor(Date.now() / 1000);
}

/** Milliseconds until the next scheduled refresh, in Moscow time. */
export function msUntilNextRefresh(fromMs: number): number {
  const MSK = 3 * 3600_000;
  const local = fromMs + MSK;
  const dayStart = Math.floor(local / 86_400_000) * 86_400_000;

  for (const hour of REFRESH_HOURS) {
    const at = dayStart + hour * 3600_000 + REFRESH_MINUTE * 60_000;
    if (at > local) {
      return at - local;
    }
  }

  // Past the last slot today: wrap to the first slot tomorrow.
  const first = REFRESH_HOURS[0];
  return dayStart + 86_400_000 + first * 3600_000 + REFRESH_MINUTE * 60_000 - local;
}

async function runIngest(db: Database, rebuild: () => void): Promise<void> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await ingest(db);
      rebuild();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        // Out of retries. The server keeps serving what it has; the staleness
        // metric is what should raise the alarm, not a crash loop.
        console.error(`ingest failed, giving up until the next slot: ${message}`);
        return;
      }
      console.error(`ingest failed (attempt ${attempt + 1}), retrying in ${delay / 1000}s: ${message}`);
      await Bun.sleep(delay);
    }
  }
}

function scheduleForever(db: Database, rebuild: () => void): void {
  const tick = (): void => {
    const wait = msUntilNextRefresh(Date.now());
    setTimeout(() => {
      void runIngest(db, rebuild).finally(tick);
    }, wait);
    console.log(`next refresh in ${Math.round(wait / 60_000)} min`);
  };
  tick();
}

if (import.meta.main) {
  const db = openDatabase(process.env.TV_DB ?? DEFAULT_DB_PATH);
  const port = Number(process.env.TV_PORT ?? DEFAULT_PORT);
  const { server, rebuild } = startServer(db, port);
  console.log(`tv on http://${server.hostname}:${server.port}`);

  const runway = horizonUtc(db) - nowUtc();
  if (runway < MIN_RUNWAY_SECONDS) {
    console.log(`runway ${Math.round(runway / 3600)}h, fetching now`);
    void runIngest(db, rebuild);
  }

  scheduleForever(db, rebuild);

  const shutdown = (): void => {
    server.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
