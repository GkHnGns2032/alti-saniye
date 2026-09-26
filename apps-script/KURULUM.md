# Ödev modu kurulumu (öğretmen için)

Bu rehberin sonunda şunlar olacak: öğrencilere WhatsApp'tan bir link gönderiyorsun. Öğrenci linki açıyor, okul numarasını ve adını soyadını yazıp testi çözüyor. Sonuç **senin Google E-Tablona** kendiliğinden düşüyor, öğrenci de kendi sonucunu ekranda görüyor. Ödevin açık olduğu süreyi sen belirliyorsun.

**Süre:** ilk kurulum yaklaşık 20 dakika. Sonraki her ödev için 2 dakika (bir satır + bir link).

**Gerekenler:**

- **Kişisel** bir Google hesabı (…@gmail.com). Okulun verdiği Google hesapları çoğu zaman "Herkes erişebilir" ayarını kapatır; o zaman öğrenciler sonuç gönderemez.
- Bilgisayar (telefondan Apps Script kurulumu zor).

> **Gizlilik:** Öğrenci adları ve numaraları yalnız senin e-tablona yazılır. Bu depo herkese açıktır; depoya hiçbir öğrenci bilgisi girmez. Telefon numarası istenmez.

---

## 1. E-tabloyu oluştur

1. Tarayıcıda **sheets.new** adresini aç. Boş bir e-tablo açılır.
2. Sol üstteki "Adsız e-tablo" yazısına tıkla ve adını değiştir, örneğin **Altı Saniye Ödevleri**.
3. **Dosya > Ayarlar** menüsünü aç:
   - **Yerel ayar:** Türkiye
   - **Saat dilimi:** (GMT+03:00) İstanbul
   - **Ayarları kaydet**'e bas.

   Saat dilimi önemli. Ödevin başlangıç ve bitiş saatleri bu saat dilimine göre okunur.

## 2. Sekmeler ve başlıklar

İki sekme gerekiyor. **3. adımda bunları kod kendisi açacak**, şimdilik bir şey yapmana gerek yok. Elle açmak istersen adları ve ilk satırları şöyle olmalı (sekme adları birebir aynı, Türkçe harfleriyle):

**Ödevler** sekmesi, ilk satır (A1'den F1'e):

| kod | test_slug | baslangic | bitis | sinif | not |
|---|---|---|---|---|---|

**Sonuçlar** sekmesi, ilk satır (A1'den N1'e):

| sunucu_zamani | kod | test_slug | numara | ad_soyad | dogru | yanlis | bos | puan | durum | deneme_no | cevaplar | istemci_sure_ms | gonderim_id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

## 3. Kodu yapıştır

1. E-tabloda **Uzantılar > Apps Komut Dosyası** menüsünü aç (İngilizce menüde adı **Apps Script**). Yeni sekmede bir kod düzenleyicisi açılır.
2. Sol üstte "Adsız proje" yazısına tıkla, adını **Altı Saniye Ödev** yap.
3. Ortadaki `Kod.gs` dosyasında yazan her şeyi sil (`function myFunction() {...}`).
4. Bu depodaki [`apps-script/Kod.gs`](Kod.gs) dosyasını aç. GitHub'da sağ üstteki **Raw** düğmesine bas, sayfadaki her şeyi seç (Ctrl+A / Cmd+A) ve kopyala.
5. Düzenleyiciye yapıştır, ardından **Kaydet** simgesine (💾) bas.
6. Üstteki işlev listesinden **kurulum**'u seç ve **Çalıştır**'a bas.
7. Google senden izin ister:
   - **İzinleri incele**'ye bas ve hesabını seç.
   - "Google bu uygulamayı doğrulamadı" uyarısı çıkarsa **Gelişmiş**'e, sonra en alttaki **… uygulamasına git (güvenli değil)** yazısına bas. Uyarıda "geliştirici" olarak kendi gmail adresin yazmalı.
   - **İzin ver**'e bas.

   Bu uyarının sebebi kodu Google'ın değil senin eklemiş olman. Kod yalnızca bu e-tabloyu okuyup yazar.
8. E-tabloya dön. **Ödevler** ve **Sonuçlar** sekmeleri başlıklarıyla açılmış olmalı. Boş "Sayfa1" sekmesini silebilirsin.

## 4. Web uygulaması olarak dağıt

1. Apps Script düzenleyicisinde sağ üstteki **Dağıt > Yeni dağıtım**'a bas.
2. "Tür seçin"in yanındaki ⚙️ simgesine bas ve **Web uygulaması**'nı seç.
3. Ayarları şöyle yap:
   - **Açıklama:** ödev
   - **Şu kullanıcı olarak yürüt:** **Ben** (kendi e-posta adresin)
   - **Erişimi olanlar:** **Herkes** ("Google hesabı olan herkes" DEĞİL. Öğrencilerin Google'a giriş yapması gerekmesin.)
4. **Dağıt**'a bas. İzin isterse 3. adımdaki gibi ver.
5. **Web uygulaması URL'sini** kopyala. Adres `https://script.google.com/macros/s/…/exec` biçimindedir ve **/exec** ile biter.
6. Denemek için bu adresi yeni bir tarayıcı sekmesinde aç. Ekranda şuna benzer bir yazı görmelisin:
   `{"ok":true,"servis":"alti-saniye","surum":1}`

> Bu adres sayfanın kaynağında herkese görünür, bu normaldir. Adresi bilen biri yalnızca bir ödevin açık olup olmadığını sorabilir ya da sonuç gönderebilir. **Tablonu okuyamaz**; Sonuçlar sekmesi hiçbir şekilde dışarı verilmez.

## 5. Adresi `ayar.json`'a koy (bir kez)

Depodaki `ayar.json` dosyasında `BURAYA_WEB_UYGULAMASI_ADRESI` yazan yere 4. adımda kopyaladığın adresi yapıştır:

```json
{
 "gonderim_adresi": "https://script.google.com/macros/s/……/exec",
 "site_adresi": "https://gkhngns2032.github.io/alti-saniye/"
}
```

Ardından sayfayı yeniden üret ve yayınla:

```sh
python3 yap.py          # index.html'i yeni adresle üretir ("ödev gönderimi: ayarlı" yazmalı)
python3 araclar/kontrol.py
git add ayar.json index.html && git commit -m "Ödev gönderim adresi ayarlandı" && git push
```

Adres yanlış biçimdeyse (örneğin sonu `/dev` ya da düzenleyici adresi) `yap.py` hiçbir dosya yazmaz ve neyin yanlış olduğunu söyler. Bilgisayarında Python yoksa adresi depoyu yöneten kişiye gönder. Bu adım yalnızca bir kez yapılır; yeni ödev vermek için tekrar gerekmez.

## 6. Ödev satırı ekle (her ödev için)

**Ödevler** sekmesinde yeni bir satıra yaz:

| sütun | ne yazılır | örnek |
|---|---|---|
| kod | Ödevin kodu. Harf, rakam, `-`, `_`. Büyük/küçük harf fark etmez. **Tahmin edilmesi zor olsun.** | `K7M2QX` |
| test_slug | Hangi test? Aşağıdaki listeden. | `ingilizce-8` |
| baslangic | Açılış. Boş bırakırsan hemen açık. | `30.09.2026 08:00` |
| bitis | Son teslim. Boş bırakırsan hiç kapanmaz. | `02.10.2026 23:59` |
| sinif | Senin notun, öğrenci görmez. | `8-A` |
| not | Senin notun, öğrenci görmez. | `3. hafta tekrarı` |

- Tarihi `GG.AA.YYYY SS:DD` biçiminde yaz. Sheets çoğu zaman bunu tarihe kendisi çevirir, sorun değil.
- **Bitiş için yalnız gün yazarsan** (`02.10.2026`), o günün **sonuna** (23:59) kadar açık kalır. Bitiş saati `00:00` yazılırsa da aynı şekilde günün sonu sayılır.
- Her ödevin kodu farklı olmalı. Aynı kod iki satırda varsa üstteki geçerlidir.

**Testler (test_slug):**

| test_slug | test |
|---|---|
| `ingilizce-8` | 8. Sınıf İngilizce (25 soru, LGS neti) |
| `odd-one-out-7` | 7. Sınıf Odd One Out (20 soru) |
| `do-you-know-me` | Do you know me? (10 soru) |

Güncel liste için: `python3 araclar/odev_linki.py --liste`

## 7. WhatsApp linkini üret

```sh
python3 araclar/odev_linki.py K7M2QX ingilizce-8     # kendi kodunla
python3 araclar/odev_linki.py --yeni ingilizce-8     # araç rastgele kod üretsin (sonra tabloya o kodu yaz)
```

Araç şunları yazdırır: link, WhatsApp'a yapıştırılacak hazır mesaj, WhatsApp'ı mesaj yazılı hâlde açan bir adres ve tabloya eklenecek satır.

Python yoksa linki elle de yazabilirsin:

```
https://gkhngns2032.github.io/alti-saniye/index.html?odev=KOD#test_slug
```

**Göndermeden önce linki kendin aç.** Ödev ekranını ve "Son teslim" tarihini görmelisin. İstersen kendi adınla bir deneme çöz; Sonuçlar sekmesinde satırın göründükten sonra o satırı silebilirsin.

## 8. Sonuçları oku

Her tamamlanan deneme **Sonuçlar** sekmesine bir satır olarak düşer:

| sütun | anlamı |
|---|---|
| sunucu_zamani | Sonucun Google'a ulaştığı an (öğrencinin telefon saati değil). |
| kod, test_slug | Hangi ödev, hangi test. |
| numara, ad_soyad | Öğrencinin kendi yazdığı bilgiler. |
| dogru, yanlis, bos | Süre dolup boş kalan sorular "bos" sayılır. |
| puan | 100 üzerinden. LGS testlerinde netten hesaplanır (3 yanlış 1 doğruyu götürür). |
| durum | **zamanında** ya da **süre dışı**. Süre dışı sonuçlar da kaydedilir, karar senin. |
| deneme_no | Aynı öğrencinin (aynı kod + numara) bu ödevdeki kaçıncı denemesi. İkinci deneme engellenmez. |
| cevaplar | Soru sırasıyla: `1B✓ 2C✗ 3-`. Harf öğrencinin işaretlediği şık, ✓ doğru, ✗ yanlış, `-` boş. |
| istemci_sure_ms | Testi bitirme süresi (milisaniye; 60000 = 1 dakika). Öğrencinin cihazından gelir. |
| gonderim_id | Teknik alan. İnternet kopup sayfa aynı sonucu yeniden gönderirse ikinci satır açılmasın diye kullanılır. |

İpucu: **Veri > Filtre oluştur** ile koda ya da sınıfa göre süzebilirsin.

## 9. Sıralamayı çocuklara gönder

Her ödevin sıralaması, tabloda kendi sekmesinde **5 dakikada bir kendiliğinden** yenilenir. Sekmenin adı **Sıralama** ve ardından ödev kodudur (ör. **Sıralama AMPBGG**). Sekme, o ödeve ilk sonuç geldikten sonraki 5 dakika içinde açılır.

- **1. satır:** WhatsApp'a yapıştırılacak hazır metin.
- **2. satır:** Son güncellenme zamanı.
- **Altındaki tablo:** Sıra, ad soyad, numara, puan, doğru, yanlış, boş, süre, durum.

**Telefondan gönderme** (Google E-Tablolar uygulaması):
1. **Ödev Sonuçları** tablosunu aç ve alttan **Sıralama KOD** sekmesine geç.
2. En üstteki metin kutusuna (1. satır) dokun, sonra **Kopyala**'ya dokun.
3. WhatsApp'ta sınıf grubuna yapıştır ve gönder.

**Bilgisayardan:** Üst menüde **Altı Saniye > Sıralama oluştur**'u kullanabilirsin. 5 dakikayı beklemeden hemen yeniler ve metni kopyalanabilir bir pencerede gösterir. Bu menü yalnızca bilgisayarda görünür; Google özel menüleri telefonda göstermez.

Sıralama kuralları:
- Her öğrencinin **ilk denemesi** sayılır. Test bitince doğru cevaplar göründüğü için sonraki denemeler sayılmaz. Öğrenci numara ve ad soyadıyla birlikte tanınır; iki öğrenci aynı numarayı yazsa da ayrı sıralanır.
- Puana göre yüksekten düşüğe dizilir. Puanlar eşitse testi **daha kısa sürede** bitiren öne geçer.
- Öğrencinin tam adı yazılır.
- Her öğrencinin yanında puanı, doğru ve yanlış sayısı yazar. Boş bıraktığı soru varsa o da yazar.
- Süre dışı sonuçlar da listede yer alır, yanlarında **(süre dışı)** yazar.
- Otomatik yenileme son 7 günde sonuç gelen ödevler için çalışır. Daha eski bir ödevin sıralaması en son hâliyle sekmesinde kalır.

Örnek metin:

```
🏆 Ödev sıralaması · ingilizce-8-friendship · 8-A
(ilk denemeler, 100 üzerinden)

🥇 Ali Veli — 90 puan · 18 doğru, 2 yanlış
🥈 Can Demir — 80 puan · 16 doğru, 4 yanlış
🥉 Ayşe Yılmaz — 80 puan · 16 doğru, 3 yanlış, 1 boş
4. Ece Kaya — 50 puan · 10 doğru, 8 yanlış, 2 boş (süre dışı)

4 öğrenci katıldı.
```

**Otomatik yenilemeyi açmak için (bir kez):** Apps Script düzenleyicisinde üstteki işlev listesinden **kurulum**'u seç ve **Çalıştır**'a bas. Google zamanlayıcı için yeniden izin isteyebilir; 3. adımdaki gibi ver. **Yürütme günlüğü**'nde "sıralama zamanlayıcısı kuruldu (5 dk)" yazısını görmelisin.

## 10. Öğretmen paneli: telefondan tek ekran (önerilen)

Tabloya hiç girmeden, telefondan tek bir sayfayla ödev verip sıralama gönderebilirsin:
- **Yeni ödev:** Testi seç, son teslim gününü seç, **Ödevi oluştur**'a bas, sonra **WhatsApp'ta gönder**'e bas. Ödev kodunu ve tablodaki satırı sistem kendisi oluşturur.
- **Ödevlerim:** Her ödevin kaç öğrenci tarafından çözüldüğü görünür. **Sıralamayı göster**'e, sonra **Sıralamayı WhatsApp'ta paylaş**'a bas.

**Kurulum (bilgisayardan, bir kez):**
1. Güncel `Kod.gs`'i yapıştır ve kaydet.
2. **kurulum**'u **Çalıştır**. Yürütme günlüğünde **ÖĞRETMEN PANELİ** ile başlayan bir satırda gizli link yazar: `https://…/index.html?panel#…`. Bu linki kopyala.
3. **Dağıt > Yeni dağıtım > Web uygulaması** (Ben / Herkes). Yeni `…/exec` adresini `ayar.json`'a koy (5. adım).
4. Gizli linki öğretmene gönder (ör. kendi WhatsApp'ına).

**Telefonda ana ekrana ekle (bir kez):**
- **iPhone (Safari):** Linki aç, alttaki **Paylaş** simgesine (kare ve yukarı ok) dokun, **Ana Ekrana Ekle**'yi seç.
- **Android (Chrome):** Linki aç, sağ üstte **⋮** menüsünü aç, **Ana ekrana ekle**'yi seç.

Bundan sonra ana ekrandaki simgeye dokunmak yeter.

**Gizlilik:** Link yalnızca öğretmene özeldir; öğrencilerle ya da gruplarla paylaşma. Başkasının eline geçerse Apps Script'te **anahtariYenile** işlevini **Çalıştır**. Eski link çalışmaz hâle gelir, günlükte yeni link yazar. Linki günlükte yeniden görmek için **ogretmenLinki**'ni çalıştırman yeterli.

## 11. Kendi testini hazırla (ücretsiz ChatGPT, telefondan)

Hazır testlerde olmayan bir konuyu öğretmen kendisi ekleyebilir. Hesap ya da bilgisayar gerekmez; ücretsiz ChatGPT yeterli. Panelde **Kendi testini ekle (ChatGPT)** kartını aç:

1. **Kalıbı kopyala**'ya bas.
2. ChatGPT'yi aç, kalıbı yapıştır. En sondaki **Konu:** kısmına konuyu yaz (ör. `Unit 6 Adventures`) ve gönder.
3. ChatGPT'nin cevabını baştan sona kopyala (cevabın altındaki kopyala simgesi).
4. Panele dön, kutuya yapıştır, **Kontrol et**'e bas.
5. Ekranda testin adı, soru sayısı ve bütün sorular doğru şıkları işaretli olarak görünür. Sarı uyarıları oku; yanlış görünen bir soru varsa ChatGPT'den o soruyu düzeltmesini iste ve yeniden yapıştır.
6. **Testi kaydet**'e bas. Test, **Yeni ödev** listesinde **Kendi testlerin** başlığı altında görünür; oradan her zamanki gibi ödev verilir.

Sistem kendiliğinden şunları yapar:
- Kalın yazı, numara biçimi (`1.` ya da `1)`), girinti gibi farkları tolere eder.
- Doğru cevaplar hep aynı harfte toplanmasın diye şıkların sırasını karıştırır (A, B, C, D eşit dağılır). "All of the above" gibi sırası önemli şıklar içeren sorulara dokunmaz.
- Eksik şıklı, cevabı olmayan ya da aynı şıkkı iki kez içeren soruları hata olarak gösterir; hata varken kaydetmez.
- 5 ile 40 arasında soru kabul eder.

Kaydedilen testler e-tablonun **Testler** sekmesinde durur (sekme ilk kayıtta kendiliğinden açılır). Bu sekmeyi elle düzenleme.

**Önemli:** ChatGPT hata yapabilir. Soruları ve cevapları göndermeden önce öğretmen mutlaka okur; sistem yalnızca biçimi denetler, içeriğin doğruluğunu denetleyemez.

## Kodu güncellemek

`Kod.gs`'in yeni bir sürümü çıkarsa kodu yine yapıştır ve kaydet. Ardından **kurulum**'u bir kez **Çalıştır** (zamanlayıcı yeni kodla kurulsun). Yalnızca sıralama bölümü değiştiyse bu kadarı yeter. Aşağıdaki yeniden dağıtım yalnızca öğrencilerin kullandığı ödev tarafı değiştiğinde gerekir. Sonra **Dağıt > Dağıtımları yönet**'e gir, ✏️ simgesine bas, **Sürüm: Yeni sürüm** seç ve **Dağıt**'a bas. Bu yolla adres **aynı kalır**. "Yeni dağıtım" yaparsan adres değişir ve 5. adımı tekrarlaman gerekir.

## Sorun giderme

| öğrencinin gördüğü | sebep ve çözüm |
|---|---|
| Ödev gönderimi kurulmamış | `ayar.json`'daki adres hâlâ yer tutucu (5. adım). |
| Ödev bulunamadı | Kod Ödevler sekmesinde yok ya da yanlış yazılmış. Sekme adı tam olarak **Ödevler** mi? |
| Ödevin tarihi okunamadı | baslangic/bitis hücresi tarih değil. `30.09.2026 08:00` biçiminde yaz. |
| Bağlantı kurulamadı | İnternet yok ya da dağıtımda **Erişimi olanlar: Herkes** seçili değil (4. adım). Okul hesabı da engel olabilir. |
| Henüz açılmadı / Süre doldu | Tarihler beklediğinden farklıysa e-tablonun saat dilimini kontrol et (1. adım). |
| Gönderilemedi — tekrar dene | Bağlantı koptu. Sonuç öğrencinin cihazında saklanır; "Tekrar dene"ye basınca ya da link yeniden açılınca kendiliğinden gönderilir. |

Kodu değiştirdin ama etkisi yoksa: yeni sürüm olarak dağıtmayı unutmuş olabilirsin (bkz. Kodu güncellemek).

## Bilmen gerekenler (sınırlar)

- **Süre ve kayıt Google tarafında denetlenir.** Öğrencinin telefonundaki sayaç ve saat değiştirilebilir. Bu yüzden "zamanında / süre dışı" kararını sonucun Google'a **ulaştığı an** verir. İnterneti olmayan bir öğrenci testi süre içinde bitirip sonucu süre bittikten sonra gönderirse "süre dışı" görünür; `istemci_sure_ms` ve `sunucu_zamani` sütunlarına bakıp sen karar verirsin.
- 6 saniyelik soru sayacı öğrencinin cihazında çalışır. Duraklat düğmesi ve teknik bilgisi olan biri bu sayacı atlatabilir. Sorular ve cevap anahtarı da sayfanın içindedir. Bu bir alıştırma aracıdır, sınav güvenliği sağlamaz.
- Puanı öğrencinin tarayıcısı hesaplar. Adresi bilen teknik biri sahte sonuç gönderebilir. Bilinmeyen kodlu gönderimler reddedilir ve kaydedilmez; bu yüzden kodu tahmin edilmesi zor seç.
- Öğrenci adını ve numarasını kendisi yazar, doğrulanmaz. Aynı cihazda son yazılan bilgi hatırlanır ve istenirse değiştirilebilir.
