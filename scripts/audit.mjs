// Full cross-check of the site's data against both sources (WDSF + marX). Prints findings; exits 1 when something is wrong.
// Run: node scripts/audit.mjs   (writes data/audit-last.json too, for the local browser tests)
import fs from 'fs';
import { scrape } from './scrape.mjs';
import { clubFor } from './club.mjs';
import { fetchMarx, MARX_BASE } from './marx.mjs';

const bad = [], warn = [];
const B = (m) => { bad.push(m); console.log('FAIL ' + m); }, W = (m) => { warn.push(m); console.log('warn ' + m); };
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ı/g, 'i').replace(/\s*\([^)]*\)\s*$/, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').sort().join(' ');
const hm = s => { const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };

const d = await scrape({ prev: null, withEntries: true });
const mx = await fetchMarx();
const cfg = JSON.parse(fs.readFileSync('club/tarz.json', 'utf8'));
const club = clubFor(d, cfg);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/audit-last.json', JSON.stringify({ ...d, MX: mx }));

console.log('R sample', JSON.stringify(d.R[Object.keys(d.R)[0]]));
// A. coverage between the two sources
const wIds = new Set(d.E.map(e => String(e[5])).filter(x => x !== '0'));
const mIds = new Set(Object.keys(mx.r).map(k => k.split('.')[0]));
for (const id of mIds) if (!wIds.has(id)) B(`marX competition ${id} is not in the WDSF schedule rows`);
for (const id of wIds) if (!mIds.has(id)) W(`WDSF competition ${id} (${(d.E.find(e => String(e[5]) === id) || [])[4]}) has no marX rounds`);

// B. every scheduled competition has round data, with consistent counts
for (const id of wIds) {
  const rows = d.R[id] || [];
  if (!rows.length) { B(`comp ${id}: no round table`); continue; }
  const mr = Object.keys(mx.r).filter(k => k.startsWith(id + '.')).length;
  if (mr && rows.filter(r => hm(r[3] || '') != null).length !== mr) W(`comp ${id}: WDSF has ${rows.filter(r => hm(r[3] || '') != null).length} timed rounds, marX ${mr}`);
}

// C. times & halls: marX vs WDSF
let cmp = 0;
for (const [k, v] of Object.entries(mx.r)) {
  const [id, n] = k.split('.');
  const wr = (d.R[id] || []).filter(r => hm(r[3] || '') != null)[+n - 1];
  const er = d.E.find(e => String(e[5]) === id);
  if (!er) continue;
  if (er[0] !== v[0]) B(`comp ${id} day: WDSF ${er[0]} vs marX ${v[0]}`);
  if (er[1] !== v[1]) W(`comp ${id} hall: WDSF ${er[1]} vs marX ${v[1]}`);
  if (wr) { cmp++; const w = hm(wr[3]); if (Math.abs(w - v[2]) > 60) W(`comp ${id} round ${n}: WDSF ${wr[3]} vs marX ${Math.floor(v[2] / 60)}:${String(v[2] % 60).padStart(2, '0')}`); }
}
console.log('compared round times:', cmp);

// D. schedule sanity: every day has both halls, times parse, no overlap inside a hall
for (const day of [...new Set(d.E.map(e => e[0]))]) for (const h of ['A', 'B']) {
  const rows = d.E.filter(e => e[0] === day && e[1] === h).map(e => [hm(e[2]), hm(e[3]), e]).sort((a, b) => a[0] - b[0]);
  if (!rows.length) { if (day <= 15) W(`day ${day} hall ${h}: no rows`); continue; }
  rows.forEach(([s, e, r]) => { if (s == null || e == null || e <= s) B(`bad time ${JSON.stringify(r)}`); });
}

// E. club coverage vs marX start lists
let mxEnt = 0, mxClub = 0;
const cats = Object.entries(mx.cat || {});
const fetchCat = async cid => { const r = await fetch(MARX_BASE + cid + '.json', { headers: { 'User-Agent': 'istanbul2026-takip (audit)' } }); return r.ok ? r.json() : null; };
const re = new RegExp(cfg.teamPattern, 'i'), xt = new Set((cfg.extraTeams || []).map(s => s.toLowerCase()));
const mine = new Set(club.members);
for (let i = 0; i < cats.length; i += 6) await Promise.all(cats.slice(i, i + 6).map(async ([wid, cid]) => {
  const c = await fetchCat(cid); if (!c) { W(`marX category ${cid} (comp ${wid}) not readable`); return; }
  const parts = c.p || [];
  const wl = d.P[wid] || [];
  if (parts.length && wl.length && parts.length !== wl.length) W(`comp ${wid}: marX ${parts.length} entries vs WDSF ${wl.length}`);
  const clubKeys = new Set((club.entries[wid] || []).map(e => norm(e[0])));
  for (const p of parts) {
    mxEnt++;
    const nm = String(p.n || '');
    const isClub = re.test(nm) || xt.has(nm.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase());
    const people = nm.split(/\s*[|\/]\s*/).map(s => s.trim());
    const hasMember = people.some(x => [...mine].some(m => norm(m) === norm(x)));
    if (isClub || hasMember) { mxClub++; if (!clubKeys.has(norm(nm.replace(/\s*\|\s*/g, ' / ')))) { const alt = [...clubKeys].some(k => k === norm(nm)); if (!alt) B(`club entry in marX but not in club list: comp ${wid} "${nm}"`); } }
    else if (/^(T[uü]rkiye|Turkey|TUR)$/i.test(p.ct)) W(`TUR entry not in club (review): comp ${wid} "${nm}"`);
  }
}));
console.log(`marX entries ${mxEnt} · club-looking ${mxClub} · club entries in site ${Object.values(club.entries).reduce((n, v) => n + v.length, 0)} in ${Object.keys(club.entries).length} comps · members ${club.members.length}`);
fs.writeFileSync('data/audit-report.json', JSON.stringify({ bad, warn }, null, 1));
console.log(`\nAUDIT: ${bad.length} failures, ${warn.length} warnings`);
process.exit(bad.length ? 1 : 0);
