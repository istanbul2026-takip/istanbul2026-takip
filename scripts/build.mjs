// Build the public page from scraped data.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { clubFor } from './club.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const A = p => path.join(root, p);
export async function buildPage(data, outDir = A('dist')) {
  const { S, _hash, _lastDeployAt, ...payload } = data;
  const { fetched: _f, MX: _mx, ...stable } = payload;
  // The version covers the data AND the page/worker code, so a design change also counts as an update
  // (otherwise phones keep opening their stored copy of the previous page).
  const buildHash = createHash('sha256').update(JSON.stringify(stable))
    .update(fs.readFileSync(A('assets/template.html'))).update(fs.readFileSync(A('assets/sw.js'))).update(fs.readdirSync(A('club')).map(f => fs.readFileSync(A('club/' + f), 'utf8')).join('') + fs.readFileSync(A('scripts/club.mjs'), 'utf8'))
    .digest('hex').slice(0, 16);
  // Fonts and hall photos are not secret: ship them as separate, long-cached files so the
  // page stays small and repeat visits only download what changed.
  const assetDir = path.join(outDir, 'a');
  fs.rmSync(assetDir, { recursive: true, force: true });
  fs.mkdirSync(assetDir, { recursive: true });
  const assets = [];
  const seen = new Map();
  const put = p => {
    if (seen.has(p)) return seen.get(p);
    const buf = fs.readFileSync(A(p));
    const ext = path.extname(p), stem = path.basename(p, ext);
    const name = `${stem}.${createHash('sha256').update(buf).digest('hex').slice(0, 10)}${ext}`;
    fs.writeFileSync(path.join(assetDir, name), buf);
    assets.push('a/' + name);
    seen.set(p, 'a/' + name);
    return 'a/' + name;
  };
  const render = (club, pre) => {
    let app = fs.readFileSync(A('assets/template.html'), 'utf8');
    app = app.replace('/*DATA*/null', () => JSON.stringify(payload).replace(/<\//g, '<\\/'))
      .replace('/*SLUGS*/null', () => JSON.stringify(S))
      .replace('/*CLUB*/null', () => JSON.stringify(club).replace(/<\//g, '<\\/'))
      .replace('/*BUILD*/null', () => JSON.stringify(club ? buildHash + '-' + club.slug : buildHash))
      .replace('data:image/jpeg;base64,/*IMGA*/', () => pre + put('assets/hallA.jpg'))
      .replace('data:image/jpeg;base64,/*IMGB*/', () => pre + put('assets/hallB.jpg'))
      .replace('data:font/woff2;base64,/*F_BSD_LATIN*/', () => pre + put('assets/fonts/big-shoulders-display-latin-wght-normal.woff2'))
      .replace('data:font/woff2;base64,/*F_BSD_EXT*/', () => pre + put('assets/fonts/big-shoulders-display-latin-ext-wght-normal.woff2'))
      .replace('data:font/woff2;base64,/*F_FIG_LATIN*/', () => pre + put('assets/fonts/figtree-latin-wght-normal.woff2'))
      .replace('data:font/woff2;base64,/*F_FIG_EXT*/', () => pre + put('assets/fonts/figtree-latin-ext-wght-normal.woff2'))
      .replace('data:font/woff2;base64,/*F_FLAGS*/', () => pre + put('assets/fonts/TwemojiCountryFlags.woff2'));
    if (/\/\*(DATA|SLUGS|CLUB|BUILD|IMG|F_)/.test(app)) throw new Error('template placeholder left unfilled');
    return app;
  };
  const app = render(null, '');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), app);
  fs.writeFileSync(path.join(outDir, 'version.txt'), buildHash + '\n' + payload.fetched + '\n');
  // Club pages (club/<slug>.json): same data, filtered to the club, at /<slug>/
  const clubDir = A('club');
  const clubs = fs.existsSync(clubDir) ? fs.readdirSync(clubDir).filter(f => f.endsWith('.json')) : [];
  const clubDirs = [];
  for (const f of clubs) {
    const cfg = JSON.parse(fs.readFileSync(path.join(clubDir, f), 'utf8'));
    const club = { ...clubFor(payload, cfg), notes: cfg.notes || [] };
    club.rel = relatedItems(payload, club);
    const dir = path.join(outDir, cfg.slug);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), render(club, '../'));
    fs.writeFileSync(path.join(dir, 'version.txt'), buildHash + '-' + cfg.slug + '\n' + payload.fetched + '\n');
    clubDirs.push(cfg.slug);
  }
  fs.writeFileSync(path.join(outDir, 'sw.js'), fs.readFileSync(A('assets/sw.js'), 'utf8')
    .replace('/*ASSETS*/[]', () => JSON.stringify(assets)).replace('/*DIRS*/[]', () => JSON.stringify(clubDirs)));
  fs.writeFileSync(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  const noCache = d => `/${d}\n  Cache-Control: no-cache\n/${d}index.html\n  Cache-Control: no-cache\n/${d}version.txt\n  Cache-Control: no-store\n`;
  fs.writeFileSync(path.join(outDir, '_headers'), `/*\n  X-Robots-Tag: noindex, nofollow\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()\n  Cross-Origin-Opener-Policy: same-origin\n  Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://raw.githubusercontent.com; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\n${noCache('')}/sw.js\n  Cache-Control: no-cache\n/a/*\n  Cache-Control: public, max-age=31536000, immutable\n${clubDirs.map(d => noCache(d + '/')).join('')}`);
  return { bytes: Buffer.byteLength(app), app };
}

// Rehearsals, results presentations and the opening ceremony that concern the club's competitions.
function relatedItems(data, club) {
  const titles = {};
  for (const e of data.E) if (e[5] && club.entries[e[5]]) titles[e[5]] = e[4].replace('World Ch.', 'World Championship');
  const out = {};
  for (const e of data.E) {
    if (e[5]) continue;
    const ids = Object.entries(titles).filter(([, t]) => e[4].includes(t)).map(([id]) => +id);
    if (ids.length || /^Opening ceremony$/i.test(e[4])) out[`${e[0]}|${e[1]}|${e[2]}`] = ids;
  }
  return out;
}
