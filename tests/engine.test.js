/* author : Hugo Joudrier-Faure */
/* Tests du moteur (node --test tests/) — aucun paquet npm requis. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor, worstWindowViolation } = require('./helpers.js');

async function plan(segments, portions, extra = {}) {
  const prof = makeProfile(segments);
  const { course, setup, athlete } = setupFor(prof, portions, undefined, extra.opts);
  const res = await PYR.optimizer.optimize({ course, setup, athlete, v0: extra.v0 || 0 });
  assert.ok(res.ok, res.error);
  return { res, course, setup, athlete };
}

function segmentAvg(res, a, b) {
  let sum = 0, n = 0;
  for (let t = 0; t < res.series.P.length; t++) {
    const s = res.series.s[t];
    if (s >= a && s < b) { sum += res.series.P[t]; n++; }
  }
  return sum / n;
}

test('courbe de puissance : monotone et CP/W′ plausibles', () => {
  const c = PYR.physio.buildCurve({}, 250);
  for (let i = 1; i < c.values.length; i++) assert.ok(c.values[i] <= c.values[i - 1] + 1e-9);
  const fit = PYR.physio.fitCpWprime(c.fn);
  assert.ok(fit.cp > 245 && fit.cp < 265, `CP ${fit.cp}`);
  assert.ok(fit.wPrime > 15000 && fit.wPrime < 28000, `W′ ${fit.wPrime}`);
  // un record plus long ne peut pas dépasser un plus court
  const c2 = PYR.physio.buildCurve({ 600: 280, 1200: 300 }, 0);
  assert.ok(c2.fn(600) >= c2.fn(1200));
});

test('régime établi : la vitesse simulée converge vers la vitesse d\'équilibre', () => {
  const prof = makeProfile([{ len: 8000, grade: 0.02 }]);
  const { course, setup, athlete } = setupFor(prof);
  const ctx = PYR.sim.createContext(course, setup, athlete, {});
  const st = PYR.sim.initState(ctx, 5);
  const cond = {};
  for (let i = 0; i < 400; i++) { PYR.sim.conditions(ctx, st.s, st.t, cond); PYR.sim.step(ctx, st, 240, cond); }
  const vEq = PYR.physics.steadySpeed(setup, 240, 0.02, 1, course.rho[0], 0, 0);
  assert.ok(Math.abs(st.v - vEq) < 0.05, `${st.v} vs ${vEq}`);
});

test('plat : l\'optimum ≈ puissance constante, contraintes respectées', async () => {
  const { res, athlete } = await plan([{ len: 20000, grade: 0 }]);
  assert.ok(res.tFinish <= res.baseline.time + 1);
  assert.ok(res.stats.wbalMin >= -1);
  assert.ok(worstWindowViolation(res.series.P, athlete) <= 1e-6);
});

test('vallonné : plus fort en montée, plus faible en descente, plus rapide que l\'allure constante', async () => {
  const { res, athlete } = await plan([{ len: 10000, grade: 0 }, { len: 5000, grade: 0.06 }, { len: 5000, grade: -0.06 }, { len: 10000, grade: 0 }]);
  const flat = segmentAvg(res, 0, 10000), climb = segmentAvg(res, 10000, 15000), desc = segmentAvg(res, 15000, 20000);
  assert.ok(climb > flat && flat > desc, `montée ${climb} / plat ${flat} / descente ${desc}`);
  assert.ok(res.tFinish < res.baseline.time - 10);
  assert.ok(worstWindowViolation(res.series.P, athlete) <= 1e-6);
});

test('vent : plus de puissance vent de face que vent de dos', async () => {
  const { res } = await plan([{ len: 10000, grade: 0 }, { len: 10000, grade: 0 }],
    { winds: [{ startKm: 0, endKm: 10, dir: 0, speed: 25 }, { startKm: 10, endKm: 20, dir: 180, speed: 25 }] });
  assert.ok(segmentAvg(res, 0, 10000) > segmentAvg(res, 10000, 20000) + 10);
  assert.ok(res.tFinish <= res.baseline.time);
});

test('sortie longue : NP ≤ record de la durée, jamais moins bon que l\'allure constante', async () => {
  const segs = Array.from({ length: 20 }, (_, i) => ({ len: 5000, grade: [0, 0.03, -0.03, 0.01, -0.01][i % 5] }));
  const { res, athlete } = await plan(segs);
  assert.ok(res.stats.np <= athlete.mmp(res.tFinish) * 1.005, `NP ${res.stats.np}`);
  assert.ok(res.tFinish <= res.baseline.time);
});

test('sprint : profil de puissance lisse et décroissant', async () => {
  const { res } = await plan([{ len: 400, grade: 0 }]);
  const P = res.series.P;
  for (let t = 1; t < 10; t++) assert.ok(P[t] <= P[t - 1] + 1, `t=${t}: ${P[t - 1]} → ${P[t]}`);
});

test('lacets : freinage avant les épingles', async () => {
  const d = [];
  for (let i = 0; i < 6; i++) d.push({ len: 400, grade: -0.08, turn: 180 });
  const { res, course } = await plan([{ len: 2000, grade: 0 }, ...d]);
  let brake = 0;
  for (let t = 0; t < res.n; t++) brake += res.series.brk[t];
  assert.ok(brake > 0);
  let minLim = Infinity;
  for (let i = 0; i < course.n; i++) minLim = Math.min(minLim, course.vLim[i]);
  assert.ok(minLim * 3.6 < 40, `vitesse min en épingle ${minLim * 3.6}`);
});

test('mode jeu : la puissance demandée est plafonnée quand W′ est vide', () => {
  const prof = makeProfile([{ len: 5000, grade: 0.05 }]);
  const { course, setup, athlete } = setupFor(prof);
  const ctx = PYR.sim.createContext(course, setup, athlete, {});
  const st = PYR.sim.initState(ctx, 5);
  const cond = {};
  let last = 0;
  for (let i = 0; i < 300; i++) { PYR.sim.conditions(ctx, st.s, st.t, cond); last = PYR.sim.step(ctx, st, 600, cond); }
  assert.ok(st.wbal < 1);
  assert.ok(last <= ctx.cp + 1, `puissance ${last} > PC ${ctx.cp}`);
});

test('mode jeu : limité par la courbe record, le coureur ralentit sans s\'arrêter tant qu\'il a du W′', () => {
  const { course, setup, athlete } = setupFor(makeProfile([{ len: 150000, grade: 0 }]));
  const ride = (smoothRec, cmd, T) => {
    const ctx = PYR.sim.createContext(course, setup, athlete, { smoothRec });
    const st = PYR.sim.initState(ctx, 8), cond = {}, P = [];
    let zeros = 0, minP = Infinity;
    for (let i = 0; i < T; i++) {
      PYR.sim.conditions(ctx, st.s, st.t, cond);
      const p = PYR.sim.step(ctx, st, cmd(i), cond);
      P.push(p);
      if (i > 400) { minP = Math.min(minP, p); if (p < 100) zeros++; }
    }
    return { P, zeros, minP, ctx };
  };
  // 330 W demandés pendant 2 h : un effort sur le W′, puis la PC, dépassent le record de 45 min…
  const greedy = ride(false, () => 330, 7200), smooth = ride(true, () => 330, 7200);
  assert.ok(greedy.zeros > 100, `sans anticipation : ${greedy.zeros} s à l'arrêt`);
  // …le plafond lissé anticipe : jamais à l'arrêt, record jamais dépassé, énergie comparable
  assert.equal(smooth.zeros, 0);
  assert.ok(smooth.minP > 120, `puissance minimale ${Math.round(smooth.minP)} W`);
  assert.ok(worstWindowViolation(smooth.P, athlete) <= 1e-6);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  assert.ok(sum(smooth.P) > 0.97 * sum(greedy.P), 'ne perd pas d\'énergie');
  // sprint et effort maximal inchangés tant que le W′ dure : 1150 W la première seconde, puis la courbe record
  const allOut = ride(true, () => 2000, 600);
  assert.ok(allOut.P[0] > 1100, `départ ${Math.round(allOut.P[0])} W`);
  assert.deepEqual(allOut.P.slice(0, 200), ride(false, () => 2000, 600).P.slice(0, 200));
  // une pause après un sprint, puis 290 W : plus de creux de plusieurs minutes
  const late = ride(true, (i) => (i < 7200 ? 200 : 290), 11000);
  assert.equal(late.zeros, 0);
  assert.ok(worstWindowViolation(late.P, athlete) <= 1e-6);
});
