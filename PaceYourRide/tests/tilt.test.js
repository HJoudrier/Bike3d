/* author : Hugo Joudrier-Faure */
/* Tests de l'inclinaison du téléphone (changer de rang en penchant l'appareil) : angle dans le repère de l'écran et déclenchement. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR } = require('./helpers.js');
require(path.join(__dirname, '..', 'js/engine/tilt.js'));

const T = PYR.tilt;
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 0.05);

test('inclinaison : positive quand le bord droit de l\'écran descend, à plat comme en portrait', () => {
  assert.ok(near(T.rollFrom(0, 0, 20, 0), 20), 'à plat, penché à droite');
  assert.ok(near(T.rollFrom(0, 0, -20, 0), -20), 'à plat, penché à gauche');
  assert.ok(Math.abs(T.rollFrom(0, 90, 0, 0)) < 1e-9, 'debout, droit');
  assert.ok(T.rollFrom(0, 50, 15, 0) > 8 && T.rollFrom(0, 50, 15, 0) < 20, 'tenu incliné vers soi, penché à droite');
  assert.ok(near(T.rollFrom(123, 0, 20, 0), T.rollFrom(0, 0, 20, 0)), 'le cap (alpha) n\'intervient pas');
});

test('inclinaison : comme un volant, debout en portrait (gamma vers ±90)', () => {
  assert.ok(near(T.rollFrom(0, 80, 89.9, 0), 10, 0.1), 'volant tourné à droite de 10°');
  assert.ok(near(T.rollFrom(0, 80, -89.9, 0), -10, 0.1), 'volant tourné à gauche');
});

test('inclinaison : en paysage, dans le repère de l\'écran, dans les deux sens de rotation', () => {
  // écran tourné de 90° (haut du téléphone à gauche) : bord droit de l'écran = bas du téléphone ; debout, gamma = −90, beta = 0
  assert.ok(near(T.rollFrom(0, 0, -89.99, 90), 0, 0.1), 'droit');
  assert.ok(near(T.rollFrom(0, 10, -89.99, 90), 10, 0.1), 'bord droit vers le bas');
  assert.ok(near(T.rollFrom(0, -10, -89.99, 90), -10, 0.1), 'bord droit vers le haut');
  // écran tourné de 270° (haut du téléphone à droite) : debout, gamma = +90
  assert.ok(near(T.rollFrom(0, -10, 89.99, 270), 10, 0.1), 'bord droit vers le bas');
  assert.ok(near(T.rollFrom(0, 10, 89.99, 270), -10, 0.1), 'bord droit vers le haut');
});

/** Envoie des mesures roll (°) toutes les 20 ms à partir de t0 ; renvoie les décalages déclenchés [{t, dir}]. */
function run(c, rolls, t0) {
  const out = [];
  let t = t0;
  for (const r of rolls) { const d = T.feed(c, r, t); if (d) out.push({ t, dir: d }); t += 20; }
  return { out, t };
}
const hold = (v, ms) => Array(Math.round(ms / 20)).fill(v);

test('inclinaison : droit, rien ; penché au-delà du seuil, un rang tout de suite, puis un de plus à intervalle régulier', () => {
  const c = T.create();
  let r = run(c, hold(30, 500), 0); // posture de départ = neutralité
  assert.equal(r.out.length, 0);
  r = run(c, [...hold(30, 200), ...hold(30 + 8, 200)], r.t); // 8° : sous le seuil
  assert.equal(r.out.length, 0, '8° : pas de décalage');
  r = run(c, hold(30 + 18, 2000), r.t); // 18° à droite, gardé 2 s
  assert.equal(r.out[0].dir, 1);
  assert.ok(r.out.length >= 2 && r.out.length <= 3, `${r.out.length} décalages en 2 s`);
  assert.ok(r.out[1].t - r.out[0].t >= 700, 'intervalle entre deux rangs');
  assert.ok(r.out.every((x) => x.dir === 1));
});

test('inclinaison : revenir droit réarme ; de l\'autre côté, un rang à gauche', () => {
  const c = T.create();
  let r = run(c, hold(0, 300), 0);
  r = run(c, hold(20, 200), r.t);
  assert.equal(r.out.length, 1, 'un rang à droite');
  r = run(c, hold(0, 300), r.t);
  assert.equal(r.out.length, 0);
  r = run(c, hold(20, 200), r.t);
  assert.equal(r.out.length, 1, 'réarmé : un nouveau rang');
  r = run(c, hold(-20, 200), r.t);
  assert.equal(r.out[0].dir, -1, 'basculer de l\'autre côté décale tout de suite');
});

test('inclinaison : très penché, les rangs s\'enchaînent plus vite', () => {
  const slow = run(T.create(), [...hold(0, 300), ...hold(16, 2000)], 0).out.length;
  const fast = run(T.create(), [...hold(0, 300), ...hold(40, 2000)], 0).out.length;
  assert.ok(fast > slow, `${fast} contre ${slow}`);
});

test('inclinaison : recalibrer reprend la posture actuelle, la neutralité suit une posture qui dérive lentement', () => {
  const c = T.create();
  let r = run(c, hold(0, 300), 0);
  r = run(c, hold(10, 400), r.t);
  assert.equal(r.out.length, 0);
  assert.ok(T.offset(c) > 4);
  T.recalibrate(c);
  assert.ok(Math.abs(T.offset(c)) < 0.5, 'neutralité = posture');
  r = run(c, hold(10, 400), r.t);
  assert.equal(r.out.length, 0);
  // posture qui dérive de 3° : la neutralité la rejoint, sans rien déclencher
  const d = T.create();
  r = run(d, hold(0, 200), 0);
  r = run(d, hold(3, 20000), r.t);
  assert.equal(r.out.length, 0);
  assert.ok(Math.abs(T.offset(d)) < 1.5, `écart restant ${T.offset(d).toFixed(2)}°`);
  assert.equal(T.feed(d, NaN, 0), 0, 'mesure invalide ignorée');
});
