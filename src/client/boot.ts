import { mskDay } from '../lib/time.ts';
import { todayTabCss } from './day-tabs.ts';
import { favouritesOrderCss } from './favourites.ts';
import { currentFavourites } from './storage.ts';

/**
 * Runs synchronously in `<head>`, and has to.
 *
 * It settles everything the first paint depends on and the server could not
 * know: which channels this visitor keeps at the top, in which order, and
 * whether the day on screen is today. Every later moment is too late — the
 * document carries all twenty columns in broadcast order and reserves no room
 * for the "on air" strip, so doing any of this after the page has painted
 * rearranges it in front of the reader.
 *
 * It is a stylesheet and two class names rather than a pass over the markup,
 * because at this point in the parse there is no markup yet.
 */
const root = document.documentElement;

/**
 * One stylesheet, under a name the application can find later.
 *
 * `#fav-order` is removed once the columns have been moved for real; the day-tab
 * rule must survive that, so they are two elements rather than one string.
 */
function addStyle(id: string, css: string): void {
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.append(style);
}

// Tells the stylesheet that the collapsed columns can be unfolded again, and
// that the controls needing scripting are worth showing. With scripting off
// nothing folds and nothing dead is offered.
root.classList.add('js');

/**
 * Which day is on screen, taken from the canonical link rather than the URL.
 *
 * The URL cannot answer this. `/` serves today when there is a today, but falls
 * back to the newest day stored when there is not — so on a cold start against
 * stale data, "no date in the path" meant "today" and was wrong: the page
 * reserved room for an "on air" strip that the application then found empty and
 * removed, shifting the whole guide up by about 150 px after first paint.
 *
 * `<link rel="canonical">` always carries the real date and the parser has
 * already seen it by the time this script runs, so it costs nothing.
 */
const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '';
const onScreen = /\/day\/(\d{4}-\d{2}-\d{2})/.exec(canonical)?.[1];
const today = mskDay(Math.floor(Date.now() / 1000));
if (onScreen !== undefined && onScreen === today) {
  root.classList.add('today');
}

// Unconditional, and not only when today is the day on screen: the tab for
// today is on all fifteen pages, and it should read «Сегодня» on every one of
// them. On a page whose window no longer contains today the rule simply matches
// nothing.
addStyle('today-tab', todayTabCss(today));

const css = favouritesOrderCss(currentFavourites());
if (css !== '') {
  addStyle('fav-order', css);
}
