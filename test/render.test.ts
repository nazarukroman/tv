import { describe, expect, test } from 'bun:test';

import { todayTabCss } from '../src/client/day-tabs.ts';
import { CHANNELS, DEFAULT_FAVOURITES, sourceIndex } from '../src/config/channels.ts';
import { SOURCE_NAMES } from '../src/config/sources.ts';
import { WINDOW_SIZE } from '../src/lib/schedule.ts';
import { mskDayStartUtc } from '../src/lib/time.ts';
import { durationLabel, escapeHtml, renderDayPage } from '../src/render/page.ts';

import type { DayPageInput } from '../src/render/page.ts';
import type { Programme } from '../src/lib/types.ts';

const DAY = '2026-08-26';
const NEXT = '2026-08-27';
const DAYS: readonly string[] = [DAY];
const SLUG = CHANNELS[0]!.slug;

function prog(channelSlug: string, startUtc: number, stopUtc: number, title: string, day: string = DAY): Programme {
  return { channelSlug, startUtc, stopUtc, day, title, description: undefined };
}

/** One day's markup, with only the field a test actually cares about spelled out. */
function page(programmes: readonly Programme[], overrides: Partial<DayPageInput> = {}): string {
  return renderDayPage({
    day: DAY,
    days: DAYS,
    programmes,
    updatedUtc: 1000,
    source: 'epg.one',
    staleNote: undefined,
    ...overrides,
  });
}

/** The opening tag of the first channel's column, where its own attributes live. */
function columnTag(html: string): string {
  const match = new RegExp(`<section class="col" data-ch="${SLUG}"[^>]*>`).exec(html);
  if (match === null) {
    throw new Error(`no column found for ${SLUG}`);
  }
  return match[0];
}

/** The `<li>` for the row starting at `startUtc`, so its attributes can be inspected. */
function rowFor(html: string, startUtc: number): string {
  const match = new RegExp(`<li class="p" data-s="${startUtc}"[^>]*>`).exec(html);
  if (match === null) {
    throw new Error(`no row found for data-s="${startUtc}"`);
  }
  return match[0];
}

describe('escapeHtml', () => {
  test('escapes the four HTML metacharacters', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
  });

  test('leaves plain text untouched', () => {
    expect(escapeHtml('Новости')).toBe('Новости');
  });
});

describe('durationLabel', () => {
  test('renders minutes, a whole hour and hours with minutes', () => {
    expect(durationLabel(25 * 60)).toBe('25 мин');
    expect(durationLabel(60 * 60)).toBe('1 ч');
    expect(durationLabel(90 * 60)).toBe('1 ч 30 мин');
  });
});

describe('renderDayPage', () => {
  test('escapes a hostile title everywhere it appears', () => {
    // A title is feed-controlled text landing straight into markup; unescaped
    // it is a stored XSS against every visitor who opens this day.
    const hostile = '<script>alert(1)</script> & "boom"';
    const html = page([prog(SLUG, 1000, 2000, hostile)]);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;boom&quot;');
  });

  test('gives every configured channel a column, even with no programmes that day', () => {
    const html = page([prog(SLUG, 1000, 2000, 'Что-то')]);

    expect((html.match(/class="col"/g) ?? []).length).toBe(CHANNELS.length);
    for (const channel of CHANNELS.slice(1)) {
      expect(html).toContain(`data-ch="${channel.slug}"`);
    }
    expect(html).toContain('Нет данных за этот день');
  });

  test('round-trips start and duration through data-s and data-d', () => {
    const start = mskDayStartUtc(DAY) + 10 * 3600; // 10:00 MSK
    const stop = start + 25 * 60; // 25-minute programme
    const html = page([prog(SLUG, start, stop, 'Утренняя передача')]);

    expect(html).toContain(`data-s="${start}"`);
    expect(html).toContain('data-d="25"');
  });

  test('collapses a long column around the start of prime time', () => {
    // The server has no clock — one document is cached for everybody — so it
    // folds around 18:00 and marks exactly the rows it kept. Getting this wrong
    // does not throw: it silently shows the visitor ten past midnight.
    const dayStart = mskDayStartUtc(DAY);
    const hourly = Array.from({ length: 24 }, (_, hour) =>
      prog(SLUG, dayStart + hour * 3600, dayStart + (hour + 1) * 3600, `Час ${hour}`),
    );

    const html = page(hourly);

    expect(html).toContain('data-window');
    expect((html.match(/ data-near/g) ?? []).length).toBe(WINDOW_SIZE);
    expect(rowFor(html, dayStart + 18 * 3600)).toContain(' data-near');
    expect(rowFor(html, dayStart + 22 * 3600)).toContain(' data-near');
    expect(rowFor(html, dayStart + 17 * 3600)).not.toContain(' data-near');
    expect(rowFor(html, dayStart + 23 * 3600)).not.toContain(' data-near');
  });

  test('runs the window past midnight when the day has run out', () => {
    // The rows of the next day are ordinary rows, marked the same way as any
    // other. That is what keeps a column five rows tall at 23:50: the window
    // carries on into tomorrow instead of backing up into an afternoon that has
    // already been on.
    const dayStart = mskDayStartUtc(DAY);
    const dayEnd = dayStart + 86_400;
    // A day that stops at 20:00, so the prime-time anchor is near its end.
    const own = Array.from({ length: 8 }, (_, index) =>
      prog(SLUG, dayStart + (12 + index) * 3600, dayStart + (13 + index) * 3600, `Час ${12 + index}`),
    );
    const tail = Array.from({ length: 4 }, (_, index) =>
      prog(SLUG, dayEnd + 600 + index * 3600, dayEnd + 600 + (index + 1) * 3600, `Ночь ${index}`, NEXT),
    );

    const html = page([...own, ...tail]);

    expect(html).not.toContain('data-tail');
    expect((html.match(/ data-near/g) ?? []).length).toBe(WINDOW_SIZE);
    // 18:00 and 19:00 of this day, then three rows of the next one.
    expect(rowFor(html, dayStart + 18 * 3600)).toContain(' data-near');
    expect(rowFor(html, dayEnd + 600)).toContain(' data-near');
    expect(rowFor(html, dayEnd + 600 + 2 * 3600)).toContain(' data-near');
    // And nothing from before the anchor, which is the half of it that matters.
    expect(rowFor(html, dayStart + 17 * 3600)).not.toContain(' data-near');
    expect(html).toContain('<time>00:10</time>');
  });

  test('counts only this day, however many rows the column shows', () => {
    // The tail is listed, searched and linked under tomorrow. Counting it here
    // would make the column claim передач it does not have, and the count is
    // also the number in «Показать все».
    const dayStart = mskDayStartUtc(DAY);
    const dayEnd = dayStart + 86_400;
    const html = page([
      prog(SLUG, dayStart + 12 * 3600, dayStart + 13 * 3600, 'Полдень'),
      prog(SLUG, dayEnd + 600, dayEnd + 3600, 'Подкаст', NEXT),
    ]);

    expect(html).toContain('>1<span class="vh"> передача</span>');
    expect(html).toContain('Показать все (1)');
  });

  test('says nothing about tomorrow in a column with no rows of its own', () => {
    // Tomorrow's small hours listed under «нет данных за этот день» reads as a
    // bug rather than as a courtesy.
    const dayEnd = mskDayStartUtc(DAY) + 86_400;
    const html = page([prog(SLUG, dayEnd + 600, dayEnd + 3600, 'Подкаст', NEXT)]);

    expect(html).toContain('Нет данных за этот день');
    expect(html).not.toContain('Подкаст');
  });

  test('offers «ещё» and «все» as separate controls, and only the second works unaided', () => {
    // The split is about failure, not taste: the button needs the bundle, the
    // checkbox does not. A hashed asset 404s for the five minutes a cached page
    // outlives a deploy, and that must not leave someone stuck at five rows.
    const dayStart = mskDayStartUtc(DAY);
    const hourly = Array.from({ length: 24 }, (_, hour) =>
      prog(SLUG, dayStart + hour * 3600, dayStart + (hour + 1) * 3600, `Час ${hour}`),
    );

    const html = page(hourly);

    expect(html).toContain(`<button type="button" class="next" disabled>Ещё ${WINDOW_SIZE}</button>`);
    expect(html).toContain(`<input type="checkbox" id="all-${SLUG}" class="vh unfold">`);
    // The icon is hidden from the accessible name, so the label still reads as
    // a sentence to a screen reader.
    expect(html).toContain('<span class="open" aria-hidden="true">…</span>');
    expect(html).toContain('<span class="open vh">Показать все (24)</span>');
  });

  test('marks the column whose window already reaches the end of the day', () => {
    // «Ещё» goes forwards only, so on such a column it has nothing to offer and
    // the stylesheet hides it. Decided here as well as in the browser: a control
    // that disappears after the first paint is movement, and this page is built
    // not to move.
    const dayStart = mskDayStartUtc(DAY);
    // Seven hourly rows from 14:00, so the prime-time anchor is the 18:00 one
    // and the five-row window runs out at the last row of the day.
    const afternoon = Array.from({ length: 7 }, (_, index) =>
      prog(SLUG, dayStart + (14 + index) * 3600, dayStart + (15 + index) * 3600, `Час ${14 + index}`),
    );
    const wholeDay = Array.from({ length: 24 }, (_, hour) =>
      prog(SLUG, dayStart + hour * 3600, dayStart + (hour + 1) * 3600, `Час ${hour}`),
    );

    // On the section tag, not anywhere in the document: the stylesheet is
    // inlined and mentions the attribute in a rule of its own.
    expect(columnTag(page(afternoon))).toContain(' data-end');
    // A full day has rows below the window, so the button belongs there.
    expect(columnTag(page(wholeDay))).toContain(' data-window');
    expect(columnTag(page(wholeDay))).not.toContain(' data-end');
  });

  test('gives every day tab both labels, and the day it needs to match on', () => {
    // The server cannot know which tab is today: pages are rebuilt twice a day
    // and one build outlives midnight. So both labels ship and the boot script
    // reveals one, keyed on `data-day` — not on the href, which the client
    // rewrites to `/` for today.
    const html = renderDayPage({
      day: DAY,
      days: [DAY, NEXT],
      programmes: [],
      updatedUtc: 1000,
      source: 'epg.one',
      staleNote: undefined,
    });

    expect(html).toContain(
      `<a href="/day/${NEXT}" data-day="${NEXT}"><span class="date">чт 27 авг</span><span class="now">Сегодня</span></a>`,
    );
    expect(todayTabCss(NEXT)).toContain(`.days a[data-day="${NEXT}"]`);
    // The rule and the markup have to agree on both class names; nothing else
    // would notice if one of them were renamed.
    expect(todayTabCss(NEXT)).toContain('.date{display:none}');
    expect(todayTabCss(NEXT)).toContain('.now{display:inline}');
  });

  test('renders a programme carried over from the previous day at the top of the column', () => {
    // The store hands these over so the column is not blank at 00:20. They are
    // ordinary rows here — the point is only that the renderer does not assume
    // every row starts inside the day it is rendering, which it would if it
    // derived anything at all from `input.day` per row.
    const dayStart = mskDayStartUtc(DAY);
    const carried = prog(SLUG, dayStart - 20 * 60, dayStart + 75 * 60, 'Ночной эфир', '2026-08-25');
    const html = page([carried, prog(SLUG, dayStart + 75 * 60, dayStart + 2 * 3600, 'Утро')]);

    expect(html).toContain(`data-s="${carried.startUtc}"`);
    expect(html).toContain('Ночной эфир');
    // 23:40 of the previous evening, rendered as the clock reads, not as 00:00.
    expect(html).toContain('<time>23:40</time>');
  });

  test('offers no control that hides a channel or a row', () => {
    // Every channel is on the page and stays there; the only filtering left is
    // the per-column unfold, which CSS owns. A stray prime-time checkbox or
    // channel dialog surviving a refactor would put back a state in which the
    // visitor sees less than the whole guide with no obvious way out.
    const html = page([prog(SLUG, 1000, 2000, 'Что-то')]);

    expect(html).not.toContain('id="prime"');
    expect(html).not.toContain('data-prime');
    expect(html).not.toContain('id="pick"');
    expect(html).not.toContain('<dialog');
  });

  test('gives every column a star, and starts them all unpressed', () => {
    // The star is the only channel control there is now, so it has to be on
    // every column — including one with no programmes, which is still a channel
    // the visitor may want at the top tomorrow.
    const html = page([prog(SLUG, 1000, 2000, 'Что-то')]);

    expect((html.match(/class="star"/g) ?? []).length).toBe(CHANNELS.length);
    // The server cannot know who is reading, so the markup is neutral and the
    // boot script settles it. Rendering any star pressed would be a lie for
    // every visitor but one.
    expect((html.match(/aria-pressed="false"/g) ?? []).length).toBe(CHANNELS.length);
  });

  test('carries a canonical link the boot script can read the day out of', () => {
    // Boot decides `html.today` from this, not from the URL, because `/` serves
    // the newest stored day when there is no today. It also has to be parsed
    // before the boot script runs, so its position in <head> is load-bearing.
    const html = page([prog(SLUG, 1000, 2000, 'Что-то')]);

    expect(html).toContain(`<link rel="canonical" href="/day/${DAY}">`);
    expect(html.indexOf('rel="canonical"')).toBeLessThan(html.indexOf('<script>'));
  });

  test('reports the feed and the time the run log actually recorded', () => {
    // Both were previously invented by the renderer: the source was hardcoded to
    // the primary, the time was whenever the page cache happened to be built.
    expect(page([], { updatedUtc: mskDayStartUtc(DAY) + 9 * 3600 + 14 * 60, source: 'iptvx.one' })).toContain(
      'Обновлено 09:14 МСК, источник iptvx.one',
    );
  });

  test('claims no freshness at all when nothing has ever been ingested', () => {
    // The empty database case. Printing the current time here is the one thing
    // the footer must never do — it is the only staleness signal a visitor gets.
    const html = page([], { updatedUtc: undefined, source: undefined });

    expect(html).toContain('Расписание ещё ни разу не загружалось');
    expect(html).not.toContain('Обновлено');
  });

  test('shows a banner when the guide came from the fallback feed', () => {
    const html = page([], { staleNote: 'Данные из резервного источника iptvx.one' });

    expect(html).toContain('<div class="stale">Данные из резервного источника iptvx.one</div>');
  });
});

describe('DEFAULT_FAVOURITES', () => {
  test('names only channels that exist', () => {
    // Substituted into the client bundle and validated there against the same
    // list, so a typo here does not fail loudly — it silently produces a
    // default of nothing, and every visitor gets plain broadcast order.
    const slugs = new Set(CHANNELS.map((channel) => channel.slug));
    for (const slug of DEFAULT_FAVOURITES) {
      expect(slugs.has(slug)).toBe(true);
    }
    expect(DEFAULT_FAVOURITES.length).toBeGreaterThan(0);
  });
});

describe('CHANNELS', () => {
  test('has a distinct slug per channel', () => {
    expect(new Set(CHANNELS.map((channel) => channel.slug)).size).toBe(CHANNELS.length);
  });

  test('pins a distinct, non-empty id for every channel in every feed', () => {
    // Two channels sharing an id would silently drop one of them: the id map is
    // built id -> slug, so the second entry overwrites the first and that
    // channel's column comes up empty with nothing reported anywhere.
    for (const source of SOURCE_NAMES) {
      const ids = CHANNELS.map((channel) => channel.sourceIds[source]);
      expect(ids.every((id) => id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(CHANNELS.length);
    }
  });

  test('builds a different id map per feed, each covering every channel', () => {
    // The bug this pins down: one global map, built from the primary's ids and
    // handed to whichever feed was being read. It made the fallback incapable of
    // resolving a single channel, and it type-checked perfectly.
    const [primary, fallback] = SOURCE_NAMES;
    const first = sourceIndex(primary);
    const second = sourceIndex(fallback);

    expect(first.size).toBe(CHANNELS.length);
    expect(second.size).toBe(CHANNELS.length);
    expect([...first.keys()]).not.toEqual([...second.keys()]);
    expect(new Set(first.values())).toEqual(new Set(second.values()));
  });
});
