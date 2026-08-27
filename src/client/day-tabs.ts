/**
 * Which day tab reads «Сегодня», as a stylesheet.
 *
 * The renderer ships both labels on every tab because it genuinely cannot tell
 * which day is today: pages are rebuilt twice a day and one of those builds is
 * still being served after midnight. The browser can tell, but it has to say so
 * before the first paint — a tab that changes width afterwards shifts every tab
 * to its right, and the day strip is a horizontal scroller where that is
 * especially easy to miss and especially annoying to hit.
 *
 * So this is CSS rather than a pass over the markup, for the same reason
 * `favouritesOrderCss` is: at the moment the boot script runs, `<nav class=days>`
 * has not been parsed yet. There is nothing to walk.
 *
 * A separate rule from the favourites one, and a separate `<style>` element,
 * because the application deletes that one the moment it has moved the columns
 * for real. This one has to outlive it.
 */
export function todayTabCss(day: string): string {
  const tab = `.days a[data-day="${day}"]`;
  return `${tab} .date{display:none}${tab} .now{display:inline}`;
}
