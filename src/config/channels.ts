import type { Channel } from '../lib/types.ts';

/**
 * The twenty channels of the two Russian terrestrial multiplexes, in broadcast
 * button order (РТРС-1 is buttons 1-10, РТРС-2 is 11-20).
 *
 * `sourceId` is epg.one's own key and is an opaque integer with no stability
 * guarantee — it is pinned here rather than resolved by name at runtime.
 * `expectName` guards that pin: every ingest asserts the id still carries this
 * name among its aliases, so a silent renumbering upstream fails loudly instead
 * of quietly blanking a column.
 *
 * The assert must test membership in the whole alias set, never equality with
 * the first `<display-name>`: measured on the live feed, five channels lead
 * with their plain name but Матч ТВ leads with 'МАТЧ! +0 (Белгород)' and
 * carries 'Матч ТВ' as one of 32 aliases.
 *
 * `slug` is ours, lives in URLs and in the favourites list, and must survive an
 * upstream renumbering untouched.
 */
export const CHANNELS: readonly Channel[] = [
  { slug: 'pervy', sourceId: '146', name: 'Первый канал', expectName: 'Первый канал', mux: 1 },
  { slug: 'rossia1', sourceId: '711', name: 'Россия 1', expectName: 'Россия 1', mux: 1 },
  { slug: 'matchtv', sourceId: '2051', name: 'Матч ТВ', expectName: 'Матч ТВ', mux: 1 },
  { slug: 'ntv', sourceId: '162', name: 'НТВ', expectName: 'НТВ', mux: 1 },
  { slug: 'five', sourceId: '427', name: 'Пятый канал', expectName: 'Пятый канал', mux: 1 },
  { slug: 'kultura', sourceId: '187', name: 'Россия К', expectName: 'Россия К', mux: 1 },
  { slug: 'rossia24', sourceId: '1683', name: 'Россия 24', expectName: 'Россия 24', mux: 1 },
  { slug: 'karusel', sourceId: '740', name: 'Карусель', expectName: 'Карусель', mux: 1 },
  { slug: 'otr', sourceId: '1000', name: 'ОТР', expectName: 'ОТР', mux: 1 },
  { slug: 'tvc', sourceId: '649', name: 'ТВ Центр', expectName: 'ТВ Центр', mux: 1 },
  { slug: 'ren', sourceId: '18', name: 'РЕН ТВ', expectName: 'РЕН ТВ', mux: 2 },
  { slug: 'spas', sourceId: '2141', name: 'Спас', expectName: 'Спас', mux: 2 },
  { slug: 'sts', sourceId: '79', name: 'СТС', expectName: 'СТС', mux: 2 },
  { slug: 'domashniy', sourceId: '304', name: 'Домашний', expectName: 'Домашний', mux: 2 },
  { slug: 'tv3', sourceId: '698', name: 'ТВ-3', expectName: 'ТВ-3', mux: 2 },
  { slug: 'pyatnica', sourceId: '1003', name: 'Пятница!', expectName: 'Пятница!', mux: 2 },
  { slug: 'zvezda', sourceId: '405', name: 'Звезда', expectName: 'Звезда', mux: 2 },
  { slug: 'mir', sourceId: '726', name: 'Мир', expectName: 'Мир', mux: 2 },
  { slug: 'tnt', sourceId: '353', name: 'ТНТ', expectName: 'ТНТ', mux: 2 },
  { slug: 'muztv', sourceId: '897', name: 'Муз-ТВ', expectName: 'Муз-ТВ', mux: 2 },
];

/** Shown when the visitor has picked no favourites yet. */
export const DEFAULT_FAVOURITES: readonly string[] = ['pervy', 'rossia1', 'ntv', 'tnt', 'sts', 'matchtv'];

/**
 * The channel's identity colour, as an OKLCH hue in degrees.
 *
 * Spread evenly around the wheel by position rather than picked per channel,
 * and deliberately so: these are wayfinding marks that must stay apart from
 * each other, not brand colours. Hand-picking twenty would collide — six of
 * these broadcasters use much the same red — and a hash of the slug collides
 * by chance. Lightness and chroma come from the theme, so only the hue lives
 * here; the stylesheet assembles the colour.
 *
 * The cost of deriving from position is that inserting a channel mid-list
 * reshuffles every colour after it. Acceptable: the list is the two fixed
 * terrestrial multiplexes and has not changed since 2019.
 */
export function channelHue(index: number): number {
  return (10 + index * 18) % 360;
}

/** epg.one source id -> our slug. The lookup the parser hits once per programme. */
export const SOURCE_ID_TO_SLUG: ReadonlyMap<string, string> = new Map(
  CHANNELS.map((channel) => [channel.sourceId, channel.slug]),
);

/** Slug -> channel, for rendering and for validating a favourites list. */
export const BY_SLUG: ReadonlyMap<string, Channel> = new Map(CHANNELS.map((channel) => [channel.slug, channel]));
