import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INITIAL_FEN } from 'chessops/fen';

import { lineToSan, replay } from '../src/deck/positions.ts';

test('replay gives the position before each move', () => {
  const steps = replay(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4']);
  assert.equal(steps.length, 5);
  assert.equal(steps[0]!.fen, INITIAL_FEN);
  assert.equal(steps[0]!.uci, 'e2e4');
  assert.equal(steps[2]!.uci, 'd1h5');
  // the last step holds the position its move was played from
  assert.equal(steps[4]!.san, 'Bc4');
  assert.ok(steps[4]!.fen.startsWith('r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w'));
});

test('replay rejects an illegal move rather than guessing', () => {
  // Qh5 is blocked by the knight on f3
  assert.throws(() => replay(['e4', 'e5', 'Nf3', 'Nc6', 'Qh5']), /Illegal move Qh5/);
});

test('lineToSan renders an engine line from a position', () => {
  const fen = replay(['e4', 'e5', 'Nf3'])[2]!.fen;
  assert.deepEqual(lineToSan(fen, ['g1f3', 'b8c6']), ['Nf3', 'Nc6']);
});
