/* author : Hugo Joudrier-Faure */
/* Tests de la course à plusieurs : aspiration, énergie, forme, durée tenable, tactiques, incidents. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor, DEFAULT_RIDER, DEFAULT_BIKE } = require('./helpers.js');

const Dr = PYR.draft, Fu = PYR.fuel, Ph = PYR.physio, Race = PYR.race, Tac = PYR.tactics;

function newRace(profile, rules, seed) {
  const { course, setup, athlete } = setupFor(profile);
  const race = Race.create({ course, rules: rules || {}, seed: seed || 7, gustSeed: 1 });
  return { race, setup, athlete, course };
}

test('aspiration : abri du suiveur selon l\'écart, file indienne, gain du meneur, côte à côte', () => {
  const at = (gaps) => { // positions : le premier devant, puis chacun à gap m (entre les roues) du précédent
    let s = 1000;
    const list = [{ id: 'a0', s, v: 12 }];
    gaps.forEach((g, i) => { s -= g + Dr.BIKE; list.push({ id: 'a' + (i + 1), s, v: 12 }); });
    return Dr.field(list);
  };
  const two = at([0.5]);
  assert.ok(Math.abs(two.get('a1').R - 0.33) < 0.02, `suiveur à 0,5 m : ${two.get('a1').R}`);
  assert.equal(two.get('a1').role, 'follow');
  assert.ok(two.get('a0').R > 0.015 && two.get('a0').R < 0.04, `meneur : ${two.get('a0').R}`);
  assert.equal(two.get('a0').role, 'lead');
  const far = at([5]).get('a1').R, veryFar = at([20]).get('a1').R;
  assert.ok(far < two.get('a1').R && far > 0.08 && far < 0.15, `à 5 m : ${far}`);
  assert.equal(veryFar, 0);
  const line = at([0.5, 0.5, 0.5, 0.5]);
  assert.ok(line.get('a3').R > line.get('a1').R + 0.08, 'plus abrité au 3ᵉ rang qu\'au 2ᵉ');
  assert.ok(line.get('a4').R <= 0.55);
  assert.equal(line.get('a4').groupSize, 5);
  // côte à côte : pas d'abri
  const side = Dr.field([{ id: 'x', s: 100, v: 12 }, { id: 'y', s: 99.5, v: 12 }]);
  assert.equal(side.get('y').R, 0);
  // vent de côté : abri réduit
  const calm = Dr.field([{ id: 'p', s: 10, v: 11 }, { id: 'q', s: 7.7, v: 11 }]).get('q').R;
  const windy = Dr.field([{ id: 'p', s: 10, v: 11, wc: 5 }, { id: 'q', s: 7.7, v: 11, wc: 5 }]).get('q').R;
  assert.ok(windy < calm * 0.85, `vent de côté ${windy} vs ${calm}`);
});

test('aspiration : plusieurs coureurs devant, l\'abri dépasse 40 % de CdA et monte avec la taille du groupe', () => {
  const file = (n, gap) => { // n coureurs en file, chacun à gap m (entre les roues) du précédent
    const list = [];
    for (let k = 0; k < n; k++) list.push({ id: 'r' + k, s: 1000 - k * (gap + Dr.BIKE), v: 11 });
    return Dr.field(list);
  };
  const f = file(30, 0.6), R = (k) => f.get('r' + k).R;
  assert.ok(R(1) > 0.3 && R(1) < 0.37, `2ᵉ : ${R(1)}`);                   // un seul coureur devant : ≈ 33 %
  assert.ok(R(2) > 0.37 && R(3) > R(2) && R(5) > R(3), `file : ${R(2)}, ${R(3)}, ${R(5)}`);
  assert.ok(R(3) > 0.42 && R(5) >= 0.48, `plusieurs coureurs devant : ${R(3)}, ${R(5)}`);
  assert.ok(R(20) > 0.58 && R(20) <= Dr.MAX_R, `cœur du groupe : ${R(20)}`);
  for (let k = 1; k < 30; k++) assert.ok(R(k) <= Dr.MAX_R + 1e-12, `plafond au rang ${k}`);
  // avec plus d'écart entre les roues l'abri baisse, sans disparaître
  const loose = file(10, 3).get('r9').R;
  assert.ok(loose < file(10, 0.6).get('r9').R && loose > 0.15, `à 3 m : ${loose}`);
  // un groupe plus gros abrite davantage le même rang
  assert.ok(file(30, 0.6).get('r8').R > file(9, 0.6).get('r8').R - 1e-12, 'groupe de 30 ≥ groupe de 9 au 9ᵉ rang');
});

test('forme du jour et niveau : PC, W′ et courbe record mis à l\'échelle', () => {
  const a = Ph.buildAthlete(DEFAULT_RIDER);
  const b = Ph.scaleAthlete(a, 0.95, 0.8);
  assert.ok(Math.abs(b.cp / a.cp - 0.95) < 1e-9 && Math.abs(b.w0 / a.w0 - 0.8) < 1e-9);
  assert.ok(Math.abs(b.mmp(5 * 3600) / a.mmp(5 * 3600) - 0.95) < 0.01, 'durées longues ← PC');
  assert.ok(Math.abs(b.mmp(5) / a.mmp(5) - 0.8) < 0.03, 'durées courtes ← W′');
  const rnd = PYR.util.mulberry32(3);
  for (let i = 0; i < 200; i++) {
    const f = Ph.drawForm(rnd);
    assert.ok(f.cpK <= 1 && f.cpK >= 0.94 && f.wK <= 1 && f.wK >= 0.88, JSON.stringify(f));
    assert.ok(['excellente', 'bonne', 'moyenne', 'jour sans'].includes(f.label));
  }
});

test('énergie : fringale sans manger, repoussée en mangeant ; déshydratation ; boire et manger', () => {
  const cp = 250;
  const hours = (fn) => {
    const f = Fu.create(72, { gels: 6, bars: 4, bottles: 2 });
    let t = 0;
    while (Fu.factor(f) > 0.95 && t < 8 * 3600) { Fu.step(f, 230, cp, 20); if (fn) fn(f, t); t++; }
    return t / 3600;
  };
  const noFood = hours(null);
  assert.ok(noFood > 1.4 && noFood < 3.2, `fringale à 230 W sans manger après ${noFood.toFixed(2)} h`);
  const withFood = hours((f, t) => { if (t % 1200 === 0 && t > 0) Fu.eat(f, t); });
  assert.ok(withFood > noFood + 0.5, `en mangeant : ${withFood.toFixed(2)} h`);
  const f = Fu.create(72, { gels: 1, bars: 0, bottles: 1 });
  assert.equal(Fu.eat(f, 0), 'gel');
  assert.equal(Fu.eat(f, 100), null, 'plus rien à manger');
  for (let t = 0; t < 7200; t++) Fu.step(f, 250, cp, 30);
  assert.ok(Fu.lossPct(f) > 2, `2 h à 30 °C sans boire : ${Fu.lossPct(f).toFixed(1)} %`);
  assert.ok(Fu.factor(f) < 1);
  const before = f.deficit;
  assert.ok(Fu.drink(f, 8000) > 0 && f.deficit < before);
  assert.ok(Fu.timeToBonk(Fu.create(72), 250, cp) > 3600);
});

test('énergie : les glucides avalés mettent du temps à passer, la tendance de la réserve s\'améliore', () => {
  const cp = 250;
  const run = (eat) => {
    const f = Fu.create(72, { gels: 3, bars: 2 });
    f.G = 0.5 * f.G0;
    if (eat) Fu.eat(f, 0, 'gel');
    const s0 = Fu.status(f);
    for (let t = 0; t < 600; t++) Fu.step(f, 230, cp, 20);
    return { f, s0, s: Fu.status(f) };
  };
  const fed = run(true), fasted = run(false);
  assert.equal(fed.s0.gut, 25, 'le gel attend dans l\'estomac');
  assert.equal(fed.s0.stomach, 25);
  assert.ok(fed.s.energy > fasted.s.energy + 0.02, `réserve ${fed.s.energy.toFixed(3)} vs ${fasted.s.energy.toFixed(3)}`);
  assert.ok(fed.s.trend > fasted.s.trend, 'la baisse est ralentie tant que les glucides sont absorbés');
  assert.ok(fasted.s.trend < -0.05, `à 230 W on brûle bien plus que ce qu'on peut absorber : ${fasted.s.trend.toFixed(2)} /h`);
});

test('durée tenable : W′ au-dessus de la PC, courbe record en dessous', () => {
  const { course, setup, athlete } = setupFor(makeProfile([{ len: 20000, grade: 0 }]));
  const ctx = PYR.sim.createContext(course, setup, athlete, {});
  const st = PYR.sim.initState(ctx, 0);
  const above = PYR.sim.timeToExhaustion(ctx, st, ctx.cp + 100);
  assert.ok(above.t > 0 && above.t <= ctx.w0 / 100 + 1, `PC + 100 W : ${above.t} s (W′/100 = ${ctx.w0 / 100})`);
  const below = PYR.sim.timeToExhaustion(ctx, st, 0.9 * ctx.cp);
  assert.equal(below.by, 'record');
  // la courbe record donne la durée D telle que MMP(D) = P
  let D = 60;
  while (athlete.mmp(D) > 0.9 * ctx.cp && D < 36000) D += 30;
  assert.ok(Math.abs(below.t - D) / D < 0.2, `0,9 PC : ${below.t} s, attendu ≈ ${D} s`);
  assert.equal(PYR.sim.timeToExhaustion(ctx, st, 100).t, Infinity);
  st.capK = 0.8;
  assert.ok(PYR.sim.timeToExhaustion(ctx, st, 0.9 * ctx.cp).t < below.t, 'la fatigue raccourcit la durée tenable');
});

test('temps restant (courbe record seule) : durée où le record passe sous la puissance, qui décroît à l\'effort constant', () => {
  const { course, setup, athlete } = setupFor(makeProfile([{ len: 20000, grade: 0 }]));
  const ctx = PYR.sim.createContext(course, setup, athlete, {});
  const n = 3000;
  const P = 0.95 * athlete.ftp;
  const constant = new Float32Array(n).fill(P);
  const left = PYR.sim.recordTimeLeft(ctx, constant, n, { step: 1 });
  // effort neuf : la durée D telle que MMP(D) = P
  let D = 60;
  while (athlete.mmp(D) > P && D < 36000) D += 10;
  assert.ok(Math.abs(left[0] - D) / D < 0.1, `effort neuf : ${left[0]} s, attendu ≈ ${D} s`);
  // à puissance constante, chaque seconde roulée est une seconde de moins à tenir
  for (const t of [300, 900, 1500]) assert.ok(Math.abs((left[t] + t) - left[0]) / left[0] < 0.06, `t=${t} : ${left[t]} + ${t} ≠ ${left[0]}`);
  // sans PC ni W′ : 0,6 PC et 1,6 PC suivent la seule courbe record (un sprint ne dépend pas de W′ ici)
  const sprint = PYR.sim.recordTimeLeft(ctx, new Float32Array(n).fill(2 * ctx.cp), n, { step: 1 });
  assert.ok(sprint[0] > 0 && sprint[0] < 300, `2 PC : ${sprint[0]} s`);
  assert.ok(sprint[0] < left[0]);
  // pas de pédalage : rien à tenir ; l'effort passé raccourcit ce qui reste
  const rest = new Float32Array(n); rest.fill(0, 0, 500); rest.fill(P, 500);
  const afterRest = PYR.sim.recordTimeLeft(ctx, rest, n, { step: 1 });
  assert.equal(afterRest[100], Infinity);
  const hard = new Float32Array(n).fill(P); hard.fill(1.3 * P, 0, 500);
  assert.ok(PYR.sim.recordTimeLeft(ctx, hard, n, { step: 1 })[500] < left[500], 'un départ trop fort raccourcit le temps restant à P');
  // calcul par blocs : même ordre de grandeur que seconde par seconde
  const blocks = PYR.sim.recordTimeLeft(ctx, constant, n, { step: 20 });
  assert.ok(Math.abs(blocks[0] - left[0]) / left[0] < 0.02 && Math.abs(blocks[41] - left[41]) < 25);
});

test('temps restant : un plan limité par la NP tombe à zéro à l\'arrivée, alors que la moyenne est loin du record', () => {
  const { course, setup, athlete } = setupFor(makeProfile([{ len: 20000, grade: 0 }]));
  const ctx = PYR.sim.createContext(course, setup, athlete, {});
  const n = 3600, mm = athlete.mmp(n) * ctx.marginK;
  // 2 min à 200 W puis 2 min à 320 W, jusqu'à l'arrivée sur un bloc dur : la NP dépasse nettement la moyenne
  const P = new Float32Array(n);
  for (let t = 0; t < n; t++) P[t] = Math.floor(t / 120) % 2 === 0 ? 200 : 320;
  const np = (A) => {
    const H = new Float64Array(n + 1); for (let t = 0; t < n; t++) H[t + 1] = H[t] + A[t];
    let s4 = 0, c = 0; for (let t = 30; t <= n; t++) { const a = (H[t] - H[t - 30]) / 30; s4 += a * a * a * a; c++; }
    return { np: Math.pow(s4 / c, 0.25), avg: H[n] / n };
  };
  const k = 0.9995 * mm / np(P).np;
  for (let t = 0; t < n; t++) P[t] *= k;
  const m = np(P);
  assert.ok(m.np > 0.998 * mm && m.np <= mm, `NP ${m.np} / record ${mm}`);
  assert.ok(m.avg < 0.95 * mm, `moyenne ${m.avg} : la NP est la seule contrainte qui lie`);
  const left = PYR.sim.recordTimeLeft(ctx, P, n, { step: 1 });
  assert.ok(left[n - 1] < 30, `à l'arrivée il reste ${left[n - 1]} s (la NP est atteinte)`);
  // au milieu d'un bloc dur, poursuivre à cette puissance n'est pas tenable jusqu'au bout de l'heure : temps fini
  assert.ok(left[150] > 0 && left[150] < 3600, `${left[150]} s`);
  assert.equal(left[30], Infinity, 'bloc facile : rien à craindre');
  // plan sous la limite de NP : il reste du temps à l'arrivée
  const easy = Float32Array.from(P, (p) => p * 0.9);
  assert.ok(PYR.sim.recordTimeLeft(ctx, easy, n, { step: 1 })[n - 1] > 120, 'un plan à 90 % laisse de la marge');
});

test('forme : margin = 1 − forme ; 80 % de forme = 20 % de marge, au-dessus de 100 % la capacité augmente', () => {
  const { course, setup, athlete } = setupFor(makeProfile([{ len: 5000, grade: 0 }]));
  const k = (margin) => PYR.sim.createContext(course, setup, athlete, { margin }).marginK;
  assert.ok(Math.abs(k(0) - 1) < 1e-9, 'forme 100 % : capacités entières');
  assert.ok(Math.abs(k(0.2) - 0.8) < 1e-9, 'forme 80 %');
  assert.ok(Math.abs(k(-0.1) - 1.1) < 1e-9, 'forme 110 %');
  assert.ok(Math.abs(k(-1) - 2) < 1e-9, 'forme 200 %');
  assert.ok(k(5) > 0 && k(-10) <= 3, 'bornes du moteur');
});

test('temps avant épuisement de W′bal : W′ restant / (P − PC) au-dessus de la PC, infini en dessous', () => {
  const cp = 250, w0 = 20000, n = 600;
  // 100 s à 200 W (W′ plein), puis 300 W : W′ baisse de 50 J par seconde
  const P = new Float32Array(n), wbal = new Float64Array(n + 1);
  wbal[0] = w0;
  for (let t = 0; t < n; t++) { P[t] = t < 100 ? 200 : 300; wbal[t + 1] = Math.max(0, wbal[t] - (P[t] > cp ? P[t] - cp : 0)); }
  const left = PYR.sim.wprimeTimeLeft(P, wbal, cp, n, { step: 1 });
  assert.equal(left[50], Infinity, 'sous la PC, W′ ne s\'épuise pas');
  assert.ok(Math.abs(left[100] - w0 / 50) < 1e-6, `à l'entrée au-dessus de la PC : ${left[100]} s`);
  // à puissance constante au-dessus de la PC, chaque seconde roulée est une seconde de moins
  assert.ok(Math.abs(left[250] + 250 - (100 + w0 / 50)) < 1e-6, `${left[250]}`);
  assert.equal(left[n - 1], 0, 'W′ vide : plus rien à tenir au-dessus de la PC');
  // par blocs : la valeur du bloc décroît d'une seconde par seconde, comme seconde par seconde
  const blocks = PYR.sim.wprimeTimeLeft(P, wbal, cp, n, { step: 20 });
  assert.ok(Math.abs(blocks[205] - left[205]) < 1e-6 && blocks[250] > 0);
});

test('durée tenable du jeu : le plus petit de W′ et de la courbe record, calculée comme la courbe de la page Performance', () => {
  const { course, setup, athlete } = setupFor(makeProfile([{ len: 20000, grade: 0 }]));
  const ctx = PYR.sim.createContext(course, setup, athlete, {});
  const n = 3000, t0 = 2200;
  // un historique varié (blocs de 3 min à 180 et 330 W) : la NP dépasse la moyenne
  const P = new Float32Array(n);
  for (let t = 0; t < n; t++) P[t] = Math.floor(t / 180) % 2 === 0 ? 180 : 330;
  const st = PYR.sim.initState(ctx, 0);
  for (let t = 0; t < t0; t++) st.hist[t + 1] = st.hist[t] + P[t];
  st.t = t0;
  for (const p of [P[t0], 260, 320]) {
    const f = new Float32Array(n).fill(0); f.set(P.subarray(0, t0)); f[t0] = p;
    const ref = PYR.sim.recordTimeLeft(ctx, f, n, { step: 1 })[t0];
    // avec les règles de l'optimiseur sur la durée totale (option `total`), exactement la courbe de la page Performance
    const plan = PYR.sim.timeToExhaustion(ctx, st, p, undefined, { total: true });
    assert.ok(Math.abs(plan.record - ref) <= 1, `${p} W : jeu (total) ${plan.record} s, courbe de performance ${ref} s`);
    // dans le jeu, seules les fenêtres glissantes comptent : jamais plus court que la courbe d'un plan
    const tte = PYR.sim.timeToExhaustion(ctx, st, p);
    assert.ok(tte.record >= plan.record, `${p} W : ${tte.record} s < ${plan.record} s`);
    assert.equal(tte.t, Math.min(tte.wprime, tte.record));
  }
  // au-dessus de la PC : W′ a une durée, et `by` désigne le plus petit des deux ; en dessous, seule la courbe record
  const above = PYR.sim.timeToExhaustion(ctx, st, ctx.cp + 150);
  assert.ok(Number.isFinite(above.wprime) && Math.abs(above.wprime - st.wbal / 150) < 1e-6);
  assert.equal(above.by, above.wprime <= above.record ? 'wprime' : 'record');
  assert.equal(above.t, Math.min(above.wprime, above.record));
  const under = PYR.sim.timeToExhaustion(ctx, st, 0.6 * ctx.cp);
  assert.equal(under.wprime, Infinity);
  assert.equal(under.t, under.record);
  // W′ épuisé : plus rien de tenable au-dessus de la PC
  st.wbal = 0;
  assert.equal(PYR.sim.timeToExhaustion(ctx, st, ctx.cp + 50).t, 0);
});

test('durée tenable : à la PC avec W′ vide on ne consomme pas W′ (pas de 0:00 / 0:01 figé), au-dessus de la PC si', () => {
  const { course, setup, athlete } = setupFor(makeProfile([{ len: 20000, grade: 0 }]));
  const ctx = PYR.sim.createContext(course, setup, athlete, {});
  const st = PYR.sim.initState(ctx, 0);
  st.wbal = 0;                                            // W′ vide : le coureur est plafonné à la PC
  for (const p of [ctx.cp, ctx.cp + 0.2, ctx.cp - 5]) {
    const r = PYR.sim.timeToExhaustion(ctx, st, p);
    assert.equal(r.wprime, Infinity, `${p} W : W′ ne se consomme pas à la PC`);
    assert.notEqual(r.by, 'wprime');
  }
  const above = PYR.sim.timeToExhaustion(ctx, st, ctx.cp + 5);
  assert.equal(above.wprime, 0);
  assert.equal(above.by, 'wprime');
  // W′ partiellement entamé, à la PC : toujours rien ; la série d'un plan suit la même règle
  st.wbal = 300;
  assert.equal(PYR.sim.timeToExhaustion(ctx, st, ctx.cp).wprime, Infinity);
  const P = new Float32Array(100).fill(ctx.cp), wb = new Float64Array(101).fill(0);
  assert.equal(PYR.sim.wprimeTimeLeft(P, wb, ctx.cp, 100, { step: 1 })[50], Infinity);
});

test('durée tenable du jeu : un sprint au départ ne fige pas le temps à 0:01 (la NP depuis le départ n\'est pas une limite du jeu)', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 60000, grade: 0 }]));
  const me = Race.addRider(race, { id: 'me', name: 'A', setup, athlete, v0: 0 });
  Tac.setMode(me, 'manual', 0);
  me.tac.cmd = 380;                       // trop fort : le limiteur de la course tient le coureur à la courbe record
  for (let i = 0; i < 1500; i++) Race.step(race);
  let p = 0; for (let k = 0; k < 5; k++) { Race.step(race); p += me.lastP / 5; }
  assert.ok(p > 100 && p < 300, `puissance tenue ${p} W`);
  // la NP depuis le départ dépasse le record de la durée (sprint initial) : avec la règle de l'optimiseur le temps est nul…
  assert.ok(PYR.sim.timeToExhaustion(me.ctx, me.st, p, undefined, { total: true }).record <= 5);
  // …mais le jeu ne l'impose pas : seules les fenêtres glissantes limitent, et le temps restant évolue avec l'effort
  const t1 = Race.timeToExhaustion(me, p);
  assert.ok(t1.record > 300, `${t1.record} s : ne doit pas être figé à ~1 s`);
  assert.equal(t1.wprime, Infinity, 'sous la PC, W′ ne limite pas');
  assert.equal(t1.by, t1.fuel !== undefined && t1.fuel < t1.record ? 'fuel' : 'record');
  const rec1 = t1.record;
  for (let k = 0; k < 120; k++) Race.step(race);
  assert.notEqual(Race.timeToExhaustion(me, p).record, rec1, 'le temps restant change quand l\'effort se poursuit');
  assert.ok(Number.isFinite(Race.timeToExhaustion(me, me.ctx.cp + 100).wprime));
});

test('dans les roues : le suiveur tient la roue et économise ≈ 30 % de puissance aéro', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 8000, grade: 0 }]));
  const lead = Race.addRider(race, { id: 'lead', name: 'A', setup, athlete, v0: 10 });
  const foll = Race.addRider(race, { id: 'foll', name: 'B', setup, athlete, v0: 10 });
  lead.st.s = 20; foll.st.s = 15;
  Tac.setMode(lead, 'threshold', 0);
  Tac.setMode(foll, 'follow', 0);
  for (let i = 0; i < 400; i++) Race.step(race);
  const gap = lead.st.s - foll.st.s - Dr.BIKE;
  assert.ok(gap > 0.1 && gap < 1.5, `écart entre les roues ${gap.toFixed(2)} m`);
  const pl = lead.stats.sumP, pf = foll.stats.sumP;
  assert.ok(pf < 0.85 * pl, `suiveur ${Math.round(pf / 400)} W vs meneur ${Math.round(pl / 400)} W`);
  assert.ok(foll.stats.savedJ > 20000, `économisé ${Math.round(foll.stats.savedJ / 1000)} kJ`);
  assert.ok(foll.stats.shelteredS > 350);
});

test('dans les roues : revenir sur une roue sans à-coups ni freinage, effort borné', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 8000, grade: 0 }]));
  const lead = Race.addRider(race, { id: 'lead', name: 'A', setup, athlete, v0: 9 });
  const foll = Race.addRider(race, { id: 'foll', name: 'B', setup, athlete, v0: 9 });
  lead.st.s = 40;
  Tac.setMode(lead, 'tempo', 0);
  Tac.setMode(foll, 'follow', 0);
  const cap = 1.3 * athlete.mmp(180);
  let brakes = 0, caught = -1;
  for (let i = 0; i < 180; i++) {
    Race.step(race);
    if (foll.st.braking) brakes++;
    if (caught < 0 && foll.draft.role === 'follow' && foll.draft.gapAhead < 1) caught = race.t;
  }
  assert.ok(caught > 0 && caught < 90, `roue reprise après ${caught} s`);
  assert.equal(brakes, 0, 'pas de coup de frein en arrivant dans la roue');
  assert.ok(foll.stats.pMax <= cap + 1, `pic ${Math.round(foll.stats.pMax)} W, plafond ${Math.round(cap)} W`);
  const gap = lead.st.s - foll.st.s - Dr.BIKE;
  assert.ok(gap > 0.1 && gap < 1.5, `écart final ${gap.toFixed(2)} m`);
});

test('dans les roues : on laisse filer une attaque, et en tête on se relève pour prendre une roue', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 12000, grade: 0 }]));
  const a = Race.addRider(race, { id: 'a', name: 'A', setup, athlete, v0: 10 });
  const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 10 });
  const b = Race.addRider(race, { id: 'b', name: 'B', setup, athlete, v0: 10 });
  a.st.s = 24.8; me.st.s = 22.4; b.st.s = 20; // A devant, moi dans sa roue, B dans la mienne
  Tac.setMode(a, 'tempo', 0);
  Tac.setMode(me, 'follow', 0);
  Tac.setMode(b, 'follow', 0);
  for (let i = 0; i < 40; i++) Race.step(race);
  assert.equal(me.draft.role, 'follow');
  // A attaque : on reste avec B plutôt que de s'épuiser à le suivre
  Tac.setMode(a, 'attack', race.t);
  let pMax = 0;
  for (let i = 0; i < 60; i++) { Race.step(race); pMax = Math.max(pMax, me.lastP); }
  assert.ok(a.st.s - me.st.s > 40, `l'attaquant est parti : ${Math.round(a.st.s - me.st.s)} m`);
  assert.ok(pMax <= 1.3 * athlete.mmp(180) + 1, `effort ${Math.round(pMax)} W`);
  assert.ok(Math.abs(me.st.s - b.st.s) < 10, 'toujours avec B');
  assert.ok(me.st.wbal > 0.8 * me.ctx.w0, `W′ préservé : ${Math.round((100 * me.st.wbal) / me.ctx.w0)} %`);
  assert.match(Tac.describe(me, {}), /Dans les roues/);
  // en tête, B juste derrière passe au seuil : on se relève et on prend sa roue
  Tac.setMode(b, 'threshold', race.t);
  let took = -1, eased = false;
  for (let i = 0; i < 60 && took < 0; i++) {
    Race.step(race);
    if (me.tac.phase === 'ease' || me.tac.phase === 'tuck') eased = true;
    if (me.tac.wheel === 'b' && me.draft.role === 'follow') took = i;
  }
  assert.ok(eased && took >= 0, `roue de B prise après ${took} s`);
});

test('dans les roues au départ groupé : on se glisse dans une roue, sans pic ni freinage', () => {
  const prof = makeProfile([{ len: 6000, grade: 0 }]);
  const { race, setup, athlete } = newRace(prof, {}, 7);
  const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 0 });
  Race.addBots(race, { n: 3, level: 'equal', rider: DEFAULT_RIDER, bike: DEFAULT_BIKE, v0: 0 });
  Tac.setMode(me, 'follow', 0);
  let sheltered = 0, brakes = 0;
  for (let i = 0; i < 180; i++) {
    Race.step(race);
    if (i >= 30 && me.draft.role === 'follow') sheltered++;
    if (me.st.braking) brakes++;
  }
  assert.ok(me.stats.pMax <= 1.3 * athlete.mmp(180) + 1, `pic ${Math.round(me.stats.pMax)} W`);
  assert.ok(sheltered > 0.8 * 150, `abrité ${sheltered} s sur 150`);
  assert.equal(brakes, 0);
  assert.ok(me.st.wbal > 0.7 * me.ctx.w0, `W′ ${Math.round((100 * me.st.wbal) / me.ctx.w0)} %`);
});

test('dans les roues, en tête devant un suiveur qui ne relaie pas : on roule au tempo, sans faire du sur-place', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 8000, grade: 0 }]));
  const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 10 });
  const b = Race.addRider(race, { id: 'b', name: 'B', setup, athlete, v0: 10 });
  me.st.s = 22.4; b.st.s = 20;
  Tac.setMode(me, 'follow', 0);
  Tac.setMode(b, 'follow', 0);
  let sum = 0;
  for (let i = 0; i < 90; i++) { Race.step(race); if (i >= 30) sum += me.lastP; }
  const tempo = Tac.steadyPower(me, 'tempo');
  assert.ok(sum / 60 > 0.95 * tempo, `${Math.round(sum / 60)} W pour un tempo à ${Math.round(tempo)} W`);
  assert.match(Tac.describe(me, {}), /personne ne relaie/);
  assert.equal(b.draft.role, 'follow');
});

test('dans les roues, seul avec un attaquant : on le suit, à 1,3 × PMA au plus', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 12000, grade: 0 }]));
  const a = Race.addRider(race, { id: 'a', name: 'A', setup, athlete, v0: 10 });
  const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 10 });
  a.st.s = 24.8; me.st.s = 22.4;
  Tac.setMode(a, 'tempo', 0);
  Tac.setMode(me, 'follow', 0);
  for (let i = 0; i < 40; i++) Race.step(race);
  Tac.setMode(a, 'attack', race.t);
  let pMax = 0;
  for (let i = 0; i < 60; i++) { Race.step(race); pMax = Math.max(pMax, me.lastP); }
  const gap = a.st.s - me.st.s - Dr.BIKE;
  assert.ok(gap < 3, `de retour dans la roue : ${gap.toFixed(1)} m`);
  assert.ok(pMax <= 1.3 * athlete.mmp(180) + 1, `effort ${Math.round(pMax)} W`);
  assert.ok(me.st.wbal / me.ctx.w0 > a.st.wbal / a.ctx.w0, 'moins entamé que l\'attaquant');
});

test('suivre les attaques : on saute dans la roue de l\'attaquant, là où « dans les roues » le laisse filer', () => {
  const run = (mode) => {
    const { race, setup, athlete } = newRace(makeProfile([{ len: 12000, grade: 0 }]));
    const a = Race.addRider(race, { id: 'a', name: 'A', setup, athlete, v0: 10 });
    const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 10 });
    const b = Race.addRider(race, { id: 'b', name: 'B', setup, athlete, v0: 10 });
    a.st.s = 24.8; me.st.s = 22.4; b.st.s = 20; // A devant, moi dans sa roue, B dans la mienne
    Tac.setMode(a, 'tempo', 0);
    Tac.setMode(me, mode, 0);
    Tac.setMode(b, 'follow', 0);
    for (let i = 0; i < 40; i++) Race.step(race);
    Tac.setMode(a, 'attack', race.t);
    let pMax = 0, covered = 0;
    for (let i = 0; i < 60; i++) {
      Race.step(race);
      pMax = Math.max(pMax, me.lastP);
      if (i >= 20 && me.draft.role === 'follow' && me.draft.wheel === 'a') covered++;
    }
    return { a, me, pMax, covered, athlete };
  };
  const follow = run('follow'), cover = run('cover');
  assert.ok(follow.a.st.s - follow.me.st.s > 40, 'dans les roues : l\'attaquant est parti');
  assert.ok(cover.a.st.s - cover.me.st.s - Dr.BIKE < 3, `suivre les attaques : écart ${(cover.a.st.s - cover.me.st.s - Dr.BIKE).toFixed(1)} m`);
  assert.ok(cover.covered > 30, `abrité derrière l'attaquant ${cover.covered} s sur 40`);
  assert.ok(cover.pMax <= 1.6 * cover.athlete.mmp(180) + 1, `effort ${Math.round(cover.pMax)} W`);
  assert.ok(cover.me.st.wbal / cover.me.ctx.w0 > cover.a.st.wbal / cover.a.ctx.w0, 'moins entamé que l\'attaquant, grâce à l\'abri');
  assert.match(Tac.describe(cover.me, {}), /Suivre les attaques/);
});

test('suivre les attaques : W′ presque épuisé, on laisse filer l\'attaque', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 12000, grade: 0 }]));
  const a = Race.addRider(race, { id: 'a', name: 'A', setup, athlete, v0: 10 });
  const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 10 });
  a.st.s = 24.8; me.st.s = 22.4;
  Tac.setMode(a, 'tempo', 0);
  Tac.setMode(me, 'cover', 0);
  for (let i = 0; i < 20; i++) Race.step(race);
  me.st.wbal = 0.1 * me.ctx.w0;
  Tac.setMode(a, 'attack', race.t);
  for (let i = 0; i < 40; i++) Race.step(race);
  assert.ok(a.st.s - me.st.s > 40, `l'attaquant est parti : ${Math.round(a.st.s - me.st.s)} m`);
  assert.ok(me.lastP <= me.ctx.cp + 1, `à la puissance critique : ${Math.round(me.lastP)} W`);
});

test('suivre les attaques : on remonte aux premières places du groupe, abrité et sans freiner', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 20000, grade: 0 }]));
  const n = 30;
  const riders = [];
  for (let i = 0; i < n; i++) { // une file derrière un meneur au seuil : le coureur testé est 26ᵉ
    const r = Race.addRider(race, { id: i === 25 ? 'me' : 'r' + i, name: 'R' + i, setup, athlete, v0: 11 });
    r.st.s = 80 - i * 2.4;
    Tac.setMode(r, i === 25 ? 'cover' : i === 0 ? 'threshold' : 'follow', 0);
    riders.push(r);
  }
  const me = riders[25];
  let placed = -1, brakes = 0, pMax = 0, sheltered = 0;
  for (let i = 0; i < 300; i++) {
    Race.step(race);
    if (me.st.braking) brakes++;
    pMax = Math.max(pMax, me.lastP);
    if (me.draft.role === 'follow') sheltered++;
    if (placed < 0 && me.draft.rank <= Tac.frontPlaces(n)) placed = i;
  }
  assert.ok(placed >= 0 && placed < 200, `aux places de tête (≤ ${Tac.frontPlaces(n) + 1}ᵉ) après ${placed} s`);
  assert.ok(me.draft.rank <= Tac.frontPlaces(n), `rang final ${me.draft.rank + 1}`);
  assert.ok(pMax <= 1.3 * athlete.mmp(180), `effort ${Math.round(pMax)} W`);
  assert.ok(sheltered > 0.8 * 300, `abrité ${sheltered} s sur 300`);
  assert.ok(brakes <= 3, `${brakes} s de freinage`);
  // on ne reste pas devant à faire le travail : quand on se retrouve en tête, on se relève
  assert.ok(me.stats.sumP / 300 < 0.95 * athlete.ftp, `${Math.round(me.stats.sumP / 300)} W de moyenne`);
});

test('suivre les attaques : places de tête selon la taille du groupe', () => {
  assert.equal(Tac.frontPlaces(2), 2);
  assert.equal(Tac.frontPlaces(10), 2);
  assert.equal(Tac.frontPlaces(20), 3);
  assert.equal(Tac.frontPlaces(90), 5);
});

test('dans les roues : dans le final, on suit le sprint jusqu\'à la ligne, même en groupe', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 3000, grade: 0 }]));
  const a = Race.addRider(race, { id: 'a', name: 'A', setup, athlete, v0: 11 });
  const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 11 });
  const b = Race.addRider(race, { id: 'b', name: 'B', setup, athlete, v0: 11 });
  a.st.s = 2400; me.st.s = 2397.6; b.st.s = 2395.2;
  Tac.setMode(a, 'tempo', 0);
  Tac.setMode(me, 'follow', 0);
  Tac.setMode(b, 'follow', 0);
  for (let i = 0; i < 200 && !me.finished; i++) {
    if (a.tac.mode === 'tempo' && race.course.length - a.st.s < 350) Tac.setMode(a, 'sprint', race.t);
    Race.step(race);
  }
  assert.ok(me.time - a.time < 0.5, `arrivée ${(me.time - a.time).toFixed(2)} s derrière le sprinteur`);
});

test('dans les roues : en bas d\'une descente, la roue ralentit et on la suit sans à-coup', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 1500, grade: -0.05 }, { len: 2500, grade: 0 }]));
  const a = Race.addRider(race, { id: 'a', name: 'A', setup, athlete, v0: 14 });
  const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 14 });
  a.st.s = 24.8; me.st.s = 22.4;
  Tac.setMode(a, 'tempo', 0);
  Tac.setMode(me, 'follow', 0);
  let pMax = 0, brakes = 0;
  for (let i = 0; i < 200; i++) {
    Race.step(race);
    if (me.st.s > 1300 && me.st.s < 1900) { pMax = Math.max(pMax, me.lastP); if (me.st.braking) brakes++; }
  }
  assert.ok(pMax < 300, `pas de relance au bas de la descente : ${Math.round(pMax)} W`);
  assert.ok(brakes <= 5, `${brakes} s de freinage`);
  assert.equal(me.draft.role, 'follow');
});

test('relais : les coureurs qui collaborent passent en tête à tour de rôle et dépensent moins', () => {
  const prof = makeProfile([{ len: 20000, grade: 0 }]);
  const { race, setup, athlete } = newRace(prof, { pullSec: 30 });
  const riders = [];
  for (let i = 0; i < 4; i++) {
    const r = Race.addRider(race, { id: 'r' + i, name: 'R' + i, setup, athlete, v0: 11 });
    r.st.s = 10 - i * 2.4;
    Tac.setMode(r, 'relay', 0);
    riders.push(r);
  }
  Race.runToEnd(race);
  for (const r of riders) assert.ok(r.tac.pulls >= 3, `${r.id} : ${r.tac.pulls} relais`);
  const times = riders.map((r) => r.time);
  assert.ok(Math.max(...times) - Math.min(...times) < 20, `groupe resté groupé : ${times.map(Math.round)}`);
  // reprendre la roue après son relais : un court effort (≈ 2 × FTP pendant 2 s), pas un sprint
  for (const r of riders) assert.ok(r.stats.pMax < 2.2 * r.athlete.ftp, `${r.id} : pic ${Math.round(r.stats.pMax)} W`);
  // seul, en menant tout le temps à la même puissance de relais
  const solo = newRace(prof);
  const s = Race.addRider(solo.race, { id: 's', name: 'S', setup: solo.setup, athlete: solo.athlete, v0: 11 });
  Tac.setMode(s, 'relay', 0);
  Race.runToEnd(solo.race);
  const avg = (r) => r.stats.sumP / r.st.t;
  const groupP = riders.reduce((a, r) => a + avg(r), 0) / riders.length;
  assert.ok(Math.max(...times) <= 1.01 * s.time, `groupe ${Math.round(Math.max(...times))} s vs seul ${Math.round(s.time)} s`);
  assert.ok(groupP < 0.85 * avg(s), `puissance moyenne en groupe ${Math.round(groupP)} W vs seul ${Math.round(avg(s))} W`);
});

test('limites « W′ > » et « PPR < » : on se laisse décrocher plutôt que de les franchir', () => {
  // l'attaquant part, le joueur suit les attaques ; seul le réglage des limites change
  const run = (lim) => {
    const { race, setup, athlete } = newRace(makeProfile([{ len: 12000, grade: 0 }]));
    const a = Race.addRider(race, { id: 'a', name: 'A', setup, athlete, v0: 10 });
    const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 10 });
    a.st.s = 24.8; me.st.s = 22.4;
    Tac.setMode(a, 'tempo', 0);
    Tac.setMode(me, 'cover', 0);
    Object.assign(me.tac, lim);
    for (let i = 0; i < 40; i++) Race.step(race);
    Tac.setMode(a, 'attack', race.t);
    let minW = 1, maxUse = 0, said = false;
    for (let i = 0; i < 90; i++) {
      Race.step(race);
      minW = Math.min(minW, me.st.wbal / me.ctx.w0);
      maxUse = Math.max(maxUse, PYR.sim.recordUsage(me.ctx, me.st).use);
      if (/limite W′ ou PPR/.test(Tac.describe(me, {}))) said = true;
    }
    return { gap: a.st.s - me.st.s - Dr.BIKE, minW, maxUse, said };
  };
  const free = run({});
  assert.ok(free.gap < 3 && free.minW < 0.85 && free.maxUse > 0.6, `sans limite : on suit (écart ${free.gap.toFixed(1)} m, W′ ${free.minW.toFixed(2)}, PPR ${free.maxUse.toFixed(2)})`);
  // limites que l'effort n'atteint pas : rien ne change
  const loose = run({ wLimit: 0.6, pprLimit: 0.8 });
  assert.ok(Math.abs(loose.gap - free.gap) < 0.5 && loose.minW === free.minW, 'limites larges : même course');
  // W′ > 90 % : l'effort est coupé à la puissance qui ferait passer W′ sous 90 %
  const w = run({ wLimit: 0.9 });
  assert.ok(w.minW >= 0.89, `W′ conservé : ${w.minW.toFixed(2)}`);
  assert.ok(w.gap > 40 && w.said, `décroché de ${w.gap.toFixed(0)} m`);
  // PPR < 50 % : la part de la courbe de puissance record utilisée ne dépasse pas 50 %
  const p = run({ pprLimit: 0.5 });
  assert.ok(p.maxUse <= 0.51, `PPR utilisé : ${p.maxUse.toFixed(2)}`);
  assert.ok(p.gap > 40 && p.said, `décroché de ${p.gap.toFixed(0)} m`);
  // puissance maximale calculée par le simulateur : sans limite, rien ; à la limite de W′, la puissance critique
  const { race, setup, athlete } = newRace(makeProfile([{ len: 1000, grade: 0 }]));
  const r = Race.addRider(race, { id: 'r', name: 'R', setup, athlete, v0: 10 });
  assert.equal(PYR.sim.limitCap(r.ctx, r.st, 0, 1), Infinity);
  r.st.wbal = 0.3 * r.ctx.w0;
  assert.ok(Math.abs(PYR.sim.limitCap(r.ctx, r.st, 0.3, 1) - r.ctx.cp) < 1, 'à la limite de W′ : la puissance critique');
  r.st.wbal = 0.5 * r.ctx.w0;
  assert.ok(Math.abs(PYR.sim.limitCap(r.ctx, r.st, 0.3, 1) - (r.ctx.cp + 0.2 * r.ctx.w0)) < 1, 'PC + ce qui dépasse la limite');
});

test('couches tactiques : suivre, suivre les attaques et relais s\'activent indépendamment', () => {
  const { race, setup, athlete } = newRace(makeProfile([{ len: 5000, grade: 0 }]));
  const me = Race.addRider(race, { id: 'me', name: 'Moi', human: true, setup, athlete, v0: 10 });
  const on = () => { const l = Tac.layersOf(me); return `${me.tac.mode}:${+l.follow}${+l.cover}${+l.relay}`; };
  Tac.setMode(me, 'tempo', 0);
  assert.equal(on(), 'tempo:000');
  Tac.toggleLayer(me, 'cover', 1);          // « Suivre les attaques » seul : actif sans « Suivre »
  assert.equal(on(), 'cover:010');
  Tac.toggleLayer(me, 'follow', 2);         // + « Suivre »
  assert.equal(on(), 'cover:110');
  Tac.toggleLayer(me, 'relay', 3);          // + « Relais » : la couche dominante est le relais
  assert.equal(on(), 'relay:111');
  Tac.toggleLayer(me, 'cover', 4);
  assert.equal(on(), 'relay:101');
  Tac.toggleLayer(me, 'follow', 5);
  assert.equal(on(), 'relay:001');
  Tac.toggleLayer(me, 'relay', 6);          // plus aucune couche : retour au manuel
  assert.equal(on(), 'manual:000');
  // setMode('cover') garde le sens d'avant : dans les roues + suivre les attaques
  Tac.setMode(me, 'cover', 7);
  assert.equal(on(), 'cover:110');
  Tac.toggleLayer(me, 'cover', 8);
  assert.equal(on(), 'follow:100');
  // un sprint rend les couches d'avant la ligne
  Tac.toggleLayer(me, 'relay', 9);
  Tac.sprintTap(me, 10, null);
  assert.equal(me.tac.mode, 'sprint');
  assert.equal(on(), 'sprint:000');
  Tac.afterLine(me, 20);
  assert.equal(on(), 'relay:101');
  assert.match(Tac.describe(me, { pullSec: 30 }), /^Relayer \+ Dans les roues/);
});

test('relais + suivre : dans les roues du relais on suit jusqu\'aux limites, en tête on mène pendant la durée du relais', () => {
  const run = (layers, lim) => {
    const { race, setup, athlete } = newRace(makeProfile([{ len: 20000, grade: 0 }]), { pullSec: 30 }, 3);
    const riders = [];
    for (let i = 0; i < 4; i++) {
      const r = Race.addRider(race, { id: i === 0 ? 'me' : 'b' + i, name: 'R' + i, human: i === 0, setup, athlete, v0: 11 });
      r.st.s = 10 - i * 2.4;
      if (i > 0) Tac.setMode(r, 'relay', 0);
      riders.push(r);
    }
    const me = riders[0];
    Tac.setMode(me, 'manual', 0);
    for (const l of layers) Tac.toggleLayer(me, l, 0);
    Object.assign(me.tac, lim);
    let maxGap = 0, inPull = 0;
    for (let i = 0; i < 180; i++) {
      Race.step(race);
      maxGap = Math.max(maxGap, Math.max(...riders.map((r) => r.st.s)) - me.st.s);
      if (me.tac.phase === 'pull') inPull++;
    }
    return { me, maxGap, inPull };
  };
  const relay = run(['relay'], {}), both = run(['relay', 'follow'], {});
  assert.ok(both.me.tac.pulls >= 2 && both.inPull > 30, `relais + suivre : ${both.me.tac.pulls} relais, ${both.inPull} s en tête`);
  assert.ok(both.maxGap < 15, `reste dans le groupe : ${both.maxGap.toFixed(0)} m`);
  assert.equal(both.inPull, relay.inPull, 'les mêmes relais qu\'avec « Relais » seul tant qu\'aucune limite n\'est franchie');
  // une limite PPR très basse : dans les roues, on se laisse décrocher (« Suivre » coché) ; « Relais » seul ne connaît pas les limites
  const tight = run(['relay', 'follow'], { pprLimit: 0.05 });
  assert.ok(tight.maxGap > 40, `décroché de ${tight.maxGap.toFixed(0)} m`);
  const ignored = run(['relay'], { pprLimit: 0.05 });
  assert.ok(ignored.maxGap < 15, `« Relais » seul : pas de limite (${ignored.maxGap.toFixed(0)} m)`);
  // « Suivre les attaques » seul : la puissance de la jauge, sauf quand ça attaque
  const { race, setup, athlete } = newRace(makeProfile([{ len: 12000, grade: 0 }]));
  const a = Race.addRider(race, { id: 'a', name: 'A', setup, athlete, v0: 10 });
  const me = Race.addRider(race, { id: 'me', name: 'Moi', human: true, setup, athlete, v0: 10 });
  a.st.s = 24.8; me.st.s = 22.4;
  Tac.setMode(a, 'tempo', 0);
  Tac.setMode(me, 'manual', 0);
  me.tac.cmd = 150;
  Tac.toggleLayer(me, 'cover', 0);
  for (let i = 0; i < 20; i++) Race.step(race);
  assert.ok(Math.abs(me.lastP - 150) < 5, `puissance de la jauge : ${Math.round(me.lastP)} W`);
  Tac.setMode(a, 'attack', race.t);
  for (let i = 0; i < 40; i++) Race.step(race);
  assert.ok(a.st.s - me.st.s - Dr.BIKE < 5, `saute dans la roue de l'attaquant : ${(a.st.s - me.st.s - Dr.BIKE).toFixed(1)} m`);
});

test('relais : la durée va de 5 à 300 s, puis « inf » (0 en interne : sans limite de durée)', () => {
  assert.equal(Race.normRules({}).pullSec, 30);
  assert.equal(Race.normRules({ pullSec: 0 }).pullSec, 0);
  assert.equal(Race.normRules({ pullSec: 250 }).pullSec, 250);
  assert.equal(Race.normRules({ pullSec: 999 }).pullSec, 300);
  assert.equal(Race.normRules({ pullSec: -5 }).pullSec, 5);
  assert.equal(Race.normRules({ pullSec: 2 }).pullSec, 5, 'pas de relais de moins de 5 s');
  assert.equal(Race.normRules({ pullSec: 0.4 }).pullSec, 5);
  assert.equal(Race.normRules({ pullSec: 'abc' }).pullSec, 30);
  // sans limite de durée : celui qui mène ne cède qu'avec « Passer le relais » ou sa limite W′ / PPR
  const prof = makeProfile([{ len: 20000, grade: 0 }]);
  const run = (pullSec) => {
    const { race, setup, athlete } = newRace(prof, { pullSec }, 3);
    const riders = [];
    for (let i = 0; i < 4; i++) {
      const r = Race.addRider(race, { id: 'r' + i, name: 'R' + i, human: i === 0, setup, athlete, v0: 11 });
      r.st.s = 10 - i * 2.4;
      Tac.setMode(r, 'relay', 0);
      riders.push(r);
    }
    const me = riders[0];
    let longest = 0, cur = 0;
    for (let i = 0; i < 240; i++) {
      Race.step(race);
      if (me.tac.phase === 'pull') { cur++; longest = Math.max(longest, cur); } else cur = 0;
    }
    return { me, longest, text: Tac.describe(me, race.rules) };
  };
  const unlimited = run(0);
  assert.ok(unlimited.longest >= 200 && unlimited.me.tac.pulls === 1, `sans limite : ${unlimited.longest} s en tête de suite`);
  assert.match(unlimited.text, /sans limite de durée/);
  const long = run(300);
  assert.ok(long.longest >= 200, `300 s : ${long.longest} s en tête de suite`);
  assert.ok(run(20).longest <= 20, 'relais de 20 s : jamais plus de 20 s de suite');
  // « Passer le relais » libère quand même le meneur sans limite de durée
  const { race, setup, athlete } = newRace(prof, { pullSec: 0 }, 3);
  const riders = [];
  for (let i = 0; i < 3; i++) {
    const r = Race.addRider(race, { id: 'r' + i, name: 'R' + i, setup, athlete, v0: 11 });
    r.st.s = 10 - i * 2.4;
    Tac.setMode(r, 'relay', 0);
    riders.push(r);
  }
  for (let i = 0; i < 10; i++) Race.step(race);
  assert.equal(Tac.passRelay(riders[0], race.t), true);
  for (let i = 0; i < 5; i++) Race.step(race);
  assert.notEqual(riders[0].tac.phase, 'pull');
});

test('relais : « W′ > » et « PPR < » du relais, on laisse le relais dès qu\'une limite est atteinte', () => {
  const run = (lim) => {
    const { race, setup, athlete } = newRace(makeProfile([{ len: 20000, grade: 0 }]), { pullSec: 30 }, 3);
    const riders = [];
    for (let i = 0; i < 4; i++) {
      const r = Race.addRider(race, { id: i === 0 ? 'me' : 'b' + i, name: 'R' + i, human: i === 0, setup, athlete, v0: 11 });
      r.st.s = 10 - i * 2.4;
      Tac.setMode(r, 'relay', 0);
      riders.push(r);
    }
    const me = riders[0];
    Object.assign(me.tac, lim);
    let inPull = 0, said = false;
    for (let i = 0; i < 240; i++) {
      Race.step(race);
      if (me.tac.phase === 'pull') inPull++;
      if (/tu laisses le relais/.test(Tac.describe(me, { pullSec: 30 }))) said = true;
    }
    return { inPull, said, gap: Math.max(...riders.map((r) => r.st.s)) - me.st.s };
  };
  const free = run({});
  assert.ok(free.inPull >= 50 && !free.said, `sans limite : ${free.inPull} s en tête`);
  // limites que l'effort n'atteint pas : rien ne change
  const loose = run({ relayW: 0.9, relayPpr: 0.8 });
  assert.equal(loose.inPull, free.inPull, 'limites larges : mêmes relais');
  // W′ > 99,5 % : mener à la puissance de relais entame un peu W′, on laisse le relais aussitôt
  const w = run({ relayW: 0.995 });
  assert.ok(w.said && w.inPull < free.inPull, `W′ : ${w.inPull} s en tête au lieu de ${free.inPull}`);
  // PPR < 50 % : même chose avec la part de la courbe de puissance record utilisée
  const p = run({ relayPpr: 0.5 });
  assert.ok(p.said && p.inPull < free.inPull, `PPR : ${p.inPull} s en tête au lieu de ${free.inPull}`);
  assert.ok(w.gap < 15 && p.gap < 15, 'on reste dans le groupe en laissant le relais');
});

test('relais : « passer le relais » libère le meneur tout de suite, et la durée d\'un relais se règle en cours de route', () => {
  const prof = makeProfile([{ len: 20000, grade: 0 }]);
  const { race, setup, athlete } = newRace(prof, { pullSec: 60 });
  const riders = [];
  for (let i = 0; i < 4; i++) {
    const r = Race.addRider(race, { id: 'r' + i, name: 'R' + i, setup, athlete, v0: 11 });
    r.st.s = 10 - i * 2.4;
    Tac.setMode(r, 'relay', 0);
    riders.push(r);
  }
  const me = riders[0];
  assert.equal(Tac.passRelay(riders[1], 0), false, 'pas en tête : rien à passer');
  for (let i = 0; i < 6; i++) Race.step(race);
  assert.equal(me.tac.phase, 'pull', 'en tête du groupe');
  assert.ok(me.st.t < 20 && race.rules.pullSec === 60, 'relais de 60 s : loin d\'être fini');
  assert.equal(Tac.passRelay(me, me.st.t), true);
  assert.equal(me.tac.phase, 'swing');
  for (let i = 0; i < 3; i++) Race.step(race);
  assert.notEqual(me.tac.phase, 'pull', `libéré après ${me.st.t} s, bien avant 60 s`);
  assert.ok(riders.some((r) => r !== me && r.tac.phase === 'pull'), 'un autre mène');
  // une autre tactique : « passer le relais » n'a aucun effet
  Tac.setMode(me, 'follow', me.st.t);
  assert.equal(Tac.passRelay(me, me.st.t), false);
  // durée plus courte en cours de route : le meneur suivant est relevé plus vite
  race.rules.pullSec = 10;
  const lead = riders.find((r) => r.tac.phase === 'pull'), since = lead.tac.phaseT;
  for (let i = 0; i < 40 && lead.tac.phase === 'pull'; i++) Race.step(race);
  assert.notEqual(lead.tac.phase, 'pull', 'relevé');
  assert.ok(lead.st.t - since < 20, `relais de ${Math.round(lead.st.t - since)} s avec une durée réglée à 10 s`);
});

test('incidents : une crevaison arrête le coureur, tirages reproductibles avec la même graine', () => {
  const prof = makeProfile([{ len: 3000, grade: 0 }]);
  const { race, setup, athlete } = newRace(prof, { events: true });
  const r = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 10 });
  Tac.setMode(r, 'tempo', 0);
  for (let i = 0; i < 20; i++) Race.step(race);
  const ev = Race.incident(race, r, 'puncture');
  const s0 = r.st.s;
  for (let i = 0; i < ev.dur - 1; i++) Race.step(race);
  assert.equal(r.st.s, s0, 'arrêté pendant le dépannage');
  for (let i = 0; i < 10; i++) Race.step(race);
  assert.ok(r.st.s > s0, 'reparti');
  // même graine → mêmes incidents et mêmes temps (parcours pavé pour provoquer des incidents)
  const run = () => {
    const x = newRace(makeProfile([{ len: 60000, grade: 0 }]), { events: true }, 42);
    x.race.course.punctR.fill(4); x.race.course.crashR.fill(3);
    const bots = Race.addBots(x.race, { n: 4, level: 'mixed', rider: DEFAULT_RIDER, bike: DEFAULT_BIKE, v0: 5 });
    Race.runToEnd(x.race);
    return { ev: x.race.events.filter((e) => e.type !== 'finish').map((e) => `${e.id}:${e.type}@${e.t}`), times: bots.map((b) => Math.round(b.time)) };
  };
  const a = run(), b = run();
  assert.deepEqual(a, b);
  assert.ok(a.ev.some((e) => /puncture|crash|sealed/.test(e)), `aucun incident sur 60 km de pavés : ${a.ev}`);
});

test('coureurs virtuels : course vallonnée complète, classement cohérent, énergie et forme', () => {
  const prof = makeProfile([{ len: 5000, grade: 0 }, { len: 3000, grade: 0.06 }, { len: 3000, grade: -0.05 }, { len: 6000, grade: 0 }]);
  const { race } = newRace(prof, { events: false, fuel: true, form: true }, 11);
  const bots = Race.addBots(race, { n: 6, level: 'mixed', rider: DEFAULT_RIDER, bike: DEFAULT_BIKE, v0: 5 });
  Race.runToEnd(race);
  const res = Race.results(race);
  assert.equal(res.length, 6);
  for (const r of bots) {
    assert.ok(r.finished && Number.isFinite(r.time) && r.time > 1200 && r.time < 3000, `${r.name} ${r.time}`);
    assert.ok(r.form && r.form.cpK <= 1);
    assert.ok(r.fuel.G < r.fuel.G0);
  }
  for (let i = 1; i < res.length; i++) assert.ok(res[i].time >= res[i - 1].time);
  const modes = new Set(race.events.map((e) => e.type));
  assert.ok(modes.has('finish'));
});

test('magasin : masses du vélo, article monté, effet de l\'équipement sur la vitesse', () => {
  const Cat = PYR.catalog, Phy = PYR.physics;
  const rider = Object.assign({}, DEFAULT_RIDER), bike = Object.assign({}, DEFAULT_BIKE, { weight: 8.5, wheelMass: 2.2 });
  const sel = {};
  const apply = (cat, id) => { const p = Cat.patchFor(cat, id, rider, bike, sel); Object.assign(rider, p.rider); Object.assign(bike, p.bike); sel[cat] = id; };
  apply('frame', 'climber');
  assert.ok(Math.abs(bike.weight - (5.5 + 2.2)) < 1e-9, `cadre : ${bike.weight}`);
  apply('tires', 'race');
  apply('wheels', 'climb');
  assert.ok(Math.abs(bike.wheelMass - (1.25 + 0.46)) < 1e-9 && Math.abs(bike.weight - (5.5 + 1.25 + 0.46)) < 1e-9, `roues + pneus : ${bike.wheelMass} / ${bike.weight}`);
  assert.equal(bike.frame, 'climber');
  assert.ok(Cat.isMounted('wheels', 'climb', rider, bike));
  bike.wheels = 'deep';
  assert.ok(!Cat.isMounted('wheels', 'climb', rider, bike), 'réglage modifié ailleurs');
  // l'équipement aéro va plus vite sur le plat, le grimpeur plus vite en montée
  const rho = Phy.airDensity(200, 20);
  const speed = (sel2, g) => { const f = Cat.fullSetup(sel2, DEFAULT_RIDER, DEFAULT_BIKE); return Phy.steadySpeed(Phy.buildSetup(f.rider, f.bike), 200, g, 1, rho, 0, 0); };
  const base = {}, aero = { frame: 'aero', wheels: 'c65', helmet: 'aero', suit: 'road', shoes: 'aero' }, climb = { frame: 'climber', wheels: 'climb', tires: 'race' };
  assert.ok(speed(aero, 0) > speed(base, 0) + 1.0 / 3.6, 'aéro : plus de 1 km/h de gagné sur le plat à 200 W');
  assert.ok(speed(climb, 0.08) > speed(aero, 0.08), 'grimpeur plus rapide en montée');
  // pneus : Crr et liquide préventif ; chaussures : puissance transmise
  const tub = Phy.buildSetup(DEFAULT_RIDER, Object.assign({}, DEFAULT_BIKE, { tire: 'tubeless' }));
  assert.ok(tub.sealant && tub.puncture < 1 && tub.crr < 0.0035);
  const flat = Phy.buildSetup(DEFAULT_RIDER, Object.assign({}, DEFAULT_BIKE, { shoes: 'flat' }));
  const road = Phy.buildSetup(DEFAULT_RIDER, DEFAULT_BIKE);
  assert.ok(flat.eta < road.eta && flat.mass > road.mass);
});

test('magasin : chaque article correspond à un réglage de la physique, deux pages, maillot ou combinaison', () => {
  const Cat = PYR.catalog, Phy = PYR.physics;
  const lists = {
    'rider.helmet': Phy.HELMETS, 'rider.clothing': Phy.CLOTHING, 'rider.glasses': Phy.GLASSES, 'rider.socks': Phy.SOCKS,
    'rider.shave': Phy.SHAVE, 'bike.frame': Phy.FRAMES, 'bike.wheels': Phy.WHEELS, 'bike.tire': Phy.TIRES,
    'bike.drivetrain': Phy.DRIVETRAINS, 'bike.shoes': Phy.SHOES,
  };
  for (const c of Cat.CATEGORIES) {
    assert.ok(c.page === 'bike' || c.page === 'rider', c.id);
    assert.ok(Cat.ITEMS[c.id].length >= 2, c.id);
    for (const it of Cat.ITEMS[c.id]) {
      for (const [side, obj] of [['rider', it.rider], ['bike', it.bike]]) {
        for (const [k, v] of Object.entries(obj || {})) {
          const list = lists[`${side}.${k}`];
          assert.ok(list && list.some((x) => x.id === v), `${c.id}/${it.id} : ${side}.${k} = ${v}`);
        }
      }
    }
  }
  assert.deepEqual(Cat.CATEGORIES.filter((c) => c.page === 'rider').map((c) => c.id), ['helmet', 'glasses', 'kit', 'suit', 'socks', 'shoes', 'shave']);
  assert.ok(Cat.rivals('kit', 'suit') && !Cat.rivals('kit', 'helmet'));
  // équipement de base : même CdA que le cycliste par défaut
  const base = Cat.fullSetup({}, DEFAULT_RIDER, DEFAULT_BIKE);
  assert.ok(Math.abs(Phy.buildSetup(base.rider, base.bike).cda - Phy.buildSetup(DEFAULT_RIDER, DEFAULT_BIKE).cda) < 1e-9);
  // lunettes, chaussettes, épilation, jante plate : de petits effets dans le bon sens
  const cda = (r, b) => Phy.buildSetup(Object.assign({}, DEFAULT_RIDER, r), Object.assign({}, DEFAULT_BIKE, b)).cda;
  const ref = cda({}, {});
  assert.ok(cda({ glasses: 'shield' }, {}) < ref && cda({ glasses: 'none' }, {}) > ref);
  assert.ok(cda({ socks: 'aero' }, {}) < ref && cda({ socks: 'short' }, {}) > ref);
  assert.ok(cda({ shave: 'full' }, {}) < cda({ shave: 'legs' }, {}) && cda({ shave: 'legs' }, {}) < ref);
  // sous des manches longues, épiler les bras ne sert plus
  assert.ok(Math.abs(cda({ clothing: 'skinsuit_tt', shave: 'full' }, {}) - cda({ clothing: 'skinsuit_tt', shave: 'legs' }, {})) < 1e-12);
  assert.ok(cda({ clothing: 'skinsuit_tt' }, {}) < cda({ clothing: 'skinsuit' }, {}));
  assert.ok(cda({}, { wheels: 'box' }) > ref);
  const waxed = Phy.buildSetup(DEFAULT_RIDER, Object.assign({}, DEFAULT_BIKE, { drivetrain: 'waxed' }));
  assert.ok(waxed.eta > Phy.buildSetup(DEFAULT_RIDER, DEFAULT_BIKE).eta);
});

test('descentes et montées : la roue se tient sans chevauchement, la rotation continue', () => {
  const prof = makeProfile([{ len: 1500, grade: -0.06 }, { len: 1500, grade: 0.05 }, { len: 1500, grade: -0.04 }, { len: 1500, grade: 0 }]);
  // dans la roue en descente : on freine un peu plutôt que de rouler sur le meneur
  const a = newRace(prof);
  const lead = Race.addRider(a.race, { id: 'lead', name: 'A', setup: a.setup, athlete: a.athlete, v0: 5 });
  const foll = Race.addRider(a.race, { id: 'foll', name: 'B', setup: a.setup, athlete: a.athlete, v0: 5 });
  lead.st.s = 5; foll.st.s = 2;
  Tac.setMode(lead, 'threshold', 0);
  Tac.setMode(foll, 'follow', 0);
  let overlap = 0, sheltered = 0, n = 0;
  while (!lead.finished && n < 2000) {
    Race.step(a.race); n++;
    const d = lead.st.s - foll.st.s;
    if (n > 20 && d < Dr.BIKE - 0.5) overlap++;
    if (foll.draft.role === 'follow') sheltered++;
  }
  assert.equal(overlap, 0, 'jamais côte à côte avec le meneur');
  assert.ok(sheltered > 0.85 * n, `abrité ${sheltered} s sur ${n}`);
  // relais sur parcours vallonné : chacun continue de passer en tête
  const b = newRace(prof, { pullSec: 20 });
  const rs = [0, 1, 2].map((i) => { const r = Race.addRider(b.race, { id: 'r' + i, name: 'R' + i, setup: b.setup, athlete: b.athlete, v0: 8 }); r.st.s = 8 - 2.4 * i; Tac.setMode(r, 'relay', 0); return r; });
  Race.runToEnd(b.race);
  for (const r of rs) assert.ok(r.tac.pulls >= 3, `${r.id} : ${r.tac.pulls} relais`);
});

test('allure endurance : entre récupération et tempo, touche 2, puissance tenue', () => {
  const ids = Tac.MODES.map((m) => m.id);
  assert.deepEqual(ids.slice(0, 3), ['recover', 'endurance', 'tempo']);
  assert.deepEqual(Tac.MODES.map((m) => m.key), ['1', '2', '3', '4', '5', '6', '7', '8', '9', 's']);
  assert.equal(Tac.LABELS.endurance, 'Endurance');
  const { race, setup, athlete } = newRace(makeProfile([{ len: 6000, grade: 0 }]));
  const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 5 });
  const P = (m) => Tac.steadyPower(me, m);
  assert.ok(P('recover') < P('endurance') && P('endurance') < P('tempo'), `${P('recover')} < ${P('endurance')} < ${P('tempo')}`);
  assert.ok(Math.abs(P('endurance') / athlete.ftp - 0.65) < 1e-9);
  // en zone 2 de la physiologie (56–75 % de la FTP)
  assert.equal(Ph.ZONES[Ph.zoneIndex(P('endurance'), athlete.ftp)].label, 'Endurance');
  Tac.setMode(me, 'endurance', 0);
  let sum = 0;
  for (let i = 0; i < 300; i++) { Race.step(race); if (i >= 30) sum += me.lastP; }
  assert.ok(Math.abs(sum / 270 / P('endurance') - 1) < 0.03, `${Math.round(sum / 270)} W pour ${Math.round(P('endurance'))} W`);
});

test('peloton de 90 : 89 coureurs virtuels aux noms et couleurs distincts, course menée à son terme', () => {
  assert.equal(Race.MAX_BOTS, 89);
  assert.equal(new Set(Race.BOT_NAMES).size, Race.BOT_NAMES.length, 'noms uniques');
  const colors = Race.palette(['#1baf7a', '#4a3aa7'], 89);
  assert.equal(colors.length, 89);
  assert.equal(new Set(colors).size, 89, 'couleurs distinctes');
  assert.deepEqual(colors.slice(0, 2), ['#1baf7a', '#4a3aa7']);
  const prof = makeProfile([{ len: 3000, grade: 0 }, { len: 2000, grade: 0.05 }, { len: 3000, grade: -0.04 }, { len: 4000, grade: 0 }]);
  const { race, setup, athlete } = newRace(prof, { events: true, form: true, fuel: true, sprints: 1, kom: true }, 3);
  const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 5 });
  Tac.setMode(me, 'follow', 0);
  const bots = Race.addBots(race, { n: 500, level: 'mixed', rider: DEFAULT_RIDER, bike: DEFAULT_BIKE, v0: 5, colors });
  assert.equal(bots.length, 89, 'plafonné à 89');
  assert.equal(race.riders.length, 90);
  assert.equal(new Set(race.riders.map((r) => r.id)).size, 90);
  const t0 = Date.now();
  Race.runToEnd(race);
  const res = Race.results(race);
  assert.equal(res.length, 90);
  for (const r of res) assert.ok(r.finished && Number.isFinite(r.time) && r.time > 600 && r.time < 3600, `${r.name} ${r.time}`);
  for (let i = 1; i < res.length; i++) assert.ok(res[i].time >= res[i - 1].time);
  // un peloton se forme : l'abri est bien plus fréquent qu'avec peu de coureurs
  const sheltered = bots.reduce((a, r) => a + r.stats.shelteredS / r.st.t, 0) / bots.length;
  assert.ok(sheltered > 0.3, `abrité ${Math.round(sheltered * 100)} % du temps en moyenne`);
  assert.ok(Date.now() - t0 < 20000, 'simulation rapide');
  // 0 ou valeurs absurdes : pas de coureur
  assert.equal(Race.addBots(newRace(prof).race, { n: -3, level: 'equal', rider: DEFAULT_RIDER, bike: DEFAULT_BIKE }).length, 0);
});

test('relais en groupe : se laisser glisser ne fait pas décrocher (on n\'attend pas ceux qui se laissent glisser eux aussi)', () => {
  const prof = makeProfile([{ len: 40000, grade: 0 }]);
  // (nombre de coureurs virtuels, graine) : des départs groupés où plusieurs coureurs en relais se laissent glisser en même temps
  for (const [nBots, seed] of [[8, 2], [8, 3], [15, 5]]) {
    const { course, setup, athlete } = setupFor(prof);
    const race = Race.create({ course, rules: { pullSec: 30 }, seed, gustSeed: 1 });
    const me = Race.addRider(race, { id: 'me', name: 'Moi', human: true, setup, athlete, v0: 11 });
    Race.addBots(race, { n: nBots, level: 'equal', rider: DEFAULT_RIDER, bike: DEFAULT_BIKE, v0: 11, colors: ['#999'] });
    race.riders.forEach((r, i) => { r.st.s = 10 - i * 2.4; });
    Tac.setMode(me, 'relay', 0);
    let swings = 0, worst = 0;
    for (let t = 0; t < 150 && !me.finished; t++) {
      const before = me.tac.phase;
      Race.step(race);
      if (before === 'swing' && me.tac.phase !== 'swing') {
        swings++;
        // à la fin de la glissade, on est dans le groupe : un coureur pas plus loin que 6 m devant (entre les roues)
        let ahead = Infinity;
        for (const o of race.riders) if (o !== me && o.st.s > me.st.s) ahead = Math.min(ahead, o.st.s - me.st.s - Dr.BIKE);
        if (ahead < Infinity) worst = Math.max(worst, ahead);
      }
    }
    assert.ok(swings >= 1, `${nBots} coureurs, graine ${seed} : ${swings} glissades`);
    assert.ok(worst <= 6, `${nBots} coureurs, graine ${seed} : décroché de ${worst.toFixed(1)} m à la fin d'une glissade`);
  }
});

test('relais libre (téléphone) : ni durée, ni limites W′ / PPR pour le joueur, les autres gardent la durée des règles', () => {
  const run = (free) => {
    const { race, setup, athlete } = newRace(makeProfile([{ len: 20000, grade: 0 }]), { pullSec: 20 }, 3);
    const riders = [];
    for (let i = 0; i < 4; i++) {
      const r = Race.addRider(race, { id: i === 0 ? 'me' : 'b' + i, name: 'R' + i, human: i === 0, setup, athlete, v0: 11 });
      r.st.s = 10 - i * 2.4;
      Tac.setMode(r, 'relay', 0);
      riders.push(r);
    }
    const me = riders[0];
    Object.assign(me.tac, { relayW: 0.995, relayPpr: 0.5, relayFree: free });
    let longest = 0, cur = 0, said = false;
    for (let i = 0; i < 240; i++) {
      Race.step(race);
      if (me.tac.phase === 'pull') { cur++; longest = Math.max(longest, cur); } else cur = 0;
      if (/limite W′ ou PPR atteinte/.test(Tac.describe(me, race.rules))) said = true;
    }
    return { longest, said, text: Tac.describe(me, race.rules) };
  };
  const limited = run(false);
  assert.ok(limited.longest <= 20 && limited.said, `avec limites : ${limited.longest} s en tête`);
  const free = run(true);
  assert.ok(free.longest >= 200 && !free.said, `relais libre : ${free.longest} s en tête de suite`);
  assert.match(free.text, /sans limite de durée/);
});
