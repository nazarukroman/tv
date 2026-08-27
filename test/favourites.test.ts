import { describe, expect, test } from 'bun:test';

import { asSlugList, favouritesCss, normaliseFavourites, toggleFavourite } from '../src/client/favourites.ts';

const KNOWN: readonly string[] = ['pervy', 'rossia1', 'ntv', 'tnt', 'sts'];
const FALLBACK: readonly string[] = ['pervy', 'rossia1'];

describe('normaliseFavourites', () => {
  test('drops a slug the line-up no longer carries', () => {
    // A channel retired from config/channels.ts must not survive in a stored
    // list — otherwise favouritesCss would build a selector for a column that
    // is never rendered, and that channel would count toward "has favourites"
    // while showing nothing.
    expect(normaliseFavourites(['pervy', 'retired', 'ntv'], KNOWN, FALLBACK)).toEqual(['pervy', 'ntv']);
  });

  test('drops a repeat, keeping only its first position', () => {
    expect(normaliseFavourites(['ntv', 'pervy', 'ntv'], KNOWN, FALLBACK)).toEqual(['ntv', 'pervy']);
  });

  test('falls back when nothing valid survives', () => {
    // Empty is not "hide every channel" — it means the visitor never chose,
    // so the default line-up must show instead of a blank guide.
    expect(normaliseFavourites(['gone', 'also-gone'], KNOWN, FALLBACK)).toEqual(FALLBACK);
    expect(normaliseFavourites([], KNOWN, FALLBACK)).toEqual(FALLBACK);
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

describe('favouritesCss', () => {
  test('emits no hide rule when every channel is a favourite', () => {
    expect(favouritesCss(KNOWN, KNOWN.length, false)).not.toContain('display:none');
  });

  test('emits order rules only when asked', () => {
    const withOrder = favouritesCss(FALLBACK, KNOWN.length, true);
    const withoutOrder = favouritesCss(FALLBACK, KNOWN.length, false);
    expect(withOrder).toContain('[data-ch="pervy"]{order:1}');
    expect(withOrder).toContain('[data-ch="rossia1"]{order:2}');
    expect(withoutOrder).not.toContain('order:');
  });

  test('the pre-paint and post-paint calls hide the same set of channels', () => {
    // The hand-off from CSS `order` to a real DOM move must not itself move a
    // column: if the hide selector differed between the two calls, a channel
    // would appear or disappear at the exact moment favourites get applied for
    // real, which is exactly the "rearranges after paint" bug this guards.
    const favourites = ['ntv', 'sts'];
    const beforePaint = favouritesCss(favourites, KNOWN.length, true);
    const afterPaint = favouritesCss(favourites, KNOWN.length, false);

    const hideRule = /\.col:not\(([^)]*)\)\{display:none\}/;
    expect(hideRule.exec(beforePaint)?.[1]).toBe(hideRule.exec(afterPaint)?.[1]);
  });
});

describe('asSlugList', () => {
  test('accepts an array of strings', () => {
    expect(asSlugList(['pervy', 'ntv'])).toEqual(['pervy', 'ntv']);
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
