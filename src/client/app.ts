import {
  extendedWindow,
  liveIndex,
  progressPercent,
  remainingLabel,
  windowAnchor,
  WINDOW_SIZE,
  type Span,
} from '../lib/schedule.ts';
import { mskClock, mskDay, mskDayStartUtc } from '../lib/time.ts';
import { el, setFlag } from './dom.ts';
import { favouritesFirst, toggleFavourite } from './favourites.ts';
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
 * that depend on the clock and on this visitor — what is on air, which five
 * rows are worth showing, which channels they starred — and answers them by
 * setting attributes the stylesheet is already waiting for, or by moving a
 * column. It never rebuilds the guide.
 */

interface Column {
  readonly slug: string;
  readonly name: string;
  readonly hue: string;
  readonly root: HTMLElement;
  readonly rows: readonly HTMLElement[];
  /** Every row: this day's, and the first few of the next one after them. */
  readonly spans: readonly Span[];
  /** The unfold checkbox. Owned by CSS; this file only ever ticks it. */
  readonly unfold: HTMLInputElement | undefined;
  /** The «Ещё» button, which widens the window rather than unfolding it. */
  readonly next: HTMLButtonElement | undefined;
  readonly star: HTMLButtonElement | undefined;
  /** One per column, moved between rows rather than created and destroyed. */
  meter: HTMLElement | undefined;
  /** Rows asked for beyond the window's own size, five at a time. */
  extra: number;
}

function readColumns(guide: HTMLElement): readonly Column[] {
  return [...guide.querySelectorAll<HTMLElement>('.col')].map((root) => {
    const rows = [...root.querySelectorAll<HTMLElement>('.p')];
    const spans = rows.map((row) => {
      const startUtc = Number(row.dataset.s);
      return { startUtc, stopUtc: startUtc + Number(row.dataset.d) * 60 };
    });

    return {
      slug: root.dataset.ch ?? '',
      name: root.querySelector('.col-name')?.textContent ?? '',
      hue: root.style.getPropertyValue('--h'),
      root,
      rows,
      spans,
      unfold: root.querySelector<HTMLInputElement>('.unfold') ?? undefined,
      next: root.querySelector<HTMLButtonElement>('.next') ?? undefined,
      star: root.querySelector<HTMLButtonElement>('.star') ?? undefined,
      meter: undefined,
      extra: 0,
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
 * that the five rows worth showing keep pointing at the right place.
 */
function updateColumn(column: Column, now: number, primeFromUtc: number, today: boolean): void {
  const live = today ? liveIndex(column.spans, now) : -1;
  const folded = column.root.hasAttribute('data-window');
  const window = folded
    ? extendedWindow(column.spans, windowAnchor(column.spans, today ? now : undefined, primeFromUtc), column.extra)
    : undefined;

  // A folded column with no window is the server and the browser disagreeing,
  // which they should not: both fold the same rounded spans with the same
  // constant. If it ever happens, showing the whole column is the harmless way
  // to be wrong — the fold rule keys on the attribute, so the other reading
  // would leave a heading with nothing under it.
  const near = (index: number): boolean =>
    folded && (window === undefined || (index >= window.from && index < window.to));

  // Nothing after the window means «Ещё» has nothing to offer — the next day's
  // rows are in this list too, so this really is the end of what the column
  // holds. Everything left is *above* the anchor, and that is the checkbox's
  // job, which is why the two controls are not interchangeable.
  setFlag(column.root, 'data-end', window !== undefined && window.to >= column.spans.length);

  for (let index = 0; index < column.rows.length; index += 1) {
    const row = column.rows[index]!;
    setFlag(row, 'data-live', index === live);
    // Only today has a past. Dimming every row of a day that is over says
    // nothing and just makes the page harder to read.
    setFlag(row, 'data-past', today && column.spans[index]!.stopUtc <= now);
    setFlag(row, 'data-near', near(index));
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

/**
 * Stands in for "nothing is on air" in the strip's comparison key.
 *
 * A real key is a list of `slug:index` pairs, so it can never collide with
 * this — and an empty string could not be used, because that is also the key
 * the first run starts from.
 */
const EMPTY_STRIP = '-';

/**
 * What is on air, across every channel, starred ones first.
 *
 * Every channel, because every channel is on the page — a strip that covered
 * only favourites would go blank for a visitor who has starred nothing, which
 * is now an ordinary state rather than an impossible one. Starred first,
 * because that is what a star means everywhere else on this page.
 */
function liveNow(columns: readonly Column[], favourites: readonly string[], now: number): readonly LiveNow[] {
  const entries: LiveNow[] = [];
  for (const column of favouritesFirst(columns, favourites)) {
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
 *
 * An empty set fills the strip rather than removing it. The stylesheet reserves
 * its height before first paint precisely so that filling it shifts nothing —
 * hiding it afterwards spends that reservation in the opposite direction, and
 * `[hidden]` beats the rule that made the room, so the whole guide jumped up
 * 148 px. A sentence in the box costs nothing and moves nothing.
 */
function updateStrip(
  track: Element,
  entries: readonly LiveNow[],
  now: number,
  previousKey: string,
  onOpen: (entry: LiveNow) => void,
): string {
  const key = entries.map((entry) => `${entry.column.slug}:${entry.live}`).join(',');

  if (entries.length === 0) {
    if (previousKey !== EMPTY_STRIP) {
      track.replaceChildren(el('p', 'live-none', 'Сейчас ничего не идёт'));
    }
    return EMPTY_STRIP;
  }

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
 * Puts a favourites list on screen for real: DOM order and stars.
 *
 * This is also what retires the boot script's provisional CSS `order`. Both
 * produce the same picture, so swapping one for the other moves nothing — but
 * only this one leaves the reading order and the tab order matching what is
 * actually on screen. Running it at start-up is not redundant with boot; it is
 * the second half of the same manoeuvre.
 *
 * Columns are moved into place rather than re-appended wholesale. Reinserting a
 * node blurs it, so appending all twenty would drop focus on every star press
 * and, worse, on the very first run — when nothing has changed at all. This
 * walks the two orders together and touches only the columns that actually
 * differ, which for a visitor who has starred nothing is none of them.
 */
function syncFavourites(guide: HTMLElement, columns: readonly Column[], favourites: readonly string[]): void {
  let cursor = guide.firstElementChild;
  for (const column of favouritesFirst(columns, favourites)) {
    if (column.root === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      guide.insertBefore(column.root, cursor);
    }
  }

  // The order rules were only ever scaffolding for the first paint, and they
  // are exactly what makes the tab order disagree with the screen.
  document.getElementById('fav-order')?.remove();

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

/**
 * Makes `/` the address of today, wherever the visitor came in from.
 *
 * The dated routes are worth keeping: a day page is a separately cached,
 * separately compressed document, the day tabs are ordinary links, and a search
 * result has to be able to point at one particular broadcast on one particular
 * day. What they are bad at is being bookmarked. Someone who lands on `/`,
 * clicks through to Thursday and then saves the page keeps Thursday for ever,
 * and the site they wanted a shortcut to shows a date further in the past every
 * morning.
 *
 * So today gets one address instead of two. Only the browser can do this, and
 * only after the page has arrived: pages are rebuilt twice a day and one of
 * those builds is still being served after midnight, so at render time the
 * server genuinely does not know which of its tabs is today.
 *
 * Two edits, both cheap:
 *
 *   - the tab for today points at `/` rather than at its own date, so clicking
 *     it leaves the address bar on the durable URL;
 *   - if the day already on screen is today and the address bar says otherwise,
 *     it is rewritten in place. No navigation, no request, no reload — the bytes
 *     at `/day/<today>` and at `/` are the same document.
 *
 * With scripting off nothing happens and every link is still a working dated
 * one, which is why the server renders those and not this.
 */
function pinTodayToRoot(day: string): void {
  const today = mskDay(Math.floor(Date.now() / 1000));

  const tab = document.querySelector<HTMLAnchorElement>(`.days a[href="/day/${today}"]`);
  if (tab !== null) {
    tab.href = '/';
  }

  if (day === today && location.pathname !== '/') {
    // `replaceState`, not `pushState`: this is the same page under its better
    // name, not somewhere the back button should have to visit.
    history.replaceState(null, '', `/${location.hash}`);
  }
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

  let favourites = currentFavourites();
  let stripKey = '';

  // Unfolding first: the row a result points at is almost always outside the
  // five the column arrived collapsed to, and scrolling to a `display:none`
  // row does nothing at all — which reads as a broken link.
  const expand = (column: Column, index: number): void => {
    if (column.unfold !== undefined) {
      column.unfold.checked = true;
    }
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

    if (track !== undefined) {
      // Emptied rather than skipped when the day is not today. A page left open
      // across midnight would otherwise keep yesterday's cards on screen for
      // ever, since nothing else clears them.
      const entries = today ? liveNow(columns, favourites, now) : [];
      stripKey = updateStrip(track, entries, now, stripKey, (entry) => expand(entry.column, entry.live));
    }
  };

  /**
   * Shows five more of this column, further down the evening.
   *
   * It widens the window the server folded rather than revealing a slice of its
   * own, because the window is recomputed on every minute tick: rows held open
   * by anything else would be folded away again within sixty seconds.
   *
   * Forwards only — `extendedWindow` pins the top of the window — so this never
   * uncovers programmes that have already been on. When there is nothing left
   * below, `updateColumn` marks the column `data-end` and the stylesheet takes
   * the button away; the earlier rows stay behind «…», which is the control
   * that means "all of it".
   */
  const revealMore = (column: Column): void => {
    column.extra += WINDOW_SIZE;
    refresh();
  };

  const commit = (next: readonly string[]): void => {
    favourites = next;
    writeFavourites(next);
    syncFavourites(guide, columns, next);
    // The strip is ordered by favourites too, so the same list it was built
    // from has just changed underneath it.
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

  // The star in each column header is the whole of channel management: it is
  // in the guide the visitor is already reading, it needs no dialog to open and
  // nothing to close, and with scripting off it is simply absent rather than
  // present and dead.
  for (const column of columns) {
    if (column.next !== undefined) {
      // Rendered disabled so it holds its space without pretending to work.
      column.next.disabled = false;
      column.next.addEventListener('click', () => {
        const hadFocus = document.activeElement === column.next;
        revealMore(column);
        // The press that reaches the end of the day is also the press that
        // takes the button away, and focus does not survive `display: none`.
        // The checkbox is visually hidden but focusable and its label draws the
        // ring, so a keyboard visitor lands on «…» rather than back at the top
        // of the page.
        if (hadFocus && column.next?.offsetParent === null) {
          column.unfold?.focus();
        }
      });
    }

    column.unfold?.addEventListener('change', () => {
      // Collapsing has to actually collapse. The extra rows were a request for
      // more of this column, and «Свернуть» withdraws it — without this the
      // window stays as wide as it was grown and the column visibly refuses to
      // fold. A programmatic tick (a search result, a card in the strip) fires
      // no `change`, so following a link never resets anything.
      if (column.unfold?.checked === false) {
        column.extra = 0;
        refresh();
      }
    });

    const star = column.star;
    if (star === undefined) {
      continue;
    }
    star.disabled = false;
    star.addEventListener('click', () => {
      // Starring moves the column, and moving a node takes it out of the
      // document, which blurs it — a keyboard visitor would be silently
      // returned to the top of the page. The button itself survives the move,
      // so putting focus back is exact rather than approximate.
      const hadFocus = document.activeElement === star;
      commit(toggleFavourite(favourites, column.slug));
      if (hadFocus) {
        star.focus();
      }
    });
  }

  // Every write first, then every read. `scrollIntoView` forces a synchronous
  // layout, so performing it between the column moves and the minute's worth of
  // row attributes made the browser lay the guide out twice — measured at 53 ms
  // of forced reflow on the mobile profile, all of it thrown away by the writes
  // that came after it.
  syncFavourites(guide, columns, favourites);
  refresh();
  pinTodayToRoot(day);

  // The day strip is a horizontal scroller that starts at the left, so on a
  // phone the day you are actually looking at can sit hundreds of pixels off
  // screen with no scrollbar to hint at it. `block: 'nearest'` keeps this
  // inside the strip rather than scrolling the page. Reading it here, after the
  // columns have been moved, is also the only point at which the answer is the
  // final one.
  document.querySelector('.days a[aria-current]')?.scrollIntoView({ inline: 'center', block: 'nearest' });

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
