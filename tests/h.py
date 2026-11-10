# Test harness: serves a dist dir, opens a page in headless Chrome at a chosen Istanbul time.
import http.server, socketserver, threading, json, os, sys, functools
from playwright.sync_api import sync_playwright
from datetime import datetime, timezone, timedelta

def serve(root):
    H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
    class Q(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
    class S(H.func):
        def log_message(self, *a): pass
    srv = Q(('127.0.0.1', 0), functools.partial(S, directory=root))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]

def ist(day, hm):
    h, m = map(int, hm.split(':'))
    return datetime(2026, 11, day, h, m, tzinfo=timezone(timedelta(hours=3)))

class Session:
    def __init__(self, root, live=None, w=390, h=844, storage=None):
        self.srv, self.port = serve(root)
        self.pw = sync_playwright().start()
        self.br = self.pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        self.w, self.h = w, h
        self.live = live  # dict or None (None -> 404)
        self.errors = []
        self.ctx = None
        self.reset()
    def reset(self):
        if self.ctx: self.ctx.close()
        self.ctx = self.br.new_context(viewport={'width': self.w, 'height': self.h}, device_scale_factor=2, locale='tr-TR', timezone_id='Europe/Istanbul', service_workers='block')
        def handle(route):
            if self.live is None: route.fulfill(status=404, body='')
            else: route.fulfill(status=200, content_type='application/json', body=json.dumps(self.live))
        self.ctx.route('https://raw.githubusercontent.com/**', handle)
    def page(self, path, at=None, storage=None, port=None):
        p = self.ctx.new_page()
        p.on('console', lambda m: self.errors.append(m.text) if m.type in ('error',) else None)
        p.on('pageerror', lambda e: self.errors.append('PAGEERROR ' + str(e)))
        if at is not None: p.clock.install(time=at)
        if storage:
            p.add_init_script("(()=>{const s=%s; for(const k in s) if(localStorage.getItem(k)===null) localStorage.setItem(k, s[k]);})()" % json.dumps(storage))
        p.goto(f'http://127.0.0.1:{port or self.port}{path}')
        p.wait_for_timeout(300)
        return p
    def close(self):
        self.br.close(); self.pw.stop(); self.srv.shutdown()
