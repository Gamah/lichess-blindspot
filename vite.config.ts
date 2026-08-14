import { defineConfig } from 'vite';

// COOP/COEP in dev too, so `crossOriginIsolated` matches production and the
// multithreaded Stockfish build is the one we actually develop against.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
});
