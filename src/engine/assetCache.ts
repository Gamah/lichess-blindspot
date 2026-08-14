// The neural net is 15 MB and never changes for a given filename, so it goes
// in its own IndexedDB store keyed by that filename. Separate from the
// per-username game stores: it is shared, and it is the one thing here that is
// always safe to evict — losing it costs a re-download, nothing else.

import { createStore, get, set, type UseStore } from 'idb-keyval';

/**
 * Opened on first use, never at import time. `createStore` calls
 * `indexedDB.open` eagerly, and a browser that refuses storage — Firefox with
 * cookies blocked for the site — throws from it. At module scope that throw
 * happens while the bundle is being evaluated, so nothing renders at all: no
 * board, no error, no page. Lazily, the worst case is a net that has to be
 * downloaded again next visit.
 */
let store: UseStore | undefined;
let tried = false;

function cache(): UseStore | undefined {
  if (!tried) {
    tried = true;
    try {
      store = createStore('blindspot-assets', 'files');
    } catch (e) {
      console.warn('no asset cache:', e);
    }
  }
  return store;
}

export async function cachedFile(
  url: string,
  key: string,
  onProgress: (fraction: number) => void = () => {},
): Promise<Uint8Array> {
  const store = cache();
  const hit = store ? await get<Uint8Array>(key, store).catch(() => undefined) : undefined;
  if (hit) return hit;

  const bytes = await download(url, onProgress);
  // A failed write (quota, private mode) must not stop the engine starting.
  if (store) await set(key, bytes, store).catch(e => console.warn('could not cache', key, e));
  return bytes;
}

async function download(url: string, onProgress: (fraction: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  // lichess1.org serves this chunked, with no content-length, so the progress
  // bar has to guess. 15 MB is the smallnet's size; being wrong only makes the
  // bar lie a little.
  const total = Number(res.headers.get('content-length')) || 15_054_352;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(1, received / total));
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
