/* author : Hugo Joudrier-Faure */
/* Tests de la vue 3D du parcours (js/ui/route3d.js) : projection, choix des tuiles du fond, placement du tracé, exagération du relief. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR, makeProfile } = require('./helpers.js');
require(path.join(__dirname, '..', 'js', 'ui', 'route3d.js'));

const R3 = PYR.route3d;

test('Mercator : le point (0°, 0°) est au centre du monde, le nord est en haut (y décroît)', () => {
  const [x, y] = R3.merc(0, 0);
  assert.ok(Math.abs(x - 0.5) < 1e-12 && Math.abs(y - 0.5) < 1e-12);
  assert.ok(R3.merc(45, 0)[1] < R3.merc(0, 0)[1]);
  assert.ok(R3.merc(0, 10)[0] > R3.merc(0, 0)[0]);
});

test('tuiles du fond : le zoom le plus fin qui tient dans 8 × 8 tuiles, la boîte est couverte', () => {
  const a = R3.merc(45.1, 6.3), b = R3.merc(45.0, 6.45);       // ~ 12 km
  const box = [a[0], a[1], b[0], b[1]];
  const t = R3.pickTiles(...box, 17);
  assert.ok(t.nx <= 8 && t.ny <= 8 && t.nx * t.ny <= 48);
  const n = 2 ** t.z;
  assert.ok(t.tx0 / n <= box[0] && (t.tx0 + t.nx) / n >= box[2], 'couvre en x');
  assert.ok(t.ty0 / n <= box[1] && (t.ty0 + t.ny) / n >= box[3], 'couvre en y');
  // un zoom de plus ne tiendrait plus
  const m = 2 ** (t.z + 1);
  const nx = Math.floor(box[2] * m) - Math.floor(box[0] * m) + 1, ny = Math.floor(box[3] * m) - Math.floor(box[1] * m) + 1;
  assert.ok(t.z === 17 || nx > 8 || ny > 8 || nx * ny > 48);
  // plafonné au zoom du fond (OpenTopoMap : 17) et au zoom 17 en général
  assert.equal(R3.pickTiles(0.5, 0.5, 0.5000001, 0.5000001, 17).z, 17);
  assert.equal(R3.pickTiles(0.5, 0.5, 0.5000001, 0.5000001, 12).z, 12);
});

test('placement du tracé : mètres autour du centre, altitude relative au point le plus bas', () => {
  const p = makeProfile([{ len: 3000, grade: 0.05 }, { len: 3000, grade: -0.02 }], { ele0: 400, heading: 90 });   // cap est
  const L = R3.layout(p);
  const n = p.n;
  assert.equal(L.pos.length, 3 * n);
  assert.ok(Math.abs(L.pos[1]) < 1e-3, 'départ au plus bas');
  assert.ok(Math.abs(L.range - (L.eleMax - L.eleMin)) < 1e-9);
  assert.ok(Math.abs(L.range - 150) < 1, 'D+ de 150 m');
  // cap est : x croît d'environ 6 000 m, z reste proche de 0
  assert.ok(Math.abs((L.pos[3 * (n - 1)] - L.pos[0]) - 6000) < 60, 'longueur est-ouest');
  assert.ok(Math.abs(L.pos[3 * (n - 1) + 2] - L.pos[2]) < 20);
  assert.ok(Math.abs(L.extent - 6000) < 60);
  assert.ok(Math.abs(L.pos[0] + L.pos[3 * (n - 1)]) < 60, 'centré');
});

test('exagération conseillée : le relief atteint ~30 % de l\'étendue, entre ×1 et ×10', () => {
  assert.equal(R3.autoExag(20000, 1000), 6);
  assert.equal(R3.autoExag(20000, 100), 10);
  assert.equal(R3.autoExag(1000, 1000), 1);
  assert.equal(R3.autoExag(5000, 0), 1);
});

test('adresse d\'une tuile', () => {
  const u = R3.tileUrl({ url: 'https://{s}.tile.example/{z}/{x}/{y}{r}.png', subdomains: 'ab' }, 12, 2113, 1456);
  assert.match(u, /^https:\/\/[ab]\.tile\.example\/12\/2113\/1456\.png$/);
});

test('altitude Terrarium : R × 256 + V + B / 256 − 32768', () => {
  assert.equal(R3.terrarium(128, 0, 0), 0);
  assert.equal(R3.terrarium(133, 232, 0), 1000);        // 133 × 256 + 232 − 32768
  assert.equal(R3.terrarium(128, 10, 128), 10.5);
});

test('maillage du terrain : altitude interpolée entre les quatre mailles voisines', () => {
  // 3 × 3 mailles (2 segments par côté) : h = 10 × colonne + 100 × rangée
  const h = new Float32Array(9).map((_, k) => 10 * (k % 3) + 100 * Math.floor(k / 3));
  assert.equal(R3.sampleGrid(h, 2, 2, 0, 0), 0);
  assert.equal(R3.sampleGrid(h, 2, 2, 1, 1), 220);
  assert.equal(R3.sampleGrid(h, 2, 2, 0.5, 0.5), 110);
  assert.equal(R3.sampleGrid(h, 2, 2, 0.25, 0.75), 5 + 150);
  assert.equal(R3.sampleGrid(h, 2, 2, -3, 9), 200, 'borné au rectangle');
});

test('exagération conseillée sur un terrain : plus modeste, jamais au-delà de ×4', () => {
  assert.equal(R3.autoExag(10000, 1500, 0.12, 4), 1);
  assert.equal(R3.autoExag(10000, 300, 0.12, 4), 4);
});
