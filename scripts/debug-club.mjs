// Diagnostic only: what the club logic finds from a full scrape. Nothing is published.
import fs from 'fs';
import { scrape } from './scrape.mjs';
import { clubFor } from './club.mjs';
const d = await scrape({ prev: null, withEntries: true });
const cfg = JSON.parse(fs.readFileSync('club/tarz.json', 'utf8'));
const c = clubFor(d, cfg);
console.log('entries total', Object.values(d.P).reduce((n, v) => n + v.length, 0), 'comps with club entries', Object.keys(c.entries).length, 'members', c.members.length);
for (const [id, list] of Object.entries(c.entries)) console.log('CLUB', id, JSON.stringify(list));
console.log('--- TUR entries not matched');
for (const [id, list] of Object.entries(d.P)) for (const [n, cty] of list) if (cty === 'TUR' && !(c.entries[id] || []).some(e => e[0] === n)) console.log('TUR', id, n, '| T:', JSON.stringify((d.T[id] || [])[list.findIndex(x => x[0] === n)] || null).slice(0, 120));
console.log('--- name has tarz', Object.entries(d.P).flatMap(([id, l]) => l.filter(([n]) => /tarz/i.test(n)).map(([n]) => id + ' ' + n)).join(' || '));
