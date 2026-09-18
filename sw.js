const CACHE_PREFIX = 'momo-player-';
const CACHE_NAME = CACHE_PREFIX + 'v2';
const APP_ROOT = new URL('./', self.location.href).href;
const APP_INDEX = new URL('./index.html', self.location.href).href;
const ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

async function readCached(request, navigation = false) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = navigation ? [request, APP_INDEX, APP_ROOT] : [request];
    for (const key of keys) {
      const response = await cache.match(key);
      if (response && response.ok) return response;
    }
  } catch (_) {}
}

async function saveCached(request, response) {
  if (request.method !== 'GET' || !response.ok) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  } catch (_) {
    // Storage failure must not turn a successful network response into an error.
  }
}

async function navigate(request) {
  let response;
  try {
    response = await fetch(request);
    if (response.ok) {
      await saveCached(request, response);
      return response;
    }
  } catch (_) {}
  return (await readCached(request, true)) || response || Response.error();
}

async function loadAsset(request) {
  const cached = await readCached(request);
  if (cached) return cached;
  const response = await fetch(request);
  await saveCached(request, response);
  return response;
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Leave other origins and non-GET requests to the browser.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Network-first for HTML (always get latest), cache-first for others
  e.respondWith(e.request.mode === 'navigate' ? navigate(e.request) : loadAsset(e.request));
});
