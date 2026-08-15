// What Blindspot is, in one place.
//
// It exists twice: on the landing page, where someone is deciding whether to
// type their name in, and behind the About button, where someone who already
// did has no other way back to it — the landing page is only reachable by
// Switch player, which throws the session away to get there. Two copies of an
// explanation drift, and the one behind the button is the one nobody would
// notice going stale, so there is one copy and both screens assemble it.
//
// Static markup only: nothing here interpolates anything a person typed, so
// nothing here escapes anything. Keep it that way — if a value has to appear
// in this file, escape it at the call site.

/** The paragraph that says what this is and how it differs from lila's. */
export const pitch = (): string => `
  <p>Lichess' <em>Learn from your mistakes</em> walks you through one game's mistakes in
    order, with the game around them — it reads as review, and you already know something
    went wrong. Blindspot takes the same positions, strips them, and shuffles them across
    your recent games. No opponent, no date, no move number, no eval bar. Just a position,
    from your side of the board, one red arrow showing the move that lost it, and no clue
    whether the answer is a combination or a quiet pawn move.</p>`;

/** Numbered, because it is a sequence: fetch, analyse, find, judge. */
export const steps = (): string => `
  <ol class="steps">
    <li>
      <h2>Your games, from lichess</h2>
      <p>Straight from the public API — no account, no token, nothing to authorise. Twenty
        at a time, and when you work through those it reaches further back into your
        history, for as long as you have games.</p>
    </li>
    <li>
      <h2>Analysed here, in this tab</h2>
      <p>Stockfish runs in this page — the first visit downloads about 15 MB of neural
        net, once. Games lichess has already analysed bring their evaluations with them and
        skip the slow half, but every position you are shown is still searched here first,
        to work out the five best moves in it. That is what the fan on your processor is
        for, and it is meant to be doing that.</p>
    </li>
    <li>
      <h2>The moments it fell apart</h2>
      <p>Every move where your position dropped sharply becomes a puzzle, using the same
        rule lichess itself uses. The opening is left out of it rather than held against
        you.</p>
    </li>
    <li>
      <h2>Judged on merit, not on one answer</h2>
      <p>A move is right if it doesn't throw away winning chances — not if it matches one
        blessed solution. Quiet positional saves count. The move you actually played never
        does. Difficulty can narrow that to the engine's top five or top two, and once a
        position is solved its whole ranking goes on the board as numbered arrows. What
        those are worth is written up in the <a
        href="https://github.com/Gamah/lichess-blindspot#difficulty-and-the-arrows"
        target="_blank" rel="noopener">readme</a>.</p>
    </li>
  </ol>`;

export const fineprint = (): string => `
  <p class="fineprint"><strong>There is no server.</strong> This page is static, your games
    are fetched straight from lichess, the engine runs in this tab, and the puzzles and your
    solving history are kept in this browser and sent nowhere. Clear the site data and it is
    all gone. The source is linked below, as the licence requires.</p>`;

/**
 * The panel behind the About button.
 *
 * Same explanation as the landing page, plus the two things a person only
 * meets *after* they start solving and so cannot have read on the way in: what
 * the numbered arrows mean when a position is revealed, and why the machine is
 * working. `battery` is the phone warning, already rendered, or empty.
 */
export const aboutPanel = (battery: string): string => `
  <div class="panel-head">
    <h2>About Blindspot</h2>
    <button id="close" class="quiet">Close</button>
  </div>
  <p class="tagline">Your own blunders, with the game taken off them.</p>
  ${pitch()}
  ${steps()}

  <h2>The arrows on a solved position</h2>
  <p>When a position is done, the engine's five best moves from it go on the board, numbered
    and fading as they go down the list. <strong>Green means the move would have been
    accepted, red means it would not</strong> — five lines come back whether or not five
    moves are sound, so ranks three to five are often just the least bad remaining, and one
    of them may well be the move that lost the game. The move you found is drawn at full
    strength, and the move actually played stays red on top of everything.</p>
  <p>The numbers are the ranking; the colour is only whether the move beats what was played.
    That is deliberate: the reveal looks the same on every difficulty, so a move does not
    change colour because of a setting.</p>

  <h2>Why this works the processor</h2>
  <p>Every position is searched before anyone is shown it — a quick pass over the whole game
    to find where the evaluation moved, a slower pair of searches to confirm it, and a couple
    of seconds to rank the alternatives. A long history is therefore tens of minutes of
    background work the first time through, and that is what the app <em>is</em> rather than
    something going wrong. Solving itself costs nothing: the ranking was worked out in
    advance, which is also why the same move always gets the same answer.</p>
  <p>Settings can spend less — fewer positions from each game, less thinking time, fewer
    processor cores — and on a phone that is worth doing.</p>
  ${battery}

  <h2>Where things are kept</h2>
  <p>In this browser, under the username you typed, and nowhere else. A stored game carries
    the analysis of it, which is minutes of engine time that cannot be downloaded back, so
    nothing is ever deleted automatically — Settings has the buttons for when you want the
    room back. Your solve history is tiny and survives either way.</p>

  ${fineprint()}
  <p class="line">Blindspot is free software, AGPL-3.0-or-later, and ports parts of
    <a href="https://github.com/lichess-org/lila" target="_blank" rel="noopener">lila</a> —
    lichess' own code — to decide what counts as a mistake and what counts as finding the
    move. <a href="https://github.com/Gamah/lichess-blindspot" target="_blank"
    rel="noopener">Source</a>.</p>`;
