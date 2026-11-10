// Scrape WDSF -> build the app -> dist/index.html
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { scrape } from './scrape.mjs';
import { buildPage } from './build.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const A = p => path.join(root, p);

const cacheFile = A('data/last.json');
const prev = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : null;
const now = new Date();
const withEntries = !prev || process.env.FULL === '1' || (now.getUTCHours() % 2 === 0 && now.getUTCMinutes() < 5);

const data = await scrape({ prev, withEntries });
const nEntries = Object.values(data.P).reduce((n, v) => n + v.length, 0);
if (nEntries < 200) throw new Error('entries look incomplete: ' + nEntries);
console.log(`items ${data.E.length} · comps ${Object.keys(data.R).length} · entries ${nEntries} · teams ${Object.keys(data.T).length} · rankings ${Object.keys(data.RK).length} · entries refreshed: ${withEntries}`);
// Publish only when something changed, plus a heartbeat every 30 min during event hours
// (Cloudflare's free plan allows ~500 deploys a month).
const { fetched, ...content } = data;
const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
const nowMs = Date.now();
const istHour = (now.getUTCHours() + 3) % 24;
const eventDay = now.getUTCMonth() === 10 && (now.getUTCDate() + (now.getUTCHours() >= 21 ? 1 : 0)) >= 11 && (now.getUTCDate() + (now.getUTCHours() >= 21 ? 1 : 0)) <= 15;
const lastDeployAt = prev && prev._lastDeployAt || 0;
const heartbeatDue = eventDay && istHour >= 7 && nowMs - lastDeployAt >= 29 * 60e3;
const forced = ['push', 'workflow_dispatch'].includes(process.env.EVENT_NAME || '');
const changed = !prev || prev._hash !== hash;
const deploy = changed || heartbeatDue || forced || nowMs - lastDeployAt > 20 * 3600e3;
console.log(`changed: ${changed} · heartbeat due: ${heartbeatDue} · forced: ${forced} → deploy: ${deploy}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${deploy}\n`);
fs.mkdirSync(A('data'), { recursive: true });
fs.writeFileSync(cacheFile, JSON.stringify({ ...data, _hash: hash, _lastDeployAt: deploy ? nowMs : lastDeployAt }));
if (!deploy) process.exit(0);

const { bytes } = await buildPage(data);
console.log('dist/index.html', bytes, 'bytes');
