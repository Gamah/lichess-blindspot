// One IndexedDB database per username, so switching profiles can never mix two
// people's decks and deleting one is a single line.
//
// What lives where matters: raw game payloads are re-fetchable from lichess and
// may be purged under pressure; puzzles and solve history are derived from
// analysis we paid for in engine time, and are not re-derivable cheaply. Only
// the first is ever evicted. See CLAUDE.md.

import { clear, createStore, del, delMany, entries, get, set, setMany, type UseStore } from 'idb-keyval';

import type { Puzzle } from '../deck/build.ts';
import type { ExportedGame } from '../lichess/export.ts';

const GAME = 'game:';
const PUZZLE = 'puzzle:';
const SOLVE = 'solve:';
const META = 'meta';

export interface SolveRecord {
  puzzleId: string;
  at: number;
  /** 'win' found it, 'view' gave up and looked. */
  result: 'win' | 'view';
  attempts: number;
}

export interface Meta {
  /** Paging cursor: the `until` to pass for the next, older batch. */
  until?: number;
  /** Games whose analysis has been done, engine or lichess, and turned into puzzles. */
  analysed: string[];
  /** Games we looked at and found nothing in — so we don't re-analyse them. */
  fetched: string[];
}

const EMPTY_META: Meta = { analysed: [], fetched: [] };

/** Usernames are case-insensitive on lichess; the store name must be too. */
export const dbName = (username: string): string => `blindspot:${username.toLowerCase()}`;

export class Profile {
  readonly username: string;
  private store: UseStore;

  constructor(username: string) {
    this.username = username;
    this.store = createStore(dbName(username), 'kv');
  }

  meta = async (): Promise<Meta> => ({ ...EMPTY_META, ...((await get<Meta>(META, this.store)) ?? {}) });
  setMeta = (meta: Meta): Promise<void> => set(META, meta, this.store);

  game = (id: string): Promise<ExportedGame | undefined> => get(GAME + id, this.store);
  putGame = (game: ExportedGame): Promise<void> => set(GAME + game.id, game, this.store);

  putPuzzles = (puzzles: readonly Puzzle[]): Promise<void> =>
    setMany(
      puzzles.map(p => [PUZZLE + p.id, p] as [string, Puzzle]),
      this.store,
    );

  puzzles = (): Promise<Puzzle[]> => valuesWithPrefix<Puzzle>(this.store, PUZZLE);

  solves = (): Promise<SolveRecord[]> => valuesWithPrefix<SolveRecord>(this.store, SOLVE);

  recordSolve = (record: SolveRecord): Promise<void> => set(SOLVE + record.puzzleId, record, this.store);

  /** "Bring back solved": forget the history, keep the puzzles. */
  clearSolves = async (): Promise<void> => {
    const keys = (await entries(this.store)).map(([k]) => k).filter(isPrefixed(SOLVE));
    await delMany(keys, this.store);
  };

  /** Raw payloads only. Oldest first, and never the puzzles built from them. */
  purgeGames = async (keep = 0): Promise<number> => {
    const games = (await entries<string, unknown>(this.store))
      .filter(([k]) => isPrefixed(GAME)(k))
      .map(([k, v]) => [k, v as ExportedGame] as const)
      .sort((a, b) => (b[1].createdAt ?? 0) - (a[1].createdAt ?? 0));
    const drop = games.slice(keep).map(([k]) => k);
    await delMany(drop, this.store);
    return drop.length;
  };

  forgetGame = (id: string): Promise<void> => del(GAME + id, this.store);

  /** Everything for this username. Used by the storage panel, nothing else. */
  wipe = (): Promise<void> => clear(this.store);
}

const isPrefixed =
  (prefix: string) =>
  (key: IDBValidKey): key is string =>
    typeof key === 'string' && key.startsWith(prefix);

async function valuesWithPrefix<T>(store: UseStore, prefix: string): Promise<T[]> {
  const all = await entries<IDBValidKey, T>(store);
  return all.filter(([k]) => isPrefixed(prefix)(k)).map(([, v]) => v);
}

/**
 * Ask once for persistent storage. Without it the browser will evict this
 * database under disk pressure, taking solve history with it.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist().catch(() => false);
}

export interface StorageEstimate {
  usage: number;
  quota: number;
}

/**
 * Raw game payloads are the only thing here worth evicting: lichess will hand
 * them back. Runs after a batch, so a long session doesn't quietly fill the
 * quota and get the whole database dropped instead.
 */
export async function purgeIfTight(profile: Profile, threshold = 0.8, keep = 20): Promise<number> {
  const estimate = await storageEstimate();
  if (!estimate || !estimate.quota) return 0;
  if (estimate.usage / estimate.quota < threshold) return 0;
  return profile.purgeGames(keep);
}

export async function storageEstimate(): Promise<StorageEstimate | undefined> {
  if (!navigator.storage?.estimate) return undefined;
  const { usage, quota } = await navigator.storage.estimate();
  return usage === undefined || quota === undefined ? undefined : { usage, quota };
}
