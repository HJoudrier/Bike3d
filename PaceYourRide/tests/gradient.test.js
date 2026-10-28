/* author : Hugo Joudrier-Faure */
/* Tests de la stratégie par descente de gradient (node --test tests/gradient.test.js) — aucun paquet npm requis. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor, worstWindowViolation } = require('./helpers.js');

const GR = PYR.gradient, I = GR._internal;

/** Pente lissée (transitions étalées sur `width` m) : plus proche d'un tracé réel que des marches de pente. */
function smooth(fn, length, seg = 50, width = 400) {
  const n = Math.round(length / seg), k = Math.max(1, Math.round(width / seg));
  const raw = Array.from({ length: n }, (_, i) => fn((i + 0.5) * seg));
  return raw.map((_, i) => {
    let s = 0, c = 0;
    for (let j = i - k; j <= i + k; j++) if (j >= 0 && j < n) { s += raw[j]; c++; }
    return { len: seg, grade: s / c };
  });
}
const HILLY = () => smooth((s) => (s < 10000 ? 0 : s < 15000 ? 0.06 : s < 20000 ? -0.06 : 0), 30000);
const ROLLING = () => smooth((s) => 0.045 * Math.sin(s / 900) + 0.02 * Math.sin(s / 310), 30000, 50, 150);
const SHORT_CLIMB = () => smooth((s) => (s < 3000 ? 0 : s < 4500 ? 0.07 : s < 5500 ? -0.05 : 0.005), 9000, 25, 100);

async function plan(segments, algo, extra = {}) {
  const prof = makeProfile(segments);
  const { course, setup, athlete } = setupFor(prof, extra.portions, undefined, extra.opts);
  const res = await PYR.optimizer.optimize({ course, setup, athlete, v0: extra.v0 || 0, margin: extra.margin || 0, algo });
  assert.ok(res.ok, res.error);
  return { res, course, setup, athlete };
}

/** Plan faisable : W′ ≥ 0, courbe record respectée sur toutes les fenêtres, endurance dans la tolérance. */
function assertFeasible(res, athlete, margin = 0) {
  assert.ok(res.stats.wbalMin >= -1, `W′ min ${res.stats.wbalMin}`);
  assert.ok(worstWindowViolation(res.series.P, athlete, margin) <= 1e-6, 'courbe record dépassée');
  assert.ok(res.stats.enduranceUse <= 1.0015, `endurance ${res.stats.enduranceUse}`);
}

/** Moyenne de la puissance sur les secondes où la pente est dans [lo, hi]. */
function avgPowerOnGrade(res, course, lo, hi) {
  let sum = 0, n = 0;
  for (let t = 0; t < res.series.P.length; t++) {
    const i = Math.min(course.n - 1, Math.floor(res.series.s[t] / course.step));
    const g = course.grade[i];
    if (g >= lo && g < hi) { sum += res.series.P[t]; n++; }
  }
  return n ? sum / n : NaN;
}

test('consigne en distance : rééchantillonner avec des nœuds deux fois plus serrés ne change rien', () => {
  const prof = makeProfile(HILLY());
  const { course, setup, athlete } = setupFor(prof);
  const ctx = PYR.sim.createContext(course, setup, athlete, {});
  const L = course.length;
  const sch = GR.makeSchedule(L, 300, (s) => 220 + 40 * Math.sin(s / 1500));
  const fine = GR.makeSchedule(L, 150, (s) => GR.sample(sch, s));
  const a = I.simulate(ctx, sch, 0, I.makeRec(ctx.maxSteps + 2));
  const b = I.simulate(ctx, fine, 0, I.makeRec(ctx.maxSteps + 2));
  assert.ok(a.finished && b.finished);
  assert.ok(Math.abs(a.T - b.T) < 0.01, `${a.T} vs ${b.T}`);
  // la consigne est attachée à la distance : le nœud k vaut la consigne à k·pas, interpolation linéaire entre deux nœuds
  assert.equal(GR.sample(sch, 600), sch.P[2]);
  assert.ok(Math.abs(GR.sample(sch, 450) - 0.5 * (sch.P[1] + sch.P[2])) < 1e-9);
  assert.equal(GR.sample(sch, -5), sch.P[0]);
  assert.equal(GR.sample(sch, 1e9), sch.P[sch.K]);
});

test('consigne issue d\'une série seconde par seconde : retrouve la puissance moyenne par tronçon', () => {
  const n = 600, s = new Float64Array(n), P = new Float64Array(n);
  for (let t = 0; t < n; t++) { s[t] = t * 8; P[t] = t < 300 ? 200 : 300; }
  const sch = GR.scheduleFromSeries(4800, 400, s, P, n);
  assert.ok(Math.abs(sch.P[2] - 200) < 1e-6);
  assert.ok(Math.abs(sch.P[10] - 300) < 1e-6);
  assert.ok(sch.P[6] > 200 && sch.P[6] < 300);
});

test('gradient physique : en régime libre, il prédit la variation du temps (différences finies sur le simulateur)', async () => {
  const prof = makeProfile(ROLLING());
  const { course, setup, athlete } = setupFor(prof);
  const ctx0 = PYR.sim.createContext(course, setup, athlete, {});
  const ctx = Object.assign({}, ctx0, { gusts: null, longCap: true });
  const rctx = Object.assign({}, ctx, { capTot: Float64Array.of(1e9), nWin: 1, nWinShort: 1, longCap: false });
  const L = course.length, N = ctx.maxSteps + 2;
  const ds = 32 * L / 3600, sch = GR.makeSchedule(L, ds, () => 200), K = sch.K;
  const rec = I.makeRec(N), ws = I.makeWorkspace(N);
  I.simulate(ctx, sch, 0, rec);
  await I.prepare(ctx, rctx, rec, sch, ws, null);
  const gr = I.reduce(ctx, rec, ws);
  assert.deepEqual(gr.counts.slice(1), [0, 0, 0], 'à 200 W aucune contrainte n\'est saturée');

  const fd = (dir, amp) => {
    const mk = (sg) => ({ ds, K, P: Float64Array.from(sch.P, (p, j) => p + sg * amp * dir[j]) });
    const rp = I.simulate(ctx, mk(1), 0, I.makeRec(N)), rm = I.simulate(ctx, mk(-1), 0, I.makeRec(N));
    return (rp.T - rm.T) / (2 * amp);
  };
  const pred = (dir) => { let x = 0; for (let j = 0; j <= K; j++) x += gr.g[j] * dir[j]; return x; };
  // directions franches (somme de beaucoup de nœuds) : l'écart tient à la quantification du simulateur à 1 s
  const uniform = Float64Array.from({ length: K + 1 }, () => 1);
  const wave = Float64Array.from({ length: K + 1 }, (_, j) => Math.sin(j / 6));
  const r1 = pred(uniform) / fd(uniform, 4), r2 = pred(wave) / fd(wave, 4);
  assert.ok(r1 > 0.9 && r1 < 1.12, `direction uniforme : rapport ${r1}`);
  assert.ok(r2 > 0.75 && r2 < 1.3, `direction ondulée : rapport ${r2}`);
  // plus de puissance partout fait gagner du temps : gradient négatif nœud par nœud (hors extrémités)
  for (let j = 2; j < K - 2; j++) assert.ok(gr.g[j] < 0, `g[${j}] = ${gr.g[j]}`);
});

test('multiplicateurs : positifs, et la direction projetée n\'aggrave aucune contrainte active', () => {
  const w = Float64Array.from([1, 2, 1, 3]);
  const g = Float64Array.from([-1, -2, -1, -0.5]);
  const c1 = { vec: Float64Array.from([1, 1, 0, 0]) }, c2 = { vec: Float64Array.from([0, 0, 1, 1]) };
  const nu = I.solveMultipliers([c1, c2], g, w);
  assert.ok(nu[0] >= 0 && nu[1] >= 0);
  const d = Float64Array.from(g, (x, j) => -w[j] * (x + nu[0] * c1.vec[j] + nu[1] * c2.vec[j]));
  const dot = (a, b) => a.reduce((s, x, j) => s + x * b[j], 0);
  assert.ok(Math.abs(dot(c1.vec, d)) < 1e-6 && Math.abs(dot(c2.vec, d)) < 1e-6, 'contraintes actives tenues au premier ordre');
  // une contrainte qui ne gêne pas (gradient dans l'autre sens) reçoit un multiplicateur nul
  const free = { vec: Float64Array.from([-1, -1, 0, 0]) };
  const nu2 = I.solveMultipliers([free], g, w);
  assert.equal(nu2[0], 0);
  assert.equal(I.solveMultipliers([], g, w).length, 0);
});

test('pas faisable : 90 % du pas maximal n\'écrête presque rien (W′ et fenêtres de la courbe record)', async () => {
  const prof = makeProfile(HILLY());
  const { course, setup, athlete } = setupFor(prof);
  const ctx0 = PYR.sim.createContext(course, setup, athlete, {});
  const ctx = Object.assign({}, ctx0, { gusts: null, longCap: true });
  const rctx = Object.assign({}, ctx, { capTot: Float64Array.of(1e9), nWin: 1, nWinShort: 1, longCap: false });
  const L = course.length, N = ctx.maxSteps + 2;
  const ds = 32 * L / 3500, sch = GR.makeSchedule(L, ds, () => 235), K = sch.K;
  const rec = I.makeRec(N), ws = I.makeWorkspace(N);
  I.simulate(ctx, sch, 0, rec);
  await I.prepare(ctx, rctx, rec, sch, ws, null);
  const gr = I.reduce(ctx, rec, ws);
  const d = Float64Array.from(gr.g, (x, j) => Math.max(-60, Math.min(60, -x * Math.max(sch.P[j], 80) ** 2 / Math.max(ws.tw[j], 1))));
  const r = I.maxFeasibleStep(ctx, rec, ws, d, new Set());
  assert.ok(r.alpha > 0 && isFinite(r.alpha) && r.limit, 'une contrainte borne le pas');
  const cand = { ds, K, P: Float64Array.from(sch.P, (p, j) => p + 0.9 * r.alpha * d[j]) };
  const out = I.simulate(ctx, cand, 0, I.makeRec(N));
  let clipped = 0, lost = 0;
  for (let t = 0; t < out.n; t++) if (!out.brk[t] && out.R[t] < out.cmd[t] - 0.5) { clipped++; lost += out.cmd[t] - out.R[t]; }
  assert.ok(clipped <= 3 && lost < 20, `${clipped} secondes écrêtées, ${lost.toFixed(1)} W perdus`);
  // au-delà du pas maximal, des secondes sont bien écrêtées
  const far = { ds, K, P: Float64Array.from(sch.P, (p, j) => p + 4 * r.alpha * d[j]) };
  const out2 = I.simulate(ctx, far, 0, I.makeRec(N));
  let clipped2 = 0;
  for (let t = 0; t < out2.n; t++) if (!out2.brk[t] && out2.R[t] < out2.cmd[t] - 0.5) clipped2++;
  assert.ok(clipped2 > clipped, `${clipped2} vs ${clipped}`);
});

test('gradient : plat — jamais plus lent que l\'allure constante, contraintes respectées', async () => {
  const { res, athlete } = await plan([{ len: 10000, grade: 0 }], 'gradient');
  assert.ok(res.tFinish <= res.baseline.time + 1e-6);
  assert.ok(['gradient', 'constant'].includes(res.strategy));
  assert.equal(res.algo, 'gradient');
  assertFeasible(res, athlete);
});

test('gradient : terrain ondulé — plus fort en montée, plus faible en descente, au moins 1 % plus rapide que la constante', async () => {
  const { res, course, athlete } = await plan(ROLLING(), 'gradient');
  assert.equal(res.strategy, 'gradient');
  assert.ok(res.tFinish < res.baseline.time * 0.99, `${res.tFinish} vs ${res.baseline.time}`);
  const up = avgPowerOnGrade(res, course, 0.02, 1), down = avgPowerOnGrade(res, course, -1, -0.02);
  assert.ok(up > down + 40, `montée ${up} / descente ${down}`);
  assertFeasible(res, athlete);
});

test('gradient : montée courte — le W′ est dépensé et le plan n\'est pas plus lent que l\'analytique', async () => {
  const analytic = await plan(SHORT_CLIMB(), 'analytic');
  const { res, athlete } = await plan(SHORT_CLIMB(), 'gradient');
  assert.ok(res.tFinish <= analytic.res.tFinish + 1, `${res.tFinish} vs ${analytic.res.tFinish}`);
  assertFeasible(res, athlete);
  const n = res.n;
  assert.ok(res.series.wbal[n] < 0.1 * res.w0, `W′ restant ${res.series.wbal[n]}`);
});

test('hybride : jamais plus lent que l\'analytique ni que le gradient seul, sur plusieurs parcours', async () => {
  for (const [name, segs] of [['vallonné', HILLY()], ['montée courte', SHORT_CLIMB()], ['ondulé', ROLLING()]]) {
    const a = await plan(segs, 'analytic'), g = await plan(segs, 'gradient'), h = await plan(segs, 'hybrid');
    assert.ok(h.res.tFinish <= a.res.tFinish + 1e-6, `${name} : hybride ${h.res.tFinish} > analytique ${a.res.tFinish}`);
    assert.ok(h.res.tFinish <= g.res.tFinish + 1e-6, `${name} : hybride ${h.res.tFinish} > gradient ${g.res.tFinish}`);
    assertFeasible(h.res, h.athlete);
    assert.ok(h.res.gradient.runs.length >= 1);
    assert.equal(h.res.gradient.runs.filter((r) => r.chosen).length, h.res.strategy === 'gradient' ? 1 : 0);
  }
});

test('gradient : cas limites — sprint, lacets, départ lancé, vent à rafales, pente très raide', async () => {
  const hairpins = [{ len: 2000, grade: 0 }];
  for (let i = 0; i < 4; i++) hairpins.push({ len: 400, grade: -0.08, turn: 180 });
  for (let i = 0; i < 4; i++) hairpins.push({ len: 400, grade: 0.08, turn: 180 });
  const gusty = { winds: [{ startKm: 0, endKm: 5, dir: 0, speed: 25, gusty: true, gust: 45 }, { startKm: 5, endKm: 10, dir: 180, speed: 25, gusty: true, gust: 45 }] };
  const cases = [
    ['sprint', [{ len: 400, grade: 0 }], {}],
    ['lacets', hairpins, {}],
    ['départ lancé', SHORT_CLIMB(), { v0: 8 }],
    ['vent à rafales', [{ len: 10000, grade: 0 }], { portions: gusty }],
    ['pente très raide', [{ len: 1500, grade: 0 }, { len: 1500, grade: 0.18 }, { len: 1500, grade: -0.1 }, { len: 1500, grade: 0 }], {}],
    ['marge de sécurité', SHORT_CLIMB(), { margin: 0.05 }],
  ];
  for (const [name, segs, extra] of cases) {
    const { res, athlete } = await plan(segs, 'gradient', extra);
    assert.ok(res.tFinish <= res.baseline.time + 1e-6, `${name} : ${res.tFinish} > constante ${res.baseline.time}`);
    assert.ok(res.stats.wbalMin >= -1, `${name} : W′ ${res.stats.wbalMin}`);
    assert.ok(worstWindowViolation(res.series.P, athlete, extra.margin || 0) <= 1e-6, `${name} : courbe record`);
    assert.ok(res.stats.enduranceUse <= 1.0015, `${name} : endurance ${res.stats.enduranceUse}`);
  }
});

test('gradient : déterministe, et le plan à la seconde reste lisse (pas de bruit de simulation)', async () => {
  const a = await plan(ROLLING(), 'gradient'), b = await plan(ROLLING(), 'gradient');
  assert.equal(a.res.tFinish, b.res.tFinish);
  assert.deepEqual(Array.from(a.res.series.P.slice(0, 500)), Array.from(b.res.series.P.slice(0, 500)));
  const P = a.res.series.P, n = a.res.n;
  let sum = 0, cnt = 0, max = 0;
  for (let t = 20; t < n - 1; t++) {
    if (a.res.series.brk[t] || a.res.series.brk[t - 1]) continue;
    const d = Math.abs(P[t] - P[t - 1]); sum += d; cnt++; if (d > max) max = d;
  }
  assert.ok(sum / cnt < 1.5, `variation moyenne ${sum / cnt} W/s`);
  assert.ok(max < 25, `variation max ${max} W/s`);
});

test('gradient : niveaux de raffinement du grossier au fin (échelle gagnante), résultat détaillé', async () => {
  const { res } = await plan(ROLLING(), 'gradient');
  const run = res.gradient.runs[0];
  assert.ok(GR.LADDERS.some((l) => JSON.stringify(l) === JSON.stringify(run.ladder)), 'échelle du portefeuille');
  assert.deepEqual(run.levels.map((l) => l.dt), run.ladder);
  assert.equal(run.from, 'constante');
  assert.ok(run.levels[0].nodes < run.levels[run.levels.length - 1].nodes);
  assert.ok(run.levels[0].gain > 10, 'le gros du gain vient du niveau grossier');
  assert.ok(run.time <= run.startTime);
  assert.ok(res.evaluations > 20);
  // les nœuds s'emboîtent d'un niveau au suivant : le temps ne remonte jamais en changeant de niveau
  for (let i = 1; i < run.levels.length; i++) assert.ok(run.levels[i].T <= run.levels[i - 1].T + 1e-3, `niveau ${run.levels[i].dt} s : ${run.levels[i].T} > ${run.levels[i - 1].T}`);
});

test('gradient : le portefeuille d\'échelles n\'est jamais moins bon que la première, et garde la meilleure', async () => {
  for (const segs of [SHORT_CLIMB(), ROLLING()]) {
    const { course, setup, athlete } = setupFor(makeProfile(segs));
    const ctx = PYR.sim.createContext(course, setup, athlete, {});
    const base = await PYR.optimizer.bestConstant(ctx, 0, PYR.optimizer.makeTicker());
    const init = { T: base.time, power: base.power };
    const single = await GR.solve(ctx, init, { v0: 0 });
    const pf = await GR.solvePortfolio(ctx, init, { v0: 0 });
    assert.ok(pf.ok && pf.runs.length === GR.LADDERS.length);
    assert.ok(pf.T <= single.T + 1e-9, `${pf.T} > ${single.T}`);
    assert.equal(pf.T, Math.min(...pf.runs.map((r) => r.T)));
    assert.ok(pf.u <= 1.0005 + 1e-9, `endurance ${pf.u}`);
    assert.ok(pf.evaluations >= single.evaluations);
  }
});

test('gradient : les niveaux qui auraient trop de nœuds sont sautés (très longues sorties)', async () => {
  const { course, setup, athlete } = setupFor(makeProfile(ROLLING()));
  const ctx = PYR.sim.createContext(course, setup, athlete, {});
  const base = await PYR.optimizer.bestConstant(ctx, 0, PYR.optimizer.makeTicker());
  const g = await GR.solve(ctx, { T: base.time, power: base.power }, { v0: 0, maxKnots: 800 });
  assert.ok(g.ok);
  assert.deepEqual(g.levels.map((l) => l.dt), [32, 16, 8]);
  assert.ok(g.levels.every((l) => l.nodes <= 800));
  assert.ok(g.T < base.time * 0.99);
  // même un plafond ridicule garde le niveau le plus grossier
  const coarse = await GR.solve(ctx, { T: base.time, power: base.power }, { v0: 0, maxKnots: 5 });
  assert.ok(coarse.ok);
  assert.deepEqual(coarse.levels.map((l) => l.dt), [32]);
});

test('optimiseur : sans « algo », comportement inchangé (analytique)', async () => {
  const { res } = await plan([{ len: 10000, grade: 0 }, { len: 3000, grade: 0.05 }, { len: 3000, grade: -0.05 }, { len: 4000, grade: 0 }], undefined);
  assert.equal(res.algo, 'analytic');
  assert.equal(res.gradient, null);
  assert.ok(['optimal', 'constant'].includes(res.strategy));
  assert.ok(Number.isFinite(res.lam));
});
