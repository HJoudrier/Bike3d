/* author : Hugo Joudrier-Faure */
/* PaceYourRide — météo d'un parcours : un champ de conditions qui varie avec la position ET avec l'heure.
 *
 * Instantané (figé avec le parcours, partageable) :
 *   {v: 1, start (s, epoch UTC du départ de la course), off (décalage UTC du lieu de départ, s), t0 (s, epoch de la 1ʳᵉ heure), n (nombre d'heures),
 *    stations: [{s (m), lat, lng, ele (m)}] triées par distance,
 *    T (°C), rh (%), p (hPa, niveau de la mer), rain (mm/h), ws (m/s à 10 m), wd (° d'où vient le vent), gust (m/s) :
 *    un tableau de n valeurs par station}
 * Les valeurs viennent de prévisions horaires (Open-Meteo) ; `at()` interpole linéairement entre stations
 * (distance) et entre heures (temps) : un coureur en avance ou en retard ne rencontre pas les mêmes conditions.
 *
 * Effets sur la course (coefficients approchés, documentés dans le README) :
 *   - air : densité de l'air humide (température, humidité, pression) ;
 *   - vent : mesuré à 10 m, ramené à hauteur de cycliste (× 0,7) ;
 *   - pluie : route mouillée (avec mémoire : elle sèche en ≈ 1 à 2 h) → roulement, adhérence (virages, freinage,
 *     descentes), risque de chute et de crevaison ; rafales violentes et verglas aggravent le risque de chute ;
 *   - chaleur : température ressentie (indice de chaleur) → baisse de capacité et sueur ; grand froid : baisse légère. */
(function (PYR) {
  'use strict';

  const WIND_K = 0.7;         // vent à hauteur de cycliste / vent à 10 m
  const MAX_STATIONS = 4000, MAX_HOURS = 96;      // 12 stations au plus pour des prévisions Open-Meteo ; une météo personnalisée en prend deux par portion (le plafond n'est qu'une garde contre les données corrompues)
  const WET_DECAY = 0.55;     // la route garde 55 % de son humidité d'une heure à l'autre : elle sèche en 1 à 2 h
  const FIELDS = ['T', 'rh', 'p', 'rain', 'ws', 'wd', 'gust'];
  const LIMITS = { T: [-60, 60], rh: [0, 100], p: [850, 1100], rain: [0, 200], ws: [0, 80], wd: [0, 360], gust: [0, 100] };
  const DEFAULTS = { T: 15, rh: 60, p: 1013.25, rain: 0, ws: 0, wd: 0, gust: 0 };

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const r1 = (x) => Math.round(x * 10) / 10;
  const num = (x) => typeof x === 'number' && Number.isFinite(x);

  /* ---------- Choix des stations, validation, lecture d'une réponse Open-Meteo ---------- */

  /**
   * Points du parcours où demander la météo : départ, arrivée et, entre les deux, un point tous les ≈ 10 km
   * (de 2 à 12 au total). profile : {n, step, length, lat, lng, ele}.
   */
  function stationsFor(profile) {
    const L = profile.length, k = clamp(Math.round(L / 10000) + 1, 2, 12);
    const out = [];
    for (let i = 0; i < k; i++) {
      const s = (L * i) / (k - 1);
      const j = clamp(Math.round(s / profile.step), 0, profile.n - 1);
      out.push({ s: Math.round(s), lat: Math.round(profile.lat[j] * 1e5) / 1e5, lng: Math.round(profile.lng[j] * 1e5) / 1e5, ele: Math.round(profile.ele[j]) });
    }
    return out;
  }

  /** Instantané vérifié (construit ici ou reçu d'un autre joueur) : valeurs bornées et arrondies, ou null s'il est invalide. */
  function normalize(w) {
    if (!w || typeof w !== 'object' || w.v !== 1) return null;
    if (!num(w.start) || !num(w.t0)) return null;
    const n = w.n;
    if (!Number.isInteger(n) || n < 1 || n > MAX_HOURS) return null;
    if (!Array.isArray(w.stations) || w.stations.length < 1 || w.stations.length > MAX_STATIONS) return null;
    const K = w.stations.length;
    const stations = [];
    for (const s of w.stations) {
      if (!s || !num(s.s) || !num(s.lat) || !num(s.lng) || !num(s.ele) || s.s < 0) return null;
      stations.push({ s: Math.round(s.s), lat: Math.round(s.lat * 1e5) / 1e5, lng: Math.round(s.lng * 1e5) / 1e5, ele: Math.round(s.ele) });
    }
    for (let k = 1; k < K; k++) if (!(stations[k].s > stations[k - 1].s)) return null;
    const out = { v: 1, start: Math.round(w.start), off: num(w.off) ? Math.round(clamp(w.off, -86400, 86400)) : 0, t0: Math.round(w.t0), n, stations };
    if (w.custom === true) out.custom = true;      // météo décrite à la main : constante, jamais rafraîchie depuis Open-Meteo
    for (const f of FIELDS) {
      const a = w[f];
      if (!Array.isArray(a) || a.length !== K) return null;
      out[f] = [];
      for (const row of a) {
        if (!Array.isArray(row) || row.length !== n) return null;
        const r = new Array(n);
        for (let h = 0; h < n; h++) {
          if (!num(row[h])) return null;
          r[h] = r1(clamp(row[h], LIMITS[f][0], LIMITS[f][1]));
        }
        out[f].push(r);
      }
    }
    for (let k = 0; k < K; k++) for (let h = 0; h < n; h++) if (out.gust[k][h] < out.ws[k][h]) out.gust[k][h] = out.ws[k][h]; // une rafale ne peut être plus faible que la moyenne
    return out;
  }

  /** Heure locale saisie (« 2026-10-12T08:30 ») → epoch UTC (s), d'après le décalage UTC du lieu de départ (s). */
  function localToEpoch(str, utcOffsetSeconds) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(str || ''));
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 - (Number(utcOffsetSeconds) || 0);
  }

  /** Epoch UTC (s) → heure locale « 2026-10-12T08:30 » d'un lieu de décalage UTC off (s). */
  function epochToLocal(epoch, off) {
    return new Date((epoch + (Number(off) || 0)) * 1000).toISOString().slice(0, 16);
  }

  /** Empreinte du tracé : les stations d'un instantané ne valent que pour lui. profile : {length, n, lat, lng}. */
  function routeKey(p) {
    return p ? [Math.round(p.length), p.lat[0].toFixed(4), p.lng[0].toFixed(4), p.lat[p.n - 1].toFixed(4), p.lng[p.n - 1].toFixed(4)].join('|') : '';
  }

  /** Pour quel tracé et quelle heure de départ locale des prévisions ont été récupérées (« fetchedFor »). */
  function freshKey(profile, startAt) { return profile ? routeKey(profile) + '@' + (startAt || '') : ''; }

  /**
   * Instantané à partir de la réponse d'Open-Meteo (une structure par station, `hourly` en temps unix).
   * stations : celles de stationsFor() ; startEpoch : départ (s, UTC) ; opts : {before (h gardées avant le départ, 1), hours (h après, 24), off (décalage UTC du lieu, s)}.
   */
  function fromApi(resp, stations, startEpoch, opts) {
    opts = opts || {};
    const list = Array.isArray(resp) ? resp : [resp];
    if (list.length !== stations.length) throw new Error('Réponse météo incomplète');
    const time0 = list[0] && list[0].hourly && list[0].hourly.time;
    if (!Array.isArray(time0) || time0.length < 2) throw new Error('Pas de prévision pour cette date');
    const from = Math.floor(startEpoch / 3600) * 3600 - 3600 * (opts.before === undefined ? 1 : opts.before);
    const to = Math.floor(startEpoch / 3600) * 3600 + 3600 * (opts.hours === undefined ? 24 : opts.hours);
    const idx = [];
    time0.forEach((t, i) => { if (t >= from && t <= to) idx.push(i); });
    if (idx.length < 2) throw new Error('Pas de prévision pour cette date');
    const src = { T: 'temperature_2m', rh: 'relative_humidity_2m', p: 'pressure_msl', rain: 'precipitation', ws: 'wind_speed_10m', wd: 'wind_direction_10m', gust: 'wind_gusts_10m' };
    const w = { v: 1, start: Math.round(startEpoch), off: opts.off || 0, t0: time0[idx[0]], n: idx.length, stations };
    for (const f of FIELDS) w[f] = [];
    for (const loc of list) {
      const hourly = loc && loc.hourly;
      if (!hourly || !Array.isArray(hourly.time) || hourly.time.length !== time0.length) throw new Error('Réponse météo incohérente');
      for (const f of FIELDS) {
        const a = hourly[src[f]];
        const row = idx.map((i) => (Array.isArray(a) && num(a[i]) ? a[i] : null));
        // trous : on reprend la valeur la plus proche (sinon une valeur neutre)
        const known = row.map((x, i) => (x === null ? -1 : i)).filter((i) => i >= 0);
        const filled = row.map((x, i) => {
          if (x !== null) return x;
          if (!known.length) return f === 'gust' ? 0 : DEFAULTS[f];
          let best = known[0];
          for (const j of known) if (Math.abs(j - i) < Math.abs(best - i)) best = j;
          return row[best];
        });
        w[f].push(filled);
      }
    }
    const out = normalize(w);
    if (!out) throw new Error('Réponse météo invalide');
    return out;
  }

  /* ---------- Météo personnalisée : des portions du parcours (température, pluie, vent) plutôt que des prévisions ---------- */

  const CUSTOM_MIN_PIECE = 20;      // m : en dessous, deux limites de portions sont confondues
  const CUSTOM_EDGE = 1;            // m : la valeur d'une portion tient jusqu'à 1 m de sa limite, puis on passe à la suivante

  /**
   * Instantané d'une météo décrite à la main : valeurs constantes dans le temps, qui changent d'une portion du parcours à l'autre.
   * custom : {baseT (°C hors portions), temp: [{startKm, endKm, T}], rain: [{startKm, endKm, rain (mm/h)}]} ;
   * winds : portions de vent du projet [{startKm, endKm, dir (° d'où vient le vent), speed (km/h), gusty, gust (km/h)}] — saisies à hauteur
   * de cycliste, donc ramenées à 10 m comme les prévisions ; une portion plus loin dans la liste l'emporte sur les précédentes.
   * opts : {start (epoch s du départ), off (décalage UTC, s)}. Renvoie null s'il n'y a pas de parcours.
   */
  function fromCustom(profile, custom, winds, opts) {
    if (!profile || !(profile.length >= 30)) return null;
    const c = custom || {}, o = opts || {};
    const L = profile.length;
    const baseT = num(Number(c.baseT)) ? Number(c.baseT) : 20;
    const span = (p) => {
      const a = clamp(Number(p.startKm) * 1000, 0, L), b = clamp(Number(p.endKm) * 1000, 0, L);
      return b - a >= 1 ? { a: Math.min(a, b), b: Math.max(a, b) } : null;
    };
    const sets = {
      temp: (c.temp || []).map((p) => ({ r: span(p), v: clamp(Number(p.T), LIMITS.T[0], LIMITS.T[1]) })),
      rain: (c.rain || []).map((p) => ({ r: span(p), v: clamp(Number(p.rain) || 0, 0, LIMITS.rain[1]) })),
      wind: (winds || []).map((p) => ({ r: span(p), v: p })),
    };
    // limites de pièces : départ, arrivée et bords des portions (autant de pièces que de portions le demandent) ; deux limites à moins de
    // CUSTOM_MIN_PIECE mètres sont confondues
    let cuts = [0, L];
    for (const k of Object.keys(sets)) for (const p of sets[k]) if (p.r) cuts.push(p.r.a, p.r.b);
    cuts = Array.from(new Set(cuts.map((x) => Math.round(x)))).sort((x, y) => x - y);
    const merge1 = () => {
      let best = -1, len = Infinity;
      for (let i = 0; i < cuts.length - 1; i++) if (cuts[i + 1] - cuts[i] < len) { len = cuts[i + 1] - cuts[i]; best = i; }
      if (best < 0) return;
      // on retire la limite intérieure de la plus petite pièce (jamais le départ ni l'arrivée)
      const drop = best === 0 ? 1 : best + 1 === cuts.length - 1 ? best : (cuts[best] - cuts[best - 1] <= cuts[best + 2] - cuts[best + 1] ? best : best + 1);
      cuts.splice(drop, 1);
    };
    while (cuts.length > 2 && cuts.some((x, i) => i && x - cuts[i - 1] < CUSTOM_MIN_PIECE)) merge1();
    // garde-fou (parcours de milliers de portions) : on ne dépasse jamais le nombre de stations que normalize() accepte
    while (cuts.length > 2 && (cuts.length - 1) * 2 > MAX_STATIONS) merge1();
    const at1 = (list, m) => { let v = null; for (const p of list) if (p.r && m >= p.r.a && m <= p.r.b) v = p.v; return v; };
    const pieces = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1], m = (a + b) / 2;
      const T = at1(sets.temp, m), r = at1(sets.rain, m), wv = at1(sets.wind, m);
      const sp = wv ? Math.max(0, Number(wv.speed) || 0) / 3.6 / WIND_K : 0;
      const gu = wv && wv.gusty ? Math.max(sp, (Number(wv.gust) || 0) / 3.6 / WIND_K) : sp;
      pieces.push({ a, b, T: T === null ? baseT : T, rain: r === null ? 0 : r, ws: sp, gust: gu, wd: wv ? ((Number(wv.dir) || 0) % 360 + 360) % 360 : 0 });
    }
    const stations = [], cols = { T: [], rh: [], p: [], rain: [], ws: [], wd: [], gust: [] };
    const station = (s) => {
      const j = clamp(Math.round(s / profile.step), 0, profile.n - 1);
      return { s: Math.round(s), lat: profile.lat[j], lng: profile.lng[j], ele: profile.ele[j] };
    };
    pieces.forEach((pc, i) => {
      const from = i === 0 ? pc.a : pc.a + CUSTOM_EDGE, to = i === pieces.length - 1 ? pc.b : pc.b - CUSTOM_EDGE;
      for (const s of from === to ? [from] : [from, to]) {
        stations.push(station(s));
        cols.T.push([pc.T, pc.T]); cols.rh.push([DEFAULTS.rh, DEFAULTS.rh]); cols.p.push([DEFAULTS.p, DEFAULTS.p]); cols.rain.push([pc.rain, pc.rain]);
        cols.ws.push([pc.ws, pc.ws]); cols.wd.push([pc.wd, pc.wd]); cols.gust.push([pc.gust, pc.gust]);
      }
    });
    const start = num(o.start) ? o.start : Math.round(Date.now() / 1000);
    return normalize(Object.assign({ v: 1, start, off: num(o.off) ? o.off : 0, t0: start - 3600, n: 2, stations, custom: true }, cols));
  }

  /* ---------- Lecture : interpolation en distance et en temps ---------- */

  const prepared = new WeakMap();

  /** Tableaux à plat (Float32) et humidité de la route de chaque station et de chaque heure, calculés une fois par instantané. */
  function prep(w) {
    let p = prepared.get(w);
    if (p) return p;
    const K = w.stations.length, n = w.n;
    p = { K, n, sx: Float64Array.from(w.stations, (s) => s.s), ele: Float64Array.from(w.stations, (s) => s.ele) };
    for (const f of FIELDS) p[f] = Float32Array.from({ length: K * n }, (_, i) => w[f][(i / n) | 0][i % n]);
    // route mouillée : monte avec la pluie, sèche d'une heure à l'autre
    p.wet = new Float32Array(K * n);
    for (let k = 0; k < K; k++) {
      let prev = 0;
      for (let h = 0; h < n; h++) {
        const wet = Math.max(Math.min(1, Math.sqrt(p.rain[k * n + h] / 0.8)), prev * WET_DECAY);
        p.wet[k * n + h] = wet;
        prev = wet;
      }
    }
    prepared.set(w, p);
    return p;
  }

  /**
   * Conditions à la distance s (m) et à l'heure tClock (s, epoch UTC) : {T, rh, p, rain, ws, wd, gust, wet, ele}.
   * out : objet réutilisé pour éviter les allocations (une lecture par seconde et par coureur).
   */
  function at(w, s, tClock, out) {
    const P = prep(w), n = P.n, K = P.K;
    const o = out || {};
    let k = 0, fs = 0;
    if (K > 1) {
      while (k < K - 2 && s > P.sx[k + 1]) k++;
      fs = clamp((s - P.sx[k]) / (P.sx[k + 1] - P.sx[k]), 0, 1);
    }
    const k1 = K > 1 ? k + 1 : k;
    const x = clamp((tClock - w.t0) / 3600, 0, n - 1);
    const h0 = Math.floor(x), h1 = Math.min(n - 1, h0 + 1), fh = x - h0;
    const get = (arr) => {
      const a = (1 - fh) * arr[k * n + h0] + fh * arr[k * n + h1];
      const b = (1 - fh) * arr[k1 * n + h0] + fh * arr[k1 * n + h1];
      return (1 - fs) * a + fs * b;
    };
    o.T = get(P.T); o.rh = get(P.rh); o.p = get(P.p); o.rain = get(P.rain); o.ws = get(P.ws); o.gust = Math.max(o.ws, get(P.gust));
    o.wet = get(P.wet);
    o.ele = (1 - fs) * P.ele[k] + fs * P.ele[k1];
    // direction : on interpole le vecteur vent (pas l'angle, qui boucle à 360°)
    const vec = (kk, hh) => { const a = (P.wd[kk * n + hh] * Math.PI) / 180, m = P.ws[kk * n + hh]; return [m * Math.sin(a), m * Math.cos(a)]; };
    let vx = 0, vy = 0;
    for (const [kk, wk] of [[k, 1 - fs], [k1, fs]]) {
      if (wk === 0) continue;
      const a = vec(kk, h0), b = vec(kk, h1);
      vx += wk * ((1 - fh) * a[0] + fh * b[0]);
      vy += wk * ((1 - fh) * a[1] + fh * b[1]);
    }
    o.wd = Math.hypot(vx, vy) > 1e-6 ? ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360 : get(P.wd);
    return o;
  }

  /* ---------- Effets ---------- */

  /** Indice de chaleur (Rothfusz, NWS) en °C ; ne compte qu'au-dessus de ≈ 27 °C. */
  function heatIndex(T, rh) {
    const F = T * 1.8 + 32;
    if (F < 80) return T;
    const R = rh;
    let hi = -42.379 + 2.04901523 * F + 10.14333127 * R - 0.22475541 * F * R - 0.00683783 * F * F - 0.05481717 * R * R +
      0.00122874 * F * F * R + 0.00085282 * F * R * R - 0.00000199 * F * F * R * R;
    if (R < 13 && F >= 80 && F <= 112) hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(F - 95)) / 17);
    else if (R > 85 && F >= 80 && F <= 87) hi += ((R - 85) / 10) * ((87 - F) / 5);
    return Math.max(T, (hi - 32) / 1.8);
  }

  /** Facteur de capacité (PC, W′, courbe record) : −0,8 %/°C ressenti au-delà de 25 °C (−15 % au plus), −0,3 %/°C sous 5 °C (−5 % au plus). */
  function heatFactor(T, rh) {
    const app = heatIndex(T, rh);
    return (1 - Math.min(0.15, 0.008 * Math.max(0, app - 25))) * (1 - Math.min(0.05, 0.003 * Math.max(0, 5 - T)));
  }

  /**
   * Effets de la route mouillée et du vent sur la course : {crrK, crashK, punctK, vlimK, brakeK}.
   * wet (0-1), T (°C), rh (%), gust (m/s à 10 m).
   */
  function roadEffects(wet, T, rh, gust) {
    const w = clamp(wet, 0, 1);
    let crash = 1 + 2 * w;                                  // ×3 sur route détrempée, comme « Route mouillée »
    if (gust * 3.6 > 60) crash *= 1.5;                       // rafales violentes
    if (T <= 1 && T >= -5 && (rh > 85 || w > 0.2)) crash *= 2; // risque de verglas
    return { crrK: 1 + 0.15 * w, crashK: crash, punctK: 1 + 0.3 * w, vlimK: 1 - 0.15 * w, brakeK: 1 - 0.3 * w };
  }

  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  /** Point cardinal (N, NE, E…) d'une direction en degrés (0 = nord). */
  function compass(deg) { return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]; }

  /**
   * Conditions rencontrées le long d'un parcours de longueur L (m), lues à l'heure de passage :
   * [{s, T, rh, p, rain, ws, gust, wd, head (m/s : > 0 de face), clock (epoch s), rainCum (mm reçus depuis le départ)}].
   * opts : {timeAt(s) : secondes écoulées depuis le départ au passage en s, bearing(s) : cap de la route (°), n (nombre de points)}.
   */
  function alongRoute(w, L, opts) {
    const n = opts.n || 120, out = [];
    let cum = 0, prev = null;
    for (let i = 0; i <= n; i++) {
      const s = (L * i) / n;
      const clock = w.start + opts.timeAt(s);
      const x = at(w, s, clock);
      const rel = ((x.wd - opts.bearing(s)) * Math.PI) / 180;
      if (prev !== null) cum += (x.rain * Math.max(0, clock - prev)) / 3600;
      prev = clock;
      out.push({ s, T: x.T, rh: x.rh, p: x.p, rain: x.rain, ws: x.ws, gust: x.gust, wd: x.wd, head: x.ws * Math.cos(rel), clock, rainCum: cum });
    }
    return out;
  }

  /** Synthèse pour l'affichage : températures, vent, pluie (cumul moyen, fenêtres), pression. */
  function summary(w) {
    const P = prep(w), K = P.K, n = P.n;
    let Tmin = Infinity, Tmax = -Infinity, ws = 0, gust = 0, pmin = Infinity, pmax = -Infinity, rain = 0, rhMax = 0;
    const wetHours = new Array(n).fill(false);
    for (let k = 0; k < K; k++) {
      for (let h = 0; h < n; h++) {
        const i = k * n + h;
        Tmin = Math.min(Tmin, P.T[i]); Tmax = Math.max(Tmax, P.T[i]);
        ws = Math.max(ws, P.ws[i]); gust = Math.max(gust, P.gust[i]);
        pmin = Math.min(pmin, P.p[i]); pmax = Math.max(pmax, P.p[i]);
        rhMax = Math.max(rhMax, P.rh[i]);
        rain += P.rain[i] / K;
        if (P.rain[i] >= 0.2) wetHours[h] = true;
      }
    }
    const windows = [];
    for (let h = 0; h < n; h++) {
      if (!wetHours[h]) continue;
      const last = windows[windows.length - 1];
      if (last && last[1] === h - 1) last[1] = h; else windows.push([h, h]);
    }
    return {
      Tmin, Tmax, wsMax: ws, gustMax: gust, pMin: pmin, pMax: pmax, rhMax, rainMm: rain,
      rainWindows: windows.map(([a, b]) => [w.t0 + a * 3600, w.t0 + (b + 1) * 3600]), // epoch (s)
    };
  }

  PYR.weather = {
    WIND_K, MAX_STATIONS, MAX_HOURS, FIELDS,
    stationsFor, fromCustom, normalize, localToEpoch, epochToLocal, routeKey, freshKey, fromApi, at, compass, alongRoute, heatIndex, heatFactor, roadEffects, summary,
  };
})(globalThis.PYR = globalThis.PYR || {});
