/**
 * Comparing channel names across feed rebuilds.
 *
 * The pinned `sourceId` needs a guard, and the obvious guard — "does this id
 * still carry the name we expect" — cannot use string equality. Measured on
 * two builds of the same feed a few hours apart, the alias set for one channel
 * changed from nine entries led by 'Первый канал' to seven led by 'Первый
 * FHD', with no bare name present at all. Several channels never carry a plain
 * name: id 162 offers only 'НТВ HD' and 'НТВ HD orig'.
 *
 * Case is not stable either ('Рен ТВ' vs 'РЕН ТВ', 'СПАС' vs 'Спас'), and
 * aliases carry decoration: quality suffixes, an 'orig' marker, timeshift
 * offsets like '+4', and a region in parentheses.
 *
 * So names are normalised down to their identifying core before comparison.
 * The stripping list is deliberately narrow — only tokens observed in this
 * feed — because an over-eager rule would collapse genuinely distinct channels
 * (Россия 1 and Россия 24 differ only by a number).
 */

/** Quality and provenance markers that never distinguish two channels here. */
const DECORATIONS = new Set(['hd', 'fhd', 'uhd', 'sd', '4k', 'orig', '50']);

/**
 * ' +0', ' +4' — a timeshifted feed of the same channel.
 *
 * Removed before digits are spaced out below: doing it after would split '+4'
 * into '+' and '4' and leave the offset in the name.
 */
const TIMESHIFT = /\s[+-]\d+\b/g;

/** A trailing '(Белгород)' names the originating region, not the channel. */
const REGION = /\([^)]*\)/g;

/**
 * Reduces a display name to a comparable core: lower case, no decoration, no
 * punctuation, single spaces. 'ТВ-3 HD orig' and 'ТВ3' both become 'тв 3'.
 */
export function normaliseChannelName(raw: string): string {
  const bare = raw.replace(REGION, ' ').replace(TIMESHIFT, ' ');

  // Punctuation carries no identity here: 'Муз-ТВ' and 'Муз ТВ' are one channel,
  // and 'Пятница!' loses nothing by dropping the mark. Digits are separated
  // from letters so 'ТВ3' and 'ТВ-3' converge on the same core.
  const words = bare
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(\d+)/g, ' $1 ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '' && !DECORATIONS.has(word));

  return words.join(' ');
}

/**
 * True when `expected` names the same channel as any of `aliases`.
 *
 * Membership over the whole alias set, never equality with the first entry:
 * the leading alias is frequently a regional or quality variant.
 */
export function matchesChannel(expected: string, aliases: readonly string[]): boolean {
  const target = normaliseChannelName(expected);
  if (target === '') {
    return false;
  }
  return aliases.some((alias) => normaliseChannelName(alias) === target);
}
