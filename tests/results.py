import sys, json; sys.path.insert(0,'/tmp/t')
from h import *
ORDER=json.load(open('/tmp/t/order-sample.json')); MX=json.load(open('/tmp/t/marx-now.json'))
s=Session('/tmp/dist')
s.ctx.route('https://raw.githubusercontent.com/**', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(ORDER if 'order.json' in r.request.url else MX)))
p=s.page('/tarz/', ist(11,'22:30'))
r=p.evaluate("""async (order) => { ORD = order; const out=[];
 for (const cid of Object.keys(ORD.o)) { const c=COMPS[cid]; if(!c||!ORD.o[cid].s) continue;
  const t=(()=>{const d=document.createElement('div'); d.innerHTML=ordResBlock(c); return d.innerText||d.textContent;})();
  out.push([cid, /Sonuçlar/.test(t), (t.match(/🏁|Final sonucu|sonucu/g)||[]).length, Object.keys(ORD.o[cid].s).length]); }
 return out; }""", ORDER)
for x in r: print(x)
print(p.evaluate("""(o)=>{ORD=o; return clubItems(11).filter(i=>i.kind==='round').map(i=>clubRow(i)).join('').match(/ordt res[^>]*>[^<]*/g)}""", ORDER))
print('errors', s.errors[:3]); s.close()
