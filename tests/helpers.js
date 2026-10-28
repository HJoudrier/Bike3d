/* author : Hugo Joudrier-Faure */
/* Chargement du moteur dans Node + parcours synthétiques pour les tests. */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const f of ['js/core/util.js', 'js/engine/physio.js', 'js/engine/physics.js', 'js/engine/weather.js', 'js/engine/course.js', 'js/engine/sim.js', 'js/engine/optimizer.js', 'js/engine/gradient.js',
  'js/engine/benchmarks.js', 'js/engine/draft.js', 'js/engine/peloton.js', 'js/engine/metabo.js', 'js/engine/fuel.js', 'js/engine/classif.js', 'js/engine/feed.js', 'js/engine/tactics.js', 'js/engine/race.js', 'js/engine/catalog.js', 'js/engine/plan-gpx.js', 'js/engine/plan-workout.js', 'js/engine/activity.js', 'js/engine/nutrition.js', 'js/engine/ride.js', 'js/engine/ride-mixed.js', 'js/engine/activity-export.js', 'js/engine/replay.js', 'js/engine/history.js', 'js/engine/presence.js', 'js/core/zip.js', 'js/ui/sensors.js']) {
  require(path.join(ROOT, f));
}
const PYR = globalThis.PYR;

/**
 * Profil régulier à partir de segments {len (m), grade, turn (° de virage à la fin, optionnel)}.
 */
function makeProfile(segments, opts = {}) {
  const step0 = opts.step || 10;
  const L = segments.reduce((s, g) => s + g.len, 0);
  const n = Math.round(L / step0) + 1;
  const step = L / (n - 1);
  const lat = new Float64Array(n), lng = new Float64Array(n), ele = new Float32Array(n);
  let la = 45, lo = 6, e = opts.ele0 || 200, heading = opts.heading || 0;
  let segIdx = 0, segStart = 0;
  lat[0] = la; lng[0] = lo; ele[0] = e;
  for (let i = 1; i < n; i++) {
    const x = (i - 0.5) * step;
    while (segIdx < segments.length - 1 && x > segStart + segments[segIdx].len) {
      heading += segments[segIdx].turn || 0;
      segStart += segments[segIdx].len;
      segIdx++;
    }
    const g = segments[segIdx].grade || 0;
    const h = heading * Math.PI / 180;
    la += Math.cos(h) * step / 111320;
    lo += Math.sin(h) * step / (111320 * Math.cos(la * Math.PI / 180));
    e += g * step;
    lat[i] = la; lng[i] = lo; ele[i] = e;
  }
  return { n, step, length: L, lat, lng, ele };
}

const DEFAULT_RIDER = { age: 35, weight: 72, height: 178, position: 'hoods_bent', helmet: 'road', clothing: 'fitted', ftp: 250, cp: 0, wPrime: 0, records: {} };
const DEFAULT_BIKE = { weight: 8.5, load: 1.5, frame: 'road', wheels: 'low', tire: 'road', drivetrain: 'clean', wheelMass: 2.2, spinMaxKmh: 65 };

function setupFor(profile, portions, env, opts, rider, bike) {
  const course = PYR.course.buildCourse(profile, portions || {}, env || { temperature: 20 }, opts || { aLat: 4.4, vmaxKmh: 90 });
  const setup = PYR.physics.buildSetup(rider || DEFAULT_RIDER, bike || DEFAULT_BIKE);
  const athlete = PYR.physio.buildAthlete(rider || DEFAULT_RIDER);
  return { course, setup, athlete };
}

/** Vérifie la courbe record sur toutes les fenêtres (renvoie le pire dépassement relatif). */
function worstWindowViolation(P, athlete, margin = 0) {
  const n = P.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + P[i];
  let worst = -Infinity;
  for (const d of PYR.physio.DURATIONS) {
    if (d > n) break;
    const cap = athlete.mmp(d) * (1 - margin);
    for (let i = d; i <= n; i++) {
      const m = (pre[i] - pre[i - d]) / d;
      const rel = m / cap - 1;
      if (rel > worst) worst = rel;
    }
  }
  return worst;
}

module.exports = { PYR, makeProfile, setupFor, worstWindowViolation, DEFAULT_RIDER, DEFAULT_BIKE };
