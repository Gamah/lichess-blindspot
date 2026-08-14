// Chessground, wrapped so the rest of the app never touches it directly.
//
// The one bit of chrome on an otherwise bare screen is the promotion chooser,
// which exists because auto-queening would make a puzzle whose answer is an
// underpromotion unsolvable rather than merely hard.

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

  private readonly el: HTMLElement;
  private readonly onMove: (move: PlayedMove) => void;

  constructor(el: HTMLElement, onMove: (move: PlayedMove) => void) {
    this.el = el;
    this.onMove = onMove;
    this.cg = Chessground(el, {
      coordinates: true,
      animation: { enabled: true, duration: 200 },
      movable: { free: false, showDests: true, events: { after: (o, d) => void this.afterMove(o, d) } },
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

  private async afterMove(orig: Key, dest: Key): Promise<void> {
    const uci = orig + dest;
    // chessground has already moved the piece, so ask chessops what the move
    // actually was and re-set the board from its answer. A move that is only
    // legal with a promotion piece attached is exactly how we detect one.
    let played = applyUci(this.fen, uci);
    let full = uci;
    if (!played) {
      const piece = await this.askPromotion(dest);
      if (!piece) return this.reset(); // cancelled
      full = uci + piece;
      played = applyUci(this.fen, full);
    }
    if (!played) return this.reset();
    this.cg.set({ fen: played.after, turnColor: turnOf(played.after) });
    this.freeze();
    this.onMove({ uci: full, san: played.san, after: played.after });
  }

  /**
   * Underpromotion is rare and a puzzle whose answer is one is rarer, but
   * auto-queening makes such a puzzle unsolvable rather than hard, so it gets
   * asked. Escape or a click outside cancels the move.
   */
  private askPromotion(dest: Key): Promise<'q' | 'r' | 'b' | 'n' | undefined> {
    const colour = turnOf(this.fen);
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'promotion';
      overlay.innerHTML = (['q', 'r', 'b', 'n'] as const)
        .map(
          p =>
            `<button data-piece="${p}" title="${PIECE_NAMES[p]} on ${dest}">
               <piece class="${PIECE_NAMES[p]} ${colour}"></piece>
             </button>`,
        )
        .join('');

      const done = (piece?: 'q' | 'r' | 'b' | 'n') => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        resolve(piece);
      };
      const onKey = (e: KeyboardEvent) => e.key === 'Escape' && done();

      overlay.addEventListener('click', e => {
        const piece = (e.target as HTMLElement).closest('button')?.dataset['piece'];
        done(piece as 'q' | 'r' | 'b' | 'n' | undefined);
      });
      document.addEventListener('keydown', onKey);
      // Inside .cg-wrap, because that is the ancestor the piece-set stylesheet
      // keys its images off. Our own rules undo its absolute positioning.
      (this.el.querySelector('.cg-wrap') ?? this.el).appendChild(overlay);
    });
  }
}

const PIECE_NAMES = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' } as const;

const turnOf = (fen: string): Color => (fen.split(' ')[1] === 'b' ? 'black' : 'white');

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
