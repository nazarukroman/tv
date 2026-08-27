import { asSlugList, normaliseFavourites } from './favourites.ts';

/** The one key this site writes. Namespaced, because the origin may host more later. */
const STORAGE_KEY = 'tv.favourites';

/**
 * Reads the saved list.
 *
 * Storage is *unavailable* rather than empty in a locked-down browser, and
 * reading it can throw rather than return null. Both mean the same thing here
 * — no preference — so both collapse to `undefined` and the caller falls back
 * to the default line-up.
 */
export function readFavourites(): readonly string[] | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? undefined : asSlugList(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Saves the list. A refusal to store is not worth interrupting anyone over. */
export function writeFavourites(list: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Private mode, storage disabled, or quota exceeded. The choice still
    // applies to this page; it simply will not survive a reload.
  }
}

/** The list this visitor should see, already validated against the line-up. */
export function currentFavourites(): readonly string[] {
  return normaliseFavourites(readFavourites(), __SLUGS__, __DEFAULT_FAVOURITES__);
}
