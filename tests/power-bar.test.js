/* author : Hugo Joudrier-Faure */
/* Tests de la barre de puissance de l'écran de course mobile : bornes des segments et conversions position ↔ puissance. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR } = require('./helpers.js');
require(path.join(__dirname, '..', 'Commun/js/engine/power-bar.js'));

const B = PYR.powerBar;

test('bornes : 0, fin des zones Z1 à Z4 (% de la FTP), puis le maximum de la jauge', () => {
  const e = B.zoneEdges(300, 900);
  assert.equal(e.length, 6);
  assert.deepEqual(e.map((x) => Math.round(x)), [0, 165, 225, 270, 315, 900]);
});

test('bornes : strictement croissantes, même avec une FTP très haute devant le maximum', () => {
  for (const [ftp, max] of [[150, 600], [250, 600], [400, 1000], [700, 600]]) {
    const e = B.zoneEdges(ftp, max);
    assert.equal(e[0], 0);
    assert.equal(e[5], max);
    for (let i = 0; i < 5; i++) assert.ok(e[i + 1] > e[i], `FTP ${ftp}, max ${max} : borne ${i + 1}`);
  }
});

test('position ↔ puissance : bornes des segments à 0, 20, 40, 60, 80 et 100 %, aller-retour exact', () => {
  const e = B.zoneEdges(280, 800);
  e.forEach((p, i) => {
    assert.ok(Math.abs(B.powerToPos(p, e) - i / 5) < 1e-9, `borne ${i}`);
    assert.ok(Math.abs(B.posToPower(i / 5, e) - p) < 1e-9, `borne ${i} (retour)`);
  });
  for (const p of [10, 150, 230, 261, 300, 555, 799]) {
    assert.ok(Math.abs(B.posToPower(B.powerToPos(p, e), e) - p) < 1e-6, `${p} W`);
  }
});

test('position ↔ puissance : monotone et bornée', () => {
  const e = B.zoneEdges(250, 600);
  let prev = -1;
  for (let x = 0; x <= 1.0001; x += 0.01) {
    const p = B.posToPower(x, e);
    assert.ok(p >= prev, 'monotone');
    prev = p;
  }
  assert.equal(B.posToPower(-1, e), 0);
  assert.equal(B.posToPower(2, e), 600);
  assert.equal(B.powerToPos(-5, e), 0);
  assert.equal(B.powerToPos(5000, e), 1);
});

test('segment d\'une puissance', () => {
  const e = B.zoneEdges(300, 900);
  assert.deepEqual([0, 164, 165, 230, 280, 320, 899, 900, 2000].map((p) => B.zoneIndex(p, e)), [0, 0, 1, 2, 3, 4, 4, 4, 4]);
  assert.equal(B.NAMES.length, 5);
  assert.equal(B.MODES.length, 5);
});

test('libellés : nom complet précédé du numéro de zone, puis nom court, puis nom court seul', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => B.zoneText(i, 0)),
    ['Z1 - Récupération', 'Z2 - Endurance', 'Z3 - Tempo', 'Z4 - Seuil', 'Z5 - PMA']);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => B.zoneText(i, 1)),
    ['Z1 - Récup', 'Z2 - Endur', 'Z3 - Tempo', 'Z4 - Seuil', 'Z5 - PMA']);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => B.zoneText(i, 2)), B.NAMES);
  assert.equal(B.LEVELS, 3);
});
