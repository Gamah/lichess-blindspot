import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Pipeline, type Store } from '../src/app/pipeline.ts';
import type { Puzzle } from '../src/deck/build.ts';
import { replay } from '../src/deck/positions.ts';
import type { Analyser } from '../src/engine/analyse.ts';
import type { EngineLine, Request } from '../src/engine/protocol.ts';
import type { ExportedGame } from '../src/lichess/export.ts';
import type { Meta } from '../src/storage/db.ts';
import { saveSettings } from '../src/storage/prefs.ts';

// Settings live in localStorage, which node does not have — and `prefs` is
// written to fail soft rather than throw when a browser refuses storage, so
// without this every setting silently reads as its default and a test that
// changes one tests nothing.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

// lichess allows one games export per IP at a time, so the thing under test is
// how often this asks — not what it does with the answers.

const fakeStore = (): Store & { stored: ExportedGame[] } => {
  let meta: Meta = { analysed: [], fetched: [] };
  const stored: ExportedGame[] = [];
  return {
    stored,
    username: 'someone',
    meta: async () => meta,
    setMeta: async next => {
      meta = next;
    },
    putGame: async game => {
      stored.push(game);
    },
    games: async () => stored.slice(),
    gameCount: async () => stored.length,
  };
};

const noEngine = (): Promise<Analyser> => Promise.reject(new Error('no engine in tests'));

const events = () => {
  const errors: Error[] = [];
  const retries: number[] = [];
  const puzzles: Puzzle[] = [];
  return {
    errors,
    retries,
    puzzles,
    handlers: {
      onPuzzles: (p: Puzzle[]) => puzzles.push(...p),
      onProgress: () => {},
      onError: (e: Error) => errors.push(e),
      onRetry: (_e: Error, ms: number) => retries.push(ms),
    },
  };
};

/** Counts export requests, records their URLs, and answers as the test wants. */
function stubFetch(reply: (n: number) => Response) {
  const real = globalThis.fetch;
  const state = { calls: 0, urls: [] as string[] };
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    state.urls.push(String(input));
    return reply(++state.calls);
  }) as typeof fetch;
  return {
    state,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const oneGame = () =>
  new Response(
    JSON.stringify({
      id: 'aaa',
      createdAt: 1000,
      variant: 'standard',
      players: { white: { user: { id: 'someone', name: 'someone' } }, black: {} },
      moves: 'e4 e5 Nf3 Nc6',
    }),
  );

test('a burst of run() calls is one export, not a burst of exports', async () => {
  const fetch = stubFetch(oneGame);
  const now = { at: 1_000_000 };
  try {
    const { handlers } = events();
    const pipeline = new Pipeline(fakeStore(), noEngine, handlers, () => now.at);
    // The deck asks after every solve; the end-of-deck screen asks on every click.
    await Promise.all([pipeline.run(), pipeline.run(), pipeline.run()]);
    await pipeline.run();
    assert.equal(fetch.state.calls, 1);
    assert.equal(pipeline.status(), 'waiting');
    assert.ok(pipeline.waitMs() > 0);

    // Once the gap has passed, asking is allowed again.
    now.at += 31_000;
    assert.equal(pipeline.status(), 'idle');
    await pipeline.run();
    assert.equal(fetch.state.calls, 2);
  } finally {
    fetch.restore();
  }
});

test('“another export is running” is waited out, not surfaced', async () => {
  const busy = new Response('{"error":"Please only run 1 request(s) at a time"}', { status: 429 });
  const fetch = stubFetch(n => (n === 1 ? busy : oneGame()));
  const now = { at: 2_000_000 };
  const { errors, retries, handlers } = events();
  try {
    const pipeline = new Pipeline(fakeStore(), noEngine, handlers, () => now.at);
    await pipeline.run();
    assert.equal(fetch.state.calls, 2, 'retried once');
    assert.deepEqual(errors, [], 'and said nothing to the user about it');
    assert.equal(retries.length, 1);
  } finally {
    fetch.restore();
  }
});

test('a 429 that survives the retry backs off hard', async () => {
  const fetch = stubFetch(() => new Response('{"error":"Too many requests"}', { status: 429 }));
  const now = { at: 3_000_000 };
  const { errors, handlers } = events();
  try {
    const pipeline = new Pipeline(fakeStore(), noEngine, handlers, () => now.at);
    await pipeline.run();
    assert.equal(fetch.state.calls, 2);
    assert.equal(errors.length, 1);
    // The 30s gap would have expired; the backoff has not.
    now.at += 31_000;
    assert.equal(pipeline.status(), 'waiting');
    await pipeline.run();
    assert.equal(fetch.state.calls, 2, 'no third request inside the backoff');
  } finally {
    fetch.restore();
  }
});

test('each batch reaches further back, so the deck is not capped at 20 games', async () => {
  // The export is newest-first and `until` is a "played before this" filter, so
  // paging backwards means asking again from just before the oldest game we
  // have. Without it every batch would be the same 20 games.
  const batch = (ids: string[], createdAt: number) =>
    new Response(
      ids
        .map(id =>
          JSON.stringify({
            id,
            createdAt,
            variant: 'standard',
            players: { white: { user: { id: 'someone', name: 'someone' } }, black: {} },
            moves: 'e4 e5 Nf3 Nc6',
          }),
        )
        .join('\n'),
    );
  const fetch = stubFetch(n => (n === 1 ? batch(['aaa', 'bbb'], 5_000) : batch(['ccc'], 3_000)));
  const now = { at: 6_000_000 };
  try {
    const { handlers } = events();
    const pipeline = new Pipeline(fakeStore(), noEngine, handlers, () => now.at);
    await pipeline.run();
    now.at += 31_000;
    await pipeline.run();

    assert.equal(fetch.state.calls, 2);
    assert.ok(!fetch.state.urls[0]!.includes('until='), 'the first batch is simply the newest');
    // 5000 was the oldest of batch one, so batch two asks for older than that.
    assert.match(fetch.state.urls[1]!, /until=4999\b/);
  } finally {
    fetch.restore();
  }
});

// The expensive thing is the eval array, and it is the only thing kept: the
// puzzles handed to the deck are derived from the game and never written.
test('what the engine works out is written back onto the game', async () => {
  const moves = 'e4 e5 Nf3 Nc6 Ng5 Nf6 Nxf7 Kxf7';
  const steps = replay(moves.split(' '));
  /** cp after each ply, white POV: white hangs the knight on move 5. */
  const after = [20, 15, 25, 20, -300, -310, -320, -330];
  const engine: Analyser = {
    analyse: (req: Request): Promise<EngineLine> => {
      // Keyed by position rather than by ply, the way a real engine answers:
      // pass 2 asks about positions pass 1 has already scored.
      const i = steps.findIndex(s => s.after === req.fen);
      return Promise.resolve({
        depth: 12,
        score: { cp: i === -1 ? 20 : after[i]! },
        pv: req.fen === steps[4]!.fen ? ['f1c4', 'f8c5'] : ['e1e2'],
      });
    },
  };
  const fetch = stubFetch(
    () =>
      new Response(
        JSON.stringify({
          id: 'aaa',
          createdAt: 1000,
          variant: 'standard',
          players: { white: { user: { id: 'someone', name: 'someone' } }, black: {} },
          moves,
        }),
      ),
  );
  const store = fakeStore();
  const { puzzles, handlers } = events();
  try {
    await new Pipeline(store, () => Promise.resolve(engine), handlers, () => 7_000_000).run();
  } finally {
    fetch.restore();
  }

  const stored = store.stored.at(-1)!;
  assert.equal(stored.id, 'aaa');
  assert.equal(stored.analysis?.length, 8, 'one entry per ply, like the export');
  assert.equal(stored.analysis![4]!.best, 'f1c4');
  assert.deepEqual(
    puzzles.map(p => p.id),
    ['aaa:5'],
  );
});

test('running out of games stops the asking for good', async () => {
  const fetch = stubFetch(() => new Response(''));
  const now = { at: 4_000_000 };
  try {
    const { handlers } = events();
    const pipeline = new Pipeline(fakeStore(), noEngine, handlers, () => now.at);
    await pipeline.run();
    assert.equal(pipeline.status(), 'exhausted');
    now.at += 10 * 60_000;
    await pipeline.run();
    assert.equal(fetch.state.calls, 1, 'an empty history is not re-asked');
  } finally {
    fetch.restore();
  }
});

// A game lichess analysed arrives with one variation per ply and no ranking, so
// its positions are withheld until the engine has been round them. That pass is
// the whole reason a stored game can go from "nothing to solve" to a full deck
// without anything being downloaded again.
test('stored games with no ranking are ranked before anything is fetched', async () => {
  const moves = 'e4 e5 Nf3 Nc6 Ng5 Nf6 Nxf7 Kxf7';
  const steps = replay(moves.split(' '));
  const analysed: ExportedGame = {
    id: 'bbb',
    createdAt: 1000,
    variant: 'standard',
    players: { white: { user: { id: 'someone', name: 'someone' } }, black: {} },
    moves,
    // Exactly lichess' shape: a best move and a variation, and no `alts`.
    analysis: [
      { eval: 20 },
      { eval: 15 },
      { eval: 25 },
      { eval: 20 },
      { eval: -300, best: 'f1c4', variation: 'Bc4 Bc5' },
      { eval: -310 },
      { eval: -320 },
      { eval: -330 },
    ],
  } as ExportedGame;

  const asked: string[] = [];
  const engine: Analyser = {
    analyse: () => Promise.reject(new Error('the ranking pass must not sweep')),
    analyseLines: (req: Request): Promise<EngineLine[]> => {
      asked.push(req.fen);
      return Promise.resolve(
        ['f1c4', 'd2d4', 'b1c3'].map((uci, i) => ({
          depth: 20,
          score: { cp: 30 - i * 10 },
          pv: [uci],
          multiPv: i + 1,
        })),
      );
    },
  };

  const store = fakeStore();
  store.stored.push(analysed);
  const { puzzles, handlers } = events();
  const fetch = stubFetch(() => new Response('', { status: 429 }));
  try {
    // `now` is far enough back that the export gap blocks fetching outright,
    // which is the point: the backlog is not a fetch and must not wait on one.
    await new Pipeline(store, () => Promise.resolve(engine), handlers, () => 0).run();
  } finally {
    fetch.restore();
  }

  assert.deepEqual(asked, [steps[4]!.fen], 'the position before the mistake, once');
  assert.deepEqual(
    puzzles.map(p => p.id),
    ['bbb:5'],
    'and it comes out of the store as a puzzle in the same pass',
  );
  assert.deepEqual(puzzles[0]!.alts.map(a => a.uci), ['f1c4', 'd2d4', 'b1c3']);
  assert.deepEqual(store.stored.at(-1)!.analysis![4]!.alts!.map(a => a.uci), [
    'f1c4',
    'd2d4',
    'b1c3',
  ]);
});

test('a game already ranked is not ranked again', async () => {
  const engine: Analyser = {
    analyse: () => Promise.reject(new Error('nothing to do')),
    analyseLines: () => Promise.reject(new Error('nothing to do')),
  };
  const store = fakeStore();
  const { handlers, errors } = events();
  // An empty export, so the run gets all the way through without the engine
  // being the thing that stopped it.
  const fetch = stubFetch(() => new Response(''));
  try {
    await new Pipeline(store, () => Promise.resolve(engine), handlers, () => 0).run();
  } finally {
    fetch.restore();
  }
  assert.deepEqual(errors, [], 'a store with nothing owing gives the engine no reason to start');
});

// The limit exists for phones, where an unbounded database is both slowest to
// build and likeliest to be thrown away by the browser.
test('the storage limit stops new games arriving and deletes nothing', async () => {
  const store = fakeStore();
  for (const id of ['old1', 'old2']) {
    store.stored.push({
      id,
      createdAt: 1000,
      variant: 'standard',
      players: { white: { user: { id: 'someone', name: 'someone' } }, black: {} },
      moves: 'e4 e5',
    } as ExportedGame);
  }
  saveSettings({ maxGames: 2 });
  const { handlers, errors } = events();
  let asked = 0;
  const fetch = stubFetch(() => {
    asked++;
    return new Response('');
  });
  try {
    const engine: Analyser = { analyse: () => Promise.reject(new Error('no engine needed')) };
    await new Pipeline(store, () => Promise.resolve(engine), handlers, () => 0).run();
  } finally {
    fetch.restore();
    saveSettings({ maxGames: 0 });
  }

  assert.equal(asked, 0, 'lichess is not asked for games we have decided not to keep');
  assert.equal(store.stored.length, 2, 'and nothing already held is dropped to make room');
  assert.deepEqual(errors, []);
});
