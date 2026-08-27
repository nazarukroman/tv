import { describe, expect, test } from 'bun:test';

import { CHANNELS } from '../src/config/channels.ts';
import { mskDayStartUtc } from '../src/lib/time.ts';
import { durationLabel, escapeHtml, renderDayPage } from '../src/render/page.ts';

import type { Programme } from '../src/lib/types.ts';

const DAY = '2026-08-26';
const DAYS: readonly string[] = [DAY];

function prog(channelSlug: string, startUtc: number, stopUtc: number, title: string): Programme {
  return { channelSlug, startUtc, stopUtc, day: DAY, title, description: undefined };
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
    const html = renderDayPage({
      day: DAY,
      days: DAYS,
      programmes: [prog(CHANNELS[0]!.slug, 1000, 2000, hostile)],
      updatedUtc: 1000,
      staleNote: undefined,
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;boom&quot;');
  });

  test('gives every configured channel a column, even with no programmes that day', () => {
    const html = renderDayPage({
      day: DAY,
      days: DAYS,
      programmes: [prog(CHANNELS[0]!.slug, 1000, 2000, 'Что-то')],
      updatedUtc: 1000,
      staleNote: undefined,
    });

    expect((html.match(/class="col"/g) ?? []).length).toBe(CHANNELS.length);
    for (const channel of CHANNELS.slice(1)) {
      expect(html).toContain(`data-ch="${channel.slug}"`);
    }
    expect(html).toContain('Нет данных за этот день');
  });

  test('round-trips start and duration through data-s and data-d', () => {
    const start = mskDayStartUtc(DAY) + 10 * 3600; // 10:00 MSK
    const stop = start + 25 * 60; // 25-minute programme
    const html = renderDayPage({
      day: DAY,
      days: DAYS,
      programmes: [prog(CHANNELS[0]!.slug, start, stop, 'Утренняя передача')],
      updatedUtc: 1000,
      staleNote: undefined,
    });

    expect(html).toContain(`data-s="${start}"`);
    expect(html).toContain('data-d="25"');
  });

  test('marks data-prime only for programmes overlapping 18:00-24:00 MSK', () => {
    const dayStart = mskDayStartUtc(DAY);
    const slug = CHANNELS[0]!.slug;
    const overlapping = prog(slug, dayStart + 19 * 3600, dayStart + 20 * 3600, 'В прайм-тайм');
    const outside = prog(slug, dayStart + 8 * 3600, dayStart + 9 * 3600, 'Утром');
    const endsAt18 = prog(slug, dayStart + 17 * 3600, dayStart + 18 * 3600, 'До прайма');
    const startsAt24 = prog(slug, dayStart + 24 * 3600, dayStart + 25 * 3600, 'После прайма');

    const html = renderDayPage({
      day: DAY,
      days: DAYS,
      programmes: [overlapping, outside, endsAt18, startsAt24],
      updatedUtc: 1000,
      staleNote: undefined,
    });

    expect(rowFor(html, overlapping.startUtc)).toContain(' data-prime');
    expect(rowFor(html, outside.startUtc)).not.toContain(' data-prime');
    // Boundary: a programme ending exactly at 18:00 does not overlap the
    // window at all — stop must be strictly greater than the window start.
    expect(rowFor(html, endsAt18.startUtc)).not.toContain(' data-prime');
    // Boundary: a programme starting exactly at 24:00 belongs to the next
    // day's window, not this one — start must be strictly less than 24:00.
    expect(rowFor(html, startsAt24.startUtc)).not.toContain(' data-prime');
  });
});
