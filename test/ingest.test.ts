import { describe, expect, test } from 'bun:test';

import { CHANNELS, sourceIndex } from '../src/config/channels.ts';
import { MIN_PROGRAMMES, SOURCE_NAMES, SOURCES } from '../src/config/sources.ts';
import { assertChannels } from '../src/ingest.ts';

/**
 * The guard on the weakest part of the whole arrangement.
 *
 * Neither feed promises us its ids. If one renumbers, the only two outcomes are
 * a loud failure and a silently empty column, and this is what decides which.
 * It was also the piece that made the fallback unreachable: while there was one
 * global id map, this assertion checked epg.one's integers against whichever
 * feed was being read, so against the secondary it reported all twenty channels
 * missing and took the run down every time.
 */

/** The aliases a healthy feed would carry for `source`, straight from the pins. */
function healthyAliases(source: (typeof SOURCE_NAMES)[number]): Map<string, readonly string[]> {
  return new Map(CHANNELS.map((channel) => [channel.sourceIds[source], [channel.expectName]]));
}

describe('assertChannels', () => {
  test.each([...SOURCE_NAMES])('passes against a healthy %s feed', (source) => {
    expect(() => assertChannels(source, healthyAliases(source))).not.toThrow();
  });

  test('rejects the other feed’s ids, which is exactly what used to happen', () => {
    // Hand epg.one's integers to the iptvx.one check and every channel is
    // missing. This is the shape of the bug, pinned so it cannot come back by
    // way of a single shared map.
    const [primary, fallback] = SOURCE_NAMES;
    expect(() => assertChannels(fallback, healthyAliases(primary))).toThrow(/channel mapping is stale for iptvx\.one/);
  });

  test('names every channel it could not resolve, not just the first', () => {
    // The message is the whole diagnostic — an operator reads it and nothing
    // else. Reporting one line at a time turns one renumbering into twenty runs.
    const aliases = healthyAliases('epg.one');
    aliases.delete(CHANNELS[0]!.sourceIds['epg.one']);
    aliases.delete(CHANNELS[1]!.sourceIds['epg.one']);

    expect(() => assertChannels('epg.one', aliases)).toThrow(
      new RegExp(`${CHANNELS[0]!.slug}[\\s\\S]*${CHANNELS[1]!.slug}`),
    );
  });

  test('rejects an id that now carries a different channel', () => {
    // The dangerous case: the id resolves, so nothing looks broken, but the
    // column would quietly fill with another broadcaster's schedule.
    const aliases = healthyAliases('epg.one');
    aliases.set(CHANNELS[0]!.sourceIds['epg.one'], ['Совсем другой канал']);

    expect(() => assertChannels('epg.one', aliases)).toThrow(/no longer looks like/);
  });

  test('accepts a decorated alias, since a plain name is often absent', () => {
    // Measured on the live feed: id 146 went from nine aliases led by «Первый
    // канал» to seven led by «Первый FHD», with no bare name at all.
    const aliases = new Map(
      CHANNELS.map((channel) => [channel.sourceIds['epg.one'], [`${channel.expectName} HD`, 'Что-то ещё']]),
    );
    expect(() => assertChannels('epg.one', aliases)).not.toThrow();
  });
});

describe('source configuration', () => {
  test('every configured source has a floor and a distinct url', () => {
    for (const source of SOURCES) {
      expect(MIN_PROGRAMMES[source.name]).toBeGreaterThan(0);
      expect(source.url.startsWith('https://')).toBe(true);
    }
    expect(new Set(SOURCES.map((source) => source.url)).size).toBe(SOURCES.length);
  });

  test('SOURCES covers exactly the names the channel pins are typed against', () => {
    // The type makes an unfilled id a build error; this makes a source declared
    // in the union but never listed — which would be a fallback nothing ever
    // tries — a test failure.
    expect(SOURCES.map((source) => source.name).sort()).toEqual([...SOURCE_NAMES].sort());
  });

  test('each feed resolves every channel through its own id map', () => {
    for (const source of SOURCE_NAMES) {
      const index = sourceIndex(source);
      expect(new Set(index.values())).toEqual(new Set(CHANNELS.map((channel) => channel.slug)));
    }
  });
});
