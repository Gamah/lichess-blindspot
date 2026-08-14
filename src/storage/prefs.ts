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

export interface Settings {
  /**
   * Take at most this many positions from any one game; 0 for every one it
   * finds. This is the analysis budget dial as much as a taste dial: the sweep
   * that locates mistakes is cheap, but each one accepted costs a pair of
   * second-long searches, and a deck does not want ten positions out of the
   * same game anyway.
   */
  maxPerGame: number;
}

export const DEFAULT_SETTINGS: Settings = { maxPerGame: 3 };

export const settings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  ...read<Partial<Settings>>(SETTINGS, {}),
});

export const saveSettings = (patch: Partial<Settings>): Settings => {
  const next = { ...settings(), ...patch };
  write(SETTINGS, next);
  return next;
};
