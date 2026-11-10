import fs from 'fs';
import { buildPage } from '../scripts/build.mjs';
const data = JSON.parse(fs.readFileSync(new URL('../data/last.json', import.meta.url),'utf8'));
if (process.env.MX) data.MX = JSON.parse(fs.readFileSync(process.env.MX,'utf8'));
const out = process.argv[2] || '/tmp/dist';
const r = await buildPage(data, out);
console.log('built', out, r.bytes);
