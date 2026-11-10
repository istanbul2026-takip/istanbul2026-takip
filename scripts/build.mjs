// Build the public page from scraped data.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const A = p => path.join(root, p);
export async function buildPage(data, outDir = A('dist')) {
  const { S, _hash, _lastDeployAt, ...payload } = data;
  const { fetched: _f, ...stable } = payload;
  const buildHash = createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
  // Fonts and hall photos are not secret: ship them as separate, long-cached files so the
  // page stays small and repeat visits only download what changed.
  const assetDir = path.join(outDir, 'a');
  fs.rmSync(assetDir, { recursive: true, force: true });
  fs.mkdirSync(assetDir, { recursive: true });
  const assets = [];
  const put = p => {
    const buf = fs.readFileSync(A(p));
    const ext = path.extname(p), stem = path.basename(p, ext);
    const name = `${stem}.${createHash('sha256').update(buf).digest('hex').slice(0, 10)}${ext}`;
    fs.writeFileSync(path.join(assetDir, name), buf);
    assets.push('a/' + name);
    return 'a/' + name;
  };
  let app = fs.readFileSync(A('assets/template.html'), 'utf8');
  app = app.replace('/*DATA*/null', () => JSON.stringify(payload).replace(/<\//g, '<\\/'))
    .replace('/*SLUGS*/null', () => JSON.stringify(S))
    .replace('/*BUILD*/null', () => JSON.stringify(buildHash))
    .replace('data:image/jpeg;base64,/*IMGA*/', () => put('assets/hallA.jpg'))
    .replace('data:image/jpeg;base64,/*IMGB*/', () => put('assets/hallB.jpg'))
    .replace('data:font/woff2;base64,/*F_BSD_LATIN*/', () => put('assets/fonts/big-shoulders-display-latin-wght-normal.woff2'))
    .replace('data:font/woff2;base64,/*F_BSD_EXT*/', () => put('assets/fonts/big-shoulders-display-latin-ext-wght-normal.woff2'))
    .replace('data:font/woff2;base64,/*F_FIG_LATIN*/', () => put('assets/fonts/figtree-latin-wght-normal.woff2'))
    .replace('data:font/woff2;base64,/*F_FIG_EXT*/', () => put('assets/fonts/figtree-latin-ext-wght-normal.woff2'))
    .replace('data:font/woff2;base64,/*F_FLAGS*/', () => put('assets/fonts/TwemojiCountryFlags.woff2'));
  if (/\/\*(DATA|SLUGS|BUILD|IMG|F_)/.test(app)) throw new Error('template placeholder left unfilled');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), app);
  fs.writeFileSync(path.join(outDir, 'version.txt'), buildHash + '\n' + payload.fetched + '\n');
  fs.writeFileSync(path.join(outDir, 'sw.js'), fs.readFileSync(A('assets/sw.js'), 'utf8').replace('/*ASSETS*/[]', () => JSON.stringify(assets)));
  fs.writeFileSync(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  fs.writeFileSync(path.join(outDir, '_headers'), `/*\n  X-Robots-Tag: noindex, nofollow\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()\n  Cross-Origin-Opener-Policy: same-origin\n  Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\n/\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n/version.txt\n  Cache-Control: no-store\n/sw.js\n  Cache-Control: no-cache\n/a/*\n  Cache-Control: public, max-age=31536000, immutable\n`);
  return { bytes: Buffer.byteLength(app), app };
}
