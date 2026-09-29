/**
 * Altı Saniye — ödev modu sunucusu (Google Apps Script).
 *
 * Öğretmenin kendi e-tablosuna bağlı (Uzantılar > Apps Script) ve "Web uygulaması" olarak
 * dağıtılır. Kurulum: apps-script/KURULUM.md
 *
 * E-tablo sekmeleri (ilk satır başlık):
 *   Ödevler   kod · test_slug · baslangic · bitis · sinif · not
 *   Sonuçlar  sunucu_zamani · kod · test_slug · numara · ad_soyad · dogru · yanlis · bos · puan ·
 *             durum · deneme_no · cevaplar · istemci_sure_ms · gonderim_id · sinif_sube
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
  'puan', 'durum', 'deneme_no', 'cevaplar', 'istemci_sure_ms', 'gonderim_id', 'sinif_sube',
  'sure_sunucu_ms', 'puan_kaynagi', 'isaretler', 'yazilan_ad'];
// sinif_sube ve sonraki dört sütun sonradan eklendi; eski tablolarda sayfa_() başlıkları en sağa kendisi yazar, eski satırlarda boş kalır.
const SUT = {sure_sunucu: 15, puan_kaynagi: 16, isaretler: 17, yazilan_ad: 18};
const ZAMANINDA = 'zamanında';
const SURE_DISI = 'süre dışı';
const GUN_MS = 24 * 60 * 60 * 1000;
// Öğretmen panelinin linki bu adresle kurulur (kurulum() günlüğe yazar). Site taşınırsa burayı değiştir.
const SITE = 'https://gkhngns2032.github.io/alti-saniye/';
const ANAHTAR_OZELLIGI = 'OGRETMEN_ANAHTARI';
const TESTLER = 'Testler';
const TEST_BASLIK = ['test_slug', 'ad', 'soru_sayisi', 'olusturma', 'icerik'];
// Sınıf listesi: öğretmen panele yapıştırır; ödevi yapmayanları görmek ve sonucu numarayla eşlemek için.
const OGRENCILER = 'Öğrenciler';
const OGRENCI_BASLIK = ['sinif_sube', 'numara', 'ad_soyad'];
// Sözlü notu kararları: yapılmayan ödev varsayılan 0, süre dışı varsayılan tam puan; öğretmen tek tek değiştirir.
// numara "*" → bütün ödev nota sayılmaz (haric). karar: ozurlu | sifir | tam | haric
const KARARLAR = 'Kararlar';
const KARAR_BASLIK = ['kod', 'numara', 'karar', 'zaman'];
const KARAR_TURLERI = ['ozurlu', 'sifir', 'tam', 'haric'];

/* ---------- Web uygulaması giriş noktaları ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!('odev' in p)) return json_({ok: true, servis: 'alti-saniye', surum: 1});
  try {
    if (hizDenetle_(normKod_(p.odev), p.numara)) return json_({gecerli: false, hata: 'yavas'});
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
    // öğrenci bilgisini yazınca sayfa sorar: bu ödevi daha önce çözmüş mü? (yalnız ilk deneme kaydedilir)
    if (p.numara && p.ad) {
      const kapi = listeKapisi_(odev.sinif, sinifSube_(p.sinif), String(p.numara).trim(), String(p.ad));
      yanit.liste = kapi.hata || kapi.durum;
      const no = kapi.durum === 'tamam' ? kapi.numara : String(p.numara).trim();
      yanit.onceki = !kapi.hata && oncekiVar_(odev.anahtar, no, kapi.durum === 'tamam' ? kapi.ad : String(p.ad));
    }
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
    if (govde && typeof govde === 'object' && hizDenetle_(normKod_(govde.kod), govde.numara)) return json_({ok: false, hata: 'yavas'});
    const g = gonderimDenetle_(govde);
    if (g.hata) return json_({ok: false, hata: g.hata, kalici: true});

    const odev = odevBul_(g.kod);
    if (!odev) return json_({ok: false, hata: 'bilinmeyen_kod', kalici: true});
    if (odev.test_slug !== g.test_slug) return json_({ok: false, hata: 'test_uyusmuyor', kalici: true});

    const ta = testAnahtari_(odev.test_slug);
    const ek = {isaretler: []};
    if (ta) {
      const secim = cevapCoz_(g.cevaplar, ta.anahtar.length);
      if (!secim) return json_({ok: false, hata: 'gecersiz', kalici: true});
      Object.assign(g, puanla_(secim, ta.anahtar, ta.puanlama));
      ek.puan_kaynagi = 'sunucu';
    } else {
      g.puan = Math.min(100, Math.max(0, g.puan));
      ek.puan_kaynagi = 'istemci';
    }

    const kapi = listeKapisi_(odev.sinif, g.sinif_sube, g.numara, g.ad_soyad);
    if (kapi.hata) return json_({ok: false, hata: kapi.hata, subeler: kapi.subeler, kalici: true});
    ek.yazilan_ad = g.ad_soyad;
    if (kapi.durum === 'tamam') { g.ad_soyad = kapi.ad; g.numara = kapi.numara; } else ek.isaretler.push('liste_yok');

    const kilit = LockService.getScriptLock();
    if (!kilit.tryLock(25000)) return json_({ok: false, hata: 'mesgul'});
    try {
      const sonuc = sonucYaz_(odev, g, simdi, ek);
      if (ta && sonuc.ok) Object.assign(sonuc, {dogru: g.dogru, yanlis: g.yanlis, bos: g.bos, puan: g.puan, anahtar: ta.anahtar, aciklamalar: ta.aciklamalar});
      return json_(sonuc);
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
  if (b.islem === 'odevler') return {ok: true, odevler: odevListesi_(), testler: testListesi_(), siniflar: sinifOzeti_()};
  if (b.islem === 'sonuclar') return odevSonuclari_(b.kod);
  if (b.islem === 'notlar') return notCizelgesi_(b.sinif_sube);
  if (b.islem === 'test_getir') {
    const t = typeof b.slug === 'string' && b.slug.indexOf('ozel-') === 0 ? ozelTest_(b.slug) : null;
    return t ? {ok: true, test: t} : {ok: false, hata: 'yok', kalici: true};
  }
  if (b.islem === 'siralama') {
    const s = siralamaHazirla_(b.kod);
    return {ok: true, kod: s.kod, katilan: s.satirlar.length, metin: s.satirlar.length ? s.metin : '',
      satirlar: s.satirlar.map(function (o) { return {ad: o.ad, sinif: o.sinif, puan: o.puan, dogru: o.dogru, yanlis: o.yanlis, bos: o.bos, durum: o.durum}; })};
  }
  if (b.islem === 'odev_ekle' || b.islem === 'test_ekle' || b.islem === 'liste_kaydet' || b.islem === 'karar' || b.islem === 'deneme_gecersiz') {
    const kilit = LockService.getScriptLock();
    if (!kilit.tryLock(25000)) return {ok: false, hata: 'mesgul'};
    try {
      return b.islem === 'odev_ekle' ? odevEkle_(b, simdi) : b.islem === 'test_ekle' ? testEkle_(b, simdi) :
        b.islem === 'karar' ? kararYaz_(b, simdi) : b.islem === 'deneme_gecersiz' ? denemeGecersiz_(b) : listeKaydet_(b);
    } finally {
      kilit.releaseLock();
    }
  }
  return {ok: false, hata: 'gecersiz', kalici: true};
}

/* ---------- Sınıf listesi ve ödev sonuçları (panel) ---------- */

/** Ödevin "sinif" alanı: "8-A, 8b" → "8-A, 8-B". Şube biçiminde değilse eski gibi serbest metin (en çok 60). */
function sinifMetni_(v) {
  const ham = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  const subeler = subeListesi_(ham);
  return subeler.length ? subeler.join(', ') : ham;
}

/** "8-A, 8-B" → ["8-A", "8-B"]; şube olmayan parçalar atlanır, tekrarlar tek. */
function subeListesi_(v) {
  const g = {};
  return String(v == null ? '' : v).split(/[,;]/).map(sinifSube_).filter(function (x) { return x && !g[x] && (g[x] = true); });
}

/** Sınıf listesi: [{sinif, numara, ad}] (boş satırlar atlanır). */
function ogrenciListesi_() {
  const sh = tablo_().getSheetByName(OGRENCILER);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, OGRENCI_BASLIK.length).getValues()
    .map(function (r) { return {sinif: sinifSube_(r[0]), numara: String(r[1]).trim(), ad: String(r[2]).replace(/^'/, '').trim()}; })
    .filter(function (o) { return o.sinif && o.numara; });
}

/** Türkçe harf, büyük/küçük ve boşluk duyarsız kelimeler: "Ayşe  YILMAZ" → ["ayse", "yilmaz"]. */
function adKelimeleri_(ad) {
  const tr = {'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u'};
  return kisiAdi_(ad).replace(/[çğıöşüâîû]/g, function (h) { return tr[h]; }).split(' ').filter(Boolean);
}

/** Yazılan her kelime listedeki adda geçmeli, en az 2 kelime (ikinci adını yazmayan reddedilmesin). */
function adUyar_(yazilan, listedeki) {
  const y = adKelimeleri_(yazilan).filter(function (k, i, a) { return a.indexOf(k) === i; }), l = adKelimeleri_(listedeki);
  return y.length >= 2 && y.every(function (k) { return l.indexOf(k) >= 0; });
}

const noNorm_ = n => String(n == null ? '' : n).trim().replace(/^0+(?=\d)/, '');

/** Sınıf listesi kapısı. Listesi olan şubede numara listede ve ad eşleşmeli; kayda listedeki ad girer.
 *  Liste hiç yoksa bugünkü davranış (serbest ad, "liste_yok"). Listeler varken şubesiz gönderim reddedilir. */
function listeKapisi_(odevSinif, sube, numara, ad) {
  const subeler = subeListesi_(odevSinif), liste = ogrenciListesi_();
  if (!liste.length && !sube) return {durum: 'liste_yok'};
  if (sube && subeler.length && subeler.indexOf(sube) < 0) return {hata: 'sube_disi', subeler: subeler};
  if (!liste.length) return {durum: 'liste_yok'};
  if (!sube) return {hata: 'sube_gerekli'};
  const sinif = liste.filter(function (o) { return o.sinif === sube; });
  if (!sinif.length) return {durum: 'liste_yok'};
  const kisi = sinif.filter(function (o) { return noNorm_(o.numara) === noNorm_(numara); })[0];
  if (!kisi) return {hata: 'listede_yok'};
  if (!adUyar_(ad, kisi.ad)) return {hata: 'ad_uyusmuyor'};
  return {durum: 'tamam', ad: kisi.ad, numara: kisi.numara};
}

/** Panelde şube seçimi için: [{sinif, n}], şube sırasıyla. */
function sinifOzeti_() {
  const say = {};
  ogrenciListesi_().forEach(function (o) { say[o.sinif] = (say[o.sinif] || 0) + 1; });
  return Object.keys(say).sort(subeSirala_).map(function (k) { return {sinif: k, n: say[k]}; });
}

function subeSirala_(a, b) {
  const x = a.split('-'), y = b.split('-');
  return (+x[0] - +y[0]) || x[1].localeCompare(y[1], 'tr');
}

/** Bir şubenin listesini yenisiyle değiştirir (diğer şubelere dokunmaz). */
function listeKaydet_(b) {
  const sinif = sinifSube_(b.sinif_sube);
  if (!sinif) return {ok: false, hata: 'sinif', kalici: true};
  if (!Array.isArray(b.ogrenciler) || b.ogrenciler.length > 80) return {ok: false, hata: 'liste', kalici: true};
  const gorulen = {}, yeni = [];
  for (let i = 0; i < b.ogrenciler.length; i++) {
    const o = b.ogrenciler[i] || {};
    const numara = String(o.numara == null ? '' : o.numara).trim();
    const ad = typeof o.ad === 'string' ? o.ad.replace(/\s+/g, ' ').trim() : '';
    if (!/^\d{1,12}$/.test(numara) || ad.length < 2 || ad.length > 80 || gorulen[numara]) return {ok: false, hata: 'ogrenci', no: i + 1, kalici: true};
    gorulen[numara] = true;
    yeni.push([sinif, numara, metin_(ad)]);
  }
  const sh = sayfa_(OGRENCILER, OGRENCI_BASLIK);
  const eski = sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, OGRENCI_BASLIK.length).getValues() : [];
  const kalan = eski.filter(function (r) { return String(r[1]).trim() && sinifSube_(r[0]) !== sinif; });
  const hepsi = kalan.concat(yeni).sort(function (x, y) {
    return subeSirala_(sinifSube_(x[0]), sinifSube_(y[0])) || (+x[1] - +y[1]);
  });
  if (eski.length) sh.getRange(2, 1, eski.length, OGRENCI_BASLIK.length).clearContent();
  if (hepsi.length) {
    sh.getRange(2, 2, hepsi.length, 1).setNumberFormat('@'); // numara metin kalsın
    sh.getRange(2, 1, hepsi.length, OGRENCI_BASLIK.length).setValues(hepsi);
  }
  SpreadsheetApp.flush();
  return {ok: true, sinif: sinif, n: yeni.length, siniflar: sinifOzeti_()};
}

/** Panelin "Sonuçlar" ekranı: ödevin bilgileri, ilk denemeler (cevaplarıyla) ve ilgili şubelerin listesi.
 *  Yalnız ilk deneme sonuca girer; sonrakiler yalnız sayılır (sonraki). */
function odevSonuclari_(kodGirdisi) {
  const kod = normKod_(kodGirdisi);
  const satirlar = sayfa_(ODEVLER, ODEV_BASLIK).getDataRange().getValues();
  let odev = null;
  for (let i = 1; i < satirlar.length && !odev; i++) {
    if (normKod_(satirlar[i][0]) === kod && kod) {
      let bit = null;
      try { bit = zaman_(satirlar[i][3], true); } catch (err) { /* tarihsiz */ }
      odev = {kod: String(satirlar[i][0]).trim(), test_slug: String(satirlar[i][1]).trim(), sinif: String(satirlar[i][4]).trim(), bitis: iso_(bit)};
    }
  }
  if (!odev) return {ok: false, hata: 'yok', kalici: true};
  const sh = sayfa_(SONUCLAR, SONUC_BASLIK);
  const son = sh.getLastRow();
  const veri = son >= 2 ? sh.getRange(2, 1, son - 1, SONUC_BASLIK.length).getValues() : [];
  const ilk = {}, sira = [], gecersizler = [];
  veri.forEach(function (r) {
    if (normKod_(r[1]) !== kod) return;
    const ad = String(r[4]).replace(/^'/, '').trim(), numara = String(r[3]).trim();
    if (gecersizMi_(r)) { gecersizler.push({numara: numara, ad: ad, puan: Number(r[8]) || 0, zaman: iso_(r[0] instanceof Date ? r[0] : null)}); return; }
    const anahtar = numara + '|' + kisiAdi_(ad);
    if (ilk[anahtar]) { ilk[anahtar].sonraki++; return; }
    ilk[anahtar] = {numara: numara, ad: ad, sinif: sinifSube_(r[14]), dogru: Number(r[5]) || 0, yanlis: Number(r[6]) || 0,
      bos: Number(r[7]) || 0, puan: Number(r[8]) || 0, durum: String(r[9]), cevaplar: String(r[11]).replace(/^'/, ''),
      sure: r[12] === '' || r[12] == null ? null : Number(r[12]), zaman: iso_(r[0] instanceof Date ? r[0] : null), sonraki: 0,
      puan_kaynagi: String(r[SUT.puan_kaynagi] || ''), isaretler: String(r[SUT.isaretler] || ''),
      sure_sunucu: r[SUT.sure_sunucu] === '' || r[SUT.sure_sunucu] == null ? null : Number(r[SUT.sure_sunucu])};
    sira.push(ilk[anahtar]);
  });
  const subeler = subeListesi_(odev.sinif);
  sira.forEach(function (o) { if (!subeler.length && o.sinif) subeler.push(o.sinif); }); // şubesiz ödev: çözenlerin şubeleri
  const tek = {};
  const ilgili = subeler.filter(function (x) { return !tek[x] && (tek[x] = true); });
  const liste = ogrenciListesi_().filter(function (o) { return ilgili.indexOf(o.sinif) >= 0; });
  const test = odev.test_slug.indexOf('ozel-') === 0 ? ozelTest_(odev.test_slug) : null;
  return {ok: true, odev: odev, sonuclar: sira, liste: liste, subeler: ilgili.sort(subeSirala_), gecersizler: gecersizler, test: test || undefined};
}

/* ---------- Geçersiz deneme (öğretmen) ----------
   Arkadaşının numarasıyla önce çözen olursa öğretmen o denemeyi geçersiz sayar: satır SİLİNMEZ,
   "isaretler" sütununa "gecersiz" yazılır; ilk-deneme kuralı onu yok sayar, öğrenci yeniden çözer.
   Geri alma yalnız o numarada yeni geçerli deneme yokken (yoksa iki "ilk deneme" olurdu). */
const GECERSIZ = 'gecersiz';
function gecersizMi_(r) { return String(r[SUT.isaretler] == null ? '' : r[SUT.isaretler]).split(',').indexOf(GECERSIZ) >= 0; }
function isaretDegistir_(metin, isaret, ekle) {
  const l = String(metin == null ? '' : metin).split(',').map(x => x.trim()).filter(x => x && x !== isaret);
  if (ekle) l.push(isaret);
  return l.join(',');
}
function denemeGecersiz_(b) {
  const kod = normKod_(b.kod), no = noNorm_(b.numara);
  if (!odevBul_(kod)) return {ok: false, hata: 'yok', kalici: true};
  if (!/^\d{1,12}$/.test(no)) return {ok: false, hata: 'gecersiz', kalici: true};
  const sh = sayfa_(SONUCLAR, SONUC_BASLIK), son = sh.getLastRow();
  const v = son >= 2 ? sh.getRange(2, 1, son - 1, SONUC_BASLIK.length).getValues() : [];
  const satir = [];
  v.forEach(function (r, i) { if (normKod_(r[1]) === kod && noNorm_(r[3]) === no) satir.push(i); });
  if (!satir.length) return {ok: false, hata: 'yok', kalici: true};
  const gecerli = satir.filter(i => !gecersizMi_(v[i]));
  if (b.geri && gecerli.length) return {ok: false, hata: 'yeni_deneme_var', kalici: true};
  const hedef = b.geri ? satir : gecerli;
  hedef.forEach(i => sh.getRange(i + 2, SUT.isaretler + 1).setValue(isaretDegistir_(v[i][SUT.isaretler], GECERSIZ, !b.geri)));
  SpreadsheetApp.flush();
  return {ok: true, kod: kod, numara: no, gecersiz: !b.geri, n: hedef.length};
}

/* ---------- Sözlü notları ---------- */

/** Öğretmenin kararı: {kod, numara ("*" = bütün ödev), karar}. karar "" → karar silinir (varsayılana döner). */
function kararYaz_(b, simdi) {
  const kod = normKod_(b.kod), numara = String(b.numara == null ? '' : b.numara).trim(), karar = b.karar == null ? '' : b.karar;
  if (!odevBul_(kod)) return {ok: false, hata: 'yok', kalici: true};
  if (!(numara === '*' || /^\d{1,12}$/.test(numara))) return {ok: false, hata: 'gecersiz', kalici: true};
  if (karar !== '' && KARAR_TURLERI.indexOf(karar) < 0) return {ok: false, hata: 'gecersiz', kalici: true};
  if (karar !== '' && (numara === '*') !== (karar === 'haric')) return {ok: false, hata: 'gecersiz', kalici: true}; // haric yalnız bütün ödeve
  const sh = sayfa_(KARARLAR, KARAR_BASLIK);
  const son = sh.getLastRow();
  const v = son >= 2 ? sh.getRange(2, 1, son - 1, KARAR_BASLIK.length).getValues() : [];
  let r = -1;
  for (let i = 0; i < v.length; i++) if (normKod_(v[i][0]) === kod && String(v[i][1]).trim() === numara) { r = i + 2; break; }
  if (r < 0) {
    if (karar === '') return {ok: true, kod: kod, numara: numara, karar: ''};
    r = son + 1;
    sh.getRange(r, 1, 1, 2).setNumberFormat('@');
  }
  sh.getRange(r, 1, 1, KARAR_BASLIK.length).setValues([[kod, numara, karar, karar === '' ? '' : simdi]]);
  SpreadsheetApp.flush();
  return {ok: true, kod: kod, numara: numara, karar: karar};
}

/** Bir şubenin not çizelgesi için ham veri: öğrenciler, o şubeyi ilgilendiren ödevler, ilk denemeler, kararlar.
 *  Ödev şubeye verilmişse (sinif alanında şube) ya da şubesiz ödevi bu şubeden biri çözmüşse ilgilidir.
 *  Notu sayfa hesaplar (varsayılanlar ve kararlar sayfada da aynı kurallarla uygulanır). */
function notCizelgesi_(subeGirdisi) {
  const sube = sinifSube_(subeGirdisi);
  if (!sube) return {ok: false, hata: 'sinif', kalici: true};
  const liste = ogrenciListesi_().filter(function (o) { return o.sinif === sube; });
  const noNorm = function (n) { return String(n).trim().replace(/^0+(?=\d)/, ''); };
  const listede = {};
  liste.forEach(function (o) { listede[noNorm(o.numara)] = true; });
  const sh = sayfa_(SONUCLAR, SONUC_BASLIK);
  const son = sh.getLastRow();
  const veri = son >= 2 ? sh.getRange(2, 1, son - 1, SONUC_BASLIK.length).getValues() : [];
  const ilk = {}, sonuclar = [], cozulen = {};
  veri.forEach(function (r) {
    if (gecersizMi_(r)) return;
    const kod = normKod_(r[1]), numara = String(r[3]).trim(), sinif = sinifSube_(r[14]);
    if (!kod || !listede[noNorm(numara)] || (sinif && sinif !== sube)) return;
    const anahtar = kod + '|' + numara + '|' + kisiAdi_(String(r[4]).replace(/^'/, ''));
    if (ilk[anahtar]) return;
    ilk[anahtar] = true; cozulen[kod] = true;
    sonuclar.push({kod: kod, numara: numara, puan: Number(r[8]) || 0, durum: String(r[9]), zaman: iso_(r[0] instanceof Date ? r[0] : null)});
  });
  const odevler = [];
  sayfa_(ODEVLER, ODEV_BASLIK).getDataRange().getValues().slice(1).forEach(function (r) {
    const kod = normKod_(r[0]);
    if (!kod) return;
    const subeler = subeListesi_(r[4]);
    if (subeler.length ? subeler.indexOf(sube) < 0 : !cozulen[kod]) return;
    let bit = null;
    try { bit = zaman_(r[3], true); } catch (err) { /* tarihsiz */ }
    odevler.push({kod: kod, test_slug: String(r[1]).trim(), bitis: iso_(bit), sinif: String(r[4]).trim()});
  });
  const ilgili = {};
  odevler.forEach(function (o) { ilgili[o.kod] = true; });
  const ksh = tablo_().getSheetByName(KARARLAR);
  const kararlar = !ksh || ksh.getLastRow() < 2 ? [] : ksh.getRange(2, 1, ksh.getLastRow() - 1, KARAR_BASLIK.length).getValues()
    .map(function (r) { return {kod: normKod_(r[0]), numara: String(r[1]).trim(), karar: String(r[2]).trim()}; })
    .filter(function (k) { return ilgili[k.kod] && KARAR_TURLERI.indexOf(k.karar) >= 0; });
  return {ok: true, sube: sube, ogrenciler: liste, odevler: odevler,
    sonuclar: sonuclar.filter(function (x) { return ilgili[x.kod]; }), kararlar: kararlar};
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
  return {ad: b.ad.replace(/\s+/g, ' ').trim(), sorular: sorular, kaynak: kaynak,
    puanlama: b.puanlama === 'plain' || b.puanlama === 'lgs' ? b.puanlama : '', oto: b.oto === true};
}

function testEkle_(b, simdi) {
  const t = testDenetle_(b);
  if (t.hata) return {ok: false, hata: t.hata, no: t.no, kalici: true};
  const govdeT = {ad: t.ad, sorular: t.sorular};
  if (t.kaynak) govdeT.kaynak = t.kaynak;
  if (t.puanlama) govdeT.puanlama = t.puanlama;
  if (t.oto) govdeT.oto = true;
  const icerik = JSON.stringify(govdeT);
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

/** Kayıtlı test: {ad, sorular, kaynak, puanlama, oto} ya da null. */
function ozelTest_(slug) {
  const satirlar = sayfa_(TESTLER, TEST_BASLIK).getDataRange().getValues();
  for (let i = 1; i < satirlar.length; i++) {
    if (String(satirlar[i][0]) !== slug) continue;
    try {
      const t = JSON.parse(String(satirlar[i][4]));
      return t && Array.isArray(t.sorular) ?
        {ad: String(t.ad || satirlar[i][1]), sorular: t.sorular, kaynak: typeof t.kaynak === 'string' ? t.kaynak : '',
          puanlama: t.puanlama === 'plain' || t.puanlama === 'lgs' ? t.puanlama : '', oto: t.oto === true} : null;
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
    sh.getRange(2, 1, son - 1, SONUC_BASLIK.length).getValues().forEach(function (r) {
      if (gecersizMi_(r)) return;
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
  const sinif = sinifMetni_(b.sinif);
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
 * Ödevde birden çok şube varsa (8-A, 8-B…) her şube ayrı blok olur: bloğun üstünde o şubenin kendi WhatsApp
 * metni, sıra her şubede 1'den; bloklar boş satırla ayrılır, şubesi olmayan eski kayıtlar en sonda.
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
const SUBESIZ = 'Şube yazılmamış';
const SIRALAMA_BASLIK = ['sira', 'ad_soyad', 'sinif_sube', 'numara', 'puan', 'dogru', 'yanlis', 'bos', 'sure', 'durum'];

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
  // Çok şubeli ödevde her şubenin metni AYRI kutuda ve AYRI Kopyala düğmesiyle: bir sınıfın grubuna başka sınıfın isimleri gitmesin.
  const cok = s.subeler.length > 1;
  const kutular = s.subeler.map(function (b, i) {
    return (cok ? '<h4 style="margin:12px 0 4px;font:bold 14px sans-serif">' + html_(b.sube || SUBESIZ) + ' grubu için</h4>' : '') +
      '<textarea id="t' + i + '" readonly style="width:100%;height:' + (cok ? 170 : 300) + 'px;font:14px sans-serif;box-sizing:border-box">' +
      html_(b.metin) + '</textarea>' +
      '<button style="margin-top:8px;padding:8px 16px;font:bold 14px sans-serif" ' +
      'onclick="var t=document.getElementById(\'t' + i + '\');t.select();document.execCommand(\'copy\');this.textContent=\'Kopyalandı ✓\'">Kopyala</button>';
  }).join('');
  const html = HtmlService.createHtmlOutput(
    '<div style="font:14px sans-serif">' +
    '<p style="margin:0 0 8px">"' + html_(s.sekme) + '" sekmesi güncellendi. ' +
    (cok ? 'Her şubenin metnini yalnız kendi WhatsApp grubuna yapıştır:' : 'Aşağıdaki metni WhatsApp\'a yapıştır:') + '</p>' +
    kutular + '</div>').setWidth(480).setHeight(cok ? Math.min(600, 90 + 260 * s.subeler.length) : 420);
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

/** "90 puan · 18 doğru, 2 yanlış" (+ ", 1 boş" varsa, + " (süre dışı)"). Panel de aynı biçimi kullanır. */
function siraOzeti_(o) {
  return String(o.puan).replace('.', ',') + ' puan · ' + o.dogru + ' doğru, ' + o.yanlis + ' yanlış' +
    (o.bos ? ', ' + o.bos + ' boş' : '') + (o.durum === SURE_DISI ? ' (süre dışı)' : '');
}

/** Sıralamayı hesaplar ve "Sıralama <KOD>" sekmesine yazar (şube şube bloklar). {kod, sekme, satirlar, metin, subeler}
 *  döndürür: satirlar şube sırasıyla düz liste (her satırda şube içi `sira`), metin şube metinlerinin birleşimi
 *  (tek şubede eski tek metin), subeler [{sube, metin, satirlar}] (şubesizler sube '' ile en sonda). */
function siralamaHazirla_(kodGirdisi) {
  const kod = normKod_(kodGirdisi);
  const sh = sayfa_(SONUCLAR, SONUC_BASLIK);
  const son = sh.getLastRow();
  const veriler = son >= 2 ? sh.getRange(2, 1, son - 1, SONUC_BASLIK.length).getValues() : [];
  const ilk = {}; // numara|ad → ilk deneme (en eski satır)
  veriler.forEach(function (r, i) {
    if (!kod || normKod_(r[1]) !== kod || gecersizMi_(r)) return;
    const numara = String(r[3]).trim();
    const o = {sira_no: i, test_slug: String(r[2]), numara: numara, ad: String(r[4]).replace(/^'/, '').trim(),
      dogru: Number(r[5]) || 0, yanlis: Number(r[6]) || 0, bos: Number(r[7]) || 0, puan: Number(r[8]) || 0,
      durum: String(r[9]), sure: r[12] === '' || r[12] == null ? Infinity : Number(r[12]), sinif: sinifSube_(r[14])};
    const anahtar = numara + '|' + kisiAdi_(o.ad);
    if (!ilk[anahtar]) ilk[anahtar] = o; // satırlar gönderim sırasıyla eklenir: ilk görülen ilk denemedir
  });
  const tumu = Object.keys(ilk).map(function (k) { return ilk[k]; }).sort(function (a, b) {
    return b.puan - a.puan || a.sure - b.sure || a.sira_no - b.sira_no;
  });

  const odev = odevBul_(kod);
  const test = tumu.length ? tumu[0].test_slug : (odev ? odev.test_slug : '');
  const sinif = odev ? odevSinifi_(kod) : '';
  const tz = tablo_().getSpreadsheetTimeZone();

  // Şube şube: her şubenin kendi sıralaması (sıra her şubede 1'den), kendi WhatsApp metni. Şubesi olmayan eski
  // kayıtlar en sonda "Şube yazılmamış" bloğu. Tek şubeli (ya da hiç şubesiz) ödevde tek blok, eski biçim.
  const gruplar = {};
  tumu.forEach(function (o) { (gruplar[o.sinif] = gruplar[o.sinif] || []).push(o); });
  const anahtarlar = Object.keys(gruplar).filter(function (k) { return k; }).sort(subeSirala_);
  if (gruplar['']) anahtarlar.push('');
  const cok = anahtarlar.length > 1;
  const bloklar = (anahtarlar.length ? anahtarlar : ['']).map(function (k) {
    const liste = gruplar[k] || [];
    liste.forEach(function (o, i) { o.sira = i + 1; }); // şube içi sıra
    const etiket = cok ? (k || SUBESIZ) : (k || sinif); // tek blokta sonucun şubesi (yoksa ödevin şubesi): sayfayla aynı kural
    return {sube: k, metin: siralamaMetni_(test, etiket, liste), satirlar: liste};
  });
  const satirlar = [].concat.apply([], bloklar.map(function (b) { return b.satirlar; })); // şube sırasıyla, şube içinde sıralı
  const metin = bloklar.map(function (b) { return b.metin; }).join('\n\n');
  if (!kod || !satirlar.length) return {kod: kod, sekme: '', satirlar: satirlar, metin: metin, subeler: []};

  const sekme = SIRALAMA + ' ' + kod;
  const bilgi = (cok ? '↑ Her şubenin kendi bloğunun üstündeki metni o şubenin WhatsApp grubuna yapıştır' : '↑ Üstteki metni WhatsApp\'a yapıştır') +
    ': telefonda hücreye dokun → Kopyala. ' + kod + ' · ' + test +
    (sinif ? ' · ' + sinif : '') + ' · güncellendi: ' + Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy HH:mm') +
    ' (5 dakikada bir kendiliğinden yenilenir)';
  const genislik = SIRALAMA_BASLIK.length;
  const bos = function () { const r = []; for (let i = 0; i < genislik; i++) r.push(''); return r; };
  const ust = function (v) { const r = bos(); r[0] = v; return r; };
  const izgara = [], metinSatirlari = []; // metinSatirlari: {satir (1'den), sayi (metnin satır sayısı)}
  bloklar.forEach(function (b, bi) {
    if (bi) izgara.push(bos()); // bloklar arası boş satır
    izgara.push(ust(b.metin));
    metinSatirlari.push({satir: izgara.length, sayi: b.metin.split('\n').length});
    if (!bi) izgara.push(ust(bilgi));
    izgara.push(SIRALAMA_BASLIK.slice());
    b.satirlar.forEach(function (o) {
      izgara.push([o.sira, metin_(o.ad), o.sinif, o.numara, o.puan, o.dogru, o.yanlis, o.bos, sure_(o.sure), o.durum]);
    });
  });
  let hedef = tablo_().getSheetByName(sekme);
  if (!hedef) hedef = tablo_().insertSheet(sekme);
  hedef.clear();
  // clear() birleşik hücreleri ayırmaz, satır yüksekliklerini sıfırlamaz: bloklar kayınca eski birleştirme bir öğrenci satırını gizlerdi
  hedef.getRange(1, 1, hedef.getMaxRows(), hedef.getMaxColumns()).breakApart();
  hedef.setRowHeights(1, hedef.getMaxRows(), 21);
  hedef.getRange(1, 1, izgara.length, genislik).setValues(izgara);
  metinSatirlari.forEach(function (m, i) {
    hedef.getRange(m.satir, 1, 1, genislik).merge().setWrap(true).setVerticalAlignment('top');
    hedef.setRowHeight(m.satir, 21 * m.sayi + 8);
    if (!i) hedef.getRange(m.satir + 1, 1, 1, genislik).merge().setWrap(true);
  });
  hedef.setFrozenRows(0);
  return {kod: kod, sekme: sekme, satirlar: satirlar, metin: metin,
    subeler: bloklar.map(function (b) { return {sube: b.sube, metin: b.metin, satirlar: b.satirlar}; })};
}

/** Bir şubenin WhatsApp metni. Sayfadaki siralamaMetni ile aynı biçim. */
function siralamaMetni_(test, etiket, liste) {
  const madalya = ['🥇', '🥈', '🥉'];
  return ['🏆 Ödev sıralaması · ' + test + (etiket ? ' · ' + etiket : ''), '(ilk denemeler, 100 üzerinden)', '']
    .concat(liste.map(function (o, i) {
      return (madalya[i] || (i + 1) + '.') + ' ' + o.ad + (o.sinif ? ' (' + o.sinif + ')' : '') + ' — ' + siraOzeti_(o);
    }))
    .concat(['', liste.length + ' öğrenci katıldı.'])
    .join('\n');
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

/* ---------- Puanlama (sunucuda) ----------
   Sayfanın gönderdiği doğru/yanlış/puan YOK SAYILIR: "1A✓ 2B✗ 3-" metnindeki harfler sunucunun
   anahtarıyla puanlanır (✓/✗ işaretleri de yok sayılır). Anahtar: öğretmen testinde Testler sekmesi,
   hazır testte sitedeki quizler/<slug>.json (6 saat önbellek). Anahtar okunamazsa sonuç kaybolmasın
   diye istemci sayıları (puan 0-100'e kırpılarak) yazılır ve puan_kaynagi "istemci" olur. */

const QUIZ_ONBELLEK_SN = 6 * 60 * 60;
const CEVAP_RE = /^(\d{1,2})([A-D-])[✓✗]?$/;

/** "1A✓ 2B✗ 3-" → [0, 1, -1] (asıl soru sırası). Parça sayısı n değilse, numara tekrar/aralık dışıysa null. */
function cevapCoz_(metin, n) {
  const parcalar = String(metin == null ? '' : metin).replace(/^'/, '').trim().split(/\s+/).filter(Boolean);
  if (parcalar.length !== n) return null;
  const secim = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = parcalar[i].match(CEVAP_RE);
    if (!m) return null;
    const no = +m[1];
    if (no < 1 || no > n || secim[no - 1] !== undefined) return null;
    secim[no - 1] = m[2] === '-' ? -1 : 'ABCD'.indexOf(m[2]);
  }
  return secim;
}

/** Sayfadaki formülle birebir (sablon.html odevGonder). */
function puanla_(secim, anahtar, puanlama) {
  let d = 0, y = 0, b = 0;
  secim.forEach(function (c, i) { if (c < 0) b++; else if (c === anahtar[i]) d++; else y++; });
  const n = anahtar.length;
  return {dogru: d, yanlis: y, bos: b, puan: Math.round(1000 * Math.max(0, puanlama === 'plain' ? d : d - y / 3) / n) / 10};
}

function testAnahtari_(slug) {
  if (String(slug).indexOf('ozel-') === 0) {
    const t = ozelTest_(slug);
    if (!t) return null;
    const pl = t.puanlama || (t.kaynak && (hazirTest_(t.kaynak) || {}).scoring === 'plain' ? 'plain' : 'lgs');
    return {anahtar: t.sorular.map(q => q.a), aciklamalar: t.sorular.map(q => q.tr || ''), puanlama: pl, kaynak: 'tablo'};
  }
  const h = hazirTest_(slug);
  return h ? {anahtar: h.questions.map(q => q.a), aciklamalar: h.questions.map(q => q.tr || ''),
    puanlama: h.scoring === 'plain' ? 'plain' : 'lgs', kaynak: 'site'} : null;
}

function hazirTest_(slug) {
  if (!/^[a-z0-9-]{1,60}$/.test(String(slug))) return null;
  let c = null;
  try { c = CacheService.getScriptCache(); } catch (e) { /* önbellek yoksa her seferinde oku */ }
  const k = 'quiz:' + slug;
  if (c) {
    const eski = c.get(k);
    if (eski) { try { return JSON.parse(eski); } catch (e) { /* bozuk önbellek: yeniden oku */ } }
  }
  try {
    const r = UrlFetchApp.fetch(SITE + 'quizler/' + slug + '.json', {muteHttpExceptions: true, followRedirects: true});
    if (r.getResponseCode() !== 200) return null;
    const t = JSON.parse(r.getContentText());
    if (!t || !Array.isArray(t.questions) || !t.questions.length ||
      !t.questions.every(q => q && Number.isInteger(q.a) && q.a >= 0 && q.a <= 3)) return null;
    const kucuk = {scoring: t.scoring, questions: t.questions.map(q => ({a: q.a, tr: typeof q.tr === 'string' ? q.tr : ''}))};
    const s = JSON.stringify(kucuk);
    if (c && s.length < 90000) c.put(k, s, QUIZ_ONBELLEK_SN);
    return kucuk;
  } catch (e) {
    console.error('hazır test okunamadı: ' + slug + ' · ' + e);
    return null;
  }
}

/* ---------- Kayıt ---------- */

/** Yalnız ilk deneme kaydedilir: aynı ödevde aynı numara + ad (büyük/küçük harf ve boşluk farkı yok sayılır) varsa true. */
function oncekiVar_(anahtar, numara, ad) {
  const sh = sayfa_(SONUCLAR, SONUC_BASLIK);
  const son = sh.getLastRow();
  if (son < 2) return false;
  const kisi = kisiAdi_(ad);
  return sh.getRange(2, 1, son - 1, SONUC_BASLIK.length).getValues().some(function (s) {
    return !gecersizMi_(s) && normKod_(s[1]) === anahtar && noNorm_(s[3]) === noNorm_(numara) && kisiAdi_(String(s[4]).replace(/^'/, '')) === kisi;
  });
}

function sonucYaz_(odev, g, simdi, ek) {
  const sh = sayfa_(SONUCLAR, SONUC_BASLIK);
  const son = sh.getLastRow();
  let deneme = 0, onceki = false;
  if (son >= 2) {
    const satirlar = sh.getRange(2, 1, son - 1, SONUC_BASLIK.length).getValues();
    for (let i = 0; i < satirlar.length; i++) {
      const s = satirlar[i];
      if (String(s[13]) === g.gonderim_id) {
        return {ok: true, durum: String(s[9]), deneme_no: Number(s[10]), tekrar: true};
      }
      if (normKod_(s[1]) === odev.anahtar && noNorm_(s[3]) === noNorm_(g.numara)) {
        deneme++;
        if (!gecersizMi_(s) && kisiAdi_(String(s[4]).replace(/^'/, '')) === kisiAdi_(g.ad_soyad)) onceki = true;
      }
    }
  }
  const durum = pencereIcinde_(odev, simdi) ? ZAMANINDA : SURE_DISI;
  // yalnız ilk deneme kaydedilir; sonrakiler alıştırmadır (sayfa öğrenciyi önceden uyarır, eski sayfa gönderse de yazılmaz)
  if (onceki) return {ok: true, kaydedilmedi: true, durum: durum, deneme_no: deneme + 1, sunucu_zamani: simdi.toISOString()};
  const e = ek || {};
  const satir = [simdi, odev.kod, odev.test_slug, g.numara, metin_(g.ad_soyad), g.dogru, g.yanlis, g.bos,
    g.puan, durum, deneme + 1, metin_(g.cevaplar), g.istemci_sure_ms, g.gonderim_id, g.sinif_sube,
    e.sure_sunucu == null ? '' : e.sure_sunucu, e.puan_kaynagi || 'istemci', (e.isaretler || []).join(','), metin_(e.yazilan_ad || g.ad_soyad)];
  const r = son + 1;
  sh.getRange(r, 4).setNumberFormat('@'); // numara metin kalsın (baştaki sıfırlar silinmesin)
  sh.getRange(r, 15).setNumberFormat('@'); // sınıf/şube metin kalsın (e-tablo tarihe çevirmesin)
  sh.getRange(r, 1, 1, satir.length).setValues([satir]);
  SpreadsheetApp.flush();
  return {ok: true, durum: durum, deneme_no: deneme + 1, sunucu_zamani: simdi.toISOString()};
}

/** "8a", "8 A", "8/a", "8.A", "8-A" → "8-A"; geçersizse ''. (Sayfadaki sinifSube ile aynı kural.) */
function sinifSube_(v) {
  const m = String(v == null ? '' : v).trim().toLocaleUpperCase('tr').match(/^(\d{1,2})\s*[-\/.\s]?\s*([A-ZÇĞİÖŞÜ])$/);
  return m && +m[1] >= 1 && +m[1] <= 12 ? +m[1] + '-' + m[2] : '';
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
    // sınıf/şube sayfada zorunlu; burada boş yalnız hiç sınıf listesi yokken kabul edilir (liste varsa listeKapisi_ sube_gerekli ile reddeder)
    kod: kod, test_slug: b.test_slug, numara: numara, ad_soyad: ad, sinif_sube: sinifSube_(b.sinif_sube),
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
    const odev = {anahtar: anahtar, kod: String(s[0]).trim(), test_slug: String(s[1]).trim(), sinif: String(s[4] == null ? '' : s[4]).trim()};
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

/* Hız sınırı: tavan (davranış eşiği değil). 30 kişilik şube aynı dakikada bitirse bile altında kalır.
   İstekler Google'a ulaşmayı sürdürür; sınır onları e-tabloya dokunmadan, ucuzca geri çevirir.
   Önbellek çalışmazsa sınır uygulanmaz (fail-open): gerçek öğrencinin sonucu kaybolmasın. */
const HIZ = {kod: [120, 60], kisi: [6, 600]}; // [en çok istek, saniye]
function sinirAsildi_(anahtar, tavan, sn) {
  try {
    const c = CacheService.getScriptCache(), k = 'hiz:' + anahtar, simdi = Date.now();
    let s = null;
    try { s = JSON.parse(c.get(k) || 'null'); } catch (e) { /* bozuk sayaç: sıfırla */ }
    if (!s || typeof s.b !== 'number' || simdi - s.b > sn * 1000) s = {b: simdi, n: 0};
    s.n++;
    c.put(k, JSON.stringify(s), sn + 5);
    return s.n > tavan;
  } catch (e) {
    return false;
  }
}
function hizDenetle_(kod, numara) {
  if (sinirAsildi_('k:' + kod, HIZ.kod[0], HIZ.kod[1])) return true;
  return !!numara && sinirAsildi_('n:' + kod + ':' + noNorm_(numara), HIZ.kisi[0], HIZ.kisi[1]);
}

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
  } else {
    // eski tabloda sonradan eklenen sütunların başlığı (gonderim_id, sinif_sube) boşsa yazılır
    const ilk = sh.getRange(1, 1, 1, baslik.length).getValues()[0];
    ilk.forEach(function (v, i) { if (String(v).trim() === '') sh.getRange(1, i + 1).setValue(baslik[i]); });
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
