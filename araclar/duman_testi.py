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

Ödev modu (?odev=KOD) senaryoları SAHTE bir uç noktayla koşar; Google'a hiçbir istek gitmez:
  - Sahte uç nokta ayrı portta gerçek bir HTTP sunucusudur (farklı köken → gerçek CORS kuralları).
    Apps Script gibi davranır: /exec yanıtı 302 ile /echo'ya yönlenir, OPTIONS'a CORS'suz 405 döner.
  - Sayfa, ayar.json'da sahte adres olan geçici bir kopyada yap.py ile üretilir; depo dosyalarına dokunulmaz.
  - Senaryolar: pencere açık (tam akış + 2. deneme + bilgilerin hatırlanması), süre doldu, henüz
    açılmadı, geçersiz kod, sunucu saatiyle "süre dışı", gönderim başarısız → kuyruk → düğmeyle ve
    sayfa yeniden açılınca gönderim, kesin ret, adres kurulmamış, ?odev yokken sıfır istek,
    text/plain gövdenin ön-kontrolsüz gidip yanıtının okunabildiği (application/json ise ön-kontrol).
Herhangi bir konsol hatası ya da yakalanmamış JS istisnası = FAIL.
Test ağdan bağımsızdır: yerel sunucu dışındaki istekler (Google Fonts) boş 200 yanıtla
karşılanır; yazı tipi yedeğe düşer, davranış değişmez, CI'da ağ kesintisi testi bozmaz.

Kullanım:  python3 araclar/duman_testi.py      (önce python3 yap.py koşulmuş olmalı)
"""
import contextlib
import functools
import http.server
import io
import json
import pathlib
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse

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
    """Her senaryo için temiz bağlam (boş localStorage) + konsol hatası toplayıcı.
    izinli: dokunulmadan geçecek kökenler (sahte uç nokta). Diğer dış istekler boş yanıtla karşılanır
    ve self.dis listesine yazılır. beklenen_hata: bu metni içeren konsol hataları sayılmaz."""
    def __init__(self, browser, taban, izinli=(), beklenen_hata=None):
        self.ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, locale='tr-TR', timezone_id='Europe/Istanbul')
        self.dis = []
        self.ctx.route(lambda url: not url.startswith(taban) and not url.startswith(tuple(izinli)), self._dis_istek)
        self.page = self.ctx.new_page()
        self.hatalar = []
        self.page.on('console', lambda m: m.type == 'error' and not (beklenen_hata and beklenen_hata in m.text)
                     and self.hatalar.append(f'console.error: {m.text}'))
        self.page.on('pageerror', lambda e: self.hatalar.append(f'JS istisnası: {e}'))
        self.page.clock.install()  # setTimeout/setInterval/performance.now taklit saate bağlanır

    def _dis_istek(self, route):
        self.dis.append(route.request.url)
        tur = 'text/css' if route.request.resource_type == 'stylesheet' else 'application/octet-stream'
        route.fulfill(status=200, content_type=tur, body='')

    def kapat(self):
        self.ctx.close()


def cevapla(page, c):
    """#start tıklanmış olmalı. Bütün soruları desenle cevaplar, (doğru, yanlış, boş) döndürür."""
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
    return dogru, yanlis, bos


def sonuc_denetle(page, c, dogru, yanlis, bos):
    expect(page.locator('#finish')).to_be_visible()
    expect(page.locator('#finish-title')).to_contain_text(f'{dogru}')
    expect(page.locator('#stats .ok b')).to_have_text(str(dogru))
    expect(page.locator('#stats .no b')).to_have_text(str(yanlis))
    expect(page.locator('#stats > div:nth-child(3) b')).to_have_text(str(bos))
    expect(page.locator('#minisheet > div')).to_have_count(len(c['questions']))
    expect(page.locator('#finish-msg')).not_to_be_empty()


def quiz_senaryosu(browser, taban, c, sayfa=None):
    s = sayfa or Sayfa(browser, taban)
    page = s.page
    try:
        page.goto(taban + '/index.html')
        expect(page.locator('#pick')).to_be_visible()
        page.click(f'#test-{c["slug"]}')
        expect(page.locator('#intro')).to_be_visible()
        expect(page.locator('#total')).to_have_text(str(len(c['questions'])))
        page.click('#start')
        dogru, yanlis, bos = cevapla(page, c)
        sonuc_denetle(page, c, dogru, yanlis, bos)
        if s.hatalar:
            raise AssertionError('; '.join(s.hatalar))
        return f'{len(c["questions"])} soru · {dogru} doğru / {yanlis} yanlış / {bos} süre doldu'
    finally:
        if sayfa is None:
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


# ---------------------------------------------------------------- Ödev modu

GUN = 86400


def iso(t):
    return time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(t))


class SahteUcNokta:
    """apps-script/Kod.gs sözleşmesini taklit eden yerel Apps Script uç noktası (Google'a istek yok).

    Gerçek Apps Script gibi: GET/POST /exec → 302 → GET /echo?id=N (JSON, Access-Control-Allow-Origin: *).
    OPTIONS (CORS ön-kontrolü) desteklenmez: CORS başlıksız 405 döner, yani ön-kontrollü istek başarısız olur.
    """
    def __init__(self):
        simdi = time.time()
        # kod → (test_slug, başlangıç, bitiş, seçenekler)
        self.odevler = {
            'ACIK1': ('do-you-know-me', simdi - GUN, simdi + GUN, {}),
            'KAPALI1': ('do-you-know-me', simdi - 3 * GUN, simdi - 2 * GUN, {}),
            'GELECEK1': ('do-you-know-me', simdi + 2 * GUN, simdi + 3 * GUN, {}),
            # doGet'te açık görünür, POST geldiğinde pencere kapanmış: karar sunucu saatinde
            'GECTI1': ('do-you-know-me', simdi - GUN, simdi + GUN, {'post_sure_disi': True}),
            # doGet'te var, POST geldiğinde öğretmen satırı silmiş: kesin ret
            'SILINDI1': ('do-you-know-me', simdi - GUN, simdi + GUN, {'post_red': True}),
        }
        self.satirlar, self.istekler, self.yanitlar = [], [], {}
        self.post_modu = 'normal'  # 'normal' | 'sunucu_hatasi'
        self.kilit = threading.Lock()

    def sifirla(self, post_modu='normal'):
        with self.kilit:
            self.satirlar.clear()
            self.istekler.clear()
            self.post_modu = post_modu

    def istek_say(self, yontem, yol='/exec'):
        return sum(1 for m, y, _, _ in self.istekler if m == yontem and y == yol)

    def doget(self, q):
        if 'odev' not in q:
            return {'ok': True, 'servis': 'alti-saniye', 'surum': 1}
        o = self.odevler.get(q['odev'][0].strip().upper())
        if not o:
            return {'gecerli': False}
        slug, bas, bit, _ = o
        simdi = time.time()
        return {'gecerli': True, 'test_slug': slug, 'baslangic': iso(bas), 'bitis': iso(bit),
                'acik': bas <= simdi <= bit, 'simdi': iso(simdi)}

    def dopost(self, govde):
        if self.post_modu == 'sunucu_hatasi':
            return {'ok': False, 'hata': 'sunucu_hatasi'}
        try:
            g = json.loads(govde)
        except ValueError:
            return {'ok': False, 'hata': 'gecersiz', 'kalici': True}
        o = self.odevler.get(str(g.get('kod', '')).strip().upper())
        if not o or o[3].get('post_red'):
            return {'ok': False, 'hata': 'bilinmeyen_kod', 'kalici': True}
        if o[0] != g.get('test_slug'):
            return {'ok': False, 'hata': 'test_uyusmuyor', 'kalici': True}
        for r in self.satirlar:
            if r['gonderim_id'] == g['gonderim_id']:
                return {'ok': True, 'durum': r['durum'], 'deneme_no': r['deneme_no'], 'tekrar': True}
        simdi = time.time()
        durum = 'zamanında' if o[1] <= simdi <= o[2] and not o[3].get('post_sure_disi') else 'süre dışı'
        deneme = 1 + sum(1 for r in self.satirlar if r['kod'] == g['kod'] and r['numara'] == g['numara'])
        self.satirlar.append(dict(g, durum=durum, deneme_no=deneme))
        return {'ok': True, 'durum': durum, 'deneme_no': deneme, 'sunucu_zamani': iso(simdi)}

    @contextlib.contextmanager
    def calis(self):
        uc = self

        class Isleyici(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _kaydet(self):
                yol = urllib.parse.urlsplit(self.path)
                with uc.kilit:
                    uc.istekler.append((self.command, yol.path, dict(self.headers), None))
                return yol

            def _yanit(self, kod, govde=b'', basliklar=()):
                self.send_response(kod)
                for k, v in basliklar:
                    self.send_header(k, v)
                self.send_header('Content-Length', str(len(govde)))
                self.end_headers()
                self.wfile.write(govde)

            def _yonlendir(self, veri):
                with uc.kilit:
                    n = len(uc.yanitlar)
                    uc.yanitlar[n] = veri
                self._yanit(302, basliklar=[('Location', f'/echo?id={n}'), ('Access-Control-Allow-Origin', '*')])

            def do_OPTIONS(self):
                self._kaydet()
                self._yanit(405)

            def do_GET(self):
                yol = self._kaydet()
                q = urllib.parse.parse_qs(yol.query, keep_blank_values=True)
                if yol.path == '/exec':
                    return self._yonlendir(uc.doget(q))
                if yol.path == '/echo':
                    veri = uc.yanitlar.get(int(q['id'][0]))
                    return self._yanit(200, json.dumps(veri, ensure_ascii=False).encode(), [
                        ('Content-Type', 'application/json; charset=utf-8'), ('Cache-Control', 'no-store'),
                        ('Access-Control-Allow-Origin', '*')])
                self._yanit(404)

            def do_POST(self):
                yol = self._kaydet()
                govde = self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode('utf-8')
                with uc.kilit:
                    m, y, h, _ = uc.istekler[-1]
                    uc.istekler[-1] = (m, y, h, govde)
                if yol.path != '/exec':
                    return self._yanit(404)
                with uc.kilit:
                    veri = uc.dopost(govde)
                self._yonlendir(veri)

        httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Isleyici)
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        try:
            self.taban = f'http://127.0.0.1:{httpd.server_address[1]}'
            yield self.taban
        finally:
            httpd.shutdown()


@contextlib.contextmanager
def odev_kopyasi(adres):
    """Depo dosyalarına dokunmadan, ayar.json'da sahte uç nokta olan geçici bir sayfa üretir."""
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(KOK))
    import yap  # noqa: E402
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        shutil.copy(KOK / 'sablon.html', tmp / 'sablon.html')
        shutil.copytree(KOK / 'quizler', tmp / 'quizler')
        (tmp / 'ayar.json').write_text(json.dumps({'gonderim_adresi': adres + '/exec'}), encoding='utf-8')
        (tmp / 'bos.html').write_text('<!DOCTYPE html><meta charset="UTF-8"><title>boş</title>', encoding='utf-8')
        cikti = io.StringIO()
        with contextlib.redirect_stdout(cikti), contextlib.redirect_stderr(cikti):
            kod = yap.main([], kok=tmp)
        if kod != 0:
            raise RuntimeError('geçici kopyada yap.py kaldı:\n' + cikti.getvalue())
        # CORS senaryosu için: aynı sayfa, yalnız Google Fonts <link>'leri çıkarılmış (hiç dış istek yok)
        sayfa = (tmp / 'index.html').read_text(encoding='utf-8')
        yazitipsiz = '\n'.join(x for x in sayfa.split('\n') if 'fonts.g' not in x)
        if yazitipsiz.count('<link') != 0 or yazitipsiz.count('\n') != sayfa.count('\n') - 3:
            raise RuntimeError('yazı tipi <link> satırları beklendiği gibi değil')
        (tmp / 'yazitipsiz.html').write_text(yazitipsiz, encoding='utf-8')
        yield tmp


class Odev:
    """Ödev senaryolarının ortak ortamı: sahte uç nokta + onu gömen sayfa."""
    def __init__(self, browser, taban, uc, quizler):
        self.browser, self.taban, self.uc = browser, taban, uc
        self.quiz = {c['slug']: c for c in quizler}

    def sayfa(self, beklenen_hata=None):
        return Sayfa(self.browser, self.taban, izinli=(self.uc.taban,), beklenen_hata=beklenen_hata)

    def kuyruk(self, page):
        return json.loads(page.evaluate("localStorage.getItem('alti-saniye:odev-kuyruk')") or '[]')

    def ac(self, page, kod, hash_='#do-you-know-me'):
        page.goto(f'{self.taban}/index.html?odev={kod}{hash_}')
        expect(page.locator('#odev')).to_be_visible()

    def bilgi_gir(self, page, no='0123', ad='Deneme Öğrenci'):
        expect(page.locator('#who')).to_be_visible()
        page.fill('#who-no', no)
        page.fill('#who-name', ad)
        page.click('#who-go')
        expect(page.locator('#intro')).to_be_visible()

    def coz(self, page, slug='do-you-know-me'):
        c = self.quiz[slug]
        page.click('#start')
        d, y, b = cevapla(page, c)
        sonuc_denetle(page, c, d, y, b)
        return d, y, b

    def bitir(self, s):
        if s.hatalar:
            raise AssertionError('; '.join(s.hatalar))
        on = self.uc.istek_say('OPTIONS')
        if on:
            raise AssertionError(f'{on} CORS ön-kontrolü (OPTIONS) geldi — gövde text/plain olmalı')


def eşit(gelen, beklenen, ne):
    if gelen != beklenen:
        raise AssertionError(f'{ne}: beklenen {beklenen!r}, gelen {gelen!r}')


def odev_acik(o):
    o.uc.sifirla()
    s = o.sayfa()
    page = s.page
    c = o.quiz['do-you-know-me']
    try:
        o.ac(page, 'ACIK1', '#ingilizce-8')  # linkteki # başka test: sunucunun test_slug'ı esas
        expect(page.locator('#odev-eyebrow')).to_have_text('Ödev · ' + c['name'])
        expect(page.locator('#odev-lead')).to_contain_text('Son teslim')
        expect(page.locator('#pick')).to_be_hidden()
        # iki alan da zorunlu
        page.click('#who-go')
        expect(page.locator('#who-err')).to_have_text('Okul numaranı yaz.')
        page.fill('#who-no', '12a')
        page.click('#who-go')
        expect(page.locator('#who-err')).to_contain_text('yalnız rakam')
        page.fill('#who-no', '0123')
        page.fill('#who-name', 'Deneme')
        page.click('#who-go')
        expect(page.locator('#who-err')).to_contain_text('soyadını')
        expect(page.locator('#intro')).to_be_hidden()
        page.fill('#who-name', '  Deneme   Öğrenci ')
        page.click('#who-go')
        expect(page.locator('#intro')).to_be_visible()
        expect(page.locator('#hero-top')).to_have_text(c['heroTop'])
        expect(page.locator('#eyebrow')).to_have_text('Ödev · Deneme Öğrenci')
        expect(page.locator('.modes')).to_be_hidden()  # Sunum (cevapları kendiliğinden yakan mod) ödevde yok
        d, y, b = o.coz(page)
        expect(page.locator('#send')).to_have_class('send ok')
        expect(page.locator('#send-title')).to_have_text('Öğretmene gönderildi ✓')
        expect(page.locator('#send-text')).to_contain_text('1. deneme')
        expect(page.locator('#to-tests')).to_be_hidden()
        eşit(len(o.uc.satirlar), 1, 'kaydedilen satır')
        r = o.uc.satirlar[0]
        for k, v in {'kod': 'ACIK1', 'test_slug': 'do-you-know-me', 'numara': '0123', 'ad_soyad': 'Deneme Öğrenci',
                     'dogru': d, 'yanlis': y, 'bos': b, 'puan': round(100 * d / len(c['questions']), 1),
                     'durum': 'zamanında', 'deneme_no': 1}.items():
            eşit(r[k], v, k)
        eşit(len(r['cevaplar'].split()), len(c['questions']), 'cevaplar')
        tur = [h for m, _, h, _ in o.uc.istekler if m == 'POST'][0].get('Content-Type', '')
        if not tur.startswith('text/plain'):
            raise AssertionError(f'POST gövdesi text/plain değil: {tur}')
        eşit(o.kuyruk(page), [], 'kuyruk')
        # ikinci deneme engellenmez, deneme_no artar
        page.click('#again')
        d2, y2, b2 = cevapla(page, c)
        expect(page.locator('#send-text')).to_contain_text('2. deneme')
        eşit([x['deneme_no'] for x in o.uc.satirlar], [1, 2], 'deneme_no')
        # bilgiler hatırlanır ve değiştirilebilir
        page.reload()
        expect(page.locator('#who')).to_be_visible()
        expect(page.locator('#who-no')).to_have_value('0123')
        expect(page.locator('#who-name')).to_have_value('Deneme Öğrenci')
        page.click('#who-go')
        expect(page.locator('#intro')).to_be_visible()
        page.click('#back')
        expect(page.locator('#who')).to_be_visible()
        o.bitir(s)
        return f'form → {len(c["questions"])} soru → gönderildi ✓ · 2. deneme · bilgiler hatırlandı'
    finally:
        s.kapat()


def odev_kapali(o, kod, baslik, parca):
    o.uc.sifirla()
    s = o.sayfa()
    page = s.page
    try:
        o.ac(page, kod)
        expect(page.locator('#odev-note-title')).to_have_text(baslik)
        expect(page.locator('#odev-note-text')).to_contain_text(parca)
        expect(page.locator('#who')).to_be_hidden()
        expect(page.locator('#intro')).to_be_hidden()
        eşit(o.uc.istek_say('POST'), 0, 'POST')
        o.bitir(s)
        return page.locator('#odev-note-text').inner_text()
    finally:
        s.kapat()


def odev_gecersiz(o):
    o.uc.sifirla()
    s = o.sayfa()
    page = s.page
    try:
        o.ac(page, 'YOKKOD')
        expect(page.locator('#odev-note-title')).to_have_text('Ödev bulunamadı')
        expect(page.locator('#who')).to_be_hidden()
        eşit(o.uc.istek_say('GET'), 1, 'sunucuya sorulan GET')
        o.ac(page, '..%2Fx')  # biçimi geçersiz kod: sunucuya hiç sorulmaz
        expect(page.locator('#odev-note-text')).to_contain_text('geçersiz')
        eşit(o.uc.istek_say('GET'), 1, 'geçersiz biçimde GET')
        o.bitir(s)
        return 'bilinmeyen kod → "bulunamadı" · bozuk kod → istek yok'
    finally:
        s.kapat()


def odev_sure_disi(o):
    o.uc.sifirla()
    s = o.sayfa()
    page = s.page
    try:
        o.ac(page, 'GECTI1')
        o.bilgi_gir(page)
        o.coz(page)
        expect(page.locator('#send-title')).to_have_text('Öğretmene gönderildi ✓')
        expect(page.locator('#send-text')).to_contain_text('süre dışı')
        eşit(o.uc.satirlar[0]['durum'], 'süre dışı', 'durum')
        o.bitir(s)
        return 'sayfa açıkken başladı, sunucu "süre dışı" kaydetti'
    finally:
        s.kapat()


def odev_kuyruk_dugme(o):
    """Ağ yok → Gönderilemedi + kuyruk → düğme (hâlâ yok) → ağ gelir → düğme → gönderildi."""
    o.uc.sifirla()
    s = o.sayfa(beklenen_hata='ERR_INTERNET_DISCONNECTED')
    page = s.page
    kes = lambda r: r.abort('internetdisconnected') if r.request.method == 'POST' else r.fallback()  # noqa: E731
    try:
        o.ac(page, 'ACIK1')
        o.bilgi_gir(page)
        page.route(o.uc.taban + '/exec', kes)
        o.coz(page)
        expect(page.locator('#send-title')).to_have_text('Gönderilemedi — tekrar dene')
        expect(page.locator('#send-retry')).to_be_visible()
        k = o.kuyruk(page)
        eşit(len(k), 1, 'kuyruk')
        page.click('#send-retry')
        expect(page.locator('#send-title')).to_have_text('Gönderilemedi — tekrar dene')
        expect(page.locator('#send-retry')).to_be_enabled()
        eşit(len(o.kuyruk(page)), 1, 'kuyruk (ağ hâlâ yok)')
        page.unroute(o.uc.taban + '/exec', kes)
        page.click('#send-retry')
        expect(page.locator('#send-title')).to_have_text('Öğretmene gönderildi ✓')
        expect(page.locator('#send-retry')).to_be_hidden()
        eşit(o.kuyruk(page), [], 'kuyruk')
        eşit([r['gonderim_id'] for r in o.uc.satirlar], [k[0]['gonderim_id']], 'kaydedilen gönderim')
        o.bitir(s)
        return 'ağ yok → kuyrukta 1 → "Tekrar dene" → gönderildi ✓, tek satır'
    finally:
        s.kapat()


def odev_kuyruk_yeniden_ac(o):
    """Sunucu hata veriyor → kuyruk → sayfa yeniden açılır (hâlâ hata) → düzelir → yeniden açılış gönderir."""
    o.uc.sifirla('sunucu_hatasi')
    s = o.sayfa()
    page = s.page
    try:
        o.ac(page, 'ACIK1')
        o.bilgi_gir(page)
        o.coz(page)
        expect(page.locator('#send-title')).to_have_text('Gönderilemedi — tekrar dene')
        k = o.kuyruk(page)
        eşit(len(k), 1, 'kuyruk')
        page.reload()
        expect(page.locator('#queue-note')).to_contain_text('bekliyor')
        eşit(len(o.kuyruk(page)), 1, 'kuyruk (sunucu hâlâ hatalı)')
        o.uc.post_modu = 'normal'
        page.reload()
        expect(page.locator('#queue-note')).to_contain_text('öğretmenine gönderildi ✓')
        expect(page.locator('#who')).to_be_visible()
        eşit(o.kuyruk(page), [], 'kuyruk')
        eşit([r['gonderim_id'] for r in o.uc.satirlar], [k[0]['gonderim_id']], 'kaydedilen gönderim')
        o.bitir(s)
        return f'{o.uc.istek_say("POST")} POST denemesi → kuyruk boşaldı, tek satır'
    finally:
        s.kapat()


def odev_kesin_red(o):
    o.uc.sifirla()
    s = o.sayfa()
    page = s.page
    try:
        o.ac(page, 'SILINDI1')
        o.bilgi_gir(page)
        o.coz(page)
        expect(page.locator('#send-title')).to_have_text('Gönderilemedi')
        expect(page.locator('#send-retry')).to_be_hidden()
        eşit(o.kuyruk(page), [], 'kuyruk')
        eşit(o.uc.satirlar, [], 'kaydedilen')
        o.bitir(s)
        return 'bilinmeyen kod → kaydedilmedi, kuyruktan düştü'
    finally:
        s.kapat()


def odev_kurulmamis(browser, taban):
    s = Sayfa(browser, taban)
    page = s.page
    try:
        page.goto(taban + '/index.html?odev=ACIK1#do-you-know-me')
        expect(page.locator('#odev-note-title')).to_have_text('Ödev gönderimi kurulmamış')
        expect(page.locator('#who')).to_be_hidden()
        google = [u for u in s.dis if 'script.google' in u]
        eşit(google, [], 'Apps Script isteği')
        if s.hatalar:
            raise AssertionError('; '.join(s.hatalar))
        return 'yer tutucu adres → uyarı, istek yok'
    finally:
        s.kapat()


def odev_parametresiz(o):
    """?odev yoksa: sahte uç noktaya sıfır istek, ödev ekranı/kutusu görünmez, ödev anahtarı yazılmaz."""
    o.uc.sifirla()
    s = o.sayfa()
    try:
        ayrinti = quiz_senaryosu(o.browser, o.taban, o.quiz['do-you-know-me'], sayfa=s)
        expect(s.page.locator('#send')).to_be_hidden()
        expect(s.page.locator('#odev')).to_be_hidden()
        anahtarlar = s.page.evaluate('Object.keys(localStorage).sort()')
        eşit([a for a in anahtarlar if 'odev' in a or 'ogrenci' in a], [], 'ödev anahtarları')
        eşit(o.uc.istekler, [], 'uç noktaya istek')
        return ayrinti + ' · uç noktaya 0 istek'
    finally:
        s.kapat()


def odev_cors(o):
    """Ön-kontrol kanıtı. Playwright'ta route() açıkken CORS ön-kontrolünü Playwright kendisi karşılar,
    OPTIONS sunucuya ulaşmaz; bu yüzden bu senaryo HİÇ route olmayan bir bağlamda koşar. Sayfa,
    yalnız Google Fonts <link>'leri çıkarılmış aynı index.html'dir (yazitipsiz.html): hiç dış istek yok.
    1) Gerçek motorla tam ödev akışı: POST sunucuya ulaşır, 0 OPTIONS, yanıt okunur (gönderildi ✓).
    2) Negatif kontrol: aynı çağrı application/json ile → OPTIONS gelir, istek düşer."""
    o.uc.sifirla()
    ctx = o.browser.new_context(locale='tr-TR', timezone_id='Europe/Istanbul')
    page = ctx.new_page()
    hatalar = []
    page.on('console', lambda m: m.type == 'error' and hatalar.append(m.text))
    page.on('pageerror', lambda e: hatalar.append(str(e)))
    dis = []  # yerel olmayan hiçbir istek olmamalı
    page.on('request', lambda r: not r.url.startswith('http://127.0.0.1') and dis.append(r.url))
    page.clock.install()
    try:
        page.goto(f'{o.taban}/yazitipsiz.html?odev=ACIK1#do-you-know-me')
        o.bilgi_gir(page)
        o.coz(page)
        expect(page.locator('#send-title')).to_have_text('Öğretmene gönderildi ✓')
        eşit(o.uc.istek_say('POST'), 1, 'POST')
        eşit(o.uc.istek_say('OPTIONS'), 0, 'text/plain ile OPTIONS')
        eşit(o.uc.istek_say('GET', '/echo'), 2, '302 sonrası okunan yanıt (GET + POST)')
        if hatalar or dis:
            raise AssertionError('; '.join(hatalar + [f'dış istek: {u}' for u in dis]))
        js = """async () => { try { const r = await fetch(%r, {method: 'POST', headers: {'Content-Type': 'application/json'},
                 body: '{}'}); await r.json(); return 'OKUNDU'; } catch (e) { return 'HATA ' + e.name; } }""" % (o.uc.taban + '/exec')
        jsn = page.evaluate(js)
        if jsn == 'OKUNDU' or o.uc.istek_say('OPTIONS') != 1 or o.uc.istek_say('POST') != 1:
            raise AssertionError(f'application/json ön-kontrol beklenirdi: {jsn}, OPTIONS={o.uc.istek_say("OPTIONS")}')
        return 'text/plain: 0 OPTIONS, yanıt okundu ✓ · application/json: OPTIONS → düştü'
    finally:
        ctx.close()


def main():
    if not (KOK / 'index.html').exists():
        sys.exit('index.html yok — önce python3 yap.py')
    quizler = quizleri_oku()
    gecen = kalan = 0

    def kos(ad, fn, *a):
        nonlocal gecen, kalan
        try:
            ayrinti = fn(*a)
            gecen += 1
            print(f'  ✓ {ad:32} {ayrinti}')
        except Exception as e:  # noqa: BLE001 — her senaryo bağımsız raporlanır
            kalan += 1
            ilk = str(e).strip().splitlines()[0] if str(e).strip() else type(e).__name__
            print(f'  ✗ {ad:32} {ilk}')

    uc = SahteUcNokta()
    with sunucu(KOK) as taban, uc.calis() as uc_taban, odev_kopyasi(uc_taban) as kopya, \
            sunucu(kopya) as odev_taban, sync_playwright() as pw:
        browser = pw.chromium.launch()
        for c in quizler:
            kos(f'akış   {c["slug"]}', quiz_senaryosu, browser, taban, c)
        for c in quizler:
            kos(f'yönlen {c["slug"]}', yonlendirme_senaryosu, browser, taban, c)

        o = Odev(browser, odev_taban, uc, quizler)
        kos('ödev   pencere açık', odev_acik, o)
        kos('ödev   süre doldu', odev_kapali, o, 'KAPALI1', 'Süre doldu', 'tarihinde doldu')
        kos('ödev   henüz açılmadı', odev_kapali, o, 'GELECEK1', 'Henüz açılmadı', 'tarihinde açılacak')
        kos('ödev   geçersiz kod', odev_gecersiz, o)
        kos('ödev   süre dışı (sunucu saati)', odev_sure_disi, o)
        kos('ödev   gönderilemedi → düğme', odev_kuyruk_dugme, o)
        kos('ödev   gönderilemedi → yeniden aç', odev_kuyruk_yeniden_ac, o)
        kos('ödev   kesin ret', odev_kesin_red, o)
        kos('ödev   adres kurulmamış', odev_kurulmamis, browser, taban)
        kos('ödev   ?odev yok → 0 istek', odev_parametresiz, o)
        kos('ödev   CORS: text/plain', odev_cors, o)
        browser.close()
    print(f'duman testi: {gecen} geçti · {kalan} kaldı')
    return 1 if kalan else 0


if __name__ == '__main__':
    sys.exit(main())
