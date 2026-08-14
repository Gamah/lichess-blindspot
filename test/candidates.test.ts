import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findCandidates, type AnalysisEntry } from '../src/analysis/candidates.ts';
import { povDiff } from '../src/analysis/winningChances.ts';

// A hand-built game where white drops a piece at index 4 (ply 5) and black
// gives some of it back at index 5. Evals are white POV, as lichess gives them.
const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Ng5', 'Nf6', 'Nxf7', 'Kxf7'];
const analysis: AnalysisEntry[] = [
  { eval: 20 },
  { eval: 15 },
  { eval: 25 },
  { eval: 20 },
  { eval: -900, best: 'f1c4', variation: 'Bc4 Bc5 c3' }, // white blunders
  { eval: -100, best: 'd8f6', variation: 'Qf6 Nf3 h6' }, // black gives it back
  { eval: -90 },
  { eval: -95 },
];

test('finds only the requested side’s mistakes', () => {
  const white = findCandidates(moves, analysis, { pov: 'white' });
  assert.deepEqual(
    white.map(c => c.index),
    [4],
  );
  assert.equal(white[0]!.played, 'Ng5');
  assert.equal(white[0]!.best, 'f1c4');
  assert.deepEqual(white[0]!.variation, ['Bc4', 'Bc5', 'c3']);

  const black = findCandidates(moves, analysis, { pov: 'black' });
  assert.deepEqual(
    black.map(c => c.index),
    [5],
  );
});

test('ignores moves the engine agreed with', () => {
  // Same swing, but no variation: lichess only stores one when the played move
  // was not the engine's first choice. That is our hasCompChild test.
  const agreed = analysis.map((a, i) => (i === 4 ? { eval: a.eval } : a));
  assert.deepEqual(findCandidates(moves, agreed, { pov: 'white' }), []);
});

test('respects fromPly, for skipping the opening', () => {
  assert.deepEqual(findCandidates(moves, analysis, { pov: 'white', fromPly: 10 }), []);
});

test('catches a lost forced mate that the cp swing would miss', () => {
  const mateMoves = ['e4', 'e5', 'Qh5', 'Ke7', 'Qxe5#'];
  const mateAnalysis: AnalysisEntry[] = [
    { eval: 20 },
    { eval: 15 },
    { eval: 30 },
    { mate: 1 }, // black walks into mate in 1
    { eval: 900, best: 'h5e5', variation: 'Qxe5#' }, // white misses it
  ];
  const found = findCandidates(mateMoves, mateAnalysis, { pov: 'white' });
  assert.deepEqual(
    found.map(c => c.index),
    [4],
  );
  // and the cp swing alone would not have flagged it
  assert.ok(Math.abs(povDiff('white', { mate: 1 }, { cp: 900 })) < 0.1);
});
