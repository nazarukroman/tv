import { CHANNELS, sourceIndex } from './config/channels.ts';
import { MIN_PROGRAMMES, RETENTION_DAYS, SOURCES } from './config/sources.ts';
import { openDatabase } from './db/schema.ts';
import {
  countProgrammes,
  finishRun,
  lastValidators,
  provenance,
  pruneBefore,
  replaceProgrammes,
  startRun,
} from './db/store.ts';
import { matchesChannel } from './lib/channel-name.ts';
import { fetchFeed } from './lib/fetch.ts';
import { scanXmltv } from './lib/xmltv.ts';

import type { Database } from 'bun:sqlite';

import type { Source, SourceName } from './config/sources.ts';
import type { Programme } from './lib/types.ts';

/**
 * One ingest run: fetch conditionally, scan, validate, replace.
 *
 * Nothing here is triggered by a page view. The guide serves what it already
 * stored, so an upstream outage costs freshness rather than availability.
 */

const DEFAULT_DB_PATH = './data/tv.db';

function nowUtc(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Fails the run when a pinned id no longer carries the name we expect *in the
 * feed being read*.
 *
 * This is the guard on the weakest part of the arrangement: neither feed's ids
 * are promised to us. Without it, a renumbering upstream would present as an
 * empty column — working software showing nothing, which is far worse than a
 * loud failure.
 *
 * The `source` parameter is not decoration. While there was one global id map,
 * every id checked here was epg.one's, so this assertion could not pass against
 * the fallback feed under any circumstances: it reported all twenty channels
 * missing and took the run down with it.
 */
export function assertChannels(source: SourceName, aliases: ReadonlyMap<string, readonly string[]>): void {
  const problems: string[] = [];

  for (const channel of CHANNELS) {
    const id = channel.sourceIds[source];
    const names = aliases.get(id);
    if (names === undefined) {
      problems.push(`${channel.slug}: id ${id} absent from the feed`);
      continue;
    }
    if (!matchesChannel(channel.expectName, names)) {
      problems.push(
        `${channel.slug}: id ${id} no longer looks like «${channel.expectName}» (aliases: ${names.slice(0, 4).join(', ')})`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`channel mapping is stale for ${source}:\n  ${problems.join('\n  ')}`);
  }
}

interface ScanOutcome {
  readonly programmes: Programme[];
  readonly aliases: Map<string, readonly string[]>;
}

/**
 * `minStopUtc` drops the archive tail during the scan rather than after the
 * write. The primary feed carries D-8 but retention keeps three days, so
 * importing everything meant inserting roughly a third of the rows only to
 * delete them again on the very same run.
 */
async function scanFeed(
  text: ReadableStream<string>,
  wanted: ReadonlyMap<string, string>,
  minStopUtc: number,
): Promise<ScanOutcome> {
  const programmes: Programme[] = [];
  const aliases = new Map<string, readonly string[]>();

  await scanXmltv(text, wanted, {
    onChannel: (channel) => {
      if (wanted.has(channel.id)) {
        aliases.set(channel.id, channel.names);
      }
    },
    onProgramme: (programme) => {
      if (programme.stopUtc >= minStopUtc) {
        programmes.push(programme);
      }
    },
  });

  return { programmes, aliases };
}

export async function ingestFrom(db: Database, source: Source): Promise<void> {
  const runId = startRun(db, source.name, nowUtc());

  try {
    // A 304 is only safe to honour when the rows we hold came from *this* feed.
    // After a fallback run the database holds the other one's data, and epg.one
    // answering "your copy of my file is current" would be true and useless: it
    // would keep the fallback's guide in place for as long as the primary's file
    // sat unchanged, which is exactly when the primary has recovered.
    const mine = provenance(db).source === source.name;
    const validators = mine ? lastValidators(db, source.name) : { etag: undefined, lastModified: undefined };
    const response = await fetchFeed(source, validators);

    if (response.notModified || response.text === undefined) {
      finishRun(db, runId, nowUtc(), {
        ok: true,
        notModified: true,
        programmes: 0,
        horizonUtc: undefined,
        etag: response.etag,
        lastModified: response.lastModified,
        error: undefined,
      });
      console.log(`${source.name}: not modified, kept ${countProgrammes(db)} stored programmes`);
      return;
    }

    const cutoffUtc = nowUtc() - RETENTION_DAYS * 86_400;
    const { programmes, aliases } = await scanFeed(response.text, sourceIndex(source.name), cutoffUtc);
    // Validate the mapping before touching stored data, never after.
    assertChannels(source.name, aliases);

    const summary = replaceProgrammes(db, programmes, MIN_PROGRAMMES[source.name]);
    // Clears rows that aged out since the last run; the scan already excluded
    // anything older, so this normally removes nothing.
    const pruned = pruneBefore(db, cutoffUtc);

    finishRun(db, runId, nowUtc(), {
      ok: true,
      notModified: false,
      programmes: summary.programmes,
      horizonUtc: summary.horizonUtc,
      etag: response.etag,
      lastModified: response.lastModified,
      error: undefined,
    });

    const horizon = new Date(summary.horizonUtc * 1000).toISOString().slice(0, 10);
    console.log(
      `${source.name}: ${summary.programmes} programmes, ${summary.channels} channels, ` +
        `${summary.days} days, horizon ${horizon}, pruned ${pruned}`,
    );
  } catch (error) {
    // The whole chain, not just the outermost message: a network failure
    // arrives wrapped, and «request failed» on its own says nothing at all.
    const message = describe(error);
    finishRun(db, runId, nowUtc(), {
      ok: false,
      notModified: false,
      programmes: 0,
      horizonUtc: undefined,
      etag: undefined,
      lastModified: undefined,
      error: message,
    });
    throw error;
  }
}

/**
 * `Error: outer` plus every `cause` beneath it, so a wrapped failure still reads.
 *
 * Bounded, because nothing guarantees an error someone else constructed has an
 * acyclic cause chain, and this runs on the path that is supposed to report the
 * problem rather than become one.
 */
function describe(error: unknown, depth = 4): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const chain: string[] = [error.message];
  let cause = error.cause;
  while (cause instanceof Error && chain.length < depth) {
    chain.push(cause.message);
    cause = cause.cause;
  }
  return chain.join(': ');
}

/**
 * Tries each source in order, stopping at the first that succeeds.
 *
 * Any `Error` from one source is non-fatal and the next is tried — an
 * unreachable host, a stale pin and a suspiciously short document are all cases
 * where the other feed is worth asking. Only a non-`Error` throw, which means a
 * bug rather than a bad response, is re-raised immediately.
 *
 * The previous version singled out `SanityError` in that condition, which read
 * as a policy but was not one: `SanityError extends Error`, so the clause could
 * never change the outcome.
 *
 * Returns the source that answered, which is what the footer and the staleness
 * banner report — a guide built from the fallback should say so.
 */
export async function ingest(db: Database): Promise<SourceName> {
  const failures: string[] = [];

  for (const source of SOURCES) {
    try {
      await ingestFrom(db, source);
      return source.name;
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      const message = describe(error);
      failures.push(`${source.name}: ${message}`);
      console.error(`${source.name} failed: ${message}`);
    }
  }

  throw new Error(`every source failed:\n  ${failures.join('\n  ')}`);
}

if (import.meta.main) {
  const path = process.env.TV_DB ?? DEFAULT_DB_PATH;
  const db = openDatabase(path);
  try {
    const source = await ingest(db);
    if (source !== SOURCES[0]?.name) {
      console.warn(`primary source unavailable, guide built from ${source}`);
    }
  } finally {
    db.close();
  }
}
