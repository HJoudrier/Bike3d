/* author : Hugo Joudrier-Faure */
/* Tests des niveaux de référence (profil de puissance) et des zones de puissance. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR } = require('./helpers.js');

const B = PYR.bench;

test('référence : seuils décroissants de « classe mondiale » à « non entraîné », hommes et femmes', () => {
  assert.equal(B.LEVELS.length, 8);
  for (const sex of ['m', 'f']) {
    for (const e of B.EFFORTS) {
      const th = B.thresholds(sex, e.id);
      assert.equal(th.length, 8);
      for (let i = 1; i < th.length; i++) assert.ok(th[i] < th[i - 1], `${sex} ${e.id} : ${th[i - 1]} > ${th[i]}`);
    }
  }
  // à effort égal, les seuils des femmes sont plus bas
  for (const e of B.EFFORTS) assert.ok(B.thresholds('f', e.id)[3] < B.thresholds('m', e.id)[3]);
  assert.deepEqual(B.EFFORTS.map((e) => e.label), ['5 s', '15 s', '1 min', '3 min', '5 min', '20 min', 'FTP']);
  // 5 s et 1 min : valeurs de la table
  assert.deepEqual(B.thresholds('m', 'p5'), B.TABLE.m.p5);
  assert.deepEqual(B.thresholds('f', 'p60'), B.TABLE.f.p60);
  // Allen & Coggan : FTP d'un « très bon » (Cat 2) = 4,44 W/kg chez les hommes
  assert.equal(B.thresholds('m', 'ftp')[3], 4.44);
  assert.equal(B.thresholds('m', 'p300')[2], 5.95);
});

test('référence : 15 s et 3 min interpolées, 20 min = FTP / 0,95', () => {
  for (let i = 0; i < 8; i++) {
    const p180 = B.thresholds('f', 'p180')[i];
    assert.ok(p180 < B.TABLE.f.p60[i] && p180 > B.TABLE.f.p300[i], `3 min niveau ${i} : ${p180}`);
    const p5 = B.TABLE.m.p5[i], p60 = B.TABLE.m.p60[i], p15 = B.thresholds('m', 'p15')[i];
    assert.ok(p15 < p5 && p15 > p60, `niveau ${i} : ${p60} < ${p15} < ${p5}`);
    assert.ok(Math.abs(B.thresholds('m', 'p1200')[i] - B.TABLE.m.ftp[i] / 0.95) < 1e-9);
  }
});

test('référence : classement d\'une valeur, niveau suivant et progression', () => {
  let c = B.classify('m', 'ftp', 4.44);
  assert.equal(c.index, 3);
  assert.equal(c.level.label, 'Très bon');
  assert.equal(c.next.level.label, 'Excellent');
  assert.ok(Math.abs(c.next.wkg - 4.98) < 1e-9 && c.progress < 0.01);
  c = B.classify('m', 'ftp', 4.43);
  assert.equal(c.index, 4);
  c = B.classify('m', 'ftp', 4.71);
  assert.ok(Math.abs(c.progress - 0.5) < 0.01, `progression ${c.progress}`);
  // sommet et en dessous du plus bas niveau
  c = B.classify('f', 'p300', 9);
  assert.equal(c.index, 0);
  assert.equal(c.next, null);
  assert.equal(c.progress, 1);
  c = B.classify('m', 'ftp', 1.5);
  assert.equal(c.level, B.BELOW);
  assert.equal(c.next.level.label, 'Non entraîné');
  // sexe inconnu : hommes
  assert.deepEqual(B.thresholds('?', 'ftp'), B.thresholds('m', 'ftp'));
  assert.throws(() => B.thresholds('m', 'nope'));
});

test('zones de puissance : six zones contiguës d\'après la FTP, la dernière jusqu\'au sprint', () => {
  const z = B.zones(250, 1100);
  assert.deepEqual(z.map((x) => x.label), ['Récupération', 'Endurance', 'Tempo', 'Seuil', 'PMA', 'Sprint / attaque']);
  assert.equal(z[0].lo, 0);
  for (let i = 1; i < z.length; i++) assert.equal(z[i].lo, z[i - 1].hi);
  assert.equal(z[0].hi, 0.55 * 250);
  assert.equal(z[3].hi, 1.05 * 250);
  assert.equal(z[4].hi, 1.2 * 250);
  assert.equal(z[5].lo, 300);
  assert.equal(z[5].hi, 1100);
  assert.equal(z[5].to, Infinity);
});
