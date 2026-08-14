// The slice of UCI we need: send a position, get one line back. Kept pure and
// DOM-free so `node --test` can drive it with recorded engine output.
//
// UCI scores are from the side to move. Everything downstream of here — the
// candidate finder, the lichess export — is White's point of view, so we
// normalise on the way in and never think about it again.

import type { Color, EvalScore } from '../analysis/winningChances.ts';

export interface Request {
  fen: string;
  /** Search to this depth. Cheap and deterministic; used for the sweep. */
  depth?: number;
  /** Or search for this long, in ms. Used for the deep re-check. */
  movetime?: number;
  /**
   * Ask for this many alternative lines instead of one. Sent on every search,
   * including the ordinary one-line kind, so the engine never carries a
   * MultiPV left over from the last caller.
   */
  multiPv?: number;
}

export interface EngineLine {
  depth: number;
  /** White's point of view, like the lichess export. */
  score: EvalScore;
  /** Principal variation, uci. */
  pv: string[];
  /**
   * Rank within a MultiPV search, 1-based and 1 for an ordinary one — so the
   * engine's own ordering, best first. Optional because plenty of code
   * constructs an EngineLine without caring.
   */
  multiPv?: number;
}

/**
 * Parse one `info` line. Returns undefined for lines with no score (`info
 * depth 1 currmove ...`, `info string ...`) and for bound-only scores, which
 * are a search artefact rather than an evaluation.
 */
export function parseInfo(line: string, turn: Color): EngineLine | undefined {
  if (!line.startsWith('info ')) return undefined;
  const t = line.split(' ');
  let depth: number | undefined;
  let score: EvalScore | undefined;
  let pv: string[] | undefined;
  let multiPv = 1;
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth':
        depth = Number(t[++i]);
        break;
      case 'multipv':
        multiPv = Number(t[++i]);
        break;
      case 'score': {
        const kind = t[++i];
        const value = Number(t[++i]);
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') return undefined;
        if (kind === 'cp') score = { cp: value };
        else if (kind === 'mate') score = { mate: value };
        break;
      }
      case 'pv':
        pv = t.slice(i + 1).filter(Boolean);
        i = t.length;
        break;
    }
  }
  if (depth === undefined || !score) return undefined;
  return { depth, score: toWhite(score, turn), pv: pv ?? [], multiPv };
}

/** `bestmove e2e4 ponder e7e5` -> `e2e4`. `bestmove (none)` -> undefined. */
export function parseBestmove(line: string): string | undefined {
  if (!line.startsWith('bestmove ')) return undefined;
  const uci = line.split(' ')[1];
  return !uci || uci === '(none)' ? undefined : uci;
}

const toWhite = (score: EvalScore, turn: Color): EvalScore =>
  turn === 'white'
    ? score
    : score.mate !== undefined
      ? { mate: -score.mate }
      : { cp: -score.cp! };

/** Whose turn it is in a FEN. */
export function fenTurn(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

export interface SessionOptions {
  threads?: number;
  hashMb?: number;
}

/**
 * Drives one engine: options, handshake, and one search at a time. It knows
 * nothing about where the engine is running, which is what lets the node
 * scripts exercise this exact code rather than an approximation of it.
 */
export class UciSession {
  private readonly send: (cmd: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private onLine: ((line: string) => void) | undefined;
  private closed = false;

  constructor(send: (cmd: string) => void) {
    this.send = send;
  }

  /** Feed every line the engine prints to this. */
  receive(line: string): void {
    this.onLine?.(line);
  }

  /** Set options and wait for `readyok`, so nothing is sent into a cold engine. */
  handshake(opts: SessionOptions = {}): Promise<void> {
    return this.exchange<void>(
      () => {
        this.send('uci');
        this.send(`setoption name Threads value ${opts.threads ?? 1}`);
        this.send(`setoption name Hash value ${opts.hashMb ?? 128}`);
        this.send('setoption name MultiPV value 1');
        this.send('ucinewgame');
        this.send('isready');
      },
      (line, done) => {
        if (line === 'readyok') done();
      },
    );
  }

  /**
   * Change an option on a running engine. Queued like a search, so it lands
   * between two of them rather than in the middle of one — Stockfish ignores
   * `setoption` while it is thinking.
   */
  setOption(name: string, value: string | number): Promise<void> {
    const run = () =>
      this.exchange<void>(
        () => {
          this.send(`setoption name ${name} value ${value}`);
          this.send('isready');
        },
        (line, done) => {
          if (line === 'readyok') done();
        },
      );
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Analyse one position. Serialised: an engine is one search at a time. */
  analyse(req: Request): Promise<EngineLine> {
    return this.analyseLines(req).then(lines => lines[0]!);
  }

  /**
   * The engine's top `multiPv` moves for a position, best first — what the
   * difficulty gate is measured against, and what the arrows on a solved
   * position are drawn from. Always at least one line; the search rejects
   * rather than returning none.
   */
  analyseLines(req: Request): Promise<EngineLine[]> {
    const run = () => this.search(req);
    const result = this.queue.then(run, run);
    // Keep the chain alive even when one request rejects.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.send('quit');
  }

  private search(req: Request): Promise<EngineLine[]> {
    if (this.closed) return Promise.reject(new Error('Engine stopped'));
    const turn = fenTurn(req.fen);
    const limit = req.movetime !== undefined ? `movetime ${req.movetime}` : `depth ${req.depth ?? 12}`;
    const multiPv = Math.max(1, req.multiPv ?? 1);
    // One deepest line per rank. A MultiPV search reprints all of them at each
    // new depth, so the last of each is the one we want.
    const best = new Map<number, EngineLine>();
    return this.exchange<EngineLine[]>(
      () => {
        // Set every time rather than only when it changes: this session is
        // shared between the background pass and the solve loop, and a stale
        // MultiPV would quietly slow the sweep down fivefold.
        this.send(`setoption name MultiPV value ${multiPv}`);
        this.send(`position fen ${req.fen}`);
        this.send(`go ${limit}`);
      },
      (line, done, fail) => {
        const info = parseInfo(line, turn);
        // Keep the deepest scored line: the last `info` before `bestmove` is
        // often a bare depth report with no score at all.
        if (info) {
          const rank = info.multiPv ?? 1;
          const held = best.get(rank);
          if (!held || info.depth >= held.depth) best.set(rank, info);
        }
        if (!line.startsWith('bestmove')) return;
        const lines = [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
        const head = lines[0];
        if (!head) return fail(new Error(`No evaluation for ${req.fen}`));
        const bestmove = parseBestmove(line);
        // Trust `bestmove` over the last pv we saw: they agree except when the
        // search was cut off part-way through a line. Only for a single-line
        // search — under MultiPV, overwriting the first pv with `bestmove`
        // would put a move in rank 1 that the ranking did not agree with.
        if (multiPv === 1 && bestmove && head.pv[0] !== bestmove) lines[0] = { ...head, pv: [bestmove] };
        done(lines);
      },
    );
  }

  private exchange<T>(
    start: () => void,
    handle: (line: string, done: (value: T) => void, fail: (e: Error) => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.onLine = line =>
        handle(
          line,
          value => {
            this.onLine = undefined;
            resolve(value);
          },
          e => {
            this.onLine = undefined;
            reject(e);
          },
        );
      start();
    });
  }
}
