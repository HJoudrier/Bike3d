/* author : Hugo Joudrier-Faure */
/* Tests de la détection des revêtements d'après OpenStreetMap (voies simulées, sans réseau). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR, makeProfile } = require('./helpers.js');
require(path.join(__dirname, '..', 'js/core/surface-osm.js'));

const S = PYR.surfaceOsm;

/** Voie OpenStreetMap simulée le long du profil, des mètres a à b (décalée de `off` m vers l'est). */
function way(p, id, a, b, tags, off = 0) {
  const geometry = [];
  for (let m = a; m <= b; m += 50) {
    const i = Math.min(p.n - 1, Math.round(m / p.step));
    geometry.push({ lat: p.lat[i], lon: p.lng[i] + off / 78700 });
  }
  return { type: 'way', id, tags, geometry };
}

test('classify : revêtement de l\'application d\'après les tags', () => {
  assert.equal(S.classify({ highway: 'residential', surface: 'asphalt' }), 'asphalt');
  assert.equal(S.classify({ highway: 'residential', surface: 'sett' }), 'cobbles');
  assert.equal(S.classify({ highway: 'track', surface: 'compacted' }), 'gravel_hard');
  assert.equal(S.classify({ highway: 'track', tracktype: 'grade4' }), 'dirt');
  assert.equal(S.classify({ highway: 'track' }), 'gravel_hard');
  assert.equal(S.classify({ highway: 'path' }), 'dirt');
  assert.equal(S.classify({ highway: 'residential' }), null);
  assert.equal(S.classify({ highway: 'residential', surface: 'asphalt', smoothness: 'very_bad' }), 'rough');
  assert.equal(S.classify({ highway: 'residential', surface: 'asphalt;gravel' }), 'gravel_loose');
});

test('portions : pavés puis gravier, l\'asphalte ne crée rien, une voie croisée est ignorée', () => {
  const p = makeProfile([{ len: 6000, grade: 0 }]);
  const ways = [
    way(p, 1, 0, 2000, { highway: 'secondary', surface: 'asphalt' }),
    way(p, 2, 2000, 4000, { highway: 'secondary', surface: 'sett' }),
    way(p, 3, 4000, 6000, { highway: 'track', tracktype: 'grade2' }),
    way(p, 4, 1000, 1010, { highway: 'path', surface: 'dirt' }, 3),     // croisement court
  ];
  const stride = 2;
  const portions = S.toPortions(S.matchWays(p, ways, stride), stride, p.step, p.length);
  assert.equal(portions.length, 2);
  assert.equal(portions[0].surface, 'cobbles');
  assert.ok(Math.abs(portions[0].startKm - 2) < 0.05 && Math.abs(portions[0].endKm - 4) < 0.05);
  assert.equal(portions[1].surface, 'gravel_hard');
  assert.ok(Math.abs(portions[1].startKm - 4) < 0.05 && Math.abs(portions[1].endKm - 6) < 0.05);
});

test('portions : voie lointaine ou sans renseignement, aucune portion', () => {
  const p = makeProfile([{ len: 2000, grade: 0 }]);
  const far = way(p, 1, 0, 2000, { highway: 'track', surface: 'dirt' }, 200);
  const unknown = way(p, 2, 0, 2000, { highway: 'residential' });
  assert.deepEqual(S.toPortions(S.matchWays(p, [far, unknown], 2), 2, p.step, p.length), []);
});

test('portions : une voie sans renseignement après un chemin redevient asphalte', () => {
  const p = makeProfile([{ len: 3000, grade: 0 }]);
  const ways = [way(p, 1, 0, 1500, { highway: 'track', surface: 'gravel' }), way(p, 2, 1500, 3000, { highway: 'residential' })];
  const portions = S.toPortions(S.matchWays(p, ways, 2), 2, p.step, p.length);
  assert.equal(portions.length, 1);
  assert.ok(Math.abs(portions[0].endKm - 1.5) < 0.05);
});

test('detect : requête Overpass puis portions', async () => {
  const p = makeProfile([{ len: 3000, grade: 0 }]);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(decodeURIComponent(opts.body));
    return { ok: true, json: async () => ({ elements: [way(p, 1, 0, 1000, { highway: 'x', surface: 'asphalt' }), way(p, 2, 1000, 3000, { highway: 'x', surface: 'gravel' })] }) };
  };
  try {
    const r = await S.detect(p);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\(way\["highway"\]\["surface"~"[^"]*"\]\([\d.]+,[\d.]+,[\d.]+,[\d.]+\);.*\);out tags geom;$/);
    assert.match(calls[0], /\["highway"~"\^\(track\|path\|bridleway\)\$"\]/);
    assert.equal(r.portions.length, 1);
    assert.equal(r.portions[0].surface, 'gravel_loose');
  } finally { globalThis.fetch = realFetch; }
});

test('detect : l\'erreur dit pourquoi chaque serveur a échoué', async () => {
  const p = makeProfile([{ len: 1000, grade: 0 }]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await assert.rejects(() => S.detect(p), (e) => e.reasons.length === 3 && /overpass-api\.de : injoignable/.test(e.reasons[0]));
  } finally { globalThis.fetch = realFetch; }
});
