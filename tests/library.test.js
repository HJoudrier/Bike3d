/* author : Hugo Joudrier-Faure */
/* Tests de la bibliothèque de l'accueil (js/core/library.js) : extraction, application et résumés. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR } = require('./helpers.js');
require(path.join(__dirname, '..', 'Commun/js/core/library.js'));

const L = PYR.library;

/** Projet type : un parcours de 2 tronçons (altitude en 3ᵉ valeur), un cycliste, un vélo, des achats au magasin. */
const project = () => ({
  route: { waypoints: [{ lat: 45, lng: 6 }, { lat: 45.01, lng: 6 }, { lat: 45.02, lng: 6 }], mode: 'fastbike', fixed: null, legs: [
    { coords: [[45, 6, 1000], [45.01, 6, 1050]] }, { coords: [[45.01, 6, 1050], [45.02, 6, 1040]] },
  ] },
  surfaces: [{ id: 's1' }], winds: [], feedZones: [{ id: 'f1', startKm: 1, endKm: 1.2 }], checkpoints: [{ id: 'c1', type: 'sprint', km: 1.5 }],
  weather: { enabled: false, startAt: '', snapshot: null },
  rider: { name: 'Camille', sex: 'f', age: 41, weight: 60, height: 166, ftp: 240, cp: '', wPrime: '', gut: 0.5, records: { 60: 450 },
    position: 'tt', helmet: 'aero', clothing: 'skinsuit', glasses: 'shield', socks: 'aero', shave: 'legs' },
  bike: { weight: 7.1, load: 1.5, frame: 'aero', wheels: 'mid', tire: 'tubeless', shoes: 'carbon', drivetrain: 'waxed' },
  shop: { frame: 'aero', wheels: 'c45', helmet: 'aero', suit: 'tt', shoes: 'carbon' },
  game: { bots: 7 },
});

test('bibliothèque : chaque rubrique ne garde que sa part du projet', () => {
  const s = project();
  assert.deepEqual(Object.keys(L.extract('route', s)).sort(), ['checkpoints', 'feedZones', 'route', 'surfaces', 'weather', 'winds']);
  const a = L.extract('athlete', s);
  assert.equal(a.rider.name, 'Camille');
  assert.equal(a.rider.helmet, undefined, "la tenue n'est pas dans l'athlète");
  assert.equal(a.rider.ftp, 240);
  const b = L.extract('bike', s);
  assert.equal(b.bike.frame, 'aero');
  assert.equal(b.bike.shoes, undefined, 'les chaussures vont avec la tenue');
  assert.deepEqual(b.shop, { frame: 'aero', wheels: 'c45' });
  const o = L.extract('outfit', s);
  assert.deepEqual(o.rider, { position: 'tt', helmet: 'aero', clothing: 'skinsuit', glasses: 'shield', socks: 'aero', shave: 'legs' });
  assert.equal(o.shoes, 'carbon');
  assert.deepEqual(o.shop, { helmet: 'aero', suit: 'tt', shoes: 'carbon' });
});

test("bibliothèque : l'extraction est une copie, pas une référence", () => {
  const s = project();
  const a = L.extract('athlete', s);
  a.rider.records[60] = 1;
  assert.equal(s.rider.records[60], 450);
});

test('bibliothèque : appliquer un athlète garde la tenue et le reste du projet', () => {
  const lib = L.empty();
  const other = project();
  other.rider = Object.assign({}, other.rider, { name: 'Léo', weight: 80, ftp: 300, helmet: 'city', position: 'upright' });
  const it = L.add(lib, 'athlete', 'Léo', L.extract('athlete', other));
  const s = project();
  L.apply('athlete', s, it.data);
  assert.equal(s.rider.name, 'Léo');
  assert.equal(s.rider.ftp, 300);
  assert.equal(s.rider.helmet, 'aero', 'la tenue du projet est conservée');
  assert.equal(s.rider.position, 'tt');
  assert.equal(s.bike.frame, 'aero');
  assert.equal(s.game.bots, 7);
});

test('bibliothèque : appliquer un vélo garde les chaussures et les achats de la tenue', () => {
  const other = project();
  other.bike = Object.assign({}, other.bike, { frame: 'climber', weight: 5.9, shoes: 'flat' });
  other.shop = { frame: 'climber', wheels: 'climb', suit: 'kit' };
  const s = project();
  L.apply('bike', s, L.extract('bike', other));
  assert.equal(s.bike.frame, 'climber');
  assert.equal(s.bike.weight, 5.9);
  assert.equal(s.bike.shoes, 'carbon', 'les chaussures restent celles de la tenue');
  assert.deepEqual(s.shop, { frame: 'climber', wheels: 'climb', helmet: 'aero', suit: 'tt', shoes: 'carbon' });
});

test('bibliothèque : appliquer une tenue change position, chaussures et achats du cycliste, pas le vélo', () => {
  const other = project();
  other.rider = Object.assign({}, other.rider, { position: 'hoods', helmet: 'road', clothing: 'fitted' });
  other.bike = Object.assign({}, other.bike, { shoes: 'road' });
  other.shop = { helmet: 'road', kit: 'fitted' };
  const s = project();
  L.apply('outfit', s, L.extract('outfit', other));
  assert.equal(s.rider.position, 'hoods');
  assert.equal(s.rider.clothing, 'fitted');
  assert.equal(s.rider.name, 'Camille');
  assert.equal(s.bike.shoes, 'road');
  assert.equal(s.bike.frame, 'aero');
  assert.deepEqual(s.shop, { frame: 'aero', wheels: 'c45', helmet: 'road', kit: 'fitted' });
});

test('bibliothèque : appliquer un parcours remplace le tracé et ses enrichissements', () => {
  const other = project();
  other.route = Object.assign({}, other.route, { legs: [{ coords: [[46, 7, 0], [46.1, 7, 10]] }] });
  other.checkpoints = [];
  other.feedZones = [];
  const s = project();
  L.apply('route', s, L.extract('route', other));
  assert.equal(s.route.legs.length, 1);
  assert.deepEqual(s.checkpoints, []);
  assert.equal(s.rider.name, 'Camille');
});

test('bibliothèque : appliquer dans un projet vide (jamais enregistré) fonctionne', () => {
  const s = {};
  L.apply('athlete', s, L.extract('athlete', project()));
  L.apply('bike', s, L.extract('bike', project()));
  L.apply('outfit', s, L.extract('outfit', project()));
  assert.equal(s.rider.name, 'Camille');
  assert.equal(s.rider.helmet, 'aero');
  assert.equal(s.bike.frame, 'aero');
  assert.equal(s.bike.shoes, 'carbon');
});

test('bibliothèque : ajout, recherche, suppression et relecture du stockage', () => {
  const lib = L.empty();
  const a = L.add(lib, 'bike', 'Aéro', L.extract('bike', project()), 1000);
  const b = L.add(lib, 'bike', '', L.extract('bike', project()), 2000);
  assert.equal(lib.bikes[0].id, b.id, 'le plus récent est en premier');
  assert.equal(b.name, 'Vélo', 'nom par défaut');
  assert.notEqual(a.id, b.id);
  assert.equal(L.find(lib, 'bike', a.id).name, 'Aéro');
  const again = L.normalize(JSON.parse(JSON.stringify(lib)));
  assert.equal(again.bikes.length, 2);
  assert.ok(L.remove(lib, 'bike', a.id));
  assert.ok(!L.remove(lib, 'bike', a.id));
  assert.equal(lib.bikes.length, 1);
  assert.deepEqual(L.normalize({ bikes: [{ id: 1 }, { id: 'x', data: 'nope' }, null] }), L.empty());
  assert.deepEqual(L.normalize('nimporte quoi'), L.empty());
});

test('bibliothèque : résumés lisibles', () => {
  const s = project();
  const r = L.summary('route', s);
  assert.match(r.title, /^2[,.]2 km · D\+ 50 m$/);
  assert.match(r.detail, /1 point en jeu/);
  assert.match(r.detail, /1 ravito/);
  assert.equal(L.summary('route', { route: { legs: [] } }), null);
  const a = L.summary('athlete', L.extract('athlete', s));
  assert.equal(a.title, 'Camille');
  assert.match(a.detail, /60 kg · FTP 240 W · 4 W\/kg/);
  const b = L.summary('bike', L.extract('bike', s));
  assert.match(b.title, /Aéro/);
  const o = L.summary('outfit', L.extract('outfit', s));
  assert.match(o.title, /Prolongateurs/);
});

test("bibliothèque : profil du parcours (distance, D+, D−) comme dans l'éditeur", () => {
  const p = L.routeProfile(project());
  assert.ok(Math.abs(p.length - L.routeLength(project())) < 1, 'même longueur que le parcours');
  assert.ok(Math.abs(p.step - 10) < 0.5, 'un point tous les ~10 m');
  assert.equal(p.n, p.ele.length);
  assert.ok(p.hasEle && p.up > 35 && p.up <= 50, 'D+ proche de 50 m, un peu lissé : ' + p.up);
  assert.ok(p.down > 0 && p.down <= 10, 'D− proche de 10 m : ' + p.down);
  assert.equal(L.routeProfile({ route: { legs: [] } }), null);
  assert.equal(L.routeProfile({ route: { legs: [{ coords: [[45, 6, 1000], [45.0001, 6, 1001]] }] } }), null, 'moins de 30 m : pas de parcours');
});

test("bibliothèque : un parcours figé (défi, course en direct : `route.fixed`, sans tronçon) est lu comme un tracé ordinaire", () => {
  const s = project();
  const pts = [[45, 6, 1000], [45.005, 6, 1020], [45.01, 6, 1050], [45.015, 6, 1045], [45.02, 6, 1040]];
  const fixed = { n: pts.length, step: 555, lat: pts.map((c) => Math.round(c[0] * 1e6)), lng: pts.map((c) => Math.round(c[1] * 1e6)), ele: pts.map((c) => Math.round(c[2] * 100)) };
  const f = { route: { waypoints: [], legs: [], fixed } };
  assert.ok(Math.abs(L.routeLength(f) - L.routeLength(s)) < 1, 'même longueur que le tracé par tronçons');
  assert.equal(L.routeAscent(f), L.routeAscent(s));
  const p = L.routeProfile(f);
  assert.ok(p && p.hasEle && Math.abs(p.length - L.routeLength(s)) < 1);
  assert.ok(L.summary('route', f).title.startsWith('2,2 km'), L.summary('route', f).title);
  assert.equal(L.routeLength({ route: { legs: [], fixed: null } }), 0);
});

test("bibliothèque : un nouvel athlète a des champs bornés et s'applique sans toucher à la tenue", () => {
  const a = L.newAthlete({ name: '  Léa  ', sex: 'f', age: '200', weight: '61.26', height: '', ftp: '30' });
  assert.deepEqual(a.rider, { name: 'Léa', sex: 'f', age: 99, weight: 61.3, height: 178, gut: 0, ftp: 50, cp: '', wPrime: '', pmax: '', records: {} });
  assert.equal(L.newAthlete().rider.sex, 'm');
  const s = project();
  L.apply('athlete', s, a);
  assert.equal(s.rider.name, 'Léa');
  assert.equal(s.rider.position, 'tt', 'la position et la tenue sont conservées');
  const sum = L.summary('athlete', a);
  assert.equal(sum.title, 'Léa');
  assert.match(sum.detail, /61,3 kg · FTP 50 W/);
});

test('bibliothèque : profil sans altitude ou avec des altitudes manquantes', () => {
  const s = project();
  for (const leg of s.route.legs) for (const c of leg.coords) c[2] = null;
  const flat = L.routeProfile(s);
  assert.equal(flat.hasEle, false);
  assert.equal(flat.ele, null);
  assert.equal(flat.up, 0);
  assert.ok(flat.length > 2000);
  const part = project();
  part.route.legs[0].coords[1][2] = null;       // interpolée entre 1000 et 1050 (point 2 du tracé), pas de trou
  part.route.legs[1].coords[0][2] = null;
  const q = L.routeProfile(part);
  assert.ok(q.hasEle && q.ele.every(Number.isFinite));
});

test('bibliothèque : fusion de deux appareils (union, plus récent, retraits mémorisés)', () => {
  const a = L.empty(), b = L.empty();
  const x = L.add(a, 'route', 'Col A', { route: { legs: [] } }, 1000);
  const y = L.add(b, 'route', 'Col B', { route: { legs: [] } }, 2000);
  const z = L.add(a, 'athlete', 'Léo', { rider: {} }, 3000);
  b.routes.push(Object.assign({}, x, { name: 'Col A (renommé)', savedAt: 1500 }));      // même id, plus récent sur l'autre appareil
  const m = L.merge(a, b);
  assert.deepEqual(m.routes.map((r) => r.name), ['Col B', 'Col A (renommé)']);
  assert.equal(m.athletes.length, 1);
  assert.equal(a.routes.length, 1, "les entrées ne sont pas modifiées");
  // retrait sur un appareil : l'élément ne revient pas depuis l'autre
  a.routes.push(y);
  L.remove(a, 'route', y.id, 2500);                // retiré après son enregistrement (2000)
  b.athletes.push(z);
  L.remove(b, 'athlete', z.id, 9);                 // retrait plus ancien que l'enregistrement (3000) : l'élément est conservé
  const m2 = L.merge(a, b);
  assert.ok(!m2.routes.some((r) => r.id === y.id));
  assert.equal(m2.removed[y.id], 2500);
  assert.equal(m2.athletes.length, 1);
  assert.deepEqual(L.merge(m2, m2), m2, 'fusionner deux fois donne le même résultat');
  assert.deepEqual(L.normalize(JSON.parse(JSON.stringify(m2))), m2, 'la forme survit au stockage');
});

test('bibliothèque : renommer garde la version la plus récente à la synchronisation', () => {
  const a = L.empty();
  const it = L.add(a, 'route', 'Col', { route: { legs: [] } }, 1000);
  const b = JSON.parse(JSON.stringify(a));                      // l'autre appareil a la version d'origine
  assert.ok(L.rename(a, 'route', it.id, '  Col du Galibier  ', 2000));
  assert.equal(a.routes[0].name, 'Col du Galibier');
  assert.equal(a.routes[0].savedAt, 2000);
  assert.equal(L.merge(a, b).routes[0].name, 'Col du Galibier');
  assert.equal(L.merge(b, a).routes[0].name, 'Col du Galibier');
  assert.equal(L.rename(a, 'route', it.id, '   ', 3000) && a.routes[0].name, 'Parcours', 'sans nom : le libellé de la rubrique');
  assert.equal(L.rename(a, 'route', 'absent', 'x'), false);
});

test("bibliothèque : un nouveau parcours est nommé d'après sa date et son heure de création", () => {
  assert.equal(L.defaultRouteName(new Date(2026, 9, 19, 20, 26, 0).getTime()), 'Parcours du 19/10/2026 20:26:00');
  assert.equal(L.defaultRouteName(new Date(2026, 0, 5, 7, 4, 9).getTime()), 'Parcours du 05/01/2026 07:04:09', 'jour, mois et heure sur deux chiffres');
  assert.match(L.defaultRouteName(), /^Parcours du \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
});

test("bibliothèque : un nouvel athlète est nommé « Athlète # » suivi de la date et de l'heure collées", () => {
  assert.equal(L.defaultAthleteName(new Date(2026, 9, 19, 22, 59, 32).getTime()), 'Athlète #20261019225932');
  assert.equal(L.defaultAthleteName(new Date(2026, 0, 5, 7, 4, 9).getTime()), 'Athlète #20260105070409');
  assert.match(L.defaultAthleteName(), /^Athlète #\d{14}$/);
});

test("bibliothèque : créer un parcours repart d'un parcours vide, nommé d'après l'instant, et garde le reste du projet", () => {
  const s = project();
  s.route.name = 'Ancien';
  s.checkpoints = [{ id: 'a', type: 'sprint', km: 1 }];
  s.winds = [{ id: 'w' }];
  const now = new Date(2026, 9, 19, 20, 26, 0).getTime();
  assert.equal(L.startRoute(s, now), s, 'modifié sur place');
  assert.equal(s.route.name, 'Parcours du 19/10/2026 20:26:00');
  assert.deepEqual(s.route.waypoints, []);
  assert.deepEqual(s.route.legs, []);
  assert.equal(s.route.fixed, null);
  assert.equal(s.route.mode, 'fastbike', 'mode de tracé conservé');
  assert.deepEqual([s.surfaces, s.winds, s.feedZones, s.checkpoints], [[], [], [], []]);
  assert.equal(s.weather, undefined);
  assert.equal(L.routeLength(s), 0);
  assert.deepEqual(s.rider, project().rider, 'athlète intact');
  assert.deepEqual(s.bike, project().bike, 'vélo intact');
});

test("bibliothèque : enregistrer sous un nom déjà pris demande confirmation avant d'écraser", () => {
  const lib = L.empty();
  const first = L.save(lib, 'route', 'Col du Galibier', { route: { legs: [] }, v: 1 }, 1000);
  assert.equal(first.replaced, false);
  L.add(lib, 'route', 'Autre', { route: { legs: [] } }, 1500);
  const again = L.save(lib, 'route', '  col du galibier ', { route: { legs: [] }, v: 2 }, 2000);
  assert.equal(again.exists.id, first.item.id, "même nom (casse et espaces ignorés) : rien n'est écrit");
  assert.equal(lib.routes.length, 2);
  assert.equal(lib.routes.find((x) => x.id === first.item.id).data.v, 1, 'ancienne version intacte');
  const over = L.save(lib, 'route', 'Col du Galibier', { route: { legs: [] }, v: 2 }, 3000, true);
  assert.equal(over.replaced, true);
  assert.equal(over.item.id, first.item.id, 'même identifiant');
  assert.equal(lib.routes.length, 2, 'pas de doublon');
  assert.equal(lib.routes[0].id, first.item.id, 'le plus récent en premier');
  assert.equal(lib.routes[0].data.v, 2);
  assert.equal(lib.routes[0].savedAt, 3000);
  assert.equal(L.findByName(lib, 'athlete', 'Col du Galibier'), null, 'les noms sont propres à chaque rubrique');
});

test("bibliothèque : le nom du vélo et celui de la tenue voyagent avec leur élément, pas avec l'athlète", () => {
  const s = project();
  s.bike.name = 'Vélo de chrono';
  s.rider.outfitName = 'Tenue pluie';
  assert.equal(L.extract('bike', s).bike.name, 'Vélo de chrono');
  assert.equal(L.extract('outfit', s).rider.outfitName, 'Tenue pluie');
  assert.equal(L.extract('athlete', s).rider.outfitName, undefined);
  const other = project();
  L.apply('bike', other, L.extract('bike', s));
  L.apply('outfit', other, L.extract('outfit', s));
  assert.equal(other.bike.name, 'Vélo de chrono');
  assert.equal(other.rider.outfitName, 'Tenue pluie');
  // changer d'athlète ne touche pas au nom de la tenue
  L.apply('athlete', other, L.extract('athlete', project()));
  assert.equal(other.rider.outfitName, 'Tenue pluie');
});

test("bibliothèque : un athlète né un jour donné a l'âge recalculé quand on l'applique", () => {
  const U = PYR.util;
  const a = L.newAthlete({ name: 'Léo', birthDate: '1990-06-15', weight: '70', height: '180', ftp: '250' });
  assert.equal(a.rider.birthDate, '1990-06-15');
  assert.equal(a.rider.age, Math.min(99, Math.max(8, U.ageFrom('1990-06-15'))));
  const old = JSON.parse(JSON.stringify(a));
  old.rider.age = 20;                                    // âge figé à l'enregistrement, ancien
  const s = project();
  L.apply('athlete', s, old);
  assert.equal(s.rider.age, U.ageFrom('1990-06-15'), "recalculé d'après la date de naissance");
  assert.equal(L.newAthlete({ name: 'X', birthDate: 'pas une date', age: '44' }).rider.birthDate, undefined);
});
