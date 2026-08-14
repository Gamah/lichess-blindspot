import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Deck } from '../src/app/deck.ts';
import { findCandidates } from '../src/analysis/candidates.ts';
import { buildPuzzles, shuffleDeck, type Puzzle } from '../src/deck/build.ts';
import { replay } from '../src/deck/positions.ts';

/** A deterministic stand-in for Math.random, so a shuffle test can assert. */
const seeded = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

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
  createdAt: 0,
});

const runsOfOneGame = (deck: readonly Puzzle[]): number =>
  deck.filter((p, i) => i > 0 && p.gameId === deck[i - 1]!.gameId).length;

test('the shuffle never puts two positions from one game together', () => {
  const puzzles = ['a', 'b', 'c', 'd'].flatMap(g => [1, 2, 3, 4, 5].map(ply => puzzle(g, ply)));
  for (let seed = 1; seed <= 20; seed++) {
    const shuffled = shuffleDeck(puzzles, seeded(seed));
    assert.equal(shuffled.length, puzzles.length);
    assert.equal(runsOfOneGame(shuffled), 0, `seed ${seed} put two of one game together`);
  }
});

test('one game dominating the deck degrades as well as it can, not worse', () => {
  // 6 from one game and 2 from another cannot be fully separated: the best any
  // arrangement manages is 3 adjacent pairs. It must not do worse than that.
  const puzzles = [...[1, 2, 3, 4, 5, 6].map(p => puzzle('big', p)), puzzle('a', 1), puzzle('b', 1)];
  for (let seed = 1; seed <= 20; seed++) {
    const shuffled = shuffleDeck(puzzles, seeded(seed));
    assert.equal(shuffled.length, 8);
    assert.ok(runsOfOneGame(shuffled) <= 3, `seed ${seed}: ${runsOfOneGame(shuffled)} adjacent pairs`);
  }
});

test('the shuffle actually shuffles', () => {
  const puzzles = ['a', 'b', 'c'].flatMap(g => [1, 2, 3].map(ply => puzzle(g, ply)));
  const one = shuffleDeck(puzzles, seeded(1)).map(p => p.id);
  const two = shuffleDeck(puzzles, seeded(9)).map(p => p.id);
  assert.notDeepEqual(one, two);
});

test('a solved puzzle leaves the deck and does not come back', () => {
  const deck = new Deck(seeded(3));
  const puzzles = ['a', 'b'].flatMap(g => [1, 2].map(ply => puzzle(g, ply)));
  assert.equal(deck.add(puzzles), 4);
  assert.equal(deck.add(puzzles), 0, 'the same puzzles are not added twice');

  const first = deck.next()!;
  deck.markSolved([first.id]);
  assert.equal(deck.unsolvedCount(), 3);
  assert.equal(deck.solvedCount(), 1);
  // Re-analysis of the same game hands us the same puzzle again; it must not
  // reappear in the deck.
  assert.equal(deck.add(puzzles), 0);
  assert.equal(deck.unsolvedCount(), 3);
});

test('a skipped puzzle goes back, at the end', () => {
  const deck = new Deck(seeded(5));
  deck.add([puzzle('a', 1), puzzle('b', 1), puzzle('c', 1)]);
  const skipped = deck.next()!;
  deck.requeue(skipped);
  assert.equal(deck.unsolvedCount(), 3);
  assert.notEqual(deck.next()!.id, skipped.id, 'not served again immediately');
});

test('a candidate becomes a puzzle holding the position before the mistake', () => {
  const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Ng5', 'Nf6', 'Nxf7', 'Kxf7'];
  const steps = replay(moves);
  const candidates = findCandidates(
    moves,
    [
      { eval: 20 },
      { eval: 15 },
      { eval: 25 },
      { eval: 20 },
      { eval: -900, best: 'f1c4', variation: 'Bc4 Bc5 c3' },
    ],
    { pov: 'white' },
  );
  const [p] = buildPuzzles('abc123', steps, candidates, 'white', 1234);
  assert.equal(p!.id, 'abc123:5');
  assert.equal(p!.ply, 5);
  assert.equal(p!.fen, steps[4]!.fen, 'the position to solve is before the mistake');
  assert.equal(p!.played.san, 'Ng5');
  assert.equal(p!.best, 'f1c4');
  assert.deepEqual(p!.pv, ['Bc4', 'Bc5', 'c3']);
});
