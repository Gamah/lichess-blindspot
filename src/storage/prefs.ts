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
}

export const DEFAULT_SETTINGS: Settings = { maxPerGame: 3, threads: 0 };

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
