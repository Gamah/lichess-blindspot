// Booting @lichess-org/stockfish-web in the browser, shaped after lila's
// ui/lib/src/ceval/engines/stockfishWebEngine.ts (read 2026-08-14).
//
// We use the sf_18_smallnet build: one 15 MB net rather than the 108 MB one,
// which is the difference between a first visit that works and one that
// doesn't. minMem 1536 pages is lila's figure for that same build.
//
// The engine .js spawns its pthreads by re-importing itself, so it has to be a
// real file at a stable URL — not something a bundler inlined. `npm run
// prepare-engine` copies it and the .wasm into public/engine/, and we load it
// with a dynamic import vite is told to leave alone.

import type StockfishWeb from '@lichess-org/stockfish-web';

import { fenTurn, parseBestmove, parseInfo, type EngineLine, type Request } from './protocol.ts';
import { cachedFile } from './assetCache.ts';

const ENGINE_PATH = `${import.meta.env.BASE_URL}engine/`;
const ENGINE_JS = 'sf_18_smallnet.js';
const MIN_MEM_PAGES = 1536;
/** Lichess' own asset host: CORS-open and `Cross-Origin-Resource-Policy:
 *  cross-origin`, so it is fetchable under our COEP require-corp. Verified by
 *  request 2026-08-14. [SOURCE] — headers are not a documented contract. */
const NNUE_BASE = 'https://lichess1.org/assets/lifat/nnue/';

export interface BootProgress {
  /** 0..1 while the net downloads, undefined once it is in hand. */
  download?: number;
  message: string;
}

/** Lila's sharedWasmMemory: ask for the maximum, back off until one allocates. */
function sharedWasmMemory(lo: number, hi = 32767): WebAssembly.Memory {
  let shrink = 4;
  for (;;) {
    try {
      return new WebAssembly.Memory({ shared: true, initial: lo, maximum: hi });
    } catch (e) {
      if (hi <= lo || !(e instanceof RangeError)) throw e;
      hi = Math.max(lo, Math.ceil(hi - hi / shrink));
      shrink = shrink === 4 ? 3 : 4;
    }
  }
}

export class EngineUnavailable extends Error {}

export class Engine {
  private module!: StockfishWeb;
  private queue: Promise<unknown> = Promise.resolve();
  private best: EngineLine | undefined;
  private turn: 'white' | 'black' = 'white';
  private onLine: ((line: string) => void) | undefined;
  private dead = false;

  static async boot(onProgress: (p: BootProgress) => void = () => {}): Promise<Engine> {
    if (!crossOriginIsolated)
      throw new EngineUnavailable(
        'This page is not cross-origin isolated, so the multithreaded engine cannot start.',
      );

    const engine = new Engine();
    onProgress({ message: 'Starting engine' });

    const scriptUrl = new URL(ENGINE_PATH + ENGINE_JS, location.href).href;
    const factory = await import(/* @vite-ignore */ scriptUrl);
    const module: StockfishWeb = await factory.default({
      wasmMemory: sharedWasmMemory(MIN_MEM_PAGES),
      locateFile: (file: string) => new URL(ENGINE_PATH + file, location.href).href,
      mainScriptUrlOrBlob: scriptUrl,
    });

    // The build reports which net it wants rather than us hardcoding a name
    // that goes stale on the next engine bump.
    const nets: string[] = [];
    for (let i = 0; ; i++) {
      const name = module.getRecommendedNnue(i);
      if (!name) break;
      nets.push(name);
    }
    await Promise.all(
      nets.map(async (name, index) => {
        const bytes = await cachedFile(NNUE_BASE + name, name, fraction =>
          onProgress({ download: fraction, message: `Downloading neural net` }),
        );
        module.setNnueBuffer(bytes, index);
      }),
    );

    module.onError = (msg: string) => console.warn('stockfish:', msg);
    module.listen = (line: string) => engine.receive(line);
    engine.module = module;

    await engine.handshake();
    onProgress({ message: 'Engine ready' });
    return engine;
  }

  private receive(line: string): void {
    this.onLine?.(line);
  }

  private send(cmd: string): void {
    if (!this.dead) this.module.uci(cmd);
  }

  /** Wait for the engine to answer `isready`, and set our options while we're here. */
  private handshake(): Promise<void> {
    const threads = Math.max(1, Math.min(navigator.hardwareConcurrency - 1, 8));
    return this.exchange(
      () => {
        this.send('uci');
        this.send(`setoption name Threads value ${threads}`);
        this.send('setoption name Hash value 128');
        this.send('setoption name MultiPV value 1');
        this.send('setoption name UCI_ShowWDL value false');
        this.send('ucinewgame');
        this.send('isready');
      },
      (line, done) => {
        if (line === 'readyok') done(undefined);
      },
    );
  }

  /**
   * Analyse one position. Serialised: the engine is a single search, so
   * requests queue rather than interleave.
   */
  analyse(req: Request): Promise<EngineLine> {
    const run = () => this.runAnalyse(req);
    const result = this.queue.then(run, run);
    // Keep the chain alive even when one request rejects.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private runAnalyse(req: Request): Promise<EngineLine> {
    if (this.dead) return Promise.reject(new EngineUnavailable('Engine stopped'));
    this.turn = fenTurn(req.fen);
    this.best = undefined;
    const limit = req.movetime !== undefined ? `movetime ${req.movetime}` : `depth ${req.depth ?? 12}`;
    return this.exchange(
      () => {
        this.send(`position fen ${req.fen}`);
        this.send(`go ${limit}`);
      },
      (line, done, fail) => {
        const info = parseInfo(line, this.turn);
        // Keep the deepest line that carried a pv: the very last info before
        // bestmove is sometimes a bare `info depth N` with no score.
        if (info && (!this.best || info.depth >= this.best.depth)) this.best = info;
        if (!line.startsWith('bestmove')) return;
        const best = this.best;
        if (!best) return fail(new Error(`No evaluation for ${req.fen}`));
        const bestmove = parseBestmove(line);
        // Trust bestmove over the last pv we saw; they agree except at the
        // moment the search is cut off mid-line.
        done(bestmove && best.pv[0] !== bestmove ? { ...best, pv: [bestmove] } : best);
      },
    );
  }

  private exchange<T>(
    start: () => void,
    handle: (line: string, done: (value: T) => void, fail: (e: Error) => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.onLine = line => {
        handle(
          line,
          value => {
            this.onLine = undefined;
            resolve(value);
          },
          e => {
            this.onLine = undefined;
            reject(e);
          },
        );
      };
      start();
    });
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.module?.uci('quit');
  }
}
