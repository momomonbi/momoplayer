const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const root = 'https://example.test/momoplayer/';
const currentCache = 'momo-player-v2';

function harness() {
  const handlers = {};
  const stores = new Map();
  const calls = [];
  let network = async () => new Response('network');
  let failWrite = false;
  let failOpen = false;
  const keyOf = key => new URL(typeof key === 'string' ? key : key.url, root).href;
  const storeFor = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const caches = {
    async open(name) {
      if (failOpen) throw new Error('storage unavailable');
      const store = storeFor(name);
      return {
        async match(key) { return store.get(keyOf(key))?.clone(); },
        async put(key, response) {
          if (failWrite) throw new Error('quota exceeded');
          store.set(keyOf(key), response.clone());
        },
        async addAll(keys) {
          calls.push(['precache', ...keys]);
          for (const key of keys) store.set(keyOf(key), new Response('installed page'));
        }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { calls.push(['delete', name]); return stores.delete(name); }
  };
  vm.runInNewContext(source, {
    URL, Response, location: new URL(root + 'sw.js'), caches,
    fetch: request => network(request),
    self: {
      location: new URL(root + 'sw.js'),
      addEventListener(type, handler) { handlers[type] = handler; },
      async skipWaiting() { calls.push(['skipWaiting']); },
      clients: { async claim() { calls.push(['claim']); } }
    }
  });
  return {
    stores, calls,
    setNetwork(callback) { network = callback; },
    failWrites() { failWrite = true; },
    failCacheOpen() { failOpen = true; },
    seed(name, url, response) { storeFor(name).set(keyOf(url), response); },
    fetch(url = root + 'index.html', { method = 'GET', mode = 'navigate' } = {}) {
      let promise;
      handlers.fetch({ request: { url, method, mode }, respondWith(value) { promise = value; } });
      return promise;
    },
    async lifecycle(type) {
      let pending;
      handlers[type]({ waitUntil(value) { pending = value; } });
      assert.ok(pending, `${type} must extend the event lifetime`);
      await pending;
    }
  };
}

test('successful navigation updates the offline page', async () => {
  const sw = harness();
  sw.seed(currentCache, 'index.html', new Response('old page'));
  sw.setNetwork(async () => new Response('new page'));
  assert.equal(await (await sw.fetch()).text(), 'new page');
  sw.setNetwork(async () => { throw new Error('offline'); });
  assert.equal(await (await sw.fetch()).text(), 'new page');
});

test('503 cannot replace a working page, including the next offline launch', async () => {
  const sw = harness();
  sw.seed(currentCache, 'index.html', new Response('working player'));
  sw.setNetwork(async () => new Response('temporarily unavailable', { status: 503 }));
  const fallback = await sw.fetch();
  assert.equal(fallback.status, 200);
  assert.equal(await fallback.text(), 'working player');
  sw.setNetwork(async () => { throw new Error('offline'); });
  assert.equal(await (await sw.fetch()).text(), 'working player');
});

test('offline navigation with an uncached query falls back to the app entry points', async () => {
  for (const entry of ['index.html', './']) {
    const sw = harness();
    sw.seed(currentCache, entry, new Response('app shell'));
    sw.setNetwork(async () => { throw new Error('offline'); });
    assert.equal(await (await sw.fetch(root + '?launch=installed')).text(), 'app shell');
  }
});

test('HTTP errors without a working cache remain errors and are never stored', async () => {
  for (const mode of ['navigate', 'cors']) {
    const sw = harness();
    sw.setNetwork(async () => new Response('unavailable', { status: 503 }));
    assert.equal((await sw.fetch(root + 'index.html', { mode })).status, 503);
    assert.equal(sw.stores.get(currentCache)?.size || 0, 0);
  }
});

test('POST and cross-origin requests are left to the browser', () => {
  const sw = harness();
  assert.equal(sw.fetch(root + 'index.html', { method: 'POST' }), undefined);
  assert.equal(sw.fetch('https://other.test/audio.mp3', { mode: 'cors' }), undefined);
  assert.equal(sw.stores.size, 0);
});

test('successful GET assets are available without a second network request', async () => {
  const sw = harness();
  let requests = 0;
  sw.setNetwork(async () => { requests++; return new Response('manifest'); });
  const url = root + 'manifest.json';
  assert.equal(await (await sw.fetch(url, { mode: 'cors' })).text(), 'manifest');
  assert.equal(await (await sw.fetch(url, { mode: 'cors' })).text(), 'manifest');
  assert.equal(requests, 1);
});

test('failed cache writes or opens do not lose successful network responses', async () => {
  for (const fail of ['failWrites', 'failCacheOpen']) {
    for (const mode of ['navigate', 'cors']) {
      const sw = harness();
      sw[fail]();
      sw.setNetwork(async () => new Response('usable response'));
      assert.equal(await (await sw.fetch(root + 'index.html', { mode })).text(), 'usable response');
    }
  }
});

test('activation preserves other applications and claims clients after deleting old versions', async () => {
  const sw = harness();
  for (const name of ['momo-player-v1', currentCache, 'another-app-v1']) {
    sw.seed(name, './', new Response(name));
  }
  await sw.lifecycle('activate');
  assert.deepEqual([...sw.stores.keys()], [currentCache, 'another-app-v1']);
  assert.deepEqual(sw.calls, [['delete', 'momo-player-v1'], ['claim']]);
});

test('installation finishes precaching before skipping the waiting phase', async () => {
  const sw = harness();
  await sw.lifecycle('install');
  assert.deepEqual(sw.calls, [['precache', './', './index.html', './manifest.json'], ['skipWaiting']]);
});
