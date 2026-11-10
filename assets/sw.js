// Keeps the last downloaded page on the phone so the site opens fast and without signal.
// - Page: if version.txt says nothing changed, the stored copy opens instantly;
//   otherwise the new page is downloaded (6s limit, then the stored copy).
// - Fonts and photos under a/ never change (their names carry a hash): stored once, reused.
const CACHE = 'istanbul2026-v2';
const ASSETS = /*ASSETS*/[];
const SCOPE = new URL('./', self.registration.scope);
const PAGE = SCOPE.pathname;
const VKEY = PAGE + '__version';
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(a => new URL(a, SCOPE).pathname))).catch(() => {}));
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  const c = await caches.open(CACHE);
  const keep = new Set([PAGE, VKEY, ...ASSETS.map(a => new URL(a, SCOPE).pathname)]);
  for (const r of await c.keys()) if (!keep.has(new URL(r.url).pathname)) await c.delete(r);
  await self.clients.claim();
})()));

async function remoteVersion() {
  const r = await Promise.race([fetch(PAGE + 'version.txt', { cache: 'no-store' }), timeout(3000)]);
  if (!r.ok) throw new Error('version ' + r.status);
  return (await r.text()).split('\n')[0].trim();
}

async function page(req) {
  const c = await caches.open(CACHE);
  const cached = await c.match(PAGE);
  let v = null;
  try { v = await remoteVersion(); } catch (e) {}
  if (cached && v) {
    const have = await c.match(VKEY);
    if (have && (await have.text()) === v) return cached;   // nothing new: open instantly
  }
  const network = fetch(req, { cache: 'no-store' }).then(res => {
    if (res.ok) {
      const copy = res.clone();
      c.put(PAGE, copy).then(() => v && c.put(VKEY, new Response(v)));
    }
    return res;
  });
  try {
    return await Promise.race([network, timeout(cached ? 6000 : 30000)]);
  } catch (e) {
    if (cached) { network.catch(() => {}); return cached; }
    return network;
  }
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate' || url.pathname === PAGE || url.pathname === PAGE + 'index.html') {
    e.respondWith(page(req));
  } else if (url.pathname.startsWith(PAGE + 'a/')) {
    e.respondWith(caches.match(url.pathname).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(url.pathname, copy)); }
      return res;
    })));
  }
});
