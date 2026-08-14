import assert from 'node:assert/strict';
import { test } from 'node:test';

import { puzzlesFromGame } from '../src/deck/derive.ts';
import type { ExportedGame } from '../src/lichess/export.ts';

// A puzzle is a view over a stored game, so these are the tests that used to be
// about what got written: same game in, same puzzles out, whatever the shape of
// a puzzle happens to be.

// White hangs a knight on move 5 (index 4) and again on move 7 (index 6).
const MOVES = 'e4 e5 Nf3 Nc6 Ng5 Nf6 Nxf7 Kxf7';
const ANALYSIS = [
  { eval: 20 },
  { eval: 15 },
  { eval: 25 },
  { eval: 20 },
  { eval: -300, best: 'f1c4', variation: 'Bc4 Bc5 c3' },
  { eval: -310 },
  { eval: -700, best: 'g5f3', variation: 'Nf3 d5' },
  { eval: -720 },
];

const game = (over: Partial<ExportedGame> = {}): ExportedGame => ({
  id: 'abc123',
  rated: true,
  variant: 'standard',
  speed: 'blitz',
  perf: 'blitz',
  createdAt: 1000,
  lastMoveAt: 2000,
  status: 'resign',
  players: {
    white: { user: { id: 'someone', name: 'Someone' } },
    black: { user: { id: 'other', name: 'Other' } },
  },
  moves: MOVES,
  analysis: ANALYSIS,
  ...over,
});

test('a stored game with analysis is all a deck needs', () => {
  const puzzles = puzzlesFromGame(game(), 'someone');
  assert.deepEqual(
    puzzles.map(p => p.id),
    ['abc123:5', 'abc123:7'],
  );
  const [first] = puzzles;
  assert.equal(first!.pov, 'white');
  assert.equal(first!.played.san, 'Ng5');
  assert.equal(first!.best, 'f1c4');
  assert.deepEqual(first!.pv, ['Bc4', 'Bc5', 'c3']);
  // Derived, so the opening animation is always there — no record predates it.
  assert.equal(first!.intro!.san, 'Nc6');
});

test('the cap is applied on derivation, so changing it is retroactive', () => {
  const ids = (maxPerGame: number) =>
    puzzlesFromGame(game(), 'someone', { maxPerGame }).map(p => p.id);
  assert.deepEqual(ids(1), ['abc123:5']);
  assert.deepEqual(ids(2), ['abc123:5', 'abc123:7']);
  // 0 is "every one it finds", and the ids do not move when the cap does —
  // which is what lets `solve:` records outlive any of this.
  assert.deepEqual(ids(0), ['abc123:5', 'abc123:7']);
});

test('the opening is left alone, by ply', () => {
  const puzzles = puzzlesFromGame(game({ division: { middle: 7 } }), 'someone');
  assert.deepEqual(
    puzzles.map(p => p.ply),
    [7],
  );
});

test('only the named player, only their side, only games we can replay', () => {
  // Nobody's blindspot but the person who played it: from black's side, white's
  // mistakes are not candidates.
  assert.deepEqual(puzzlesFromGame(game(), 'other'), []);
  assert.deepEqual(puzzlesFromGame(game(), 'nobody'), []);
  assert.deepEqual(puzzlesFromGame(game({ variant: 'crazyhouse' }), 'someone'), []);
  assert.deepEqual(puzzlesFromGame(game({ moves: 'e4 e5' }), 'someone'), []);
  // Case is not identity: lichess usernames are case-insensitive.
  assert.equal(puzzlesFromGame(game(), 'SomeOne').length, 2);
});

test('a game nobody has analysed yields nothing, and does not go looking', () => {
  assert.deepEqual(puzzlesFromGame(game({ analysis: undefined }), 'someone'), []);
  assert.deepEqual(puzzlesFromGame(game({ analysis: [] }), 'someone'), []);
});

test('a game whose moves will not replay is skipped, not thrown', () => {
  assert.deepEqual(puzzlesFromGame(game({ moves: 'e4 e5 Qh9 Nc6 Ng5' }), 'someone'), []);
});
