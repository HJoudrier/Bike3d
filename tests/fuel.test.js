/* author : Hugo Joudrier-Faure */
/* Tests de la digestion : délai selon l'aliment, plafond d'absorption selon le mélange de sucres et l'entraînement. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR } = require('./helpers.js');

const Fu = PYR.fuel;

/** Fait passer t secondes à l'arrêt (consommation minimale) et renvoie l'état. */
function rest(f, t) { for (let i = 0; i < t; i++) Fu.step(f, 0, 250, 20); return f; }

test('plafonds : glucose seul 60 g/h, mélange 90 g/h, intestin entraîné jusqu\'à 120 g/h', () => {
  assert.deepEqual(Fu.caps(0), { glucose: 60, fructose: 30, mix: 90 });
  assert.deepEqual(Fu.caps(1), { glucose: 70, fructose: 50, mix: 120 });
  assert.equal(Fu.caps(0.5).mix, 105);
  assert.equal(Fu.caps(7).mix, 120, 'borné à 1');
  assert.equal(Fu.caps(-1).mix, 90);
  assert.equal(Fu.caps(undefined).mix, 90);
  assert.deepEqual(Fu.GUT_LEVELS.map((l) => l.value), [0, 0.5, 1]);
});

test('absorption : le débit s\'arrête au plafond de chaque voie (glucose seul, mélange, intestin entraîné)', () => {
  const rate = (train, glu, fru) => {
    const f = Fu.create(72, { gutTraining: train });
    f.int.glu = glu; f.int.fru = fru; f.gut = glu + fru; // l'intestin est plein : on mesure le débit maximal
    f.G = 0.2 * f.G0;
    Fu.step(f, 0, 250, 20);
    return f.absorbing * 3600;
  };
  assert.ok(Math.abs(rate(0, 300, 0) - 60) < 1e-6, 'glucose seul');
  assert.ok(Math.abs(rate(0, 200, 100) - 90) < 1e-6, 'mélange 2 : 1');
  assert.ok(Math.abs(rate(1, 300, 0) - 70) < 1e-6, 'glucose seul, intestin entraîné');
  assert.ok(Math.abs(rate(1, 200, 100) - 120) < 1e-6, 'mélange, intestin entraîné');
  assert.ok(Math.abs(rate(0.5, 200, 100) - 105) < 1e-6);
  // la voie du fructose ne sert à rien s'il n'y a que du glucose, et inversement
  assert.ok(Math.abs(rate(0, 0, 100) - 30) < 1e-6, 'fructose seul : 30 g/h');
  // peu en attente : tout passe, sans dépasser ce qui attend
  assert.ok(rate(0, 0.005, 0) < 60);
});

test('absorption : un intestin entraîné absorbe un mélange plus vite sur une heure', () => {
  const take = (train) => {
    const f = Fu.create(72, { gels: 6, bars: 0, gutTraining: train });
    f.G = 0.3 * f.G0;
    let absorbed = 0;
    // un gel toutes les 12 min : 125 g/h, au-delà de tous les plafonds
    for (let t = 0; t < 3600; t++) {
      if (t % 720 === 0) Fu.eat(f, t, 'gel');
      Fu.step(f, 0, 250, 20);
      absorbed += f.absorbing;
    }
    return { absorbed, left: Fu.status(f).gut };
  };
  const untrained = take(0), trained = take(1);
  assert.ok(trained.absorbed > untrained.absorbed, `${trained.absorbed.toFixed(1)} g vs ${untrained.absorbed.toFixed(1)} g`);
  assert.ok(untrained.absorbed <= 90 + 1e-6 && trained.absorbed <= 120 + 1e-6, 'jamais au-delà du plafond horaire');
  assert.ok(trained.absorbed > untrained.absorbed + 3);
});

test('délai d\'arrivée : la boisson passe avant le gel, le gel avant la barre', () => {
  // temps (s) pour avoir absorbé une fraction de ≈ 25 g de glucides, à l'arrêt
  const timeTo = (feedFn, frac) => {
    const f = Fu.create(72, { gels: 3, bars: 3 });
    f.G = 0.3 * f.G0;
    feedFn(f);
    const eaten = f.gut;
    let absorbed = 0;
    for (let t = 1; t <= 7200; t++) {
      Fu.step(f, 0, 250, 20);
      absorbed += f.absorbing;
      if (absorbed >= eaten * frac) return t;
    }
    return Infinity;
  };
  const gulp = (f) => { f.lastDrink = -1e9; let q = 0; while (q < 25 / 60 - 1e-9) { f.lastDrink = -1e9; q += Fu.drink(f, 0); } }; // ≈ 25 g de glucides
  for (const frac of [0.2, 0.5, 0.8]) {
    const drinkT = timeTo(gulp, frac), gelT = timeTo((f) => Fu.eat(f, 0, 'gel'), frac), barT = timeTo((f) => Fu.eat(f, 0, 'bar'), frac);
    assert.ok(drinkT < gelT && gelT < barT, `${frac * 100} % : boisson ${drinkT} s, gel ${gelT} s, barre ${barT} s`);
    if (frac === 0.2) assert.ok(drinkT < 300 && barT > 450, `20 % : ${drinkT} / ${gelT} / ${barT}`);
    if (frac === 0.8) assert.ok(gelT > drinkT + 150 && barT > gelT + 300, `80 % : ${drinkT} / ${gelT} / ${barT}`);
  }
  assert.ok(Math.abs(Fu.halfMinutes('gel') - 9) < 0.01 && Math.abs(Fu.halfMinutes('bar') - 17) < 0.01 && Math.abs(Fu.halfMinutes('drink') - 5) < 0.01);
});

test('délai d\'arrivée : la barre met du temps à démarrer (pas d\'absorption pendant la digestion)', () => {
  const f = Fu.create(72, { gels: 0, bars: 2 });
  Fu.eat(f, 0, 'bar');
  let first = -1;
  for (let t = 1; t <= 600 && first < 0; t++) { Fu.step(f, 0, 250, 20); if (f.absorbing > 0) first = t; }
  assert.ok(first >= 300, `premiers glucides absorbés après ${first} s`);
  const g = Fu.create(72, { gels: 1, bars: 0 });
  Fu.eat(g, 0, 'gel');
  let firstGel = -1;
  for (let t = 1; t <= 600 && firstGel < 0; t++) { Fu.step(g, 0, 250, 20); if (g.absorbing > 0) firstGel = t; }
  assert.ok(firstGel >= 60 && firstGel < first, `gel : ${firstGel} s`);
});

test('digestion : rien ne se perd, tout finit absorbé ; la barre (glucose surtout) est freinée par la voie du glucose', () => {
  const f = Fu.create(72, { gels: 3, bars: 3 });
  f.G = 0.2 * f.G0;
  Fu.eat(f, 0, 'gel'); Fu.eat(f, 100, 'bar'); Fu.eat(f, 200, 'gel');
  f.lastDrink = -1e9; Fu.drink(f, 300);
  const eaten = f.eatenG + 60 * 0.15;
  let absorbed = 0;
  for (let t = 0; t < 4 * 3600; t++) { Fu.step(f, 0, 250, 20); absorbed += f.absorbing; }
  assert.ok(Math.abs(absorbed - eaten) < 0.05, `absorbé ${absorbed.toFixed(2)} g sur ${eaten.toFixed(2)} g avalés`);
  const s = Fu.status(f);
  assert.ok(s.gut < 0.05 && s.stomach < 0.05 && s.intestine < 0.05, `reste ${s.gut}`);
  // l'énergie reçue est bien dans la réserve (au repos, la consommation de base est petite)
  assert.ok(f.G > 0.2 * f.G0 + 70 - f.burned - 1e-6);
});

test('statut : estomac, intestin, débit et plafond actuels', () => {
  const f = Fu.create(72, { gutTraining: 1 });
  let s = Fu.status(f);
  assert.equal(s.stomach, 0); assert.equal(s.absorbing, 0); assert.equal(s.ceiling, 120, 'sans rien en attente : plafond du mélange');
  Fu.eat(f, 0, 'bar');
  s = Fu.status(f);
  assert.equal(s.stomach, 40); assert.equal(s.intestine, 0);
  rest(f, 400);
  s = Fu.status(f);
  assert.ok(s.intestine > 0 || s.absorbing > 0);
  assert.ok(s.ceiling > 60 && s.ceiling <= 120);
  // plus de gel ni de barre à compter dans les poches de la musette : inchangé
  assert.equal(s.gels, 3);
});

test('bonk : le temps avant la fringale tient compte de ce qui reste à absorber', () => {
  const f = Fu.create(72, { gels: 3, bars: 3 });
  f.G = 0.4 * f.G0;
  const t0 = Fu.timeToBonk(f, 250, 250);
  Fu.eat(f, 0, 'gel');
  assert.ok(Fu.timeToBonk(f, 250, 250) > t0, 'avec un gel en route, la fringale est repoussée');
  const g = Fu.create(72);
  g.G = 0.15 * g.G0;
  assert.equal(Fu.timeToBonk(g, 250, 250), 0);
});

test('matériel : bidons, camelback et contenus, gels et barres de plusieurs sortes', () => {
  // valeurs par défaut : deux bidons d'énergétique, 3 gels, 2 barres
  const d = Fu.normKit();
  assert.deepEqual(d.slots, ['iso', 'iso', '', '']);
  assert.equal(d.items.gel, 3);
  assert.equal(d.items.bar, 2);
  // contenus inconnus écartés ; les poches se remplissent par catégorie (6 gels, 4 barres en tout, tous types confondus)
  const k = Fu.normKit({ slots: ['water', 'nimporte', 'hypo', 'hyper'], items: { gel: 4, gelglu: 5, gelplus: 3, bar: 3, barmini: 9 } });
  assert.deepEqual(k.slots, ['water', '', 'hypo', 'hyper']);
  assert.equal(k.items.gel + k.items.gelglu + k.items.gelplus, 6);
  assert.equal(k.items.gel, 4);
  assert.equal(k.items.gelglu, 2);
  assert.equal(k.items.gelplus, 0);
  assert.equal(k.items.bar + k.items.barmini, 4);
  // trois bidons et un camelback
  const f = Fu.create(72, { slots: ['iso', 'hypo', 'hyper', 'water'], items: { gel: 2, gelplus: 2, bar: 1, barmini: 2 } });
  assert.deepEqual(f.bottles, [0.5, 0.5, 0.5, 1.5]);
  assert.deepEqual(f.cont.map((c) => c.type + ':' + c.mix), ['bottle:iso', 'bottle:hypo', 'bottle:hyper', 'camelback:water']);
  const s = Fu.status(f);
  assert.equal(s.gels, 4);
  assert.equal(s.bars, 3);
  assert.ok(Math.abs(s.fluid - 3) < 1e-9);
  assert.equal(s.containers.length, 4);
  // sans emplacement rempli : aucun contenant
  assert.equal(Fu.create(72, { slots: ['', '', '', ''] }).bottles.length, 0);
  // ancien réglage (nombre de bidons) : bidons d'énergétique
  assert.deepEqual(Fu.create(72, { bottles: 3, gels: 1, bars: 0 }).cont.map((c) => c.mix), ['iso', 'iso', 'iso']);
});

test('boire : on choisit le contenant ; eau sans glucides, hypo / énergétique / hyper selon leur concentration et leur vidange', () => {
  const kit = { slots: ['water', 'hypo', 'iso', 'hyper'], items: {} };
  const sip = (idx) => { const f = Fu.create(72, kit); f.deficit = 1; const q = Fu.drink(f, 0, idx); return { f, q }; };
  const w = sip(0), h = sip(1), i = sip(2), y = sip(3);
  assert.ok(w.q > 0 && w.f.gut === 0 && w.f.drunkG === 0, 'eau : pas de glucides');
  assert.ok(Math.abs(w.f.bottles[0] - (0.5 - w.q)) < 1e-9, 'le volume baisse dans le bon contenant');
  assert.equal(w.f.bottles[1], 0.5, 'les autres contenants sont intacts');
  // glucides d'une gorgée : 25, 60 et 100 g/L
  assert.ok(Math.abs(h.f.drunkG - h.q * 25) < 1e-9 && Math.abs(i.f.drunkG - i.q * 60) < 1e-9 && Math.abs(y.f.drunkG - y.q * 100) < 1e-9);
  // l'hypertonique hydrate moins : 70 % de l'eau bue
  assert.ok(Math.abs((1 - y.f.deficit) - 0.7 * y.q) < 1e-9, 'hypertonique : 70 % hydrate');
  assert.ok(Math.abs((1 - i.f.deficit) - i.q) < 1e-9, 'isotonique : tout hydrate');
  // vidange : après 10 minutes, il reste une part plus grande d'hypertonique que d'énergétique ou d'hypotonique
  for (const x of [h, i, y]) rest(x.f, 600);
  const left = (x) => Fu.pending(x.f).stomach / x.f.drunkG;
  assert.ok(left(y) > left(i) && left(i) > left(h), `reste dans l'estomac : hypo ${left(h).toFixed(3)}, énergétique ${left(i).toFixed(3)}, hyper ${left(y).toFixed(3)}`);
  // contenant vide ou inexistant : rien
  const e = Fu.create(72, kit); e.bottles[0] = 0;
  assert.equal(Fu.drink(e, 0, 0), 0);
  assert.equal(Fu.drink(e, 100, 9), 0);
  // sans choix : le premier contenant qui n'est pas vide (comportement d'origine)
  assert.ok(Fu.drink(e, 200) > 0 && e.bottles[1] < 0.5);
});

test('manger : on choisit l\'aliment ; gel glucose seul, gel haute dose, mini-barre', () => {
  const f = Fu.create(72, { slots: ['iso'], items: { gel: 1, gelglu: 1, gelplus: 1, bar: 1, barmini: 1 } });
  assert.equal(Fu.eat(f, 0, 'gelglu', true), 'gel glucose');
  assert.equal(f.eatenG, 25);
  assert.equal(f.stom.items[0].fru, 0, 'glucose seul : pas de fructose');
  assert.equal(Fu.eat(f, 5, 'gelplus', true), null, 'trop tôt : délai entre deux prises');
  assert.equal(Fu.eat(f, 100, 'gelplus', true), 'gel haute dose');
  assert.equal(f.eatenG, 65);
  assert.ok(f.stom.items[1].lag > f.stom.items[0].lag, 'haute dose : digestion plus lente');
  assert.equal(Fu.eat(f, 200, 'barmini', true), 'mini-barre');
  assert.equal(f.eatenG, 85);
  // choix précis sans stock : rien ; sinon un autre aliment de la catégorie le remplace
  assert.equal(Fu.eat(f, 300, 'gelglu', true), null);
  assert.equal(Fu.eat(f, 300, 'gelglu'), 'gel', 'sans choix strict : un autre gel');
  assert.equal(Fu.status(f).gels, 0);
  assert.equal(Fu.eat(f, 400), 'barre', 'sans choix : ce qui reste (une barre)');
  assert.equal(Fu.eat(f, 500), null, 'plus rien');
});

test('musette : chaque contenant est rempli avec son contenu, le camelback aussi', () => {
  const f = Fu.create(72, { slots: ['water', 'hyper', '', 'water'], items: { gel: 5, gelplus: 1 } });
  f.bottles[0] = 0.1; f.bottles[1] = 0; f.bottles[2] = 0.7;
  const got = Fu.resupply(f);
  assert.deepEqual(f.bottles, [0.5, 0.5, 1.5]);
  assert.deepEqual(f.cont.map((c) => c.mix), ['water', 'hyper', 'water'], 'les contenus ne changent pas');
  assert.ok(Math.abs(got.liters - (0.4 + 0.5 + 0.8)) < 1e-9);
  assert.equal(got.gels, 0, 'poches de gels déjà pleines (6 en tout, tous types confondus)');
  assert.equal(got.bars, Fu.MUSETTE.bar);
});
