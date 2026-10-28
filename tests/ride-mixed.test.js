/* author : Hugo Joudrier-Faure */
/* Tests du mode mixte de la sortie : coureurs virtuels sans aspiration qui partent à la ligne, avancent à la demande, passages du cycliste aux
 * sprints et aux sommets (rang, points), classement en course, sauvegarde et reprise. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor, DEFAULT_RIDER, DEFAULT_BIKE } = require('./helpers.js');

const Mx = PYR.rideMixed, Cl = PYR.classif, Race = PYR.race;

/** ≈ 10 km : plat, montée, descente, plat. */
const HILLY = [{ len: 3000, grade: 0 }, { len: 2000, grade: 0.05 }, { len: 2000, grade: -0.04 }, { len: 3000, grade: 0.005 }];
const COLORS = ['#1baf7a', '#4a3aa7', '#e87ba4', '#008300', '#eda100', '#e34948'];

function setup(o = {}) {
  const prof = makeProfile(HILLY);
  const { course } = setupFor(prof);
  const cps = Cl.normalize([{ type: 'sprint', s: 1500 }, { type: 'kom', s: 5000, cat: '3', start: 3000, len: 2000, gain: 100 }], course.length);
  const make = (x = {}) => Mx.create(Object.assign({ course, cps, rules: { sprints: 1, kom: true }, seed: 5, gustSeed: 1, n: 4, level: 'equal', rider: DEFAULT_RIDER, bike: DEFAULT_BIKE, colors: COLORS }, o, x));
  return { course, cps, make };
}

/** Cycliste de synthèse à vitesse constante : mêmes champs qu'une séance (t, s, finished, timeAt). */
function rider(v, L) {
  const o = {
    t: 0, s: 0, finished: false, positioned: true,
    timeAt: (x) => (x <= o.s ? x / v : null),
    tick() { o.t++; o.s = Math.min(L, o.s + v); if (o.s >= L - 15) o.finished = true; },
  };
  return o;
}

test('aspiration : la règle draft:false met tous les coureurs en solo ; le défaut ne change pas', () => {
  assert.equal(Race.normRules({}).draft, true);
  assert.equal(Race.normRules({ draft: false }).draft, false);
  const { make } = setup();
  const m = make({ n: 6 });
  assert.equal(m.race.rules.draft, false);
  const sess = rider(8, 10000);
  for (let i = 0; i < 400; i++) { sess.tick(); Mx.update(m, sess); }
  assert.ok(m.race.t > 300);
  for (const r of m.race.riders) {
    assert.equal(r.stats.savedJ, 0, r.id + ' : watts économisés');
    assert.equal(r.draft.k, 1, r.id + ' : coefficient d\'abri');
  }
});

test('départ : les coureurs virtuels attendent la ligne, partent à l\'instant interpolé du passage, et avancent au plus de AHEAD secondes en avance', () => {
  const { course, make } = setup();
  const m = make();
  const sess = rider(8, course.length);
  sess.tick(); sess.tick();                                    // s = 16 m : pas encore franchi
  Mx.update(m, sess);
  assert.equal(m.t0, null);
  assert.equal(m.race.t, 0);
  assert.ok(Mx.positions(m, sess.t).every((p) => p.s === 0));
  sess.tick();                                                  // s = 24 m, la ligne (20 m) a été franchie à t = 2,5 s
  Mx.update(m, sess);
  assert.ok(Math.abs(m.t0 - 2.5) < 1e-9, `t0 = ${m.t0}`);
  assert.equal(m.race.t, Math.ceil(0.5) + Mx.AHEAD);
  for (let i = 0; i < 60; i++) { sess.tick(); Mx.update(m, sess); }
  assert.equal(m.race.t, Math.ceil(sess.t - m.t0) + Mx.AHEAD);
  // position d'un coureur à l'instant t de la sortie = sa trace au temps de course t − t0
  const t = m.t0 + 20.5, r = m.race.riders[0], x = Mx.positions(m, t)[0].s;
  const i = 20, expect = r.trace.s[i] + (r.trace.s[i + 1] - r.trace.s[i]) * 0.5;
  assert.ok(Math.abs(x - expect) < 1e-9);
  assert.ok(x > 50, `position ${x}`);
});

test('reproductible : même graine, mêmes traces, quel que soit le découpage du budget de calcul', () => {
  const { course, make } = setup();
  const a = make(), b = make();
  const sa = rider(8, course.length), sb = rider(8, course.length);
  for (let i = 0; i < 200; i++) {
    sa.tick(); sb.tick();
    Mx.update(a, sa);                                           // sans limite de temps
    for (let k = 0; k < 40 && b.race.t < Math.ceil(Mx.tau(b, sb.t)) + Mx.AHEAD; k++) Mx.update(b, sb, 0);   // un pas à la fois
  }
  assert.equal(a.race.t, b.race.t);
  for (let i = 0; i < a.race.riders.length; i++) assert.deepEqual(a.race.riders[i].trace.s, b.race.riders[i].trace.s);
  const c = make({ seed: 6 });
  const sc = rider(8, course.length);
  for (let i = 0; i < 200; i++) { sc.tick(); Mx.update(c, sc); }
  assert.ok(JSON.stringify(c.race.riders[0].trace.s) !== JSON.stringify(a.race.riders[0].trace.s), 'une autre graine donne une autre course');
});

test('passages : le cycliste rapide gagne le sprint et le sommet, le lent est dernier ; rang, points et écart', () => {
  const { course, cps, make } = setup();
  const play = (v) => {
    const m = make(), sess = rider(v, course.length), events = [];
    for (let i = 0; i < 4000 && !(sess.finished && m.splits.every((x) => x !== null) && !m.pending.length); i++) { sess.tick(); events.push(...Mx.update(m, sess, 50)); }
    return { m, sess, events };
  };
  const fast = play(14);
  assert.deepEqual(fast.events.map((e) => e.cp), [0, 1, 2]);
  assert.deepEqual(fast.events.map((e) => e.point.type), ['sprint', 'kom', 'finish']);
  assert.ok(fast.events.every((e) => e.rank === 1), JSON.stringify(fast.events.map((e) => e.rank)));
  assert.equal(fast.events[0].pts, Cl.pointsFor(cps[0], 1));
  assert.ok(fast.events[0].gap < 0, 'en tête : écart négatif sur le suivant');
  const slow = play(3);
  assert.ok(slow.events.every((e) => e.rank === 5), JSON.stringify(slow.events.map((e) => e.rank)));
  assert.equal(slow.events[0].pts, Cl.pointsFor(cps[0], 5));
  assert.ok(slow.events.every((e) => e.gap > 0));
  // temps de passage interpolé : à vitesse constante, t = s / v (en temps de course)
  assert.ok(Math.abs(fast.m.splits[0] - (1500 - Mx.START_S) / 14) < 1.1, `split ${fast.m.splits[0]}`);
});

test('classement en course : trié par position, écarts signés (positif = devant toi)', () => {
  const { course, make } = setup();
  const m = make({ n: 4, level: 'mixed' }), sess = rider(5, course.length);
  for (let i = 0; i < 300; i++) { sess.tick(); Mx.update(m, sess); }
  const rows = Mx.board(m, sess, sess.t);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4, 5]);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].s >= rows[i].s);
  const me = rows.find((r) => r.me);
  assert.equal(me.id, 'me');
  assert.ok(Math.abs(me.s - sess.s) < 1e-9);
  assert.ok(rows.some((r) => !r.me && r.dm > 0 && r.dt > 0), 'au moins un coureur virtuel devant, d\'autant de secondes d\'avance');
  for (const r of rows) {
    if (r.me) continue;
    assert.equal(Math.sign(r.dm), Math.sign(r.dt), `${r.name} : mètres ${r.dm}, secondes ${r.dt}`);
  }
});

test('sauvegarde : la reprise reconstruit la même course (graine, départ, temps de passage du cycliste)', () => {
  const { course, make } = setup();
  const m = make(), sess = rider(9, course.length);
  for (let i = 0; i < 400; i++) { sess.tick(); Mx.update(m, sess); }
  const json = JSON.parse(JSON.stringify(Mx.pack(m)));
  const back = Mx.unpack(json, { course, rider: DEFAULT_RIDER, bike: DEFAULT_BIKE, gustSeed: 1, colors: COLORS });
  assert.equal(back.t0, m.t0);
  assert.deepEqual(back.splits, m.splits);
  assert.equal(back.race.t, 0, 'à rattraper');
  Mx.update(back, sess);
  assert.equal(back.race.t, m.race.t);
  for (let i = 0; i < m.race.riders.length; i++) assert.deepEqual(back.race.riders[i].trace.s, m.race.riders[i].trace.s);
  assert.deepEqual(Mx.positions(back, sess.t), Mx.positions(m, sess.t));
  assert.equal(Mx.unpack({ v: 2 }, { course }), null);
});

test('étalonnage : le niveau égal boucle le parcours au temps visé (celui du plan), le faible plus lentement, et k est sauvegardé', () => {
  const { course, cps, make } = setup();
  const o = { course, rider: DEFAULT_RIDER, bike: DEFAULT_BIKE, gustSeed: 1 };
  const base = Mx.probeTime(o, cps, 1), target = base * 0.9;       // visé : 10 % plus vite que le niveau brut
  const mean = (m) => { assert.ok(Mx.finishAll(m)); return m.race.riders.reduce((s, r) => s + r.time, 0) / m.race.riders.length; };
  const eq = make({ n: 4, targetTime: target });
  assert.ok(eq.levelK > 1.03 && eq.levelK < 1.6, `k = ${eq.levelK}`);
  const meanEq = mean(eq);
  assert.ok(Math.abs(meanEq / target - 1) < 0.06, `moyenne ${meanEq} s pour ${target} s visées`);
  const weak = make({ n: 4, level: 'weaker', targetTime: target });
  assert.ok(mean(weak) > meanEq * 1.03, 'le niveau faible reste plus lent que le niveau égal étalonné');
  assert.equal(make({ n: 4 }).levelK, 1, 'sans temps visé : pas d\'étalonnage');
  // sauvegarde : pas de nouvel étalonnage à la reprise, mêmes coureurs
  const back = Mx.unpack(JSON.parse(JSON.stringify(Mx.pack(eq))), Object.assign({ colors: COLORS }, o));
  assert.equal(back.levelK, eq.levelK);
  for (let i = 0; i < 300; i++) Race.step(back.race);
  assert.deepEqual(back.race.riders[0].trace.s.slice(0, 301), eq.race.riders[0].trace.s.slice(0, 301));
});

test('niveau : des coureurs plus forts arrivent avant des plus faibles ; bilan avec le cycliste', () => {
  const { course, make } = setup();
  const meanTime = (level) => {
    const m = make({ n: 4, level });
    assert.ok(Mx.finishAll(m));
    assert.ok(m.race.riders.every((r) => r.finished));
    return { m, mean: m.race.riders.reduce((s, r) => s + r.time, 0) / m.race.riders.length };
  };
  const strong = meanTime('stronger'), weak = meanTime('weaker');
  assert.ok(strong.mean < weak.mean * 0.97, `forts ${strong.mean} s, faibles ${weak.mean} s`);
  // bilan : le cycliste arrive pendant que les coureurs virtuels roulent encore, puis ils finissent
  const m = make({ n: 3 }), sess = rider(9, course.length);
  for (let i = 0; i < 2000 && !sess.finished; i++) { sess.tick(); Mx.update(m, sess); }
  for (let i = 0; i < 50; i++) Mx.update(m, sess, 20);
  Mx.finishAll(m);
  for (let i = 0; i < 50 && m.pending.length; i++) Mx.update(m, sess);
  const sd = Mx.standings(m, sess);
  assert.equal(sd.general.length, 4);
  assert.ok(sd.general.every((g) => g.time !== null), 'tous arrivés');
  assert.ok(sd.general.some((g) => g.id === 'me'));
  const names = Mx.names(m);
  assert.equal(names.get('me').name, 'Toi');
  assert.equal(names.get('bot1').color, COLORS[0]);
});
