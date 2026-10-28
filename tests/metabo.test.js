/* author : Hugo Joudrier-Faure */
/* Tests du modèle physiologique et métabolique couplé (metabo.js) : cibles de validation du rapport « Modèle physiologique du
 * cycliste », couplage avec l'alimentation (fuel.js), la course (race.js) et le compteur (ride.js). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor, DEFAULT_BIKE } = require('./helpers.js');

const Mx = PYR.metabo, Fu = PYR.fuel;
// athlète du rapport : CP2 = 300 W, W′ = 20 kJ, Pmax = 1 100 W, 70 kg
const RIDER = { weight: 70, height: 178, age: 35, sex: 'm', ftp: 285, records: {}, gut: 0.5 };
const ATH = { cp: 300, w0: 20000, pmax: 1100, mmp: (d) => 300 + 20000 / (d + 20000 / 800) };
const card = (physio) => Mx.card(Object.assign({}, RIDER, { physio }), ATH);
const near = (x, a, b, m) => assert.ok(x >= a && x <= b, `${m} : ${x} hors de [${a}, ${b}]`);

test('carte athlète : valeurs estimées, valeurs saisies bornées', () => {
  const c = card();
  assert.equal(c.CP1, 225, 'CP1 = 75 % de CP2 par défaut');
  near(c.VO2max, 4.2, 5.0, 'VO₂max (L/min) estimée depuis la puissance 5 min');
  near(c.fI, 0.45, 0.65, 'fibres I d’après Pmax / PC');
  assert.equal(c.HRmax, Math.round(208 - 0.7 * 35));
  assert.equal(c.src.cp1, 'estimée');
  const u = card({ cp1: 240, fI: 99, sweatNa: '' });
  assert.equal(u.CP1, 240);
  assert.equal(u.src.cp1, 'saisie');
  assert.equal(u.fI, Mx.FIELD.fI.max / 100, 'bornée');
  assert.equal(u.src.sweatNa, 'estimée');
  const s = Mx.create(c);
  near(s.f.cpK, 0.999, 1.0001, 'athlète frais : CP2 effective = CP2');
  near(s.f.wK, 0.999, 1.0001, 'athlète frais : W′ effectif = W′');
});

test('rendement brut ≈ 21 % à 150 W et ≈ 22 % à 230 W ; lipides en cloche, glucides croissants', () => {
  const c = card();
  const [p150, p230, p300] = Mx.substrateCurve(c, [150, 230, 300]);
  near(p150.GE, 0.2, 0.22, 'GE à 150 W');
  near(p230.GE, 0.21, 0.23, 'GE à 230 W');
  assert.ok(p300.fat < p230.fat && p230.cho < p300.cho, 'au-delà de FATmax les lipides baissent, les glucides montent');
  near(p300.fat / 60, 0.15, 0.3, 'à CP2, environ 35 % de MFO');
  assert.ok(p300.pI + p300.pIIa + p300.pIIx > 299, 'la puissance est entièrement partagée entre les fibres');
});

test('validation (Clark 2019) : 2 h à 77 % de CP2 sans glucides — W′ et CP2 baissent, W′ davantage', () => {
  const c = card();
  const r = Mx.simulate(c, { dur: 7200, P: 230, v: 11, env: { Ta: 20, RH: 50, h: 200 }, fluidMLh: 500 });
  near(r.last.wK, 0.7, 0.9, 'W′ effectif');
  near(r.last.cpK, 0.88, 0.97, 'CP2 effective');
  assert.ok(1 - r.last.wK > 1 - r.last.cpK, 'W′ plus sensible que CP2');
});

test('validation (Coyle 1986) : fringale vers 3 h à 71 % de VO₂max sans glucides, environ une heure plus tard avec', () => {
  const c = card();
  let P71 = 0;
  for (let P = 150; P < 320; P++) if (Mx.substrateCurve(c, [P])[0].VO2 / c.VO2max >= 0.71) { P71 = P; break; }
  const no = Mx.simulate(c, { dur: 6 * 3600, P: P71, v: 11, env: { Ta: 20, RH: 50 }, fluidMLh: 600, rec: 600 });
  const yes = Mx.simulate(c, { dur: 6 * 3600, P: P71, v: 11, env: { Ta: 20, RH: 50 }, fluidMLh: 600, choGh: 60, rec: 600 });
  near(no.bonkT / 3600, 2.2, 3.6, 'sans glucides');
  near((yes.bonkT - no.bonkT) / 3600, 0.6, 2.2, 'gain avec 60 g/h');
});

test('chaleur : au soleil sous 32 °C le noyau chauffe et la capacité baisse ; l’acclimatation aide', () => {
  const run = (Ta, sun, acc) => Mx.simulate(card({ heatAcc: acc }), { dur: 3600, P: 250, v: 15 / 3.6, env: { Ta, RH: 40, sun, h: 200 }, choGh: 60, fluidMLh: 500 }).last;
  const cool = run(20, 0, 0), hot = run(32, 900, 0), acc = run(32, 900, 100);
  near(cool.Tc, 37.8, 38.8, 'tempéré');
  near(hot.Tc, 39.0, 40.6, 'canicule au soleil');
  assert.ok(hot.cpK < cool.cpK - 0.05, 'capacité réduite à la chaleur');
  assert.ok(acc.cpK > hot.cpK && acc.SR > hot.SR, 'acclimaté : plus de sueur, moins de pénalité');
  assert.ok(hot.HR > cool.HR + 5, 'dérive cardiaque');
});

test('eau et sodium : sans boire on se déshydrate ; trop d’eau pure fait baisser la natrémie', () => {
  const c = card({ sweatNa: 80 });
  const dry = Mx.simulate(c, { dur: 3 * 3600, P: 200, v: 9, env: { Ta: 30, RH: 40, sun: 600 }, fluidMLh: 0 }).last;
  near(dry.dehy, 2, 8, 'déshydratation sans boire');
  const water = Mx.simulate(c, { dur: 4 * 3600, P: 180, v: 9, env: { Ta: 30, RH: 40, sun: 600 }, fluidMLh: 1200, drinkNa: 0 }).last;
  const salty = Mx.simulate(c, { dur: 4 * 3600, P: 180, v: 9, env: { Ta: 30, RH: 40, sun: 600 }, fluidMLh: 1200, drinkNa: 60 }).last;
  assert.ok(water.dehy < dry.dehy, 'boire hydrate');
  assert.ok(water.Na < salty.Na, 'eau pure : natrémie plus basse');
});

test('altitude et caféine agissent sur la signature', () => {
  const c = card();
  const s = Mx.create(c);
  const high = Mx.factors(c, s, { Ta: 15, h: 2600 });
  assert.ok(high.cpK < 0.85 && high.cpK > 0.7, 'col à 2 600 m, non acclimaté');
  const ca = Mx.create(card({ altAcc: 100 }));
  assert.ok(Mx.factors(card({ altAcc: 100 }), ca, { Ta: 15, h: 2600 }).cpK > high.cpK, 'acclimaté : moins de perte');
  const r = Mx.simulate(c, { dur: 3600, P: 150, v: 9, cafMg: 3 * 70, cafAt: 0 });
  near(r.last.caf, 2, 6, 'caféine plasmatique (mg/L) une heure après 3 mg/kg');
  assert.ok(r.last.VA > 1.01, 'commande centrale augmentée');
});

test('fuel.js avec le modèle physiologique : réserves, boisson absorbée progressivement, capacité', () => {
  const c = card();
  const f = Fu.create(70, { slots: ['water', 'iso', '', ''], items: { gel: 2, gelcaf: 1 }, gutTraining: 0.5, physio: c });
  assert.ok(f.phy, 'corps du modèle physiologique');
  near(f.G / f.G0, 0.89, 0.91, 'glycogène de départ : 90 %');
  const env = { Ta: 28, RH: 50, sun: 500, h: 300, v: 10, vAir: 10, shelter: 0, remain: 1e5 };
  for (let t = 0; t < 3600; t++) Fu.step(f, 230, 300, 28, env);
  const before = Fu.lossPct(f);
  assert.ok(before > 0.3, 'on transpire');
  assert.ok(Fu.drink(f, 3600, 0) > 0);
  assert.ok(Math.abs(Fu.lossPct(f) - before) < 1e-9, 'l’eau ne compte pas tout de suite : elle est dans l’estomac');
  for (let t = 3601; t < 4500; t++) Fu.step(f, 100, 300, 28, env);
  const st = Fu.status(f);
  assert.ok(f.phy.s.fstom < 60, 'l’eau bue est absorbée en quelques minutes');
  assert.ok(st.phys && st.phys.Tc > 37 && st.phys.Tc < 39 && st.phys.HR > 80, 'état du corps disponible');
  assert.ok(Fu.factor(f) < 1 && Fu.wFactor(f) < 1, 'capacité entamée après une heure à 230 W');
  assert.equal(Fu.eat(f, 4500, 'gelcaf', true), 'gel caféiné');
  assert.ok(f.phy.s.cafGut > 90, 'caféine avalée');
  assert.ok(Number.isFinite(Fu.timeToBonk(f, 250, 300)));
});

test('course avec le modèle physiologique : déterministe, capacité réduite par la chaleur et l’effort, coureurs virtuels variés', () => {
  const profile = makeProfile([{ len: 6000, grade: 0 }, { len: 4000, grade: 0.05 }, { len: 6000, grade: 0 }]);
  const run = (physio) => {
    const { course, setup, athlete } = setupFor(profile, {}, { temperature: 33 });
    const race = PYR.race.create({ course, rules: { fuel: true, physio, draft: true }, seed: 42 });
    const me = PYR.race.addRider(race, { id: 'me', name: 'Moi', human: true, setup, athlete, rider: Object.assign({}, RIDER, { weight: 72 }), cmd: 260, kit: Fu.normKit() });
    PYR.race.addBots(race, { n: 4, level: 'equal', rider: Object.assign({}, RIDER, { weight: 72 }), bike: DEFAULT_BIKE, v0: 0 });
    PYR.race.runToEnd(race, 6000);
    return { race, me };
  };
  const a = run(true), b = run(true);
  assert.deepEqual(a.race.riders.map((r) => r.time), b.race.riders.map((r) => r.time), 'même graine, mêmes temps');
  assert.ok(a.me.fuel.phy, 'joueur avec le modèle physiologique');
  assert.ok(a.me.ctx.win.every((d) => d <= 1200), 'courbe record limitée aux efforts de 20 min au plus');
  assert.ok(a.me.st.capK < 1, 'capacité entamée à 33 °C');
  const fis = new Set(a.race.riders.filter((r) => r.bot).map((r) => r.fuel.phy.card.fI));
  assert.ok(fis.size > 1, 'chaque coureur virtuel a sa carte athlète');
  const old = run(false);
  assert.ok(!old.me.fuel.phy && old.me.ctx.win.some((d) => d > 1200), 'sans l’option : modèle simplifié et courbe record complète');
  assert.equal(PYR.race.normRules({ physio: true }).physio, false, 'le modèle physiologique demande l’alimentation');
});

test('compteur : la séance suit le modèle physiologique, et la reprise le rejoue à l’identique', () => {
  const profile = makeProfile([{ len: 8000, grade: 0.01 }]);
  const { course, setup, athlete } = setupFor(profile, {}, { temperature: 25 });
  const c = Mx.card(RIDER, athlete);
  const sess = PYR.ride.createSession({ course, setup, athlete, mass: 70, tempC: 25, physio: c });
  for (let k = 0; k < 900; k++) sess.step({ power: 240, fix: null });
  assert.ok(sess.fuel.phy, 'réserves du modèle physiologique');
  const st = PYR.fuel.status(sess.fuel);
  assert.ok(st.phys.Tc > 37.3 && st.phys.cho > 60);
  const again = PYR.ride.createSession({ course, setup, athlete, mass: 70, tempC: 25, physio: c });
  assert.ok(again.restore(sess.pack()));
  assert.ok(Math.abs(again.fuel.G - sess.fuel.G) < 1e-6, 'glycogène recalculé en rejouant la trace');
  assert.ok(Math.abs(again.fuel.phy.s.Tc - sess.fuel.phy.s.Tc) < 1e-9, 'température recalculée');
});

/**
 * Recalage par la FC : un cycliste « vrai » (carte cTrue, environnement envT) produit la FC mesurée, au bpm près (plus `bias`) ;
 * le modèle (carte c, environnement envM) tourne deux fois, sans recalage (O) et recalé sur cette FC (K). P : puissance (W) à t.
 */
function hrRun({ cTrue, c, envT, envM, P, dur, bias }) {
  const env = (e) => Object.assign({}, Mx.DEF_ENV, { RH: 50, v: 9, vAir: 9, remain: Infinity }, e);
  const eT = env(envT), eM = env(envM);
  const T = Mx.create(cTrue), O = Mx.create(c), K = Mx.create(c);
  let maxDev = 0;
  for (let t = 0; t < dur; t++) {
    const p = P(t), inp = { fluid: 500 / 3600 };
    const oT = Mx.step(cTrue, T, p, eT, inp);
    Mx.step(c, O, p, eM, inp);
    Mx.step(c, K, p, eM, inp);
    Mx.observeHR(c, K, Math.round(oT.HR + (bias || 0)));
    if (t >= 600) maxDev = Math.max(maxDev, Math.abs(K.Tc - O.Tc));
  }
  return { T, O, K, fit: Mx.hrFit(c, K), maxDev };
}

test('recalage par la FC : une FC plus haute que prévu à puissance égale (plus chaud que la météo) fait monter Tc estimée', () => {
  const c = card();
  // il fait 30 °C au grand soleil, la météo en annonce 26 et un ciel voilé : la FC dérive plus que prévu
  const r = hrRun({ cTrue: c, c, envT: { Ta: 30, sun: 700 }, envM: { Ta: 26, sun: 500 }, P: () => 240, dur: 5400 });
  assert.ok(r.T.Tc > r.O.Tc + 0.4, 'le cycliste a plus chaud que ne le prévoit le modèle seul');
  assert.ok(r.K.Tc > r.O.Tc + 0.3, `Tc recalée ${r.K.Tc.toFixed(2)} °C, modèle seul ${r.O.Tc.toFixed(2)} °C`);
  assert.ok(Math.abs(r.K.Tc - r.T.Tc) < 0.4 * Math.abs(r.O.Tc - r.T.Tc), 'Tc recalée bien plus près de la vraie');
  assert.ok(r.fit.Q > 50, 'chaleur que la météo ne voit pas');
  assert.ok(r.K.water > r.O.water, 'plus de sueur, donc plus de déshydratation');
  assert.ok(Math.abs(r.fit.dRest) < 5 && Math.abs(r.fit.dMax) < 5, 'les biais de FC ne prennent pas la dérive thermique');
  const st = Mx.status(c, r.K);
  assert.ok(st.hrFit && st.hrFit.n === 5400 && st.hrFit.sdTc < 0.3, 'recalage visible dans status');
  near(st.HR, Math.round(r.T.o.HR) - 3, Math.round(r.T.o.HR) + 3, 'FC prévue après recalage');
});

test('recalage par la FC : un biais constant de FC est absorbé par les FC de repos et max, sans faire dériver Tc', () => {
  const c = card();
  // FC toujours 8 bpm au-dessus de la prédiction (FC de repos ou max mal estimées), mêmes conditions que le modèle
  const a = hrRun({ cTrue: c, c, envT: { Ta: 20, sun: 300 }, envM: { Ta: 20, sun: 300 }, P: () => 220, dur: 5400, bias: 8 });
  assert.ok(a.maxDev < 0.1, `Tc dérive de ${a.maxDev.toFixed(2)} °C`);
  const fr = (a.K.VO2 - c.VO2rest) / (c.VO2max - c.VO2rest);
  near((1 - fr) * a.fit.dRest + fr * a.fit.dMax, 6.5, 9.5, 'biais appris à l’intensité roulée (bpm)');
  // FC max réelle 175 bpm au lieu des 184 estimées (Tanaka), intensité qui varie : c'est la FC max qui se recale
  const b = hrRun({ cTrue: card({ hrMax: 175 }), c, envT: { Ta: 20, sun: 300 }, envM: { Ta: 20, sun: 300 }, P: (t) => (Math.floor(t / 300) % 2 ? 260 : 170), dur: 5400 });
  assert.ok(b.maxDev < 0.1, `Tc dérive de ${b.maxDev.toFixed(2)} °C`);
  near(b.fit.HRmax, 172, 179, 'FC max recalée');
  near(b.fit.HRrest, c.HRrest - 3, c.HRrest + 3, 'FC de repos inchangée');
});

test('recalage par la FC : une FC conforme à la prédiction ne change rien, pas plus que l’absence de ceinture', () => {
  const c = card();
  const env = Object.assign({}, Mx.DEF_ENV, { Ta: 25, RH: 50, sun: 400, v: 9, vAir: 9 });
  const a = Mx.create(c), b = Mx.create(c);
  for (let t = 0; t < 1800; t++) {
    Mx.step(c, a, 230, env, {});
    Mx.step(c, b, 230, env, {});
    Mx.observeHR(c, b, Mx.predictHR(c, b, true));      // écart nul
  }
  assert.equal(b.Tc, a.Tc); assert.equal(b.water, a.water);
  assert.deepEqual(b.kf.x, [0, 0, 0]);
  assert.equal(Mx.observeHR(c, b, 0), null, 'FC nulle : ignorée');
  assert.equal(Mx.status(c, a).hrFit, null);
  // compteur : sans ceinture (ou ceinture muette), pas de recalage ; avec, la reprise le rejoue à l'identique
  const profile = makeProfile([{ len: 12000, grade: 0.01 }]);
  const { course, setup, athlete } = setupFor(profile, {}, { temperature: 25 });
  const ca = Mx.card(RIDER, athlete);
  const mk = () => PYR.ride.createSession({ course, setup, athlete, mass: 70, tempC: 25, physio: ca });
  const none = mk(), mute = mk(), belt = mk();
  for (let k = 0; k < 1500; k++) {
    none.step({ power: 240, fix: null });
    mute.step({ power: 240, hr: 0, fix: null });
    belt.step({ power: k >= 1200 && k < 1260 ? undefined : 240, hr: 150 + k / 60, fix: null });   // une minute sans puissance : pas de recalage
  }
  assert.equal(none.fuel.phy.s.kf, null, 'sans ceinture, le filtre ne naît pas');
  assert.equal(PYR.fuel.status(none.fuel).phys.hrFit, null);
  assert.equal(mute.fuel.phy.s.Tc, none.fuel.phy.s.Tc, 'ceinture muette : rien ne change');
  assert.equal(mute.fuel.G, none.fuel.G);
  const fit = PYR.fuel.status(belt.fuel).phys.hrFit;
  assert.equal(fit && fit.n, 1500 - 60, 'secondes sans puissance connue : pas de recalage');
  assert.notEqual(belt.fuel.phy.s.Tc, none.fuel.phy.s.Tc, 'avec la ceinture, le modèle est recalé');
  const again = mk();
  assert.ok(again.restore(belt.pack()));
  assert.equal(again.fuel.phy.s.Tc, belt.fuel.phy.s.Tc, 'reprise : même température recalée');
  assert.equal(again.fuel.G, belt.fuel.G);
  assert.deepEqual(PYR.fuel.status(again.fuel).phys.hrFit, fit, 'reprise : même recalage');
});

test('environnement : soleil nul la nuit, plus fort à midi en été qu’en hiver', () => {
  const noonJune = Date.UTC(2026, 5, 21, 11, 30) / 1000, noonDec = Date.UTC(2026, 11, 21, 11, 30) / 1000, night = Date.UTC(2026, 5, 21, 23, 0) / 1000;
  assert.equal(Mx.solarClear(45, 6, night), 0);
  assert.ok(Mx.solarClear(45, 6, noonJune) > 800 && Mx.solarClear(45, 6, noonDec) < 600);
  assert.ok(Mx.solar(45, 6, noonJune, 4) < Mx.solar(45, 6, noonJune, 0), 'pluie : ciel couvert');
});
