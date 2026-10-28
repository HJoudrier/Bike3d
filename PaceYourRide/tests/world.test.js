/* author : Hugo Joudrier-Faure */
/* Tests du « même monde » : cyclistes réels dans la course (home-trainer : watts mesurés ; vraie route : position GPS), commande d'un
 * home-trainer FTMS, et messages envoyés à la vue 3D (Bike3D). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR, makeProfile, setupFor } = require('./helpers.js');
require(path.join(__dirname, '..', 'js', 'ui', 'view3d.js'));

const Race = PYR.race, Pr = PYR.presence, Sx = PYR.sensors, V3 = PYR.view3d;

function newRace(profile, rules) {
  const { course, setup, athlete } = setupFor(profile);
  const race = Race.create({ course, rules: rules || {}, seed: 7, gustSeed: 1 });
  return { race, setup, athlete, course };
}

test('vraie route : la position mesurée fait avancer le cycliste, jamais en arrière, passages et arrivée interpolés', () => {
  const { race, setup, athlete, course } = newRace(makeProfile([{ len: 3000, grade: 0 }]), { events: true, sprints: 1 });
  race.cps = PYR.classif.normalize([{ type: 'sprint', s: 1505 }], course.length);
  const me = Race.addRider(race, { id: 'me', name: 'Moi', human: true, driven: true, setup, athlete });
  const bot = Race.addBots(race, { n: 2, level: 'equal', rider: { weight: 72, ftp: 250, records: {} }, bike: {} })[0];
  let s = 0;
  for (let t = 0; t < 400 && !me.finished; t++) {
    s += 9;
    // un point GPS bruité qui recule de 4 m : la position reste où elle était
    me.drive = { s: t === 50 ? s - 13 : s, v: 9, P: 210 };
    Race.step(race);
    if (t === 50) assert.equal(me.st.s, 9 * 50, 'pas de retour en arrière');
    if (t === 49) assert.equal(me.st.s, 9 * 50);
  }
  assert.ok(me.finished, 'arrivé');
  assert.ok(Math.abs(me.time - course.length / 9) < 1.01, `temps d'arrivée ${me.time}`);
  assert.ok(Math.abs(me.splits[0] - 1505 / 9) < 1.01, `passage au sprint ${me.splits[0]}`);
  assert.equal(me.stats.incidents.filter((e) => e.type === 'puncture' || e.type === 'crash').length, 0, 'pas d\'incident tiré au sort');
  assert.equal(me.draft.R || 0, 0, 'pas d\'abri pour un cycliste sur la route');
  assert.ok(Math.abs(me.stats.sumP / me.st.t - 210) < 1, 'la puissance du capteur compte dans les statistiques');
  assert.ok(bot.st.s > 0, 'les coureurs virtuels roulent à côté');
});

test('vraie route : W′ suit la puissance mesurée (Skiba), sans GPS on reste sur place', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 5000, grade: 0 }]));
  const me = Race.addRider(race, { id: 'me', name: 'Moi', human: true, driven: true, setup, athlete });
  const w0 = me.ctx.w0, cp = me.ctx.cp;
  me.drive = null;
  Race.step(race);
  assert.equal(me.st.s, 0, 'sans position, on ne bouge pas');
  for (let t = 0; t < 30; t++) { me.drive = { s: (t + 1) * 10, v: 10, P: cp + 200 }; Race.step(race); }
  assert.ok(Math.abs(me.st.wbal - (w0 - 30 * 200)) < 1, `W′ dépensé : ${w0 - me.st.wbal}`);
  for (let t = 30; t < 90; t++) { me.drive = { s: (t + 1) * 10, v: 10, P: 100 }; Race.step(race); }
  assert.ok(me.st.wbal > w0 - 30 * 200 + 1000, 'W′ se reconstitue sous la PC');
});

test('home-trainer : les watts mesurés ne sont pas plafonnés par le modèle, ceux d\'un avatar le sont', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 6000, grade: 0.08 }]));
  const me = Race.addRider(race, { id: 'me', name: 'Moi', human: true, measured: true, setup, athlete });
  const av = Race.addRider(race, { id: 'av', name: 'Avatar', human: true, setup, athlete });
  const big = athlete.pmax * 1.5;
  for (let t = 0; t < 40; t++) {
    me.tac.cmd = big;
    av.tac.cmd = big;
    Race.step(race);
  }
  assert.ok(Math.abs(me.lastP - big) < 1, `home-trainer : ${me.lastP} W`);
  assert.ok(av.lastP < big * 0.8, `avatar plafonné : ${av.lastP} W`);
  assert.ok(me.st.wbal < 0, 'W′ du modèle sous zéro : le modèle sous-estimait le cycliste');
  assert.ok(me.st.s > av.st.s, 'plus de watts, plus loin');
});

test('puissance mesurée : moyenne des mesures récentes, 0 W quand le capteur se tait, rien avant la première mesure', () => {
  const f = Pr.createPowerFeed();
  assert.equal(f.at(1000), null);
  f.push(200, 1000); f.push(220, 1500); f.push(240, 2000);
  assert.equal(f.at(2000), 220);
  assert.equal(f.at(2600), 230, 'les mesures de plus de 1,5 s sont sorties');
  assert.equal(f.at(5500), 0, 'plus rien depuis 3,5 s');
  f.push(Number.NaN, 6000); f.push(9000, 6000);
  assert.equal(f.at(6000), 0, 'mesures aberrantes ignorées');
});

test('vraie route : les points GPS projetés sur le tracé donnent la position, prolongée entre deux points, jamais en arrière', () => {
  const profile = makeProfile([{ len: 2000, grade: 0 }, { len: 2000, grade: 0.03, turn: 0 }]);
  const { course } = setupFor(profile);
  const road = Pr.createRoadFeed(course);
  assert.equal(road.at(0).ok, false);
  const at = (s) => { const i = Math.round(s / course.step); return { lat: course.lat[i], lng: course.lng[i] }; };
  let ts = 0;
  for (let s = 0; s <= 600; s += 8) { const p = at(s); road.fix({ lat: p.lat, lng: p.lng + 0.00002, acc: 5, speed: 8, ts }); ts += 1000; }
  const r = road.at(ts - 1000);
  assert.ok(r.ok && Math.abs(r.s - 600) < 15, `position ${r.s}`);
  assert.ok(Math.abs(r.v - 8) < 0.5, `vitesse ${r.v}`);
  const ahead = road.at(ts + 500);
  assert.ok(ahead.s > r.s + 8 && ahead.s < r.s + 16, `prolongée : ${ahead.s}`);
  const p = at(560);
  road.fix({ lat: p.lat, lng: p.lng, acc: 5, speed: 0, ts: ts + 1000 }); // un point en arrière
  assert.ok(road.at(ts + 1000).s >= ahead.s, 'jamais en arrière');
  // loin du tracé : pas de position
  const lost = Pr.createRoadFeed(course);
  lost.fix({ lat: course.lat[0] + 0.05, lng: course.lng[0], acc: 5, ts: 0 });
  assert.equal(lost.at(0).ok, false);
});

test('home-trainer : charge FTMS (pente devant, vent de face, roulement, cw réduit par l\'abri)', () => {
  const { course, setup } = setupFor(makeProfile([{ len: 1000, grade: 0 }, { len: 2000, grade: 0.06 }]));
  const cond = {};
  PYR.sim.conditions(PYR.sim.createContext(course, setup, PYR.physio.buildAthlete({ weight: 72, ftp: 250, records: {} })), 1500, 0, cond);
  const flat = Pr.trainerLoad(course, setup, 200, cond, 1);
  const climb = Pr.trainerLoad(course, setup, 1500, cond, 1);
  assert.ok(Math.abs(flat.grade) < 0.2, `plat : ${flat.grade}`);
  assert.ok(Math.abs(climb.grade - 6) < 0.3, `côte : ${climb.grade}`);
  assert.ok(climb.cw > 0.15 && climb.cw < 0.4, `cw ${climb.cw}`);
  const drafted = Pr.trainerLoad(course, setup, 1500, cond, 0.6);
  assert.ok(Math.abs(drafted.cw - climb.cw * 0.6) < 1e-9, 'abri : cw réduit');
  assert.ok(climb.crr > 0 && climb.crr < 0.02);
  const windy = Pr.trainerLoad(course, setup, 1500, Object.assign({}, cond, { wh: 4 }), 1);
  assert.equal(windy.wind, 4, 'vent de face positif');
});

test('FTMS : octets de « Set Indoor Bike Simulation Parameters »', () => {
  const b = Sx.ftmsSimBytes({ grade: 5.5, wind: -2.5, crr: 0.004, cw: 0.51 });
  const dv = new DataView(b.buffer);
  assert.equal(b.length, 7);
  assert.equal(dv.getUint8(0), 0x11);
  assert.equal(dv.getInt16(1, true), -2500);
  assert.equal(dv.getInt16(3, true), 550);
  assert.equal(dv.getUint8(5), 40);
  assert.equal(dv.getUint8(6), 51);
  const steep = new DataView(Sx.ftmsSimBytes({ grade: -12, wind: 0, crr: 1, cw: 9 }).buffer);
  assert.equal(steep.getInt16(3, true), -1200);
  assert.equal(steep.getUint8(5), 255, 'borné');
  assert.equal(steep.getUint8(6), 255, 'borné');
});

test('FTMS : prise de contrôle, départ, puis charge envoyée au plus toutes les 2 s et seulement si elle change', async () => {
  const writes = [];
  const cp = { async startNotifications() {}, async writeValueWithResponse(b) { writes.push(Array.from(b)); } };
  const dev = { gatt: { connected: true, async getPrimaryService(s) { if (s !== 'fitness_machine') throw new Error('non'); return { async getCharacteristic(c) { if (c !== 'fitness_machine_control_point') throw new Error('non'); return cp; } }; } } };
  const tr = Sx.makeTrainer();
  assert.equal(await tr.attach(dev), 'on');
  assert.deepEqual(writes, [[0x00], [0x07]]);
  const L = { grade: 4, wind: 1, crr: 0.004, cw: 0.3 };
  assert.equal(await tr.set(L, 10000), true);
  assert.equal(await tr.set(L, 13000), false, 'même charge : rien à envoyer');
  assert.equal(await tr.set(Object.assign({}, L, { grade: 6 }), 10500), false, 'trop tôt');
  assert.equal(await tr.set(Object.assign({}, L, { grade: 6 }), 12100), true);
  assert.equal(writes.length, 4);
  assert.equal(writes[3][0], 0x11);
  // un capteur de puissance seul (pas de point de contrôle) : non pilotable
  const plain = Sx.makeTrainer();
  assert.equal(await plain.attach({ gatt: { connected: true, async getPrimaryService() { throw new Error('Service introuvable'); } } }), 'unsupported');
  assert.equal(await plain.set(L, 0), false);
});

test('présence : codes de la course en direct', () => {
  for (const k of Pr.KINDS) assert.equal(Pr.fromCode(Pr.CODE[k]), k);
  assert.equal(Pr.fromCode(undefined), 'avatar', 'ancienne version : avatar');
  assert.equal(Pr.fromCode('x'), 'avatar');
  assert.equal(Pr.normKind('road'), 'road');
  assert.equal(Pr.normKind('robot'), 'avatar');
});

test('vue 3D : message du parcours (empreinte stable, même graine pour tous) et de chaque image', () => {
  const { course } = setupFor(makeProfile([{ len: 4000, grade: 0.02 }]));
  const cps = PYR.classif.normalize([{ type: 'sprint', s: 1500 }, { type: 'kom', s: 3800, cat: '3', start: 2000 }], course.length);
  const a = V3.courseMessage(course, cps, [{ s: 2500, end: 3000 }], { name: 'Hugo', color: '#eb6834', cp: 260 });
  const b = V3.courseMessage(course, cps, [{ s: 2500, end: 3000 }], { name: 'Chloé' });
  assert.equal(a.type, 'course');
  assert.equal(a.key, b.key, 'même parcours, même empreinte');
  assert.equal(a.seed, b.seed, 'même graine de paysage pour tous les joueurs');
  const noFeed = V3.courseMessage(course, cps, [], { name: 'Chloé' });
  assert.notEqual(noFeed.key, a.key, 'autres ravitaillements : la vue se reconstruit…');
  assert.equal(noFeed.seed, a.seed, '… dans le même paysage');
  assert.equal(a.lat.length, course.lat.length);
  assert.equal(a.cps.find((c) => c.type === 'kom').start, 2000);
  assert.deepEqual(a.feed, [{ s: 2500, end: 3000 }]);
  assert.equal(a.cp, 260);
  const other = setupFor(makeProfile([{ len: 4000, grade: 0.03 }])).course;
  assert.notEqual(V3.courseKey(other), a.key, 'autre relief, autre empreinte');

  const f = V3.frameMessage({
    course, t: 12.345, k: 5, run: true,
    me: { id: 'me', name: 'Hugo', color: '#eb6834', kind: 'trainer', s: 101.234, y: 0.5, v: 9.876, P: 251.4, w: 0.8, dr: 0.3 },
    others: [{ id: 'bot1', name: 'Léa', color: '#3d7be0', kind: 'bot', s: 90, v: 9, P: 200, st: true }, { id: 'live-x', name: 'Max', kind: 'road', s: 50, v: 8, fin: true }],
  });
  assert.equal(f.type, 'frame');
  assert.equal(f.me, 'me');
  assert.equal(f.t, 12.35);
  assert.equal(f.k, 5);
  assert.equal(f.riders.length, 3);
  assert.deepEqual(f.riders[0], { id: 'me', name: 'Hugo', color: '#eb6834', kind: 'trainer', s: 101.23, v: 9.88, y: 0.5, P: 251, w: 0.8, dr: 0.3 });
  assert.equal(f.riders[1].st, true);
  assert.equal(f.riders[2].kind, 'road');
  assert.equal(f.riders[2].fin, true);
  assert.equal(f.riders[2].y, undefined, 'sans position latérale : la vue choisit une voie');
  assert.equal(f.env.T, course.temperature);
});

test('vue 3D : météo à la position et à l\'heure du joueur (heure locale du départ)', () => {
  const { course } = setupFor(makeProfile([{ len: 4000, grade: 0 }]));
  const start = Date.UTC(2026, 5, 21, 7, 0, 0) / 1000; // 9 h à Paris (UTC+2)
  const w = {
    v: 1, start, off: 7200, t0: start - 3600, n: 3,
    stations: [{ s: 0, lat: course.lat[0], lng: course.lng[0], ele: 200 }],
    T: [[12, 14, 16]], rh: [[70, 70, 70]], p: [[1013, 1013, 1013]], rain: [[0, 2, 4]], ws: [[3, 3, 3]], wd: [[270, 270, 270]], gust: [[5, 5, 5]],
  };
  course.weather = PYR.weather.normalize ? PYR.weather.normalize(w) || w : w;
  const e0 = V3.envAt(course, 100, 0);
  assert.ok(Math.abs(e0.hour - 9) < 1e-6, `heure ${e0.hour}`);
  assert.ok(Math.abs(e0.T - 14) < 0.01 && Math.abs(e0.rain - 2) < 0.01, `T ${e0.T}, pluie ${e0.rain}`);
  assert.ok(Math.abs(e0.wd - 270) < 0.01);
  const e1 = V3.envAt(course, 100, 1800);
  assert.ok(Math.abs(e1.hour - 9.5) < 1e-6 && Math.abs(e1.rain - 3) < 0.01, `une demi-heure plus tard : ${e1.hour} h, ${e1.rain} mm/h`);
});

test('revêtements : portions effectives (la dernière l\'emporte), largeur, regroupement des cellules', () => {
  const profile = makeProfile([{ len: 5000, grade: 0 }]);
  const surfaces = [
    { startKm: 1, endKm: 2, surface: 'cobbles' },
    { startKm: 1.5, endKm: 2.5, surface: 'gravel_loose', width: 2.5 },
    { startKm: 3, endKm: 3.4, surface: 'custom', factor: 3.2 },
    { startKm: 4, endKm: 4.5, surface: 'asphalt', width: 8 },
  ];
  const { course } = setupFor(profile, { surfaces }, { temperature: 20, roadWidth: 5 });
  const runs = PYR.course.surfaceRuns(course);
  assert.deepEqual(runs.map((r) => r.surface), ['cobbles', 'gravel_loose', 'custom', 'asphalt']);
  const near = (x, y) => Math.abs(x - y) <= course.step + 1e-6;
  assert.ok(near(runs[0].s, 1000) && near(runs[0].end, 1500), `pavés ${runs[0].s}–${runs[0].end}`);
  assert.ok(near(runs[1].s, 1500) && near(runs[1].end, 2500), 'le gravier recouvre la fin des pavés');
  assert.equal(runs[0].width, 4, 'largeur du revêtement (pavés : 4 m)');
  assert.equal(runs[1].width, 2.5, 'largeur saisie sur la portion');
  assert.equal(runs[3].width, 8);
  assert.ok(Math.abs(runs[2].factor - 3.2) < 1e-6);
  assert.equal(course.roadWidth, 5);
  assert.deepEqual(PYR.course.surfaceRuns(setupFor(profile).course), [], 'sans portion : rien');

  // dans le message de la vue : aspect de chaque portion (un coefficient personnalisé prend l'aspect le plus proche), largeur par défaut
  const msg = V3.courseMessage(course, [], [], { name: 'Hugo' });
  assert.deepEqual(msg.surfaces.map((x) => x.kind), ['cobbles', 'gravel_loose', 'dirt', 'asphalt']);
  assert.equal(msg.surfaces[1].w, 2.5);
  assert.equal(msg.roadW, 5);
  assert.equal(V3.surfaceKind({ surface: 'custom', factor: 0.9 }), 'smooth');
  assert.equal(V3.surfaceKind({ surface: 'custom', factor: 1.4 }), 'rough');
  assert.equal(V3.surfaceKind({ surface: 'custom', factor: 2 }), 'gravel_hard');
  assert.equal(V3.surfaceKind({ surface: 'custom', factor: 9 }), 'grass');
  // une portion de plus : la route se redessine, dans le même paysage
  const plain = V3.courseMessage(setupFor(profile, {}, { temperature: 20, roadWidth: 5 }).course, [], [], { name: 'Hugo' });
  assert.notEqual(plain.key, msg.key);
  assert.equal(plain.seed, msg.seed);
});

test('peloton 2D : aucun coureur n\'en chevauche un autre, même dans un gros peloton qui remonte et relaie', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 8000, grade: 0 }, { len: 3000, grade: 0.05, turn: 40 }]), { peloton: true, events: true });
  const me = Race.addRider(race, { id: 'me', name: 'Moi', human: true, setup, athlete });
  me.tac.cmd = 230;
  Race.addBots(race, { n: 40, level: 'mixed', rider: { weight: 72, ftp: 250, records: {} }, bike: {} });
  PYR.peloton.grid(race);
  const BIKE = PYR.draft.BIKE, DY = PYR.peloton.MIN_DY - 0.02;
  let worst = 0;
  for (let t = 0; t < 1500 && race.riders.some((r) => !r.finished); t++) {
    Race.step(race);
    const rs = race.riders.filter((r) => !r.finished && !r.incident);
    for (let a = 0; a < rs.length; a++) for (let b = a + 1; b < rs.length; b++) {
      const ds = Math.abs(rs[a].st.s - rs[b].st.s), dy = Math.abs(rs[a].lat.y - rs[b].lat.y);
      if (ds < BIKE && dy < DY) worst = Math.max(worst, BIKE - ds);
    }
  }
  assert.equal(worst, 0, `chevauchement de ${worst.toFixed(2)} m`);
});

test('peloton 2D : arrivé trop vite dans la roue de quelqu\'un, on freine derrière lui ; décalé d\'une voie, on le double', () => {
  for (const dy of [0, 0.6]) {
    const { race, setup, athlete } = newRace(makeProfile([{ len: 3000, grade: 0 }]), { peloton: true });
    const slow = Race.addRider(race, { id: 'a', name: 'Lent', human: true, setup, athlete, v0: 3 });
    const fast = Race.addRider(race, { id: 'b', name: 'Rapide', human: true, setup, athlete, v0: 15 });
    slow.st.s = 104; slow.prevS = 104; fast.st.s = 100; fast.prevS = 100;
    PYR.peloton.setY(slow, 0); PYR.peloton.setY(fast, dy);
    slow.tac.cmd = 60; fast.tac.cmd = 600;
    const bumps = [];
    race.onEvent = (ev) => { if (ev.type === 'bump') bumps.push(ev); };
    Race.step(race);
    if (dy === 0) {
      assert.ok(fast.st.s <= slow.st.s - PYR.draft.BIKE - 0.04, `retenu derrière : ${fast.st.s.toFixed(2)} / ${slow.st.s.toFixed(2)}`);
      assert.ok(fast.st.v <= slow.st.v + 1e-9, 'à sa vitesse');
      assert.equal(bumps.length, 1, 'le joueur est prévenu');
      assert.equal(bumps[0].other, 'a');
    } else {
      assert.ok(fast.st.s > slow.st.s, 'une voie à côté : il passe');
      assert.equal(bumps.length, 0);
    }
  }
});

test('peloton 2D : un cycliste sur la vraie route n\'est jamais retenu, les autres l\'évitent', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 3000, grade: 0 }]), { peloton: true });
  const real = Race.addRider(race, { id: 'r', name: 'Réel', human: true, driven: true, setup, athlete, v0: 3 });
  const bot = Race.addRider(race, { id: 'b', name: 'Virtuel', human: true, setup, athlete, v0: 15 });
  real.st.s = 104; real.prevS = 104; bot.st.s = 100; bot.prevS = 100;
  PYR.peloton.setY(real, 0); PYR.peloton.setY(bot, 0);
  bot.tac.cmd = 600;
  real.drive = { s: 107, v: 3, P: 100 };
  Race.step(race);
  assert.equal(real.st.s, 107, 'la position mesurée est gardée');
  assert.ok(bot.st.s <= 107 - PYR.draft.BIKE - 0.04, 'le coureur virtuel reste derrière lui');
  // un cycliste réel qui rattrape un coureur virtuel le traverse (il roule pour de vrai) : c'est au virtuel de s'écarter
  const r2 = newRace(makeProfile([{ len: 3000, grade: 0 }]), { peloton: true });
  const ahead = Race.addRider(r2.race, { id: 'v', name: 'Virtuel', human: true, setup: r2.setup, athlete: r2.athlete, v0: 3 });
  const behind = Race.addRider(r2.race, { id: 'r', name: 'Réel', human: true, driven: true, setup: r2.setup, athlete: r2.athlete, v0: 8 });
  ahead.st.s = 104; ahead.prevS = 104; behind.st.s = 100; behind.prevS = 100;
  PYR.peloton.setY(ahead, 0); PYR.peloton.setY(behind, 0);
  ahead.tac.cmd = 60;
  behind.drive = { s: 108, v: 8, P: 250 };
  Race.step(r2.race);
  assert.equal(behind.st.s, 108);
});

test('crevaisons : risque selon le revêtement et la résistance du pneu sur ce terrain', () => {
  const Ph = PYR.physics;
  const profile = makeProfile([{ len: 6000, grade: 0 }]);
  const surfaces = [
    { startKm: 1, endKm: 2, surface: 'cobbles_hard' }, { startKm: 2, endKm: 3, surface: 'gravel_loose' },
    { startKm: 3, endKm: 4, surface: 'dirt' }, { startKm: 4, endKm: 5, surface: 'custom', factor: 3 },
  ];
  const { course } = setupFor(profile, { surfaces });
  const cell = (km) => Math.floor(km * 1000 / course.step);
  const tire = (id) => Ph.buildSetup({ weight: 72, height: 178 }, { tire: id });
  const risk = (km, id) => Race.punctureRisk(course, cell(km), tire(id));
  assert.equal(risk(0.5, 'road'), 1, 'pneu route sur l\'asphalte : la référence (une crevaison tous les 250 km)');
  assert.equal(risk(1.5, 'road'), 8, 'pavés difficiles');
  assert.equal(risk(2.5, 'road'), 8, 'gravier meuble');
  assert.equal(risk(3.5, 'road'), 4, 'chemin de terre');
  assert.equal(risk(4.5, 'road'), 5, 'personnalisé ×3 : terrain gravier');
  assert.ok(risk(2.5, 'race') > risk(2.5, 'road'), 'le latex se coupe sur le gravier');
  assert.ok(Math.abs(risk(2.5, 'gravel') - 8 * 0.2) < 1e-9, 'pneu gravel : cinq fois moins');
  assert.ok(risk(1.5, 'tubeless') < risk(1.5, 'road') * 0.6, 'un tubeless ne pince pas sur les pavés');
  assert.ok(risk(0.5, 'training') < risk(0.5, 'road') && risk(1.5, 'training') / risk(0.5, 'training') > 8, 'renforcé : très sûr sur la route, mais il pince sur les pavés');
  for (const t of Ph.TIRES) assert.equal(t.pt.length, Ph.PUNCT_TERRAINS.length);
  assert.equal(tire('tubeless').sealant, true);
});

test('crevaisons : en course, bien plus sur le gravier et les pavés, et bien moins avec des pneus gravel', () => {
  const count = (surface, tireId) => {
    const prof = makeProfile([{ len: 30000, grade: 0 }]);
    const { course } = setupFor(prof, surface ? { surfaces: [{ startKm: 0, endKm: 30, surface }] } : {});
    const race = Race.create({ course, rules: { events: true }, seed: 5, gustSeed: 1 });
    Race.addBots(race, { n: 12, level: 'equal', rider: { weight: 72, height: 178, ftp: 250, records: {} }, bike: { tire: tireId }, v0: 5 });
    Race.runToEnd(race);
    return race.events.filter((e) => e.type === 'puncture' || e.type === 'sealed').length;
  };
  const asphalt = count(null, 'road'), cobbles = count('cobbles_hard', 'road');
  const gravelRoad = count('gravel_loose', 'road'), gravelTires = count('gravel_loose', 'gravel');
  // 12 coureurs × 30 km = 360 km : ≈ 1,4 crevaison attendue sur l'asphalte, ≈ 11,5 sur les pavés ou le gravier, ≈ 2,3 en pneus gravel
  assert.ok(cobbles >= 5 && cobbles > 3 * Math.max(1, asphalt), `pavés ${cobbles} / asphalte ${asphalt}`);
  assert.ok(gravelRoad >= 5 && gravelRoad > 2.5 * Math.max(1, gravelTires), `gravier : pneus route ${gravelRoad} / pneus gravel ${gravelTires}`);
});
