import { CHANNELS, SOURCE_ID_TO_SLUG } from './config/channels.ts';
import { MIN_PROGRAMMES, RETENTION_DAYS, SOURCES } from './config/sources.ts';
import { openDatabase } from './db/schema.ts';
import {
  countProgrammes,
  finishRun,
  lastValidators,
  pruneBefore,
  replaceProgrammes,
  SanityError,
  startRun,
} from './db/store.ts';
import { matchesChannel } from './lib/channel-name.ts';
import { fetchFeed } from './lib/fetch.ts';
import { scanXmltv } from './lib/xmltv.ts';

import type { Database } from 'bun:sqlite';

import type { FeedSource } from './lib/fetch.ts';
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
 * Fails the run when a pinned `sourceId` no longer carries the name we expect.
 *
 * This is the guard on the weakest part of the arrangement: epg.one's ids are
 * opaque integers with no stability promise. Without it, a renumbering
 * upstream would present as an empty column — working software showing
 * nothing, which is far worse than a loud failure.
 */
function assertChannels(aliases: ReadonlyMap<string, readonly string[]>): void {
  const problems: string[] = [];

  for (const channel of CHANNELS) {
    const names = aliases.get(channel.sourceId);
    if (names === undefined) {
      problems.push(`${channel.slug}: id ${channel.sourceId} absent from the feed`);
      continue;
    }
    if (!matchesChannel(channel.expectName, names)) {
      problems.push(
        `${channel.slug}: id ${channel.sourceId} no longer looks like «${channel.expectName}» (aliases: ${names.slice(0, 4).join(', ')})`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`channel mapping is stale:\n  ${problems.join('\n  ')}`);
  }
}

interface ScanOutcome {
  readonly programmes: Programme[];
  readonly aliases: Map<string, readonly string[]>;
}

/**
 * `minStopUtc` drops the archive tail during the scan rather than after the
 * write. The feed carries D-8 but retention keeps three days, so importing
 * everything meant inserting roughly a third of the rows only to delete them
 * again on the very same run.
 */
async function scanFeed(text: ReadableStream<string>, minStopUtc: number): Promise<ScanOutcome> {
  const programmes: Programme[] = [];
  const aliases = new Map<string, readonly string[]>();

  await scanXmltv(text, SOURCE_ID_TO_SLUG, {
    onChannel: (channel) => {
      if (SOURCE_ID_TO_SLUG.has(channel.id)) {
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

export async function ingestFrom(db: Database, source: FeedSource): Promise<void> {
  const runId = startRun(db, source.name, nowUtc());

  try {
    const validators = lastValidators(db, source.name);
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
    const { programmes, aliases } = await scanFeed(response.text, cutoffUtc);
    // Validate the mapping before touching stored data, never after.
    assertChannels(aliases);

    const summary = replaceProgrammes(db, programmes, MIN_PROGRAMMES);
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
    const message = error instanceof Error ? error.message : String(error);
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
 * Tries each source in order, stopping at the first that succeeds.
 *
 * A `SanityError` is deliberately not fatal to the whole run: it means this
 * source answered with something degraded, which is exactly when the fallback
 * earns its place.
 */
export async function ingest(db: Database): Promise<void> {
  const failures: string[] = [];

  for (const source of SOURCES) {
    try {
      await ingestFrom(db, source);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${source.name}: ${message}`);
      console.error(`${source.name} failed: ${message}`);
      if (!(error instanceof SanityError) && !(error instanceof Error)) {
        throw error;
      }
    }
  }

  throw new Error(`every source failed:\n  ${failures.join('\n  ')}`);
}

if (import.meta.main) {
  const path = process.env.TV_DB ?? DEFAULT_DB_PATH;
  const db = openDatabase(path);
  try {
    await ingest(db);
  } finally {
    db.close();
  }
}
