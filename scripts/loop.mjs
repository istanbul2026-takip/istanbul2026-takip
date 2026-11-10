// Long-running updater: checks WDSF every 3 min (every 10 min at night) and marX every minute for ~5h40m,
// publishing when something changed. The workflow then starts a fresh copy of itself.
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fetchMarx, marxKey } from './marx.mjs';

const RUN_UNTIL = Date.now() + (+process.env.LOOP_MINUTES || 340) * 60e3;
const EVENT_END = Date.UTC(2026, 10, 15, 22, 0);      // 16 Nov 01:00 Istanbul
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- 1-minute live feed: organiser's timetable → live.json on the 'live' branch.
// Phones read it from raw.githubusercontent.com, so delays show up without a new deploy.
const REPO = process.env.GITHUB_REPOSITORY, TOKEN = process.env.GH_TOKEN;
let liveSha = null, liveKey = '', livePushedAt = 0;
async function gh(path, init = {}) {
  const r = await fetch('https://api.github.com/repos/' + REPO + path, { ...init, headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  return r;
}
async function pushLive() {
  if (!REPO || !TOKEN) return;
  let mx;
  try { mx = await fetchMarx(); } catch (e) { console.log('marX:', e.message); return; }
  const key = marxKey(mx);
  if (key === liveKey && Date.now() - livePushedAt < 10 * 60e3) return;      // unchanged: heartbeat every 10 min
  try {
    if (!liveSha) { const g = await gh('/contents/live.json?ref=live'); if (g.ok) liveSha = (await g.json()).sha; }
    const body = { message: (key === liveKey ? 'live: heartbeat ' : 'live: timetable ') + mx.fetched, content: Buffer.from(JSON.stringify(mx)).toString('base64'), branch: 'live', ...(liveSha ? { sha: liveSha } : {}) };
    let p = await gh('/contents/live.json', { method: 'PUT', body: JSON.stringify(body) });
    if (p.status === 409 || p.status === 422) { liveSha = null; const g = await gh('/contents/live.json?ref=live'); if (g.ok) { liveSha = (await g.json()).sha; p = await gh('/contents/live.json', { method: 'PUT', body: JSON.stringify({ ...body, sha: liveSha }) }); } }
    if (!p.ok) { console.log('live push failed', p.status, (await p.text()).slice(0, 200)); return; }
    liveSha = (await p.json()).content.sha;
    if (key !== liveKey) console.log('live feed updated ·', Object.values(mx.r).filter(x => x[4] === 'c').length, 'current ·', mx.at);
    liveKey = key; livePushedAt = Date.now();
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
