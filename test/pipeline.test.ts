import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Pipeline, type Store } from '../src/app/pipeline.ts';
import type { Analyser } from '../src/engine/analyse.ts';
import type { Meta } from '../src/storage/db.ts';

// lichess allows one games export per IP at a time, so the thing under test is
// how often this asks — not what it does with the answers.

const fakeStore = (): Store => {
  let meta: Meta = { analysed: [], fetched: [] };
  return {
    username: 'someone',
    meta: async () => meta,
    setMeta: async next => {
      meta = next;
    },
    putGame: async () => {},
    putPuzzles: async () => {},
    purgeGames: async () => 0,
  };
};

const noEngine = (): Promise<Analyser> => Promise.reject(new Error('no engine in tests'));

const events = () => {
  const errors: Error[] = [];
  const retries: number[] = [];
  return {
    errors,
    retries,
    handlers: {
      onPuzzles: () => {},
      onProgress: () => {},
      onError: (e: Error) => errors.push(e),
      onRetry: (_e: Error, ms: number) => retries.push(ms),
    },
  };
};

/** Counts export requests and answers with whatever the test wants. */
function stubFetch(reply: (n: number) => Response) {
  const real = globalThis.fetch;
  const state = { calls: 0 };
  globalThis.fetch = (async () => reply(++state.calls)) as typeof fetch;
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
