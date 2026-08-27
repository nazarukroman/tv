import { describe, expect, test } from 'bun:test';

import { mskClock, mskDay, parseXmltvTime } from '../src/lib/time.ts';
import { decodeEntities, scanXmltv, stripTypePrefix } from '../src/lib/xmltv.ts';

import type { ChannelRecord, Programme } from '../src/lib/types.ts';

/** Two real channels plus one we do not want, so the filter is actually exercised. */
const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<tv generator-info-name="EPG it999 generator xmltv v2.1">
<channel id="353"><display-name lang="ru">ТНТ</display-name><display-name lang="ru">ТНТ HD</display-name></channel>
<channel id="2051"><display-name lang="ru">МАТЧ! +0 (Белгород)</display-name><display-name lang="ru">Матч ТВ</display-name></channel>
<channel id="9999"><display-name lang="ru">Посторонний</display-name></channel>
<programme start="20260826200000 +0300" stop="20260826203000 +0300" channel="353"><title lang="ru">т/с Малой. 1 с.</title><desc lang="ru">Описание серии</desc></programme>
<programme start="20260826203000 +0300" stop="20260826210000 +0300" channel="353"><title lang="ru">Новости &amp; погода</title></programme>
<programme start="20260826210000 +0300" stop="20260826220000 +0300" channel="9999"><title lang="ru">Не наш канал</title></programme>
<programme start="20260826235000 +0300" stop="20260827001000 +0300" channel="2051"><title lang="ru">Футбол</title></programme>
</tv>
`;

/** Feeds `text` through a stream in fixed-size chunks, to prove chunking is handled. */
function streamOf(text: string, chunkSize: number): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (let at = 0; at < text.length; at += chunkSize) {
        controller.enqueue(text.slice(at, at + chunkSize));
      }
      controller.close();
    },
  });
}

const WANTED = new Map([
  ['353', 'tnt'],
  ['2051', 'matchtv'],
]);

async function collect(chunkSize: number): Promise<{ channels: ChannelRecord[]; programmes: Programme[] }> {
  const channels: ChannelRecord[] = [];
  const programmes: Programme[] = [];
  await scanXmltv(streamOf(FIXTURE, chunkSize), WANTED, {
    onChannel: (channel) => channels.push(channel),
    onProgramme: (programme) => programmes.push(programme),
  });
  return { channels, programmes };
}

describe('parseXmltvTime', () => {
  test('honours the declared +0300 offset', () => {
    // 2026-08-26 20:00 MSK is 17:00 UTC.
    expect(parseXmltvTime('20260826200000 +0300')).toBe(Date.UTC(2026, 7, 26, 17, 0, 0) / 1000);
  });

  test('treats a missing offset as UTC, per the XMLTV DTD', () => {
    expect(parseXmltvTime('20260826200000')).toBe(Date.UTC(2026, 7, 26, 20, 0, 0) / 1000);
  });

  test('handles a negative offset', () => {
    expect(parseXmltvTime('20260826200000 -0500')).toBe(Date.UTC(2026, 7, 27, 1, 0, 0) / 1000);
  });

  test('returns undefined for junk rather than throwing', () => {
    // One malformed row must not be able to abort a whole ingest run.
    expect(parseXmltvTime('not a time')).toBeUndefined();
    expect(parseXmltvTime('')).toBeUndefined();
  });
});

describe('mskDay', () => {
  test('groups a late-evening programme under the day it starts', () => {
    const at = parseXmltvTime('20260826235000 +0300');
    expect(mskDay(at!)).toBe('2026-08-26');
  });

  test('rolls over at Moscow midnight, not UTC midnight', () => {
    // 00:10 MSK on the 27th is still 21:10 UTC on the 26th — the naive UTC
    // reading would file this under the wrong day.
    const at = parseXmltvTime('20260827001000 +0300');
    expect(mskDay(at!)).toBe('2026-08-27');
  });

  test('renders the Moscow wall clock', () => {
    const at = parseXmltvTime('20260826235000 +0300');
    expect(mskClock(at!)).toBe('23:50');
  });
});

describe('stripTypePrefix', () => {
  test('removes the content-type prefix', () => {
    expect(stripTypePrefix('т/с Малой. 1 с.')).toBe('Малой. 1 с.');
    expect(stripTypePrefix('х/ф Ирония судьбы')).toBe('Ирония судьбы');
    expect(stripTypePrefix('м/ф Ну, погоди!')).toBe('Ну, погоди!');
  });

  test('leaves an unprefixed title alone', () => {
    expect(stripTypePrefix('Новости')).toBe('Новости');
  });

  test('does not eat a title that merely contains a slash', () => {
    expect(stripTypePrefix('Мужское / Женское')).toBe('Мужское / Женское');
  });
});

describe('decodeEntities', () => {
  test('resolves named and numeric forms', () => {
    expect(decodeEntities('Новости &amp; погода')).toBe('Новости & погода');
    expect(decodeEntities('&quot;Доброе утро&quot;')).toBe('"Доброе утро"');
    expect(decodeEntities('&#34;Доброе утро&#34;')).toBe('"Доброе утро"');
  });

  test('leaves an unknown entity untouched instead of mangling it', () => {
    expect(decodeEntities('&unknown;')).toBe('&unknown;');
  });

  test('does not resolve a name inherited from Object.prototype', () => {
    // The table used to be an object literal, so `ENTITIES['constructor']`
    // found a function on the prototype chain and `String.replace` stringified
    // it: a title containing `&constructor;` was stored, indexed and rendered
    // as «function Object() { [native code] }».
    expect(decodeEntities('Шоу &constructor; вечер')).toBe('Шоу &constructor; вечер');
    expect(decodeEntities('&hasOwnProperty;')).toBe('&hasOwnProperty;');
    expect(decodeEntities('&__proto__;')).toBe('&__proto__;');
  });

  test.each(['&#1114112;', '&#x110000;', '&#99999999;', '&#xFFFFFFFF;'])(
    'survives the out-of-range character reference %s',
    (entity) => {
      // `String.fromCodePoint` throws a RangeError above U+10FFFF, and the throw
      // escaped the whole scan: one such entity anywhere in 465 000 elements
      // aborted the run and left the guide frozen until the feed changed. The
      // rule everywhere else in this parser applies here too — one bad row
      // degrades to its literal text, it does not take the run with it.
      expect(() => decodeEntities(`Титр ${entity} конец`)).not.toThrow();
      expect(decodeEntities(`Титр ${entity} конец`)).toBe(`Титр ${entity} конец`);
    },
  );

  test('refuses a lone surrogate rather than storing a broken character', () => {
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
  });

  test('still resolves the highest code point that is actually valid', () => {
    // The bound is inclusive; clipping it one short would silently drop real
    // characters instead of real bugs.
    expect(decodeEntities('&#x10FFFF;')).toBe(String.fromCodePoint(0x10_ffff));
    expect(decodeEntities('&#x41;')).toBe('A');
  });
});

describe('scanXmltv', () => {
  test('keeps only the wanted channels', async () => {
    const { programmes } = await collect(FIXTURE.length);
    expect(programmes.map((p) => p.channelSlug)).toEqual(['tnt', 'tnt', 'matchtv']);
  });

  test('normalises a programme end to end', async () => {
    const { programmes } = await collect(FIXTURE.length);
    expect(programmes[0]).toEqual({
      channelSlug: 'tnt',
      startUtc: Date.UTC(2026, 7, 26, 17, 0, 0) / 1000,
      stopUtc: Date.UTC(2026, 7, 26, 17, 30, 0) / 1000,
      day: '2026-08-26',
      title: 'Малой. 1 с.',
      description: 'Описание серии',
    });
  });

  test('leaves description undefined when the feed omits it', async () => {
    const { programmes } = await collect(FIXTURE.length);
    expect(programmes[1]?.description).toBeUndefined();
    expect(programmes[1]?.title).toBe('Новости & погода');
  });

  test('collects every display-name, not just the first', async () => {
    // The startup assert depends on this: Матч ТВ leads with a regional alias.
    const { channels } = await collect(FIXTURE.length);
    const match = channels.find((c) => c.id === '2051');
    expect(match?.names).toEqual(['МАТЧ! +0 (Белгород)', 'Матч ТВ']);
  });

  test.each([1, 7, 64, 500, 4096])('produces identical output at chunk size %i', async (chunkSize) => {
    // Regression guard: an element split across two stream reads must not be
    // dropped. Losing one this way is silent — the page just misses a row.
    const { channels, programmes } = await collect(chunkSize);
    expect(programmes).toHaveLength(3);
    expect(channels).toHaveLength(3);
    expect(programmes[0]?.title).toBe('Малой. 1 с.');
    expect(programmes[2]?.channelSlug).toBe('matchtv');
  });
});
