import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hiddenRows, lookup, reviewRows, waitingSummary } from '../src/deck/review.ts';
import { deckStats } from '../src/deck/stats.ts';
import { PAGE_SIZE, clampPage, pageCount, pageOf } from '../src/ui/review.ts';
import type { Puzzle } from '../src/deck/build.ts';
import type { ExportedGame } from '../src/lichess/export.ts';
import type { SolveRecord } from '../src/storage/db.ts';

const puzzle = (gameId: string, ply: number): Puzzle => ({
  id: `${gameId}:${ply}`,
  gameId,
  ply,
  fen: 'startpos',
  pov: 'white',
  played: { san: 'e4', uci: 'e2e4' },
  best: 'd2d4',
  pv: ['d4'],
  prevEval: { cp: 0 },
  eval: { cp: -200 },
  alts: [{ uci: 'd2d4', eval: 0 }],
});

const game = (id: string): ExportedGame =>
  ({
    id,
    rated: true,
    variant: 'standard',
    speed: 'blitz',
    perf: 'blitz',
    createdAt: 1,
    lastMoveAt: 2,
    status: 'mate',
    players: { white: { user: { id: 'me', name: 'Me' } }, black: { user: { id: 'them', name: 'Them' } } },
    moves: 'e4 e5',
  }) as ExportedGame;

const solve = (puzzleId: string, at: number): SolveRecord => ({
  puzzleId,
  at,
  result: 'win',
  attempts: 1,
});

test('review rows are newest first and carry the position and its game', () => {
  const rows = reviewRows(
    [solve('a:5', 100), solve('b:9', 300), solve('a:7', 200)],
    lookup([puzzle('a', 5), puzzle('a', 7), puzzle('b', 9)], [game('a'), game('b')]),
  );
  assert.deepEqual(rows.map(r => r.puzzleId), ['b:9', 'a:7', 'a:5']);
  assert.equal(rows[0]!.puzzle?.gameId, 'b');
  assert.equal(rows[0]!.game?.id, 'b');
});

test('a solve whose position can no longer be derived still gets a row', () => {
  // The game was purged, or "positions per game" was lowered past this ply.
  // Dropping the row would quietly delete someone's history.
  const rows = reviewRows([solve('gone:5', 1)], lookup([], []));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.puzzle, undefined);
  assert.equal(rows[0]!.game, undefined);
});

test('a position whose game is gone keeps the position', () => {
  const rows = reviewRows([solve('a:5', 1)], lookup([puzzle('a', 5)], []));
  assert.equal(rows[0]!.puzzle?.id, 'a:5');
  assert.equal(rows[0]!.game, undefined);
});

test('the waiting summary counts positions and the games they span', () => {
  assert.deepEqual(waitingSummary([puzzle('a', 5), puzzle('a', 7), puzzle('b', 9)]), {
    count: 3,
    games: 2,
  });
  assert.deepEqual(waitingSummary([]), { count: 0, games: 0 });
});

test('paging clamps rather than running off either end', () => {
  const rows = Array.from({ length: PAGE_SIZE * 2 + 1 }, (_, i) => puzzle('a', i));
  assert.equal(pageCount(rows.length), 3);
  assert.equal(clampPage(-4, rows.length), 0);
  assert.equal(clampPage(99, rows.length), 2);
  // The case this exists for: a page held while a purge shrank the list.
  assert.equal(clampPage(2, 1), 0);
  assert.equal(pageCount(0), 1, 'an empty list is still one page, not zero');
});

test('a page is its own slice, and the last one is short', () => {
  const rows = Array.from({ length: PAGE_SIZE + 3 }, (_, i) => puzzle('a', i));
  assert.equal(pageOf(rows, 0).length, PAGE_SIZE);
  assert.equal(pageOf(rows, 1).length, 3);
  assert.equal(pageOf(rows, 0)[0], rows[0]);
  assert.equal(pageOf(rows, 1)[0], rows[PAGE_SIZE]);
  // Clamped, so an out-of-range page shows the last one rather than nothing.
  assert.deepEqual(pageOf(rows, 9), pageOf(rows, 1));
});

test('a hidden position leaves the solved list and appears in the hidden one', () => {
  const solves = [solve('a:5', 100), solve('a:7', 200)];
  const from = lookup([puzzle('a', 5), puzzle('a', 7)], [game('a')]);
  const hides = [{ puzzleId: 'a:5', at: 900 }];
  // Having it in both would make Hide look as though it had done nothing.
  assert.deepEqual(
    reviewRows(solves, from, new Set(['a:5'])).map(r => r.puzzleId),
    ['a:7'],
  );
  const hidden = hiddenRows(hides, solves, from);
  assert.deepEqual(hidden.map(r => r.puzzleId), ['a:5']);
  assert.equal(hidden[0]!.at, 900, 'dated by when it was hidden, not when it was solved');
  assert.equal(hidden[0]!.result, 'win', 'and it still says how the solve went');
});

test('an unsolved position can be hidden, and says so', () => {
  const hidden = hiddenRows([{ puzzleId: 'a:5', at: 1 }], [], lookup([puzzle('a', 5)], []));
  assert.equal(hidden[0]!.result, undefined);
  assert.equal(hidden[0]!.puzzle?.id, 'a:5');
});

const at = (day: number) => new Date(2026, 7, day, 12).getTime();

test('stats count what the records support, and nothing they do not', () => {
  const rows = reviewRows(
    [
      { puzzleId: 'a:5', at: at(10), result: 'win', attempts: 1 },
      { puzzleId: 'a:7', at: at(11), result: 'win', attempts: 3 },
      { puzzleId: 'b:9', at: at(12), result: 'view', attempts: 2 },
    ],
    lookup([puzzle('a', 5), puzzle('a', 7), puzzle('b', 9)], [game('a'), game('b')]),
  );
  const s = deckStats(rows, { waiting: 4, hidden: 2 }, at(12));
  assert.equal(s.solved, 3);
  assert.equal(s.found, 2);
  assert.equal(s.firstTry, 1);
  assert.equal(s.averageTries, 2, 'averaged over the ones found, not over all three');
  assert.equal(s.waiting, 4);
  assert.equal(s.hidden, 2);
  assert.equal(s.recent, 3);
  assert.equal(s.streak, 3, 'three consecutive days ending today');
});

test('a streak survives a day that is not over yet, but not a gap', () => {
  const row = (day: number) => ({ puzzleId: `a:${day}`, at: at(day), result: 'win' as const, attempts: 1 });
  const from = lookup([], []);
  // Solved yesterday and the day before, nothing yet today: still a streak.
  assert.equal(deckStats(reviewRows([row(10), row(11)], from), { waiting: 0, hidden: 0 }, at(12)).streak, 2);
  // A missing day ends it, however much came before.
  assert.equal(deckStats(reviewRows([row(8), row(11)], from), { waiting: 0, hidden: 0 }, at(12)).streak, 1);
  assert.equal(deckStats([], { waiting: 0, hidden: 0 }, at(12)).streak, 0);
});

test('a record with no position still counts towards the totals', () => {
  // It happened; it just cannot be broken down by side or by how bad it was.
  const rows = reviewRows([solve('gone:5', at(12))], lookup([], []));
  const s = deckStats(rows, { waiting: 0, hidden: 0 }, at(12));
  assert.equal(s.solved, 1);
  assert.equal(s.found, 1);
  assert.equal(s.bySide.white.solved + s.bySide.black.solved, 0);
  assert.equal(s.byBand.reduce((n, b) => n + b.tally.solved, 0), 0);
});
