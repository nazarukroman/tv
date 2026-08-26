import type { Programme } from '../lib/types.ts';

/**
 * The row lattice a day's grid is drawn on.
 *
 * Channels are columns and time runs down the page, so every programme needs a
 * pair of row lines. Those lines are the union of every start and stop in the
 * day plus each hour mark: that way a cell always lands on a real boundary,
 * neighbouring channels stay aligned to the minute, and no row is taller than
 * the content that justifies it.
 *
 * The alternative — a fixed row per N minutes — either wastes vertical space
 * on quiet channels or clips titles on busy ones, and measured on this data a
 * uniform scale makes about half the titles unreadable without hover.
 */

/** Pixels per minute the row heights are derived from. */
const SCALE = 1.6;

/** No row shorter than this, or a five-minute filler becomes unreadable. */
const MIN_ROW_PX = 22;

export interface Lattice {
  /** Boundary instants, ascending. Row line `i` sits at `times[i]`. */
  readonly times: readonly number[];
  /** Instant -> CSS grid line number (1-based). */
  readonly line: ReadonlyMap<number, number>;
  /** `grid-template-rows` value. */
  readonly template: string;
  readonly dayStartUtc: number;
  readonly dayEndUtc: number;
}

/** Moscow midnight that opens `day`, as unix seconds. */
export function dayStartUtc(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year!, month! - 1, date!) / 1000 - 3 * 3600;
}

export function buildLattice(day: string, programmes: readonly Programme[]): Lattice {
  const start = dayStartUtc(day);
  const end = start + 86_400;

  const times = new Set<number>([start, end]);
  for (let hour = 1; hour < 24; hour += 1) {
    times.add(start + hour * 3600);
  }
  for (const programme of programmes) {
    // Clamped: a programme may begin the previous evening or run past midnight,
    // and the day's grid only owns the part inside its own bounds.
    if (programme.startUtc > start && programme.startUtc < end) {
      times.add(programme.startUtc);
    }
    if (programme.stopUtc > start && programme.stopUtc < end) {
      times.add(programme.stopUtc);
    }
  }

  const sorted = [...times].sort((a, b) => a - b);
  const line = new Map<number, number>();
  sorted.forEach((time, index) => line.set(time, index + 1));

  const rows: string[] = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const minutes = (sorted[index + 1]! - sorted[index]!) / 60;
    const height = Math.max(MIN_ROW_PX, Math.round(minutes * SCALE));
    rows.push(`minmax(${height}px,auto)`);
  }

  return { times: sorted, line, template: rows.join(' '), dayStartUtc: start, dayEndUtc: end };
}

/** Grid lines a programme occupies, clamped into the day. */
export function placement(lattice: Lattice, programme: Programme): { from: number; to: number } | undefined {
  const from = lattice.line.get(Math.max(programme.startUtc, lattice.dayStartUtc));
  const to = lattice.line.get(Math.min(programme.stopUtc, lattice.dayEndUtc));
  if (from === undefined || to === undefined || to <= from) {
    return undefined;
  }
  return { from, to };
}
