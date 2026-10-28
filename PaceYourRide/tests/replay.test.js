/* author : Hugo Joudrier-Faure */
/* Tests du mode démo « sortie rejouée » : lecture du FIT (relu depuis l'export de l'appli), du GPX et du TCX, remise à une ligne par seconde (pauses),
 * échauffement écarté, refus d'un autre tracé, et une séance du compteur conduite par la sortie rejouée. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor } = require('./helpers.js');

const R = PYR.ride, X = PYR.activityExport, P = PYR.replay;
const START = Date.UTC(2026, 5, 1, 8, 0, 0);
const HILLY = [{ len: 1200, grade: 0 }, { len: 800, grade: 0.05 }, { len: 800, grade: -0.04 }, { len: 1200, grade: 0.005 }];     // 4 000 m
const env = () => setupFor(makeProfile(HILLY));

/** Une séance de n secondes à 8 m/s sur le parcours (comme dans activity-export.test.js). */
function session(n, e) {
  const sess = R.createSession({ course: e.course, setup: e.setup, athlete: e.athlete, mass: 72, startMs: START, tempC: 20 });
  for (let k = 0; k < n; k++) {
    const [la, lo] = PYR.course.latLngAt(e.course, 8 * k);
    sess.step({
      power: Math.round(200 + 60 * Math.sin(k / 9)), hr: 130 + (k % 20), cad: 80 + (k % 12),
      fix: { lat: la, lng: lo, acc: 3, speed: 8, alt: PYR.course.eleAt(e.course, 8 * k), age: 0 },
    });
  }
  return sess;
}

/** Sortie à la main : un point par seconde, position à 8 m/s sur le parcours à partir de la distance s0, puissance 250 W. */
function manual(e, n, o = {}) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    const [la, lo] = PYR.course.latLngAt(e.course, Math.min(e.course.length, (o.s0 || 0) + 8 * k));
    pts.push({ t: (o.gapAt !== undefined && k >= o.gapAt ? o.gap : 0) + k, lat: la, lng: lo, ele: 100, dist: NaN, power: o.noPower ? NaN : 250, hr: NaN, cad: NaN });
  }
  return { format: 'gpx', name: 'à la main', points: pts, hasTime: true };
}

test('FIT : la sortie exportée par l\'appli est relue (position, altitude, puissance, cœur, cadence, vitesse, horodatage)', () => {
  const e = env(), src = session(300, e);
  const act = P.load(X.fit(src, 'essai'));
  assert.equal(act.format, 'fit');
  assert.ok(act.hasTime && act.hasPower && act.hasHr && act.hasCad && act.hasEle);
  assert.ok(Math.abs(act.points.length - 300) <= 1, `${act.points.length} points`);
  const p = act.points[100], [la, lo] = PYR.course.latLngAt(e.course, 8 * 100);
  assert.ok(Math.abs(p.lat - la) < 2e-6 && Math.abs(p.lng - lo) < 2e-6, `${p.lat} ${p.lng} / ${la} ${lo}`);
  assert.ok(Math.abs(p.t - 100) < 1.01, `t=${p.t}`);
  assert.ok(p.power >= 140 && p.power <= 260, `${p.power} W`);
  assert.ok(p.hr >= 130 && p.hr < 150 && p.cad >= 80 && p.cad < 92, `${p.hr} ${p.cad}`);
  assert.ok(p.speed > 6 && p.speed < 10, `${p.speed} m/s`);
});

test('FIT : valeurs invalides = absentes, fichier qui n\'est pas un FIT = erreur', () => {
  const rec = { num: 20, fields: [{ id: 253, type: 'u32' }, { id: 0, type: 's32' }, { id: 1, type: 's32' }, { id: 7, type: 'u16' }, { id: 3, type: 'u8' }] };
  const semi = (d) => Math.round(d * 2147483648 / 180);
  const bytes = X.encodeFit([{ def: rec, rows: [[1000, semi(45), semi(6), null, null], [1001, semi(45.0001), semi(6), 180, 120], [1002, semi(45.0002), semi(6), 0, 121]] }]);
  const act = P.decodeFit(bytes);
  assert.equal(act.points.length, 3);
  assert.ok(Number.isNaN(act.points[0].power) && Number.isNaN(act.points[0].hr));
  assert.equal(act.points[1].power, 180);
  assert.equal(act.points[2].power, 0, 'zéro watt = roue libre, pas une absence');
  assert.equal(act.points[2].t, 2);
  assert.throws(() => P.decodeFit(new Uint8Array(40)), /pas un FIT/);
});

test('GPX et TCX : puissance, cœur et cadence sont lus', () => {
  const e = env(), src = session(120, e);
  for (const [fmt, text] of [['gpx', X.gpx(src, 'x')], ['tcx', X.tcx(src, 'x')]]) {
    const act = P.load(new TextEncoder().encode(text));
    assert.equal(act.format, fmt);
    assert.ok(act.hasPower, fmt + ' : puissance');
    assert.ok(act.hasHr, fmt + ' : cœur');
    assert.ok(act.hasCad, fmt + ' : cadence');
    const p = act.points[50];
    assert.ok(p.hr >= 130 && p.hr < 150 && p.cad >= 80 && p.cad < 92, `${fmt} : ${p.hr} ${p.cad}`);
  }
});

test('rejeu : une ligne par seconde, la sortie finit quand le fichier finit', () => {
  const e = env(), act = P.load(X.fit(session(400, e)));
  const rp = P.create({ activity: act, course: e.course });
  assert.ok(rp.replay && rp.info.hasPower && rp.info.hasHr);
  assert.ok(Math.abs(rp.info.duration - 400) <= 6, `${rp.info.duration} s`);
  assert.ok(rp.info.coverage > 0.95);
  assert.ok(rp.info.avgPower > 190 && rp.info.avgPower < 260);
  let n = 0, last;
  for (;;) { last = rp.step(); if (last.done) break; n++; assert.ok(last.fix && Number.isFinite(last.fix.lat) && last.fix.speed >= 0); if (n > 1000) assert.fail('ne finit pas'); }
  assert.equal(n, rp.n);
  assert.equal(rp.step().done, true, 'reste fini');
});

test('rejeu : l\'échauffement avant le départ et le retour après l\'arrivée sont écartés, une pause est ramenée à une seconde', () => {
  const e = env();
  // 60 s d'échauffement sur une route à 1 km au sud du départ, puis 200 s sur le parcours
  const warm = [];
  for (let k = 0; k < 60; k++) warm.push({ t: k, lat: e.course.lat[0] - 0.01 + k * 1e-5, lng: e.course.lng[0], ele: 100, power: 120, hr: NaN, cad: NaN, dist: NaN });
  const body = manual(e, 200).points.map((p) => Object.assign(p, { t: p.t + 60 }));
  const act = { format: 'gpx', name: 'w', points: warm.concat(body), hasTime: true };
  const rp = P.create({ activity: act, course: e.course });
  assert.ok(rp.info.duration >= 190 && rp.info.duration <= 200, `${rp.info.duration} s`);
  const f0 = rp.step().fix, [la, lo] = PYR.course.latLngAt(e.course, 0);
  assert.ok(Math.abs(f0.lat - la) * 111195 < 80 && Math.abs(f0.lng - lo) * 78000 < 80, 'la sortie rejouée commence au départ');

  // pause de 10 minutes au milieu : 200 s de roulage, pas 800
  const paused = manual(e, 200, { gapAt: 100, gap: 600 });
  const rq = P.create({ activity: paused, course: e.course });
  assert.ok(rq.info.duration >= 195 && rq.info.duration <= 205, `${rq.info.duration} s avec la pause`);
});

test('rejeu : un autre tracé est refusé, une sortie sans horodatage aussi', () => {
  const e = env();
  const other = setupFor(makeProfile(HILLY, { heading: 90 }));       // même forme, mais parti vers l'est
  const act = manual(other, 300);
  // même point de départ : seuls les premiers mètres coïncident
  assert.throws(() => P.create({ activity: act, course: e.course }), /même tracé|départ/);
  const far = manual(e, 100);
  for (const p of far.points) p.lat += 0.5;
  assert.throws(() => P.create({ activity: far, course: e.course }), /départ du parcours/);
  const noTime = manual(e, 100);
  for (const p of noTime.points) p.t = NaN;
  assert.throws(() => P.create({ activity: noTime, course: e.course }), /horodatage/);
});

test('rejeu : sans puissance enregistrée, elle est absente (le compteur l\'estimera)', () => {
  const e = env(), rp = P.create({ activity: manual(e, 200, { noPower: true }), course: e.course });
  assert.equal(rp.info.hasPower, false);
  assert.equal(rp.step().power, undefined);
});

test('rejeu : le compteur suit la sortie rejouée jusqu\'à l\'arrivée, avec la puissance enregistrée', () => {
  const e = env(), act = P.load(X.fit(session(520, e)));
  const rp = P.create({ activity: act, course: e.course });
  const sess = R.createSession({ course: e.course, setup: e.setup, athlete: e.athlete, mass: 72, startMs: START, tempC: 20 });
  let pSum = 0, n = 0;
  for (let i = 0; i < 1000 && !sess.finished; i++) {
    const o = rp.step();
    if (o.done) break;
    sess.step({ power: o.power, hr: o.hr, cad: o.cad, fix: o.fix });
    pSum += o.power; n++;
  }
  assert.ok(sess.finished, 'arrivée franchie');
  assert.ok(sess.s > e.course.length - 20, `${sess.s} m`);
  assert.ok(Math.abs(sess.t - rp.info.duration) < 15, `${sess.t} s pour ${rp.info.duration} s enregistrées`);
  assert.ok(sess.hr >= 130 && sess.hr < 150);
  assert.ok(!sess.powerEstimated);
});
