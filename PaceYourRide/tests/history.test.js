/* author : Hugo Joudrier-Faure */
/* Tests du profil estimé depuis l'historique des sorties : modèle de Morton, filtres d'artefacts (puissance, FC), FC maximale, profil sur
 * une période et fiabilités, index de l'export Strava, lecture des sorties en salle (FIT, TCX sans position) et de l'archive zip. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR } = require('./helpers.js');

const H = PYR.history, Z = PYR.zip, Pz = PYR.physio, X = PYR.activityExport, R = PYR.replay;
const DUR = Pz.DURATIONS;
const morton = (cp, wp, pmax) => (d) => cp + wp / (d + wp / (pmax - cp));
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what || ''} ${a} au lieu de ${b} (± ${tol})`);
const FIT_EPOCH = 631065600;

/** FIT d'une sortie en salle : un point par seconde sans position (puissance, FC), et la séance (sport, sous-sport). */
function indoorFit(n, power, hr, ts0, sport, subSport) {
  const rec = { num: 20, fields: [{ id: 253, type: 'u32' }, { id: 7, type: 'u16' }, { id: 3, type: 'u8' }] };
  const ses = { num: 18, fields: [{ id: 253, type: 'u32' }, { id: 5, type: 'enum' }, { id: 6, type: 'enum' }] };
  const rows = [];
  for (let k = 0; k < n; k++) rows.push([ts0 + k, power(k), hr(k)]);
  return X.encodeFit([{ def: rec, rows }, { def: ses, rows: [[ts0 + n, sport, subSport]] }]);
}

/* ---------- modèle de Morton ---------- */

test('Morton : retrouve PC, W′ et Pmax d\'une courbe synthétique', () => {
  for (const [cp, wp, pm] of [[280, 20000, 1100], [210, 12000, 750], [380, 28000, 1600]]) {
    const m = morton(cp, wp, pm);
    const fit = H.fitMorton(DUR.filter((d) => d <= 1200).map((d) => ({ d, p: m(d) })));
    assert.ok(fit, 'ajustement');
    near(fit.cp, cp, cp * 0.002, 'PC');
    near(fit.wPrime, wp, wp * 0.005, 'W′');
    near(fit.pmax, pm, pm * 0.005, 'Pmax');
    assert.ok(fit.rms < 1e-4, `écart ${fit.rms}`);
    near(fit.model(300), m(300), 0.5, 'modèle à 5 min');
    // Pmax imposée : seules PC et W′ sont ajustées
    const fixed = H.fitMorton(DUR.filter((d) => d <= 1200).map((d) => ({ d, p: m(d) })), { pmax: pm });
    near(fixed.cp, cp, cp * 0.002, 'PC (Pmax imposée)');
    near(fixed.wPrime, wp, wp * 0.005, 'W′ (Pmax imposée)');
    assert.equal(fixed.pmax, pm);
  }
});

test('Morton : un point en creux (effort pas à fond) tire moins le modèle que dans un ajustement symétrique', () => {
  const m = morton(300, 18000, 1300);
  const pts = DUR.filter((d) => d <= 1200).map((d) => ({ d, p: d === 180 || d === 240 ? m(d) * 0.85 : m(d) }));
  const asym = H.fitMorton(pts), sym = H.fitMorton(pts, { asym: false });
  assert.ok(Math.abs(asym.wPrime - 18000) < Math.abs(sym.wPrime - 18000), `W′ ${asym.wPrime} / symétrique ${sym.wPrime}`);
  near(asym.cp, 300, 6, 'PC');
  near(asym.wPrime, 18000, 1500, 'W′');
});

test('Morton : pas d\'ajustement sans durée courte ni longue', () => {
  assert.equal(H.fitMorton([{ d: 600, p: 300 }, { d: 900, p: 290 }, { d: 1200, p: 285 }, { d: 1800, p: 280 }]), null);
  assert.equal(H.fitMorton([{ d: 1, p: 900 }, { d: 5, p: 850 }, { d: 10, p: 800 }, { d: 30, p: 600 }]), null);
});

/* ---------- filtres d'artefacts ---------- */

test('Filtre : un pic de puissance isolé et une valeur au-delà de 2 500 W sont supprimés, un vrai sprint est gardé', () => {
  const P = Float64Array.from([200, 210, 205, 1800, 215, 200, 0, 0, 400, 950, 1100, 1050, 600, 3000, 250]);
  const r = H.cleanPower(P);
  assert.equal(r.spikes, 2);
  assert.equal(r.power[3], 210, 'pic remplacé par la moyenne de ses voisines');
  assert.equal(r.power[13], 425);
  assert.deepEqual(Array.from(r.power.slice(8, 12)), [400, 950, 1100, 1050], 'sprint intact');
  assert.equal(P[3], 1800, 'l\'entrée n\'est pas modifiée');
});

test('Filtre : la fréquence cardiaque aberrante (saut de plus de 20 bpm/s, plus de 230 bpm) est écartée', () => {
  const r = H.cleanHr(Float64Array.from([120, 121, 122, 190, 123, 124, 240, 125, NaN, 126]));
  assert.ok(Number.isNaN(r.hr[3]) && Number.isNaN(r.hr[6]));
  assert.equal(r.hr[4], 123);
  assert.equal(r.dropped, 2);
  // ceinture qui démarre sur une valeur fausse : le vrai niveau, tenu, est admis
  const s = H.cleanHr(Float64Array.from([210, ...Array.from({ length: 30 }, (_, k) => 90 + k * 0.5)]));
  assert.ok(Number.isFinite(s.hr[30]), 'nouveau niveau admis');
  assert.ok(H.hrPeak(s.hr) < 110, `pic ${H.hrPeak(s.hr)}`);
});

test('Sortie : le pic de puissance ne fait pas le record d\'une seconde ; MMP et pic de FC', () => {
  const pts = [];
  for (let k = 0; k < 900; k++) {
    let p = k >= 300 && k < 600 ? 350 : 180;
    if (k === 100) p = 1900;                            // pic isolé du capteur
    if (k >= 700 && k < 705) p = 900;                    // sprint de 5 s
    pts.push({ t: k, lat: NaN, lng: NaN, power: p, hr: k < 300 ? 120 : k < 600 ? 120 + (k - 300) / 10 : Math.max(120, 149.9 - (k - 599)) });
  }
  const ride = H.analyze({ points: pts, startMs: Date.UTC(2026, 8, 1), sport: 'Ride' });
  assert.equal(ride.sport, 'cycling');
  assert.ok(ride.hasPower);
  assert.equal(ride.spikes, 1);
  assert.equal(ride.mmp[DUR.indexOf(1)], 900);
  assert.equal(ride.mmp[DUR.indexOf(5)], 900);
  near(ride.mmp[DUR.indexOf(300)], 350, 1e-9, '5 min');
  assert.ok(Number.isNaN(ride.mmp[DUR.indexOf(1200)]), 'sortie de 15 min : pas de 20 min');
  near(ride.hrPeak, 149.7, 1e-9, 'pic de FC (meilleure moyenne sur 5 s)');
  assert.equal(ride.hrDropped, 0);
});

test('Sortie : un arrêt (trou de plus de 5 s) compte 0 W, un petit trou est interpolé', () => {
  const pts = [];
  for (let k = 0; k < 120; k++) pts.push({ t: k, power: 300, hr: NaN });
  for (let k = 0; k < 120; k++) pts.push({ t: 400 + k, power: 300, hr: NaN });      // 280 s d'arrêt
  pts.splice(50, 3);                                                                   // 3 s perdues : interpolées
  const s = H.series({ points: pts });
  assert.equal(s.n, 520);
  assert.equal(s.power[51], 300);
  assert.equal(s.power[250], 0);
  const m = H.mmp(s.power, [120, 240]);
  assert.equal(m[0], 300);
  assert.ok(m[1] < 160, `4 min à cheval sur l'arrêt : ${m[1]}`);
});

/* ---------- FC maximale ---------- */

test('FC maximale : plus haut pic, sauf pic isolé (plus de 10 bpm au-dessus des autres) quand les sorties sont assez nombreuses', () => {
  assert.deepEqual(H.hrMaxEstimate([175, 215, 190, 189]), { value: 190, n: 4, near: 2, dropped: 1, droppedMax: 215 });
  assert.equal(H.hrMaxEstimate([186, 188, 185, NaN]).value, 188);
  assert.equal(H.hrMaxEstimate([182, 153]).value, 182, 'deux sorties : un seul effort à fond, gardé');
  assert.equal(H.hrMaxEstimate([180]).value, 180);
  assert.equal(H.hrMaxEstimate([NaN]), null);
  // 5 % des sorties au plus : sur 40 sorties, deux pics isolés écartés, pas un troisième
  const many = [230, 214, 201, ...Array.from({ length: 37 }, (_, k) => 185 - k * 0.5)];
  assert.deepEqual([H.hrMaxEstimate(many).value, H.hrMaxEstimate(many).dropped], [201, 2]);
});

/* ---------- profil sur une période ---------- */

const END = Date.UTC(2026, 9, 1);
/** Résumé de sortie dont la MMP suit p(d) jusqu'à sa durée. */
const ride = (daysAgo, p, dur, hrPeak, extra) => Object.assign({
  name: 'S' + daysAgo, file: '', startMs: END - daysAgo * 86400000, duration: dur, sport: 'cycling', hasPower: true,
  mmp: DUR.map((d) => (d <= dur ? p(d) : NaN)), hrPeak, spikes: 0, hrDropped: 0,
}, extra || {});

test('Profil : enveloppe sur la période, Morton, FC max et VO₂max ; une sortie ancienne compte seulement pour « tout »', () => {
  const m = morton(280, 20000, 1150);
  const rides = [
    ride(5, (d) => m(d) * (d <= 60 ? 1 : 0.9), 3 * 3600, 186),       // sprint à fond, le reste en dessous
    ride(20, (d) => (d <= 60 ? m(d) * 0.8 : m(d)), 3600, 188),       // efforts longs à fond
    ride(40, (d) => m(d) * 0.7, 2 * 3600, NaN, { hasPower: false, mmp: null }),
    ride(200, (d) => m(d) * 1.1, 5 * 3600, 195),                     // il y a 200 jours
    ride(10, (d) => m(d) * 2, 3600, 200, { sport: 'other' }),        // course à pied : ignorée
  ];
  const a = H.aggregate(rides, { days: 90, mass: 70, age: 40 });
  assert.equal(a.toMs, END - 5 * 86400000, 'la période finit à la dernière sortie de vélo');
  assert.equal(a.nRides, 3);
  assert.equal(a.nPower, 2);
  for (const d of [1, 30, 300, 1200]) near(a.env[DUR.indexOf(d)], m(d), 1e-6, `${d} s`);
  assert.equal(a.best[DUR.indexOf(1)].name, 'S5');
  assert.equal(a.best[DUR.indexOf(1200)].name, 'S20');
  assert.ok(Number.isNaN(a.env[DUR.indexOf(18000)]), 'pas de sortie de 5 h sur la période');
  // Pmax imposée = meilleure seconde (un peu sous la Pmax du modèle, à t = 0) : PC et W′ à peine décalées
  near(a.fit.cp, 280, 4, 'PC');
  near(a.fit.wPrime, 20000, 1000, 'W′');
  assert.equal(a.pmax, a.env[0]);
  assert.equal(a.fit.pmax, a.env[0]);
  assert.equal(a.hr.value, 188);
  near(a.vo2max, PYR.metabo.vo2maxFromP5(m(300), 70), 1e-9, 'VO₂max (Hawley et Noakes)');
  assert.equal(a.count[DUR.indexOf(7200)], 1);
  const all = H.aggregate(rides, { days: 0, mass: 70 });
  assert.equal(all.nRides, 4);
  near(all.env[DUR.indexOf(300)], m(300) * 1.1, 1e-6, 'tout l\'historique');
  assert.equal(all.hr.value, 195);
});

test('Fiabilité : profil type à fond = bonne ; sans sprint ni effort de 2 à 8 min = faible', () => {
  const ftp = 270, typ = (d) => ftp * Pz.templateRatio(d);
  const good = H.aggregate([ride(3, typ, 5 * 3600, 185), ride(9, typ, 4 * 3600, 187), ride(15, typ, 2 * 3600, 184)], { days: 90, age: 35 });
  for (const k of ['cp', 'wPrime', 'pmax', 'hrMax']) assert.equal(good.rel[k].level, 'bonne', `${k} : ${good.rel[k].why}`);
  assert.equal(good.rel.vo2max.level, 'moyenne', 'VO₂max : estimation indirecte');
  assert.ok(good.rel.records.every((r) => r && r.level !== 'faible'), good.rel.records.map((r) => r && r.level).join());
  // aucun sprint, rien d'intense en dessous de 20 min : PC tenue, mais W′ et Pmax ne se voient pas
  const flat = { 1: 2.1, 5: 1.9, 10: 1.7, 15: 1.55, 30: 1.4, 45: 1.3, 60: 1.24, 120: 1.15, 180: 1.13, 240: 1.11, 300: 1.10, 600: 1.09, 900: 1.085 };
  const dull = (d) => ftp * (flat[d] || Pz.templateRatio(d));
  const bad = H.aggregate([ride(3, dull, 3 * 3600, 150)], { days: 90, age: 35 });
  assert.equal(bad.rel.pmax.level, 'faible', bad.rel.pmax.why);
  assert.match(bad.rel.pmax.why, /aucun sprint/);
  assert.equal(bad.rel.wPrime.level, 'faible', bad.rel.wPrime.why);
  assert.match(bad.rel.wPrime.why, /entre 2 et 8 min/);
  assert.equal(bad.rel.hrMax.level, 'faible', 'une seule sortie avec FC');
});

/* ---------- export Strava ---------- */

test('Export Strava : index activities.csv (guillemets, retours à la ligne) et classes de sport', () => {
  const csv = '﻿Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Filename\r\n'
    + '12,"Jan 3, 2026, 9:41:20 AM",Sortie du matin,Ride,"Col, puis ""retour""\nfatigué",3600,activities/12.fit.gz\r\n'
    + '13,"Jan 4, 2026, 9:41:20 AM",Footing,Run,,1800,activities/13.gpx\r\n'
    + '14,"Jan 5, 2026, 9:41:20 AM",Saisie manuelle,Ride,,1800,\r\n';
  const idx = H.stravaIndex(csv);
  assert.equal(idx.size, 2);
  assert.deepEqual(idx.get('12.fit.gz'), { type: 'Ride', name: 'Sortie du matin' });
  assert.equal(idx.get('13.gpx').type, 'Run');
  assert.equal(H.parseCsv('a,"b\nc",d\n1,2,3')[0][1], 'b\nc');
  const C = H.sportClass;
  assert.deepEqual(['Ride', 'Virtual Ride', 'Gravel Ride', 'Vélo', 'VTT', 'Biking', 'cycling', '1'].map((s) => C(s)), Array(8).fill('cycling'));
  assert.deepEqual(['E-Bike Ride', 'Vélo électrique'].map((s) => C(s)), ['ebike', 'ebike']);
  assert.deepEqual(['Run', 'Course à pied', 'Swim', 'Walk', '9'].map((s) => C(s)), Array(5).fill('other'));
  assert.deepEqual(['', 'Other', undefined].map((s) => C(s)), Array(3).fill('unknown'));
  assert.deepEqual([C(2), C(1), C(21), C(0), C(4, 6), C(4, 14)], ['cycling', 'other', 'ebike', 'unknown', 'cycling', 'other']);
});

/* ---------- lecture des fichiers ---------- */

test('FIT en salle (sans position) : lu avec anyPos, date de départ et sport', () => {
  const ts0 = 1100000000;
  const fit = indoorFit(600, (k) => (k === 200 ? 2600 : 250), (k) => 130 + k / 20, ts0, 2, 6);
  assert.throws(() => R.decodeFit(fit), /trace/);
  const act = R.load(fit, { anyPos: true });
  assert.equal(act.points.length, 600);
  assert.equal(act.startMs, (ts0 + FIT_EPOCH) * 1000);
  assert.equal(act.sport, 2);
  assert.equal(act.subSport, 6);
  assert.ok(act.hasPower && act.hasHr);
  const r = H.analyze(act);
  assert.equal(r.sport, 'cycling');
  assert.equal(r.spikes, 1);
  assert.equal(r.mmp[0], 250);
});

test('TCX en salle (sans position) : lu avec anyPos, sport « Biking »', () => {
  let tps = '';
  for (let k = 0; k < 90; k++) tps += `<Trackpoint><Time>2026-09-01T08:00:${String(k % 60).padStart(2, '0')}Z</Time><HeartRateBpm><Value>${120 + k % 5}</Value></HeartRateBpm><Extensions><TPX><Watts>${200 + k}</Watts></TPX></Extensions></Trackpoint>`.replace('08:00:', k < 60 ? '08:00:' : '08:01:');
  const tcx = `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity Sport="Biking"><Id>2026-09-01T08:00:00Z</Id><Lap><Track>${tps}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  assert.throws(() => PYR.activity.parse(tcx), /trace/);
  const act = R.load(new TextEncoder().encode(tcx), { anyPos: true });
  assert.equal(act.points.length, 90);
  assert.equal(act.sport, 'Biking');
  assert.equal(act.startMs, Date.UTC(2026, 8, 1, 8, 0, 0));
  const r = H.analyze(act);
  assert.equal(r.sport, 'cycling');
  assert.equal(r.mmp[0], 289);
  assert.equal(r.duration, 90);
});

test('GPX : le sport est le <type> de la trace, pas celui d\'un lien des métadonnées', () => {
  const pts = '<trkpt lat="45" lon="6"><time>2026-09-01T08:00:00Z</time></trkpt><trkpt lat="45.001" lon="6"><time>2026-09-01T08:00:01Z</time></trkpt>';
  const meta = '<metadata><author><link href="https://example.org"><type>text/html</type></link></author></metadata>';
  const gpx = (trkType) => `<gpx>${meta}<trk><name>x</name>${trkType}<trkseg>${pts}</trkseg></trk></gpx>`;
  assert.equal(PYR.activity.parse(gpx('')).sport, '');
  assert.equal(PYR.activity.parse(gpx('<type>Ride</type>')).sport, 'Ride');
  assert.equal(H.sportClass(PYR.activity.parse(gpx('')).sport), 'unknown');
});

/* ---------- archive zip ---------- */

function crc32(b) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) {
    let c = (crc ^ b[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function compress(bytes, format) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Archive zip minimale : [{ name, data, comp (données compressées, méthode 8) }]. */
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], cen = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), comp = f.comp || f.data, method = f.comp ? 8 : 0, crc = crc32(f.data);
    const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x800, true); lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, f.data.length, true); lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true); cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, comp.length, true); cv.setUint32(24, f.data.length, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, off, true);
    ch.set(name, 46);
    parts.push(lh, comp); cen.push(ch);
    off += lh.length + comp.length;
  }
  const size = cen.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, size, true); ev.setUint32(16, off, true);
  return new Blob([...parts, ...cen, end]);
}

test('Zip : une archive minimale (fichier stocké, fichier compressé, sortie .fit.gz) est lue', async () => {
  const enc = new TextEncoder();
  const csv = enc.encode('Activity Name,Activity Type,Filename\nHome trainer,Virtual Ride,activities/7.fit.gz\n');
  const gpx = enc.encode('<gpx><trk><type>cycling</type><trkseg>' + '<trkpt lat="45" lon="6"><time>2026-09-01T08:00:00Z</time></trkpt>'.repeat(3) + '</trkseg></trk></gpx>'.repeat(20));
  const fit = indoorFit(400, (k) => 200 + (k % 7), () => 140, 1100000000, 2, 58);
  const zip = makeZip([
    { name: 'activities.csv', data: csv },
    { name: 'activities/6.gpx', data: gpx, comp: await compress(gpx, 'deflate-raw') },
    { name: 'activities/', data: new Uint8Array(0) },
    { name: 'activities/7.fit.gz', data: await compress(fit, 'gzip') },
  ]);
  const list = await Z.list(zip);
  assert.deepEqual(list.map((e) => [e.name, e.method, e.dir]), [['activities.csv', 0, false], ['activities/6.gpx', 8, false], ['activities/', 0, true], ['activities/7.fit.gz', 0, false]]);
  assert.equal(list[1].size, gpx.length);
  assert.ok(list[1].compSize < gpx.length, 'compressé');
  assert.deepEqual(Array.from(await Z.read(zip, list[0])), Array.from(csv));
  assert.deepEqual(Array.from(await Z.read(zip, list[1])), Array.from(gpx));
  const gz = await Z.read(zip, list[3]);
  assert.ok(Z.isGzip(gz) && !Z.isGzip(fit));
  const raw = await Z.gunzip(gz);
  assert.deepEqual(Array.from(raw), Array.from(fit));
  const meta = H.stravaIndex(new TextDecoder().decode(await Z.read(zip, list[0]))).get(H.baseName(list[3].name));
  const r = H.analyze(R.load(raw, { anyPos: true }), meta);
  assert.equal(r.name, 'Home trainer');
  assert.equal(r.sport, 'cycling');
  assert.ok(r.hasPower);
  assert.equal(r.mmp[0], 206);
  await assert.rejects(() => Z.list(new Blob([enc.encode('pas une archive')])));
});
