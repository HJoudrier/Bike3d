/* author : Hugo Joudrier-Faure */
/* Tests du plan d'alimentation et du coach de sortie. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR } = require('./helpers.js');

const N = PYR.nutrition, Fu = PYR.fuel;

const flat = (W, sec) => new Float32Array(sec).fill(W);
const BIG_KIT = { slots: ['iso', 'water', '', 'water'], items: { gel: 6, gelglu: 0, gelplus: 0, bar: 4, barmini: 0 } };
const base = (extra) => Object.assign({ P: flat(200, 3 * 3600), dur: 3 * 3600, mass: 72, cp: 250, ftp: 250, tempC: 20, gut: 0.5, kit: BIG_KIT }, extra);

test('plan : une sortie courte n\'a pas besoin de nourriture, seulement de quoi boire', () => {
  const p = N.planNutrition(base({ P: flat(180, 2400), dur: 2400 }));
  assert.equal(p.mode, 'none');
  assert.equal(p.carbsPerH, 0);
  assert.ok(p.events.every((e) => e.type === 'drink'));
  assert.equal(p.food.everyS, 0);
});

test('plan : plus la sortie est longue, plus on apporte de glucides (sans dépasser 90 % du plafond d\'absorption)', () => {
  const at = (h, W) => N.planNutrition(base({ P: flat(W, h * 3600), dur: h * 3600 }));
  const one = at(1, 190), two = at(2, 190), four = at(4, 190);
  assert.ok(one.carbsPerH < two.carbsPerH && two.carbsPerH <= four.carbsPerH, `${one.carbsPerH} ${two.carbsPerH} ${four.carbsPerH}`);
  assert.ok(four.carbsPerH <= 0.9 * Fu.caps(0.5).mix + 1e-9);
  // intestin non entraîné et glucose seul : plafond plus bas
  const glu = N.planNutrition(base({ gut: 0, kit: { slots: ['water', '', '', ''], items: { gel: 0, gelglu: 6, bar: 0, barmini: 0 } } , P: flat(190, 4 * 3600), dur: 4 * 3600 }));
  assert.ok(glu.carbsPerH <= 0.9 * 60 + 1e-9, `${glu.carbsPerH}`);
});

test('plan : la réserve de glycogène ne passe pas sous 30 % quand le matériel suffit', () => {
  const p = N.planNutrition(base({ P: flat(190, 3 * 3600), dur: 3 * 3600 }));
  assert.ok(p.sim.minG >= N.G_FLOOR - 0.01, `minimum ${p.sim.minG}`);
  assert.ok(p.carbsPerH >= 50);
  // sans rien manger, la même sortie fait descendre la réserve bien plus bas
  const f = Fu.create(72, { slots: ['water', '', '', ''], items: {} });
  let minG = 1;
  for (let t = 0; t < 3 * 3600; t++) { Fu.step(f, 190, 250, 20); minG = Math.min(minG, f.G / f.G0); }
  assert.ok(minG < p.sim.minG - 0.1, `${minG} vs ${p.sim.minG}`);
});

test('plan : un effort que les poches ne peuvent pas nourrir est signalé (glycogène sous 30 %)', () => {
  const p = N.planNutrition(base({ P: flat(235, 4 * 3600), dur: 4 * 3600 }));
  assert.ok(p.sim.minG < N.G_FLOOR);
  assert.ok(p.warnings.length >= 1, 'au moins un avertissement');
  assert.ok(p.carbsPerH <= 0.9 * Fu.caps(0.5).mix + 1e-9);
});

test('plan : prises espacées d\'au moins 12 min (solide) et 8 min (boisson), pas de solide dans les 20 dernières minutes', () => {
  const p = N.planNutrition(base());
  const eats = p.events.filter((e) => e.type === 'eat'), drinks = p.events.filter((e) => e.type === 'drink');
  assert.ok(eats.length >= 3 && drinks.length >= 6);
  for (let i = 1; i < eats.length; i++) assert.ok(eats[i].t - eats[i - 1].t >= N.MIN_FOOD_GAP - 1);
  for (let i = 1; i < drinks.length; i++) assert.ok(drinks[i].t - drinks[i - 1].t >= N.MIN_DRINK_GAP - 1);
  assert.ok(eats[eats.length - 1].t <= p.events.length * 0 + 3 * 3600 - N.NO_FOOD_LAST);
  assert.ok(p.drink.slot === 0 && p.drink.mix === 'iso');
});

test('plan : le matériel manquant est signalé', () => {
  const p = N.planNutrition(base({ kit: { slots: ['water', '', '', ''], items: { gel: 1, bar: 0 } }, P: flat(210, 4 * 3600), dur: 4 * 3600 }));
  assert.ok(p.warnings.some((w) => /gels et de barres/.test(w)), p.warnings.join(' | '));
  assert.ok(p.warnings.some((w) => /à boire/.test(w)), 'pas assez de liquide emporté');
  assert.ok(p.have.gels === 1 && p.have.liters === 0.5);
});

test('plan : une barre quand l\'effort est facile, un gel quand il est dur', () => {
  const stock = { gel: 3, gelglu: 0, gelplus: 0, bar: 3, barmini: 0 };
  assert.equal(N.pickFood(stock, true), 'bar');
  assert.equal(N.pickFood(stock, false), 'gel');
  assert.equal(stock.bar, 2);
  assert.equal(stock.gel, 2);
  const only = { gel: 0, gelglu: 0, gelplus: 0, bar: 1, barmini: 0 };
  assert.equal(N.pickFood(only, false), 'bar', 'à défaut, ce qui reste');
  assert.equal(N.pickFood(only, false), null);
});

test('coach : rappels calés sur la dernière prise réelle, jamais avant l\'heure', () => {
  const p = N.planNutrition(base());
  const c = N.createCoach(p);
  const ctx = (extra) => Object.assign({ P3: 200, cp: 250, G: 0.9, lossPct: 0.3, remaining: 7200, easy: false, stock: { gels: 5, bars: 3 } }, extra);
  let r = c.update(0, ctx());
  assert.ok(r.eat.inS > 0 && r.drink.inS > 0, 'rien à faire au départ');
  r = c.update(p.food.firstS, ctx());
  assert.ok(r.eat.inS <= 0 && !r.eat.deferred, 'première prise à l\'heure');
  c.taken('eat', p.food.firstS + 120);                       // pris avec deux minutes de retard
  r = c.update(p.food.firstS + 130, ctx());
  assert.ok(Math.abs(r.eat.inS - (p.food.everyS - 10)) < 1.5, `${r.eat.inS} vs ${p.food.everyS - 10}`);
  c.taken('drink', 300);
  r = c.update(301, ctx());
  assert.ok(Math.abs(r.drink.inS - (p.drink.everyS - 1)) < 1.5);
});

test('coach : pendant un gros effort le rappel est reporté, il revient dès que ça se calme', () => {
  const p = N.planNutrition(base());
  const c = N.createCoach(p);
  const hard = { P3: 330, cp: 250, G: 0.9, lossPct: 0.3, remaining: 7200, easy: false, stock: { gels: 5, bars: 3 } };
  const t = p.food.firstS + 60;
  const r = c.update(t, hard);
  assert.ok(r.eat.deferred && r.eat.inS > 0);
  const calm = c.update(t + 5, Object.assign({}, hard, { P3: 200 }));
  assert.ok(!calm.eat.deferred && calm.eat.inS <= 0);
});

test('coach : réserve basse ou déshydratation, la prise passe devant l\'horaire ; arrivée proche, plus de solide', () => {
  const p = N.planNutrition(base());
  const c = N.createCoach(p);
  const ctx = { P3: 200, cp: 250, G: 0.9, lossPct: 0.3, remaining: 7200, easy: false, stock: { gels: 5, bars: 3 } };
  c.taken('eat', 1000); c.taken('drink', 1000);
  let r = c.update(1100, ctx);
  assert.ok(r.eat.inS > 0 && !r.eat.urgent);
  r = c.update(1500, Object.assign({}, ctx, { G: 0.40 }));
  assert.ok(r.eat.urgent && r.eat.inS <= 0, 'glycogène à 40 % : on mange sans attendre');
  r = c.update(1100, Object.assign({}, ctx, { lossPct: 1.8 }));
  assert.ok(r.drink.urgent && r.drink.inS <= 0, 'déshydratation : on boit');
  r = c.update(7000, Object.assign({}, ctx, { remaining: 600 }));
  assert.equal(r.eat, null, 'à 10 min de l\'arrivée, un gel ne sert plus');
  r = c.update(4000, Object.assign({}, ctx, { stock: { gels: 0, bars: 0 } }));
  assert.ok(r.eat.empty && r.eat.kind === null, 'plus rien dans les poches');
  r = c.update(4000, Object.assign({}, ctx, { easy: true }));
  assert.equal(r.eat.kind, 'bar');
  r = c.update(4000, Object.assign({}, ctx, { easy: false }));
  assert.equal(r.eat.kind, 'gel');
});

test('coach : état sauvegardé puis repris', () => {
  const p = N.planNutrition(base());
  const a = N.createCoach(p);
  a.taken('eat', 900); a.taken('drink', 1500);
  const b = N.createCoach(p);
  b.restore({ lastEat: a.lastEat, lastDrink: a.lastDrink });
  assert.equal(b.lastEat, 900);
  assert.equal(b.lastDrink, 1500);
});
