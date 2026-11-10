// Collects the WDSF Istanbul 2026 schedule, rounds, entries, team members and rankings.
import { DOMParser } from 'linkedom';

const BASE = 'https://www.worlddancesport.org';
const EVENT = 8773;
const parse = html => new DOMParser().parseFromString(html || '<html><body></body></html>', 'text/html');
const text = el => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();

async function get(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + path, { headers: { 'User-Agent': 'Mozilla/5.0 (WDSF Istanbul schedule helper)', 'Accept-Language': 'en' } });
      if (r.ok) return await r.text();
      if (r.status === 404) return '';
    } catch (e) {}
    await new Promise(res => setTimeout(res, 800 * (i + 1)));
  }
  throw new Error('fetch failed: ' + path);
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

export async function scrape({ prev = null, withEntries = true } = {}) {
  const g = parse(await get('/Events/GroupSchedule/' + EVENT));
  const E = [];
  for (const c of g.querySelectorAll('.js-day-container')) {
    const day = +String(c.getAttribute('data-day')).slice(8);
    const halls = [...c.querySelectorAll('thead th')].map(text);
    for (const tr of c.querySelectorAll('tbody tr')) {
      [...tr.children].forEach((td, i) => {
        const t = td.querySelector('.schedule__item__time'); if (!t) return;
        const a = td.querySelector('a');
        const [s, e] = text(t).split(' - ');
        const href = a ? a.getAttribute('href') : '';
        E.push([day, (halls[i] || '').startsWith('B') ? 'B' : 'A', s, e, text(td).replace(text(t), '').trim(),
          href ? +href.split('-').pop() : 0, href ? href.replace('/Competitions/Schedule/', '').replace(/-\d+$/, '') : '']);
      });
    }
  }
  if (E.length < 50) throw new Error('schedule looks empty (' + E.length + ' items)');
  const S = {}; E.forEach(e => { if (e[5]) S[e[5]] = e[6]; }); E.forEach(e => e.pop());
  const ids = Object.keys(S);
  const todayIst = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

  const R = {}, P = {}, T = {}, RK = {};
  const todayDay = todayIst.startsWith('2026-11-') ? +todayIst.slice(8) : (todayIst < '2026-11-01' ? 0 : 99);
  await pool(ids, 6, async id => {
    const slug = S[id] + '-' + id;
    const day = E.find(e => e[5] === +id)[0];
    // past days no longer change: reuse earlier round times
    if (prev && prev.R && prev.R[id] && prev.R[id].length && day < todayDay) R[id] = prev.R[id];
    else {
      const sd = parse(await get('/Competitions/Schedule/' + slug));
      R[id] = [...sd.querySelectorAll('table tbody tr')].map(tr => [...tr.children].map(text))
        .filter(x => x.length >= 4).map(x => [x[0].replace(/ \(\d+\)/, ''), +x[1] || 0, x[2], x[3].replace(' - ', '-')]);
    }
    if (prev && prev.RK && prev.RK[id] && day < todayDay) { RK[id] = prev.RK[id]; return; }
    if (day <= todayDay) {
      const rd = parse(await get('/Competitions/Ranking/' + slug));
      const rr = [...rd.querySelectorAll('table.ranking tbody tr')].filter(tr => tr.querySelector('.ranking__rank'))
        .map(tr => [text(tr.querySelector('.ranking__rank')).replace('.', ''), text(tr.querySelector('.ranking__couple')), text(tr.querySelector('.ranking__country')), text(tr.querySelector('.ranking__number'))]);
      if (rr.length) RK[id] = rr;
    }
  });

  if (withEntries || !prev) {
    await pool(ids, 6, async id => {
      const pd = parse(await get('/Competitions/Participants/' + S[id] + '-' + id));
      const rows = [...pd.querySelectorAll('table.ranking tbody tr')];
      P[id] = rows.map(tr => { const c = tr.querySelectorAll('td'); return [text(c[0]), text(c[1])]; });
      const links = rows.map(tr => tr.querySelector('a')).map(a => a ? a.getAttribute('href') : '');
      if (links.some(h => /\/Teams\//.test(h))) {
        T[id] = await pool(links, 4, async h => {
          if (!h) return [];
          const dd = parse(await get(h.replace(/#.*$/, '')));
          const comp = dd.querySelector('.js-composition');
          return comp ? [...comp.querySelectorAll('.cardlist__item__name')].map(text) : [];
        });
      }
    });
  } else {
    Object.assign(P, prev.P || {}); Object.assign(T, prev.T || {});
  }
  // keep earlier lists for any competition whose page failed to list entries this time
  if (prev) for (const id of ids) { if (!(P[id] || []).length && prev.P && prev.P[id]) P[id] = prev.P[id]; if (!T[id] && prev.T && prev.T[id]) T[id] = prev.T[id]; }
  if (Object.keys(R).length < ids.length * 0.9) throw new Error('round data incomplete');
  return { fetched: new Date().toISOString(), E, R, P, T, RK, S };
}
