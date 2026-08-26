/** One of the twenty terrestrial channels, as configured in `config/channels.ts`. */
export interface Channel {
  /** Ours, stable, appears in URLs. Never taken from the feed. */
  readonly slug: string;
  /** epg.one's opaque integer key, pinned by hand. */
  readonly sourceId: string;
  /** Display name we render. */
  readonly name: string;
  /** Must appear among the feed's aliases for `sourceId`, or ingest aborts. */
  readonly expectName: string;
  /** 1 = РТРС-1, 2 = РТРС-2. Groups the channel picker. */
  readonly mux: 1 | 2;
}

/** One broadcast, normalised. Only the fields the guide actually renders. */
export interface Programme {
  readonly channelSlug: string;
  /** Unix seconds. */
  readonly startUtc: number;
  readonly stopUtc: number;
  /** Moscow calendar day, `YYYY-MM-DD`. The day a viewer would look under. */
  readonly day: string;
  readonly title: string;
  /** Absent on 3-27% of programmes depending on channel — never assume it. */
  readonly description: string | undefined;
}

/** Every `<display-name>` the feed carries for one channel id. */
export interface ChannelRecord {
  readonly id: string;
  readonly names: readonly string[];
}

/** What one ingest run learned, for the staleness alert and for observability. */
export interface IngestResult {
  readonly source: string;
  /** True when the upstream answered 304 and nothing was rewritten. */
  readonly notModified: boolean;
  readonly programmes: number;
  readonly channels: number;
  /** Latest `stopUtc` in the snapshot — the horizon the alert watches. */
  readonly horizonUtc: number;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
}
