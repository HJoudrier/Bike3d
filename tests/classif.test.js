/* author : Hugo Joudrier-Faure */
/* Tests des classements annexes : côtes classées, sprints intermédiaires, points, passages. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor, DEFAULT_RIDER, DEFAULT_BIKE } = require('./helpers.js');

const Cl = PYR.classif, Race = PYR.race, Tac = PYR.tactics;

const climbsOf = (segs, opts) => { const p = makeProfile(segs, opts); return Cl.findClimbs(p.ele, p.step); };

test('côtes : détection, pied et sommet, catégories de la 4ᵉ à « hors catégorie »', () => {
  const one = (segs, opts) => { const c = climbsOf(segs, opts); assert.equal(c.length, 1, JSON.stringify(c)); return c[0]; };
  const flat = { len: 3000, grade: 0 };
  assert.equal(one([flat, { len: 1500, grade: 0.05 }, flat]).cat, '4');
  const c3 = one([flat, { len: 3000, grade: 0.06 }, { len: 3000, grade: -0.05 }]);
  assert.equal(c3.cat, '3');
  assert.ok(Math.abs(c3.start - 3000) < 60 && Math.abs(c3.end - 6000) < 20, `pied ${c3.start}, sommet ${c3.end}`);
  assert.ok(Math.abs(c3.gain - 180) < 3 && Math.abs(c3.grade - 0.06) < 0.003);
  assert.equal(one([flat, { len: 5000, grade: 0.07 }, { len: 3000, grade: -0.06 }]).cat, '2');
  assert.equal(one([flat, { len: 10000, grade: 0.07 }, { len: 3000, grade: -0.06 }], { ele0: 1000 }).cat, '1');
  assert.equal(one([flat, { len: 15000, grade: 0.08 }, { len: 3000, grade: -0.07 }], { ele0: 600 }).cat, 'hc');
  assert.equal(one([flat, { len: 1000, grade: 0.035 }, flat]).cat, null, 'bosse de 35 m : non classée');
  // un faux plat avant la côte n'en fait pas partie ; un replat au sommet non plus
  const fp = one([{ len: 2000, grade: 0 }, { len: 1000, grade: 0.01 }, { len: 2000, grade: 0.06 }, { len: 800, grade: 0.003 }, { len: 2000, grade: -0.05 }]);
  assert.ok(Math.abs(fp.start - 3000) < 60 && Math.abs(fp.end - 5000) < 20, `faux plat : ${fp.start} → ${fp.end}`);
  // deux côtes séparées par 2 km de plat, mais une seule malgré un court replat de 800 m
  assert.equal(climbsOf([flat, { len: 2000, grade: 0.07 }, { len: 2000, grade: 0 }, { len: 2000, grade: 0.07 }, { len: 3000, grade: -0.05 }]).length, 2);
  assert.equal(climbsOf([flat, { len: 2000, grade: 0.07 }, { len: 800, grade: 0 }, { len: 2000, grade: 0.07 }, { len: 3000, grade: -0.05 }]).length, 1);
  assert.deepEqual(climbsOf([{ len: 8000, grade: 0 }]), []);
});

test('points de passage : sprints sur du plat, sommets, arrivée en dernier', () => {
  const plat = makeProfile([{ len: 20000, grade: 0 }]);
  const two = Cl.build(plat, { sprints: 2, kom: true });
  assert.deepEqual(two.map((c) => c.type), ['sprint', 'sprint', 'finish']);
  assert.ok(Math.abs(two[0].s - 20000 / 3) < 400 && Math.abs(two[1].s - 40000 / 3) < 400, two.map((c) => c.s).join());
  assert.equal(two[2].s, plat.length);
  assert.deepEqual(two.map((c) => c.n), [1, 2, undefined]);
  // col de 5 km : les sprints évitent la côte, son pied et le début de la descente
  const col = makeProfile([{ len: 5000, grade: 0 }, { len: 5000, grade: 0.07 }, { len: 5000, grade: -0.06 }, { len: 5000, grade: 0 }]);
  const cps = Cl.build(col, { sprints: 2, kom: true });
  const kom = cps.find((c) => c.type === 'kom');
  assert.equal(kom.cat, '2');
  for (const s of cps.filter((c) => c.type === 'sprint')) assert.ok(s.s < kom.start - 400 || s.s > kom.s + 900, `sprint au km ${s.s / 1000}`);
  assert.equal(Cl.build(col, { sprints: 2, kom: false }).filter((c) => c.type === 'kom').length, 0);
  // montée finale : le sommet est la ligne d'arrivée, compté avant l'arrivée
  const summit = Cl.build(makeProfile([{ len: 8000, grade: 0 }, { len: 6000, grade: 0.07 }]), { sprints: 0, kom: true });
  assert.deepEqual(summit.map((c) => c.type), ['kom', 'finish']);
  assert.equal(summit[0].s, summit[1].s);
  assert.equal(Cl.longLabel(summit[0], summit), 'Arrivée au sommet (2ᵉ catégorie)');
  // trop court pour un sprint ; sans règles, seulement l'arrivée
  assert.equal(Cl.build(makeProfile([{ len: 3000, grade: 0 }]), { sprints: 3 }).length, 1);
  assert.ok(!Cl.active(Cl.build(col, {})));
  assert.ok(Cl.active(cps));
});

test('sprints ajoutés un par un : dans le plus grand intervalle libre, sur du plat, sans limite de nombre', () => {
  const plat = makeProfile([{ len: 60000, grade: 0 }]);
  const taken = [];
  for (let k = 0; k < 12; k++) {
    const s = Cl.nextSprint(plat.ele, plat.step, [], taken, []);
    assert.ok(s !== null, `sprint n°${k + 1}`);
    for (const t of [0, plat.length, ...taken]) assert.ok(Math.abs(s - t) >= 2000, `km ${s / 1000} trop près du km ${t / 1000}`);
    taken.push(s);
  }
  assert.ok(Math.abs(taken[0] - 30000) < 100, `premier sprint au milieu : km ${taken[0] / 1000}`);
  assert.ok(Math.abs(taken[1] - 15000) < 100 || Math.abs(taken[1] - 45000) < 100, `deuxième au quart : km ${taken[1] / 1000}`);
  // à force, il n'y a plus de place (2 km entre deux sprints)
  let more = 0;
  while (Cl.nextSprint(plat.ele, plat.step, [], taken, []) !== null && more < 40) { taken.push(Cl.nextSprint(plat.ele, plat.step, [], taken, [])); more++; }
  assert.ok(more < 40 && taken.length <= 29, `${taken.length} sprints`);
  // col au milieu : le sprint évite la côte, et la zone à éviter (ravitaillement)
  const col = makeProfile([{ len: 8000, grade: 0 }, { len: 5000, grade: 0.07 }, { len: 5000, grade: -0.06 }, { len: 8000, grade: 0 }]);
  const climbs = Cl.findClimbs(col.ele, col.step);
  const s1 = Cl.nextSprint(col.ele, col.step, climbs, [], []);
  assert.ok(s1 < climbs[0].start - 400 || s1 > climbs[0].end + 900, `sprint au km ${s1 / 1000}`);
  const s2 = Cl.nextSprint(col.ele, col.step, climbs, [], [{ start: s1 - 1000, end: s1 + 1000 }]);
  assert.ok(Math.abs(s2 - s1) > 1200, `zone évitée : km ${s1 / 1000} puis ${s2 / 1000}`);
  // parcours accidenté : jamais dans une pente de plus de 3 %, même à force d'en ajouter
  const hilly = makeProfile([{ len: 5000, grade: 0.05 }, { len: 5000, grade: -0.05 }, { len: 6000, grade: 0 }, { len: 5000, grade: 0.05 }, { len: 5000, grade: -0.05 }]);
  const hc = Cl.findClimbs(hilly.ele, hilly.step), placed = [];
  for (let s; (s = Cl.nextSprint(hilly.ele, hilly.step, hc, placed, [])) !== null && placed.length < 20;) placed.push(s);
  assert.ok(placed.length >= 1 && placed.length < 20, `${placed.length} sprints`);
  for (const s of placed) assert.ok(s > 10000 && s < 16000, `sprint au km ${s / 1000}, hors du plat`);
  // trop court
  assert.equal(Cl.nextSprint(makeProfile([{ len: 3000, grade: 0 }]).ele, 10, [], [], []), null);
});

test('côtes ajoutées une par une : la plus dure d\'abord, jamais deux fois la même', () => {
  const p = makeProfile([{ len: 3000, grade: 0 }, { len: 1500, grade: 0.05 }, { len: 3000, grade: 0 }, { len: 10000, grade: 0.07 }, { len: 4000, grade: -0.06 },
    { len: 3000, grade: 0 }, { len: 3000, grade: 0.06 }, { len: 3000, grade: -0.05 }], { ele0: 1000 });
  const taken = [];
  const cats = [];
  for (;;) {
    const c = Cl.nextClimb(p.ele, p.step, taken);
    if (!c) break;
    cats.push(c.cat);
    taken.push({ start: c.start, end: c.s });
    assert.ok(taken.length <= 3, 'au plus trois côtes');
  }
  assert.deepEqual(cats, ['1', '2', '4']);
  // une côte posée à la main un peu décalée compte comme déjà posée
  const first = Cl.nextClimb(p.ele, p.step, []);
  const next = Cl.nextClimb(p.ele, p.step, [{ start: first.start + 400, end: first.s - 150 }]);
  assert.notEqual(next.s, first.s);
  // arrivée au sommet : la ligne est l'arrivée
  const summit = makeProfile([{ len: 8000, grade: 0 }, { len: 6000, grade: 0.07 }]);
  assert.equal(Cl.nextClimb(summit.ele, summit.step, []).s, summit.length);
  assert.equal(Cl.nextClimb(makeProfile([{ len: 8000, grade: 0 }]).ele, 10, []), null);
});

test('points de passage reçus : vérifiés, triés, numérotés, idempotents', () => {
  const L = 10000;
  const raw = [
    { type: 'kom', s: 6000, cat: '3', start: 4000, len: 2000, gain: 120 },
    { type: 'sprint', s: 3000 },
    { type: 'sprint', s: 10000 },            // sur la ligne d'arrivée : refusé
    { type: 'kom', s: 7000, cat: '9' },      // catégorie inconnue
    { type: 'finish', s: 5000 },             // l'arrivée est ajoutée d'office
    { type: 'bonus', s: 2000 }, null, { type: 'sprint', s: -5 }, { type: 'sprint', s: 'x' },
    { type: 'kom', s: 9999.99, cat: 'hc', start: 5000 },
  ];
  const cps = Cl.normalize(raw, L);
  assert.deepEqual(cps.map((c) => `${c.type}@${c.s}`), ['sprint@3000', 'kom@6000', 'kom@10000', 'finish@10000']);
  assert.equal(cps[2].cat, 'hc');
  assert.deepEqual(Cl.normalize(JSON.parse(JSON.stringify(cps)), L), cps);
  assert.deepEqual(Cl.normalize('nimporte', L), [{ type: 'finish', s: L }]);
});

test('classements : points, montagne, écarts et départage des ex æquo', () => {
  const cps = Cl.normalize([{ type: 'sprint', s: 3000 }, { type: 'kom', s: 5000, cat: '4' }, { type: 'kom', s: 7000, cat: '2' }], 9000);
  // splits : sprint, côte 4ᵉ, côte 2ᵉ, arrivée
  const riders = [
    { id: 'a', splits: [100, 250, 400, 600] },
    { id: 'b', splits: [100.4, 240, 401, 601] },
    { id: 'c', splits: [99, 260, 395, null], s: 8000 },
    { id: 'd', splits: [null, null, null, null], s: 2000 },
  ];
  const sd = Cl.standings(cps, riders);
  assert.deepEqual(sd.passages[0].map((p) => `${p.id}:${p.rank}:${p.pts}:${p.gap.toFixed(1)}`), ['c:1:20:0.0', 'a:2:17:1.0', 'b:3:15:1.4']);
  assert.deepEqual(sd.general.map((g) => g.id), ['a', 'b', 'c', 'd']);
  // points : a 17 + 30 = 47, b 15 + 25 = 40, c 20
  assert.deepEqual(sd.points.map((x) => `${x.id}:${x.pts}`), ['a:47', 'b:40', 'c:20']);
  // montagne : c 5 (1ᵉʳ en 2ᵉ cat.) ; a 3 (2ᵉ en 2ᵉ cat.) ; b 1 (1ᵉʳ en 4ᵉ cat.) + 2 (3ᵉ en 2ᵉ cat.) = 3,
  // devant a à égalité grâce à sa victoire au sommet de la côte de 4ᵉ catégorie
  assert.deepEqual(sd.kom.map((x) => `${x.id}:${x.pts}`), ['c:5', 'b:3', 'a:3']);
  // ex æquo : la victoire dans la côte la plus dure l'emporte, puis le général
  const tie = Cl.standings(Cl.normalize([{ type: 'kom', s: 2000, cat: '3' }, { type: 'kom', s: 4000, cat: '2' }], 5000), [
    { id: 'x', splits: [10, 31, 50] },   // 2 (1ᵉʳ en 3ᵉ) + 3 (2ᵉ en 2ᵉ) = 5
    { id: 'y', splits: [11, 30, 51] },   // 1 + 5 (1ᵉʳ en 2ᵉ) = 6
    { id: 'z', splits: [12, 32, 49] },
  ]);
  assert.deepEqual(tie.kom.map((x) => `${x.id}:${x.pts}`), ['y:6', 'x:5', 'z:2']);
  const tie2 = Cl.standings(Cl.normalize([{ type: 'kom', s: 2000, cat: '4' }, { type: 'kom', s: 4000, cat: '4' }], 5000), [
    { id: 'p', splits: [10, 31, 52] }, { id: 'q', splits: [11, 30, 50] },
  ]);
  assert.deepEqual(tie2.kom.map((x) => x.id), ['q', 'p'], '1 point chacun : le meilleur au général devant');
});

test('course : temps de passage interpolés, identiques à ceux tirés de la trace', () => {
  const prof = makeProfile([{ len: 3000, grade: 0 }, { len: 1500, grade: 0.05 }, { len: 2500, grade: 0 }]);
  const cps = Cl.build(prof, { sprints: 1, kom: true });
  assert.deepEqual(cps.map((c) => c.type).sort(), ['finish', 'kom', 'sprint']);
  assert.equal(cps[2].type, 'finish');
  const { course, setup, athlete } = setupFor(prof);
  const race = Race.create({ course, rules: { sprints: 1, kom: true }, seed: 5, gustSeed: 1, cps });
  const r = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 8 });
  Tac.setMode(r, 'threshold', 0);
  const seen = [];
  race.onEvent = (ev) => { if (ev.type === 'cp') seen.push(ev.cp); };
  Race.runToEnd(race);
  assert.deepEqual(seen, [0, 1], 'un évènement par sprint ou sommet');
  assert.equal(r.splits[2], r.time);
  const fromTrace = Cl.entrySplits(cps, { s: r.trace.s, time: r.time });
  r.splits.forEach((t, k) => assert.ok(Math.abs(t - fromTrace[k]) < 1e-6, `point ${k} : ${t} vs ${fromTrace[k]}`));
  // la trace ne passe pas encore le point : pas de temps
  assert.equal(Cl.entrySplits(cps, { s: [0, 10, 20], time: NaN })[0], null);
  assert.deepEqual(Cl.entrySplits(cps, { sp: [1, 2, 3], s: [] }), [1, 2, 3]);
});

test('tactique : sprint vers la ligne, puis retour à la tactique d\'avant ; les virtuels disputent les points', () => {
  const prof = makeProfile([{ len: 6000, grade: 0 }, { len: 3000, grade: 0.06 }, { len: 3000, grade: -0.05 }, { len: 8000, grade: 0 }]);
  const cps = Cl.build(prof, { sprints: 2, kom: true });
  const { course, setup, athlete } = setupFor(prof);
  const race = Race.create({ course, rules: { sprints: 2, kom: true }, seed: 3, gustSeed: 1, cps });
  const bots = Race.addBots(race, { n: 6, level: 'mixed', rider: DEFAULT_RIDER, bike: DEFAULT_BIKE, v0: 5 });
  const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 5 });
  Tac.setMode(me, 'follow', 0);
  const sprint = cps.find((c) => c.type === 'sprint');
  const aimed = new Set();
  let launched = false, resumed = false;
  while (race.riders.some((r) => !r.finished) && race.t < 4 * 3600) {
    if (!launched && me.st.s > sprint.s - 250) {
      assert.equal(Tac.lineFor(me, cps, 'sprint'), sprint.s);
      Tac.setMode(me, 'sprint', me.st.t, Tac.lineFor(me, cps, 'sprint'));
      launched = true;
    }
    Race.step(race);
    if (launched && !resumed && me.st.s >= sprint.s) { resumed = true; assert.equal(me.tac.mode, 'follow', 'ligne passée : de nouveau dans les roues'); }
    for (const b of bots) if ((b.tac.mode === 'sprint' || b.tac.mode === 'attack') && b.tac.target) aimed.add(`${b.tac.mode}@${b.tac.target}`);
  }
  assert.ok(resumed);
  assert.ok([...aimed].some((x) => x.startsWith('sprint@')), `sprints intermédiaires disputés : ${[...aimed]}`);
  const sd = Race.standings(race);
  assert.equal(sd.points.length, 7, 'tout le monde marque à l\'arrivée');
  assert.ok(sd.kom.length >= 1 && sd.kom[0].pts === 2, 'côte de 3ᵉ catégorie : 2 points au premier');
  for (const r of race.riders) assert.ok(r.splits.every((t) => Number.isFinite(t)), `${r.name} : ${r.splits}`);
  // bots : goûts entre 0 et 1, sans changer les autres tirages de la course
  for (const b of bots) assert.ok(b.bot.sprint >= 0 && b.bot.sprint <= 1 && b.bot.climb >= 0 && b.bot.climb <= 1);
});

test('liste de l\'onglet Parcours : points de passage, dénivelé des côtes, barème personnalisé', () => {
  const p = makeProfile([{ len: 3000, grade: 0 }, { len: 3000, grade: 0.06 }, { len: 3000, grade: -0.05 }, { len: 3000, grade: 0 }]);
  const items = [
    { id: 'a', type: 'sprint', km: 1.5, pts: [10, 5, 1] },
    { id: 'b', type: 'kom', km: 6, startKm: 3, cat: '3' },
    { id: 'c', type: 'sprint', km: 50 },          // au-delà de l'arrivée : ignoré
    { id: 'd', type: 'bogus', km: 2 },
  ];
  const cps = Cl.fromList(items, p);
  assert.deepEqual(cps.map((c) => c.type), ['sprint', 'kom', 'finish']);
  assert.equal(cps[2].s, p.length);
  const kom = cps[1];
  assert.equal(kom.cat, '3');
  assert.ok(Math.abs(kom.len - 3000) < 1 && Math.abs(kom.gain - 180) < 3, `${kom.len} m, +${kom.gain}`);
  // barème : celui de la liste, sinon celui de la catégorie
  assert.equal(Cl.pointsFor(cps[0], 1), 10);
  assert.equal(Cl.pointsFor(cps[0], 3), 1);
  assert.equal(Cl.pointsFor(cps[0], 4), 0);
  assert.equal(Cl.pointsFor(kom, 1), Cl.CATS.find((c) => c.id === '3').pts[0]);
  assert.deepEqual(Cl.cleanPts([3, 'x', -1, 2.4]), [3, 2]);
  assert.equal(Cl.cleanPts([]), null);
  assert.deepEqual(Cl.fromList([], p).map((c) => c.type), ['finish']);
  assert.deepEqual(Cl.fromList(undefined, p).map((c) => c.type), ['finish']);
  // le barème personnalisé survit à la vérification d'une liste reçue du réseau
  assert.deepEqual(Cl.normalize(cps, p.length)[0].pts, [10, 5, 1]);
});

test('ajout automatique : build puis toItems redonnent les mêmes points de passage', () => {
  const p = makeProfile([{ len: 3000, grade: 0 }, { len: 3000, grade: 0.06 }, { len: 3000, grade: -0.05 }, { len: 6000, grade: 0 }]);
  const auto = Cl.build(p, { kom: true, sprints: 1 });
  const back = Cl.fromList(Cl.toItems(auto), p);
  assert.deepEqual(back.map((c) => [c.type, c.cat]), auto.map((c) => [c.type, c.cat]));
  for (let i = 0; i < auto.length; i++) assert.ok(Math.abs(back[i].s - auto[i].s) < 1, `${back[i].s} / ${auto[i].s}`);
  const k = Cl.catFor(3000, 180, 380);
  assert.equal(k.cat, '3');
});
