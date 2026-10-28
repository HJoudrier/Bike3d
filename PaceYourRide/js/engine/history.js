/* author : Hugo Joudrier-Faure */
/* PaceYourRide — profil estimé depuis l'historique des sorties (export d'un compte Strava, dossier de fichiers FIT / GPX / TCX).
 *
 * Chaque sortie lue (replay.load) est remise à une ligne par seconde puis nettoyée :
 *   - puissance : un pic isolé (plus de 2,5 × la plus forte des deux secondes voisines) ou une valeur au-delà de 2 500 W est un artefact du
 *     capteur, remplacé par la moyenne de ses voisines ; un trou de plus de 5 s dans l'enregistrement est un arrêt (0 W) ;
 *   - fréquence cardiaque : hors de 30–230 bpm, ou saut de plus de 20 bpm par seconde (contact de la ceinture, interférence) : écartée.
 * On en garde un résumé : puissance maximale moyenne (MMP) aux durées de physio.DURATIONS, pic de FC (meilleure moyenne sur 5 s).
 *
 * Sur une période (90 jours par défaut, ou tout l'historique) :
 *   - enveloppe MMP = meilleure valeur de toutes les sorties à chaque durée, d'où les records ;
 *   - modèle de Morton à trois paramètres, P(t) = PC + W′ / (t + W′ / (Pmax − PC)) : Pmax = meilleure seconde filtrée (comme dans
 *     l'appli, où Pmax est le record d'une seconde), PC et W′ ajustées sur l'enveloppe de 1 s à 20 min ;
 *   - FC max = plus haut pic corroboré par une autre sortie ; VO₂max d'après le meilleur 5 min (Hawley et Noakes, formule de metabo.js).
 * Une enveloppe n'est qu'une borne basse des capacités : un effort jamais fait à fond y laisse un creux. Chaque valeur reçoit donc une
 * fiabilité (bonne, moyenne, faible), tirée de la forme de la courbe comparée au profil type de physio.js et du nombre de sorties.
 * Pas de DOM : se teste sous Node. */
(function (PYR) {
  'use strict';

  const Pz = PYR.physio;
  const DUR = Pz.DURATIONS;
  const I = (d) => DUR.indexOf(d);

  const P_MAX_W = 2500;        // W : au-delà, artefact du capteur
  const SPIKE_K = 2.5;         // pic isolé : plus de 2,5 × la plus forte des deux secondes voisines…
  const SPIKE_MIN_W = 100;     // … et au moins 100 W (sous ce seuil, un pic ne touche aucun record)
  const P_GAP_S = 5;           // s : trou de puissance interpolé ; au-delà, arrêt (0 W)
  const HR_MIN = 30, HR_MAX = 230, HR_JUMP = 20;   // bpm ; bpm par seconde
  const HR_REANCHOR = 10;      // s : un nouveau niveau de FC tenu aussi longtemps est admis (ceinture qui démarre sur une valeur fausse)
  const HR_GAP_S = 10;         // s : trou de FC interpolé
  const HR_WIN = 5;            // s : le pic de FC d'une sortie est sa meilleure moyenne sur 5 s
  const HR_CORROB = 10;        // bpm : un pic de FC à plus de 10 bpm de tous les autres est isolé (artefact probable)
  const MAX_GAP_S = 1800;      // s : un arrêt plus long compte pour 30 min (sortie enregistrée sur deux jours)
  const MAX_S = 48 * 3600;     // s : garde-fou
  const MIN_POWER_S = 60;      // s : une sortie « avec puissance » en a au moins une minute
  const MIN_HR_S = 60;
  const FIT_MAX_S = 1200;      // s : le modèle de Morton est ajusté de 1 s à 20 min
  const DAY_MS = 86400000;

  const fmt = (x, d) => x.toFixed(d).replace('.', ',');
  const lab = (d) => Pz.durationLabel(d);

  /* ---------- sport ---------- */

  /**
   * Classe d'un sport : 'cycling', 'ebike', 'other' ou 'unknown'. s : énumération FIT (nombre, avec subSport), type d'activité d'un export
   * Strava (« Ride », « Virtual Ride », « Vélo », « Run »…), attribut Sport d'un TCX (« Biking ») ou <type> d'un GPX (« cycling », « 1 »).
   */
  function sportClass(s, subSport) {
    if (typeof s === 'number') {
      if (s === 2) return 'cycling';
      if (s === 21) return 'ebike';
      if (s === 0) return 'unknown';
      if (s === 4) return subSport === 6 ? 'cycling' : subSport === undefined || subSport === 0 ? 'unknown' : 'other';   // appareil de fitness : home trainer ou rameur…
      return 'other';
    }
    const t = String(s === undefined || s === null ? '' : s).trim().toLowerCase();
    if (!t || t === 'other' || t === 'generic' || t === 'autre') return 'unknown';
    if (/^\d+$/.test(t)) return t === '1' ? 'cycling' : t === '9' ? 'other' : 'unknown';   // codes des GPX de Strava : 1 vélo, 9 course à pied
    if (/e-?bike|e-?mountain|e_biking|ebik|électrique|electrique|\bvae\b/.test(t)) return 'ebike';
    if (/ride|v[ée]lo|bik(e|ing)|cycl|vtt|gravel|velomobile|handcycle|handbike/.test(t)) return 'cycling';
    return 'other';
  }

  /* ---------- index de l'export Strava (activities.csv) ---------- */

  /** Lignes d'un CSV (champs entre guillemets, guillemets doublés, retours à la ligne dans un champ). */
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c !== '"') field += c;
        else if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  const baseName = (p) => String(p || '').split('/').pop().toLowerCase();

  /**
   * Index de l'export Strava : nom du fichier (sans dossier, en minuscules) → { type, name }. Les en-têtes sont cherchés en anglais et en
   * français ; sans en-tête reconnu, la colonne des fichiers est celle dont les valeurs ressemblent à « activities/123.fit.gz ».
   */
  function stravaIndex(text) {
    const rows = parseCsv(String(text || '').replace(/^﻿/, ''));
    const map = new Map();
    if (rows.length < 2) return map;
    const hdr = rows[0].map((x) => x.trim().toLowerCase());
    const col = (re) => hdr.findIndex((x) => re.test(x));
    let iFile = col(/^(filename|nom du fichier|nom de fichier|fichier)$/);
    const iType = col(/^(activity type|type d.activit[ée]|type)$/);
    const iName = col(/^(activity name|nom de l.activit[ée]|nom)$/);
    if (iFile < 0) {
      const sample = rows.slice(1, 50);
      iFile = hdr.findIndex((_, k) => sample.some((r) => /\.(fit|gpx|tcx)(\.gz)?$/i.test(r[k] || '')));
    }
    if (iFile < 0) return map;
    for (const r of rows.slice(1)) {
      const f = r[iFile];
      if (!f) continue;
      map.set(baseName(f), { type: iType >= 0 ? r[iType] || '' : '', name: iName >= 0 ? r[iName] || '' : '' });
    }
    return map;
  }

  /* ---------- une sortie ---------- */

  const lerp = (a, b, f) => (Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : Number.isFinite(a) && f < 0.5 ? a : Number.isFinite(b) && f >= 0.5 ? b : NaN);

  /**
   * Sortie remise à une ligne par seconde : { n, power, hr } (Float64Array, NaN = absent). La puissance est interpolée sur les trous de
   * 5 s au plus ; au-delà, l'enregistrement s'est arrêté (pause automatique, café) : 0 W, et la FC est absente. Un trou de plus de 30 min
   * compte pour 30 min. null si moins de deux points horodatés.
   */
  function series(act) {
    const sorted = act.points.filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
    const pts = [];
    for (const p of sorted) if (!pts.length || p.t > pts[pts.length - 1].t) pts.push(p);
    const m = pts.length;
    if (m < 2) return null;
    const tt = new Float64Array(m);
    for (let i = 1; i < m; i++) tt[i] = tt[i - 1] + Math.min(pts[i].t - pts[i - 1].t, MAX_GAP_S);
    const n = Math.min(MAX_S, Math.floor(tt[m - 1]) + 1);
    const power = new Float64Array(n), hr = new Float64Array(n);
    let j = 0;
    for (let k = 0; k < n; k++) {
      while (j < m - 2 && tt[j + 1] <= k) j++;
      const a = pts[j], c = pts[j + 1], span = tt[j + 1] - tt[j];
      const f = span > 0 ? Math.min(1, Math.max(0, (k - tt[j]) / span)) : 0;
      if (span <= P_GAP_S) power[k] = lerp(a.power, c.power, f);
      else power[k] = k - tt[j] < 1 ? a.power : tt[j + 1] - k < 1 ? c.power : 0;
      if (span <= HR_GAP_S) hr[k] = lerp(a.hr, c.hr, f);
      else hr[k] = k - tt[j] < 1 ? a.hr : tt[j + 1] - k < 1 ? c.hr : NaN;
    }
    return { n, power, hr };
  }

  /**
   * Puissance sans artefacts : une valeur au-delà de 2 500 W, ou un pic isolé (≥ 100 W et plus de 2,5 × la plus forte des deux secondes
   * voisines), est remplacée par la moyenne des voisines saines. Renvoie { power (copie), spikes (nombre de secondes corrigées) }.
   */
  function cleanPower(P) {
    const n = P.length, out = Float64Array.from(P), bad = new Uint8Array(n);
    const v = (i) => (i >= 0 && i < n && Number.isFinite(P[i]) ? P[i] : 0);
    let spikes = 0;
    for (let i = 0; i < n; i++) {
      const p = P[i];
      if (!Number.isFinite(p)) continue;
      if (p < 0 || p > P_MAX_W || (p >= SPIKE_MIN_W && p > SPIKE_K * Math.max(v(i - 1), v(i + 1)))) { bad[i] = 1; spikes++; }
    }
    if (spikes) {
      for (let i = 0; i < n; i++) {
        if (!bad[i]) continue;
        let s = 0, c = 0;
        for (const k of [i - 1, i + 1]) if (k >= 0 && k < n && !bad[k] && Number.isFinite(P[k])) { s += P[k]; c++; }
        out[i] = c ? s / c : 0;
      }
    }
    return { power: out, spikes };
  }

  /**
   * Fréquence cardiaque sans artefacts : hors de 30–230 bpm, ou à plus de 20 bpm par seconde de la dernière valeur admise, elle est écartée
   * (NaN). Un nouveau niveau tenu 10 s (valeurs cohérentes entre elles) est admis : la ceinture a pu démarrer sur une valeur fausse.
   * Renvoie { hr (copie), dropped (nombre de secondes écartées) }.
   */
  function cleanHr(H) {
    const n = H.length, out = Float64Array.from(H);
    let last = NaN, lastI = -1, run = 0, prev = NaN, prevI = -1, dropped = 0;
    for (let i = 0; i < n; i++) {
      const v = H[i];
      if (!Number.isFinite(v)) continue;
      if (v < HR_MIN || v > HR_MAX) { out[i] = NaN; dropped++; continue; }
      if (Number.isFinite(last) && Math.abs(v - last) > HR_JUMP * (i - lastI)) {
        out[i] = NaN; dropped++;
        run = Number.isFinite(prev) && Math.abs(v - prev) <= HR_JUMP * (i - prevI) ? run + 1 : 1;
        prev = v; prevI = i;
        if (run >= HR_REANCHOR) { last = v; lastI = i; run = 0; prev = NaN; }
        continue;
      }
      last = v; lastI = i; run = 0; prev = NaN;
    }
    return { hr: out, dropped };
  }

  /** Puissance maximale moyenne (W) sur chaque durée de `durations` (s) ; NaN si la sortie est plus courte. Une valeur absente compte 0 W. */
  function mmp(P, durations) {
    const n = P.length, S = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) S[i + 1] = S[i] + (Number.isFinite(P[i]) ? P[i] : 0);
    const out = new Float64Array(durations.length);
    durations.forEach((d, k) => {
      if (d > n) { out[k] = NaN; return; }
      let best = -Infinity;
      for (let i = d; i <= n; i++) { const s = S[i] - S[i - d]; if (s > best) best = s; }
      out[k] = best / d;
    });
    return out;
  }

  /** Pic de FC : meilleure moyenne sur 5 s (fenêtres où 4 secondes au moins sont mesurées). NaN sans FC. */
  function hrPeak(H) {
    let best = NaN;
    for (let i = 0; i + HR_WIN <= H.length; i++) {
      let s = 0, c = 0;
      for (let k = i; k < i + HR_WIN; k++) if (Number.isFinite(H[k])) { s += H[k]; c++; }
      if (c >= HR_WIN - 1 && !(s / c <= best)) best = s / c;
    }
    return best;
  }

  /**
   * Résumé d'une sortie (replay.load avec anyPos). meta : { type (type d'activité de l'export Strava), name, file }. Renvoie { name, file,
   * startMs, duration (s), sport ('cycling', 'ebike', 'other', 'unknown'), hasPower, mmp ([W] aux physio.DURATIONS, NaN au-delà de la
   * durée de la sortie ; null sans puissance), hrPeak (bpm, NaN sans FC), spikes, hrDropped }.
   */
  function analyze(act, meta) {
    meta = meta || {};
    const s = series(act);
    if (!s) throw new Error('pas d\'horodatage');
    const cp = cleanPower(s.power), ch = cleanHr(s.hr);
    let nP = 0, nH = 0;
    for (let i = 0; i < s.n; i++) { if (cp.power[i] > 0) nP++; if (Number.isFinite(ch.hr[i])) nH++; }
    const hasPower = nP >= MIN_POWER_S;
    const type = meta.type !== undefined && meta.type !== '' ? meta.type : act.sport;
    return {
      name: meta.name || act.name || '', file: meta.file || '', startMs: Number.isFinite(act.startMs) ? act.startMs : NaN,
      duration: s.n, sport: sportClass(type, act.subSport), hasPower,
      mmp: hasPower ? Array.from(mmp(cp.power, DUR)) : null,
      hrPeak: nH >= MIN_HR_S ? hrPeak(ch.hr) : NaN, spikes: cp.spikes, hrDropped: ch.dropped,
    };
  }

  /* ---------- modèle de Morton ---------- */

  /**
   * Ajuste le modèle de Morton à trois paramètres P(t) = PC + W′ / (t + k), k = W′ / (Pmax − PC), sur des points [{ d (s), p (W) }] :
   * moindres carrés sur l'écart relatif. Pour k donné, PC et W′ sont linéaires (solution exacte) ; k est cherché sur une grille
   * logarithmique (0,05 à 600 s) puis affiné (section dorée). opts.pmax : Pmax imposée (l'appli prend la meilleure seconde pour Pmax,
   * le modèle libre dépasse nettement un vrai sprint, dont la puissance plafonne les premières secondes) ; seules PC et W′ sont alors
   * ajustées. Une enveloppe de sorties n'étant qu'une borne basse, un point à plus de 3 % sous le modèle pèse quatre fois moins
   * (opts.asym = false pour l'ajustement symétrique), en quelques passes.
   * Renvoie { cp, wPrime (J), pmax (W, à t = 0), k, model(d), rms (écart relatif quadratique moyen), n } ou null (moins de 4 points, ou
   * rien de court (≤ 30 s) ni de long (≥ 2 min)).
   */
  function fitMorton(points, opts) {
    opts = opts || {};
    const pts = points.filter((q) => q.d > 0 && q.p > 0 && Number.isFinite(q.p));
    if (pts.length < 4 || !pts.some((q) => q.d <= 30) || !pts.some((q) => q.d >= 120)) return null;
    const pm = Number(opts.pmax) > 0 ? Number(opts.pmax) : 0;
    const solve = (k, w) => {
      let cp, wp;
      if (pm) {
        // P(t) = PC · t / (t + k) + Pmax · k / (t + k) : linéaire en PC
        let saa = 0, say = 0;
        pts.forEach((q, i) => { const a = q.d / (q.d + k), wi = w[i] / (q.p * q.p); saa += wi * a * a; say += wi * a * (q.p - pm * k / (q.d + k)); });
        cp = say / saa; wp = k * (pm - cp);
      } else {
        let s0 = 0, sx = 0, sxx = 0, sy = 0, sxy = 0;
        pts.forEach((q, i) => {
          const x = 1 / (q.d + k), wi = w[i] / (q.p * q.p);
          s0 += wi; sx += wi * x; sxx += wi * x * x; sy += wi * q.p; sxy += wi * x * q.p;
        });
        const det = s0 * sxx - sx * sx;
        if (!(det > 0)) return null;
        wp = (s0 * sxy - sx * sy) / det; cp = (sy - wp * sx) / s0;
      }
      if (!(cp > 0 && wp > 0)) return null;
      let sse = 0;
      pts.forEach((q, i) => { const r = (cp + wp / (q.d + k) - q.p) / q.p; sse += w[i] * r * r; });
      return { cp, wp, k, sse };
    };
    const search = (w) => {
      const lo = Math.log(0.05), hi = Math.log(600), N = 90;
      let best = null, bi = -1;
      for (let g = 0; g <= N; g++) {
        const r = solve(Math.exp(lo + (hi - lo) * g / N), w);
        if (r && (!best || r.sse < best.sse)) { best = r; bi = g; }
      }
      if (!best) return null;
      let a = lo + (hi - lo) * Math.max(0, bi - 1) / N, b = lo + (hi - lo) * Math.min(N, bi + 1) / N;
      const g = (Math.sqrt(5) - 1) / 2;
      const cost = (x) => { const r = solve(Math.exp(x), w); if (r && r.sse < best.sse) best = r; return r ? r.sse : Infinity; };
      let x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = cost(x1), f2 = cost(x2);
      for (let it = 0; it < 60 && b - a > 1e-9; it++) {
        if (f1 <= f2) { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = cost(x1); }
        else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = cost(x2); }
      }
      return best;
    };
    let w = pts.map(() => 1), r = search(w);
    if (!r) return null;
    for (let it = 0; opts.asym !== false && it < 5; it++) {
      const w2 = pts.map((q) => { const m = r.cp + r.wp / (q.d + r.k); return (q.p - m) / m < -0.03 ? 0.25 : 1; });
      if (w2.every((x, i) => x === w[i])) break;
      const r2 = search(w2);
      if (!r2) break;
      w = w2; r = r2;
    }
    const cp = r.cp, wp = r.wp, k = r.k;
    const model = (d) => cp + wp / (d + k);
    let s2 = 0;
    for (const q of pts) { const e = (model(q.d) - q.p) / q.p; s2 += e * e; }
    return { cp, wPrime: wp, pmax: pm || cp + wp / k, k, model, rms: Math.sqrt(s2 / pts.length), n: pts.length };
  }

  /* ---------- fréquence cardiaque maximale ---------- */

  /**
   * FC maximale d'après les pics de FC des sorties (centile haut robuste) : le plus haut pic, sauf s'il dépasse de plus de 10 bpm tous les
   * autres (artefact probable) ; on écarte ainsi au plus 5 % des sorties (une au moins), et rien sous 4 sorties avec FC, où un seul effort
   * à fond est la règle. Renvoie { value, n (sorties avec FC), near (sorties à 5 bpm ou moins sous la valeur), dropped (pics plus hauts
   * écartés), droppedMax } ou null.
   */
  function hrMaxEstimate(peaks) {
    const p = peaks.filter(Number.isFinite).sort((a, b) => b - a);
    if (!p.length) return null;
    const maxDrop = p.length >= 4 ? Math.max(1, Math.floor(p.length * 0.05)) : 0;
    let i = 0;
    while (i < maxDrop && p[i] - p[i + 1] > HR_CORROB) i++;
    const v = p[i];
    return { value: Math.round(v), n: p.length, near: p.slice(i).filter((x) => x >= v - 5).length, dropped: i, droppedMax: i ? Math.round(p[0]) : NaN };
  }

  /* ---------- fiabilité ---------- */

  const LEVELS = ['faible', 'moyenne', 'bonne'];
  const rel = (level, why) => ({ level, why });
  /** Fiabilité abaissée d'un cran (pas en dessous de « faible »), avec la raison en plus. */
  const down = (r, why) => (r ? rel(LEVELS[Math.max(0, LEVELS.indexOf(r.level) - 1)], r.why + ' ; ' + why) : r);
  const cap = (r, level, why) => (r && LEVELS.indexOf(r.level) > LEVELS.indexOf(level) ? rel(level, r.why + ' ; ' + why) : r);
  const T = Pz.templateRatio;

  /** Rapport env(d1) / env(d2), relatif à celui du profil type (1 : même forme ; moins : env(d1) en creux). NaN sans données. */
  function shape(env, d1, d2) {
    const a = env[I(d1)], b = env[I(d2)];
    return a > 0 && b > 0 ? (a / b) / (T(d1) / T(d2)) : NaN;
  }
  const ratioTxt = (env, d1, d2) => `meilleur ${lab(d1)} = ${fmt(env[I(d1)] / env[I(d2)], 2)} × meilleur ${lab(d2)} (${fmt(T(d1) / T(d2), 2)} × pour le profil type)`;

  function relPmax(env, fit) {
    if (!(env[0] > 0)) return null;
    if (!fit) return rel('faible', 'trop peu de durées pour situer ta meilleure seconde');
    const r = env[0] / fit.cp;
    if (r >= 3) return rel('bonne', `meilleure seconde = ${fmt(r, 1)} × CP2 : au moins un vrai sprint`);
    if (r >= 2.4) return rel('moyenne', `meilleure seconde = ${fmt(r, 1)} × CP2 : sprint peut-être pas à fond (3 à 5 × après un sprint à fond)`);
    return rel('faible', `aucun sprint franc : meilleure seconde = ${fmt(r, 1)} × CP2 seulement (3 à 5 × après un sprint à fond)`);
  }

  function relWPrime(env, fit) {
    if (!fit) return null;
    const short = [120, 180, 240, 300].filter((d) => env[I(d)] > 0);
    if (!short.length) return rel('faible', 'aucune sortie avec puissance de plus de 2 min');
    const ref = [1200, 900, 600].find((d) => env[I(d)] > 0);
    let r;
    if (!ref) r = rel('moyenne', 'pas d\'effort de plus de 10 min pour situer tes efforts de 2 à 8 min');
    else {
      let q = -Infinity, dq = short[0];
      for (const d of short) { const s = shape(env, d, ref); if (s > q) { q = s; dq = d; } }
      const txt = ratioTxt(env, dq, ref);
      // un rouleur qui va à fond fait encore 1,1 × son meilleur 20 min sur 5 min (q ≈ 0,92)
      r = q >= 0.92 ? rel('bonne', `effort à fond entre 2 et 8 min probable : ${txt}`)
        : q >= 0.88 ? rel('moyenne', `effort entre 2 et 8 min peut-être pas à fond : ${txt}`)
          : rel('faible', `aucun effort maximal entre 2 et 8 min : ${txt}`);
    }
    if (fit.wPrime < 4000 || fit.wPrime > 45000) return rel('faible', `W′ de ${fmt(fit.wPrime / 1000, 1)} kJ, hors des valeurs habituelles (5 à 40 kJ) ; ${r.why}`);
    if (fit.rms > 0.06) r = down(r, `courbe éloignée du modèle (écart moyen ${fmt(fit.rms * 100, 0)} %)`);
    return r;
  }

  function relCp(env, fit) {
    if (!fit) return null;
    if (!(env[I(600)] > 0)) return rel('faible', 'aucune sortie avec puissance de plus de 10 min');
    let r;
    const s = shape(env, 1200, 3600);
    if (Number.isFinite(s)) {
      const txt = ratioTxt(env, 1200, 3600);
      r = s >= 0.96 ? rel('bonne', `effort à fond de 10 à 30 min probable : ${txt}`)
        : s >= 0.935 ? rel('moyenne', `effort de 10 à 30 min peut-être pas à fond : ${txt}`)
          : rel('faible', `aucun effort maximal de 10 à 30 min : ${txt}`);
    } else if (env[I(1200)] > 0) r = rel('moyenne', 'pas de sortie d\'une heure avec puissance pour vérifier que ton meilleur 20 min est un effort à fond');
    else r = rel('moyenne', 'pas d\'effort de 20 min : CP2 est extrapolée');
    if (fit.rms > 0.06) r = down(r, `courbe éloignée du modèle (écart moyen ${fmt(fit.rms * 100, 0)} %)`);
    return r;
  }

  function relVo2(env) {
    if (!(env[I(300)] > 0)) return null;
    const s = shape(env, 300, 1200);
    if (s < 0.92) return rel('faible', `ton meilleur 5 min ne semble pas être un effort à fond : ${ratioTxt(env, 300, 1200)}`);
    return rel('moyenne', 'estimation indirecte depuis ton meilleur 5 min (Hawley et Noakes 1992, ± 10 %)'
      + (Number.isFinite(s) ? '' : ' ; pas d\'effort de 20 min pour vérifier qu\'il est à fond'));
  }

  function relHr(hr, age) {
    if (!hr) return null;
    let r;
    if (hr.n < 3) r = rel('faible', `seulement ${hr.n} sortie${hr.n > 1 ? 's' : ''} avec FC`);
    else if (hr.near >= 3) r = rel('bonne', `${hr.near} sorties à 5 bpm ou moins de cette valeur`);
    else r = rel('moyenne', `${hr.near > 1 ? hr.near + ' sorties' : 'une seule sortie'} à 5 bpm ou moins de cette valeur`);
    if (hr.dropped) r.why += ` ; ${hr.dropped > 1 ? hr.dropped + ' pics isolés plus hauts écartés' : '1 pic isolé plus haut écarté'} (${hr.droppedMax} bpm)`;
    const a = Number(age) > 0 ? Number(age) : 35, exp = 208 - 0.7 * a;
    if (hr.value < exp - 15) r = down(r, `nettement sous la valeur attendue à ${Math.round(a)} ans (≈ ${Math.round(exp)} bpm) : la FC maximale n'est atteinte qu'au bout d'un effort à fond`);
    else if (hr.value > exp + 25) r = down(r, `très au-dessus de la valeur attendue à ${Math.round(a)} ans (≈ ${Math.round(exp)} bpm) : artefact de capteur ?`);
    return r;
  }

  function relRecord(i, env, count, nPower, fit, rPmax) {
    const d = DUR[i], v = env[i];
    if (!(v > 0)) return null;
    if (d === 1) return rPmax;
    let r;
    if (d <= FIT_MAX_S) {
      if (!fit) r = rel('moyenne', 'pas de modèle pour comparer');
      else {
        // le modèle de Morton s'écarte de lui-même de quelques % d'une courbe à fond (vers 1 min surtout) : seuils larges
        const q = v / fit.model(d), pc = fmt(Math.abs(q - 1) * 100, 0);
        r = q >= 0.93 ? rel('bonne', q >= 1 ? `${pc} % au-dessus du modèle` : `${pc} % sous le modèle`)
          : q >= 0.85 ? rel('moyenne', `${pc} % sous le modèle`)
            : rel('faible', `${pc} % sous le modèle : effort pas à fond`);
      }
    } else {
      const s = shape(env, d, 1200);
      if (!Number.isFinite(s)) r = rel('moyenne', 'pas d\'effort de 20 min pour comparer');
      else {
        // seuils larges : au-delà d'une heure, une sortie compte descentes et arrêts, et le profil type est optimiste sur 3 à 5 h
        const txt = `${fmt(v / env[I(1200)], 2)} × ton meilleur 20 min (${fmt(T(d) / T(1200), 2)} × pour le profil type)`;
        r = s >= 0.93 ? rel('bonne', txt) : s >= 0.82 ? rel('moyenne', txt) : rel('faible', `${txt} : pas d'effort soutenu aussi long`);
      }
    }
    if (count[i] === 1) r = cap(r, 'moyenne', nPower === 1 ? 'une seule sortie avec puissance' : 'une seule sortie assez longue');
    return r;
  }

  /* ---------- profil sur une période ---------- */

  /**
   * Profil estimé sur une période. rides : résumés d'analyze ; opts : { days (0 ou absent : tout), endMs (fin de la période ; par défaut la
   * dernière sortie), mass (kg, pour la VO₂max), age }. Seules les sorties de vélo (sport 'cycling' ou 'unknown') comptent ; la courbe ne
   * retient que celles avec puissance. Renvoie { fromMs, toMs, rides, nRides, nPower, nHr, env ([W] aux DURATIONS, NaN sans données,
   * décroissante), best ([sortie] d'où vient chaque record), count ([nombre de sorties avec puissance assez longues]), fit (fitMorton),
   * pmax, hr (hrMaxEstimate), vo2max (mL/min/kg), rel: { cp, wPrime, pmax, hrMax, vo2max, records: [] } (fiabilités { level, why }) }.
   */
  function aggregate(rides, opts) {
    opts = opts || {};
    const days = Number(opts.days) > 0 ? Number(opts.days) : 0;
    const bike = rides.filter((r) => r.sport === 'cycling' || r.sport === 'unknown');
    let endMs = Number(opts.endMs);
    if (!Number.isFinite(endMs)) { endMs = -Infinity; for (const r of bike) if (r.startMs > endMs) endMs = r.startMs; }
    if (!Number.isFinite(endMs)) endMs = NaN;
    const fromMs = days && Number.isFinite(endMs) ? endMs - days * DAY_MS : -Infinity;
    const win = days ? bike.filter((r) => r.startMs >= fromMs && r.startMs <= endMs + DAY_MS) : bike.slice();
    const pw = win.filter((r) => r.hasPower && r.mmp);
    const env = DUR.map(() => NaN), best = DUR.map(() => null), count = DUR.map(() => 0);
    for (const r of pw) {
      DUR.forEach((d, i) => {
        const v = r.mmp[i];
        if (!(v > 0)) return;
        count[i]++;
        if (!(v <= env[i])) { env[i] = v; best[i] = r; }
      });
    }
    for (let i = DUR.length - 2; i >= 0; i--) if (env[i + 1] > env[i]) { env[i] = env[i + 1]; best[i] = best[i + 1]; }   // un record plus long ne peut dépasser un plus court
    const fit = fitMorton(DUR.map((d, i) => ({ d, p: env[i] })).filter((q) => q.d <= FIT_MAX_S), { pmax: env[0] });
    const hr = hrMaxEstimate(win.map((r) => r.hrPeak));
    const mass = Number(opts.mass) > 0 ? Number(opts.mass) : 72;
    const p5 = env[I(300)];
    const vo2max = p5 > 0 ? PYR.metabo.vo2maxFromP5(p5, mass) : NaN;
    let first = Infinity;
    for (const r of win) if (r.startMs < first) first = r.startMs;
    const rPmax = relPmax(env, fit);
    return {
      fromMs: Number.isFinite(first) ? first : NaN, toMs: endMs, days,
      rides: win, nRides: win.length, nPower: pw.length, nHr: win.filter((r) => Number.isFinite(r.hrPeak)).length,
      env, best, count, fit, pmax: env[0], hr, vo2max,
      rel: {
        cp: relCp(env, fit), wPrime: relWPrime(env, fit), pmax: rPmax, hrMax: relHr(hr, opts.age), vo2max: relVo2(env),
        records: DUR.map((d, i) => relRecord(i, env, count, pw.length, fit, rPmax)),
      },
    };
  }

  PYR.history = {
    P_MAX_W, SPIKE_K, HR_MAX, HR_JUMP, FIT_MAX_S,
    sportClass, parseCsv, stravaIndex, baseName, series, cleanPower, cleanHr, mmp, hrPeak, analyze, fitMorton, hrMaxEstimate, aggregate,
  };
})(globalThis.PYR = globalThis.PYR || {});
