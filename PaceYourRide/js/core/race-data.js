/* author : Hugo Joudrier-Faure */
/* PaceYourRide — données de course partagées (défis en différé et courses en direct).
 * Un « parcours canonique » est quantifié (µdegrés, centimètres) : tous les joueurs simulent
 * exactement le même parcours, avec les mêmes portions de vent / revêtement et les mêmes options. */
(function (PYR) {
  'use strict';

  const C = PYR.codec;
  const SEED = 20240917;

  const r3 = (x) => Math.round(Number(x) * 1000) / 1000;

  function normPortions(state) {
    return {
      // largeur de la portion : seulement si elle est saisie, pour que les empreintes des anciens défis ne changent pas
      surfaces: (state.surfaces || []).map((s) => Object.assign({ startKm: r3(s.startKm), endKm: r3(s.endKm), surface: String(s.surface), factor: r3(s.factor || 1) },
        Number(s.width) > 0 ? { width: r3(s.width) } : null)),
      winds: (state.winds || []).map((w) => ({ startKm: r3(w.startKm), endKm: r3(w.endKm), dir: r3(w.dir), speed: r3(w.speed), gusty: !!w.gusty, gust: r3(w.gust || 0) })),
    };
  }

  /**
   * Météo figée avec le parcours : seulement si elle est activée et correspond à ce tracé et à cette heure de départ
   * (sinon null). Absente, rien n'est ajouté au parcours : les empreintes des anciens défis ne changent pas.
   */
  function weatherOf(state, profile) {
    const w = state.weather;
    if (!w || !w.enabled || !w.snapshot || !profile || !PYR.weather) return null;
    return w.fetchedFor === PYR.weather.freshKey(profile, w.startAt) ? PYR.weather.normalize(w.snapshot) : null;
  }

  function normOpts(state) {
    const p = state.perf || {};
    // largeur de route par défaut : seulement si elle diffère de celle de toujours (6 m), même raison
    const rw = state.road && Number(state.road.width) > 0 ? r3(state.road.width) : 6;
    return {
      env: Object.assign({ temperature: r3(state.env ? state.env.temperature : 20) }, rw !== 6 ? { roadWidth: rw } : null),
      opts: { cornering: String(p.cornering || 'normal'), vmaxKmh: r3(p.vmaxKmh || 80), startSpeedKmh: r3(p.startSpeedKmh || 0) },
    };
  }

  /** Parcours canonique à partir du profil courant et des réglages de l'état. */
  function canonicalCourse(profile, state) {
    const n = profile.n;
    const lat = new Array(n), lng = new Array(n), ele = new Array(n);
    for (let i = 0; i < n; i++) {
      lat[i] = Math.round(profile.lat[i] * 1e6);
      lng[i] = Math.round(profile.lng[i] * 1e6);
      ele[i] = Math.round(profile.ele[i] * 100);
    }
    const course = Object.assign({ v: 1, n, step: Math.round(profile.step * 1e6) / 1e6, lat, lng, ele, seed: SEED }, normPortions(state), normOpts(state));
    const weather = weatherOf(state, profile);
    if (weather) course.weather = weather;
    return course;
  }

  /** Géométrie seule (ce que le tracé mémorise). */
  function courseGeometry(course) {
    return { n: course.n, step: course.step, lat: course.lat, lng: course.lng, ele: course.ele };
  }

  /** Profil (format du modèle de tracé) à partir d'une géométrie canonique. */
  function geometryProfile(g) {
    const n = g.n;
    const lat = new Float64Array(n), lng = new Float64Array(n), ele = new Float32Array(n);
    for (let i = 0; i < n; i++) { lat[i] = g.lat[i] / 1e6; lng[i] = g.lng[i] / 1e6; ele[i] = g.ele[i] / 100; }
    return { n, step: g.step, length: g.step * (n - 1), lat, lng, ele };
  }

  /** Empreinte d'un parcours complet (géométrie + portions + options). */
  function signature(geometry, portions, envOpts, weather) {
    const parts = [String(geometry.n), String(geometry.step), geometry.lat, geometry.lng, geometry.ele,
      JSON.stringify(portions), JSON.stringify(envOpts), String(SEED)];
    if (weather) parts.push(JSON.stringify(weather)); // sans météo, l'empreinte est celle d'avant
    return C.hash(...parts);
  }

  function courseSignature(course) {
    return signature(course, { surfaces: course.surfaces, winds: course.winds }, { env: course.env, opts: course.opts }, course.weather);
  }

  /** Empreinte du parcours actuellement chargé (null s'il n'est pas canonique). */
  function currentSignature(state) {
    const fx = state.route && state.route.fixed;
    if (!fx) return null;
    return signature(fx, normPortions(state), normOpts(state), weatherOf(state, geometryProfile(fx)));
  }

  /* ---------- Empaquetage compact (tableaux en différences successives) ---------- */
  function packCourse(c) {
    return Object.assign({}, c, { lat: C.delta(c.lat), lng: C.delta(c.lng), ele: C.delta(c.ele), enc: 'd' });
  }
  function unpackCourse(p) {
    const c = p.enc === 'd' ? Object.assign({}, p, { lat: C.undelta(p.lat), lng: C.undelta(p.lng), ele: C.undelta(p.ele) }) : p;
    delete c.enc;
    // météo reçue du réseau : vérifiée, sinon abandonnée (le parcours se joue alors sans météo)
    if (c.weather) {
      const w = PYR.weather ? PYR.weather.normalize(c.weather) : null;
      if (w) c.weather = w; else delete c.weather;
    }
    return c;
  }

  /** Résultat : position à chaque seconde en décimètres (différences secondes), puissance en W. */
  function packEntry(e) {
    const sDm = e.s.map((x) => Math.round(x * 10));
    return Object.assign({}, e, { s: C.delta(C.delta(sDm)), P: C.delta(e.P.map((x) => Math.round(x))), enc: 'd2' });
  }
  function unpackEntry(p) {
    if (p.enc !== 'd2') return p;
    const e = Object.assign({}, p, { s: C.undelta(C.undelta(p.s)).map((x) => x / 10), P: C.undelta(p.P) });
    delete e.enc;
    return e;
  }

  /** Temps (s, interpolé) auquel une trace « position à chaque seconde » atteint la distance s. */
  function traceTimeAt(sArr, s, tFinish) {
    const n = sArr.length - 1;
    if (s <= 0) return 0;
    if (s >= sArr[n]) return tFinish !== undefined ? tFinish : n;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sArr[m] < s) lo = m; else hi = m; }
    const span = sArr[hi] - sArr[lo];
    return lo + (span > 0 ? (s - sArr[lo]) / span : 0);
  }

  /** Position (m) d'une trace au temps t (s). */
  function tracePosAt(sArr, t) {
    if (t <= 0) return sArr[0] || 0;
    const i = Math.floor(t);
    if (i >= sArr.length - 1) return sArr[sArr.length - 1];
    return sArr[i] + (sArr[i + 1] - sArr[i]) * (t - i);
  }

  PYR.raceData = {
    SEED, canonicalCourse, courseGeometry, geometryProfile, signature, courseSignature, currentSignature,
    normPortions, normOpts, weatherOf, packCourse, unpackCourse, packEntry, unpackEntry, traceTimeAt, tracePosAt,
  };
})(globalThis.PYR = globalThis.PYR || {});
