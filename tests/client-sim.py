# Client-side fault simulation: hostile storage, clock, timezone, network, feed skew, interaction stress, viewports.
# Run: node tests/build-local.mjs /tmp/clientsim/dist && python3 tests/client-sim.py [/tmp/clientsim/dist] [group ...]
# Groups: storage time net skew stress view   (default: all). Prints one line per case; nothing is asserted silently.
import sys, json, copy, time, re
sys.path.insert(0, '/tmp/t')
from h import *
ARGS = [a for a in sys.argv[1:]]
ROOT = '/tmp/clientsim/dist'
if ARGS and ARGS[0].startswith('/'): ROOT = ARGS.pop(0)
GROUPS = set(ARGS) or {'storage', 'time', 'net', 'skew', 'stress', 'view', 'extra', 'poison'}
ORDER = json.load(open('/tmp/t/order-sample.json')); MX = json.load(open('/tmp/t/marx-now.json')); SC = json.load(open('/tmp/t/sc-sample.json'))
UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

HOOK = """(()=>{ window.__errs=[]; const oe=console.error; const f=a=>a.map(x=>x&&x.stack?String(x.stack).split('\\n').slice(0,3).join(' | '):String(x)).join(' ');
 console.error=(...a)=>{ try{ window.__errs.push('C:'+f(a)); }catch(e){} oe.apply(console,a); };
 addEventListener('error',e=>window.__errs.push('E:'+e.message+' @'+e.lineno+':'+e.colno));
 addEventListener('unhandledrejection',e=>window.__errs.push('U:'+e.reason)); })();"""

class Env:
    """One browser; each case gets a fresh context. feed(url)->(status, body, ctype) or None to hang; default serves fixtures."""
    def __init__(self):
        self.s = Session(ROOT)
        self.cur = None
    def new(self, tz='Europe/Istanbul', w=390, h=844, feed=None, init=None, ua=None):
        s = self.s
        if s.ctx: s.ctx.close()
        kw = dict(viewport={'width': w, 'height': h}, device_scale_factor=2, locale='tr-TR', timezone_id=tz, service_workers='block')
        if ua: kw.update(user_agent=ua, is_mobile=True, has_touch=True)
        s.ctx = s.br.new_context(**kw)
        self.hits = []
        def handle(route):
            u = route.request.url; self.hits.append(u)
            r = (feed or default_feed)(u, len(self.hits))
            if r == 'hang': return  # never answers
            if r == 'abort': return route.abort()
            st, body, ct = r
            route.fulfill(status=st, content_type=ct, body=body)
        s.ctx.route('https://raw.githubusercontent.com/**', handle)
        for sc in ([HOOK] + ([init] if init else [])): s.ctx.add_init_script(sc)
        return s.ctx
    def open(self, path, at, wait=300):
        p = self.s.ctx.new_page()
        p.on('pageerror', lambda e: self.s.errors.append('PAGEERROR ' + str(e)[:300]))
        if at is not None: p.clock.install(time=at)
        p.goto(f'http://127.0.0.1:{self.s.port}{path}')
        p.wait_for_timeout(wait)
        return p
    def close(self): self.s.close()

def default_feed(u, n=0):
    if '/sc/' in u:
        i = u.split('/sc/')[1].split('.json')[0]
        return (200, json.dumps({'fetched': '2026-11-11T20:00:00+03:00', **SC[i]}) if i in SC else '{}', 'application/json')
    if 'order.json' in u: return (200, json.dumps(ORDER), 'application/json')
    return (200, json.dumps(MX), 'application/json')

SNAP = """() => { try { const v = view, sec = document.getElementById('v-' + v), nav = document.querySelector('nav.tabs');
  const nb = nav && nav.getBoundingClientRect();
  return {view: v, on: !!(sec && sec.classList.contains('on')), len: sec ? sec.innerText.trim().length : -1, navH: nb ? Math.round(nb.height) : -1,
   navLinks: document.querySelectorAll('nav.tabs a').length, nodes: document.getElementsByTagName('*').length, sw: document.documentElement.scrollWidth, iw: innerWidth,
   lang: document.documentElement.lang, heap: 0, errs: window.__errs.slice(0, 50), simAbs: typeof simAbs !== 'undefined' ? simAbs : null,
   title: document.title}; } catch (e) { return {dead: String(e).slice(0, 160), nodes: document.getElementsByTagName('*').length, navLinks: document.querySelectorAll('nav.tabs a').length, errs: (window.__errs||[]).slice(0, 50)}; } }"""
def heapkb(p):
    try:
        c = p.context.new_cdp_session(p); c.send('HeapProfiler.collectGarbage'); m = {x['name']: x['value'] for x in c.send('Performance.getMetrics')['metrics']} if c.send('Performance.enable') is not None or True else {}
        m = {x['name']: x['value'] for x in c.send('Performance.getMetrics')['metrics']}; c.detach(); return int(m['JSHeapUsedSize'] / 1024)
    except Exception as e: return -1
def snap(p, env=None):
    r = p.evaluate(SNAP)
    r['heap'] = heapkb(p) * 1024 if env is True else 0
    return r

RESULTS = []   # (group, name, ok, detail)
def record(group, name, ok, detail=''):
    RESULTS.append((group, name, ok, detail))
    print(('  ok   ' if ok else '  FAIL ') + f'[{group}] {name}' + (f'  :: {detail}' if detail else ''), flush=True)

def judge(sn, base_len=300, allow_errs=False):
    """Return list of problems from a snapshot."""
    bad = []
    if 'dead' in sn: bad.append('SCRIPT DEAD: ' + sn['dead'] + f" (nav links {sn['navLinks']}, nodes {sn['nodes']})")
    else:
        if not sn['on']: bad.append('view section not .on')
        if sn['navH'] <= 0 or sn['navLinks'] < 4: bad.append(f"nav missing ({sn['navLinks']} links, h={sn['navH']})")
        if sn['len'] < base_len: bad.append(f"view content only {sn['len']} chars")
    if sn.get('errs') and not allow_errs: bad.append('errs=' + ' || '.join(e[:200] for e in sn['errs'][:3]))
    return bad

def run_pages(env, tag, at, paths=('/tarz/', '/'), group='storage', hashes=('',), base=None, allow_errs=False, extra=None):
    allbad = []
    for path in paths:
        for h in hashes:
            try:
                p = env.open(path + h, at)
                sn = snap(p)
                if extra: extra(p, sn)
                bad = judge(sn, (base or {}).get(path, 300) if base else 300, allow_errs)
                if 'dead' not in sn:
                    # touch every tab so a poisoned renderer shows up
                    for v in (['kulup'] if path == '/tarz/' else []) + ['simdi', 'program', 'yarismalar', 'sporcu', 'programim']:
                        p.evaluate(f"location.hash='{v}'"); p.wait_for_timeout(60)
                        s2 = snap(p)
                        b2 = judge(s2, 50, allow_errs)
                        if b2: bad.append(f'tab {v}: ' + '; '.join(b2))
                if bad: allbad.append(f'{path}{h} @{at.strftime("%d %H:%M") if at else "-"}: ' + ' / '.join(bad))
                p.close()
            except Exception as e:
                allbad.append(f'{path}: HARNESS {str(e)[:200]}')
    record(group, tag, not allbad, ' | '.join(allbad)[:900])
    return allbad

# ------------------------------------------------------------------ 1. storage
def init_ls(mapping, ss=None):
    return "(()=>{const m=%s, q=%s; for(const k in m) localStorage.setItem(k,m[k]); for(const k in q) sessionStorage.setItem(k,q[k]);})()" % (json.dumps(mapping), json.dumps(ss or {}))
BIG = 'x' * 2_000_000
GARB = {
    'badjson': '{not json', 'null': 'null', 'num': '5', 'zero': '0', 'str': '"abc"', 'obj': '{}', 'objk': '{"a":1}', 'true': 'true', 'arr_null': '[null,{},[],5]',
    'big_invalid_2MB': BIG, 'big_json_str_2MB': '"' + BIG + '"', 'big_arr_1.2MB': '[' + ','.join(['"k"'] * 200000) + ']', 'empty': '',
}
# every key the page reads; club page prefixes with 'tarz-' except lang/theme/live/order/findhide which are global
CLUB_KEYS = ['tarz-favs', 'tarz-pins', 'tarz-done', 'tarz-mynotes', 'tarz-cperson', 'tarz-hidedone', 'tarz-prefs', 'tarz-alerted', 'tarz-chgseen']
GLOBAL_KEYS = ['wdsfist-lang', 'wdsfist-theme', 'wdsfist-live', 'wdsfist-order', 'wdsfist-findhide']
MAIN_KEYS = ['wdsfist-favs', 'wdsfist-pins', 'wdsfist-prefs', 'wdsfist-alerted', 'wdsfist-chgseen']
def g_storage(env):
    at = ist(12, '19:40')
    env.new(); p = env.open('/tarz/', at); base = {'/tarz/': snap(p)['len']}; p.close(); p = env.open('/', at); base['/'] = snap(p)['len']; p.close()
    print('  baseline content lengths', base)
    for key in CLUB_KEYS + GLOBAL_KEYS + MAIN_KEYS:
        for gname, gv in GARB.items():
            env.new(init=init_ls({key: gv}))
            run_pages(env, f'{key} = {gname}', at, group='storage', base={k: int(v * .6) for k, v in base.items()}, paths=('/tarz/',) if key in CLUB_KEYS else (('/',) if key in MAIN_KEYS else ('/tarz/', '/')))
    # shaped "older version" payloads
    old = {
        'tarz-favs': '{"67353":true}', 'tarz-done': '{"r:67353:F":1}', 'tarz-mynotes': '[{"text":"x"},"str",{"id":1,"text":5,"day":99,"time":"zz"}]',
        'tarz-cperson': '5', 'tarz-prefs': '"yes"', 'tarz-alerted': '"67353@F"', 'tarz-hidedone': '"false"', 'tarz-chgseen': '"abc"', 'tarz-pins': '123',
        'wdsfist-live': json.dumps({'fetched': 'junk', 'r': 'x', 'chg': [None, 5]}), 'wdsfist-order': json.dumps({'fetched': 'junk', 'o': {'1': None}}),
        'wdsfist-lang': 'fr', 'wdsfist-theme': 'blue'}
    for key, v in old.items():
        env.new(init=init_ls({key: v}))
        run_pages(env, f'old-shape {key} = {v[:40]}', at, group='storage', paths=('/tarz/',) if key.startswith('tarz-') else ('/tarz/', '/'))
    env.new(init=init_ls({}, {'wdsfist-sim': 'garbage'})); run_pages(env, 'sessionStorage wdsfist-sim=garbage', at, group='storage')
    env.new(init=init_ls({}, {'wdsfist-sim': '99999999'})); run_pages(env, 'sessionStorage wdsfist-sim=99999999', at, group='storage')
    env.new(init=init_ls({}, {'tarz-ui': '{"t":1,"det":5,"cDay":"x"}'})); run_pages(env, 'sessionStorage tarz-ui garbage det', at, group='storage')
    env.new(init=init_ls({}, {'tarz-ui': '[[[['})); run_pages(env, 'sessionStorage tarz-ui invalid', at, group='storage')
    # everything at once
    allg = {k: '{bad' for k in CLUB_KEYS + GLOBAL_KEYS + MAIN_KEYS}
    env.new(init=init_ls(allg)); run_pages(env, 'ALL keys invalid JSON', at, group='storage')
    allg = {k: '5' for k in CLUB_KEYS + GLOBAL_KEYS + MAIN_KEYS}
    env.new(init=init_ls(allg)); run_pages(env, 'ALL keys = 5', at, group='storage')
    # quota: setItem throws
    quota = "Storage.prototype.setItem=function(){throw new DOMException('quota','QuotaExceededError')};"
    env.new(init=quota)
    def use(p, sn):
        p.evaluate("location.hash='kulup'"); p.wait_for_timeout(80)
        p.evaluate("document.querySelector('[data-tick]') && document.querySelector('[data-tick]').click()")
        p.wait_for_timeout(100)
        sn['toast'] = p.evaluate("document.getElementById('toast').textContent")
        sn['warn'] = p.evaluate("/kayıt tutmuyor|does not keep/.test(document.body.innerText)")
        p.evaluate("document.getElementById('cNote').click()"); p.wait_for_timeout(100)
        p.evaluate("(()=>{const d=document.getElementById('noteDlg'); document.getElementById('nText').value='abc'; document.getElementById('nTime').value='10:00'; const f=d.querySelector('form'); f&&f.requestSubmit&&f.requestSubmit();})()")
        p.wait_for_timeout(150)
        sn['toast2'] = p.evaluate("document.getElementById('toast').textContent")
    run_pages(env, 'setItem throws QuotaExceededError (tick+note)', at, paths=('/tarz/',), group='storage', extra=lambda p, sn: (use(p, sn), print('     quota toast:', repr(sn.get('toast')), '| warn banner:', sn.get('warn'), '| note toast:', repr(sn.get('toast2')))))
    # localStorage inaccessible
    nols = "Object.defineProperty(window,'localStorage',{get(){throw new DOMException('denied','SecurityError')}});"
    env.new(init=nols)
    run_pages(env, 'localStorage access throws SecurityError', at, group='storage', extra=lambda p, sn: print('     warn banner:', p.evaluate("/kayıt tutmuyor|does not keep/.test(document.body.innerText)")) if p.url.endswith('/tarz/') else None)
    nobs = nols + "Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('denied','SecurityError')}});"
    env.new(init=nobs); run_pages(env, 'localStorage+sessionStorage throw', at, group='storage')
    nul = "Object.defineProperty(window,'localStorage',{value:null,configurable:true});"
    env.new(init=nul); run_pages(env, 'localStorage === null', at, group='storage')
    # storage that silently drops writes (Safari private-ish): setItem ok, getItem returns null
    drop = "Storage.prototype.getItem=function(){return null};"
    env.new(init=drop); run_pages(env, 'getItem always null (write-only storage)', at, group='storage')

# ------------------------------------------------------------------ 2. time
def g_time(env):
    base_at = ist(12, '19:40')
    from datetime import timedelta
    cases = [('clock -1 day', base_at - timedelta(days=1)), ('clock +1 day', base_at + timedelta(days=1)),
             ('clock -1 year', base_at.replace(year=2025)), ('clock +1 year', base_at.replace(year=2027)),
             ('clock at epoch 1970', base_at.replace(year=1970)), ('clock 2038', base_at.replace(year=2038, month=1, day=20))]
    for name, at in cases:
        env.new(); run_pages(env, name, at, group='time')
    for tz in ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC', 'Europe/London']:
        for hm in ['19:40', '23:50']:
            env.new(tz=tz)
            def chk(p, sn, tz=tz, at=ist(12, hm)):
                # the page must still show Istanbul wall-clock for the instant; compare with the expected Istanbul time
                sn['clk'] = p.evaluate("document.getElementById('clockTxt').innerText")
                sn['hasNow'] = p.evaluate("(()=>{const m=nowParts(); return [m.d, m.m]})()")
            allb = run_pages(env, f'tz {tz} @IST 12 Nov {hm}', at=ist(12, hm), group='time', paths=('/tarz/',), extra=chk)
    # exact clock assertions: nowAbs must equal Istanbul minutes regardless of tz
    for tz in ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati']:
        env.new(tz=tz); p = env.open('/tarz/', ist(12, '19:40'))
        r = p.evaluate("[nowAbs(), todayDay(), document.getElementById('clockTxt').innerText, tTxt(new Date().toISOString())]")
        want = (1 * 1440) + 19 * 60 + 40
        record('time', f'tz {tz}: nowAbs()=={want} and clock text Istanbul', abs(r[0] - want) < 1.5 and '19:4' in r[2], str(r))
        p.close()
    # long soak: feeds refreshing (fetched advances every poll so every poll re-renders), across midnight, 12 simulated hours, one view held
    for path, start, vw, sheet in [('/tarz/', ist(12, '19:40'), 'kulup', False), ('/tarz/', ist(12, '23:40'), 'program', False), ('/tarz/', ist(12, '23:40'), 'simdi', False),
                                   ('/tarz/', ist(12, '19:40'), 'sporcu', False), ('/tarz/', ist(12, '19:40'), 'programim', False), ('/', ist(11, '22:30'), 'simdi', False),
                                   ('/', ist(11, '22:30'), 'program', False), ('/tarz/', ist(12, '19:40'), 'kulup', True)]:
        st = {'n': 0}
        def feed(u, n, st=st, start=start):
            st['n'] += 1
            if '/sc/' in u: return default_feed(u)
            j = copy.deepcopy(ORDER if 'order.json' in u else MX); j['fetched'] = (start + timedelta(minutes=st['n'] // 2 + 1)).isoformat(); return (200, json.dumps(j), 'application/json')
        env.new(feed=feed)
        p = env.open(path + '#' + vw, start)
        if sheet: p.evaluate("openComp(67353)")
        p.clock.run_for(5 * 60 * 1000); p.wait_for_timeout(100)
        samples = []
        t0 = time.time()
        for hr in range(12 * 4):
            p.clock.run_for(15 * 60 * 1000)
            if hr in (3, 23, 47): p.wait_for_timeout(50); sn = snap(p); samples.append((sn['nodes'], heapkb(p), p.evaluate("history.length")))
        s1 = snap(p)
        info = f"{vw}{'+sheet' if sheet else ''} nodes/heapKB/history at 1h,6h,12h: {samples}, feed hits {len(env.hits)}, wall {time.time()-t0:.0f}s, clock '{p.evaluate('document.getElementById(\"clockTxt\").innerText')}'"
        bad = judge(s1, 50)
        grow = samples[-1][0] > samples[0][0] * 1.3 + 50 or samples[-1][1] > samples[0][1] * 1.5 + 1500
        record('time', f'soak 12h {path}{vw}{"+sheet" if sheet else ""} from {start.strftime("%d %H:%M")} (15-min steps, polls refreshing)', not bad and not grow, info + ' ' + ' / '.join(bad))
        p.close()
    # timers: count intervals/timeouts alive via patching before load
    env.new(init="""(()=>{ const si=setInterval, ci=clearInterval, st=setTimeout, ct=clearTimeout; window.__iv=new Set(); window.__to=new Set(); window.__tcount=0;
        window.setInterval=function(...a){ const id=si.apply(this,a); __iv.add(id); return id }; window.clearInterval=function(id){ __iv.delete(id); return ci(id) };
        window.setTimeout=function(f,d,...a){ __tcount++; const id=st.call(this,function(){ __to.delete(id); return typeof f==='function'?f.apply(this,arguments):0 },d,...a); __to.add(id); return id }; window.clearTimeout=function(id){ __to.delete(id); return ct(id) }; })()""")
    p = env.open('/tarz/', ist(12, '19:40'))
    a = p.evaluate("[__iv.size, __to.size, __tcount]")
    p.clock.run_for(6 * 3600 * 1000)
    b = p.evaluate("[__iv.size, __to.size, __tcount]")
    record('time', 'timers: pending setTimeouts bounded over 6h (setInterval ids NOT observable here: playwright clock wraps them after my hook)', b[1] <= a[1] + 5, f'pending timeouts {a[1]}->{b[1]}, timeouts created {a[2]}->{b[2]}')
    p.close()

# ------------------------------------------------------------------ 3. network
def g_net(env):
    at = ist(12, '19:40')
    MXs = json.dumps(MX)
    def newer(j):
        j = copy.deepcopy(j); j['fetched'] = '2026-11-12T19:39:00+03:00'; return j
    def mk(live=None, order=None, sc=None):
        def f(u, n):
            if '/sc/' in u: kind, h = 'sc', sc
            elif 'order.json' in u: kind, h = 'order', order
            else: kind, h = 'live', live
            if h is None: return default_feed(u)
            return h(n) if callable(h) else h
        return f
    J = 'application/json'
    cases = {
        'live: 200 HTML': dict(live=(200, '<!doctype html><title>x</title><h1>Rate limited</h1>', 'text/html')),
        'live: 200 HTML w/ json ctype': dict(live=(200, '<html>oops', J)),
        'live: 200 empty body': dict(live=(200, '', J)),
        'live: 204': dict(live=(204, '', J)),
        'live: 304 (no body)': dict(live=(304, '', J)),
        'live: 500': dict(live=(500, 'err', 'text/plain')),
        'live: 404': dict(live=(404, 'Not Found', 'text/plain')),
        'live: 429': dict(live=(429, '{"message":"rate"}', J)),
        'live: json null': dict(live=(200, 'null', J)),
        'live: json []': dict(live=(200, '[]', J)),
        'live: stale (fetched 3 days ago)': dict(live=(200, json.dumps({**MX, 'fetched': '2026-11-09T10:00:00+03:00'}), J)),
        'live: fetched in FUTURE (2027)': dict(live=(200, json.dumps({**MX, 'fetched': '2027-01-01T00:00:00+03:00'}), J)),
        'live: abort (net error)': dict(live='abort'),
        'live: hangs forever': dict(live='hang', order='hang'),
        'order: missing (404) live ok': dict(order=(404, '', 'text/plain')),
        'order: 200 HTML': dict(order=(200, '<html>', 'text/html')),
        'order: empty': dict(order=(200, '', J)),
        'order: hang, live ok': dict(order='hang'),
        'live: missing, order ok': dict(live=(404, '', 'text/plain')),
        'both 404': dict(live=(404, '', 'text/plain'), order=(404, '', 'text/plain')),
        'sc: 404': dict(sc=(404, '', 'text/plain')),
        'sc: garbage HTML': dict(sc=(200, '<html>', 'text/html')),
        'sc: empty': dict(sc=(200, '', J)),
        'sc: json "x"': dict(sc=(200, '"x"', J)),
        'sc: {"r":5}': dict(sc=(200, '{"r":5}', J)),
        'sc: {"r":{"1":"x"}}': dict(sc=(200, '{"r":{"1":"x","2":{"3":"y"}},"cr":5}', J)),
        'sc: hang': dict(sc='hang'),
    }
    for name, kw in cases.items():
        env.new(feed=mk(**kw))
        def extra(p, sn):
            p.evaluate("ORD=%s" % json.dumps(ORDER)); p.evaluate("rerender()")
            p.clock.run_for(70_000); p.wait_for_timeout(100)
            # open results sheet for a competition that has results in ORDER
            cid = '67353'
            if cid:
                sn['sc_hits_before'] = sum('/sc/' in u for u in env.hits)
                p.evaluate(f"openComp({cid})"); p.clock.run_for(5000); p.wait_for_timeout(100)
                sn['sheet'] = p.evaluate("document.getElementById('ov').classList.contains('on') && document.getElementById('sheet').innerText.length")
                p.clock.run_for(130_000); p.wait_for_timeout(100)
                sn['sheet2'] = p.evaluate("document.getElementById('ov').classList.contains('on') && document.getElementById('sheet').innerText.length")
                sn['sc_hits'] = sum('/sc/' in u for u in env.hits); sn['scd'] = p.evaluate("document.querySelectorAll('.scd').length"); print('     ', name, 'sc requests', sn['sc_hits'], '.scd rows', sn['scd'], 'sheet len', sn['sheet'], sn['sheet2'])
                p.evaluate("closeSheet()")
        allb = run_pages(env, name, at, group='net', paths=('/tarz/', '/'), extra=extra, allow_errs=False)
    # alternating fail/succeed every poll and a 30-s slow response
    for label, fn in [('alternate fail/ok each poll', lambda u, n: default_feed(u) if n % 2 else (500, '', 'text/plain')),
                      ('alternate HTML/ok each poll', lambda u, n: default_feed(u) if n % 2 else (200, '<html>', J))]:
        env.new(feed=fn); p = env.open('/tarz/', at)
        for _ in range(10): p.clock.run_for(60_000); p.wait_for_timeout(30)
        sn = snap(p); record('net', label + ' (10 polls)', not judge(sn), ' / '.join(judge(sn))); p.close()
    # slow 30 s: with the fake clock we cannot delay in page time, so delay in the route (real time)
    def slowf(u, n): time.sleep(2); return default_feed(u)   # real 2 s stand-in for 30 s; chains with polls piling up is checked below
    env.new(feed=slowf); p = env.open('/tarz/', at, wait=100)
    for _ in range(8): p.clock.run_for(60_000); p.wait_for_timeout(20)
    sn = snap(p); record('net', 'slow feed (2 s real per request) while 8 polls fire back to back', not judge(sn), f"requests so far {len(env.hits)} " + ' / '.join(judge(sn))); p.close()
    # hang: do polls pile up?
    env.new(feed=lambda u, n: 'hang'); p = env.open('/tarz/', at)
    for _ in range(30): p.clock.run_for(60_000)
    n_live = sum('live.json' in u for u in env.hits); n_ord = sum('order.json' in u for u in env.hits)
    record('net', 'hang forever: requests in flight pile up (30 polls)', True, f'live.json requests={n_live}, order.json requests={n_ord} (no abort/timeout, each poll adds a pending fetch)')
    sn = snap(p); record('net', 'hang forever: page still renders', not judge(sn), ' / '.join(judge(sn))); p.close()
    # sc.json re-poll: how often is sc/<id>.json hit while sheet open for 10 minutes
    env.new(); p = env.open('/tarz/', at); p.evaluate("ORD=%s" % json.dumps(ORDER)); p.evaluate("rerender()")
    cid = '67353'
    p.evaluate(f"openComp({cid})"); p.wait_for_timeout(200); n0 = sum('/sc/' in u for u in env.hits)
    p.clock.run_for(10 * 60 * 1000); n1 = sum('/sc/' in u for u in env.hits)
    record('net', 'sc/<id>.json requests while a results sheet is open 10 min', True, f'{n1 - n0} requests in 10 min')
    p.close()

# ------------------------------------------------------------------ 4. skew
def g_skew(env):
    at = ist(12, '19:40')
    first = next(iter(ORDER['o']))
    def M(**kw): return kw
    def mut_live(f):
        def g(mx, od): f(mx); return mx, od
        return g
    def mut_order(f):
        def g(mx, od): f(od); return mx, od
        return g
    def r_extra(mx):
        for k in list(mx['r'])[:5]: mx['r'][k] = mx['r'][k] + ['extra', {'a': 1}, None]
    def r_state(mx):
        for k in list(mx['r'])[5:9]: mx['r'][k][4] = 'zz'
    def r_unknown_comp(mx): mx['r']['99999.1'] = [12, 'HALL', 600, 30, 'u']; mx['r']['99999.2'] = [12, 'HALL', 640, 30, 'c']
    def r_unknown_round(mx): mx['r']['67353.9'] = [12, 'A', 700, 30, 'u']; mx['r']['67353.0'] = [12, 'A', 700, 30, 'u']
    def r_topfields(mx): mx['zzz'] = {'new': [1, 2]}; mx['v'] = 7
    def x_bad(mx): mx['x'] = (mx.get('x') or []) + [['z', 'z', 1, 2, 'unknownkind', 'extra'], [None] * 5, 'str', 5, [12, 'A', 'x', 'y', 'z']]
    def chg_new(mx): mx['chg'] = (mx.get('chg') or []) + [['2026-11-12T19:30:00+03:00', '99999.1', 600, 700, 'new-field']]
    def chg_bad(mx): mx['chg'] = (mx.get('chg') or []) + [None, 5, [], ['x'], ['2026-11-12T19:30:00+03:00']]
    def o_unknown(od): od['o']['99999'] = {'j': [['A', 'X Y']], 'o': 1, 'n': {'1': 'Foo'}, 'h': {'1': [[600, [1]]]}, 's': {}}
    def o_newfield(od): od['o'][first]['newfield'] = {'a': [1, 2, 3]}; od['v'] = 3
    def o_hkey_Q(od): od['o'][first]['h'] = {**(od['o'][first].get('h') or {}), 'Q': [[1, [1]]]}
    def o_hkey_7(od): od['o'][first]['h'] = {**(od['o'][first].get('h') or {}), '7': [[900, [1, 2]]]}
    def o_hkey_0(od): od['o'][first]['h'] = {**(od['o'][first].get('h') or {}), '0': [[1, [1]]]}
    def o_hkey_float(od): od['o'][first]['h'] = {**(od['o'][first].get('h') or {}), '1.5': [[1, [1]]], '-1': [[1, [1]]]}
    def o_skey_Z(od): od['o'][first]['s'] = {**(od['o'][first].get('s') or {}), '7': [None], 'Z': {'rank': 1}}
    def o_heat_obj(od): od['o'][first]['h'] = {'1': {'a': 1}}
    def o_judge_new(od): od['o'][first]['j'] = [['A', 'X Y', 'extra'], {'l': 'B'}, 'C']
    def o_names_newshape(od): od['o'][first]['n'] = {'1': {'name': 'Foo', 'cty': 'TUR'}, '2': ['x']}
    def o_extra_dance(od): od['o'][first]['h'] = {'1': [['NewDance', [1, 2]], [5, [3]]]}
    def o_sn_str(od): od['o'][first]['h'] = {'1': [[1, ['a', None, {}]]]}
    cases = [('live: extra fields inside round tuples', mut_live(r_extra)), ('live: unknown state letter zz', mut_live(r_state)), ('live: unknown comp ids', mut_live(r_unknown_comp)),
             ('live: unknown round idx (9, 0)', mut_live(r_unknown_round)), ('live: new top-level fields', mut_live(r_topfields)), ('live: bad .x entries', mut_live(x_bad)),
             ('live: chg new-shape entry', mut_live(chg_new)), ('live: chg junk entries (null,5,[],short)', mut_live(chg_bad)),
             ('order: unknown comp id', mut_order(o_unknown)), ('order: new fields', mut_order(o_newfield)), ('order: h key non-numeric "Q"', mut_order(o_hkey_Q)),
             ('order: h key round 7 (not in comp)', mut_order(o_hkey_7)), ('order: h key "0"', mut_order(o_hkey_0)), ('order: h keys "1.5","-1"', mut_order(o_hkey_float)),
             ('order: s key "Z"/round 7 null', mut_order(o_skey_Z)), ('order: h[1] object not array', mut_order(o_heat_obj)), ('order: judges new shape', mut_order(o_judge_new)),
             ('order: names as objects', mut_order(o_names_newshape)), ('order: new dance label + int in place of heat list', mut_order(o_extra_dance)), ('order: heat entries non-numeric', mut_order(o_sn_str))]
    for name, fn in cases:
        mx, od = fn(copy.deepcopy(MX), copy.deepcopy(ORDER))
        mx['fetched'] = '2026-11-12T19:39:00+03:00'; od['fetched'] = '2026-11-12T19:39:00+03:00'
        def feed(u, n, mx=mx, od=od):
            if '/sc/' in u: return default_feed(u)
            return (200, json.dumps(od if 'order.json' in u else mx), 'application/json')
        env.new(feed=feed)
        def extra(p, sn, mx=mx, od=od):
            p.clock.run_for(70_000); p.wait_for_timeout(200)
            p.evaluate("ORD=%s" % json.dumps(od)); p.evaluate("LIVE=%s" % json.dumps(mx)); p.evaluate("rerender()")
            for cid in [int(first), 67353, 67320, 67326, 67344, 99999]:
                p.evaluate(f"openComp({cid})"); p.wait_for_timeout(80); p.evaluate("rerender()")
                sn.setdefault('sheets', {})[cid] = p.evaluate("document.getElementById('sheet').innerText.length"); p.evaluate("closeSheet()")
            sn['errs'] = (sn.get('errs') or []) + snap(p)['errs']
        bad = run_pages(env, name, at, group='skew', paths=('/tarz/', '/'), extra=extra)
    # combined newer feed
    mx = copy.deepcopy(MX); od = copy.deepcopy(ORDER)
    for _, fn in cases:
        if 'Q' in _: continue
        mx, od = fn(mx, od)
    mx['fetched'] = od['fetched'] = '2026-11-12T19:39:00+03:00'
    env.new(feed=lambda u, n: default_feed(u) if '/sc/' in u else (200, json.dumps(od if 'order.json' in u else mx), 'application/json'))
    run_pages(env, 'ALL skew mutations combined (minus Q key)', at, group='skew', paths=('/tarz/', '/'), extra=lambda p, sn: (p.clock.run_for(70_000), p.wait_for_timeout(200)))
    for name, mxj, odj in [('feed r={} (all page comps missing)', {**MX, 'r': {}}, ORDER), ('feed keeps only 49 rounds (below 50 guard)', {**MX, 'r': dict(list(MX['r'].items())[:49])}, ORDER),
                           ('order o={}', MX, {**ORDER, 'o': {}}), ('order has only 1 comp', MX, {**ORDER, 'o': dict(list(ORDER['o'].items())[:1])}),
                           ('live.r tuples truncated to 3 fields', {**MX, 'r': {k: v[:3] for k, v in MX['r'].items()}}, ORDER),
                           ('live fields as strings', {**MX, 'r': {k: [str(x) for x in v] for k, v in MX['r'].items()}}, ORDER),
                           ('live.r every time shifted +120 min (all 154 rounds)', {**MX, 'r': {k: [v[0], v[1], v[2] + 120] + v[3:] for k, v in MX['r'].items()}}, ORDER),
                           ('live.r times > 1440 / negative', {**MX, 'r': {k: [v[0], v[1], v[2] + (1500 if i % 2 else -2000)] + v[3:] for i, (k, v) in enumerate(MX['r'].items())}}, ORDER)]:
        def feed2(u, n, mxj=mxj, odj=odj):
            if '/sc/' in u: return default_feed(u)
            return (200, json.dumps({**(odj if 'order.json' in u else mxj), 'fetched': '2026-11-12T19:39:00+03:00'}), 'application/json')
        env.new(feed=feed2)
        run_pages(env, name, at, group='skew', paths=('/tarz/', '/'), extra=lambda p, sn: (p.clock.run_for(70_000), p.wait_for_timeout(200), sn.update(snap(p))))

# ------------------------------------------------------------------ 5. stress
STRS = ['😀👩‍👩‍👧‍👦🏳️‍🌈', 'مرحبا بالعالم  שלום', 'A' * 5000, '<script>window.__xss=1</script><img src=x onerror="window.__xss=2">', '(((', '\\', '[', '*', '.*', '?', '(?<', '$^', '%', "'\"", '\u0000', 'İİıİ', 'ß', '‮', ' ', '']
def g_stress(env):
    for path, at in [('/tarz/', ist(12, '19:40')), ('/tarz/', ist(11, '22:30')), ('/', ist(12, '19:40'))]:
        env.new(); p = env.open(path, at)
        tag = f'{path}@{at.strftime("%d %H:%M")}'
        p.evaluate("ORD=%s" % json.dumps(ORDER)); p.evaluate("rerender()")
        n0 = snap(p)['nodes']; heap0 = heapkb(p) * 1024
        views = ['simdi', 'program', 'yarismalar', 'sporcu', 'programim'] + (['kulup'] if '/tarz' in path else [])
        # rapid tab switching x50 via real clicks on the nav
        bad = []
        for i in range(50):
            v = views[i % len(views)]
            try: p.click(f'nav.tabs a[data-v="{v if v != "yarismalar" else "sporcu"}"]', timeout=2000, no_wait_after=True)
            except Exception as e: bad.append(f'click {v}: {str(e)[:100]}'); break
        sn = snap(p); b = judge(sn, 50); record('stress', f'{tag} 50 rapid nav clicks', not b and not bad, ' / '.join(b + bad));
        # hashes incl. unknown/garbage
        for h in ['#nope', '#', '#__proto__', '#simdi%20', '#SIMDI', '#kulup', '#yarismalar']:
            p.evaluate(f"location.hash={json.dumps(h)}"); p.wait_for_timeout(40)
        sn = snap(p); b = judge(sn, 50); record('stress', f'{tag} odd hashes (#nope #__proto__ #SIMDI ...)', not b, ' / '.join(b) + f" view={sn.get('view')}")
        # comp sheets x100
        for v in views:
            p.evaluate(f"location.hash='{v}'"); p.wait_for_timeout(50)
            opened = 0
            for i in range(100 // len(views) + 1):
                try:
                    els = p.query_selector_all('[data-comp]')
                    if not els: break
                    el = els[i % len(els)]
                    el.scroll_into_view_if_needed(timeout=500); el.click(timeout=800, no_wait_after=True); opened += 1
                    if i % 2: p.evaluate("closeSheet()")
                    else: p.keyboard.press('Escape')
                except Exception as e:
                    bad.append(f'sheet {v}: {str(e)[:100]}'); break
            p.evaluate("closeSheet(); 0"); p.wait_for_timeout(40)
        sn = snap(p); b = judge(sn, 50)
        stuck = p.evaluate("[document.getElementById('ov').classList.contains('on'), !!document.querySelector('.wrap[inert]'), !!document.querySelector('nav.tabs[inert]'), history.length]")
        record('stress', f'{tag} ~100 sheet open/close via [data-comp] click (Esc / closeSheet)', not b and not stuck[0] and not stuck[1], ' / '.join(b) + f' overlay_on={stuck[0]} wrap_inert={stuck[1]} nav_inert={stuck[2]} history.length={stuck[3]}')
        # sheet open then tabs / back
        p.evaluate("openComp(%s)" % list(ORDER['o'].keys())[0]); p.wait_for_timeout(60)
        for _ in range(6):
            p.go_back(); p.wait_for_timeout(60); p.go_forward(); p.wait_for_timeout(60)
        sn = snap(p); b = judge(sn, 50)
        record('stress', f'{tag} sheet open + 6x back/forward', not b, ' / '.join(b) + f" ov={p.evaluate('document.getElementById(\"ov\").classList.contains(\"on\")')} inert={p.evaluate('!!document.querySelector(\".wrap[inert]\")')}")
        # history walk through hashes
        for v in views * 2:
            p.evaluate(f"location.hash='{v}'"); p.wait_for_timeout(25)
        for _ in range(len(views) * 2 + 3): p.go_back(); p.wait_for_timeout(25)
        for _ in range(len(views) * 2 + 3): p.go_forward(); p.wait_for_timeout(25)
        sn = snap(p); b = judge(sn, 50); record('stress', f'{tag} back/forward through hashes', not b, ' / '.join(b))
        # lang + dark toggles x40 on each view
        for v in views:
            p.evaluate(f"location.hash='{v}'"); p.wait_for_timeout(30)
            for i in range(8):
                p.click('#lngBtn', no_wait_after=True); p.click('#themeBtn', no_wait_after=True)
        sn = snap(p); b = judge(sn, 50); record('stress', f'{tag} EN/TR + theme toggled {8*len(views)}x each', not b, ' / '.join(b) + f" lang={sn.get('lang')}")
        # search inputs
        inputs = [('simdi', '#homeQ'), ('yarismalar', '#cQ'), ('sporcu', '#aQ')]
        for v, sel in inputs:
            p.evaluate(f"location.hash='{v if v!='yarismalar' else 'yarismalar'}'"); p.wait_for_timeout(80)
            if not p.query_selector(sel):
                record('stress', f'{tag} search {sel}', True, 'input not present in this view (skipped)'); continue
            badq = []
            for sv in STRS:
                try:
                    p.fill(sel, sv, timeout=2000); p.clock.run_for(900); p.wait_for_timeout(50)
                    sn = snap(p)
                    b = judge(sn, 20)
                    xss = p.evaluate("window.__xss")
                    if xss: badq.append(f'XSS executed ({xss}) for {sv[:20]!r}')
                    if b: badq.append(f'{sv[:20]!r}: ' + '; '.join(b)[:200])
                except Exception as e: badq.append(f'{sv[:20]!r}: EXC {str(e)[:120]}')
                if sel == '#homeQ': p.evaluate("location.hash='simdi'")
                if p.evaluate("location.hash") != '#' + v and sel == '#homeQ': p.evaluate(f"location.hash='simdi'")
            record('stress', f'{tag} search {sel} odd strings ({len(STRS)})', not badq, ' | '.join(badq[:4]))
        # sheet search
        p.evaluate("location.hash='yarismalar'" if False else "location.hash='sporcu'"); p.wait_for_timeout(50)
        cid = list(ORDER['o'].keys())[0]; p.evaluate(f"openComp({cid})"); p.wait_for_timeout(80)
        badq = []
        for sv in STRS:
            try:
                p.fill('#sq', sv, timeout=2000); p.wait_for_timeout(30)
                if p.evaluate("window.__xss"): badq.append('XSS')
                if not p.evaluate("document.getElementById('ov').classList.contains('on')"): badq.append(f'sheet closed by {sv[:15]!r}')
            except Exception as e: badq.append(f'{sv[:15]!r}: {str(e)[:120]}')
        errs = snap(p)['errs']
        record('stress', f'{tag} sheet search #sq odd strings', not badq and not errs, ' | '.join(badq[:3] + errs[:2]))
        p.evaluate("closeSheet()")
        # club person select
        if '/tarz' in path:
            p.evaluate("location.hash='kulup'"); p.wait_for_timeout(80)
            opts = p.evaluate("[...document.querySelectorAll('#cPer option')].map(o=>o.value)")
            badp = []
            for o in opts:
                try:
                    p.select_option('#cPer', o, timeout=2000); p.wait_for_timeout(30)
                    for dd in DAYS if False else [11, 12, 13, 14, 15]:
                        p.evaluate(f"st.cDay={dd}; renderClub()")
                    sn = snap(p); b = judge(sn, 40, )
                    if b: badp.append(f'{o!r}: ' + '; '.join(b)[:160])
                except Exception as e: badp.append(f'{o!r}: {str(e)[:120]}')
            record('stress', f'{tag} #cPer every option x 5 days ({len(opts)} options)', not badp, ' | '.join(badp[:4]))
            # tick/note/hide-done toggles
            p.evaluate("st.cPerson=''; renderClub()")
            for i in range(60):
                p.evaluate("(()=>{const t=document.querySelectorAll('[data-tick]'); if(t.length) t[%d%%t.length].click();})()" % i)
                if i % 7 == 0: p.evaluate("document.getElementById('cHide').click()")
            sn = snap(p); b = judge(sn, 40); record('stress', f'{tag} 60 done-ticks + hide-done toggles', not b, ' / '.join(b))
        n1 = snap(p, True); record('stress', f'{tag} DOM/heap after stress', n1['nodes'] < n0 * 1.5 + 300, f"nodes {n0}->{n1['nodes']}, heap {heap0//1024}KB->{n1['heap']//1024}KB")
        p.close()

# ------------------------------------------------------------------ 6. viewports
CLIPJS = """()=>{ const iw=innerWidth, out=[]; document.querySelectorAll('body *').forEach(e=>{ if(e.closest('[hidden],.sheet-hidden')) return; const cs=getComputedStyle(e); if(cs.display==='none'||cs.visibility==='hidden'||cs.position==='fixed') return; const r=e.getBoundingClientRect(); if(r.width===0||r.height===0) return;
  if(r.right>iw+1 || r.left<-1){ let a=e.parentElement, scr=false; while(a&&a!==document.body){ const o=getComputedStyle(a).overflowX; if(o==='auto'||o==='scroll'){scr=true;break;} a=a.parentElement; } if(!scr) out.push(e.tagName+'.'+String(e.className).slice(0,30)+' L'+Math.round(r.left)+' R'+Math.round(r.right)); } }); return out.slice(0,5); }"""
def g_view(env):
    for (w, h) in [(320, 568), (1024, 768)]:
        for path, at in [('/tarz/', ist(12, '19:40')), ('/tarz/', ist(11, '22:30')), ('/', ist(12, '19:40'))]:
            for lng in ['tr', 'en']:
                for theme in ['light']:
                    env.new(w=w, h=h, init=init_ls({'wdsfist-lang': lng}))
                    p = env.open(path, at)
                    p.evaluate("ORD=%s" % json.dumps(ORDER)); p.evaluate("rerender()")
                    views = ['simdi', 'program', 'yarismalar', 'sporcu', 'programim'] + (['kulup'] if '/tarz' in path else [])
                    over = []
                    for v in views:
                        p.evaluate(f"location.hash='{v}'"); p.wait_for_timeout(120)
                        if v == 'program':
                            for dd in [11, 12, 13, 14, 15]:
                                p.evaluate("(d)=>{ const b=document.querySelector('[data-d=\"'+d+'\"]'); b&&b.click(); }", dd); p.wait_for_timeout(40)
                                m = p.evaluate("[document.documentElement.scrollWidth, innerWidth]")
                                if m[0] > m[1]: over.append(f'{v}/day{dd}: {m[0]}>{m[1]}')
                        if v == 'kulup':
                            for dd in [11, 12, 13, 14, 15]:
                                p.evaluate(f"st.cDay={dd}; renderClub()")
                                m = p.evaluate("[document.documentElement.scrollWidth, innerWidth]")
                                if m[0] > m[1]: over.append(f'{v}/day{dd}: {m[0]}>{m[1]}')
                        m = p.evaluate("[document.documentElement.scrollWidth, innerWidth]")
                        if m[0] > m[1]: over.append(f'{v}: {m[0]}>{m[1]}')
                        clip = p.evaluate(CLIPJS)
                        if clip: over.append(f'{v}: clipped/overflowing elements {clip}')
                    # open a sheet + sheet with results
                    cid = next(k for k, v in ORDER['o'].items() if v.get('s'))
                    p.evaluate(f"openComp({cid})"); p.wait_for_timeout(150)
                    m = p.evaluate("[document.documentElement.scrollWidth, innerWidth, document.getElementById('sheet').scrollWidth, document.getElementById('sheet').clientWidth]")
                    if m[0] > m[1] or m[2] > m[3]: over.append(f'sheet: doc {m[0]}>{m[1]}, sheet {m[2]}>{m[3]}')
                    wide = p.evaluate("""()=>{ const out=[]; const iw=innerWidth; document.querySelectorAll('body *').forEach(e=>{ const r=e.getBoundingClientRect(); if(r.width>0 && r.right>iw+1 && !e.closest('[hidden]')) out.push(e.tagName+'.'+(e.className||'')+'#'+(e.id||'')+' right='+Math.round(r.right)); }); return out.slice(0,6); }""") if over else []
                    record('view', f'{w}x{h} {path} {lng} {at.strftime("%d %H:%M")}: no horizontal overflow on {len(views)} tabs + sheet', not over and not snap(p)['errs'], ' ; '.join(over) + (' wide:' + str(wide) if wide else '') + ' ' + str(snap(p)['errs'][:2]))
                    p.close()


# ------------------------------------------------------------------ 7. targeted observations
def g_extra(env):
    from datetime import timedelta
    at = ist(12, '19:40')
    # (a) storage that accepts the probe but fails real writes (genuinely full phone)
    full = "const _s=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){ if(k==='wdsfist-probe') return _s.call(this,k,v); throw new DOMException('quota','QuotaExceededError') };"
    env.new(init=full); p = env.open('/tarz/', at); p.evaluate("location.hash='kulup'"); p.wait_for_timeout(100)
    p.evaluate("document.querySelector('[data-tick]').click()"); p.wait_for_timeout(100)
    t = p.evaluate("document.getElementById('toast').textContent"); on = p.evaluate("document.getElementById('toast').classList.contains('on')")
    record('extra', 'storage full (probe ok, writes throw): user told on tick', 'aydedilemedi' in t and on, f'toast={t!r} visible={on}')
    p.evaluate("document.getElementById('cPer').value && 0"); p.close()
    # (b) saved person not in roster any more
    env.new(init=init_ls({'tarz-cperson': '"Zzz Removed"'})); p = env.open('/tarz/', at)
    r = p.evaluate("[document.getElementById('cPer').value, [...document.querySelectorAll('#cPer option')].some(o=>o.selected && o.value), st.cPerson, document.querySelectorAll('#clubBox .crow, #clubBox [data-comp]').length, document.getElementById('clubBox').innerText.slice(0,0)]")
    txt = p.evaluate("[...document.querySelectorAll('#clubBox p.plannote')].map(e=>e.innerText).join('|')")
    record('extra', 'saved person missing from roster: select shows Whole club but list is filtered', r[0] == '' and r[2] != '' , f'select.value={r[0]!r} st.cPerson={r[2]!r} rows={r[3]} note={txt!r}')
    p.close()
    # (c) clock skew observations: what does the page claim
    for name, shift in [('clock -1 day', -timedelta(days=1)), ('clock +1 day', timedelta(days=1)), ('clock -1 year', None), ('clock +1 year', 'y')]:
        t_ = at + shift if isinstance(shift, timedelta) else (at.replace(year=2025) if shift is None else at.replace(year=2027))
        env.new(); p = env.open('/tarz/', t_)
        p.clock.run_for(70_000); p.wait_for_timeout(100)
        o = p.evaluate("[liveFresh(), document.getElementById('clockTxt').innerText, document.getElementById('updTxt').textContent, (document.querySelector('.csum .k')||{}).innerText||'', !!document.querySelector('.cday .td'), document.getElementById('stale').hidden, document.getElementById('stale').textContent]")
        record('extra', f'observe {name}', True, f'liveFresh={o[0]} clock="{o[1]}" updTxt="{o[2]}" summary="{o[3]}" todayChip={o[4]} staleBanner={"hidden" if o[5] else o[6]}')
        p.close()
    # LIVE feed fetched 'now' but device clock a year behind: stale cached live treated as fresh forever?
    env.new(init=init_ls({'wdsfist-live': json.dumps({**MX, 'fetched': '2026-11-12T19:30:00+03:00'})}))
    p = env.open('/tarz/', at.replace(year=2025)); o = p.evaluate("[liveFresh(), Date.now()-Date.parse(LIVE.fetched)]"); p.close()
    record('extra', 'device clock 1 year behind: cached live.json judged fresh (negative age)', not o[0], f'liveFresh={o[0]} age_ms={o[1]}')
    # (d) midnight: page open across 00:00, today chip + now line + day selection
    env.new(); p = env.open('/tarz/#kulup', ist(12, '23:50')); p.wait_for_timeout(100)
    b = p.evaluate("[st.cDay, document.querySelector('.cday .td') && document.querySelector('.cday .td').parentElement.dataset.cd]")
    p.clock.run_for(25 * 60 * 1000); p.wait_for_timeout(100)
    a = p.evaluate("[st.cDay, document.querySelector('.cday .td') && document.querySelector('.cday .td').parentElement.dataset.cd, document.getElementById('clockTxt').innerText]")
    record('extra', 'page open across midnight 12->13 Nov (club): BUGÜN chip moves, selected day stays', a[1] == '13', f'before(cDay,todayChip)={b} after={a}')
    p.close()
    env.new(); p = env.open('/#simdi', ist(12, '23:50')); p.wait_for_timeout(100)
    b = p.evaluate("document.getElementById('heroBox').innerText.slice(0,120)"); p.clock.run_for(25 * 60 * 1000); p.wait_for_timeout(100)
    a = p.evaluate("document.getElementById('heroBox').innerText.slice(0,120)")
    record('extra', 'main page Now tab updates across midnight', b != a, f'before={b!r} after={a!r}')
    p.close()
    # (e) tick() unguarded: one throwing step freezes periodic updates while rerender() (guarded) keeps working
    env.new(init=init_ls({'wdsfist-pins': '[null]'})); p = env.open('/#simdi', at); p.wait_for_timeout(100)
    errs0 = len(snap(p)['errs']); n_thrown = 0
    for _ in range(15):
        try: p.clock.run_for(20 * 1000)
        except Exception as e: n_thrown += 1
    sn = snap(p); sn['errs'] = sn['errs'] + ['x'] * n_thrown
    record('extra', 'wdsfist-pins=[null]: periodic tick() keeps throwing (every 20 s)', False, f'uncaught exceptions from timers in 5 min (15 ticks of 20 s): {n_thrown}; errors logged: {len(sn["errs"]) - errs0 - n_thrown}; first: {sn["errs"][-1][:160] if sn["errs"] else None}; hero len {p.evaluate("document.getElementById(\"heroBox\").innerText.length")}')
    p.close()
    # (f) lang garbage recovery by toggling
    env.new(init=init_ls({'wdsfist-lang': 'fr'})); p = env.open('/tarz/', at)
    l0 = p.evaluate("document.getElementById('v-kulup').innerText.length"); p.click('#lngBtn'); p.wait_for_timeout(100); l1 = p.evaluate("document.getElementById('v-kulup').innerText.length")
    p.click('#lngBtn'); p.wait_for_timeout(100); l2 = p.evaluate("document.getElementById('v-kulup').innerText.length")
    record('extra', "wdsfist-lang='fr': club tab content before/after EN, after TR toggles", False, f'{l0} -> {l1} -> {l2}')
    p.close()
    # (h) leak check: identical state before/after many cycles
    for path in ['/tarz/', '/']:
        env.new(); p = env.open(path, at); p.evaluate("ORD=%s" % json.dumps(ORDER)); p.evaluate("rerender()")
        views = ['simdi', 'program', 'yarismalar', 'sporcu', 'programim'] + (['kulup'] if '/tarz' in path else [])
        def cycle():
            for v in views:
                p.evaluate(f"location.hash='{v}'")
            p.evaluate("openComp(67353)"); p.evaluate("rerender()"); p.evaluate("closeSheet()")
            p.click('#lngBtn', no_wait_after=True); p.click('#lngBtn', no_wait_after=True)
        for _ in range(10): cycle()
        p.evaluate(f"location.hash='{views[0]}'"); a = (snap(p)['nodes'], heapkb(p), p.evaluate("history.length"))
        for _ in range(300): cycle()
        p.evaluate(f"location.hash='{views[0]}'"); b = (snap(p)['nodes'], heapkb(p), p.evaluate("history.length"))
        record('extra', f'leak: {path} 300 cycles (6 tabs + sheet + lang x2) nodes/heapKB/history.length', b[0] <= a[0] + 20 and b[1] < a[1] * 1.5 + 1500, f'{a} -> {b}')
        p.close()
    # (g) lang 'en-GB' from navigator-derived? what values does the page write
    env.new(); p = env.open('/tarz/', at); p.close()

def g_poison(env):
    from datetime import timedelta
    at = ist(12, '19:40'); state = {'bad': True}
    def feed(u, n):
        if '/sc/' in u: return default_feed(u)
        j = copy.deepcopy(ORDER if 'order.json' in u else MX)
        j['fetched'] = '2027-06-01T00:00:00+03:00' if state['bad'] else (at - timedelta(minutes=1)).isoformat()
        return (200, json.dumps(j), 'application/json')
    env.new(feed=feed); p = env.open('/tarz/', at); p.clock.run_for(70_000); p.wait_for_timeout(100)
    state['bad'] = False; p.clock.run_for(5 * 60_000); p.wait_for_timeout(100)
    a = p.evaluate("[LIVE.fetched, ORD.fetched, liveFresh()]")
    p2 = env.s.ctx.new_page(); p2.clock.install(time=at); p2.goto(f'http://127.0.0.1:{env.s.port}/tarz/'); p2.wait_for_timeout(300)
    b = p2.evaluate("[LIVE.fetched, ORD.fetched]")
    record('poison', 'one feed with future `fetched` (2027) then good feeds: page recovers (also after reload)', a[0].startswith('2026') and b[0].startswith('2026'), f'after 5 good polls LIVE/ORD/liveFresh={a}; after reload={b}')

def main():
    env = Env()
    try:
        for g, fn in [('storage', g_storage), ('time', g_time), ('net', g_net), ('skew', g_skew), ('stress', g_stress), ('view', g_view), ('extra', g_extra), ('poison', g_poison)]:
            if g in GROUPS:
                print(f'=== {g}', flush=True)
                try: fn(env)
                except Exception as e:
                    import traceback; traceback.print_exc(); record(g, 'HARNESS CRASH', False, str(e)[:300])
    finally:
        env.close()
    fails = [r for r in RESULTS if not r[2]]
    print(f'\n{len(RESULTS) - len(fails)} ok, {len(fails)} FAIL')
    for r in fails: print('FAIL', r[0], r[1], '::', r[3][:400])
    sys.exit(1 if fails else 0)
main()
