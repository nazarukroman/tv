import type { FeedSource } from '../lib/fetch.ts';

/**
 * Where the schedule comes from, in order of preference.
 *
 * Both are free XMLTV files rather than an API with a contract, which is the
 * honest state of affairs for these channels — no broadcaster publishes one.
 * Two independent sources on two CDNs is the redundancy actually available;
 * the fallback is operational, not editorial, since both may draw on the same
 * upstream and could go stale together.
 */
export const SOURCES: readonly FeedSource[] = [
  // 15-day window, times already +0300, half the payload of the alternative.
  { name: 'epg.one', url: 'https://cdn.epg.one/ru.xml.gz' },
  // Readable slug ids, so it survives a renumbering that would break the primary.
  { name: 'iptvx.one', url: 'https://epg.iptvx.one/epg_noarch.xml.gz' },
];

/**
 * Below this the run is treated as degraded and refused.
 *
 * Twenty channels over the window measured 7590 programmes; a third of that is
 * low enough never to trip on a normal short day and high enough to catch a
 * truncated transfer, which arrives looking like a valid short document.
 */
export const MIN_PROGRAMMES = 2500;

/** Programmes that ended more than this long ago are dropped on each run. */
export const RETENTION_DAYS = 3;
