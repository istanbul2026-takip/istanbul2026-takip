// Running order (heats) and judges, from the organiser's per-category files (marX).
// marX publishes <categoryId>.json next to timetable.json; the viewer's category page reads the same file.
// Nothing is corrected here: the order is shown as marX publishes it, and appears once marX has published it.
import { MARX_BASE } from './marx.mjs';


// One category file -> the small form phones download.
//   j: judges [letter, name, country]    o: chairperson / DJ / other officials [role, name, country]
//   n: { startNo: name }                 h: { roundNumber: [[dance, [startNo, ...]], ...] }  (heats in running order)
export function compactCategory(c) {
  if (!c || !Array.isArray(c.p) || !Array.isArray(c.r)) return null;
  const rn = {}; c.r.forEach(r => { if (r && r.i != null && Number.isFinite(r.rn)) rn[r.i] = r.rn; });
  const n = {}; c.p.forEach(p => { if (p && Number.isFinite(p.sn) && p.n) n[p.sn] = String(p.n); });
  const h = {};
  for (const [rid, list] of Object.entries(c.h || {})) {
    if (!Array.isArray(list) || !rn[rid]) continue;
    const heats = list.filter(x => x && Array.isArray(x.p) && x.p.length).slice().sort((a, b) => (a.dhn || a.hn || 0) - (b.dhn || b.hn || 0) || (a.hn || 0) - (b.hn || 0));
    if (!heats.length) continue;
    h[rn[rid]] = heats.map(x => [x.dn || '', x.p.map(q => q.sn).filter(Number.isFinite)]);
    for (const x of heats) for (const q of x.p) if (Number.isFinite(q.sn) && q.n && !n[q.sn]) n[q.sn] = String(q.n);
  }
  const ad = Array.isArray(c.ad) && c.ad.length ? c.ad : (Array.isArray(c.j) ? c.j : []);
  const j = ad.filter(a => a && a.n && (a.role || 'judge') === 'judge').map(a => [String(a.l || a.i || ''), String(a.n), String(a.ct || '')]);
  const o = ad.filter(a => a && a.n && (a.role || 'judge') !== 'judge').map(a => [String(a.role), String(a.n), String(a.ct || '')]);
  // results: s = { startNo: [finalRank|null, [[roundNumber, placeInRound, advanced 0|1], ...]] }.
  // marX can reuse one round id for two rounds (e.g. "F" for semi-final and final); per-round data under such an id is ambiguous, so it is left out.
  const idCount = {}; c.r.forEach(r => { if (r) idCount[r.i] = (idCount[r.i] || 0) + 1; });
  const s = {};
  for (const p of c.p) {
    if (!p || !Number.isFinite(p.sn)) continue;
    const rr = [];
    for (const [rid, v] of Object.entries(p.r || {})) if (v && rn[rid] && idCount[rid] === 1 && Number.isFinite(v.fp)) rr.push([rn[rid], v.fp, v.adv ? 1 : 0]);
    const fr = Number.isFinite(p.finalRank) ? p.finalRank : null;
    if (fr != null || rr.length) s[p.sn] = [fr, rr];
  }
  return Object.keys(s).length ? { j, o, n, h, s } : { j, o, n, h };
}

// Marks (AJS scoring) of every judged round, for the detail view. Phones load it per competition, only when someone opens the results.
//   { cr: { roundNo: ['TQ','CH','IP'] }, r: { roundNo: { startNo: [total, place, advanced, [[dance, danceTotal, dancePlace, { judgeLetter: ['5.8','5.0*'] }], ...]] } } }
// A mark ending in * was flagged invalid by the scoring system. marX can reuse one round id for two rounds, so the round is picked
// by its size (marked entries == round size); anything ambiguous is left out rather than guessed.
export function compactScores(c) {
  if (!c || !Array.isArray(c.r) || !c.dr || typeof c.dr !== 'object') return null;
  const byId = {}; c.r.forEach(r => { if (r && r.i != null && Number.isFinite(r.rn)) (byId[r.i] = byId[r.i] || []).push(r); });
  const out = { cr: {}, r: {} };
  for (const [rid, v] of Object.entries(c.dr)) {
    const s = v && v.sajs; if (!s || !Array.isArray(s.p) || !s.p.length) continue;
    const cands = byId[rid] || [];
    const exact = cands.filter(r => r.mp === s.p.length);
    const rd = exact.length ? exact.sort((a, b) => b.rn - a.rn)[0] : (cands.length === 1 ? cands[0] : null);
    if (!rd) continue;
    const crit = (s.sajsCriteria || []).filter(x => x && x.enabled);
    const dn = {}; (s.da || []).forEach(d => { if (d) { const a = d.abbreviation || d.n || ''; if (d.uuid) dn[d.uuid] = a; if (d.i) dn[d.i] = a; } });
    const ps = {};
    for (const p of s.p) {
      if (!p || !Number.isFinite(p.sn) || !Number.isFinite(p.ts)) continue;
      const drs = (p.drs || []).map(d => {
        const js = {};
        for (const j of d.jsc || []) { if (!j || !j.sc) continue; js[j.jl || j.ji] = crit.map(k => (j.sc[k.key] == null ? '' : String(j.sc[k.key])) + (j.invalid && j.invalid[k.key] ? '*' : '')); }
        return [dn[d.di] || '', Number.isFinite(d.ts) ? d.ts : null, Number.isFinite(d.pl) ? d.pl : null, js];
      });
      if (!(p.ts > 0) && !drs.some(d => Object.values(d[3]).some(ms => ms.some(m => m !== '')))) continue;   // not judged yet
      ps[p.sn] = [Math.round(p.ts * 1000) / 1000, Number.isFinite(p.fpl) ? p.fpl : null, p.adv ? 1 : 0, drs];
    }
    if (!Object.keys(ps).length) continue;
    out.cr[rd.rn] = crit.map(k => k.label || ''); out.r[rd.rn] = ps;
  }
  return Object.keys(out.r).length ? out : null;
}

async function getCategory(id) {
  const res = await fetch(MARX_BASE + id + '.json?_cb=' + Date.now(), {
    headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'istanbul2026-takip (schedule mirror)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('marX ' + id + ' ' + res.status);
  const raw = await res.json();
  return { ord: compactCategory(raw), sc: compactScores(raw) };
}

// Which categories to look at now. A category with a round today that is not finished (or tomorrow's first thing)
// is checked about every 2 minutes; the rest every 20 minutes.
export function dueCategories(mx, last, now = Date.now(), todayDay) {
  const rounds = {};   // wdsfId -> [state...]
  for (const [k, m] of Object.entries(mx.r)) { const id = k.split('.')[0]; (rounds[id] = rounds[id] || []).push([m[0], m[4]]); }
  const due = [];
  for (const [wid, cid] of Object.entries(mx.cat || {})) {
    const rs = rounds[wid] || [];
    const active = rs.some(([d, s]) => s !== 'd' && d <= todayDay + 1);
    const today = rs.some(([d]) => d === todayDay);   // results arrive after the final: keep today's finished categories fresh too
    const every = (active ? 100 : today ? 300 : 20 * 60) * 1000;
    if (!last[wid] || now - last[wid] >= every) due.push([wid, cid]);
  }
  return due;
}

// Refresh the categories that are due; `store` is { [wdsfId]: compact category } and is updated in place.
// Returns true when something changed.
export async function refreshOrder(mx, store, last, todayDay, log = console.log, scStore = {}) {
  const due = dueCategories(mx, last, Date.now(), todayDay);
  let changed = false, i = 0;
  const scChanged = refreshOrder.scChanged = new Set();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < due.length) {
      const [wid, cid] = due[i++];
      try {
        const { ord: c, sc } = await getCategory(cid);
        last[wid] = Date.now();
        if (sc && JSON.stringify(scStore[wid]) !== JSON.stringify(sc)) { scStore[wid] = sc; scChanged.add(wid); }
        if (!c) continue;
        if (JSON.stringify(store[wid]) !== JSON.stringify(c)) { store[wid] = c; changed = true; }
      } catch (e) { log('order:', e.message); }
    }
  }));
  return changed;
}
