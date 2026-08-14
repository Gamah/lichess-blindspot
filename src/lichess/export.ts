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

/**
 * Why the export failed, when it matters to the person waiting. lichess uses
 * 429 for two unrelated things and they need different sentences: going too
 * fast, and running two exports at once — which for us means a second tab.
 */
export type FailureKind = 'notFound' | 'rateLimit' | 'concurrent' | 'http';

export class ExportError extends Error {
  readonly kind: FailureKind;
  readonly status: number;

  constructor(kind: FailureKind, status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
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
  if (!res.ok) throw await failure(res, username);
  if (!res.body) throw new ExportError('http', res.status, 'lichess sent no response body');

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

/**
 * Turn a failed response into something worth showing. The concurrency limit
 * answers `{"error":"Please only run 1 request(s) at a time"}` with the same
 * 429 as the per-second limit, so the body is the only thing that separates
 * them.
 *
 * A 404 here can also mean lichess' NoCrawlers guard rejected a request with no
 * User-Agent, but a browser always sends one, so from the app it really is a
 * missing user.
 */
async function failure(res: Response, username: string): Promise<ExportError> {
  const body = await res.text().catch(() => '');
  if (res.status === 404) return new ExportError('notFound', 404, `No such lichess user: ${username}`);
  if (res.status === 429 && /at a time/i.test(body))
    return new ExportError(
      'concurrent',
      429,
      'lichess allows one games export at a time, and another one is running — ' +
        'close any other Blindspot tab and try again.',
    );
  if (res.status === 429)
    return new ExportError('rateLimit', 429, 'lichess is rate limiting us — wait a minute and retry.');
  return new ExportError('http', res.status, `lichess returned ${res.status}`);
}

/** Which side the named player had, or undefined if they weren't in the game. */
export function povOf(game: ExportedGame, username: string): 'white' | 'black' | undefined {
  const id = username.toLowerCase();
  if (game.players.white.user?.id.toLowerCase() === id) return 'white';
  if (game.players.black.user?.id.toLowerCase() === id) return 'black';
  return undefined;
}
