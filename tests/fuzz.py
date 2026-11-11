# Robustness: odd feed data (order.json, marks, live.json) must never break the page. Run: python3 tests/fuzz.py /tmp/dist
import sys, json, copy; sys.path.insert(0, '/tmp/t')
from h import *
ROOT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/dist'
ORDER = json.load(open('/tmp/t/order-sample.json')); MX = json.load(open('/tmp/t/marx-now.json')); SC = json.load(open('/tmp/t/sc-sample.json'))
def mutate(o, kind):
    o = copy.deepcopy(o)
    for cid, c in list(o['o'].items()):
        if kind == 'nulls': o['o'][cid] = None
        elif kind == 'types': o['o'][cid] = {'j': 'x', 'o': 5, 'n': [], 'h': 'zz', 's': 'q'}
        elif kind == 'holes':
            c['h'] = {k: [[None, None]] for k in (c.get('h') or {})}; c['n'] = {}; c['s'] = {k: None for k in (c.get('s') or {})}
        elif kind == 'junk': c['s'] = {k: [None, [[1, 'a', None]]] for k in (c.get('s') or {})}; c['j'] = [[None]]
    return o
def scmut(sc, kind):
    sc = copy.deepcopy(sc)
    for k, v in sc.items():
        if kind == 'nulls': sc[k] = {'r': None}
        else: sc[k] = {'cr': 'x', 'r': {'1': {'5': [None, None, None, 'bad']}}}
    return sc
fails = []
for okind in ['none', 'nulls', 'types', 'holes', 'junk']:
    for skind in ['none', 'nulls', 'junk']:
        s = Session(ROOT)
        order = ORDER if okind == 'none' else mutate(ORDER, okind)
        sc = SC if skind == 'none' else scmut(SC, skind)
        def route(r, order=order, sc=sc):
            u = r.request.url
            if '/sc/' in u:
                i = u.split('/sc/')[1].split('.json')[0]
                return r.fulfill(status=200, content_type='application/json', body=json.dumps({'fetched': 'x', **sc[i]}) if i in sc else '{}')
            r.fulfill(status=200, content_type='application/json', body=json.dumps(order if 'order.json' in u else MX))
        s.ctx.route('https://raw.githubusercontent.com/**', route)
        bad = []
        for path in ['/', '/tarz/']:
            p = s.page(path, ist(11, '22:30'))
            p.evaluate("(o)=>{ORD=o}", order); p.evaluate("rerender()")
            for cid in [67353, 67320, 67326, 67344]:
                p.evaluate(f"openComp({cid})"); p.wait_for_timeout(250); p.evaluate("rerender()")
                p.evaluate("closeSheet()")
            for v in ['simdi', 'program', 'yarismalar', 'kulup']:
                try: p.evaluate(f"(()=>{{ view='{v}'; rerender(); }})()")
                except Exception as e: bad.append(str(e)[:120])
            n = p.evaluate("document.body.innerText.length")
            if n < 500: bad.append(f'{path}: page nearly empty ({n})')
            p.close()
        # console errors from our own guard messages are expected; uncaught page errors are not
        uncaught = [e for e in s.errors if 'render:' not in e and 'feed:' not in e]
        ok = not bad and not uncaught
        print(('  ok   ' if ok else '  FAIL ') + f'order={okind} marks={skind}', (bad + uncaught)[:2] if not ok else '')
        if not ok: fails.append((okind, skind))
        s.close()
print('\nALL PASSED' if not fails else f'\nFAILED {fails}'); sys.exit(1 if fails else 0)
