import sys, json; sys.path.insert(0,'/tmp/t')
from h import *
ORDER=json.load(open('/tmp/t/order-sample.json')); MX=json.load(open('/tmp/t/marx-now.json')); SC=json.load(open('/tmp/t/sc-sample.json'))
s=Session(sys.argv[1] if len(sys.argv) > 1 else '/tmp/dist')
def route(r):
    u=r.request.url
    if '/sc/' in u:
        i=u.split('/sc/')[1].split('.json')[0]
        if i in SC: return r.fulfill(status=200, content_type='application/json', body=json.dumps({'fetched':'x', **SC[i]}))
        return r.fulfill(status=404, body='')
    r.fulfill(status=200, content_type='application/json', body=json.dumps(ORDER if 'order.json' in u else MX))
s.ctx.route('https://raw.githubusercontent.com/**', route)
p=s.page('/tarz/', ist(11,'22:30'))
p.wait_for_timeout(500)
res=p.evaluate("""async (order) => { ORD = order; const out=[];
 for (const cid of Object.keys(SC_IDS)) { const c=COMPS[cid]; if(!c) continue;
   scGet(cid); await new Promise(r=>setTimeout(r,150));
   const d=document.createElement('div'); d.innerHTML=ordResBlock(c);
   out.push([cid, d.querySelectorAll('.scd').length, d.querySelectorAll('.sct').length, (d.querySelector('.sctot')||{}).textContent||'']); }
 return out; }""".replace('SC_IDS', json.dumps({k:1 for k in SC})), ORDER)
for x in res: print(x)
p.evaluate("(o)=>{ORD=o; openComp(67353)}", ORDER); p.wait_for_timeout(1200)
p.evaluate("document.querySelector('.scd > summary').click()"); p.wait_for_timeout(100)
p.evaluate("rerender()"); p.wait_for_timeout(300)
r=p.evaluate("(()=>{const d=document.querySelector('.scd'); return [d.open, d.querySelectorAll('.sct tr').length, d.querySelector('.sct').innerText.slice(0,120)]})()")
print('after rerender', r)
assert r[0] and r[1] >= 8, r
print('errors', s.errors[:3]); s.close()
