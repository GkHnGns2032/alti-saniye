#!/usr/bin/env node
/*
 * Altı Saniye — apps-script/Kod.gs birim testi (Node, ağ yok, Google yok).
 *
 * Kod.gs'i bir vm bağlamında, SpreadsheetApp / LockService / ContentService / Utilities'in
 * bellek içi taklitleriyle çalıştırır: doGet pencere yanıtı, doPost süre denetimi (sunucu saati),
 * bilinmeyen kodun reddi, deneme_no artışı, tekrar gönderimin tek satır kalması, formül
 * enjeksiyonu, kilit alınamaması ve tarih biçimleri denetlenir.
 *
 * Kullanım:  node araclar/sunucu_testi.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const kripto = require('crypto');

const KOD = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Kod.gs'), 'utf8');
const TZ_DK = {'Europe/Istanbul': 180}; // Türkiye 2016'dan beri sabit UTC+3
const GUN = 864e5;

/* ---------- Taklitler ---------- */
class Sayfa {
  constructor() { this.v = []; this.bicim = {}; this.birlesik = []; this.yukseklik = {}; }
  clear() { this.v = []; } // gerçek e-tablo gibi: birleşik hücreleri ve satır yüksekliklerini SIFIRLAMAZ
  setRowHeight(r, h) { this.yukseklik[r] = h; }
  setRowHeights(r, n, h) { for (let i = 0; i < n; i++) this.yukseklik[r + i] = h; }
  getMaxRows() { return Math.max(1000, this.v.length); }
  getMaxColumns() { return 26; }
  getLastRow() { return this.v.length; }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.v.length), Math.max(1, ...this.v.map(r => r.length))); }
  setFrozenRows() {}
  getRange(r, c, nr = 1, nc = 1) {
    const s = this;
    const hucre = (i, j) => (s.v[i] && s.v[i][j] !== undefined ? s.v[i][j] : '');
    return {
      getValues: () => Array.from({length: nr}, (_, i) => Array.from({length: nc}, (_, j) => hucre(r - 1 + i, c - 1 + j))),
      getValue: () => hucre(r - 1, c - 1),
      setValue: x => { while (s.v.length < r) s.v.push([]); s.v[r - 1][c - 1] = x; },
      setValues: rows => rows.forEach((row, i) => row.forEach((x, j) => {
        while (s.v.length < r + i) s.v.push([]);
        s.v[r - 1 + i][c - 1 + j] = x;
      })),
      setNumberFormat: f => { s.bicim[r + ':' + c] = f; },
      clearContent() { // gerçek e-tablo gibi: sondaki boş satırlar getLastRow'a sayılmaz
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (s.v[r - 1 + i]) s.v[r - 1 + i][c - 1 + j] = '';
        while (s.v.length && s.v[s.v.length - 1].every(x => x === '' || x === undefined)) s.v.pop();
        return this;
      },
      merge() { s.birlesik.push([r, c, nr, nc]); return this; },
      breakApart() { s.birlesik = s.birlesik.filter(([r2, c2, nr2, nc2]) => r2 > r + nr - 1 || r2 + nr2 - 1 < r || c2 > c + nc - 1 || c2 + nc2 - 1 < c); return this; },
      setWrap() { return this; },
      setVerticalAlignment() { return this; }
    };
  }
}

function ortam({kilit = true, istem = null, site = {}} = {}) {
  const sayfalar = {};
  const ui = {
    menuler: [], diyaloglar: [], uyarilar: [],
    ButtonSet: {OK: 'OK', OK_CANCEL: 'OK_CANCEL'}, Button: {OK: 'OK', CANCEL: 'CANCEL'},
    createMenu(ad) { const m = {ad, ogeler: [], addItem(e, f) { this.ogeler.push([e, f]); return this; }, addToUi() { ui.menuler.push(m); }}; return m; },
    prompt: () => ({getSelectedButton: () => (istem === null ? 'CANCEL' : 'OK'), getResponseText: () => istem || ''}),
    alert(baslik, metin) { ui.uyarilar.push(metin); },
    showModalDialog(h, baslik) { ui.diyaloglar.push({html: h.html, baslik}); }
  };
  const ss = {
    getSheetByName: ad => sayfalar[ad] || null,
    insertSheet: ad => (sayfalar[ad] = new Sayfa()),
    getSpreadsheetTimeZone: () => 'Europe/Istanbul'
  };
  const tetikler = [];
  const ozellikler = {};
  const onbellek = {}, urlIstekleri = [];
  let uuid = 0;
  const ctx = {
    PropertiesService: {getScriptProperties: () => ({
      getProperty: k => (k in ozellikler ? ozellikler[k] : null),
      setProperty: (k, v) => { ozellikler[k] = v; }
    })},
    console: {log() {}, error() {}},
    ScriptApp: {
      getProjectTriggers: () => tetikler.slice(),
      deleteTrigger: t => tetikler.splice(tetikler.indexOf(t), 1),
      newTrigger: f => ({timeBased: () => ({everyMinutes: dk => ({create: () => {
        const t = {f, dk, getHandlerFunction: () => f}; tetikler.push(t); return t;
      }})})})
    },
    SpreadsheetApp: {getActiveSpreadsheet: () => ss, flush() {}, getUi: () => ui},
    HtmlService: {createHtmlOutput: h => ({html: h, setWidth() { return this; }, setHeight() { return this; }})},
    LockService: {getScriptLock: () => ({tryLock: () => kilit, releaseLock() {}})},
    ContentService: {
      MimeType: {JSON: 'application/json'},
      createTextOutput: t => ({t, mime: null, setMimeType(m) { this.mime = m; return this; }})
    },
    UrlFetchApp: {fetch(url) {
      urlIstekleri.push(url);
      const m = String(url).match(/quizler\/([a-z0-9-]+)\.json$/), t = m && site[m[1]];
      return {getResponseCode: () => (t ? 200 : 404), getContentText: () => (t ? JSON.stringify(t) : 'Not Found')};
    }},
    CacheService: {getScriptCache: () => ({get: k => (k in onbellek ? onbellek[k] : null), put: (k, v) => { onbellek[k] = String(v); }})},
    Utilities: {
      computeHmacSha256Signature: (v, k) => Array.from(kripto.createHmac('sha256', k).update(v, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => ('0000000' + (++uuid)).slice(-8) + '-aaaa-bbbb-cccc-' + ('00000000000' + uuid).slice(-12),
      parseDate(s, tz, bicim) {
        if (bicim !== 'yyyy-MM-dd HH:mm:ss') throw new Error('taklit: desteklenmeyen biçim ' + bicim);
        const [g, sa] = s.split(' '), [y, a, gun] = g.split('-').map(Number), [h, m, sn] = sa.split(':').map(Number);
        return new Date(Date.UTC(y, a - 1, gun, h, m, sn) - TZ_DK[tz] * 6e4);
      },
      formatDate(d, tz, bicim) {
        const x = new Date(d.getTime() + TZ_DK[tz] * 6e4).toISOString();
        if (bicim === 'HH:mm:ss') return x.slice(11, 19);
        if (bicim === 'dd.MM.yyyy HH:mm') return `${x.slice(8, 10)}.${x.slice(5, 7)}.${x.slice(0, 4)} ${x.slice(11, 16)}`;
        throw new Error('taklit: desteklenmeyen biçim ' + bicim);
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(KOD, ctx, {filename: 'Kod.gs'});
  const cevap = o => { if (o.mime !== 'application/json') throw new Error('JSON mime yok'); return JSON.parse(o.t); };
  return {
    ctx, sayfalar, ui, tetikler, ozellikler, urlIstekleri, onbellek,
    odev: (...satirlar) => {
      const sh = ss.insertSheet('Ödevler');
      sh.v = [['kod', 'test_slug', 'baslangic', 'bitis', 'sinif', 'not'], ...satirlar];
    },
    get: prm => cevap(ctx.doGet({parameter: prm})),
    post: govde => cevap(ctx.doPost({postData: {contents: typeof govde === 'string' ? govde : JSON.stringify(govde), type: 'text/plain'}})),
    sonuclar: () => (sayfalar['Sonuçlar'] ? sayfalar['Sonuçlar'].v.slice(1) : [])
  };
}

let sayac = 0;
const govde = (ek = {}) => Object.assign({
  kod: 'ACIK1', test_slug: 'ingilizce-8', numara: '0123', ad_soyad: 'Deneme Öğrenci',
  dogru: 9, yanlis: 8, bos: 8, puan: 25.3, cevaplar: '1B✓ 2C✗ 3-', istemci_sure_ms: 181000,
  gonderim_id: 'test-' + (++sayac) + '-abcdef'
}, ek);

const simdi = Date.now();
const once = new Date(simdi - GUN), sonra = new Date(simdi + GUN);
const standart = () => {
  const o = ortam();
  o.odev(
    ['ACIK1', 'ingilizce-8', once, sonra, '8-A', ''],
    ['GECTI', 'ingilizce-8', new Date(simdi - 3 * GUN), new Date(simdi - 2 * GUN), '8-A', ''],
    ['GELECEK', 'odd-one-out-7', new Date(simdi + 2 * GUN), new Date(simdi + 3 * GUN), '7-B', ''],
    [4521, 'do-you-know-me', '', '', '', 'sayı olarak yazılmış kod, sınırsız pencere'],
    ['METIN', 'ingilizce-8', '30.09.2026 14:00', '2.10.2026', '', ''],
    ['BOZUK', 'ingilizce-8', 'yarın', '', '', '']
  );
  return o;
};

const ANAHTAR_25 = Array.from({length: 25}, (_, i) => i % 4);
const SITE = {'ingilizce-8': {scoring: 'lgs', questions: ANAHTAR_25.map((a, i) => ({q: 'q' + i, o: ['a', 'b', 'c', 'd'], a, tr: 'açıklama ' + (i + 1)}))}};
// desen: D doğru · Y yanlış · B boş (asıl soru sırasıyla)
const cevapMetni = (anahtar, desen) => anahtar.map((a, i) => (i + 1) + (desen[i] === 'D' ? 'ABCD'[a] + '✓' : desen[i] === 'Y' ? 'ABCD'[(a + 1) % 4] + '✗' : '-')).join(' ');
const siteli = () => { const o = ortam({site: SITE}); o.odev(['ACIK1', 'ingilizce-8', once, sonra, '', '']); return o; };

/* ---------- Vakalar ---------- */
const VAKALAR = [
  ['GET parametresiz → sağlık yanıtı', () => {
    const r = standart().get({});
    return r.ok === true && r.servis === 'alti-saniye';
  }],
  ['GET bilinmeyen kod → gecerli:false', () => standart().get({odev: 'YOK'}).gecerli === false],
  ['GET boş kod → gecerli:false', () => standart().get({odev: ''}).gecerli === false],
  ['GET açık pencere → acik:true, test_slug, ISO tarihler', () => {
    const r = standart().get({odev: 'ACIK1'});
    return r.gecerli && r.acik === true && r.test_slug === 'ingilizce-8' &&
      r.baslangic === once.toISOString() && r.bitis === sonra.toISOString() && typeof r.simdi === 'string';
  }],
  ['GET süresi geçmiş → acik:false', () => { const r = standart().get({odev: 'GECTI'}); return r.gecerli && r.acik === false; }],
  ['GET henüz açılmamış → acik:false', () => { const r = standart().get({odev: 'GELECEK'}); return r.gecerli && r.acik === false; }],
  ['GET kod büyük/küçük harf duyarsız, sayı hücresi, boş tarih = sınırsız', () => {
    const o = standart();
    const a = o.get({odev: 'acik1'}), b = o.get({odev: '4521'});
    return a.gecerli && a.acik && b.gecerli && b.acik && b.baslangic === null && b.bitis === null;
  }],
  ['GET metin tarih e-tablo saat diliminde; bitiş 00:00 → günün sonu', () => {
    const r = standart().get({odev: 'METIN'});
    return r.baslangic === '2026-09-30T11:00:00.000Z' && r.bitis === '2026-10-02T20:59:59.999Z';
  }],
  ['GET okunamayan tarih → gecerli:false, hata:tarih', () => {
    const r = standart().get({odev: 'BOZUK'});
    return r.gecerli === false && r.hata === 'tarih';
  }],
  ['POST açık pencere → zamanında, deneme 1, 15 sütun, numara ve sınıf/şube metin', () => {
    const o = standart();
    const r = o.post(govde({sinif_sube: '8a'}));
    const s = o.sonuclar();
    const sh = o.sayfalar['Sonuçlar'];
    return r.ok && r.durum === 'zamanında' && r.deneme_no === 1 && s.length === 1 && s[0].length === 19 &&
      s[0][1] === 'ACIK1' && s[0][3] === '0123' && s[0][9] === 'zamanında' && s[0][10] === 1 && s[0][14] === '8-A' && s[0][16] === 'istemci' && s[0][18] === 'Deneme Öğrenci' &&
      sh.v[0].join() === 'sunucu_zamani,kod,test_slug,numara,ad_soyad,dogru,yanlis,bos,puan,durum,deneme_no,cevaplar,istemci_sure_ms,gonderim_id,sinif_sube,sure_sunucu_ms,puan_kaynagi,isaretler,yazilan_ad' &&
      sh.bicim['2:4'] === '@' && sh.bicim['2:15'] === '@';
  }],
  ['sınıf/şube yazımları 8-A biçimine çevrilir; geçersiz ya da eksikse boş kalır ama sonuç kaybolmaz', () => {
    const o = standart();
    o.sayfalar['Ödevler'].v[1][4] = ''; // ödev şubeye bağlı değil: her yazım denenir (şube dışı kuralı S2 vakasında)
    const giris = ['8-A', '8a', ' 8 b ', '8/c', '7.D', '12-i', '8-ş', '13-A', '0-A', '8-AB', 'A-8', '', null, 8, undefined];
    const r = giris.map((x, i) => o.post(govde(Object.assign({numara: String(100 + i)}, x === undefined ? {} : {sinif_sube: x}))));
    const s = o.sonuclar().map(x => x[14]);
    return r.every(x => x.ok) && s.join('|') === '8-A|8-A|8-B|8-C|7-D|12-İ|8-Ş||||||||';
  }],
  ['yalnız ilk deneme kaydedilir: aynı kişi (ad büyük/küçük harf, boşluk farkıyla) ikinci kez → kaydedilmedi, tek satır', () => {
    const o = standart();
    const a = o.post(govde());
    const r = o.post(govde({kod: 'acik1', ad_soyad: 'DENEME   öğrenci', puan: 99}));
    return a.ok && !a.kaydedilmedi && r.ok && r.kaydedilmedi === true && r.deneme_no === 2 && o.sonuclar().length === 1 &&
      o.sonuclar()[0][8] === 25.3;
  }],
  ['aynı numarayı yazan başka biri (başka ad) kaydedilir, deneme 2', () => {
    const o = standart();
    o.post(govde());
    const r = o.post(govde({ad_soyad: 'Başka Öğrenci'}));
    return r.ok && !r.kaydedilmedi && r.deneme_no === 2 && o.sonuclar().length === 2 && o.sonuclar()[1][10] === 2;
  }],
  ['doGet numara + ad ile sorulunca daha önce çözdüyse onceki: true', () => {
    const o = standart();
    const once = o.get({odev: 'ACIK1', numara: '0123', ad: 'Deneme Öğrenci'});
    o.post(govde());
    const sonra = o.get({odev: 'acik1', numara: '0123', ad: 'deneme  ÖĞRENCİ'});
    const baskasi = o.get({odev: 'ACIK1', numara: '0124', ad: 'Deneme Öğrenci'});
    const sorusuz = o.get({odev: 'ACIK1'});
    return once.onceki === false && sonra.onceki === true && baskasi.onceki === false && !('onceki' in sorusuz);
  }],
  ['POST başka numara → deneme 1', () => {
    const o = standart();
    o.post(govde());
    const r = o.post(govde({numara: '77'}));
    return r.ok && r.deneme_no === 1;
  }],
  ['POST aynı gonderim_id tekrar → yeni satır yok, ilk kayıt döner', () => {
    const o = standart();
    const g = govde();
    const a = o.post(g), b = o.post(g);
    return a.ok && b.ok && b.tekrar === true && b.deneme_no === 1 && o.sonuclar().length === 1;
  }],
  ['POST süresi geçmiş → "süre dışı" ama kaydedilir', () => {
    const o = standart();
    const r = o.post(govde({kod: 'GECTI'}));
    return r.ok && r.durum === 'süre dışı' && o.sonuclar().length === 1 && o.sonuclar()[0][9] === 'süre dışı';
  }],
  ['POST henüz açılmamış → "süre dışı" ama kaydedilir', () => {
    const o = standart();
    const r = o.post(govde({kod: 'GELECEK', test_slug: 'odd-one-out-7'}));
    return r.ok && r.durum === 'süre dışı' && o.sonuclar().length === 1;
  }],
  ['POST bilinmeyen kod → reddedilir (kalıcı), kaydedilmez', () => {
    const o = standart();
    const r = o.post(govde({kod: 'YOK'}));
    return r.ok === false && r.hata === 'bilinmeyen_kod' && r.kalici === true && o.sonuclar().length === 0;
  }],
  ['POST test uyuşmuyor → reddedilir, kaydedilmez', () => {
    const o = standart();
    const r = o.post(govde({test_slug: 'odd-one-out-7'}));
    return r.ok === false && r.hata === 'test_uyusmuyor' && r.kalici && o.sonuclar().length === 0;
  }],
  ['POST bozuk JSON / eksik alan / harfli numara / kısa ad → gecersiz', () => {
    const o = standart();
    const hepsi = [o.post('{"kod":'), o.post(govde({numara: undefined})), o.post(govde({numara: '12a'})),
      o.post(govde({ad_soyad: ' x '})), o.post(govde({dogru: -1})), o.post(govde({gonderim_id: 'kısa'})), o.post('[]')];
    return hepsi.every(r => r.ok === false && r.hata === 'gecersiz' && r.kalici) && o.sonuclar().length === 0;
  }],
  ['POST formül enjeksiyonu → düz metin olarak yazılır', () => {
    const o = standart();
    o.post(govde({ad_soyad: '=HYPERLINK("http://x","tıkla")'}));
    return o.sonuclar()[0][4] === '\'=HYPERLINK("http://x","tıkla")';
  }],
  ['POST ad soyad boşlukları sadeleşir', () => {
    const o = standart();
    o.post(govde({ad_soyad: '  Ada   Nur  Yıldız '}));
    return o.sonuclar()[0][4] === 'Ada Nur Yıldız';
  }],
  ['POST kilit alınamazsa → mesgul (geçici), kaydedilmez', () => {
    const o = ortam({kilit: false});
    o.odev(['ACIK1', 'ingilizce-8', once, sonra, '', '']);
    const r = o.post(govde());
    return r.ok === false && r.hata === 'mesgul' && !r.kalici && o.sonuclar().length === 0;
  }],
  ['kurulum() iki sekmeyi başlıklarıyla açar', () => {
    const o = ortam();
    o.ctx.kurulum();
    return o.sayfalar['Ödevler'].v[0].join() === 'kod,test_slug,baslangic,bitis,sinif,not' &&
      o.sayfalar['Sonuçlar'].v[0].length === 19;
  }],
  ['eski Sonuçlar sekmesine (13 sütun) gonderim_id başlığı eklenir', () => {
    const o = standart();
    const sh = o.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet('Sonuçlar');
    sh.v = [['sunucu_zamani', 'kod', 'test_slug', 'numara', 'ad_soyad', 'dogru', 'yanlis', 'bos', 'puan', 'durum', 'deneme_no', 'cevaplar', 'istemci_sure_ms']];
    const r = o.post(govde());
    return r.ok && sh.v[0][13] === 'gonderim_id' && sh.v[0][14] === 'sinif_sube' && sh.v.length === 2;
  }],
  ['eski Sonuçlar sekmesine (14 sütun) sinif_sube başlığı eklenir; eski satırlar sıralamada sınıfsız görünür', () => {
    const o = standart();
    o.sayfalar['Ödevler'].v[1][4] = ''; // ödev şubeye bağlı değil: her yazım denenir (şube dışı kuralı S2 vakasında)
    const sh = o.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet('Sonuçlar');
    sh.v = [['sunucu_zamani', 'kod', 'test_slug', 'numara', 'ad_soyad', 'dogru', 'yanlis', 'bos', 'puan', 'durum', 'deneme_no', 'cevaplar', 'istemci_sure_ms', 'gonderim_id'],
      [new Date(simdi - 1000), 'ACIK1', 'ingilizce-8', '5', 'Eski Satır', 8, 2, 0, 80, 'zamanında', 1, '', 60000, 'eski-satir-0001']];
    const r = o.post(govde({numara: '6', ad_soyad: 'Yeni Satır', dogru: 9, puan: 90, sinif_sube: '8-B'}));
    const m = o.ctx.siralamaHazirla_('ACIK1').metin;
    return r.ok && sh.v[0][14] === 'sinif_sube' && sh.v[0][13] === 'gonderim_id' && sh.v.length === 3 &&
      m.includes('🥇 Yeni Satır (8-B) — 90 puan') && m.includes('🥇 Eski Satır — 80 puan'); // şubesizler ayrı blok: sıra orada 1'den
  }]
];

/* ---------- Sıralama ---------- */
// Sıralama için sonuç tablosu: aynı ödevde birkaç öğrenci, tekrar denemeler, süre dışı, başka ödev.
function siralamaOrtami(istem) {
  const o = ortam({istem});
  o.odev(['ACIK1', 'ingilizce-8', once, sonra, '8-A, 8-B', ''], ['GECTI', 'ingilizce-8', new Date(simdi - 3 * GUN), new Date(simdi - 2 * GUN), '', '']);
  const g = (numara, ad, dogru, puan, sure, ek = {}) => o.post(govde(Object.assign({numara, ad_soyad: ad, dogru, yanlis: 10 - dogru, bos: 0, puan, istemci_sure_ms: sure}, ek)));
  g('11', 'Ayşe Yılmaz', 8, 80, 90000);
  g('12', 'Ali Veli', 9, 90, 120000);
  g('11', 'Ayşe Yılmaz', 10, 100, 60000);       // 2. deneme: sayılmamalı
  g('13', 'Can Demir', 8, 80, 70000, {sinif_sube: '8 b'}); // Ayşe ile eşit puan, daha hızlı → önde; sınıfını yazmış
  g('14', '=Kötü Ad', 5, 50, 100000);           // formül gibi başlayan ad
  g('99', 'Başka Ödev', 10, 100, 1000, {kod: 'GECTI'}); // süre dışı, başka kod
  return o;
}
VAKALAR.push(
  ['onOpen() tabloya "Altı Saniye > Sıralama oluştur" menüsü ekler', () => {
    const o = ortam();
    o.ctx.onOpen();
    return o.ui.menuler.length === 1 && o.ui.menuler[0].ad === 'Altı Saniye' &&
      o.ui.menuler[0].ogeler[0][0] === 'Sıralama oluştur' && o.ui.menuler[0].ogeler[0][1] === 'siralamaMenusu';
  }],
  ['sıralama: ilk deneme sayılır, puan ↓, eşitlikte hızlı olan önde, başka ödev yok, şube şube', () => {
    const s = siralamaOrtami().ctx.siralamaHazirla_('acik1');
    return s.satirlar.map(x => x.numara).join() === '13,12,11,14' && s.satirlar[2].puan === 80; // şube şube: 8-B (13), sonra şubesizler (12,11,14)
  }],
  ['sıralama: tek şubeli ödevde sekme eski biçimde: 1. satır WhatsApp metni, 2. satır bilgi, sonra tablo', () => {
    const o = siralamaOrtami();
    o.post(govde({kod: 'GECTI', numara: '97', ad_soyad: 'İkinci Kişi', puan: 40, dogru: 4}));
    const s = o.ctx.siralamaHazirla_('gecti');
    const sh = o.sayfalar['Sıralama GECTI'];
    const v = sh.v;
    return s.subeler.length === 1 && s.subeler[0].sube === '' && s.subeler[0].metin === s.metin && s.sekme === 'Sıralama GECTI' &&
      v[0][0] === s.metin && v[0][0].startsWith('🏆 ') && !s.metin.includes('Şube yazılmamış') &&
      /^↑ Üstteki metni WhatsApp'a yapıştır.*GECTI · ingilizce-8 · güncellendi: \d\d\.\d\d\.\d{4} \d\d:\d\d/.test(v[1][0]) &&
      v[2].join() === 'sira,ad_soyad,sinif_sube,numara,puan,dogru,yanlis,bos,sure,durum' &&
      v[3].join() === '1,Başka Ödev,,99,100,10,0,0,0:01,süre dışı' && v[4][0] === 2 && v.length === 5 &&
      JSON.stringify(sh.birlesik) === '[[1,1,1,10],[2,1,1,10]]' && sh.yukseklik[1] === 21 * s.metin.split('\n').length + 8;
  }],
  ['sıralama: çok şubeli ödevde sekme şube şube bloklar: her bloğun üstünde o şubenin metni, sıra her şubede 1\'den, şubesizler sonda', () => {
    const o = siralamaOrtami();
    o.post(govde({numara: '21', ad_soyad: 'Mert Aslan', dogru: 7, puan: 70, sinif_sube: '8-A', istemci_sure_ms: 80000}));
    o.post(govde({numara: '22', ad_soyad: 'Elif Şen', dogru: 9, puan: 90, sinif_sube: '8-A', istemci_sure_ms: 90000}));
    o.post(govde({numara: '23', ad_soyad: 'Zeynep Kara', dogru: 8, puan: 85, sinif_sube: '8-b', istemci_sure_ms: 95000}));
    const s = o.ctx.siralamaHazirla_('ACIK1');
    const sh = o.sayfalar['Sıralama ACIK1'], v = sh.v;
    const [a, b, yok] = s.subeler;
    return s.subeler.map(x => x.sube).join('|') === '8-A|8-B|' &&
      a.satirlar.map(x => x.ad + x.sira).join() === 'Elif Şen1,Mert Aslan2' && b.satirlar.map(x => x.ad + x.sira).join() === 'Zeynep Kara1,Can Demir2' &&
      yok.satirlar.map(x => x.sira).join() === '1,2,3' &&
      a.metin.split('\n')[0] === '🏆 Ödev sıralaması · ingilizce-8 · 8-A' && a.metin.includes('🥇 Elif Şen (8-A) — 90') && !a.metin.includes('Zeynep') &&
      b.metin.includes('🥇 Zeynep Kara (8-B) — 85') && b.metin.includes('🥈 Can Demir (8-B) — 80') && b.metin.includes('2 öğrenci katıldı.') &&
      yok.metin.split('\n')[0] === '🏆 Ödev sıralaması · ingilizce-8 · Şube yazılmamış' && yok.metin.includes('🥇 Ali Veli — 90') &&
      s.satirlar.map(x => x.sira).join() === '1,2,1,2,1,2,3' && s.metin === a.metin + '\n\n' + b.metin + '\n\n' + yok.metin &&
      // sayfa: blok başına metin (birleşik, sarılı), bilgi yalnız ilk bloktan sonra, bloklar boş satırla ayrılı
      v[0][0] === a.metin && /^↑ Her şubenin kendi bloğunun üstündeki metni.*güncellendi/.test(v[1][0]) && v[2][0] === 'sira' &&
      v[3].join().startsWith('1,Elif Şen,8-A,22,90,9,') && v[3][8] === '1:30' && v[5].every(h => h === '') && v[6][0] === b.metin && v[7][0] === 'sira' &&
      v[8][1] === 'Zeynep Kara' && v[11][0] === yok.metin && v[13][0] === 1 && v.length === 16 && v[15][1] === "'=Kötü Ad" && // formül enjeksiyonu kaçışı
      JSON.stringify(sh.birlesik) === '[[1,1,1,10],[2,1,1,10],[7,1,1,10],[12,1,1,10]]' &&
      sh.yukseklik[7] === 21 * b.metin.split('\n').length + 8;
  }],
  ['sıralama: her ödevin kendi sekmesi olur, biri ötekini ezmez', () => {
    const o = siralamaOrtami();
    o.ctx.siralamaHazirla_('ACIK1');
    o.ctx.siralamaHazirla_('GECTI');
    return o.sayfalar['Sıralama ACIK1'].v.length === 10 && o.sayfalar['Sıralama GECTI'].v[3][1] === 'Başka Ödev';
  }],
  ['sıralama: yeniden oluşturunca eski satırlar kalmaz (sonuç silinirse tablo kısalır)', () => {
    const o = siralamaOrtami();
    o.ctx.siralamaHazirla_('ACIK1');
    const sonuc = o.sayfalar['Sonuçlar'];
    sonuc.v = sonuc.v.filter(r => r[4] !== 'Can Demir');
    o.ctx.siralamaHazirla_('ACIK1');
    return o.sayfalar['Sıralama ACIK1'].v.length === 6;
  }],
  ['zamanlayıcı: son 7 günde sonucu gelen her ödevi yeniler, eskileri yenilemez', () => {
    const o = siralamaOrtami();
    const sonuc = o.sayfalar['Sonuçlar'];
    sonuc.v.forEach((r, i) => { if (i > 0 && r[1] === 'GECTI') r[0] = new Date(simdi - 8 * GUN); });
    const n = o.ctx.siralamalariGuncelle();
    return n === 1 && !!o.sayfalar['Sıralama ACIK1'] && !o.sayfalar['Sıralama GECTI'];
  }],
  ['zamanlayıcı: hiç sonuç yokken sessizce 0 döner', () => {
    const o = ortam();
    return o.ctx.siralamalariGuncelle() === 0;
  }],
  ['kurulum() 5 dakikalık zamanlayıcıyı kurar; ikinci kez çalıştırınca tek zamanlayıcı kalır', () => {
    const o = siralamaOrtami();
    o.ctx.kurulum();
    o.ctx.kurulum();
    return o.tetikler.length === 1 && o.tetikler[0].f === 'siralamalariGuncelle' && o.tetikler[0].dk === 5 &&
      !!o.sayfalar['Sıralama ACIK1'];
  }],
  ['sıralama: WhatsApp metni madalyalı, tam ad, puan, doğru/yanlış sayısı, katılımcı sayısı (her şube kendi metni)', () => {
    const s = siralamaOrtami().ctx.siralamaHazirla_('ACIK1'), sb = s.subeler[0].metin.split('\n'), yok = s.subeler[1].metin.split('\n');
    return sb[0] === '🏆 Ödev sıralaması · ingilizce-8 · 8-B' && sb[3] === '🥇 Can Demir (8-B) — 80 puan · 8 doğru, 2 yanlış' && sb[sb.length - 1] === '1 öğrenci katıldı.' &&
      yok[0] === '🏆 Ödev sıralaması · ingilizce-8 · Şube yazılmamış' && yok[3] === '🥇 Ali Veli — 90 puan · 9 doğru, 1 yanlış' &&
      yok[4] === '🥈 Ayşe Yılmaz — 80 puan · 8 doğru, 2 yanlış' && yok[5].startsWith('🥉 ') && yok[yok.length - 1] === '3 öğrenci katıldı.';
  }],
  ['sıralama: tek şubeli ödevde (hepsi şubesiz) metin eski gibi: başlıkta ödevin şubesi, tek blok', () => {
    const o = siralamaOrtami();
    o.sayfalar['Sonuçlar'].v = o.sayfalar['Sonuçlar'].v.filter(r => r[4] !== 'Can Demir');
    const s = o.ctx.siralamaHazirla_('ACIK1'), m = s.metin.split('\n');
    return s.subeler.length === 1 && m[0] === '🏆 Ödev sıralaması · ingilizce-8 · 8-A, 8-B' && m[3] === '🥇 Ali Veli — 90 puan · 9 doğru, 1 yanlış' &&
      m[4] === '🥈 Ayşe Yılmaz — 80 puan · 8 doğru, 2 yanlış' && m[m.length - 1] === '3 öğrenci katıldı.';
  }],
  ['sıralama: süre dışı sonuç listede, işaretli; ondalık puan virgüllü; boş yalnız varsa yazılır', () => {
    const o = siralamaOrtami();
    o.post(govde({kod: 'GECTI', numara: '98', ad_soyad: 'Geç Kalan', puan: 63.3, dogru: 7}));
    const m = o.ctx.siralamaHazirla_('GECTI').metin;
    return m.includes('🥇 Başka Ödev — 100 puan · 10 doğru, 0 yanlış (süre dışı)') &&
      m.includes('🥈 Geç Kalan — 63,3 puan · 7 doğru, 8 yanlış, 8 boş (süre dışı)');
  }],
  ['sıralama: aynı numarayı yazan iki farklı kişi ayrı sıralanır', () => {
    const o = siralamaOrtami();
    o.post(govde({numara: '12', ad_soyad: 'Zeynep Kaya', dogru: 7, puan: 70, istemci_sure_ms: 50000}));
    const s = o.ctx.siralamaHazirla_('ACIK1');
    return s.satirlar.length === 5 && s.satirlar.some(x => x.ad === 'Zeynep Kaya') &&
      s.satirlar.filter(x => x.numara === '12').map(x => x.ad).join() === 'Ali Veli,Zeynep Kaya';
  }],
  ['sıralama: aynı kişi büyük/küçük harf ya da boşluk farkıyla yeniden çözerse yine ilk deneme sayılır', () => {
    const o = siralamaOrtami();
    o.post(govde({numara: '11', ad_soyad: 'AYŞE  yılmaz', dogru: 10, puan: 100, istemci_sure_ms: 30000}));
    const s = o.ctx.siralamaHazirla_('ACIK1');
    const ayse = s.satirlar.filter(x => x.numara === '11');
    return ayse.length === 1 && ayse[0].puan === 80 && ayse[0].ad === 'Ayşe Yılmaz';
  }],
  ['sıralama: sonucu olmayan kod → boş liste', () => siralamaOrtami().ctx.siralamaHazirla_('YOK').satirlar.length === 0],
  ['menü: kod sorulur, metin kopyalanabilir pencerede gösterilir (HTML kaçışlı)', () => {
    const o = siralamaOrtami('acik1');
    o.post(govde({numara: '15', ad_soyad: 'Ece <b>Kaya</b>', puan: 10, dogru: 1}));
    o.ctx.siralamaMenusu();
    const d = o.ui.diyaloglar[0];
    return o.ui.diyaloglar.length === 1 && d.baslik === 'WhatsApp sıralama metni' &&
      d.html.includes('🥇 Ali Veli — 90') && d.html.includes('Kopyala') &&
      d.html.includes('Ece &lt;b&gt;Kaya&lt;/b&gt;') && !d.html.includes('<b>Kaya') && d.html.includes('"Sıralama ACIK1" sekmesi');
  }],
  ['menü: çok şubeli ödevde her şubenin metni AYRI kutuda ve ayrı Kopyala düğmesiyle; hiçbir kutu iki şubenin adını birlikte taşımaz', () => {
    const o = siralamaOrtami('acik1');
    o.post(govde({numara: '15', ad_soyad: 'Ece <b>Kaya</b>', puan: 10, dogru: 1, sinif_sube: '8-A'}));
    o.ctx.siralamaMenusu();
    const h = o.ui.diyaloglar[0].html;
    const kutular = [...h.matchAll(/<textarea[^>]*>([\s\S]*?)<\/textarea>/g)].map(m => m[1]);
    const ad = ['Ece &lt;b&gt;Kaya', 'Can Demir', 'Ali Veli']; // 8-A, 8-B, şubesiz
    return kutular.length === 3 && (h.match(/>Kopyala</g) || []).length === 3 && new Set(kutular.map(k => ad.findIndex(a => k.includes(a)))).size === 3 &&
      kutular.every(k => ad.filter(a => k.includes(a)).length === 1) && h.includes('8-A grubu için') && h.includes('Şube yazılmamış grubu için') &&
      !h.includes('<b>Kaya') && /id="t2"/.test(h);
  }],
  ['sıralama: ödevin iki şubesinden yalnız biri çözmüşse başlık o şubenin adını taşır (sayfayla aynı kural)', () => {
    const o = ortam();
    o.odev(['IKI1', 'ingilizce-8', once, sonra, '8-A, 8-B', '']);
    o.post(govde({kod: 'IKI1', numara: '41', ad_soyad: 'Tek Şube', dogru: 9, puan: 90, sinif_sube: '8-B'}));
    const m = o.ctx.siralamaHazirla_('IKI1').metin.split('\n');
    return m[0] === '🏆 Ödev sıralaması · ingilizce-8 · 8-B' && m[3].startsWith('🥇 Tek Şube (8-B) — 90 puan');
  }],
  ['menü: tek şubeli ödevde tek kutu, tek Kopyala (bugünkü görünüm)', () => {
    const o = siralamaOrtami('gecti');
    o.ctx.siralamaMenusu();
    const h = o.ui.diyaloglar[0].html;
    return (h.match(/<textarea/g) || []).length === 1 && (h.match(/>Kopyala</g) || []).length === 1 && !h.includes('grubu için');
  }],
  ['sıralama sekmesi: bloklar kayınca eski birleştirme ve satır yüksekliği kalmaz (clear() ayırmaz)', () => {
    const o = siralamaOrtami();
    o.ctx.siralamaHazirla_('ACIK1');
    const sh = o.sayfalar['Sıralama ACIK1'];
    const once = JSON.stringify(sh.birlesik);
    // 8-B büyür: şubesiz bloğun metin satırı aşağı kayar
    o.post(govde({numara: '31', ad_soyad: 'Ada Bir', dogru: 6, puan: 60, sinif_sube: '8-B'}));
    o.post(govde({numara: '32', ad_soyad: 'Bora İki', dogru: 5, puan: 50, sinif_sube: '8-B'}));
    o.post(govde({numara: '33', ad_soyad: 'Ceren Üç', dogru: 4, puan: 40, sinif_sube: '8-B'}));
    o.ctx.siralamaHazirla_('ACIK1');
    const v = sh.v, metinSatir = v.map((r, i) => /^(🏆 |↑ )/.test(String(r[0])) ? i + 1 : 0).filter(Boolean);
    const yuk = Object.keys(sh.yukseklik).map(Number);
    return once !== JSON.stringify(sh.birlesik) && sh.birlesik.length === 3 && sh.birlesik.every(m => metinSatir.includes(m[0])) &&
      yuk.filter(r => !metinSatir.includes(r) && sh.yukseklik[r] !== 21).length === 0 && metinSatir.filter(r => sh.yukseklik[r] > 21).length === 2 &&
      v.length === 13 && v[10][1] === 'Ali Veli' && !sh.birlesik.some(m => m[0] === 6);
  }],
  ['menü: sonucu olmayan kodda uyarı, pencere yok; iptalde hiçbir şey olmaz', () => {
    const a = siralamaOrtami('YOK');
    a.ctx.siralamaMenusu();
    const b = siralamaOrtami(null);
    b.ctx.siralamaMenusu();
    return a.ui.uyarilar.length === 1 && a.ui.uyarilar[0].includes('henüz sonuç yok') && a.ui.diyaloglar.length === 0 &&
      b.ui.uyarilar.length === 0 && b.ui.diyaloglar.length === 0 && !Object.keys(b.sayfalar).some(k => k.startsWith('Sıralama')) &&
      !Object.keys(a.sayfalar).some(k => k.startsWith('Sıralama'));
  }]
);

/* ---------- Öğretmen paneli ---------- */
const ANAHTAR = 'a'.repeat(64);
function panelOrtami() {
  const o = siralamaOrtami();
  o.ozellikler.OGRETMEN_ANAHTARI = ANAHTAR;
  o.panel = (islem, ek = {}) => o.post(Object.assign({islem, anahtar: ANAHTAR}, ek));
  return o;
}
const gelecek = () => { const d = new Date(simdi + 5 * GUN); return d.toISOString().slice(0, 10) + ' 23:59'; };
VAKALAR.push(
  ['panel: anahtarsız / yanlış anahtar / anahtar kurulmamış → yetkisiz, hiçbir şey yazılmaz', () => {
    const o = panelOrtami();
    const once = o.sayfalar['Ödevler'].v.length;
    const a = o.post({islem: 'odevler'});
    const b = o.post({islem: 'odev_ekle', anahtar: 'b'.repeat(64), test_slug: 'ingilizce-8', bitis: gelecek()});
    const c = siralamaOrtami().post({islem: 'odevler', anahtar: ''});
    return [a, b, c].every(r => r.ok === false && r.hata === 'yetkisiz') && o.sayfalar['Ödevler'].v.length === once;
  }],
  ['panel: öğrenci gönderimi panel yolundan etkilenmez (islem alanı yok)', () => {
    const o = panelOrtami();
    const r = o.post(govde({numara: '44', ad_soyad: 'Yeni Öğrenci'}));
    return r.ok && r.durum === 'zamanında';
  }],
  ['panel: odev_ekle → 6 harfli benzersiz kod, Ödevler\'e satır (tarih e-tablo saat diliminde, günün sonu)', () => {
    const o = panelOrtami();
    const g = gelecek();
    const r = o.panel('odev_ekle', {test_slug: 'ingilizce-8-friendship', bitis: g, sinif: ' 8-A '});
    const v = o.sayfalar['Ödevler'].v;
    const son = v[v.length - 1];
    const beklenen = new Date(Date.UTC(+g.slice(0, 4), +g.slice(5, 7) - 1, +g.slice(8, 10), 23, 59) - 180 * 6e4);
    return r.ok && /^[A-HJ-NP-Z2-9]{6}$/.test(r.kod) && son[0] === r.kod && son[1] === 'ingilizce-8-friendship' &&
      son[2] === '' && son[3].getTime() === beklenen.getTime() && son[4] === '8-A' && r.bitis === beklenen.toISOString() &&
      o.sayfalar['Ödevler'].bicim[v.length + ':1'] === '@' && o.get({odev: r.kod}).acik === true;
  }],
  ['panel: odev_ekle geçmiş tarih / bozuk tarih / bozuk test adı → reddedilir', () => {
    const o = panelOrtami();
    const once = o.sayfalar['Ödevler'].v.length;
    const r = [o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: '2020-01-01 10:00'}),
      o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: 'yarın'}),
      o.panel('odev_ekle', {test_slug: '../x', bitis: gelecek()})];
    return r[0].hata === 'gecmis_tarih' && r[1].hata === 'gecersiz' && r[2].hata === 'gecersiz' &&
      o.sayfalar['Ödevler'].v.length === once;
  }],
  ['panel: art arda eklenen ödevlerin kodları farklı', () => {
    const o = panelOrtami();
    const k = new Set();
    for (let i = 0; i < 20; i++) k.add(o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: gelecek()}).kod);
    return k.size === 20;
  }],
  ['panel: odevler → en yeni üstte, test, bitiş, katılan öğrenci sayısı', () => {
    const o = panelOrtami();
    const yeni = o.panel('odev_ekle', {test_slug: 'ingilizce-8-teen-life', bitis: gelecek(), sinif: '8-B'});
    const r = o.panel('odevler');
    const ilk = r.odevler[0], acik = r.odevler.find(x => x.kod === 'ACIK1');
    return r.ok && ilk.kod === yeni.kod && ilk.test_slug === 'ingilizce-8-teen-life' && ilk.sinif === '8-B' &&
      ilk.katilan === 0 && ilk.bitis === yeni.bitis && acik.katilan === 4 && acik.sinif === '8-A, 8-B';
  }],
  ['panel: siralama → WhatsApp metni ve satırlar; sonuçsuz ödevde boş metin', () => {
    const o = panelOrtami();
    const r = o.panel('siralama', {kod: 'acik1'});
    const bos = o.panel('siralama', {kod: 'GELECEK'});
    const ali = r.satirlar.find(x => x.ad === 'Ali Veli');
    return r.ok && r.katilan === 4 && r.metin.startsWith('🏆 ') && r.metin.includes('🥇 Ali Veli — 90') &&
      r.satirlar[0].sinif === '8-B' && r.satirlar[1].ad === 'Ali Veli' && r.satirlar[1].sinif === '' && ali.dogru === 9 && ali.yanlis === 1 &&
      ali.bos === 0 && bos.ok && bos.katilan === 0 && bos.metin === '' && r.metin.includes('🥇 Can Demir (8-B) — 80') && !('subeler' in r) && !('sira' in ali);
  }],
  ['kurulum: öğretmen anahtarı bir kez üretilir, ikinci kurulumda değişmez; anahtariYenile değiştirir', () => {
    const o = siralamaOrtami();
    o.ctx.kurulum();
    const a = o.ozellikler.OGRETMEN_ANAHTARI;
    o.ctx.kurulum();
    const b = o.ozellikler.OGRETMEN_ANAHTARI;
    const link = o.ctx.anahtariYenile();
    const c = o.ozellikler.OGRETMEN_ANAHTARI;
    return /^[0-9a-f]{40,}$/.test(a) && a === b && c !== a && link.endsWith('index.html?panel#' + c) &&
      o.ctx.ogretmenLinki() === link;
  }]
);

/* ---------- Öğretmenin kendi testleri ---------- */
const soruK = (i, ek = {}) => Object.assign({q: `Question ${i} is _____?`, o: ['one ' + i, 'two', 'three', 'four'], a: i % 4, tr: 'açıklama'}, ek);
const testK = (n = 6, ek = {}) => Object.assign({ad: 'Unit 6: Adventures!', sorular: Array.from({length: n}, (_, i) => soruK(i))}, ek);
VAKALAR.push(
  ['özel test: test_ekle → "ozel-" adlı kayıt, Testler sekmesine satır', () => {
    const o = panelOrtami();
    const r = o.panel('test_ekle', testK());
    const v = o.sayfalar['Testler'].v;
    const icerik = JSON.parse(v[1][4]);
    return r.ok && /^ozel-unit-6-adventures-[a-hj-np-z2-9]{4}$/.test(r.test_slug) && r.n === 6 &&
      v[0].join() === 'test_slug,ad,soru_sayisi,olusturma,icerik' && v[1][0] === r.test_slug &&
      v[1][1] === 'Unit 6: Adventures!' && v[1][2] === 6 && icerik.sorular.length === 6 && icerik.sorular[1].a === 1;
  }],
  ['özel test: anahtarsız test_ekle → yetkisiz, kayıt yok', () => {
    const o = panelOrtami();
    const r = o.post(Object.assign({islem: 'test_ekle', anahtar: 'x'.repeat(64)}, testK()));
    return r.hata === 'yetkisiz' && !o.sayfalar['Testler'];
  }],
  ['özel test: bozuk testler reddedilir (az soru, 3 şık, aynı şık, a=4, adsız)', () => {
    const o = panelOrtami();
    const bozuk = [testK(4), testK(6, {sorular: [soruK(0, {o: ['a', 'b', 'c']}), ...Array.from({length: 5}, (_, i) => soruK(i))]}),
      testK(6, {sorular: [soruK(0, {o: ['a', 'A ', 'c', 'd']}), ...Array.from({length: 5}, (_, i) => soruK(i))]}),
      testK(6, {sorular: [soruK(0, {a: 4}), ...Array.from({length: 5}, (_, i) => soruK(i))]}), testK(6, {ad: '  '})];
    const r = bozuk.map(t => o.panel('test_ekle', t));
    return r.every(x => x.ok === false && x.kalici) && r[0].hata === 'soru_sayisi' && r[1].no === 1 && r[4].hata === 'ad' &&
      !(o.sayfalar['Testler'] && o.sayfalar['Testler'].v.length > 1);
  }],
  ['özel test: odevler yanıtında testler listesi (en yeni üstte)', () => {
    const o = panelOrtami();
    const a = o.panel('test_ekle', testK(6, {ad: 'Birinci'})), b = o.panel('test_ekle', testK(7, {ad: 'İkinci Şık'}));
    const t = o.panel('odevler').testler;
    return t.length === 2 && t[0].slug === b.test_slug && t[0].ad === 'İkinci Şık' && t[0].n === 7 &&
      /^ozel-ikinci-sik-/.test(b.test_slug) && t[1].slug === a.test_slug;
  }],
  ['özel test: ödev bu testle verilince doGet testi de döndürür; öğrenci sonucu kaydedilir', () => {
    const o = panelOrtami();
    const t = o.panel('test_ekle', testK(6));
    const od = o.panel('odev_ekle', {test_slug: t.test_slug, bitis: gelecek()});
    const g = o.get({odev: od.kod});
    const k = o.post(govde({kod: od.kod, test_slug: t.test_slug, cevaplar: '1A 2B 3C 4D 5A 6B'}));
    const hazir = o.get({odev: 'ACIK1'});
    return g.gecerli && g.acik && g.test_slug === t.test_slug && g.test.sorular.length === 6 && g.test.ad === 'Unit 6: Adventures!' &&
      k.ok && k.durum === 'zamanında' && !('test' in hazir);
  }],
  ['onaylı hazır test: kaynak ve kategori saklanır; listede yalnız en yeni onay görünür, ChatGPT testleri etkilenmez', () => {
    const o = panelOrtami();
    const kendi = o.panel('test_ekle', testK(6, {ad: 'Kendi'}));
    const ilk = o.panel('test_ekle', testK(6, {ad: 'Friendship', kaynak: 'ingilizce-8-friendship'}));
    const baska = o.panel('test_ekle', testK(6, {ad: 'Teen Life', kaynak: 'ingilizce-8-teen-life'}));
    const son = o.panel('test_ekle', testK(5, {ad: 'Friendship', kaynak: 'ingilizce-8-friendship',
      sorular: Array.from({length: 5}, (_, i) => soruK(i, {c: 'Unit 1 · Friendship'}))}));
    const t = o.panel('odevler').testler;
    const icerik = JSON.parse(o.sayfalar['Testler'].v[4][4]);
    return ilk.ok && son.ok && son.kaynak === 'ingilizce-8-friendship' && t.length === 3 &&
      t[0].slug === son.test_slug && t[0].kaynak === 'ingilizce-8-friendship' && t[0].n === 5 &&
      t[1].slug === baska.test_slug && t[2].slug === kendi.test_slug && t[2].kaynak === '' &&
      !t.some(x => x.slug === ilk.test_slug) && icerik.kaynak === 'ingilizce-8-friendship' && icerik.sorular[0].c === 'Unit 1 · Friendship';
  }],
  ['onaylı hazır test: geçersiz kaynak reddedilir (ozel-, boşluk, büyük harf, sayı)', () => {
    const o = panelOrtami();
    const r = ['ozel-abc-1234', 'unit 1', 'Ingilizce', 42].map(k => o.panel('test_ekle', testK(6, {kaynak: k})));
    return r.every(x => x.ok === false && x.hata === 'kaynak' && x.kalici) && !(o.sayfalar['Testler'] && o.sayfalar['Testler'].v.length > 1);
  }],
  ['onaylı hazır test: test_getir kayıtlı testi geri verir; bilinmeyen/hazır slug ve anahtarsız istek reddedilir', () => {
    const o = panelOrtami();
    const k = o.panel('test_ekle', testK(6, {ad: 'Friendship', kaynak: 'ingilizce-8-friendship'}));
    const g = o.panel('test_getir', {slug: k.test_slug});
    const yok = o.panel('test_getir', {slug: 'ozel-olmayan-abcd'}), hazir = o.panel('test_getir', {slug: 'ingilizce-8-friendship'});
    const izinsiz = o.post({islem: 'test_getir', anahtar: 'x'.repeat(64), slug: k.test_slug});
    return g.ok && g.test.sorular.length === 6 && g.test.kaynak === 'ingilizce-8-friendship' && g.test.ad === 'Friendship' &&
      yok.ok === false && yok.hata === 'yok' && hazir.ok === false && izinsiz.hata === 'yetkisiz' && !izinsiz.test;
  }],
  ['onaylı hazır test: ödevde doGet testi kaynağıyla döndürür (sayfa hazır testin görünümünü kullanır)', () => {
    const o = panelOrtami();
    const k = o.panel('test_ekle', testK(6, {ad: 'Friendship', kaynak: 'ingilizce-8-friendship'}));
    const od = o.panel('odev_ekle', {test_slug: k.test_slug, bitis: gelecek()});
    const g = o.get({odev: od.kod});
    return g.gecerli && g.test_slug === k.test_slug && g.test.kaynak === 'ingilizce-8-friendship' && g.test.sorular.length === 6;
  }],
  ['özel test: silinmiş/bozuk test → doGet test alanı olmadan döner (sayfa "test bulunamadı" der)', () => {
    const o = panelOrtami();
    const od = o.panel('odev_ekle', {test_slug: 'ozel-olmayan-abcd', bitis: gelecek()});
    const g = o.get({odev: od.kod});
    return g.gecerli && g.test_slug === 'ozel-olmayan-abcd' && !('test' in g);
  }]
);

/* ---------- Sınıf listesi ve ödev sonuçları ---------- */
const ogr = (numara, ad) => ({numara, ad});
VAKALAR.push(
  ['sınıf listesi: şube şube kaydedilir, yeniden kaydedince yalnız o şube değişir; sıralı, numara metin', () => {
    const o = panelOrtami();
    const a = o.panel('liste_kaydet', {sinif_sube: '8a', ogrenciler: [ogr('12', 'Ali Veli'), ogr('3', 'Ayşe  Yılmaz'), ogr('7', '=Kötü')]});
    const b = o.panel('liste_kaydet', {sinif_sube: '8-B', ogrenciler: [ogr('5', 'Can Demir')]});
    const c = o.panel('liste_kaydet', {sinif_sube: '8 A', ogrenciler: [ogr('12', 'Ali Veli'), ogr('4', 'Ece Kaya')]});
    const v = o.sayfalar['Öğrenciler'].v;
    const ozet = o.panel('odevler').siniflar;
    return a.ok && a.n === 3 && a.sinif === '8-A' && b.ok && c.ok && c.n === 2 &&
      v[0].join() === 'sinif_sube,numara,ad_soyad' && v.length === 4 &&
      v.slice(1).map(r => r.join('/')).join('|') === '8-A/4/Ece Kaya|8-A/12/Ali Veli|8-B/5/Can Demir' &&
      o.sayfalar['Öğrenciler'].bicim['2:2'] === '@' &&
      JSON.stringify(ozet) === '[{"sinif":"8-A","n":2},{"sinif":"8-B","n":1}]' &&
      JSON.stringify(c.siniflar) === JSON.stringify(ozet);
  }],
  ['sınıf listesi: bozuk şube, aynı numara, harfli numara, kısa ad, 80+ öğrenci ve anahtarsız istek reddedilir', () => {
    const o = panelOrtami();
    const iyi = o.panel('liste_kaydet', {sinif_sube: '8-A', ogrenciler: [ogr('1', 'Ali Veli')]});
    const r = [
      o.panel('liste_kaydet', {sinif_sube: 'sekiz', ogrenciler: [ogr('1', 'Ali Veli')]}),
      o.panel('liste_kaydet', {sinif_sube: '8-A', ogrenciler: [ogr('1', 'Ali Veli'), ogr('1', 'Can Demir')]}),
      o.panel('liste_kaydet', {sinif_sube: '8-A', ogrenciler: [ogr('1a', 'Ali Veli')]}),
      o.panel('liste_kaydet', {sinif_sube: '8-A', ogrenciler: [ogr('2', 'A')]}),
      o.panel('liste_kaydet', {sinif_sube: '8-A', ogrenciler: Array.from({length: 81}, (_, i) => ogr(String(i + 1), 'Ad Soyad'))}),
      o.post({islem: 'liste_kaydet', anahtar: 'x'.repeat(64), sinif_sube: '8-A', ogrenciler: []})
    ];
    return iyi.ok && r.slice(0, 5).every(x => x.ok === false && x.kalici) && r[1].no === 2 && r[5].hata === 'yetkisiz' &&
      o.sayfalar['Öğrenciler'].v.length === 2 && o.sayfalar['Öğrenciler'].v[1][2] === 'Ali Veli';
  }],
  ['ödev şubeleri: "8a, 8 b; 8-A" → "8-A, 8-B"; şube olmayan metin eskisi gibi kalır', () => {
    const o = panelOrtami();
    const a = o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: gelecek(), sinif: '8a, 8 b; 8-A'});
    const b = o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: gelecek(), sinif: 'Hazırlık grubu'});
    return a.ok && a.sinif === '8-A, 8-B' && b.ok && b.sinif === 'Hazırlık grubu';
  }],
  ['sonuçlar: ilk denemeler cevaplarıyla (ikinci deneme hiç yazılmaz); ödevin şubelerinin listesi gelir', () => {
    const o = panelOrtami();
    o.panel('liste_kaydet', {sinif_sube: '8-A', ogrenciler: [ogr('11', 'Ayşe Yılmaz'), ogr('20', 'Gelmeyen Öğrenci')]});
    o.panel('liste_kaydet', {sinif_sube: '8-B', ogrenciler: [ogr('13', 'Can Demir')]});
    const r = o.panel('sonuclar', {kod: 'acik1'});
    const ayse = r.sonuclar.find(x => x.numara === '11'), can = r.sonuclar.find(x => x.numara === '13');
    return r.ok && r.odev.kod === 'ACIK1' && r.odev.test_slug === 'ingilizce-8' && r.odev.sinif === '8-A, 8-B' && !!r.odev.bitis &&
      r.sonuclar.length === 4 && ayse.puan === 80 && ayse.sonraki === 0 && ayse.cevaplar === '1B✓ 2C✗ 3-' &&
      can.sinif === '8-B' && can.sonraki === 0 && typeof can.sure === 'number' && !!can.zaman &&
      JSON.stringify(r.subeler) === '["8-A","8-B"]' && r.liste.map(x => x.numara).join() === '11,20,13' && !('test' in r);
  }],
  ['sonuçlar: şubesiz ödevde çözenlerin şubeleri; bilinmeyen kod ve anahtarsız istek reddedilir', () => {
    const o = panelOrtami();
    o.panel('liste_kaydet', {sinif_sube: '8-B', ogrenciler: [ogr('13', 'Can Demir'), ogr('30', 'Yapmayan Biri')]});
    const od = o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: gelecek()});
    o.post(govde({kod: od.kod, numara: '13', ad_soyad: 'Can Demir', sinif_sube: '8-B'}));
    const r = o.panel('sonuclar', {kod: od.kod});
    const yok = o.panel('sonuclar', {kod: 'YOKKOD'});
    const izinsiz = o.post({islem: 'sonuclar', anahtar: 'x'.repeat(64), kod: 'ACIK1'});
    return r.ok && JSON.stringify(r.subeler) === '["8-B"]' && r.liste.length === 2 && r.sonuclar.length === 1 &&
      yok.ok === false && yok.hata === 'yok' && izinsiz.hata === 'yetkisiz' && !izinsiz.sonuclar;
  }],
  ['sonuçlar: öğretmenin kendi testiyle verilen ödevde test içeriği de gelir', () => {
    const o = panelOrtami();
    const t = o.panel('test_ekle', testK(6));
    const od = o.panel('odev_ekle', {test_slug: t.test_slug, bitis: gelecek(), sinif: '8-A'});
    const r = o.panel('sonuclar', {kod: od.kod});
    return r.ok && r.test && r.test.sorular.length === 6 && r.sonuclar.length === 0;
  }]
);

/* ---------- Sözlü notları ---------- */
VAKALAR.push(
  ['karar: yazılır, aynı öğrencide güncellenir (tek satır), "" ile varsayılana döner; bütün ödev "haric"', () => {
    const o = panelOrtami();
    const a = o.panel('karar', {kod: 'acik1', numara: '12', karar: 'ozurlu'});
    const b = o.panel('karar', {kod: 'ACIK1', numara: '12', karar: 'sifir'});
    const c = o.panel('karar', {kod: 'ACIK1', numara: '*', karar: 'haric'});
    const v1 = o.sayfalar['Kararlar'].v.map(r => r.slice(0, 3).join('/'));
    const d = o.panel('karar', {kod: 'ACIK1', numara: '12', karar: ''});
    const e = o.panel('karar', {kod: 'ACIK1', numara: '55', karar: ''}); // olmayan kararı silmek: satır açılmaz
    const v2 = o.sayfalar['Kararlar'].v;
    return a.ok && b.ok && c.ok && d.ok && e.ok && v1.join('|') === 'kod/numara/karar|ACIK1/12/sifir|ACIK1/*/haric' &&
      v2.length === 3 && v2[1][2] === '' && o.sayfalar['Kararlar'].bicim['2:1'] === '@';
  }],
  ['karar: bilinmeyen ödev, bozuk numara, bilinmeyen karar, "*" ile öğrenci kararı, öğrenciye "haric" ve anahtarsız istek reddedilir', () => {
    const o = panelOrtami();
    const r = [
      o.panel('karar', {kod: 'YOK', numara: '12', karar: 'ozurlu'}),
      o.panel('karar', {kod: 'ACIK1', numara: '1a', karar: 'ozurlu'}),
      o.panel('karar', {kod: 'ACIK1', numara: '12', karar: 'yarim'}),
      o.panel('karar', {kod: 'ACIK1', numara: '*', karar: 'ozurlu'}),
      o.panel('karar', {kod: 'ACIK1', numara: '12', karar: 'haric'}),
      o.post({islem: 'karar', anahtar: 'x'.repeat(64), kod: 'ACIK1', numara: '12', karar: 'ozurlu'})
    ];
    return r.slice(0, 5).every(x => x.ok === false && x.kalici) && r[5].hata === 'yetkisiz' &&
      !(o.sayfalar['Kararlar'] && o.sayfalar['Kararlar'].v.length > 1);
  }],
  ['not çizelgesi: şubenin öğrencileri, o şubenin ödevleri, listedeki öğrencilerin ilk denemeleri ve ilgili kararlar', () => {
    const o = panelOrtami();
    o.panel('liste_kaydet', {sinif_sube: '8-A', ogrenciler: [ogr('11', 'Ayşe Yılmaz'), ogr('012', 'Ali Veli'), ogr('20', 'Gelmeyen Öğrenci')]});
    o.panel('liste_kaydet', {sinif_sube: '8-B', ogrenciler: [ogr('13', 'Can Demir')]});
    const ikiSube = o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: gelecek(), sinif: '8-A, 8-B'});
    const sadeceB = o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: gelecek(), sinif: '8-B'});
    const subesiz = o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: gelecek()});
    o.post(govde({kod: subesiz.kod, numara: '11', ad_soyad: 'Ayşe Yılmaz', puan: 55, sinif_sube: '8-A'}));
    o.panel('karar', {kod: 'ACIK1', numara: '20', karar: 'ozurlu'});
    o.panel('karar', {kod: sadeceB.kod, numara: '13', karar: 'sifir'});
    const r = o.panel('notlar', {sinif_sube: '8a'});
    const kodlar = r.odevler.map(x => x.kod);
    const ayse = r.sonuclar.filter(x => x.numara === '11').map(x => x.kod + ':' + x.puan).sort().join();
    return r.ok && r.sube === '8-A' && r.ogrenciler.map(x => x.numara).join() === '11,012,20' &&
      kodlar.includes('ACIK1') && kodlar.includes(ikiSube.kod) && kodlar.includes(subesiz.kod) &&
      !kodlar.includes(sadeceB.kod) && !kodlar.includes('GECTI') &&
      ayse === ['ACIK1:80', subesiz.kod + ':55'].sort().join() &&
      r.sonuclar.some(x => x.numara === '12' && x.kod === 'ACIK1' && x.puan === 90) &&
      !r.sonuclar.some(x => x.numara === '13' || x.numara === '14') &&
      JSON.stringify(r.kararlar) === '[{"kod":"ACIK1","numara":"20","karar":"ozurlu"}]';
  }],
  ['not çizelgesi: bozuk şube ve anahtarsız istek reddedilir', () => {
    const o = panelOrtami();
    const a = o.panel('notlar', {sinif_sube: 'sekiz'});
    const b = o.post({islem: 'notlar', anahtar: 'x'.repeat(64), sinif_sube: '8-A'});
    return a.ok === false && a.hata === 'sinif' && b.hata === 'yetkisiz' && !b.ogrenciler;
  }]
);

VAKALAR.push(
  ['S1: sayfanın puanı yok sayılır, sunucu cevaplardan hesaplar (LGS neti) ve yanıtta anahtarı verir', () => {
    const o = siteli();
    const r = o.post(govde({puan: 9999, dogru: 25, yanlis: 0, bos: 0, cevaplar: cevapMetni(ANAHTAR_25, 'D'.repeat(20) + 'YYY' + 'BB')}));
    const s = o.sonuclar()[0];
    return r.ok && r.dogru === 20 && r.yanlis === 3 && r.bos === 2 && r.puan === 76 && // (20 - 1) / 25 → 76
      s[5] === 20 && s[6] === 3 && s[7] === 2 && s[8] === 76 && s[16] === 'sunucu' &&
      r.anahtar.join() === ANAHTAR_25.join() && r.aciklamalar[0] === 'açıklama 1';
  }],
  ['S1: ✓/✗ işaretleri yok sayılır (yalnız harf); işaretsiz biçim de kabul', () => {
    const o = siteli();
    const yalan = ANAHTAR_25.map((a, i) => (i + 1) + 'ABCD'[(a + 1) % 4] + '✓').join(' '); // hepsi yanlış ama ✓ yazılmış
    const r = o.post(govde({cevaplar: yalan}));
    const r2 = o.post(govde({numara: '77', cevaplar: ANAHTAR_25.map((a, i) => (i + 1) + 'ABCD'[a]).join(' ')}));
    return r.ok && r.dogru === 0 && r.yanlis === 25 && r.puan === 0 && r2.puan === 100;
  }],
  ['S1: bozuk cevaplar (eksik, fazla, tekrar numara, 26. soru, E şıkkı) kesin reddedilir, satır yazılmaz', () => {
    const o = siteli();
    const tam = cevapMetni(ANAHTAR_25, 'D'.repeat(25));
    const kotu = [tam.split(' ').slice(0, 24).join(' '), tam + ' 26A', tam.replace('2B', '1A'), tam.replace(/^1[A-D]/, '26A'), tam.replace(/^1[A-D]/, '1E'), ''];
    return kotu.every(c => { const r = o.post(govde({cevaplar: c})); return r.ok === false && r.hata === 'gecersiz' && r.kalici === true; }) &&
      o.sonuclar().length === 0;
  }],
  ['S1: hazır test siteden bir kez okunur, sonra önbellekten', () => {
    const o = siteli();
    o.post(govde({cevaplar: cevapMetni(ANAHTAR_25, 'D'.repeat(25))}));
    o.post(govde({numara: '5', cevaplar: cevapMetni(ANAHTAR_25, 'D'.repeat(25))}));
    return o.urlIstekleri.length === 1 && /quizler\/ingilizce-8\.json$/.test(o.urlIstekleri[0]);
  }],
  ['S1: site okunamazsa sonuç kaybolmaz: istemci puanı 0-100 arasına kırpılır, puan_kaynagi=istemci', () => {
    const o = ortam(); // site boş → 404
    o.odev(['ACIK1', 'ingilizce-8', once, sonra, '', '']);
    const r = o.post(govde({puan: 9999}));
    const s = o.sonuclar()[0];
    return r.ok && s[8] === 100 && s[16] === 'istemci' && r.anahtar === undefined;
  }]
);
const ozelSorular = n => Array.from({length: n}, (_, i) => ({q: 'Soru ' + (i + 1) + ' ____?', o: ['w' + i, 'x' + i, 'y' + i, 'z' + i], a: (i + 2) % 4, tr: 'tr ' + i}));
VAKALAR.push(
  ['S1: öğretmen testi Testler sekmesinden puanlanır; puanlama:"plain" saygı görür', () => {
    const o = panelOrtami();
    const t = o.panel('test_ekle', {ad: 'Deneme', sorular: ozelSorular(10), puanlama: 'plain'});
    const od = o.panel('odev_ekle', {test_slug: t.test_slug, bitis: gelecek()});
    const anahtar = ozelSorular(10).map(q => q.a), sayi = o.urlIstekleri.length; // panelOrtami kurulumu ingilizce-8 için siteye zaten baktı
    const r = o.post(govde({kod: od.kod, test_slug: t.test_slug, numara: '31', cevaplar: cevapMetni(anahtar, 'DDDDDDDYYB')}));
    return t.ok && r.ok && r.dogru === 7 && r.yanlis === 2 && r.puan === 70 && o.urlIstekleri.length === sayi;
  }]
);

/* ---------- S2: sınıf listesi kapısı ---------- */
const isaret = (s, x) => String(s[17]).split(',').indexOf(x) >= 0;
const listeli = () => {
  const o = panelOrtami();
  o.sayfalar['Sonuçlar'].v.splice(1); // hazır örnek sonuçlar silinir: bu vakalar boş sekmeden başlar
  o.panel('liste_kaydet', {sinif_sube: '8-A', ogrenciler: [ogr('123', 'Ayşe Nur Yılmaz'), ogr('7', 'Ali Veli')]});
  o.panel('liste_kaydet', {sinif_sube: '8-B', ogrenciler: [ogr('9', 'Can Demir')]});
  o.odevA = o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: gelecek(), sinif: '8-A'});
  o.odevAB = o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: gelecek(), sinif: '8-A, 8-B'});
  o.odevSubesiz = o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: gelecek()});
  return o;
};
VAKALAR.push(
  ['S2: listedeki ad kayda girer; ikinci ad eksik, Türkçe harfsiz, büyük harf, baştaki 0 kabul', () => {
    const o = listeli();
    const r = o.post(govde({kod: o.odevA.kod, numara: '0123', ad_soyad: 'AYSE yilmaz', sinif_sube: '8a'}));
    const s = o.sonuclar()[0];
    return r.ok && s[3] === '123' && s[4] === 'Ayşe Nur Yılmaz' && s[18] === 'AYSE yilmaz' && !isaret(s, 'liste_yok');
  }],
  ['S2: tek kelime ad, yanlış soyad, listede olmayan numara, yanlış şube reddedilir; satır yazılmaz', () => {
    const o = listeli(), k = o.odevA.kod;
    const r = [
      o.post(govde({kod: k, numara: '123', ad_soyad: 'Ayşe', sinif_sube: '8-A'})),
      o.post(govde({kod: k, numara: '123', ad_soyad: 'Ayşe Kaya', sinif_sube: '8-A'})),
      o.post(govde({kod: k, numara: '999', ad_soyad: 'Ayşe Yılmaz', sinif_sube: '8-A'})),
      o.post(govde({kod: k, numara: '9', ad_soyad: 'Can Demir', sinif_sube: '8-B'}))
    ];
    return r[0].hata === 'ad_uyusmuyor' && r[1].hata === 'ad_uyusmuyor' && r[2].hata === 'listede_yok' &&
      r[3].hata === 'sube_disi' && r[3].subeler.join() === '8-A' && r.every(x => x.ok === false && x.kalici) && o.sonuclar().length === 0;
  }],
  ['S2: liste varken şubesiz gönderim reddedilir (şube alanını silerek kapıdan kaçılmaz)', () => {
    const o = listeli();
    const r = o.post(govde({kod: o.odevSubesiz.kod, numara: '7', ad_soyad: 'Ali Veli'}));
    return r.ok === false && r.hata === 'sube_gerekli' && o.sonuclar().length === 0;
  }],
  ['S2: şubenin listesi yoksa serbest ad yazılır, liste_yok işaretlenir', () => {
    const o = listeli();
    const r = o.post(govde({kod: o.odevSubesiz.kod, numara: '50', ad_soyad: 'Serbest Ad', sinif_sube: '8-C'}));
    const s = o.sonuclar()[0];
    return r.ok && s[4] === 'Serbest Ad' && isaret(s, 'liste_yok');
  }],
  ['S2: hiç liste yoksa bugünkü davranış (şubesiz de kabul)', () => {
    const o = standart();
    const r = o.post(govde());
    return r.ok && isaret(o.sonuclar()[0], 'liste_yok');
  }],
  ['S2: GET liste durumunu söyler ama listedeki adı ASLA vermez', () => {
    const o = listeli(), k = o.odevA.kod;
    const a = o.get({odev: k, numara: '123', ad: 'Ayşe Yılmaz', sinif: '8-A'});
    const b = o.get({odev: k, numara: '123', ad: 'Biri Başka', sinif: '8-A'});
    const c = o.get({odev: k, numara: '555', ad: 'Biri Başka', sinif: '8-A'});
    return a.liste === 'tamam' && b.liste === 'ad_uyusmuyor' && c.liste === 'listede_yok' &&
      ![a, b, c].some(x => JSON.stringify(x).indexOf('Nur') >= 0);
  }],
  ['S2: tekrarlanan kelime tek sayılır: "Yılmaz Yılmaz" reddedilir (POST ve GET)', () => {
    const o = listeli(), k = o.odevA.kod;
    const r = o.post(govde({kod: k, numara: '123', ad_soyad: 'Yılmaz Yılmaz', sinif_sube: '8-A'}));
    const g = o.get({odev: k, numara: '123', ad: 'Ayşe Ayşe', sinif: '8-A'});
    return r.hata === 'ad_uyusmuyor' && g.liste === 'ad_uyusmuyor' && o.sonuclar().length === 0;
  }],
  ['S2: hiç liste yokken şube_dışı yine reddedilir, şubesiz kabul edilir', () => {
    const o = panelOrtami();
    o.sayfalar['Sonuçlar'].v.splice(1);
    const od = o.panel('odev_ekle', {test_slug: 'ingilizce-8', bitis: gelecek(), sinif: '8-A'});
    const a = o.post(govde({kod: od.kod, sinif_sube: '8-B'}));
    const b = o.post(govde({kod: od.kod}));
    return a.hata === 'sube_disi' && a.subeler.join() === '8-A' && b.ok && isaret(o.sonuclar()[0], 'liste_yok');
  }],
  ['S2: ilk deneme listedeki adla tanınır: farklı yazılışla ikinci gönderim kaydedilmez', () => {
    const o = listeli(), k = o.odevA.kod;
    o.post(govde({kod: k, numara: '123', ad_soyad: 'Ayşe Yılmaz', sinif_sube: '8-A'}));
    const r = o.post(govde({kod: k, numara: '0123', ad_soyad: 'ayse nur yilmaz', sinif_sube: '8-A'}));
    const g = o.get({odev: k, numara: '123', ad: 'Ayse Yilmaz', sinif: '8-A'});
    return r.kaydedilmedi === true && o.sonuclar().length === 1 && g.onceki === true;
  }]
);


VAKALAR.push(
  ['S3: geçersiz sayılan deneme ilk-deneme kuralından çıkar; öğrenci yeniden çözünce kaydedilir; durum korunur', () => {
    const o = listeli(), k = o.odevA.kod;
    o.post(govde({kod: k, numara: '7', ad_soyad: 'Ali Veli', sinif_sube: '8-A', puan: 10})); // arkadaşı yerine çözen
    const g = o.panel('deneme_gecersiz', {kod: k, numara: '007'});
    const onceki = o.get({odev: k, numara: '7', ad: 'Ali Veli', sinif: '8-A'}).onceki;
    const r = o.post(govde({kod: k, numara: '7', ad_soyad: 'Ali Veli', sinif_sube: '8-A', puan: 90}));
    const s = o.sonuclar();
    const sr = o.panel('sonuclar', {kod: k});
    return g.ok && g.gecersiz === true && g.n === 1 && onceki === false && r.ok && !r.kaydedilmedi && s.length === 2 &&
      isaret(s[0], 'gecersiz') && s[0][9] === 'zamanında' && sr.sonuclar.length === 1 && sr.sonuclar[0].puan === 90 &&
      sr.gecersizler.length === 1 && sr.gecersizler[0].puan === 10;
  }],
  ['S3: geri al yalnız yeni deneme yokken; varsa yeni_deneme_var', () => {
    const o = listeli(), k = o.odevA.kod;
    o.post(govde({kod: k, numara: '7', ad_soyad: 'Ali Veli', sinif_sube: '8-A'}));
    o.panel('deneme_gecersiz', {kod: k, numara: '7'});
    const geri = o.panel('deneme_gecersiz', {kod: k, numara: '7', geri: true});
    const s1 = isaret(o.sonuclar()[0], 'gecersiz');
    o.panel('deneme_gecersiz', {kod: k, numara: '7'});
    o.post(govde({kod: k, numara: '7', ad_soyad: 'Ali Veli', sinif_sube: '8-A'}));
    const red = o.panel('deneme_gecersiz', {kod: k, numara: '7', geri: true});
    return geri.ok && geri.gecersiz === false && s1 === false && red.ok === false && red.hata === 'yeni_deneme_var';
  }],
  ['S3: sıralama, katılım sayısı ve not çizelgesi geçersiz satırı saymaz; anahtarsız istek reddedilir', () => {
    const o = listeli(), k = o.odevA.kod;
    o.post(govde({kod: k, numara: '7', ad_soyad: 'Ali Veli', sinif_sube: '8-A'}));
    o.panel('deneme_gecersiz', {kod: k, numara: '7'});
    const sira = o.panel('siralama', {kod: k});
    const liste = o.panel('odevler').odevler.filter(x => x.kod === k)[0];
    const notlar = o.panel('notlar', {sinif_sube: '8-A'});
    const yetkisiz = o.post({islem: 'deneme_gecersiz', anahtar: 'x'.repeat(64), kod: k, numara: '7'});
    return sira.katilan === 0 && liste.katilan === 0 && !notlar.sonuclar.some(x => x.kod === k) && yetkisiz.hata === 'yetkisiz';
  }]
);


let gecen = 0, kalan = 0;
for (const [ad, fn] of VAKALAR) {
  let ok, neden = '';
  try { ok = fn() === true; } catch (e) { ok = false; neden = ' — ' + e.message; }
  ok ? gecen++ : kalan++;
  console.log(`  ${ok ? '✓' : '✗'} ${ad}${neden}`);
}
console.log(`sunucu testi (Kod.gs): ${gecen} geçti · ${kalan} kaldı`);
process.exit(kalan ? 1 : 0);
