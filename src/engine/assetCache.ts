// The neural net is 15 MB and never changes for a given filename, so it goes
// in its own IndexedDB store keyed by that filename. Separate from the
// per-username game stores: it is shared, and it is the one thing here that is
// always safe to evict — losing it costs a re-download, nothing else.

import { createStore, get, set } from 'idb-keyval';

const store = createStore('blindspot-assets', 'files');

export async function cachedFile(
  url: string,
  key: string,
  onProgress: (fraction: number) => void = () => {},
): Promise<Uint8Array> {
  const hit = await get<Uint8Array>(key, store).catch(() => undefined);
  if (hit) return hit;

  const bytes = await download(url, onProgress);
  // A failed write (quota, private mode) must not stop the engine starting.
  await set(key, bytes, store).catch(e => console.warn('could not cache', key, e));
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
