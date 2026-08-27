/**
 * What a favourites list means, as arithmetic over arrays of slugs.
 *
 * Nothing here touches the DOM or storage, and that is the point rather than
 * an accident. This is the only state the site persists, three separate
 * scripts read it, and it is the one place where a bug shows up as the wrong
 * channel rather than as a misaligned box — so it is the part worth pinning
 * down with tests, and it is testable only while it stays this shape.
 */

/**
 * A stored list, made safe to act on.
 *
 * Two failures are realistic and both must degrade to something sensible: a
 * slug that no longer exists because the line-up changed, and a list that ends
 * up empty. Empty is not "hide everything" — it is "this visitor has expressed
 * no preference", so it falls through to the default.
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
  return kept.length > 0 ? kept : fallback;
}

/** Adds a slug to the end, or removes it. */
export function toggleFavourite(list: readonly string[], slug: string): readonly string[] {
  return list.includes(slug) ? list.filter((each) => each !== slug) : [...list, slug];
}

/**
 * The stylesheet that puts a favourites list on screen.
 *
 * Two rules, and which of them is present depends on when this runs.
 *
 * Before first paint there is no DOM to rearrange, so visual order comes from
 * CSS `order` — a channel the visitor did not pick is hidden, and the ones
 * they did are numbered. After the page has painted, the application moves the
 * columns for real and asks for the same CSS without `order`, because `order`
 * leaves the reading order and the tab order disagreeing with the screen. That
 * is WCAG 1.3.2, and at phone width, where the guide is a single column, it is
 * the difference between a usable page and a scrambled one.
 *
 * Doing it in that sequence is what makes it free: the visual result of the
 * two is identical, so the hand-off moves no pixels.
 */
export function favouritesCss(favourites: readonly string[], total: number, withOrder: boolean): string {
  const rules: string[] = [];

  if (favourites.length < total) {
    const shown = favourites.map((slug) => `[data-ch="${slug}"]`).join(',');
    rules.push(`.col:not(${shown}){display:none}`);
  }
  if (withOrder) {
    favourites.forEach((slug, index) => rules.push(`[data-ch="${slug}"]{order:${index + 1}}`));
  }
  return rules.join('');
}

/** Every value that is not a list of strings reads as "nothing saved". */
export function asSlugList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((each) => typeof each === 'string') ? (value as readonly string[]) : undefined;
}
