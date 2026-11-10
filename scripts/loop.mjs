// Long-running updater: checks WDSF every 3 min (every 10 min at night) and marX every minute for ~5h40m,
// publishing when something changed. The workflow then starts a fresh copy of itself.
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fetchMarx, marxKey, marxDiff, addChanges } from './marx.mjs';

const RUN_UNTIL = Date.now() + (+process.env.LOOP_MINUTES || 340) * 60e3;
const EVENT_END = Date.UTC(2026, 10, 15, 22, 0);      // 16 Nov 01:00 Istanbul
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- 1-minute live feed: organiser's timetable → live.json on the 'live' branch.
// Phones read it from raw.githubusercontent.com, so delays show up without a new deploy.
const REPO = process.env.GITHUB_REPOSITORY, TOKEN = process.env.GH_TOKEN;
let liveSha = null, liveKey = '', livePushedAt = 0;
let lastMx = null, chgLog = null, chgFrom = null;      // previous snapshot and the change log (both continue from the file on the live branch)
async function gh(path, init = {}) {
  const r = await fetch('https://api.github.com/repos/' + REPO + path, { ...init, headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  return r;
}
// The file already on the live branch: its version (needed to replace it) and, on the first read,
// the previous timetable and change log, so the log carries on across restarts of this job.
async function loadLive() {
  const g = await gh('/contents/live.json?ref=live');
  if (!g.ok) return;
  const j = await g.json();
  liveSha = j.sha;
  if (lastMx) return;
  try {
    const old = JSON.parse(Buffer.from(j.content || '', 'base64').toString('utf8'));
    if (old && old.r) { lastMx = old; chgLog = Array.isArray(old.chg) ? old.chg : []; chgFrom = Array.isArray(old.chg) && old.chg0 || null; }
  } catch (e) { console.log('live: previous file not readable', e.message); }
}
// The timetable plus the change log. A problem in the log must never stop the timetable itself.
function withChanges(mx) {
  let chg = Array.isArray(chgLog) ? chgLog : [];
  try {
    const d = marxDiff(lastMx, mx);
    if (d.length) console.log('marX moved', d.length, 'item(s)');
    const before = chg.reduce((n, g) => n + (Array.isArray(g) && Array.isArray(g[1]) ? g[1].length : 0), 0) + d.length;
    chg = addChanges(chg, mx.fetched, d);
    if (chg.length && chg.reduce((n, g) => n + g[1].length, 0) < before) chgFrom = chg[0][0];     // oldest entries dropped: the log now starts later
  } catch (e) { console.log('change log skipped:', e.message); }
  if (!chgFrom) chgFrom = mx.fetched;                 // the log starts with this run
  return { ...mx, chg, chg0: chgFrom };
}
async function pushLive() {
  if (!REPO || !TOKEN) return;
  let mx;
  try { mx = await fetchMarx(); } catch (e) { console.log('marX:', e.message); return; }
  const key = marxKey(mx);
  if (key === liveKey && Date.now() - livePushedAt < 10 * 60e3) return;      // unchanged: heartbeat every 10 min
  try {
    if (!liveSha) await loadLive();
    let body0 = withChanges(mx);
    const put = () => gh('/contents/live.json', { method: 'PUT', body: JSON.stringify({ message: (key === liveKey ? 'live: heartbeat ' : 'live: timetable ') + mx.fetched, content: Buffer.from(JSON.stringify(body0)).toString('base64'), branch: 'live', ...(liveSha ? { sha: liveSha } : {}) }) });
    let p = await put();
    if (p.status === 409 || p.status === 422) {          // someone else wrote the file, or we had not read it yet
      liveSha = null; await loadLive();
      if (liveSha) { body0 = withChanges(mx); p = await put(); }      // rebuilt, so a log read just now is kept
    }
    if (!p.ok) { console.log('live push failed', p.status, (await p.text()).slice(0, 200)); return; }
    liveSha = (await p.json()).content.sha;
    if (key !== liveKey) console.log('live feed updated ·', Object.values(mx.r).filter(x => x[4] === 'c').length, 'current ·', mx.at);
    liveKey = key; livePushedAt = Date.now();
    lastMx = mx; chgLog = body0.chg;
  } catch (e) { console.log('live push error', e.message); }
}
async function waitWithLiveFeed(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await pushLive();                                // organiser updates at any hour, night included
    await sleep(Math.min(60e3, Math.max(0, end - Date.now())));
  }
}
const istHour = () => (new Date().getUTCHours() + 3) % 24;
const deployCmd = ['--yes', 'wrangler@3.114.17', 'pages', 'deploy', 'dist', '--project-name=istanbul2026-takip', '--branch=main', '--commit-dirty=true'];

let round = 0, failures = 0;
while (Date.now() < RUN_UNTIL && Date.now() < EVENT_END) {
  round++;
  const started = Date.now();
  fs.rmSync('dist', { recursive: true, force: true });
  const r = spawnSync('node', ['scripts/update.mjs'], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', EVENT_NAME: 'loop' } });
  const out = (r.stdout || '') + (r.stderr || '');
  console.log(`— round ${round} · ${new Date().toISOString()}\n${out.trim()}`);
  failures = r.status === 0 ? 0 : failures + 1;
  if (failures >= 3) { console.error('::error::3 checks in a row failed — stopping so the failure shows up; a new run takes over.'); process.exit(1); }
  if (r.status === 0 && /deploy: true/.test(out) && fs.existsSync('dist/index.html') && process.env.CLOUDFLARE_API_TOKEN) {
    const d = spawnSync('npx', deployCmd, { encoding: 'utf8', env: process.env });
    console.log(d.status === 0 ? 'published' : 'publish failed: ' + (d.stderr || '').slice(-400));
    if (d.status === 0) spawnSync('node', ['scripts/cleanup.mjs'], { stdio: 'inherit', env: process.env });
  }
  const gap = (istHour() >= 7 ? 3 : 10) * 60e3;    // WDSF every 3 min by day, 10 at night; marX every minute in between
  const wait = gap - ((Date.now() - started) % gap);
  if (Date.now() + wait >= RUN_UNTIL) break;
  await waitWithLiveFeed(wait);
}
console.log('loop finished after', round, 'round(s)');
