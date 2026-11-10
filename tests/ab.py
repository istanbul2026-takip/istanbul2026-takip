# Regression net: with the same data and an old-format feed, every view must read exactly as before
# (club view: only the new action row may differ).
import sys, json, copy; sys.path.insert(0,'/tmp/t')
from h import *
MX = json.load(open('/tmp/t/marx-now.json'))
def iso(dt): return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
res = {}
for name, root in [('old','/tmp/dist-base'), ('new','/tmp/dist')]:
    s = Session(root); out = {}
    for at in [ist(10,'23:30'), ist(11,'08:35'), ist(11,'21:10'), ist(12,'12:40'), ist(13,'09:50'), ist(14,'16:05'), ist(15,'23:59'), ist(16,'10:00')]:
        j = copy.deepcopy(MX); j['fetched'] = iso(at); s.live = j; s.reset()
        for path in ['/', '/tarz/']:
            p = s.page(path, at, storage={'wdsfist-favs': '[67347,67344]', 'tarz-favs': '[67347]'}); p.clock.run_for(4000); p.wait_for_timeout(80)
            views = ['simdi','program','yarismalar','sporcu','programim'] + (['kulup'] if path != '/' else [])
            for v in views:
                p.evaluate(f"goView('{v}')"); p.wait_for_timeout(60)
                out[f'{at.day} {at.hour:02d}:{at.minute:02d} {path} {v}'] = p.inner_text('#v-' + v)
                if v == 'kulup':
                    for d in [11,12,13,14,15]:
                        p.evaluate(f"st.cDay={d}; renderClub()"); out[f'{at.day} {at.hour:02d}:{at.minute:02d} {path} kulup d{d}'] = p.inner_text('#v-kulup')
            p.close()
    print(name, 'views', len(out), 'errors', s.errors); res[name] = out; s.close()
strip = lambda t: '\n'.join(l for l in t.split('\n') if l.strip() not in ('📤 Günü paylaş', '🔆 Ekran açık', '＋ Not') and not l.startswith('Saat değişiklikleri: marX bir turun') and not l.startswith('Kendi notların:'))
diff = [k for k in res['old'] if strip(res['old'][k]) != strip(res['new'][k])]
print('views that read differently:', len(diff))
for k in diff[:3]:
    a, b = strip(res['old'][k]).split('\n'), strip(res['new'][k]).split('\n')
    print(k); [print('   -', x) for x in a if x not in b][:6]; [print('   +', x) for x in b if x not in a][:6]
