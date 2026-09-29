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
Fotoğraf kalıbı: iki kopyalama düğmesinin panoya doğru kalıbı yazması; araclar/ornek_chatgpt_foto.txt (8 soru, 2'sinde
"(emin değilim)") okunur, sarı uyarı çıkar, kayıtlı açıklamada ifade kalmaz.
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
import math
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


def cevapla(page, c, gizli=False):
    """#start tıklanmış olmalı. Bütün soruları desenle cevaplar, (doğru, yanlış, boş) döndürür.
    gizli: ödevde anahtar sayfada yok — doğru şık YANMAZ, yalnız seçilen işaretlenir."""
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
        if gizli:
            expect(page.locator('#answers .ans.is-lit')).to_have_count(0)
            expect(page.locator('#answers .ans.is-sel')).to_have_count(0 if p % 3 == 2 else 1)
        else:
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


def sinif_sube(v):
    """Kod.gs sinifSube_: "8a", "8 A", "8/a" → "8-A"; geçersizse ''."""
    m = re.match(r'^(\d{1,2})\s*[-/.\s]?\s*([A-Za-zÇĞİÖŞÜçğıöşü])$', str(v or '').strip())
    if not m or not 1 <= int(m[1]) <= 12:
        return ''
    return f"{int(m[1])}-{m[2].replace('i', 'İ').replace('ı', 'I').upper()}"


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
        self.ogrenciler = []  # sınıf listesi: [{sinif, numara, ad}]
        self.kararlar = {}  # (kod, numara | '*') → karar
        self.post_modu = 'normal'  # 'normal' | 'sunucu_hatasi'
        self.gizli = True  # Kod.gs CEVAP_GIZLE: öğretmen testi öğrenciye cevapsız gider
        self.eski_sunucu = False  # True: Task 1-7 öncesi sunucu (test cevaplı gider, POST puanlamaz)
        self.hazir_puanlama = {c['slug']: c.get('scoring') for c in quizleri_oku()}  # Kod.gs hazirTest_(kaynak).scoring
        self.kilit = threading.Lock()

    def sifirla(self, post_modu='normal'):
        with self.kilit:
            self.satirlar.clear()
            self.istekler.clear()
            self.post_modu = post_modu
            self.gizli = True
            self.eski_sunucu = False
            for k in [k for k in self.odevler if k.startswith('P')]:
                del self.odevler[k]  # panelden eklenenler
            self.testler.clear()
            self.ogrenciler.clear()
            self.kararlar.clear()

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
            t = self.testler[slug]
            if self.gizli and not self.eski_sunucu:  # Kod.gs gizliTest_
                yanit['test'] = {'ad': t['ad'], 'kaynak': t.get('kaynak', ''), 'puanlama': t.get('puanlama', ''),
                                 'sorular': [{k: v for k, v in q.items() if k in ('q', 'o', 'c')} for q in t['sorular']]}
                yanit['gizli'] = True
            else:
                yanit['test'] = t
        if 'numara' in q and 'ad' in q:  # Kod.gs oncekiVar_: aynı ödevde aynı numara + ad
            ad = ' '.join(q['ad'][0].lower().split())
            yanit['onceki'] = any(r['kod'].upper() == q['odev'][0].strip().upper() and r['numara'] == q['numara'][0]
                                  and ' '.join(r['ad_soyad'].lower().split()) == ad for r in self.satirlar)
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
        puan = None
        if not self.eski_sunucu and o[0] in self.testler:  # Kod.gs S1 taklidi; hazır testler sahte uçta "istemci" yolunda
            puan = self.puanla(g.get('cevaplar', ''), self.testler[o[0]])
            if puan is None:
                return {'ok': False, 'hata': 'gecersiz', 'kalici': True}
            g.update({k: puan[k] for k in ('dogru', 'yanlis', 'bos', 'puan')})
        for r in self.satirlar:
            if r['gonderim_id'] == g['gonderim_id']:
                return {'ok': True, 'durum': r['durum'], 'deneme_no': r['deneme_no'], 'tekrar': True, **(puan or {})}
        simdi = time.time()
        durum = 'zamanında' if o[1] <= simdi <= o[2] and not o[3].get('post_sure_disi') else 'süre dışı'
        deneme = 1 + sum(1 for r in self.satirlar if r['kod'] == g['kod'] and r['numara'] == g['numara'])
        if any(r['kod'] == g['kod'] and r['numara'] == g['numara'] and r['ad_soyad'].lower().split() == g['ad_soyad'].lower().split()
               for r in self.satirlar):  # Kod.gs: yalnız ilk deneme kaydedilir
            return {'ok': True, 'kaydedilmedi': True, 'durum': durum, 'deneme_no': deneme, **(puan or {})}
        self.satirlar.append(dict(g, durum=durum, deneme_no=deneme))
        return {'ok': True, 'durum': durum, 'deneme_no': deneme, 'sunucu_zamani': iso(simdi), **(puan or {})}

    def puanla(self, cevaplar, t):
        """Kod.gs cevapCoz_ + puanla_: "1A✓ 2B 3-" → özgün soru/şık sırasıyla puan; ✓/✗ yok sayılır. Bozuksa None."""
        anahtar = [q['a'] for q in t['sorular']]
        parca = str(cevaplar).lstrip("'").split()
        if len(parca) != len(anahtar):
            return None
        sec = [None] * len(anahtar)
        for p in parca:
            m = re.match(r'^(\d{1,2})([A-D-])[✓✗]?$', p)
            if not m or not 1 <= int(m[1]) <= len(anahtar) or sec[int(m[1]) - 1] is not None:
                return None
            sec[int(m[1]) - 1] = -1 if m[2] == '-' else 'ABCD'.index(m[2])
        d = sum(1 for s, a in zip(sec, anahtar) if s == a)
        b = sec.count(-1)
        y = len(sec) - d - b
        pl = t.get('puanlama') or ('plain' if self.hazir_puanlama.get(t.get('kaynak')) == 'plain' else 'lgs')
        ham = d if pl == 'plain' else max(0, d - y / 3)
        return {'dogru': d, 'yanlis': y, 'bos': b, 'puan': math.floor(1000 * ham / len(sec) + 0.5) / 10,  # JS Math.round
                'anahtar': anahtar, 'aciklamalar': [q.get('tr', '') for q in t['sorular']]}

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
            say = {}
            for x in self.ogrenciler:
                say[x['sinif']] = say.get(x['sinif'], 0) + 1
            return {'ok': True, 'odevler': liste, 'testler': testler,
                    'siniflar': [{'sinif': k, 'n': say[k]} for k in sorted(say)]}
        if g['islem'] == 'liste_kaydet':
            sube = sinif_sube(g.get('sinif_sube'))
            ogr = g.get('ogrenciler') or []
            if not sube or not ogr or len({x['numara'] for x in ogr}) != len(ogr):
                return {'ok': False, 'hata': 'liste', 'kalici': True}
            self.ogrenciler[:] = [x for x in self.ogrenciler if x['sinif'] != sube] + \
                [{'sinif': sube, 'numara': x['numara'], 'ad': x['ad']} for x in ogr]
            say = {}
            for x in self.ogrenciler:
                say[x['sinif']] = say.get(x['sinif'], 0) + 1
            return {'ok': True, 'sinif': sube, 'n': len(ogr), 'siniflar': [{'sinif': k, 'n': say[k]} for k in sorted(say)]}
        if g['islem'] == 'karar':
            kod, numara, karar = str(g.get('kod', '')).upper(), str(g.get('numara', '')), g.get('karar', '')
            if kod not in self.odevler or karar not in ('', 'ozurlu', 'sifir', 'tam', 'haric') or \
                    (karar and (numara == '*') != (karar == 'haric')):
                return {'ok': False, 'hata': 'gecersiz', 'kalici': True}
            if karar:
                self.kararlar[(kod, numara)] = karar
            else:
                self.kararlar.pop((kod, numara), None)
            return {'ok': True, 'kod': kod, 'numara': numara, 'karar': karar}
        if g['islem'] == 'notlar':  # Kod.gs notCizelgesi_
            sube = sinif_sube(g.get('sinif_sube'))
            liste = [x for x in self.ogrenciler if x['sinif'] == sube]
            nolar = {x['numara'].lstrip('0') for x in liste}
            sonuclar, gorulen, cozulen = [], set(), set()
            for r in self.satirlar:
                k = (r['kod'].upper(), r['numara'], r['ad_soyad'].lower())
                if r['numara'].lstrip('0') not in nolar or k in gorulen or (sinif_sube(r.get('sinif_sube')) not in ('', sube)):
                    continue
                gorulen.add(k)
                cozulen.add(k[0])
                sonuclar.append({'kod': k[0], 'numara': r['numara'], 'puan': r['puan'], 'durum': r['durum'], 'zaman': iso(time.time())})
            odevler = []
            for kod, (slug, bas, bit, sec) in self.odevler.items():
                subeler = [x for x in (sinif_sube(t) for t in re.split('[,;]', sec.get('sinif', ''))) if x]
                if (sube in subeler) if subeler else (kod in cozulen):
                    odevler.append({'kod': kod, 'test_slug': slug, 'bitis': iso(bit), 'sinif': sec.get('sinif', '')})
            ilgili = {o['kod'] for o in odevler}
            return {'ok': True, 'sube': sube, 'ogrenciler': liste, 'odevler': odevler,
                    'sonuclar': [x for x in sonuclar if x['kod'] in ilgili],
                    'kararlar': [{'kod': k, 'numara': n, 'karar': v} for (k, n), v in self.kararlar.items() if k in ilgili]}
        if g['islem'] == 'sonuclar':
            kod = str(g.get('kod', '')).upper()
            if kod not in self.odevler:
                return {'ok': False, 'hata': 'yok', 'kalici': True}
            slug, _, bit, sec = self.odevler[kod]
            ilk, sira = {}, []
            for r in self.satirlar:  # Kod.gs odevSonuclari_ gibi: ilk deneme (numara + ad), sonrakiler sayılır
                if r['kod'].upper() != kod:
                    continue
                if kisi(r) in ilk:
                    ilk[kisi(r)]['sonraki'] += 1
                    continue
                ilk[kisi(r)] = {'numara': r['numara'], 'ad': r['ad_soyad'], 'sinif': sinif_sube(r.get('sinif_sube')),
                                'dogru': r.get('dogru'), 'yanlis': r.get('yanlis'), 'bos': r.get('bos'), 'puan': r['puan'],
                                'durum': r['durum'], 'cevaplar': r.get('cevaplar', ''), 'sure': r.get('istemci_sure_ms'),
                                'zaman': iso(time.time()), 'sonraki': 0}
                sira.append(ilk[kisi(r)])
            subeler = [x for x in (sinif_sube(t) for t in re.split('[,;]', sec.get('sinif', ''))) if x]
            if not subeler:
                subeler = sorted({x['sinif'] for x in sira if x['sinif']})
            yanit = {'ok': True, 'odev': {'kod': kod, 'test_slug': slug, 'sinif': sec.get('sinif', ''), 'bitis': iso(bit)},
                     'sonuclar': sira, 'subeler': subeler, 'liste': [x for x in self.ogrenciler if x['sinif'] in subeler]}
            if slug in self.testler:
                yanit['test'] = self.testler[slug]
            return yanit
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
        expect(page.locator('#send-text')).to_have_text('No 0123 · 8-A · Deneme Öğrenci · Tekrar çözebilirsin ama yeni sonuçlar kaydedilmez.')
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
        # ikinci deneme çözülebilir ama gönderilmez (yalnız ilk deneme kaydedilir)
        post_once = o.uc.istek_say('POST')
        page.click('#again')
        d2, y2, b2 = cevapla(page, c)
        expect(page.locator('#send-title')).to_have_text('Alıştırma · sonuç kaydedilmedi')
        expect(page.locator('#send-retry')).to_be_hidden()
        eşit(o.uc.istek_say('POST'), post_once, 'ikinci denemede POST yok')
        eşit(len(o.uc.satirlar), 1, 'yalnız ilk deneme kayıtlı')
        # bilgiler hatırlanır ve değiştirilebilir
        page.reload()
        expect(page.locator('#who')).to_be_visible()
        expect(page.locator('#who-no')).to_have_value('0123')
        expect(page.locator('#who-name')).to_have_value('Deneme Öğrenci')
        expect(page.locator('#who-sinif')).to_have_value('8-A')
        page.click('#who-go')
        expect(page.locator('#intro')).to_be_visible()
        expect(page.locator('#tekrar-not')).to_be_visible()  # bu cihaz biliyor
        # başka cihaz gibi (yerel kayıt yok): sunucu söyler
        page.evaluate("localStorage.removeItem('alti-saniye:cozulen')")
        page.reload()
        page.click('#who-go')
        expect(page.locator('#intro')).to_be_visible()
        expect(page.locator('#tekrar-not')).to_be_visible()
        # başka öğrenci: uyarı yok
        page.click('#back')
        page.fill('#who-no', '0999')
        page.click('#who-go')
        expect(page.locator('#tekrar-not')).to_be_hidden()
        page.click('#back')
        expect(page.locator('#who')).to_be_visible()
        o.bitir(s)
        return f'form (numara+ad+sınıf/şube) → 12 sn, durdurma yok → {len(c["questions"])} soru → gönderildi ✓ · 2. deneme gönderilmedi, uyarı (cihaz + sunucu) · bilgiler hatırlandı'
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
    """Sonuçlar: şube filtresi, sıralama + WhatsApp, öğrenci ayrıntısı (cevaplar, sonraki denemeler, listede yok),
    yapmayanlar + hatırlatma, soru analizi, Excel (CSV) indirme."""
    from urllib.parse import unquote
    o.uc.sifirla()
    c = o.quiz['do-you-know-me']
    q = c['questions']
    ali_cevap = f"1{'ABCD'[q[0]['a']]}✓ 2{'ABCD'[(q[1]['a'] + 1) % 4]}✗ 3-"
    o.uc.ogrenciler[:] = [{'sinif': '8-A', 'numara': '5', 'ad': 'Ayşe Kaya'}, {'sinif': '8-A', 'numara': '6', 'ad': 'Ali Can'},
                          {'sinif': '8-A', 'numara': '7', 'ad': 'Gelmeyen Öğrenci'}, {'sinif': '8-B', 'numara': '8', 'ad': 'Can Demir'}]
    # Ayşe'nin gönderiminde doğru/yanlış/boş ve sınıf yok (eski sayfa gibi): yalnız puan yazılır, listeden 8-A olur
    for no, ad, puan, ek in (('5', 'Ayşe Kaya', 70, {}),
                             ('6', 'Ali Can', 90, {'dogru': 9, 'yanlis': 0, 'bos': 1, 'sinif_sube': '8-A', 'cevaplar': ali_cevap}),
                             ('9', 'Yabancı Kişi', 80, {'dogru': 8, 'yanlis': 2, 'bos': 0, 'sinif_sube': '8-A'}),
                             ('8', 'Can Demir', 60, {'dogru': 6, 'yanlis': 4, 'bos': 0, 'sinif_sube': '8-B'})):
        o.uc.dopost(json.dumps({'kod': 'ACIK1', 'test_slug': 'do-you-know-me', 'numara': no, 'ad_soyad': ad,
                                'puan': puan, 'istemci_sure_ms': 61000, 'gonderim_id': f'g-{no}-{puan}', **ek}))
    # kural gelmeden önce kaydedilmiş ikinci deneme (eski tablo): sayılmaz, yalnız "sonra 1 kez daha" görünür
    o.uc.satirlar.append({'kod': 'ACIK1', 'test_slug': 'do-you-know-me', 'numara': '6', 'ad_soyad': 'Ali Can', 'puan': 100,
                          'dogru': 10, 'yanlis': 0, 'bos': 0, 'sinif_sube': '8-A', 'istemci_sure_ms': 50000,
                          'gonderim_id': 'eski-2-deneme', 'durum': 'zamanında', 'deneme_no': 2})
    s = o.sayfa()
    page = s.page
    try:
        page.goto(f'{o.taban}/index.html?panel#{PANEL_ANAHTAR}')
        kart = page.locator('#p-odev-ACIK1')
        expect(kart.locator('.p-katilan')).to_have_text('👥 4 öğrenci çözdü')
        kart.locator('.p-sonuc').click()
        expect(kart.locator('.s-ozet')).to_have_text('3 / 4 öğrenci çözdü · ortalama 75 · 1 öğrenci yapmadı')
        # sıralama (varsayılan görünüm: şube şube; iki şube var → her şubenin bloğu, sıra her şubede 1'den)
        expect(kart.locator('.s-sube option')).to_have_text(['Şube şube (hepsi)', '8-A', '8-B'])
        expect(kart.locator('.s-blok-bas')).to_have_text(['8-A · 2/3 çözdü · ortalama 80', '8-B · 1/1 çözdü · ortalama 60'])
        sira = kart.locator('.s-sira').nth(0).locator('li')
        expect(sira).to_have_count(3)
        expect(sira.first).to_have_text('🥇 Ali Can (8-A) — 90 puan · 9 doğru, 0 yanlış, 1 boş')
        expect(sira.nth(2)).to_have_text('🥉 Ayşe Kaya (8-A) — 70')
        expect(kart.locator('.s-sira').nth(1).locator('li')).to_have_text(['🥇 Can Demir (8-B) — 60 puan · 6 doğru, 4 yanlış'])  # 8-B'de sıra yeniden 1'den
        # karışık "bütün şubeler" düğmesi yok: her şubenin kendi WhatsApp düğmesi ve metni var
        expect(kart.locator('.s-wa')).to_have_count(2)
        expect(kart.locator('.s-wa').nth(0)).to_have_text("8-A sıralamasını WhatsApp'ta paylaş")
        href = unquote(kart.locator('.s-wa').nth(0).get_attribute('href'))
        if not href.startswith('https://wa.me/?text=') or not href.split('\n')[0].endswith('· 8-A'):
            raise AssertionError(f'8-A WhatsApp başlığı hatalı: {href}')
        if 'Ali Can (8-A) — 90 puan' not in href or '3 öğrenci katıldı.' not in href or 'Can Demir' in href:
            raise AssertionError(f'8-A WhatsApp metni yalnız 8-A öğrencilerini içermeli: {href}')
        href_b = unquote(kart.locator('.s-wa').nth(1).get_attribute('href'))
        if '· 8-B' not in href_b.split('\n')[0] or 'Can Demir (8-B) — 60 puan' not in href_b or 'Ali Can' in href_b or '1 öğrenci katıldı.' not in href_b:
            raise AssertionError(f'8-B WhatsApp metni hatalı: {href_b}')
        # hatırlatma her şubenin bloğunda, yalnız o şubenin yapmayanları (8-B'de yapmayan yok → düğme yok)
        expect(kart.locator('.s-hatirlat')).to_have_count(1)
        expect(kart.locator('.s-hatirlat')).to_have_text('8-A · yapmayanlara hatırlat (1 öğrenci)')
        h = unquote(kart.locator('.s-hatirlat').get_attribute('href'))
        if '• Gelmeyen Öğrenci' not in h or '?odev=ACIK1' not in h or 'Ayşe' in h or '(8-A)' not in h:
            raise AssertionError(f'hatırlatma mesajı hatalı: {h}')
        # öğrenciler: şube başlıkları altında gruplu, grupta numara sırası, listede olmayan grubun sonunda
        kart.locator('.s-sekme[data-k="ogr"]').click()
        expect(kart.locator('.s-blok-bas')).to_have_text(['8-A', '8-B'])
        kisiler = kart.locator('.s-kisi')
        expect(kisiler).to_have_count(5)
        expect(kisiler.locator('.s-ad')).to_have_text(['5 · Ayşe Kaya', '6 · Ali Can', '7 · Gelmeyen Öğrenci', '9 · Yabancı Kişi', '8 · Can Demir'])
        expect(kart.locator('.s-kisi.yapmadi .s-not')).to_have_text('Yapmadı')
        ali = kisiler.nth(1)
        ali.locator('.s-kisi-bas').click()
        expect(ali.locator('.s-detay')).to_be_visible()
        expect(ali.locator('.s-detay .pnote')).to_contain_text('sonra 1 kez daha çözdü (sayılmaz)')
        expect(ali.locator('.s-cevaplar li')).to_have_count(len(q))
        eşit([ali.locator('.s-cevaplar li').nth(k).get_attribute('class') for k in range(3)], ['dogru', 'yanlis', 'bos'], 'cevap renkleri')
        kisiler.nth(3).locator('.s-kisi-bas').click()
        expect(kisiler.nth(3).locator('.s-detay .pnote')).to_contain_text('sınıf listesinde bu numara yok')
        # sorular (şubeden bağımsız, değişmedi)
        kart.locator('.s-sekme[data-k="soru"]').click()
        sor = kart.locator('.s-sorular li')
        expect(sor).to_have_count(len(q))
        expect(sor.last.locator('strong')).to_have_text('%25 doğru · 1 D · 0 Y · 3 B')
        expect(kart.locator('.s-sorular li', has_text=q[1]['q'].replace('\n', ' ')).locator('.s-yanlis')).to_contain_text('(1 kişi)')
        # indir (şube şube): önce şube, sonra şube içi sıra; "Sıra" sütunu, çözmeyen boş
        with page.expect_download() as d:
            kart.locator('.s-indir').click()
        csv = pathlib.Path(d.value.path()).read_text(encoding='utf-8-sig').splitlines()
        eşit(csv[0].split(';')[:5], ['Numara', 'Ad Soyad', 'Şube', 'Sıra', 'Durum'], 'CSV başlık')
        eşit(len(csv), 6, 'CSV satır')
        eşit([r.split(';')[:4] for r in csv[1:]], [['6', 'Ali Can', '8-A', '1'], ['9', 'Yabancı Kişi', '8-A', '2'], ['5', 'Ayşe Kaya', '8-A', '3'],
                                                   ['7', 'Gelmeyen Öğrenci', '8-A', ''], ['8', 'Can Demir', '8-B', '1']], 'CSV şube sırası')
        if not csv[3].startswith('5;Ayşe Kaya;8-A;3;çözdü;70;;;;1:01;') or not csv[3].endswith(';' * len(q)):
            raise AssertionError(f'CSV cevapsız eski kayıt boş olmalı: {csv}')
        if not csv[4].startswith('7;Gelmeyen Öğrenci;8-A;;yapmadı'):
            raise AssertionError(f'CSV yapmayan satırı yok: {csv}')
        if not csv[1].startswith('6;Ali Can;8-A;1;çözdü;90;9;0;1;1:01') or not csv[1].endswith(';' + 'ABCD'[q[0]['a']] + ' ✓;' + 'ABCD'[(q[1]['a'] + 1) % 4] + ' ✗' + ';-' * (len(q) - 2)):
            raise AssertionError(f'CSV Ali satırı hatalı: {csv}')
        # şube seçilince yalnız o blok
        kart.locator('.s-sube').select_option('8-B')
        expect(kart.locator('.s-ozet')).to_have_text('1 / 1 öğrenci çözdü · ortalama 60')
        kart.locator('.s-sekme[data-k="sira"]').click()
        expect(kart.locator('.s-blok-bas')).to_have_text(['8-B · 1/1 çözdü · ortalama 60'])
        expect(kart.locator('.s-sira li')).to_have_count(1)
        expect(kart.locator('.s-hatirlat')).to_have_count(0)
        expect(kart.locator('.s-wa')).to_have_count(1)
        if '· 8-B' not in unquote(kart.locator('.s-wa').get_attribute('href')).split('\n')[0]:
            raise AssertionError('şube sıralaması başlığında şube yok')
        with page.expect_download() as d:
            kart.locator('.s-indir').click()
        eşit(len(pathlib.Path(d.value.path()).read_text(encoding='utf-8-sig').splitlines()), 2, 'yalnız 8-B CSV')
        # tek şubeli ödev: görünüm sade (şube seçici yok, blok başlığı yok, tek WhatsApp/hatırlatma düğmesi)
        o.uc.ogrenciler[:] = [x for x in o.uc.ogrenciler if x['sinif'] == '8-A']
        o.uc.satirlar[:] = [x for x in o.uc.satirlar if x.get('sinif_sube') != '8-B']
        page.reload()
        kart = page.locator('#p-odev-ACIK1')
        kart.locator('.p-sonuc').click()
        expect(kart.locator('.s-ozet')).to_have_text('2 / 3 öğrenci çözdü · ortalama 80 · 1 öğrenci yapmadı')
        expect(kart.locator('.s-sube')).to_have_count(0)
        expect(kart.locator('.s-blok-bas')).to_have_count(0)
        expect(kart.locator('.s-sira li')).to_have_count(3)
        expect(kart.locator('.s-wa')).to_have_count(1)
        expect(kart.locator('.s-wa')).to_have_text("Sıralamayı WhatsApp'ta paylaş")
        expect(kart.locator('.s-hatirlat')).to_have_text('Yapmayanlara hatırlat (1 öğrenci)')
        if '• Gelmeyen Öğrenci' not in unquote(kart.locator('.s-hatirlat').get_attribute('href')):
            raise AssertionError('tek şubede hatırlatma mesajı hatalı')
        o.bitir(s)
        return 'şube şube sıralama (her şubenin WhatsApp + hatırlatması) · şube seçici · gruplu öğrenciler · soru analizi · şube sıralı CSV (Sıra) · tek şubede sade görünüm'
    finally:
        s.kapat()


def panel_sozlu(o):
    """Sözlü notları: varsayılanlar (yapmadı 0, süre dışı tam, süresi süren sayılmaz), kararlar (özürlü, 0 say),
    ödevi nota saymama, yeniden yüklemede kararların kalıcılığı, başka şubenin ödevinin karışmaması, CSV."""
    o.uc.sifirla()
    simdi = time.time()
    o.uc.ogrenciler[:] = [{'sinif': '8-A', 'numara': '5', 'ad': 'Ayşe Kaya'}, {'sinif': '8-A', 'numara': '6', 'ad': 'Ali Can'},
                          {'sinif': '8-A', 'numara': '7', 'ad': 'Gelmeyen Öğrenci'}, {'sinif': '8-B', 'numara': '8', 'ad': 'Can Demir'}]
    # P ile başlayan kodlar sifirla() ile silinir
    o.uc.odevler['P9001'] = ('do-you-know-me', simdi - 2 * GUN, simdi - 3600, {'sinif': '8-A'})
    o.uc.odevler['P9002'] = ('ingilizce-8-friendship', simdi - 2 * GUN, simdi - 7200, {'sinif': '8-A'})
    o.uc.odevler['P9003'] = ('do-you-know-me', simdi - GUN, simdi + GUN, {'sinif': '8-A'})  # süresi sürüyor
    o.uc.odevler['P9004'] = ('do-you-know-me', simdi - 2 * GUN, simdi - 3600, {'sinif': '8-B'})  # başka şube
    def ekle(kod, no, ad, puan, durum):
        o.uc.satirlar.append({'kod': kod, 'test_slug': o.uc.odevler[kod][0], 'numara': no, 'ad_soyad': ad, 'puan': puan,
                              'dogru': 0, 'yanlis': 0, 'bos': 0, 'sinif_sube': '8-A', 'istemci_sure_ms': 1000,
                              'gonderim_id': f'{kod}-{no}', 'durum': durum, 'deneme_no': 1})
    ekle('P9001', '5', 'Ayşe Kaya', 80, 'zamanında')
    ekle('P9001', '6', 'Ali Can', 60, 'zamanında')
    ekle('P9002', '5', 'Ayşe Kaya', 90, 'süre dışı')
    ekle('P9003', '6', 'Ali Can', 100, 'zamanında')
    ekle('P9004', '8', 'Can Demir', 10, 'zamanında')
    s = o.sayfa()
    page = s.page
    notlar = page.locator('#n-ogr .n-not')
    try:
        page.goto(f'{o.taban}/index.html?panel#{PANEL_ANAHTAR}')
        expect(page.locator('#p-odev-ACIK1')).to_be_visible()
        page.click('#n-kart summary')
        expect(page.locator('#n-form')).to_be_visible()
        page.select_option('#n-sube', '8-A')
        page.select_option('#n-donem', '')
        page.click('#n-goster')
        # varsayılan: Ayşe (90 süre dışı tam + 80) → 85 · Ali (yapmadı 0 + 60 + 100) → 53 · Gelmeyen (0 + 0) → 0; süresi süren yapılmayan sayılmaz
        expect(page.locator('#n-ozet')).to_have_text('8-A · 3 öğrenci · 3 ödev nota sayılıyor · şube ortalaması 46')
        expect(notlar).to_have_text(['85', '53', '0'])
        expect(page.locator('#n-odevler .n-odev')).to_have_count(3)
        # Ali: yapmadığı ödev → özürlü
        ali = page.locator('#n-ogr .n-kisi').nth(1)
        ali.locator('.n-bas').click()
        karar = ali.locator('.n-karar')
        expect(karar).to_have_text(['Yapmadı · 0 sayılıyor'])
        karar.first.click()
        expect(karar).to_have_text(['Yapmadı · özürlü (sayılmıyor)'])
        expect(notlar).to_have_text(['85', '80', '0'])
        expect(ali.locator('.n-detay li').last).to_contain_text('100')
        # Ayşe: süre dışı → 0 → özürlü
        ayse = page.locator('#n-ogr .n-kisi').first
        ayse.locator('.n-bas').click()
        ayse.locator('.n-karar').first.click()
        expect(ayse.locator('.n-karar').first).to_have_text('90 · süre dışı · 0 sayılıyor')
        expect(notlar.first).to_have_text('40')
        ayse.locator('.n-karar').first.click()
        expect(notlar.first).to_have_text('80')
        expect(page.locator('#n-ogr .n-kisi').nth(2).locator('.n-detay')).to_be_hidden()
        # ödevi nota sayma
        page.locator('#n-odevler .n-odev input').nth(1).uncheck()  # tarih sırası: Friendship (P9002), P9001, P9003
        expect(page.locator('#n-ozet')).to_contain_text('2 ödev nota sayılıyor')
        expect(notlar).to_have_text(['—', '100', '0'])
        eşit(o.uc.kararlar, {('P9002', '6'): 'ozurlu', ('P9002', '5'): 'ozurlu', ('P9001', '*'): 'haric'}, 'kaydedilen kararlar')
        # CSV
        with page.expect_download() as d:
            page.click('#n-indir')
        csv = pathlib.Path(d.value.path()).read_text(encoding='utf-8-sig').splitlines()
        eşit(csv[0].split(';')[:4], ['Numara', 'Ad Soyad', 'Sözlü notu', 'Sayılan ödev'], 'CSV başlık')
        eşit(csv[2].split(';')[:4], ['6', 'Ali Can', '100', '1'], 'CSV Ali')
        eşit(csv[1].split(';')[2:5], ['', '0', 'özürlü'], 'CSV Ayşe')
        # yeniden yükle: kararlar kalıcı
        page.reload()
        page.click('#n-kart summary')
        page.select_option('#n-sube', '8-A')
        page.select_option('#n-donem', '')
        page.click('#n-goster')
        expect(notlar).to_have_text(['—', '100', '0'])
        expect(page.locator('#n-odevler .n-odev input').nth(1)).not_to_be_checked()
        o.bitir(s)
        return 'varsayılanlar (yapmadı 0, süre dışı tam, süren sayılmaz) → 85/53/0 · özürlü, 0 say, ödevi sayma · kalıcı · başka şube karışmadı · CSV'
    finally:
        s.kapat()


def panel_sinif_listesi(o):
    """Sınıf listesi yapıştırılır (başlık ve sıra no'lu satırlar), aynı numara hatası yakalanır, kaydedilir;
    Yeni ödev'de şube çipi çıkar ve ödeve şube yazılır; yeniden kaydedince eski listenin yerine geçeceği söylenir."""
    o.uc.sifirla()
    s = o.sayfa()
    page = s.page
    try:
        page.goto(f'{o.taban}/index.html?panel#{PANEL_ANAHTAR}')
        expect(page.locator('#p-odev-ACIK1')).to_be_visible()
        expect(page.locator('#p-subeler')).to_be_hidden()
        page.click('#n-kart summary')
        expect(page.locator('#n-bos')).to_be_visible()
        expect(page.locator('#n-form')).to_be_hidden()
        page.click('#l-kart summary')
        page.fill('#l-sinif', '8a')
        page.fill('#l-metin', 'S.No\tÖğrenci No\tAdı\tSoyadı\n1\t123\tAli\tVeli\n2.\t124\tAyşe\tYılmaz\n125 Can Demir\n\n3 124 Tekrar Numara')
        page.click('#l-kontrol')
        expect(page.locator('#l-hatalar')).to_contain_text('124 numarası iki kez var')
        expect(page.locator('#l-kaydet')).to_be_hidden()
        page.fill('#l-metin', 'S.No\tÖğrenci No\tAdı\tSoyadı\n1\t123\tAli\tVeli\n2.\t124\tAyşe\tYılmaz\n125 Can Demir')
        page.click('#l-kontrol')
        expect(page.locator('#l-sinif')).to_have_value('8-A')
        expect(page.locator('#l-bilgi')).to_have_text('✓ 8-A için 3 öğrenci bulundu. Adları ve numaraları kontrol et.')
        expect(page.locator('#l-uyarilar')).to_contain_text('1. satır atlandı')
        expect(page.locator('#l-onizleme li')).to_have_text(['123 · Ali Veli', '124 · Ayşe Yılmaz', '125 · Can Demir'])
        page.click('#l-kaydet')
        expect(page.locator('#l-tamam')).to_contain_text('8-A listesi kaydedildi (3 öğrenci)')
        eşit([(x['sinif'], x['numara'], x['ad']) for x in o.uc.ogrenciler],
             [('8-A', '123', 'Ali Veli'), ('8-A', '124', 'Ayşe Yılmaz'), ('8-A', '125', 'Can Demir')], 'kaydedilen liste')
        expect(page.locator('#l-ozet')).to_have_text('Kayıtlı listeler: 8-A (3)')
        expect(page.locator('#n-bos')).to_be_hidden()
        expect(page.locator('#n-sube option')).to_have_text(['8-A (3 öğrenci)'])
        # Yeni ödev: şube çipi
        cip = page.locator('#p-subeler .cip')
        expect(cip).to_have_text(['8-A'])
        cip.first.click()
        expect(page.locator('#p-sinif')).to_have_value('8-A')
        expect(cip.first).to_have_attribute('aria-pressed', 'true')
        page.fill('#p-gun', time.strftime('%Y-%m-%d', time.localtime(time.time() + 5 * GUN)))
        page.click('#p-olustur')
        expect(page.locator('#p-sonuc')).to_be_visible()
        yeni = [v for k, v in o.uc.odevler.items() if k.startswith('P')]
        eşit([v[3]['sinif'] for v in yeni], ['8-A'], 'ödevin şubesi')
        # aynı şubeyi yeniden kaydetmek eskisinin yerine geçer
        page.fill('#l-sinif', '8-A')
        page.fill('#l-metin', '123 Ali Veli\n126 Deniz Ak')
        page.click('#l-kontrol')
        expect(page.locator('#l-bilgi')).to_contain_text("8-A'nın kayıtlı listesi (3 öğrenci) bununla değiştirilecek")
        o.bitir(s)
        return 'başlık/sıra no/sekme ayrımlı satırlar okundu · aynı numara yakalandı · kaydedildi · şube çipi → ödev 8-A'
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
            d, y, b = cevapla(p2, c, gizli=True)
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
            d, y, b = cevapla(p2, c, gizli=True)
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


def panel_foto_kalibi(o):
    """Fotoğraf kalıbı: iki düğme doğru metni panoya yazar; kalıba uyan çıktı (araclar/ornek_chatgpt_foto.txt) okunur,
    "(emin değilim)" olan sorular sarı uyarı alır ve kayıtlı açıklamada o ifade kalmaz."""
    o.uc.sifirla()
    kaynak = (KOK / 'sablon.html').read_text(encoding='utf-8')
    kalip = re.search(r'const KALIP = `(.*?)`;', kaynak, re.S).group(1)
    foto = re.search(r'const KALIP_FOTO = `(.*?)`;', kaynak, re.S).group(1)
    if 'emin değilim' not in foto or 'Sayfa hakkında not (isteğe bağlı):' not in foto or 'TEST: (' not in foto or 'fotoğraf' in kalip.lower():
        raise AssertionError('kalıplar beklenen içerikte değil')
    metin = (KOK / 'araclar' / 'ornek_chatgpt_foto.txt').read_text(encoding='utf-8')
    s = o.sayfa()
    page = s.page
    try:
        # gerçek pano yerine kayıt tutan sahte pano: hangi metnin kopyalandığı okunabilsin
        page.add_init_script("window.__pano = []; Object.defineProperty(navigator, 'clipboard', {configurable: true, "
                             "value: {writeText: t => { window.__pano.push(t); return Promise.resolve(); }}});")
        page.goto(f'{o.taban}/index.html?panel#{PANEL_ANAHTAR}')
        expect(page.locator('#p-odev-ACIK1')).to_be_visible()
        page.click('#t-kart summary')
        expect(page.locator('#t-kalip-foto')).to_have_text('Fotoğraf kalıbını kopyala')
        expect(page.locator('#t-kart .adimlar')).to_contain_text("ChatGPT'de fotoğrafı ekle (📎 / +), fotoğraf kalıbını yapıştır, gönder.")
        page.click('#t-kalip')
        expect(page.locator('#t-kalip')).to_contain_text('Kopyalandı')
        page.click('#t-kalip-foto')
        expect(page.locator('#t-kalip-foto')).to_contain_text('Kopyalandı')
        pano = page.evaluate('window.__pano')
        eşit(len(pano), 2, 'pano yazımı')
        if pano[0] != kalip or pano[1] != foto or pano[0] == pano[1]:
            raise AssertionError('düğmeler panoya doğru kalıbı yazmadı')
        # büyük harf / Türkçe İ ile yazılsa da uyarı çıkar ve ifade silinir
        page.fill('#t-metin', metin.replace('(emin değilim)', '(EMİN DEĞİLİM)'))
        page.click('#t-kontrol')
        expect(page.locator('#t-onizleme > li.uyarili')).to_have_count(2)
        expect(page.locator('#t-onizleme')).not_to_contain_text('EMİN')
        expect(page.locator('#t-onizleme')).not_to_contain_text('DEĞİLİM')
        # kalıba uyan çıktı: 8 soru, 2 sarı uyarı, açıklamada "(emin değilim)" yok
        page.fill('#t-metin', metin)
        page.click('#t-kontrol')
        expect(page.locator('#t-hatalar')).to_be_hidden()
        expect(page.locator('#t-ozet')).to_contain_text('8 soru bulundu')
        expect(page.locator('#t-onizleme > li')).to_have_count(8)
        expect(page.locator('#t-onizleme > li.uyarili')).to_have_count(2)
        expect(page.locator('#t-uyarilar > li')).to_have_count(3)  # "Kontrol etmen iyi olur:" + 2 uyarı
        expect(page.locator('#t-uyarilar')).to_contain_text('5. soru: ChatGPT cevaptan emin değil — kontrol et')
        expect(page.locator('#t-uyarilar')).to_contain_text('8. soru: ChatGPT cevaptan emin değil — kontrol et')
        expect(page.locator('#t-onizleme')).not_to_contain_text('emin değilim')
        expect(page.locator('#t-ad')).to_have_value('Unit 7 Tourism')
        page.click('#t-kaydet')
        expect(page.locator('#t-tamam')).to_contain_text('kaydedildi')
        slug, t = next(iter(o.uc.testler.items()))
        eşit(len(t['sorular']), 8, 'kaydedilen soru')
        if any('emin değilim' in q['tr'] for q in t['sorular']):
            raise AssertionError('kayıtlı açıklamada "(emin değilim)" kalmış')
        eşit(t['sorular'][4]['tr'], 'Crowded (kalabalık) kelimesinin zıttı empty (boş) kelimesidir.', '5. sorunun temiz açıklaması')
        o.bitir(s)
        return 'iki kalıp düğmesi panoya doğru metni yazdı · fotoğraf çıktısı: 8 soru, 2 "emin değilim" sarı uyarı, kayıtta ifade yok'
    finally:
        s.kapat()


GIZLI_SLUG = 'ozel-deneme-abcd'


def gizli_hazirla(o, kod='PGIZLI'):
    """Sahte uca 6 soruluk öğretmen testi + açık ödev koyar (doğru şık i. soruda (i + 2) % 4)."""
    o.uc.sifirla()
    sorular = [{'q': f'Soru {i + 1} ____?', 'o': [f'w{i}', f'x{i}', f'y{i}', f'z{i}'], 'a': (i + 2) % 4, 'tr': f'tr {i}'} for i in range(6)]
    o.uc.testler[GIZLI_SLUG] = {'ad': 'Gizli Deneme', 'sorular': sorular}
    simdi = time.time()
    o.uc.odevler[kod] = (GIZLI_SLUG, simdi - GUN, simdi + GUN, {})
    return sorular


def sonuc_kaydi(page, kod='PGIZLI'):
    return json.loads(page.evaluate(f"localStorage.getItem('alti-saniye:sonuc:{kod}')") or 'null')


def odev_gizli(o):
    """Ödevde doğru şık soru sırasında YANMAZ (yanlışta da doğruda da); sonuç ekranı sunucu yanıtından çizilir."""
    gizli_hazirla(o)
    s = o.sayfa()
    page = s.page
    try:
        o.ac(page, 'PGIZLI', '#' + GIZLI_SLUG)
        o.bilgi_gir(page)
        expect(page.locator('#lead')).to_contain_text('test bitince')
        page.click('#start')
        page.click('#ans-0')  # 1. soru: doğru şık 2 (C) — A seçildi (yanlış)
        expect(page.locator('#ans-0')).to_have_class('ans is-sel')
        eşit(page.locator('.ans.is-lit').count(), 0, 'gizli modda doğru şık yanmamalı (yanlış seçim)')
        eşit(page.locator('#status-text').text_content(), 'Cevabın alındı', 'durum metni')
        eşit(page.locator('#row-0 .bub.lit, #row-0 .bub.ghost, #row-0 .bub.miss').count(), 0, 'optik kâğıtta anahtar yok')
        eşit(page.locator('#row-0 .bub.sel').count(), 1, 'optik kâğıtta seçilen işaretli')
        page.clock.run_for(2100)
        expect(page.locator('#num')).to_have_text('02')
        page.click('#ans-3')  # 2. soru: doğru şık 3 (D) — doğru seçildi
        expect(page.locator('#ans-3')).to_have_class('ans is-sel')
        eşit(page.locator('.ans.is-lit').count(), 0, 'gizli modda doğru şık yanmamalı (doğru seçim)')
        for _ in range(4):
            page.clock.run_for(20_000)
        expect(page.locator('#finish')).to_be_visible()
        expect(page.locator('#finish-title')).to_have_text(re.compile(r'^1'))
        expect(page.locator('#stats')).to_be_visible()
        expect(page.locator('#stats .ok b')).to_have_text('1')
        expect(page.locator('#stats .no b')).to_have_text('1')
        expect(page.locator('#stats > div:nth-child(3) b')).to_have_text('4')
        expect(page.locator('#minisheet > div')).to_have_count(6)
        expect(page.locator('#review-list .rv')).to_have_count(5)  # doğru olan 2. soru listede yok
        expect(page.locator('#review-list .rv-a b').first).to_have_text('y0')  # doğru cevap sunucudan: C) y0
        expect(page.locator('#review-list .rv-tr').first).to_have_text('tr 0')  # açıklama sunucudan
        expect(page.locator('#send-title')).to_have_text('Öğretmene gönderildi ✓')
        r = o.uc.satirlar[0]
        eşit(r['cevaplar'], '1A 2D 3- 4- 5- 6-', 'gizli modda ✓/✗ işareti yok')
        eşit((r['dogru'], r['yanlis'], r['bos'], r['puan']), (1, 1, 4, 11.1), 'sunucunun puanı (LGS: 1 - 1/3)')
        eşit(sonuc_kaydi(page) and {k: sonuc_kaydi(page)[k] for k in ('dogru', 'yanlis', 'bos', 'puan')},
             {'dogru': 1, 'yanlis': 1, 'bos': 4, 'puan': 11.1}, 'saklanan sonuç')
        sizan = [q for y in list(o.uc.yanitlar.values()) if isinstance(y, dict) and 'test' in y for q in y['test']['sorular'] if 'a' in q or 'tr' in q]
        eşit(sizan, [], 'GET yanıtında anahtar/açıklama')
        # yeniden çözerken anahtar yine görünmez
        page.click('#again')
        page.click('#ans-2')
        eşit(page.locator('.ans.is-lit').count(), 0, '2. denemede de doğru şık yanmamalı')
        o.bitir(s)
        return '2 cevap (yanlış + doğru), hiçbirinde doğru şık yanmadı → sonuç sunucudan: 1 D / 1 Y / 4 B, 11,1 puan · 2. denemede de gizli'
    finally:
        s.kapat()


def odev_gizli_cevrimdisi(o):
    """Gizli modda gönderim başarısız → sonuç ekranı "bekliyor"; yeniden açılışta gider, sunucunun puanı gösterilir."""
    gizli_hazirla(o)
    o.uc.post_modu = 'sunucu_hatasi'
    s = o.sayfa()
    page = s.page
    try:
        o.ac(page, 'PGIZLI', '#' + GIZLI_SLUG)
        o.bilgi_gir(page)
        page.click('#start')
        for _ in range(5):
            page.clock.run_for(20_000)
        expect(page.locator('#finish')).to_be_visible()
        expect(page.locator('#send-title')).to_have_text('Gönderilemedi — tekrar dene')
        expect(page.locator('#finish-msg')).to_contain_text('Sonucun bu cihazda bekliyor')
        expect(page.locator('#finish-title')).to_have_text('⌛')
        expect(page.locator('#stats')).to_be_hidden()
        expect(page.locator('#review-list .rv')).to_have_count(0)
        eşit(len(o.kuyruk(page)), 1, 'kuyruk')
        eşit(sonuc_kaydi(page), None, 'sonuç yokken saklanan')
        o.uc.post_modu = 'normal'
        page.reload()
        expect(page.locator('#queue-note')).to_contain_text('sonucun: 0 doğru, 0 yanlış, 6 boş · 0 puan')
        expect(page.locator('#queue-note')).to_contain_text('öğretmenine gönderildi ✓')
        eşit(o.kuyruk(page), [], 'kuyruk')
        eşit(len(o.uc.satirlar), 1, 'kaydedilen')
        eşit(sonuc_kaydi(page)['bos'], 6, 'saklanan sonuç')
        page.reload()  # kuyruk boş: not saklanan sonuçtan gelir
        expect(page.locator('#queue-note')).to_have_text('Son gönderilen sonucun: 0 doğru, 0 yanlış, 6 boş · 0 puan')
        expect(page.locator('#who')).to_be_visible()
        o.bitir(s)
        return 'sunucu hatası → "⌛ bekliyor", istatistik yok → yeniden açılış gönderdi → "sonucun: 0 doğru…" (kuyruktan + kayıttan)'
    finally:
        s.kapat()


def odev_eski_sunucu(o):
    """Eski sunucu: öğretmen testi cevaplı gelir, POST puanlamaz → eski davranış (doğru şık yanar, yerel hesap)."""
    sorular = gizli_hazirla(o)
    o.uc.eski_sunucu = True
    s = o.sayfa()
    page = s.page
    c = {'questions': sorular}
    try:
        o.ac(page, 'PGIZLI', '#' + GIZLI_SLUG)
        o.bilgi_gir(page)
        page.click('#start')
        d, y, b = cevapla(page, c)
        sonuc_denetle(page, c, d, y, b)
        expect(page.locator('#send-title')).to_have_text('Öğretmene gönderildi ✓')
        r = o.uc.satirlar[0]
        eşit((r['dogru'], r['yanlis'], r['bos'], r['puan']), (d, y, b, math.floor(1000 * max(0, d - y / 3) / 6 + 0.5) / 10), 'istemci puanı')
        if '✓' not in r['cevaplar'] or '✗' not in r['cevaplar']:
            raise AssertionError(f'eski sunucuda cevaplar işaretli gitmeli: {r["cevaplar"]}')
        eşit(sonuc_kaydi(page), None, 'puansız yanıtta saklanan sonuç')
        o.bitir(s)
        return f'test cevaplı geldi → doğru şık yandı → yerel sonuç {d} D / {y} Y / {b} B, gönderildi ✓'
    finally:
        s.kapat()


def odev_gizli_tekrar(o):
    """Gizli modda 2. deneme (alıştırma) de gönderilir, sunucu kaydetmez ama puanlar; sonuç ekranı yanıttan."""
    sorular = gizli_hazirla(o)
    s = o.sayfa()
    page = s.page
    c = {'questions': sorular}
    try:
        o.ac(page, 'PGIZLI', '#' + GIZLI_SLUG)
        o.bilgi_gir(page)
        page.click('#start')
        d, y, b = cevapla(page, c, gizli=True)
        sonuc_denetle(page, c, d, y, b)
        expect(page.locator('#send-title')).to_have_text('Öğretmene gönderildi ✓')
        post_once = o.uc.istek_say('POST')
        page.click('#again')  # 2. deneme: hepsi boş
        for _ in range(5):
            page.clock.run_for(20_000)
        expect(page.locator('#finish-title')).to_have_text(re.compile(r'^0'))
        expect(page.locator('#stats > div:nth-child(3) b')).to_have_text('6')
        expect(page.locator('#review-list .rv')).to_have_count(6)
        expect(page.locator('#review-list .rv-a b').first).to_have_text('y0')
        expect(page.locator('#send-title')).to_have_text('Kaydedilmedi')
        eşit(o.uc.istek_say('POST'), post_once + 1, '2. denemede POST (puanlama için)')
        eşit(len(o.uc.satirlar), 1, 'yalnız ilk deneme kayıtlı')
        eşit(sonuc_kaydi(page)['dogru'], d, 'saklanan sonuç ilk (kaydedilen) deneme')
        o.bitir(s)
        return f'1. deneme {d} D kaydedildi · 2. deneme gönderildi → "Kaydedilmedi", sonuç sunucudan (0 D / 6 B)'
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
        eşit(o.uc.istek_say('GET', '/echo'), 3, '302 sonrası okunan yanıt (ödev GET + önceki deneme GET + POST)')
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
        kos('ödev   gizli: doğru şık yanmaz', odev_gizli, o)
        kos('ödev   gizli: çevrimdışı sonuç', odev_gizli_cevrimdisi, o)
        kos('ödev   eski sunucu (cevaplı test)', odev_eski_sunucu, o)
        kos('ödev   gizli: 2. deneme puanlanır', odev_gizli_tekrar, o)
        kos('panel  anahtarsız / yanlış', panel_anahtarsiz, o)
        kos('panel  ödev oluştur → WhatsApp', panel_odev_olustur, o)
        kos('panel  sonuçlar', panel_siralama, o)
        kos('panel  ChatGPT testi → ödev', panel_ozel_test, o)
        kos('panel  ChatGPT hatalı metin', panel_ozel_hatalar, o)
        kos('panel  fotoğraf kalıbı', panel_foto_kalibi, o)
        kos('panel  hazır testi kontrol et', panel_hazir_kontrol, o)
        kos('panel  sınıf listesi', panel_sinif_listesi, o)
        kos('panel  sözlü notları', panel_sozlu, o)
        browser.close()
    print(f'duman testi: {gecen} geçti · {kalan} kaldı')
    return 1 if kalan else 0


if __name__ == '__main__':
    sys.exit(main())
