/**
 * Where the schedule comes from, in order of preference.
 *
 * Both are free XMLTV files rather than an API with a contract, which is the
 * honest state of affairs for these channels — no broadcaster publishes one.
 * Two independent sources on two CDNs is the redundancy actually available;
 * the fallback is operational, not editorial, since both may draw on the same
 * upstream and could go stale together.
 *
 * The two feeds do not agree on how a channel is named, and that is the whole
 * reason `SOURCE_NAMES` exists as a type rather than a string. Every channel in
 * `config/channels.ts` must declare an id for every name listed here, and the
 * type checker enforces it: adding a third feed fails the build until all
 * twenty ids are filled in. The previous arrangement — one `sourceId` per
 * channel, implicitly epg.one's — compiled perfectly and left the fallback
 * unable to resolve a single channel, so it could never once have worked.
 */
export const SOURCE_NAMES = ['epg.one', 'iptvx.one'] as const;

export type SourceName = (typeof SOURCE_NAMES)[number];

export interface Source {
  readonly name: SourceName;
  readonly url: string;
}

export const SOURCES: readonly Source[] = [
  // 15-day window, times already +0300, half the payload of the alternative.
  { name: 'epg.one', url: 'https://cdn.epg.one/ru.xml.gz' },
  // Readable slug ids, so it survives a renumbering that would break the primary.
  { name: 'iptvx.one', url: 'https://epg.iptvx.one/epg_noarch.xml.gz' },
];

/**
 * Below this the run is treated as degraded and refused.
 *
 * Per source, because the two do not carry the same amount. Measured on the live
 * feeds after the retention cutoff, for our twenty channels: epg.one keeps 4739
 * programmes over ten days, iptvx.one 3863 over eight — its `epg_noarch` file is
 * exactly what the name says and carries no archive tail.
 *
 * One shared floor would have to be either low enough to miss a truncated
 * epg.one transfer or high enough to reject a healthy iptvx run, and the second
 * mistake is the dangerous one: it would refuse the fallback precisely when the
 * fallback is the only thing left.
 *
 * Each is a little over half of what that source actually delivers — low enough
 * never to trip on a short day, high enough to catch a transfer cut short, which
 * arrives looking like a valid short document.
 */
export const MIN_PROGRAMMES: Readonly<Record<SourceName, number>> = {
  'epg.one': 2500,
  'iptvx.one': 2000,
};

/** Programmes that ended more than this long ago are dropped on each run. */
export const RETENTION_DAYS = 3;
