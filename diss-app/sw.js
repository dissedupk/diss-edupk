// ── DISS School System — Service Worker v3 ───────────────────────────────────
const CACHE = 'diss-school-v3'; // bumped to clear old broken cache

const STATIC_ASSETS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/@babel/standalone/babel.min.js'
];

// Install: pre-cache only static CDN assets (NOT index.html)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete ALL old caches immediately
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch strategy:
// → HTML pages: NETWORK FIRST (always get latest from Netlify)
// → CDN assets: CACHE FIRST (speed)
// → Firebase: bypass completely
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  // Never intercept Firebase or Google APIs
  if (url.includes('firebase') || url.includes('googleapis') || url.includes('gstatic')) return;

  const isHTML = event.request.headers.get('accept')?.includes('text/html') ||
                 url.endsWith('.html') || url.endsWith('/');

  if (isHTML) {
    // NETWORK FIRST for HTML — always get fresh app from server
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request) || caches.match('/index.html'))
    );
  } else {
    // CACHE FIRST for static assets (React, Tailwind, etc.)
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => null);
      })
    );
  }
});
