// Scrape WDSF -> build the app -> dist/index.html
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { scrape } from './scrape.mjs';
import { buildPage } from './build.mjs';
import { fetchMarx } from './marx.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const A = p => path.join(root, p);

const cacheFile = A('data/last.json');
let prev = null;
try { if (fs.existsSync(cacheFile)) prev = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); }
catch (e) { console.log('::warning::last.json unreadable, starting fresh: ' + e.message); }   // a cut-off file must not stop every later run
const now = new Date();
// Entry lists (who dances where) are refreshed every 2 h, every 30 min on event days, and at once whenever a competition has no list yet.
const evDay = now.getUTCMonth() === 10 && now.getUTCDate() >= 10 && now.getUTCDate() <= 15;
const noList = !prev || !prev.P || (prev.E || []).some(e => e[5] && !(prev.P[e[5]] || []).length);
const withEntries = !prev || process.env.FULL === '1' || noList || (now.getUTCHours() % 2 === 0 && now.getUTCMinutes() < 5) || (evDay && now.getUTCMinutes() % 30 < 5);

const data = await scrape({ prev, withEntries });
// Organiser's live timetable (marX): baked into the page as a starting point; the 1-minute feed
// (scripts/loop.mjs → live branch) keeps phones current without new deploys.
try { data.MX = await fetchMarx(); } catch (e) { console.log('::warning::marX not reachable: ' + e.message); data.MX = prev && prev.MX || null; }
const nEntries = Object.values(data.P).reduce((n, v) => n + v.length, 0);
if (nEntries < 200) throw new Error('entries look incomplete: ' + nEntries);
console.log(`items ${data.E.length} · comps ${Object.keys(data.R).length} · entries ${nEntries} · teams ${Object.keys(data.T).length} · rankings ${Object.keys(data.RK).length} · entries refreshed: ${withEntries}`);
// Publish only when something changed, plus a heartbeat every 30 min during event hours
// (Cloudflare's free plan allows ~500 deploys a month).
const { fetched, MX, ...content } = data;   // marX changes alone do not trigger a deploy
const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
const nowMs = Date.now();
const istHour = (now.getUTCHours() + 3) % 24;
const eventDay = now.getUTCMonth() === 10 && (now.getUTCDate() + (now.getUTCHours() >= 21 ? 1 : 0)) >= 11 && (now.getUTCDate() + (now.getUTCHours() >= 21 ? 1 : 0)) <= 15;
const lastDeployAt = prev && prev._lastDeployAt || 0;
const heartbeatDue = eventDay && istHour >= 7 && nowMs - lastDeployAt >= 29 * 60e3;
const forced = ['push', 'workflow_dispatch'].includes(process.env.EVENT_NAME || '');
// The page's own code counts too: a newer template or club list must go out without waiting for a data change.
const codeHash = (() => { const h = createHash('sha256');
  try { for (const f of ['assets/template.html', 'assets/sw.js', 'scripts/build.mjs', 'scripts/club.mjs', ...fs.readdirSync(A('club')).sort().map(f => 'club/' + f)]) h.update(fs.readFileSync(A(f))); } catch (e) { return prev && prev._code || ''; }
  return h.digest('hex'); })();
const changed = !prev || prev._hash !== hash || (prev._code || codeHash) !== codeHash;
const deploy = changed || heartbeatDue || forced || nowMs - lastDeployAt > 20 * 3600e3;
console.log(`changed: ${changed} · heartbeat due: ${heartbeatDue} · forced: ${forced} → deploy: ${deploy}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${deploy}\n`);
fs.mkdirSync(A('data'), { recursive: true });
// Build first: if the build fails, the old marker stays and the next run tries again.
if (deploy) { const { bytes } = await buildPage(data); console.log('dist/index.html', bytes, 'bytes'); }
fs.writeFileSync(cacheFile + '.tmp', JSON.stringify({ ...data, _hash: hash, _code: codeHash, _lastDeployAt: deploy ? nowMs : lastDeployAt }));
fs.renameSync(cacheFile + '.tmp', cacheFile);
if (!deploy) process.exit(0);
