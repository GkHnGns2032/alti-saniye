#!/usr/bin/env python3
"""Altı Saniye — kalite kapısı. Tek komut:  python3 araclar/kontrol.py

Adımlar (biri kalırsa sonrakiler koşmaz, çıkış kodu 1):
  1. Doğrulayıcı öz-testi   araclar/dogrulayici_testi.py (bozuk örnekler yakalanıyor mu?)
  2. İçerik doğrulama       yap.py --dogrula (quizler/*.json)
  3. Üretim                 yap.py → index.html + <slug>/index.html
     Üretilen dosyalar depodakinden farklıysa: yerelde uyarı; CI'da (CI=true) KALIR,
     çünkü JSON/şablon değişip yap.py koşulmadan commit edilmiş ya da çıktı elle düzenlenmiş demektir.
  4. Duman testi            araclar/duman_testi.py (Playwright, gerçek tarayıcı)

Seçenek:  --duman-yok   4. adımı atla (Playwright kurulu değilken hızlı yerel kontrol)
"""
import os
import pathlib
import subprocess
import sys
import time

KOK = pathlib.Path(__file__).resolve().parent.parent
PY = sys.executable


def uretilenler():
    yollar = [KOK / 'index.html'] + sorted(p / 'index.html' for p in KOK.iterdir()
                                           if p.is_dir() and (p / 'index.html').exists() and not p.name.startswith('.'))
    return {str(p.relative_to(KOK)): p.read_bytes() for p in yollar}


def adim(no, ad, komut):
    print(f'\n[{no}] {ad}', flush=True)
    t = time.monotonic()
    kod = subprocess.run(komut, cwd=KOK).returncode
    print(f'    → {"TAMAM" if kod == 0 else "KALDI"} ({time.monotonic() - t:.1f} sn)')
    return kod == 0


def main():
    duman = '--duman-yok' not in sys.argv[1:]
    ci = os.environ.get('CI', '').lower() in ('1', 'true', 'yes')

    if not adim(1, 'Doğrulayıcı öz-testi', [PY, 'araclar/dogrulayici_testi.py']):
        return 1
    if not adim(2, 'İçerik doğrulama (quizler/*.json)', [PY, 'yap.py', '--dogrula']):
        return 1

    once = uretilenler()
    if not adim(3, 'Üretim (yap.py)', [PY, 'yap.py']):
        return 1
    sonra = uretilenler()
    farkli = sorted(k for k in set(once) | set(sonra) if once.get(k) != sonra.get(k))
    if farkli:
        print('    ! Üretilen dosyalar depodakiyle aynı değildi, yap.py yeniden üretti:')
        for k in farkli:
            print(f'      - {k}')
        if ci:
            print('    ✗ CI: JSON/şablon değişmiş ama yap.py çıktısı commit edilmemiş (ya da çıktı elle düzenlenmiş).\n'
                  '      Yerelde  python3 yap.py  koşup üretilen dosyaları commit edin.')
            return 1
        print('    Yeniden üretilen dosyaları commit etmeyi unutmayın.')
    else:
        print('    ✓ Üretilen dosyalar depodakiyle birebir aynı')

    if duman:
        if not adim(4, 'Tarayıcı duman testi (Playwright)', [PY, 'araclar/duman_testi.py']):
            return 1
    else:
        print('\n[4] Duman testi atlandı (--duman-yok)')

    print('\nKALİTE KAPISI: GEÇTİ')
    return 0


if __name__ == '__main__':
    sys.exit(main())
