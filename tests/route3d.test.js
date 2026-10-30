/* author : Hugo Joudrier-Faure */
/* Tests de la géométrie de la vue 3D d'un parcours (Commun/js/jeu/route-3d.js) : échantillonnage, mise à l'échelle, exagération du relief, pentes. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR, makeProfile } = require('./helpers.js');
require(path.join(__dirname, '..', 'Commun/js/core/library.js'));
require(path.join(__dirname, '..', 'Commun/js/jeu/route-3d.js'));

const R3 = PYR.route3d;
const profileOf = (segments, opts) => {
  const p = makeProfile(segments, opts);
  return { n: p.n, step: p.step, length: p.length, lat: p.lat, lng: p.lng, ele: p.ele, hasEle: true };
};

test('route 3D : le tracé tient dans la scène, centré, et le relief est exagéré quand il est faible', () => {
  const g = R3.geometry(profileOf([{ len: 20000, grade: 0.005 }, { len: 10000, grade: -0.005 }]));
  assert.ok(g && g.n >= 2 && g.n <= 500);
  const span = Math.max(Math.max(...g.x) - Math.min(...g.x), Math.max(...g.z) - Math.min(...g.z));
  assert.ok(Math.abs(span - g.span) < 1e-6, 'étendue horizontale = ' + g.span);
  assert.ok(Math.abs((Math.max(...g.x) + Math.min(...g.x)) / 2) < 1e-6, 'centré en x');
  assert.ok(g.exag > 1 && g.exag <= 8, 'relief exagéré : ×' + g.exag);
  assert.ok(Math.min(...g.y) >= 0 && g.height > 0);
});

test('route 3D : un parcours sans altitude donne un tracé plat ; un col a des pentes positives puis négatives', () => {
  const flat = R3.geometry(Object.assign(profileOf([{ len: 10000, grade: 0 }]), { ele: null, hasEle: false }));
  assert.equal(flat.height, 0);
  assert.ok(flat.grade.every((x) => x === 0));
  const col = R3.geometry(profileOf([{ len: 8000, grade: 0.08 }, { len: 8000, grade: -0.08 }]));
  assert.ok(Math.max(...col.grade) > 0.06 && Math.min(...col.grade) < -0.06);
});

test('route 3D : trop de points est ramené à 500, pas de géométrie sans tracé', () => {
  const g = R3.geometry(profileOf([{ len: 200000, grade: 0.01 }], { step: 10 }));
  assert.equal(g.n, 500);
  assert.equal(R3.geometry(null), null);
  assert.equal(R3.geometry({ n: 1, lat: [0], lng: [0] }), null);
});

test('route 3D : sommets du ruban et du rideau cohérents, couleurs selon la pente', () => {
  const g = R3.geometry(profileOf([{ len: 6000, grade: 0.1 }]));
  const d = R3.meshData(g);
  assert.equal(d.pos.length, g.n * 6);
  assert.equal(d.idx.length, (g.n - 1) * 6);
  assert.equal(d.cPos.length, g.n * 6);
  for (const i of d.idx.concat(d.cIdx)) assert.ok(i >= 0 && i < g.n * 2);
  // le rideau descend jusqu'au sol
  for (let i = 0; i < g.n; i++) assert.equal(d.cPos[i * 6 + 4], 0);
  const steep = R3.gradeColor(0.1), flat = R3.gradeColor(0.01), down = R3.gradeColor(-0.06);
  assert.notDeepEqual(steep, flat);
  assert.ok(down[2] > down[0], 'descente en bleu');
  assert.ok(steep[0] > steep[2], 'montée raide en rouge');
});
