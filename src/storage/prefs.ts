// localStorage, and only for things small enough that losing them costs
// nothing. It is a separate ~5 MiB box, not a slice of the IndexedDB quota, so
// nothing here competes with the deck for space.

const RECENT = 'blindspot.recent';
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
