// Keeps the last downloaded page on the phone so the site opens fast and without signal.
// - Page: if version.txt says nothing changed, the stored copy opens instantly;
//   otherwise the new page is downloaded (6s limit, then the stored copy).
// - Fonts and photos under a/ never change (their names carry a hash): stored once, reused.
const CACHE = 'istanbul2026-v2';
const ASSETS = /*ASSETS*/[];
const SCOPE = new URL('./', self.registration.scope);
const PAGE = SCOPE.pathname;
const DIRS = /*DIRS*/[];                       // club pages, e.g. ['tarz'] → /tarz/
const pageDirs = () => [PAGE, ...DIRS.map(d => PAGE + d + '/')];
const dirOf = p => pageDirs().slice(1).find(d => p === d || p === d + 'index.html') || ((p === PAGE || p === PAGE + 'index.html') ? PAGE : null);
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(a => new URL(a, SCOPE).pathname))).catch(() => {}));
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  const c = await caches.open(CACHE);
  const keep = new Set([...pageDirs().flatMap(d => [d, d + '__version']), ...ASSETS.map(a => new URL(a, SCOPE).pathname)]);
  for (const r of await c.keys()) if (!keep.has(new URL(r.url).pathname)) await c.delete(r);
  await self.clients.claim();
})()));

async function remoteVersion(dir) {
  const r = await Promise.race([fetch(dir + 'version.txt', { cache: 'no-store' }), timeout(2000)]);
  if (!r.ok) throw new Error('version ' + r.status);
  return (await r.text()).split('\n')[0].trim();
}

async function page(req, dir) {
  const VKEY = dir + '__version';
  const c = await caches.open(CACHE);
  const cached = await c.match(dir);
  let v = null;
  try { v = await remoteVersion(dir); } catch (e) {}
  if (cached && v) {
    const have = await c.match(VKEY);
    if (have && (await have.text()) === v) return cached;   // nothing new: open instantly
  }
  // Only a complete copy of our own page is shown or stored: an error page, a Wi-Fi login page
  // or a download cut half-way must never replace the good copy on the phone.
  const raw = fetch(req, { cache: 'no-store' });
  const good = raw.then(async res => {
    if (!res.ok) throw new Error('status ' + res.status);
    const txt = await res.clone().text();     // rejects if the connection is cut mid-body
    if (!txt.includes('id="v-simdi"') || !/<\/html>\s*$/.test(txt)) throw new Error('not our complete page');
    await c.put(dir, res.clone());
    if (v) await c.put(VKEY, new Response(v));
    return res;
  });
  try {
    return await Promise.race([good, timeout(cached ? 5000 : 30000)]);
  } catch (e) {
    if (cached) { good.catch(() => {}); return cached; }
    return raw;                                // nothing stored yet: show whatever the server sent
  }
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const dir = dirOf(url.pathname);
  if (dir) {
    e.respondWith(page(req, dir));
  } else if (url.pathname.startsWith(PAGE + 'a/')) {
    e.respondWith(caches.match(url.pathname).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(url.pathname, copy)); }
      return res;
    })));
  }
});
