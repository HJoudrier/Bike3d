/* author : Hugo Joudrier-Faure */
/* Tests des ravitaillements des étapes longues : zones, musette, ralentissement, coureurs virtuels. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor, DEFAULT_RIDER, DEFAULT_BIKE } = require('./helpers.js');

const F = PYR.feed, Fu = PYR.fuel, Race = PYR.race, Tac = PYR.tactics;

const flat = (km) => setupFor(makeProfile([{ len: km * 1000, grade: 0 }]));

test('zones : une tous les ≈ 50 km à partir de 75 km, seulement avec l\'alimentation', () => {
  const zonesOf = (km, rules) => F.build(flat(km).course, rules);
  assert.equal(zonesOf(40, { fuel: true }).length, 0, 'parcours court');
  assert.equal(zonesOf(74, { fuel: true }).length, 0);
  assert.equal(zonesOf(100, { fuel: false }).length, 0, 'sans l\'option alimentation');
  assert.equal(zonesOf(100, undefined).length, 0);
  assert.equal(zonesOf(75, { fuel: true }).length, 1);
  assert.equal(zonesOf(150, { fuel: true }).length, 2);
  assert.equal(zonesOf(200, { fuel: true }).length, 3);
  assert.equal(zonesOf(1000, { fuel: true }).length, F.MAX_ZONES, 'au plus 6');
  const z = zonesOf(150, { fuel: true });
  assert.ok(Math.abs(z[0].s - 50000) < 5000 && Math.abs(z[1].s - 100000) < 5000, `km ${z.map((x) => x.s / 1000)}`);
  assert.deepEqual(z.map((x) => x.n), [1, 2]);
  assert.ok(z.every((x) => x.end - x.s === F.ZONE_LEN));
});

test('zones : jamais dans une côte, à son pied ni dans les 8 derniers km ; mêmes zones pour tous', () => {
  const prof = makeProfile([{ len: 20000, grade: 0 }, { len: 5000, grade: 0.06 }, { len: 5000, grade: -0.05 }, { len: 20000, grade: 0 },
    { len: 6000, grade: 0.07 }, { len: 6000, grade: -0.06 }, { len: 40000, grade: 0.002 }]);
  const { course } = setupFor(prof);
  const zones = F.build(course, { fuel: true });
  assert.ok(zones.length >= 1);
  const climbs = PYR.classif.findClimbs(course.ele, course.step);
  assert.ok(climbs.length >= 2);
  for (const z of zones) {
    for (const c of climbs) assert.ok(z.end <= c.start - 300 || z.s >= c.end + 500, `zone ${z.s}–${z.end} dans la côte ${c.start}–${c.end}`);
    assert.ok(z.end <= course.length - 8000);
  }
  assert.deepEqual(F.build(setupFor(prof).course, { fuel: true }), zones, 'déterministe');
  assert.equal(F.zoneAt(zones, zones[0].s + 10), 0);
  assert.equal(F.zoneAt(zones, zones[0].s - 1), -1);
  assert.equal(F.nextZone(zones, 0), 0);
  assert.equal(F.nextZone(zones, course.length), -1);
});

test('musette : bidons pleins, gels et barres dans la limite des poches', () => {
  const f = Fu.create(72, { gels: 5, bars: 0 });
  f.bottles[0] = 0.1; f.bottles[1] = 0;
  const got = Fu.resupply(f);
  assert.equal(f.items.gel, Fu.POCKETS.gel, 'poches pleines : 5 + 3 → 6');
  assert.equal(got.gels, 1);
  assert.equal(f.items.bar, Fu.MUSETTE.bar);
  assert.deepEqual(f.bottles, [0.5, 0.5]);
  assert.ok(Math.abs(got.liters - 0.9) < 1e-9);
  assert.equal(Fu.runningLow(Fu.create(72, { gels: 1, bars: 1 })), true);
  assert.equal(Fu.runningLow(Fu.create(72)), false, 'kit de départ : 3 gels, 2 barres, 1 L');
  const empty = Fu.create(72, { gels: 5, bars: 5 });
  empty.bottles[0] = empty.bottles[1] = 0.1;
  assert.equal(Fu.runningLow(empty), true, 'presque plus à boire');
});

test('ravitaillement : une musette par zone, à la saisir dans la zone, en levant le pied', () => {
  const { course, setup, athlete } = flat(100);
  const feed = [{ s: 5000, end: 5500, n: 1 }, { s: 9000, end: 9500, n: 2 }];
  const race = Race.create({ course, rules: { fuel: true }, seed: 3, gustSeed: 1, feed });
  const me = Race.addRider(race, { id: 'me', name: 'Moi', human: true, setup, athlete, v0: 11 });
  me.fuel.items.gel = 0; me.fuel.items.bar = 0; me.fuel.bottles[0] = 0.2;
  const events = [];
  race.onEvent = (e) => events.push(e);
  Tac.setMode(me, 'threshold', 0);
  assert.equal(Race.takeFeed(race, me), null, 'hors zone');
  me.st.s = 4900;
  let took = null, tookI = -1, vmax = 0, brakes = 0;
  for (let i = 0; i < 80; i++) {
    Race.step(race);
    if (!took && me.st.s >= 5000 && me.st.s <= 5500) { took = Race.takeFeed(race, me); tookI = i; }
    if (took && i > tookI + 1 && me.st.t <= me.feedUntil) { vmax = Math.max(vmax, me.st.v); if (me.st.braking) brakes++; }
  }
  assert.ok(took && took.gels === 3 && took.bars === 2 && took.liters > 0.29, JSON.stringify(took));
  assert.equal(me.fuel.items.gel + me.fuel.items.bar >= 5, true);
  assert.deepEqual(me.fuel.bottles, [0.5, 0.5]);
  assert.equal(Race.takeFeed(race, me), null, 'une fois par zone');
  assert.ok(vmax <= F.GRAB_SPEED + 0.5, `vitesse pendant la saisie : ${vmax.toFixed(1)} m/s`);
  assert.ok(events.some((e) => e.type === 'feed' && e.id === 'me' && e.zone === 0 && e.gels === 3));
  // le ralentissement est temporaire : on repart à l'allure du seuil
  for (let i = 0; i < 60; i++) Race.step(race);
  assert.ok(me.st.v > 9.5, `de nouveau lancé : ${me.st.v.toFixed(1)} m/s`);
});

test('ravitaillement : zone manquée signalée au joueur, jamais aux coureurs virtuels ; sans alimentation, rien', () => {
  const { course, setup, athlete } = flat(100);
  const feed = [{ s: 3000, end: 3500, n: 1 }];
  const race = Race.create({ course, rules: { fuel: true }, seed: 3, gustSeed: 1, feed });
  const me = Race.addRider(race, { id: 'me', name: 'Moi', human: true, setup, athlete, v0: 11 });
  const events = [];
  race.onEvent = (e) => events.push(e.type + ':' + e.id);
  Tac.setMode(me, 'tempo', 0);
  me.st.s = 2900;
  for (let i = 0; i < 80; i++) Race.step(race);
  assert.ok(events.includes('feedmiss:me'), events.join(' '));
  assert.equal(me.feedTaken.size, 0);
  // sans l'option alimentation : pas de vivres à compléter
  const bare = Race.create({ course, rules: { fuel: false }, seed: 3, gustSeed: 1, feed });
  const r2 = Race.addRider(bare, { id: 'me', name: 'Moi', human: true, setup, athlete, v0: 11 });
  r2.st.s = 3100;
  assert.equal(Race.takeFeed(bare, r2), null);
});

test('ravitaillement : les coureurs virtuels prennent leur musette s\'il leur reste peu de vivres', () => {
  const { course } = flat(100);
  const feed = [{ s: 2000, end: 2500, n: 1 }];
  const race = Race.create({ course, rules: { fuel: true }, seed: 5, gustSeed: 1, feed });
  const bots = Race.addBots(race, { n: 6, level: 'equal', rider: DEFAULT_RIDER, bike: DEFAULT_BIKE, v0: 8 });
  // trois coureurs presque à sec, trois bien pourvus
  bots.slice(0, 3).forEach((b) => { b.fuel.items.gel = 0; b.fuel.items.bar = 1; });
  const fed = [];
  race.onEvent = (e) => { if (e.type === 'feed') fed.push(e.id); };
  for (let i = 0; i < 400; i++) Race.step(race);
  assert.deepEqual(fed.sort(), bots.slice(0, 3).map((b) => b.id).sort(), 'seuls ceux qui en ont besoin');
  for (const b of bots.slice(0, 3)) assert.ok(b.fuel.items.gel >= 3 && b.fuel.items.bar >= 3);
  for (const b of bots.slice(3)) assert.equal(b.feedTaken.size, 0);
});

test('étape longue : avec un ravitaillement, le joueur ne tombe pas en fringale', () => {
  const { course, setup, athlete } = flat(160);
  const feed = F.build(course, { fuel: true });
  assert.equal(feed.length, 2);
  const run = (useFeed) => {
    const race = Race.create({ course, rules: { fuel: true }, seed: 9, gustSeed: 1, feed });
    const me = Race.addRider(race, { id: 'me', name: 'Moi', human: true, setup, athlete, v0: 8 });
    Tac.setMode(me, 'tempo', 0);
    let minE = 1;
    while (!me.finished && race.t < 4 * 3600 * 2) {
      Race.step(race);
      // mange et boit régulièrement, et prend les musettes quand on en a
      if (race.t % 600 === 0) Fu.eat(me.fuel, race.t);
      if (race.t % 60 === 0) Fu.drink(me.fuel, race.t);
      if (useFeed) Race.takeFeed(race, me, true);
      minE = Math.min(minE, Fu.status(me.fuel).energy);
    }
    return { me, minE };
  };
  const without = run(false), withFeed = run(true);
  assert.ok(without.me.fuel.items.gel + without.me.fuel.items.bar === 0 || without.minE < 0.8, 'sans ravito, les poches se vident');
  assert.ok(withFeed.me.feedTaken.size >= 1);
  assert.ok(withFeed.minE >= without.minE, `énergie mini ${withFeed.minE.toFixed(2)} vs ${without.minE.toFixed(2)}`);
});

test('zones choisies dans l\'onglet Parcours : vérifiées, triées, numérotées', () => {
  const p = flat(100);
  const zones = F.fromList([
    { id: 'b', startKm: 60, endKm: 60.5 },
    { id: 'a', startKm: 20, endKm: 20.3 },
    { id: 'c', startKm: 30, endKm: 30.01 },     // trop courte : ignorée
    { id: 'd', startKm: 50, endKm: 40 },        // fin avant le début : ignorée
    { id: 'e', startKm: 'x', endKm: 3 },
    null,
  ], p.course);
  assert.deepEqual(zones.map((z) => [z.s, z.end, z.n]), [[20000, 20300, 1], [60000, 60500, 2]]);
  assert.deepEqual(F.fromList(undefined, p.course), []);
  // zones reçues d'un autre joueur : même vérification, bornées au parcours
  const rec = F.normalize([{ s: 99500, end: 120000 }, { s: -5, end: 400 }, { s: 'a', end: 9 }], p.course.length);
  assert.deepEqual(rec.map((z) => [z.s, z.end]), [[0, 400], [99500, 100000]]);
  // les zones calculées se reprennent dans la liste de l'onglet Parcours
  const auto = F.build(p.course, { fuel: true });
  assert.deepEqual(F.fromList(F.toItems(auto), p.course).map((z) => [z.s, z.end]), auto.map((z) => [z.s, z.end]));
});
