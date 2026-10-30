/* author : Hugo Joudrier-Faure */
/* Tests du retour à ×1 aux évènements : réglages par évènement et zones avant les points de passage. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR } = require('./helpers.js');
require(path.join(__dirname, '..', 'Commun/js/engine/slowdown.js'));

const Sd = PYR.slowdown;
const L = 5246;
const cps = PYR.classif.normalize([
  { type: 'sprint', s: 2000, pts: [5, 3, 1] },
  { type: 'kom', s: 3500, start: 2800, len: 700, gain: 50, cat: '4' },
], L);
const game = { slowSprint: 1000, slowSprintPause: 3, slowKom: 500, slowKomPause: 0, slowFinish: 1000, slowFinishPause: 2, slowAttack: 60, slowAttackPause: 4, slowCrash: 0, slowCrashPause: 0, slowPuncture: 30, slowPuncturePause: 0 };

test('évènements : durée et pause ; un cas à 0 s sans pause est ignoré ; les autres types ne sont pas concernés', () => {
  assert.deepEqual(Sd.eventSpec(game, 'attack'), { dur: 60, pause: 4 });
  assert.deepEqual(Sd.eventSpec(game, 'puncture'), { dur: 30, pause: 0 });
  assert.equal(Sd.eventSpec(game, 'crash'), null);
  assert.equal(Sd.eventSpec(game, 'feed'), null);
  assert.deepEqual(Sd.eventSpec({ slowCrash: 0, slowCrashPause: 5 }, 'crash'), { dur: 0, pause: 5 }, 'pause seule');
});

test('sprint intermédiaire : zone sur les N derniers mètres, seulement tant qu\'il n\'est pas franchi', () => {
  assert.equal(Sd.zoneFor(cps, 0, 999, game), null);
  assert.deepEqual(Sd.zoneFor(cps, 0, 1000, game), { k: 0, kind: 'sprint', pause: 3 });
  assert.equal(Sd.zoneFor(cps, 0, 1999.9, game).kind, 'sprint');
  assert.equal(Sd.zoneFor(cps, 1, 1500, game), null, 'déjà franchi (nextCp après le sprint)');
});

test('côte classée : sur les N derniers mètres avant le sommet, pas dès le pied', () => {
  assert.equal(Sd.zoneFor(cps, 1, 2800, game), null, 'au pied de la côte (km 2,8)');
  assert.equal(Sd.zoneFor(cps, 1, 2999, game), null, 'dans la côte, loin du sommet');
  assert.equal(Sd.zoneFor(cps, 1, 3000, game).kind, 'kom'); // sommet à 3 500 m, 500 m avant
  assert.equal(Sd.zoneFor(cps, 1, 3499, game).kind, 'kom');
  assert.equal(Sd.zoneFor(cps, 2, 3499, game), null, 'sommet franchi');
});

test('arrivée : le dernier kilomètre ; un réglage à 0 désactive le cas', () => {
  assert.deepEqual(Sd.zoneFor(cps, 2, L - 1000, game), { k: 2, kind: 'finish', pause: 2 });
  assert.equal(Sd.zoneFor(cps, 2, L - 1001, game), null);
  assert.equal(Sd.zoneFor(cps, 2, L - 500, Object.assign({}, game, { slowFinish: 0 })), null);
  assert.equal(Sd.zoneFor(null, 0, 1500, game), null);
});
