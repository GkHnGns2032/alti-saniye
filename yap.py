#!/usr/bin/env python3
"""Altı Saniye — sablon.html + quizler/*.json → tek sayfa (bütün testler, başta test seçimi).

Kullanım:  python3 yap.py             doğrula + üret
           python3 yap.py --dogrula  yalnız doğrula, hiçbir şey yazma
Yeni test: quizler/ altına bir JSON daha koy, betiği koş, commit + push et.
Ödev modu: ayar.json → gonderim_adresi (Apps Script web uygulaması adresi) sayfaya gömülür;
  yer tutucu değer kalırsa ödev linkleri "kurulmamış" uyarısı gösterir (apps-script/KURULUM.md).
Çıktılar üretilmiş dosyadır — elle düzenleme, şablonu ya da JSON'u düzenle:
  index.html          bütün testler tek dosyada (e-postayla da gönderilebilir)
  <slug>/index.html   eski/doğrudan linkler için yönlendirme: ../#<slug>
"""
import hashlib
import html
import json
import pathlib
import re
import sys

KOK = pathlib.Path(__file__).resolve().parent
ZORUNLU = ['slug', 'sira', 'title', 'name', 'desc', 'scoring', 'eyebrow', 'heroTop', 'heroBottom',
           'leadHtml', 'facts', 'playHint', 'sheetTag', 'messages', 'questions']
METIN = ['slug', 'title', 'name', 'desc', 'eyebrow', 'heroTop', 'heroBottom',
         'leadHtml', 'playHint', 'sheetTag']
SAYFAYA = [k for k in ZORUNLU if k != 'sira']  # JS'in kullandığı alanlar; sira/noindex yalnız üretimde
SCORING = ('lgs', 'plain')
SLUG_RE = re.compile(r'^[a-z0-9]+(-[a-z0-9]+)*$')
YER_TUTUCU = 'BURAYA_WEB_UYGULAMASI_ADRESI'
# Dağıt > Yönet'teki "Web uygulaması URL'si" (/exec). Workspace hesaplarında /a/macros/<alan>/s/... biçimi.
# http://127.0.0.1 yalnız duman testinin sahte uç noktası içindir.
ADRES_RE = re.compile(r'^(https://script\.google\.com/(a/macros/[A-Za-z0-9.-]+|macros)/s/[A-Za-z0-9_-]{20,}/exec'
                      r'|http://127\.0\.0\.1:\d+/exec)$')


def _metin_mi(v):
    return isinstance(v, str) and v.strip() != ''


def _tamsayi_mi(v):
    return isinstance(v, int) and not isinstance(v, bool)  # JSON true/false Python'da int sayılır


def dogrula(ad, c):
    """Tek bir quiz sözlüğünü denetler; hata metinlerinin listesini döndürür (boşsa geçerli)."""
    if not isinstance(c, dict):
        return [f'{ad}: dosyanın kökü bir JSON nesnesi ({{...}}) olmalı']
    h = []
    eksik = [k for k in ZORUNLU if k not in c]
    if eksik:
        h.append(f"{ad}: eksik zorunlu alan: {', '.join(eksik)}")
    for k in METIN:
        if k in c and not _metin_mi(c[k]):
            h.append(f'{ad}: "{k}" boş olmayan bir metin olmalı')
    if _metin_mi(c.get('slug')) and not SLUG_RE.match(c['slug']):
        h.append(f'{ad}: slug "{c["slug"]}" yalnız küçük harf, rakam ve tire içermeli (klasör adı olarak kullanılıyor)')
    if 'sira' in c and not _tamsayi_mi(c['sira']):
        h.append(f'{ad}: "sira" bir tamsayı olmalı (şu an: {c["sira"]!r})')
    if 'scoring' in c and c['scoring'] not in SCORING:
        h.append(f'{ad}: "scoring" yalnız "lgs" ya da "plain" olabilir (şu an: {c["scoring"]!r})')
    if 'noindex' in c and not isinstance(c['noindex'], bool):
        h.append(f'{ad}: "noindex" true ya da false olmalı')
    if 'facts' in c:
        f = c['facts']
        if not isinstance(f, list) or not all(isinstance(x, list) and len(x) == 2 and all(isinstance(y, str) for y in x) for x in f):
            h.append(f'{ad}: "facts" [["sayı", "etiket"], ...] biçiminde bir liste olmalı')
    if 'messages' in c:
        m = c['messages']
        if (not isinstance(m, list) or not m or not all(
                isinstance(x, list) and len(x) == 2 and isinstance(x[0], (int, float)) and not isinstance(x[0], bool)
                and isinstance(x[1], str) for x in m)):
            h.append(f'{ad}: "messages" boş olmayan [[oran, "metin"], ...] listesi olmalı')
    if 'questions' in c:
        qs = c['questions']
        if not isinstance(qs, list) or not qs:
            h.append(f'{ad}: "questions" en az bir soru içeren bir liste olmalı')
        else:
            for i, q in enumerate(qs, 1):
                h += dogrula_soru(f'{ad} · soru {i}', q)
    return h


def dogrula_soru(yer, q):
    if not isinstance(q, dict):
        return [f'{yer}: soru bir JSON nesnesi olmalı']
    h = []
    if not _metin_mi(q.get('q')):
        h.append(f'{yer}: soru metni ("q") boş ya da eksik')
    for k in ('c', 'tr'):
        if k in q and not isinstance(q[k], str):
            h.append(f'{yer}: "{k}" metin olmalı')
    o = q.get('o')
    if not isinstance(o, list):
        h.append(f'{yer}: şıklar ("o") bir liste olmalı')
        o = None
    elif len(o) != 4:
        h.append(f'{yer}: tam 4 şık gerekli, {len(o)} şık var')
    if o is not None:
        for j, x in enumerate(o):
            if not _metin_mi(x):
                h.append(f'{yer}: {"ABCD"[j] if j < 4 else j + 1} şıkkı boş ya da metin değil')
        gorulen = {}
        for j, x in enumerate(o):
            if _metin_mi(x):
                anahtar = ' '.join(x.split()).casefold()
                if anahtar in gorulen:
                    h.append(f'{yer}: {"ABCD"[gorulen[anahtar]] if gorulen[anahtar] < 4 else "?"} ve '
                             f'{"ABCD"[j] if j < 4 else "?"} şıkları aynı ("{x.strip()}")')
                else:
                    gorulen[anahtar] = j
    if 'a' not in q:
        h.append(f'{yer}: doğru cevap ("a") eksik')
    elif not _tamsayi_mi(q['a']) or not 0 <= q['a'] <= 3:
        h.append(f'{yer}: doğru cevap ("a") 0-3 arası tamsayı olmalı (0=A … 3=D), şu an: {q["a"]!r}')
    return h


def dogrula_hepsi(kok=KOK):
    """quizler/*.json'u okuyup denetler. (quizler, hatalar) döndürür; hiçbir şey yazmaz."""
    quizler, hatalar = [], []
    yollar = sorted((kok / 'quizler').glob('*.json'))
    if not yollar:
        hatalar.append('quizler/ klasöründe hiç .json dosyası yok')
    for yol in yollar:
        ad = f'quizler/{yol.name}'
        try:
            c = json.loads(yol.read_text(encoding='utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            hatalar.append(f'{ad}: geçersiz JSON ({e})')
            continue
        h = dogrula(ad, c)
        hatalar += h
        if not h:
            quizler.append((ad, c))
    for alan, etiket in (('slug', 'slug'), ('sira', 'sira')):
        sahip = {}
        for ad, c in quizler:
            sahip.setdefault(c[alan], []).append(ad)
        for deger, adlar in sahip.items():
            if len(adlar) > 1:
                hatalar.append(f'{etiket} {deger!r} birden fazla testte kullanılıyor: {", ".join(adlar)}')
    return [c for _, c in quizler], hatalar


def ayar_oku(kok=KOK):
    """ayar.json'u okur ve denetler. ({'gonderim': adres ya da ''}, hatalar) döndürür; dosya yoksa ödev kapalı."""
    yol = kok / 'ayar.json'
    if not yol.exists():
        return {'gonderim': ''}, []
    try:
        a = json.loads(yol.read_text(encoding='utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        return None, [f'ayar.json: geçersiz JSON ({e})']
    if not isinstance(a, dict):
        return None, ['ayar.json: dosyanın kökü bir JSON nesnesi ({...}) olmalı']
    h = []
    adres = a.get('gonderim_adresi', '')
    if not isinstance(adres, str):
        h.append('ayar.json: "gonderim_adresi" metin olmalı')
        adres = ''
    adres = adres.strip()
    if adres == YER_TUTUCU:
        adres = ''
    if adres and not ADRES_RE.match(adres):
        h.append(f'ayar.json: "gonderim_adresi" Apps Script web uygulaması adresi olmalı '
                 f'(https://script.google.com/macros/s/.../exec — Dağıt > Dağıtımları yönet), şu an: {adres!r}')
    site = a.get('site_adresi')
    if site is not None and not (isinstance(site, str) and re.match(r'^https?://\S+/$', site)):
        h.append('ayar.json: "site_adresi" / ile biten bir http(s) adresi olmalı')
    return {'gonderim': adres}, h


def hatalari_bas(hatalar):
    print(f'DOĞRULAMA BAŞARISIZ · {len(hatalar)} hata — hiçbir dosya yazılmadı:', file=sys.stderr)
    for x in hatalar:
        print(f'  ✗ {x}', file=sys.stderr)


def yonlendirme(c):
    # ../index.html (../ değil): dosya olarak açılınca ../ klasör listesine gider
    t, hedef = html.escape(c['title']), f"../index.html#{c['slug']}"
    return ('<!DOCTYPE html>\n<html lang="tr">\n<head>\n<meta charset="UTF-8">\n'
            '<meta name="robots" content="noindex">\n'
            f'<meta http-equiv="refresh" content="0;url={hedef}">\n<title>{t}</title>\n'
            f"<script>location.replace('{hedef}')</script>\n</head>\n"
            f'<body><a href="{hedef}">{t} testine git</a></body>\n</html>\n')


def yaz(yol, metin):
    yol.parent.mkdir(parents=True, exist_ok=True)
    yol.write_text(metin, encoding='utf-8')
    b = metin.encode()
    return f'{len(b)} B · md5 {hashlib.md5(b).hexdigest()[:8]}'


def uret(kok, quizler, ayar=None):
    """Bütün çıktıları bellekte hazırlar: {yol: metin}. Şablon sorunu varsa ValueError."""
    quizler = sorted(quizler, key=lambda c: (c['sira'], c['slug']))
    s = (kok / 'sablon.html').read_text(encoding='utf-8')
    kapali = any(c.get('noindex') for c in quizler)
    s = s.replace('{{robots}}', '<meta name="robots" content="noindex">' if kapali else '')
    if '{{' in s:
        raise ValueError('sablon.html: doldurulmamış şablon alanı kaldı')
    if s.count('/*QUIZ*/') != 1:
        raise ValueError('sablon.html: /*QUIZ*/ yer tutucusu tam 1 kez olmalı')
    if s.count('/*AYAR*/') != 1:
        raise ValueError('sablon.html: /*AYAR*/ yer tutucusu tam 1 kez olmalı')
    veri = json.dumps([{k: c[k] for k in SAYFAYA} for c in quizler], ensure_ascii=False).replace('</', '<\\/')
    ayar_js = json.dumps(ayar or {'gonderim': ''}, ensure_ascii=False).replace('</', '<\\/')
    cikti = {kok / 'index.html': s.replace('/*AYAR*/', ayar_js).replace('/*QUIZ*/', veri)}  # ayar önce: quiz metni etkilenmesin
    for c in quizler:
        cikti[kok / c['slug'] / 'index.html'] = yonlendirme(c)
    return quizler, cikti


def main(argv=None, kok=KOK):
    argv = sys.argv[1:] if argv is None else argv
    quizler, hatalar = dogrula_hepsi(kok)
    ayar, ayar_hatalari = ayar_oku(kok)
    hatalar += ayar_hatalari
    if not hatalar:
        try:
            quizler, cikti = uret(kok, quizler, ayar)
        except (OSError, ValueError) as e:
            hatalar.append(str(e))
    if hatalar:  # fail-closed: tek bir hata bile varsa hiçbir dosyaya dokunma
        hatalari_bas(hatalar)
        return 1
    if '--dogrula' in argv:
        n = sum(len(c['questions']) for c in quizler)
        print(f'doğrulama tamam · {len(quizler)} test · {n} soru · 0 hata')
        return 0

    sayfa = cikti.pop(kok / 'index.html')
    print(f"index.html                  {len(quizler)} test · {yaz(kok / 'index.html', sayfa)}")
    print(f"  ödev gönderimi: {'ayarlı' if ayar['gonderim'] else 'kurulmamış (ayar.json yer tutucu)'}")
    for c in quizler:
        qs = c['questions']
        dagilim = ' '.join(f"{'ABCD'[i]}{sum(q['a'] == i for q in qs)}" for i in range(4))
        durum = yaz(kok / c['slug'] / 'index.html', cikti[kok / c['slug'] / 'index.html'])
        print(f"  #{c['slug']:24} {len(qs):2} soru · {dagilim} · yönlendirme {durum}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
