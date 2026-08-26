import { CHANNELS, DEFAULT_FAVOURITES } from '../config/channels.ts';
import { mskClock } from '../lib/time.ts';
import { CLIENT_SCRIPT, INLINE_BOOT } from './client.ts';
import { buildLattice, placement } from './lattice.ts';
import { STYLES } from './styles.ts';

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

export interface DayPageInput {
  readonly day: string;
  readonly days: readonly string[];
  readonly programmes: readonly Programme[];
  /** Unix seconds of the last successful ingest, for the footer. */
  readonly updatedUtc: number;
  /** Set when serving from the fallback feed, shown as a banner. */
  readonly staleNote: string | undefined;
}

function humanDay(day: string): string {
  const [, month, date] = day.split('-').map(Number);
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${date} ${months[month! - 1]}`;
}

function weekday(day: string): string {
  const names = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const [year, month, date] = day.split('-').map(Number);
  return names[new Date(Date.UTC(year!, month! - 1, date!)).getUTCDay()] ?? '';
}

function renderDayNav(days: readonly string[], current: string): string {
  const links = days
    .map((day) => {
      const mark = day === current ? ' aria-current="date"' : '';
      return `<a href="/day/${day}"${mark}>${weekday(day)} ${humanDay(day)}</a>`;
    })
    .join('');
  return `<nav class="days" aria-label="Дни">${links}</nav>`;
}

function renderRail(lattice: ReturnType<typeof buildLattice>): string {
  const marks: string[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const at = lattice.dayStartUtc + hour * 3600;
    const from = lattice.line.get(at);
    const to = lattice.line.get(at + 3600) ?? lattice.line.get(lattice.dayEndUtc);
    if (from === undefined || to === undefined) {
      continue;
    }
    marks.push(`<div class="rail" style="grid-row:${from}/${to}"><span>${mskClock(at)}</span></div>`);
  }
  return marks.join('');
}

function renderCells(lattice: ReturnType<typeof buildLattice>, programmes: readonly Programme[]): string {
  const cells: string[] = [];
  for (const programme of programmes) {
    const at = placement(lattice, programme);
    if (at === undefined) {
      continue;
    }
    const title = escapeHtml(programme.title);
    // Start and duration travel with the cell so the client can find "now" and
    // build the strip without a second copy of the schedule. Duration in
    // minutes rather than an absolute end, and no ISO `datetime` attribute:
    // both were high-entropy restatements of `data-s`, and on 600-odd cells
    // they cost more compressed bytes than everything else on the page.
    const minutes = Math.round((programme.stopUtc - programme.startUtc) / 60);
    cells.push(
      `<article class="p" data-ch="${programme.channelSlug}" data-s="${programme.startUtc}" data-d="${minutes}"` +
        ` style="grid-row:${at.from}/${at.to}">` +
        `<time>${mskClock(programme.startUtc)}</time><b>${title}</b></article>`,
    );
  }
  return cells.join('');
}

export function renderDayPage(input: DayPageInput): string {
  const lattice = buildLattice(input.day, input.programmes);
  const heads = CHANNELS.map(
    (channel) => `<div class="head" data-ch="${channel.slug}">${escapeHtml(channel.name)}</div>`,
  ).join('');

  const banner = input.staleNote === undefined ? '' : `<div class="stale">${escapeHtml(input.staleNote)}</div>`;
  const updated = `Обновлено ${mskClock(input.updatedUtc)}, источник epg.one`;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Телепрограмма — ${humanDay(input.day)}</title>
<style>${STYLES}</style>
<script>${INLINE_BOOT}</script>
</head>
<body data-day="${input.day}">
${banner}
<header>
  <div class="bar"><h1>Телепрограмма</h1>${renderDayNav(input.days, input.day)}</div>
</header>
<div id="now-strip"></div>
<main class="guide" style="--cols:${CHANNELS.length};grid-template-rows:${lattice.template}">
  ${heads}
  ${renderRail(lattice)}
  ${renderCells(lattice, input.programmes)}
  <div id="nowline" hidden></div>
</main>
<footer>${updated}</footer>
<script id="fav-default" type="application/json">${JSON.stringify(DEFAULT_FAVOURITES)}</script>
<script defer>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}
