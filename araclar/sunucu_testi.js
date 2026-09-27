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

const KOD = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Kod.gs'), 'utf8');
const TZ_DK = {'Europe/Istanbul': 180}; // Türkiye 2016'dan beri sabit UTC+3
const GUN = 864e5;

/* ---------- Taklitler ---------- */
class Sayfa {
  constructor() { this.v = []; this.bicim = {}; this.birlesik = []; this.yukseklik = {}; }
  clear() { this.v = []; }
  setRowHeight(r, h) { this.yukseklik[r] = h; }
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
      setWrap() { return this; },
      setVerticalAlignment() { return this; }
    };
  }
}

function ortam({kilit = true, istem = null} = {}) {
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
    Utilities: {
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
    ctx, sayfalar, ui, tetikler, ozellikler,
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
    return r.ok && r.durum === 'zamanında' && r.deneme_no === 1 && s.length === 1 && s[0].length === 15 &&
      s[0][1] === 'ACIK1' && s[0][3] === '0123' && s[0][9] === 'zamanında' && s[0][10] === 1 && s[0][14] === '8-A' &&
      sh.v[0].join() === 'sunucu_zamani,kod,test_slug,numara,ad_soyad,dogru,yanlis,bos,puan,durum,deneme_no,cevaplar,istemci_sure_ms,gonderim_id,sinif_sube' &&
      sh.bicim['2:4'] === '@' && sh.bicim['2:15'] === '@';
  }],
  ['sınıf/şube yazımları 8-A biçimine çevrilir; geçersiz ya da eksikse boş kalır ama sonuç kaybolmaz', () => {
    const o = standart();
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
      o.sayfalar['Sonuçlar'].v[0].length === 15;
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
    const sh = o.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet('Sonuçlar');
    sh.v = [['sunucu_zamani', 'kod', 'test_slug', 'numara', 'ad_soyad', 'dogru', 'yanlis', 'bos', 'puan', 'durum', 'deneme_no', 'cevaplar', 'istemci_sure_ms', 'gonderim_id'],
      [new Date(simdi - 1000), 'ACIK1', 'ingilizce-8', '5', 'Eski Satır', 8, 2, 0, 80, 'zamanında', 1, '', 60000, 'eski-satir-0001']];
    const r = o.post(govde({numara: '6', ad_soyad: 'Yeni Satır', dogru: 9, puan: 90, sinif_sube: '8-B'}));
    const m = o.ctx.siralamaHazirla_('ACIK1').metin;
    return r.ok && sh.v[0][14] === 'sinif_sube' && sh.v[0][13] === 'gonderim_id' && sh.v.length === 3 &&
      m.includes('🥇 Yeni Satır (8-B) — 90 puan') && m.includes('🥈 Eski Satır — 80 puan');
  }]
];

/* ---------- Sıralama ---------- */
// Sıralama için sonuç tablosu: aynı ödevde birkaç öğrenci, tekrar denemeler, süre dışı, başka ödev.
function siralamaOrtami(istem) {
  const o = ortam({istem});
  o.odev(['ACIK1', 'ingilizce-8', once, sonra, '8-A', ''], ['GECTI', 'ingilizce-8', new Date(simdi - 3 * GUN), new Date(simdi - 2 * GUN), '', '']);
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
  ['sıralama: ilk deneme sayılır, puan ↓, eşitlikte hızlı olan önde, başka ödev yok', () => {
    const s = siralamaOrtami().ctx.siralamaHazirla_('acik1');
    return s.satirlar.map(x => x.numara).join() === '12,13,11,14' && s.satirlar[2].puan === 80;
  }],
  ['sıralama: "Sıralama <KOD>" sekmesi: 1. satır WhatsApp metni, 2. satır bilgi, sonra tablo', () => {
    const o = siralamaOrtami();
    const s = o.ctx.siralamaHazirla_('acik1');
    const sh = o.sayfalar['Sıralama ACIK1'];
    const v = sh.v;
    return s.sekme === 'Sıralama ACIK1' && v[0][0] === s.metin && v[0][0].startsWith('🏆 ') &&
      /^↑ Üstteki metni WhatsApp'a yapıştır.*ACIK1 · ingilizce-8 · 8-A · güncellendi: \d\d\.\d\d\.\d{4} \d\d:\d\d/.test(v[1][0]) &&
      v[2].join() === 'sira,ad_soyad,sinif_sube,numara,puan,dogru,yanlis,bos,sure,durum' &&
      v[3].join() === '1,Ali Veli,,12,90,9,1,0,2:00,zamanında' && v[4][2] === '8-B' && v[4][8] === '1:10' && v.length === 7 &&
      v[6][1] === "'=Kötü Ad" && JSON.stringify(sh.birlesik) === '[[1,1,1,10],[2,1,1,10]]' &&
      sh.yukseklik[1] === 21 * s.metin.split('\n').length + 8 && !o.sayfalar['Sıralama'];
  }],
  ['sıralama: her ödevin kendi sekmesi olur, biri ötekini ezmez', () => {
    const o = siralamaOrtami();
    o.ctx.siralamaHazirla_('ACIK1');
    o.ctx.siralamaHazirla_('GECTI');
    return o.sayfalar['Sıralama ACIK1'].v.length === 7 && o.sayfalar['Sıralama GECTI'].v[3][1] === 'Başka Ödev';
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
  ['sıralama: WhatsApp metni madalyalı, tam ad, puan, doğru/yanlış sayısı, katılımcı sayısı', () => {
    const m = siralamaOrtami().ctx.siralamaHazirla_('ACIK1').metin.split('\n');
    return m[0] === '🏆 Ödev sıralaması · ingilizce-8 · 8-A' && m[3] === '🥇 Ali Veli — 90 puan · 9 doğru, 1 yanlış' &&
      m[4] === '🥈 Can Demir (8-B) — 80 puan · 8 doğru, 2 yanlış' && m[5] === '🥉 Ayşe Yılmaz — 80 puan · 8 doğru, 2 yanlış' && m[6].startsWith('4. ') &&
      m[m.length - 1] === '4 öğrenci katıldı.';
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
      ilk.katilan === 0 && ilk.bitis === yeni.bitis && acik.katilan === 4 && acik.sinif === '8-A';
  }],
  ['panel: siralama → WhatsApp metni ve satırlar; sonuçsuz ödevde boş metin', () => {
    const o = panelOrtami();
    const r = o.panel('siralama', {kod: 'acik1'});
    const bos = o.panel('siralama', {kod: 'GELECEK'});
    return r.ok && r.katilan === 4 && r.metin.startsWith('🏆 ') && r.metin.includes('🥇 Ali Veli — 90') &&
      r.satirlar[0].ad === 'Ali Veli' && r.satirlar[0].sinif === '' && r.satirlar[1].sinif === '8-B' && r.satirlar[0].dogru === 9 && r.satirlar[0].yanlis === 1 &&
      r.satirlar[0].bos === 0 && bos.ok && bos.katilan === 0 && bos.metin === '';
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
    const k = o.post(govde({kod: od.kod, test_slug: t.test_slug}));
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
    return r.ok && r.odev.kod === 'ACIK1' && r.odev.test_slug === 'ingilizce-8' && r.odev.sinif === '8-A' && !!r.odev.bitis &&
      r.sonuclar.length === 4 && ayse.puan === 80 && ayse.sonraki === 0 && ayse.cevaplar === '1B✓ 2C✗ 3-' &&
      can.sinif === '8-B' && can.sonraki === 0 && typeof can.sure === 'number' && !!can.zaman &&
      JSON.stringify(r.subeler) === '["8-A"]' && r.liste.map(x => x.numara).join() === '11,20' && !('test' in r);
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

let gecen = 0, kalan = 0;
for (const [ad, fn] of VAKALAR) {
  let ok, neden = '';
  try { ok = fn() === true; } catch (e) { ok = false; neden = ' — ' + e.message; }
  ok ? gecen++ : kalan++;
  console.log(`  ${ok ? '✓' : '✗'} ${ad}${neden}`);
}
console.log(`sunucu testi (Kod.gs): ${gecen} geçti · ${kalan} kaldı`);
process.exit(kalan ? 1 : 0);
