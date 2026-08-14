// One IndexedDB database per username, so switching profiles can never mix two
// people's decks and deleting one is a single line.
//
// Two things are stored, and the split is deliberate:
//
//   game:<id>   the game, carrying its eval array — lichess' if it analysed the
//               game, ours written back into the same field if we did. This is
//               the expensive artefact and the only durable one.
//   solve:<id>  what has been solved, keyed by `gameId:ply`, which is stable
//               whatever a puzzle happens to contain this week.
//
// Puzzles are not stored at all: they are derived from a game whenever they are
// wanted (see deck/derive.ts). So a game with our analysis in it is no longer
// "re-fetchable" and is never evicted automatically — deleting it deletes the
// engine time that produced it, and the positions with it. See CLAUDE.md.

import { clear, createStore, del, delMany, entries, get, set, type UseStore } from 'idb-keyval';

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
  /**
   * False when this browser refuses us storage — Firefox with cookies blocked
   * for the site throws `SecurityError` from `indexedDB.open`, and it throws
   * it *here*, in the constructor, because idb-keyval opens eagerly. Every
   * method below then fails soft: reads come back empty, writes do nothing,
   * and the session works for as long as the tab is open. A browser that will
   * not remember anything is a reason to lose persistence, not the app.
   */
  readonly available: boolean;
  private store: UseStore | undefined;

  constructor(username: string) {
    this.username = username;
    try {
      this.store = createStore(dbName(username), 'kv');
      this.available = true;
    } catch (e) {
      console.warn('storage unavailable:', e);
      this.available = false;
    }
  }

  /** Runs `work` against the store, or gives up quietly and returns `fallback`. */
  private async use<T>(work: (store: UseStore) => Promise<T>, fallback: T): Promise<T> {
    if (!this.store) return fallback;
    try {
      return await work(this.store);
    } catch (e) {
      console.warn('storage failed:', e);
      return fallback;
    }
  }

  meta = (): Promise<Meta> =>
    this.use(async store => ({ ...EMPTY_META, ...((await get<Meta>(META, store)) ?? {}) }), {
      ...EMPTY_META,
    });

  setMeta = (meta: Meta): Promise<void> => this.use(store => set(META, meta, store), undefined);

  game = (id: string): Promise<ExportedGame | undefined> =>
    this.use(store => get<ExportedGame>(GAME + id, store), undefined);

  putGame = (game: ExportedGame): Promise<void> =>
    this.use(store => set(GAME + game.id, game, store), undefined);

  /** Every stored game, newest first. The deck is derived from these. */
  games = (): Promise<ExportedGame[]> =>
    this.use(async store => {
      const all = await valuesWithPrefix<ExportedGame>(store, GAME);
      return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    }, []);

  /**
   * Puzzles written by the versions that persisted them, before a puzzle became
   * a view over its game. Read so nobody loses a deck to the change; nothing
   * writes these any more, and they can go once no profile has any left.
   */
  legacyPuzzles = (): Promise<Puzzle[]> => this.use(store => valuesWithPrefix<Puzzle>(store, PUZZLE), []);

  solves = (): Promise<SolveRecord[]> => this.use(store => valuesWithPrefix<SolveRecord>(store, SOLVE), []);

  recordSolve = (record: SolveRecord): Promise<void> =>
    this.use(store => set(SOLVE + record.puzzleId, record, store), undefined);

  /** "Bring back solved": forget the history, keep the puzzles. */
  clearSolves = (): Promise<void> =>
    this.use(async store => {
      const keys = (await entries(store)).map(([k]) => k).filter(isPrefixed(SOLVE));
      await delMany(keys, store);
    }, undefined);

  /**
   * Drop stored games, newest `keep` kept — and with them their analysis and
   * every position derived from it. Manual only: nothing here is cheap enough
   * to throw away on our own initiative any more.
   */
  purgeGames = (keep = 0): Promise<number> =>
    this.use(async store => {
      const games = (await entries<string, unknown>(store))
        .filter(([k]) => isPrefixed(GAME)(k))
        .map(([k, v]) => [k, v as ExportedGame] as const)
        .sort((a, b) => (b[1].createdAt ?? 0) - (a[1].createdAt ?? 0));
      const drop = games.slice(keep).map(([k]) => k);
      await delMany(drop, store);
      return drop.length;
    }, 0);

  forgetGame = (id: string): Promise<void> => this.use(store => del(GAME + id, store), undefined);

  /** Everything for this username. Used by the settings panel, nothing else. */
  wipe = (): Promise<void> => this.use(store => clear(store), undefined);
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

export async function storageEstimate(): Promise<StorageEstimate | undefined> {
  if (!navigator.storage?.estimate) return undefined;
  const { usage, quota } = await navigator.storage.estimate();
  return usage === undefined || quota === undefined ? undefined : { usage, quota };
}
