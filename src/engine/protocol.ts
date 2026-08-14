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
}

export interface EngineLine {
  depth: number;
  /** White's point of view, like the lichess export. */
  score: EvalScore;
  /** Principal variation, uci. */
  pv: string[];
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
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth':
        depth = Number(t[++i]);
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
  return { depth, score: toWhite(score, turn), pv: pv ?? [] };
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
