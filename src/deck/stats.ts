// What the solve records add up to.
//
// Everything here comes off records the app already keeps — there is no
// tracking, nothing extra is stored, and nothing leaves the browser. It is
// arithmetic over `solve:` and the positions those solves point at.
//
// Pure: no DOM, no engine, no storage, and `now` is a parameter rather than a
// call to the clock, so the streak is testable. Runs under `node --test`.

import { povDiff, type Color } from '../analysis/winningChances.ts';
import type { ReviewRow } from './review.ts';

export interface Tally {
  solved: number;
  found: number;
}

const empty = (): Tally => ({ solved: 0, found: 0 });

const add = (t: Tally, found: boolean): void => {
  t.solved++;
  if (found) t.found++;
};

/**
 * The bands are lila's own, from `modules/tree/src/main/Advice.scala`:
 * `List(.3 -> Blunder, .2 -> Mistake, .1 -> Inaccuracy)` against the drop in
 * winning chances. Reused rather than invented so that "how bad was it" means
 * the same thing here as it does in the `judgment` lichess sends, and so a
 * changed threshold shows up as one diff.
 */
export const BANDS: readonly { label: string; min: number }[] = [
  { label: 'Blunders', min: 0.3 },
  { label: 'Mistakes', min: 0.2 },
  { label: 'Inaccuracies', min: 0.1 },
];

/** How much the move played cost, from the player's own point of view. Positive. */
export const dropOf = (pov: Color, prevEval: { cp?: number; mate?: number }, ev: { cp?: number; mate?: number }): number =>
  povDiff(pov, prevEval, ev);

const bandOf = (drop: number): string => BANDS.find(b => drop >= b.min)?.label ?? 'Inaccuracies';

export interface DeckStats {
  /** Positions still to solve, and positions put aside. Context for the rest. */
  waiting: number;
  hidden: number;
  solved: number;
  /** Solved without looking at the answer. */
  found: number;
  /** Found on the very first move tried. */
  firstTry: number;
  /** Mean tries over the positions that were found; undefined when none were. */
  averageTries: number | undefined;
  /** Found rate by the side you were playing. */
  bySide: { white: Tally; black: Tally };
  /** Found rate by how bad the mistake was, worst band first. */
  byBand: { label: string; tally: Tally }[];
  /** Solves in the last seven days, and consecutive days solving up to today. */
  recent: number;
  streak: number;
}

/** Local midnight, as a day count — what a "day" means to the person solving. */
function dayNumber(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return Math.round(d.getTime() / 86_400_000);
}

/**
 * `rows` is every solve. A row whose position can no longer be derived still
 * counts towards the totals — it happened — but is left out of the breakdowns,
 * which need the position to say anything.
 */
export function deckStats(
  rows: readonly ReviewRow[],
  counts: { waiting: number; hidden: number },
  now: number,
): DeckStats {
  const bySide = { white: empty(), black: empty() };
  const bands = new Map(BANDS.map(b => [b.label, empty()]));
  let found = 0;
  let firstTry = 0;
  let tries = 0;
  const days = new Set<number>();

  for (const row of rows) {
    const won = row.result === 'win';
    if (won) {
      found++;
      tries += row.attempts ?? 0;
      if ((row.attempts ?? 0) <= 1) firstTry++;
    }
    days.add(dayNumber(row.at));
    if (!row.puzzle) continue;
    add(bySide[row.puzzle.pov], won);
    const band = bandOf(dropOf(row.puzzle.pov, row.puzzle.prevEval, row.puzzle.eval));
    add(bands.get(band)!, won);
  }

  const today = dayNumber(now);
  // Counted from today or from yesterday, so a streak is not broken by the
  // fact that it is nine in the morning and nothing has been solved yet.
  let streak = 0;
  let day = days.has(today) ? today : today - 1;
  while (days.has(day)) {
    streak++;
    day--;
  }

  return {
    waiting: counts.waiting,
    hidden: counts.hidden,
    solved: rows.length,
    found,
    firstTry,
    averageTries: found ? tries / found : undefined,
    bySide,
    byBand: BANDS.map(b => ({ label: b.label, tally: bands.get(b.label)! })),
    recent: rows.filter(r => dayNumber(r.at) > today - 7).length,
    streak,
  };
}
