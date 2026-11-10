// Keeps the last downloaded (encrypted) page on the phone so the site opens without signal.
const CACHE = 'istanbul2026-v1';
const PAGE = new URL('./', self.registration.scope).pathname;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate' || url.pathname === PAGE || url.pathname.endsWith('/index.html')) {
    const network = fetch(req, { cache: 'no-store' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(PAGE, copy)); }
      return res;
    });
    e.respondWith(Promise.race([network, timeout(6000)]).catch(async () => {
      const cached = await caches.match(PAGE);
      if (cached) { network.catch(() => {}); return cached; }
      return network;
    }));
  }
});
