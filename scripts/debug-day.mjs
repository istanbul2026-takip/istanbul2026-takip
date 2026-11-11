// Diagnostic only: what the scraper sees for one day (default 11 Nov), printed to the log. Nothing is published.
import { scrape } from './scrape.mjs';
const day = +(process.env.DAY || 11);
const d = await scrape({ prev: null, withEntries: false });
const rows = d.E.filter(e => e[0] === day);
console.log('after fix · E rows day', day, rows.length, 'A:', rows.filter(e => e[1] === 'A').length, 'B:', rows.filter(e => e[1] === 'B').length);
for (const e of rows.filter(e => e[1] === 'A')) console.log('A', JSON.stringify(e), '| R:', JSON.stringify(d.R[e[5]] || null));
const ids = [...new Set(rows.map(e => e[5]).filter(Boolean))];
console.log('comps today', ids.length, 'with R rows', ids.filter(i => (d.R[i] || []).length).length, 'without R', ids.filter(i => !(d.R[i] || []).length));
// raw table shape for the day: cells per row, spans and times, to see why a hall column could shift
import { DOMParser } from 'linkedom';
const html = await (await fetch('https://www.worlddancesport.org/Events/GroupSchedule/8773', { headers: { 'User-Agent': 'Mozilla/5.0 (WDSF Istanbul schedule helper)', 'Accept-Language': 'en' } })).text();
const g = new DOMParser().parseFromString(html, 'text/html');
const c = [...g.querySelectorAll('.js-day-container')].find(x => String(x.getAttribute('data-day')).slice(8) == String(day));
console.log('thead:', [...c.querySelectorAll('thead th')].map(t => t.textContent.replace(/\s+/g, ' ').trim()).join(' || '));
[...c.querySelectorAll('tbody tr')].slice(0, 70).forEach((tr, n) => console.log('tr', n, [...tr.children].map(td => (td.tagName + (td.getAttribute('rowspan') ? ' rs' + td.getAttribute('rowspan') : '') + (td.getAttribute('colspan') ? ' cs' + td.getAttribute('colspan') : '') + ' ' + ((td.querySelector('.schedule__item__time') || {}).textContent || '-').replace(/\s+/g, ' ').trim())).join(' | ')));
// cells that have content but no time element
let shown = 0;
[...c.querySelectorAll('tbody tr')].forEach((tr, n) => [...tr.children].forEach((td, i) => { if (!td.querySelector('.schedule__item__time') && td.textContent.trim() && shown++ < 8) console.log('NOTIME tr', n, 'col', i, td.outerHTML.replace(/\s+/g, ' ').slice(0, 700)); }));
// the B cell that did parse (Youth solo 08:44 - 22:06) for comparison
const ok = [...c.querySelectorAll('td')].find(td => (td.textContent || '').includes('08:44 - 22:06')); console.log('OKCELL', ok ? ok.outerHTML.replace(/\s+/g, ' ').slice(0, 700) : 'none');
