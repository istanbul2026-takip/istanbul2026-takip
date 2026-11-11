// Reads the organiser's live timetable (marX). It carries each round's current start time,
// expected length and state (upcoming / current / done), updated by the scrutineers during the event.
export const MARX_BASE = 'https://marx.dance/reg/LIVE/2026/20261111_Istanbul/';
export const MARX_URL = MARX_BASE + 'timetable.json';
const MONTHS = { November: 11 };

export async function fetchMarx() {
  const res = await fetch(MARX_URL + '?_cb=' + Date.now(), {
    headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'istanbul2026-takip (schedule mirror)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('marX ' + res.status);
  const j = await res.json();
  if (!j || !Array.isArray(j.timetable)) throw new Error('marX: no timetable');
  const hallNames = (j.competition && j.competition.hallNames) || {};
  const hallOf = n => ((hallNames[n] || '').match(/^\s*([A-Z])\b/) || [])[1] || (n === 1 ? 'A' : n === 2 ? 'B' : String(n));
  const r = {};
  const cat = {};   // wdsfId -> marX categoryId (for the heats/judges files); not part of live.json
  const x = [];   // other items (rehearsals, results presentations, breaks, ceremonies): [day, hall, minutes, length, key]
  for (const e of j.timetable) {
    if (!e) continue;
    if (!e.wdsfId) {
      const m0 = String(e.time || '').match(/^(\d{1,2}):(\d{2})$/), d0 = String(e.blockName || '').match(/(\d{1,2}) ([A-Z][a-z]+)/);
      if (!m0 || !d0 || MONTHS[d0[2]] !== 11) continue;
      const key = Array.isArray(e.resultsCategories) && e.resultsCategories.length
        ? 'R:' + e.resultsCategories.map(c => String(c.name || '').trim()).sort().join('|')
        : String(e.text || '').trim();
      x.push([+d0[1], hallOf(e.hall), +m0[1] * 60 + +m0[2], +e.expectedMinutes || 0, key]);
      continue;
    }
    if (!e.roundNumber) continue;
    if (e.categoryId) cat[e.wdsfId] = e.categoryId;
    const m = String(e.time || '').match(/^(\d{1,2}):(\d{2})$/);
    const dm = String(e.blockName || '').match(/(\d{1,2}) ([A-Z][a-z]+)/);
    if (!m || !dm || MONTHS[dm[2]] !== 11) continue;
    const st = e.state === 'current' ? 'c' : e.state === 'done' ? 'd' : 'u';
    r[`${e.wdsfId}.${e.roundNumber}`] = [+dm[1], hallOf(e.hall), +m[1] * 60 + +m[2], +e.expectedMinutes || 0, st];
  }
  if (Object.keys(r).length < 50) throw new Error('marX: only ' + Object.keys(r).length + ' rounds');
  const out = { at: j.exportedAt || null, fetched: new Date().toISOString(), r, x };
  Object.defineProperty(out, 'cat', { value: cat, enumerable: false });   // kept out of JSON and spreads
  return out;
}

// Same content, ignoring when we looked.
export const marxKey = mx => mx ? JSON.stringify({ at: mx.at, r: mx.r, x: mx.x }) : '';

// --- Change log: what marX moved, and when we saw it. Nothing is corrected or judged here;
// the page only tells people "this was 19:22, marX now says 19:40".
// One change: [key, oldDay, oldHall, oldMinutes, newDay, newHall, newMinutes].
// key is "compId.round" for rounds, "x|<text>" for other items (rehearsals, awards, ceremonies).
const validRow = m => Array.isArray(m) && Number.isFinite(m[0]) && typeof m[1] === 'string' && Number.isFinite(m[2]);
const uniqueX = mx => {
  const seen = new Map();
  for (const m of (mx && Array.isArray(mx.x) ? mx.x : [])) {
    if (!validRow(m) || typeof m[4] !== 'string' || !m[4]) continue;
    seen.set(m[4], seen.has(m[4]) ? null : m);          // the same text twice: cannot tell them apart, leave out
  }
  return seen;
};
export function marxDiff(prev, cur) {
  const out = [];
  if (!prev || !cur || !prev.r || !cur.r) return out;
  if (Object.keys(prev.r).length < 50 || Object.keys(cur.r).length < 50) return out;   // half-empty snapshot: no conclusions
  const moved = (a, b) => a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2];
  for (const [k, n] of Object.entries(cur.r)) {
    const o = prev.r[k];
    if (validRow(o) && validRow(n) && moved(o, n)) out.push([k, o[0], o[1], o[2], n[0], n[1], n[2]]);
  }
  const px = uniqueX(prev), cx = uniqueX(cur);
  for (const [k, n] of cx) {
    const o = px.get(k);
    if (o && n && moved(o, n)) out.push(['x|' + k, o[0], o[1], o[2], n[0], n[1], n[2]]);
  }
  return out;
}
// Log: [[isoTime, [change, ...]], ...], oldest first, capped so the 1-minute file stays small.
export function addChanges(log, iso, changes, cap = 600) {
  const out = (Array.isArray(log) ? log : []).filter(g => Array.isArray(g) && typeof g[0] === 'string' && Array.isArray(g[1]) && g[1].length);
  if (changes && changes.length) out.push([iso, changes]);
  let n = out.reduce((s, g) => s + g[1].length, 0);
  while (out.length > 1 && n > cap) n -= out.shift()[1].length;
  return out;
}
