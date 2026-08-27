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

/**
 * Connect and headers. Short on purpose: this is the phase where a dead host
 * shows itself, and every second spent here is a second the fallback is not
 * being tried.
 */
const HEADERS_TIMEOUT_MS = 20_000;

/**
 * The body, once headers are in. Generous on purpose, and separate from the
 * budget above for a reason paid for in a real failure: one 60-second deadline
 * covering both phases aborted a perfectly healthy download of the secondary
 * feed mid-stream, which surfaced as "the source is unreachable" when the
 * source was answering fine and simply had more bytes than epg.one.
 *
 * A slow transfer that never finishes is not a hang: this runs twice a day in
 * the background, the guide keeps serving throughout, and the scheduler retries.
 */
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

/**
 * The two things fetching needs to know about a feed.
 *
 * Declared here rather than imported from `config/`, so that this module stays
 * a library the configuration uses and not the other way round. `Source` in
 * `config/sources.ts` satisfies it structurally.
 */
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
 * A pass-through whose only job is to say when the body has been read to the end.
 *
 * The transfer deadline has to be cancelled by whoever finishes reading, and
 * that is the caller, several modules away. Hanging it off the end of the
 * stream keeps the timer's lifetime tied to the thing it is timing.
 */
function onStreamEnd<T>(done: () => void): TransformStream<T, T> {
  return new TransformStream<T, T>({ flush: done });
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
  const controller = new AbortController();
  let timer = setTimeout(
    () => controller.abort(new Error(`feed ${source.name}: no response headers within ${HEADERS_TIMEOUT_MS} ms`)),
    HEADERS_TIMEOUT_MS,
  );
  const clear = (): void => clearTimeout(timer);

  let response: Response;
  try {
    response = await fetch(source.url, {
      headers: conditionalHeaders(validators),
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (error) {
    clear();
    // `cause` rather than a flattened message: the abort reason, the DNS
    // failure and the TLS error all read the same once reduced to a string.
    throw new Error(`feed ${source.name}: request failed`, { cause: error });
  }

  // Headers are in, so the short budget has done its job. The same controller
  // now guards the body under the long one.
  clear();
  timer = setTimeout(
    () => controller.abort(new Error(`feed ${source.name}: body stalled beyond ${TRANSFER_TIMEOUT_MS} ms`)),
    TRANSFER_TIMEOUT_MS,
  );
  // A consumer that walks away without draining the stream must not keep the
  // ingest process alive for ten minutes waiting on a timer for a request
  // nobody is reading.
  timer.unref();

  try {
    if (response.status === 304) {
      // Drain nothing: a 304 has no body, but the connection is still ours to release.
      await response.body?.cancel();
      clear();
      return {
        notModified: true,
        text: undefined,
        etag: validators.etag,
        lastModified: validators.lastModified,
      };
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`feed ${source.name}: HTTP ${response.status} ${response.statusText}`);
    }

    // From here the stream owns the deadline: it is cleared when the last chunk
    // has been handed over, not when this function returns.
    return {
      notModified: false,
      text: decodeBody(response).pipeThrough(onStreamEnd(clear)),
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
    };
  } catch (error) {
    clear();
    throw error;
  }
}
