# Kelime doğrulama: test kelimelerini ders kitabı metninde sayar (sözlük dışı sayfa sayısı).
# Kitap PDF → pdftotext -layout kitap.pdf <ad>.txt ; K sözlüğündeki adları kendi .txt dosyalarına göre düzenle.
# Kural: her kelime her kitapta en az 2 sayfada geçmeli. Dikkat: "fin"→find, "win"→wind gibi ekli eşleşmeler sayıyı şişirir.
import json, re, sys
SON = 10  # kitap sonundaki sözlük/cevap sayfaları sayılmaz
def yukle(ad):
    ham = open(ad+'.txt', encoding='utf-8', errors='ignore').read()
    s = [re.sub(r'\s+', ' ', re.sub(r'-\s*\n\s*', '', p)).lower().replace('’', "'").replace('-', ' ') for p in ham.split('\f')]
    return s[:-SON]
K = {ad: yukle(ad) for ad in ['meb-a', 'meb-b', 'sdr']}
def ara(w):
    k = w.lower().replace('’', "'").replace('-', ' ').replace('the moon', 'moon')
    k = re.sub(r"'s$", '', k)
    rx = re.compile(r'\b' + r'\s+'.join(map(re.escape, k.split())) + r"(s|es|d|ed|ing|'s)?\b")
    return {ad: len({i for i, p in enumerate(ps) if rx.search(p)}) for ad, ps in K.items()}
def satir(w):
    c = ara(w); return min(c.values()), c
if __name__ == '__main__':
    AD = json.load(open(sys.argv[1], encoding='utf-8'))
    for unite, kelimeler in AD.items():
        sonuc = sorted(((satir(w), w) for w in kelimeler), key=lambda x: -x[0][0])
        ok = [f"{w}({m})" for (m, c), w in sonuc if m >= 2]
        zayif = [f"{w}({c['meb-a']}/{c['meb-b']}/{c['sdr']})" for (m, c), w in sonuc if m < 2]
        print(f"\n## {unite}\n  ✓ {' · '.join(ok)}\n  ✗ {' · '.join(zayif)}")
