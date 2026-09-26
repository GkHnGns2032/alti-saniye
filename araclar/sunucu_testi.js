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
  constructor() { this.v = []; this.bicim = {}; }
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
      setNumberFormat: f => { s.bicim[r + ':' + c] = f; }
    };
  }
}

function ortam({kilit = true} = {}) {
  const sayfalar = {};
  const ss = {
    getSheetByName: ad => sayfalar[ad] || null,
    insertSheet: ad => (sayfalar[ad] = new Sayfa()),
    getSpreadsheetTimeZone: () => 'Europe/Istanbul'
  };
  const ctx = {
    console: {log() {}, error() {}},
    SpreadsheetApp: {getActiveSpreadsheet: () => ss, flush() {}},
    LockService: {getScriptLock: () => ({tryLock: () => kilit, releaseLock() {}})},
    ContentService: {
      MimeType: {JSON: 'application/json'},
      createTextOutput: t => ({t, mime: null, setMimeType(m) { this.mime = m; return this; }})
    },
    Utilities: {
      parseDate(s, tz, bicim) {
        if (bicim !== 'yyyy-MM-dd HH:mm:ss') throw new Error('taklit: desteklenmeyen biçim ' + bicim);
        const [g, sa] = s.split(' '), [y, a, gun] = g.split('-').map(Number), [h, m, sn] = sa.split(':').map(Number);
        return new Date(Date.UTC(y, a - 1, gun, h, m, sn) - TZ_DK[tz] * 6e4);
      },
      formatDate(d, tz, bicim) {
        if (bicim !== 'HH:mm:ss') throw new Error('taklit: desteklenmeyen biçim ' + bicim);
        return new Date(d.getTime() + TZ_DK[tz] * 6e4).toISOString().slice(11, 19);
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(KOD, ctx, {filename: 'Kod.gs'});
  const cevap = o => { if (o.mime !== 'application/json') throw new Error('JSON mime yok'); return JSON.parse(o.t); };
  return {
    ctx, sayfalar,
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
  ['POST açık pencere → zamanında, deneme 1, 14 sütun, numara metin', () => {
    const o = standart();
    const r = o.post(govde());
    const s = o.sonuclar();
    const sh = o.sayfalar['Sonuçlar'];
    return r.ok && r.durum === 'zamanında' && r.deneme_no === 1 && s.length === 1 && s[0].length === 14 &&
      s[0][1] === 'ACIK1' && s[0][3] === '0123' && s[0][9] === 'zamanında' && s[0][10] === 1 &&
      sh.v[0].join() === 'sunucu_zamani,kod,test_slug,numara,ad_soyad,dogru,yanlis,bos,puan,durum,deneme_no,cevaplar,istemci_sure_ms,gonderim_id' &&
      sh.bicim['2:4'] === '@';
  }],
  ['POST aynı kod+numara ikinci kez → engellenmez, deneme 2', () => {
    const o = standart();
    o.post(govde());
    const r = o.post(govde({kod: 'acik1'}));
    return r.ok && r.deneme_no === 2 && o.sonuclar().length === 2 && o.sonuclar()[1][10] === 2;
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
      o.sayfalar['Sonuçlar'].v[0].length === 14;
  }],
  ['eski Sonuçlar sekmesine (13 sütun) gonderim_id başlığı eklenir', () => {
    const o = standart();
    const sh = o.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet('Sonuçlar');
    sh.v = [['sunucu_zamani', 'kod', 'test_slug', 'numara', 'ad_soyad', 'dogru', 'yanlis', 'bos', 'puan', 'durum', 'deneme_no', 'cevaplar', 'istemci_sure_ms']];
    const r = o.post(govde());
    return r.ok && sh.v[0][13] === 'gonderim_id' && sh.v.length === 2;
  }]
];

let gecen = 0, kalan = 0;
for (const [ad, fn] of VAKALAR) {
  let ok, neden = '';
  try { ok = fn() === true; } catch (e) { ok = false; neden = ' — ' + e.message; }
  ok ? gecen++ : kalan++;
  console.log(`  ${ok ? '✓' : '✗'} ${ad}${neden}`);
}
console.log(`sunucu testi (Kod.gs): ${gecen} geçti · ${kalan} kaldı`);
process.exit(kalan ? 1 : 0);
