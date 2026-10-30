/* author : Hugo Joudrier-Faure */
/* Tests de la bibliothèque vue des jeux et du compteur (Commun/js/core/lib-cache.js) : listes (projet en cours en tête, sans doublon), choix, recopie dans l'état. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { PYR, makeProfile } = require('./helpers.js');
PYR.storageNs = 'paceyourride.jeu2d';
require(path.join(__dirname, '..', 'Commun/js/core/library.js'));
require(path.join(__dirname, '..', 'Commun/js/core/lib-cache.js'));
const L = PYR.library, C = PYR.libCache;

const route = (name) => { const p = makeProfile([{ len: 5000, grade: 0.03 }]); const coords = []; for (let i = 0; i < p.n; i++) coords.push([p.lat[i], p.lng[i], p.ele[i]]); return { route: { name, legs: [{ coords }], waypoints: [] }, surfaces: [], winds: [], feedZones: [], checkpoints: [] }; };
const defaults = () => ({ route: {}, surfaces: [], winds: [], feedZones: [], checkpoints: [], rider: {}, bike: {}, shop: {}, perf: { formPct: 100 }, env: { temperature: 20 }, ride: { kit: {}, plan: null, planInfo: null }, weather: { enabled: false } });

function setup(withProject) {
  const lib = L.empty();
  L.add(lib, 'route', 'Col', route('Col'), 1000);
  L.add(lib, 'athlete', 'Hugo', { rider: { name: 'Hugo', weight: 70, ftp: 260 } }, 1000);
  C.load();
  C.state.lib = lib;
  C.state.memo = {};
  C.state.project = withProject ? Object.assign({ version: 1 }, route('Projet'), { rider: { name: 'Camille', weight: 58, ftp: 210 }, bike: { weight: 7.5 }, perf: { formPct: 90 }, env: { temperature: 12 }, ride: { plan: { s: [0, 1] }, planInfo: { fp: 'x' }, kit: { slots: [] } } }) : null;
  return lib;
}

test('lib-cache : le projet en cours est proposé en tête, la bibliothèque ensuite', () => {
  setup(true);
  const routes = C.items('route');
  assert.equal(routes.length, 2);
  assert.equal(routes[0].id, C.PROJECT_ID);
  assert.ok(routes[0].project && /projet en cours/.test(routes[0].name));
  assert.equal(C.items('athlete')[0].id, C.PROJECT_ID);
  setup(false);
  assert.equal(C.items('route').length, 1);
});

test('lib-cache : un projet identique à un élément de la bibliothèque n\'est pas proposé deux fois', () => {
  const lib = setup(true);
  C.state.project = Object.assign({ version: 1 }, route('Col'), { rider: { name: 'Hugo', weight: 70, ftp: 260 } });
  C.state.memo = {};
  assert.equal(C.items('route').length, 1);
  assert.equal(lib.routes.length, 1);
});

test('lib-cache : pickId garde le choix s\'il existe, sinon prend le premier ; compose recopie le choix dans l\'état', () => {
  setup(true);
  const col = C.state.lib.routes[0].id;
  assert.equal(C.pickId('route', col), col);
  assert.equal(C.pickId('route', 'inconnu'), C.PROJECT_ID);
  const st = defaults();
  const r = C.compose(st, { route: col, athlete: C.state.lib.athletes[0].id, bike: 'none', outfit: 'none' });
  assert.equal(r.name, 'Col');
  assert.equal(st.route.name, 'Col');
  assert.equal(st.rider.name, 'Hugo');
  assert.ok(st.weather, 'l\'état garde une météo après le changement de parcours');
  assert.equal(st.perf.formPct, 90, 'les réglages de stratégie du projet suivent');
  assert.equal(st.env.temperature, 12);
  assert.ok(st.ride.plan, 'le plan du projet suit (il n\'est repris que si son empreinte correspond : plan-link.js)');
});

test('lib-cache : sans bibliothèque ni projet, compose ne change rien', () => {
  C.load(); C.state.lib = L.empty(); C.state.project = null; C.state.memo = {};
  const st = defaults();
  assert.equal(C.compose(st, {}), null);
  assert.deepEqual(st.route, {});
});
