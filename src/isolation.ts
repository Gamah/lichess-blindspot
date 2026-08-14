// GitHub Pages cannot set response headers, and SharedArrayBuffer needs
// COOP/COEP, so the headers have to come from a service worker that re-serves
// the page carrying them. The consequence, which the rest of the app is built
// to tolerate: `crossOriginIsolated` is false on a visitor's very first load
// and only true after the worker has installed and the page has reloaded once.
//
// On Cloudflare Pages (or the vite dev server) the real headers are already
// there, this finds `crossOriginIsolated` true, and does nothing at all.

const RELOADED = 'blindspot.coi-reloaded';

export async function ensureIsolation(): Promise<void> {
  if (crossOriginIsolated) return;
  if (!('serviceWorker' in navigator)) return;
  // A worker that installed but didn't isolate us must not reload forever.
  if (sessionStorage.getItem(RELOADED)) return;

  try {
    const url = `${import.meta.env.BASE_URL}coi-serviceworker.js`;
    const registration = await navigator.serviceWorker.register(url, {
      scope: import.meta.env.BASE_URL,
    });
    await registration.update().catch(() => {});
    if (!navigator.serviceWorker.controller) {
      // It has installed but isn't controlling this page yet; the reload is
      // what puts it in charge, and the reloaded page will be isolated.
      sessionStorage.setItem(RELOADED, '1');
      location.reload();
      await never();
    }
  } catch (e) {
    console.warn('no cross-origin isolation:', e);
  }
}

const never = (): Promise<never> => new Promise<never>(() => {});
