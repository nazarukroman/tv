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
