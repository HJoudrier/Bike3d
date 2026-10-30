/* author : Hugo Joudrier-Faure */
/* Tests du matériel réglé sur la vue 3D de Jeu3D (Commun/js/jeu/gear-edit.js) : articles proposés, montage comme au magasin, reprise des modifications. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR } = require('./helpers.js');
PYR.dom = { h() {}, $() {}, $$() { return []; } };
require(path.join(__dirname, '..', 'Commun/js/core/store.js'));
require(path.join(__dirname, '..', 'Commun/js/jeu/gear-edit.js'));
const G = PYR.gearEdit, store = PYR.store, Cat = PYR.catalog;
const part = (id) => G.PARTS.find((p) => p.id === id);

test('matériel 3D : chaque partie propose des articles, la tenue réunit maillots et combinaisons, la position ses huit réglages', () => {
  for (const p of G.PARTS) assert.ok(G.options(p).length >= 2, p.label);
  assert.equal(G.options(part('clothing')).length, Cat.ITEMS.kit.length + Cat.ITEMS.suit.length);
  assert.equal(G.options(part('position')).length, PYR.physics.POSITIONS.length);
});

test('matériel 3D : monter un article règle le vélo et le cycliste comme le magasin (masse comprise)', () => {
  store.state = JSON.parse(JSON.stringify(store.state));
  const frame = G.options(part('frame')).find((o) => o.id === 'tt');
  G.equip(frame);
  assert.equal(store.state.bike.frame, 'tt');
  assert.ok(Math.abs(store.state.bike.weight - (Cat.get('frame', 'tt').mass + (store.state.bike.wheelMass || 2.2))) < 0.5);
  assert.equal(store.state.shop.frame, 'tt');
  G.equip(G.options(part('position')).find((o) => o.id === 'tt_pro'));
  assert.equal(store.state.rider.position, 'tt_pro');
  assert.equal(G.currentIndex(part('position')), G.options(part('position')).findIndex((o) => o.id === 'tt_pro'));
});

test('matériel 3D : une combinaison prend la place du maillot, et inversement', () => {
  const suit = G.options(part('clothing')).find((o) => o.cat === 'suit');
  G.equip(suit);
  assert.equal(store.state.rider.clothing, Cat.get('suit', suit.id).rider.clothing);
  assert.ok(!store.state.shop.kit, 'le maillot n\'est plus monté');
  const kit = G.options(part('clothing')).find((o) => o.cat === 'kit');
  G.equip(kit);
  assert.ok(!store.state.shop.suit);
});

test('matériel 3D : reapply remonte les modifications gardées, clear les oublie par vélo ou par tenue', () => {
  const e = store.state.game.gearEdit = { frame: 'climber', helmet: 'aero', position: 'drops', wheels: 'inconnu' };
  store.state.bike.frame = 'road'; store.state.rider.helmet = 'road'; store.state.rider.position = 'hoods';
  G.reapply();
  assert.equal(store.state.bike.frame, 'climber');
  assert.equal(store.state.rider.helmet, 'aero');
  assert.equal(store.state.rider.position, 'drops');
  assert.ok(!('wheels' in e), 'un article inconnu est abandonné');
  G.clear('bike');
  assert.deepEqual(Object.keys(store.state.game.gearEdit).sort(), ['helmet', 'position']);
  G.clear('outfit');
  assert.deepEqual(store.state.game.gearEdit, {});
});
