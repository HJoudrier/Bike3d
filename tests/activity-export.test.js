/* author : Hugo Joudrier-Faure */
/* Tests de l'export de la sortie (FIT, TCX, GPX, CSV) : un point par seconde avec position, altitude, distance, vitesse, puissance, cardio,
 * cadence, W′bal et glycogène ; le FIT est relu par un décodeur minimal (en-tête, CRC, définitions, champs développeur). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor } = require('./helpers.js');

const R = PYR.ride, X = PYR.activityExport;
const START = Date.UTC(2026, 5, 1, 8, 0, 0);
const HILLY = [{ len: 1200, grade: 0 }, { len: 800, grade: 0.05 }, { len: 800, grade: -0.04 }, { len: 1200, grade: 0.005 }];

/** Une séance de n secondes à ~8 m/s, avec ou sans cardio et cadence. */
function session(n, o = {}) {
  const prof = makeProfile(HILLY);
  const { course, setup, athlete } = setupFor(prof);
  const sess = R.createSession({ course, setup, athlete, mass: 72, startMs: START, tempC: 20 });
  for (let k = 0; k < n; k++) {
    const [la, lo] = PYR.course.latLngAt(course, 8 * k);
    sess.step({
      power: Math.round(200 + 60 * Math.sin(k / 9)), hr: o.hr === false ? undefined : 130 + (k % 20), cad: o.cad === false ? undefined : 80 + (k % 12),
      fix: { lat: la, lng: lo, acc: 3, speed: 8, alt: PYR.course.eleAt(course, 8 * k) + 0.4 * Math.sin(k), age: 1 },
    });
  }
  return sess;
}

/* ---------- décodeur FIT minimal ---------- */

function decodeFit(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(bytes[0], 14, 'taille d\'en-tête');
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), '.FIT');
  const crc = PYR.planWorkout.crc16;
  assert.equal(dv.getUint16(12, true), crc(bytes, 0, 0, 12), 'CRC de l\'en-tête');
  const size = dv.getUint32(4, true);
  assert.equal(bytes.length, 14 + size + 2, 'taille des données');
  assert.equal(dv.getUint16(14 + size, true), crc(bytes, 0, 0, 14 + size), 'CRC du fichier');
  const defs = {}, msgs = [];
  let p = 14;
  const read = (base, len, at) => {
    if (base === 0x07) { let s = ''; for (let i = 0; i < len && bytes[at + i]; i++) s += String.fromCharCode(bytes[at + i]); return s; }
    if (base === 0x0D) return Array.from(bytes.slice(at, at + len));
    if (base === 0x88) return dv.getFloat32(at, true);
    if (len === 1) return bytes[at];
    if (len === 2) return dv.getUint16(at, true);
    return base === 0x85 ? dv.getInt32(at, true) : dv.getUint32(at, true);
  };
  while (p < 14 + size) {
    const h = bytes[p++];
    if (h & 0x40) {
      const local = h & 15, hasDev = !!(h & 0x20);
      p++;
      assert.equal(bytes[p++], 0, 'petit boutiste');
      const num = dv.getUint16(p, true); p += 2;
      const nf = bytes[p++], fields = [], dev = [];
      for (let i = 0; i < nf; i++) { fields.push({ id: bytes[p], size: bytes[p + 1], base: bytes[p + 2] }); p += 3; }
      if (hasDev) { const nd = bytes[p++]; for (let i = 0; i < nd; i++) { dev.push({ id: bytes[p], size: bytes[p + 1], idx: bytes[p + 2] }); p += 3; } }
      defs[local] = { num, fields, dev };
    } else {
      const def = defs[h & 15];
      assert.ok(def, 'données sans définition');
      const m = { num: def.num, f: {}, d: {} };
      for (const fd of def.fields) { m.f[fd.id] = read(fd.base, fd.size, p); p += fd.size; }
      for (const fd of def.dev) { m.d[fd.id] = read(0x88, fd.size, p); p += fd.size; }
      msgs.push(m);
    }
  }
  assert.equal(p, 14 + size);
  return msgs;
}
const semiToDeg = (s) => s * 180 / 2147483648;

test('FIT : fichier valide (en-tête, CRC), messages dans l\'ordre, un enregistrement par seconde', () => {
  const sess = session(120);
  const msgs = decodeFit(X.fit(sess, 'Sortie de test'));
  const nums = msgs.map((m) => m.num);
  assert.deepEqual(nums.slice(0, 6), [0, 207, 206, 206, 206, 21]);
  assert.equal(nums.filter((x) => x === 20).length, 120);
  assert.deepEqual(nums.slice(-5), [20, 21, 19, 18, 34], 'fin : dernier point, arrêt, tour, séance, activité');
});

test('FIT : valeurs des points (position, altitude, distance, vitesse, puissance, cardio, cadence) et champs développeur (W′bal, glycogène)', () => {
  const sess = session(120), T = sess.track();
  const msgs = decodeFit(X.fit(sess, 'Sortie de test'));
  assert.equal(msgs[0].f[8], 'Sortie de test');
  assert.equal(msgs[0].f[0], 4, 'fichier de type activité');
  const rec = msgs.filter((m) => m.num === 20);
  const FIT_EPOCH = 631065600;
  for (const k of [0, 1, 59, 119]) {
    const r = rec[k];
    assert.equal(r.f[253], Math.floor(START / 1000) - FIT_EPOCH + k + 1, `heure du point ${k}`);
    assert.ok(Math.abs(semiToDeg(r.f[0] | 0) - T.lat[k]) < 2e-7, 'latitude');
    assert.ok(Math.abs(semiToDeg(r.f[1] | 0) - T.lng[k]) < 2e-7, 'longitude');
    assert.ok(Math.abs(r.f[2] / 5 - 500 - T.ele[k]) < 0.21, `altitude ${r.f[2] / 5 - 500} / ${T.ele[k]}`);
    assert.equal(r.f[3], T.hr[k], 'cardio');
    assert.equal(r.f[4], Math.round(T.cad[k]), 'cadence');
    assert.ok(Math.abs(r.f[5] / 100 - T.s[k]) < 0.006, 'distance');
    assert.ok(Math.abs(r.f[6] / 1000 - T.v[k]) < 0.001, 'vitesse');
    assert.equal(r.f[7], Math.round(T.P[k]), 'puissance');
    assert.ok(Math.abs(r.d[0] - T.wbal[k]) < 0.01 * T.w0, 'W′bal');
    assert.ok(Math.abs(r.d[1] - T.gBurned[k]) < 1e-3 * (1 + T.gBurned[k]), 'glycogène dépensé');
    assert.ok(Math.abs(r.d[2] - T.gStock[k]) < 1e-3 * T.g0, 'glycogène restant');
  }
  // le glycogène dépensé ne fait que croître, le W′ varie avec l'effort
  for (let k = 1; k < rec.length; k++) assert.ok(rec[k].d[1] >= rec[k - 1].d[1] - 1e-6);
  assert.ok(rec[119].d[1] > 5, `glycogène dépensé ${rec[119].d[1]} g`);
  assert.ok(new Set(rec.map((r) => Math.round(r.d[0]))).size > 5);
});

test('FIT : définition des champs développeur, séance et activité', () => {
  const sess = session(120), T = sess.track();
  const msgs = decodeFit(X.fit(sess));
  const desc = msgs.filter((m) => m.num === 206);
  assert.deepEqual(desc.map((m) => [m.f[1], m.f[2], m.f[3], m.f[8]]), [[0, 0x88, 'W prime balance', 'J'], [1, 0x88, 'Glycogen burned', 'g'], [2, 0x88, 'Glycogen remaining', 'g']]);
  const ses = msgs.find((m) => m.num === 18), lap = msgs.find((m) => m.num === 19), act = msgs.find((m) => m.num === 34);
  assert.equal(ses.f[5], 2, 'sport : cyclisme');
  assert.equal(ses.f[7], 120000, 'durée écoulée (ms)');
  assert.equal(ses.f[9], Math.round(T.s[119] * 100), 'distance (cm)');
  const avgP = T.P.reduce((a, b) => a + b, 0) / 120;
  assert.ok(Math.abs(ses.f[20] - avgP) < 1, `puissance moyenne ${ses.f[20]} / ${avgP}`);
  assert.equal(ses.f[26], 1, 'un tour');
  assert.equal(lap.f[7], 120000);
  assert.equal(act.f[1], 1, 'une séance');
  assert.ok(ses.f[16] >= 130 && ses.f[17] <= 149, 'cardio moyen et maximal');
  assert.ok(ses.f[11] > 0, 'calories');
});

test('FIT : sans ceinture cardio ni capteur de cadence, ces champs sont « invalides »', () => {
  const sess = session(60, { hr: false, cad: false });
  const msgs = decodeFit(X.fit(sess));
  const rec = msgs.filter((m) => m.num === 20);
  assert.equal(rec.length, 60);
  assert.ok(rec.every((r) => r.f[3] === 0xFF && r.f[4] === 0xFF));
  const ses = msgs.find((m) => m.num === 18);
  assert.equal(ses.f[16], 0xFF);
  assert.equal(ses.f[18], 0xFF);
});

test('GPX : un point par seconde relu par activity.js, avec cardio, cadence, vitesse, W′bal et glycogène', () => {
  const sess = session(120), T = sess.track();
  const gpx = X.gpx(sess, 'Sortie <x> & co');
  assert.match(gpx, /Sortie &lt;x&gt; &amp; co/);
  const act = PYR.activity.parse(gpx);
  assert.equal(act.points.length, 120);
  assert.ok(act.hasPower && act.hasTime && act.hasEle);
  assert.equal(act.points[100].power, Math.round(T.P[100]));
  assert.ok(Math.abs(act.points[119].t - act.points[0].t - 119) < 0.5);
  assert.match(gpx, /<gpxtpx:hr>130<\/gpxtpx:hr>/);
  assert.match(gpx, /<pyr:wbal>\d+<\/pyr:wbal>/);
  assert.match(gpx, /<pyr:glycogenBurned>[\d.]+<\/pyr:glycogenBurned>/);
  assert.match(gpx, /<gpxpx:PowerInWatts>/);
  assert.equal((gpx.match(/<trkpt /g) || []).length, 120);
  if (typeof DOMParser !== 'undefined') assert.ok(!new DOMParser().parseFromString(gpx, 'application/xml').querySelector('parsererror'), 'XML bien formé');
});

test('TCX : relu par activity.js, un point par seconde avec cardio, cadence, vitesse et puissance, bilan du tour', () => {
  const sess = session(120), T = sess.track();
  const tcx = X.tcx(sess, 'Sortie');
  const act = PYR.activity.parse(tcx);
  assert.equal(act.format, 'tcx');
  assert.equal(act.points.length, 120);
  assert.ok(act.hasPower && act.hasTime && act.hasEle && act.hasDist);
  assert.equal(act.points[50].power, Math.round(T.P[50]));
  assert.ok(Math.abs(act.points[50].dist - T.s[50]) < 0.06);
  assert.match(tcx, /<HeartRateBpm><Value>130<\/Value><\/HeartRateBpm>/);
  assert.match(tcx, /<ns3:Speed>[\d.]+<\/ns3:Speed>/);
  assert.match(tcx, /<TotalTimeSeconds>120<\/TotalTimeSeconds>/);
  assert.match(tcx, /<pyr:WPrimeBalance>\d+<\/pyr:WPrimeBalance>/);
  assert.ok(!/<HeartRateBpm>/.test(X.tcx(session(30, { hr: false }), 'x')), 'pas de cardio sans ceinture');
  if (typeof DOMParser !== 'undefined') assert.ok(!new DOMParser().parseFromString(tcx, 'application/xml').querySelector('parsererror'), 'XML bien formé');
});

test('CSV : une ligne par seconde, toutes les colonnes', () => {
  const sess = session(120), T = sess.track();
  const lines = X.csv(sess).trim().split('\n');
  assert.equal(lines.length, 121);
  assert.deepEqual(lines[0].split(','), X.CSV_COLUMNS);
  const row = Object.fromEntries(lines[101].split(',').map((v, i) => [X.CSV_COLUMNS[i], v]));   // lines[0] : en-tête, lines[k + 1] : seconde k + 1
  assert.equal(row.temps_s, '101');
  assert.equal(row.puissance_w, String(Math.round(T.P[100])));
  assert.equal(row.cardio_bpm, String(T.hr[100]));
  assert.equal(row.cadence_tr_min, String(Math.round(T.cad[100])));
  assert.ok(Math.abs(Number(row.vitesse_kmh) - T.v[100] * 3.6) < 0.01);
  assert.ok(Math.abs(Number(row.wprime_pct) - T.wbal[100] / T.w0 * 100) < 0.06);
  assert.ok(Number(row.glycogene_depense_g) > 0 && Number(row.glycogene_restant_g) < T.g0);
  assert.equal(lines[101].split(',').length, X.CSV_COLUMNS.length);
});

test('build : nom de fichier, type MIME et contenu de chaque format', () => {
  const sess = session(40);
  const out = Object.fromEntries(X.FORMATS.map((f) => [f.id, X.build(sess, f.id, 'Test')]));
  assert.deepEqual(X.FORMATS.map((f) => f.id), ['fit', 'tcx', 'gpx', 'csv']);
  for (const f of X.FORMATS) assert.match(out[f.id].filename, new RegExp(`^sortie-2026-06-01-\\d{4}\\.${f.ext}$`));
  assert.ok(out.fit.data instanceof Uint8Array);
  assert.equal(typeof out.gpx.data, 'string');
  assert.match(out.tcx.mime, /tcx/);
  assert.throws(() => X.build(sess, 'zip'), /inconnu/);
});

test('sauvegarde et reprise : cardio, cadence, W′bal, glycogène et altitude (0,1 m) sont conservés pour l\'export', () => {
  const sess = session(90), T = sess.track();
  const back = R.createSession({ course: sess.course, athlete: sess.athlete, mass: 72, startMs: START, tempC: 20 });
  assert.ok(back.restore(JSON.parse(JSON.stringify(sess.pack()))));
  const U = back.track();
  assert.equal(U.n, 90);
  assert.deepEqual(Array.from(U.hr), Array.from(T.hr));
  assert.deepEqual(Array.from(U.cad), Array.from(T.cad));
  for (const k of [0, 30, 89]) {
    assert.ok(Math.abs(U.ele[k] - T.ele[k]) < 0.06, `altitude ${U.ele[k]} / ${T.ele[k]}`);
    assert.ok(Math.abs(U.lat[k] - T.lat[k]) < 2e-6 && Math.abs(U.lng[k] - T.lng[k]) < 2e-6, 'position');
    assert.ok(Math.abs(U.wbal[k] - T.wbal[k]) < 1, 'W′bal rejoué');
    assert.ok(Math.abs(U.gBurned[k] - T.gBurned[k]) < 1e-3, 'glycogène rejoué');
  }
  // anciennes sauvegardes : altitude au mètre, position à 1e-5°, sans cardio ni cadence
  const old = JSON.parse(JSON.stringify(sess.pack()));
  old.lat = R.packDelta(T.lat, 90, 1e5); old.lng = R.packDelta(T.lng, 90, 1e5); old.ele = R.packDelta(T.ele, 90, 1);
  delete old.llK; delete old.eleK; delete old.hr; delete old.cad;
  const rest = R.createSession({ course: sess.course, athlete: sess.athlete, mass: 72, startMs: START });
  assert.ok(rest.restore(old));
  assert.ok(Math.abs(rest.track().ele[40] - T.ele[40]) <= 0.51);
  assert.ok(rest.track().hr.every((x) => x === 0));
});
