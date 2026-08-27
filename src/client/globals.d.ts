/**
 * Constants the bundler substitutes at build time.
 *
 * The channel list is configuration, not page data: it is identical on every
 * day's document and changes only when `config/channels.ts` does. Baking it
 * into the bundle keeps it out of the markup, and — more importantly — lets
 * the boot script validate a saved favourites list before it writes a rule.
 * Without that check a stale slug in `localStorage` would hide all twenty
 * columns and the page would come up blank.
 */
declare const __SLUGS__: readonly string[];
declare const __DEFAULT_FAVOURITES__: readonly string[];
