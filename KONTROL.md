# Kalite kapısı

Tek komut:

```sh
python3 araclar/kontrol.py
```

Her push ve PR'da GitHub Actions da aynı komutu koşar (`.github/workflows/kontrol.yml`). Bir adım kalırsa sonrakiler koşmaz, çıkış kodu 1 olur.

| Adım | Ne yapar |
|---|---|
| 1. Doğrulayıcı öz-testi | `araclar/dogrulayici_testi.py`: bilerek bozulmuş örnek quizlerle doğrulayıcının her hatayı yakaladığını ve hiçbir dosya yazmadığını denetler. |
| 2. İçerik doğrulama | `yap.py --dogrula`: `quizler/*.json` denetlenir, hiçbir şey yazılmaz. |
| 3. Üretim | `yap.py`: `index.html` ve `<slug>/index.html` üretilir. Çıktı depodakinden farklıysa yerelde uyarı verir; **CI'da kalır** (JSON değişmiş ama `yap.py` çıktısı commit edilmemiş ya da üretilmiş dosya elle düzenlenmiş demektir). |
| 4. Duman testi | `araclar/duman_testi.py`: gerçek tarayıcıda (Chromium) her test seçilir, bütün sorular cevaplanır, sonuç ekranı ve doğru/yanlış/boş sayıları denetlenir. `<slug>/` yönlendirmeleri de denetlenir. **Konsol hatası = KALDI.** |

## Doğrulayıcı neye bakar

`yap.py` her çalıştırmada aynı denetimi yapar. Tek bir hata bile varsa **hiçbir dosya yazılmaz** (fail-closed), hatalar dosya ve soru numarasıyla listelenir:

```
DOĞRULAMA BAŞARISIZ · 2 hata — hiçbir dosya yazılmadı:
  ✗ quizler/odd-one-out-7.json · soru 5: doğru cevap ("a") 0-3 arası tamsayı olmalı (0=A … 3=D), şu an: 7
  ✗ quizler/odd-one-out-7.json · soru 12: A ve C şıkları aynı ("balloon")
```

- Zorunlu alanlar: `slug, sira, title, name, desc, scoring, eyebrow, heroTop, heroBottom, leadHtml, facts, playHint, sheetTag, messages, questions`. Metin alanları boş olamaz.
- `scoring` yalnız `lgs` ya da `plain`. `noindex` varsa true/false.
- `slug` benzersiz ve yalnız `a-z 0-9 -` (klasör adı olarak kullanılır). `sira` benzersiz tamsayı.
- Her soruda boş olmayan `q`, tam 4 boş olmayan şık (`o`) ve 0-3 arası tamsayı `a` bulunur.
- Aynı soruda iki şık aynı olamaz (büyük/küçük harf ve fazla boşluk yok sayılarak).
- `facts` `[["sayı","etiket"], ...]`, `messages` `[[oran,"metin"], ...]` biçiminde olmalı.

## Yerelde kurulum (bir kez)

```sh
python3 -m pip install -r araclar/gereksinimler.txt
python3 -m playwright install chromium
```

Playwright kurulu değilken hızlı kontrol: `python3 araclar/kontrol.py --duman-yok`

## Duman testi hakkında

- Motor değiştirilmez. 6 saniyelik zamanlayıcı Playwright'ın saat taklidiyle (`page.clock`) ileri sarılır; bütün test birkaç saniye sürer.
- Cevap deseni: sırayla doğru şık, yanlış şık, süre dolsun. Böylece tıklama ve zaman aşımı yolları da denenir.
- Ağdan bağımsızdır: yerel sunucu dışındaki istekler (Google Fonts) boş yanıtla karşılanır.
