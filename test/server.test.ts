import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { openDatabase } from '../src/db/schema.ts';
import { finishRun, replaceProgrammes, startRun } from '../src/db/store.ts';
import { mskDay, mskDayStartUtc } from '../src/lib/time.ts';
import { APP_ASSET } from '../src/render/bundle.ts';
import { startServer } from '../src/server.ts';

import type { Database } from 'bun:sqlite';
import type { RunningServer } from '../src/server.ts';
import type { Programme } from '../src/lib/types.ts';

/**
 * The HTTP surface, against a real server on a real port.
 *
 * Every one of these is a route whose failure is invisible from the inside: a
 * 404 on the bundle, a 304 that should have been a 200, brotli bytes handed to
 * a client that asked for none. None of them throws, so nothing but a request
 * finds them.
 */

const TODAY = mskDay(Math.floor(Date.now() / 1000));
const OTHER = mskDay(Math.floor(Date.now() / 1000) + 86_400);

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

let db: Database;
let running: RunningServer;
let origin: string;

beforeAll(async () => {
  db = openDatabase(':memory:');

  const rows: Programme[] = [];
  for (const day of [TODAY, OTHER]) {
    for (let index = 0; index < 30; index += 1) {
      rows.push(prog('tnt', mskDayStartUtc(day) + index * 1800, 30, index === 0 ? 'Ёлки' : `Передача ${index}`));
    }
  }
  replaceProgrammes(db, rows, 10);
  finishRun(db, startRun(db, 'epg.one', 100), 110, {
    ok: true,
    notModified: false,
    programmes: rows.length,
    horizonUtc: 999,
    etag: 'x',
    lastModified: undefined,
    error: undefined,
  });

  // Port 0: the OS picks a free one, so a parallel run cannot collide.
  running = await startServer(db, 0);
  origin = `http://localhost:${running.server.port}`;
});

afterAll(async () => {
  await running.server.stop();
  db.close();
});

describe('routing', () => {
  test('serves today at / without a redirect', async () => {
    // A 302 here costs a whole round trip before the document even starts
    // loading, on the one URL people type by hand.
    const response = await fetch(`${origin}/`, { redirect: 'manual' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  test('/ and /day/<today> are the same document, byte for byte', async () => {
    // The whole basis of making `/` the durable address for today: rewriting the
    // URL from one to the other must not change what is on screen.
    const [root, dated] = await Promise.all([
      fetch(`${origin}/`).then((r) => r.text()),
      fetch(`${origin}/day/${TODAY}`).then((r) => r.text()),
    ]);
    expect(root).toBe(dated);
  });

  test('the page names its own date as canonical', async () => {
    const html = await fetch(`${origin}/day/${OTHER}`).then((r) => r.text());
    expect(html).toContain(`<link rel="canonical" href="/day/${OTHER}">`);
  });

  test('404s a day it does not hold, and an unknown path', async () => {
    expect((await fetch(`${origin}/day/1999-01-01`)).status).toBe(404);
    expect((await fetch(`${origin}/nope`)).status).toBe(404);
    // Not a date at all: must not be mistaken for one.
    expect((await fetch(`${origin}/day/whatever`)).status).toBe(404);
  });

  test('healthz is green only once there are pages to serve', async () => {
    const response = await fetch(`${origin}/healthz`);
    expect(response.status).toBe(200);

    const empty = openDatabase(':memory:');
    const bare = await startServer(empty, 0);
    expect((await fetch(`http://localhost:${bare.server.port}/healthz`)).status).toBe(503);
    await bare.server.stop();
    empty.close();
  });

  test('metrics reports the stored counts', async () => {
    const body = await fetch(`${origin}/metrics`).then((r) => r.text());
    expect(body).toContain('tv_programmes_total 60');
    expect(body).toContain('tv_days_total 2');
    expect(body).toContain('tv_channels_total 20');
  });
});

describe('caching', () => {
  test('answers a matching If-None-Match with 304 and no body', async () => {
    const first = await fetch(`${origin}/day/${TODAY}`);
    const etag = first.headers.get('etag');
    expect(etag).not.toBeNull();

    const second = await fetch(`${origin}/day/${TODAY}`, { headers: { 'if-none-match': etag! } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  test('a stale validator gets the document, not a 304', async () => {
    const response = await fetch(`${origin}/day/${TODAY}`, { headers: { 'if-none-match': 'W/"stale"' } });
    expect(response.status).toBe(200);
  });

  test('varies on accept-encoding, so a shared cache cannot cross the wires', async () => {
    const response = await fetch(`${origin}/day/${TODAY}`);
    expect(response.headers.get('vary')).toBe('accept-encoding');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('hands back only an encoding that was asked for', async () => {
    // `fetch` decodes transparently, so the header is what is being asserted.
    const brotli = await fetch(`${origin}/day/${TODAY}`, { headers: { 'accept-encoding': 'br' } });
    expect(brotli.headers.get('content-encoding')).toBe('br');

    const gzip = await fetch(`${origin}/day/${TODAY}`, { headers: { 'accept-encoding': 'gzip' } });
    expect(gzip.headers.get('content-encoding')).toBe('gzip');

    const plain = await fetch(`${origin}/day/${TODAY}`, { headers: { 'accept-encoding': 'identity' } });
    expect(plain.headers.get('content-encoding')).toBeNull();
  });
});

describe('the client bundle', () => {
  test('is immutable at its own hashed path', async () => {
    const response = await fetch(`${origin}${APP_ASSET.path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
  });

  test('answers a hash from a previous deploy rather than 404ing', async () => {
    // For the five minutes a cached page outlives a deploy, browsers are asking
    // for the old URL. A 404 there leaves a visitor with a page whose channels
    // cannot be reordered and whose search does nothing.
    const response = await fetch(`${origin}/app.deadbeef.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).not.toContain('immutable');
    expect(response.headers.get('content-type')).toContain('javascript');
  });
});

interface Hit {
  readonly d: string;
  readonly s: number;
  readonly c: string;
  readonly t: string;
}

/** The wire shape, asserted here rather than assumed by every test below. */
async function search(query: string | undefined): Promise<{ status: number; hits: readonly Hit[] }> {
  const url = query === undefined ? `${origin}/search` : `${origin}/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(url);
  const body = (await response.json()) as { hits?: readonly Hit[] };
  return { status: response.status, hits: body.hits ?? [] };
}

describe('search', () => {
  test('folds ё and е in both directions', async () => {
    // The feed is inconsistent and ё is optional in writing, so this is the
    // difference between finding «Ёлки» and finding nothing.
    const { hits } = await search('елки');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.t).toBe('Ёлки');
  });

  test('answers a too-short query with nothing rather than everything', async () => {
    expect((await search('е')).hits).toEqual([]);
    expect((await search(undefined)).hits).toEqual([]);
  });

  test('answers an over-long query with nothing rather than scanning for it', async () => {
    // 500 characters, well past the 100 the handler accepts but still short
    // enough to reach it — anything much longer is refused by Bun with a 431
    // before this code sees it, which is somebody else's guard, not ours.
    const { status, hits } = await search('а'.repeat(500));
    expect(status).toBe(200);
    expect(hits).toEqual([]);
  });

  test('does not reflect the query into the response', async () => {
    // The answer is data the client renders as text, never markup — but a query
    // echoed into it is the shape that turns into an injection the first time
    // someone renders it as HTML.
    const body = await fetch(`${origin}/search?q=${encodeURIComponent('<script>alert(1)</script>')}`).then((r) =>
      r.text(),
    );
    expect(body).not.toContain('<script>');
  });

  test('indexes a carried-over broadcast once, under the day it started', async () => {
    const { hits } = await search('передача');
    const keys = hits.map((hit) => `${hit.d}|${hit.c}|${hit.s}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
