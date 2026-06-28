/**
 * BizOps Service Worker v33
 * Caches ONLY static assets — never API responses or financial data (FIND-004)
 *
 * Strategy: NETWORK-FIRST for the app shell so code/UI updates apply on the next
 * load when online; falls back to cache only when the network is unavailable.
 * (v5 was cache-first, which pinned stale JS until the cache name was bumped.)
 */

const CACHE = 'bizops-v33';

// Only static shell files — NO API endpoints
const STATIC_SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/config.js',
  '/js/auth.js',
  '/js/store.js',
  '/js/sync.js',
  '/js/holidays.js',
  '/js/invoices.js',
  '/js/staff.js',
  '/js/cash.js',
  '/js/timesheets.js',
  '/js/dashboard.js',
  '/js/app.js',
  '/js/api-square.js',
  '/js/api-xero.js',
  '/manifest.json',
];

// Never cache these — financial/API data
const NEVER_CACHE = [
  '/.netlify/functions/',
  '/api/',
  'api.xero.com',
  'connect.squareup.com',
  'identity.xero.com',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Only handle same-origin GET requests. Letting cross-origin assets (Google
  // Fonts) and non-http schemes (chrome-extension) pass straight through avoids
  // turning a <link> load into a CSP-blocked connect-src fetch, and avoids
  // cache.put() throwing on unsupported schemes.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never cache API calls or financial data — always hit the network live
  if (NEVER_CACHE.some(nc => req.url.includes(nc))) {
    e.respondWith(fetch(req));
    return;
  }

  // Network-first for the app shell: fetch fresh, cache the result, and only
  // fall back to the cached copy when offline. Use cache:'no-store' so the
  // request bypasses the browser HTTP cache — otherwise an unversioned
  // /js/app.js can be served stale even though we go "network-first".
  e.respondWith(
    fetch(req, { cache: 'no-store' })
      .then(response => {
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return response;
      })
      .catch(() => caches.match(req))
  );
});

// Clear all caches on logout message
self.addEventListener('message', e => {
  if (e.data?.type === 'LOGOUT') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});
