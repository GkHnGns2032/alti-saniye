#!/usr/bin/env python3
"""Altı Saniye — tarayıcı duman testi (Playwright, Chromium, başsız).

Üretilmiş index.html'i yerel bir HTTP sunucusundan açar ve her test için:
  test seçimi → Başla → bütün sorular → sonuç ekranı
akışını gerçek tarayıcıda yürütür. Motor değiştirilmez; 6 saniyelik zamanlayıcı
Playwright'ın saat taklidiyle (page.clock) ileri sarılır, test bu yüzden saniyeler sürer.

Cevap deseni (soru sırası p = 0, 1, 2, ...):
  p % 3 == 0 → doğru şıkka tıkla
  p % 3 == 1 → yanlış şıkka tıkla
  p % 3 == 2 → hiç dokunma, 6 sn dolsun (zamanlayıcı yolu)
Sonuç ekranındaki doğru/yanlış/boş sayıları JSON'dan hesaplananla karşılaştırılır.
Ek olarak <slug>/index.html yönlendirmesinin doğru teste indiği denetlenir.
Herhangi bir konsol hatası ya da yakalanmamış JS istisnası = FAIL.
Test ağdan bağımsızdır: yerel sunucu dışındaki istekler (Google Fonts) boş 200 yanıtla
karşılanır; yazı tipi yedeğe düşer, davranış değişmez, CI'da ağ kesintisi testi bozmaz.

Kullanım:  python3 araclar/duman_testi.py      (önce python3 yap.py koşulmuş olmalı)
"""
import contextlib
import functools
import http.server
import json
import pathlib
import sys
import threading

KOK = pathlib.Path(__file__).resolve().parent.parent
ASK_MS = 6000

try:
    from playwright.sync_api import sync_playwright, expect
except ImportError:
    sys.exit('Playwright kurulu değil:  pip install playwright && python3 -m playwright install chromium')


@contextlib.contextmanager
def sunucu(kok):
    class Sessiz(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Sessiz, directory=str(kok)))
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f'http://127.0.0.1:{httpd.server_address[1]}'
    finally:
        httpd.shutdown()


def quizleri_oku():
    qs = [json.loads(p.read_text(encoding='utf-8')) for p in sorted((KOK / 'quizler').glob('*.json'))]
    return sorted(qs, key=lambda c: (c['sira'], c['slug']))


class Sayfa:
    """Her senaryo için temiz bağlam (boş localStorage) + konsol hatası toplayıcı."""
    def __init__(self, browser, taban):
        self.ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
        self.ctx.route(lambda url: not url.startswith(taban), self._dis_istek)
        self.page = self.ctx.new_page()
        self.hatalar = []
        self.page.on('console', lambda m: m.type == 'error' and self.hatalar.append(f'console.error: {m.text}'))
        self.page.on('pageerror', lambda e: self.hatalar.append(f'JS istisnası: {e}'))
        self.page.clock.install()  # setTimeout/setInterval/performance.now taklit saate bağlanır

    @staticmethod
    def _dis_istek(route):
        tur = 'text/css' if route.request.resource_type == 'stylesheet' else 'application/octet-stream'
        route.fulfill(status=200, content_type=tur, body='')

    def kapat(self):
        self.ctx.close()


def quiz_senaryosu(browser, taban, c):
    s = Sayfa(browser, taban)
    page = s.page
    try:
        page.goto(taban + '/index.html')
        expect(page.locator('#pick')).to_be_visible()
        page.click(f'#test-{c["slug"]}')
        expect(page.locator('#intro')).to_be_visible()
        expect(page.locator('#total')).to_have_text(str(len(c['questions'])))
        page.click('#start')

        dogru = yanlis = bos = 0
        for p, q in enumerate(c['questions']):
            expect(page.locator('#play')).to_be_visible()
            expect(page.locator('#num')).to_have_text(f'{p + 1:02d}')
            expect(page.locator('#question')).to_have_text(q['q'])
            expect(page.locator('#answers .ans')).to_have_count(4)
            if p % 3 == 0:
                page.click(f'#ans-{q["a"]}')
                dogru += 1
            elif p % 3 == 1:
                page.click(f'#ans-{(q["a"] + 1) % 4}')
                yanlis += 1
            else:
                page.clock.run_for(ASK_MS + 50)  # süre dolsun → reveal(-1)
                bos += 1
            expect(page.locator(f'#ans-{q["a"]}')).to_have_class('ans is-lit')
            page.clock.run_for(2100)  # cevap gösterim aralığı (varsayılan 1,5 sn) → sonraki soru / bitiş

        expect(page.locator('#finish')).to_be_visible()
        expect(page.locator('#finish-title')).to_contain_text(f'{dogru}')
        expect(page.locator('#stats .ok b')).to_have_text(str(dogru))
        expect(page.locator('#stats .no b')).to_have_text(str(yanlis))
        expect(page.locator('#stats > div:nth-child(3) b')).to_have_text(str(bos))
        expect(page.locator('#minisheet > div')).to_have_count(len(c['questions']))
        expect(page.locator('#finish-msg')).not_to_be_empty()
        if s.hatalar:
            raise AssertionError('; '.join(s.hatalar))
        return f'{len(c["questions"])} soru · {dogru} doğru / {yanlis} yanlış / {bos} süre doldu'
    finally:
        s.kapat()


def yonlendirme_senaryosu(browser, taban, c):
    s = Sayfa(browser, taban)
    page = s.page
    try:
        page.goto(f'{taban}/{c["slug"]}/index.html')
        page.wait_for_url(f'**/index.html#{c["slug"]}')
        expect(page.locator('#intro')).to_be_visible()
        expect(page.locator('#hero-top')).to_have_text(c['heroTop'])
        if s.hatalar:
            raise AssertionError('; '.join(s.hatalar))
        return f'/{c["slug"]}/ → #{c["slug"]}'
    finally:
        s.kapat()


def main():
    if not (KOK / 'index.html').exists():
        sys.exit('index.html yok — önce python3 yap.py')
    quizler = quizleri_oku()
    gecen = kalan = 0
    with sunucu(KOK) as taban, sync_playwright() as pw:
        browser = pw.chromium.launch()
        senaryolar = [(f'akış   {c["slug"]}', quiz_senaryosu, c) for c in quizler] + \
                     [(f'yönlen {c["slug"]}', yonlendirme_senaryosu, c) for c in quizler]
        for ad, fn, c in senaryolar:
            try:
                ayrinti = fn(browser, taban, c)
                gecen += 1
                print(f'  ✓ {ad:32} {ayrinti}')
            except Exception as e:  # noqa: BLE001 — her senaryo bağımsız raporlanır
                kalan += 1
                ilk = str(e).strip().splitlines()[0] if str(e).strip() else type(e).__name__
                print(f'  ✗ {ad:32} {ilk}')
        browser.close()
    print(f'duman testi: {gecen} geçti · {kalan} kaldı')
    return 1 if kalan else 0


if __name__ == '__main__':
    sys.exit(main())
