// Reads the organiser's live timetable (marX). It carries each round's current start time,
// expected length and state (upcoming / current / done), updated by the scrutineers during the event.
export const MARX_URL = 'https://marx.dance/reg/LIVE/2026/20261111_Istanbul/timetable.json';
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
  for (const e of j.timetable) {
    if (!e || !e.wdsfId || !e.roundNumber) continue;
    const m = String(e.time || '').match(/^(\d{1,2}):(\d{2})$/);
    const dm = String(e.blockName || '').match(/(\d{1,2}) ([A-Z][a-z]+)/);
    if (!m || !dm || MONTHS[dm[2]] !== 11) continue;
    const st = e.state === 'current' ? 'c' : e.state === 'done' ? 'd' : 'u';
    r[`${e.wdsfId}.${e.roundNumber}`] = [+dm[1], hallOf(e.hall), +m[1] * 60 + +m[2], +e.expectedMinutes || 0, st];
  }
  if (Object.keys(r).length < 50) throw new Error('marX: only ' + Object.keys(r).length + ' rounds');
  return { at: j.exportedAt || null, fetched: new Date().toISOString(), r };
}

// Same content, ignoring when we looked.
export const marxKey = mx => mx ? JSON.stringify({ at: mx.at, r: mx.r }) : '';
