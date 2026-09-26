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

/* ---------- Web uygulaması giriş noktaları ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!('odev' in p)) return json_({ok: true, servis: 'alti-saniye', surum: 1});
  try {
    const odev = odevBul_(normKod_(p.odev));
    if (!odev) return json_({gecerli: false});
    if (odev.hata) return json_({gecerli: false, hata: odev.hata});
    const simdi = new Date();
    return json_({
      gecerli: true,
      test_slug: odev.test_slug,
      baslangic: iso_(odev.baslangic),
      bitis: iso_(odev.bitis),
      acik: pencereIcinde_(odev, simdi),
      simdi: simdi.toISOString()
    });
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

/** İsteğe bağlı: Apps Script düzenleyicisinde bir kez "Çalıştır" → iki sekmeyi başlıklarıyla açar. */
function kurulum() {
  sayfa_(ODEVLER, ODEV_BASLIK);
  sayfa_(SONUCLAR, SONUC_BASLIK);
  console.log('Sekmeler hazır. E-tablo saat dilimi: ' + tablo_().getSpreadsheetTimeZone());
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
