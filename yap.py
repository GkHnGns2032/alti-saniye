#!/usr/bin/env python3
"""Altı Saniye — sablon.html + quizler/*.json → tek sayfa (bütün testler, başta test seçimi).

Kullanım:  python3 yap.py
Yeni test: quizler/ altına bir JSON daha koy, betiği koş, commit + push et.
Çıktılar üretilmiş dosyadır — elle düzenleme, şablonu ya da JSON'u düzenle:
  index.html          bütün testler tek dosyada (e-postayla da gönderilebilir)
  <slug>/index.html   eski/doğrudan linkler için yönlendirme: ../#<slug>
"""
import hashlib
import html
import json
import pathlib
import sys

KOK = pathlib.Path(__file__).resolve().parent
ZORUNLU = ['slug', 'title', 'name', 'desc', 'scoring', 'eyebrow', 'heroTop', 'heroBottom',
           'leadHtml', 'facts', 'playHint', 'sheetTag', 'messages', 'questions']
SAYFAYA = ZORUNLU  # JS'in kullandığı alanlar; sira/noindex yalnız üretimde


def dogrula(ad, c):
    eksik = [k for k in ZORUNLU if k not in c]
    if eksik:
        sys.exit(f'{ad}: eksik alan {eksik}')
    if c['scoring'] not in ('lgs', 'plain'):
        sys.exit(f'{ad}: scoring "lgs" ya da "plain" olmalı')
    for i, q in enumerate(c['questions'], 1):
        if len(q['o']) != 4 or len(set(q['o'])) != 4:
            sys.exit(f'{ad} soru {i}: 4 farklı şık gerekli')
        if q['a'] not in (0, 1, 2, 3):
            sys.exit(f'{ad} soru {i}: doğru cevap 0-3 arası olmalı (0=A)')


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


def main():
    quizler = []
    for yol in (KOK / 'quizler').glob('*.json'):
        c = json.loads(yol.read_text(encoding='utf-8'))
        dogrula(yol.name, c)
        quizler.append(c)
    if len({c['slug'] for c in quizler}) != len(quizler):
        sys.exit('iki test aynı slug\'ı kullanıyor')
    quizler.sort(key=lambda c: (c.get('sira', 99), c['slug']))

    s = (KOK / 'sablon.html').read_text(encoding='utf-8')
    kapali = any(c.get('noindex') for c in quizler)
    s = s.replace('{{robots}}', '<meta name="robots" content="noindex">' if kapali else '')
    if '{{' in s:
        sys.exit('sablon.html: doldurulmamış şablon alanı kaldı')
    if s.count('/*QUIZ*/') != 1:
        sys.exit('sablon.html: /*QUIZ*/ yer tutucusu tam 1 kez olmalı')
    veri = json.dumps([{k: c[k] for k in SAYFAYA} for c in quizler], ensure_ascii=False).replace('</', '<\\/')
    s = s.replace('/*QUIZ*/', veri)

    print(f"index.html                  {len(quizler)} test · {yaz(KOK / 'index.html', s)}")
    for c in quizler:
        qs = c['questions']
        dagilim = ' '.join(f"{'ABCD'[i]}{sum(q['a'] == i for q in qs)}" for i in range(4))
        durum = yaz(KOK / c['slug'] / 'index.html', yonlendirme(c))
        print(f"  #{c['slug']:24} {len(qs):2} soru · {dagilim} · yönlendirme {durum}")


if __name__ == '__main__':
    main()
