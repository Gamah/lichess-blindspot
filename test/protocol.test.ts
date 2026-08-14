import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fenTurn, parseBestmove, parseInfo, UciSession } from '../src/engine/protocol.ts';

test('an info line becomes a white-POV evaluation', () => {
  const line = 'info depth 18 seldepth 24 multipv 1 score cp 35 nodes 1000 nps 5 pv e2e4 e7e5 g1f3';
  assert.deepEqual(parseInfo(line, 'white'), {
    depth: 18,
    score: { cp: 35 },
    pv: ['e2e4', 'e7e5', 'g1f3'],
    multiPv: 1,
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
  assert.deepEqual(line, { depth: 0, score: { mate: -0 }, pv: [], multiPv: 1 });
});

test('a line with no multipv field is rank 1 — an ordinary search', () => {
  assert.equal(parseInfo('info depth 12 score cp 5 pv e2e4', 'white')!.multiPv, 1);
  assert.equal(parseInfo('info depth 12 multipv 3 score cp 5 pv d2d4', 'white')!.multiPv, 3);
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

test('an option change waits for the search in front of it', async () => {
  // Stockfish ignores setoption while it is thinking, so the session must queue
  // it behind the search rather than send it straight away.
  const sent: string[] = [];
  const session = new UciSession(cmd => {
    sent.push(cmd);
    // Answer the search only after the option has been asked for, proving the
    // option did not jump the queue.
    if (cmd === 'go depth 1')
      queueMicrotask(() => {
        session.receive('info depth 1 score cp 20 pv e2e4');
        session.receive('bestmove e2e4');
      });
    if (cmd === 'isready') queueMicrotask(() => session.receive('readyok'));
  });

  const search = session.analyse({ fen: 'startpos-ish w', depth: 1 });
  const option = session.setOption('Threads', 4);
  assert.ok(!sent.includes('setoption name Threads value 4'), 'not sent mid-search');

  await search;
  await option;
  assert.deepEqual(sent.slice(-2), ['setoption name Threads value 4', 'isready']);
});

test('a MultiPV search returns the ranks in the engine’s order, deepest of each', async () => {
  const sent: string[] = [];
  const session = new UciSession(cmd => {
    sent.push(cmd);
    if (!cmd.startsWith('go ')) return;
    queueMicrotask(() => {
      // Two depths, arriving in the order Stockfish prints them: every rank at
      // depth 8, then every rank at depth 9, and rank 2 out of order to prove
      // the sort is on the rank and not on arrival.
      session.receive('info depth 8 multipv 1 score cp 30 pv e2e4 e7e5');
      session.receive('info depth 8 multipv 2 score cp 25 pv d2d4 d7d5');
      session.receive('info depth 9 multipv 2 score cp 22 pv d2d4 g8f6');
      session.receive('info depth 9 multipv 1 score cp 33 pv e2e4 c7c5');
      session.receive('info depth 9 multipv 3 score cp 10 pv g1f3 d7d5');
      session.receive('bestmove e2e4');
    });
  });

  const lines = await session.analyseLines({ fen: 'x w', movetime: 50, multiPv: 3 });
  assert.deepEqual(
    lines.map(l => [l.multiPv, l.depth, l.pv[0]]),
    [
      [1, 9, 'e2e4'],
      [2, 9, 'd2d4'],
      [3, 9, 'g1f3'],
    ],
  );
  assert.ok(sent.includes('setoption name MultiPV value 3'));
});

test('MultiPV is set on every search, so a stale one cannot slow the sweep down', async () => {
  const sent: string[] = [];
  const session = new UciSession(cmd => {
    sent.push(cmd);
    if (!cmd.startsWith('go ')) return;
    queueMicrotask(() => {
      session.receive('info depth 12 score cp 5 pv e2e4');
      session.receive('bestmove e2e4');
    });
  });
  await session.analyse({ fen: 'x w', depth: 12 });
  assert.deepEqual(sent, ['setoption name MultiPV value 1', 'position fen x w', 'go depth 12']);
});

test('bestmove overrides a cut-off pv on a single line, but never reorders a ranking', async () => {
  const single = new UciSession(cmd => {
    if (!cmd.startsWith('go ')) return;
    queueMicrotask(() => {
      single.receive('info depth 12 score cp 5 pv e2e4 e7e5');
      single.receive('bestmove d2d4');
    });
  });
  assert.deepEqual((await single.analyse({ fen: 'x w', depth: 12 })).pv, ['d2d4']);

  const multi = new UciSession(cmd => {
    if (!cmd.startsWith('go ')) return;
    queueMicrotask(() => {
      multi.receive('info depth 12 multipv 1 score cp 5 pv e2e4 e7e5');
      multi.receive('info depth 12 multipv 2 score cp 3 pv d2d4 d7d5');
      multi.receive('bestmove d2d4');
    });
  });
  const lines = await multi.analyseLines({ fen: 'x w', depth: 12, multiPv: 2 });
  assert.deepEqual(lines.map(l => l.pv[0]), ['e2e4', 'd2d4']);
});
