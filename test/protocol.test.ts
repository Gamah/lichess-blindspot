import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fenTurn, parseBestmove, parseInfo } from '../src/engine/protocol.ts';

test('an info line becomes a white-POV evaluation', () => {
  const line = 'info depth 18 seldepth 24 multipv 1 score cp 35 nodes 1000 nps 5 pv e2e4 e7e5 g1f3';
  assert.deepEqual(parseInfo(line, 'white'), {
    depth: 18,
    score: { cp: 35 },
    pv: ['e2e4', 'e7e5', 'g1f3'],
  });
});

test('black to move: the sign flips, because UCI scores the side to move', () => {
  // +35 for black is -35 for white, which is what everything downstream expects.
  const line = 'info depth 12 score cp 35 pv e7e5';
  assert.deepEqual(parseInfo(line, 'black')!.score, { cp: -35 });
  assert.deepEqual(parseInfo('info depth 5 score mate 2 pv h4h7', 'black')!.score, { mate: -2 });
});

test('bounds and score-less lines are not evaluations', () => {
  assert.equal(parseInfo('info depth 20 score cp 12 upperbound nodes 5', 'white'), undefined);
  assert.equal(parseInfo('info depth 3 currmove e2e4 currmovenumber 1', 'white'), undefined);
  assert.equal(parseInfo('info string NNUE evaluation using nn-4ca89e4b3abf.nnue', 'white'), undefined);
  assert.equal(parseInfo('bestmove e2e4', 'white'), undefined);
});

test('a mated position still gives a score, with no pv', () => {
  const line = parseInfo('info depth 0 score mate 0', 'black');
  assert.deepEqual(line, { depth: 0, score: { mate: -0 }, pv: [] });
});

test('bestmove', () => {
  assert.equal(parseBestmove('bestmove e2e4 ponder e7e5'), 'e2e4');
  assert.equal(parseBestmove('bestmove (none)'), undefined);
  assert.equal(parseBestmove('info depth 1'), undefined);
});

test('fenTurn', () => {
  assert.equal(fenTurn('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 'white');
  assert.equal(fenTurn('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1'), 'black');
});
