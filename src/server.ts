import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

import { CHANNELS } from './config/channels.ts';
import { openDatabase } from './db/schema.ts';
import { countProgrammes, horizonUtc, programmesForDay } from './db/store.ts';
import { mskDay } from './lib/time.ts';
import { APP_ASSET } from './render/bundle.ts';
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
 *
 * Search follows the same rule rather than making an exception to it. The
 * titles are flattened into one array alongside the pages, so a query scans
 * memory that was already there — no SQL on a request path, and no fifteen-day
 * corpus shipped to the browser to achieve it.
 */

const DEFAULT_PORT = 4300;
const DEFAULT_DB_PATH = './data/tv.db';

/** Most a search will answer with. Past this nobody is reading, they are refining. */
const SEARCH_LIMIT = 60;
const SEARCH_MIN_QUERY = 2;
const SEARCH_MAX_QUERY = 100;

/**
 * Brotli quality.
 *
 * 10, not the maximum, and measured rather than assumed: on this corpus 11
 * produces a *larger* file than 10 on nine of the ten stored days and takes
 * 2.7 times as long — 888 ms against 332 ms for the set, to end up 139 bytes
 * fatter overall. The window and mode 11 switches to simply do not suit a
 * hundred kilobytes of repetitive markup.
 *
 * The instinct that "it is paid once so the maximum is free" was wrong twice
 * over: it is not free, because it blocks the only event loop this server has,
 * and here it does not even win.
 */
const BROTLI_QUALITY = 10;

/** Bytes in all three encodings a client might ask for, compressed once. */
interface Encoded {
  readonly identity: Uint8Array;
  readonly gzip: Uint8Array;
  readonly brotli: Uint8Array;
  readonly etag: string;
}

function encode(text: string): Encoded {
  const identity = new TextEncoder().encode(text);
  return {
    identity,
    gzip: Bun.gzipSync(identity),
    brotli: brotliCompressSync(identity, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: identity.length,
      },
    }),
    etag: `W/"${Bun.hash(text).toString(36)}"`,
  };
}

/**
 * The client bundle. Built and compressed once per process, never per request,
 * and addressed by content hash so it can be cached for a year.
 */
const APP_BUNDLE = encode(APP_ASSET.code);

/** One programme, flattened for search. Short keys: this crosses the wire. */
interface SearchHit {
  readonly d: string;
  readonly s: number;
  readonly c: string;
  readonly t: string;
}

interface SearchEntry {
  readonly hit: SearchHit;
  /** Lower-cased with ё folded to е — what the query is actually matched against. */
  readonly haystack: string;
}

interface Snapshot {
  readonly pages: ReadonlyMap<string, Encoded>;
  readonly days: readonly string[];
  readonly search: readonly SearchEntry[];
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
 * The one normalisation search uses, applied to both sides.
 *
 * `ё` is optional in written Russian and the feed is inconsistent about it, so
 * a visitor who types "елки" must find "Ёлки". Folding both the title and the
 * query is the whole mechanism.
 */
function fold(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е');
}

/**
 * Renders every stored day up front.
 *
 * Fifteen small documents take milliseconds, so there is no partial
 * invalidation anywhere in this program — the whole set is rebuilt or none of
 * it is. Partial cache invalidation is where this class of service usually
 * starts serving yesterday under today's URL.
 */
export async function buildSnapshot(db: Database): Promise<Snapshot> {
  const days = listDays(db);
  const updatedUtc = nowUtc();
  const pages = new Map<string, Encoded>();
  const search: SearchEntry[] = [];

  for (const day of days) {
    // One yield per day. Compressing the set takes about a third of a second,
    // and this is the only thread there is — without this, every request in
    // flight when an ingest commits waits for the whole run, `/healthz`
    // included, which is exactly the request that must not stall.
    await Bun.sleep(0);
    const programmes = programmesForDay(db, day);

    for (const programme of programmes) {
      search.push({
        hit: { d: day, s: programme.startUtc, c: programme.channelSlug, t: programme.title },
        haystack: fold(programme.title),
      });
    }

    pages.set(day, encode(renderDayPage({ day, days, programmes, updatedUtc, staleNote: undefined })));
  }

  // Chronological, so results read as a timeline rather than grouped by
  // whichever channel the database happened to return first.
  search.sort((a, b) => a.hit.s - b.hit.s);

  return {
    pages,
    days,
    search,
    programmes: countProgrammes(db),
    horizonUtc: horizonUtc(db),
    builtAtUtc: updatedUtc,
  };
}

/**
 * Scans the flattened titles. Linear over a few thousand strings, in memory.
 *
 * The cap is taken from `nowUtc` outwards, not from the start of the index,
 * and that is the whole subtlety here. The store holds eight days behind and
 * six ahead; a common word like "новости" matches a couple of hundred times,
 * so filling the sixty slots in index order would return nothing but
 * programmes that finished days ago. Upcoming ones are what a schedule is for,
 * so they are taken first and the remaining slots are backfilled with the most
 * recent past. The answer stays in one chronological run either way.
 */
export function searchSnapshot(
  entries: readonly SearchEntry[],
  rawQuery: string,
  nowUtc: number,
): readonly SearchHit[] {
  const query = fold(rawQuery.trim());
  if (query.length < SEARCH_MIN_QUERY || query.length > SEARCH_MAX_QUERY) {
    return [];
  }

  // Entries are sorted by start, so everything from here on is still to come.
  let from = entries.findIndex((entry) => entry.hit.s >= nowUtc);
  if (from === -1) {
    from = entries.length;
  }

  const upcoming: SearchHit[] = [];
  for (let index = from; index < entries.length && upcoming.length < SEARCH_LIMIT; index += 1) {
    const entry = entries[index]!;
    if (entry.haystack.includes(query)) {
      upcoming.push(entry.hit);
    }
  }

  const past: SearchHit[] = [];
  for (let index = from - 1; index >= 0 && upcoming.length + past.length < SEARCH_LIMIT; index -= 1) {
    const entry = entries[index]!;
    if (entry.haystack.includes(query)) {
      past.push(entry.hit);
    }
  }

  return [...past.reverse(), ...upcoming];
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

function send(asset: Encoded, request: Request, contentType: string, cacheControl: string): Response {
  if (request.headers.get('if-none-match') === asset.etag) {
    return new Response(null, { status: 304, headers: { etag: asset.etag } });
  }

  const accepted = request.headers.get('accept-encoding') ?? '';
  const headers = new Headers({
    'content-type': contentType,
    etag: asset.etag,
    'cache-control': cacheControl,
    // Three encodings of one URL. Without this a shared cache is free to hand
    // brotli bytes to a client that only asked for gzip.
    vary: 'accept-encoding',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });

  if (accepted.includes('br')) {
    headers.set('content-encoding', 'br');
    return new Response(asset.brotli, { headers });
  }
  if (accepted.includes('gzip')) {
    headers.set('content-encoding', 'gzip');
    return new Response(asset.gzip, { headers });
  }
  return new Response(asset.identity, { headers });
}

/**
 * Short: the document embeds "now" only as data, but the day tabs and the
 * schedule itself change twice a day, and a stale guide is the whole failure
 * mode we are avoiding.
 */
const PAGE_CACHE = 'public, max-age=300';

/** The bundle's URL contains its own hash, so a change is a different URL. */
const ASSET_CACHE = 'public, max-age=31536000, immutable';

/** Any bundle path, including hashes from a previous deploy. */
const APP_PATH = /^\/app\.[a-z0-9]+\.js$/;

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
    '# HELP tv_search_entries_total Titles in the in-memory search index.',
    '# TYPE tv_search_entries_total gauge',
    `tv_search_entries_total ${snapshot.search.length}`,
  ];
  return `${lines.join('\n')}\n`;
}

export interface RunningServer {
  readonly server: ReturnType<typeof Bun.serve>;
  /** Re-renders every page. Called after an ingest commits. */
  readonly rebuild: () => Promise<void>;
}

export async function startServer(db: Database, port: number): Promise<RunningServer> {
  let snapshot = await buildSnapshot(db);

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

      // Any hash, not only the current one. A day page is cached for five
      // minutes, so for five minutes after a deploy there are browsers holding
      // markup that points at the previous bundle. Answering those with a 404
      // leaves a visitor on a page whose channels cannot be chosen — so they
      // get the current bundle instead, just not marked immutable.
      if (APP_PATH.test(path)) {
        const exact = path === APP_ASSET.path;
        return send(APP_BUNDLE, request, 'text/javascript; charset=utf-8', exact ? ASSET_CACHE : PAGE_CACHE);
      }

      if (path === '/search') {
        const hits = searchSnapshot(snapshot.search, url.searchParams.get('q') ?? '', nowUtc());
        return Response.json(
          { hits },
          {
            headers: {
              'cache-control': 'public, max-age=300',
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
            },
          },
        );
      }

      // Served, not redirected. A 302 here costs a whole extra round trip
      // before the document request even starts — measured on a phone profile
      // over Slow 4G it was 575 ms, roughly half of LCP, on the one URL people
      // actually type. The page carries a canonical link to its own date, so
      // the dated URL stays the real one.
      if (path === '/') {
        const day = pickDay(snapshot);
        const page = day === undefined ? undefined : snapshot.pages.get(day);
        return page === undefined
          ? new Response('Расписание ещё не загружено\n', { status: 503 })
          : send(page, request, 'text/html; charset=utf-8', PAGE_CACHE);
      }

      const match = /^\/day\/(\d{4}-\d{2}-\d{2})$/.exec(path);
      if (match !== null) {
        const page = snapshot.pages.get(match[1]!);
        return page === undefined
          ? new Response('Нет такого дня\n', { status: 404 })
          : send(page, request, 'text/html; charset=utf-8', PAGE_CACHE);
      }

      return new Response('Не найдено\n', { status: 404 });
    },
  });

  return {
    server,
    rebuild: async () => {
      snapshot = await buildSnapshot(db);
    },
  };
}

if (import.meta.main) {
  const db = openDatabase(process.env.TV_DB ?? DEFAULT_DB_PATH);
  const port = Number(process.env.TV_PORT ?? DEFAULT_PORT);
  const { server } = await startServer(db, port);
  console.log(`tv on http://${server.hostname}:${server.port}`);
}
