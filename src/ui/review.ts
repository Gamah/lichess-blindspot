// The deck panel: what is waiting, and everything that has been solved.
//
// Static assembly only — it takes the rows `deck/review.ts` worked out and
// turns them into markup. Every value that came from lichess or from a person
// is escaped here, at the call site, the way `about.ts` says.
//
// The Review button carries the puzzle id in a data attribute and nothing else;
// `App` looks the position up and puts it back on the board.

import type { ReviewRow, WaitingSummary } from '../deck/review.ts';
import { escape, gameUrl, moveNumber, showEval } from './format.ts';

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The unsolved half, which is a count and a sentence rather than a list — see
 * the note at the top of `deck/review.ts`. The sentence is there because a
 * missing list reads as a missing feature otherwise.
 */
function waiting(summary: WaitingSummary): string {
  const spread =
    summary.count === 0
      ? 'Nothing is waiting — the engine is either still working or has run out of games.'
      : `${plural(summary.count, 'position')} waiting, from ${plural(summary.games, 'game')}.`;
  return `
    <div class="setting">
      <span class="label-text">Still to solve</span>
      <p class="hint">${spread} They are not listed, and that is the point of the app rather
        than an omission: a position you have not solved may not tell you which game it is
        from, so there is nothing to list that would not give it away. They are shuffled so
        that two from one game never arrive together, and Skip puts one back at the end.</p>
    </div>`;
}

const outcome = (row: ReviewRow): string =>
  row.result === 'win'
    ? `<span class="good">Found it</span> in ${plural(row.attempts, 'try', 'tries')}`
    : `<span class="dim">Looked at the answer</span>${
        row.attempts ? ` after ${plural(row.attempts, 'try', 'tries')}` : ''
      }`;

/**
 * One solved position. Everything is allowed here — it is solved, so the rule
 * about hiding its origin has already been discharged by `renderReveal`.
 */
function row(r: ReviewRow): string {
  const when = new Date(r.at).toLocaleDateString();
  if (!r.puzzle)
    return `
      <li class="review-row gone">
        <div class="review-main"><span class="dim">This position is no longer in the deck —
          its game has been deleted, or "positions per game" no longer reaches it.</span></div>
        <div class="review-meta">${outcome(r)} · ${escape(when)}</div>
      </li>`;

  const p = r.puzzle;
  const them = r.game
    ? (p.pov === 'white' ? r.game.players.black : r.game.players.white).user?.name ?? 'Anonymous'
    : undefined;
  const played = new Date(r.game?.createdAt ?? 0).toLocaleDateString();
  return `
    <li class="review-row">
      <div class="review-main">
        <strong>${escape(p.played.san)}</strong> at move ${moveNumber(p.ply)},
        ${p.pov === 'white' ? 'White' : 'Black'} —
        ${escape(`${showEval(p.prevEval)} → ${showEval(p.eval)}`)}${
          p.judgment ? ` · ${escape(p.judgment)}` : ''
        }
        <span class="dim">best ${escape(p.pv.slice(0, 3).join(' '))}</span>
      </div>
      <div class="review-meta">
        ${outcome(r)} · solved ${escape(when)}${
          them ? ` · <a href="${gameUrl(p.gameId, p)}" target="_blank" rel="noopener">vs ${escape(
              them,
            )}, ${escape(played)}</a>` : ''
        }
      </div>
      <button class="quiet" data-review="${escape(p.id)}">Play it again</button>
    </li>`;
}

/**
 * `rows` is every solve, newest first. Nothing is paged: a long history is a
 * few hundred rows of text inside a panel that is already scrolled, and paging
 * it would cost a control for no gain.
 */
export function deckPanel(summary: WaitingSummary, rows: readonly ReviewRow[]): string {
  const solved = rows.length;
  return `
    <div class="panel-head">
      <h2>Your deck</h2>
      <button id="close" class="quiet">Close</button>
    </div>

    ${waiting(summary)}

    <div class="setting">
      <span class="label-text">Solved</span>
      <span class="dim">${plural(solved, 'position')}</span>
      <p class="hint">Newest first. Playing one again puts it back on the board exactly as it
        was; it is a replay, so how it goes this time is not recorded and the position does not
        rejoin the shuffle. Settings can put <em>all</em> of them back in the deck at once.</p>
    </div>

    ${
      solved
        ? `<ul class="review-list">${rows.map(row).join('')}</ul>`
        : `<p class="hint">Nothing solved yet.</p>`
    }`;
}
