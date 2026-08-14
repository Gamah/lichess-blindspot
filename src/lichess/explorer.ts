// The masters opening explorer, used the way lila's retro uses it: a move that
// masters have played is not a blunder to be shown to someone, whatever the
// engine says about it.
//
// CORS-open and unauthenticated. Answers are cached per position for the life
// of the page — an opening position is asked about once per game we analyse,
// and there are not many distinct ones.

const BASE = 'https://explorer.lichess.ovh/masters';

interface ExplorerMove {
  uci: string;
  white: number;
  draws: number;
  black: number;
}

/**
 * The moves played from this position, filtered as retroCtrl filters them:
 * `m.white + m.draws + m.black > 1`, i.e. more than one master game. One game
 * is an anecdote.
 */
export async function mastersUcis(fen: string, signal?: AbortSignal): Promise<string[]> {
  const url = new URL(BASE);
  url.searchParams.set('fen', fen);
  url.searchParams.set('topGames', '0');
  url.searchParams.set('moves', '20');
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`masters explorer returned ${res.status}`);
  const data = (await res.json()) as { moves?: ExplorerMove[] };
  return (data.moves ?? []).filter(m => m.white + m.draws + m.black > 1).map(m => m.uci);
}

/** Counters, so a browser can see whether any of this actually happened. */
export interface BookStats {
  /** Positions asked about (a cache hit is not a lookup). */
  lookups: number;
  /** Lookups the explorer answered. */
  answered: number;
  /** Lookups it refused or could not be reached for. */
  failed: number;
  lastError?: string;
}

export class OpeningBook {
  private readonly cache = new Map<string, Promise<string[] | undefined>>();
  private readonly fetcher: (fen: string) => Promise<string[]>;
  readonly stats: BookStats = { lookups: 0, answered: 0, failed: 0 };

  constructor(fetcher: (fen: string) => Promise<string[]> = fen => mastersUcis(fen)) {
    this.fetcher = fetcher;
  }

  /** The book moves here, or undefined if the explorer would not say. */
  ucis(fen: string): Promise<string[] | undefined> {
    const hit = this.cache.get(fen);
    if (hit) return hit;
    // A failure is cached as well as a hit: retrying once per candidate would
    // turn one explorer outage into a burst of requests.
    this.stats.lookups++;
    const pending = this.fetcher(fen).then(
      ucis => {
        this.stats.answered++;
        return ucis;
      },
      (e: Error) => {
        this.stats.failed++;
        this.stats.lastError = String(e.message ?? e);
        return undefined;
      },
    );
    this.cache.set(fen, pending);
    return pending;
  }

  /**
   * True when this move is book — and true as well when the explorer cannot be
   * reached, which is deliberate. Not knowing means falling back to "leave the
   * opening alone", which is what this app did before it asked at all; the
   * other way round, an outage would fill the deck with book moves presented
   * as blunders.
   */
  async contains(fen: string, uci: string): Promise<boolean> {
    const ucis = await this.ucis(fen);
    return ucis === undefined || ucis.includes(uci);
  }
}
