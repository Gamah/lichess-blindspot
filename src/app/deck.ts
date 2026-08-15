// What to serve next. Solved puzzles leave the shuffle but stay in the store,
// so "solved" is a property of the deck, not a deletion.

import { shuffleDeck, type Puzzle, type Rng } from '../deck/build.ts';

export class Deck {
  private pending: Puzzle[] = [];
  private served: Puzzle | undefined;
  private readonly known = new Set<string>();
  private readonly solved = new Set<string>();

  private readonly rng: Rng;

  constructor(rng: Rng = Math.random) {
    this.rng = rng;
  }

  /** Ignores puzzles it has already seen, so re-analysis can't duplicate them. */
  add(puzzles: readonly Puzzle[]): number {
    const fresh = puzzles.filter(p => !this.known.has(p.id) && !this.solved.has(p.id));
    for (const p of fresh) this.known.add(p.id);
    if (!fresh.length) return 0;
    // Reshuffle the whole remainder rather than appending: a batch tacked on
    // the end would serve one game's puzzles back to back at the join.
    this.pending = shuffleDeck([...this.pending, ...fresh], this.rng);
    return fresh.length;
  }

  markSolved(ids: Iterable<string>): void {
    for (const id of ids) {
      this.solved.add(id);
      this.known.add(id);
    }
    this.pending = this.pending.filter(p => !this.solved.has(p.id));
  }

  next(): Puzzle | undefined {
    this.served = this.pending.shift();
    return this.served;
  }

  current(): Puzzle | undefined {
    return this.served;
  }

  /**
   * Take over a puzzle that is already on screen — for a deck rebuilt while
   * someone is looking at one.
   *
   * The rebuild is not rare: every Settings dial that shapes the deck runs it,
   * and a puzzle is a view over a stored game, so the *same* position comes out
   * of the new build sitting in `pending` with nothing recording that it is
   * currently being solved. Skip would then push a duplicate (`requeue` catches
   * that one), and Next could serve the position that is already on the board.
   * Telling the new deck what the old one was serving is the fix: it leaves
   * `pending` and counts as known, exactly as if `next()` had dealt it.
   */
  serve(puzzle: Puzzle): void {
    this.served = puzzle;
    this.known.add(puzzle.id);
    this.pending = this.pending.filter(p => p.id !== puzzle.id);
  }

  /**
   * Put one back, unsolved — for "skip", which is not "solved". Ignores a
   * puzzle that is already waiting: the deck can be rebuilt from storage while
   * one is on screen, and that copy would otherwise be skipped into a duplicate.
   */
  requeue(puzzle: Puzzle): void {
    if (this.pending.some(p => p.id === puzzle.id) || this.solved.has(puzzle.id)) return;
    this.pending.push(puzzle);
  }

  unsolvedCount(): number {
    return this.pending.length;
  }

  /** What is still waiting, in the order it will be dealt. For the deck dialog. */
  waiting(): readonly Puzzle[] {
    return this.pending;
  }

  /**
   * Deal a named position instead of the next one — "Solve this" in the deck
   * dialog. It leaves `pending` and becomes the served puzzle, exactly as
   * `next()` would have left it whenever its turn came round; undefined if it
   * is not waiting, which a stale dialog can ask for.
   */
  take(id: string): Puzzle | undefined {
    const puzzle = this.pending.find(p => p.id === id);
    if (!puzzle) return undefined;
    this.pending = this.pending.filter(p => p.id !== id);
    this.served = puzzle;
    return puzzle;
  }

  solvedCount(): number {
    return this.solved.size;
  }
}
