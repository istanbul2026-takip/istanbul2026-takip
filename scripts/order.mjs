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
  return { j, o, n, h };
}

async function getCategory(id) {
  const res = await fetch(MARX_BASE + id + '.json?_cb=' + Date.now(), {
    headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'istanbul2026-takip (schedule mirror)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('marX ' + id + ' ' + res.status);
  return compactCategory(await res.json());
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
    const every = (active ? 100 : 20 * 60) * 1000;
    if (!last[wid] || now - last[wid] >= every) due.push([wid, cid]);
  }
  return due;
}

// Refresh the categories that are due; `store` is { [wdsfId]: compact category } and is updated in place.
// Returns true when something changed.
export async function refreshOrder(mx, store, last, todayDay, log = console.log) {
  const due = dueCategories(mx, last, Date.now(), todayDay);
  let changed = false, i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < due.length) {
      const [wid, cid] = due[i++];
      try {
        const c = await getCategory(cid);
        last[wid] = Date.now();
        if (!c) continue;
        if (JSON.stringify(store[wid]) !== JSON.stringify(c)) { store[wid] = c; changed = true; }
      } catch (e) { log('order:', e.message); }
    }
  }));
  return changed;
}
