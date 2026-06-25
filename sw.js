/**
 * BizOps Service Worker v3
 * Caches ONLY static assets — never API responses or financial data (FIND-004)
 */

const CACHE = 'bizops-v3';

// Only static shell files — NO API endpoints
const STATIC_SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/config.js',
  '/js/auth.js',
  '/js/store.js',
  '/js/holidays.js',
  '/js/invoices.js',
  '/js/staff.js',
  '/js/cash.js',
  '/js/timesheets.js',
  '/js/dashboard.js',
  '/js/app.js',
  '/manifest.json',
];

// Never cache these — financial/API data
const NEVER_CACHE = [
  '/.netlify/functions/',
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
  const url = e.request.url;

  // Never cache API calls or financial data
  const isApiCall = NEVER_CACHE.some(nc => url.includes(nc));
  if (isApiCall) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first for static shell only
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        // Only cache successful static responses
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      });
    })
  );
});

// Clear all caches on logout message
self.addEventListener('message', e => {
  if (e.data?.type === 'LOGOUT') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});
