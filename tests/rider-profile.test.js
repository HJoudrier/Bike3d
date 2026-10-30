/* author : Hugo Joudrier-Faure */
/* Tests de l'export / import du profil du cycliste (store.exportRider / store.importRider). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR } = require('./helpers.js');
require(path.join(__dirname, '..', 'Commun/js/core/store.js'));

const store = PYR.store;
store.save = () => {};                       // pas de stockage local dans les tests
store.saveNow = () => {};

const sample = () => ({
  name: 'Camille', sex: 'f', birthDate: '', age: 41, weight: 58.5, height: 166, position: 'hoods', helmet: 'aero', clothing: 'aero',
  glasses: 'shield', socks: 'aero', shave: 'legs', gut: 0.5, ftp: 230, cp: 240, wPrime: 18.5, pmax: 1050, records: { 5: 800, 60: 450, 1200: 235 },
  // carte athlète du modèle physiologique : quelques champs saisis, les autres vides (estimés)
  physio: Object.assign(Object.fromEntries(PYR.metabo.FIELDS.map((f) => [f.key, ''])), { cp1: 185, fI: 62, sweatNa: 70, heatAcc: 50 }),
});

const EQUIP = ['position', 'helmet', 'clothing', 'glasses', 'socks', 'shave'];
const equipOf = (r) => EQUIP.map((k) => r[k]);

test('profil : export puis import redonne le même profil, sans parcours ni équipement (vélo, tenue, position)', () => {
  store.state.rider = sample();
  const file = JSON.parse(store.exportRider());
  assert.equal(file.app, 'PaceYourRide');
  assert.equal(file.kind, 'rider');
  assert.deepEqual(Object.keys(file.rider).sort(), Object.keys(sample()).filter((k) => !EQUIP.includes(k)).sort());
  assert.ok(!('route' in file) && !('bike' in file));
  // sur un autre poste : tenue et position différentes, elles ne bougent pas au chargement
  store.state.rider = Object.assign(sample(), { name: '', ftp: 100, position: 'upright', helmet: 'city', clothing: 'loose', glasses: 'none', socks: 'short', shave: 'full' });
  const bike = store.state.bike;
  store.importRider(file);
  const want = sample();
  for (const k of EQUIP) want[k] = { position: 'upright', helmet: 'city', clothing: 'loose', glasses: 'none', socks: 'short', shave: 'full' }[k];
  assert.deepEqual(store.state.rider, want);
  assert.equal(store.state.bike, bike, 'le vélo est conservé');
});

test('profil : un projet complet fournit aussi son cycliste', () => {
  store.state.rider = sample();
  store.importRider(JSON.parse(store.exportProject()));
  assert.equal(store.state.rider.name, 'Camille');
});

test('profil : valeurs hors bornes ou inconnues corrigées, records inconnus abandonnés', () => {
  store.state.rider = sample();
  store.importRider({ rider: { name: 'x'.repeat(80), sex: 'z', age: 500, weight: 'abc', height: 10, position: 'upright', ftp: 5000, cp: 5, wPrime: '', pmax: 9000, gut: 0.7, records: { 5: 99999, 7: 300, 60: -4, 300: 280 } } });
  const r = store.state.rider;
  assert.equal(r.name.length, 30);
  assert.equal(r.sex, 'm');
  assert.equal(r.age, 99);
  assert.equal(r.weight, 72, 'valeur illisible : défaut');
  assert.equal(r.height, 120);
  assert.deepEqual(equipOf(r), equipOf(sample()), 'tenue et position inchangées, même si le fichier en contient');
  assert.equal(r.ftp, 600);
  assert.equal(r.cp, 50);
  assert.equal(r.wPrime, '');
  assert.equal(r.pmax, 3000);
  assert.equal(r.gut, 0.5, 'niveau le plus proche');
  assert.deepEqual(r.records, { 300: 280 }, 'record hors 10–3000 W ou durée inconnue : abandonné');
  assert.ok(Object.values(r.physio).every((v) => v === ''), 'sans carte athlète : tous les champs estimés');
});

test('profil : carte athlète du modèle physiologique bornée, champs inconnus ou illisibles abandonnés', () => {
  store.state.rider = sample();
  store.importRider({ rider: Object.assign(sample(), { physio: { cp1: 5000, fI: 'abc', sweatNa: 3, glyFill: 75, inconnu: 12 } }) });
  const p = store.state.rider.physio;
  assert.equal(p.cp1, PYR.metabo.FIELD.cp1.max);
  assert.equal(p.fI, '', 'illisible : estimé');
  assert.equal(p.sweatNa, PYR.metabo.FIELD.sweatNa.min);
  assert.equal(p.glyFill, 75);
  assert.ok(!('inconnu' in p));
  assert.deepEqual(Object.keys(p).sort(), PYR.metabo.FIELDS.map((f) => f.key).sort());
});

test('profil : fichier sans cycliste ou défi partagé refusé, profil actuel inchangé', () => {
  store.state.rider = sample();
  assert.throws(() => store.importRider(null), /invalide/);
  assert.throws(() => store.importRider({ route: {} }), /invalide/);
  assert.throws(() => store.importRider({ kind: 'challenge', rider: sample() }), /invalide/);
  assert.deepEqual(store.state.rider, sample());
});

test("profil : l'âge se déduit de la date de naissance et se recalcule", () => {
  const U = PYR.util, at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();
  assert.equal(U.ageFrom('1990-06-15', at(2026, 6, 14)), 35, "la veille de l'anniversaire");
  assert.equal(U.ageFrom('1990-06-15', at(2026, 6, 15)), 36, "le jour de l'anniversaire");
  assert.equal(U.ageFrom('1990-02-30'), null, 'date impossible');
  assert.equal(U.ageFrom('2999-01-01'), null, 'date future');
  assert.equal(U.ageFrom(''), null);
  store.state.rider = sample();
  store.set('rider.birthDate', '1990-06-15', true);
  assert.equal(store.state.rider.age, U.ageFrom('1990-06-15'), "l'âge suit la date saisie");
  store.set('rider.birthDate', 'n’importe quoi', true);
  assert.equal(store.state.rider.birthDate, '', 'date invalide abandonnée');
  const file = JSON.parse(JSON.stringify({ rider: Object.assign(sample(), { birthDate: '1980-01-01', age: 12 }) }));
  store.importRider(file);
  assert.equal(store.state.rider.birthDate, '1980-01-01');
  assert.equal(store.state.rider.age, U.ageFrom('1980-01-01'), "l'âge du fichier est recalculé d'après la date");
});

test('profil : Pmax saisie remplace le record 1 s dans la signature, vide = record 1 s de la courbe', () => {
  const Pz = PYR.physio, base = { ftp: 250, records: { 1: 1200, 300: 330 } };
  const est = Pz.buildAthlete(Object.assign({}, base, { pmax: '' }));
  assert.equal(Math.round(est.pmax), 1200);
  assert.equal(est.pmaxSource, 'estimée');
  const own = Pz.buildAthlete(Object.assign({}, base, { pmax: 1450 }));
  assert.equal(own.pmax, 1450);
  assert.equal(own.pmaxSource, 'saisie');
  assert.equal(Math.round(own.mmp(1)), 1200, 'la courbe record garde le record 1 s');
});
