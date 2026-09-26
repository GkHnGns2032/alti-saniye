#!/usr/bin/env python3
"""yap.py doğrulayıcısının öz-testi: bilerek bozulmuş quizlerle geçici bir kopyada koşar.

Her bozukluk için (1) yakalandığını, (2) çıkış kodunun sıfır olmadığını, (3) hiçbir dosyanın
yazılmadığını (fail-closed) denetler. Gerçek quizler/ ve üretilmiş dosyalara dokunmaz.
"""
import contextlib
import copy
import io
import json
import pathlib
import shutil
import sys
import tempfile

KOK = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KOK))
sys.dont_write_bytecode = True  # depoya (ve Pages'e) __pycache__ düşmesin
import yap  # noqa: E402

SORU = {'c': 'Ünite 1', 'q': 'Which one?', 'o': ['red', 'blue', 'green', 'pink'], 'a': 2}
QUIZ = {
    'slug': 'ornek', 'sira': 1, 'title': 'Örnek', 'name': 'Örnek test', 'desc': 'Öz-test verisi.',
    'scoring': 'plain', 'eyebrow': 'x', 'heroTop': 'x', 'heroBottom': 'y', 'leadHtml': '<p>x</p>',
    'facts': [['1', 'soru']], 'playHint': 'x', 'sheetTag': 'X', 'messages': [[0.5, 'iyi'], [-99, 'devam']],
    'questions': [copy.deepcopy(SORU) for _ in range(3)],
}


def q(**degisiklik):
    """3 soruluk geçerli quiz; 2. soruyu verilen alanlarla bozar (None = alanı sil)."""
    c = copy.deepcopy(QUIZ)
    for k, v in degisiklik.items():
        if v is None:
            c['questions'][1].pop(k, None)
        else:
            c['questions'][1][k] = v
    return c


def ust(**degisiklik):
    c = copy.deepcopy(QUIZ)
    for k, v in degisiklik.items():
        if v is None:
            c.pop(k, None)
        else:
            c[k] = v
    return c


# (ad, {dosya: içerik (dict ya da ham metin)}, beklenen hata parçası)
VAKALAR = [
    ('3 şık', {'a.json': q(o=['a', 'b', 'c'])}, 'a.json · soru 2: tam 4 şık gerekli, 3 şık var'),
    ('5 şık', {'a.json': q(o=['a', 'b', 'c', 'd', 'e'])}, 'soru 2: tam 4 şık gerekli, 5 şık var'),
    ('a = 4', {'a.json': q(a=4)}, 'soru 2: doğru cevap ("a") 0-3 arası tamsayı'),
    ('a = -1', {'a.json': q(a=-1)}, 'soru 2: doğru cevap ("a") 0-3 arası tamsayı'),
    ('a = "1"', {'a.json': q(a='1')}, 'soru 2: doğru cevap ("a") 0-3 arası tamsayı'),
    ('a = 1.0', {'a.json': q(a=1.0)}, 'soru 2: doğru cevap ("a") 0-3 arası tamsayı'),
    ('a = true', {'a.json': q(a=True)}, 'soru 2: doğru cevap ("a") 0-3 arası tamsayı'),
    ('a eksik', {'a.json': q(a=None)}, 'soru 2: doğru cevap ("a") eksik'),
    ('tekrar şık', {'a.json': q(o=['cat', 'dog', 'cat', 'cow'])}, 'soru 2: A ve C şıkları aynı'),
    ('tekrar şık (büyük/küçük, boşluk)', {'a.json': q(o=['Cat', 'dog', ' cat ', 'cow'])}, 'soru 2: A ve C şıkları aynı'),
    ('boş şık', {'a.json': q(o=['a', '  ', 'c', 'd'])}, 'soru 2: B şıkkı boş'),
    ('şık metin değil', {'a.json': q(o=['a', 3, 'c', 'd'])}, 'soru 2: B şıkkı boş ya da metin değil'),
    ('boş soru', {'a.json': q(q='   ')}, 'soru 2: soru metni ("q") boş'),
    ('soru eksik', {'a.json': q(q=None)}, 'soru 2: soru metni ("q") boş'),
    ('zorunlu alan eksik', {'a.json': ust(title=None, messages=None)}, 'eksik zorunlu alan: title, messages'),
    ('sira eksik', {'a.json': ust(sira=None)}, 'eksik zorunlu alan: sira'),
    ('scoring yanlış', {'a.json': ust(scoring='net')}, '"scoring" yalnız "lgs" ya da "plain"'),
    ('slug güvensiz', {'a.json': ust(slug='../kotu')}, 'slug "../kotu" yalnız küçük harf'),
    ('soru listesi boş', {'a.json': ust(questions=[])}, '"questions" en az bir soru'),
    ('slug tekrar', {'a.json': ust(sira=1), 'b.json': ust(sira=2)}, "slug 'ornek' birden fazla testte"),
    ('sira tekrar', {'a.json': ust(slug='bir'), 'b.json': ust(slug='iki')}, "sira 1 birden fazla testte"),
    ('bozuk JSON', {'a.json': '{"slug": '}, 'a.json: geçersiz JSON'),
    ('kök liste', {'a.json': [QUIZ]}, 'kökü bir JSON nesnesi'),
    # bir dosya geçerli, diğeri bozuk: yine hiçbir şey yazılmamalı
    ('karışık', {'a.json': ust(slug='iyi', sira=1), 'b.json': ust(slug='kotu', sira=2, scoring='x')}, 'b.json: "scoring"'),
]


def kur(tmp, dosyalar):
    (tmp / 'quizler').mkdir()
    shutil.copy(KOK / 'sablon.html', tmp / 'sablon.html')
    for ad, icerik in dosyalar.items():
        metin = icerik if isinstance(icerik, str) else json.dumps(icerik, ensure_ascii=False)
        (tmp / 'quizler' / ad).write_text(metin, encoding='utf-8')


def dosya_kumesi(tmp):
    return sorted(str(p.relative_to(tmp)) for p in tmp.rglob('*') if p.is_file())


def kos(dosyalar, argv=()):
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        kur(tmp, dosyalar)
        once = dosya_kumesi(tmp)
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            kod = yap.main(list(argv), kok=tmp)
        return kod, err.getvalue(), once, dosya_kumesi(tmp)


def main():
    gecen = kalan = 0

    def sonuc(ok, ad, neden=''):
        nonlocal gecen, kalan
        gecen, kalan = gecen + ok, kalan + (not ok)
        print(f"  {'✓' if ok else '✗'} {ad}" + (f' — {neden}' if neden else ''))

    # Pozitif: geçerli veri üretir ve 0 döner
    kod, err, once, sonra = kos({'a.json': QUIZ})
    sonuc(kod == 0 and 'index.html' in sonra and 'ornek/index.html' in sonra and not err,
          'geçerli quiz → 0 · index.html + ornek/index.html üretildi', err.strip())

    for ad, dosyalar, beklenen in VAKALAR:
        kod, err, once, sonra = kos(dosyalar)
        sorunlar = []
        if kod == 0:
            sorunlar.append('çıkış kodu 0')
        if beklenen not in err:
            sorunlar.append(f'beklenen mesaj yok: {beklenen!r} · gelen: {err.strip()!r}')
        if once != sonra:
            sorunlar.append(f'dosya yazıldı: {sorted(set(sonra) - set(once))}')
        sonuc(not sorunlar, ad, '; '.join(sorunlar))

    # --dogrula hiçbir şey yazmaz
    kod, err, once, sonra = kos({'a.json': QUIZ}, ['--dogrula'])
    sonuc(kod == 0 and once == sonra, '--dogrula geçerli veride 0 döner, dosya yazmaz')

    print(f'doğrulayıcı öz-testi: {gecen} geçti · {kalan} kaldı')
    return 1 if kalan else 0


if __name__ == '__main__':
    sys.exit(main())
