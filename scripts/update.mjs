// Scrape WDSF -> build the app -> encrypt with SITE_PASSWORD -> dist/index.html
import fs from 'fs';
import path from 'path';
import { scrape } from './scrape.mjs';
import { buildPage } from './build.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const A = p => path.join(root, p);
const password = process.env.SITE_PASSWORD;

const cacheFile = A('data/last.json');
const prev = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : null;
const now = new Date();
const withEntries = !prev || process.env.FULL === '1' || (now.getUTCHours() % 2 === 0 && now.getUTCMinutes() < 15);

const data = await scrape({ prev, withEntries });
const nEntries = Object.values(data.P).reduce((n, v) => n + v.length, 0);
if (nEntries < 200) throw new Error('entries look incomplete: ' + nEntries);
console.log(`items ${data.E.length} · comps ${Object.keys(data.R).length} · entries ${nEntries} · teams ${Object.keys(data.T).length} · rankings ${Object.keys(data.RK).length} · entries refreshed: ${withEntries}`);
fs.mkdirSync(A('data'), { recursive: true });
fs.writeFileSync(cacheFile, JSON.stringify(data));

if (!password) {
  console.log('::warning::SITE_PASSWORD secret is not set yet — data was fetched successfully, but the page was not built.');
  process.exit(0);
}
const { bytes } = await buildPage(data, password);
console.log('dist/index.html', bytes, 'bytes');
