import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ExportError, fetchGames, povOf, type ExportedGame } from '../src/lichess/export.ts';

const game = (id: string, whiteId: string, blackId: string): ExportedGame =>
  ({
    id,
    players: {
      white: { user: { id: whiteId, name: whiteId } },
      black: { user: { id: blackId, name: blackId } },
    },
    moves: 'e4 e5',
  }) as ExportedGame;

/** Swap in a fetch that answers with what we want to test against. */
async function withFetch<T>(reply: () => Response, body: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => reply()) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}

const collect = async (): Promise<ExportedGame[]> => {
  const out: ExportedGame[] = [];
  for await (const g of fetchGames('someone')) out.push(g);
  return out;
};

test('ndjson arrives one game at a time, split across chunk boundaries', async () => {
  const lines = [game('aaa', 'someone', 'other'), game('bbb', 'other', 'someone')]
    .map(g => JSON.stringify(g))
    .join('\n');
  // No trailing newline: the last game is only in the buffer when the stream ends.
  const games = await withFetch(() => new Response(lines), collect);
  assert.deepEqual(
    games.map(g => g.id),
    ['aaa', 'bbb'],
  );
});

test('the two meanings of 429 are told apart', async () => {
  const concurrent = await withFetch(
    () => new Response('{"error":"Please only run 1 request(s) at a time"}', { status: 429 }),
    () => collect().catch((e: ExportError) => e),
  );
  assert.equal((concurrent as ExportError).kind, 'concurrent');
  assert.match((concurrent as ExportError).message, /one games export at a time/);

  const fast = await withFetch(
    () => new Response('{"error":"Too many requests"}', { status: 429 }),
    () => collect().catch((e: ExportError) => e),
  );
  assert.equal((fast as ExportError).kind, 'rateLimit');
});

test('404 is a missing user, and says so', async () => {
  const e = await withFetch(
    () => new Response('', { status: 404 }),
    () => collect().catch((err: ExportError) => err),
  );
  assert.equal((e as ExportError).kind, 'notFound');
  assert.match((e as ExportError).message, /someone/);
});

test('povOf is case-insensitive, like lichess usernames', () => {
  const g = game('aaa', 'someone', 'other');
  assert.equal(povOf(g, 'SoMeOnE'), 'white');
  assert.equal(povOf(g, 'other'), 'black');
  assert.equal(povOf(g, 'nobody'), undefined);
});
