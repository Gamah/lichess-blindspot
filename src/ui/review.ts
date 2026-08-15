// The deck dialog: every position in the deck, as a board you can look at.
//
// **It is a `<dialog>`, opened modally, and that is not decoration.** The other
// two panels sit under the board and push it up the page; this one is a grid
// that can run to hundreds of positions, and reading it should not mean
// scrolling the board out of sight and then scrolling back to carry on solving.
// Native `showModal()` also brings the backdrop, Escape, the focus trap and
// inerting the page behind it — all of which a hand-rolled overlay would have
// to reimplement, and would get wrong.
//
// Static assembly only — it takes the rows `deck/review.ts` worked out and
// turns them into markup, leaving a `div.mini` per card for `App` to mount a
// view-only board into. Every value that came from lichess or from a person is
// escaped here, at the call site, the way `about.ts` says.
//
// The buttons carry a puzzle id in a data attribute and nothing else; `App`
// looks the position up.

import type { Puzzle } from '../deck/build.ts';
import type { ReviewRow, WaitingSummary } from '../deck/review.ts';
import { escape, gameUrl, moveNumber, showEval } from './format.ts';

/**
 * Cards a page, both halves. Paged rather than rendered whole because both
 * lists grow without limit and each card is a board: a few hundred of them is a
 * few hundred chessground instances built on every open, inside a dialog that
 * has to appear instantly. The rows are worked out once and held; a page turn
 * re-renders a dozen cards and touches no storage.
 */
export const PAGE_SIZE = 12;

export const pageCount = (n: number): number => Math.max(1, Math.ceil(n / PAGE_SIZE));

/** Clamped, so a page held across a purge or a settings change cannot land past the end. */
export const clampPage = (page: number, n: number): number =>
  Math.min(Math.max(0, page), pageCount(n) - 1);

export const pageOf = <T>(items: readonly T[], page: number): readonly T[] => {
  const at = clampPage(page, items.length);
  return items.slice(at * PAGE_SIZE, (at + 1) * PAGE_SIZE);
};

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

const side = (pov: 'white' | 'black'): string => (pov === 'white' ? 'White' : 'Black');

/**
 * The board on a card. `App` mounts a real one into this after the markup
 * lands; the attributes are the whole of what it needs.
 */
const mini = (fen: string, pov: 'white' | 'black'): string =>
  `<div class="mini" data-fen="${escape(fen)}" data-pov="${pov}"></div>`;

/**
 * An unsolved position, and the reason this is allowed to exist at all.
 *
 * The rule at the top of `ui/app.ts` is about **where a position came from** —
 * the game, the opponent, the date, the move number, the evaluation — not about
 * the position itself, which is handed over in full the moment the puzzle is
 * dealt. A grid of them together adds nothing to that: twelve boards side by
 * side tell you no more than each one does alone, because there is nothing
 * shared between them to read. So the position is shown and everything around
 * it is not, which is the same line the solving screen draws.
 */
const waitingCard = (p: Puzzle): string => `
  <li class="deck-card">
    ${mini(p.fen, p.pov)}
    <div class="deck-card-text"><strong>${side(p.pov)} to play.</strong></div>
    <button class="quiet" data-serve="${escape(p.id)}">Solve this</button>
  </li>`;

const outcome = (row: ReviewRow): string =>
  row.result === 'win'
    ? `<span class="good">Found it</span> in ${plural(row.attempts, 'try', 'tries')}`
    : `<span class="dim">Looked at the answer</span>${
        row.attempts ? ` after ${plural(row.attempts, 'try', 'tries')}` : ''
      }`;

/**
 * A solved position. Everything is allowed here — it is solved, so the rule
 * about hiding its origin has already been discharged by `renderReveal`.
 */
function solvedCard(r: ReviewRow): string {
  const when = new Date(r.at).toLocaleDateString();
  if (!r.puzzle)
    return `
      <li class="deck-card gone">
        <div class="deck-card-text"><span class="dim">This position is not in the deck at the
          moment — "positions per game" no longer reaches it. Raising it in Settings brings it
          back.</span></div>
        <div class="deck-card-meta">${outcome(r)} · ${escape(when)}</div>
      </li>`;

  const p = r.puzzle;
  const them = r.game
    ? (p.pov === 'white' ? r.game.players.black : r.game.players.white).user?.name ?? 'Anonymous'
    : undefined;
  const played = new Date(r.game?.createdAt ?? 0).toLocaleDateString();
  return `
    <li class="deck-card">
      ${mini(p.fen, p.pov)}
      <div class="deck-card-text">
        <strong>${escape(p.played.san)}</strong> was played, move ${moveNumber(p.ply)} —
        ${escape(`${showEval(p.prevEval)} → ${showEval(p.eval)}`)}${
          p.judgment ? ` · ${escape(p.judgment)}` : ''
        }
        <span class="dim">best ${escape(p.pv.slice(0, 3).join(' '))}</span>
      </div>
      <div class="deck-card-meta">
        ${outcome(r)} · ${escape(when)}${
          them
            ? `<br><a href="${gameUrl(p.gameId, p)}" target="_blank" rel="noopener">vs ${escape(
                them,
              )}, ${escape(played)}</a>`
            : ''
        }
      </div>
      <button class="quiet" data-review="${escape(p.id)}">Play it again</button>
    </li>`;
}

/** Nothing at all when it all fits on one page — a pager over one page is noise. */
function pager(id: string, total: number, page: number): string {
  const pages = pageCount(total);
  if (pages < 2) return '';
  const at = clampPage(page, total);
  const first = at * PAGE_SIZE + 1;
  const last = Math.min(total, first + PAGE_SIZE - 1);
  return `
    <div class="pager">
      <button class="quiet" data-page="${id}:${at - 1}"${at === 0 ? ' disabled' : ''}>Back</button>
      <span class="dim">${first}–${last} of ${total}</span>
      <button class="quiet" data-page="${id}:${at + 1}"${
        at === pages - 1 ? ' disabled' : ''
      }>More</button>
    </div>`;
}

export interface DeckPages {
  waiting: number;
  solved: number;
}

/**
 * `waiting` is in the order the deck will deal it; `rows` is every solve,
 * newest first. Pages are 0-based and clamped here, so the caller may hold a
 * stale one across a purge without checking.
 */
export function deckPanel(
  summary: WaitingSummary,
  waiting: readonly Puzzle[],
  rows: readonly ReviewRow[],
  pages: DeckPages = { waiting: 0, solved: 0 },
): string {
  return `
    <div class="panel-head">
      <h2>Your deck</h2>
      <button id="close" class="quiet">Close</button>
    </div>

    <h3 class="deck-section">Still to solve
      <span class="dim">${
        summary.count
          ? `${plural(summary.count, 'position')}, from ${plural(summary.games, 'game')}`
          : 'nothing waiting'
      }</span></h3>
    ${
      summary.count
        ? `<p class="hint">The position and nothing else — no game, no opponent, no date, no
             evaluation, exactly as one arrives when it is dealt. They are shuffled so that two
             from one game never come up together; "Solve this" jumps the queue.</p>
           <ul class="deck-grid">${pageOf(waiting, pages.waiting).map(waitingCard).join('')}</ul>
           ${pager('waiting', waiting.length, pages.waiting)}`
        : `<p class="hint">Nothing is waiting — the engine is either still working or has run
             out of games to look at.</p>`
    }

    <h3 class="deck-section">Solved <span class="dim">${plural(rows.length, 'position')}</span></h3>
    ${
      rows.length
        ? `<p class="hint">Newest first. Playing one again puts it back on the board exactly as
             it was; it is a replay, so how it goes this time is not recorded and the position
             does not rejoin the shuffle. Settings can put <em>all</em> of them back at once, and
             deleting games there deletes their solved records too.</p>
           <ul class="deck-grid">${pageOf(rows, pages.solved).map(solvedCard).join('')}</ul>
           ${pager('solved', rows.length, pages.solved)}`
        : `<p class="hint">Nothing solved yet.</p>`
    }`;
}
