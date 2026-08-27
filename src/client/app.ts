import {
  collapsedWindow,
  liveIndex,
  progressPercent,
  remainingLabel,
  windowAnchor,
  type Span,
} from '../lib/schedule.ts';
import { mskClock, mskDayStartUtc } from '../lib/time.ts';
import { el, setFlag } from './dom.ts';
import { favouritesCss, toggleFavourite } from './favourites.ts';
import { openPicker } from './picker.ts';
import { attachSearch } from './search.ts';
import { currentFavourites, writeFavourites } from './storage.ts';

/**
 * Everything that is not needed before first paint.
 *
 * Loaded as a module, which is what makes it deferred — `defer` on an inline
 * script is ignored by the HTML parser, and the previous version of this page
 * paid for that: the client script ran ahead of the first pixel.
 *
 * The shape of the work is the same throughout. The server rendered every row
 * of every channel and cannot know what time it is, because one document is
 * cached and served to everyone. So this file answers exactly the questions
 * that depend on the clock and on this visitor — what is on air, which three
 * rows are worth showing, which channels they picked — and answers them by
 * setting attributes the stylesheet is already waiting for. It never rebuilds
 * the guide.
 */

interface Column {
  readonly slug: string;
  readonly name: string;
  readonly hue: string;
  readonly root: HTMLElement;
  readonly rows: readonly HTMLElement[];
  readonly spans: readonly Span[];
  /** The unfold checkbox. Owned by CSS; this file only ever ticks it. */
  readonly unfold: HTMLInputElement | undefined;
  readonly star: HTMLButtonElement | undefined;
  /** One per column, moved between rows rather than created and destroyed. */
  meter: HTMLElement | undefined;
}

function readColumns(guide: HTMLElement): readonly Column[] {
  return [...guide.querySelectorAll<HTMLElement>('.col')].map((root) => {
    const rows = [...root.querySelectorAll<HTMLElement>('.p')];
    return {
      slug: root.dataset.ch ?? '',
      name: root.querySelector('.col-name')?.textContent ?? '',
      hue: root.style.getPropertyValue('--h'),
      root,
      rows,
      spans: rows.map((row) => {
        const startUtc = Number(row.dataset.s);
        return { startUtc, stopUtc: startUtc + Number(row.dataset.d) * 60 };
      }),
      unfold: root.querySelector<HTMLInputElement>('.unfold') ?? undefined,
      star: root.querySelector<HTMLButtonElement>('.star') ?? undefined,
      meter: undefined,
    };
  });
}

function buildMeter(): HTMLElement {
  const meter = el('div', 'meter');
  meter.append(el('span'));
  return meter;
}

function setMeter(meter: HTMLElement, span: Span, now: number): void {
  (meter.firstElementChild as HTMLElement).style.width = `${progressPercent(span, now)}%`;
}

/**
 * Brings one column up to date with the clock.
 *
 * Flags are written only where they differ, so a minute in which nothing
 * crosses a boundary invalidates no style and triggers no layout. The window
 * is recomputed every time rather than pinned at load: it should follow the
 * programme that is on air, and it only actually moves when that programme
 * changes.
 *
 * On a day that is not today this recomputes to exactly what the server
 * already rendered — same function, same prime-time anchor — so it writes
 * nothing and the page does not move.
 *
 * Whether a column is *currently* folded is not this function's business: that
 * is the unfold checkbox, and CSS reads it directly. All that happens here is
 * that the three rows worth showing keep pointing at the right place.
 */
function updateColumn(column: Column, now: number, primeFromUtc: number, today: boolean): void {
  const live = today ? liveIndex(column.spans, now) : -1;
  const window = column.root.hasAttribute('data-window')
    ? collapsedWindow(column.spans, windowAnchor(column.spans, today ? now : undefined, primeFromUtc))
    : undefined;

  for (let index = 0; index < column.rows.length; index += 1) {
    const row = column.rows[index]!;
    setFlag(row, 'data-live', index === live);
    // Only today has a past. Dimming every row of a day that is over says
    // nothing and just makes the page harder to read.
    setFlag(row, 'data-past', today && column.spans[index]!.stopUtc <= now);
    setFlag(row, 'data-near', window !== undefined && index >= window.from && index < window.to);
  }

  if (live === -1) {
    column.meter?.remove();
    return;
  }
  column.meter ??= buildMeter();
  setMeter(column.meter, column.spans[live]!, now);
  if (column.meter.parentElement !== column.rows[live]) {
    column.rows[live]!.append(column.meter);
  }
}

interface LiveNow {
  readonly column: Column;
  readonly live: number;
}

function liveFavourites(columns: readonly Column[], favourites: readonly string[], now: number): readonly LiveNow[] {
  const entries: LiveNow[] = [];
  for (const slug of favourites) {
    const column = columns.find((each) => each.slug === slug);
    if (column === undefined) {
      continue;
    }
    const live = liveIndex(column.spans, now);
    if (live !== -1) {
      entries.push({ column, live });
    }
  }
  return entries;
}

function buildCard(entry: LiveNow, now: number, onOpen: (entry: LiveNow) => void): HTMLElement {
  const { column, live } = entry;
  const card = el('button', 'card');
  card.type = 'button';
  card.style.setProperty('--h', column.hue);

  const meter = buildMeter();
  setMeter(meter, column.spans[live]!, now);

  card.append(
    el('b', undefined, column.name),
    el('em', undefined, column.rows[live]?.querySelector('b')?.textContent ?? ''),
    meter,
    el('i', undefined, remainingLabel(column.spans[live]!, now)),
  );
  card.addEventListener('click', () => onOpen(entry));
  return card;
}

/**
 * The "on air now" strip, rebuilt only when the set of programmes changes.
 *
 * A minute-by-minute rebuild would be simpler and would also throw away focus
 * every sixty seconds, so between boundaries the cards are updated in place
 * and the nodes stay exactly where they were. Returns the key describing what
 * is currently shown, for the next call to compare against.
 */
function updateStrip(
  track: Element,
  entries: readonly LiveNow[],
  now: number,
  previousKey: string,
  onOpen: (entry: LiveNow) => void,
): string {
  const key = entries.map((entry) => `${entry.column.slug}:${entry.live}`).join(',');

  if (key !== previousKey) {
    track.replaceChildren(...entries.map((entry) => buildCard(entry, now, onOpen)));
    return key;
  }

  entries.forEach((entry, index) => {
    const card = track.children[index];
    const meter = card?.querySelector<HTMLElement>('.meter');
    const label = card?.querySelector('i');
    if (meter != null) {
      setMeter(meter, entry.column.spans[entry.live]!, now);
    }
    if (label != null) {
      label.textContent = remainingLabel(entry.column.spans[entry.live]!, now);
    }
  });
  return key;
}

function applyStars(columns: readonly Column[], favourites: readonly string[]): void {
  for (const column of columns) {
    if (column.star === undefined) {
      continue;
    }
    const on = favourites.includes(column.slug);
    column.star.setAttribute('aria-pressed', String(on));
    column.star.textContent = on ? '★' : '☆';
    column.star.setAttribute(
      'aria-label',
      on ? `${column.name} — убрать из избранного` : `${column.name} — в избранное`,
    );
  }
}

/**
 * Puts a favourites list on screen for real: DOM order, the hiding rule, stars.
 *
 * This is also what retires the boot script's provisional CSS `order`. Both
 * produce the same picture, so swapping one for the other moves nothing — but
 * only this one leaves the reading order and the tab order matching what is
 * actually on screen. Running it at start-up is not redundant with boot; it is
 * the second half of the same manoeuvre.
 */
function syncFavourites(guide: HTMLElement, columns: readonly Column[], favourites: readonly string[]): void {
  // Choosing channels is the visitor restating what they want to see, which
  // retires any column a search result had temporarily forced into view.
  for (const column of columns) {
    column.root.removeAttribute('data-revealed');
  }

  for (let index = favourites.length - 1; index >= 0; index -= 1) {
    const column = columns.find((each) => each.slug === favourites[index]);
    if (column !== undefined) {
      guide.prepend(column.root);
    }
  }

  const css = favouritesCss(favourites, columns.length, false);
  let style = document.getElementById('fav-style');
  if (style === null && css !== '') {
    style = el('style');
    style.id = 'fav-style';
    document.head.append(style);
  }
  if (style !== null) {
    style.textContent = css;
  }

  applyStars(columns, favourites);
}

/**
 * A minute tick aligned to the wall clock.
 *
 * `setInterval(fn, 60000)` drifts: after an hour the "ещё 25 мин" label
 * updates at an arbitrary offset from the minute it is displaying. Scheduling
 * to the next real minute costs nothing and fixes it. A hidden tab does no
 * work at all and catches up the moment it is looked at again.
 */
function startTicker(run: () => void): void {
  const schedule = (): void => {
    setTimeout(
      () => {
        if (document.visibilityState === 'visible') {
          run();
        }
        schedule();
      },
      60_000 - (Date.now() % 60_000),
    );
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      run();
    }
  });
  schedule();
}

function start(guide: HTMLElement, header: HTMLElement, day: string): void {
  const columns = readColumns(guide);
  const dayStart = mskDayStartUtc(day);
  const dayEnd = dayStart + 86_400;
  const primeFrom = dayStart + 18 * 3600;

  const strip = document.getElementById('live');
  const track = strip?.querySelector('.live-track') ?? undefined;
  const clock = document.getElementById('clock');
  const found = document.getElementById('found');
  const foundStatus = document.getElementById('found-n');
  const search = document.getElementById('q') as HTMLInputElement | null;
  const pick = document.getElementById('pick') as HTMLButtonElement | null;

  let favourites = currentFavourites();
  let stripKey = '';

  const expand = (column: Column, index: number): void => {
    if (column.unfold !== undefined) {
      column.unfold.checked = true;
    }
    // Search spans all twenty channels, so a result can point at a column this
    // visitor does not have. Scrolling to a `display:none` row does nothing at
    // all, which reads as a broken link — so the column is shown for this page
    // view without touching what they chose.
    column.root.setAttribute('data-revealed', '');
    column.rows[index]?.scrollIntoView({ block: 'center' });
  };

  /**
   * Takes the visitor to the programme a search result points at.
   *
   * The fragment carries the channel as well as the instant, and it has to:
   * on a normal day nine hundred-odd (day, start) pairs are shared by two to
   * thirteen channels, so a bare timestamp would land on whichever column came
   * first in broadcast order — a different programme, silently.
   */
  const goToHash = (): void => {
    const match = /^#([a-z0-9]+)-(\d+)$/.exec(location.hash);
    if (match === null) {
      return;
    }
    const column = columns.find((each) => each.slug === match[1]);
    const index = column?.spans.findIndex((span) => span.startUtc === Number(match[2])) ?? -1;
    if (column !== undefined && index !== -1) {
      // The result panel covers the guide, and following a result means the
      // visitor is done searching.
      if (search !== null && search.value !== '') {
        search.value = '';
        search.dispatchEvent(new Event('input'));
      }
      expand(column, index);
    }
  };

  const refresh = (): void => {
    const now = Math.floor(Date.now() / 1000);
    const today = now >= dayStart && now < dayEnd;

    if (clock !== null) {
      clock.hidden = !today;
      if (today) {
        clock.textContent = `Сейчас ${mskClock(now)} · МСК`;
      }
    }

    for (const column of columns) {
      updateColumn(column, now, primeFrom, today);
    }

    if (track !== undefined && strip !== null) {
      // Emptied rather than skipped when the day is not today. A page left open
      // across midnight would otherwise keep yesterday's cards on screen for
      // ever, since nothing else clears them.
      const entries = today ? liveFavourites(columns, favourites, now) : [];
      stripKey = updateStrip(track, entries, now, stripKey, (entry) => expand(entry.column, entry.live));
      strip.hidden = entries.length === 0;
    }
  };

  const commit = (next: readonly string[]): void => {
    favourites = next;
    writeFavourites(next);
    syncFavourites(guide, columns, next);
    if (pick !== null) {
      pick.textContent = `Каналы (${next.length})`;
    }
    stripKey = '';
    refresh();
  };

  /**
   * Column headers stick under the page header, so they need its height — and
   * it is not a constant: the bar wraps differently by width and by the
   * visitor's text size. Measured on every resize, written to the one custom
   * property the stylesheet reads.
   */
  new ResizeObserver(() => {
    // Zero unless the page header is actually sticky — below the breakpoint it
    // scrolls away, and a channel heading that stops 190px down the screen
    // would look like a bug.
    const sticky = getComputedStyle(header).position === 'sticky';
    document.documentElement.style.setProperty('--head-top', sticky ? `${header.offsetHeight}px` : '0px');
  }).observe(header);

  // Rendered disabled so they hold their space from the first paint without
  // pretending to work: if this module never arrives, a visitor gets a control
  // that is visibly unavailable rather than one that silently does nothing.
  if (search !== null && found !== null && foundStatus !== null) {
    search.disabled = false;
    attachSearch({
      input: search,
      panel: found,
      status: foundStatus,
      names: new Map(columns.map((column) => [column.slug, column.name])),
      hues: new Map(columns.map((column) => [column.slug, column.hue])),
    });
  }

  if (pick !== null) {
    pick.disabled = false;
    pick.textContent = `Каналы (${favourites.length})`;
    pick.addEventListener('click', () => {
      openPicker(
        columns.map(({ slug, name, hue }) => ({ slug, name, hue })),
        favourites,
        commit,
      );
    });
  }

  for (const column of columns) {
    if (column.star !== undefined) {
      column.star.disabled = false;
    }
    column.star?.addEventListener('click', () => {
      const next = toggleFavourite(favourites, column.slug);
      // Never down to nothing: an empty saved list is indistinguishable from
      // never having chosen, so it would silently restore the defaults.
      if (next.length === 0) {
        return;
      }
      // Unstarring hides the column the button lives in, which blurs it and
      // drops focus to <body> — a keyboard visitor would be silently returned
      // to the top of the document. Hand focus to whichever star takes its
      // place on screen, or to the control that manages channels.
      const hadFocus = document.activeElement === column.star;
      const position = favourites.indexOf(column.slug);
      commit(next);
      if (hadFocus) {
        const successor = columns.find((each) => each.slug === next[Math.min(position, next.length - 1)]);
        (successor?.star ?? pick)?.focus();
      }
    });
  }

  // The day strip is a horizontal scroller that starts at the left, so on a
  // phone the day you are actually looking at can sit hundreds of pixels off
  // screen with no scrollbar to hint at it. `block: 'nearest'` keeps this
  // inside the strip rather than scrolling the page.
  document.querySelector('.days a[aria-current]')?.scrollIntoView({ inline: 'center', block: 'nearest' });

  syncFavourites(guide, columns, favourites);
  refresh();
  goToHash();
  // A result for the day already on screen is a same-document navigation, so
  // nothing reloads and nothing else would ever notice it.
  window.addEventListener('hashchange', goToHash);

  startTicker(refresh);
}

const guide = document.querySelector<HTMLElement>('.guide');
const header = document.querySelector<HTMLElement>('header');
const day = document.body.dataset.day;

if (guide !== null && header !== null && day !== undefined) {
  start(guide, header, day);
}
