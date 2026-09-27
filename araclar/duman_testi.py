#!/usr/bin/env python3
"""Altı Saniye — tarayıcı duman testi (Playwright, Chromium, başsız).

Üretilmiş index.html'i yerel bir HTTP sunucusundan açar ve her test için:
  test seçimi → Başla → bütün sorular → sonuç ekranı
akışını gerçek tarayıcıda yürütür. Motor değiştirilmez; 12 saniyelik zamanlayıcı
Playwright'ın saat taklidiyle (page.clock) ileri sarılır, test bu yüzden saniyeler sürer.

Cevap deseni (soru sırası p = 0, 1, 2, ...):
  p % 3 == 0 → doğru şıkka tıkla
  p % 3 == 1 → yanlış şıkka tıkla
  p % 3 == 2 → hiç dokunma, 12 sn dolsun (zamanlayıcı yolu)
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
Öğretmen paneli (?panel#ANAHTAR) senaryoları: anahtarsız/yanlış anahtar, ödev listesi, ödev oluşturma
→ WhatsApp linki → o linkin öğrenci olarak açılıp ödev formuna inmesi, sıralamanın WhatsApp'ta paylaşımı; ChatGPT'den
yapıştırılan testin (araclar/ornek_chatgpt.txt, öğretmenin gerçek çıktısı) okunması, dengelenmesi,
kaydedilmesi, o testle ödev verilip öğrencinin çözmesi; hatalı yapıştırmaların yakalanması.
Herhangi bir konsol hatası ya da yakalanmamış JS istisnası = FAIL.
Test ağdan bağımsızdır: yerel sunucu dışındaki istekler (Google Fonts) boş 200 yanıtla
karşılanır; yazı tipi yedeğe düşer, davranış değişmez, CI'da ağ kesintisi testi bozmaz.

Kullanım:  python3 araclar/duman_testi.py      (önce python3 yap.py koşulmuş olmalı)
"""
import calendar
import contextlib
import functools
import http.server
import io
import json
import pathlib
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse

KOK = pathlib.Path(__file__).resolve().parent.parent
ASK_MS = 12000

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


TR_HARF = set('çğıöşüÇĞİÖŞÜ')


def buyuk(metin):
    """Ekranda beklenen büyük harf: Türkçe harf içeren " · " parçası Türkçe kuralla (i→İ, ı→I),
    içermeyen parça İngilizce kuralla (i→I) büyütülür. FRİENDSHİP gibi karışık yazım olmamalı."""
    return ' · '.join(p.replace('i', 'İ').replace('ı', 'I').upper() if TR_HARF & set(p) else p.upper()
                      for p in metin.split(' · '))


def quiz_senaryosu(browser, taban, c, sayfa=None):
    s = sayfa or Sayfa(browser, taban)
    page = s.page
    try:
        page.goto(taban + '/index.html')
        expect(page.locator('#pick')).to_be_visible()
        page.click(f'#test-{c["slug"]}')
        expect(page.locator('#intro')).to_be_visible()
        expect(page.locator('#total')).to_have_text(str(len(c['questions'])))
        # büyük harfli başlıklar: innerText CSS text-transform'u uygular
        for sec, metin in (('#eyebrow', c['eyebrow']), ('#hero-top', c['heroTop']), ('#hero-bottom', c['heroBottom'])):
            eşit(page.locator(sec).inner_text(), buyuk(metin), f'{sec} büyük harf')
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
PANEL_ANAHTAR = 'f0' * 20


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
        self.testler = {}  # öğretmenin kendi testleri: slug → {ad, sorular}
        self.post_modu = 'normal'  # 'normal' | 'sunucu_hatasi'
        self.kilit = threading.Lock()

    def sifirla(self, post_modu='normal'):
        with self.kilit:
            self.satirlar.clear()
            self.istekler.clear()
            self.post_modu = post_modu
            for k in [k for k in self.odevler if k.startswith('P')]:
                del self.odevler[k]  # panelden eklenenler
            self.testler.clear()

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
        yanit = {'gecerli': True, 'test_slug': slug, 'baslangic': iso(bas), 'bitis': iso(bit),
                 'acik': bas <= simdi <= bit, 'simdi': iso(simdi)}
        if slug in self.testler:
            yanit['test'] = self.testler[slug]
        return yanit

    def dopost(self, govde):
        if self.post_modu == 'sunucu_hatasi':
            return {'ok': False, 'hata': 'sunucu_hatasi'}
        try:
            g = json.loads(govde)
        except ValueError:
            return {'ok': False, 'hata': 'gecersiz', 'kalici': True}
        if 'islem' in g:
            return self.panel(g)
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

    def panel(self, g):
        """Kod.gs panelIslem_ sözleşmesi: odevler / odev_ekle / siralama, anahtarla."""
        if g.get('anahtar') != PANEL_ANAHTAR:
            return {'ok': False, 'hata': 'yetkisiz', 'kalici': True}
        kisi = lambda r: (r['numara'], r['ad_soyad'].lower())  # noqa: E731
        if g['islem'] == 'odevler':
            liste = []
            for kod, (slug, bas, bit, sec) in reversed(list(self.odevler.items())):
                katilan = len({kisi(r) for r in self.satirlar if r['kod'] == kod})
                liste.append({'kod': kod, 'test_slug': slug, 'baslangic': iso(bas), 'bitis': iso(bit),
                              'sinif': sec.get('sinif', ''), 'katilan': katilan})
            testler, gorulen = [], set()
            for k, t in reversed(list(self.testler.items())):  # Kod.gs gibi: aynı hazır testin yalnız en yeni onayı
                if t.get('kaynak'):
                    if t['kaynak'] in gorulen:
                        continue
                    gorulen.add(t['kaynak'])
                testler.append({'slug': k, 'ad': t['ad'], 'n': len(t['sorular']), 'kaynak': t.get('kaynak', '')})
            return {'ok': True, 'odevler': liste, 'testler': testler}
        if g['islem'] == 'test_ekle':
            sor = g.get('sorular') or []
            if not g.get('ad') or not 5 <= len(sor) <= 40 or not all(len(q['o']) == 4 and 0 <= q['a'] <= 3 for q in sor):
                return {'ok': False, 'hata': 'gecersiz', 'kalici': True}
            if g.get('kaynak') and (not re.match(r'^[a-z0-9][a-z0-9-]{0,59}$', g['kaynak']) or g['kaynak'].startswith('ozel-')):
                return {'ok': False, 'hata': 'kaynak', 'kalici': True}
            slug = f'ozel-test-{len(self.testler):04d}'
            self.testler[slug] = {'ad': g['ad'], 'sorular': sor, 'kaynak': g.get('kaynak') or ''}
            return {'ok': True, 'test_slug': slug, 'ad': g['ad'], 'n': len(sor), 'kaynak': g.get('kaynak') or ''}
        if g['islem'] == 'test_getir':
            t = self.testler.get(g.get('slug'))
            return {'ok': True, 'test': t} if t else {'ok': False, 'hata': 'yok', 'kalici': True}
        if g['islem'] == 'odev_ekle':
            y, a, gun = map(int, g['bitis'][:10].split('-'))
            bit = calendar.timegm((y, a, gun, 23, 59, 0)) - 3 * 3600  # Kod.gs gibi e-tablo saat diliminde (İstanbul, UTC+3)
            if bit <= time.time():
                return {'ok': False, 'hata': 'gecmis_tarih', 'kalici': True}
            kod = 'P' + str(len(self.odevler)).zfill(5)
            self.odevler[kod] = (g['test_slug'], time.time() - 60, bit, {'sinif': g.get('sinif', '')})
            return {'ok': True, 'kod': kod, 'test_slug': g['test_slug'], 'bitis': iso(bit), 'sinif': g.get('sinif', '')}
        if g['islem'] == 'siralama':
            ilk = {}
            for r in self.satirlar:
                if r['kod'] == g['kod'] and kisi(r) not in ilk:
                    ilk[kisi(r)] = r
            sira = sorted(ilk.values(), key=lambda r: (-r['puan'], r['istemci_sure_ms']))
            metin = '🏆 Ödev sıralaması\n\n' + '\n'.join(f"{i + 1}. {r['ad_soyad']} — {r['puan']}" for i, r in enumerate(sira))
            return {'ok': True, 'kod': g['kod'], 'katilan': len(sira), 'metin': metin if sira else '',
                    # doğru/yanlış/boş yalnız gönderimde varsa: yoksa eski sunucu gibi davranır (panel yalnız puan yazar)
                    'satirlar': [{'ad': r['ad_soyad'], 'puan': r['puan'], 'durum': r['durum'], 'sinif': r.get('sinif_sube', ''),
                                  **{k: r[k] for k in ('dogru', 'yanlis', 'bos') if k in r}} for r in sira]}
        return {'ok': False, 'hata': 'gecersiz', 'kalici': True}

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
    """Depo dosyalarına dokunmadan, ayar.json'da sahte uç nokta olan geçici bir sayfa üretir.
    adres None ise ayar.json yer tutucu olur ("kurulmamış" senaryosu; depodaki gerçek adresten bağımsız)."""
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(KOK))
    import yap  # noqa: E402
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        shutil.copy(KOK / 'sablon.html', tmp / 'sablon.html')
        shutil.copytree(KOK / 'quizler', tmp / 'quizler')
        gonderim = yap.YER_TUTUCU if adres is None else adres + '/exec'
        (tmp / 'ayar.json').write_text(json.dumps({'gonderim_adresi': gonderim}), encoding='utf-8')
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

    def bilgi_gir(self, page, no='0123', ad='Deneme Öğrenci', sinif='8-A'):
        expect(page.locator('#who')).to_be_visible()
        page.fill('#who-no', no)
        page.fill('#who-name', ad)
        page.fill('#who-sinif', sinif)
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
        # üç alan da zorunlu: numara, ad soyad, sınıf/şube
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
        expect(page.locator('#who-err')).to_have_text('Sınıfını ve şubeni yaz (ör. 8-A).')
        expect(page.locator('#who-sinif')).to_be_focused()
        for yanlis in ('8', 'A', '8-AB', '13-A'):
            page.fill('#who-sinif', yanlis)
            page.click('#who-go')
            expect(page.locator('#who-err')).to_contain_text('8-A gibi yaz')
            expect(page.locator('#intro')).to_be_hidden()
        page.fill('#who-sinif', ' 8 a ')
        page.click('#who-go')
        expect(page.locator('#intro')).to_be_visible()
        expect(page.locator('#who-sinif')).to_have_value('8-A')
        expect(page.locator('#hero-top')).to_have_text(c['heroTop'])
        expect(page.locator('#eyebrow')).to_have_text('Ödev · Deneme Öğrenci')
        expect(page.locator('.modes')).to_be_hidden()  # Sunum (cevapları kendiliğinden yakan mod) ödevde yok
        expect(page.locator('#lead')).to_contain_text('12 saniye')
        page.click('#start')
        # ödevde durdurma yok: düğme görünmez; boşluk tuşu ve sekme değiştirme süreyi durdurmaz
        expect(page.locator('#play')).to_be_visible()
        expect(page.locator('#digit')).to_have_text('12')
        expect(page.locator('#pause')).to_be_hidden()
        page.keyboard.press('Space')
        page.evaluate("Object.defineProperty(document, 'hidden', {value: true, configurable: true}); document.dispatchEvent(new Event('visibilitychange'))")
        eşit(page.evaluate("document.getElementById('app').classList.contains('paused')"), False, 'ödevde durdurulmamalı')
        page.evaluate("delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))")
        d, y, b = cevapla(page, c)
        sonuc_denetle(page, c, d, y, b)
        expect(page.locator('#send')).to_have_class('send ok')
        expect(page.locator('#send-title')).to_have_text('Öğretmene gönderildi ✓')
        expect(page.locator('#send-text')).to_contain_text('No 0123 · 8-A · Deneme Öğrenci · 1. deneme')
        expect(page.locator('#to-tests')).to_be_hidden()
        eşit(len(o.uc.satirlar), 1, 'kaydedilen satır')
        r = o.uc.satirlar[0]
        for k, v in {'kod': 'ACIK1', 'test_slug': 'do-you-know-me', 'numara': '0123', 'ad_soyad': 'Deneme Öğrenci', 'sinif_sube': '8-A',
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
        expect(page.locator('#who-sinif')).to_have_value('8-A')
        page.click('#who-go')
        expect(page.locator('#intro')).to_be_visible()
        page.click('#back')
        expect(page.locator('#who')).to_be_visible()
        o.bitir(s)
        return f'form (numara+ad+sınıf/şube) → 12 sn, durdurma yok → {len(c["questions"])} soru → gönderildi ✓ · 2. deneme · bilgiler hatırlandı'
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
        # ödev dışında durdur düğmesi yerinde ve çalışır; süre 12 sn
        s.page.click('#again')
        expect(s.page.locator('#digit')).to_have_text('12')
        expect(s.page.locator('#pause')).to_be_visible()
        s.page.click('#pause')
        expect(s.page.locator('#app')).to_have_class(re.compile(r'\bpaused\b'))
        s.page.click('#pause')
        expect(s.page.locator('#app')).not_to_have_class(re.compile(r'\bpaused\b'))
        s.page.click('#quit')
        expect(s.page.locator('#odev')).to_be_hidden()
        anahtarlar = s.page.evaluate('Object.keys(localStorage).sort()')
        eşit([a for a in anahtarlar if 'odev' in a or 'ogrenci' in a], [], 'ödev anahtarları')
        eşit(o.uc.istekler, [], 'uç noktaya istek')
        return ayrinti + ' · durdur düğmesi çalışıyor · uç noktaya 0 istek'
    finally:
        s.kapat()


def panel_anahtarsiz(o):
    o.uc.sifirla()
    s = o.sayfa()
    page = s.page
    try:
        page.goto(f'{o.taban}/index.html?panel')
        expect(page.locator('#panel')).to_be_visible()
        expect(page.locator('#panel-note-title')).to_have_text('Öğretmen linki gerekli')
        expect(page.locator('#panel-govde')).to_be_hidden()
        eşit(o.uc.istekler, [], 'uç noktaya istek')
        page.goto(f'{o.taban}/index.html?panel#' + 'ab' * 20)  # biçimce geçerli ama yanlış anahtar
        page.reload()
        expect(page.locator('#panel-note-title')).to_have_text('Link geçersiz')
        eşit(page.evaluate("localStorage.getItem('alti-saniye:ogretmen')"), 'null', 'yanlış anahtar saklanmamalı')
        o.bitir(s)
        return 'anahtarsız → "link gerekli", 0 istek · yanlış anahtar → "geçersiz"'
    finally:
        s.kapat()


def panel_odev_olustur(o):
    """Panelden ödev oluştur → WhatsApp mesajındaki link öğrenci olarak açılır ve ödev formuna iner."""
    from urllib.parse import unquote, urlsplit
    o.uc.sifirla()
    s = o.sayfa()
    page = s.page
    try:
        page.goto(f'{o.taban}/index.html?panel#{PANEL_ANAHTAR}')
        expect(page.locator('#panel-govde')).to_be_visible()
        expect(page.locator('#p-odev-ACIK1')).to_be_visible()
        expect(page.locator('#p-test option')).to_have_count(len(o.quiz))
        expect(page.locator('#p-gun')).not_to_have_value('')
        # geçmiş tarih reddedilir
        page.fill('#p-gun', '2020-01-01')
        page.click('#p-olustur')
        expect(page.locator('#p-err')).to_contain_text('bugünden önce')
        gun = time.strftime('%Y-%m-%d', time.localtime(time.time() + 5 * GUN))
        page.select_option('#p-test', 'ingilizce-8-friendship')
        page.fill('#p-gun', gun)
        page.fill('#p-sinif', '8-A')
        page.click('#p-olustur')
        expect(page.locator('#p-sonuc')).to_be_visible()
        href = page.get_attribute('#p-wa', 'href')
        if not href.startswith('https://wa.me/?text='):
            raise AssertionError(f'WhatsApp linki değil: {href}')
        mesaj = unquote(href.split('text=', 1)[1])
        for parca in ('📚 Ödev: 8. Sınıf İngilizce · Unit 1 Friendship (20 soru', '⏰ Son teslim:', '23:59',
                      '?odev=P', '#ingilizce-8-friendship'):
            if parca not in mesaj:
                raise AssertionError(f'mesajda yok: {parca!r} · {mesaj!r}')
        kod = [k for k in o.uc.odevler if k.startswith('P')]
        eşit(len(kod), 1, 'oluşturulan ödev')
        expect(page.locator(f'#p-odev-{kod[0]}')).to_be_visible()  # listeye düştü
        ogrenci_link = mesaj.rsplit('\n', 1)[1]
        parca = urlsplit(ogrenci_link)
        o.bitir(s)
        # mesajdaki link öğrencinin telefonunda: ödev formu açılır, test Friendship
        s2 = o.sayfa()
        try:
            s2.page.goto(f'{o.taban}{parca.path}?{parca.query}#{parca.fragment}')
            expect(s2.page.locator('#who')).to_be_visible()
            expect(s2.page.locator('#odev-eyebrow')).to_contain_text('Friendship')
            o.bitir(s2)
        finally:
            s2.kapat()
        return f'ödev {kod[0]} oluştu → WhatsApp mesajı → öğrenci linki ödev formunu açtı'
    finally:
        s.kapat()


def panel_siralama(o):
    o.uc.sifirla()
    # Ali Can'ın gönderiminde doğru/yanlış/boş var; Ayşe'ninkinde yok (eski sunucu yanıtı gibi: yalnız puan)
    for no, ad, puan, ek in (('5', 'Ayşe Kaya', 70, {}), ('6', 'Ali Can', 90, {'dogru': 9, 'yanlis': 0, 'bos': 1, 'sinif_sube': '8-A'}),
                             ('5', 'Ayşe Kaya', 100, {})):
        o.uc.dopost(json.dumps({'kod': 'ACIK1', 'test_slug': 'do-you-know-me', 'numara': no, 'ad_soyad': ad,
                                'puan': puan, 'istemci_sure_ms': 1000, 'gonderim_id': f'g-{no}-{puan}', **ek}))
    s = o.sayfa()
    page = s.page
    try:
        page.goto(f'{o.taban}/index.html?panel#{PANEL_ANAHTAR}')
        kart = page.locator('#p-odev-ACIK1')
        expect(kart.locator('.p-katilan')).to_have_text('👥 2 öğrenci çözdü')
        kart.locator('.p-sira').click()
        expect(kart.locator('.prank li')).to_have_count(2)
        expect(kart.locator('.prank li').first).to_have_text('🥇 Ali Can (8-A) — 90 puan · 9 doğru, 0 yanlış, 1 boş')
        expect(kart.locator('.prank li').nth(1)).to_have_text('🥈 Ayşe Kaya — 70')
        href = kart.locator('.p-sira-wa').get_attribute('href')
        from urllib.parse import unquote
        if not href.startswith('https://wa.me/?text=') or 'Ali Can — 90' not in unquote(href):
            raise AssertionError(f'sıralama WhatsApp linki hatalı: {href}')
        o.bitir(s)
        return 'katılan 2 · sıralama listesi (puan + doğru/yanlış/boş) · "WhatsApp\'ta paylaş" linki'
    finally:
        s.kapat()


def panel_ozel_test(o):
    """Öğretmenin gerçek ChatGPT çıktısı → panelde kontrol → dengele → kaydet → o testle ödev → öğrenci çözer."""
    from urllib.parse import unquote, urlsplit
    o.uc.sifirla()
    metin = (KOK / 'araclar' / 'ornek_chatgpt.txt').read_text(encoding='utf-8')
    s = o.sayfa()
    page = s.page
    try:
        page.goto(f'{o.taban}/index.html?panel#{PANEL_ANAHTAR}')
        expect(page.locator('#p-odev-ACIK1')).to_be_visible()
        page.click('#t-kart summary')
        expect(page.locator('#t-metin')).to_be_visible()
        page.fill('#t-metin', metin)
        page.click('#t-kontrol')
        expect(page.locator('#t-ozet')).to_contain_text('20 soru bulundu')
        expect(page.locator('#t-hatalar')).to_be_hidden()
        expect(page.locator('#t-uyarilar')).to_contain_text('3. soru: ne sorulduğu belli değil')
        expect(page.locator('#t-onizleme > li')).to_have_count(20)
        expect(page.locator('#t-ad')).to_have_value('Friendship')
        harfler = [t[0] for t in page.locator('#t-onizleme .dogru').all_inner_texts()]
        eşit(sorted({h: harfler.count(h) for h in 'ABCD'}.items()), [('A', 5), ('B', 5), ('C', 5), ('D', 5)], 'dengelenmiş cevaplar')
        page.fill('#t-ad', 'Friendship (ChatGPT)')
        page.click('#t-kaydet')
        expect(page.locator('#t-tamam')).to_contain_text('kaydedildi')
        eşit(len(o.uc.testler), 1, 'kaydedilen test')
        slug, t = next(iter(o.uc.testler.items()))
        eşit(page.locator('#p-test').input_value(), slug, 'seçili test')
        expect(page.locator('#p-test optgroup[label="Kendi testlerin"] option')).to_have_count(1)
        eşit(t['sorular'][0]['q'], 'I always help my friends when they have problems. I am very ____.', '1. soru')
        eşit(t['sorular'][19]['q'], 'A good friend should always ____ your feelings.', '20. soru (boşluk korunmalı)')
        dogrular = [q['o'][q['a']] for q in t['sorular']]
        eşit((dogrular[0], dogrular[6], dogrular[19]), ('loyal', 'Refusing', 'respect'), 'dengelemeden sonra doğru cevaplar aynı')
        eşit(t['sorular'][1]['tr'], 'Davete olumlu cevap vermek için “Sure, why not?” kullanılır.', 'açıklama')
        # bu testle ödev → WhatsApp mesajı → öğrenci
        page.fill('#p-gun', time.strftime('%Y-%m-%d', time.localtime(time.time() + 5 * GUN)))
        page.click('#p-olustur')
        expect(page.locator('#p-sonuc')).to_be_visible()
        mesaj = unquote(page.get_attribute('#p-wa', 'href').split('text=', 1)[1])
        for parca in ('📚 Ödev: Friendship (ChatGPT) (20 soru', f'#{slug}', '?odev=P'):
            if parca not in mesaj:
                raise AssertionError(f'mesajda yok: {parca!r} · {mesaj!r}')
        o.bitir(s)
        link = urlsplit(mesaj.rsplit('\n', 1)[1])
        s2 = o.sayfa()
        try:
            p2 = s2.page
            p2.goto(f'{o.taban}{link.path}?{link.query}#{link.fragment}')
            expect(p2.locator('#odev-eyebrow')).to_have_text('Ödev · Friendship (ChatGPT)')
            o.bilgi_gir(p2)
            c = {'questions': t['sorular']}
            p2.click('#start')
            d, y, b = cevapla(p2, c)
            sonuc_denetle(p2, c, d, y, b)
            expect(p2.locator('#send-title')).to_have_text('Öğretmene gönderildi ✓')
            eşit([r['test_slug'] for r in o.uc.satirlar], [slug], 'kaydedilen sonuç')
            eşit(len(o.uc.satirlar[0]['cevaplar'].split()), 20, 'cevaplar')
            o.bitir(s2)
        finally:
            s2.kapat()
        return f'gerçek ChatGPT çıktısı → 20 soru, 8 uyarı, A5 B5 C5 D5 → kaydedildi → ödev → öğrenci çözdü ({d}/20)'
    finally:
        s.kapat()


def panel_hazir_kontrol(o):
    """Öğretmen hazır testi panelde kontrol eder: düzeltir, doğru şıkkı değiştirir, soru çıkarır, onaylar.
    Onaylı sürüm listede hazır testin yerine geçer, yeniden açılınca onaylanan hâl gelir, ödev onunla gider."""
    from urllib.parse import unquote, urlsplit
    o.uc.sifirla()
    z = next(c for c in quizleri_oku() if c['slug'] == 'ingilizce-8-friendship')
    s = o.sayfa()
    page = s.page
    try:
        page.goto(f'{o.taban}/index.html?panel#{PANEL_ANAHTAR}')
        expect(page.locator('#p-odev-ACIK1')).to_be_visible()
        page.click('#k-kart summary')
        page.select_option('#k-test', 'ingilizce-8-friendship')
        page.click('#k-ac')
        kart = page.locator('#k-sorular > .kq')
        expect(kart).to_have_count(20)
        expect(page.locator('#k-bilgi')).to_contain_text('hazır hâli')
        expect(kart.nth(1).locator('.kq-q')).to_have_value(z['questions'][1]['q'])
        expect(kart.nth(1).locator(f'input[type=radio][value="{z["questions"][1]["a"]}"]')).to_be_checked()
        # 1. soruyu düzelt, 2. sorunun doğru şıkkını değiştir, 3. soruyu çıkar
        kart.nth(0).locator('.kq-q').fill('Ali never tells my secrets.\nHe is very _____.')
        kart.nth(1).locator('.kq-ot').nth(0).fill('helps')
        kart.nth(1).locator('input[type=radio][value="0"]').check()
        kart.nth(2).locator('.kq-cikar').click()
        expect(kart.nth(2)).to_have_class('kq cikti')
        expect(page.locator('#k-kaydet')).to_have_text('Onayla ve kaydet (19 soru)')
        # çıkarılanın yerine yeni soru: boş kart açılır, yazılır
        page.click('#k-ekle')
        expect(kart).to_have_count(21)
        expect(kart.nth(20).locator('.kq-no')).to_have_text('21. soru (yeni)')
        expect(kart.nth(20).locator('.kq-q')).to_be_focused()
        expect(page.locator('#k-kaydet')).to_have_text('Onayla ve kaydet (20 soru)')
        kart.nth(20).locator('.kq-q').fill('A true friend is always _____.')
        for k, x in enumerate(('rude', 'lazy', 'loyal', 'mean')):
            kart.nth(20).locator('.kq-ot').nth(k).fill(x)
        # hatalı hâl kaydedilmez: boş şık, işaretsiz doğru şık
        eski = kart.nth(3).locator('.kq-ot').nth(1).input_value()
        kart.nth(3).locator('.kq-ot').nth(1).fill('  ')
        page.click('#k-kaydet')
        expect(page.locator('#k-hatalar')).to_contain_text('4. soruda boş şık var.')
        expect(page.locator('#k-hatalar')).to_contain_text('21. soruda doğru şık işaretli değil.')
        expect(kart.nth(3)).to_have_class('kq hatali')
        eşit(o.uc.testler, {}, 'hatalıyken kayıt yok')
        kart.nth(3).locator('.kq-ot').nth(1).fill(eski)
        kart.nth(20).locator('input[type=radio][value="2"]').check()
        page.click('#k-kaydet')
        expect(page.locator('#k-tamam')).to_contain_text('onaylandı (20 soru)')
        expect(page.locator('#k-hatalar')).to_be_hidden()
        eşit(len(o.uc.testler), 1, 'kaydedilen onaylı test')
        slug, t = next(iter(o.uc.testler.items()))
        eşit((t['kaynak'], t['ad'], len(t['sorular'])), ('ingilizce-8-friendship', z['name'], 20), 'onaylı test')
        eşit(t['sorular'][0]['q'], 'Ali never tells my secrets.\nHe is very _____.', 'düzeltilen soru')
        eşit((t['sorular'][1]['o'][0], t['sorular'][1]['a']), ('helps', 0), 'değiştirilen doğru şık')
        eşit(t['sorular'][2]['q'], z['questions'][3]['q'], '3. soru çıkarıldı')
        eşit([q['a'] for q in t['sorular'][2:19]], [q['a'] for q in z['questions'][3:]], 'dokunulmayan cevaplar aynı (karıştırılmadı)')
        eşit((t['sorular'][19]['q'], t['sorular'][19]['o'], t['sorular'][19]['a']),
             ('A true friend is always _____.', ['rude', 'lazy', 'loyal', 'mean'], 2), 'eklenen soru sonda')
        eşit({q['c'] for q in t['sorular']}, {'Unit 1 · Friendship'}, 'kategori')
        # onaylı sürüm hazır testin yerine geçer
        eşit(page.locator('#p-test').input_value(), slug, 'Yeni ödev\'de seçili test')
        expect(page.locator('#p-test option[value="ingilizce-8-friendship"]')).to_have_count(0)
        expect(page.locator(f'#p-test optgroup[label="Hazır testler"] option[value="{slug}"]')).to_have_text(z['name'] + ' ✓ onaylı (20 soru)')
        expect(page.locator('#p-test optgroup[label="Kendi testlerin"]')).to_have_count(0)
        expect(page.locator('#k-test option[value="ingilizce-8-friendship"]')).to_have_text(z['name'] + ' ✓ onaylı')
        # yeniden açınca onaylanan hâl gelir
        page.click('#k-ac')
        expect(kart).to_have_count(20)
        expect(page.locator('#k-bilgi')).to_contain_text('Daha önce onayladığın')
        expect(kart.nth(19).locator('.kq-q')).to_have_value('A true friend is always _____.')
        expect(kart.nth(0).locator('.kq-q')).to_have_value('Ali never tells my secrets.\nHe is very _____.')
        # bu testle ödev → öğrenci düzeltilmiş soruları görür, hazır testin görünümüyle
        page.fill('#p-gun', time.strftime('%Y-%m-%d', time.localtime(time.time() + 5 * GUN)))
        page.click('#p-olustur')
        expect(page.locator('#p-sonuc')).to_be_visible()
        mesaj = unquote(page.get_attribute('#p-wa', 'href').split('text=', 1)[1])
        for parca in (f'📚 Ödev: {z["name"]} (20 soru', f'#{slug}'):
            if parca not in mesaj:
                raise AssertionError(f'mesajda yok: {parca!r} · {mesaj!r}')
        o.bitir(s)
        link = urlsplit(mesaj.rsplit('\n', 1)[1])
        s2 = o.sayfa()
        try:
            p2 = s2.page
            p2.goto(f'{o.taban}{link.path}?{link.query}#{link.fragment}')
            expect(p2.locator('#odev-eyebrow')).to_have_text('Ödev · ' + z['name'])
            eşit(p2.locator('#odev-eyebrow').inner_text(), 'ÖDEV · 8. SINIF İNGİLİZCE · UNIT 1 FRIENDSHIP', 'ödev başlığı büyük harf')
            eşit(p2.locator('#odev-top').inner_text(), 'FRIENDSHIP', 'ödev hero büyük harf')
            o.bilgi_gir(p2)
            p2.click('#start')
            expect(p2.locator('#unit')).to_have_text('Unit 1 · Friendship')
            c = {'questions': t['sorular']}
            d, y, b = cevapla(p2, c)
            sonuc_denetle(p2, c, d, y, b)
            expect(p2.locator('#send-title')).to_have_text('Öğretmene gönderildi ✓')
            eşit([r['test_slug'] for r in o.uc.satirlar], [slug], 'kaydedilen sonuç')
            o.bitir(s2)
        finally:
            s2.kapat()
        return 'düzelt + doğru şıkkı değiştir + çıkar + yeni soru → boş/işaretsiz yakalandı → onaylandı (20) → "✓ onaylı" → yeniden açıldı → ödev → öğrenci çözdü'
    finally:
        s.kapat()


def panel_ozel_hatalar(o):
    """Hatalı yapıştırmalar kaydedilmeden yakalanır; kalın yazı ve diyalog satırları doğru okunur."""
    o.uc.sifirla()
    s = o.sayfa()
    page = s.page
    try:
        page.goto(f'{o.taban}/index.html?panel#{PANEL_ANAHTAR}')
        expect(page.locator('#p-liste > li').first).to_be_visible()
        page.click('#t-kart summary')
        page.fill('#t-metin', 'Merhaba! İşte sorular hakkında bilgi.')
        page.click('#t-kontrol')
        expect(page.locator('#t-hatalar')).to_contain_text('Hiç soru bulunamadı')
        expect(page.locator('#t-kaydet')).to_be_hidden()
        sorular = '\n\n'.join(
            f'**{i})** Question {i}: which one is _____?\n**A)** red {i}\n**B)** blue\n**C)** green\n**D)** pink\nCevap: **C**'
            for i in range(1, 5))
        diyalog = ('5) A: Let’s go to the park after school.\nB: _____ I’m free today.\n'
                   'A) Sorry, I can’t.\nB) I’m afraid not.\nC) Maybe another time.\nD) That’s a good idea!\n'
                   'Doğru cevap: D) That’s a good idea!\nAçıklama: Kabul ediyor.')
        eksik = '6) Pick one?\nA) x\nB) y\nC) z\nCevap: A'
        page.fill('#t-metin', 'TEST: Deneme\n' + sorular + '\n\n' + diyalog + '\n\n' + eksik)
        page.click('#t-kontrol')
        expect(page.locator('#t-hatalar')).to_contain_text('6. soruda 4 şık yok')
        expect(page.locator('#t-kaydet')).to_be_hidden()
        page.fill('#t-metin', 'TEST: Deneme\n' + sorular + '\n\n' + diyalog)
        page.click('#t-kontrol')
        expect(page.locator('#t-ozet')).to_contain_text('5 soru bulundu')
        expect(page.locator('#t-onizleme > li').nth(4).locator('.tq')).to_have_text(
            '5. A: Let’s go to the park after school.\nB: _____ I’m free today.')
        expect(page.locator('#t-onizleme > li').nth(4).locator('.dogru')).to_contain_text('That’s a good idea!')
        expect(page.locator('#t-onizleme > li').nth(0).locator('.dogru')).to_contain_text('green')
        eşit(o.uc.testler, {}, 'kaydetmeden önce kayıt yok')
        o.bitir(s)
        return 'boş/bozuk yapıştırma yakalandı · **kalın** ve diyalog satırları doğru okundu'
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
            sunucu(kopya) as odev_taban, odev_kopyasi(None) as bos_kopya, sunucu(bos_kopya) as bos_taban, \
            sync_playwright() as pw:
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
        kos('ödev   adres kurulmamış', odev_kurulmamis, browser, bos_taban)
        kos('ödev   ?odev yok → 0 istek', odev_parametresiz, o)
        kos('ödev   CORS: text/plain', odev_cors, o)
        kos('panel  anahtarsız / yanlış', panel_anahtarsiz, o)
        kos('panel  ödev oluştur → WhatsApp', panel_odev_olustur, o)
        kos('panel  sıralama → WhatsApp', panel_siralama, o)
        kos('panel  ChatGPT testi → ödev', panel_ozel_test, o)
        kos('panel  ChatGPT hatalı metin', panel_ozel_hatalar, o)
        kos('panel  hazır testi kontrol et', panel_hazir_kontrol, o)
        browser.close()
    print(f'duman testi: {gecen} geçti · {kalan} kaldı')
    return 1 if kalan else 0


if __name__ == '__main__':
    sys.exit(main())
