import { mskDay } from '../lib/time.ts';
import { favouritesCss } from './favourites.ts';
import { currentFavourites } from './storage.ts';

/**
 * Runs synchronously in `<head>`, and has to.
 *
 * It settles everything the first paint depends on and the server could not
 * know: which channels this visitor keeps, in which order, and whether the day
 * on screen is today. Every later moment is too late — the document carries
 * all twenty columns in broadcast order and reserves no room for the "on air"
 * strip, so doing any of this after the page has painted rearranges it in
 * front of the reader.
 *
 * It is a stylesheet and two class names rather than a pass over the markup,
 * because at this point in the parse there is no markup yet.
 */
const root = document.documentElement;

// Tells the stylesheet that the collapsed columns can be unfolded again, and
// that the controls needing scripting are worth showing. With scripting off
// nothing folds and nothing dead is offered.
root.classList.add('js');

// `/` serves today's page directly rather than redirecting to it, so a path
// with no date in it is today by construction.
const onScreen = /\/day\/(\d{4}-\d{2}-\d{2})/.exec(location.pathname)?.[1];
if (onScreen === undefined || onScreen === mskDay(Math.floor(Date.now() / 1000))) {
  root.classList.add('today');
}

const css = favouritesCss(currentFavourites(), __SLUGS__.length, true);
if (css !== '') {
  const style = document.createElement('style');
  style.id = 'fav-style';
  style.textContent = css;
  document.head.append(style);
}
