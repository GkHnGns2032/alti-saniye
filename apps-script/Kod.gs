/**
 * Altı Saniye — ödev modu sunucusu (Google Apps Script).
 *
 * Öğretmenin kendi e-tablosuna bağlı (Uzantılar > Apps Script) ve "Web uygulaması" olarak
 * dağıtılır. Kurulum: apps-script/KURULUM.md
 *
 * E-tablo sekmeleri (ilk satır başlık):
 *   Ödevler   kod · test_slug · baslangic · bitis · sinif · not
 *   Sonuçlar  sunucu_zamani · kod · test_slug · numara · ad_soyad · dogru · yanlis · bos · puan ·
 *             durum · deneme_no · cevaplar · istemci_sure_ms · gonderim_id
 *
 * GET  ?odev=KOD  → {gecerli, test_slug, baslangic, bitis, acik, simdi}
 *                   (bilinmeyen kod: {gecerli:false}; parametresiz: sağlık yanıtı)
 * POST (gövde text/plain, içerik JSON) → Sonuçlar'a bir satır yazar.
 *   - Süre SUNUCU saatiyle denetlenir: pencere içi "zamanında", dışı "süre dışı" (yine kaydedilir).
 *   - Bilinmeyen kod reddedilir, kaydedilmez.
 *   - Aynı kod + numara ile yeni gönderim engellenmez, deneme_no artar.
 *   - Aynı gonderim_id ikinci kez gelirse (ağ kopup tarayıcı yeniden denediyse) yeni satır
 *     açılmaz, ilk kaydın bilgisi döner.
 *   Yanıt: {ok:true, durum, deneme_no, sunucu_zamani}  ya da  {ok:false, hata, kalici?}
 *   kalici:true → tarayıcı bu gönderimi kuyruktan siler (yeniden denemenin anlamı yok).
 *
 * Sıralama: her ödev kodunun sonuçları en iyiden en kötüye dizilip "Sıralama <KOD>" sekmesine
 * yazılır; sekmenin en üst hücresinde WhatsApp'a yapıştırılacak metin durur (telefondan
 * kopyalanabilir). kurulum() bunu 5 dakikada bir kendiliğinden yenileyen zamanlayıcıyı kurar;
 * bilgisayarda "Altı Saniye > Sıralama oluştur" menüsü anında yeniler (aşağıda).
 *
 * Öğretmen paneli (sitede index.html?panel): aynı POST ucuna {islem, anahtar, ...} gövdesiyle gelir.
 *   islem: "odevler" (liste + katılan sayısı + öğretmenin kendi testleri) · "odev_ekle" (kod üretir,
 *   Ödevler'e satır yazar) · "siralama" (WhatsApp metni) · "test_ekle" (ChatGPT'den gelen ya da
 *   öğretmenin kontrol edip onayladığı hazır testi "Testler" sekmesine kaydeder; adı "ozel-" ile başlar)
 *   · "test_getir" (kayıtlı testi düzenlemek için geri verir). Ödev bu testlerden biriyse doGet
 *   yanıtına testin kendisi de eklenir (sayfada gömülü değildir). anahtar, kurulum() ile üretilip Betik Özellikleri'nde saklanır;
 *   depoda yoktur. Yanlış/eksik anahtar → {ok:false, hata:"yetkisiz"}.
 *
 * Neden text/plain? Tarayıcı, application/json gövdeli çapraz kaynaklı bir POST için önce
 * OPTIONS (CORS ön-kontrolü) yollar; Apps Script OPTIONS'a yanıt veremez ve istek düşer.
 * text/plain "basit istek" sayılır, ön-kontrol olmaz. Apps Script yanıtı 302 ile
 * script.googleusercontent.com'a yönlendirir; oradaki yanıt Access-Control-Allow-Origin: *
 * taşıdığı için sayfa JSON'u okuyabilir.
 */

const ODEVLER = 'Ödevler';
const SONUCLAR = 'Sonuçlar';
const ODEV_BASLIK = ['kod', 'test_slug', 'baslangic', 'bitis', 'sinif', 'not'];
const SONUC_BASLIK = ['sunucu_zamani', 'kod', 'test_slug', 'numara', 'ad_soyad', 'dogru', 'yanlis', 'bos',
  'puan', 'durum', 'deneme_no', 'cevaplar', 'istemci_sure_ms', 'gonderim_id'];
const ZAMANINDA = 'zamanında';
const SURE_DISI = 'süre dışı';
const GUN_MS = 24 * 60 * 60 * 1000;
// Öğretmen panelinin linki bu adresle kurulur (kurulum() günlüğe yazar). Site taşınırsa burayı değiştir.
const SITE = 'https://gkhngns2032.github.io/alti-saniye/';
const ANAHTAR_OZELLIGI = 'OGRETMEN_ANAHTARI';
const TESTLER = 'Testler';
const TEST_BASLIK = ['test_slug', 'ad', 'soru_sayisi', 'olusturma', 'icerik'];

/* ---------- Web uygulaması giriş noktaları ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!('odev' in p)) return json_({ok: true, servis: 'alti-saniye', surum: 1});
  try {
    const odev = odevBul_(normKod_(p.odev));
    if (!odev) return json_({gecerli: false});
    if (odev.hata) return json_({gecerli: false, hata: odev.hata});
    const simdi = new Date();
    const yanit = {
      gecerli: true,
      test_slug: odev.test_slug,
      baslangic: iso_(odev.baslangic),
      bitis: iso_(odev.bitis),
      acik: pencereIcinde_(odev, simdi),
      simdi: simdi.toISOString()
    };
    const ozel = odev.test_slug.indexOf('ozel-') === 0 ? ozelTest_(odev.test_slug) : null;
    if (ozel) yanit.test = ozel;
    return json_(yanit);
  } catch (err) {
    console.error(err);
    return json_({gecerli: false, hata: 'sunucu_hatasi'});
  }
}

function doPost(e) {
  const simdi = new Date(); // istek geldiği an; kilit beklemesi öğrencinin aleyhine işlemesin
  try {
    let govde;
    try {
      govde = JSON.parse((e && e.postData && e.postData.contents) || '');
    } catch (err) {
      return json_({ok: false, hata: 'gecersiz', kalici: true});
    }
    if (govde && typeof govde === 'object' && 'islem' in govde) return json_(panelIslem_(govde, simdi));
    const g = gonderimDenetle_(govde);
    if (g.hata) return json_({ok: false, hata: g.hata, kalici: true});

    const odev = odevBul_(g.kod);
    if (!odev) return json_({ok: false, hata: 'bilinmeyen_kod', kalici: true});
    if (odev.test_slug !== g.test_slug) return json_({ok: false, hata: 'test_uyusmuyor', kalici: true});

    const kilit = LockService.getScriptLock();
    if (!kilit.tryLock(25000)) return json_({ok: false, hata: 'mesgul'});
    try {
      return json_(sonucYaz_(odev, g, simdi));
    } finally {
      kilit.releaseLock();
    }
  } catch (err) {
    console.error(err);
    return json_({ok: false, hata: 'sunucu_hatasi'});
  }
}

/**
 * Apps Script düzenleyicisinde "Çalıştır" (kod her güncellendiğinde bir kez):
 * iki sekmeyi başlıklarıyla açar ve sıralamaları 5 dakikada bir yenileyen zamanlayıcıyı kurar.
 * Birden çok kez çalıştırmak güvenlidir: eski zamanlayıcı silinip yenisi kurulur.
 */
function kurulum() {
  sayfa_(ODEVLER, ODEV_BASLIK);
  sayfa_(SONUCLAR, SONUC_BASLIK);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'siralamalariGuncelle') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('siralamalariGuncelle').timeBased().everyMinutes(5).create();
  const n = siralamalariGuncelle();
  const ozellik = PropertiesService.getScriptProperties();
  if (!ozellik.getProperty(ANAHTAR_OZELLIGI)) ozellik.setProperty(ANAHTAR_OZELLIGI, yeniAnahtar_());
  console.log('Sekmeler hazır, sıralama zamanlayıcısı kuruldu (5 dk), ' + n + ' sıralama yenilendi. ' +
    'E-tablo saat dilimi: ' + tablo_().getSpreadsheetTimeZone());
  ogretmenLinki();
}

/** Öğretmen panelinin gizli linkini günlüğe yazar (Çalıştır → Yürütme günlüğü). */
function ogretmenLinki() {
  const k = PropertiesService.getScriptProperties().getProperty(ANAHTAR_OZELLIGI);
  console.log(k ? 'ÖĞRETMEN PANELİ (yalnız öğretmenle paylaş): ' + SITE + 'index.html?panel#' + k
    : 'Anahtar yok: önce kurulum\'u çalıştır.');
  return k ? SITE + 'index.html?panel#' + k : '';
}

/** Link başkasının eline geçerse: yeni anahtar üretir, eski link çalışmaz olur. */
function anahtariYenile() {
  PropertiesService.getScriptProperties().setProperty(ANAHTAR_OZELLIGI, yeniAnahtar_());
  return ogretmenLinki();
}

function yeniAnahtar_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/* ---------- Öğretmen paneli ---------- */

function panelIslem_(b, simdi) {
  if (!anahtarDogru_(b.anahtar)) return {ok: false, hata: 'yetkisiz', kalici: true};
  if (b.islem === 'odevler') return {ok: true, odevler: odevListesi_(), testler: testListesi_()};
  if (b.islem === 'test_getir') {
    const t = typeof b.slug === 'string' && b.slug.indexOf('ozel-') === 0 ? ozelTest_(b.slug) : null;
    return t ? {ok: true, test: t} : {ok: false, hata: 'yok', kalici: true};
  }
  if (b.islem === 'siralama') {
    const s = siralamaHazirla_(b.kod);
    return {ok: true, kod: s.kod, katilan: s.satirlar.length, metin: s.satirlar.length ? s.metin : '',
      satirlar: s.satirlar.map(function (o) { return {ad: o.ad, puan: o.puan, dogru: o.dogru, yanlis: o.yanlis, bos: o.bos, durum: o.durum}; })};
  }
  if (b.islem === 'odev_ekle' || b.islem === 'test_ekle') {
    const kilit = LockService.getScriptLock();
    if (!kilit.tryLock(25000)) return {ok: false, hata: 'mesgul'};
    try {
      return b.islem === 'odev_ekle' ? odevEkle_(b, simdi) : testEkle_(b, simdi);
    } finally {
      kilit.releaseLock();
    }
  }
  return {ok: false, hata: 'gecersiz', kalici: true};
}

/* ---------- Öğretmenin kendi testleri ----------
   İki kaynaktan gelir: ChatGPT'den panele yapıştırılan test ya da öğretmenin panelde kontrol edip
   onayladığı hazır test. İkincisinde "kaynak" hazır testin slug'ıdır; panel o hazır testin yerine
   en son onaylanan sürümü gösterir. Hazır testin kendisi (sitedeki) değişmez. */

const KAYNAK_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** Panelden gelen testi denetler: 5-40 soru, her soruda 4 farklı şık, 0-3 doğru cevap.
 *  {hata} ya da {ad, sorular, kaynak}. */
function testDenetle_(b) {
  const metin = (v, ust) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= ust;
  if (!metin(b.ad, 60)) return {hata: 'ad'};
  const kaynak = b.kaynak == null || b.kaynak === '' ? '' : b.kaynak;
  if (kaynak && (typeof kaynak !== 'string' || !KAYNAK_RE.test(kaynak) || kaynak.indexOf('ozel-') === 0)) return {hata: 'kaynak'};
  if (!Array.isArray(b.sorular) || b.sorular.length < 5 || b.sorular.length > 40) return {hata: 'soru_sayisi'};
  const sorular = [];
  for (let i = 0; i < b.sorular.length; i++) {
    const q = b.sorular[i] || {};
    if (!metin(q.q, 300) || !Array.isArray(q.o) || q.o.length !== 4 || !q.o.every(x => metin(x, 100))) return {hata: 'soru', no: i + 1};
    const o = q.o.map(x => x.trim());
    if (new Set(o.map(x => x.toLowerCase())).size !== 4) return {hata: 'soru', no: i + 1};
    if (typeof q.a !== 'number' || !Number.isInteger(q.a) || q.a < 0 || q.a > 3) return {hata: 'soru', no: i + 1};
    const soru = {q: q.q.trim(), o: o, a: q.a, tr: typeof q.tr === 'string' ? q.tr.trim().slice(0, 300) : ''};
    if (typeof q.c === 'string' && q.c.trim()) soru.c = q.c.trim().slice(0, 60);
    sorular.push(soru);
  }
  return {ad: b.ad.replace(/\s+/g, ' ').trim(), sorular: sorular, kaynak: kaynak};
}

function testEkle_(b, simdi) {
  const t = testDenetle_(b);
  if (t.hata) return {ok: false, hata: t.hata, no: t.no, kalici: true};
  const icerik = JSON.stringify(t.kaynak ? {ad: t.ad, kaynak: t.kaynak, sorular: t.sorular} : {ad: t.ad, sorular: t.sorular});
  if (icerik.length > 45000) return {ok: false, hata: 'cok_uzun', kalici: true};
  const sh = sayfa_(TESTLER, TEST_BASLIK);
  const var_ = {};
  sh.getDataRange().getValues().slice(1).forEach(function (r) { var_[String(r[0])] = true; });
  let slug;
  do { slug = 'ozel-' + slugla_(t.ad) + '-' + kodUret_().slice(0, 4).toLowerCase(); } while (var_[slug]);
  sh.getRange(sh.getLastRow() + 1, 1, 1, TEST_BASLIK.length).setValues([[slug, metin_(t.ad), t.sorular.length, simdi, icerik]]);
  SpreadsheetApp.flush();
  return {ok: true, test_slug: slug, ad: t.ad, n: t.sorular.length, kaynak: t.kaynak};
}

/** Kayıtlı test: {ad, sorular, kaynak} ya da null. */
function ozelTest_(slug) {
  const satirlar = sayfa_(TESTLER, TEST_BASLIK).getDataRange().getValues();
  for (let i = 1; i < satirlar.length; i++) {
    if (String(satirlar[i][0]) !== slug) continue;
    try {
      const t = JSON.parse(String(satirlar[i][4]));
      return t && Array.isArray(t.sorular) ?
        {ad: String(t.ad || satirlar[i][1]), sorular: t.sorular, kaynak: typeof t.kaynak === 'string' ? t.kaynak : ''} : null;
    } catch (err) {
      return null;
    }
  }
  return null;
}

/** Öğretmenin testleri, en yeni üstte: [{slug, ad, n, kaynak}]. Aynı hazır testin
 *  onaylanmış sürümlerinden yalnız en yenisi listelenir (eski ödevler eski sürümle çalışmaya devam eder). */
function testListesi_() {
  const gorulen = {};
  return sayfa_(TESTLER, TEST_BASLIK).getDataRange().getValues().slice(1).reverse()
    .filter(function (r) { return String(r[0]).indexOf('ozel-') === 0; })
    .map(function (r) {
      let kaynak = '';
      try { kaynak = String(JSON.parse(String(r[4])).kaynak || ''); } catch (err) { /* bozuk içerik: kaynaksız say */ }
      return {slug: String(r[0]), ad: String(r[1]).replace(/^'/, ''), n: Number(r[2]) || 0, kaynak: kaynak};
    })
    .filter(function (t) {
      if (!t.kaynak) return true;
      if (gorulen[t.kaynak]) return false;
      return (gorulen[t.kaynak] = true);
    });
}

/** "Unit 6: Adventures!" → "unit-6-adventures" (Türkçe harfler sadeleşir). */
function slugla_(ad) {
  const tr = {'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u'};
  const s = String(ad).replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase()
    .replace(/[çğıöşüâîû]/g, function (h) { return tr[h]; })
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  return s || 'test';
}

function anahtarDogru_(k) {
  const dogru = PropertiesService.getScriptProperties().getProperty(ANAHTAR_OZELLIGI);
  return typeof k === 'string' && !!dogru && k.length === dogru.length && k === dogru;
}

/** Ödevler sekmesi, en yeni üstte (en çok 50), her biri için sıralamaya giren öğrenci sayısıyla. */
function odevListesi_() {
  const satirlar = sayfa_(ODEVLER, ODEV_BASLIK).getDataRange().getValues().slice(1);
  const sh = sayfa_(SONUCLAR, SONUC_BASLIK);
  const son = sh.getLastRow();
  const kisiler = {};
  if (son >= 2) {
    sh.getRange(2, 1, son - 1, 5).getValues().forEach(function (r) {
      const k = normKod_(r[1]);
      (kisiler[k] = kisiler[k] || {})[String(r[3]).trim() + '|' + kisiAdi_(String(r[4]).replace(/^'/, ''))] = true;
    });
  }
  const liste = [];
  for (let i = satirlar.length - 1; i >= 0 && liste.length < 50; i--) {
    const s = satirlar[i];
    const kod = normKod_(s[0]);
    if (!kod) continue;
    let bas = null, bit = null;
    try { bas = zaman_(s[2], false); bit = zaman_(s[3], true); } catch (err) { /* tarihi bozuk satır: tarihsiz göster */ }
    liste.push({kod: String(s[0]).trim(), test_slug: String(s[1]).trim(), baslangic: iso_(bas), bitis: iso_(bit),
      sinif: String(s[4]).trim(), katilan: Object.keys(kisiler[kod] || {}).length});
  }
  return liste;
}

/** Panelden yeni ödev: benzersiz kod üretir, Ödevler'e satır ekler. bitis: "YYYY-MM-DD HH:mm" (e-tablo saat dilimi). */
function odevEkle_(b, simdi) {
  if (typeof b.test_slug !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.test_slug) || b.test_slug.length > 60) {
    return {ok: false, hata: 'gecersiz', kalici: true};
  }
  if (typeof b.bitis !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(b.bitis)) return {ok: false, hata: 'gecersiz', kalici: true};
  let bitis;
  try { bitis = zaman_(b.bitis, true); } catch (err) { return {ok: false, hata: 'gecersiz', kalici: true}; }
  if (bitis.getTime() <= simdi.getTime()) return {ok: false, hata: 'gecmis_tarih', kalici: true};
  const sinif = typeof b.sinif === 'string' ? b.sinif.replace(/\s+/g, ' ').trim().slice(0, 20) : '';
  const sh = sayfa_(ODEVLER, ODEV_BASLIK);
  const var_ = {};
  sh.getDataRange().getValues().slice(1).forEach(function (r) { var_[normKod_(r[0])] = true; });
  let kod;
  do { kod = kodUret_(); } while (var_[kod]);
  const r = sh.getLastRow() + 1;
  sh.getRange(r, 1).setNumberFormat('@');
  sh.getRange(r, 1, 1, ODEV_BASLIK.length).setValues([[kod, b.test_slug, '', bitis, metin_(sinif), 'öğretmen paneli']]);
  SpreadsheetApp.flush();
  return {ok: true, kod: kod, test_slug: b.test_slug, bitis: iso_(bitis), sinif: sinif};
}

function kodUret_() {
  const harfler = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // karışan harf/rakam yok (0/O, 1/I)
  let k = '';
  for (let i = 0; i < 6; i++) k += harfler.charAt(Math.floor(Math.random() * harfler.length));
  return k;
}

/* ---------- Sıralama ----------
 * Bir ödev kodunun sonuçlarını en iyiden en kötüye dizer ve "Sıralama <KOD>" sekmesine yazar:
 *   1. satır  WhatsApp'a yapıştırılacak metin (telefonda hücreye dokun → Kopyala)
 *   2. satır  açıklama + güncellenme zamanı
 *   3. satır  başlıklar, 4. satırdan sonrası tablo
 * Kendiliğinden: siralamalariGuncelle() 5 dakikada bir (kurulum() kurar), son 7 günde sonucu
 * gelen her ödev için. Anında: bilgisayarda "Altı Saniye > Sıralama oluştur" menüsü
 * (özel menüler telefondaki E-Tablolar uygulamasında görünmez). Kurallar (öğretmenin kararı):
 *   - Her öğrencinin İLK denemesi (tablodaki en eski satırı) sayılır; sonrakiler cevaplar görüldükten
 *     sonradır. Öğrenci = numara + ad soyad (büyük/küçük harf ve boşluk farkı yok sayılır): iki
 *     öğrenci aynı numarayı yazsa da ayrı sıralanır.
 *   - Sıra: puan (yüksekten düşüğe), eşitlikte daha kısa sürede bitiren öne.
 *   - Tam ad soyad yazılır. "süre dışı" sonuçlar listede kalır, yanlarında işaret olur.
 * Web uygulamasına (doGet/doPost) dokunmaz: bu bölüm için yeniden dağıtım gerekmez.
 */

const SIRALAMA = 'Sıralama';
const YENI_GUN = 7; // zamanlayıcı yalnız son 7 günde sonucu gelen ödevleri yeniler
const SIRALAMA_BASLIK = ['sira', 'ad_soyad', 'numara', 'puan', 'dogru', 'yanlis', 'bos', 'sure', 'durum'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Altı Saniye').addItem('Sıralama oluştur', 'siralamaMenusu').addToUi();
}

function siralamaMenusu() {
  const ui = SpreadsheetApp.getUi();
  const cevap = ui.prompt('Sıralama', 'Hangi ödevin sıralaması? Ödev kodunu yaz (ör. AMPBGG):', ui.ButtonSet.OK_CANCEL);
  if (cevap.getSelectedButton() !== ui.Button.OK) return;
  const s = siralamaHazirla_(cevap.getResponseText());
  if (!s.satirlar.length) {
    ui.alert('Sıralama', '"' + s.kod + '" kodlu ödev için henüz sonuç yok.', ui.ButtonSet.OK);
    return;
  }
  const html = HtmlService.createHtmlOutput(
    '<div style="font:14px sans-serif">' +
    '<p style="margin:0 0 8px">"' + html_(s.sekme) + '" sekmesi güncellendi. Aşağıdaki metni WhatsApp\'a yapıştır:</p>' +
    '<textarea id="t" readonly style="width:100%;height:300px;font:14px sans-serif;box-sizing:border-box">' +
    html_(s.metin) + '</textarea>' +
    '<button style="margin-top:8px;padding:8px 16px;font:bold 14px sans-serif" ' +
    'onclick="var t=document.getElementById(\'t\');t.select();document.execCommand(\'copy\');this.textContent=\'Kopyalandı ✓\'">Kopyala</button>' +
    '</div>').setWidth(480).setHeight(420);
  ui.showModalDialog(html, 'WhatsApp sıralama metni');
}

/** Zamanlayıcı: son YENI_GUN günde sonucu gelen her ödevin sıralamasını yeniler. Yenilenen sayısını döndürür. */
function siralamalariGuncelle() {
  const sh = sayfa_(SONUCLAR, SONUC_BASLIK);
  const son = sh.getLastRow();
  if (son < 2) return 0;
  const sinir = Date.now() - YENI_GUN * GUN_MS;
  const kodlar = {};
  sh.getRange(2, 1, son - 1, 2).getValues().forEach(function (r) {
    const t = Object.prototype.toString.call(r[0]) === '[object Date]' ? r[0].getTime() : NaN;
    const k = normKod_(r[1]);
    if (k && !(t < sinir)) kodlar[k] = true; // tarihi okunamayan satır da yenilensin
  });
  let n = 0;
  Object.keys(kodlar).forEach(function (k) {
    try {
      siralamaHazirla_(k);
      n++;
    } catch (err) {
      console.error('sıralama yenilenemedi: ' + k + ' · ' + err);
    }
  });
  return n;
}

/** Sıralamayı hesaplar ve "Sıralama <KOD>" sekmesine yazar. {kod, sekme, satirlar, metin} döndürür. */
/** "90 puan · 18 doğru, 2 yanlış" (+ ", 1 boş" varsa, + " (süre dışı)"). Panel de aynı biçimi kullanır. */
function siraOzeti_(o) {
  return String(o.puan).replace('.', ',') + ' puan · ' + o.dogru + ' doğru, ' + o.yanlis + ' yanlış' +
    (o.bos ? ', ' + o.bos + ' boş' : '') + (o.durum === SURE_DISI ? ' (süre dışı)' : '');
}

function siralamaHazirla_(kodGirdisi) {
  const kod = normKod_(kodGirdisi);
  const sh = sayfa_(SONUCLAR, SONUC_BASLIK);
  const son = sh.getLastRow();
  const veriler = son >= 2 ? sh.getRange(2, 1, son - 1, SONUC_BASLIK.length).getValues() : [];
  const ilk = {}; // numara|ad → ilk deneme (en eski satır)
  veriler.forEach(function (r, i) {
    if (!kod || normKod_(r[1]) !== kod) return;
    const numara = String(r[3]).trim();
    const o = {sira_no: i, test_slug: String(r[2]), numara: numara, ad: String(r[4]).replace(/^'/, '').trim(),
      dogru: Number(r[5]) || 0, yanlis: Number(r[6]) || 0, bos: Number(r[7]) || 0, puan: Number(r[8]) || 0,
      durum: String(r[9]), sure: r[12] === '' || r[12] == null ? Infinity : Number(r[12])};
    const anahtar = numara + '|' + kisiAdi_(o.ad);
    if (!ilk[anahtar]) ilk[anahtar] = o; // satırlar gönderim sırasıyla eklenir: ilk görülen ilk denemedir
  });
  const satirlar = Object.keys(ilk).map(function (k) { return ilk[k]; }).sort(function (a, b) {
    return b.puan - a.puan || a.sure - b.sure || a.sira_no - b.sira_no;
  });

  const odev = odevBul_(kod);
  const test = satirlar.length ? satirlar[0].test_slug : (odev ? odev.test_slug : '');
  const sinif = odev ? odevSinifi_(kod) : '';
  const tz = tablo_().getSpreadsheetTimeZone();

  const madalya = ['🥇', '🥈', '🥉'];
  const metin = ['🏆 Ödev sıralaması · ' + test + (sinif ? ' · ' + sinif : ''), '(ilk denemeler, 100 üzerinden)', '']
    .concat(satirlar.map(function (o, i) {
      return (madalya[i] || (i + 1) + '.') + ' ' + o.ad + ' — ' + siraOzeti_(o);
    }))
    .concat(['', satirlar.length + ' öğrenci katıldı.'])
    .join('\n');
  if (!kod || !satirlar.length) return {kod: kod, sekme: '', satirlar: satirlar, metin: metin};

  const sekme = SIRALAMA + ' ' + kod;
  const bilgi = '↑ Üstteki metni WhatsApp\'a yapıştır: telefonda hücreye dokun → Kopyala. ' + kod + ' · ' + test +
    (sinif ? ' · ' + sinif : '') + ' · güncellendi: ' + Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy HH:mm') +
    ' (5 dakikada bir kendiliğinden yenilenir)';
  const tablo = [SIRALAMA_BASLIK];
  satirlar.forEach(function (o, i) {
    tablo.push([i + 1, metin_(o.ad), o.numara, o.puan, o.dogru, o.yanlis, o.bos, sure_(o.sure), o.durum]);
  });
  const genislik = SIRALAMA_BASLIK.length;
  let hedef = tablo_().getSheetByName(sekme);
  if (!hedef) hedef = tablo_().insertSheet(sekme);
  hedef.clear();
  hedef.getRange(1, 1).setValue(metin);
  hedef.getRange(2, 1).setValue(bilgi);
  hedef.getRange(3, 1, tablo.length, genislik).setValues(tablo);
  hedef.getRange(1, 1, 1, genislik).merge().setWrap(true).setVerticalAlignment('top');
  hedef.getRange(2, 1, 1, genislik).merge().setWrap(true);
  hedef.setRowHeight(1, 21 * metin.split('\n').length + 8);
  hedef.setFrozenRows(0);
  return {kod: kod, sekme: sekme, satirlar: satirlar, metin: metin};
}

/** Ad karşılaştırması için: Türkçe küçük harf, tek boşluk. "AYŞE  Yılmaz" = "ayşe yılmaz". */
function kisiAdi_(ad) {
  return String(ad).replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase().replace(/\s+/g, ' ').trim();
}

function odevSinifi_(kod) {
  const satirlar = sayfa_(ODEVLER, ODEV_BASLIK).getDataRange().getValues();
  for (let i = 1; i < satirlar.length; i++) {
    if (normKod_(satirlar[i][0]) === kod) return String(satirlar[i][4]).trim();
  }
  return '';
}

function sure_(ms) {
  if (!isFinite(ms)) return '';
  const sn = Math.round(ms / 1000);
  return Math.floor(sn / 60) + ':' + ('0' + (sn % 60)).slice(-2);
}

function html_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- Kayıt ---------- */

function sonucYaz_(odev, g, simdi) {
  const sh = sayfa_(SONUCLAR, SONUC_BASLIK);
  const son = sh.getLastRow();
  let deneme = 0;
  if (son >= 2) {
    const satirlar = sh.getRange(2, 1, son - 1, SONUC_BASLIK.length).getValues();
    for (let i = 0; i < satirlar.length; i++) {
      const s = satirlar[i];
      if (String(s[13]) === g.gonderim_id) {
        return {ok: true, durum: String(s[9]), deneme_no: Number(s[10]), tekrar: true};
      }
      if (normKod_(s[1]) === odev.anahtar && String(s[3]).trim() === g.numara) deneme++;
    }
  }
  const durum = pencereIcinde_(odev, simdi) ? ZAMANINDA : SURE_DISI;
  const satir = [simdi, odev.kod, odev.test_slug, g.numara, metin_(g.ad_soyad), g.dogru, g.yanlis, g.bos,
    g.puan, durum, deneme + 1, metin_(g.cevaplar), g.istemci_sure_ms, g.gonderim_id];
  const r = son + 1;
  sh.getRange(r, 4).setNumberFormat('@'); // numara metin kalsın (baştaki sıfırlar silinmesin)
  sh.getRange(r, 1, 1, satir.length).setValues([satir]);
  SpreadsheetApp.flush();
  return {ok: true, durum: durum, deneme_no: deneme + 1, sunucu_zamani: simdi.toISOString()};
}

/** Tarayıcıdan gelen gövdeyi denetler; {hata} ya da temizlenmiş alanları döndürür. */
function gonderimDenetle_(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return {hata: 'gecersiz'};
  const tam = (v, ust) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= ust;
  const kod = normKod_(b.kod);
  const numara = String(b.numara == null ? '' : b.numara).trim();
  const ad = typeof b.ad_soyad === 'string' ? b.ad_soyad.replace(/\s+/g, ' ').trim() : '';
  if (!kod || kod.length > 40) return {hata: 'gecersiz'};
  if (typeof b.test_slug !== 'string' || !/^[a-z0-9-]{1,60}$/.test(b.test_slug)) return {hata: 'gecersiz'};
  if (!/^\d{1,12}$/.test(numara)) return {hata: 'gecersiz'};
  if (ad.length < 2 || ad.length > 80) return {hata: 'gecersiz'};
  if (!tam(b.dogru, 1000) || !tam(b.yanlis, 1000) || !tam(b.bos, 1000)) return {hata: 'gecersiz'};
  if (typeof b.puan !== 'number' || !isFinite(b.puan)) return {hata: 'gecersiz'};
  if (typeof b.cevaplar !== 'string' || b.cevaplar.length > 4000) return {hata: 'gecersiz'};
  if (b.istemci_sure_ms != null && !tam(b.istemci_sure_ms, 864e5)) return {hata: 'gecersiz'};
  if (typeof b.gonderim_id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(b.gonderim_id)) return {hata: 'gecersiz'};
  return {
    kod: kod, test_slug: b.test_slug, numara: numara, ad_soyad: ad,
    dogru: b.dogru, yanlis: b.yanlis, bos: b.bos, puan: b.puan, cevaplar: b.cevaplar,
    istemci_sure_ms: b.istemci_sure_ms == null ? '' : b.istemci_sure_ms, gonderim_id: b.gonderim_id
  };
}

/* ---------- Ödevler ---------- */

function odevBul_(anahtar) {
  if (!anahtar) return null;
  const sh = sayfa_(ODEVLER, ODEV_BASLIK);
  const satirlar = sh.getDataRange().getValues();
  for (let i = 1; i < satirlar.length; i++) {
    const s = satirlar[i];
    if (normKod_(s[0]) !== anahtar) continue;
    const odev = {anahtar: anahtar, kod: String(s[0]).trim(), test_slug: String(s[1]).trim()};
    try {
      odev.baslangic = zaman_(s[2], false);
      odev.bitis = zaman_(s[3], true);
    } catch (err) {
      odev.hata = 'tarih'; // tarih hücresi okunamadı: öğretmen düzeltmeli; pencere kapalı sayılır
      odev.baslangic = odev.bitis = null;
    }
    return odev;
  }
  return null;
}

function pencereIcinde_(odev, simdi) {
  if (odev.hata) return false;
  const t = simdi.getTime();
  return (!odev.baslangic || t >= odev.baslangic.getTime()) && (!odev.bitis || t <= odev.bitis.getTime());
}

/**
 * Hücredeki zamanı Date'e çevirir. Boş → null (sınır yok).
 * Tarih hücresi (Sheets Date nesnesi) ya da "30.09.2026 14:00", "30.09.2026", "2026-09-30 14:00" metni.
 * Metin e-tablonun saat diliminde okunur. Bitiş saati 00:00 ise o günün SONU (23:59:59) sayılır:
 * "30.09.2026" yazan öğretmen 30 Eylül'ün sonuna kadar süre vermek ister.
 */
function zaman_(v, bitisMi) {
  if (v === '' || v == null) return null;
  const tz = tablo_().getSpreadsheetTimeZone();
  let d;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    d = v;
  } else {
    const m = String(v).trim();
    let y, a, g, sa = '00', dk = '00', x;
    if ((x = m.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T]+(\d{1,2})[:.](\d{2}))?$/))) {
      g = x[1]; a = x[2]; y = x[3]; if (x[4]) { sa = x[4]; dk = x[5]; }
    } else if ((x = m.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?$/))) {
      y = x[1]; a = x[2]; g = x[3]; if (x[4]) { sa = x[4]; dk = x[5]; }
    } else {
      throw new Error('tarih okunamadı: ' + m);
    }
    const iki = s => ('0' + s).slice(-2);
    d = Utilities.parseDate(y + '-' + iki(a) + '-' + iki(g) + ' ' + iki(sa) + ':' + dk + ':00', tz, 'yyyy-MM-dd HH:mm:ss');
  }
  if (isNaN(d.getTime())) throw new Error('tarih okunamadı');
  if (bitisMi && Utilities.formatDate(d, tz, 'HH:mm:ss') === '00:00:00') d = new Date(d.getTime() + GUN_MS - 1);
  return d;
}

/* ---------- Yardımcılar ---------- */

function tablo_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** Sekmeyi getirir; yoksa başlıklarıyla açar, başlık satırı eksikse tamamlar. */
function sayfa_(ad, baslik) {
  const ss = tablo_();
  let sh = ss.getSheetByName(ad);
  if (!sh) sh = ss.insertSheet(ad);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, baslik.length).setValues([baslik]);
    sh.setFrozenRows(1);
  } else if (String(sh.getRange(1, baslik.length).getValue()).trim() === '') {
    sh.getRange(1, baslik.length).setValue(baslik[baslik.length - 1]); // eski tabloda son sütun (gonderim_id)
  }
  return sh;
}

function normKod_(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

/** E-tabloya formül olarak yorumlanabilecek metni (=, +, -, @ ile başlayan) düz metne çevirir. */
function metin_(s) {
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function iso_(d) {
  return d ? d.toISOString() : null;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
