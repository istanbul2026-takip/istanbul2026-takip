// Fault-injection simulation of the server-side updater (scripts/loop.mjs, update.mjs, scrape.mjs, marx.mjs, order.mjs, cleanup.mjs).
// NOTHING here touches the network, git, GitHub or Cloudflare: every outside host is a stub, `npx wrangler` is a fake binary,
// the repo is COPIED to /tmp/pipesim/<scenario>/repo and run there (data/last.json of the real repo is only read).
//
//   node tests/pipeline-sim.mjs                 all scenarios
//   node tests/pipeline-sim.mjs S1 S6           some scenarios (names: see SCENARIOS at the bottom)
//   SPEED=40 node tests/pipeline-sim.mjs        simulated seconds per real second (default 30)
//
// The same file is also the preload module (`node --import tests/pipeline-sim.mjs`, selected by PIPESIM_CHILD=1) that
// installs: a fake clock (sim time, any speed), fake fetch for marx.dance / api.github.com / worlddancesport.org /
// api.cloudflare.com, and the fake `npx wrangler`. Only what the script OBSERVED is reported as OBS lines.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..');
const ROOT = '/tmp/pipesim';

/* =====================================================================================================
   PART 1 — stubs (run inside every child process, and inside the driver for direct function tests)
   ===================================================================================================== */
const hhmm = m => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function rawMarx(B, opt = {}) {          // organiser's timetable.json, rebuilt from the compact MX sample in data/last.json
  const mx = B.MX, tt = [];
  for (const [k, m] of Object.entries(mx.r)) {
    const [wid, rn] = k.split('.');
    tt.push({ wdsfId: +wid, roundNumber: +rn, categoryId: 'c' + wid, time: hhmm(m[2]), blockName: m[0] + ' November', hall: m[1] === 'A' ? 1 : 2, expectedMinutes: m[3], state: m[4] === 'c' ? 'current' : m[4] === 'd' ? 'done' : 'upcoming', text: 'Comp ' + wid, round: 'R' + rn });
  }
  for (const x of mx.x) {
    const res = String(x[4]).startsWith('R:');
    tt.push({ time: hhmm(x[2]), blockName: x[0] + ' November', hall: x[1] === 'A' ? 1 : 2, expectedMinutes: x[3], text: res ? '' : x[4], ...(res ? { resultsCategories: x[4].slice(2).split('|').map(name => ({ name })) } : {}) });
  }
  return { exportedAt: opt.exportedAt || mx.at, competition: { hallNames: { 1: 'A: Grand Ballroom', 2: 'B: Auditorium' } }, timetable: tt };
}
function rawCategory(cid) {
  return { p: [{ sn: 1, n: 'Alpha ' + cid }, { sn: 2, n: 'Beta ' + cid }], r: [{ i: 'r1', rn: 1, mp: 2 }], h: { r1: [{ dn: 'Samba', hn: 1, p: [{ sn: 1, n: 'Alpha' }, { sn: 2, n: 'Beta' }] }] }, ad: [{ l: 'A', n: 'Judge', ct: 'TUR' }] };
}
function wdsfPages(B, ph) {               // WDSF HTML pages rebuilt from data/last.json so that scrape() round-trips to it
  const w = ph.wdsf || {};
  const slug = id => B.S[id] + '-' + id;
  const page = b => `<html><body>${b}</body></html>`;
  const days = {}; B.E.forEach(e => (days[e[0]] = days[e[0]] || []).push(e));
  return function route(p) {
    if (w.sched === '503' || w.captcha) return { status: w.sched === '503' ? 503 : 200, body: '<html><title>Just a moment...</title><body>Checking your browser (captcha)</body></html>' };
    if (p.startsWith('/Events/GroupSchedule/')) {
      if (w.sched === 'zero') return { status: 200, body: page('<h1>No schedule</h1>') };
      let k = 0;
      return { status: 200, body: page(Object.entries(days).map(([d, rows]) => `<div class="js-day-container" data-day="2026-11-${String(d).padStart(2, '0')}"><table><thead><tr><th>B: Auditorium</th><th>A: Grand Ballroom</th></tr></thead><tbody>${rows.filter(e => { k++; return !(w.dropSched && e[5] && +d === (w.dropDay || 12) && (k % w.dropSched === 0)); }).map(e => {
        const cell = e[5] ? `<a href="/Competitions/Schedule/${slug(e[5])}"><span class="schedule__item__time">${e[2]} - ${e[3]}</span> ${esc(e[4])}</a>` : `<span class="schedule__item__time">${e[2]} - ${e[3]}</span> ${esc(e[4])}`;
        return e[1] === 'B' ? `<tr><td>${cell}</td><td></td></tr>` : `<tr><td></td><td>${cell}</td></tr>`;
      }).join('')}</tbody></table></div>`).join('')) };
    }
    let m;
    if ((m = p.match(/^\/Competitions\/Schedule\/.*-(\d+)$/))) {
      if (w.compSchedule === '404') return { status: 404, body: '' };
      if (w.compSchedule === 'html') return { status: 200, body: page('<h1>Maintenance</h1><p>Please try again later</p>') };
      return { status: 200, body: page(`<table><tbody>${(B.R[m[1]] || []).map(r => `<tr><td>${esc(r[0])}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3].replace('-', ' - ')}</td></tr>`).join('')}</tbody></table>`) };
    }
    if ((m = p.match(/^\/Competitions\/Ranking\/.*-(\d+)$/))) {
      let rows = B.RK[m[1]] || [];
      if (w.ranking === 'empty') rows = [];
      if (w.rankingRows != null) rows = rows.slice(0, w.rankingRows);
      return { status: 200, body: page(`<table class="ranking"><tbody>${rows.map(r => `<tr><td class="ranking__rank">${esc(r[0])}</td><td class="ranking__couple">${esc(r[1])}</td><td class="ranking__country">${esc(r[2])}</td><td class="ranking__number">${esc(r[3])}</td></tr>`).join('')}</tbody></table>`) };
    }
    if ((m = p.match(/^\/Competitions\/Participants\/.*-(\d+)$/))) {
      let rows = B.P[m[1]] || [];
      if (w.participants === 'zero') rows = [];
      if (w.participants === 'half') rows = rows.slice(0, Math.ceil(rows.length / 2));
      const hasT = !!B.T[m[1]];
      return { status: 200, body: page(`<table class="ranking"><tbody>${rows.map((r, i) => `<tr><td>${hasT ? `<a href="/Teams/t-${m[1]}-${i}">${esc(r[0])}</a>` : esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</tbody></table>`) };
    }
    if ((m = p.match(/^\/Teams\/t-(\d+)-(\d+)$/))) {
      if (w.teams === '404') return { status: 404, body: '' };
      return { status: 200, body: page(`<div class="js-composition">${((B.T[m[1]] || [])[+m[2]] || []).map(n => `<div class="cardlist__item__name">${esc(n)}</div>`).join('')}</div>`) };
    }
    return { status: 404, body: '' };
  };
}

const ORIG = { Date, setTimeout: globalThis.setTimeout, abortTimeout: AbortSignal.timeout.bind(AbortSignal), fetch: globalThis.fetch };   // captured once: installStubs may run several times in the driver
export function installStubs(cfg) {
  const RealDate = ORIG.Date, realNow = RealDate.now.bind(RealDate);
  const clk = cfg.clock;
  const speed = () => (clk && clk.speed) || 1;
  const simNow = () => clk ? clk.t0Sim + (realNow() - clk.t0Real) * clk.speed : realNow();
  if (clk) {
    globalThis.Date = class FDate extends RealDate { constructor(...a) { if (a.length === 0) super(simNow()); else super(...a); } static now() { return simNow(); } };
    globalThis.setTimeout = (f, ms, ...a) => ORIG.setTimeout(f, (ms || 0) / speed(), ...a);
    AbortSignal.timeout = ms => ORIG.abortTimeout(Math.max(1, Math.round(ms / speed() / (cfg.abortScale || 1))));
  } else { globalThis.Date = ORIG.Date; globalThis.setTimeout = ORIG.setTimeout; AbortSignal.timeout = ORIG.abortTimeout; }
  const B = cfg.base;
  const phase = () => { if (cfg.fixed) return cfg.fixed; const min = (simNow() - (clk ? clk.t0Sim : 0)) / 60e3; let p = cfg.phases[0]; for (const x of cfg.phases) if (x.from <= min) p = x; return p; };
  const log = ev => { const e = { sim: new RealDate(simNow()).toISOString().slice(11, 19), role: path.basename(process.argv[1] || 'driver'), ...ev }; if (cfg.ws) fs.appendFileSync(path.join(cfg.ws, 'events.jsonl'), JSON.stringify(e) + '\n'); else (cfg.events = cfg.events || []).push(e); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hang = init => new Promise((_, rej) => { const s = init && init.signal, ka = setInterval(() => {}, 1e6); if (s) s.addEventListener('abort', () => { clearInterval(ka); rej(s.reason); }); });   // keepalive: a real stalled socket keeps Node alive too   // no signal => hangs forever (what scrape.mjs' fetch does)
  // In-memory GitHub 'live' branch (lives in the process that owns the loop). Mirrored to <ws>/live/ on every write.
  const gh = cfg.ghStore = cfg.ghStore || {};
  if (cfg.ghSeed) for (const [k, v] of Object.entries(cfg.ghSeed)) gh[k] = { sha: 'seed' + k.length, content: v };
  let shaN = 0, putN = 0, conflictArmed = true;
  const R = (status, body, headers) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  const dropped = cfg.dropped = cfg.dropped || [];

  globalThis.fetch = async (url, init = {}) => {
    url = String(url); const ph = phase(), u = new URL(url), method = init.method || 'GET';
    const lat = ph.latency || 0; if (lat) await sleep(lat);
    if (u.host === 'marx.dance') {
      const file = u.pathname.split('/').pop(), isTT = file === 'timetable.json', mode = isTT ? (ph.marx || 'ok') : (ph.cat || 'ok');
      log({ ev: 'marx', file, mode });
      if (mode === 'hang') return hang(init);
      if (mode === '500') return R(500, 'Internal Server Error');
      if (mode === 'html') return R(200, '<!doctype html><html><body>Cloudflare: error 1015</body></html>', { 'content-type': 'text/html' });
      if (!isTT) return R(200, rawCategory(file));
      const exportedAt = ph.marxDrift ? new RealDate(Math.floor(simNow() / 60e3) * 60e3).toISOString() : undefined;
      const j = rawMarx(B, { exportedAt });
      if (mode === 'truncated') { const s = JSON.stringify(j); return R(200, s.slice(0, Math.floor(s.length * 0.6))); }
      if (mode === 'empty') j.timetable = [];
      if (mode === 'notimetable') delete j.timetable;
      if (mode === 'nofield') j.timetable.forEach(e => { delete e.time; delete e.blockName; });
      if (mode === 'nulltimes') j.timetable.forEach(e => { e.time = null; });
      if (mode === 'nohall') j.timetable.forEach(e => { delete e.hall; });
      if (mode === 'partial') j.timetable = j.timetable.filter(e => e.wdsfId && e.roundNumber).slice(0, ph.keep || 60);
      if (mode === 'dupes') { const first = j.timetable.filter(e => e.wdsfId && e.roundNumber).slice(0, 10); j.timetable.push(...first.map(e => ({ ...e, time: '23:59', state: 'upcoming' }))); }
      if (mode === 'nullentries') j.timetable.splice(5, 0, null, null);
      return R(200, j);
    }
    if (u.host === 'api.github.com') {
      const m = u.pathname.match(/\/contents\/(.+)$/); const file = m && m[1]; const mode = ph.gh || 'ok';
      log({ ev: 'gh', method, file, mode });
      if (mode === 'hang') return hang(init);
      if (mode === '500') return R(500, 'Server Error');
      if (mode === '403' && method !== 'GET') return R(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '60' });
      if (mode === 'getfail' && method === 'GET') return R(500, 'x');
      if (method === 'GET') { const f = gh[file]; return f ? R(200, { sha: f.sha, content: Buffer.from(f.content).toString('base64') }) : R(404, { message: 'Not Found' }); }
      const b = JSON.parse(init.body); const f = gh[file];
      if (mode === '409always') return R(409, { message: 'conflict' });
      if (mode === '409once' && conflictArmed && file === 'live.json') { conflictArmed = false; return R(409, { message: 'conflict' }); }
      if (f && !b.sha) return R(422, { message: 'sha wasn\'t supplied' });
      if (f && b.sha !== f.sha) return R(409, { message: 'does not match' });
      const content = Buffer.from(b.content, 'base64').toString('utf8');
      gh[file] = { sha: 'sha' + (++shaN), content }; putN++;
      let info = {}; try { const j = JSON.parse(content); if (j.r) info = { rounds: Object.keys(j.r).length, cur: Object.values(j.r).filter(x => x[4] === 'c').length, chg: (j.chg || []).length, fetched: j.fetched }; } catch (e) {}
      log({ ev: 'gh-put', file, bytes: content.length, msg: b.message.slice(0, 30), ...info });
      if (cfg.ws) { const fp = path.join(cfg.ws, 'live', file); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, content); }
      return R(200, { content: { sha: gh[file].sha } });
    }
    if (u.host === 'www.worlddancesport.org') {
      const w = ph.wdsf || {}; log({ ev: 'wdsf', path: u.pathname.slice(0, 50) });
      if (w.sched === 'hang' || w.hang) return hang(init);
      const r = wdsfPages(B, ph)(u.pathname);
      return R(r.status, r.body, { 'content-type': 'text/html' });
    }
    if (u.host === 'api.cloudflare.com') {
      log({ ev: 'cf-api', method, path: u.pathname.slice(-40), mode: ph.cfApi || 'ok' });
      if (ph.cfApi === 'hang') return hang(init);
      return R(200, { success: true, result: [] });
    }
    dropped.push(url); log({ ev: 'unexpected-fetch', url });
    throw new TypeError('fetch failed (sim: host not allowed ' + u.host + ')');
  };
  return { phase, simNow, log, sleep };
}

/* fake `npx wrangler pages deploy dist ...`: records WHAT would go live (template marker, content hash) into a shared fake "Cloudflare" store */
async function fakeNpx(cfg) {
  const sim = installStubs({ ...cfg, ghStore: {} });
  const ph = sim.phase(), args = process.argv.slice(2);
  const dist = path.resolve('dist/index.html');
  const html = fs.existsSync(dist) ? fs.readFileSync(dist, 'utf8') : null;
  const ver = fs.existsSync('dist/version.txt') ? fs.readFileSync('dist/version.txt', 'utf8').split('\n') : [];
  const rec = { who: process.env.PIPESIM_WHO || 'loop', args: args.join(' ').slice(0, 60), template: html && (html.match(/TEMPLATE-V\d+/) || [])[0] || null, sha: html && crypto.createHash('sha1').update(html).digest('hex').slice(0, 8), dataFetched: ver[1] || null };
  const dur = ph.npxMs || 0; if (dur) await sim.sleep(dur);
  if (ph.cf === 'hang') { setInterval(() => {}, 1e6); await new Promise(() => {}); }
  if (ph.cf === 'fail') { sim.log({ ev: 'deploy', ...rec, result: 'FAILED' }); console.error('✘ [ERROR] A request to the Cloudflare API failed (sim).'); process.exit(1); }
  sim.log({ ev: 'deploy', ...rec, result: 'ok' });
  if (process.env.PIPESIM_CF_STORE) fs.appendFileSync(process.env.PIPESIM_CF_STORE, JSON.stringify({ sim: new Date().toISOString().slice(11, 19), ...rec }) + '\n');
  console.log('✨ Deployment complete (sim)');
}

if (process.env.PIPESIM_CHILD) {
  const cfg = JSON.parse(fs.readFileSync(process.env.PIPESIM_CFG, 'utf8'));
  cfg.ws = process.env.PIPESIM_WS; cfg.base = JSON.parse(fs.readFileSync(path.join(cfg.ws, 'base.json'), 'utf8'));
  const seed = path.join(cfg.ws, 'ghseed.json'); if (fs.existsSync(seed)) cfg.ghSeed = JSON.parse(fs.readFileSync(seed, 'utf8'));
  if (path.basename(process.argv[1] || '') === 'npx.mjs') await fakeNpx(cfg);
  else installStubs(cfg);
}

/* =====================================================================================================
   PART 2 — driver
   ===================================================================================================== */
const DRIVER = !process.env.PIPESIM_CHILD && path.resolve(process.argv[1] || '') === SELF;
const SPEED = +process.env.SPEED || 30;
const out = [];                                           // observations
const OBS = (sc, msg) => { const l = `OBS[${sc}] ${msg}`; out.push(l); console.log(l); };

function readBase() {
  const f = path.join(REPO, 'data/last.json');
  const B = JSON.parse(fs.readFileSync(f, 'utf8'));
  return B;
}
function mkWs(name, { marker = 'TEMPLATE-V1', prev = true, lastPatch = null, corrupt = false, ghSeed = null } = {}) {
  const ws = path.join(ROOT, name); fs.rmSync(ws, { recursive: true, force: true });
  const rp = path.join(ws, 'repo'); fs.mkdirSync(path.join(rp, 'data'), { recursive: true });
  for (const d of ['scripts', 'assets', 'club']) fs.cpSync(path.join(REPO, d), path.join(rp, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(rp, 'package.json'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(rp, 'node_modules'));
  fs.appendFileSync(path.join(rp, 'assets/template.html'), `\n<!-- ${marker} -->\n`);
  const B = readBase(); fs.writeFileSync(path.join(ws, 'base.json'), JSON.stringify(B));
  if (prev) { const p = { ...B, ...(lastPatch || {}) }; fs.writeFileSync(path.join(rp, 'data/last.json'), JSON.stringify(p)); }
  if (corrupt) fs.writeFileSync(path.join(rp, 'data/last.json'), JSON.stringify(B).slice(0, 4000));
  if (ghSeed) fs.writeFileSync(path.join(ws, 'ghseed.json'), JSON.stringify(ghSeed));
  fs.mkdirSync(path.join(ws, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'bin/npx'), `#!/bin/sh\nexec node "${SELF}" "$@"\n`, { mode: 0o755 });
  // the fake npx must run SELF as a *script named npx*: node sees argv[1]=SELF, so mark it via env instead
  fs.writeFileSync(path.join(ws, 'bin/npx'), `#!/bin/sh\nPIPESIM_NPX=1 exec node --import "${SELF}" "${path.join(ws, 'bin/npx.mjs')}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(ws, 'bin/npx.mjs'), '// fake wrangler; behaviour is in the preload\n');
  return { ws, rp };
}
function writeCfg(ws, { start, phases, speed = SPEED, abortScale = 1 }) {
  const cfg = { clock: { t0Real: ORIG.Date.now(), t0Sim: Date.parse(start), speed }, phases, abortScale };
  const f = path.join(ws, 'cfg.json'); fs.writeFileSync(f, JSON.stringify(cfg)); return f;
}
const envFor = (ws, cfgFile, extra = {}) => ({
  ...process.env, PATH: path.join(ws, 'bin') + ':' + process.env.PATH, PIPESIM_CHILD: '1', PIPESIM_CFG: cfgFile, PIPESIM_WS: ws,
  NODE_OPTIONS: `--import ${SELF}`, GITHUB_REPOSITORY: 'istanbul2026-takip/istanbul2026-takip', GH_TOKEN: 'sim', CLOUDFLARE_API_TOKEN: 'sim', CLOUDFLARE_ACCOUNT_ID: 'sim', ...extra,
});
const events = ws => fs.existsSync(path.join(ws, 'events.jsonl')) ? fs.readFileSync(path.join(ws, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const toSec = t => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };
const gaps = ts => { const s = ts.map(toSec); let best = 0, at = ''; for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > best) { best = s[i] - s[i - 1]; at = ts[i - 1] + '→' + ts[i]; } return { maxGapMin: +(best / 60).toFixed(1), at }; };

function runLoop(ws, rp, cfgFile, { loopMinutes = 40, realTimeoutS = 120, extraEnv = {} } = {}) {
  return new Promise(res => {
    const p = spawn('node', ['scripts/loop.mjs'], { cwd: rp, env: envFor(ws, cfgFile, { LOOP_MINUTES: String(loopMinutes), ...extraEnv }) });
    let so = ''; p.stdout.on('data', d => so += d); p.stderr.on('data', d => so += d);
    let killed = false; const t = ORIG.setTimeout(() => { killed = true; p.kill('SIGKILL'); }, realTimeoutS * 1000);
    p.on('exit', code => { clearTimeout(t); fs.writeFileSync(path.join(ws, 'loop.log'), so); res({ code, killed, log: so, p }); });
    res.proc = p;
  });
}
function runNode(rp, ws, cfgFile, script, env = {}, timeoutS = 60) {
  const r = spawnSync('node', [script], { cwd: rp, env: envFor(ws, cfgFile, env), encoding: 'utf8', timeout: timeoutS * 1000 });
  return { code: r.status, signal: r.signal, out: (r.stdout || '') + (r.stderr || '') };
}
const stdPhases = (extra = {}) => [{ from: 0, marxDrift: true, ...extra }];
const tail = (s, n = 300) => String(s).replace(/\s+/g, ' ').slice(-n);

/* ------------------------------------------------ scenarios ------------------------------------------------ */
const SCENARIOS = {};

// S0: harness fidelity — scrape() against the stub must reproduce data/last.json, otherwise later findings would be artefacts.
SCENARIOS.S0 = async () => {
  const B = readBase(); const cfg = { base: B, phases: [{ from: 0 }], fixed: { wdsf: {} }, clock: { t0Real: ORIG.Date.now(), t0Sim: Date.parse('2026-11-11T12:00:00Z'), speed: 1000 } };
  installStubs(cfg);
  const { scrape } = await import(pathToFileURL(path.join(REPO, 'scripts/scrape.mjs')).href);
  const d = await scrape({ prev: null, withEntries: true });
  const same = k => JSON.stringify(d[k]) === JSON.stringify(B[k]);
  OBS('S0', `harness round-trip of real scrape() vs data/last.json: E ${same('E')} R ${same('R')} P ${same('P')} T ${same('T')} (RK differs by design: only days <= today are fetched: ${Object.keys(d.RK).length} vs ${Object.keys(B.RK).length}) items ${d.E.length}/${B.E.length}, entries ${Object.values(d.P).reduce((n, v) => n + v.length, 0)}`);
};

// S1: marX fault matrix on the REAL fetchMarx() (direct import).
SCENARIOS.S1 = async () => {
  const B = readBase();
  const cfg = { base: B, phases: [{ from: 0 }], fixed: {}, clock: { t0Real: ORIG.Date.now(), t0Sim: Date.parse('2026-11-12T08:00:00Z'), speed: 1 }, abortScale: 20 };
  installStubs(cfg);
  const { fetchMarx, marxKey, marxDiff } = await import(pathToFileURL(path.join(REPO, 'scripts/marx.mjs')).href);
  const ok = await fetchMarx(); const nOk = Object.keys(ok.r).length;
  OBS('S1', `baseline fetchMarx: ${nOk} rounds, ${ok.x.length} other items`);
  for (const [mode, extra] of [['500'], ['hang'], ['html'], ['truncated'], ['empty'], ['notimetable'], ['nofield'], ['nulltimes'], ['nullentries'], ['nohall'], ['dupes'], ['partial', { keep: 60 }], ['partial', { keep: 120 }]]) {
    cfg.fixed = { marx: mode, ...(extra || {}) };
    const t0 = ORIG.Date.now();
    try {
      const r = await fetchMarx(); const rows = Object.values(r.r);
      const halls = [...new Set(rows.map(m => m[1]))].join(',');
      const diff = marxDiff(ok, r).length;
      OBS('S1', `marX=${mode}${extra ? JSON.stringify(extra) : ''}: ACCEPTED ${rows.length} rounds (baseline ${nOk}), halls={${halls}}, diff-vs-baseline ${diff} changes, key ${marxKey(r) === marxKey(ok) ? 'same' : 'different'}${mode === 'dupes' ? ', first dup round now ' + JSON.stringify(Object.entries(r.r).find(([k]) => k === Object.keys(ok.r)[0] || true)) : ''}`);
    } catch (e) { OBS('S1', `marX=${mode}: rejected after ${ORIG.Date.now() - t0}ms (${e.name}: ${e.message.slice(0, 60)})`); }
  }
  cfg.fixed = { marx: 'dupes' }; const d = await fetchMarx(); const k0 = Object.keys(ok.r)[0];
  OBS('S1', `duplicate wdsfId.round: ${k0} baseline ${JSON.stringify(ok.r[k0])} -> with later duplicate at 23:59 ${JSON.stringify(d.r[k0])} (last one silently wins)`);
};

// S2: loop-level marX faults: what reaches live.json and when (event day, daytime).
SCENARIOS.S2 = async () => {
  const { ws, rp } = mkWs('S2');
  const ph = [
    { from: 0, marxDrift: true }, { from: 6, marxDrift: true, marx: '500' }, { from: 12, marxDrift: true, marx: 'html' },
    { from: 16, marxDrift: true, marx: 'truncated' }, { from: 20, marxDrift: true, marx: 'hang' }, { from: 26, marxDrift: true, marx: 'partial', keep: 60 }, { from: 32, marxDrift: true },
  ];
  const cfg = writeCfg(ws, { start: '2026-11-12T07:00:00Z', phases: ph, speed: SPEED });
  const r = await runLoop(ws, rp, cfg, { loopMinutes: 40, realTimeoutS: 150 });
  const ev = events(ws), puts = ev.filter(e => e.ev === 'gh-put' && e.file === 'live.json');
  OBS('S2', `loop exit code ${r.code}${r.killed ? ' (killed by driver timeout)' : ''}; live.json PUTs: ${puts.length}; ${JSON.stringify(gaps(puts.map(p => p.sim)))}`);
  OBS('S2', 'PUT timeline (sim time: rounds): ' + puts.map(p => `${p.sim}:${p.rounds}`).join(' '));
  OBS('S2', 'loop log marX lines: ' + [...new Set(r.log.split('\n').filter(l => /^marX:/.test(l)).map(l => l.slice(0, 70)))].join(' | '));
  const partial = puts.filter(p => p.rounds < 100); OBS('S2', `PUTs with fewer than 100 rounds (real marX has ${Object.keys(readBase().MX.r).length}): ${partial.length} -> ${partial.map(p => p.sim + ':' + p.rounds).join(' ')}`);
};

// S3: GitHub contents API faults.
SCENARIOS.S3 = async () => {
  const { ws, rp } = mkWs('S3');
  const ph = [{ from: 0, marxDrift: true }, { from: 6, marxDrift: true, gh: '409once' }, { from: 10, marxDrift: true, gh: '409always' }, { from: 15, marxDrift: true, gh: '403' }, { from: 20, marxDrift: true, gh: '500' }, { from: 25, marxDrift: true, gh: 'hang' }, { from: 34, marxDrift: true }];
  const cfg = writeCfg(ws, { start: '2026-11-12T07:00:00Z', phases: ph, speed: SPEED });
  const r = await runLoop(ws, rp, cfg, { loopMinutes: 42, realTimeoutS: 200 });
  const ev = events(ws), puts = ev.filter(e => e.ev === 'gh-put' && e.file === 'live.json');
  OBS('S3', `loop exit ${r.code}${r.killed ? ' (killed)' : ''}; live.json PUT ok at: ${puts.map(p => p.sim).join(' ')}`);
  OBS('S3', JSON.stringify(gaps(puts.map(p => p.sim))) + ' (phases: 409once@6 409always@10 403@15 500@20 hang@25-34 ok@34, sim minutes from 10:00 IST)');
  const lg = r.log.split('\n'); const uniq = a => [...new Set(a)];
  OBS('S3', 'failure lines: ' + uniq(lg.filter(l => /push failed|push error|order push|marks push/.test(l)).map(l => l.replace(/\{.*/, '').slice(0, 70))).join(' | '));
  OBS('S3', 'unhandled crash text in log: ' + /Unhandled|TypeError|ReferenceError|at .*\.mjs/.test(r.log));
};

// S4: WDSF faults against the REAL update.mjs (one child per fault, prev = real data/last.json, event day).
SCENARIOS.S4 = async () => {
  const faults = [
    ['baseline', {}], ['schedule page zero rows', { sched: 'zero' }], ['captcha/HTML on every page, HTTP 200', { captcha: 1 }], ['HTTP 503 everywhere', { sched: '503' }],
    ['per-competition Schedule pages return 200 maintenance HTML', { compSchedule: 'html' }], ['per-competition Schedule pages 404', { compSchedule: '404' }],
    ['group schedule: 1 in 12 day-12 rows missing (8%)', { dropSched: 12 }], ['group schedule: 1 in 5 day-12 rows missing (20%)', { dropSched: 5 }],
    ['participants: every list cut to half (FULL=1)', { participants: 'half' }, { FULL: '1' }], ['participants: every list empty (FULL=1)', { participants: 'zero' }, { FULL: '1' }],
    ['team pages 404 (FULL=1)', { teams: '404' }, { FULL: '1' }], ['ranking tables empty', { ranking: 'empty' }], ['ranking tables cut to 1 row', { rankingRows: 1 }],
  ];
  const B = readBase();
  for (const [name, w, env] of faults) {
    const nm = 'S4-' + name.replace(/\W+/g, '').slice(0, 14);
    const { ws, rp } = mkWs(nm, { lastPatch: { _hash: 'x', _lastDeployAt: 0 } });
    const cfg = writeCfg(ws, { start: '2026-11-12T08:30:00Z', phases: [{ from: 0, wdsf: w }], speed: 1 });
    const r = runNode(rp, ws, cfg, 'scripts/update.mjs', { EVENT_NAME: 'loop', ...(env || {}) });
    const last = JSON.parse(fs.readFileSync(path.join(rp, 'data/last.json'), 'utf8'));
    const emptyR = Object.values(last.R).filter(v => !v.length).length;
    const nP = Object.values(last.P).reduce((n, v) => n + v.length, 0), nB = Object.values(B.P).reduce((n, v) => n + v.length, 0);
    const emptyT = Object.values(last.T).reduce((n, v) => n + v.filter(m => !m.length).length, 0), emptyTb = Object.values(B.T).reduce((n, v) => n + v.filter(m => !m.length).length, 0);
    const dep = /deploy: true/.test(r.out), built = fs.existsSync(path.join(rp, 'dist/index.html'));
    const wrote = last._hash !== 'x';
    OBS('S4', `${name}: exit ${r.code}${r.signal ? ' ' + r.signal : ''} | ${r.code === 0 ? `deploy=${dep} built=${built} cacheRewritten=${wrote} | R empty:${emptyR}/${Object.keys(last.R).length} entries:${nP}(was ${nB}) emptyTeamRows:${emptyT}(was ${emptyTb}) RK:${Object.keys(last.RK).length}(was ${Object.keys(B.RK).length}) E:${last.E.length}(was ${B.E.length})` : 'FAILED: ' + tail(r.out, 140)}`);
  }
};

// S5: no timeouts: WDSF hang / wrangler hang / Cloudflare API hang inside the loop => the 1-minute marX feed freezes (spawnSync blocks the event loop).
SCENARIOS.S5 = async () => {
  const CASES = [
    ['wdsf-hang', 'WDSF never answers (scrape.mjs fetch has no timeout; with the real undici default ~300 s per try x3 tries the stall is still >= 15 min per request)', { wdsf: { hang: 1 } }],
    ['wrangler-hang', 'wrangler deploy never returns (first hang = the 29-min heartbeat deploy at ~07:29)', { cf: 'hang' }],
    ['cleanup-api-hang', 'Cloudflare list-deployments never answers after a good deploy (cleanup.mjs has no timeout)', { cfApi: 'hang' }],
    ['wrangler-60s', 'wrangler needs 60 sim seconds (cold `npx --yes wrangler@3` download) on every deploy: not a hang, just slow', { npxMs: 60000 }],
  ];
  for (const [name, why, ph] of CASES.filter(c => !process.env.S5_CASES || process.env.S5_CASES.split(',').includes(c[0]))) {
    const { ws, rp } = mkWs('S5-' + name, { lastPatch: { _hash: 'old', _lastDeployAt: Date.parse('2026-11-12T06:39:30Z') } });   // heartbeat due ~07:08; round 1 (07:00) deploys too ('old' hash)
    const phases = [{ from: 0, marxDrift: true }, { from: name === 'wrangler-60s' ? 0 : 5, marxDrift: true, ...ph }];   // fault starts at sim min 5, after round 1 has deployed; next deploy is the 29-min heartbeat (~07:29)
    const cfg = writeCfg(ws, { start: '2026-11-12T07:00:00Z', phases, speed: SPEED });
    const REAL_S = Math.round(52 * 60 / SPEED), t0 = ORIG.Date.now();
    const r = await runLoop(ws, rp, cfg, { loopMinutes: 90, realTimeoutS: REAL_S });
    const simKill = Date.parse('2026-11-12T07:00:00Z') + (ORIG.Date.now() - t0) * SPEED;
    const ev = events(ws), puts = ev.filter(e => e.ev === 'gh-put' && e.file === 'live.json');
    const lastPut = puts.length ? puts[puts.length - 1].sim : null, stuckMin = lastPut ? ((simKill - Date.parse('2026-11-12T' + lastPut + 'Z')) / 60e3) : null;
    const g = gaps(puts.map(p => p.sim));
    OBS('S5', `${name} [${why}]: loop ${r.killed ? 'did not return within ' + REAL_S + ' real s (killed by driver at sim ' + new Date(simKill).toISOString().slice(11, 19) + ')' : 'ended by itself, exit ' + r.code}; live.json PUTs ${puts.length}, last at ${lastPut}; ${r.killed ? '' + (stuckMin == null ? 'no live.json PUT at all' : 'no live.json PUT for the last ' + stuckMin.toFixed(1) + ' sim min') + '; ' : ''}largest gap between PUTs ${JSON.stringify(g)}; deploys seen: ${ev.filter(e => e.ev === 'deploy').map(e => e.sim + '/' + e.result).join(' ')}`);
  }
};

// S6: (i)/(ii) template overwrite. The loop checked out V1 at start; V2 is pushed to main; the 'Update site' workflow deploys V2; what does the loop deploy next?
// The repo is a SCRATCH git repo (local bare remote under /tmp/pipesim, shallow depth-1 clone like actions/checkout) so the real `git pull --ff-only origin main` in loop.mjs runs for real.
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=sim', '-c', 'user.email=sim@sim', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
function mkGitWs(name, { oldLoop = false, lastPatch }) {
  const { ws, rp } = mkWs(name, { marker: 'TEMPLATE-V1', lastPatch });         // reuse: bin/, base.json, last.json, cfg
  const seed = path.join(ws, 'seed'), remote = path.join(ws, 'remote.git');
  fs.mkdirSync(seed); for (const d of ['scripts', 'assets', 'club']) fs.cpSync(path.join(rp, d), path.join(seed, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(seed, 'package.json')); fs.copyFileSync(path.join(REPO, '.gitignore'), path.join(seed, '.gitignore'));
  if (oldLoop) fs.writeFileSync(path.join(seed, 'scripts/loop.mjs'), spawnSync('git', ['show', '999fef6:scripts/loop.mjs'], { cwd: REPO, encoding: 'utf8' }).stdout);   // loop.mjs as it was before fa555e9 (read-only git show)
  git(seed, 'init', '-q', '-b', 'main'); git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'v1');
  git(ws, 'clone', '-q', '--bare', seed, remote);
  const dataBak = fs.readFileSync(path.join(rp, 'data/last.json')); fs.rmSync(rp, { recursive: true, force: true });
  const c = git(ws, 'clone', '-q', '--depth', '1', 'file://' + remote, rp);   // like actions/checkout: shallow, branch main
  fs.mkdirSync(path.join(rp, 'data')); fs.writeFileSync(path.join(rp, 'data/last.json'), dataBak); fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(rp, 'node_modules'));
  return { ws, rp, remote, cloneOut: c.stderr };
}
function pushV2(g, { force = false } = {}) {            // somebody pushes a new template to main (to the scratch remote only)
  const pu = path.join(g.ws, 'pusher'); fs.rmSync(pu, { recursive: true, force: true });
  git(g.ws, 'clone', '-q', 'file://' + g.remote, pu);
  const t = path.join(pu, 'assets/template.html'); fs.writeFileSync(t, fs.readFileSync(t, 'utf8').replace('TEMPLATE-V1', 'TEMPLATE-V2'));
  if (force) { git(pu, 'reset', '-q', '--hard', 'HEAD~0'); fs.writeFileSync(path.join(pu, 'x.txt'), 'rewrite'); git(pu, 'add', '-A'); git(pu, 'commit', '-q', '--amend', '-m', 'v1 amended'); fs.writeFileSync(t, fs.readFileSync(t, 'utf8')); git(pu, 'add', '-A'); git(pu, 'commit', '-q', '--amend', '-m', 'v2 rewritten'); return git(pu, 'push', '-q', '-f', 'origin', 'main'); }
  git(pu, 'add', '-A'); git(pu, 'commit', '-qm', 'v2'); return git(pu, 'push', '-q', 'origin', 'main');
}
async function s6variant(tag, { oldLoop, actions, updateYmlDeploys, force }) {
  const store = path.join(ROOT, `S6${tag}-cf-store.jsonl`); fs.rmSync(store, { force: true });
  const g = mkGitWs('S6' + tag, { oldLoop, lastPatch: { _hash: 'old', _lastDeployAt: Date.parse('2026-11-12T06:50:00Z') } });
  const cfg = writeCfg(g.ws, { start: '2026-11-12T07:00:00Z', phases: stdPhases(), speed: SPEED });
  const env = { PIPESIM_CF_STORE: store, ...(actions ? { GITHUB_ACTIONS: 'true' } : {}) };
  const loopP = runLoop(g.ws, g.rp, cfg, { loopMinutes: 48, realTimeoutS: 160, extraEnv: env });
  await new Promise(r => ORIG.setTimeout(r, 8 * 60e3 / SPEED));        // sim minute ~8
  const pr = pushV2(g, { force });
  let upd = '';
  if (updateYmlDeploys) {                                               // 'Update site' (event=push) = fresh checkout of main = V2, then wrangler
    const U = mkWs('S6' + tag + 'u', { marker: 'TEMPLATE-V2' }); fs.copyFileSync(cfg, path.join(U.ws, 'cfg.json'));
    const u = runNode(U.rp, U.ws, path.join(U.ws, 'cfg.json'), 'scripts/update.mjs', { EVENT_NAME: 'push', GITHUB_OUTPUT: '' });
    const d = spawnSync('npx', ['--yes', 'wrangler@3.114.17', 'pages', 'deploy', 'dist'], { cwd: U.rp, env: envFor(U.ws, path.join(U.ws, 'cfg.json'), { ...env, PIPESIM_WHO: 'update.yml(V2)' }), encoding: 'utf8' });
    upd = ` update.yml-equivalent: exit ${u.code}/${d.status};`;
  }
  const r = await loopP;
  const dl = fs.existsSync(store) ? fs.readFileSync(store, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  const pull = r.log.split('\n').filter(l => /git pull/.test(l)).slice(0, 2).join(' | ');
  OBS('S6' + tag, `[${tag}] push of V2 to scratch main: ${pr.status === 0 ? 'ok' : 'FAILED ' + tail(pr.stderr)};${upd} loop code=${oldLoop ? 'BEFORE fa555e9 (no pull)' : 'fa555e9 (git pull per round)'}; GITHUB_ACTIONS=${actions ? 1 : 'unset'}${pull ? '; loop says: ' + pull : ''}`);
  OBS('S6' + tag, `[${tag}] Cloudflare history (template read from the uploaded dist/index.html): ` + dl.map(d => `${d.sim} ${d.who} ${d.template}`).join('  →  '));
  const lastT = dl[dl.length - 1] && dl[dl.length - 1].template, firstV2 = dl.find(d => d.template === 'TEMPLATE-V2');
  OBS('S6' + tag, `[${tag}] FINAL production template = ${lastT}; V2 first live at ${firstV2 ? firstV2.sim + ' (' + firstV2.who + ')' : 'NEVER within 48 sim min'}; loop exit ${r.code}${r.killed ? ' killed' : ''}; working tree template in loop checkout: ${(fs.readFileSync(path.join(g.rp, 'assets/template.html'), 'utf8').match(/TEMPLATE-V\d/) || [])[0]}`);
}
SCENARIOS.S6 = async () => {
  await Promise.all([
    s6variant('A', { oldLoop: true, actions: true, updateYmlDeploys: true }),
    s6variant('B', { oldLoop: false, actions: true, updateYmlDeploys: true }),
  ]);
  await Promise.all([
    s6variant('C', { oldLoop: false, actions: true, updateYmlDeploys: false }),
    s6variant('D', { oldLoop: false, actions: true, updateYmlDeploys: true, force: true }),
  ]);
  const wf = f => fs.readFileSync(path.join(REPO, '.github/workflows', f), 'utf8');
  OBS('S6', `concurrency groups: loop.yml=${(wf('loop.yml').match(/group:\s*(\S+)/) || [])[1]}  update.yml=${(wf('update.yml').match(/group:\s*(\S+)/) || [])[1]}  (different groups => no mutual exclusion; no script locks or compares versions on Cloudflare)`);
  const stepIf = wf('update.yml').match(/Publish to Cloudflare Pages[\s\S]*?if:\s*(.*)\n[\s\S]*?env:\n\s*CF_TOKEN:/);
  OBS('S6', `update.yml publish step reads \`env.CF_TOKEN\` in its own \`if:\` while CF_TOKEN is defined only in that step's env: ${stepIf ? 'yes (finding F2; NOT executed here, GitHub expression semantics are not testable offline)' : 'pattern not found'}`);
};

// S7: failed deploy is remembered as deployed (data/last.json is written before the deploy).
SCENARIOS.S7 = async () => {
  const { ws, rp } = mkWs('S7', { lastPatch: { _hash: 'old', _lastDeployAt: 0 } });
  const ph = [{ from: 0, marxDrift: true, cf: 'fail' }, { from: 12, marxDrift: true }];
  const cfg = writeCfg(ws, { start: '2026-11-12T07:00:00Z', phases: ph, speed: SPEED });
  const r = await runLoop(ws, rp, cfg, { loopMinutes: 45, realTimeoutS: 120 });
  const dep = events(ws).filter(e => e.ev === 'deploy');
  OBS('S7', `wrangler fails until sim min 12 then works. Deploy attempts (sim time/result): ${dep.map(d => d.sim + '/' + d.result).join(' ')}`);
  OBS('S7', 'loop log: ' + r.log.split('\n').filter(l => /publish|deploy:|changed:/.test(l)).slice(0, 8).map(l => l.slice(0, 90)).join(' | '));
  OBS('S7', `=> after the failed attempt the next try came ${dep.length > 1 ? 'at ' + dep[1].sim : 'NEVER within 45 sim min'} (heartbeat is 29 min on event days after 07:00 IST; 20 h otherwise)`);
};

// S8: data/last.json corrupt or missing.
SCENARIOS.S8 = async () => {
  for (const [name, opt] of [['corrupt', { corrupt: true }], ['missing', { prev: false }]]) {
    const { ws, rp } = mkWs('S8-' + name, opt);
    const cfg = writeCfg(ws, { start: '2026-11-12T07:00:00Z', phases: stdPhases(), speed: SPEED });
    const t0 = ORIG.Date.now();
    const r = await runLoop(ws, rp, cfg, { loopMinutes: 30, realTimeoutS: 100 });
    const ev = events(ws), puts = ev.filter(e => e.ev === 'gh-put' && e.file === 'live.json'), dep = ev.filter(e => e.ev === 'deploy');
    OBS('S8', `last.json ${name}: loop exit ${r.code} after ${Math.round((ORIG.Date.now() - t0) / 1000)} real s; rounds run ${(r.log.match(/— round/g) || []).length}; deploys ${dep.length}; live.json PUTs ${puts.length}; ${r.log.includes('3 checks in a row failed') ? 'loop gave up (process.exit(1)) => live feed stops until a new run starts' : ''}; first error: ${tail((r.log.match(/SyntaxError[^\n]*|Error:[^\n]*/) || [''])[0], 100)}`);
  }
};

// S9: slow marX category files delay the timetable push (pushOrder is awaited before live.json is pushed), plus first-push delay at start-up.
SCENARIOS.S9 = async () => {
  for (const [name, ph] of [['categories-ok', {}], ['categories-hang', { cat: 'hang' }], ['categories-500', { cat: '500' }]]) {
    const { ws, rp } = mkWs('S9-' + name);
    const cfg = writeCfg(ws, { start: '2026-11-12T07:00:00Z', phases: [{ from: 0, marxDrift: true, ...ph }], speed: SPEED });
    const r = await runLoop(ws, rp, cfg, { loopMinutes: 25, realTimeoutS: 100 });
    const ev = events(ws), puts = ev.filter(e => e.ev === 'gh-put' && e.file === 'live.json'), first = ev[0] && ev[0].sim;
    OBS('S9', `${name}: first event ${first}; live.json PUTs ${puts.length} at ${puts.map(p => p.sim).join(' ')}; ${JSON.stringify(gaps(puts.map(p => p.sim)))}; order.json PUTs ${ev.filter(e => e.ev === 'gh-put' && e.file === 'order.json').length}; sc/* PUTs ${ev.filter(e => e.ev === 'gh-put' && /^sc\//.test(e.file)).length}`);
  }
};

// S10: start-up gap of a fresh run (what a cancelled-and-restarted loop looks like): time until first live.json PUT.
SCENARIOS.S10 = async () => {
  for (const [name, ph] of [['fast scrape, no deploy needed', { }], ['1.5 s latency per request (WDSF+marX) + 40 s npx download/deploy', { latency: 1500, npxMs: 40000 }]]) {
    const { ws, rp } = mkWs('S10-' + name.slice(0, 4).replace(/\W/g, ''), { lastPatch: { _hash: 'old', _lastDeployAt: 0 } });
    const cfg = writeCfg(ws, { start: '2026-11-12T07:00:00Z', phases: [{ from: 0, marxDrift: true, ...ph }], speed: SPEED });
    const r = await runLoop(ws, rp, cfg, { loopMinutes: 12, realTimeoutS: 60 });
    const ev = events(ws), puts = ev.filter(e => e.ev === 'gh-put' && e.file === 'live.json');
    OBS('S10', `${name}: loop started at sim ${ev[0] && ev[0].sim}; first live.json PUT at sim ${puts[0] && puts[0].sim} (this excludes runner queue, checkout, npm ci, cache restore)`);
  }
  OBS('S10', 'by reading: round 1 (scripts/update.mjs + optional wrangler via spawnSync) runs BEFORE the first pushLive(), so every restart delays the feed by (scrape time + deploy time).');
};

// S11: clock crossing midnight Istanbul.
SCENARIOS.S11 = async () => {
  const B = readBase();
  const cfg = { base: B, phases: [{ from: 0 }], fixed: {}, clock: { t0Real: ORIG.Date.now(), t0Sim: Date.parse('2026-11-12T20:55:00Z'), speed: 1 } };
  installStubs(cfg);
  const { dueCategories } = await import(pathToFileURL(path.join(REPO, 'scripts/order.mjs')).href);
  const { fetchMarx } = await import(pathToFileURL(path.join(REPO, 'scripts/marx.mjs')).href);
  const mx = await fetchMarx(); const day12 = Object.entries(mx.r).filter(([, m]) => m[0] === 11);
  const mx2 = { r: Object.fromEntries(day12.map(([k, m]) => [k, [...m.slice(0, 4), 'd']])), cat: { 1: 'c1' } };  // a category whose rounds are all done, on day 11
  const k = Object.keys(mx2.r)[0].split('.')[0]; mx2.cat = { [k]: 'c' + k };
  const last = { [k]: Date.now() - 6 * 60e3 };
  const before = dueCategories(mx2, last, Date.now(), 11).length, after = dueCategories(mx2, last, Date.now(), 12).length;
  OBS('S11', `finished day-11 category last read 6 min ago: due at 23:55 IST (todayDay=11) = ${before}; due at 00:05 IST (todayDay=12) = ${after} (refresh interval drops from 5 min to 20 min exactly when late finals publish results after midnight)`);
  // scrape(): rounds/rankings of a competition whose WDSF day is yesterday are frozen from prev after midnight
  const { scrape } = await import(pathToFileURL(path.join(REPO, 'scripts/scrape.mjs')).href);
  const id = Object.keys(B.RK)[0], day = B.E.find(e => e[5] === +id)[0];
  const prev = JSON.parse(JSON.stringify(B)); prev.RK[id] = prev.RK[id].slice(0, 1);
  cfg.clock.t0Sim = Date.parse(`2026-11-${String(day).padStart(2, '0')}T21:30:00Z`);   // 00:30 IST of day+1
  cfg.fixed = { wdsf: {} };
  const d = await scrape({ prev, withEntries: false });
  OBS('S11', `comp ${id} (WDSF day ${day}) at 00:30 IST of day ${day + 1}: ranking rows in prev=1, on WDSF=${B.RK[id].length}, published=${(d.RK[id] || []).length} (${(d.RK[id] || []).length < B.RK[id].length ? 'STALE: day<today => frozen' : 'fresh'})`);
  // loop crossing 21:00Z
  const { ws, rp } = mkWs('S11-loop', { lastPatch: { _hash: 'old', _lastDeployAt: 0 } });
  const cf2 = writeCfg(ws, { start: '2026-11-12T20:40:00Z', phases: stdPhases(), speed: SPEED });
  const r = await runLoop(ws, rp, cf2, { loopMinutes: 45, realTimeoutS: 100 });
  const rounds = [...r.log.matchAll(/— round (\d+) · (\S+)/g)].map(m => m[1] + '@' + m[2].slice(11, 19));
  OBS('S11', `loop 23:40→00:25 IST: round start times (sim UTC): ${rounds.join(' ')} (3-min cadence before 00:00 IST, 10-min after); exit ${r.code}`);
};

// S13: one malformed element in a marX category file (marks) discards that category's running order and judges as well.
SCENARIOS.S13 = async () => {
  const B = readBase();
  const cfg = { base: B, phases: [{ from: 0 }], fixed: {}, clock: { t0Real: ORIG.Date.now(), t0Sim: Date.parse('2026-11-12T08:00:00Z'), speed: 1 } };
  installStubs(cfg);
  const base = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (String(u).includes('/c67345.json')) return new Response(JSON.stringify({ ...rawCategory('c67345'), dr: { r1: { sajs: { p: [{ sn: 1, ts: 5, drs: [null] }] } } } })); return base(u, i); };
  const { fetchMarx } = await import(pathToFileURL(path.join(REPO, 'scripts/marx.mjs')).href);
  const { refreshOrder } = await import(pathToFileURL(path.join(REPO, 'scripts/order.mjs')).href);
  const mx = await fetchMarx(); const store = {}, last = {}, sc = {}, msgs = [];
  const ch = await refreshOrder(mx, store, last, 12, (...a) => msgs.push(a.join(' ')), sc);
  OBS('S13', `categories refreshed: ${Object.keys(store).length} in store of ${Object.keys(mx.cat).length}; category c67345 (valid heats/judges but one null in marks) in store: ${!!store['67345']}; last-read recorded for it: ${last['67345'] != null}; log: ${msgs.join(' | ').slice(0, 140)}`);
  const n1 = Object.keys(store).length; const msgs2 = []; await refreshOrder(mx, store, last, 12, (...a) => msgs2.push(a.join(' ')), sc);
  OBS('S13', `second pass (one minute later): errors again on the next pass: ${msgs2.length} (no back-off: a failing category is retried on every pass)`);
};

// S14: build fails AFTER data/last.json was rewritten: the next round says "deploy: false" and exits 0 (failure counter reset).
SCENARIOS.S14 = async () => {
  const { ws, rp } = mkWs('S14', { lastPatch: { _hash: 'old', _lastDeployAt: 0 } });
  fs.appendFileSync(path.join(rp, 'assets/template.html'), '\n<!--/*IMGZ*/-->\n');       // buildPage throws 'template placeholder left unfilled'
  const cfg = writeCfg(ws, { start: '2026-11-12T07:00:00Z', phases: [{ from: 0 }], speed: 1 });
  const r1 = runNode(rp, ws, cfg, 'scripts/update.mjs', { EVENT_NAME: 'loop' }), r2 = runNode(rp, ws, cfg, 'scripts/update.mjs', { EVENT_NAME: 'loop' });
  const pick = o => (o.match(/Error: [^\n]*/) || o.match(/deploy: \w+/) || [''])[0];
  OBS('S14', `round 1 (build breaks): exit ${r1.code}, ${pick(r1.out)}; round 2 (nothing changed on WDSF): exit ${r2.code}, ${(r2.out.match(/changed: .*/) || [''])[0]}; dist/index.html exists: ${fs.existsSync(path.join(rp, 'dist/index.html'))}`);
  OBS('S14', 'loop.mjs counts consecutive non-zero exits: 1 then 0 => counter reset, nothing is retried, nothing alarms; the broken build is never re-attempted until data changes or the 29-min heartbeat.');
};

/* ------------------------------------------------ static scan ------------------------------------------------ */
SCENARIOS.S12 = async () => {
  const files = fs.readdirSync(path.join(REPO, 'scripts')).filter(f => /^(loop|update|scrape|marx|order|club|build|cleanup)\.mjs$/.test(f));
  for (const f of files) {
    const L = fs.readFileSync(path.join(REPO, 'scripts', f), 'utf8').split('\n');
    L.forEach((l, i) => {
      if (/spawnSync\(/.test(l) && !/timeout/.test(l)) OBS('S12', `${f}:${i + 1} spawnSync without timeout (blocks the whole event loop incl. the live feed)`);
      if (/[^.]fetch\(/.test(l) && !/AbortSignal|signal/.test(l) && !/^\s*\/\//.test(l) && !/async function/.test(l)) {
        const ctx = L.slice(i, i + 4).join(' '); if (!/signal:/.test(ctx)) OBS('S12', `${f}:${i + 1} fetch without signal/timeout`);
      }
      if (/process\.exit\(/.test(l)) OBS('S12', `${f}:${i + 1} process.exit: ${l.trim().slice(0, 90)}`);
      if (/JSON\.parse\(/.test(l)) OBS('S12', `${f}:${i + 1} JSON.parse${/try|catch/.test(l) || /try/.test(L[i - 1] || '') ? ' (guarded)' : ''}: ${l.trim().slice(0, 80)}`);
    });
  }
};

if (DRIVER) {
  fs.mkdirSync(ROOT, { recursive: true });
  const want = process.argv.slice(2), names = want.length ? want : Object.keys(SCENARIOS);
  // S1/S0/S11 install stubs inside the driver process (global fetch): run them last and alone
  const heavy = names.filter(n => !['S0', 'S1', 'S11', 'S12', 'S13'].includes(n)), light = names.filter(n => ['S12', 'S0', 'S1', 'S11', 'S13'].includes(n));
  for (const n of [...heavy, ...light]) {
    console.log(`\n===== ${n} =====`);
    try { await SCENARIOS[n](); } catch (e) { console.log('SCENARIO ERROR', n, e.stack); out.push(`SCENARIO ERROR ${n} ${e.message}`); }
  }
  fs.writeFileSync(path.join(ROOT, 'results.txt'), out.join('\n') + '\n');
  console.log('\nresults written to ' + path.join(ROOT, 'results.txt'));
  process.exit(0);
}
