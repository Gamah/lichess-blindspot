// The deck dialog: every position in the deck, as a board you can look at,
// plus what the solve records add up to.
//
// **It is a `<dialog>`, opened modally, and that is not decoration.** The other
// two panels sit under the board and push it up the page; this one is a list
// that runs to hundreds of positions, and reading it should not mean scrolling
// the board out of sight and then scrolling back to carry on solving. Native
// `showModal()` also brings the backdrop, Escape, the focus trap and inerting
// the page behind it — all of which a hand-rolled overlay would have to
// reimplement, and would get wrong.
//
// Static assembly only — it takes the rows `deck/review.ts` worked out and
// turns them into markup, leaving a `div.mini` per card for `App` to mount a
// view-only board into. Every value that came from lichess or from a person is
// escaped here, at the call site, the way `about.ts` says.
//
// Buttons carry an id in a data attribute and nothing else; `App` looks it up.

import type { Puzzle } from '../deck/build.ts';
import { isCheck } from '../deck/positions.ts';
import type { ReviewRow, WaitingSummary } from '../deck/review.ts';
import type { DeckStats, Tally } from '../deck/stats.ts';
import type { ExportedGame } from '../lichess/export.ts';
import { escape, gameUrl, moveNumber, showEval } from './format.ts';

/**
 * Cards a page, per section. Paged rather than rendered whole because the lists
 * grow without limit and each card is a board: a few hundred of them is a few
 * hundred chessground instances built on every open, inside a dialog that has
 * to appear instantly. The rows are worked out once and held; a page turn
 * re-renders a dozen cards and touches no storage.
 */
export const PAGE_SIZE = 12;

export const pageCount = (n: number): number => Math.max(1, Math.ceil(n / PAGE_SIZE));

/** Clamped, so a page held across a delete or a settings change cannot land past the end. */
export const clampPage = (page: number, n: number): number =>
  Math.min(Math.max(0, page), pageCount(n) - 1);

export const pageOf = <T>(items: readonly T[], page: number): readonly T[] => {
  const at = clampPage(page, items.length);
  return items.slice(at * PAGE_SIZE, (at + 1) * PAGE_SIZE);
};

export interface DeckPages {
  waiting: number;
  solved: number;
  hidden: number;
}

export const NO_PAGES: DeckPages = { waiting: 0, solved: 0, hidden: 0 };

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

const side = (pov: 'white' | 'black'): string => (pov === 'white' ? 'White' : 'Black');

const percent = (part: number, whole: number): string =>
  whole ? `${Math.round((part / whole) * 100)}%` : '—';

const date = (ms: number): string => new Date(ms).toLocaleDateString();

// --- the boards -------------------------------------------------------------

/**
 * The board on a card. `App` mounts a real one into this after the markup
 * lands; the attributes are the whole of what it needs.
 *
 * `played` and `last` are the red arrow and the last-move squares, which are
 * what the solving screen puts on a position the moment it is dealt.
 */
const mini = (p: Puzzle): string =>
  `<div class="mini" data-fen="${escape(p.fen)}" data-pov="${p.pov}"` +
  ` data-played="${escape(p.played.uci)}"` +
  (p.intro ? ` data-last="${escape(p.intro.uci)}"` : '') +
  `></div>`;

// --- the text on a card -----------------------------------------------------

/**
 * What the position is and where it came from — shared by all three sections.
 *
 * **An unsolved card carries this too, which is a deliberate exception to the
 * rule at the top of `ui/app.ts`.** That rule governs the *solving screen*,
 * where the point is to meet a position cold. The deck dialog is the opposite
 * activity: you opened it to look through what you have, and a list of
 * positions you cannot tell apart is not something you can choose from. So the
 * dialog shows the move number, the swing and the game — everything except the
 * answer, which is the one thing that would make solving pointless rather than
 * merely informed.
 */
function positionText(p: Puzzle): string {
  const check = isCheck(p.fen) ? ` · <span class="bad">in check</span>` : '';
  return `
    <div class="deck-card-text">
      <strong>${escape(p.played.san)}</strong> was played, move ${moveNumber(p.ply)},
      ${side(p.pov)}${check}
      <span class="dim">${escape(`${showEval(p.prevEval)} → ${showEval(p.eval)}`)}${
        p.judgment ? ` · ${escape(p.judgment)}` : ''
      }</span>
    </div>`;
}

/** The link into the game, when the game is still here to link to. */
function gameLink(p: Puzzle, game: ExportedGame | undefined): string {
  if (!game) return `<span class="dim">the game is no longer stored</span>`;
  const them = (p.pov === 'white' ? game.players.black : game.players.white).user?.name ?? 'Anonymous';
  return `<a href="${gameUrl(p.gameId, p)}" target="_blank" rel="noopener">vs ${escape(
    them,
  )}, ${escape(date(game.createdAt))}</a>`;
}

const metaLine = (parts: readonly string[]): string =>
  `<div class="deck-card-meta">${parts.filter(Boolean).join(' · ')}</div>`;

const outcome = (row: ReviewRow): string => {
  const hint = row.hinted ? ' <span class="dim">(with a hint)</span>' : '';
  if (row.result === undefined) return '<span class="dim">not solved</span>';
  return row.result === 'win'
    ? `<span class="good">found it</span> in ${plural(row.attempts ?? 0, 'try', 'tries')}${hint}`
    : `<span class="dim">looked at the answer</span>${hint}`;
};

/** The row a record points at when its position can no longer be derived. */
const gone = (r: ReviewRow, actions: string): string => `
  <li class="deck-card gone">
    <div class="deck-card-text"><span class="dim">This position is not in the deck at the moment
      — "positions per game" no longer reaches it. Raising it in Settings brings it back.</span></div>
    <div class="deck-card-meta">${outcome(r)} · ${escape(date(r.at))}</div>
    ${actions}
  </li>`;

// --- the buttons ------------------------------------------------------------

/**
 * Hide, and nothing destructive. **There is deliberately no delete here.** The
 * only thing that could be deleted is the *game* — a position is derived from
 * its game on every deck build — and deleting a game throws away the minutes of
 * engine time that analysed it while leaving the paging cursor past it, so the
 * game is not re-fetched and the work is simply gone. Hiding does everything
 * wanting-it-gone actually needs, costs nothing, and can be undone. Purge in
 * Settings is still there for reclaiming space, where losing the analysis is
 * the point rather than a side effect.
 */
const actions = (p: Puzzle, first: string): string => `
  <div class="deck-card-actions">
    ${first}
    <button class="quiet" data-hide="${escape(p.id)}">Hide</button>
  </div>`;

const orphanActions = (r: ReviewRow): string => `
  <div class="deck-card-actions">
    <button class="quiet" data-forget="${escape(r.puzzleId)}">Forget this record</button>
  </div>`;

// --- the cards --------------------------------------------------------------

const waitingCard = (p: Puzzle, games: ReadonlyMap<string, ExportedGame>): string => `
  <li class="deck-card">
    ${mini(p)}
    ${positionText(p)}
    ${metaLine([gameLink(p, games.get(p.gameId))])}
    ${actions(p, `<button class="quiet" data-serve="${escape(p.id)}">Solve this</button>`)}
  </li>`;

function solvedCard(r: ReviewRow): string {
  if (!r.puzzle) return gone(r, orphanActions(r));
  const p = r.puzzle;
  return `
    <li class="deck-card">
      ${mini(p)}
      ${positionText(p)}
      ${metaLine([
        `<span class="dim">best ${escape(p.pv.slice(0, 3).join(' '))}</span>`,
        outcome(r),
        escape(date(r.at)),
        gameLink(p, r.game),
      ])}
      ${actions(p, `<button class="quiet" data-review="${escape(p.id)}">Play it again</button>`)}
    </li>`;
}

function hiddenCard(r: ReviewRow): string {
  const restore = `<button class="quiet" data-restore="${escape(r.puzzleId)}">Restore</button>`;
  if (!r.puzzle)
    return gone(r, `<div class="deck-card-actions">${restore}</div>`);
  const p = r.puzzle;
  return `
    <li class="deck-card">
      ${mini(p)}
      ${positionText(p)}
      ${metaLine([outcome(r), `hidden ${escape(date(r.at))}`, gameLink(p, r.game)])}
      <div class="deck-card-actions">${restore}</div>
    </li>`;
}

// --- the stats --------------------------------------------------------------

const bar = (label: string, t: Tally): string => `
  <li>
    <span class="stat-label">${escape(label)}</span>
    <span class="stat-bar"><span style="width:${t.solved ? (t.found / t.solved) * 100 : 0}%"></span></span>
    <span class="stat-value">${percent(t.found, t.solved)} <span class="dim">of ${t.solved}</span></span>
  </li>`;

const figure = (value: string, label: string): string =>
  `<li><strong>${value}</strong><span class="dim">${escape(label)}</span></li>`;

/**
 * Everything the solve records will honestly support, and nothing they will
 * not. There is no timing, no rating and no comparison with anyone else,
 * because none of that is recorded — a solve is a result, a number of tries and
 * a date.
 *
 * The breakdown by band is the one worth having: it is the same three
 * thresholds lichess judges a move by, so "you find blunders and miss
 * inaccuracies" is a statement about your play rather than about this app.
 */
function statsBlock(s: DeckStats): string {
  if (!s.solved)
    return `<p class="hint">Nothing solved yet — this fills in as you go.</p>`;
  return `
    <ul class="stat-figures">
      ${figure(String(s.solved), 'solved')}
      ${figure(percent(s.found, s.solved), 'found without looking')}
      ${figure(percent(s.unaided, s.solved), 'found unaided')}
      ${figure(percent(s.hinted, s.solved), 'took a hint')}
      ${figure(percent(s.firstTry, s.solved), 'found first try')}
      ${figure(s.averageTries ? s.averageTries.toFixed(1) : '—', 'tries when found')}
      ${figure(String(s.recent), 'in the last 7 days')}
      ${figure(String(s.streak), s.streak === 1 ? 'day in a row' : 'days in a row')}
    </ul>
    <ul class="stat-bars">
      ${s.byBand.filter(b => b.tally.solved).map(b => bar(b.label, b.tally)).join('')}
      ${s.bySide.white.solved ? bar('As White', s.bySide.white) : ''}
      ${s.bySide.black.solved ? bar('As Black', s.bySide.black) : ''}
    </ul>
    <p class="hint"><em>Found unaided</em> is found without looking at the answer <em>and</em>
      without taking a hint; the two figures next to it are the same total split the other way.
      Each bar is how often you found the move without looking at the answer.
      The three bands are lichess' own thresholds for an inaccuracy, a mistake and a blunder,
      so the shape of that list says something about your play rather than about this app.
      Nothing here is recorded beyond the result, the number of tries and the date, and none
      of it leaves this browser.</p>`;
}

// --- the whole thing --------------------------------------------------------

/** Nothing at all when it all fits on one page — a pager over one page is noise. */
function pager(id: string, total: number, page: number): string {
  const pages = pageCount(total);
  if (pages < 2) return '';
  const at = clampPage(page, total);
  const first = at * PAGE_SIZE + 1;
  return `
    <div class="pager">
      <button class="quiet" data-page="${id}:${at - 1}"${at === 0 ? ' disabled' : ''}>Back</button>
      <span class="dim">${first}–${Math.min(total, first + PAGE_SIZE - 1)} of ${total}</span>
      <button class="quiet" data-page="${id}:${at + 1}"${
        at === pages - 1 ? ' disabled' : ''
      }>More</button>
    </div>`;
}

const section = (title: string, note: string, body: string): string =>
  `<h3 class="deck-section">${title} <span class="dim">${note}</span></h3>${body}`;

export interface DeckView {
  summary: WaitingSummary;
  waiting: readonly Puzzle[];
  games: ReadonlyMap<string, ExportedGame>;
  solved: readonly ReviewRow[];
  hidden: readonly ReviewRow[];
  stats: DeckStats;
  pages: DeckPages;
}

export function deckPanel(view: DeckView): string {
  const { summary, waiting, games, solved, hidden, pages } = view;
  const list = (items: string[], id: string, total: number, page: number): string =>
    `<ul class="deck-grid">${items.join('')}</ul>${pager(id, total, page)}`;

  return `
    <div class="panel-head">
      <h2>Your deck</h2>
      <button id="close" class="quiet">Close</button>
    </div>

    ${section('How it is going', '', statsBlock(view.stats))}

    ${section(
      'Still to solve',
      summary.count
        ? `${plural(summary.count, 'position')}, from ${plural(summary.games, 'game')}`
        : 'nothing waiting',
      summary.count
        ? `<p class="hint">Everything except the engine's answer. "Solve this" jumps the queue;
             hiding one takes it out of the shuffle without deleting anything.</p>
           ${list(
             pageOf(waiting, pages.waiting).map(p => waitingCard(p, games)),
             'waiting',
             waiting.length,
             pages.waiting,
           )}`
        : `<p class="hint">Nothing is waiting — the engine is either still working or has run
             out of games to look at.</p>`,
    )}

    ${section(
      'Solved',
      plural(solved.length, 'position'),
      solved.length
        ? `<p class="hint">Newest first. Playing one again puts it back on the board exactly as
             it was; it is a replay, so how it goes this time is not recorded and the position
             does not rejoin the shuffle.</p>
           ${list(pageOf(solved, pages.solved).map(solvedCard), 'solved', solved.length, pages.solved)}`
        : `<p class="hint">Nothing solved yet.</p>`,
    )}

    ${section(
      'Hidden',
      plural(hidden.length, 'position'),
      hidden.length
        ? `<p class="hint">Put aside and out of the shuffle. Nothing has been deleted — restoring
             one brings it straight back to wherever it belongs.</p>
           ${list(pageOf(hidden, pages.hidden).map(hiddenCard), 'hidden', hidden.length, pages.hidden)}`
        : `<p class="hint">Nothing hidden. The Hide button on a position takes it out of the
             shuffle without deleting it, and it lands here.</p>`,
    )}`;
}
