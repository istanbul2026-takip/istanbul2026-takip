#!/usr/bin/env python3
"""Service-worker fault simulation (headless Chrome, Python Playwright).

    node tests/build-local.mjs /tmp/swsim/dist
    python3 tests/sw-sim.py [--dist /tmp/swsim/dist] [--only S5] [--path /tarz/]

Serves the built site on http://localhost:PORT (service workers allowed) from a tiny HTTP server whose behaviour
can be switched per scenario (normal / 404 / 500 / HTML error page / hang / truncated / down), and prints one JSON
line per observation. Nothing here touches the repo or the network (GitHub calls are answered from fixtures).
"""
import argparse, functools, json, os, re, shutil, socket, socketserver, sys, threading, time, http.server
from datetime import datetime, timezone, timedelta
from playwright.sync_api import sync_playwright

FIX = os.environ.get('SW_FIX', '/tmp/t')
PATHS = ['/', '/tarz/']


class State:
    def __init__(self, root):
        self.root = root
        self.idx = ('normal', 0)      # (mode, arg)
        self.ver = ('normal', 0)
        self.ver_value = None         # None -> file content
        self.marker = 'A'
        self.log = []                 # (path, mode)
        self.assets_delay = 0
        self.sw_root = None           # alternative dir for sw.js


def make_server(st):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.0'
        def log_message(self, *a): pass
        def drop(self):
            self.close_connection = True
            try: self.connection.shutdown(socket.SHUT_RDWR)
            except Exception: pass
        def send(self, code, body, ctype='text/html; charset=utf-8', cl=None):
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body) if cl is None else cl))
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(body)
        def do_GET(self):
            p = self.path.split('?')[0]
            root = st.root
            if p in ('/', '/index.html', '/tarz/', '/tarz/index.html'):
                mode, arg = st.idx
                st.log.append((p, mode))
                f = os.path.join(root, p.lstrip('/'), 'index.html') if p.endswith('/') else os.path.join(root, p.lstrip('/'))
                body = open(f, 'rb').read().replace(b'<head>', b'<head><!--MARK:' + st.marker.encode() + b'-->', 1)
                return self.serve_mode(mode, arg, body)
            if p.endswith('version.txt'):
                mode, arg = st.ver
                st.log.append((p, 'ver-' + mode))
                body = (st.ver_value if st.ver_value is not None else open(os.path.join(root, p.lstrip('/')), 'rb').read().decode().split('\n')[0]) + '\n2026\n'
                if p.startswith('/tarz') and st.ver_value is not None: body = st.ver_value + '-tarz\n2026\n'
                return self.serve_mode(mode, arg, body.encode(), ctype='text/plain')
            if p == '/sw.js' and st.sw_root:
                root = st.sw_root
            f = os.path.join(root, p.lstrip('/'))
            if os.path.isfile(f):
                if p.startswith('/a/') and st.assets_delay: time.sleep(st.assets_delay)
                ct = 'application/javascript' if p.endswith('.js') else ('font/woff2' if p.endswith('woff2') else 'image/jpeg' if p.endswith('jpg') else 'text/plain')
                return self.send(200, open(f, 'rb').read(), ct)
            self.send(404, b'nf')
        def serve_mode(self, mode, arg, body, ctype='text/html; charset=utf-8'):
            if mode == 'normal': return self.send(200, body, ctype)
            if mode == 'slow':
                time.sleep(arg); return self.send(200, body, ctype)
            if mode == 's500': return self.send(500, b'Internal Server Error', 'text/plain')
            if mode == 's404': return self.send(404, b'<html><body>404 not found</body></html>')
            if mode == 'html502': return self.send(502, b'<html><body><h1>502 Bad Gateway</h1></body></html>')
            if mode == 'html200': return self.send(200, b'<html><head><title>Wi-Fi login</title></head><body><h1>Captive portal</h1></body></html>')
            if mode == 'hang':
                time.sleep(60); return
            if mode == 'down': return self.drop()
            if mode == 'truncate_cl':      # promises full length, connection cut halfway
                self.send_response(200); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body))); self.end_headers()
                self.wfile.write(body[:len(body) // 2]); self.wfile.flush(); return self.drop()
            if mode == 'truncate_valid':   # short file, self-consistent headers (e.g. half-written deploy)
                return self.send(200, body[:len(body) // 2], ctype)
            raise Exception(mode)
    class Q(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True
    srv = Q(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


CACHE_JS = """async()=>{const out={};for(const k of await caches.keys()){const c=await caches.open(k);const o={};let assets=0;
for(const r of await c.keys()){const p=new URL(r.url).pathname;const res=await c.match(r);
if(p.endsWith('/')||p.endsWith('__version')){const t=await res.clone().text();o[p]={status:res.status,len:t.length,tail:t.trim().slice(-7),marker:(t.match(/MARK:(\\w+)/)||[])[1]||null,txt:p.endsWith('__version')?t:undefined}}else assets++}
o.assets=assets;out[k]=o}return out}"""

RENDER_JS = """()=>{const q=s=>document.querySelector(s);const t=q('#v-kulup')||q('#v-simdi');
const any=['#v-simdi','#v-kulup'].map(s=>q(s)&&q(s).textContent.trim().length).filter(x=>x);
const mk=(document.documentElement.outerHTML.match(/MARK:(\\w+)/)||[])[1]||null;
return {tabs:!!q('nav.tabs'),content:any.length?Math.max(...any):0,marker:mk,title:document.title,body:(document.body&&document.body.innerText||'').slice(0,80),sw:!!navigator.serviceWorker.controller}}"""


class Env:
    def __init__(self, br, dist, w=390, h=844):
        self.dist = dist
        self.st = State(dist)
        self.srv, self.port = make_server(self.st)
        self.ctx = br.new_context(viewport={'width': w, 'height': h}, locale='tr-TR', timezone_id='Europe/Istanbul', service_workers='allow')
        live = open(os.path.join(FIX, 'marx-now.json')).read()
        order = open(os.path.join(FIX, 'order-sample.json')).read()
        def gh(route):
            u = route.request.url
            if u.endswith('live.json'): route.fulfill(status=200, content_type='application/json', body=live)
            elif u.endswith('order.json'): route.fulfill(status=200, content_type='application/json', body=order)
            else: route.fulfill(status=404, body='')
        self.ctx.route('https://raw.githubusercontent.com/**', gh)
        self.errors = []
        self.probe = self.ctx.new_page()
        self.probe.goto(f'http://localhost:{self.port}/robots.txt')
    def url(self, path): return f'http://localhost:{self.port}{path}'
    def visit(self, path, timeout=70000, settle=700):
        p = self.ctx.new_page()
        errs = []
        p.on('console', lambda m: errs.append('console:' + m.text[:120]) if m.type == 'error' else None)
        p.on('pageerror', lambda e: errs.append('pageerror:' + str(e)[:120]))
        p.clock.install(time=datetime(2026, 11, 12, 19, 40, tzinfo=timezone(timedelta(hours=3))))
        t0 = time.time(); goto_err = None
        try: p.goto(self.url(path), timeout=timeout, wait_until='load')
        except Exception as e: goto_err = str(e).split('\n')[0][:140]
        ms = int((time.time() - t0) * 1000)
        p.wait_for_timeout(settle)
        try: r = p.evaluate(RENDER_JS)
        except Exception as e: r = {'tabs': False, 'content': 0, 'marker': None, 'err': str(e)[:80]}
        r['ok'] = bool(r.get('tabs') and r.get('content'))
        r.update(ms=ms, goto_err=goto_err, errors=errs[:4], url=p.url[-30:])
        r['_page'] = p
        return r
    def done(self, r):
        r.pop('_page').close(); return r
    def cache(self):
        self.probe.wait_for_timeout(400)
        return self.probe.evaluate(CACHE_JS)
    def sw_ready(self, p):
        return p.evaluate("navigator.serviceWorker.ready.then(r=>!!r.active)")
    def warm(self, path, n=2):
        """n=1: first visit only (SW installs, page not yet stored). n=2: second visit (SW controls, page stored)."""
        r = self.visit(path); assert r['ok'], r
        r['_page'].evaluate("navigator.serviceWorker.ready.then(()=>1)")
        r['_page'].wait_for_timeout(800); self.done(r)
        for _ in range(n - 1):
            r = self.visit(path); assert r['ok'], r; self.done(r)
        self.st.log.clear()
    def close(self):
        try: self.ctx.close()
        except Exception: pass
        self.srv.shutdown(); self.srv.server_close()


def brief(r): return {k: v for k, v in r.items() if k != '_page'}
def pagecache(c, path):
    d = c.get('istanbul2026-v2', {}); e = d.get(path)
    return e and {k: e[k] for k in ('status', 'len', 'tail', 'marker')}
def vcache(c, path):
    d = c.get('istanbul2026-v2', {}).get(path + '__version'); return d and d['txt'].strip()

OUT = []
def emit(sc, path, **kw):
    kw.update(sc=sc, path=path); print(json.dumps(kw, ensure_ascii=False), flush=True); OUT.append(kw)


# ---------------------------------------------------------------- scenarios
def s1(br, dist, path):
    for warm in (1, 2):
        for kind in ('dropped', 'refused'):
            e = Env(br, dist)
            try:
                e.warm(path, warm)
                before = e.cache()
                if kind == 'dropped': e.st.idx = ('down', 0); e.st.ver = ('down', 0)
                else: e.srv.shutdown(); e.srv.server_close()
                r = e.visit(path, timeout=60000)
                emit(f'S1 down (visited {warm}x) [{kind}]', path, r=brief(r), cache_before=pagecache(before, path))
                e.done(r)
            finally: e.close()


def s2(br, dist, path):
    e = Env(br, dist)
    try:
        e.warm(path, 2)
        e.st.marker = 'B'                       # server content changed, version.txt NOT changed
        r = e.visit(path); emit('S2a version same, content changed on server', path, r=brief(r), index_requests=[x for x in e.st.log if 'ver' not in x[1]]); e.done(r)
        e.st.log.clear(); e.st.ver_value = 'newver'
        r = e.visit(path); emit('S2b version changed', path, r=brief(r), cache=pagecache(e.cache(), path), ver=vcache(e.cache(), path)); e.done(r)
        e.st.log.clear()
        r = e.visit(path); emit('S2c next load, version same again', path, r=brief(r), index_requests=[x for x in e.st.log if 'ver' not in x[1]]); e.done(r)
    finally: e.close()


def s3(br, dist, path):
    for mode in ('s500', 's404', 'html502', 'html200'):
        e = Env(br, dist)
        try:
            e.warm(path, 2)
            e.st.marker = 'B'; e.st.ver_value = 'newver'; e.st.idx = (mode, 0)
            r = e.visit(path); c = e.cache()
            emit(f'S3 version changed + index {mode}', path, r=brief(r), cache=pagecache(c, path), ver=vcache(c, path)); e.done(r)
            e.st.idx = ('normal', 0)
            r = e.visit(path); c = e.cache()
            emit(f'S3 ... then server healthy again (version stays newver) [{mode}]', path, r=brief(r), cache=pagecache(c, path), ver=vcache(c, path)); e.done(r)
        finally: e.close()
    # no cached page yet (second visit, SW active), index 500
    e = Env(br, dist)
    try:
        e.warm(path, 1); e.st.idx = ('s500', 0)
        r = e.visit(path); emit('S3b no stored page yet + index 500', path, r=brief(r), cache=pagecache(e.cache(), path)); e.done(r)
    finally: e.close()
    e = Env(br, dist)
    try:
        e.warm(path, 1); e.st.idx = ('html200', 0)
        r = e.visit(path); emit('S3c no stored page yet + index 200 captive-portal HTML', path, r=brief(r), cache=pagecache(e.cache(), path)); e.done(r)
    finally: e.close()


def s4(br, dist, path):
    e = Env(br, dist)
    try:
        e.warm(path, 2)
        e.st.marker = 'B'; e.st.ver_value = 'newver'; e.st.idx = ('hang', 0)
        r = e.visit(path); c = e.cache()
        emit('S4 version changed + index hangs', path, r=brief(r), cache=pagecache(c, path), ver=vcache(c, path)); e.done(r)
    finally: e.close()


def s5(br, dist, path):
    for mode, warm in (('truncate_cl', 2), ('truncate_valid', 2), ('truncate_cl', 1)):
        e = Env(br, dist)
        try:
            e.warm(path, warm)
            e.st.marker = 'B'; e.st.ver_value = 'newver'; e.st.idx = (mode, 0)
            r = e.visit(path); c = e.cache()
            emit(f'S5 {mode} (visited {warm}x): the faulty load', path, r=brief(r), cache=pagecache(c, path), ver=vcache(c, path)); e.done(r)
            e.st.idx = ('normal', 0)
            for i in (1, 2):
                r = e.visit(path); c = e.cache()
                emit(f'S5 {mode} (visited {warm}x): healthy server, reload #{i}, version still newver', path, r=brief(r), cache=pagecache(c, path), ver=vcache(c, path)); e.done(r)
        finally: e.close()


def s6(br, dist, path):
    for label, ver, idx in (('version hangs', ('hang', 0), ('normal', 0)), ('version 500', ('s500', 0), ('normal', 0)),
                            ('version hangs + index hangs', ('hang', 0), ('hang', 0)), ('version 500 + index down', ('s500', 0), ('down', 0))):
        e = Env(br, dist)
        try:
            e.warm(path, 2)
            e.st.marker = 'B'; e.st.ver = ver; e.st.idx = idx
            r = e.visit(path); c = e.cache()
            emit(f'S6 {label} (index content changed)', path, r=brief(r), cache=pagecache(c, path), ver=vcache(c, path)); e.done(r)
        finally: e.close()
    e = Env(br, dist)
    try:
        e.warm(path, 2); e.st.ver = ('hang', 0)           # nothing changed, only version hangs
        r = e.visit(path); emit('S6 version hangs, nothing changed', path, r=brief(r)); e.done(r)
    finally: e.close()


def s7(br, dist, path):
    d2 = '/tmp/swsim/dist2'
    shutil.rmtree(d2, ignore_errors=True); shutil.copytree(dist, d2)
    old = 'figtree-latin-wght-normal.4ba7d3d096.woff2'; new = 'figtree-latin-wght-normal.ffffffffff.woff2'
    os.rename(f'{d2}/a/{old}', f'{d2}/a/{new}')
    for f in ('index.html', 'tarz/index.html', 'sw.js'):
        s = open(f'{d2}/{f}').read().replace(old, new)
        if f == 'sw.js': s = s.replace("const CACHE = 'istanbul2026-v2';", "const CACHE = 'istanbul2026-v2'; // build 2")
        open(f'{d2}/{f}', 'w').write(s)
    open(f'{d2}/version.txt', 'w').write('deploy2\n'); open(f'{d2}/tarz/version.txt', 'w').write('deploy2-tarz\n')
    fonts_js = "async()=>{await document.fonts.ready;return [...document.fonts].map(f=>f.family+':'+f.status).slice(0,8)}"
    for variant in ('open_page_then_reload', 'two_reloads'):
        e = Env(br, dist)
        try:
            e.warm(path, 2)
            open_page = e.visit(path)       # stays open during the "deploy"
            e.st.root = d2; e.st.sw_root = d2; e.st.ver_value = None
            e.st.log.clear()
            # reload in the open page
            open_page['_page'].reload(); open_page['_page'].wait_for_timeout(1500)
            r1 = open_page['_page'].evaluate(RENDER_JS)
            f1 = open_page['_page'].evaluate(fonts_js)
            c = e.cache()
            emit(f'S7 deploy w/ changed sw.js, reload #1 [{variant}]', path, r=r1, fonts=f1, cache=pagecache(c, path), ver=vcache(c, path), assets=c['istanbul2026-v2']['assets'], asset_names_has_new=None)
            if variant == 'two_reloads':
                open_page['_page'].reload(); open_page['_page'].wait_for_timeout(1500)
                f2 = open_page['_page'].evaluate(fonts_js)
                emit('S7 reload #2', path, r=open_page['_page'].evaluate(RENDER_JS), fonts=f2)
            names = open_page['_page'].evaluate("async()=>{const c=await caches.open('istanbul2026-v2');return (await c.keys()).map(r=>new URL(r.url).pathname).filter(p=>p.startsWith('/a/'))}")
            emit('S7 cached asset paths after deploy', path, assets=names, new_font_cached=any(new in n for n in names), old_font_still_cached=any(old in n for n in names))
            reqs = [x for x in e.st.log]
            emit('S7 server requests during reload', path, log=reqs[:15])
            open_page['_page'].close()
        finally: e.close()
    # asset 404 during install (sw.js lists an asset that is missing): does caching of the others silently stop?
    d3 = '/tmp/swsim/dist3'
    shutil.rmtree(d3, ignore_errors=True); shutil.copytree(dist, d3)
    os.remove(f'{d3}/a/hallB.8e32def03f.jpg') if False else os.remove(glob_one(d3 + '/a', 'hallB'))
    e = Env(br, d3)
    try:
        r = e.visit(path); r['_page'].evaluate("navigator.serviceWorker.ready.then(()=>1)"); r['_page'].wait_for_timeout(1000)
        c = e.cache(); emit('S7b one listed asset missing at install -> addAll fails, how many assets cached', path, assets=c['istanbul2026-v2']['assets'] if 'istanbul2026-v2' in c else 'no cache'); e.done(r)
    finally: e.close()


def glob_one(d, pre):
    return os.path.join(d, [f for f in os.listdir(d) if f.startswith(pre)][0])


def s8(br, dist, path):
    # first-ever visit on a slow network (index 5 s, assets 3 s each)
    e = Env(br, dist)
    try:
        e.st.idx = ('slow', 5); e.st.assets_delay = 3
        r = e.visit(path); emit('S8a first visit, index 5 s + assets 3 s each', path, r=brief(r))
        r['_page'].evaluate("navigator.serviceWorker.ready.then(()=>1)"); r['_page'].wait_for_timeout(6000)
        c = e.cache(); emit('S8a ... cache a few seconds later', path, cache=pagecache(c, path), assets=c.get('istanbul2026-v2', {}).get('assets')); e.done(r)
        e.st.assets_delay = 0
        # second visit (SW active, nothing stored for the page yet), index still slow
        r = e.visit(path); emit('S8b second visit, SW active, no stored page, index 5 s', path, r=brief(r)); e.done(r)
    finally: e.close()
    e = Env(br, dist)
    try:
        e.warm(path, 1); e.st.idx = ('slow', 35)
        r = e.visit(path, timeout=90000); emit('S8c SW active, no stored page, index 35 s', path, r=brief(r)); e.done(r)
    finally: e.close()
    e = Env(br, dist)
    try:
        e.warm(path, 1); e.st.idx = ('slow', 5); e.st.ver = ('slow', 5)
        r = e.visit(path, timeout=90000); emit('S8d SW active, no stored page, version 5 s + index 5 s', path, r=brief(r)); e.done(r)
    finally: e.close()


SC = {'S1': s1, 'S2': s2, 'S3': s3, 'S4': s4, 'S5': s5, 'S6': s6, 'S7': s7, 'S8': s8}

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--dist', default='/tmp/swsim/dist'); ap.add_argument('--only'); ap.add_argument('--path')
    a = ap.parse_args()
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for name, fn in SC.items():
            if a.only and a.only != name: continue
            for p in ([a.path] if a.path else PATHS):
                try: fn(br, a.dist, p)
                except Exception as ex:
                    import traceback; emit(name + ' CRASH', p, err=traceback.format_exc()[-600:])
        br.close()
