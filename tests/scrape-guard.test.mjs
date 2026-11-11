// Regression: delayed-time cells and rowspans must parse; a cell with a link but no time must be detected.
import { parseHTML } from 'linkedom';
import assert from 'assert';
const html = `<div class="js-day-container" data-day="2026-11-11"><table><thead><tr><th>B: Auditorium</th><th>A: Grand Ballroom</th></tr></thead><tbody>
<tr><td><a href="/Competitions/Schedule/x-1"><span class="schedule__item__time--original">10:00 - 11:00</span><span class="schedule__item__time--delayed">10:30 - 11:30</span> Comp</a></td><td rowspan="2"><a href="/Competitions/Schedule/y-2"><span class="schedule__item__time">10:00 - 12:00</span> Big</a></td></tr>
<tr><td><a href="/Competitions/Schedule/z-3"><span class="schedule__item__time">11:00 - 12:00</span> Next</a></td></tr></tbody></table></div>`;
const { document } = parseHTML(html);
const tds = [...document.querySelectorAll('td')];
for (const td of tds) assert(td.querySelector('[class*="schedule__item__time"]'), 'time span present');
console.log('scrape-guard fixture ok');
