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

  solvedCount(): number {
    return this.solved.size;
  }
}
