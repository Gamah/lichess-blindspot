// GitHub Pages cannot set response headers, and SharedArrayBuffer needs
// COOP/COEP, so the headers have to come from a service worker that re-serves
// the page carrying them. The consequence, which the rest of the app is built
// to tolerate: `crossOriginIsolated` is false on a visitor's very first load
// and only true after the worker has installed and the page has reloaded once.
//
// The timing is the whole difficulty. `register()` resolves when the
// registration exists, not when the worker is active and certainly not when it
// controls this page — and a reload fired before it controls anything produces
// a second uncontrolled load, at which point the one-reload guard gives up and
// the engine is unavailable for the rest of the visit. So we wait for the
// worker to actually take control, and only then reload.
//
// On Cloudflare Pages (or the vite dev server) the real headers are already
// there, this finds `crossOriginIsolated` true, and does nothing at all.

const RELOADED = 'blindspot.coi-reloaded';
/** Long enough for a slow phone to install a worker, short enough to give up. */
const CLAIM_TIMEOUT = 10_000;

export interface IsolationReport {
  isolated: boolean;
  /** Is a service worker driving this page? */
  controlled: boolean;
  sharedArrayBuffer: boolean;
  /** What stopped us, when something did. */
  problem?: string;
}

export function report(): IsolationReport {
  return {
    isolated: crossOriginIsolated,
    controlled: Boolean(navigator.serviceWorker?.controller),
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  };
}

export async function ensureIsolation(): Promise<IsolationReport> {
  if (crossOriginIsolated) return report();
  if (!('serviceWorker' in navigator))
    return { ...report(), problem: 'This browser has no service workers, so the headers cannot be set.' };
  // A worker that installed but didn't isolate us must not reload forever.
  if (sessionStorage.getItem(RELOADED))
    return {
      ...report(),
      problem: 'The service worker is running but the page is still not isolated.',
    };

  try {
    const url = `${import.meta.env.BASE_URL}coi-serviceworker.js`;
    await navigator.serviceWorker.register(url, { scope: import.meta.env.BASE_URL });
    // Registered is not active, and active is not controlling. Only a page the
    // worker controls gets the headers, so wait for that before reloading.
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await claimed();
    if (!navigator.serviceWorker.controller)
      return { ...report(), problem: 'The service worker did not take control in time.' };

    sessionStorage.setItem(RELOADED, '1');
    location.reload();
    return await never();
  } catch (e) {
    console.warn('no cross-origin isolation:', e);
    return { ...report(), problem: String((e as Error).message ?? e) };
  }
}

/** Resolves when a worker claims this page, or when we stop waiting for one. */
function claimed(): Promise<void> {
  return new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', done);
      resolve();
    };
    const timer = setTimeout(done, CLAIM_TIMEOUT);
    navigator.serviceWorker.addEventListener('controllerchange', done);
  });
}

const never = (): Promise<never> => new Promise<never>(() => {});
