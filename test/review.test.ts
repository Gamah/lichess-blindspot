import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reviewRows, waitingSummary } from '../src/deck/review.ts';
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
    [puzzle('a', 5), puzzle('a', 7), puzzle('b', 9)],
    [game('a'), game('b')],
  );
  assert.deepEqual(rows.map(r => r.puzzleId), ['b:9', 'a:7', 'a:5']);
  assert.equal(rows[0]!.puzzle?.gameId, 'b');
  assert.equal(rows[0]!.game?.id, 'b');
});

test('a solve whose position can no longer be derived still gets a row', () => {
  // The game was purged, or "positions per game" was lowered past this ply.
  // Dropping the row would quietly delete someone's history.
  const rows = reviewRows([solve('gone:5', 1)], [], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.puzzle, undefined);
  assert.equal(rows[0]!.game, undefined);
});

test('a position whose game is gone keeps the position', () => {
  const rows = reviewRows([solve('a:5', 1)], [puzzle('a', 5)], []);
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
