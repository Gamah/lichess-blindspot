import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Puzzle } from '../src/deck/build.ts';
import {
  altVerdicts,
  classify,
  judgeEval,
  hintSquares,
  judgeRanked,
  Solve,
  TOP_LINES,
  withinTopLines,
} from '../src/solve/retro.ts';

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
  // The engine's five, best first, gathered before the position was shown.
  // Bc4 is `best`; a2a3 is its fifth and is the awkward case the eval test
  // exists for — a line the engine named that is *worse* than the blunder the
  // puzzle is about, so being on the list must not be enough to pass.
  alts: [
    { uci: 'f1c4', eval: 30 },
    { uci: 'd2d4', eval: 25 },
    { uci: 'b1c3', eval: 10 },
    { uci: 'e1g1', eval: 5 },
    { uci: 'a2a3', eval: -1200 },
  ],
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

test('judging is “did you improve on what you played”, not “was that best”', () => {
  // The puzzle is Ng5 (-900) played where Bc4 (+20) held. The question is
  // whether the move beats Ng5, *not* whether it matches Bc4 — that difference
  // is the whole reason this is not a straight port of retroCtrl.
  //
  // Nowhere near best, but it saves the piece: a win. Under the old baseline
  // this was a fail, which is the bug.
  assert.equal(judgeEval(puzzle, { cp: -150 }), 'win');
  // Level with the position we were handed: obviously fine.
  assert.equal(judgeEval(puzzle, { cp: 20 }), 'win');
  // No better than the blunder is not an improvement.
  assert.equal(judgeEval(puzzle, { cp: -900 }), 'fail');
  assert.equal(judgeEval(puzzle, { cp: -1500 }), 'fail');
  assert.equal(judgeEval(puzzle, { mate: -3 }), 'fail');
});

test('black’s puzzles are judged from black’s side', () => {
  // Mirrored: black played something reaching +900 where the position was -20.
  const black: Puzzle = { ...puzzle, pov: 'black', prevEval: { cp: -20 }, eval: { cp: 900 } };
  // White-POV -900 is winning for black, so this is an improvement.
  assert.equal(judgeEval(black, { cp: -900 }), 'win');
  assert.equal(judgeEval(black, { cp: 150 }), 'win');
  assert.equal(judgeEval(black, { cp: 900 }), 'fail');
  assert.equal(judgeEval(black, { cp: 1500 }), 'fail');
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

// --- the difficulty gate ----------------------------------------------------

test('easy asks no question about rank, so a move only has to hold the position', () => {
  assert.equal(TOP_LINES.easy, 0);
  assert.ok(withinTopLines('a2a3', puzzle.alts, TOP_LINES.easy));
});

test('medium and hard are the same test with a different edge', () => {
  assert.ok(withinTopLines('b1c3', puzzle.alts, TOP_LINES.medium));
  assert.ok(!withinTopLines('b1c3', puzzle.alts, TOP_LINES.hard));
  assert.ok(withinTopLines('d2d4', puzzle.alts, TOP_LINES.hard));
  assert.ok(!withinTopLines('h2h3', puzzle.alts, TOP_LINES.medium));
});

test('the whole verdict comes off the puzzle, with no engine anywhere near it', () => {
  // Third choice: inside medium's five, outside hard's two.
  assert.deepEqual(judgeRanked(puzzle, 'b1c3', TOP_LINES.medium), { verdict: 'win', rank: 2 });
  assert.deepEqual(judgeRanked(puzzle, 'b1c3', TOP_LINES.hard), { verdict: 'fail', rank: 2 });
});

test('inside the ranking, the eval still has to hold: both tests, not either', () => {
  // Ranked fifth, and still no better than the move that lost the game —
  // being on the engine's list is not enough.
  assert.deepEqual(judgeRanked(puzzle, 'a2a3', TOP_LINES.medium), { verdict: 'fail', rank: 4 });
});

test('an unranked move on Easy is the one case left that needs a search', () => {
  assert.deepEqual(judgeRanked(puzzle, 'h2h3', TOP_LINES.easy), { verdict: 'outside', rank: -1 });
  // ...and on the harder settings it needs nothing: unranked is the answer.
  assert.deepEqual(judgeRanked(puzzle, 'h2h3', TOP_LINES.hard), { verdict: 'fail', rank: -1 });
});

test('Solve answers from the ranking, and only asks for a search when it cannot', () => {
  const hard = new Solve(puzzle);
  hard.play({ uci: 'h2h3', san: 'h3' });
  assert.equal(hard.onRanked(TOP_LINES.hard), 'fail');

  const easy = new Solve(puzzle);
  easy.play({ uci: 'h2h3', san: 'h3' });
  assert.equal(easy.onRanked(TOP_LINES.easy), 'eval', 'nothing stored says what h3 is worth');
  assert.equal(easy.onCeval({ cp: 15 }), 'win');
});

test('the rank of the last attempt is kept, because the feedback line says it', () => {
  const solve = new Solve(puzzle);
  solve.play({ uci: 'b1c3', san: 'Nc3' });
  solve.onRanked(TOP_LINES.hard);
  assert.equal(solve.rank, 2);
});

test('the ranking carries its own verdicts, and being ranked is not one', () => {
  // MultiPV fills five slots whether or not five moves hold: a2a3 is the
  // engine's fifth choice and still throws the position away. This is what the
  // reveal colours its arrows by, so a "fan of five options" cannot go on
  // implying all five were playable.
  assert.deepEqual(altVerdicts(puzzle), [true, true, true, true, false]);
});

test('alt verdicts are the eval test alone, so difficulty cannot repaint them', () => {
  // Nothing here takes a `lines` argument: rank 3 is sound on Hard too, Hard
  // simply asks more than sound. The numbers in the arrowheads say that part.
  assert.equal(altVerdicts(puzzle).length, puzzle.alts.length);
  assert.equal(altVerdicts({ ...puzzle, alts: [] }).length, 0);
});

test('a hint rings one piece per sound line, best first', () => {
  // Four of the five beat Ng5; a2a3 does not, so the a-pawn is not ringed.
  assert.deepEqual(hintSquares(puzzle), ['f1', 'd2', 'b1', 'e1']);
});

test('two sound lines from one piece are one hint', () => {
  // A hint counts pieces, not moves: the knight going two places is one ring.
  const knight: Puzzle = {
    ...puzzle,
    alts: [
      { uci: 'b1c3', eval: 30 },
      { uci: 'b1d2', eval: 25 },
      { uci: 'f1c4', eval: 20 },
    ],
  };
  assert.deepEqual(hintSquares(knight), ['b1', 'f1']);
});

test('a hint is never empty, even when no ranked line passes the eval test', () => {
  // `classify` accepts `best` outright whatever the eval says, so that piece
  // is always hintable and a hint that rings nothing would be a lie.
  const hopeless: Puzzle = { ...puzzle, alts: [{ uci: 'f1c4', eval: -1200 }] };
  assert.deepEqual(hintSquares(hopeless), ['f1']);
});

test('a hint does not narrow with difficulty', () => {
  // The same decision as altVerdicts: it is a property of the position, so it
  // says the same thing on Hard as on Easy. Nothing here reads TOP_LINES.
  assert.equal(hintSquares(puzzle).length, 4);
  assert.ok(TOP_LINES.hard < 4, 'and Hard would accept fewer moves than it rings pieces');
});

test('asking for a hint is recorded on the solve', () => {
  const solve = new Solve(puzzle);
  assert.equal(solve.hinted, false);
  solve.hinted = true;
  assert.equal(solve.play({ uci: 'f1c4', san: 'Bc4' }), 'win');
  assert.equal(solve.hinted, true, 'and survives the solve that follows it');
});
