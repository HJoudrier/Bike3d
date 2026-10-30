/* author : Hugo Joudrier-Faure */
/* Tests de la lecture de Dropbox par les jeux et le compteur (Commun/js/core/cloud.js : pull, adresse de retour, envoi seul) avec un Dropbox simulé. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// navigateur minimal : stockage local, adresse, requêtes
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.location = { origin: 'https://exemple.test', pathname: '/site/Jeu2D/index.html', href: 'https://exemple.test/site/Jeu2D/index.html', search: '', hash: '' };
globalThis.history = { replaceState() {} };
const { PYR, makeProfile } = require('./helpers.js');
PYR.root = 'https://exemple.test/site/';
PYR.storageNs = 'paceyourride.jeu2d';
require(path.join(__dirname, '..', 'Commun/js/core/library.js'));
require(path.join(__dirname, '..', 'Commun/js/core/cloud.js'));
const L = PYR.library, C = PYR.cloud;

const route = (name) => { const p = makeProfile([{ len: 5000, grade: 0.03 }]); const coords = []; for (let i = 0; i < p.n; i++) coords.push([p.lat[i], p.lng[i], p.ele[i]]); return { route: { name, legs: [{ coords }], waypoints: [] } }; };
function snapshot() {
  const lib = L.empty();
  L.add(lib, 'route', 'Col', route('Col'), 1000);
  L.add(lib, 'athlete', 'Hugo', { rider: { name: 'Hugo', weight: 70, ftp: 260 } }, 1000);
  return { app: 'PaceYourRide', kind: 'cloud', version: 1, savedAt: 5000, project: Object.assign({ version: 1 }, route('Projet'), { rider: { name: 'Hugo' } }), library: lib };
}
const mock = (handler) => { globalThis.fetch = async (url, init) => handler(String(url), init || {}); };
const reply = (status, body, headers) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => (headers || {})[k.toLowerCase()] || null }, text: async () => body, json: async () => JSON.parse(body) });

test('cloud : les clés du stockage sont celles de l\'application, la connexion est commune', () => {
  assert.equal(L.STORAGE_KEY, 'paceyourride.jeu2d.library.v1');
  localStorage.setItem('paceyourride.cloud.v1', JSON.stringify({ access: 'tok', refresh: '', expiresAt: Date.now() + 1e9 }));
  assert.equal(C.status().connected, true);
});

test('cloud : pull rend la bibliothèque normalisée et le projet, sans toucher au stockage', async () => {
  mock((url) => { assert.match(url, /files\/download/); return reply(200, JSON.stringify(snapshot()), { 'dropbox-api-result': '{"rev":"a"}' }); });
  const before = JSON.stringify([...store.entries()]);
  const r = await C.pull();
  assert.equal(r.library.routes.length, 1);
  assert.equal(r.library.athletes[0].name, 'Hugo');
  assert.equal(r.savedAt, 5000);
  assert.ok(r.project && r.project.route.name === 'Projet');
  const after = [...store.entries()].filter(([k]) => k !== 'paceyourride.cloud.v1');
  assert.deepEqual(after, JSON.parse(before).filter(([k]) => k !== 'paceyourride.cloud.v1'), 'pull n\'écrit que la date de lecture de la connexion');
});

test('cloud : pull sans fichier rend null ; un autre fichier ou un fichier illisible est refusé avec un message clair', async () => {
  mock(() => reply(409, '{}'));
  assert.equal(await C.pull(), null);
  mock(() => reply(200, JSON.stringify({ app: 'Autre' })));
  await assert.rejects(C.pull(), /n'est pas un fichier PaceYourRide/);
  mock(() => reply(200, 'pas du json'));
  await assert.rejects(C.pull(), /illisible/);
  mock(() => { throw new TypeError('network'); });
  await assert.rejects(C.pull(), /injoignable/);
});

test('cloud : la connexion revient par le portail de la racine du site et se souvient de la page d\'origine', async () => {
  localStorage.removeItem('paceyourride.cloud.v1');
  await C.login();
  const u = new URL(location.href);
  assert.equal(u.origin + u.pathname, 'https://www.dropbox.com/oauth2/authorize');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://exemple.test/site/index.html');
  const pk = JSON.parse(localStorage.getItem('paceyourride.cloud.pkce'));
  assert.equal(pk.returnTo, 'https://exemple.test/site/Jeu2D/index.html');
  assert.equal(pk.redirect, 'https://exemple.test/site/index.html');
});
