/**
 * ClearVoice Service Worker
 *
 * Enables PWA installation on Android, iOS, and desktop (Chrome/Edge/Safari).
 * Caches all app shell files so ClearVoice works offline and loads instantly.
 *
 * Cache strategy: Cache-first for app shell, network-first for API calls.
 */

const CACHE_NAME   = 'clearvoice-v1';
const CACHE_BUST   = '2026-04-28'; // bump this to force cache refresh on update

const APP_SHELL = [
  './clearvoice.html',
  './clearvoice.js',
  './clearvoice.css',
  './audio-engine.js',
  './noise-processor.worklet.js',
  './voice-profile.js',
  './sip-client.js',
  './lib/jssip.bundle.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // Google Fonts (cached for offline)
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;600&display=swap',
];

// ── Install: cache all app shell files ──────────────────────────────────────

self.addEventListener('install', (event) => {
  console.log('[SW] Installing ClearVoice v1...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache files one by one — don't let one failure block the rest
      const results = await Promise.allSettled(
        APP_SHELL.map(url => cache.add(url).catch(err => {
          console.warn('[SW] Could not cache:', url, err.message);
        }))
      );
      const cached = results.filter(r => r.status === 'fulfilled').length;
      console.log(`[SW] Cached ${cached}/${APP_SHELL.length} app shell files`);
    })
  );
  // Take control immediately without waiting for old SW to expire
  self.skipWaiting();
});

// ── Activate: delete old caches ──────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim()) // take control of all open pages
  );
});

// ── Fetch: cache-first for app shell, passthrough for everything else ────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Let SIP/WebSocket traffic pass through
  if (url.protocol === 'wss:' || url.protocol === 'ws:') return;

  // Cache-first strategy for app shell assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // Not in cache — fetch from network and cache for next time
      return fetch(event.request).then(response => {
        // Only cache successful responses for same-origin or fonts
        if (
          response.ok &&
          (url.origin === self.location.origin ||
           url.hostname === 'fonts.googleapis.com' ||
           url.hostname === 'fonts.gstatic.com')
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Network failed — return offline fallback for HTML pages
        if (event.request.headers.get('Accept')?.includes('text/html')) {
          return caches.match('./clearvoice.html');
        }
      });
    })
  );
});

// ── Message: force update from app ──────────────────────────────────────────

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
