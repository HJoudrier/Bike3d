/* author : Hugo Joudrier-Faure */
/* PaceYourRide — utilitaires communs (navigateur + Node pour les tests). */
(function (PYR) {
  'use strict';

  const U = {};

  U.clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.sum = (arr) => { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s; };

  /** Générateur pseudo-aléatoire déterministe (mulberry32). */
  U.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* ---------- Géodésie ---------- */
  const R_EARTH = 6371008.8;
  U.toRad = (d) => d * Math.PI / 180;
  U.toDeg = (r) => r * 180 / Math.PI;

  U.haversine = function (lat1, lng1, lat2, lng2) {
    const p1 = U.toRad(lat1), p2 = U.toRad(lat2);
    const dp = p2 - p1, dl = U.toRad(lng2 - lng1);
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  };

  /** Cap (0–360°, 0 = nord, sens horaire) de 1 vers 2. */
  U.bearing = function (lat1, lng1, lat2, lng2) {
    const p1 = U.toRad(lat1), p2 = U.toRad(lat2), dl = U.toRad(lng2 - lng1);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (U.toDeg(Math.atan2(y, x)) + 360) % 360;
  };

  /** Ramène un angle (radians) dans ]-π, π]. */
  U.wrapPi = function (a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a <= -Math.PI) a += 2 * Math.PI;
    return a;
  };

  /* ---------- Formatage (fr-FR) ---------- */
  // Un Intl.NumberFormat par nombre de décimales : toLocaleString en recrée un à chaque appel (lent, et appelé à chaque image par les graphiques)
  const numberFormats = new Map();
  U.fmt = function (x, digits = 0) {
    if (x === null || x === undefined || !isFinite(x)) return '–';
    let f = numberFormats.get(digits);
    if (!f) { f = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }); numberFormats.set(digits, f); }
    return f.format(Number(x));
  };

  /** 3725 → "1:02:05" ; 125 → "2:05". */
  U.fmtClock = function (sec) {
    if (!isFinite(sec)) return '–';
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(h > 0 ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };

  /** 3725 → "1 h 02 min 05 s". */
  U.fmtDuration = function (sec) {
    if (!isFinite(sec)) return '–';
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min ${String(s).padStart(2, '0')} s`;
    if (m > 0) return `${m} min ${String(s).padStart(2, '0')} s`;
    return `${s} s`;
  };

  /** Écart signé « +1:05 » / « −0:12 ». */
  U.fmtDelta = function (sec) {
    if (!isFinite(sec)) return '–';
    const sign = sec > 0.5 ? '+' : sec < -0.5 ? '−' : '±';
    return sign + U.fmtClock(Math.abs(sec));
  };

  U.fmtKm = (m, digits = 1) => U.fmt(m / 1000, digits) + ' km';

  const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
  U.cardinal = (deg) => CARDINALS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

  /* ---------- Divers ---------- */
  U.debounce = function (fn, ms) {
    let id = null;
    return function (...args) {
      clearTimeout(id);
      id = setTimeout(() => fn.apply(this, args), ms);
    };
  };

  /** Âge révolu (années) à la date `now` (ms, défaut : maintenant) d'après une date de naissance « AAAA-MM-JJ » ; null si la date est absente, invalide ou future. */
  U.ageFrom = function (birth, now) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birth || ''));
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const chk = new Date(Date.UTC(y, mo - 1, d));
    if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
    const t = new Date(now === undefined ? Date.now() : now);
    let age = t.getFullYear() - y;
    if (t.getMonth() + 1 < mo || (t.getMonth() + 1 === mo && t.getDate() < d)) age--;
    return age >= 0 ? age : null;
  };

  U.uid = () => Math.random().toString(36).slice(2, 10);

  U.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Recherche dichotomique : plus grand indice i tel que arr[i] <= x. */
  U.bisectRight = function (arr, x) {
    let lo = 0, hi = arr.length - 1;
    if (x < arr[0]) return 0;
    if (x >= arr[hi]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= x) lo = mid; else hi = mid;
    }
    return lo;
  };

  PYR.util = U;
})(globalThis.PYR = globalThis.PYR || {});
