import type { SourceName } from './sources.ts';

/** One of the twenty terrestrial channels. */
export interface Channel {
  /** Ours, stable, appears in URLs. Never taken from the feed. */
  readonly slug: string;
  /**
   * The feed's own key, per feed. Neither is ours and neither is stable, so
   * both are pinned by hand and both are guarded by `expectName`.
   *
   * Typed against the whole `SourceName` union rather than an index signature,
   * which is what makes an unfilled id a build failure instead of a fallback
   * that silently resolves nothing.
   */
  readonly sourceIds: Readonly<Record<SourceName, string>>;
  /** Display name we render. */
  readonly name: string;
  /** Must appear among a feed's aliases for our pinned id, or ingest aborts. */
  readonly expectName: string;
  /** 1 = РТРС-1, 2 = РТРС-2. Which terrestrial multiplex carries the channel. */
  readonly mux: 1 | 2;
}

/**
 * The twenty channels of the two Russian terrestrial multiplexes, in broadcast
 * button order (РТРС-1 is buttons 1-10, РТРС-2 is 11-20).
 *
 * The ids are each feed's own key and neither kind has a stability guarantee.
 * epg.one uses opaque integers; iptvx.one uses slugs, which are readable but no
 * more promised — and its slugs are not ours (`five` is `5kanal-ru` there,
 * `tvc` is `tvcentr`, `domashniy` is `domashny`), so they cannot be derived and
 * are pinned like the integers.
 *
 * `expectName` guards both pins: every ingest asserts that the id it is about
 * to read still carries this name among its aliases *in the feed being read*,
 * so a silent renumbering upstream fails loudly instead of quietly blanking a
 * column.
 *
 * The assert must test membership in the whole alias set, never equality with
 * the first `<display-name>`: measured on the live feeds, five channels lead
 * with their plain name but Матч ТВ leads with 'МАТЧ! +0 (Белгород)' on epg.one
 * and with 'Матч!' on iptvx.one, carrying 'Матч ТВ' and 'Матч! ТВ' among the
 * aliases respectively.
 *
 * `slug` is ours, lives in URLs and in the favourites list, and must survive an
 * upstream renumbering untouched.
 */
export const CHANNELS: readonly Channel[] = [
  {
    slug: 'pervy',
    sourceIds: { 'epg.one': '146', 'iptvx.one': 'pervy' },
    name: 'Первый канал',
    expectName: 'Первый канал',
    mux: 1,
  },
  {
    slug: 'rossia1',
    sourceIds: { 'epg.one': '711', 'iptvx.one': 'rossia1' },
    name: 'Россия 1',
    expectName: 'Россия 1',
    mux: 1,
  },
  {
    slug: 'matchtv',
    sourceIds: { 'epg.one': '2051', 'iptvx.one': 'match-tv' },
    name: 'Матч ТВ',
    expectName: 'Матч ТВ',
    mux: 1,
  },
  { slug: 'ntv', sourceIds: { 'epg.one': '162', 'iptvx.one': 'ntv' }, name: 'НТВ', expectName: 'НТВ', mux: 1 },
  {
    slug: 'five',
    sourceIds: { 'epg.one': '427', 'iptvx.one': '5kanal-ru' },
    name: 'Пятый канал',
    expectName: 'Пятый канал',
    mux: 1,
  },
  {
    slug: 'kultura',
    sourceIds: { 'epg.one': '187', 'iptvx.one': 'kultura' },
    name: 'Россия К',
    expectName: 'Россия К',
    mux: 1,
  },
  {
    slug: 'rossia24',
    sourceIds: { 'epg.one': '1683', 'iptvx.one': 'rossia-24' },
    name: 'Россия 24',
    expectName: 'Россия 24',
    mux: 1,
  },
  {
    slug: 'karusel',
    sourceIds: { 'epg.one': '740', 'iptvx.one': 'karusel' },
    name: 'Карусель',
    expectName: 'Карусель',
    mux: 1,
  },
  { slug: 'otr', sourceIds: { 'epg.one': '1000', 'iptvx.one': 'otr' }, name: 'ОТР', expectName: 'ОТР', mux: 1 },
  {
    slug: 'tvc',
    sourceIds: { 'epg.one': '649', 'iptvx.one': 'tvcentr' },
    name: 'ТВ Центр',
    expectName: 'ТВ Центр',
    mux: 1,
  },
  { slug: 'ren', sourceIds: { 'epg.one': '18', 'iptvx.one': 'rentv' }, name: 'РЕН ТВ', expectName: 'РЕН ТВ', mux: 2 },
  { slug: 'spas', sourceIds: { 'epg.one': '2141', 'iptvx.one': 'spas' }, name: 'Спас', expectName: 'Спас', mux: 2 },
  { slug: 'sts', sourceIds: { 'epg.one': '79', 'iptvx.one': 'sts' }, name: 'СТС', expectName: 'СТС', mux: 2 },
  {
    slug: 'domashniy',
    sourceIds: { 'epg.one': '304', 'iptvx.one': 'domashny' },
    name: 'Домашний',
    expectName: 'Домашний',
    mux: 2,
  },
  { slug: 'tv3', sourceIds: { 'epg.one': '698', 'iptvx.one': 'tv3-ru' }, name: 'ТВ-3', expectName: 'ТВ-3', mux: 2 },
  {
    slug: 'pyatnica',
    sourceIds: { 'epg.one': '1003', 'iptvx.one': 'piatnica' },
    name: 'Пятница!',
    expectName: 'Пятница!',
    mux: 2,
  },
  {
    slug: 'zvezda',
    sourceIds: { 'epg.one': '405', 'iptvx.one': 'zvezda' },
    name: 'Звезда',
    expectName: 'Звезда',
    mux: 2,
  },
  { slug: 'mir', sourceIds: { 'epg.one': '726', 'iptvx.one': 'mir' }, name: 'Мир', expectName: 'Мир', mux: 2 },
  { slug: 'tnt', sourceIds: { 'epg.one': '353', 'iptvx.one': 'tnt' }, name: 'ТНТ', expectName: 'ТНТ', mux: 2 },
  {
    slug: 'muztv',
    sourceIds: { 'epg.one': '897', 'iptvx.one': 'muztv' },
    name: 'Муз-ТВ',
    expectName: 'Муз-ТВ',
    mux: 2,
  },
];

/**
 * Pinned to the top of the guide until the visitor stars something themselves.
 *
 * Every channel is on the page regardless, so this is a starting order and not
 * a filter — which is why two is enough. Unstarring both is a legitimate
 * choice and leaves twenty columns in broadcast order.
 */
export const DEFAULT_FAVOURITES: readonly string[] = ['tnt', 'matchtv'];

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

/**
 * Feed id -> our slug, for the source about to be read.
 *
 * A function rather than a constant, because there is no such thing as *the*
 * id map: each feed has its own, and handing epg.one's integers to iptvx.one is
 * exactly the bug that made the fallback unreachable. Twenty entries built once
 * per ingest run cost nothing.
 */
export function sourceIndex(source: SourceName): ReadonlyMap<string, string> {
  return new Map(CHANNELS.map((channel) => [channel.sourceIds[source], channel.slug]));
}
