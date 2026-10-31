/* author : Hugo Joudrier-Faure */
/* Tests du « même monde » : cyclistes réels dans la course (home-trainer : watts mesurés ; vraie route : position GPS), commande d'un
 * home-trainer FTMS, et messages envoyés à la vue 3D (Bike3D). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR, makeProfile, setupFor } = require('./helpers.js');
require(path.join(__dirname, '..', 'Commun', 'js', 'jeu', 'view3d.js'));

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

/* ---------- vélo en 3D : le magasin et la vue 3D montrent le même cycliste (B3D.Cyclist de Bike3D) ---------- */

require(path.join(__dirname, '..', 'Commun', 'js', 'ui', 'gear-art.js'));
const fs = require('fs');
const BIKE3D = path.join(__dirname, '..', 'VirtualRide3D', 'univers');   // l'univers 3D du jeu (Bike3D)
const hasBike3d = fs.existsSync(path.join(BIKE3D, 'js', 'cyclist.js'));

/** Bike3D chargé à part (three.js, utilitaires, rendu cartoon, anatomie, cycliste ; peloton en plus si demandé), avec un faux
 *  canevas pour les textures (maillot, inscriptions des jantes) : renvoie B3D. */
function bike3d(more) {
  const vm = require('vm');
  const noop = new Proxy(function () {}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 10 }) : noop), apply: () => undefined, set: () => true });
  const ctx = { console: { log() {}, warn() {}, error() {} }, document: { createElement: () => ({ width: 0, height: 0, getContext: () => noop }) } };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['vendor/three.min.js', 'js/util.js', 'js/toon.js', 'js/anatomy.js', 'js/cyclist.js'].concat(more || [])) vm.runInContext(fs.readFileSync(path.join(BIKE3D, f), 'utf8'), ctx, { filename: f });
  return ctx.B3D;
}
/** Le cycliste de Bike3D : ses listes d'équipement, sa géométrie. */
function bike3dCyclist() { return bike3d().Cyclist; }

test('vélo 3D : modèle de cadre et de roues du magasin, cadre de VTT ou de ville, roues de 60 et 80 mm', () => {
  const G = PYR.gearArt.gear3d, Cat = PYR.catalog;
  const rider = { position: 'drops', helmet: 'aero', clothing: 'skinsuit', glasses: 'shield', socks: 'aero' };
  const g = G({ rider, bike: { frame: 'road', wheels: 'deep80', tire: 'race', shoes: 'carbon' }, picks: { frame: 'endurance', wheels: 'c80' } });
  assert.deepEqual(g, { frame: 'endurance', wheels: 'c80', tire: 'race', position: 'drops', helmet: 'aero', clothing: 'skinsuit', glasses: 'shield', socks: 'aero', shoes: 'carbon', sex: 'm' });
  assert.equal(G({ rider: Object.assign({ sex: 'f' }, rider), bike: {} }).sex, 'f', 'une cycliste (profil de la page Athlète)');
  // article du magasin qui ne correspond plus au réglage (modifié dans l'onglet Équipement) : le modèle de référence du réglage
  assert.equal(G({ bike: { frame: 'road', wheels: 'deep' }, picks: { frame: 'aero', wheels: 'c45' } }).frame, 'alu');
  assert.equal(G({ bike: { frame: 'road', wheels: 'deep' }, picks: { frame: 'aero', wheels: 'c45' } }).wheels, 'c65');
  assert.equal(G({ bike: { frame: 'mtb' } }).frame, 'mtb');
  assert.equal(G({ bike: { frame: 'city' } }).frame, 'city');
  assert.equal(Cat.get('wheels', 'c65').name, 'Carbone 60 mm');
  const c80 = Cat.get('wheels', 'c80');
  assert.ok(PYR.physics.byId(PYR.physics.WHEELS, c80.bike.wheels).dcda < PYR.physics.byId(PYR.physics.WHEELS, 'deep').dcda, '80 mm : plus aérodynamiques que 60 mm');
  assert.ok(c80.mass > Cat.get('wheels', 'c65').mass && c80.price > Cat.get('wheels', 'c65').price, 'plus lourdes et plus chères');
  assert.equal(G({ bike: { wheels: 'deep80' } }).wheels, 'c80');
  // chaque cadre et chaque paire de roues du magasin se voit en 3D comme tel
  for (const it of Cat.ITEMS.frame) assert.equal(G({ bike: it.bike, picks: { frame: it.id } }).frame, it.id);
  for (const it of Cat.ITEMS.wheels) assert.equal(G({ bike: it.bike, picks: { wheels: it.id } }).wheels, it.id);
});

test('vélo 3D : Bike3D connaît chaque cadre, roue, pneu, position, casque, tenue, lunettes, chaussettes et chaussures', { skip: !hasBike3d && 'Bike3D absent' }, () => {
  const C = bike3dCyclist(), Ph = PYR.physics, Cat = PYR.catalog, L = C.GEAR;
  const known = (list, ids, what) => { for (const id of ids) assert.ok(list.includes(id), `${what} inconnu de Bike3D : ${id}`); };
  known(L.frames, Cat.ITEMS.frame.map((it) => it.id).concat(['mtb', 'city']), 'cadre');
  known(L.wheels, Cat.ITEMS.wheels.map((it) => it.id), 'roues');
  known(L.tires, Ph.TIRES.filter((t) => t.id !== 'custom').map((t) => t.id), 'pneu');
  known(L.positions, Ph.POSITIONS.map((x) => x.id), 'position');
  known(L.helmets, Ph.HELMETS.map((x) => x.id), 'casque');
  known(L.clothing, Ph.CLOTHING.map((x) => x.id), 'tenue');
  known(L.glasses, Ph.GLASSES.map((x) => x.id), 'lunettes');
  known(L.socks, Ph.SOCKS.map((x) => x.id), 'chaussettes');
  known(L.shoes, Ph.SHOES.map((x) => x.id), 'chaussures');
  // l'équipement envoyé passe tel quel ; un pneu personnalisé ou une valeur inconnue prend celle du vélo du jeu
  const g = PYR.gearArt.gear3d({ rider: { position: 'tt_pro', helmet: 'tt', clothing: 'skinsuit_tt', glasses: 'none', socks: 'classic' }, bike: { frame: 'tt', wheels: 'disc', tire: 'tubeless', shoes: 'aero' }, picks: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(C.normGear(g))), g); // (objet venu d'un autre contexte)
  assert.equal(C.normGear(PYR.gearArt.gear3d({ rider: { sex: 'f' }, bike: {}, picks: {} })).sex, 'f');
  const n = C.normGear({ frame: 'gravel', tire: 'custom', position: 'superman', sex: 'x' });
  assert.equal(n.sex, 'm');
  assert.equal(n.frame, 'gravel');
  assert.equal(n.tire, 'road');
  assert.equal(n.position, 'hoods');
  assert.equal(C.normGear(null).wheels, 'tri', 'sans équipement : les roues à bâtons du jeu');
});

/** Distance (dans le plan du cadre : y, z) d'un point à un tube vu de profil : rectangle d'axe [a, b] et de demi-épaisseur h. */
function toTube(p, a, b, h) {
  const len = Math.hypot(b.y - a.y, b.z - a.z), uy = (b.y - a.y) / len, uz = (b.z - a.z) / len;
  const py = p.y - a.y, pz = p.z - a.z, s = py * uy + pz * uz, w = Math.abs(pz * uy - py * uz);
  return Math.hypot(Math.max(0, -s, s - len), Math.max(0, w - h));
}

test('vélo 3D : la roue avant ne touche pas le cadre, le bidon est posé sur le tube oblique', { skip: !hasBike3d && 'Bike3D absent' }, () => {
  const C = bike3dCyclist();
  for (const id of C.GEAR.frames) {
    const L = C.layout(id), F = L.F, R = L.R, A = L.frontAxle;
    const depth = (r, prof) => r * (prof > 1.2 ? Math.sqrt(prof) : 1); // demi-épaisseur d'un tube profilé dans le plan du cadre
    // fourche : l'axe de roue devant l'axe de direction (déport), sinon la roue recule contre le tube oblique
    const rake = A.z - L.onHead(R).z;
    assert.ok(rake > 0.03 && rake < 0.07, `${id} : déport de fourche ${rake.toFixed(3)} m`);
    // tube oblique : partie droite, puis arc éventuel autour de l'axe avant
    const gapDt = toTube(A, L.dt[0], L.dt[1], L.dtHalf) - R;
    assert.ok(gapDt >= 0.01, `${id} : pneu avant à ${(gapDt * 100).toFixed(1)} cm du tube oblique`);
    if (L.arc) {
      assert.ok(L.arc.r - L.dtHalf - R >= 0.01, `${id} : passage de roue trop serré`);
      const end = L.arc.at(L.arc.to);
      assert.ok(end.y > F.hb[0] && end.y < F.ht && Math.abs(end.z - L.onHead(end.y).z) < 1e-9, `${id} : le tube oblique arrive sur la douille`);
    }
    const gapHt = toTube(A, L.htBot, L.htTop, depth(0.028 * F.k, F.prof > 1.2 ? 1.6 : 1)) - R;
    assert.ok(gapHt >= 0.008, `${id} : pneu avant à ${(gapHt * 100).toFixed(1)} cm de la douille`);
    // roue arrière et tube de selle
    const gapSt = toTube(L.rearAxle, L.BB, L.stTop, depth(0.022 * F.k, F.prof)) - R;
    assert.ok(gapSt >= 0.005, `${id} : pneu arrière à ${(gapSt * 100).toFixed(1)} cm du tube de selle`);
    if (!F.bottle) continue;
    // bidon : parallèle au tube oblique, bouchon vers le haut, contre le tube sans le traverser, dans le triangle du cadre
    const B = L.bottle, u = L.dt[1].clone().sub(L.dt[0]).normalize();
    assert.ok(B.dir.dot(u) > 0.9999 && B.dir.y > 0, `${id} : bidon dans le sens du tube oblique`);
    const off = toTube(B.center, L.dt[0], L.dt[1], 0);
    assert.ok(off > L.dtHalf + L.BOTTLE_R && off < L.dtHalf + L.BOTTLE_R + 0.008, `${id} : bidon à ${off.toFixed(3)} m de l'axe du tube oblique`);
    const n = { y: B.dir.z, z: -B.dir.y }; // vers l'intérieur du cadre (le tube de selle)
    assert.ok((B.center.y - L.BB.y) * n.y + (B.center.z - L.BB.z) * n.z > 0, `${id} : bidon au-dessus du tube oblique`);
    for (const [ka, kb] of [[-0.1, -1], [-0.1, 1], [0.1, -1], [0.1, 1]]) {
      const p = { y: B.center.y + B.dir.y * ka + n.y * kb * L.BOTTLE_R, z: B.center.z + B.dir.z * ka + n.z * kb * L.BOTTLE_R };
      assert.ok(toTube(p, L.BB, L.stTop, depth(0.022 * F.k, F.prof)) > 0.02, `${id} : bidon contre le tube de selle`);
      assert.ok(toTube(p, L.stTop, L.onHead(F.ht - 0.02), depth(0.02 * F.k, F.prof > 1.2 ? 1.5 : 1)) > 0.02, `${id} : bidon contre le tube horizontal`);
      assert.ok(Math.hypot(p.y - A.y, p.z - A.z) > R + 0.02, `${id} : bidon contre la roue avant`);
    }
  }
  assert.ok(C.layout('tt').arc, 'contre-la-montre : le tube oblique épouse la roue avant');
});

test('cyclistes 3D : trois niveaux de détail, la même pose, une cycliste', { skip: !hasBike3d && 'Bike3D absent' }, () => {
  const B3D = bike3d(), C = B3D.Cyclist;
  assert.deepEqual([...C.DETAILS], ['simple', 'detailed', 'realistic']);
  assert.equal(C.detailLevel('realistic'), 2);
  assert.equal(C.detailLevel('inconnu'), 0, 'valeur inconnue : le modèle simple');
  const st = { speed: 9, pedaling: true, standing: false, tuck: false, steer: 0 };
  const build = (detail, sex, gear) => {
    const c = new C({ gear: Object.assign({ frame: 'alu', wheels: 'c45', sex }, gear), detail });
    c.update(0.016, st);
    let verts = 0;
    c.root.traverse((o) => { if (o.isMesh && !o.userData.isOutline) verts += o.geometry.attributes.position.count; });
    return { c, verts };
  };
  const simple = build('simple', 'm'), detailed = build('detailed', 'm'), real = build('realistic', 'm');
  assert.ok(simple.verts < detailed.verts && detailed.verts < real.verts, `de plus en plus fin : ${simple.verts}, ${detailed.verts}, ${real.verts} sommets`);
  // même pose quel que soit le niveau : mains sur le cintre, pieds sur les pédales
  for (const x of [detailed, real]) {
    for (let i = 0; i < 2; i++) {
      assert.ok(x.c.arms[i].hand.position.distanceTo(simple.c.arms[i].hand.position) < 1e-9, 'mains au même endroit');
      assert.ok(x.c.legs[i].shoe.position.distanceTo(simple.c.legs[i].shoe.position) < 1e-9, 'pieds au même endroit');
    }
  }
  // tête à l'échelle réelle dans les modèles fins : de 18 à 25 cm du sommet du crâne au menton (27 cm dans le modèle simple)
  const skull = real.c.head.children[0].geometry;
  skull.computeBoundingBox();
  const h = (skull.boundingBox.max.y - skull.boundingBox.min.y) * real.c.head.scale.y;
  assert.ok(h > 0.18 && h < 0.25, `hauteur de la tête : ${h.toFixed(3)} m`);
  // une cycliste : queue de cheval, buste plus étroit aux épaules ; le sexe vient de l'équipement (profil de PaceYourRide)
  const f = build('realistic', 'f');
  assert.ok(f.c.fem && f.c.tail, 'queue de cheval');
  assert.ok(!real.c.tail, 'pas de queue de cheval chez un homme');
  assert.ok(f.c.shoulderX < real.c.shoulderX);
  assert.ok(real.c.arms.every((a) => !a.shoulder), 'modèles fins : pas de boule à l\'épaule');
  // les fessiers suivent les cuisses : angles opposés autour de leur moyenne, qui s'inversent au demi-tour de pédalier
  const c = real.c;
  c.crank = 1;
  c.update(0, st);
  const a1 = c.hipU.uHipA.value.clone();
  c.crank = 1 + Math.PI;
  c.update(0, st);
  const a2 = c.hipU.uHipA.value;
  assert.ok(Math.abs(a1.x + a1.y) < 1e-9 && Math.abs(a1.x) > 0.1, `écarts des cuisses : ${a1.x.toFixed(3)}, ${a1.y.toFixed(3)}`);
  assert.ok(Math.abs(a2.x - a1.y) < 1e-6, 'au demi-tour, chaque fessier prend le mouvement de l\'autre');
  assert.ok(!simple.c.hipU, 'modèle simple : pas de fessiers animés');
  assert.ok(new C({ sex: 'f', detail: 'detailed' }).fem, 'sans équipement : le sexe du menu de Bike3D');
  assert.ok(!new C({ sex: 'f', gear: { sex: 'm' } }).fem, 'avec équipement : celui du profil');
  // finitions du réaliste : lunettes, jugulaire et col en plus ; les yeux se voient sans lunettes ou derrière la visière du chrono
  const A = B3D.anatomy;
  assert.ok(A.headParts({ q: 2 }).straps.length > 0 && A.headParts({ q: 1 }).straps.length === 0);
  assert.ok(A.headParts({ q: 1, eyes: true }).marks.length > A.headParts({ q: 1, eyes: false }).marks.length);
});

test('cyclistes 3D : anatomie (géométries valides, poitrine d\'une cycliste, fessiers, épaules, couleurs des membres)', { skip: !hasBike3d && 'Bike3D absent' }, () => {
  const B3D = bike3d(), A = B3D.anatomy;
  const finite = (geo) => [...geo.attributes.position.array, ...geo.attributes.normal.array].every(Number.isFinite);
  for (const q of [1, 2]) {
    for (const fem of [false, true]) {
      const H = A.headParts({ q, fem, eyes: true });
      for (const k of ['skull', 'features', 'marks', 'mouth', 'hair', 'tail', 'straps']) for (const p of H[k]) assert.ok(finite(p.geo), `tête (${k})`);
      assert.ok(finite(A.torsoGeometry({ q, fem })) && A.pelvisParts({ q, fem }).every((p) => finite(p.geo)));
      for (const k of ['thigh', 'shin', 'upper', 'fore', 'neck']) for (const p of A.limbParts(k, { q, fem, side: -1, bands: [[0.6, '#000000'], [1, '#ffffff']] })) assert.ok(finite(p.geo), k);
      for (const p of A.handParts({ q, side: 1, fem }).concat(A.shoeParts({ q, side: 1, kind: 'road', upper: '#fff', sole: '#000', detail: '#333' }))) assert.ok(finite(p.geo));
    }
  }
  // poitrine : le devant du buste avance nettement plus chez une cycliste, à hauteur de poitrine (repère du buste : +z devant)
  const chest = (fem) => {
    const p = A.torsoGeometry({ q: 2, fem }).attributes.position;
    let z = -1;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > 0.15 && p.getY(i) < 0.45) z = Math.max(z, p.getZ(i));
    return z;
  };
  assert.ok(chest(true) > chest(false) + 0.2, `poitrine : ${chest(true).toFixed(2)} contre ${chest(false).toFixed(2)}`);
  assert.ok(A.headParts({ q: 1, fem: true }).tail.length > 0 && A.headParts({ q: 1, fem: false }).tail.length === 0);
  // fessiers : une seule surface avec le bassin (pas deux boules), deux rondeurs séparées par un sillon étroit, qui se fondent dans
  // le dos en haut ; plus pleines chez une cycliste ; reflet du lycra sur le cuissard
  const at = (fem, v, x) => { // point du dos à la hauteur v et à x m du milieu (repère debout : +z devant)
    let lo = 0, hi = Math.PI / 2;
    for (let k = 0; k < 40; k++) { const a = (lo + hi) / 2; if (A.pelvisPoint(a, v, fem).x < x) lo = a; else hi = a; }
    return A.pelvisPoint(lo, v, fem);
  };
  for (const fem of [false, true]) {
    const cheek = at(fem, 0.44, 0.07).z, cleft = at(fem, 0.44, 0).z, near = at(fem, 0.44, 0.03).z;
    assert.ok(cheek < -0.11 && cheek > -0.13, `fessier en arrière sans excès : ${cheek.toFixed(3)} m`);
    // de profil, pas de pointe : le fessier reste presque aussi saillant 4 cm au-dessus et au-dessous de son sommet
    const prof = [];
    for (let v = 0.02; v < 1; v += 0.01) prof.push({ y: A.pelvisPoint(0, v, fem).y, z: at(fem, v, 0.07).z });
    const top = prof.reduce((m, p) => (p.z < m.z ? p : m));
    const near4 = (dy) => prof.reduce((m, p) => (Math.abs(p.y - top.y - dy) < Math.abs(m.y - top.y - dy) ? p : m));
    for (const dy of [-0.04, 0.04]) assert.ok(near4(dy).z - top.z < 0.012, `profil plein à ${dy * 100} cm du sommet : ${(near4(dy).z - top.z).toFixed(3)} m`);
    assert.ok(cleft - cheek > 0.025, 'sillon entre les fessiers');
    assert.ok(near - cheek < 0.012, 'sillon étroit : le fessier reste plein jusqu\'à 3 cm du milieu');
    assert.ok(Math.abs(at(fem, 0.97, 0.02).z - at(fem, 0.97, 0).z) < 0.003, 'en haut, ni sillon ni bord : les fessiers se fondent dans le dos');
  }
  assert.ok(at(true, 0.44, 0.07).z < at(false, 0.44, 0.07).z - 0.006, 'plus pleins chez une cycliste');
  const seat = A.pelvisParts({ q: 2, fem: true });
  assert.equal(seat[0].sheen, 1, 'reflet du lycra sur le cuissard');
  assert.ok(B3D.toon.merge(seat).attributes.sheen, 'attribut de reflet dans la géométrie fusionnée');
  // pédalage : le bas de chaque fessier suit sa cuisse (poids par sommet, signé par côté), le haut et le milieu ne bougent pas
  const hw = seat[0].geo.attributes.hipW, pp = seat[0].geo.attributes.position;
  let low = 0, high = 0, mid = 0;
  for (let i = 0; i < hw.count; i++) {
    const w = hw.getX(i), x = pp.getX(i), y = pp.getY(i);
    if (w !== 0) assert.equal(Math.sign(w), Math.sign(x), 'chaque côté suit sa cuisse');
    if (y < -0.1 && Math.abs(x) > 0.06) low = Math.max(low, Math.abs(w));
    if (y > 0.1) high = Math.max(high, Math.abs(w));
    if (Math.abs(x) < 0.002) mid = Math.max(mid, Math.abs(w));
  }
  assert.ok(Math.abs(low - A.HIP_FOLLOW) < 0.05 && high < 0.01 && mid < 0.05, `poids : bas ${low.toFixed(2)}, haut ${high.toFixed(2)}, milieu ${mid.toFixed(2)}`);
  // le bassin bascule avec le buste : plus en bas du cintre (buste couché) qu'en danseuse (buste relevé)
  const V3 = B3D.toon.shared.uRider.value.constructor;
  assert.ok(A.pelvisPose(new V3(0, 0.45, 0.9)).tilt > A.pelvisPose(new V3(0, 0.9, 0.45)).tilt);
  // épaules : le buste va jusqu'à l'attache des bras (pas de boule du deltoïde à côté)
  const shoulder = (fem) => A.torsoPoint({ x: 1, y: 0.69, z: 0 }, fem).x * 0.2; // côté du buste à hauteur des épaules (unité x : 0,2 m)
  assert.ok(shoulder(false) >= 0.19 && shoulder(true) >= 0.175, `largeur aux épaules : ${shoulder(false).toFixed(3)} m, ${shoulder(true).toFixed(3)} m`);
  // un membre par couleur : cuissard jusqu'à 78 % de la cuisse, puis la peau, l'anneau de la limite en commun
  const [shorts, skin] = A.limbParts('thigh', { q: 1, side: 1, bands: [[0.78, '#26232f'], [1, '#f1c29b']] });
  shorts.geo.computeBoundingBox(); skin.geo.computeBoundingBox();
  assert.equal(shorts.color, '#26232f');
  assert.ok(Math.abs(shorts.geo.boundingBox.max.y - 0.28) < 1e-6 && Math.abs(skin.geo.boundingBox.min.y - 0.28) < 1e-6);
});

test('peloton 3D : modèle fin près de la caméra, simple au loin ; des coureuses', { skip: !hasBike3d && 'Bike3D absent' }, () => {
  const B3D = bike3d(['js/peloton.js']);
  const P = new B3D.Peloton({ add() {}, remove() {} }, { sStart: 0, sEnd: 1000 }, { seed: 1, race: null, roadHalf: 3 }, { count: 4, detail: 2, sex: 'f' });
  assert.ok(P.riders.every((r) => r.fem), 'des coureuses quand le joueur est une cycliste');
  assert.deepEqual([...P.bodies.keys()].sort(), ['0f', '2f']);
  P.setLook(1, 'Léa', '#3d7be0', 'm');
  assert.ok(!P.riders[1].fem, 'le sexe imposé de l\'extérieur (vue pilotée par PaceYourRide)');
  // coureurs à 5 m et à 200 m de la caméra
  P.route.sample = (s, q) => Object.assign(q, { x: 0, y: 0, z: s, tx: 0, tz: 1, rx: 1, rz: 0, grade: 0, curv: 0 });
  P.riders.forEach((r, i) => Object.assign(r, { s: i < 2 ? 5 : 200, lat: i, latV: 0, lean: 0, rock: 0 }));
  const cam = { getWorldPosition: (v) => v.set(0, 1.5, 0), getWorldDirection: (v) => v.set(0, 0, 1) };
  P.render(0.016, cam);
  assert.deepEqual([...P.riders.map((r) => r.fine)], [true, true, false, false]);
  const count = (k) => P.bodies.get(k) ? P.bodies.get(k).k : 0;
  assert.equal(count('2f') + count('2m'), 2);
  assert.equal(count('0f') + count('0m'), 2);
  assert.equal(P.legsL.k, 2);
  assert.equal(P.legs0.k, 2);
  assert.ok(P.bodies.has('2m'), 'corps créé au premier besoin');
});

test('vue 3D : l\'équipement du joueur part avec le parcours sans changer son empreinte', () => {
  const { course } = setupFor(makeProfile([{ len: 2000, grade: 0.02 }]));
  const gear = PYR.gearArt.gear3d({ rider: { position: 'tt' }, bike: { frame: 'tt', wheels: 'disc', tire: 'race' }, picks: {} });
  const a = V3.courseMessage(course, [], [], { name: 'Hugo', gear });
  const b = V3.courseMessage(course, [], [], { name: 'Hugo' });
  assert.deepEqual(a.me.gear, gear);
  assert.equal(b.me.gear, undefined);
  assert.equal(a.key, b.key, 'changer de vélo ne reconstruit pas le paysage');
});
