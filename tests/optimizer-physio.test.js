/* author : Hugo Joudrier-Faure */
/* Tests de la stratégie optimale avec le modèle physiologique (option de l'onglet Performance, optimizer.optimizePhysio) : modèle
 * réduit dans le simulateur (profil de capacité le long du parcours, endurance du jour), vérification d'un plan sur le modèle complet
 * (metabo.js, avec le plan d'alimentation), plan plus prudent sur un long parcours chaud sans ravitaillement. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor, DEFAULT_RIDER } = require('./helpers.js');

const Opt = PYR.optimizer, Mx = PYR.metabo, GR = PYR.gradient, I = GR._internal;
const WATER = { slots: ['water', 'water', '', ''], items: {} };                          // deux bidons d'eau, rien à manger
const FED = { slots: ['iso', 'iso', 'iso', ''], items: { gel: 6, bar: 4 } };             // boisson énergétique, gels et barres
const ROLLING = (km) => Array.from({ length: km / 5 }, (_, i) => ({ len: 5000, grade: [0, 0.02, -0.02, 0.01, -0.01, 0][i % 6] }));

/** Sortie sur les tronçons segs à la température tempC ; carte athlète `physio` (champs de rider.physio), matériel kit, intestin gut. */
function ride(segs, tempC, o = {}) {
  const rider = Object.assign({}, DEFAULT_RIDER, { physio: o.physio || {}, gut: o.gut || 0 });
  const { course, setup, athlete } = setupFor(makeProfile(segs), {}, { temperature: tempC }, undefined, rider);
  const input = { course, setup, athlete, algo: o.algo || 'analytic' };
  return { input, physio: { card: Mx.card(rider, athlete), kit: o.kit || WATER, gut: o.gut || 0 } };
}
const withPhysio = (r, extra) => Object.assign({}, r.input, { physio: r.physio }, extra || {});

/** Puissance moyenne du plan entre les distances a et b (m). */
function meanP(res, a, b) {
  let s = 0, n = 0;
  for (let t = 0; t < res.series.P.length; t++) if (res.series.s[t] >= a && res.series.s[t] < b) { s += res.series.P[t]; n++; }
  return s / n;
}

test('modèle réduit : profil de capacité le long du parcours (PC, W′, records courts) et endurance du jour (records de 20 min et plus)', () => {
  const { course, setup, athlete } = setupFor(makeProfile([{ len: 10000, grade: 0 }]));
  const half = Math.floor(course.n / 2);
  const capS = new Float32Array(course.n).fill(1).fill(0.8, half), wS = new Float32Array(course.n).fill(1).fill(0.5, half);
  const ref = PYR.sim.createContext(course, setup, athlete, {});
  const ctx = PYR.sim.createContext(course, setup, athlete, { capS, wS });
  assert.deepEqual(Array.from(ctx.capTot), Array.from(ref.capTot), 'le profil ne touche pas à la table des records');
  const cond = {};
  PYR.sim.conditions(ctx, 1000, 0, cond);
  assert.deepEqual([cond.capS, cond.wS], [1, 1], 'capacité entière avant la baisse');
  PYR.sim.conditions(ref, 8000, 0, cond);
  assert.deepEqual([cond.capS, cond.wS], [1, 1], 'sans profil : 1 partout');
  PYR.sim.conditions(ctx, 8000, 0, cond);
  assert.ok(Math.abs(cond.capS - 0.8) < 1e-6 && Math.abs(cond.wS - 0.5) < 1e-6, `${cond.capS} / ${cond.wS}`);
  // à 90 % de la PC là où elle est réduite à 80 % : on puise dans W′ ; le record de 1 s est réduit lui aussi
  const st = PYR.sim.initState(ctx, 10);
  st.s = 8000;
  PYR.sim.step(ctx, st, 0.9 * ctx.cp, cond);
  assert.ok(Math.abs(ctx.w0 - st.wbal - 0.1 * ctx.cp) < 1e-6 * ctx.cp, `W′ entamé de ${ctx.w0 - st.wbal} J`);
  assert.ok(Math.abs(st.capM - 0.8 * ref.capTot[0]) < 1e-6 * ref.capTot[0], 'record de 1 s à 80 %');
  // sous la PC réduite, W′ revient vers la moitié du W′ (wS), pas vers le W′ entier
  const w1 = st.wbal;
  for (let k = 0; k < 600; k++) PYR.sim.step(ctx, st, 0, cond);
  assert.ok(st.wbal < w1 && Math.abs(st.wbal - 0.5 * ctx.w0) < 0.05 * ctx.w0, `W′ ${st.wbal} J`);
  // endurance du jour : records de 20 min et plus seulement ; taux d'utilisation de la sortie divisé d'autant
  const e = PYR.sim.createContext(course, setup, athlete, { endK: 0.9 });
  for (let j = 0; j < ref.nWin; j++) {
    const k = e.capTot[j] / ref.capTot[j];
    assert.ok(Math.abs(k - (ref.win[j] >= PYR.sim.LONG_WINDOW ? 0.9 : 1)) < 1e-12, `fenêtre de ${ref.win[j]} s : ${k}`);
  }
  const H = new Float64Array(3601);
  for (let t = 1; t <= 3600; t++) H[t] = H[t - 1] + 0.9 * athlete.cp;
  assert.ok(Math.abs(PYR.sim.enduranceUse(e, H, 3600) * 0.9 - PYR.sim.enduranceUse(ref, H, 3600)) < 1e-9);
});

test('modèle physiologique : sans l’option rien ne change ; un plan que le modèle complet tient est gardé tel quel', async () => {
  const r = ride(ROLLING(150), 8, { kit: FED, gut: 1 });
  const base = await Opt.optimize(r.input);
  assert.equal(base.physio, undefined, 'sans l’option : pas de vérification');
  const res = await Opt.optimize(withPhysio(r));
  const ph = res.physio;
  assert.ok(ph.feasible && ph.minW >= 0, `W′bal effectif le plus bas ${ph.minW}`);
  assert.equal(ph.runs.length, 1, 'un seul calcul');
  assert.equal(ph.endK, 1);
  assert.equal(ph.capS, null);
  assert.equal(res.tFinish, base.tFinish, 'même plan');
  assert.deepEqual(Array.from(res.series.P), Array.from(base.series.P));
  for (const k of ['cpK', 'wK', 'cpLoc', 'wLoc', 'Tc', 'wbal']) assert.equal(ph[k].length, res.n + 1, k);
  assert.ok(Math.abs(ph.Tc[0] - 37) < 1e-6 && ph.maxTc > 37.5, `Tc ${ph.Tc[0]} → ${ph.maxTc}`);
  assert.ok(ph.nutrition.eat > 0 && ph.nutrition.drink > 0, 'prises du plan d’alimentation');
  assert.ok(ph.endCpK < 1 && ph.endCpK > 0.8, `PC effective à l’arrivée ${ph.endCpK}`);
});

test('modèle physiologique : long parcours chaud sans ravitaillement — plan plus prudent sur la fin, tenu par le modèle complet', async () => {
  const r = ride(ROLLING(100), 33);
  const L = r.input.course.length;
  const base = await Opt.optimize(r.input);
  const chk = Opt.physioCheck(withPhysio(r), base);
  assert.ok(!chk.feasible && chk.minW < -0.5 * chk.w0, `sans l’option, le W′ se viderait : ${chk.minW} J`);
  assert.ok(chk.cpK[chk.cpK.length - 1] < 0.8 * chk.cpK[0], 'la PC effective s’effondre (glycogène, chaleur, eau)');
  const res = await Opt.optimize(withPhysio(r));
  const ph = res.physio;
  assert.ok(ph.feasible && ph.minW >= -ph.tol, `W′bal effectif le plus bas ${ph.minW}`);
  assert.ok(ph.runs.length >= 2 && ph.runs.length <= Opt.PHYSIO_RUNS && !ph.runs[0].feasible, `${ph.runs.length} calculs`);
  assert.ok(ph.endK < 1 && ph.endK > 0.8, `endurance du jour ${ph.endK}`);
  assert.ok(ph.capS && ph.capS.length === r.input.course.n && ph.capS[ph.capS.length - 1] < 0.98, 'capacité réduite sur la fin (chaleur, eau)');
  const endB = meanP(base, 0.75 * L, L), endP = meanP(res, 0.75 * L, L);
  assert.ok(endP < endB - 5, `dernier quart : ${endP.toFixed(0)} W avec l’option, ${endB.toFixed(0)} W sans`);
  assert.ok(res.tFinish > base.tFinish, 'plus lent que le plan qui ne tiendrait pas');
  assert.ok(ph.endCpK > chk.endCpK, `PC effective à l’arrivée : ${ph.endCpK} contre ${chk.endCpK}`);
  assert.ok(ph.maxTc > 38.5 && ph.maxTc < ph.Tcrit, `température centrale ${ph.maxTc}`);
});

test('modèle physiologique : le plan d’alimentation compte — gels et boisson énergétique soutiennent la PC effective', async () => {
  const dry = ride(ROLLING(100), 33), fed = ride(ROLLING(100), 33, { kit: FED });
  const base = await Opt.optimize(dry.input);
  const a = Opt.physioCheck(withPhysio(dry), base), b = Opt.physioCheck(withPhysio(fed), base);
  assert.equal(a.nutrition.eat, 0, 'rien à manger');
  assert.ok(b.nutrition.eat > 0 && b.nutrition.carbsPerH > 0, 'gels et barres pris');
  assert.ok(b.endCpK > a.endCpK + 0.05, `PC effective à l’arrivée : ${b.endCpK} nourri, ${a.endCpK} à l’eau`);
  assert.ok(b.minW > a.minW, 'le W′ se vide moins');
  const again = Opt.physioCheck(withPhysio(fed), base);
  assert.deepEqual(Array.from(again.cpK), Array.from(b.cpK), 'déterministe');
});

test('modèle physiologique : ignoré en replanification (la séance suit déjà la capacité du moment)', async () => {
  const r = ride([{ len: 6000, grade: 0 }, { len: 2000, grade: 0.04 }], 33);
  const ctx = PYR.sim.createContext(r.input.course, r.input.setup, r.input.athlete, {});
  const start = { t: 300, s: 2500, v: 9, wbal: 0.6 * ctx.w0, hist: Float64Array.from({ length: 301 }, (_, k) => 230 * k) };
  const res = await Opt.optimize(withPhysio(r, { start }));
  assert.ok(res.ok, res.error);
  assert.equal(res.physio, undefined);
  assert.equal(res.t0, 300);
});

test('descente de gradient avec un profil de capacité : passage arrière et pas faisable avec la PC et le W′ du lieu', async () => {
  const segs = [{ len: 6000, grade: 0 }, { len: 3000, grade: 0.05 }, { len: 1000, grade: -0.03 }, { len: 4000, grade: 0.005 }];
  const { course, setup, athlete } = setupFor(makeProfile(segs));
  const capS = new Float32Array(course.n), wS = new Float32Array(course.n);
  for (let i = 0; i < course.n; i++) { const x = (i + 0.5) * course.step; capS[i] = x < 6000 ? 1 : 0.88; wS[i] = x < 6000 ? 1 : 0.8; }
  const ctx0 = PYR.sim.createContext(course, setup, athlete, { capS, wS });
  const ctx = Object.assign({}, ctx0, { gusts: null, longCap: true });
  const rctx = Object.assign({}, ctx, { capTot: Float64Array.of(1e9), nWin: 1, nWinShort: 1, longCap: false });
  const L = course.length, N = ctx.maxSteps + 2;
  const ds = 32 * L / 1500, sch = GR.makeSchedule(L, ds, () => 215), K = sch.K;
  const rec = I.makeRec(N), ws = I.makeWorkspace(N);
  I.simulate(ctx, sch, 0, rec);
  let lowCp = 0;
  for (let t = 0; t < rec.n; t++) if (rec.s[t] > 6100 && Math.abs(rec.kc[t] - 0.88) < 1e-6 && Math.abs(rec.kw[t] - 0.8) < 1e-6) lowCp++;
  assert.ok(lowCp > 100, 'PC et W′ du lieu enregistrés à chaque seconde');
  await I.prepare(ctx, rctx, rec, sch, ws, null);
  const gr = I.reduce(ctx, rec, ws);
  const d = Float64Array.from(gr.g, (x, j) => Math.max(-60, Math.min(60, -x * Math.max(sch.P[j], 80) ** 2 / Math.max(ws.tw[j], 1))));
  const r = I.maxFeasibleStep(ctx, rec, ws, d, new Set());
  assert.ok(r.alpha > 0 && isFinite(r.alpha), 'pas maximal fini');
  const cand = { ds, K, P: Float64Array.from(sch.P, (p, j) => p + 0.9 * r.alpha * d[j]) };
  const out = I.simulate(ctx, cand, 0, I.makeRec(N));
  let clipped = 0, lost = 0;
  for (let t = 0; t < out.n; t++) if (!out.brk[t] && out.R[t] < out.cmd[t] - 0.5) { clipped++; lost += out.cmd[t] - out.R[t]; }
  assert.ok(clipped <= 3 && lost < 20, `${clipped} secondes écrêtées, ${lost.toFixed(1)} W perdus`);
  // l'optimiseur complet avec ce profil : W′ (réduit) respecté, montée plus douce qu'avec la capacité entière
  const full = await Opt.optimize({ course, setup, athlete, algo: 'gradient' });
  const red = await Opt.optimize({ course, setup, athlete, algo: 'gradient', capS, wS });
  assert.ok(red.ok && red.stats.wbalMin >= -1, `W′ min ${red.stats.wbalMin}`);
  assert.ok(meanP(red, 6000, 9000) < meanP(full, 6000, 9000) - 10, `montée : ${meanP(red, 6000, 9000).toFixed(0)} W contre ${meanP(full, 6000, 9000).toFixed(0)} W`);
});

test('modèle physiologique, algorithme hybride : endurance cherchée en analytique, plan final de l’hybride vérifié lui aussi', async () => {
  const segs = Array.from({ length: 12 }, (_, i) => ({ len: 2000, grade: [0, 0.03, -0.03, 0][i % 4] }));
  const r = ride(segs, 33, { physio: { glyFill: 25 }, algo: 'hybrid' });
  const res = await Opt.optimize(withPhysio(r));
  const ph = res.physio, runs = ph.runs;
  assert.ok(runs.slice(0, -1).every((x) => x.algo === 'analytic'), 'recherche en analytique');
  assert.equal(runs[runs.length - 1].algo, 'hybrid', 'puis un calcul avec l’algorithme choisi');
  assert.ok(ph.feasible, `W′bal effectif le plus bas ${ph.minW}`);
  const fastest = Math.min(...runs.filter((x) => x.feasible).map((x) => x.time));
  assert.equal(res.tFinish, fastest, 'le plus rapide des plans tenus');
  assert.ok(ph.endK < 1);
});
