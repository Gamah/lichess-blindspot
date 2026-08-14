// Copies the Stockfish build out of node_modules and into public/engine/.
//
// It can't just be imported: the .js spawns its pthread workers by re-importing
// its own URL and finds its .wasm relative to that URL, so both have to sit at
// a stable path a bundler hasn't touched. public/ is that path.
//
// Run by `npm run dev` and `npm run build`; the output is gitignored, so a
// fresh clone or a CI runner regenerates it.

import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', '@lichess-org', 'stockfish-web');
const to = join(root, 'public', 'engine');

// Only the smallnet build. The full net is 108 MB of download for a first
// visit, which is not a trade this app can make; see src/engine/stockfish.ts.
const WANTED = ['sf_18_smallnet.js', 'sf_18_smallnet.wasm', 'LICENSE'];

await mkdir(to, { recursive: true });
const available = new Set(await readdir(from));
for (const name of WANTED) {
  if (!available.has(name)) throw new Error(`${name} is missing from @lichess-org/stockfish-web`);
  await copyFile(join(from, name), join(to, name));
}
console.log(`engine: copied ${WANTED.length} files to public/engine/`);
