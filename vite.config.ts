import { defineConfig } from 'vite';

// COOP/COEP in dev too, so `crossOriginIsolated` matches production and the
// multithreaded Stockfish build is the one we actually develop against.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// GitHub Pages serves this from /<repo>/, and the engine and the service
// worker are both loaded by URL rather than by import, so the base has to be
// real rather than assumed. BASE=/ for a Cloudflare Pages or local build.
const base = process.env.BASE ?? '/lichess-blindspot/';

export default defineConfig({
  base,
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
