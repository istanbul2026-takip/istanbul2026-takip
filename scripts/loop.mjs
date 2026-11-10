// Long-running updater: checks WDSF every 5 min (every 30 min at night) for ~5h40m,
// publishing when something changed. The workflow then starts a fresh copy of itself.
import fs from 'fs';
import { spawnSync } from 'child_process';

const RUN_UNTIL = Date.now() + (+process.env.LOOP_MINUTES || 340) * 60e3;
const EVENT_END = Date.UTC(2026, 10, 15, 22, 0);      // 16 Nov 01:00 Istanbul
const sleep = ms => new Promise(r => setTimeout(r, ms));
const istHour = () => (new Date().getUTCHours() + 3) % 24;
const deployCmd = ['--yes', 'wrangler@3.114.17', 'pages', 'deploy', 'dist', '--project-name=istanbul2026-takip', '--branch=main', '--commit-dirty=true'];

let round = 0;
while (Date.now() < RUN_UNTIL && Date.now() < EVENT_END) {
  round++;
  const started = Date.now();
  fs.rmSync('dist', { recursive: true, force: true });
  const r = spawnSync('node', ['scripts/update.mjs'], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', EVENT_NAME: 'loop' } });
  const out = (r.stdout || '') + (r.stderr || '');
  console.log(`— round ${round} · ${new Date().toISOString()}\n${out.trim()}`);
  if (r.status === 0 && /deploy: true/.test(out) && fs.existsSync('dist/index.html') && process.env.CLOUDFLARE_API_TOKEN) {
    const d = spawnSync('npx', deployCmd, { encoding: 'utf8', env: process.env });
    console.log(d.status === 0 ? 'published' : 'publish failed: ' + (d.stderr || '').slice(-400));
    if (d.status === 0) spawnSync('node', ['scripts/cleanup.mjs'], { stdio: 'inherit', env: process.env });
  }
  const gap = (istHour() >= 7 ? 5 : 30) * 60e3;
  const wait = gap - ((Date.now() - started) % gap);
  if (Date.now() + wait >= RUN_UNTIL) break;
  await sleep(wait);
}
console.log('loop finished after', round, 'round(s)');
