/* author : Hugo Joudrier-Faure */
/* Tests de la lecture GPX / TCX et de l'estimation du CdA et du Crr (node --test tests/activity.test.js). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR } = require('./helpers.js');

const A = PYR.activity, Ph = PYR.physics;
const G = 9.80665;
const RIDER = { weight: 72, height: 178, position: 'hoods_bent', helmet: 'road', clothing: 'fitted' };
const BIKE = { weight: 8.5, load: 1.5, frame: 'road', wheels: 'low', tire: 'road', drivetrain: 'clean', wheelMass: 2.2, spinMaxKmh: 65 };

/**
 * Sortie synthétique générée par la même physique que le simulateur : vers le nord, relief ondulé, puissance variable,
 * CdA et Crr connus. Renvoie les points seconde par seconde.
 */
function ride({ cda, crr, windKmh = 0, windDir = 0, seconds = 1800, noise = 0, seed = 5 }) {
  const setup = Ph.buildSetup(RIDER, BIKE);
  const W = windKmh / 3.6 * A.WIND_K;
  let rnd = seed; const rand = () => { rnd = (rnd * 1664525 + 1013904223) % 4294967296; return rnd / 4294967296 - 0.5; };
  const grade = (s) => 0.035 * Math.sin(s / 700) + 0.02 * Math.sin(s / 190) + 0.006;
  const pts = [];
  let s = 0, v = 8, ele = 300, t = 0;
  const power = (tt) => 230 + 70 * Math.sin(tt / 85) + 45 * Math.sin(tt / 27) + 25 * Math.sin(tt / 9);
  const accel = (vv, P, g) => {
    const th = Math.atan(g), cosT = Math.cos(th), sinT = Math.sin(th);
    // vent de face : le cap est 0° (nord) ; vent d'où windDir : composante de face = W cos(windDir − cap)
    const wh = W * Math.cos(windDir * Math.PI / 180);
    const wc = W * Math.abs(Math.sin(windDir * Math.PI / 180));
    const va = vv + wh, vapp = Math.sqrt(va * va + wc * wc);
    const rho = Ph.airDensity(ele, 15 - 0.0065 * (ele - 300));
    const F = setup.mass * G * (sinT + crr * cosT) + 0.5 * rho * cda * vapp * va;
    return (setup.eta * P / Math.max(vv, 0.5) - F) / setup.massEff;
  };
  for (let sec = 0; sec <= seconds; sec++) {
    const P = power(sec);
    pts.push({ t: sec, s, ele, power: Math.max(0, Math.round(P + noise * 8 * rand())), lat: 45 + s / 111320, lng: 6 });
    // intégration à 0,1 s (Heun)
    for (let k = 0; k < 10; k++) {
      const g = grade(s);
      const a1 = accel(v, P, g), v1 = Math.max(0.5, v + 0.1 * a1), a2 = accel(v1, P, g);
      const vn = Math.max(0.5, v + 0.05 * (a1 + a2));
      s += 0.05 * (v + vn); ele += g * 0.05 * (v + vn); v = vn; t += 0.1;
    }
  }
  return { pts, setup };
}

const iso = (sec) => new Date(Date.UTC(2026, 5, 1, 8, 0, 0) + sec * 1000).toISOString();

function toGpx(pts, { power = 'power' } = {}) {
  const body = pts.map((p) => {
    const w = power === 'garmin' ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>140</gpxtpx:hr></gpxtpx:TrackPointExtension><gpxpx:PowerExtension><gpxpx:PowerInWatts>${p.power}</gpxpx:PowerInWatts></gpxpx:PowerExtension></extensions>`
      : power === 'ns3' ? `<extensions><ns3:power>${p.power}</ns3:power></extensions>`
        : power === 'none' ? '' : `<extensions><power>${p.power}</power></extensions>`;
    return `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}"><ele>${p.ele.toFixed(2)}</ele><time>${iso(p.t)}</time>${w}</trkpt>`;
  }).join('\n');
  return `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Sortie test</name></metadata><trk><name>Sortie test</name><trkseg>\n${body}\n</trkseg></trk></gpx>`;
}

function toTcx(pts) {
  const body = pts.map((p) => `<Trackpoint><Time>${iso(p.t)}</Time><Position><LatitudeDegrees>${p.lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${p.lng.toFixed(7)}</LongitudeDegrees></Position>`
    + `<AltitudeMeters>${p.ele.toFixed(2)}</AltitudeMeters><DistanceMeters>${p.s === undefined ? 0 : p.s.toFixed(2)}</DistanceMeters><Extensions><ns3:TPX><ns3:Watts>${p.power}</ns3:Watts></ns3:TPX></Extensions></Trackpoint>`).join('\n');
  return `<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Biking"><Id>${iso(0)}</Id><Lap><Track>\n${body}\n</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
}

test('lecture GPX : position, altitude, heure et puissance (balise <power>, extension Garmin, ns3)', () => {
  const { pts } = ride({ cda: 0.3, crr: 0.005, seconds: 300 });
  for (const mode of ['power', 'garmin', 'ns3']) {
    const act = A.parse(toGpx(pts, { power: mode }));
    assert.equal(act.format, 'gpx');
    assert.equal(act.name, 'Sortie test');
    assert.equal(act.points.length, pts.length);
    assert.ok(act.hasTime && act.hasEle && act.hasPower, mode);
    assert.equal(act.points[0].t, 0);
    assert.equal(act.points[10].t, 10);
    assert.equal(act.points[100].power, pts[100].power, `puissance (${mode})`);
    assert.ok(Math.abs(act.points[100].lat - pts[100].lat) < 1e-6);
  }
  const none = A.parse(toGpx(pts, { power: 'none' }));
  assert.equal(none.hasPower, false);
  assert.throws(() => A.parse('<gpx></gpx>'), /Aucune trace/);
});

test('lecture TCX : heure, position, altitude, distance du capteur et watts', () => {
  const { pts } = ride({ cda: 0.3, crr: 0.005, seconds: 200 });
  const act = A.parse(toTcx(pts));
  assert.equal(act.format, 'tcx');
  assert.equal(act.points.length, pts.length);
  assert.ok(act.hasTime && act.hasEle && act.hasPower && act.hasDist);
  assert.equal(act.points[50].power, pts[50].power);
  assert.ok(Math.abs(act.points[50].dist - pts[50].s) < 0.01);
  assert.equal(act.points[50].t, 50);
});

test('estimation : retrouve le CdA et le Crr d\'une sortie sans bruit (air calme)', () => {
  const truth = { cda: 0.31, crr: 0.0052 };
  const { pts, setup } = ride({ ...truth });
  const prep = A.prepare(A.parse(toGpx(pts)), { windKmh: 0, tempC: 15 });
  const r = A.fit(prep, setup, { mode: 'both' });
  assert.ok(r.ok, r.error);
  assert.ok(Math.abs(r.cda - truth.cda) < 0.008, `CdA ${r.cda} (vrai ${truth.cda})`);
  assert.ok(Math.abs(r.crr - truth.crr) < 0.0007, `Crr ${r.crr} (vrai ${truth.crr})`);
  assert.ok(r.n > 100 && r.rmse < 6, `${r.n} fenêtres, rmse ${r.rmse} W`);
  assert.ok(r.seconds > 1500 && r.share > 0.8, `${r.seconds} s exploitées (${r.share})`);
  assert.ok(r.seCda > 0 && r.seCrr > 0 && Math.abs(r.corr) <= 1);
  assert.ok(r.series.Pmodel.length === prep.n);
});

test('estimation : le vent connu est pris en compte (vent de face et de dos, de travers)', () => {
  const truth = { cda: 0.28, crr: 0.0045 };
  const { setup } = ride({ ...truth, seconds: 60 });
  for (const [windKmh, windDir] of [[18, 0], [18, 180], [20, 90]]) {
    const { pts } = ride({ ...truth, windKmh, windDir, seconds: 1800 });
    const act = A.parse(toGpx(pts));
    const withWind = A.fit(A.prepare(act, { windKmh, windDir, tempC: 15 }), setup, { mode: 'both' });
    assert.ok(withWind.ok, withWind.error);
    assert.ok(Math.abs(withWind.cda - truth.cda) < 0.02, `vent ${windKmh} km/h depuis ${windDir}° : CdA ${withWind.cda}`);
    // ignorer un vent de face de 18 km/h gonfle le CdA… et un vent de dos le dégonfle
    if (windDir === 0) {
      const ignored = A.fit(A.prepare(act, { windKmh: 0, tempC: 15 }), setup, { mode: 'both' });
      assert.ok(ignored.cda > withWind.cda + 0.015, `sans le vent : ${ignored.cda} contre ${withWind.cda}`);
      assert.ok(ignored.warnings.some((w) => /vent/i.test(w)), 'avertissement : aucun vent saisi');
    }
    if (windDir === 180) {
      const ignored = A.fit(A.prepare(act, { windKmh: 0, tempC: 15 }), setup, { mode: 'both' });
      assert.ok(ignored.cda < withWind.cda - 0.01, `sans le vent de dos : ${ignored.cda} contre ${withWind.cda}`);
    }
  }
});

test('estimation : CdA seul (Crr fixé) et Crr seul (CdA fixé), la puissance mesurée a du bruit', () => {
  const truth = { cda: 0.3, crr: 0.005 };
  const { pts, setup } = ride({ ...truth, noise: 1 });
  const prep = A.prepare(A.parse(toGpx(pts)), { windKmh: 0, tempC: 15 });
  const a = A.fit(prep, setup, { mode: 'cda', crr0: truth.crr });
  assert.ok(a.ok && a.crr === truth.crr && Math.abs(a.cda - truth.cda) < 0.012, `CdA seul : ${a.cda}`);
  assert.ok(a.seCda > 0 && Number.isNaN(a.seCrr));
  const b = A.fit(prep, setup, { mode: 'crr', cda0: truth.cda });
  assert.ok(b.ok && b.cda === truth.cda && Math.abs(b.crr - truth.crr) < 0.0008, `Crr seul : ${b.crr}`);
  // un Crr fixé trop haut fait baisser le CdA estimé (le roulement « explique » une part de la puissance)
  const high = A.fit(prep, setup, { mode: 'cda', crr0: 0.009 });
  assert.ok(high.cda < a.cda - 0.03, `${high.cda} contre ${a.cda}`);
});

test('estimation : refus clairs (pas de puissance, pas d\'heure, pas d\'altitude, trop court)', () => {
  const { pts, setup } = ride({ cda: 0.3, crr: 0.005, seconds: 400 });
  const noPower = A.prepare(A.parse(toGpx(pts, { power: 'none' })), {});
  const r = A.fit(noPower, setup, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /puissance/);
  const noTime = A.parse(toGpx(pts).replace(/<time>[^<]*<\/time>/g, ''));
  assert.throws(() => A.prepare(noTime, {}), /heure/);
  const noEle = A.parse(toGpx(pts).replace(/<ele>[^<]*<\/ele>/g, ''));
  assert.throws(() => A.prepare(noEle, {}), /altitude/);
  const short = A.parse(toGpx(pts.slice(0, 40)));
  assert.throws(() => A.prepare(short, {}), /courte|Trop peu/);
});

test('estimation : vitesse constante sur le plat — refusée si elle est parfaitement constante, mise en garde si elle varie à peine', () => {
  const setup = Ph.buildSetup(RIDER, BIKE);
  const truth = { cda: 0.3, crr: 0.005 };
  const rho = Ph.airDensity(100, 15);
  const make = (ripple) => {
    const pts = [];
    let s = 0;
    for (let t = 0; t <= 1500; t++) {
      const v = 8.3 + ripple * Math.sin(t / 40), a = ripple * Math.cos(t / 40) / 40;
      const P = ((setup.mass * G * truth.crr + 0.5 * rho * truth.cda * v * v) * v + setup.massEff * v * a) / setup.eta;
      pts.push({ t, s, ele: 100, power: Math.round(P), lat: 45 + s / 111320, lng: 6 });
      s += v;
    }
    return pts;
  };
  // parfaitement constante : les deux régresseurs sont proportionnels, impossible de séparer CdA et Crr
  const flat = A.fit(A.prepare(A.parse(toGpx(make(0))), { windKmh: 0, tempC: 15 }), setup, { mode: 'both' });
  assert.equal(flat.ok, false);
  assert.match(flat.error, /dégénérées/);
  // un peu de variation : l'estimation est possible, avec des mises en garde et une forte corrélation entre les deux
  const r = A.fit(A.prepare(A.parse(toGpx(make(0.35))), { windKmh: 0, tempC: 15 }), setup, { mode: 'both' });
  assert.ok(r.ok, r.error);
  assert.ok(r.warnings.length > 0, 'avertissement attendu');
  assert.ok(Math.abs(r.corr) > 0.95, `corr ${r.corr}`);
  // le CdA seul reste bien déterminé, lui, si le Crr est connu
  const c = A.fit(A.prepare(A.parse(toGpx(make(0))), { windKmh: 0, tempC: 15 }), setup, { mode: 'cda', crr0: truth.crr });
  assert.ok(c.ok && Math.abs(c.cda - truth.cda) < 0.01, `CdA seul ${c.cda}`);
});
