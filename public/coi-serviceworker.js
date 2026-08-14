// Re-serves this origin's own responses with COOP/COEP, because GitHub Pages
// has no way to set a response header and SharedArrayBuffer needs both.
//
// It caches nothing and rewrites nothing else. Cross-origin requests — the
// lichess API, the neural net — are left entirely alone: they already carry
// the CORS and CORP headers that satisfy require-corp, and wrapping an opaque
// response here would break them.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.mode === 'no-cors') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.status === 0) return response; // opaque; nothing to rewrite
        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      .catch(e => {
        console.error('coi-serviceworker:', e);
        throw e;
      }),
  );
});
