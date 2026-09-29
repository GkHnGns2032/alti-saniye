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
| 4. Sunucu testi | `araclar/sunucu_testi.js` (Node): `apps-script/Kod.gs` taklit Google servisleriyle (e-tablo, kilit, yanıt) çalıştırılır. Pencere yanıtı, sunucu saatiyle "zamanında / süre dışı", bilinmeyen kodun reddi, `deneme_no` artışı, aynı gönderimin tek satır kalması, formül enjeksiyonu, tarih biçimleri ve sıralama denetlenir: ilk deneme, puan/süre sırası, süre dışı işareti, ödev başına sekme (tek şubede eski biçim; çok şubede şube şube bloklar, her bloğun üstünde o şubenin WhatsApp metni, sıra her şubede 1'den, şubesizler "Şube yazılmamış" bloğunda en sonda) ve WhatsApp metni, panel `siralama` yanıtı eski biçimde (yeni alan yok), e-tablo menüsünde her şubenin metni ayrı kutuda ve ayrı Kopyala düğmesiyle (hiçbir kutu iki şubenin adını taşımaz; tek şubede tek kutu), sekme yeniden yazılırken eski birleşik hücre ve satır yüksekliği kalmaz (taklitte `clear()` gerçek gibi ayırmaz; `breakApart` + `setRowHeights` şart), formül enjeksiyonu kaçışı, ödevin iki şubesinden yalnız biri çözünce başlık o şubenin adı, tablo menüsü, 5 dakikalık zamanlayıcının kurulması. Öğretmen paneli: anahtar denetimi, ödev oluşturma, kendi testinin denetimi (5-40 soru, 4 farklı şık, geçerli cevap) ve kaydedilen testin ödevle öğrenciye gelmesi; onaylanan hazır testin kaynağı, listede yalnız en yeni onayın görünmesi ve `test_getir`. Ödev güvenliği (S1-S6): **S1** sunucu puanı (sayfanın puanı yok sayılır, LGS neti, ✓/✗ işaretli ya da işaretsiz cevap, bozuk cevap kesin ret, hazır test siteden bir kez okunur, site okunamazsa istemci puanı 0-100'e kırpılır ve `puan_kaynagi=istemci`, önbelleğe yazılamasa da puan sunucudan, öğretmen testi ve `plain`); **S2** sınıf listesi kapısı (listedeki ad kayda girer, Türkçe harfsiz/büyük harf/baştaki 0 kabul, yanlış ad-numara-şube ret, şubesiz gönderim ret, ödevde adı yazılmış listesiz şubede serbest ad + `liste_yok`, liste varken şubesiz ödevde listesiz şube (8-Z) GET ve POST'ta `listede_yok` (listeli şube çalışır), GET listedeki adı vermez, tekrarlanan kelime, ilk deneme listedeki adla tanınır); **S3** geçersiz say / geri al (ilk-deneme kuralından çıkar, yeni deneme varsa geri alınmaz, sıralama-katılım-not çizelgesi saymaz, anahtarsız ret); **S4** hız sınırı (kişi başı sınır yok, kod başına dakikada 240, panel sınırsız, önbellek çökerse istek geçer, bozuk sayaç, uzun kod); **S5** sunucu süresi (damga POST\'ta doğrulanır, sahte imza / başka öğrenci / başka kod → `sure_dogrulanmadi`, aynı öğrenciye hep ilk damga, eşit puanda kısa sunucu süresi önde, `DAMGA_SIRRI` `kurulum()`\'da oluşur ve depoda yoktur); **S6** cevap gizleme (`gonderim_id` tekrarı yalnız aynı ödev + numarada tanınır: eski ödevin ya da başkasının kimliği kayıt açmadan anahtar vermez, gerçek ağ tekrarı kayıtlı puanı + anahtarı döndürür ve ikinci satır yazmaz; öğrenciye giden testte doğru cevap ve açıklama yok, `gizli:true`; `CEVAP_GIZLE=false` eski yanıt; otomatik kopya onaylı sürümü ezmez). Node yoksa yerelde atlanır; **CI'da kalır**. |
| 5. Duman testi | `araclar/duman_testi.py`: gerçek tarayıcıda (Chromium) her test seçilir, başlıkların ekrandaki büyük harf yazımı denetlenir (İngilizce parça FRIENDSHIP, Türkçe parça İNGİLİZCE; FRİENDSHİP olmamalı), bütün sorular cevaplanır, sonuç ekranı ve doğru/yanlış/boş sayıları denetlenir. `<slug>/` yönlendirmeleri de denetlenir. Ödev modu (`?odev=KOD`) sahte bir uç noktayla denenir (aşağıda). **Konsol hatası = KALDI.** |

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
- `ayar.json` → `gonderim_adresi` ya yer tutucu (`BURAYA_WEB_UYGULAMASI_ADRESI`, ödev kapalı) ya da `https://script.google.com/macros/s/…/exec` biçiminde olmalı; `/dev` ya da düzenleyici adresi reddedilir. `site_adresi` `/` ile bitmeli.

## Yerelde kurulum (bir kez)

```sh
python3 -m pip install -r araclar/gereksinimler.txt
python3 -m playwright install chromium
```

Sunucu testi için Node (18+) gerekir; GitHub Actions'ta hazır gelir.

Playwright kurulu değilken hızlı kontrol: `python3 araclar/kontrol.py --duman-yok`

## Duman testi hakkında

- Motor değiştirilmez. 12 saniyelik zamanlayıcı Playwright'ın saat taklidiyle (`page.clock`) ileri sarılır; bütün test birkaç saniye sürer.
- Cevap deseni: sırayla doğru şık, yanlış şık, süre dolsun. Böylece tıklama ve zaman aşımı yolları da denenir.
- Ağdan bağımsızdır: yerel sunucu dışındaki istekler (Google Fonts) boş yanıtla karşılanır.

### Ödev modu senaryoları

Google'a hiç istek atılmaz. Sayfa, `ayar.json`'unda sahte adres olan geçici bir kopyada üretilir (depo dosyalarına dokunulmaz). Sahte uç nokta ayrı portta gerçek bir HTTP sunucusudur (farklı köken, yani gerçek CORS kuralları). Apps Script gibi davranır: yanıtı 302 ile yönlendirir ve OPTIONS'a CORS başlıksız 405 döner.

| Senaryo | Denetlenen |
|---|---|
| pencere açık | İkinci deneme çözülür ama gönderilmez ("Alıştırma · sonuç kaydedilmedi"); yeniden açınca uyarı bu cihazdan, yerel kayıt silinince sunucudan gelir; başka numarada uyarı çıkmaz. Numara, ad soyad ve sınıf/şube zorunlu; sınıf/şube yazımı `8-A`'ya çevrilir, geçersiz yazım (8, A, 8-AB, 13-A) reddedilir. Sayaç 12'den başlar. Ödevde durdur düğmesi görünmez; boşluk tuşu ve sekme değiştirme süreyi durdurmaz. Linkteki `#` farklı olsa da sunucunun `test_slug`'ı esas alınır. Sunum modu gizlidir. Tam akış sonunda "Öğretmene gönderildi ✓" görünür ve satırın bütün alanları doğrulanır. İkinci deneme `deneme_no` 2 olur. Sayfa yeniden açılınca bilgiler hatırlanır. |
| süre doldu / henüz açılmadı | "… tarihinde doldu / açılacak" yazar, form ve Başla görünmez, POST gitmez. |
| geçersiz kod | Bilinmeyen kodda "bulunamadı" görünür. Biçimi bozuk kodda sunucuya hiç sorulmaz. |
| süre dışı | Sayfa açıkken başlayan ödev, POST geldiğinde sunucu saatine göre "süre dışı" kaydedilir. |
| gönderilemedi → düğme | Ağ yokken sonuç kuyruğa girer. "Tekrar dene" ağ yokken kuyrukta tutar, ağ gelince gönderir; tek satır oluşur. |
| gönderilemedi → yeniden aç | Sunucu hata verirken kuyruk kalır; sayfa yeniden açılınca kendiliğinden gönderilir. |
| kesin ret | Sunucu kodu tanımıyorsa kayıt yapılmaz, sonuç kuyruktan düşer, "Tekrar dene" görünmez. |
| adres kurulmamış | Yer tutucu adreste uyarı görünür ve hiçbir istek gitmez. |
| `?odev` yok | Tam akış çalışır; durdur düğmesi görünür ve durdurup devam ettirir; uç noktaya **0 istek** gider, ödev ekranı/kutusu görünmez, ödev anahtarı yazılmaz. |
| CORS: text/plain | Route'suz bağlamda, yazı tipi linkleri çıkarılmış aynı sayfayla tam akış koşar: 0 OPTIONS, yanıt okunur. Negatif kontrol olarak `application/json` OPTIONS tetikler ve istek düşer. |
| panel (sonuçlar) | Sınıf listesiyle (8-A: 3 öğrenci, 8-B: 1) ilk denemeler eşlenir. Özet "3 / 4 öğrenci çözdü · ortalama 75 · 1 öğrenci yapmadı". Varsayılan görünüm şube şube: her şubenin başlığı ("8-A · 2/3 çözdü · ortalama 80"), kendi sıralaması (her şubede 1'den), kendi WhatsApp düğmesi/metni (yalnız o şubenin öğrencileri, karışık düğme yok) ve kendi hatırlatması (yalnız o şubenin yapmayanları). Öğrenciler şube başlıkları altında gruplu, grupta numara sırasında, listede olmayan grubun sonunda. Tek şubeli ödevde görünüm sade kalır (seçici ve blok başlığı yok, tek düğme). Öğrenci ayrıntısında cevaplar (doğru/yanlış/boş), eski tablodan kalan ikinci deneme "sayılmaz" notu ve "listede yok" denetlenir. Soru analizi (%25 doğru …, en çok seçilen yanlış) ve CSV indirme (başlık, "Sıra" sütunu, önce şube sonra şube içi sıra, yapmayan satırı sırasız, cevap sütunları, cevapsız eski kayıt boş) denetlenir. Şube seçici ("Şube şube (hepsi)" + tek tek şubeler): 8-B seçilince yalnız o blok, özet ve CSV değişir. |
| sözlü notları | 8-A'ya üç ödev (biri süresi sürüyor) ve 8-B'ye bir ödev. Varsayılan notlar 85 / 53 / 0: yapmadı 0, süre dışı tam, süresi süren sayılmaz, başka şubenin ödevi karışmaz. Özürlü ve 0 say kararları notu değiştirir. Bir ödevi nota saymamak özeti ve notları değiştirir. Kararlar sunucuya yazılır ve yeniden yüklemede kalır. CSV denetlenir. Sınıf listesi yokken kart "önce liste ekle" der. |
| sınıf listesi | Başlık, sıra no'lu ve sekmeyle ayrılmış satırlar okunur; aynı numara hata verir. Kaydedilince şube çipi çıkar, ödev o şubeyle oluşturulur. Aynı şube yeniden kaydedilince eskisinin yerine geçeceği söylenir. |
| panel | `?panel` anahtarsız açılınca "link gerekli" uyarısı çıkar ve hiç istek gitmez; yanlış anahtarda "geçersiz" çıkar. Ödev oluşturulunca WhatsApp mesajı test, son teslim ve linki içerir, ödev listeye düşer, mesajdaki link öğrenci olarak açılınca ödev formuna iner. Sıralama listesi ve "WhatsApp'ta paylaş" linki denetlenir. |
| kendi testi (ChatGPT) | `araclar/ornek_chatgpt.txt` (gerçek ChatGPT çıktısı) panele yapıştırılır: 20 soru ayrıştırılır, "ne sorulduğu belli değil" uyarıları çıkar, doğru cevaplar A5 B5 C5 D5'e dengelenir. Kaydedilince test "Kendi testlerin" altında seçilir, ödev oluşturulur, öğrenci linki açıp testi sunucudan gelen içerikle çözer. |
| fotoğraf kalıbı | "Kalıbı kopyala" ve "Fotoğraf kalıbını kopyala" düğmeleri (sahte panoyla) `sablon.html`'deki `KALIP` ve `KALIP_FOTO` metnini birebir panoya yazar. `araclar/ornek_chatgpt_foto.txt` (fotoğraf kalıbına uyan örnek çıktı) panele yapıştırılır: 8 soru ayrıştırılır, açıklamasında "(emin değilim)" olan 2 soru "ChatGPT cevaptan emin değil — kontrol et" sarı uyarısı alır (hata değil, kayıt engellenmez), önizlemede ve kaydedilen açıklamada "(emin değilim)" kalmaz; "(EMİN DEĞİLİM)" büyük harf yazımı da uyarı verir ve silinir. |
| kendi testi: hatalar | Soru bulunamayan metinde ve eksik şıklı soruda hata çıkar, **Testi kaydet** görünmez. Kalın yazı ve `1.` numaralama tolere edilir, diyalog satırları sorunun parçası kalır. Kaydetmeden sunucuya hiçbir şey yazılmaz. |
| hazır testi kontrol et | Friendship açılır (20 kart). Bir soru düzeltilir, bir sorunun doğru şıkkı değiştirilir, bir soru çıkarılır, yerine **Yeni soru ekle** ile boş kart açılıp yazılır. Boş şık ya da işaretsiz doğru şık varken kayıt yapılmaz ve hatalı kart işaretlenir. Onaylanınca 20 soru (yeni soru sonda) `kaynak` ile kaydedilir, kategori korunur, dokunulmayan cevaplar karıştırılmaz. Listede hazır testin yerine "✓ onaylı" sürüm çıkar. Yeniden açınca onaylanan hâl gelir. Ödev bu sürümle verilir; öğrenci düzeltilmiş soruları hazır testin görünümüyle çözer. |
| gizli cevap | `odev_gizli`: doğru şık soru sırasında yanmaz, bitince sunucudan gelen cevaplar gösterilir, yeniden çözerken anahtar görünmez. `odev_gizli_cevrimdisi`: ağ yokken sonuç saklanır, ağ gelince gönderilir. `odev_gizli_tekrar` ve `odev_gizli_tekrar_metin`: ikinci deneme (alıştırma) puanlanır ve metinler doğru. `odev_eski_sunucu`: eski (cevaplı test veren) sunucuyla sayfa hâlâ çalışır. |
| liste hataları + damga | `odev_liste_hatalari`: numara listede yoksa, şubesiz ödevde listesi olmayan şube (8-Z) yazılırsa ya da ad uyuşmuyorsa dostça hata test başlamadan görünür; süre damgası gönderilir. |
| hız sınırı | `odev_yavas`: sunucu "yavas" derse "Sistem şu an yoğun" görünür, sonuç kaybolmaz, sonra gönderilir. |
| panel (geçersiz say) | `panel_gecersiz_say`: iki adımlı "Bu denemeyi geçersiz say", öğrenci yeniden çözebilir görünür, "Geri al" ile döner. |
| panel (korumalı kopya) | `panel_korumali_kopya`: hazır testle ödev oluştururken korumalı kopya kendiliğinden çıkar; `panel_kopya_basarisiz`: kopya çıkmazsa ödev hazır testin kendi adıyla yine oluşur ve öğretmene uyarı çıkar. |
| panel (uyarılar) | `panel_uyarilar`: "⚠ Puan doğrulanamadı" ve sınıf listesi uyarıları; eşit puanda sunucu süresi ölçülen öğrenci önde. |
