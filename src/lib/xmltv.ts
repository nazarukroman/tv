import { mskDay, parseXmltvTime } from './time.ts';

import type { ChannelRecord, Programme } from './types.ts';

/**
 * A streaming XMLTV reader.
 *
 * The feed is 25 MB gzipped and roughly 150 MB of XML holding ~465 000
 * programmes, of which we keep about 7 600. Loading that into a DOM would cost
 * hundreds of megabytes for a result measured in single-digit ones, so this
 * scans the character stream instead and never holds more than one element.
 *
 * The cheap part matters: every `<programme>` opening tag is tested for its
 * `channel` attribute before anything else is parsed, so ~98% of elements are
 * discarded on a substring compare rather than a parse.
 *
 * This is deliberately not a general XML parser. It handles exactly the shape
 * XMLTV emits — flat `<channel>` and `<programme>` elements with simple text
 * children, no CDATA, no namespaces, no same-name nesting.
 */

/** Refuses to buffer more than this between element boundaries. */
const MAX_ELEMENT_CHARS = 1 << 20;

/**
 * Longest opening-tag prefix we must compare against — `'<programme '`.
 *
 * A `<` may not be discarded until at least this many characters follow it,
 * or a chunk boundary landing mid-tag makes the comparison fail for lack of
 * input and the scanner steps past the start of a real element. That loses
 * rows silently, which is the worst way to lose them.
 */
const LOOKAHEAD_CHARS = '<programme '.length;

/**
 * A `Map`, not an object literal, and the difference is not stylistic: the key
 * is a substring of the feed. `ENTITIES['constructor']` on an object literal
 * resolves through `Object.prototype` and returns a function, so `&constructor;`
 * in a title rendered as `function Object() { [native code] }` and was stored
 * that way. A `Map` has no prototype chain to fall through.
 */
const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

/** The highest code point Unicode defines; above it `String.fromCodePoint` throws. */
const MAX_CODE_POINT = 0x10_ffff;

/**
 * Titles arrive with a Russian content-type prefix on a large share of rows —
 * 'т/с' for a series, 'х/ф' film, 'м/ф' animation, 'д/ф' documentary. It is
 * noise in a column heading and, worse, it defeats search: someone typing the
 * actual title never matches a string that starts with 'т/с '.
 */
const TYPE_PREFIX = /^[а-яё]{1,3}\/[а-яё]\s+/i;

const DISPLAY_NAME = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;

export interface XmltvHandlers {
  readonly onChannel?: (channel: ChannelRecord) => void;
  readonly onProgramme?: (programme: Programme) => void;
}

/** A value `String.fromCodePoint` will accept and that means a real character. */
function isCodePoint(code: number): boolean {
  return Number.isInteger(code) && code > 0 && code <= MAX_CODE_POINT && (code < 0xd800 || code > 0xdfff);
}

/** Resolves the entity forms XMLTV actually emits, including numeric ones. */
export function decodeEntities(raw: string): string {
  if (!raw.includes('&')) {
    return raw;
  }

  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole: string, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // Bounded, not merely positive. `String.fromCodePoint` throws a RangeError
      // above U+10FFFF, and the throw escaped all the way out of the scan — so
      // one `&#1114112;` anywhere in 465 000 elements aborted the entire run.
      // A lone surrogate is refused for the same reason `parseXmltvTime` refuses
      // a malformed date: it would be stored and rendered as a broken character.
      return isCodePoint(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES.get(body.toLowerCase()) ?? whole;
  });
}

export function stripTypePrefix(title: string): string {
  return title.replace(TYPE_PREFIX, '').trim();
}

/** Reads one attribute out of an opening tag. Attributes are always quoted here. */
function readAttribute(tag: string, name: string): string | undefined {
  const at = tag.indexOf(` ${name}="`);
  if (at === -1) {
    return undefined;
  }

  const from = at + name.length + 3;
  const to = tag.indexOf('"', from);
  return to === -1 ? undefined : tag.slice(from, to);
}

/** First direct child element's text, decoded and trimmed. */
function readChildText(body: string, tag: string): string | undefined {
  const open = body.indexOf(`<${tag}`);
  if (open === -1) {
    return undefined;
  }

  const gt = body.indexOf('>', open);
  if (gt === -1 || body[gt - 1] === '/') {
    // Either malformed, or self-closing and therefore carrying no text.
    return undefined;
  }

  const close = body.indexOf(`</${tag}>`, gt);
  if (close === -1) {
    return undefined;
  }

  const text = decodeEntities(body.slice(gt + 1, close)).trim();
  return text === '' ? undefined : text;
}

function emitChannel(openTag: string, body: string, handlers: XmltvHandlers): void {
  if (handlers.onChannel === undefined) {
    return;
  }

  const id = readAttribute(openTag, 'id');
  if (id === undefined) {
    return;
  }

  const names: string[] = [];
  for (const match of body.matchAll(DISPLAY_NAME)) {
    const text = decodeEntities(match[1] ?? '').trim();
    if (text !== '') {
      names.push(text);
    }
  }

  handlers.onChannel({ id, names });
}

function emitProgramme(
  openTag: string,
  body: string,
  wanted: ReadonlyMap<string, string>,
  handlers: XmltvHandlers,
): void {
  if (handlers.onProgramme === undefined) {
    return;
  }

  // The whole point of the filter: bail before parsing anything else.
  const channelId = readAttribute(openTag, 'channel');
  if (channelId === undefined) {
    return;
  }

  const channelSlug = wanted.get(channelId);
  if (channelSlug === undefined) {
    return;
  }

  const rawStart = readAttribute(openTag, 'start');
  const rawStop = readAttribute(openTag, 'stop');
  if (rawStart === undefined || rawStop === undefined) {
    return;
  }

  const startUtc = parseXmltvTime(rawStart);
  const stopUtc = parseXmltvTime(rawStop);
  // A zero-or-negative span is corrupt, not a real slot.
  if (startUtc === undefined || stopUtc === undefined || stopUtc <= startUtc) {
    return;
  }

  const rawTitle = readChildText(body, 'title');
  if (rawTitle === undefined) {
    return;
  }

  const title = stripTypePrefix(rawTitle);
  if (title === '') {
    return;
  }

  handlers.onProgramme({
    channelSlug,
    startUtc,
    stopUtc,
    day: mskDay(startUtc),
    title,
    description: readChildText(body, 'desc'),
  });
}

/**
 * Scans a decoded XMLTV text stream, invoking handlers per element.
 *
 * `wanted` maps the feed's channel id to our slug; anything absent from it is
 * skipped without being parsed.
 */
export async function scanXmltv(
  text: ReadableStream<string>,
  wanted: ReadonlyMap<string, string>,
  handlers: XmltvHandlers,
): Promise<void> {
  const reader = text.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value !== undefined) {
        buffer += value;
      }

      let cursor = 0;
      for (;;) {
        const open = buffer.indexOf('<', cursor);
        if (open === -1) {
          // No element start left in the buffer — the rest is text between
          // elements and can be dropped, which is what keeps memory constant.
          cursor = buffer.length;
          break;
        }

        if (!done && buffer.length - open < LOOKAHEAD_CHARS) {
          // Not enough characters yet to tell what this element is. Leave the
          // '<' in place and wait; discarding it here would eat a real row.
          break;
        }

        const isChannel = buffer.startsWith('<channel ', open) || buffer.startsWith('<channel>', open);
        const isProgramme = buffer.startsWith('<programme ', open);
        if (!isChannel && !isProgramme) {
          // Not an element we care about; step past this '<' and keep looking.
          cursor = open + 1;
          continue;
        }

        const closeTag = isChannel ? '</channel>' : '</programme>';
        const end = buffer.indexOf(closeTag, open);
        if (end === -1) {
          // Incomplete element — wait for more input rather than guessing.
          break;
        }

        const element = buffer.slice(open, end + closeTag.length);
        const gt = element.indexOf('>');
        if (gt !== -1) {
          const openTag = element.slice(0, gt + 1);
          const body = element.slice(gt + 1, element.length - closeTag.length);
          if (isChannel) {
            emitChannel(openTag, body, handlers);
          } else {
            emitProgramme(openTag, body, wanted, handlers);
          }
        }

        cursor = end + closeTag.length;
      }

      if (cursor > 0) {
        buffer = buffer.slice(cursor);
      }

      if (buffer.length > MAX_ELEMENT_CHARS) {
        throw new Error(
          `xmltv: no element boundary within ${MAX_ELEMENT_CHARS} chars — feed is not the expected shape`,
        );
      }

      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
