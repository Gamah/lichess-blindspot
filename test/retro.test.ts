import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Puzzle } from '../src/deck/build.ts';
import { classify, judgeEval, Solve } from '../src/solve/retro.ts';

// White to move, having played Ng5 in the game when Bc4 was the engine's move.
const puzzle: Puzzle = {
  id: 'g:5',
  gameId: 'g',
  ply: 5,
  fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 4 3',
  pov: 'white',
  played: { san: 'Ng5', uci: 'f3g5' },
  best: 'f1c4',
  pv: ['Bc4'],
  prevEval: { cp: 20 },
  eval: { cp: -900 },
  createdAt: 0,
};

test('the engine’s own move is accepted without asking the engine', () => {
  assert.equal(classify(puzzle, { uci: 'f1c4', san: 'Bc4' }), 'win');
});

test('the move played in the game is the one answer that is always wrong', () => {
  assert.equal(classify(puzzle, { uci: 'f3g5', san: 'Ng5' }), 'fail');
});

test('mate ends the game, so it is accepted whatever the engine prefers', () => {
  assert.equal(classify(puzzle, { uci: 'h5f7', san: 'Qxf7#' }), 'win');
});

test('a move found in the masters explorer is accepted', () => {
  assert.equal(classify(puzzle, { uci: 'b1c3', san: 'Nc3' }, ['b1c3', 'd2d4']), 'win');
});

test('anything else has to be judged by the engine', () => {
  assert.equal(classify(puzzle, { uci: 'd2d4', san: 'd4' }), 'eval');
});

test('judging is “did that throw anything away”, not “was that best”', () => {
  // Level with the position we were handed: fine, even though it isn't Bc4.
  assert.equal(judgeEval(puzzle, { cp: 20 }), 'win');
  // A little worse, inside the -0.04 winning-chances tolerance: still fine.
  assert.equal(judgeEval(puzzle, { cp: 0 }), 'win');
  // Dropping a piece is not.
  assert.equal(judgeEval(puzzle, { cp: -900 }), 'fail');
  assert.equal(judgeEval(puzzle, { mate: -3 }), 'fail');
});

test('black’s puzzles are judged from black’s side', () => {
  const black: Puzzle = { ...puzzle, pov: 'black', prevEval: { cp: -20 } };
  // White-POV -900 is winning for black, so this is an improvement, not a loss.
  assert.equal(judgeEval(black, { cp: -900 }), 'win');
  assert.equal(judgeEval(black, { cp: 900 }), 'fail');
});

test('a wrong move is a retry, and a right one ends the solve', () => {
  const solve = new Solve(puzzle);
  assert.equal(solve.feedback, 'find');
  assert.equal(solve.play({ uci: 'f3g5', san: 'Ng5' }), 'fail');
  assert.ok(solve.isSolving(), 'a fail is still solving — you try again');
  assert.ok(!solve.isDone());

  assert.equal(solve.play({ uci: 'f1c4', san: 'Bc4' }), 'win');
  assert.ok(solve.isDone());
  // Moves after the solve are ignored rather than reopening it.
  assert.equal(solve.play({ uci: 'f3g5', san: 'Ng5' }), 'win');
});

test('the eval state waits for the engine before deciding', () => {
  const solve = new Solve(puzzle);
  assert.equal(solve.play({ uci: 'd2d4', san: 'd4' }), 'eval');
  assert.ok(!solve.isSolving(), 'no more moves accepted while a verdict is pending');
  assert.equal(solve.onCeval({ cp: 15 }), 'win');
  assert.ok(solve.isDone());
});

test('viewing the solution counts as done, not as solved by hand', () => {
  const solve = new Solve(puzzle);
  solve.viewSolution();
  assert.equal(solve.feedback, 'view');
  assert.ok(solve.isDone());
  assert.ok(!solve.isSolving());
});
