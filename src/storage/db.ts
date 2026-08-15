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
//   hide:<id>   positions put aside, same key. A position is derived from its
//               game every time the deck is built, so there is nothing to
//               delete — the only way to stop one coming round is to write
//               down that it should not. Restoring is deleting that note.
//
// Plus `meta`, the paging cursor, and `schema`, the version stamp.
//
// Puzzles are not stored at all: they are derived from a game whenever they are
// wanted (see deck/derive.ts). So a game with our analysis in it is no longer
// "re-fetchable" and is never evicted automatically — deleting it deletes the
// engine time that produced it, and the positions with it. See CLAUDE.md.

import { clear, createStore, del, delMany, entries, get, set, type UseStore } from 'idb-keyval';

import type { ExportedGame } from '../lichess/export.ts';

const GAME = 'game:';
const SOLVE = 'solve:';
const HIDE = 'hide:';
const META = 'meta';
const SCHEMA = 'schema';

/**
 * Bumped when a store written by an older version can no longer be read as it
 * stands. There is no migration path and deliberately so — see `stale()`.
 *
 * 2: puzzles stopped being stored. A store from version 1 holds `puzzle:`
 *    records nothing reads, and — worse — games our engine analysed whose
 *    evals were thrown away, listed in `meta.analysed` so they would never be
 *    looked at again. Neither is repairable from what is there.
 */
export const SCHEMA_VERSION = 2;

export interface SolveRecord {
  puzzleId: string;
  at: number;
  /** 'win' found it, 'view' gave up and looked. */
  result: 'win' | 'view';
  attempts: number;
  /**
   * A hint was asked for. Optional, and absent on every record written before
   * the button existed — which needs no schema bump, because a missing field
   * reads as "no hint" and that is exactly what it was.
   */
  hinted?: boolean;
}

export interface HideRecord {
  puzzleId: string;
  at: number;
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
   * True when this store was written by a version whose records we can no
   * longer make sense of. An empty store is not stale — there is nothing to be
   * wrong — and neither is one already stamped with the current version.
   */
  stale = (): Promise<boolean> =>
    this.use(async store => {
      const version = await get<number>(SCHEMA, store);
      if (version === SCHEMA_VERSION) return false;
      const keys = (await entries(store)).map(([k]) => k);
      return keys.some(isPrefixed(GAME)) || keys.some(k => k === META);
    }, false);

  /**
   * True when this store already holds games — someone who has been here
   * before. The same shape of question as `stale()`, and asked for the same
   * reason: a change only has to be announced to the people it changes
   * something for. A first visit is told nothing and gets the defaults.
   */
  hasGames = (): Promise<boolean> =>
    this.use(async store => (await entries(store)).some(([k]) => isPrefixed(GAME)(k)), false);

  /** How many games are held, for the storage limit to be measured against. */
  gameCount = (): Promise<number> =>
    this.use(async store => (await entries(store)).filter(([k]) => isPrefixed(GAME)(k)).length, 0);

  /**
   * Everything for this username, gone, and the current version stamped on the
   * empty store.
   *
   * Solve history could in principle be carried across — a `solve:` key is
   * `gameId:ply`, which is what a position *is* rather than what a record of it
   * looked like. It isn't, deliberately. Keeping one table across a break means
   * every future version has to reason about a store that is half old and half
   * new, and the deck this version builds from re-fetched games is not the deck
   * those solves were taken against. Cheaper to be honest once.
   */
  reset = (): Promise<void> =>
    this.use(async store => {
      await clear(store);
      await set(SCHEMA, SCHEMA_VERSION, store);
    }, undefined);

  /** Stamp a store we have not had to reset, so it is never asked about again. */
  stamp = (): Promise<void> => this.use(store => set(SCHEMA, SCHEMA_VERSION, store), undefined);

  solves = (): Promise<SolveRecord[]> => this.use(store => valuesWithPrefix<SolveRecord>(store, SOLVE), []);

  recordSolve = (record: SolveRecord): Promise<void> =>
    this.use(store => set(SOLVE + record.puzzleId, record, store), undefined);

  /**
   * Positions put aside. Kept as their own records rather than as a flag on
   * anything, because there is nothing durable to flag: a puzzle is derived
   * from its game on every deck build, so "hidden" has to be a note *about* an
   * id that outlives every derivation.
   */
  hidden = (): Promise<HideRecord[]> =>
    this.use(store => valuesWithPrefix<HideRecord>(store, HIDE), []);

  hide = (puzzleId: string, at: number): Promise<void> =>
    this.use(store => set(HIDE + puzzleId, { puzzleId, at }, store), undefined);

  restore = (puzzleId: string): Promise<void> =>
    this.use(store => del(HIDE + puzzleId, store), undefined);

  /** One solve record, for a card whose position no longer exists to show. */
  forgetSolve = (puzzleId: string): Promise<void> =>
    this.use(store => del(SOLVE + puzzleId, store), undefined);

  /** "Bring back solved": forget the history, keep the puzzles. */
  clearSolves = (): Promise<void> =>
    this.use(async store => {
      const keys = (await entries(store)).map(([k]) => k).filter(isPrefixed(SOLVE));
      await delMany(keys, store);
    }, undefined);

  /**
   * Drop stored games, newest `keep` kept — and with them their analysis, every
   * position derived from it, **and the record of having solved those
   * positions**. Manual only: nothing here is cheap enough to throw away on our
   * own initiative any more.
   *
   * The solve records used to survive a purge, on the grounds that they are
   * tiny and that `gameId:ply` is what a position *is*. That was wrong to leave
   * as the default: deleting a game deletes the position, so what is left is a
   * record of solving something that no longer exists — it cannot be shown in
   * the deck panel, cannot be replayed, and silently inflates "bring back
   * solved" with positions that will never come back. Purging is asked for in
   * order to make room and be rid of something; leaving half of it behind is
   * not what the button says.
   */
  purgeGames = (keep = 0): Promise<PurgeResult> =>
    this.use(async store => {
      const all = await entries<string, unknown>(store);
      const games = all
        .filter(([k]) => isPrefixed(GAME)(k))
        .map(([k, v]) => [k as string, v as ExportedGame] as const)
        .sort((a, b) => (b[1].createdAt ?? 0) - (a[1].createdAt ?? 0));
      const drop = games.slice(keep);
      const ids = new Set(drop.map(([, g]) => g.id));
      const solves = keysFor(all, SOLVE, ids);
      const hides = keysFor(all, HIDE, ids);
      await delMany([...drop.map(([k]) => k), ...solves, ...hides], store);
      return { games: drop.length, solves: solves.length };
    }, EMPTY_PURGE);

  /**
   * One game, and every note about a position in it — solved, hidden, both.
   * Same rule as a purge, and the only true delete there is: a position is
   * derived from its game, so nothing short of dropping the game removes it.
   */
  forgetGame = (id: string): Promise<void> =>
    this.use(async store => {
      const all = await entries<string, unknown>(store);
      const ids = new Set([id]);
      await delMany([GAME + id, ...keysFor(all, SOLVE, ids), ...keysFor(all, HIDE, ids)], store);
    }, undefined);

  /** Everything for this username. Used by the settings panel, nothing else. */
  wipe = (): Promise<void> => this.use(store => clear(store), undefined);
}

export interface PurgeResult {
  games: number;
  solves: number;
}

const EMPTY_PURGE: PurgeResult = { games: 0, solves: 0 };

/**
 * The keys under `prefix` that belong to any of `gameIds`.
 *
 * Both per-position prefixes key on a puzzle id, `<gameId>:<ply>`, and a
 * lichess game id carries no colon, so the last one separates the ply. Matched
 * that way rather than by `startsWith(prefix + id)`, which would also catch a
 * different game whose id merely began with this one's.
 */
function keysFor(
  all: readonly (readonly [IDBValidKey, unknown])[],
  prefix: string,
  gameIds: Set<string>,
): string[] {
  return all
    .map(([k]) => k)
    .filter(isPrefixed(prefix))
    .filter(k => gameIds.has(k.slice(prefix.length, k.lastIndexOf(':'))));
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
 * There used to be a `purgeIfTight` here that shed the oldest game payloads
 * once the quota got tight. It could, because a payload was a download away.
 * A stored game now carries the analysis of it and the positions derived from
 * that, so there is nothing left cheap enough to discard behind someone's
 * back — and quietly spending an evening of engine time is a worse outcome
 * than a full disk.
 *
 * So we say so instead, and let them choose what goes. Undefined while there
 * is room, or the browser will not say.
 */
export async function storagePressure(threshold = 0.8): Promise<string | undefined> {
  const estimate = await storageEstimate();
  if (!estimate?.quota) return undefined;
  if (estimate.usage / estimate.quota < threshold) return undefined;
  return (
    `Storage is nearly full — ${mb(estimate.usage)} of ${mb(estimate.quota)}. ` +
    'Nothing is deleted automatically, but if the browser runs out it may drop all of it. ' +
    'Settings can delete older games — which takes their positions, and your record of solving them, with them.'
  );
}

export const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

export async function storageEstimate(): Promise<StorageEstimate | undefined> {
  if (!navigator.storage?.estimate) return undefined;
  const { usage, quota } = await navigator.storage.estimate();
  return usage === undefined || quota === undefined ? undefined : { usage, quota };
}
