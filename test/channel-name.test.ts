import { describe, expect, test } from 'bun:test';

import { matchesChannel, normaliseChannelName } from '../src/lib/channel-name.ts';

/**
 * Alias lists copied verbatim from a live epg.one build on 2026-08-26.
 *
 * They are the point of the test. An earlier build of the same feed led id 146
 * with a bare 'Первый канал'; hours later it led with 'Первый FHD' and carried
 * no bare name at all. Pinning real strings is what stops the matcher from
 * being quietly rewritten to something that only works on tidy input.
 */
const LIVE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  pervy: ['Первый FHD', 'Первый HD', 'Первый HD Orig', 'Первый канал FHD', 'Первый канал HD', 'Первый канал HD 50'],
  rossia1: ['Россия 1 FHD', 'Россия 1 HD', 'Россия 1 HD 50', 'Россия FHD', 'Россия HD'],
  ntv: ['НТВ HD', 'НТВ HD orig'],
  ren: ['Рен ТВ HD', 'Рен ТВ HD orig'],
  spas: ['СПАС', 'СПАС orig'],
  pyatnica: ['Пятница! HD'],
  tnt: ['ТНТ FHD', 'ТНТ HD', 'ТНТ HD 50', 'ТНТ HD Orig'],
  muztv: ['МУЗ-ТВ', 'МУЗ-ТВ +4', 'МУЗ-ТВ HD', 'Муз ТВ +0 (Элиста)', 'Муз ТВ'],
  tv3: ['ТВ', 'ТВ-3', 'ТВ-3 +4 (Томск)', 'ТВ-3 HD orig', 'ТВ3', 'ТВ3 +0 (Белгород)'],
};

describe('normaliseChannelName', () => {
  test('strips quality and provenance markers', () => {
    expect(normaliseChannelName('ТНТ FHD')).toBe('тнт');
    expect(normaliseChannelName('НТВ HD orig')).toBe('нтв');
    expect(normaliseChannelName('Первый канал HD 50')).toBe('первый канал');
  });

  test('strips a quality marker that carries a digit', () => {
    // '4k' sat in the token filter, which runs after digits are spaced apart —
    // so by then it was the two tokens '4' and 'k' and could never match.
    // 'Матч ТВ 4K' normalised to 'матч тв 4 k' and failed its own pin.
    expect(normaliseChannelName('Матч ТВ 4K')).toBe('матч тв');
    expect(matchesChannel('Матч ТВ', ['Матч ТВ 4K'])).toBe(true);
  });

  test('strips a timeshift offset without eating the digits of a name', () => {
    expect(normaliseChannelName('МУЗ-ТВ +4')).toBe('муз тв');
    // The offset goes, but '1' and '24' are part of the identity and must stay.
    expect(normaliseChannelName('Россия 1 +4')).toBe('россия 1');
    expect(normaliseChannelName('Россия 24')).toBe('россия 24');
  });

  test('strips a parenthesised region', () => {
    expect(normaliseChannelName('Муз ТВ +0 (Элиста)')).toBe('муз тв');
    expect(normaliseChannelName('МАТЧ! +0 (Белгород)')).toBe('матч');
  });

  test('is case-insensitive and punctuation-insensitive', () => {
    expect(normaliseChannelName('СПАС')).toBe(normaliseChannelName('Спас'));
    expect(normaliseChannelName('Рен ТВ')).toBe(normaliseChannelName('РЕН ТВ'));
    expect(normaliseChannelName('Муз-ТВ')).toBe(normaliseChannelName('Муз ТВ'));
    expect(normaliseChannelName('Пятница!')).toBe(normaliseChannelName('Пятница'));
  });

  test('converges hyphenated and glued digit forms', () => {
    expect(normaliseChannelName('ТВ-3')).toBe(normaliseChannelName('ТВ3'));
  });

  test('folds ё to е', () => {
    expect(normaliseChannelName('Ёлки')).toBe(normaliseChannelName('Елки'));
  });
});

describe('matchesChannel', () => {
  test.each(Object.entries(LIVE_ALIASES))('resolves %s against its live aliases', (slug, aliases) => {
    const expected: Readonly<Record<string, string>> = {
      pervy: 'Первый канал',
      rossia1: 'Россия 1',
      ntv: 'НТВ',
      ren: 'РЕН ТВ',
      spas: 'Спас',
      pyatnica: 'Пятница!',
      tnt: 'ТНТ',
      muztv: 'Муз-ТВ',
      tv3: 'ТВ-3',
    };
    expect(matchesChannel(expected[slug]!, aliases)).toBe(true);
  });

  test('matches on any alias, not only the first', () => {
    // The leading alias is routinely a regional or quality variant.
    expect(matchesChannel('Первый канал', LIVE_ALIASES.pervy!)).toBe(true);
    expect(normaliseChannelName(LIVE_ALIASES.pervy![0]!)).toBe('первый');
  });

  test('does not conflate channels that differ only by number', () => {
    // The failure that would matter most: silently binding Россия 1 to the
    // Россия 24 feed, which looks like working software showing wrong data.
    expect(matchesChannel('Россия 1', ['Россия 24 HD'])).toBe(false);
    expect(matchesChannel('Россия 24', ['Россия 1 FHD'])).toBe(false);
    expect(matchesChannel('ТВ-3', ['ТВ Центр'])).toBe(false);
  });

  test('does not match a differently-named sibling channel', () => {
    expect(matchesChannel('Матч ТВ', ['Матч! Футбол 1', 'Матч Премьер'])).toBe(false);
    expect(matchesChannel('ТНТ', ['ТНТ4 HD', 'ТНТ Music'])).toBe(false);
  });

  test('refuses an empty expectation rather than matching everything', () => {
    expect(matchesChannel('', ['ТНТ HD'])).toBe(false);
  });
});
