import { CHANNELS } from './config/channels.ts';
import { openDatabase } from './db/schema.ts';
import { countProgrammes, horizonUtc, programmesForDay } from './db/store.ts';
import { mskDay } from './lib/time.ts';
import { renderDayPage } from './render/page.ts';

import type { Database } from 'bun:sqlite';

/**
 * The read path.
 *
 * Pages are rendered and compressed when the data changes, never per request,
 * so serving one is a map lookup plus a write of bytes already in memory. That
 * is also why an upstream outage costs nothing here: the server answers from
 * what it last stored, and a cold start with an unreachable feed still returns
 * yesterday's grid.
 */

const DEFAULT_PORT = 4300;
const DEFAULT_DB_PATH = './data/tv.db';

interface CachedPage {
  readonly html: Uint8Array;
  readonly gzip: Uint8Array;
  readonly etag: string;
}

interface Snapshot {
  readonly pages: ReadonlyMap<string, CachedPage>;
  readonly days: readonly string[];
  readonly programmes: number;
  readonly horizonUtc: number;
  readonly builtAtUtc: number;
}

function nowUtc(): number {
  return Math.floor(Date.now() / 1000);
}

function listDays(db: Database): string[] {
  return db
    .query<{ day: string }, []>('SELECT DISTINCT day FROM programme ORDER BY day')
    .all()
    .map((row) => row.day);
}

/**
 * Renders every stored day up front.
 *
 * Fifteen small documents take milliseconds, so there is no partial
 * invalidation anywhere in this program — the whole set is rebuilt or none of
 * it is. Partial cache invalidation is where this class of service usually
 * starts serving yesterday under today's URL.
 */
export function buildSnapshot(db: Database): Snapshot {
  const days = listDays(db);
  const updatedUtc = nowUtc();
  const pages = new Map<string, CachedPage>();

  for (const day of days) {
    const html = renderDayPage({
      day,
      days,
      programmes: programmesForDay(db, day),
      updatedUtc,
      staleNote: undefined,
    });
    const bytes = new TextEncoder().encode(html);
    pages.set(day, {
      html: bytes,
      gzip: Bun.gzipSync(bytes),
      etag: `W/"${Bun.hash(html).toString(36)}"`,
    });
  }

  return {
    pages,
    days,
    programmes: countProgrammes(db),
    horizonUtc: horizonUtc(db),
    builtAtUtc: updatedUtc,
  };
}

function pickDay(snapshot: Snapshot): string | undefined {
  const today = mskDay(nowUtc());
  if (snapshot.pages.has(today)) {
    return today;
  }
  // Cold start on stale data: show the newest day we actually hold rather than
  // a 404, so an outage degrades to old information instead of no page.
  return snapshot.days.at(-1);
}

function send(page: CachedPage, request: Request): Response {
  if (request.headers.get('if-none-match') === page.etag) {
    return new Response(null, { status: 304, headers: { etag: page.etag } });
  }

  const acceptsGzip = request.headers.get('accept-encoding')?.includes('gzip') ?? false;
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    etag: page.etag,
    // Short: the document embeds "now" only as data, but the day nav and the
    // schedule itself change twice a day, and a stale guide is the whole
    // failure mode we are avoiding.
    'cache-control': 'public, max-age=300',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });

  if (acceptsGzip) {
    headers.set('content-encoding', 'gzip');
    return new Response(page.gzip, { headers });
  }
  return new Response(page.html, { headers });
}

function metrics(snapshot: Snapshot): string {
  const lines = [
    '# HELP tv_programmes_total Programmes currently stored.',
    '# TYPE tv_programmes_total gauge',
    `tv_programmes_total ${snapshot.programmes}`,
    '# HELP tv_data_horizon_timestamp_seconds Latest programme end time held.',
    '# TYPE tv_data_horizon_timestamp_seconds gauge',
    `tv_data_horizon_timestamp_seconds ${snapshot.horizonUtc}`,
    '# HELP tv_snapshot_built_timestamp_seconds When the page cache was last built.',
    '# TYPE tv_snapshot_built_timestamp_seconds gauge',
    `tv_snapshot_built_timestamp_seconds ${snapshot.builtAtUtc}`,
    '# HELP tv_days_total Days available in the guide.',
    '# TYPE tv_days_total gauge',
    `tv_days_total ${snapshot.days.length}`,
    '# HELP tv_channels_total Channels configured.',
    '# TYPE tv_channels_total gauge',
    `tv_channels_total ${CHANNELS.length}`,
  ];
  return `${lines.join('\n')}\n`;
}

export interface RunningServer {
  readonly server: ReturnType<typeof Bun.serve>;
  /** Re-renders every page. Called after an ingest commits. */
  readonly rebuild: () => void;
}

export function startServer(db: Database, port: number): RunningServer {
  let snapshot = buildSnapshot(db);

  const server = Bun.serve({
    port,
    hostname: '0.0.0.0',
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/healthz') {
        // Unhealthy while the cache is empty: a container that came up against
        // an empty database must not be reported green.
        const ok = snapshot.pages.size > 0;
        return new Response(ok ? 'ok\n' : 'no data\n', { status: ok ? 200 : 503 });
      }

      if (path === '/metrics') {
        return new Response(metrics(snapshot), { headers: { 'content-type': 'text/plain; version=0.0.4' } });
      }

      if (path === '/') {
        const day = pickDay(snapshot);
        return day === undefined
          ? new Response('Расписание ещё не загружено\n', { status: 503 })
          : Response.redirect(`/day/${day}`, 302);
      }

      const match = /^\/day\/(\d{4}-\d{2}-\d{2})$/.exec(path);
      if (match !== null) {
        const page = snapshot.pages.get(match[1]!);
        return page === undefined ? new Response('Нет такого дня\n', { status: 404 }) : send(page, request);
      }

      return new Response('Не найдено\n', { status: 404 });
    },
  });

  return {
    server,
    rebuild: () => {
      snapshot = buildSnapshot(db);
    },
  };
}

if (import.meta.main) {
  const db = openDatabase(process.env.TV_DB ?? DEFAULT_DB_PATH);
  const port = Number(process.env.TV_PORT ?? DEFAULT_PORT);
  const { server } = startServer(db, port);
  console.log(`tv on http://${server.hostname}:${server.port}`);
}
