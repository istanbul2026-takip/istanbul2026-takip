// Build the encrypted page from scraped data.
import fs from 'fs';
import path from 'path';
import { webcrypto as c, createHash } from 'crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const A = p => path.join(root, p);
export const ITERATIONS = 600000;
// Fixed per-site salt: the derived key stays the same between builds, so "remember me" survives updates.
const SALT = createHash('sha256').update('istanbul2026-takip|v1').digest().subarray(0, 16);

export async function buildPage(data, password, outDir = A('dist')) {
  if (!password) throw new Error('SITE_PASSWORD is not set');
  const { S, _hash, _lastDeployAt, ...payload } = data;
  const b64 = p => fs.readFileSync(A(p)).toString('base64');
  let app = fs.readFileSync(A('assets/template.html'), 'utf8');
  app = app.replace('/*DATA*/null', () => JSON.stringify(payload).replace(/<\//g, '<\\/'))
    .replace('/*SLUGS*/null', () => JSON.stringify(S))
    .replace('/*IMGA*/', () => b64('assets/hallA.jpg')).replace('/*IMGB*/', () => b64('assets/hallB.jpg'))
    .replace('/*F_BSD_LATIN*/', () => b64('assets/fonts/big-shoulders-display-latin-wght-normal.woff2'))
    .replace('/*F_BSD_EXT*/', () => b64('assets/fonts/big-shoulders-display-latin-ext-wght-normal.woff2'))
    .replace('/*F_FIG_LATIN*/', () => b64('assets/fonts/figtree-latin-wght-normal.woff2'))
    .replace('/*F_FIG_EXT*/', () => b64('assets/fonts/figtree-latin-ext-wght-normal.woff2'))
    .replace('/*F_FLAGS*/', () => b64('assets/fonts/TwemojiCountryFlags.woff2'));
  if (/\/\*(DATA|SLUGS|IMG|F_)/.test(app)) throw new Error('template placeholder left unfilled');
  const iv = c.getRandomValues(new Uint8Array(12));
  const base = await c.subtle.importKey('raw', new TextEncoder().encode(password.trim()), 'PBKDF2', false, ['deriveKey']);
  const key = await c.subtle.deriveKey({ name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(app)));
  const B = x => Buffer.from(x).toString('base64');
  const page = fs.readFileSync(A('assets/loader.html'), 'utf8')
    .replace('__S__', B(SALT)).replace('__I__', B(iv)).replace('__N__', String(ITERATIONS)).replace('__C__', () => B(ct));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), page);
  fs.writeFileSync(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  fs.writeFileSync(path.join(outDir, '_headers'), '/*\n  X-Robots-Tag: noindex\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Cache-Control: no-cache\n');
  return { bytes: page.length, app };
}
