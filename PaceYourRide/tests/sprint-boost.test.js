/* author : Hugo Joudrier-Faure */
/* Tests de l'effort « Sprint » du joueur : chaque appui monte la consigne de 20 % de l'écart entre le haut de la zone PMA et le
 * record de puissance le plus élevé ; elle retombe sans appui puis rend la main à la tactique d'avant. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR } = require('./helpers.js');

const Tac = PYR.tactics;
const rider = (mode = 'manual') => ({
  human: true, bot: null, nextCp: 0,
  st: { capK: 1, t: 10, s: 100 },
  athlete: { ftp: 250, pmax: 1000, mmp: () => 330 },
  tac: { mode, cmd: 200, pull: 0 },
});

test('fourchette : du haut de la zone PMA (120 % de la FTP) au record le plus élevé', () => {
  const r = rider();
  assert.deepEqual(Tac.boostRange(r), { lo: 300, hi: 1000 });
  r.st.capK = 0.9; // fringale : tout est réduit
  assert.deepEqual(Tac.boostRange(r), { lo: 270, hi: 900 });
});

test('chaque appui ajoute 20 % de la fourchette, sans jamais dépasser le record', () => {
  const r = rider();
  const P = [1, 2, 3, 4, 5, 6].map(() => Math.round(Tac.sprintTap(r, 10, null)));
  assert.deepEqual(P, [440, 580, 720, 860, 1000, 1000]);
  assert.equal(r.tac.mode, 'sprint');
  assert.equal(Tac.command(r, { field: [], info: {} }, {}), 1000);
});

test('sans appui, l\'effort est retombé une seconde après le dernier appui et la tactique d\'avant est reprise', () => {
  const r = rider('threshold');
  for (let i = 0; i < 3; i++) Tac.sprintTap(r, 10, null); // 60 %
  assert.equal(Tac.decayBoost(r, 0.1), false);
  assert.ok(Math.abs(r.tac.boost - 0.6) < 1e-9, 'délai de grâce : le niveau ne bouge pas');
  assert.equal(Tac.decayBoost(r, 0.5), false); // 0,6 s sans appui : en cours de descente
  assert.ok(r.tac.boost > 0 && r.tac.boost < 0.4, 'descend vite');
  assert.equal(Tac.decayBoost(r, 0.4), true);   // 1,0 s sans appui
  assert.equal(r.tac.mode, 'threshold', 'retour à la tactique d\'avant l\'effort');
});

test('un nouvel appui repart du niveau atteint et relance le décompte', () => {
  const r = rider();
  Tac.sprintTap(r, 10, null); Tac.sprintTap(r, 10, null); // 40 %
  Tac.decayBoost(r, 0.5);
  Tac.sprintTap(r, 10, null);
  assert.ok(r.tac.boost > 0.4 && r.tac.boost < 0.6, 'niveau en baisse + 20 %');
  assert.equal(r.tac.idle, 0);
});

test('un coureur virtuel n\'est pas concerné par la décroissance', () => {
  const r = rider();
  r.human = false; r.bot = { aggr: 0.2, sprint: 0.5, climb: 0.5, team: 0.5, level: 1 };
  Tac.setMode(r, 'sprint', 10, null);
  assert.equal(Tac.decayBoost(r, 5), false);
  assert.equal(r.tac.mode, 'sprint');
});
