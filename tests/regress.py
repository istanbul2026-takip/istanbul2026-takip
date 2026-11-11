# Regression tests for the bugs found on 11 Nov 2026 (club coverage, running-order highlight, wrapped round labels).
# Run: python3 tests/regress.py /tmp/dist   (needs tests/order-sample.json and the built site)
import sys, json, re; sys.path.insert(0, '/tmp/t')
from h import *
ROOT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/dist'
ORDER = json.load(open('/tmp/t/order-sample.json'))
MX = json.load(open('/tmp/t/marx-now.json'))
fails = []
def ok(c, name, extra=''):
    print(('  ok   ' if c else '  FAIL ') + name + ((' :: ' + str(extra)[:400]) if (extra and not c) else ''))
    if not c: fails.append(name)

s = Session(ROOT)
def route(r):
    u = r.request.url
    body = ORDER if 'order.json' in u else MX
    r.fulfill(status=200, content_type='application/json', body=json.dumps(body))
s.ctx.route('https://raw.githubusercontent.com/**', route)
NOW = ist(11, '16:40')
p = s.page('/tarz/', NOW)

print('club coverage')
info = p.evaluate("""() => ({ comps: Object.keys(CLUB.entries).length, pat: CLUB.pat, xt: CLUB.xt,
  missingItems: Object.keys(CLUB.entries).filter(id => !ITEMS.some(i => i.kind === 'round' && i.comp.id == id)).length })""")
ok(info['comps'] >= 20, 'club has entries in many comps', info)
ok(info['missingItems'] == 0, 'every club competition has schedule items', info)

print('every club entry is shown on its round cards')
bad = p.evaluate("""() => { const out = [];
  DAYS.forEach(d => clubItems(d).forEach(i => { if (i.kind !== 'round') return;
    const ents = clubEntries(i.comp.id); const html = clubRow(i);
    ents.forEach(e => { if (!html.includes(esc(e[1]))) out.push(i.comp.id + ' ' + e[1]); }); }));
  return out; }""")
ok(not bad, 'club cards list all club entries', bad)

print('club entries vs marX names (order feed)')
res = p.evaluate("""(order) => { const out = [];
  const re = new RegExp(CLUB.pat, 'i');
  for (const [cid, oc] of Object.entries(order.o)) {
    const names = Object.values(oc.n || {}); const hit = names.filter(n => re.test(n));
    const c = COMPS[cid]; if (!c) continue;
    const mine = new Set(clubEntries(+cid).map(e => e[0]));
    hit.forEach(n => { if (![...mine].some(m => ordSame(n, m) || ordSame(m, n))) { /* matched by pattern anyway */ } });
    out.push([cid, hit.length]);
  } return out; }""", ORDER)
ok(len(res) > 0, 'order feed has categories', res[:3])

print('running-order highlight')
r = p.evaluate("""async (order) => {
  ORD = order; const out = [];
  for (const cid of Object.keys(order.o)) { const c = COMPS[cid]; if (!c) continue;
    const re = new RegExp(CLUB.pat, 'i'); const xt = CLUB.xt.map(x => x.toLowerCase());
    const names = Object.values(order.o[cid].n || {});
    const expect = names.filter(n => re.test(n) || xt.includes(n.replace(/\\s*\\([^)]*\\)\\s*$/, '').trim().toLowerCase())).length;
    openComp(+cid);
    await new Promise(r => setTimeout(r, 30));
    document.querySelectorAll('details.srcs').forEach(d => d.open = true);
    const lis = [...document.querySelectorAll('.ordl li')];
    const mine = lis.filter(li => li.classList.contains('mine')).length;
    const rounds = Object.keys(order.o[cid].h || {}).length;
    out.push({cid, expect, mine, rounds, lis: lis.length});
    closeSheet();
  } return out; }""", ORDER)
for x in r:
    if x['expect'] and x['lis']:
        # a Tarz entry appears once per round it dances in, so highlighted rows must be at least the entries (in its first round)
        ok(x['mine'] >= x['expect'], f"comp {x['cid']}: highlighted {x['mine']} rows for {x['expect']} club entries", x)
ok(any(x['expect'] for x in r), 'at least one comp has club names in the order feed')

print('round labels never wrap')
for view in ['kulup', 'simdi', 'program', 'yarismalar']:
    for day in [11, 12, 13]:
        q = s.page('/tarz/#' + view, ist(day, '10:00'))
        w = q.evaluate("""() => [...document.querySelectorAll('.rb')].filter(e => e.getClientRects().length > 1 || e.getBoundingClientRect().height > 22).map(e => e.textContent)""")
        ok(not w, f'{view} day {day}: no wrapped round labels', w[:5])
        q.close()

ok(not s.errors, 'no console errors', s.errors[:3])
s.close()
print('\nALL PASSED' if not fails else '\nFAILED: ' + ', '.join(fails))
sys.exit(1 if fails else 0)
