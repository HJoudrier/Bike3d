/* author : Hugo Joudrier-Faure */
/* Les jeux Virtual Ride ne proposent plus le GPS : un ancien réglage « sur la vraie route » redevient avatar (Commun/js/core/store.js). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { PYR } = require('./helpers.js');
require(path.join(__dirname, '..', 'Commun/js/core/store.js'));

test('jeux : un projet qui demandait le GPS roule en avatar, les autres présences sont gardées', () => {
  const S = PYR.store;
  S.importProject({ route: { waypoints: [], legs: [] }, game: { source: 'road' } });
  assert.equal(S.state.game.source, 'avatar');
  S.importProject({ route: { waypoints: [], legs: [] }, game: { source: 'trainer' } });
  assert.equal(S.state.game.source, 'trainer');
});
