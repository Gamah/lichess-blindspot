import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mastersUcis, OpeningBook } from '../src/lichess/explorer.ts';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('a move played in exactly one master game is not a book move', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        moves: [
          { uci: 'e2e4', white: 100, draws: 200, black: 90 },
          { uci: 'd2d4', white: 2, draws: 0, black: 0 },
          { uci: 'a2a4', white: 1, draws: 0, black: 0 }, // an anecdote, not a book move
        ],
      }),
    )) as typeof fetch;
  try {
    assert.deepEqual(await mastersUcis(FEN), ['e2e4', 'd2d4']);
  } finally {
    globalThis.fetch = real;
  }
});

test('the book is asked about a position once, however many moves we check', async () => {
  let calls = 0;
  const book = new OpeningBook(async () => {
    calls++;
    return ['e2e4', 'd2d4'];
  });
  assert.equal(await book.contains(FEN, 'e2e4'), true);
  assert.equal(await book.contains(FEN, 'a2a4'), false);
  assert.equal(calls, 1);
});

test('an unreachable explorer means “leave the opening alone”, not “blunder”', async () => {
  let calls = 0;
  const book = new OpeningBook(async () => {
    calls++;
    throw new Error('401');
  });
  // Everything is book when we cannot ask, which reproduces the blanket
  // skip-the-opening behaviour rather than filling the deck with book moves.
  assert.equal(await book.contains(FEN, 'a2a4'), true);
  assert.equal(await book.ucis(FEN), undefined);
  // And the failure is cached, so an outage is not a burst of requests.
  assert.equal(await book.contains(FEN, 'h2h4'), true);
  assert.equal(calls, 1);
});
