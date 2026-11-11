// Diagnostic only: what the scraper sees for one day (default 11 Nov), printed to the log. Nothing is published.
import { scrape } from './scrape.mjs';
const day = +(process.env.DAY || 11);
const d = await scrape({ prev: null, withEntries: false });
const rows = d.E.filter(e => e[0] === day);
console.log('E rows day', day, rows.length, 'A:', rows.filter(e => e[1] === 'A').length, 'B:', rows.filter(e => e[1] === 'B').length);
for (const e of rows.filter(e => e[1] === 'A')) console.log('A', JSON.stringify(e), '| R:', JSON.stringify(d.R[e[5]] || null));
const ids = [...new Set(rows.map(e => e[5]).filter(Boolean))];
console.log('comps today', ids.length, 'with R rows', ids.filter(i => (d.R[i] || []).length).length, 'without R', ids.filter(i => !(d.R[i] || []).length));
