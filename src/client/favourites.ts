/**
 * What a favourites list means, as arithmetic over arrays of slugs.
 *
 * Nothing here touches the DOM or storage, and that is the point rather than
 * an accident. This is the only state the site persists, three separate
 * scripts read it, and it is the one place where a bug shows up as the wrong
 * channel rather than as a misaligned box — so it is the part worth pinning
 * down with tests, and it is testable only while it stays this shape.
 *
 * A favourite orders the guide; it never hides anything. Every channel is on
 * the page from the first paint, so "no favourites" is a perfectly good state
 * — twenty columns in broadcast order — and nothing in this file has to defend
 * against an empty list.
 */

/**
 * A stored list, made safe to act on.
 *
 * Only "nothing was ever saved" falls through to the default line-up. An empty
 * list is a choice — the visitor unstarred everything — and survives as itself,
 * which it could not do while an empty list meant a blank page.
 *
 * A slug the line-up no longer carries is dropped, as is a repeat: both would
 * otherwise produce an order rule for a column that does not exist, or two for
 * one that does.
 */
export function normaliseFavourites(
  saved: readonly string[] | undefined,
  known: readonly string[],
  fallback: readonly string[],
): readonly string[] {
  if (saved === undefined) {
    return fallback;
  }

  const valid = new Set(known);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const slug of saved) {
    if (valid.has(slug) && !seen.has(slug)) {
      seen.add(slug);
      kept.push(slug);
    }
  }
  return kept;
}

/** Adds a slug to the end, or removes it. */
export function toggleFavourite(list: readonly string[], slug: string): readonly string[] {
  return list.includes(slug) ? list.filter((each) => each !== slug) : [...list, slug];
}

/**
 * Display order: favourites first, in the visitor's order, then the rest as
 * broadcast.
 *
 * One function for both places a channel list appears — the guide and the "on
 * air" strip — because "favourites first" has to mean the same thing in both.
 * Two copies of this rule would drift the moment one of them learned about a
 * new case.
 */
export function favouritesFirst<T extends { readonly slug: string }>(
  items: readonly T[],
  favourites: readonly string[],
): readonly T[] {
  const bySlug = new Map(items.map((item) => [item.slug, item]));
  const picked = new Set(favourites);
  const chosen = favourites.map((slug) => bySlug.get(slug)).filter((item) => item !== undefined);
  return [...chosen, ...items.filter((item) => !picked.has(item.slug))];
}

/**
 * The stylesheet that puts favourites first before there is any DOM to move.
 *
 * The boot script runs while `<head>` is still being parsed, so the columns it
 * needs to reorder do not exist yet — CSS `order` is the only lever available
 * that early. Favourites are numbered backwards from zero so that everything
 * else, sitting at the initial `order: 0`, falls in behind them without needing
 * a rule of its own: twenty channels cost two declarations, not twenty.
 *
 * The application retires this the moment it loads, by moving the columns for
 * real. It has to: `order` leaves the reading order and the tab order
 * disagreeing with the screen, which is WCAG 1.3.2, and at phone width — where
 * the guide is a single column — that is the difference between a usable page
 * and a scrambled one. The two produce the same picture, so the hand-off moves
 * no pixels.
 */
export function favouritesOrderCss(favourites: readonly string[]): string {
  return favourites.map((slug, index) => `[data-ch="${slug}"]{order:${index - favourites.length}}`).join('');
}

/** Every value that is not a list of strings reads as "nothing saved". */
export function asSlugList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((each) => typeof each === 'string') ? (value as readonly string[]) : undefined;
}
