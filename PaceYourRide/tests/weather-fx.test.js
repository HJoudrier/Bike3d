/* author : Hugo Joudrier-Faure */
/* Tests des animations météo : sens du vent, aspect des manches à air, intensité de la pluie. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR } = require('./helpers.js');
require(path.join(__dirname, '..', 'js/ui/weather-fx.js'));

const Fx = PYR.weatherFx;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('vent : sens à l\'écran, vers où il souffle (nord en haut de la carte)', () => {
  // vent du nord (0°) : il souffle vers le sud, donc vers le bas de l'écran
  let w = Fx.blowing(0);
  assert.ok(near(w.dx, 0) && near(w.dy, 1), `${w.dx}, ${w.dy}`);
  // vent d'ouest (270°) : vers l'est, donc vers la droite
  w = Fx.blowing(270);
  assert.ok(near(w.dx, 1) && near(w.dy, 0));
  // vent du sud (180°) : vers le nord, le haut ; vent d'est (90°) : vers la gauche
  w = Fx.blowing(180);
  assert.ok(near(w.dx, 0) && near(w.dy, -1));
  assert.ok(near(Fx.blowing(90).dx, -1));
  // vecteur unitaire pour n'importe quelle direction
  for (const wd of [0, 33, 135, 222, 359.5, 720, -45]) {
    const v = Fx.blowing(wd);
    assert.ok(near(Math.hypot(v.dx, v.dy), 1), `direction ${wd}`);
  }
});

test('manche à air : plus le vent est fort, plus elle est longue et plus elle bat vite', () => {
  const calm = Fx.sockParams(0), light = Fx.sockParams(10), strong = Fx.sockParams(30), storm = Fx.sockParams(80);
  assert.ok(near(calm.k, 0.22), 'sans vent, elle pend (courte)');
  assert.ok(calm.k < light.k && light.k < strong.k && strong.k < storm.k + 1e-9);
  assert.ok(near(Fx.sockParams(Fx.SOCK_FULL).k, 1) && near(storm.k, 1), 'tendue à 45 km/h, pas plus longue au-delà');
  assert.ok(calm.flap > light.flap && light.flap > strong.flap, 'la période du battement diminue');
  assert.ok(storm.flap >= 0.35 && calm.flap <= 1.7, 'période bornée');
  assert.ok(calm.amp < strong.amp && storm.amp <= 17, 'amplitude bornée');
  assert.ok(calm.amp > 0, 'jamais figée');
});

test('manche à air : valeurs manquantes ou aberrantes = calme', () => {
  for (const v of [undefined, null, NaN, -5, 'abc']) assert.deepEqual(Fx.sockParams(v), Fx.sockParams(0));
});

test('pluie : rien sous 0,2 mm/h, puis de plus en plus de gouttes, rapides et longues, voile sous l\'averse', () => {
  assert.equal(Fx.rainParams(0, 5, 90), null);
  assert.equal(Fx.rainParams(0.1, 5, 90), null);
  const drizzle = Fx.rainParams(0.5, 0, 0), rain = Fx.rainParams(3, 0, 0), downpour = Fx.rainParams(12, 0, 0);
  assert.ok(drizzle.density < rain.density && rain.density < downpour.density);
  assert.ok(drizzle.vy < rain.vy && rain.vy < downpour.vy);
  assert.ok(drizzle.len < downpour.len);
  assert.ok(drizzle.tint < downpour.tint && downpour.tint <= 0.1 + 1e-9);
  assert.equal(downpour.density, Fx.rainParams(40, 0, 0).density, 'saturé au-delà de 6 mm/h');
  assert.ok(Fx.rainParams(40, 0, 0).density * 31 > Fx.MAX_RAIN * 0.5, 'beaucoup de gouttes sur une carte entière');
});

test('pluie : le vent penche les gouttes dans son sens, d\'autant plus qu\'il est fort', () => {
  const calm = Fx.rainParams(3, 0, 270), breeze = Fx.rainParams(3, 5, 270), gale = Fx.rainParams(3, 15, 270);
  assert.equal(calm.vx, 0);
  assert.ok(breeze.vx > 0 && gale.vx > breeze.vx, 'vent d\'ouest : les gouttes dérivent vers l\'est');
  assert.ok(Fx.rainParams(3, 15, 90).vx < 0, 'vent d\'est : vers l\'ouest');
  assert.ok(near(Fx.rainParams(3, 15, 0).vx, 0, 1e-6), 'vent du nord : pas de dérive latérale');
  assert.ok(gale.vy > 0 && Math.abs(gale.vx) < gale.vy, 'elles tombent toujours plus qu\'elles ne dérivent');
});
