import { CHANNELS, channelHue } from '../config/channels.ts';
import { dayLabel, humanDay, plural } from '../lib/labels.ts';
import { collapsedWindow, windowAnchor, WINDOW_SIZE } from '../lib/schedule.ts';
import { mskClock, mskDayStartUtc } from '../lib/time.ts';
import { APP_ASSET, BOOT_SCRIPT, STYLES } from './bundle.ts';

import type { Programme } from '../lib/types.ts';

/**
 * Renders one day's document.
 *
 * Every channel is in the markup and every channel is on screen. A star is an
 * ordering preference, never a filter: one cached page serves every possible
 * layout, so there are no per-visitor server variants, changing favourites
 * needs no request at all, and with scripting off the page is not a degraded
 * version of anything — it is the same twenty columns in broadcast order.
 *
 * Two scripts, delivered differently because they are needed at different
 * moments:
 *
 *   BOOT  inline in <head>, parser-blocking on purpose. It lifts the visitor's
 *         starred channels to the top before the first paint. Anything later
 *         and twenty columns appear and then visibly rearrange. A round trip is
 *         out of the question here, so inline it is.
 *   APP   an external module, and external is the point: it is byte-identical
 *         on all fifteen day pages, the day tabs are ordinary links, and
 *         inlining would re-send four kilobytes on every day the visitor
 *         opens. It is addressed by content hash and cached for a year.
 *         `type="module"` is also what defers it — `defer` on an *inline*
 *         script is ignored by the HTML spec, and the previous version of this
 *         page paid for that with a client script that ran before first paint.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

export function escapeHtml(raw: string): string {
  return raw.replace(/[&<>"]/g, (char) => ESCAPES[char] ?? char);
}

/**
 * The icon, inline.
 *
 * Not vanity: without it every visit fetches `/favicon.ico` and takes a 404,
 * which is a wasted round trip and a red line in anyone's console. As a data
 * URI it costs a couple of hundred bytes and no request at all.
 */
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E" +
  "%3Cpath d='M4.5 1.5 8 4.5l3.5-3' stroke='%23b8331f' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E" +
  "%3Crect x='1' y='4.5' width='14' height='10' rx='2.5' fill='%23b8331f'/%3E%3C/svg%3E";

export interface DayPageInput {
  readonly day: string;
  readonly days: readonly string[];
  readonly programmes: readonly Programme[];
  /**
   * Unix seconds of the last successful feed check, for the footer. Absent
   * before the first one has ever completed, which is a container that came up
   * against an empty database — the footer then claims nothing rather than
   * claiming the current time.
   */
  readonly updatedUtc: number | undefined;
  /** Which feed the rows came from. Absent on an empty database. */
  readonly source: string | undefined;
  /** Set when serving from the fallback feed, shown as a banner. */
  readonly staleNote: string | undefined;
}

/** `25 мин`, `1 ч 30 мин`, `2 ч`. */
export function durationLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} мин`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** Length in whole minutes — the only form the browser ever sees, via `data-d`. */
function roundedMinutes(programme: Programme): number {
  return Math.round((programme.stopUtc - programme.startUtc) / 60);
}

/**
 * The day tabs, each carrying both of its possible labels.
 *
 * The server cannot pick out today. Pages are rebuilt twice a day and one of
 * those builds is still being served after midnight, so at render time "which
 * of my fifteen tabs is today" has no answer here. Only the browser knows, and
 * the browser must not answer it after the first paint: a tab that changes
 * width once the page is on screen shifts every tab after it.
 *
 * So every tab ships «Сегодня» alongside its date, the stylesheet hides the
 * former, and the boot script — still inside `<head>` — un-hides exactly one of
 * them with a rule keyed on `data-day`. Fifteen extra words cost a few bytes
 * compressed; a round trip or a reflow costs neither of those things.
 *
 * `data-day` rather than the `href`, because the application rewrites today's
 * tab to point at `/` — a rule matching on the href would come undone at
 * precisely the moment it applies.
 */
function renderDayNav(days: readonly string[], current: string): string {
  const links = days
    .map((day) => {
      const mark = day === current ? ' aria-current="date"' : '';
      return (
        `<a href="/day/${day}" data-day="${day}"${mark}>` +
        `<span class="date">${dayLabel(day)}</span>` +
        `<span class="now">Сегодня</span></a>`
      );
    })
    .join('');
  return `<nav class="days" aria-label="Дни">${links}</nav>`;
}

/** Programmes of one day, grouped by channel and kept in start order. */
function groupByChannel(programmes: readonly Programme[]): Map<string, Programme[]> {
  const groups = new Map<string, Programme[]>();
  for (const programme of programmes) {
    let list = groups.get(programme.channelSlug);
    if (list === undefined) {
      list = [];
      groups.set(programme.channelSlug, list);
    }
    list.push(programme);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.startUtc - b.startUtc);
  }
  return groups;
}

/**
 * One programme row.
 *
 * `data-s` and `data-d` carry start and length so the client can find what is
 * on air without a second copy of the schedule. Minutes rather than an
 * absolute end, and no ISO `datetime`: both were high-entropy restatements of
 * `data-s`, and across six hundred rows they cost more compressed bytes than
 * everything else on the page.
 *
 * Rows of the next day are not marked in any way, and that is the point: they
 * are ordinary rows, so the window slides into them when the day runs out and
 * the column stays five rows tall instead of backing into the afternoon.
 */
function renderProgramme(programme: Programme, near: boolean): string {
  const seconds = programme.stopUtc - programme.startUtc;
  const minutes = roundedMinutes(programme);
  return (
    `<li class="p" data-s="${programme.startUtc}" data-d="${minutes}"${near ? ' data-near' : ''}>` +
    `<time>${mskClock(programme.startUtc)}</time>` +
    `<b>${escapeHtml(programme.title)}</b>` +
    `<i>${durationLabel(seconds)}</i>` +
    `</li>`
  );
}

/**
 * One channel column, already collapsed.
 *
 * Collapsing here rather than leaving it to the client is what keeps the page
 * from rearranging itself after it appears. The document cannot know the time
 * — one copy is cached for everybody — so it collapses around the start of
 * prime time, and the client slides the window onto whatever is actually on
 * air. Five rows become five different rows: the page barely moves.
 *
 * The column's rows are this day's plus the first few of the next, and they are
 * windowed as one list. Late in the evening that is the difference between five
 * rows that carry on past midnight and five rows backing up into the afternoon.
 *
 * Leaving it to the client instead would mean painting the whole day, up to
 * twenty thousand pixels of it on a phone, and then folding it away. That is a
 * layout shift measured in screens, on the device this site is mostly read on.
 */
function renderColumn(index: number, programmes: readonly Programme[], day: string): string {
  const channel = CHANNELS[index]!;
  const dayStart = mskDayStartUtc(day);
  const primeFrom = dayStart + 18 * 3600;

  // Every row the column carries, this day's and the next day's, in one list —
  // and windowed as one list. That is what makes a column five rows tall at
  // 23:50: the window runs past midnight instead of backing up into the
  // afternoon, which is the only other way to keep a column its full height.
  //
  // Windowed on the *rounded* stop times, because that is what the browser
  // will reconstruct from `data-d`. Using the exact seconds here would let the
  // two disagree by up to thirty seconds, which is enough to pick a different
  // anchor row when a programme ends right at 18:00 — and a disagreement means
  // the page rearranges itself a moment after it appears.
  const spans = programmes.map((programme) => ({
    startUtc: programme.startUtc,
    stopUtc: programme.startUtc + roundedMinutes(programme) * 60,
  }));
  const window = collapsedWindow(spans, windowAnchor(spans, undefined, primeFrom));
  const rows = programmes
    .map((programme, row) => renderProgramme(programme, window !== undefined && row >= window.from && row < window.to))
    .join('');

  // The count in the heading is this day's own, though: a programme is filed
  // under the day it starts on, so anything from midnight belongs to tomorrow's
  // page, is searched and linked there, and a column claiming передач it does
  // not have would be the one dishonest number on the page.
  const dayEnd = dayStart + 86_400;
  const own = programmes.filter((programme) => programme.startUtc < dayEnd).length;

  const name = escapeHtml(channel.name);
  // Two controls, and the difference between them is which failure each one has
  // to survive.
  //
  // «Ещё 5» is a button the application drives: it widens the same window the
  // server folded, so the minute tick keeps it open instead of undoing it.
  // Rendered disabled, like the search field and the stars, so that a bundle
  // that never arrives leaves a control that is visibly unavailable rather than
  // one that silently does nothing.
  //
  // «…» is a checkbox and a label, and it is the one that has to work with no
  // script at all: a hashed asset 404s for the five minutes a cached page
  // outlives a deploy, and a second request on a phone network fails routinely.
  // Neither may leave someone looking at five rows of twenty-seven with no way
  // to see the rest, so CSS owns this one on its own. Icon rather than words
  // because "show the next few" is what people actually want and it deserves
  // the readable label.
  const unfold =
    `<div class="tools">` +
    `<button type="button" class="next" disabled>Ещё ${WINDOW_SIZE}</button>` +
    `<input type="checkbox" id="all-${channel.slug}" class="vh unfold">` +
    `<label class="more" for="all-${channel.slug}">` +
    `<span class="open" aria-hidden="true">…</span>` +
    `<span class="open vh">Показать все (${own})</span>` +
    `<span class="shut">Свернуть</span></label>` +
    `</div>`;

  // No rows of its own means no column: tomorrow's small hours listed beneath
  // "нет данных за этот день" read as a bug rather than as a courtesy.
  const body = own === 0 ? '<p class="none">Нет данных за этот день</p>' : `<ol class="progs">${rows}</ol>${unfold}`;

  // The heading is the channel name and nothing else. Wrapping the star and
  // the count inside the <h2> made its accessible name "Первый канал Первый
  // канал — убрать из избранного 27", because a heading takes its name from
  // its content — including a button's aria-label. Heading navigation is the
  // main way a screen reader moves through twenty columns, so it has to read
  // as the channel.
  const noun = plural(own, 'передача', 'передачи', 'передач');

  // `data-end` says the window has nothing after it left to show — the next
  // day's rows included — so «Ещё» has no work and the stylesheet hides it.
  // Decided here as well as in the browser because a control that appears or
  // disappears after the first paint is the kind of movement this page is built
  // not to have.
  const atEnd = window !== undefined && window.to >= spans.length;

  return (
    `<section class="col" data-ch="${channel.slug}" style="--h:${channelHue(index)}"` +
    `${window === undefined ? '' : ' data-window'}${atEnd ? ' data-end' : ''}>` +
    `<div class="col-head">` +
    `<span class="dot"></span>` +
    `<h2 class="col-name">${name}</h2>` +
    `<button type="button" class="star" disabled aria-pressed="false" aria-label="${name} — в избранное">☆</button>` +
    `<span class="col-n">${own}<span class="vh"> ${noun}</span></span>` +
    `</div>${body}</section>`
  );
}

/**
 * The one line of provenance the page carries.
 *
 * Both halves are read from the run log rather than assumed. The source was
 * hardcoded to epg.one, which was true only for as long as the fallback could
 * not run; the time was the moment the page cache was built, which on a
 * container restart is the current time printed under whatever age the data
 * actually is — the exact claim this site exists not to make.
 */
function footerNote(updatedUtc: number | undefined, source: string | undefined): string {
  const parts: string[] = [];
  if (updatedUtc !== undefined) {
    parts.push(`Обновлено ${mskClock(updatedUtc)} МСК`);
  }
  if (source !== undefined) {
    parts.push(`источник ${escapeHtml(source)}`);
  }
  return parts.length === 0 ? 'Расписание ещё ни разу не загружалось' : parts.join(', ');
}

export function renderDayPage(input: DayPageInput): string {
  const groups = groupByChannel(input.programmes);
  const columns = CHANNELS.map((channel, index) => renderColumn(index, groups.get(channel.slug) ?? [], input.day)).join(
    '',
  );

  const banner = input.staleNote === undefined ? '' : `<div class="stale">${escapeHtml(input.staleNote)}</div>`;
  const updated = footerNote(input.updatedUtc, input.source);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${FAVICON}">
<link rel="canonical" href="/day/${input.day}">
<link rel="modulepreload" href="${APP_ASSET.path}">
<title>Телепрограмма — ${humanDay(input.day)}</title>
<style>${STYLES}</style>
<script>${BOOT_SCRIPT}</script>
</head>
<body data-day="${input.day}">
${banner}<header>
<div class="bar">
<h1>Телепрограмма</h1>
<input id="q" type="search" disabled placeholder="Поиск передачи" aria-label="Поиск передачи по названию" autocomplete="off" enterkeyhint="search">
</div>
${renderDayNav(input.days, input.day)}
<div class="sub"><span id="clock" hidden></span></div>
</header>
<section class="live" id="live" aria-labelledby="live-h">
<h2 id="live-h">Сейчас в эфире</h2>
<div class="live-track"></div>
</section>
<section class="found" id="found" hidden aria-label="Результаты поиска"></section>
<p id="found-n" class="vh" role="status"></p>
<main class="guide">${columns}</main>
<footer>${updated}</footer>
<script type="module" src="${APP_ASSET.path}"></script>
</body>
</html>`;
}
