/* author : Hugo Joudrier-Faure */
/* PaceYourRide — construction du « parcours de simulation » :
 * grille régulière (~10 m) avec pente, cap, friction, largeur de route, vent, densité de l'air et vitesse limite (virages). */
(function (PYR) {
  'use strict';

  const U = PYR.util;
  const Ph = PYR.physics;

  /**
   * profile : {n, step, length, lat, lng, ele} (points régulièrement espacés, altitude lissée)
   * portions : {surfaces: [...], winds: [...]}
   *   surface : {startKm, endKm, surface, factor, width (m, facultative : sinon celle du revêtement)}
   *   vent    : {startKm, endKm, dir (° d'où vient le vent), speed (km/h), gusty, gust (km/h)}
   * env  : {temperature (°C), roadWidth (largeur de route hors portions, m ; 6 par défaut)}
   * opts : {aLat (m/s², 0 = pas de limite en virage), vmaxKmh, aBrake (m/s²),
   *         weather (instantané météo, cf. weather.js : vent, température, pluie… selon la position et l'heure,
   *         qui remplacent alors les portions de vent et la température)}
   */
  function buildCourse(profile, portions, env, opts) {
    opts = opts || {};
    env = env || {};
    portions = portions || {};
    const n = profile.n - 1; // nombre de cellules
    const step = profile.step;
    const L = profile.length;
    const ele = profile.ele, lat = profile.lat, lng = profile.lng;

    const grade = new Float32Array(n), sinT = new Float32Array(n), cosT = new Float32Array(n);
    const bear = new Float32Array(n), crrF = new Float32Array(n).fill(1), rho = new Float32Array(n);
    const crashR = new Float32Array(n).fill(1), punctR = new Float32Array(n).fill(1); // risques d'incident
    const punctT = new Uint8Array(n); // terrain de crevaison (rang dans Ph.PUNCT_TERRAINS : 0 route, 1 pavés, 2 gravier, 3 chemins)
    const wMean = new Float32Array(n), wAmp = new Float32Array(n), cosRel = new Float32Array(n), sinRel = new Float32Array(n);
    const sinRelS = new Float32Array(n); // sinus signé du vent relatif : > 0, vent venant de la droite du coureur
    const roadW = Ph.roadWidth(env.roadWidth);
    const width = new Float32Array(n).fill(roadW); // largeur praticable (m), pour le peloton du mode jeu
    const surf = new Uint8Array(n); // revêtement de chaque cellule : rang dans Ph.SURFACES + 1 (0 : route par défaut, hors portions)
    const windDir = new Float32Array(n).fill(NaN);
    const vLim = new Float32Array(n);

    // Pente
    for (let i = 0; i < n; i++) {
      const g = U.clamp((ele[i + 1] - ele[i]) / step, -0.35, 0.35);
      const th = Math.atan(g);
      grade[i] = g; sinT[i] = Math.sin(th); cosT[i] = Math.cos(th);
    }

    // Cap (radians, 0 = nord) — approximation équirectangulaire locale
    const ux = new Float32Array(n), uy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const cl = Math.cos(U.toRad(0.5 * (lat[i] + lat[i + 1])));
      const dx = (lng[i + 1] - lng[i]) * cl, dy = lat[i + 1] - lat[i];
      const b = Math.atan2(dx, dy);
      bear[i] = b; ux[i] = Math.sin(b); uy[i] = Math.cos(b);
    }
    // Cap lissé (±3 cellules) pour le calcul du vent relatif
    const bearS = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0;
      for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) { sx += ux[j]; sy += uy[j]; }
      bearS[i] = Math.atan2(sx, sy);
    }

    const cellRange = (p) => {
      const a = Math.max(0, Math.floor((Number(p.startKm) * 1000) / step));
      const b = Math.min(n, Math.ceil((Number(p.endKm) * 1000) / step));
      return [a, b];
    };

    // Revêtements (la dernière portion définie l'emporte en cas de chevauchement)
    for (const p of portions.surfaces || []) {
      const f = Ph.surfaceFactor(p);
      const risk = Ph.surfaceRisk(p);
      const w = Ph.surfaceWidth(p, roadW);
      const sid = Ph.SURFACES.indexOf(Ph.byId(Ph.SURFACES, p.surface, 1)) + 1;
      const [a, b] = cellRange(p);
      for (let i = a; i < b; i++) { crrF[i] = f; crashR[i] = risk.crash; punctR[i] = risk.punct; punctT[i] = risk.terrain; width[i] = w; surf[i] = sid; }
    }

    // Vent
    let hasGusts = false, hasWind = false;
    for (const p of portions.winds || []) {
      const [a, b] = cellRange(p);
      const sp = Math.max(0, Number(p.speed) || 0) / 3.6;
      const amp = p.gusty ? Math.max(0, (Number(p.gust) || 0) / 3.6 - sp) : 0;
      const dir = U.toRad(Number(p.dir) || 0);
      if (amp > 0) hasGusts = true;
      if (sp > 0 || amp > 0) hasWind = true;
      for (let i = a; i < b; i++) {
        wMean[i] = sp; wAmp[i] = amp; windDir[i] = Number(p.dir) || 0;
        const rel = dir - bearS[i];
        cosRel[i] = Math.cos(rel); sinRelS[i] = Math.sin(rel); sinRel[i] = Math.abs(sinRelS[i]);
      }
    }

    // Météo : vent, température, humidité, pression et pluie lus à chaque seconde (sim.js) ; les rafales viennent de la météo
    const weather = opts.weather || null;
    if (weather) {
      hasWind = true;
      for (let k = 0; k < weather.stations.length && !hasGusts; k++) {
        for (let h = 0; h < weather.n; h++) if (weather.gust[k][h] > weather.ws[k][h] + 0.3) { hasGusts = true; break; }
      }
    }

    // Densité de l'air (température donnée à l'altitude de départ, gradient −6,5 °C/km)
    const t0 = Number.isFinite(Number(env.temperature)) ? Number(env.temperature) : 20;
    const e0 = ele[0];
    for (let i = 0; i < n; i++) {
      const e = 0.5 * (ele[i] + ele[i + 1]);
      rho[i] = Ph.airDensity(e, t0 - 0.0065 * (e - e0));
    }

    // Vitesse limite : virages (accélération latérale max) + vitesse max absolue, puis freinage anticipé
    const vmax = (Number(opts.vmaxKmh) > 0 ? Number(opts.vmaxKmh) : 90) / 3.6;
    const aLat = Number(opts.aLat) > 0 ? Number(opts.aLat) : 0;
    const aBrake = Number(opts.aBrake) > 0 ? Number(opts.aBrake) : 3.5;
    const radius = new Float32Array(n).fill(Infinity);
    const kappa = new Float32Array(n); // courbure signée (1/m) : > 0 virage à droite (le cap croît), pour la trajectoire du peloton 2D
    for (let i = 0; i < n; i++) {
      let vl = vmax;
      if (n > 4) {
        const j0 = Math.max(0, i - 2), j1 = Math.min(n - 1, i + 2);
        const dTurn = U.wrapPi(bear[j1] - bear[j0]);
        const span = Math.max(1, j1 - j0) * step;
        kappa[i] = dTurn / span;
        if (aLat > 0) {
          const R = span / Math.max(Math.abs(dTurn), 1e-6);
          radius[i] = R;
          vl = Math.min(vl, Math.sqrt(aLat * R));
        }
      }
      vLim[i] = vl;
    }
    if (aLat > 0) {
      const tmp = Float32Array.from(vLim);
      for (let i = 0; i < n; i++) {
        let m = tmp[i];
        if (i > 0 && tmp[i - 1] < m) m = tmp[i - 1];
        if (i < n - 1 && tmp[i + 1] < m) m = tmp[i + 1];
        vLim[i] = m;
      }
    }
    for (let i = n - 2; i >= 0; i--) {
      const vb = Math.sqrt(vLim[i + 1] * vLim[i + 1] + 2 * aBrake * step);
      if (vb < vLim[i]) vLim[i] = vb;
    }

    return {
      n, step, length: L,
      grade, sinT, cosT, bear, bearS, crrF, rho, wMean, wAmp, cosRel, sinRel, sinRelS, windDir, vLim, radius, kappa, crashR, punctR, punctT, width, surf, roadWidth: roadW,
      ele, lat, lng,
      hasGusts, hasWind, aBrake, temperature: t0, weather,
    };
  }

  /** Altitude (m) interpolée à la distance s (m). */
  function eleAt(course, s) {
    const x = U.clamp(s / course.step, 0, course.n);
    const i = Math.min(course.n - 1, Math.floor(x));
    const f = x - i;
    return course.ele[i] * (1 - f) + course.ele[i + 1] * f;
  }

  /** Position [lat, lng] interpolée à la distance s (m). */
  function latLngAt(course, s) {
    const x = U.clamp(s / course.step, 0, course.n);
    const i = Math.min(course.n - 1, Math.floor(x));
    const f = x - i;
    return [course.lat[i] * (1 - f) + course.lat[i + 1] * f, course.lng[i] * (1 - f) + course.lng[i + 1] * f];
  }

  /**
   * Portions de revêtement effectives (celles que la simulation applique : la dernière portion définie l'emporte là où elles se
   * chevauchent), de proche en proche : [{s, end (m), surface (id de Ph.SURFACES), factor (multiplicateur du Crr), width (m)}].
   * Hors portions, la route par défaut (course.roadWidth) n'y figure pas.
   */
  function surfaceRuns(course) {
    const out = [], n = course.n, step = course.step;
    if (!course.surf) return out;
    let a = 0;
    for (let i = 1; i <= n; i++) {
      if (i < n && course.surf[i] === course.surf[a] && course.width[i] === course.width[a] && course.crrF[i] === course.crrF[a]) continue;
      if (course.surf[a] > 0) {
        out.push({ s: a * step, end: Math.min(course.length, i * step), surface: Ph.SURFACES[course.surf[a] - 1].id, factor: course.crrF[a], width: course.width[a] });
      }
      a = i;
    }
    return out;
  }

  PYR.course = { buildCourse, eleAt, latLngAt, surfaceRuns };
})(globalThis.PYR = globalThis.PYR || {});
