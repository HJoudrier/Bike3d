/* author : Hugo Joudrier-Faure */
/* Tests de la limite de la courbe record en mode jeu : interpolation linéaire entre deux points de la courbe (pas d'escalier)
 * et point de la courbe qui fixe la limite (durée, record, puissance). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor } = require('./helpers.js');

const setup = () => setupFor(makeProfile([{ len: 150000, grade: 0 }]));
const D = PYR.physio.DURATIONS;

test('mode jeu : fenêtres intermédiaires entre les points de la courbe, record interpolé linéairement', () => {
  const { course, setup: su, athlete } = setup();
  const plain = PYR.sim.createContext(course, su, athlete, {});
  const game = PYR.sim.createContext(course, su, athlete, { smoothRec: true });
  assert.equal(plain.mmpAt, null);
  assert.ok(game.nWin > 2 * plain.nWin, `${game.nWin} fenêtres contre ${plain.nWin}`);
  // les fenêtres des points de la courbe sont inchangées
  for (const d of D) {
    const jp = Array.from(plain.win).indexOf(d), jg = Array.from(game.win).indexOf(d);
    assert.ok(jp >= 0 && jg >= 0);
    assert.ok(Math.abs(plain.capTot[jp] - game.capTot[jg]) < 1e-6, `point ${d} s`);
  }
  // une fenêtre intermédiaire : record = interpolation linéaire des deux points voisins
  const [d0, d1] = [60, 120];
  const mid = Array.from(game.win).map((d, j) => [d, j]).filter(([d, j]) => d > d0 && d < d1 && game.extra[j]);
  assert.ok(mid.length >= 3, 'plusieurs fenêtres entre 60 s et 120 s');
  for (const [d, j] of mid) {
    const p = athlete.mmp(d0) + (athlete.mmp(d1) - athlete.mmp(d0)) * (d - d0) / (d1 - d0);
    assert.ok(Math.abs(game.capTot[j] / d - p) < 1e-9, `${d} s`);
    assert.ok(Math.abs(game.mmpAt(d) - p) < 1e-9);
  }
  // fenêtres triées, sans doublon
  for (let j = 1; j < game.nWin; j++) assert.ok(game.win[j] > game.win[j - 1]);
});

test('le record interpolé est bien entre les deux points voisins (pas de marche d\'escalier)', () => {
  const { course, setup: su, athlete } = setup();
  const game = PYR.sim.createContext(course, su, athlete, { smoothRec: true });
  for (let i = 1; i < D.length; i++) {
    const hi = athlete.mmp(D[i - 1]), lo = athlete.mmp(D[i]);
    for (const d of [D[i - 1] + 1, Math.round((D[i - 1] + D[i]) / 2), D[i] - 1]) {
      if (d <= D[i - 1] || d >= D[i]) continue;
      const p = game.mmpAt(d);
      assert.ok(p <= hi + 1e-9 && p >= lo - 1e-9, `${d} s : ${p} entre ${lo} et ${hi}`);
    }
  }
});

test('point de la courbe qui limite : durée, record et puissance limite cohérents', () => {
  const { course, setup: su, athlete } = setup();
  const ctx = PYR.sim.createContext(course, su, athlete, { smoothRec: true });
  const st = PYR.sim.initState(ctx, 8), cond = {};
  let capped = 0;
  for (let i = 0; i < 1500; i++) {
    PYR.sim.conditions(ctx, st.s, st.t, cond);
    PYR.sim.step(ctx, st, 600, cond);
    if (st.capped && i > 200) {
      const b = PYR.sim.recordBinding(ctx, st);
      assert.ok(b.d >= 1 && b.d <= 86400, `durée ${b.d}`);
      assert.ok(Math.abs(b.rec - ctx.mmpAt(b.d) * ctx.marginK) < 1e-6, `record de ${b.d} s`);
      assert.equal(b.P, PYR.sim.availablePower(ctx, st).capM, 'puissance limite = celle du limiteur');
      capped++;
    }
  }
  assert.ok(capped > 100, `limité pendant ${capped} s`);
});

test('la limite de puissance baisse sans marches d\'escalier quand l\'effort se prolonge', () => {
  const { course, setup: su, athlete } = setup();
  const run = (smoothRec) => {
    const ctx = PYR.sim.createContext(course, su, athlete, { smoothRec });
    const st = PYR.sim.initState(ctx, 8), cond = {};
    const cap = [];
    for (let i = 0; i < 900; i++) {
      PYR.sim.conditions(ctx, st.s, st.t, cond);
      PYR.sim.step(ctx, st, 2000, cond); // effort maximal : la puissance suit la limite
      cap.push(PYR.sim.availablePower(ctx, st).capM);
    }
    return cap;
  };
  const biggestStep = (c) => { let m = 0; for (let i = 61; i < c.length; i++) m = Math.max(m, Math.abs(c[i] - c[i - 1])); return m; };
  const smooth = biggestStep(run(true)), coarse = biggestStep(run(false));
  assert.ok(smooth <= coarse + 1e-6, `plus grand saut ${smooth.toFixed(1)} W (lissé) contre ${coarse.toFixed(1)} W`);
});

/** Roule effortS secondes à fond, puis restS secondes à restW, et renvoie le contexte et l'état. */
function rideThen(effortS, restS, restW = 250) {
  const { course, setup: su, athlete } = setup();
  const ctx = PYR.sim.createContext(course, su, athlete, { smoothRec: true });
  const st = PYR.sim.initState(ctx, 8), cond = {};
  for (let i = 0; i < effortS + restS; i++) {
    PYR.sim.conditions(ctx, st.s, st.t, cond);
    PYR.sim.step(ctx, st, i < effortS ? 2000 : restW, cond);
  }
  return { ctx, st, athlete };
}

test('courbe disponible : à l\'état frais c\'est la courbe de puissance record', () => {
  const { ctx, st, athlete } = rideThen(0, 0);
  const taus = [5, 15, 60, 300, 1200];
  const P = PYR.sim.forwardCurve(ctx, st, taus);
  taus.forEach((tau, i) => assert.ok(Math.abs(P[i] - athlete.mmp(tau) * ctx.marginK) < 1e-6, `${tau} s : ${P[i]} contre ${athlete.mmp(tau)}`));
  const u = PYR.sim.recordUsage(ctx, st);
  assert.equal(u.use, 0);
});

test('courbe disponible : après un effort à fond elle s\'affaisse (contre-effort) puis se reconstitue', () => {
  const taus = [5, 15, 60, 300];
  const fresh = rideThen(0, 0);
  const F = PYR.sim.forwardCurve(fresh.ctx, fresh.st, taus);
  const after = rideThen(60, 0);
  const A = PYR.sim.forwardCurve(after.ctx, after.st, taus);
  assert.ok(A[0] < 0.6 * F[0], `5 s : ${A[0].toFixed(0)} W contre ${F[0].toFixed(0)} W à l'état frais`);
  assert.ok(A[2] < F[2], '1 min');
  assert.ok(PYR.sim.recordUsage(after.ctx, after.st).use > 0.9, 'une fenêtre est presque pleine');
  const later = rideThen(60, 150);
  const L = PYR.sim.forwardCurve(later.ctx, later.st, taus);
  taus.forEach((tau, i) => assert.ok(L[i] >= A[i] - 1e-6, `${tau} s : ne baisse pas pendant le repos`));
  assert.ok(L[1] > A[1] + 100, '15 s : se reconstitue');
});

test('courbe disponible : rester à la puissance tenable 15 s ou 1 min en continu ne limite jamais (chaque seconde de l\'effort est contrôlée)', () => {
  for (const tau of [15, 60, 300]) {
    const { ctx, st } = rideThen(0, 0);
    const cond = {};
    let limited = 0;
    for (let i = 0; i < 400; i++) {
      PYR.sim.conditions(ctx, st.s, st.t, cond);
      const target = PYR.sim.forwardCurve(ctx, st, [tau])[0];
      assert.ok(target <= PYR.sim.availablePower(ctx, st).cap + 1e-6, 'jamais au-dessus de la limite de la seconde qui vient');
      const P = PYR.sim.step(ctx, st, target, cond);
      if (P < target - 1) limited++;
    }
    assert.equal(limited, 0, `puissance tenable ${tau} s suivie 400 s : ${limited} s limitées`);
  }
});

test('courbe disponible : elle suit le record du jour (forme du jour), pas la courbe de référence', () => {
  const { course, setup: su, athlete } = setup();
  const day = PYR.physio.scaleAthlete(athlete, 0.94, 0.9); // « jour sans »
  const make = (a) => { const ctx = PYR.sim.createContext(course, su, a, { smoothRec: true }); return { ctx, st: PYR.sim.initState(ctx, 8) }; };
  const ref = make(athlete), dd = make(day);
  const taus = [15, 60, 300, 1200];
  const R = PYR.sim.forwardCurve(ref.ctx, ref.st, taus), Dy = PYR.sim.forwardCurve(dd.ctx, dd.st, taus);
  taus.forEach((tau, i) => assert.ok(Dy[i] < R[i], `${tau} s : jour sans ${Dy[i].toFixed(0)} W < référence ${R[i].toFixed(0)} W`));
  // chute ou fringale : capK réduit tout
  const hurt = make(athlete); hurt.st.capK = 0.9;
  const H = PYR.sim.forwardCurve(hurt.ctx, hurt.st, taus);
  taus.forEach((tau, i) => assert.ok(H[i] < R[i], `${tau} s : capacité à 90 %`));
});

test('durée tenable (courbe record) : elle diminue d\'une seconde par seconde à puissance constante, sans marches d\'escalier', () => {
  const { ctx, st } = rideThen(0, 0);
  const cond = {};
  const left = [];
  for (let i = 0; i < 90; i++) {
    PYR.sim.conditions(ctx, st.s, st.t, cond);
    PYR.sim.step(ctx, st, 380, cond);
    left.push(PYR.sim.timeToExhaustion(ctx, st, 380).record);
  }
  const steps = new Set(left.slice(1).map((v, i) => Math.round(left[i] - v)));
  assert.deepEqual([...steps], [1], `pas observés : ${[...steps]} (début ${left.slice(0, 6).join(', ')})`);
});
