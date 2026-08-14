// Chessground, wrapped so the rest of the app never touches it directly.
//
// Promotion is auto-queen. Underpromotion is a real puzzle answer roughly never,
// and a promotion dialog would be the only piece of chrome on an otherwise bare
// screen. If a puzzle's solution ever needs it, this is the place to fix.

import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';

import { applyUci, dests } from '../deck/positions.ts';
import type { Color } from '../analysis/winningChances.ts';

export interface PlayedMove {
  uci: string;
  san: string;
  /** Position after the move, for handing to the engine. */
  after: string;
}

export class Board {
  private cg: Api;
  private fen = '';
  private orientation: Color = 'white';

  private readonly onMove: (move: PlayedMove) => void;

  constructor(el: HTMLElement, onMove: (move: PlayedMove) => void) {
    this.onMove = onMove;
    this.cg = Chessground(el, {
      coordinates: true,
      animation: { enabled: true, duration: 200 },
      movable: { free: false, showDests: true, events: { after: (o, d) => this.afterMove(o, d) } },
      draggable: { showGhost: true },
      drawable: { enabled: true },
    });
  }

  /** Show a position, taking moves from `orientation`'s side. */
  set(fen: string, orientation: Color, movable: boolean): void {
    this.fen = fen;
    this.orientation = orientation;
    this.cg.set({
      fen,
      orientation,
      turnColor: orientation,
      lastMove: undefined,
      check: undefined,
      movable: {
        color: movable ? orientation : undefined,
        dests: movable ? (dests(fen) as Map<Key, Key[]>) : new Map(),
      },
    });
  }

  /** Rewind to the position we handed out, after a wrong move. */
  reset(): void {
    this.set(this.fen, this.orientation, true);
  }

  freeze(): void {
    this.cg.set({ movable: { color: undefined, dests: new Map() } });
  }

  /** Play a line out on the board, for showing the solution. */
  async playLine(ucis: readonly string[], fen = this.fen, delay = 600): Promise<void> {
    let at = fen;
    for (const uci of ucis) {
      const played = applyUci(at, uci);
      if (!played) return;
      this.cg.move(uci.slice(0, 2) as Key, uci.slice(2, 4) as Key);
      this.cg.set({ fen: played.after, turnColor: turnOf(played.after) });
      at = played.after;
      await sleep(delay);
    }
    this.freeze();
  }

  private afterMove(orig: Key, dest: Key): void {
    const uci = orig + dest;
    // Auto-queen: chessground has already moved the pawn, so ask chessops what
    // the move actually was and re-set the board from its answer.
    const played = applyUci(this.fen, uci) ?? applyUci(this.fen, uci + 'q');
    if (!played) return this.reset();
    this.cg.set({ fen: played.after, turnColor: turnOf(played.after) });
    this.freeze();
    this.onMove({ uci: played.san.includes('=') ? uci + 'q' : uci, san: played.san, after: played.after });
  }
}

const turnOf = (fen: string): Color => (fen.split(' ')[1] === 'b' ? 'black' : 'white');

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
