import { dayLabel } from '../lib/labels.ts';
import { mskClock } from '../lib/time.ts';
import { el } from './dom.ts';

/**
 * Search across every stored day.
 *
 * The index stays on the server. That is not a compromise, it is the cheaper
 * side of the trade in both directions: the same corpus shipped to the browser
 * measured about 74 KB gzip over the fifteen-day window — roughly five times
 * the whole page — while answering from memory on the server costs well under
 * a millisecond and nothing on the wire until someone actually types.
 *
 * Answering is still not a database query: `buildSnapshot` builds the index at
 * ingest time along with the pages, so a search is a scan of an array that was
 * already in memory. The "nothing happens per request that could have happened
 * earlier" rule survives intact.
 */

const MIN_QUERY = 2;
const DEBOUNCE_MS = 180;

export interface Hit {
  /** Day, `YYYY-MM-DD`. */
  readonly d: string;
  /** Start, unix seconds. */
  readonly s: number;
  /** Channel slug. */
  readonly c: string;
  readonly t: string;
}

function isHit(value: unknown): value is Hit {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const hit = value as Record<string, unknown>;
  return (
    typeof hit.d === 'string' && typeof hit.s === 'number' && typeof hit.c === 'string' && typeof hit.t === 'string'
  );
}

function parseHits(value: unknown): readonly Hit[] | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const hits = (value as Record<string, unknown>).hits;
  return Array.isArray(hits) && hits.every(isHit) ? hits : undefined;
}

export interface SearchView {
  readonly input: HTMLInputElement;
  readonly panel: HTMLElement;
  /**
   * A small, permanent live region.
   *
   * The results list is deliberately NOT one. Sixty rows inserted at once is
   * about two and a half thousand characters, and a polite live region reads
   * the whole insertion — so every debounced keystroke queued minutes of
   * speech. A screen reader gets the count here and reads the results at its
   * own pace.
   */
  readonly status: HTMLElement;
  /** Slug -> display name, read off the columns already in the document. */
  readonly names: ReadonlyMap<string, string>;
  /** Slug -> OKLCH hue, for the identity dot. */
  readonly hues: ReadonlyMap<string, string>;
}

function say(view: SearchView, text: string): void {
  view.status.textContent = text;
}

function message(view: SearchView, text: string): void {
  view.panel.replaceChildren(el('p', undefined, text));
  say(view, text);
}

function renderHits(view: SearchView, hits: readonly Hit[]): void {
  if (hits.length === 0) {
    message(view, 'Ничего не найдено');
    return;
  }

  const rows = hits.map((hit) => {
    // A real link, not a button: a result is a place in the guide, so it should
    // be shareable, openable in a new tab, and reachable with scripting off
    // once the visitor is looking at it.
    const row = el('a', 'hit');
    // Channel as well as instant: on a normal day around nine hundred (day,
    // start) pairs are shared by two to thirteen channels, so a bare timestamp
    // would open whichever column comes first in broadcast order.
    row.href = `/day/${hit.d}#${hit.c}-${hit.s}`;
    const hue = view.hues.get(hit.c);
    if (hue !== undefined) {
      row.style.setProperty('--h', hue);
    }
    row.append(
      el('span', 'dot'),
      el('em', undefined, dayLabel(hit.d)),
      el('time', undefined, mskClock(hit.s)),
      el('b', undefined, hit.t),
      el('i', undefined, view.names.get(hit.c) ?? hit.c),
    );
    return row;
  });
  view.panel.replaceChildren(...rows);
  say(view, `Найдено: ${hits.length}`);
}

/**
 * Wires the input to the panel.
 *
 * Each keystroke cancels the request the previous one started. Without that,
 * replies race and the panel settles on whichever the network happened to
 * deliver last, which is not necessarily the one matching what is on screen.
 */
export function attachSearch(view: SearchView): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | undefined;

  const run = async (query: string): Promise<void> => {
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;

    try {
      const response = await fetch(`/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`search responded ${response.status}`);
      }
      const hits = parseHits(await response.json());
      if (hits === undefined) {
        throw new Error('search returned an unexpected shape');
      }
      renderHits(view, hits);
    } catch (error) {
      // A cancelled request is the normal case, not a failure: the visitor
      // typed another character and its reply is already on the way.
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      message(view, 'Не удалось выполнить поиск. Проверьте соединение.');
    }
  };

  view.input.addEventListener('input', () => {
    const query = view.input.value.trim();
    clearTimeout(timer);
    inflight?.abort();

    if (query.length === 0) {
      document.body.removeAttribute('data-finding');
      view.panel.hidden = true;
      view.panel.replaceChildren();
      say(view, '');
      return;
    }

    document.body.setAttribute('data-finding', '');
    view.panel.hidden = false;

    if (query.length < MIN_QUERY) {
      message(view, 'Введите минимум два символа');
      return;
    }

    timer = setTimeout(() => void run(query), DEBOUNCE_MS);
  });

  view.input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && view.input.value !== '') {
      event.preventDefault();
      view.input.value = '';
      view.input.dispatchEvent(new Event('input'));
    }
  });
}
