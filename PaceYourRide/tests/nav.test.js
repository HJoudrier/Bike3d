/* author : Hugo Joudrier-Faure */
/* Tests du guidage de la carte de la sortie : virages détectés dans la géométrie du tracé, prochain virage, niveau de zoom. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR } = require('./helpers.js');
require(path.join(__dirname, '..', 'js/engine/nav.js'));

const N = PYR.nav;
const R = 6371008.8, DEG = Math.PI / 180, LAT0 = 45, LNG0 = 5;

/** Profil (un point tous les `step` m) d'un tracé fait de segments « cap (°, 0 = nord, horaire), longueur (m) » ou d'arcs { turn (°), radius (m) }. */
function track(parts, step = 10) {
  let x = 0, y = 0, hd = 0;
  const pts = [[x, y]];
  const go = (len) => { // avance de len m dans le cap courant, un point tous les step m
    for (let d = step; d <= len + 1e-9; d += step) pts.push([x + Math.sin(hd * DEG) * d, y + Math.cos(hd * DEG) * d]);
    x += Math.sin(hd * DEG) * len; y += Math.cos(hd * DEG) * len;
  };
  for (const q of parts) {
    if (q.heading !== undefined) hd = q.heading;
    if (q.len) go(q.len);
    if (q.turn) { // arc de cercle : petits pas de 1 m de long
      const n = Math.max(1, Math.round(Math.abs(q.turn) * DEG * q.radius / 1)), dh = q.turn / n, ds = Math.abs(q.turn) * DEG * q.radius / n;
      for (let k = 0; k < n; k++) { hd += dh / 2; x += Math.sin(hd * DEG) * ds; y += Math.cos(hd * DEG) * ds; hd += dh / 2; pts.push([x, y]); }
    }
  }
  // rééchantillonnage régulier (step m)
  const lat = [], lng = [];
  let acc = 0, k = 1, [px, py] = pts[0];
  lat.push(LAT0 + py / R / DEG); lng.push(LNG0 + px / (R * Math.cos(LAT0 * DEG) * DEG));
  while (k < pts.length) {
    const dx = pts[k][0] - px, dy = pts[k][1] - py, d = Math.hypot(dx, dy);
    if (acc + d >= step) {
      const f = (step - acc) / d;
      px += dx * f; py += dy * f; acc = 0;
      lat.push(LAT0 + py / R / DEG); lng.push(LNG0 + px / (R * Math.cos(LAT0 * DEG) * DEG));
    } else { acc += d; px = pts[k][0]; py = pts[k][1]; k++; }
  }
  return { n: lat.length, step, lat, lng };
}

test('virages : une route droite ou une courbe douce n\'en donne aucun', () => {
  assert.deepEqual(N.turns(track([{ len: 2000 }])), []);
  assert.deepEqual(N.turns(track([{ len: 500 }, { turn: 20, radius: 200 }, { len: 500 }])), []);
});

test('virages : un angle droit à droite puis un à gauche, au bon endroit, avec le bon signe', () => {
  const t = N.turns(track([{ len: 500 }, { heading: 0 }, { turn: 90, radius: 8 }, { len: 500 }, { turn: -90, radius: 8 }, { len: 300 }]));
  assert.equal(t.length, 2, JSON.stringify(t));
  assert.ok(Math.abs(t[0].angle - 90) < 8 && t[0].kind === 'turn', `angle ${t[0].angle}`);
  assert.ok(Math.abs(t[0].s - 510) < 15, `s ${t[0].s}`);
  assert.ok(Math.abs(t[1].angle + 90) < 8, `angle ${t[1].angle}`);
  assert.ok(Math.abs(t[1].s - 1030) < 20, `s ${t[1].s}`);
});

test('virages : une courbe de 90° sur un grand rayon est un seul virage, un lacet serré est une épingle', () => {
  const bend = N.turns(track([{ len: 400 }, { turn: 90, radius: 60 }, { len: 400 }]));
  assert.equal(bend.length, 1, JSON.stringify(bend));
  assert.ok(Math.abs(bend[0].angle - 90) < 8);
  const hairpin = N.turns(track([{ len: 400 }, { turn: 180, radius: 12 }, { len: 400 }]));
  assert.equal(hairpin.length, 1, JSON.stringify(hairpin));
  assert.equal(hairpin[0].kind, 'sharp');
  assert.ok(Math.abs(Math.abs(hairpin[0].angle) - 180) < 15, `angle ${hairpin[0].angle}`);
});

test('prochain virage : celui devant soi, ou celui qu\'on passe à moins de 15 m ; null après le dernier', () => {
  const list = [{ s: 500, angle: 90, kind: 'turn' }, { s: 1000, angle: -45, kind: 'slight' }];
  assert.equal(N.nextTurn(list, 0).s, 500);
  assert.equal(N.nextTurn(list, 505).s, 500);
  assert.equal(N.nextTurn(list, 520).s, 1000);
  assert.equal(N.nextTurn(list, 1100), null);
});

test('zoom : large sur la route libre, plus près à l\'approche d\'un virage, au plus près juste avant', () => {
  assert.equal(N.zoomFor(Infinity, 8), 16);
  assert.equal(N.zoomFor(2000, 8), 16);
  assert.equal(N.zoomFor(250, 8), 17);
  assert.equal(N.zoomFor(60, 8), 18);
  // plus on roule vite, plus tôt on zoome
  assert.ok(N.zoomFor(100, 15) > N.zoomFor(100, 3));
});

test('description : flèche et texte selon le sens et la nature du virage', () => {
  assert.equal(N.describe({ angle: 90, kind: 'turn' }).text, 'à droite');
  assert.equal(N.describe({ angle: -90, kind: 'turn' }).text, 'à gauche');
  assert.match(N.describe({ angle: 40, kind: 'slight' }).text, /légèrement/);
  assert.match(N.describe({ angle: 170, kind: 'sharp' }).text, /demi-tour/);
});

test('peloton : position décalée sur la largeur de la route (+ = à droite), route prolongée avant le départ', () => {
  const m = (a, b) => { // distance (m) et sens entre deux points [lat, lng]
    const dy = (b[0] - a[0]) * DEG * R, dx = (b[1] - a[1]) * DEG * R * Math.cos(a[0] * DEG);
    return { d: Math.hypot(dx, dy), dx, dy };
  };
  const north = track([{ heading: 0, len: 500 }]);
  const c = N.offsetAt(north, 200, 0), r = N.offsetAt(north, 200, 10);
  const d = m(c, r);
  assert.ok(Math.abs(d.d - 10) < 0.05 && d.dx > 9.9, `cap nord, +10 m : vers l'est (${d.dx.toFixed(2)} m)`);
  const east = track([{ heading: 90, len: 500 }]);
  const e = m(N.offsetAt(east, 200, 0), N.offsetAt(east, 200, 10));
  assert.ok(e.dy < -9.9, `cap est, +10 m : vers le sud (${e.dy.toFixed(2)} m)`);
  assert.ok(Math.abs(N.headingAt(east, 200) - Math.PI / 2) < 0.01);
  // avant le départ (grille du peloton) : 20 m derrière la ligne, dans l'axe de la route
  const back = m(N.offsetAt(north, 0, 0), N.offsetAt(north, -20, 0));
  assert.ok(Math.abs(back.dy + 20) < 0.05 && Math.abs(back.dx) < 0.05, `20 m derrière le départ (${back.dy.toFixed(2)} m)`);
});
