import { describe, expect, test } from 'bun:test';

import {
  asSlugList,
  favouritesFirst,
  favouritesOrderCss,
  normaliseFavourites,
  toggleFavourite,
} from '../src/client/favourites.ts';

const KNOWN: readonly string[] = ['pervy', 'rossia1', 'ntv', 'tnt', 'sts'];
const FALLBACK: readonly string[] = ['tnt', 'matchtv'];

/** The shape both call sites share: a column and a live card are both this. */
const COLUMNS = KNOWN.map((slug) => ({ slug }));

describe('normaliseFavourites', () => {
  test('drops a slug the line-up no longer carries', () => {
    // A channel retired from config/channels.ts must not survive in a stored
    // list — otherwise it would take an order slot for a column that is never
    // rendered, pushing the real favourites one place down the guide.
    expect(normaliseFavourites(['pervy', 'retired', 'ntv'], KNOWN, FALLBACK)).toEqual(['pervy', 'ntv']);
  });

  test('drops a repeat, keeping only its first position', () => {
    expect(normaliseFavourites(['ntv', 'pervy', 'ntv'], KNOWN, FALLBACK)).toEqual(['ntv', 'pervy']);
  });

  test('keeps an empty list empty rather than restoring the defaults', () => {
    // Unstarring the last channel is a choice, not a reset. Every channel is on
    // the page either way, so "no favourites" simply means broadcast order —
    // and quietly bringing the defaults back would overrule the visitor.
    expect(normaliseFavourites([], KNOWN, FALLBACK)).toEqual([]);
    expect(normaliseFavourites(['gone', 'also-gone'], KNOWN, FALLBACK)).toEqual([]);
  });

  test('falls back when nothing was ever saved', () => {
    expect(normaliseFavourites(undefined, KNOWN, FALLBACK)).toEqual(FALLBACK);
  });

  test('keeps the order the visitor picked, exactly as given', () => {
    // Order is not incidental here — it is the column order the visitor chose,
    // and a sort anywhere in this path would silently rearrange their layout.
    expect(normaliseFavourites(['sts', 'pervy', 'tnt'], KNOWN, FALLBACK)).toEqual(['sts', 'pervy', 'tnt']);
  });
});

describe('toggleFavourite', () => {
  test('appends an absent slug to the end', () => {
    expect(toggleFavourite(['pervy', 'ntv'], 'tnt')).toEqual(['pervy', 'ntv', 'tnt']);
  });

  test('removes a present slug, keeping the rest in order', () => {
    expect(toggleFavourite(['pervy', 'ntv', 'tnt'], 'ntv')).toEqual(['pervy', 'tnt']);
  });

  test('does not mutate the list it was given', () => {
    const original = ['pervy', 'ntv'];
    toggleFavourite(original, 'tnt');
    expect(original).toEqual(['pervy', 'ntv']);
  });
});

describe('favouritesFirst', () => {
  test('lifts the favourites to the front in the visitor order', () => {
    expect(favouritesFirst(COLUMNS, ['sts', 'ntv']).map((each) => each.slug)).toEqual([
      'sts',
      'ntv',
      'pervy',
      'rossia1',
      'tnt',
    ]);
  });

  test('leaves everything else in broadcast order', () => {
    // The unstarred channels are not sorted, ranked or grouped — they keep the
    // order the two multiplexes broadcast in, which is how a TV remote is
    // numbered and the only order a visitor can predict.
    expect(favouritesFirst(COLUMNS, []).map((each) => each.slug)).toEqual([...KNOWN]);
  });

  test('drops nothing: every channel comes out, exactly once', () => {
    // A favourite is an ordering, never a filter. If this ever returned fewer
    // items than it was given, columns would vanish from the guide.
    const out = favouritesFirst(COLUMNS, ['ntv', 'pervy']);
    expect(out.length).toBe(COLUMNS.length);
    expect(new Set(out.map((each) => each.slug)).size).toBe(COLUMNS.length);
  });

  test('ignores a favourite with no column of its own', () => {
    expect(favouritesFirst(COLUMNS, ['retired', 'tnt']).map((each) => each.slug)).toEqual([
      'tnt',
      'pervy',
      'rossia1',
      'ntv',
      'sts',
    ]);
  });

  test('does not mutate the list it was given', () => {
    const original = [...COLUMNS];
    favouritesFirst(original, ['sts']);
    expect(original.map((each) => each.slug)).toEqual([...KNOWN]);
  });
});

describe('favouritesOrderCss', () => {
  test('numbers favourites backwards from zero so the rest follow without a rule', () => {
    // Every unstarred column sits at the initial `order: 0`. Numbering the
    // favourites 1, 2, ... would put them *after* those columns — the exact
    // opposite of what a star means — so they have to be negative.
    const css = favouritesOrderCss(['tnt', 'matchtv']);
    expect(css).toBe('[data-ch="tnt"]{order:-2}[data-ch="matchtv"]{order:-1}');
  });

  test('emits nothing at all when nothing is starred', () => {
    // Not merely small: the boot script skips appending the <style> entirely,
    // so a visitor with no favourites pays no bytes and no style recalculation.
    expect(favouritesOrderCss([])).toBe('');
  });

  test('agrees with favouritesFirst on the order', () => {
    // The two run a few hundred milliseconds apart on the same list — CSS
    // before the first paint, a real DOM move once the bundle lands. If they
    // disagreed, the guide would rearrange itself in front of the reader, which
    // is the one thing this whole hand-off exists to prevent.
    const favourites = ['sts', 'ntv'];
    const byCss = [...COLUMNS]
      .map((column) => ({
        slug: column.slug,
        order: Number(
          new RegExp(`\\[data-ch="${column.slug}"\\]\\{order:(-?\\d+)\\}`).exec(favouritesOrderCss(favourites))?.[1] ??
            0,
        ),
      }))
      .sort((a, b) => a.order - b.order)
      .map((each) => each.slug);

    expect(byCss).toEqual(favouritesFirst(COLUMNS, favourites).map((each) => each.slug));
  });
});

describe('asSlugList', () => {
  test('accepts an array of strings', () => {
    expect(asSlugList(['pervy', 'ntv'])).toEqual(['pervy', 'ntv']);
  });

  test('accepts an empty array, which is not the same as nothing saved', () => {
    expect(asSlugList([])).toEqual([]);
  });

  test('rejects anything that is not an array', () => {
    expect(asSlugList('pervy')).toBeUndefined();
    expect(asSlugList({ 0: 'pervy' })).toBeUndefined();
    expect(asSlugList(null)).toBeUndefined();
    expect(asSlugList(undefined)).toBeUndefined();
  });

  test('rejects an array holding a non-string element', () => {
    // A hand-edited or corrupted localStorage value must read as "nothing
    // saved" rather than crash normaliseFavourites downstream.
    expect(asSlugList(['pervy', 42])).toBeUndefined();
    expect(asSlugList([null])).toBeUndefined();
  });
});
