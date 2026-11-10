// Preload for testing scripts/loop.mjs: fake GitHub + marX, time runs 2000x faster.
import fs from 'fs';
const base = JSON.parse(fs.readFileSync('/tmp/t/marx-raw.json', 'utf8'));
const realNow = Date.now.bind(Date), t0 = realNow();
Date.now = () => t0 + (realNow() - t0) * 2000;
const st = globalThis.setTimeout;
globalThis.setTimeout = (f, ms, ...a) => st(f, Math.max(1, (ms || 0) / 2000), ...a);
let file = { sha: 's0', json: JSON.parse(fs.readFileSync('/tmp/t/marx-now.json', 'utf8')) };   // old format, no chg
let marxCalls = 0, getCalls = 0; const puts = [];
const scen = process.env.SCEN || 'a';
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const res = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (url.includes('marx.dance')) {
    marxCalls++;
    const j = JSON.parse(JSON.stringify(base));
    const rounds = j.timetable.filter(e => e && e.wdsfId && e.roundNumber);
    const bump = (i, min) => { const [h, m] = rounds[i].time.split(':').map(Number); const t = h * 60 + m + min; rounds[i].time = String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
    if (marxCalls >= 3 && marxCalls < 6) { bump(0, 7); bump(1, 7); bump(2, 7); j.exportedAt = 'e2'; }
    if (marxCalls >= 6) { j.exportedAt = 'e3'; }
    if (marxCalls >= 8) { bump(5, 15); j.exportedAt = 'e4'; }
    if (marxCalls === 4) throw new Error('marX down (test)');
    return res(200, j);
  }
  if (url.includes('api.github.com')) {
    if ((init.method || 'GET') === 'GET') {
      getCalls++;
      if (scen === 'b' && getCalls === 1) return res(500, {});      // first read fails: history must still survive
      return res(200, { sha: file.sha, content: Buffer.from(JSON.stringify(file.json)).toString('base64') });
    }
    const b = JSON.parse(init.body);
    if (b.sha !== file.sha) return res(b.sha ? 409 : 422, { message: 'sha' });
    if (scen === 'c' && puts.length === 1 && !globalThis.__failed) { globalThis.__failed = 1; return res(502, { message: 'bad gateway' }); }
    file = { sha: 's' + (puts.length + 1), json: JSON.parse(Buffer.from(b.content, 'base64').toString('utf8')) };
    puts.push({ chg0: file.json.chg0, msg: b.message.replace(/ \d{4}-.*/, ''), chg: file.json.chg, nr: Object.keys(file.json.r).length });
    return res(200, { content: { sha: file.sha } });
  }
  throw new Error('unexpected fetch ' + url);
};
process.on('exit', () => fs.writeFileSync('/tmp/t/mock-out-' + scen + '.json', JSON.stringify({ marxCalls, getCalls, puts, final: file.json.chg })));
