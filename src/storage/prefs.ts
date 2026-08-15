// localStorage, and only for things small enough that losing them costs
// nothing. It is a separate ~5 MiB box, not a slice of the IndexedDB quota, so
// nothing here competes with the deck for space.

const RECENT = 'blindspot.recent';
const SETTINGS = 'blindspot.settings';
const MAX_RECENT = 8;

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode, or a full box. Not worth telling anyone about.
  }
};

/** Most recently used first; the head of this is the name we open with. */
export const recentUsernames = (): string[] => read<string[]>(RECENT, []);

export const rememberUsername = (username: string): void => {
  const name = username.trim();
  if (!name) return;
  const rest = recentUsernames().filter(u => u.toLowerCase() !== name.toLowerCase());
  write(RECENT, [name, ...rest].slice(0, MAX_RECENT));
};

export const forgetUsername = (username: string): void =>
  write(
    RECENT,
    recentUsernames().filter(u => u.toLowerCase() !== username.toLowerCase()),
  );

import { RANK_MOVETIME } from '../engine/analyse.ts';
import { isDifficulty, type Difficulty } from '../solve/retro.ts';

export interface Settings {
  /**
   * How strict the verdict on a move you invented is. Absent means never
   * chosen — which is how someone who was here before the setting existed is
   * told about it, so don't give it a value in `DEFAULT_SETTINGS`.
   */
  difficulty?: Difficulty;
  /**
   * Take at most this many positions from any one game; 0 for every one it
   * finds. This is the analysis budget dial as much as a taste dial: the sweep
   * that locates mistakes is cheap, but each one accepted costs a pair of
   * second-long searches, and a deck does not want ten positions out of the
   * same game anyway.
   */
  maxPerGame: number;
  /**
   * Engine threads, or 0 to decide from `hardwareConcurrency`. More is faster
   * until it isn't, and on a phone it is also the difference between a warm
   * device and an unusable one.
   */
  threads: number;
  /**
   * Stop keeping games once this many are stored; 0 for no limit.
   *
   * A **limit, not a budget**: reaching it stops new games being fetched, it
   * does not start deleting old ones. That asymmetry is the whole point — a
   * stored game carries the analysis and the ranking done on it, which is
   * minutes of engine time and cannot be re-fetched, so nothing here throws
   * one away on its own initiative. Purge in Settings is the manual answer,
   * and it says what it takes with it.
   *
   * Counted in games rather than megabytes because it can be enforced exactly
   * and works in a browser that will not report a quota at all; Settings shows
   * the live figure in MB next to it so the two can be related.
   */
  maxGames: number;
  /**
   * How long the engine gets on **one position it is preparing** — the ranking
   * search, and nothing else. Milliseconds, like lichess mobile's engine
   * setting.
   *
   * Explicitly *not* the sweep that hunts for blunders: that is a fixed shallow
   * pass over every ply of every game and is the wrong thing to spend on. Nor
   * the pair of searches that confirm a swing, which decide *whether* a
   * position is a puzzle at all — a slider there would silently change which
   * mistakes the deck contains rather than how well they are understood.
   *
   * `altsMs` records what each position was actually given, so raising this
   * re-ranks the positions done under the old value and lowering it leaves
   * better work alone.
   */
  rankMs: number;
  /**
   * How far back into the history to reach, in days; 0 for all of it.
   *
   * A *floor on fetching*, not on keeping: it is passed to the export as
   * `since`, so the backwards paging stops at that date instead of at the first
   * game someone ever played. Nothing already stored is affected — lowering it
   * does not delete the older games it would no longer fetch, for the same
   * reason `maxGames` doesn't.
   *
   * It is deliberately a date rather than a count, because the count is
   * `maxGames` and two dials in the same units would be two answers to one
   * question. "The last month" and "the last hundred games" are different
   * things to want, and now each has the dial that says it.
   */
  historyDays: number;
  /**
   * How many games one export asks for. Not a rate: lichess is asked at most
   * once every `EXPORT_GAP`, whatever this is, so a bigger batch means fewer
   * requests reaching further per request — and a longer wait before the first
   * of them is analysed, because they arrive together and the engine works
   * through them one at a time.
   */
  batchSize: number;
}

/** Roughly what one stored game costs, for turning a count into a size. */
export const BYTES_PER_GAME = 5_000;

/**
 * A phone's quota is smaller and its eviction is more eager, and it is also
 * the device where an unbounded history hurts most. So a first visit on one
 * starts bounded and can be raised, rather than starting unbounded and being
 * discovered.
 */
export const MOBILE_GAME_LIMIT = 150;

export const DEFAULT_SETTINGS: Settings = {
  maxPerGame: 3,
  threads: 0,
  maxGames: 0,
  rankMs: RANK_MOVETIME,
  // Both defaults are what the app did before either dial existed: reach back
  // for as long as there are games, twenty at a time.
  historyDays: 0,
  batchSize: 20,
};

/**
 * The oldest `createdAt` worth fetching, or undefined for "all of it".
 *
 * `now` is a parameter for the same reason it is one in `deckStats`: a floor
 * derived from the clock is untestable otherwise.
 */
export const historyFloor = (now: number = Date.now()): number | undefined => {
  const days = settings().historyDays;
  return days > 0 ? now - days * 24 * 60 * 60 * 1000 : undefined;
};

export const settings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  ...read<Partial<Settings>>(SETTINGS, {}),
});

/**
 * The setting in force, with the default applied. Easy is the default because
 * it is what the app did before there was a choice: a returning player who
 * dismisses the notice without touching anything gets exactly what they had.
 */
export const difficulty = (): Difficulty => {
  const chosen = settings().difficulty;
  return isDifficulty(chosen) ? chosen : 'easy';
};

/** False for anyone who has never been asked — see `Settings.difficulty`. */
export const difficultyChosen = (): boolean => isDifficulty(settings().difficulty);

export const saveSettings = (patch: Partial<Settings>): Settings => {
  const next = { ...settings(), ...patch };
  write(SETTINGS, next);
  return next;
};

/**
 * Everything this module keeps, gone: recent usernames and settings both. Used
 * by the schema reset, which starts the browser over rather than reasoning
 * about which of yesterday's records are still meaningful.
 */
export const forgetPrefs = (): void => {
  for (const key of [RECENT, SETTINGS]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // A browser that refuses storage has nothing to forget.
    }
  }
};
