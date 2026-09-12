#!/usr/bin/env python3
"""Altı Saniye — sablon.html + quizler/*.json → tek dosyalık quiz sayfaları.

Kullanım:  python3 yap.py
Yeni test: quizler/ altına bir JSON daha koy, betiği koş, çıkan klasörü commit + push et.
Çıktılar üretilmiş dosyadır — elle düzenleme, şablonu ya da JSON'u düzenle.
"""
import hashlib
import html
import json
import pathlib
import sys

KOK = pathlib.Path(__file__).resolve().parent
ZORUNLU = ['slug', 'out', 'title', 'scoring', 'eyebrow', 'heroTop', 'heroBottom',
           'leadHtml', 'facts', 'playHint', 'sheetTag', 'messages', 'questions']


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


def uret(sablon, c):
    e = html.escape
    alanlar = {
        'title': e(c['title']), 'eyebrow': e(c['eyebrow']),
        'heroTop': e(c['heroTop']), 'heroBottom': e(c['heroBottom']),
        'leadHtml': c['leadHtml'], 'playHint': e(c['playHint']), 'sheetTag': e(c['sheetTag']),
        'count': str(len(c['questions'])),
        'robots': '<meta name="robots" content="noindex">' if c.get('noindex') else '',
        'facts': ''.join(f'<div><b>{e(n)}</b><span>{e(l)}</span></div>' for n, l in c['facts']),
    }
    s = sablon
    for k, v in alanlar.items():
        s = s.replace('{{' + k + '}}', v)
    if '{{' in s:
        sys.exit(f"{c['slug']}: doldurulmamış şablon alanı kaldı")
    veri = json.dumps({k: c[k] for k in ('slug', 'scoring', 'messages', 'questions')},
                      ensure_ascii=False).replace('</', '<\\/')
    if s.count('/*QUIZ*/') != 1:
        sys.exit('sablon.html: /*QUIZ*/ yer tutucusu tam 1 kez olmalı')
    return s.replace('/*QUIZ*/', veri)


def main():
    sablon = (KOK / 'sablon.html').read_text(encoding='utf-8')
    for yol in sorted((KOK / 'quizler').glob('*.json')):
        c = json.loads(yol.read_text(encoding='utf-8'))
        dogrula(yol.name, c)
        s = uret(sablon, c)
        hedef = KOK / c['out']
        hedef.parent.mkdir(parents=True, exist_ok=True)
        hedef.write_text(s, encoding='utf-8')
        qs = c['questions']
        dagilim = ' '.join(f"{'ABCD'[i]}{sum(q['a'] == i for q in qs)}" for i in range(4))
        b = s.encode()
        print(f"{c['out']:28} {len(qs):2} soru · {dagilim} · {len(b)} B · md5 {hashlib.md5(b).hexdigest()[:8]}")


if __name__ == '__main__':
    main()
