/* author : Hugo Joudrier-Faure */
/* Tests du peloton en deux dimensions : largeur de route, vent de côté signé, aspiration selon la position latérale,
 * placement des coureurs (groupe large, file indienne, éventail, remontée par le côté, relais), garde-fou et déterminisme. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR, makeProfile, setupFor, DEFAULT_RIDER, DEFAULT_BIKE } = require('./helpers.js');
require(path.join(__dirname, '..', 'js/core/codec.js'));
require(path.join(__dirname, '..', 'js/core/race-data.js'));

const Dr = PYR.draft, Pel = PYR.peloton, Race = PYR.race, Tac = PYR.tactics, Sim = PYR.sim, Ph = PYR.physics, R = PYR.raceData;

/* ---------- largeur de route et vent signé ---------- */

test('largeur de route : par défaut, réglée, selon le revêtement ou saisie sur la portion', () => {
  const prof = makeProfile([{ len: 4000, grade: 0 }]);
  const at = (c, km) => c.width[Math.floor((km * 1000) / c.step)];
  let c = setupFor(prof).course;
  assert.equal(at(c, 1), 6, 'route standard : 6 m');
  c = setupFor(prof, {}, { temperature: 20, roadWidth: 8 }).course;
  assert.equal(at(c, 1), 8);
  c = setupFor(prof, { surfaces: [
    { startKm: 1, endKm: 2, surface: 'cobbles_hard', factor: 3.5 },
    { startKm: 2, endKm: 3, surface: 'dirt', factor: 3, width: 4.5 },
    { startKm: 3, endKm: 3.5, surface: 'asphalt', factor: 1 },
  ] }, { temperature: 20, roadWidth: 7 }).course;
  assert.equal(at(c, 0.5), 7, 'hors portion : la largeur par défaut');
  assert.equal(at(c, 1.5), 3, 'pavés difficiles : 3 m');
  assert.equal(at(c, 2.5), 4.5, 'largeur saisie sur la portion');
  assert.equal(at(c, 3.2), 7, 'asphalte : la largeur par défaut');
  assert.equal(Ph.surfaceWidth({ surface: 'dirt' }, 6), 2.5, 'chemin : 2,5 m');
  assert.equal(Ph.roadWidth(50), Ph.ROAD_W_MAX);
  assert.equal(Ph.roadWidth(''), 6);
});

test('vent de côté signé : positif quand il vient de la droite du coureur, même valeur absolue que wc', () => {
  const prof = makeProfile([{ len: 3000, grade: 0 }], { heading: 0 }); // plein nord
  const env = { temperature: 20 };
  for (const [dir, sign] of [[90, 1], [270, -1]]) {
    const { course, setup, athlete } = setupFor(prof, { winds: [{ startKm: 0, endKm: 3, dir, speed: 36, gusty: false, gust: 0 }] }, env);
    const ctx = Sim.createContext(course, setup, athlete, { seed: 1 });
    const c = Sim.conditions(ctx, 500, 0, {});
    assert.ok(Math.sign(c.wcS) === sign, `vent de ${dir}° : wcS = ${c.wcS}`);
    assert.ok(Math.abs(Math.abs(c.wcS) - c.wc) < 1e-6);
    assert.ok(Math.abs(c.wc - 10) < 0.05, 'vent de travers : 10 m/s de côté');
  }
});

test("largeur de route dans l'empreinte d'un défi : absente ou par défaut, l'empreinte ne change pas", () => {
  const prof = makeProfile([{ len: 3000, grade: 0.02 }]);
  const base = () => ({ surfaces: [{ startKm: 1, endKm: 2, surface: 'cobbles', factor: 2.2, id: 'x' }], winds: [], env: { temperature: 18 }, perf: { cornering: 'normal', vmaxKmh: 80, startSpeedKmh: 0 } });
  const sig0 = R.courseSignature(R.canonicalCourse(prof, base()));
  const s6 = Object.assign(base(), { road: { width: 6 } });
  assert.equal(R.courseSignature(R.canonicalCourse(prof, s6)), sig0, 'largeur par défaut : même empreinte');
  const s8 = Object.assign(base(), { road: { width: 8 } });
  const c8 = R.canonicalCourse(prof, s8);
  assert.equal(c8.env.roadWidth, 8);
  assert.notEqual(R.courseSignature(c8), sig0);
  const sw = base();
  sw.surfaces[0].width = 3.5;
  const cw = R.canonicalCourse(prof, sw);
  assert.equal(cw.surfaces[0].width, 3.5);
  assert.notEqual(R.courseSignature(cw), sig0);
  assert.equal(R.canonicalCourse(prof, base()).surfaces[0].width, undefined);
});

/* ---------- aspiration en deux dimensions ---------- */

const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

test('aspiration 2D : une file dans l\'axe, sans vent, donne exactement le modèle en file', () => {
  for (const n of [2, 3, 5, 8]) {
    const list = [];
    for (let i = 0; i < n; i++) list.push({ id: 'r' + i, s: 100 - i * (Dr.BIKE + 0.3 + 0.2 * i), v: 11, wc: 0, y: 0, tb: 0 });
    const a = Dr.field(list.map((x) => ({ id: x.id, s: x.s, v: x.v, wc: 0 }))), b = Pel.field(list, null);
    for (const x of list) {
      const p = a.get(x.id), q = b.get(x.id);
      assert.ok(near(p.R, q.R), `${n} coureurs, ${x.id} : R ${p.R} vs ${q.R}`);
      for (const k of ['role', 'wheel', 'chain', 'group', 'groupSize', 'rank']) assert.equal(q[k], p[k], `${x.id}.${k}`);
      assert.ok(near(p.gapAhead, q.gapAhead) || p.gapAhead === q.gapAhead);
      assert.ok(near(p.gapBehind, q.gapBehind) || p.gapBehind === q.gapBehind);
    }
  }
});

test('aspiration 2D : décalé du sillage, on perd vite son abri ; côte à côte, aucun', () => {
  const lam = (dy) => Pel.pair(Dr.BIKE + 0.5, dy, 0).lam;
  assert.ok(near(lam(0), 1));
  // cœur étroit (derrière la roue) et épaule large : un peu d'abri en diagonale
  assert.ok(near(lam(0.25), 0.80, 0.02), `0,25 m : ${lam(0.25)}`);
  assert.ok(near(lam(0.5), 0.46, 0.02), `0,5 m : ${lam(0.5)}`);
  assert.ok(near(lam(0.75), 0.26, 0.03), `0,75 m : ${lam(0.75)}`);
  assert.ok(lam(1.5) < 0.1, 'à 1,5 m, presque plus rien');
  // un peu derrière et sur le côté : un abri partiel, bien moindre que dans la roue
  const diag = Pel.pair(Dr.BIKE + 0.3, Pel.LANE, 0).R, inline = Pel.pair(Dr.BIKE + 0.3, 0, 0).R;
  assert.ok(diag > 0.25 * inline && diag < 0.5 * inline, `diagonale ${diag.toFixed(3)} contre ${inline.toFixed(3)} dans la roue`);
  assert.ok(near(Pel.pair(Dr.BIKE + 0.5, 0.3, 0).lam, Pel.pair(Dr.BIKE + 0.5, -0.3, 0).lam), 'symétrique sans vent');
  assert.equal(Pel.pair(0.5, 0.75, 0).R, 0, 'côte à côte : pas d\'abri');
});

/** Bloc de `cols` voies × `rows` rangs (voies écartées de LANE, rangs de `pitch` m), vent de lacet tb. */
function block(cols, rows, pitch, tb) {
  const list = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) list.push({ id: `b${r}_${c}`, s: 200 - r * pitch, v: 12, y: (c - (cols - 1) / 2) * Pel.LANE, tb: tb || 0 });
  }
  return list;
}

test('aspiration 2D : au cœur d\'un peloton compact, l\'abri est bien plus fort que dans une file', () => {
  const f = Pel.field(block(7, 9, 2.2), null);
  const R = (r, c) => f.get(`b${r}_${c}`).R;
  const file = Dr.field(Array.from({ length: 9 }, (_, i) => ({ id: 'f' + i, s: 200 - i * 2.2, v: 12, wc: 0 }))).get('f6').R;
  assert.ok(R(6, 3) >= 0.80 && R(6, 3) <= Pel.MAX_R, `cœur : ${R(6, 3)}`);
  assert.ok(R(6, 3) > file + 0.15, `cœur ${R(6, 3)} contre ${file} en file`);
  assert.ok(R(6, 0) < R(6, 3) - 0.1, `bord ${R(6, 0)} contre cœur ${R(6, 3)}`);
  assert.ok(R(1, 3) >= 0.3 && R(1, 3) <= 0.6, `2e rang : ${R(1, 3)}`);
  assert.ok(R(0, 3) < 0.06, `1er rang : ${R(0, 3)}`);
  // rangs serrés au maximum : plafond, 7 % de la traînée seul (Blocken et al. 2018 : 5 à 10 %)
  const g = Pel.field(block(7, 12, Dr.BIKE + 0.3), null);
  assert.ok(near(g.get('b10_3').R, Pel.MAX_R, 0.03), `plafond : ${g.get('b10_3').R}`);
});

test('aspiration 2D par vent de côté : le sillage part sous le vent, la place décalée abrite mieux', () => {
  const tb = 0.7, dx = Dr.BIKE + 0.6;
  const behind = Pel.pair(dx, 0, tb).R / (1 + 0.5 * tb * tb);
  const shifted = Pel.pair(dx, -0.52, tb).R / (1 + 0.5 * tb * tb);
  const calm = Pel.pair(dx, 0, 0).R;
  assert.ok(behind < 0.6 * calm, `juste derrière : ${behind} (sans vent ${calm})`);
  assert.ok(shifted >= 1.25 * behind && shifted > 0.2, `décalé sous le vent : ${shifted}`);
  assert.ok(near(Pel.pair(dx, 0.4, tb).R, Pel.pair(dx, -0.4, -tb).R), 'vent de gauche : symétrique');
  assert.ok(Pel.pair(dx, 0.52, tb).R < 0.5 * shifted, "côté vent : bien moins qu'à l'abri");
});

/** Éventail idéal (vent de droite, lacet tb) sur une route de largeur w : chacun dans le sillage du précédent, bordure au bord. */
function echelon(n, w, tb) {
  const profile = makeProfile([{ len: 2000, grade: 0 }]);
  const course = setupFor(profile, {}, { temperature: 20, roadWidth: w }).course;
  const hw = Pel.halfWidth(course, 500);
  const list = [];
  let y = hw;
  for (let i = 0; i < n; i++) {
    list.push({ id: 'e' + i, s: 500 - i * (Dr.BIKE + 0.6), v: 12, y, tb });
    y = Math.max(-hw, y - 0.7 * tb);
  }
  return { list, course };
}

test('éventail : la largeur de route limite les abrités, les suivants sont en bordure', () => {
  const tb = 0.7;
  const { list, course } = echelon(14, 3.5, tb);
  const f = Pel.field(list, course);
  const R = list.map((x) => f.get(x.id).R), edge = list.map((x) => f.get(x.id).edge);
  const sheltered = R.filter((x) => x > 0.2).length;
  assert.ok(sheltered >= 4 && sheltered <= 8, `abrités sur 3,5 m : ${sheltered} (${R.map((x) => x.toFixed(2)).join(' ')})`);
  assert.ok(edge.filter(Boolean).length >= 4, `en bordure : ${edge.filter(Boolean).length}`);
  assert.ok(R[12] < 0.2 && edge[12], 'en queue : en bordure, à peine abrité');
  const wide = echelon(14, 8, tb), fw = Pel.field(wide.list, wide.course);
  assert.ok(wide.list.filter((x) => fw.get(x.id).R > 0.2).length > sheltered, 'route large : plus d\'abrités');
});

/* ---------- placement des coureurs : scénarios ---------- */

const BOT = { aggr: 0.2, team: 0.5, level: 1, sprint: 0.5, climb: 0.5 };

/**
 * Course de n coureurs en peloton : un meneur (allure fixe leadMode) et des coureurs virtuels dans les roues (sans décisions
 * tactiques, sauf think), au départ en grille ou en file. o : {n, w (largeur de route), wind {dir, kmh}, grade, surfaces,
 * leadMode, start ('grid' | 'file'), botK (niveau des virtuels), think, seed}.
 */
function pack(o) {
  const { n = 30, w = 6, wind = null, leadMode = 'tempo', seed = 7, grade = 0, start = 'grid', len = 30000, think = false, surfaces = [], botK = 1 } = o || {};
  const profile = makeProfile([{ len, grade }], { heading: 0 }); // plein nord : un vent de 90° vient de la droite
  const portions = { surfaces, winds: wind ? [{ startKm: 0, endKm: len / 1000, dir: wind.dir, speed: wind.kmh, gusty: false, gust: 0 }] : [] };
  const { course, setup, athlete } = setupFor(profile, portions, { temperature: 20, roadWidth: w });
  const race = Race.create({ course, rules: { peloton: true }, seed, gustSeed: 1 });
  const lead = Race.addRider(race, { id: 'lead', name: 'Meneur', setup, athlete, v0: 10 });
  Tac.setMode(lead, leadMode, 0);
  for (let i = 0; i < n - 1; i++) {
    const ath = botK === 1 ? athlete : PYR.physio.scaleAthlete(athlete, botK, botK);
    const r = Race.addRider(race, { id: 'b' + String(i).padStart(2, '0'), name: 'B' + i, setup, athlete: ath, v0: 10, bot: Object.assign({}, BOT) });
    if (!think) r.tac.nextThink = Infinity;
  }
  if (start === 'file') race.riders.forEach((r, k) => { r.st.s = 200 - k * 2.4; r.prevS = r.st.s; });
  else { Pel.grid(race); race.riders.forEach((r) => { r.st.s += 200; r.prevS = r.st.s; }); }
  return race;
}

/** Fait rouler T secondes ; compte les collisions (roues qui se chevauchent dans la même voie) ; cb(race) après chaque seconde. */
function ride(race, T, cb) {
  let coll = 0;
  for (let t = 0; t < T; t++) {
    Race.step(race);
    const rs = race.riders.filter((r) => !r.finished && !r.incident);
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      if (Math.abs(rs[i].st.s - rs[j].st.s) < Dr.BIKE - 0.3 && Math.abs(rs[i].lat.y - rs[j].lat.y) < Pel.MIN_DY - 0.05) coll++;
    }
    if (cb) cb(race);
  }
  return coll;
}

/** Groupes (écart entre les roues de moins de GROUP_GAP), de la tête à la queue ; mesures du premier. */
function shape(race) {
  const rs = race.riders.slice().sort((a, b) => b.st.s - a.st.s);
  const groups = [[rs[0]]];
  for (let i = 1; i < rs.length; i++) {
    if (rs[i - 1].st.s - rs[i].st.s - Dr.BIKE > Dr.GROUP_GAP) groups.push([]);
    groups[groups.length - 1].push(rs[i]);
  }
  const g = groups[0], ys = g.map((r) => r.lat.y), my = ys.reduce((a, b) => a + b, 0) / ys.length;
  return {
    groups, n: g.length, len: g[0].st.s - g[g.length - 1].st.s,
    spread: Math.max(...ys) - Math.min(...ys), sd: Math.sqrt(ys.reduce((a, b) => a + (b - my) * (b - my), 0) / ys.length),
    lanes: new Set(ys.map((y) => Math.round(y / Pel.LANE))).size,
    meanR: g.reduce((a, r) => a + r.draft.R, 0) / g.length,
  };
}

test('peloton à allure modérée : un groupe large et compact, bien abrité, sans collision', () => {
  for (const start of ['grid', 'file']) {
    const race = pack({ start });
    const coll = ride(race, 300);
    const g = shape(race);
    assert.equal(coll, 0, `${start} : collisions`);
    assert.equal(g.n, 30, `${start} : un seul groupe (${g.groups.map((x) => x.length).join('/')})`);
    assert.ok(g.len < 0.5 * 30 * 2.4, `${start} : groupe de ${g.len.toFixed(1)} m`);
    assert.ok(g.lanes >= 4 && g.spread >= 2, `${start} : ${g.lanes} de front sur ${g.spread.toFixed(1)} m`);
    assert.ok(g.meanR > 0.3, `${start} : abri moyen ${g.meanR.toFixed(2)}`);
  }
});

test("même à allure élevée, le peloton reste sur plusieurs lignes ; seule la descente rapide le resserre", () => {
  const calm = pack({});
  ride(calm, 300);
  const c = shape(calm);
  const race = pack({ leadMode: 'pma' });
  const coll = ride(race, 200);
  const g = shape(race);
  assert.equal(coll, 0, 'collisions');
  assert.equal(g.n, 30, 'un seul groupe');
  assert.ok(g.lanes >= 4 && g.sd > 0.8, `PMA : ${g.lanes} de front, écart latéral ${g.sd.toFixed(2)} m`);
  const down = pack({ grade: -0.05 });
  ride(down, 150);
  const d = shape(down);
  assert.ok(down.riders[0].st.v > 14, 'plus de 50 km/h');
  assert.ok(d.sd < c.sd, `descente : écart latéral ${d.sd.toFixed(2)} m contre ${c.sd.toFixed(2)} m à allure modérée`);
});

test("pas sur des rails : personne n'est exactement dans la roue du précédent, les écarts latéraux sont variés", () => {
  const race = pack({});
  ride(race, 300);
  const rs = race.riders.slice().sort((a, b) => b.st.s - a.st.s);
  // chacun et le coureur le plus proche devant, dans la même voie à 0,5 m près : écart latéral à sa roue
  const offs = [];
  for (let i = 1; i < rs.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      const dx = rs[j].st.s - rs[i].st.s;
      if (dx < Dr.BIKE) continue;
      if (dx > 6) break;
      const dy = Math.abs(rs[j].lat.y - rs[i].lat.y);
      if (dy < 0.6) { offs.push(dy); break; }
    }
  }
  assert.ok(offs.length >= 8, `${offs.length} coureurs dans une roue`);
  const exact = offs.filter((x) => x < 0.03).length;
  assert.ok(exact < 0.3 * offs.length, `${exact} sur ${offs.length} pile dans la roue`);
  // les positions latérales ne tombent pas sur quelques voies : beaucoup de valeurs différentes (au centimètre près pour 0,05 m)
  const ys = new Set(rs.map((r) => Math.round(r.lat.y / 0.05)));
  assert.ok(ys.size >= 15, `${ys.size} positions latérales différentes`);
  // compact : le peloton de 30 tient sur moins de 25 m
  const g = shape(race);
  assert.ok(g.len < 25, `${g.n} coureurs sur ${g.len.toFixed(1)} m`);
});

test("les coureurs cherchent l'avant : ils remontent souvent, même à allure soutenue", () => {
  const race = pack({ leadMode: 'threshold' });
  let ups = 0;
  const prev = new Map();
  ride(race, 400, (rc) => { for (const r of rc.riders) { if (r.lat.mode === 'up' && prev.get(r.id) !== 'up') ups++; prev.set(r.id, r.lat.mode); } });
  assert.ok(ups >= 25, `${ups} remontées en 400 s à allure seuil`);
  assert.equal(shape(race).n, 30, 'le groupe reste entier');
});

test("mouvements dans le peloton : des coureurs remontent, d'autres reculent", () => {
  const race = pack({});
  let ups = 0, r0 = null;
  const prev = new Map();
  ride(race, 600, (rc) => {
    for (const r of rc.riders) { if (r.lat.mode === 'up' && prev.get(r.id) !== 'up') ups++; prev.set(r.id, r.lat.mode); }
    if (rc.t === 60) r0 = rc.riders.slice().sort((a, b) => b.st.s - a.st.s).map((r) => r.id);
  });
  const r1 = race.riders.slice().sort((a, b) => b.st.s - a.st.s).map((r) => r.id);
  let gained = 0, lost = 0;
  r1.forEach((id, k) => { const k0 = r0.indexOf(id); if (k < k0) gained++; else if (k > k0) lost++; });
  assert.ok(ups >= 10, `${ups} remontées`);
  assert.ok(gained >= 5 && lost >= 5, `${gained} ont gagné des places, ${lost} en ont perdu`);
  assert.equal(shape(race).n, 30, 'le groupe reste entier');
});

test("éventail par vent de côté : en diagonale sous le vent ; sur route étroite, plus de coureurs en bordure, qui s'usent", () => {
  const o = { leadMode: 'threshold', n: 20, botK: 0.9, wind: { dir: 90, kmh: 25 } };
  /** Coureurs en bordure plus de la moitié du temps (après la mise en place), et énergie économisée par l'abri, eux et les autres. */
  const echelon = (w) => {
    const race = pack(Object.assign({ w }, o));
    const edgeT = new Map();
    let T = 0;
    const coll = ride(race, 600, (rc) => {
      if (rc.t <= 120) return;
      T++;
      for (const r of rc.riders) if (r.draft.edge) edgeT.set(r.id, (edgeT.get(r.id) || 0) + 1);
    });
    const gutter = race.riders.filter((r) => (edgeT.get(r.id) || 0) > 0.5 * T);
    const others = race.riders.filter((r) => r.id !== 'lead' && !((edgeT.get(r.id) || 0) > 0.1 * T));
    const saved = (a) => a.reduce((x, r) => x + r.stats.savedJ, 0) / Math.max(1, a.length);
    return { race, coll, gutter: gutter.length, savedGutter: saved(gutter), savedOthers: saved(others) };
  };
  const narrow = echelon(3.5);
  assert.equal(narrow.coll, 0, 'collisions');
  // la tête de l'éventail : le meneur au bord au vent, chacun plus sous le vent (à gauche) que celui qu'il suit
  const head = shape(narrow.race).groups[0].slice(0, 5).map((r) => r.lat.y);
  assert.ok(head[0] > 1, `meneur au bord au vent : ${head[0].toFixed(2)}`);
  for (let k = 1; k < head.length; k++) assert.ok(head[k] < head[k - 1] - 0.3, `éventail : ${head.map((y) => y.toFixed(2)).join(' ')}`);
  assert.ok(narrow.gutter >= 4, `en bordure : ${narrow.gutter}`);
  assert.ok(narrow.savedGutter < 0.85 * narrow.savedOthers, `économisé en bordure ${Math.round(narrow.savedGutter / 1000)} kJ, dans l'éventail ${Math.round(narrow.savedOthers / 1000)} kJ`);
  const wide = echelon(8);
  assert.ok(wide.gutter < narrow.gutter, `en bordure : ${narrow.gutter} sur 3,5 m, ${wide.gutter} sur 8 m`);
});

test('relais en éventail : celui qui se laisse glisser passe côté vent', () => {
  const race = pack({ n: 12, think: true, wind: { dir: 90, kmh: 25 } });
  let windward = 0, leeward = 0, pulls = 0;
  const coll = ride(race, 300, (rc) => {
    for (const r of rc.riders) {
      if (r.tac.phase === 'pull') pulls++;
      if (r.tac.phase !== 'swing' || r.lat.swingY === null) continue;
      if (r.lat.swingY > r.lat.prevY + 0.05) windward++; else if (r.lat.swingY < r.lat.prevY - 0.05) leeward++;
    }
  });
  assert.equal(coll, 0, 'collisions');
  assert.ok(pulls > 100, 'les relais tournent');
  assert.ok(windward > 2 * leeward, `côté vent ${windward}, sous le vent ${leeward}`);
});

test("remonter le groupe (« Suivre les attaques ») : par le côté, jusqu'aux places de tête", () => {
  const race = pack({ n: 14 });
  const { setup, athlete } = setupFor(makeProfile([{ len: 100, grade: 0 }]));
  ride(race, 90);
  const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: race.riders[0].st.v, human: true });
  const last = race.riders.slice(0, -1).sort((a, b) => a.st.s - b.st.s)[0];
  me.st.s = last.st.s - 2.4; me.prevS = me.st.s; Pel.setY(me, last.lat.y);
  Tac.setMode(me, 'cover', race.t);
  let maxY = 0, at = -1;
  const coll = ride(race, 150, (rc) => {
    maxY = Math.max(maxY, Math.abs(me.lat.y - last.lat.y));
    const rank = rc.riders.slice().sort((a, b) => b.st.s - a.st.s).indexOf(me);
    if (at < 0 && rank <= Tac.frontPlaces(15)) at = rc.t;
  });
  assert.equal(coll, 0, 'collisions');
  assert.ok(at > 0 && at < 90 + 120, `places de tête atteintes à ${at} s`);
  assert.ok(maxY > 1, `écart latéral pour passer : ${maxY.toFixed(2)} m`);
});

test("route qui rétrécit (pavés de 3 m) : le groupe s'allonge, sans sortir de la route ni se percuter", () => {
  const race = pack({ surfaces: [{ startKm: 2, endKm: 4, surface: 'cobbles_hard', factor: 3.5 }] });
  let worst = 0, inside = 0, before = 0, narrow = 0;
  const coll = ride(race, 420, (rc) => {
    for (const r of rc.riders) {
      const out = Math.abs(r.lat.y) - Pel.halfWidth(rc.course, r.st.s);
      if (out > worst) worst = out;
      if (r.st.s > 2050 && r.st.s < 3950 && out > 0.05) inside++;
    }
    const g = shape(rc), s0 = g.groups[0][0].st.s;
    if (s0 > 1700 && s0 < 1900) before = Math.max(before, g.spread);
    if (s0 > 2300 && s0 < 3900) narrow = Math.max(narrow, g.spread);
  });
  assert.equal(coll, 0, 'collisions');
  assert.ok(worst < 0.5, `au plus ${worst.toFixed(2)} m sur le bas-côté, le temps de se glisser derrière un voisin`);
  assert.equal(inside, 0, 'sur les pavés, tout le monde est sur la route');
  assert.ok(narrow <= 2 * (1.5 - Pel.EDGE) + 0.01 && narrow < before, `largeur du groupe : ${before.toFixed(2)} → ${narrow.toFixed(2)} m`);
});

test("changer de rang (← →) : le joueur se décale d'un rang, sans sortir de la route", () => {
  const race = pack({ n: 2 });
  const me = race.riders.find((r) => r.id === 'b00');
  me.human = true; me.bot = null; me.lat.roam = false; Tac.setMode(me, 'manual', 0); me.tac.cmd = 200;
  race.riders.find((r) => r.id === 'lead').st.s += 100; // seul sur la route : rien à côté
  ride(race, 5);
  const y0 = me.lat.y;
  Pel.nudge(me, 1, me.st.t, race.course);
  ride(race, 2);
  assert.ok(Math.abs(me.lat.y - (y0 + Pel.LANE)) < 0.05, `${y0.toFixed(2)} → ${me.lat.y.toFixed(2)}`);
  for (let k = 0; k < 8; k++) { Pel.nudge(me, 1, me.st.t, race.course); ride(race, 2); }
  assert.ok(Math.abs(me.lat.y - Pel.halfWidth(race.course, me.st.s)) < 0.01, 'bloqué au bord de la route');
  ride(race, 20);
  assert.ok(me.lat.y > Pel.halfWidth(race.course, me.st.s) - 0.05, 'en allure libre, le joueur garde la voie choisie');
});

test('peloton : déterministe, et sans la règle, la course est celle de toujours', () => {
  const trace = () => { const race = pack({ n: 20, think: true }); const ys = []; ride(race, 200, (rc) => ys.push(rc.riders.map((r) => r.lat.y.toFixed(4)).join())); return ys.join('|'); };
  assert.equal(trace(), trace());
  const { course } = setupFor(makeProfile([{ len: 5000, grade: 0.01 }]));
  const runRules = (rules) => {
    const race = Race.create({ course, rules, seed: 3, gustSeed: 1 });
    Race.addBots(race, { n: 8, level: 'mixed', rider: DEFAULT_RIDER, bike: DEFAULT_BIKE, v0: 8 });
    Race.runToEnd(race);
    return race.riders.map((r) => r.time.toFixed(3)).join();
  };
  assert.equal(Race.normRules({ peloton: true, draft: false }).peloton, false);
  assert.equal(Race.normRules({}).peloton, false);
  assert.equal(runRules({ peloton: false }), runRules({}));
});

test("peloton : « dans les roues » tient la roue et économise autant qu'en file", () => {
  const { course, setup, athlete } = setupFor(makeProfile([{ len: 8000, grade: 0 }]));
  const race = Race.create({ course, rules: { peloton: true }, seed: 7, gustSeed: 1 });
  const lead = Race.addRider(race, { id: 'lead', name: 'A', setup, athlete, v0: 10 });
  const foll = Race.addRider(race, { id: 'foll', name: 'B', setup, athlete, v0: 10 });
  lead.st.s = 20; foll.st.s = 15; Pel.setY(foll, 0.75);
  Tac.setMode(lead, 'threshold', 0);
  Tac.setMode(foll, 'follow', 0);
  ride(race, 400);
  const gap = lead.st.s - foll.st.s - Dr.BIKE;
  assert.ok(gap > 0.1 && gap < 1.5, `écart entre les roues ${gap.toFixed(2)} m`);
  assert.ok(Math.abs(foll.lat.y - lead.lat.y) < 0.05, 'dans le sillage');
  assert.ok(foll.stats.sumP < 0.85 * lead.stats.sumP, 'il économise');
  assert.ok(foll.stats.shelteredS > 340);
});

test('peloton de 90 : assez rapide pour le jeu', () => {
  const race = pack({ n: 90 });
  const t0 = Date.now();
  const coll = ride(race, 300);
  const ms = Date.now() - t0;
  assert.ok(ms < 6000, `${ms} ms pour 300 s de course (collisions comprises)`);
  assert.equal(coll, 0, 'collisions');
  assert.equal(shape(race).n, 90, 'un seul groupe');
});

/* ---------- virages : la corde ---------- */

/** Segments d'un virage de deg° (> 0 à droite, < 0 à gauche) de rayon R (m) : des pas de 10 m. */
function arc(deg, R) {
  const n = Math.round((Math.abs(deg) * Math.PI / 180 * R) / 10);
  return Array.from({ length: n }, () => ({ len: 10, grade: 0, turn: Math.sign(deg) * (10 / R) * 180 / Math.PI }));
}

/** Course de n coureurs (un meneur à allure fixe, des virtuels) sur une route droite de pre m, un virage, puis 1500 m droit. */
function bend(o) {
  const { n = 30, deg = 90, R = 60, pre = 1500, w = 6, seed = 7 } = o || {};
  const profile = makeProfile([{ len: pre, grade: 0 }, ...arc(deg, R), { len: 1500, grade: 0 }], { heading: 0 });
  const { course, setup, athlete } = setupFor(profile, {}, { temperature: 20, roadWidth: w });
  const race = Race.create({ course, rules: { peloton: true }, seed, gustSeed: 1 });
  const lead = Race.addRider(race, { id: 'lead', name: 'Meneur', setup, athlete, v0: 10 });
  Tac.setMode(lead, 'tempo', 0);
  for (let i = 0; i < n - 1; i++) {
    const r = Race.addRider(race, { id: 'b' + String(i).padStart(2, '0'), name: 'B' + i, setup, athlete, v0: 10, bot: Object.assign({}, BOT) });
    r.tac.nextThink = Infinity;
  }
  Pel.grid(race); race.riders.forEach((r) => { r.st.s += 300; r.prevS = r.st.s; });
  return { race, pre, len: Math.abs(deg) * Math.PI / 180 * R };
}

/** Un coureur seul, à la puissance P, sur la voie y (il la garde), dans un virage : son temps d'arrivée. */
function soloBend(deg, R, y, P) {
  const profile = makeProfile([{ len: 400, grade: 0 }, ...arc(deg, R), { len: 400, grade: 0 }], { heading: 0 });
  const { course, setup, athlete } = setupFor(profile, {}, { temperature: 20, roadWidth: 6 });
  const race = Race.create({ course, rules: { peloton: true }, seed: 1, gustSeed: 1 });
  const r = Race.addRider(race, { id: 'a', name: 'A', setup, athlete, v0: 10 });
  r.human = true; Tac.setMode(r, 'manual', 0); r.tac.cmd = P; Pel.setY(r, y);
  for (let t = 0; t < 400 && !r.finished; t++) Race.step(race);
  return r.time;
}

test('courbure signée du tracé : positive à droite, négative à gauche, nulle en ligne droite', () => {
  const k = (deg) => {
    const { course } = setupFor(makeProfile([{ len: 400, grade: 0 }, ...arc(deg, 60), { len: 400, grade: 0 }], { heading: 0 }));
    let m = 0;
    for (let i = 0; i < course.n; i++) if (Math.abs(course.kappa[i]) > Math.abs(m)) m = course.kappa[i];
    return { m, c0: course.kappa[10], c1: course.kappa[course.n - 10] };
  };
  const r = k(90), l = k(-90);
  assert.ok(near(r.m, 1 / 60, 0.002), `à droite : ${r.m}`);
  assert.ok(near(l.m, -1 / 60, 0.002), `à gauche : ${l.m}`);
  assert.equal(r.c0, 0); assert.equal(r.c1, 0);
  // sans limite de vitesse en virage (cornering « off »), la courbure existe quand même (trajectoire)
  const { course } = setupFor(makeProfile([{ len: 400, grade: 0 }, ...arc(90, 60), { len: 400, grade: 0 }], { heading: 0 }), {}, { temperature: 20 }, { aLat: 0, vmaxKmh: 90 });
  assert.ok(course.kappa.some((x) => x > 0.01));
});

test('trajectoire : à la corde le chemin est plus court, au large plus long, borné', () => {
  const { course } = setupFor(makeProfile([{ len: 400, grade: 0 }, ...arc(180, 20), { len: 400, grade: 0 }], { heading: 0 }));
  const i = course.kappa.findIndex((x) => x > 0.045);
  assert.ok(i > 0, 'épingle repérée');
  assert.equal(Pel.pathFactor(course, i, 0), 1, 'sur le tracé');
  assert.ok(Pel.pathFactor(course, i, 2.4) > 1.1, `à la corde (droite) : ${Pel.pathFactor(course, i, 2.4)}`);
  assert.ok(Pel.pathFactor(course, i, -2.4) < 0.9, `au large : ${Pel.pathFactor(course, i, -2.4)}`);
  assert.ok(near(Pel.pathFactor(course, i, 2.4), 1 / (1 - 2.4 * course.kappa[i]), 1e-6));
  assert.equal(Pel.pathFactor(course, 5, 2.4), 1, 'en ligne droite, la voie ne change rien');
  assert.ok(Pel.pathFactor(course, i, 50) <= 1 / 0.7 + 1e-9 && Pel.pathFactor(course, i, -50) >= 1 / 1.3 - 1e-9, 'borné');
  assert.equal(Pel.pathFactor({ n: 10 }, 3, 2), 1, 'parcours sans courbure');
});

test('virage : à la corde on le passe plus vite que sur le rail, au large plus lentement', () => {
  for (const [deg, R, P, min] of [[90, 60, 250, 0.25], [180, 15, 250, 0.9], [90, 25, 400, 0.25]]) {
    const t = [2.4, 1.2, 0, -1.2, -2.4].map((y) => soloBend(deg, R, y, P));
    for (let k = 1; k < t.length; k++) assert.ok(t[k] > t[k - 1], `${deg}° R ${R} : ${t.map((x) => x.toFixed(2)).join(' < ')}`);
    assert.ok(t[2] - t[0] > min, `${deg}° R ${R} : gain de ${(t[2] - t[0]).toFixed(2)} s à la corde`);
    const g = t[4] - t[2], gl = soloBend(-deg, R, 2.4, P) - soloBend(-deg, R, 0, P);
    assert.ok(g > min * 0.5, 'au large, on perd du temps');
    assert.ok(near(gl, g, 0.02), `à gauche, la voie de droite est au large : ${gl.toFixed(2)} s contre ${g.toFixed(2)} s`);
  }
});

test('virage : le peloton descend à la corde (côté intérieur), à droite comme à gauche, sans collision ni sortie de route', () => {
  for (const sgn of [1, -1]) {
    const { race, pre, len } = bend({ deg: 90 * sgn });
    const bots = race.riders.filter((r) => r.id !== 'lead');
    const mean = () => bots.reduce((a, r) => a + sgn * r.lat.y, 0) / bots.length;
    let before = null, apex = null, worst = 0;
    const coll = ride(race, 330, (rc) => {
      const s0 = Math.max(...rc.riders.map((r) => r.st.s));
      if (before === null && s0 > pre - 250) before = mean();
      if (apex === null && s0 > pre + 0.7 * len) apex = mean();
      for (const r of rc.riders) worst = Math.max(worst, Math.abs(r.lat.y) - Pel.halfWidth(rc.course, r.st.s));
    });
    assert.equal(coll, 0, 'collisions');
    assert.ok(worst < 0.05, `hors route de ${worst.toFixed(2)} m`);
    assert.ok(apex > before + 0.6 && apex > 1, `${sgn > 0 ? 'à droite' : 'à gauche'} : côté intérieur ${before.toFixed(2)} → ${apex.toFixed(2)} m`);
  }
});

test('virage : une courbe douce ne change pas la trajectoire du peloton', () => {
  const { race } = bend({ deg: 20, R: 400 }); // rayon 400 m : au-delà de la limite où l'on prend la corde
  let max = 0;
  ride(race, 330, (rc) => { for (const r of rc.riders) max = Math.max(max, Math.abs(r.lat.line)); });
  assert.equal(max, 0, 'pas de corde pour une courbe douce');
  assert.equal(Pel.cornerAhead({ n: 10, step: 10 }, 20, 10), 0, 'sans courbure');
});

test("virage : la corde est annoncée à l'approche et relâchée après le virage ; le sens inverse attend la fin du premier", () => {
  const profile = makeProfile([{ len: 500, grade: 0 }, ...arc(90, 60), { len: 100, grade: 0 }, ...arc(-90, 60), { len: 500, grade: 0 }], { heading: 0 });
  const { course } = setupFor(profile);
  assert.equal(Pel.cornerAhead(course, 100, 10), 0, 'loin du virage');
  assert.ok(Pel.cornerAhead(course, 470, 10) > 0.9, 'virage à droite à 30 m : corde à droite');
  assert.ok(Pel.cornerAhead(course, 500 + 47, 10) > 0.9, 'dans le virage');
  assert.ok(Pel.cornerAhead(course, 500 + 94 + 70, 10) < -0.5, 'entre les deux : déjà celui de gauche');
  assert.equal(Pel.cornerAhead(course, 500 + 94 + 100 + 94 + 150, 10), 0, 'après le dernier virage');
});

test("virage : celui qui est à la corde gêne : un plus rapide derrière prend la voie d'à côté, sans être freiné", () => {
  const profile = makeProfile([{ len: 600, grade: 0 }, ...arc(90, 60), { len: 600, grade: 0 }], { heading: 0 });
  const { course, setup, athlete } = setupFor(profile);
  const race = Race.create({ course, rules: { peloton: true }, seed: 3, gustSeed: 1 });
  const A = Race.addRider(race, { id: 'A', name: 'A', setup, athlete, v0: 6 });
  A.human = true; Tac.setMode(A, 'manual', 0); A.tac.cmd = 90; Pel.setY(A, 2.4); // lent, à la corde (à droite)
  const B = Race.addRider(race, { id: 'B', name: 'B', setup, athlete, v0: 10, bot: Object.assign({}, BOT) });
  B.tac.nextThink = Infinity; Tac.setMode(B, 'tempo', 0); Pel.setY(B, 0.5);
  A.st.s = 640; A.prevS = 640; B.st.s = 590; B.prevS = 590;
  let vmin = Infinity, yAt = null;
  const coll = ride(race, 25, () => {
    const gap = A.st.s - B.st.s;
    if (gap < 30 && gap > -10) vmin = Math.min(vmin, B.st.v);
    if (Math.abs(gap) < Dr.BIKE) yAt = Math.min(yAt === null ? Infinity : yAt, B.lat.y);
  });
  assert.equal(coll, 0, 'collisions');
  assert.ok(yAt !== null && yAt <= A.lat.y - Pel.MIN_DY + 0.02, `B passe à ${yAt} m, A est à ${A.lat.y} m`);
  assert.ok(vmin > 9.3, `B n'est pas freiné derrière A : ${vmin.toFixed(2)} m/s`);
});

test('virage : le coureur en allure libre garde sa voie (← → pour prendre la corde)', () => {
  const profile = makeProfile([{ len: 400, grade: 0 }, ...arc(90, 60), { len: 400, grade: 0 }], { heading: 0 });
  const { course, setup, athlete } = setupFor(profile);
  const race = Race.create({ course, rules: { peloton: true }, seed: 1, gustSeed: 1 });
  const me = Race.addRider(race, { id: 'me', name: 'Moi', setup, athlete, v0: 10 });
  me.human = true; Tac.setMode(me, 'manual', 0); me.tac.cmd = 250; Pel.setY(me, 0);
  ride(race, 70);
  assert.equal(me.lat.y, 0, 'sans consigne, il reste sur sa voie dans le virage');
  assert.equal(me.lat.line, 0);
});
