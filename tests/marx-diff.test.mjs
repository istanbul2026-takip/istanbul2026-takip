import assert from 'assert';
import fs from 'fs';
import { marxDiff, addChanges, fetchMarx } from '../scripts/marx.mjs';
const mk = (n, f) => { const r = {}; for (let i = 0; i < n; i++) r[`${60000 + i}.1`] = [11, 'A', 500 + i, 5, 'u']; const o = { at: 'a', fetched: 'f', r, x: [[11,'A',480,10,'Team rehearsal X'],[11,'B',600,5,'Break'],[12,'B',700,5,'Break'],[11,'B',620,5,'R:Y']] }; f && f(o); return o; };
// no change
assert.deepEqual(marxDiff(mk(60), mk(60)), []);
// time change, hall change, day change
let d = marxDiff(mk(60), mk(60, o => { o.r['60000.1'][2] = 530; o.r['60001.1'][1] = 'B'; o.r['60002.1'][0] = 12; }));
assert.deepEqual(d, [['60000.1',11,'A',500,11,'A',530],['60001.1',11,'A',501,11,'B',501],['60002.1',11,'A',502,12,'A',502]]);
// state / duration change only: not a move
assert.deepEqual(marxDiff(mk(60), mk(60, o => { o.r['60000.1'][4] = 'c'; o.r['60001.1'][3] = 99; })), []);
// new and removed rounds are not "moves"
assert.deepEqual(marxDiff(mk(60), mk(60, o => { delete o.r['60000.1']; o.r['9.1'] = [11,'A',1,1,'u']; })), []);
// x: unique text moves; duplicated text ("Break") is ignored
d = marxDiff(mk(60), mk(60, o => { o.x[0][2] = 490; o.x[1][2] = 999; }));
assert.deepEqual(d, [['x|Team rehearsal X',11,'A',480,11,'A',490]]);
// half-empty snapshots: nothing
assert.deepEqual(marxDiff(mk(10), mk(60)), []); assert.deepEqual(marxDiff(mk(60), mk(10)), []);
assert.deepEqual(marxDiff(null, mk(60)), []); assert.deepEqual(marxDiff({}, {}), []);
// broken rows
assert.deepEqual(marxDiff(mk(60), mk(60, o => { o.r['60000.1'] = null; o.r['60001.1'] = ['x']; o.x.push(null, [1]); })), []);
// log: append, skip empty, cap drops oldest groups, tolerates rubbish
let log = addChanges(null, 't1', [['a',1,'A',1,1,'A',2]]);
assert.equal(log.length, 1);
assert.equal(addChanges(log, 't2', []).length, 1);
log = addChanges(log, 't2', [['b',1,'A',1,1,'A',2]]); assert.deepEqual(log.map(g => g[0]), ['t1','t2']);
const big = Array.from({length: 400}, (_, i) => ['k' + i,1,'A',1,1,'A',2]);
log = addChanges(addChanges(log, 't3', big), 't4', big);
assert.deepEqual(log.map(g => g[0]), ['t4']);        // 802 > 600 → t1,t2,t3 dropped; newest always kept
assert.deepEqual(addChanges([1, 'x', [], ['t', []], ['t0', [['q']]]], 't', []).map(g => g[0]), ['t0']);
// real marX file
const real = await fetchMarx();
assert.deepEqual(marxDiff(real, real), []);
const moved = JSON.parse(JSON.stringify(real)); let n = 0; for (const k in moved.r) { moved.r[k][2] += 120; n++; }
const dd = marxDiff(real, moved); assert.equal(dd.filter(c => !c[0].startsWith('x|')).length, n);
console.log('diff tests ok ·', n, 'rounds ·', real.x.length, 'other items ·', new Set(real.x.map(m => m[4])).size, 'distinct texts · exported', real.at);
fs.writeFileSync('/tmp/t/marx-now.json', JSON.stringify(real));
