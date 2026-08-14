// GET /api/games/user/{u} as NDJSON. No token: the endpoint is public.
// See CLAUDE.md for the field semantics we depend on.

import type { AnalysisEntry } from '../analysis/candidates.ts';

export interface ExportedGame {
  id: string;
  rated: boolean;
  variant: string;
  speed: string;
  perf: string;
  createdAt: number;
  lastMoveAt: number;
  status: string;
  players: {
    white: { user?: { id: string; name: string }; rating?: number };
    black: { user?: { id: string; name: string }; rating?: number };
  };
  winner?: 'white' | 'black';
  initialFen?: string; // absent for a standard start
  moves: string; // SAN, space separated
  division?: { middle?: number; end?: number };
  opening?: { eco: string; name: string; ply: number };
  analysis?: AnalysisEntry[]; // only when lichess has analysed the game
}

export interface FetchOptions {
  max?: number;
  until?: number; // ms, for paging backwards through history
  signal?: AbortSignal;
}

const BASE = 'https://lichess.org';

/**
 * Streams games newest-first, yielding each as it arrives so analysis can start
 * before the download finishes.
 *
 * Throws on 404 (no such user) and 429 (rate limited — 25 games/sec anonymous,
 * and one concurrent export per IP, so never run two of these at once).
 */
export async function* fetchGames(username: string, opts: FetchOptions = {}): AsyncGenerator<ExportedGame> {
  const url = new URL(`/api/games/user/${encodeURIComponent(username)}`, BASE);
  const params = url.searchParams;
  params.set('max', String(opts.max ?? 20));
  params.set('moves', 'true');
  params.set('evals', 'true'); // defaults to false here; we want the free analysis
  params.set('division', 'true');
  params.set('clocks', 'false');
  params.set('pgnInJson', 'false');
  if (opts.until !== undefined) params.set('until', String(opts.until));

  const res = await fetch(url, {
    headers: { Accept: 'application/x-ndjson' },
    signal: opts.signal,
  });
  if (res.status === 404) throw new Error(`No such lichess user: ${username}`);
  if (res.status === 429) throw new Error('Rate limited by lichess — wait a minute before retrying');
  if (!res.ok) throw new Error(`lichess returned ${res.status}`);
  if (!res.body) throw new Error('No response body');

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as ExportedGame;
    }
  }
  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as ExportedGame;
}

/** Which side the named player had, or undefined if they weren't in the game. */
export function povOf(game: ExportedGame, username: string): 'white' | 'black' | undefined {
  const id = username.toLowerCase();
  if (game.players.white.user?.id.toLowerCase() === id) return 'white';
  if (game.players.black.user?.id.toLowerCase() === id) return 'black';
  return undefined;
}
