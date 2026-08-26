/**
 * Fetching the XMLTV feed, cheaply and without inheriting the upstream's cache
 * headers.
 *
 * Two things here are not obvious and are both load-bearing.
 *
 * First, the feed answers with `Cache-Control: max-age=16070400` — 186 days.
 * Any transparent cache on the way out is entitled to serve a half-year-old
 * copy, and from the outside that looks exactly like "the source stopped
 * updating". Every request therefore carries `Cache-Control: no-cache`.
 *
 * Second, the body is 25 MB gzipped and ~150 MB of XML. It is never buffered:
 * `DecompressionStream` and `TextDecoderStream` turn the response into a
 * character stream that the scanner consumes incrementally.
 */

/** How long to wait for the first byte before giving up on a source. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The whole `<channel>` section fits well inside this prefix — measured at
 * 3256 channels ending long before 1.5 MB of the archive. Validating the
 * pinned ids therefore costs a Range request, not a 25 MB download.
 */
const CHANNEL_PREFIX_BYTES = 1_500_000;

export interface FeedSource {
  /** Short name for logs and metrics, e.g. 'epg.one'. */
  readonly name: string;
  readonly url: string;
}

/** What the previous successful run saw, so this one can ask for a 304. */
export interface CacheValidators {
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
}

export interface FeedResponse {
  readonly notModified: boolean;
  /** Absent when `notModified` is true. */
  readonly text: ReadableStream<string> | undefined;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
}

function conditionalHeaders(validators: CacheValidators): Headers {
  const headers = new Headers({
    // Defeats any intermediary honouring the feed's 186-day max-age.
    'cache-control': 'no-cache',
    'accept-encoding': 'gzip',
  });

  if (validators.etag !== undefined) {
    headers.set('if-none-match', validators.etag);
  }
  if (validators.lastModified !== undefined) {
    headers.set('if-modified-since', validators.lastModified);
  }

  return headers;
}

/**
 * Turns a gzipped response body into a character stream.
 *
 * `fetch` transparently decompresses when it negotiated the encoding itself,
 * so the pipeline only inserts a gunzip step when the payload is still
 * compressed — which it is here, the file being served as a `.gz` object
 * rather than a gzip-encoded response.
 */
function decodeBody(response: Response): ReadableStream<string> {
  const body = response.body;
  if (body === null) {
    throw new Error('feed: response had no body');
  }

  const encoding = response.headers.get('content-encoding')?.toLowerCase() ?? '';
  const looksGzipped = encoding === '' && /\.gz(\?|$)/.test(new URL(response.url).pathname);

  const bytes = looksGzipped ? body.pipeThrough(new DecompressionStream('gzip')) : body;
  // UTF-8 is the default and the only encoding the feed declares.
  return bytes.pipeThrough(new TextDecoderStream());
}

/**
 * Conditionally fetches the feed.
 *
 * A 304 comes back as `notModified: true` with no body — the caller should
 * keep whatever it already stored rather than rewriting it.
 */
export async function fetchFeed(source: FeedSource, validators: CacheValidators): Promise<FeedResponse> {
  const response = await fetch(source.url, {
    headers: conditionalHeaders(validators),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'follow',
  });

  if (response.status === 304) {
    // Drain nothing: a 304 has no body, but the connection is still ours to release.
    await response.body?.cancel();
    return {
      notModified: true,
      text: undefined,
      etag: validators.etag,
      lastModified: validators.lastModified,
    };
  }

  if (!response.ok) {
    throw new Error(`feed ${source.name}: HTTP ${response.status} ${response.statusText}`);
  }

  return {
    notModified: false,
    text: decodeBody(response),
    etag: response.headers.get('etag') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined,
  };
}

/**
 * Fetches only the leading bytes of the archive — enough to carry the entire
 * `<channel>` section — so the pinned-id assertion does not cost a full
 * download.
 *
 * A server that ignores `Range` answers 200 with the whole body; that still
 * works, it is merely wasteful, so this is not treated as an error.
 */
export async function fetchChannelPrefix(source: FeedSource): Promise<ReadableStream<string>> {
  const response = await fetch(source.url, {
    headers: new Headers({
      'cache-control': 'no-cache',
      range: `bytes=0-${CHANNEL_PREFIX_BYTES - 1}`,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'follow',
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`feed ${source.name}: HTTP ${response.status} on channel prefix`);
  }

  return decodeBody(response);
}
