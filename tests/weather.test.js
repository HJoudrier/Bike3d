/* author : Hugo Joudrier-Faure */
/* Tests de la météo : champ (position × heure), effets sur la mécanique, la course et l'optimiseur. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor, DEFAULT_RIDER, DEFAULT_BIKE } = require('./helpers.js');

const W = PYR.weather, Ph = PYR.physics, Race = PYR.race, Tac = PYR.tactics;

const T0 = 1760000000 - (1760000000 % 3600); // une heure ronde (epoch, s)
const HOUR = 3600;

/** Instantané : stations à 0 et L m, n heures, valeurs par défaut calmes ; over : {champ: (k, h) => valeur}. */
function mkWeather(L, n, over, extra) {
  const stations = [{ s: 0, lat: 45, lng: 6, ele: 200 }, { s: L, lat: 45.1, lng: 6, ele: 200 }];
  const base = { T: 20, rh: 0, p: 1013.25, rain: 0, ws: 0, wd: 0, gust: 0 };
  const w = Object.assign({ v: 1, start: T0, t0: T0, n, stations }, extra || {});
  for (const f of W.FIELDS) {
    w[f] = stations.map((_, k) => Array.from({ length: n }, (_, h) => (over && over[f] ? over[f](k, h) : base[f])));
  }
  return W.normalize(w);
}

const flat = (km, opts) => setupFor(makeProfile([{ len: km * 1000, grade: 0 }]), {}, { temperature: 20 }, Object.assign({ aLat: 4.4, vmaxKmh: 90 }, opts));

test('instantané : validation, bornes et arrondis', () => {
  const ok = mkWeather(20000, 4);
  assert.ok(ok && ok.n === 4 && ok.stations.length === 2);
  const raw = JSON.parse(JSON.stringify(ok));
  assert.equal(W.normalize(raw).gust[0][0], 0);
  // une rafale ne peut pas être plus faible que le vent moyen ; valeurs bornées
  raw.ws[0][0] = 9.04; raw.gust[0][0] = 3; raw.rh[0][0] = 180; raw.T[1][1] = -99;
  const n = W.normalize(raw);
  assert.equal(n.gust[0][0], 9); assert.equal(n.rh[0][0], 100); assert.equal(n.T[1][1], -60);
  // rejets
  const bad = (fn) => { const c = JSON.parse(JSON.stringify(ok)); fn(c); return W.normalize(c); };
  assert.equal(W.normalize(null), null);
  assert.equal(bad((c) => { c.v = 2; }), null);
  assert.equal(bad((c) => { c.T[0].pop(); }), null, 'longueur incohérente');
  assert.equal(bad((c) => { c.T.pop(); }), null, 'une station sans données');
  assert.equal(bad((c) => { c.p[0][0] = NaN; }), null);
  assert.equal(bad((c) => { c.stations.reverse(); }), null, 'stations non triées');
  assert.equal(bad((c) => { c.n = W.MAX_HOURS + 1; }), null);
  assert.equal(bad((c) => { c.start = 'x'; }), null);
});

test('lecture : interpolation entre stations (distance) et entre heures (temps), bornée', () => {
  const w = mkWeather(10000, 3, { T: (k, h) => 10 + 10 * k + 10 * h });
  const at = (s, t) => W.at(w, s, T0 + t).T;
  assert.equal(at(0, 0), 10);
  assert.equal(at(10000, 0), 20);
  assert.ok(Math.abs(at(5000, 0) - 15) < 1e-4, 'à mi-distance');
  assert.ok(Math.abs(at(0, 1800) - 15) < 1e-4, 'à mi-heure');
  assert.ok(Math.abs(at(5000, 1800) - 20) < 1e-4);
  assert.equal(at(-500, -3600), 10, 'avant le début : bornes');
  assert.equal(at(99999, 99 * HOUR), 40, 'après la fin : bornes');
  // réutilise l'objet de sortie
  const o = {};
  assert.equal(W.at(w, 0, T0, o), o);
  // direction : on interpole le vecteur, pas l'angle (350° et 10° donnent ≈ 0°, pas 180°)
  const v = mkWeather(10000, 2, { ws: () => 6, wd: (k) => (k === 0 ? 350 : 10) });
  const d = W.at(v, 5000, T0).wd;
  assert.ok(d < 1 || d > 359, `direction ${d}`);
  assert.ok(Math.abs(W.at(v, 5000, T0).ws - 6) < 1e-4);
});

test('route mouillée : monte avec la pluie et sèche en 1 à 2 h', () => {
  const w = mkWeather(10000, 5, { rain: (k, h) => (h === 0 ? 2 : 0) });
  const wet = (h) => W.at(w, 5000, T0 + h * HOUR).wet;
  assert.equal(wet(0), 1);
  assert.ok(Math.abs(wet(1) - 0.55) < 1e-4 && Math.abs(wet(2) - 0.3025) < 1e-4, `${wet(1)} ${wet(2)}`);
  assert.ok(wet(4) < 0.1);
  const drizzle = mkWeather(10000, 2, { rain: () => 0.05 });
  assert.ok(W.at(drizzle, 0, T0).wet > 0.2 && W.at(drizzle, 0, T0).wet < 0.5, 'bruine : route humide');
  assert.equal(W.at(mkWeather(10000, 2), 0, T0).wet, 0);
});

test('réponse Open-Meteo : fenêtre autour du départ, trous comblés, erreurs claires', () => {
  const stations = [{ s: 0, lat: 45, lng: 6, ele: 200 }, { s: 20000, lat: 45.2, lng: 6, ele: 300 }];
  const time = Array.from({ length: 72 }, (_, i) => T0 - 24 * HOUR + i * HOUR); // 3 jours
  const loc = (off) => ({
    utc_offset_seconds: 7200,
    hourly: {
      time,
      temperature_2m: time.map((_, i) => 10 + off + i * 0.1), relative_humidity_2m: time.map(() => 60), pressure_msl: time.map(() => 1015),
      precipitation: time.map((_, i) => (i === 25 ? 1.2 : 0)), wind_speed_10m: time.map(() => 5), wind_direction_10m: time.map(() => 270),
      wind_gusts_10m: time.map(() => 9),
    },
  });
  const resp = [loc(0), loc(1)];
  resp[0].hourly.temperature_2m[26] = null; // trou
  const start = T0 + 1800;
  const w = W.fromApi(resp, stations, start, { before: 1, hours: 6 });
  assert.equal(w.t0, T0 - HOUR);
  assert.equal(w.n, 8, 'de 1 h avant à 6 h après l\'heure du départ');
  assert.equal(w.start, start);
  assert.ok(Number.isFinite(w.T[0][2]) && Math.abs(w.T[0][2] - w.T[0][1]) < 0.3, 'trou comblé par le voisin');
  assert.equal(w.rain[0][2], 1.2);
  assert.equal(w.p[1][0], 1015);
  assert.throws(() => W.fromApi([resp[0]], stations, start), /incompl/);
  assert.throws(() => W.fromApi(resp, stations, T0 + 400 * HOUR), /prévision/);
  assert.equal(W.localToEpoch('2026-10-12T08:30', 7200), Date.UTC(2026, 9, 12, 6, 30) / 1000);
  assert.ok(Number.isNaN(W.localToEpoch('demain', 0)));
  // stations d'un parcours : départ, arrivée, un point tous les ≈ 10 km
  const prof = makeProfile([{ len: 40000, grade: 0 }]);
  const st = W.stationsFor(prof);
  assert.equal(st.length, 5);
  assert.equal(st[0].s, 0); assert.equal(st[4].s, 40000);
  assert.equal(W.stationsFor(makeProfile([{ len: 3000, grade: 0 }])).length, 2);
  assert.equal(W.stationsFor(makeProfile([{ len: 400000, grade: 0 }])).length, 12);
});

test('physique : densité de l\'air humide, chaleur, route mouillée', () => {
  // air sec à la pression standard : comme airDensity
  for (const [alt, T] of [[0, 15], [800, 8], [2000, -3]]) {
    assert.ok(Math.abs(Ph.airDensityHumid(alt, T, 0, 1013.25) - Ph.airDensity(alt, T)) < 1e-9, `${alt} m ${T} °C`);
  }
  const dry = Ph.airDensityHumid(100, 30, 0, 1013.25), humid = Ph.airDensityHumid(100, 30, 100, 1013.25);
  assert.ok(humid < dry && humid > 0.97 * dry, `${humid} vs ${dry}`);
  assert.ok(Ph.airDensityHumid(100, 15, 50, 995) < Ph.airDensityHumid(100, 15, 50, 1025), 'basse pression : air plus léger');
  assert.ok(Math.abs(Ph.airDensityHumid(100, 15, 0, 1013.25) / Ph.airDensityHumid(100, 15, 0, 1000) - 1013.25 / 1000) < 1e-9, 'air sec : proportionnel à la pression');
  // chaleur : l'humidité aggrave, le froid et la douceur n'ont pas d'effet / peu
  assert.equal(W.heatIndex(15, 80), 15);
  assert.ok(W.heatIndex(33, 70) > W.heatIndex(33, 30) + 3);
  assert.equal(W.heatFactor(20, 50), 1);
  assert.ok(W.heatFactor(35, 70) < W.heatFactor(35, 30) && W.heatFactor(35, 30) < 1);
  assert.ok(W.heatFactor(50, 100) >= 0.85 * 0.999, 'plafonné à −15 %');
  assert.ok(W.heatFactor(-5, 50) < 1 && W.heatFactor(-5, 50) >= 0.95 - 1e-9);
  // route mouillée : plus de chutes, plus de roulement, moins d'adhérence
  const dryFx = W.roadEffects(0, 15, 50, 3), wetFx = W.roadEffects(1, 15, 50, 3);
  assert.deepEqual(dryFx, { crrK: 1, crashK: 1, punctK: 1, vlimK: 1, brakeK: 1 });
  assert.equal(wetFx.crashK, 3);
  assert.ok(wetFx.crrK > 1 && wetFx.punctK > 1 && wetFx.vlimK < 1 && wetFx.brakeK < 1);
  assert.equal(W.roadEffects(0, 15, 50, 20).crashK, 1.5, 'rafales de 72 km/h');
  assert.equal(W.roadEffects(0.5, -1, 90, 3).crashK, 2 * 2, 'verglas');
});

test('conditions : vent de face ralentit, de dos accélère ; météo constante = vent statique équivalent', () => {
  // parcours plein nord (cap 0°) : vent du nord (0°) = de face, du sud (180°) = de dos
  const L = 12000;
  const calm = flat(12, { weather: mkWeather(L, 3) });
  const head = flat(12, { weather: mkWeather(L, 3, { ws: () => 8, wd: () => 0 }) });
  const tail = flat(12, { weather: mkWeather(L, 3, { ws: () => 8, wd: () => 180 }) });
  const cond = (c) => { const ctx = PYR.sim.createContext(c.course, c.setup, c.athlete, {}); const o = {}; PYR.sim.conditions(ctx, 5000, 600, o); return o; };
  const ch = cond(head), ct = cond(tail), cc = cond(calm);
  assert.ok(Math.abs(ch.wh - 8 * W.WIND_K) < 1e-6 && Math.abs(ct.wh + 8 * W.WIND_K) < 1e-6, `${ch.wh} ${ct.wh}`);
  assert.ok(Math.abs(cc.wh) < 1e-9);
  const vOf = (o, c) => Ph.steadySpeed(c.setup, 250, 0, 1, o.rho, o.wh, o.wc);
  assert.ok(vOf(ct, tail) > vOf(cc, calm) + 1 && vOf(ch, head) < vOf(cc, calm) - 1, 'dos > calme > face');
  // vent de travers : composante de face nulle, composante latérale égale au vent
  const side = cond(flat(12, { weather: mkWeather(L, 3, { ws: () => 8, wd: () => 90 }) }));
  assert.ok(Math.abs(side.wh) < 1e-6 && Math.abs(side.wc - 8 * W.WIND_K) < 1e-6);
  // même effet qu'une portion de vent saisie à la main (air sec, 1013,25 hPa, même température)
  const st = flat(12);
  const manual = setupFor(makeProfile([{ len: 12000, grade: 0 }]), { winds: [{ startKm: 0, endKm: 12, dir: 0, speed: 8 * W.WIND_K * 3.6 }] }, { temperature: 20 }, { aLat: 4.4, vmaxKmh: 90 });
  const a = cond(manual), b = ch;
  assert.ok(Math.abs(a.whM - b.whM) < 1e-4 && Math.abs(a.wcM - b.wcM) < 1e-4, `${a.whM} vs ${b.whM}`);
  assert.ok(Math.abs(a.rho - b.rho) / a.rho < 2e-4, `${a.rho} vs ${b.rho}`); // la pression est arrondie à 0,1 hPa
  assert.ok(st.course.weather === null, 'sans météo : pas de champ');
  // les conditions ne changent pas sans météo
  assert.equal(cond(st).crashK, 1);
  assert.equal(cond(st).heatK, 1);
});

test('conditions : pluie → roulement, limite en virage, freinage, risque de chute', () => {
  const dry = flat(12, { weather: mkWeather(12000, 3) });
  const wet = flat(12, { weather: mkWeather(12000, 3, { rain: () => 3 }) });
  const read = (c) => { const ctx = PYR.sim.createContext(c.course, c.setup, c.athlete, {}); const o = {}; PYR.sim.conditions(ctx, 5000, 600, o); return o; };
  const d = read(dry), w = read(wet);
  assert.ok(Math.abs(w.crr / d.crr - 1.15) < 1e-6);
  assert.ok(Math.abs(w.vlim / d.vlim - 0.85) < 1e-6);
  assert.equal(w.crashK, 3);
  assert.equal(d.crashK, 1);
  assert.ok(w.brakeK < 1 && w.wet === 1);
  // le freinage est moins franc sur route mouillée
  const ctx = PYR.sim.createContext(wet.course, wet.setup, wet.athlete, {});
  const stDry = PYR.sim.initState(ctx, 15), stWet = PYR.sim.initState(ctx, 15);
  const cd = { ...d, vCap: 5 }, cw = { ...w, vCap: 5 };
  PYR.sim.step(ctx, stDry, 0, cd); PYR.sim.step(ctx, stWet, 0, cw);
  assert.ok(stWet.v > stDry.v, `après un freinage : ${stWet.v.toFixed(2)} vs ${stDry.v.toFixed(2)} m/s`);
});

test('averse localisée dans le temps : un coureur en avance ou en retard n\'a pas les mêmes conditions', () => {
  // averse à la 3ᵉ heure, partout sur le parcours
  const c = flat(12, { weather: mkWeather(12000, 6, { rain: (k, h) => (h === 2 ? 4 : 0) }) });
  const ctx = PYR.sim.createContext(c.course, c.setup, c.athlete, {});
  const at = (t) => { const o = {}; PYR.sim.conditions(ctx, 5000, t, o); return o; };
  assert.equal(at(0).crashK, 1, 'avant l\'averse');
  assert.equal(at(2 * HOUR).crashK, 3, 'sous l\'averse');
  assert.ok(Math.abs(at(3 * HOUR).crashK - (1 + 2 * 0.55)) < 1e-6, 'après : la route sèche peu à peu');
  assert.ok(at(5 * HOUR).crashK < 1.4, 'presque sèche');
  // localisée aussi dans l'espace : averse seulement près de l'arrivée
  const loc = flat(12, { weather: mkWeather(12000, 3, { rain: (k) => (k === 1 ? 4 : 0) }) });
  const lctx = PYR.sim.createContext(loc.course, loc.setup, loc.athlete, {});
  const near = (s) => { const o = {}; PYR.sim.conditions(lctx, s, 0, o); return o.crashK; };
  assert.equal(near(0), 1);
  assert.ok(Math.abs(near(12000 - 0.01) - 3) < 1e-3);
  assert.ok(near(6000) > 1 && near(6000) < 3);
});

test('course : plus de chutes sous la pluie, la chaleur use et fait suer', () => {
  const crashes = (rain) => {
    const km = 80;
    const { course, setup, athlete } = flat(km, { weather: mkWeather(km * 1000, 6, { rain: () => (rain ? 4 : 0) }) });
    const race = Race.create({ course, rules: { events: true }, seed: 11, gustSeed: 1 });
    Race.addBots(race, { n: 60, level: 'equal', rider: DEFAULT_RIDER, bike: DEFAULT_BIKE, v0: 8 });
    let n = 0;
    race.onEvent = (e) => { if (e.type === 'crash') n++; };
    Race.runToEnd(race);
    return n;
  };
  const dry = crashes(false), wet = crashes(true);
  assert.ok(wet > dry + 3 && wet > 1.8 * dry, `chutes : ${wet} sous la pluie, ${dry} au sec`);
  // chaleur
  const run = (T, rh) => {
    const { course, setup, athlete } = flat(60, { weather: mkWeather(60000, 6, { T: () => T, rh: () => rh }) });
    const race = Race.create({ course, rules: { fuel: true }, seed: 4, gustSeed: 1 });
    const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 8 });
    Tac.setMode(me, 'tempo', 0);
    for (let i = 0; i < 1800; i++) Race.step(race);
    return { me, loss: PYR.fuel.lossPct(me.fuel) };
  };
  const cool = run(15, 40), hot = run(36, 70);
  assert.ok(cool.me.st.capK > 0.999, `capK frais ${cool.me.st.capK}`);
  assert.ok(hot.me.st.capK < 0.9 && hot.me.st.capK >= 0.85 - 1e-9, `capK chaud ${hot.me.st.capK}`);
  assert.ok(hot.loss > 1.5 * cool.loss, `déshydratation ${hot.loss.toFixed(2)} % contre ${cool.loss.toFixed(2)} %`);
});

test('optimiseur : plus lent avec vent de face et sous la pluie, plan valide', async () => {
  const time = async (over) => {
    const prof = makeProfile([{ len: 15000, grade: 0 }]);
    const { course, setup, athlete } = setupFor(prof, {}, { temperature: 20 }, { aLat: 4.4, vmaxKmh: 90, weather: mkWeather(15000, 4, over) });
    const res = await PYR.optimizer.optimize({ course, setup, athlete, v0: 0 });
    assert.ok(res.ok, res.error);
    assert.ok(res.stats.wbalMin >= -1);
    return res.tFinish;
  };
  const calm = await time(), head = await time({ ws: () => 9, wd: () => 0 }), rain = await time({ rain: () => 3 });
  assert.ok(head > calm + 60, `face ${head.toFixed(0)} s vs calme ${calm.toFixed(0)} s`);
  assert.ok(rain > calm, `pluie ${rain.toFixed(0)} s vs sec ${calm.toFixed(0)} s`);
});

/* ---------- partage : la météo est figée avec le parcours ---------- */
const path = require('path');
require(path.join(__dirname, '..', 'Commun/js/core/codec.js'));
require(path.join(__dirname, '..', 'Commun/js/core/race-data.js'));
const R = PYR.raceData, Cd = PYR.codec;

function shareState(profile, over) {
  const wx = mkWeather(profile.length, 5, { rain: (k, h) => (h === 2 ? 2 : 0), ws: () => 6, wd: () => 90 }, { off: 7200 });
  const startAt = W.epochToLocal(wx.start, wx.off);
  return Object.assign({
    surfaces: [], winds: [], env: { temperature: 20 }, perf: {}, route: { fixed: null },
    weather: { enabled: true, startAt, snapshot: wx, utcOffset: 7200, fetchedAt: 1, fetchedFor: W.freshKey(profile, startAt) },
  }, over);
}

test('partage : heure locale, décalage UTC et clé de fraîcheur du tracé', () => {
  const t = Date.UTC(2026, 9, 12, 6, 30) / 1000;
  assert.equal(W.epochToLocal(t, 7200), '2026-10-12T08:30');
  assert.equal(W.localToEpoch(W.epochToLocal(t, 7200), 7200), t, 'aller-retour');
  assert.equal(W.epochToLocal(t, -18000), '2026-10-12T01:30');
  const prof = makeProfile([{ len: 15000, grade: 0.01 }]);
  assert.equal(W.freshKey(prof, '2026-10-12T08:30'), W.freshKey(prof, '2026-10-12T08:30'));
  assert.notEqual(W.freshKey(prof, '2026-10-12T08:30'), W.freshKey(prof, '2026-10-12T09:00'));
  assert.notEqual(W.freshKey(prof, 'x'), W.freshKey(makeProfile([{ len: 16000, grade: 0 }]), 'x'));
  assert.equal(W.freshKey(null, 'x'), '');
  // la clé survit à la quantification du parcours canonique (µdegrés, centimètres)
  const state = shareState(prof);
  const c = R.canonicalCourse(prof, state);
  assert.equal(W.freshKey(R.geometryProfile(c), state.weather.startAt), state.weather.fetchedFor);
});

test('partage : parcours avec météo — embarquée, empreinte propre, anciens parcours inchangés', () => {
  const prof = makeProfile([{ len: 15000, grade: 0.01 }]);
  const state = shareState(prof);
  const withW = R.canonicalCourse(prof, state);
  assert.ok(withW.weather && withW.weather.v === 1 && withW.weather.off === 7200);
  const noWx = R.canonicalCourse(prof, Object.assign({}, state, { weather: Object.assign({}, state.weather, { enabled: false }) }));
  assert.equal('weather' in noWx, false, 'météo désactivée : rien dans le parcours');
  const sigNo = R.courseSignature(noWx), sigWx = R.courseSignature(withW);
  assert.notEqual(sigNo, sigWx);
  // sans météo, l'empreinte est celle d'avant l'ajout de la météo
  const old = Cd.hash(String(noWx.n), String(noWx.step), noWx.lat, noWx.lng, noWx.ele,
    JSON.stringify({ surfaces: noWx.surfaces, winds: noWx.winds }), JSON.stringify({ env: noWx.env, opts: noWx.opts }), String(R.SEED));
  assert.equal(sigNo, old);
  // un autre ciel : une autre empreinte
  const other = JSON.parse(JSON.stringify(withW)); other.weather.rain[0][0] = 9;
  assert.notEqual(R.courseSignature(other), sigWx);
  // empaquetage et dépaquetage conservent la météo, et l'empreinte
  const back = R.unpackCourse(JSON.parse(JSON.stringify(R.packCourse(withW))));
  assert.deepEqual(back.weather, withW.weather);
  assert.equal(R.courseSignature(back), sigWx);
  // une météo reçue invalide est abandonnée, pas appliquée
  const bad = JSON.parse(JSON.stringify(R.packCourse(withW))); bad.weather.T[0].pop();
  const dropped = R.unpackCourse(bad);
  assert.equal('weather' in dropped, false);
});

test('partage : le parcours chargé est « courant » tant que la météo, le tracé et l\'heure de départ sont les mêmes', () => {
  const prof = makeProfile([{ len: 15000, grade: 0.01 }]);
  const state = shareState(prof);
  const course = R.canonicalCourse(prof, state);
  const loaded = Object.assign({}, state, { route: { fixed: R.courseGeometry(course) } });
  const sig = R.courseSignature(course);
  assert.equal(R.currentSignature(loaded), sig);
  // météo désactivée, ou heure de départ modifiée (prévisions périmées) : ce n'est plus le même parcours
  assert.notEqual(R.currentSignature(Object.assign({}, loaded, { weather: Object.assign({}, loaded.weather, { enabled: false }) })), sig);
  assert.notEqual(R.currentSignature(Object.assign({}, loaded, { weather: Object.assign({}, loaded.weather, { startAt: '2030-01-01T00:00' }) })), sig);
  // un parcours sans météo reste reconnu sans météo
  const plain = R.canonicalCourse(prof, Object.assign({}, state, { weather: { enabled: false } }));
  const plainLoaded = Object.assign({}, state, { weather: { enabled: false }, route: { fixed: R.courseGeometry(plain) } });
  assert.equal(R.currentSignature(plainLoaded), R.courseSignature(plain));
});

test('sauvegarde : un instantané illisible est abandonné, un bon est conservé', () => {
  const wx = mkWeather(10000, 3);
  assert.deepEqual(W.normalize(JSON.parse(JSON.stringify(wx))), wx, 'idempotent : l\'empreinte reste stable après un aller-retour');
  assert.equal(W.normalize(Object.assign({}, wx, { n: 99 })), null);
});

test('affichage : points cardinaux, conditions et cumul de pluie le long du parcours', () => {
  assert.deepEqual([0, 45, 90, 135, 180, 225, 270, 315, 359, 360, -90].map(W.compass), ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO', 'N', 'N', 'O']);
  const L = 10000;
  const w = mkWeather(L, 4, { rain: () => 2, ws: () => 6, wd: () => 0, T: (k, h) => 10 + h });
  const S = W.alongRoute(w, L, { n: 10, timeAt: (s) => s / 5, bearing: () => 0 });
  assert.equal(S.length, 11);
  assert.equal(S[0].s, 0); assert.equal(S[10].s, L);
  assert.equal(S[0].clock, T0, 'départ à l\'heure du départ');
  assert.equal(S[10].clock, T0 + 2000, 'arrivée 2000 s plus tard (5 m/s)');
  assert.ok(Math.abs(S[10].rainCum - (2 * 2000) / 3600) < 1e-6, `pluie reçue ${S[10].rainCum}`);
  assert.equal(S[0].rainCum, 0);
  assert.ok(S.every((q, i) => i === 0 || q.rainCum >= S[i - 1].rainCum));
  assert.ok(Math.abs(S[3].head - 6) < 1e-6, 'vent du nord sur une route plein nord : de face');
  const back = W.alongRoute(w, L, { n: 4, timeAt: (s) => s / 5, bearing: () => 180 });
  assert.ok(Math.abs(back[2].head + 6) < 1e-6, 'route plein sud : de dos');
  const side = W.alongRoute(w, L, { n: 4, timeAt: (s) => s / 5, bearing: () => 90 });
  assert.ok(Math.abs(side[2].head) < 1e-6, 'de travers');
  // la température suit l'heure de passage : plus tard, plus chaud (+1 °C par heure ici)
  const slow = W.alongRoute(w, L, { n: 4, timeAt: (s) => s / 1, bearing: () => 0 });
  assert.ok(slow[4].T > S[10].T, `${slow[4].T} > ${S[10].T}`);
});

test('météo personnalisée : des portions de température, de pluie et de vent, constantes dans le temps', () => {
  const profile = makeProfile([{ len: 20000, grade: 0 }]);
  const custom = { baseT: 18, temp: [{ startKm: 5, endKm: 10, T: 30 }], rain: [{ startKm: 8, endKm: 15, rain: 4 }] };
  const winds = [{ startKm: 0, endKm: 5, dir: 270, speed: 21, gusty: true, gust: 42 }];
  const w = W.fromCustom(profile, custom, winds, { start: T0, off: 0 });
  assert.ok(w, 'instantané valide (passe normalize)');
  assert.ok(w.stations.length <= W.MAX_STATIONS && w.n === 2);
  const at = (km, t) => W.at(w, km * 1000, T0 + (t || 0));
  assert.equal(Math.round(at(2).T), 18, 'hors portion de température : la température de base');
  assert.equal(Math.round(at(7).T), 30);
  assert.equal(Math.round(at(12).T), 18);
  assert.equal(at(2).rain, 0);
  assert.equal(Math.round(at(7).rain), 0);
  assert.equal(Math.round(at(9).rain), 4);
  assert.equal(Math.round(at(14).rain), 4);
  assert.equal(at(18).rain, 0);
  // vent saisi à hauteur de cycliste, ramené à 10 m : le cycliste le ressent comme saisi
  assert.ok(Math.abs(at(2).ws * W.WIND_K * 3.6 - 21) < 0.5, 'vitesse moyenne');
  assert.ok(Math.abs(at(2).gust * W.WIND_K * 3.6 - 42) < 0.5, 'rafales');
  assert.equal(Math.round(at(2).wd), 270);
  assert.equal(at(12).ws, 0, 'air calme hors portion');
  // constant dans le temps
  assert.equal(at(9, 0).rain, at(9, 5 * HOUR).rain);
  assert.equal(at(7, 0).T, at(7, -3 * HOUR).T);
});

test('météo personnalisée : sans portion, une seule pièce ; de nombreuses portions sont toutes conservées', () => {
  const profile = makeProfile([{ len: 30000, grade: 0 }]);
  const plain = W.fromCustom(profile, { baseT: 12 }, [], { start: T0 });
  assert.equal(plain.stations.length, 2);
  assert.equal(Math.round(W.at(plain, 15000, T0).T), 12);
  const many = { baseT: 10, temp: Array.from({ length: 20 }, (_, i) => ({ startKm: i * 1.4, endKm: i * 1.4 + 0.7, T: 20 + i })), rain: Array.from({ length: 20 }, (_, i) => ({ startKm: i * 1.4 + 0.3, endKm: i * 1.4 + 1, rain: 1 })) };
  const w = W.fromCustom(profile, many, [], { start: T0 });
  assert.ok(w && w.stations.length > 48, 'pas de plafond à 24 portions : 40 portions, chacune gardée');
  assert.equal(Math.round(W.at(w, 300, T0).T), 20, 'première portion de température');
  assert.equal(Math.round(W.at(w, 27000, T0).T), 39, 'dernière portion de température');
  assert.ok(w.stations.length <= W.MAX_STATIONS);
  for (let k = 1; k < w.stations.length; k++) assert.ok(w.stations[k].s > w.stations[k - 1].s);
  assert.equal(W.fromCustom(null, {}, [], {}), null, 'pas de parcours');
});
