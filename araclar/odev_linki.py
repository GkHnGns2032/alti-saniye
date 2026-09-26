#!/usr/bin/env python3
"""Altı Saniye — ödev linki üretici (WhatsApp'a yapıştırmak için).

Kullanım:
  python3 araclar/odev_linki.py KOD SLUG        verilen kodla link
  python3 araclar/odev_linki.py --yeni SLUG     tahmin edilmesi zor rastgele kodla link
  python3 araclar/odev_linki.py --liste         testlerin slug'larını listele
Seçenek:
  --site https://.../   ayar.json'daki site_adresi yerine bunu kullan

Çıktı: link, WhatsApp mesajı ve e-tablonun "Ödevler" sekmesine eklenecek satır.
Hiçbir yere istek atmaz; e-tabloya kendin eklersin (araç tabloya erişemez).
"""
import json
import pathlib
import re
import secrets
import sys
import urllib.parse

KOK = pathlib.Path(__file__).resolve().parent.parent
KOD_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
HARFLER = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'  # karışan harf/rakam yok (0/O, 1/I)
YER_TUTUCU = 'BURAYA_WEB_UYGULAMASI_ADRESI'


def quizler():
    qs = {}
    for p in sorted((KOK / 'quizler').glob('*.json')):
        c = json.loads(p.read_text(encoding='utf-8'))
        qs[c['slug']] = c
    return qs


def ayar():
    yol = KOK / 'ayar.json'
    return json.loads(yol.read_text(encoding='utf-8')) if yol.exists() else {}


def main(argv):
    site = None
    if '--site' in argv:
        i = argv.index('--site')
        if i + 1 >= len(argv):
            return hata('--site sonrasına site adresini yaz')
        site = argv[i + 1]
        del argv[i:i + 2]
    qs = quizler()
    if argv == ['--liste']:
        for slug, c in qs.items():
            print(f'  {slug:24} {c["name"]} · {len(c["questions"])} soru')
        return 0
    if len(argv) != 2:
        print(__doc__.strip())
        return 2
    kod, slug = argv
    if kod == '--yeni':
        kod = ''.join(secrets.choice(HARFLER) for _ in range(6))
    if not KOD_RE.match(kod):
        return hata(f'kod yalnız harf, rakam, - ve _ içerebilir (en çok 40): {kod!r}')
    if slug not in qs:
        return hata(f'"{slug}" diye bir test yok. Var olanlar: {", ".join(qs)}')
    a = ayar()
    site = site or a.get('site_adresi')
    if not site:
        return hata('site adresi yok: ayar.json\'a "site_adresi" ekle ya da --site ver')
    site = site if site.endswith('/') else site + '/'
    c = qs[slug]
    link = f'{site}index.html?odev={urllib.parse.quote(kod)}#{slug}'
    mesaj = (f'📚 Ödev: {c["name"]} ({len(c["questions"])} soru, her soruda 6 saniye)\n'
             f'Linki aç, okul numaranı ve adını soyadını yaz, başla. Son teslim tarihi linkte yazıyor.\n{link}')

    print(f'\nLink:\n  {link}\n')
    print('WhatsApp mesajı (kopyala-yapıştır):\n' + '\n'.join('  ' + x for x in mesaj.split('\n')) + '\n')
    print(f'WhatsApp\'ta doğrudan aç:\n  https://wa.me/?text={urllib.parse.quote(mesaj, safe="")}\n')
    print('E-tablonun "Ödevler" sekmesine şu satırı ekle (tarihleri kendin yaz):')
    print(f'  kod: {kod}  |  test_slug: {slug}  |  baslangic: 30.09.2026 08:00  |  bitis: 02.10.2026 23:59  |  sinif: 8-A  |  not: (isteğe bağlı)')
    if kod != kod.upper():
        print('\n  Not: kod büyük/küçük harf ayırmaz; tabloda da aynı kodu yazman yeterli.')
    adres = str(a.get('gonderim_adresi', '')).strip()
    if not adres or adres == YER_TUTUCU:
        print('\n  ! UYARI: ayar.json\'da "gonderim_adresi" henüz yer tutucu. Öğrenciler linki açınca '
              '"Ödev gönderimi kurulmamış" görür. apps-script/KURULUM.md adım 5.')
    return 0


def hata(metin):
    print(f'HATA: {metin}', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
