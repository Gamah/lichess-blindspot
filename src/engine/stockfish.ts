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

import { UciSession, type EngineLine, type Request } from './protocol.ts';
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
  private session!: UciSession;

  /**
   * How many threads to use when nobody has said. One core is left for the
   * page, and there is a ceiling because the gain flattens long before a big
   * machine's core count does.
   */
  static defaultThreads(): number {
    return Math.max(1, Math.min((navigator.hardwareConcurrency || 2) - 1, 8));
  }

  static async boot(
    onProgress: (p: BootProgress) => void = () => {},
    threads = Engine.defaultThreads(),
  ): Promise<Engine> {
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
          onProgress({ download: fraction, message: 'Downloading neural net' }),
        );
        module.setNnueBuffer(bytes, index);
      }),
    );

    module.onError = (msg: string) => console.warn('stockfish:', msg);
    engine.session = new UciSession(cmd => module.uci(cmd));
    module.listen = (line: string) => engine.session.receive(line);

    await engine.session.handshake({ threads, hashMb: 128 });
    onProgress({ message: 'Engine ready' });
    return engine;
  }

  analyse(req: Request): Promise<EngineLine> {
    return this.session.analyse(req);
  }

  /** Applies to the next search; no restart, no re-download. */
  setThreads(threads: number): Promise<void> {
    return this.session.setOption('Threads', threads);
  }

  destroy(): void {
    this.session?.close();
  }
}
