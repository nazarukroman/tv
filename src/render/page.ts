import { CHANNELS, channelHue } from '../config/channels.ts';
import { dayLabel, humanDay, plural } from '../lib/labels.ts';
import { collapsedWindow, windowAnchor } from '../lib/schedule.ts';
import { mskClock, mskDayStartUtc } from '../lib/time.ts';
import { APP_ASSET, BOOT_SCRIPT, STYLES } from './bundle.ts';

import type { Programme } from '../lib/types.ts';

/**
 * Renders one day's document.
 *
 * Every channel is in the markup, not just the visitor's favourites. That
 * costs a few kilobytes and buys two things worth more: one cached page serves
 * every possible layout, so there are no per-visitor server variants, and
 * changing favourites needs no request at all. With scripting off the page
 * still shows all twenty channels, which is a reasonable default rather than a
 * broken one.
 *
 * Two scripts, delivered differently because they are needed at different
 * moments:
 *
 *   BOOT  inline in <head>, parser-blocking on purpose. It puts the visitor's
 *         own channels on screen, in their own order, before the first paint.
 *         Anything later and twenty columns appear and then rearrange into
 *         six. A round trip is out of the question here, so inline it is.
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
  /** Unix seconds of the last successful ingest, for the footer. */
  readonly updatedUtc: number;
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

function renderDayNav(days: readonly string[], current: string): string {
  const links = days
    .map((day) => {
      const mark = day === current ? ' aria-current="date"' : '';
      return `<a href="/day/${day}"${mark}>${dayLabel(day)}</a>`;
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
 */
function renderProgramme(programme: Programme, primeFrom: number, primeTo: number, near: boolean): string {
  const seconds = programme.stopUtc - programme.startUtc;
  const minutes = roundedMinutes(programme);
  const prime = programme.startUtc < primeTo && programme.stopUtc > primeFrom ? ' data-prime' : '';
  return (
    `<li class="p" data-s="${programme.startUtc}" data-d="${minutes}"${prime}${near ? ' data-near' : ''}>` +
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
 * air. Three rows become three different rows: the page barely moves.
 *
 * Leaving it to the client instead would mean painting the whole day, up to
 * twenty thousand pixels of it on a phone, and then folding it away. That is a
 * layout shift measured in screens, on the device this site is mostly read on.
 */
function renderColumn(index: number, programmes: readonly Programme[], day: string): string {
  const channel = CHANNELS[index]!;
  const dayStart = mskDayStartUtc(day);
  const primeFrom = dayStart + 18 * 3600;
  const primeTo = dayStart + 24 * 3600;

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
    .map((programme, row) =>
      renderProgramme(programme, primeFrom, primeTo, window !== undefined && row >= window.from && row < window.to),
    )
    .join('');

  const name = escapeHtml(channel.name);
  // A checkbox and a label rather than a button: unfolding must survive the
  // application bundle failing to arrive, and CSS can do this one on its own.
  const unfold =
    `<input type="checkbox" id="all-${channel.slug}" class="vh unfold">` +
    `<label class="more" for="all-${channel.slug}">` +
    `<span class="open">Показать все (${programmes.length})</span>` +
    `<span class="shut">Свернуть</span></label>`;

  const body =
    programmes.length === 0 ? '<p class="none">Нет данных за этот день</p>' : `<ol class="progs">${rows}</ol>${unfold}`;

  // The heading is the channel name and nothing else. Wrapping the star and
  // the count inside the <h2> made its accessible name "Первый канал Первый
  // канал — убрать из избранного 27", because a heading takes its name from
  // its content — including a button's aria-label. Heading navigation is the
  // main way a screen reader moves through twenty columns, so it has to read
  // as the channel.
  const noun = plural(programmes.length, 'передача', 'передачи', 'передач');

  return (
    `<section class="col" data-ch="${channel.slug}" style="--h:${channelHue(index)}"` +
    `${window === undefined ? '' : ' data-window'}>` +
    `<div class="col-head">` +
    `<span class="dot"></span>` +
    `<h2 class="col-name">${name}</h2>` +
    `<button type="button" class="star" disabled aria-pressed="false" aria-label="${name} — в избранное">☆</button>` +
    `<span class="col-n">${programmes.length}<span class="vh"> ${noun}</span></span>` +
    `</div>${body}</section>`
  );
}

export function renderDayPage(input: DayPageInput): string {
  const groups = groupByChannel(input.programmes);
  const columns = CHANNELS.map((channel, index) => renderColumn(index, groups.get(channel.slug) ?? [], input.day)).join(
    '',
  );

  const banner = input.staleNote === undefined ? '' : `<div class="stale">${escapeHtml(input.staleNote)}</div>`;
  const updated = `Обновлено ${mskClock(input.updatedUtc)} МСК, источник epg.one`;

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
<button type="button" id="pick" disabled aria-haspopup="dialog">Каналы</button>
<input id="q" type="search" disabled placeholder="Поиск передачи" aria-label="Поиск передачи по названию" autocomplete="off" enterkeyhint="search">
</div>
${renderDayNav(input.days, input.day)}
<div class="sub">
<input type="checkbox" id="prime" class="vh">
<label for="prime" id="prime-label">Прайм-тайм 18:00–24:00</label>
<span id="clock" hidden></span>
</div>
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
