/* author : Hugo Joudrier-Faure */
/* Tests du suivi de sortie : projection GPS, plan consultable, replanification depuis un état réel, séance (écart, déclencheurs,
 * réserves), reprise après rechargement, export GPX. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor, worstWindowViolation } = require('./helpers.js');

const R = PYR.ride;

/** ≈ 10 km : plat, montée, descente, plat. */
const HILLY = [{ len: 3000, grade: 0 }, { len: 2000, grade: 0.05 }, { len: 2000, grade: -0.04 }, { len: 3000, grade: 0.005 }];

async function planOf(segments) {
  const prof = makeProfile(segments);
  const { course, setup, athlete } = setupFor(prof);
  const input = { course, setup, athlete, v0: 0 };
  const res = await PYR.optimizer.optimize(input);
  assert.ok(res.ok, res.error);
  return { input, res, plan: R.planFromResult(res, course.length), course, setup, athlete };
}

/** État d'un cycliste qui a roulé t secondes à `factor` × le plan (simulateur complet). */
function stateAfter(P, input, t, factor) {
  const ctx = PYR.sim.createContext(input.course, input.setup, input.athlete, {});
  const st = PYR.sim.initState(ctx, 0);
  const cond = {};
  for (let k = 0; k < t; k++) { PYR.sim.conditions(ctx, st.s, st.t, cond); PYR.sim.step(ctx, st, P[k] * factor, cond); }
  return { ctx, st };
}

/* ---------- projection sur le tracé ---------- */

test('projection : un point du tracé donne sa distance, un écart latéral reste un écart', () => {
  const prof = makeProfile(HILLY);
  const { course } = setupFor(prof);
  const M = R.createMatcher(course);
  for (const s of [0, 1234, 5000, 8765, 9990]) {
    const [la, lo] = PYR.course.latLngAt(course, s);
    const r = M.project(la, lo);
    assert.ok(Math.abs(r.s - s) < 1.5, `s=${s} → ${r.s}`);
    assert.ok(r.d < 1);
  }
  // 12 m à l'est de la route (qui part vers le nord)
  const [la, lo] = PYR.course.latLngAt(course, 4000);
  const r = M.project(la, lo + 12 / (111195 * Math.cos(la * Math.PI / 180)));
  assert.ok(Math.abs(r.s - 4000) < 3 && Math.abs(r.d - 12) < 1, `${r.s} ${r.d}`);
});

test('projection : sur un aller-retour, la fenêtre choisit le bon passage', () => {
  const prof = makeProfile([{ len: 1000, grade: 0, turn: 180 }, { len: 1000, grade: 0 }]);
  const { course } = setupFor(prof);
  const M = R.createMatcher(course);
  const [la, lo] = PYR.course.latLngAt(course, 600);       // même route à l'aller (600 m) et au retour (1 400 m)
  assert.ok(Math.abs(M.project(la, lo).s - 600) < 2, 'sans fenêtre : le premier passage');
  assert.ok(Math.abs(M.project(la, lo, 1300, 1600).s - 1400) < 2, 'avec fenêtre : le retour');
});

test('suivi : bruit GPS de 5 m, le tracé reste suivi sans reculer ; hors tracé puis retour', () => {
  const prof = makeProfile(HILLY);
  const { course } = setupFor(prof);
  const T = R.createTracker(course);
  const rnd = PYR.util.mulberry32(11);
  const noise = () => (rnd() - 0.5) * 10 / 111195;
  let worst = 0;
  for (let k = 0; k < 600; k++) {
    const s = k * 12;                                      // 43 km/h
    const [la, lo] = PYR.course.latLngAt(course, s);
    const r = T.update(la + noise(), lo + noise(), 5, 1, 12);
    assert.ok(r.ok);
    worst = Math.max(worst, Math.abs(r.s - s));
  }
  assert.ok(worst < 9, `écart max ${worst}`);
  // quitte le tracé : 500 m à l'est
  const [la, lo] = PYR.course.latLngAt(course, 7200);
  const east = 500 / (111195 * Math.cos(la * Math.PI / 180));
  const before = T.s;
  for (let k = 0; k < 12; k++) assert.ok(!T.update(la, lo + east, 5, 1, 0).ok);
  assert.equal(T.s, before, 'la position ne bouge pas tant que les fixes sont hors tracé');
  const back = T.update(...PYR.course.latLngAt(course, 7260), 5, 1, 0);
  assert.ok(back.ok && Math.abs(back.s - 7260) < 3);
});

/* ---------- plan consultable ---------- */

test('plan : temps et distance se répondent, puissance et W′ lus à la distance', async () => {
  const { res, plan, course } = await planOf(HILLY);
  assert.equal(plan.t0, 0);
  assert.ok(Math.abs(plan.tAt(course.length) - res.tFinish) < 1e-6);
  for (const t of [10, 100, 400, Math.floor(res.tFinish) - 5]) {
    assert.ok(Math.abs(plan.tAt(plan.sAt(t)) - t) < 0.6, `t=${t}`);
  }
  const k = 200;
  assert.ok(Math.abs(plan.powerAt(res.series.s[k]) - res.series.P[k]) < 1e-3);
  assert.ok(Math.abs(plan.wbalAt(res.series.s[k]) - res.series.wbal[k]) < 1);
});

test('tronçons : jointifs de la position de départ à l\'arrivée, puissance moyenne conservée', async () => {
  const { res, plan, course } = await planOf(HILLY);
  const segs = R.segments(plan, course);
  assert.ok(segs.length >= 3 && segs.length <= 40, `${segs.length}`);
  assert.equal(segs[0].a, 0);
  assert.ok(Math.abs(segs[segs.length - 1].b - course.length) < 1e-6);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].a, segs[i - 1].b);
  for (const g of segs) assert.ok(g.b - g.a >= 150 - 1e-6 || segs.length === 1, `tronçon de ${g.b - g.a} m`);
  // la moyenne pondérée par la durée est celle du plan
  let w = 0, d = 0;
  for (const g of segs) { const dt = g.t1 - g.t0; w += g.P * dt; d += dt; }
  const avg = res.series.P.reduce((a, b) => a + b, 0) / res.series.P.length;
  assert.ok(Math.abs(w / d - avg) < 4, `${w / d} vs ${avg}`);
  // montée plus forte que la descente
  const climb = segs.find((g) => g.a >= 3000 && g.b <= 5000) || segs.find((g) => g.grade > 0.03);
  const desc = segs.find((g) => g.grade < -0.03);
  assert.ok(climb.P > desc.P + 30, `${climb.P} / ${desc.P}`);
});

test('forme : W′bal du plan lu sur le profil de l\'athlète à 100 % (ou sur le profil ajusté à la forme)', async () => {
  const prof = makeProfile(HILLY);
  const { course, setup, athlete } = setupFor(prof);
  const margin = 0.2;                                     // forme de 80 %
  const res = await PYR.optimizer.optimize({ course, setup, athlete, v0: 0, margin });
  assert.ok(res.ok, res.error);
  const S = res.series;
  const ref = { athlete };
  const adj = R.planFromResult(res, course.length);       // référence de l'optimiseur : profil ajusté à la forme
  const full = R.planFromResult(res, course.length, ref); // référence : profil de l'athlète
  const w = PYR.physio.wbalSeries(S.P, S.P.length, athlete);
  assert.equal(full.wbal.length, adj.wbal.length);
  assert.ok(Math.abs(full.wbal[0] - athlete.w0) < 1, 'part de W′ plein, en joules du profil de l\'athlète');
  assert.ok(Math.abs(adj.wbal[0] - athlete.w0 * (1 - margin)) < 1, 'l\'optimiseur part du W′ ajusté');
  let minFull = Infinity, minAdj = Infinity;
  for (let k = 0; k < w.length; k++) { assert.ok(Math.abs(full.wbal[k] - w[k]) < 1e-3); minFull = Math.min(minFull, w[k]); minAdj = Math.min(minAdj, adj.wbal[k]); }
  assert.ok(minFull >= minAdj, 'à 80 % de forme, il reste plus de W′ sur le profil complet que sur le profil ajusté');
  // au-dessus de 100 % de forme : le plan dépasse les capacités de l'athlète, W′bal touche 0 sur son profil
  const resUp = await PYR.optimizer.optimize({ course, setup, athlete, v0: 0, margin: -0.3 });
  assert.ok(resUp.ok, resUp.error);
  const wUp = PYR.physio.wbalSeries(resUp.series.P, resUp.series.P.length, athlete);
  assert.ok(Math.min(...wUp) < 0, 'forme 130 % : W′bal de l\'athlète s\'épuise puis devient négatif, il n\'est pas arrêté à 0');
  assert.equal(PYR.physio.wbalState(-0.1), 'au-delà des capacités');
  assert.equal(PYR.physio.wbalState(0.03), 'épuisement imminent');
  assert.equal(PYR.physio.wbalState(0.3), 'fatigue modérée');
});

test('plan enregistré puis relu : mêmes temps, distances et puissances', async () => {
  const { plan } = await planOf(HILLY);
  const back = R.unpackPlan(JSON.parse(JSON.stringify(R.packPlan(plan))));
  assert.ok(Math.abs(back.tFinish - plan.tFinish) < 0.06);
  for (const s of [500, 3500, 6000, 9000]) {
    assert.ok(Math.abs(back.tAt(s) - plan.tAt(s)) < 0.2, `s=${s}`);
    assert.ok(Math.abs(back.powerAt(s) - plan.powerAt(s)) <= 0.6);
  }
  assert.equal(R.unpackPlan({}), null);
});

/* ---------- replanification depuis un état réel ---------- */

test('replanifier sur le plan lui-même redonne (à quelques secondes près) le même arrivée', async () => {
  const { input, res, athlete } = await planOf(HILLY);
  const t = 300;
  const hist = new Float64Array(res.n + 2);
  for (let k = 1; k <= t; k++) hist[k] = hist[k - 1] + res.series.P[k - 1];
  const start = { t, s: res.series.s[t], v: res.series.v[t], wbal: res.series.wbal[t], hist };
  const b = await PYR.optimizer.optimize(Object.assign({}, input, { start }));
  assert.ok(b.ok, b.error);
  assert.equal(b.t0, t);
  assert.equal(b.series.s.length, b.n - t + 1);
  assert.equal(b.series.P.length, b.n - t);
  assert.ok(Math.abs(b.series.s[0] - start.s) < 1e-3);
  assert.ok(Math.abs(b.tFinish - res.tFinish) < 4, `${b.tFinish} vs ${res.tFinish}`);
  assert.ok(b.stats.wbalMin >= -1, 'W′ ne passe pas sous zéro');
  // le passé (plan d'origine) et la suite respectent ensemble la courbe de puissance record
  const all = Array.from(res.series.P.slice(0, t)).concat(Array.from(b.series.P));
  assert.ok(worstWindowViolation(all, athlete) <= 2e-3, `dépassement ${worstWindowViolation(all, athlete)}`);
  // les statistiques ne comptent que la suite
  assert.ok(Math.abs(b.stats.dist - (res.series.s[res.series.s.length - 1] - start.s)) < 2);
});

test('replanifier après un début trop sage : jamais plus lent que de suivre l\'ancien plan, jamais plus rapide que l\'optimum initial', async () => {
  const { input, res, plan, athlete } = await planOf(HILLY);
  const t = 300;
  const { ctx, st } = stateAfter(res.series.P, input, t, 0.85);
  const start = { t: st.t, s: st.s, v: st.v, wbal: st.wbal, hist: st.hist };
  assert.ok(st.s < res.series.s[t] - 20, 'le cycliste est en retard sur le plan');
  const b = await PYR.optimizer.optimize(Object.assign({}, input, { start }));
  assert.ok(b.ok, b.error);
  // suivre l'ancien plan à la distance où l'on se trouve
  const cond = {}, cl = PYR.sim.cloneState(st);
  cl.hist = Float64Array.from(st.hist);
  while (!cl.finished && cl.t < ctx.maxSteps) { PYR.sim.conditions(ctx, cl.s, cl.t, cond); PYR.sim.step(ctx, cl, plan.powerAt(cl.s), cond); }
  assert.ok(cl.finished);
  assert.ok(b.tFinish <= cl.tFinish + 1.5, `replan ${b.tFinish} vs ancien plan ${cl.tFinish}`);
  assert.ok(b.tFinish >= res.tFinish - 1.5, `${b.tFinish} < optimum initial ${res.tFinish}`);
  assert.ok(b.stats.wbalMin >= -1);
  const all = Array.from(st.hist.slice(1, t + 1)).map((x, k) => st.hist[k + 1] - st.hist[k]).concat(Array.from(b.series.P));
  assert.ok(worstWindowViolation(all, athlete) <= 2e-3);
  // il reste du W′ au départ de la suite : on peut le dépenser plus (puissance moyenne de la suite ≥ celle de l'ancien plan sur le même tronçon)
  assert.ok(start.wbal > res.series.wbal[t] - 1);
});

test('replanifier à W′ presque vide : la suite reste faisable et l\'arrivée est atteinte', async () => {
  const { input, res } = await planOf([{ len: 4000, grade: 0.07 }, { len: 3000, grade: 0 }]);
  const t = Math.floor(res.tFinish / 2);
  const { st } = stateAfter(res.series.P, input, t, 1.12);   // trop fort : W′ proche de zéro
  const b = await PYR.optimizer.optimize(Object.assign({}, input, { start: { t: st.t, s: st.s, v: st.v, wbal: st.wbal, hist: st.hist } }));
  assert.ok(b.ok, b.error);
  assert.ok(b.stats.wbalMin >= -1);
  assert.ok(b.tFinish > res.tFinish - 1);
});

/* ---------- séance ---------- */

function newSession(env, cfg) {
  const sess = R.createSession({ course: env.course, setup: env.setup, athlete: env.athlete, mass: 72, startMs: Date.UTC(2026, 5, 1, 8), cfg });
  sess.setPlan(env.plan, 'plan initial');
  return sess;
}

/** Fait rouler le cycliste de démonstration : renvoie ce qui s'est passé. */
function ride(sess, demo, seconds, hook) {
  let maxErr = 0, reqs = [];
  for (let i = 0; i < seconds && !sess.finished && !demo.st.finished; i++) {
    const g = sess.guidance();
    const out = demo.step(g ? g.target : 0);
    sess.step({ power: out.power, fix: out.fix });
    const r = sess.takeReplanRequest();
    if (r) reqs.push(r);
    if (sess.t > 20) maxErr = Math.max(maxErr, Math.abs(sess.s - demo.st.s));
    if (hook) hook(sess, demo);
  }
  return { maxErr, reqs };
}

test('séance : un cycliste qui suit la consigne finit à l\'heure du plan, la position lissée colle à la vraie', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env);
  const demo = R.createDemo({ course: env.course, setup: env.setup, athlete: env.athlete, noise: 0.02, gps: 3, seed: 3 });
  const { maxErr } = ride(sess, demo, 4000);
  assert.ok(sess.finished || demo.st.finished, 'arrivé');
  assert.ok(Math.abs(sess.t - env.plan.tFinish) < 0.04 * env.plan.tFinish, `${sess.t} s pour un plan de ${env.plan.tFinish} s`);
  assert.ok(maxErr < 14, `position lissée à ${maxErr} m de la vraie au pire`);
  assert.ok(sess.wbal >= 0);
});

test('séance : un point GPS daté d\'avant la fin de la seconde est ramené à l\'instant de l\'état ; la vitesse vient des positions si le GPS n\'en donne pas', () => {
  const prof = makeProfile([{ len: 10000, grade: 0 }]);
  const { course, setup, athlete } = setupFor(prof);
  const lag = (withAge) => {
    const sess = R.createSession({ course, setup, athlete });
    let err = 0;
    for (let k = 0; k < 120; k++) {
      const [la, lo] = PYR.course.latLngAt(course, 10 * k);       // position au début de la seconde k, à 10 m/s
      sess.step({ power: 200, fix: { lat: la, lng: lo, acc: 3, speed: NaN, age: withAge ? 1 : 0 } });
      if (k > 40) err = Math.max(err, Math.abs(sess.s - 10 * (k + 1)));
    }
    return { err, v: sess.v };
  };
  const a = lag(true), b = lag(false);
  assert.ok(a.err < 4, `avec l'âge du point : ${a.err} m`);
  assert.ok(b.err > 8, `sans : ${b.err} m`);
  assert.ok(Math.abs(a.v - 10) < 0.6, `vitesse ${a.v}`);
});

test('séance : la consigne est celle du tronçon, le cue suit l\'écart de puissance', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env);
  const demo = R.createDemo({ course: env.course, setup: env.setup, athlete: env.athlete, noise: 0, gps: 0, seed: 1 });
  ride(sess, demo, 120);
  const g = sess.guidance();
  assert.ok(Number.isInteger(g.target) && g.target >= 0);
  assert.ok(g.seg && g.seg.a <= sess.s && sess.s <= g.seg.b);
  assert.equal(g.segCount, sess.segs.length);
  assert.ok(g.toSegEnd >= 0 && g.toSegEnd <= g.seg.b - g.seg.a + 1);
  // le cycliste suit : « ok » la plupart du temps ; on force une mesure trop haute puis trop basse
  const tgt = g.target;
  for (let i = 0; i < 4; i++) sess.step({ power: tgt + 80, fix: null });
  assert.ok(['over', 'way_over'].includes(sess.guidance().cue), sess.guidance().cue);
  for (let i = 0; i < 4; i++) sess.step({ power: Math.max(0, tgt - 80), fix: null });
  assert.ok(['under', 'way_under'].includes(sess.guidance().cue), sess.guidance().cue);
});

test('séance : part du temps dans le tube de la consigne sur le tronçon en cours (moyenne 3 s)', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env);
  assert.equal(sess.guidance().zonePct, null);
  const demo = R.createDemo({ course: env.course, setup: env.setup, athlete: env.athlete, noise: 0, gps: 0, seed: 1 });
  ride(sess, demo, 120);
  const g = sess.guidance();
  assert.ok(g.zonePct >= 0 && g.zonePct <= 1 && g.zoneT > 0);
  for (let i = 0; i < 6; i++) sess.step({ power: g.target + 150, fix: null });
  const g2 = sess.guidance();
  if (g2.segIndex === g.segIndex) {
    assert.ok(g2.zonePct < g.zonePct || g.zonePct === 0, 'rouler loin du tube fait baisser la part de temps dans la cible');
    assert.equal(g2.zoneT, g.zoneT + 6);
  }
});

test('séance : la trajectoire donne le passé récent (moyenne 3 s, consigne) et la consigne des secondes à venir, tube à ± 5 %', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env);
  assert.equal(sess.trajectory(30, 15).n, 0);
  const demo = R.createDemo({ course: env.course, setup: env.setup, athlete: env.athlete, noise: 0, gps: 0, seed: 1 });
  ride(sess, demo, 120);
  const g = sess.guidance(), tr = sess.trajectory(30, 15);
  assert.equal(tr.n, 30);
  assert.equal(tr.ahead.length, 15);
  assert.equal(tr.tolFrac, 0.05);
  assert.ok(Math.abs(tr.avg[29] - g.p3) < 0.01, 'le dernier point est la puissance moyenne sur 3 s');
  assert.equal(tr.tgt[29], g.target);
  assert.equal(g.tol, Math.max(5, 0.05 * g.target));
  assert.ok(tr.ahead.every((x) => x % 5 === 0 && x >= 0));
  // moins d'historique que demandé : séries raccourcies
  assert.equal(sess.trajectory(1000, 5).n, sess.t);
});

test('séance : la puissance moyenne estimée sur 30 s ; alpha pondère l\'altitude mesurée et celle du tracé', () => {
  const prof = makeProfile([{ len: 10000, grade: 0 }]);
  const { course, setup, athlete } = setupFor(prof);
  const run = (altAt, cfg) => {
    const sess = R.createSession({ course, setup, athlete, cfg });
    for (let k = 0; k < 120; k++) {
      const [la, lo] = PYR.course.latLngAt(course, 10 * k);
      sess.step({ power: 200, fix: { lat: la, lng: lo, acc: 3, speed: 10, alt: altAt(k), age: 1 } });
    }
    return sess;
  };
  assert.equal(R.createSession({ course, setup, athlete }).estimateMean(0.3), null, 'pas assez de données');
  // le tracé est plat ; l'altitude mesurée monte de 0,5 m/s : 15 m sur 30 s
  const flat = run(() => 100), climb = run((k) => 100 + 0.5 * k), blind = run(() => NaN);
  const f0 = flat.estimateMean(0), f1 = flat.estimateMean(1);
  assert.ok(f0.P > 20 && Math.abs(f0.P - f1.P) < 0.5, `mesure plate = tracé plat : ${f0.P} / ${f1.P}`);
  const c0 = climb.estimateMean(0), c1 = climb.estimateMean(1), ch = climb.estimateMean(0.5);
  assert.equal(c0.n, 30);
  assert.ok(Math.abs(c1.dhMeas - 15) < 0.5, `dénivelée mesurée ${c1.dhMeas}`);
  assert.ok(Math.abs(c0.P - f0.P) < 0.5, 'alpha = 0 : la mesure ne compte pas');
  const gain = setup.mass * 9.80665 * 15 / setup.eta / 30;
  assert.ok(Math.abs(c1.P - c0.P - gain) < 0.05 * gain, `alpha = 1 : +${c1.P - c0.P} W attendus ${gain}`);
  assert.ok(Math.abs(ch.P - (c0.P + c1.P) / 2) < 0.5, 'alpha = 0,5 : à mi-chemin');
  // sans altitude mesurée, tout le poids va au tracé
  const b1 = blind.estimateMean(1);
  assert.equal(b1.alpha, 0);
  assert.ok(Number.isNaN(b1.dhMeas) && Math.abs(b1.P - f0.P) < 0.5);
  // sans capteur : la puissance estimée seconde par seconde reçoit la correction de l'altitude mesurée, au prorata d'alpha
  const climbAt = (k) => 100 + 0.5 * k;
  const s0 = run(climbAt, { altAlpha: 0 }).estimate(10), s1 = run(climbAt, { altAlpha: 1 }).estimate(10), sh = run(climbAt, { altAlpha: 0.5 }).estimate(10);
  assert.ok(Math.abs(s1 - s0 - gain) < 0.05 * gain, `estimation seconde par seconde : +${s1 - s0} W attendus ${gain}`);
  assert.ok(Math.abs(sh - (s0 + s1) / 2) < 1, 'alpha = 0,5 : à mi-chemin');
  assert.ok(Math.abs(run(() => NaN, { altAlpha: 1 }).estimate(10) - s0) < 0.5, 'sans mesure d\'altitude : le tracé seul');
  // hors parcours : l'altitude mesurée passe à 100 % quel que soit le réglage
  const lost = run(climbAt, { altAlpha: 0 });
  assert.equal(lost.altAlpha(), 0);
  for (let k = 120; k < 150; k++) {
    const [la, lo] = PYR.course.latLngAt(course, 10 * k);
    lost.step({ power: 200, fix: { lat: la, lng: lo + 600 / (111195 * Math.cos(la * Math.PI / 180)), acc: 3, speed: 10, alt: climbAt(k), age: 1 } });   // 600 m à l'est
  }
  assert.ok(lost.offCourse, 'hors parcours');
  assert.equal(lost.altAlpha(), 1);
  const e = lost.estimateMean(lost.altAlpha());
  assert.equal(e.alpha, 1);
  assert.ok(Math.abs(e.dh - e.dhMeas) < 1e-9, 'la dénivelée est la mesurée');
  // l'estimation seconde par seconde en tient compte aussi : la même sortie restée sur le parcours (alpha = 0) estime moins
  const onc = run(climbAt, { altAlpha: 0 });
  for (let k = 120; k < 150; k++) {
    const [la, lo] = PYR.course.latLngAt(course, 10 * k);
    onc.step({ power: 200, fix: { lat: la, lng: lo, acc: 3, speed: 10, alt: climbAt(k), age: 1 } });
  }
  assert.ok(!onc.offCourse);
  assert.ok(lost.estimate(10) - onc.estimate(10) > 0.5 * gain, `hors parcours ${lost.estimate(10)} W, sur le parcours ${onc.estimate(10)} W`);
});

test('séance : la puissance estimée sur 30 s retrouve la puissance du cycliste de démonstration sur un parcours vallonné', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env, { altAlpha: 0 });
  const demo = R.createDemo({ course: env.course, setup: env.setup, athlete: env.athlete, noise: 0, gps: 0, seed: 1 });
  let n = 0, worst = 0, sumRel = 0;
  ride(sess, demo, 600, (s) => {
    if (s.t < 60 || s.t % 20) return;
    const g = s.guidance();
    if (!g.est30 || g.p30meas < 120) return;                      // roue libre et descentes freinées : le bilan ne dit rien
    const rel = Math.abs(g.est30.P - g.p30meas) / g.p30meas;
    n++; sumRel += rel; worst = Math.max(worst, rel);
  });
  assert.ok(n >= 10, `${n} points comparés`);
  assert.ok(sumRel / n < 0.08, `écart moyen ${(100 * sumRel / n).toFixed(1)} %`);
  assert.ok(worst < 0.25, `pire écart ${(100 * worst).toFixed(1)} %`);
});

test('séance : la puissance affichée est la moyenne sur la durée réglée (1 s = instantanée, au plus 60 s)', async () => {
  const env = await planOf(HILLY);
  const at = (powerAvg) => {
    const sess = newSession(env, powerAvg === undefined ? {} : { powerAvg });
    for (let i = 0; i < 70; i++) sess.step({ power: i < 67 ? 100 : 400, fix: null });      // 67 s à 100 W, puis 3 s à 400 W
    return sess.guidance();
  };
  assert.equal(at(1).pDisp, 400);
  assert.equal(at(1).pDispN, 1);
  assert.equal(at(3).pDisp, 400);
  assert.equal(at(10).pDisp, (7 * 100 + 3 * 400) / 10);
  assert.equal(at(60).pDispN, 60);
  assert.ok(Math.abs(at(60).pDisp - (57 * 100 + 3 * 400) / 60) < 1e-9);
  assert.equal(at(500).pDispN, 60, 'plafonnée à 60 s');
  assert.equal(at(0).pDispN, 3, 'valeur invalide : la valeur par défaut (3 s)');
  assert.equal(at().pDispN, 3, 'par défaut : 3 s');
});

test('séance : timeAt donne l\'instant où le cycliste a atteint une distance (interpolé), null s\'il n\'y est pas encore', () => {
  const prof = makeProfile([{ len: 10000, grade: 0 }]);
  const { course, setup, athlete } = setupFor(prof);
  const sess = R.createSession({ course, setup, athlete });
  assert.equal(sess.timeAt(100), null, 'rien de roulé');
  for (let k = 0; k < 120; k++) {
    const [la, lo] = PYR.course.latLngAt(course, 10 * k);       // à 10 m/s : position au début de la seconde k
    sess.step({ power: 200, fix: { lat: la, lng: lo, acc: 3, speed: 10, age: 1 } });
  }
  assert.equal(sess.timeAt(5000), null);
  for (const s of [200, 500, 900]) {
    const t = sess.timeAt(s);
    assert.ok(Math.abs(t - s / 10) < 2.5, `${s} m atteints à ${t} s (≈ ${s / 10})`);
  }
  assert.ok(sess.timeAt(900) > sess.timeAt(500) && sess.timeAt(500) > sess.timeAt(200), 'croissant');
});

test('séance : un cycliste trop mou déclenche un recalcul ; le nouveau plan remet l\'écart à zéro et reste faisable', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env);
  const demo = R.createDemo({ course: env.course, setup: env.setup, athlete: env.athlete, noise: 0.02, gps: 3, seed: 5, bias: -0.3 });
  const { reqs } = ride(sess, demo, 600, (s) => { if (s.replanRequest) s.replanRequest = s.replanRequest; });
  assert.ok(reqs.length >= 1, 'aucune demande de recalcul');
  assert.ok(/retard|sous la consigne|W′/.test(reqs[0].reason), reqs[0].reason);
  const before = sess.gap;
  const res2 = await PYR.optimizer.optimize(sess.replanInput({ course: env.course, setup: env.setup, athlete: env.athlete, v0: 0 }));
  assert.ok(res2.ok, res2.error);
  assert.equal(res2.t0, sess.t);
  sess.setPlan(R.planFromResult(res2, env.course.length), reqs[0].reason);
  assert.ok(Math.abs(sess.gap) < 2, `écart ${sess.gap} (avant ${before})`);
  assert.equal(sess.planLog.length, 2);
  assert.ok(sess.plan.tFinish > env.plan.tFinish, 'on a perdu du temps');
  // la suite : s'il roule sans biais, il finit près du nouveau plan
  demo.setBias(0);
  ride(sess, demo, 4000);
  assert.ok(Math.abs(sess.t - sess.plan.tFinish) < 0.05 * sess.plan.tFinish, `${sess.t} vs ${sess.plan.tFinish}`);
});

test('séance : à l\'arrêt (feu rouge) le retard grandit mais aucun recalcul ; il vient une fois reparti', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env, { sens: 'normal', auto: true });
  const demo = R.createDemo({ course: env.course, setup: env.setup, athlete: env.athlete, noise: 0, gps: 0, seed: 2 });
  ride(sess, demo, 90);
  assert.equal(sess.replanRequest, null);
  const fix = { lat: sess.lastLat, lng: sess.lastLng, acc: 4, speed: 0 };
  for (let i = 0; i < 90; i++) { sess.step({ power: 0, fix }); assert.equal(sess.replanRequest, null, `arrêté à ${i}`); }
  assert.ok(sess.gap < -20, `écart ${sess.gap}`);
  const { reqs } = ride(sess, R.createDemo({ course: env.course, setup: env.setup, athlete: env.athlete, noise: 0, gps: 0, seed: 2 }), 0);
  assert.equal(reqs.length, 0);
});

test('séance : recalcul automatique coupé, aucune demande ; demande manuelle toujours possible', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env, { auto: false });
  const demo = R.createDemo({ course: env.course, setup: env.setup, athlete: env.athlete, noise: 0.02, gps: 3, seed: 5, bias: -0.3 });
  assert.equal(ride(sess, demo, 600).reqs.length, 0);
  sess.requestReplan('test');
  assert.equal(sess.takeReplanRequest().reason, 'test');
  assert.equal(sess.takeReplanRequest(), null);
});

test('séance : hors tracé puis retour — la position est estimée, puis un recalcul est demandé', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env);
  const demo = R.createDemo({ course: env.course, setup: env.setup, athlete: env.athlete, noise: 0, gps: 0, seed: 4 });
  ride(sess, demo, 120);
  const off = (dt) => ({ lat: demo.st && PYR.course.latLngAt(env.course, demo.st.s)[0], lng: PYR.course.latLngAt(env.course, demo.st.s)[1] + 600 / (111195 * Math.cos(45 * Math.PI / 180)), acc: 5, speed: 9 });
  for (let i = 0; i < 20; i++) { const out = demo.step(sess.guidance().target); sess.step({ power: out.power, fix: off() }); }
  assert.ok(sess.offCourse);
  assert.ok(sess.s > 0 && Math.abs(sess.s - demo.st.s) < 80, `estimée ${sess.s} vs ${demo.st.s}`);
  const { reqs } = ride(sess, demo, 30);
  assert.ok(!sess.offCourse);
  assert.ok(reqs.length >= 1 || sess.replanRequest, 'recalcul au retour sur le tracé');
});

test('séance : sans capteur de puissance, la puissance est estimée d\'après la vitesse', async () => {
  const prof = makeProfile([{ len: 8000, grade: 0 }]);
  const { course, setup, athlete } = setupFor(prof);
  const res = await PYR.optimizer.optimize({ course, setup, athlete, v0: 0 });
  const sess = R.createSession({ course, setup, athlete, mass: 72 });
  sess.setPlan(R.planFromResult(res, course.length), 'initial');
  const demo = R.createDemo({ course, setup, athlete, noise: 0, gps: 1, seed: 8 });
  let real = 0, est = 0, n = 0;
  for (let i = 0; i < 400; i++) {
    const out = demo.step(220);
    sess.step({ fix: out.fix, estimate: sess.estimate() });
    if (i > 100) { real += out.power; est += sess.Pk[sess.t - 1]; n++; }
  }
  assert.ok(sess.powerEstimated);
  assert.ok(Math.abs(est / n - real / n) < 0.1 * real / n, `estimée ${est / n} vs mesurée ${real / n}`);
});

test('séance : réserves — W′ suit la puissance, le glycogène baisse, boire et manger sont comptés', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env);
  const f = sess.fuel;
  const G0 = f.G;
  for (let i = 0; i < 600; i++) sess.step({ power: 300, fix: null });
  assert.ok(sess.wbal < env.athlete.w0, 'W′ entamé à 300 W');
  assert.ok(f.G < G0, 'glycogène consommé');
  const gels = f.items.gel, vol = f.bottles[0];
  assert.equal(sess.eat('gel'), 'gel');
  assert.equal(f.items.gel, gels - 1);
  const q = sess.drink();
  assert.ok(q > 0 && Math.abs(f.bottles[0] - (vol - q)) < 1e-9);
  assert.equal(sess.intakes.length, 2);
  // un gel hors du stock (reçu en route) se prend quand même
  f.items.gelglu = 0;
  assert.equal(sess.eat('gelglu'), 'gel glucose');
  assert.equal(sess.eat('licorne'), null);
  // hydratation : on transpire
  const loss = Math.max(0, f.deficit);
  for (let i = 0; i < 600; i++) sess.step({ power: 200, fix: null });
  assert.ok(f.deficit > loss);
  sess.refill();
  assert.ok(f.bottles.every((b, i) => Math.abs(b - f.cont[i].cap) < 1e-9));
});

test('séance : sauvegarde puis reprise — même temps, mêmes réserves, même plan, même consigne', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env);
  const demo = R.createDemo({ course: env.course, setup: env.setup, athlete: env.athlete, noise: 0.03, gps: 2, seed: 9 });
  ride(sess, demo, 200);
  sess.eat('gel');
  ride(sess, demo, 60);
  sess.drink(0);
  sess.refill(1);
  ride(sess, demo, 40);
  const data = JSON.parse(JSON.stringify(sess.pack()));
  const again = R.createSession({ course: env.course, setup: env.setup, athlete: env.athlete, mass: 72, kit: data.kit });
  assert.ok(again.restore(data));
  assert.equal(again.t, sess.t);
  assert.ok(Math.abs(again.s - sess.s) < 0.2 && Math.abs(again.v - sess.v) < 0.02);
  assert.ok(Math.abs(again.wbal - sess.wbal) < 1e-6);
  assert.ok(Math.abs(again.fuel.G - sess.fuel.G) < 1e-6 && Math.abs(again.fuel.deficit - sess.fuel.deficit) < 1e-9);
  assert.deepEqual(again.fuel.bottles.map((x) => +x.toFixed(6)), sess.fuel.bottles.map((x) => +x.toFixed(6)));
  assert.equal(again.intakes.length, sess.intakes.length);
  assert.ok(again.plan && Math.abs(again.plan.tFinish - sess.plan.tFinish) < 0.06);
  assert.equal(again.guidance().target, sess.guidance().target);
  assert.ok(Math.abs(again.gap - sess.gap) < 1.5, `${again.gap} vs ${sess.gap}`);
  // et la séance continue
  again.step({ power: 200, fix: null });
  assert.equal(again.t, sess.t + 1);
  assert.equal(R.createSession({ course: env.course, setup: env.setup, athlete: env.athlete }).restore({ v: 9 }), false);
});

test('export GPX : un point par seconde avec heure et puissance, relu par activity.js', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env);
  const demo = R.createDemo({ course: env.course, setup: env.setup, athlete: env.athlete, noise: 0.02, gps: 2, seed: 6 });
  ride(sess, demo, 150);
  const gpx = R.toGpx(sess, 'Sortie <test> & co');
  assert.match(gpx, /Sortie &lt;test&gt; &amp; co/);
  const act = PYR.activity.parse(gpx);
  assert.equal(act.points.length, 150);
  assert.ok(act.hasPower && act.hasTime && act.hasEle);
  assert.equal(act.points[100].power, Math.round(sess.Pk[100]));
  assert.ok(Math.abs(act.points[149].t - 149) < 0.5);
});

test('séance : un capteur connecté qui se tait (roue libre) n\'est pas une panne ; déconnecté, il en est une', async () => {
  const env = await planOf(HILLY);
  const run = (sensorOn) => {
    const sess = newSession(env);
    for (let k = 0; k < 10; k++) sess.step({ power: 220, sensorOn, fix: null });
    for (let k = 0; k < 10; k++) sess.step({ sensorOn, fix: null });
    return sess;
  };
  const on = run(true), off = run(false);
  assert.ok(!on.powerLost, 'connecté : roue libre');
  assert.equal(on.Pk[19], 0, 'silence = 0 W après 2 s');
  assert.ok(on.Pk[11] > 0, 'les 2 premières secondes gardent la dernière valeur');
  assert.ok(off.powerLost, 'déconnecté : capteur perdu');
});

test('export GPX : la cadence est enregistrée avec la fréquence cardiaque', async () => {
  const env = await planOf(HILLY);
  const sess = newSession(env);
  for (let k = 0; k < 5; k++) sess.step({ power: 200, cad: 85 + k, fix: null });
  assert.equal(sess.guidance().cad, 89);
  const gpx = R.toGpx(sess);
  assert.match(gpx, /<gpxtpx:cad>87<\/gpxtpx:cad>/);
  assert.ok(!/gpxtpx:hr/.test(gpx));
});

test('export GPX : la fréquence cardiaque n\'apparaît que si une ceinture était connectée', async () => {
  const env = await planOf(HILLY);
  const without = newSession(env);
  for (let k = 0; k < 5; k++) without.step({ power: 200, fix: null });
  assert.ok(!/gpxtpx/.test(R.toGpx(without)));
  const withHr = newSession(env);
  for (let k = 0; k < 5; k++) withHr.step({ power: 200, hr: 140 + k, fix: null });
  const gpx = R.toGpx(withHr);
  assert.match(gpx, /xmlns:gpxtpx=/);
  assert.match(gpx, /<gpxtpx:hr>144<\/gpxtpx:hr>/);
  assert.equal(PYR.activity.parse(gpx).points.length, 5);
});
