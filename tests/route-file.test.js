/* author : Hugo Joudrier-Faure */
/* Tests du parcours complet en fichier (GPX enrichi) : export puis import redonnent le même parcours. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR, makeProfile } = require('./helpers.js');
require(path.join(__dirname, '..', 'js/core/route-file.js'));

const RF = PYR.routeFile;

/** Lecture minimale du GPX produit par build (le navigateur passe par DOMParser, voir services.parseGpx). */
function readGpx(text) {
  const points = [];
  const re = /<trkpt lat="([^"]+)" lon="([^"]+)">(?:<ele>([^<]+)<\/ele>)?<\/trkpt>/g;
  for (let m; (m = re.exec(text));) points.push([+m[1], +m[2], m[3] === undefined ? null : +m[3]]);
  const ext = /<pyr:route[^>]*>([^<]*)<\/pyr:route>/.exec(text);
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const name = /<trk><name>([^<]*)<\/name>/.exec(text);
  return { name: name ? unescape(name[1]) : '', points, hasEle: true, data: ext ? JSON.parse(unescape(ext[1])) : null };
}

/** Projet avec un tracé de trois tronçons (coordonnées arrondies comme dans la sauvegarde) et son profil. */
function project() {
  const p = makeProfile([{ len: 6000, grade: 0 }, { len: 4000, grade: 0.06, turn: 40 }, { len: 4000, grade: -0.05, turn: -70 }, { len: 6000, grade: 0 }]);
  const coords = [];
  for (let i = 0; i < p.n; i += 7) coords.push([+p.lat[i].toFixed(6), +p.lng[i].toFixed(6), i === 14 ? null : +(+p.ele[i]).toFixed(1)]);
  const cut = [0, 100, 200, coords.length - 1];
  const legs = [];
  for (let k = 0; k < 3; k++) legs.push({ mode: ['fastbike', 'gpx', 'straight'][k], coords: coords.slice(cut[k], cut[k + 1] + 1).map((c) => c.slice()) });
  // un tronçon routé ne repart pas exactement du point d'arrivée du précédent
  legs[1].coords[0] = [legs[1].coords[0][0] + 0.00002, legs[1].coords[0][1], legs[1].coords[0][2]];
  const waypoints = cut.map((i) => ({ lat: coords[i][0], lng: coords[i][1] }));
  const state = {
    route: { name: 'Tour <des> « lacs » & cols', mode: 'lowtraffic', fixed: null, waypoints, legs },
    checkpoints: [{ id: 'a', type: 'sprint', km: 4.5, pts: [10, 5] }, { id: 'b', type: 'kom', km: 10, startKm: 6, cat: '2' }],
    feedZones: [{ id: 'f', startKm: 15, endKm: 15.5 }],
    surfaces: [{ id: 's', startKm: 1, endKm: 2, surface: 'cobbles', factor: 2.2, width: 4 }],
    winds: [{ id: 'w', startKm: 0, endKm: 20, dir: 270, speed: 20, gusty: true, gust: 40 }],
    weather: { enabled: true, source: 'custom', startAt: '2026-10-28T08:30', snapshot: null, custom: { baseT: 12, temp: [{ id: 't', startKm: 8, endKm: 12, T: 4 }], rain: [{ id: 'r', startKm: 0, endKm: 5, rain: 2 }] } },
    road: { width: 5 },
    rider: { name: 'pas exporté' },
  };
  const profile = Object.assign(p, { stats: { length: p.length, up: 240, down: 200 } });
  return { state, profile };
}

test('parcours complet : export puis import redonnent tracé, tronçons, points en jeu, portions et météo', () => {
  const { state, profile } = project();
  const gpx = RF.build(state, profile, Date.UTC(2026, 9, 28));
  assert.match(gpx, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<gpx version="1.1" creator="PaceYourRide"/);
  assert.ok(gpx.includes('<name>Tour &lt;des&gt; « lacs » &amp; cols</name>'));
  assert.ok(!gpx.includes('pas exporté'), 'le cycliste ne fait pas partie du parcours');
  // des points lisibles par les autres applis : sprint, sommet, ravitaillement
  assert.equal((gpx.match(/<wpt /g) || []).length, 3);
  assert.ok(/<type>sprint<\/type>/.test(gpx) && /<sym>Summit<\/sym><type>kom<\/type>/.test(gpx) && /<type>feed<\/type>/.test(gpx));
  assert.ok(gpx.indexOf('<wpt ') < gpx.indexOf('<trk>') && gpx.indexOf('<trk>') < gpx.indexOf('<extensions>'), 'ordre du schéma GPX 1.1');

  const out = RF.restore(readGpx(gpx));
  assert.equal(out.route.name, state.route.name);
  assert.equal(out.route.mode, 'lowtraffic');
  assert.equal(out.route.fixed, null);
  assert.deepEqual(out.route.waypoints, state.route.waypoints);
  assert.deepEqual(out.route.legs.map((l) => l.mode), ['fastbike', 'gpx', 'straight']);
  // le profil ne lit pas le premier point des tronçons suivants : la trace concaténée est identique
  const concat = (legs) => legs.flatMap((l, k) => l.coords.slice(k ? 1 : 0));
  assert.deepEqual(concat(out.route.legs), concat(state.route.legs));
  assert.equal(out.route.legs[0].coords.length, state.route.legs[0].coords.length);
  for (const k of ['checkpoints', 'feedZones', 'surfaces', 'winds', 'weather', 'road']) assert.deepEqual(out[k], state[k], k);
  assert.equal(out.rider, undefined);
  assert.equal(RF.summary(out), '1 sprint, 1 côte classée, 1 ravitaillement, 1 portion de revêtement, 1 portion de vent, météo personnalisée');
});

test('parcours complet : parcours figé (défi) relu à l\'identique ; découpage incohérent ; simple trace', () => {
  const { state, profile } = project();
  const pts = state.route.legs.flatMap((l, k) => l.coords.slice(k ? 1 : 0));
  state.route.fixed = { n: pts.length, step: 70.1, lat: pts.map((p) => Math.round(p[0] * 1e6)), lng: pts.map((p) => Math.round(p[1] * 1e6)), ele: pts.map((p) => Math.round((p[2] || 0) * 100)) };
  state.route.legs = [];
  const fixed = RF.restore(readGpx(RF.build(state, profile)));
  assert.deepEqual(fixed.route.fixed, state.route.fixed);
  assert.equal(fixed.route.waypoints.length, 2);

  // tronçons qui ne collent pas à la trace : une seule portion « gpx », géométrie gardée
  const { state: s2, profile: p2 } = project();
  const parsed = readGpx(RF.build(s2, p2));
  parsed.data.route.legs[1].to = 99999;
  const one = RF.restore(parsed);
  assert.equal(one.route.legs.length, 1);
  assert.equal(one.route.legs[0].mode, 'gpx');
  assert.equal(one.route.legs[0].coords.length, parsed.points.length);

  // une simple trace (ou un fichier d'une autre appli) n'est pas un parcours complet
  assert.equal(RF.restore({ name: 'x', points: parsed.points, data: null }), null);
  assert.equal(RF.restore({ name: 'x', points: parsed.points, data: { app: 'Autre' } }), null);
  assert.throws(() => RF.restore({ points: [[45, 6, 0]], data: parsed.data }), /Aucune trace/);
});
