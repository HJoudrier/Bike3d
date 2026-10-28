/* author : Hugo Joudrier-Faure */
/* PaceYourRide — sortie réelle (GPX / TCX) : lecture, et estimation du CdA et du Crr du cycliste.
 *
 * Une sortie enregistrée donne, seconde par seconde, la position, l'altitude, l'heure et la puissance. Sur une fenêtre de
 * quelques secondes (30 s), le bilan d'énergie de la physique de la simulation s'écrit, à la roue :
 *
 *   η·ΣP·dt − ½·m_eff·(v_fin² − v_début²) − m·g·(h_fin − h_début)  =  Crr · m·g·(distance)  +  CdA · Σ ½·ρ·v_air·|v_air|_x·v·dt
 *
 * avec P la puissance mesurée, η le rendement de la transmission, v la vitesse, h l'altitude, ρ la masse volumique de l'air,
 * v_air = v + vent de face, et |v_air|_x = √(v_air² + vent de travers²). Le membre de gauche et les deux régresseurs sont
 * connus : c'est une régression linéaire à deux inconnues (CdA, Crr), résolue par moindres carrés pondérés (pondération de
 * Huber : les fenêtres qui s'écartent du modèle — freinage, bourrasque, glissement — pèsent moins). CdA et Crr se distinguent
 * par la façon dont la puissance varie avec la vitesse (v³ pour l'air, v pour le roulement) : une sortie à vitesse constante
 * les confond, d'où l'incertitude et les mises en garde renvoyées.
 *
 * Lecture sans DOM (expressions régulières) : le module se teste sous Node comme le reste du moteur. */
(function (PYR) {
  'use strict';

  const G = 9.80665, R_EARTH = 6371000, D2R = Math.PI / 180;
  const WIND_K = 0.7;        // vent à hauteur de cycliste / vent à 10 m (comme weather.js)
  const MAX_POINTS = 400000; // garde-fou : au-delà, le fichier n'est pas une sortie de vélo plausible

  /* ---------- Lecture ---------- */

  /** Texte de la première balise dont le nom (sans espace de noms) figure dans `names` (alternatives « a|b »). */
  function tag(body, names) {
    const m = new RegExp('<(?:[\\w.-]+:)?(?:' + names + ')\\b[^>]*>\\s*([^<\\s][^<]*?)\\s*<', 'i').exec(body);
    return m ? m[1] : null;
  }
  const num = (s) => { const x = s === null || s === undefined ? NaN : parseFloat(s); return Number.isFinite(x) ? x : NaN; };

  /**
   * Lit un GPX ou un TCX. Renvoie {format, name, points: [{t (s depuis le premier point), lat, lng, ele, dist, power}],
   * hasTime, hasEle, hasPower, hasDist, startMs (date du premier point, ms), sport (attribut Sport d'un TCX, <type> d'un GPX, ou '')}.
   * Les champs absents valent NaN. La puissance est cherchée dans <power>, dans les extensions Garmin (<…:PowerInWatts>, <…:watts>) et,
   * pour un TCX, dans <Watts>. opts.anyPos : garder aussi les points horodatés sans position (TCX d'un entraînement en salle).
   */
  function parse(text, opts) {
    const anyPos = !!(opts && opts.anyPos);
    text = String(text || '');
    const isTcx = /<TrainingCenterDatabase\b|<Trackpoint\b/i.test(text);
    const raw = [];
    if (isTcx) {
      const re = /<Trackpoint\b[^>]*>([\s\S]*?)<\/Trackpoint>/gi;
      let m;
      while ((m = re.exec(text)) && raw.length < MAX_POINTS) {
        const b = m[1];
        raw.push({
          ms: Date.parse(tag(b, 'Time') || ''), lat: num(tag(b, 'LatitudeDegrees')), lng: num(tag(b, 'LongitudeDegrees')),
          ele: num(tag(b, 'AltitudeMeters')), dist: num(tag(b, 'DistanceMeters')), power: num(tag(b, 'Watts|PowerInWatts|power')),
          hr: num((/<HeartRateBpm\b[^>]*>\s*<Value>\s*([\d.]+)/i.exec(b) || [])[1]), cad: num(tag(b, 'Cadence|RunCadence')),
        });
      }
    } else {
      const re = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/gi;
      let m;
      while ((m = re.exec(text)) && raw.length < MAX_POINTS) {
        const attrs = m[1], b = m[2] || '';
        const la = /\blat\s*=\s*["']([^"']+)["']/i.exec(attrs), lo = /\blon\s*=\s*["']([^"']+)["']/i.exec(attrs);
        raw.push({
          ms: Date.parse(tag(b, 'time') || ''), lat: num(la && la[1]), lng: num(lo && lo[1]), ele: num(tag(b, 'ele')),
          dist: NaN, power: num(tag(b, 'power|watts|PowerInWatts')), hr: num(tag(b, 'hr|heartrate')), cad: num(tag(b, 'cad|cadence')),
        });
      }
    }
    // TCX d'un entraînement en salle : points sans position ; on les garde seulement s'il en reste avec une position (ou avec opts.anyPos)
    const points = raw.filter((p) => (Number.isFinite(p.lat) && Number.isFinite(p.lng)) || (anyPos && Number.isFinite(p.ms)));
    if (points.length < 2) throw new Error(`Aucune trace trouvée dans le ${isTcx ? 'TCX' : 'GPX'} (il faut des points avec une position).`);
    const first = points.find((p) => Number.isFinite(p.ms)), t0 = first ? first.ms : NaN;
    for (const p of points) { p.t = Number.isFinite(t0) && Number.isFinite(p.ms) ? (p.ms - t0) / 1000 : NaN; delete p.ms; }
    const nameM = isTcx ? /<Id>\s*([^<]+?)\s*<\/Id>/i.exec(text) : /<(?:trk|metadata)\b[^>]*>[\s\S]*?<name>\s*([^<]+?)\s*<\/name>/i.exec(text);
    // sport d'un GPX : <type> de la trace (entre <trk> et <trkseg>), pas celui d'un lien des métadonnées (« text/html »)
    const trkAt = text.search(/<trk\b/i), segAt = text.search(/<trkseg\b/i);
    const head = isTcx || trkAt < 0 ? '' : text.slice(trkAt, segAt > trkAt ? segAt : trkAt + 4000);
    const sportM = isTcx ? /<Activity\b[^>]*\bSport\s*=\s*["']([^"']*)["']/i.exec(text) : /<type>\s*([^<]*?)\s*<\/type>/i.exec(head);
    const any = (k) => points.some((p) => Number.isFinite(p[k]));
    return {
      format: isTcx ? 'tcx' : 'gpx', name: nameM ? nameM[1] : '', points, startMs: t0, sport: sportM ? sportM[1] : '',
      hasTime: points.filter((p) => Number.isFinite(p.t)).length >= 2, hasEle: any('ele'), hasPower: any('power'), hasDist: any('dist'),
    };
  }

  /* ---------- Préparation : une ligne par seconde ---------- */

  const hav = (la1, lo1, la2, lo2) => {
    const dLa = (la2 - la1) * D2R, dLo = (lo2 - lo1) * D2R;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * D2R) * Math.cos(la2 * D2R) * Math.sin(dLo / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  };

  /** Moyenne glissante centrée (±k) ; NaN si une valeur de la fenêtre est NaN (pas d'extrapolation sur un trou). */
  function movingMean(a, k) {
    const n = a.length, out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (i - k < 0 || i + k >= n) { out[i] = NaN; continue; }
      let s = 0;
      for (let j = i - k; j <= i + k; j++) s += a[j];
      out[i] = s / (2 * k + 1);
    }
    return out;
  }
  /** Médiane glissante centrée (±k), bords recopiés. */
  function movingMedian(a, k) {
    const n = a.length, out = new Float64Array(n), buf = [];
    for (let i = 0; i < n; i++) {
      buf.length = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) buf.push(a[j]);
      buf.sort((x, y) => x - y);
      out[i] = buf[buf.length >> 1];
    }
    return out;
  }

  /**
   * Rééchantillonne la sortie à 1 Hz et calcule ce qu'il faut au bilan de puissance.
   * opts : {windKmh (vent météo à 10 m), windDir (° d'où il vient), tempC, speedWin (s, ±), eleWin (s, ±), maxGap (s)}
   * Renvoie {n, s, ele, v, a, grade, bearing, P (lissée), Praw, valid, wh, wc, rho, hasPower, length, duration}.
   */
  function prepare(act, opts) {
    opts = opts || {};
    if (!act.hasTime) throw new Error('Le fichier ne contient pas d\'heure : impossible de reconstituer la vitesse.');
    if (!act.hasEle) throw new Error('Le fichier ne contient pas d\'altitude : la pente est indispensable.');
    const kV = opts.speedWin === undefined ? 2 : opts.speedWin, eleW = opts.eleWin === undefined ? 8 : opts.eleWin, maxGap = opts.maxGap || 6;
    const clean = [];
    for (const p of act.points) {
      if (!Number.isFinite(p.t)) continue;
      if (!clean.length || p.t > clean[clean.length - 1].t) clean.push(p);
    }
    if (clean.length < 30) throw new Error('Trop peu de points horodatés (30 au moins) pour estimer quoi que ce soit.');
    // altitude manquante sur quelques points : on interpole entre voisins
    let lastE = NaN;
    for (const p of clean) { if (Number.isFinite(p.ele)) lastE = p.ele; else if (Number.isFinite(lastE)) p.ele = lastE; }
    const firstE = clean.find((p) => Number.isFinite(p.ele));
    for (const p of clean) if (!Number.isFinite(p.ele)) p.ele = firstE.ele;
    // distance cumulée : celle du fichier (capteur de vitesse) si elle est complète, sinon la distance GPS
    const fileDist = clean.every((p) => Number.isFinite(p.dist)) && clean[clean.length - 1].dist > clean[0].dist;
    const cum = new Float64Array(clean.length);
    for (let i = 1; i < clean.length; i++) {
      cum[i] = fileDist ? clean[i].dist - clean[0].dist : cum[i - 1] + hav(clean[i - 1].lat, clean[i - 1].lng, clean[i].lat, clean[i].lng);
      if (cum[i] < cum[i - 1]) cum[i] = cum[i - 1];
    }
    const n = Math.floor(clean[clean.length - 1].t) + 1;
    if (n < 60) throw new Error('Sortie trop courte (moins d\'une minute).');
    const s = new Float64Array(n), ele0 = new Float64Array(n), lat = new Float64Array(n), lng = new Float64Array(n);
    const Praw = new Float64Array(n).fill(NaN), valid = new Uint8Array(n);
    let j = 0;
    for (let t = 0; t < n; t++) {
      while (j + 2 < clean.length && clean[j + 1].t < t) j++;
      const a = clean[j], b = clean[j + 1];
      const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
      s[t] = cum[j] + (cum[j + 1] - cum[j]) * f;
      ele0[t] = a.ele + (b.ele - a.ele) * f;
      lat[t] = a.lat + (b.lat - a.lat) * f; lng[t] = a.lng + (b.lng - a.lng) * f;
      valid[t] = b.t - a.t <= maxGap ? 1 : 0;       // un trou d'enregistrement (pause, perte de signal) n'est pas une mesure
      if (Number.isFinite(a.power) && Number.isFinite(b.power)) Praw[t] = a.power + (b.power - a.power) * f;
      else if (Number.isFinite(a.power) && f < 0.5) Praw[t] = a.power;
      else if (Number.isFinite(b.power) && f >= 0.5) Praw[t] = b.power;
    }
    // vitesse (différence centrée sur ±kV s), accélération (différence centrée de la vitesse lissée)
    const v = new Float64Array(n).fill(NaN), acc = new Float64Array(n).fill(NaN);
    for (let t = kV; t < n - kV; t++) v[t] = (s[t + kV] - s[t - kV]) / (2 * kV);
    for (let t = kV + 1; t < n - kV - 1; t++) acc[t] = (v[t + 1] - v[t - 1]) / 2;
    // puissance lissée sur la même fenêtre que la vitesse : la puissance d'une seconde agit sur la vitesse des suivantes
    const P = movingMean(Praw, kV);
    // altitude : médiane (pics de baromètre) puis moyenne, pente sur ±eleW s
    const eleS = movingMean(movingMedian(ele0, 3), eleW);
    for (let t = 0; t < n; t++) if (!Number.isFinite(eleS[t])) eleS[t] = ele0[t];
    const grade = new Float64Array(n).fill(NaN);
    for (let t = eleW; t < n - eleW; t++) {
      const ds = s[t + eleW] - s[t - eleW];
      grade[t] = ds > 15 ? (eleS[t + eleW] - eleS[t - eleW]) / ds : NaN;
    }
    // cap de la route (±5 s) et composantes du vent : de face (> 0) et de travers
    const bearing = new Float64Array(n), wh = new Float64Array(n), wc = new Float64Array(n), rho = new Float64Array(n);
    const W = Math.max(0, Number(opts.windKmh) || 0) / 3.6 * WIND_K, wd = Number(opts.windDir) || 0;
    const tempC = Number.isFinite(Number(opts.tempC)) ? Number(opts.tempC) : 15;
    const eRef = eleS[0];
    for (let t = 0; t < n; t++) {
      const a = Math.max(0, t - 5), b = Math.min(n - 1, t + 5);
      const y = (lng[b] - lng[a]) * Math.cos(lat[t] * D2R), x = lat[b] - lat[a];
      bearing[t] = (Math.atan2(y, x) / D2R + 360) % 360;
      const rel = (wd - bearing[t]) * D2R;
      wh[t] = W * Math.cos(rel); wc[t] = W * Math.abs(Math.sin(rel));
      rho[t] = PYR.physics.airDensity(eleS[t], tempC - 0.0065 * (eleS[t] - eRef));
    }
    return {
      n, s, ele: eleS, v, a: acc, grade, bearing, P, Praw, valid, wh, wc, rho,
      hasPower: act.hasPower, length: s[n - 1], duration: n - 1,
    };
  }

  /* ---------- Estimation : bilan d'énergie sur des fenêtres ---------- */

  /**
   * Découpe la sortie en fenêtres de `win` secondes (une toutes les `stride` secondes) et écrit, pour chacune, le bilan
   * d'énergie à la roue (J) :
   *   η·ΣP·dt  −  ½·m_eff·(v_fin² − v_début²)  −  m·g·(h_fin − h_début)   =   Crr · m·g·(distance)  +  CdA · Σ ½·ρ·v_air·|v_air|_x·v·dt
   * Une fenêtre est préférable au bilan seconde par seconde : l'aérodynamique (v³) est intégrée sur les vitesses de chaque
   * seconde sans lissage, l'accélération se réduit à deux vitesses, et l'altitude n'intervient qu'aux deux bords (une
   * moyenne glissante n'y déforme pas une pente régulière, alors qu'elle écrase le relief d'une pente calculée par seconde).
   * Renvoie une fenêtre par départ : {t0, dt, ok, y, x1, x2, v (m/s moyen), g (pente moyenne), pMeas, pRest (W, mesurée et
   * hors Crr / CdA)} ; ok = false si la fenêtre n'est pas exploitable (trou, arrêt, freinage, puissance manquante).
   */
  function windows(prep, setup, opts) {
    const win = Math.max(10, Math.round(opts.window || 30)), stride = Math.max(1, Math.round(opts.stride || win / 3));
    const eta = setup.eta, mass = opts.mass > 0 ? opts.mass : setup.mass, mEff = setup.massEff + (mass - setup.mass);
    const out = [];
    for (let t0 = 3; t0 + win <= prep.n - 4; t0 += stride) {
      const t1 = t0 + win;
      let ok = true, eP = 0, x2 = 0, vMin = Infinity, vSum = 0;
      for (let t = t0; t < t1; t++) {
        const P = prep.Praw[t], v = prep.v[t];
        if (!prep.valid[t] || !Number.isFinite(P) || !Number.isFinite(v)) { ok = false; break; }
        const va = v + prep.wh[t], vapp = Math.sqrt(va * va + prep.wc[t] * prep.wc[t]);
        eP += P; x2 += 0.5 * prep.rho[t] * vapp * va * v; vSum += v;
        if (v < vMin) vMin = v;
      }
      const w = { t0, dt: win, ok: false };
      if (!ok) { out.push(w); continue; }
      const va0 = prep.v[t0], va1 = prep.v[t1];
      if (!Number.isFinite(va0) || !Number.isFinite(va1)) { out.push(w); continue; }
      const ds = prep.s[t1] - prep.s[t0], dh = prep.ele[t1] - prep.ele[t0];
      const dKE = 0.5 * mEff * (va1 * va1 - va0 * va0), dPE = mass * G * dh;
      w.v = vSum / win; w.g = ds > 10 ? dh / ds : NaN; w.pMeas = eP / win;
      w.y = eta * eP - dKE - dPE;
      w.x1 = mass * G * ds;
      w.x2 = x2;
      // exclusions : arrêt ou quasi-arrêt, descente très raide, puissance aberrante, freinage (puissance nulle et ralentissement :
      // le frein dissipe de l'énergie que le modèle ignore)
      const aMean = (va1 - va0) / win;
      if (vMin < 1.5 || w.v < 2.5 || w.v > 25 || !Number.isFinite(w.g) || Math.abs(w.g) > 0.25 || w.pMeas > 1500) { out.push(w); continue; }
      if (w.pMeas < 5 && aMean < -0.15) { out.push(w); continue; }
      w.ok = true;
      out.push(w);
    }
    return out;
  }

  /** Moindres carrés pondérés à deux inconnues (b1, b2) ; renvoie aussi (X'WX)⁻¹. */
  function wls(rows, w, cols) {
    let s11 = 0, s12 = 0, s22 = 0, r1 = 0, r2 = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], wi = w[i], a = cols[0](r), b = cols[1](r), y = cols[2](r);
      s11 += wi * a * a; s12 += wi * a * b; s22 += wi * b * b; r1 += wi * a * y; r2 += wi * b * y;
    }
    const det = s11 * s22 - s12 * s12;
    if (!(Math.abs(det) > 1e-9 * (s11 * s22 || 1))) return null;
    return { b1: (r1 * s22 - r2 * s12) / det, b2: (s11 * r2 - s12 * r1) / det, inv: [s22 / det, -s12 / det, s11 / det] };
  }

  /** Moindres carrés pondérés à un seul paramètre : y ≈ b · x. */
  function wls1(rows, w, xcol, ycol) {
    let sxx = 0, sxy = 0;
    for (let i = 0; i < rows.length; i++) { const r = rows[i], x = xcol(r); sxx += w[i] * x * x; sxy += w[i] * x * ycol(r); }
    return sxx > 0 ? { b1: sxy / sxx, inv: [1 / sxx] } : null;
  }

  const quantile = (arr, q) => { const a = Array.from(arr).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : NaN; };

  /**
   * Estime le CdA et/ou le Crr. setup : paramètres du vélo (PYR.physics.buildSetup : masse, rendement, CdA et Crr actuels).
   * opts : {mode: 'both' (défaut) | 'cda' (Crr fixé à opts.crr0 ou à celui du vélo) | 'crr' (CdA fixé à opts.cda0 ou à celui du vélo),
   *         mass (kg, remplace la masse du vélo + cycliste), windKmh (pour les avertissements), window (s, 30), stride (s, 10)}
   * Renvoie {ok, cda, crr, seCda, seCrr, corr, n (fenêtres), seconds (secondes exploitées), rmse (W), bias (W), r2, mode,
   * warnings, series} ou {ok: false, error}. series : par fenêtre de `window` secondes (sans recouvrement), puissance
   * moyenne mesurée et modélisée : {s, t, P, Pmodel, ele, v}.
   */
  function fit(prep, setup, opts) {
    opts = opts || {};
    if (!prep.hasPower) return { ok: false, error: 'Le fichier ne contient pas de puissance : elle est nécessaire à l\'estimation.' };
    const mode = opts.mode === 'cda' || opts.mode === 'crr' ? opts.mode : 'both';
    const eta = setup.eta, mass = opts.mass > 0 ? opts.mass : setup.mass, mEff = setup.massEff + (mass - setup.mass);
    const all = windows(prep, setup, opts), stride = Math.max(1, Math.round(opts.stride || (opts.window || 30) / 3));
    const winLen = all.length ? all[0].dt : 30;
    const rows = all.filter((w) => w.ok);
    if (rows.length < 12) return { ok: false, error: `Seulement ${rows.length} fenêtres de ${winLen} s exploitables (vitesse ≥ 9 km/h, puissance et altitude valides, sans arrêt) : il en faut au moins 12.` };
    const crr0 = Number(opts.crr0) > 0 ? Number(opts.crr0) : setup.crr, cda0 = Number(opts.cda0) > 0 ? Number(opts.cda0) : setup.cda;
    // inconnues selon le mode : (Crr, CdA) ensemble, ou un seul des deux, l'autre fixé et passé dans le membre de gauche
    const colCrr = (r) => r.x1, colCda = (r) => r.x2;
    const w = new Float64Array(rows.length).fill(1);
    let sol = null;
    for (let it = 0; it < 8; it++) {
      sol = mode === 'both' ? wls(rows, w, [colCrr, colCda, (r) => r.y])
        : mode === 'cda' ? wls1(rows, w, colCda, (r) => r.y - crr0 * r.x1)
          : wls1(rows, w, colCrr, (r) => r.y - cda0 * r.x2);
      if (!sol) return { ok: false, error: 'Données dégénérées (aucune variation de vitesse ou de pente) : estimation impossible.' };
      const crr = mode === 'cda' ? crr0 : sol.b1, cda = mode === 'crr' ? cda0 : mode === 'cda' ? sol.b1 : sol.b2;
      // pondération de Huber sur les résidus en puissance (W) : échelle robuste (MAD), plancher de 1 W
      const res = rows.map((r) => (r.y - crr * r.x1 - cda * r.x2) / (r.dt * eta));
      const abs = res.map(Math.abs).sort((x, y) => x - y);
      const sigma = Math.max(1.4826 * abs[abs.length >> 1], 1);
      for (let i = 0; i < rows.length; i++) { const k = 1.5 * sigma, e = Math.abs(res[i]); w[i] = e <= k ? 1 : k / e; }
    }
    let crr, cda;
    if (mode === 'both') { crr = sol.b1; cda = sol.b2; } else if (mode === 'cda') { crr = crr0; cda = sol.b1; } else { crr = sol.b1; cda = cda0; }
    // résidus (en puissance aux pédales), incertitude : les fenêtres se recouvrent (×winLen/stride) et leurs résidus sont voisins
    // (×2) : on gonfle la variance d'autant
    let se2 = 0, sw = 0, sumRes = 0, sumY = 0, sumY2 = 0, sumRes2 = 0;
    rows.forEach((r, i) => {
      const e = r.y - crr * r.x1 - cda * r.x2;
      se2 += w[i] * e * e; sw += w[i]; sumRes += e / (r.dt * eta); sumRes2 += (e / (r.dt * eta)) ** 2;
      const yp = r.y / r.dt; sumY += yp; sumY2 += yp * yp;
    });
    const dof = Math.max(1, sw - (mode === 'both' ? 2 : 1)), s2 = se2 / dof, inflate = 2 * Math.max(1, winLen / stride);
    const inv = sol.inv;
    let seCrr = NaN, seCda = NaN, corr = NaN;
    if (mode === 'both') {
      seCrr = Math.sqrt(s2 * inv[0] * inflate); seCda = Math.sqrt(s2 * inv[2] * inflate);
      corr = inv[1] / Math.sqrt(inv[0] * inv[2]);
    } else {
      const se = Math.sqrt(s2 * inv[0] * inflate);
      if (mode === 'cda') seCda = se; else seCrr = se;
    }
    const meanY = sumY / rows.length, varY = sumY2 / rows.length - meanY * meanY;
    const rmse = Math.sqrt(sumRes2 / rows.length);
    const warnings = [];
    const vs = rows.map((r) => r.v), gs = rows.map((r) => r.g);
    const vSpread = quantile(vs, 0.9) - quantile(vs, 0.1), gSpread = quantile(gs, 0.9) - quantile(gs, 0.1);
    const seconds = Math.round(rows.length * stride + winLen - stride);
    if (seconds < 600) warnings.push(`Peu de données exploitables (≈ ${seconds} s) : l'estimation est fragile.`);
    if (mode === 'both' && Math.abs(corr) > 0.92) warnings.push('CdA et Crr sont presque indiscernables sur cette sortie (vitesse trop régulière) : fixe l\'un des deux et estime l\'autre.');
    else if (vSpread < 2.5) warnings.push('La vitesse varie peu : CdA et Crr se séparent mal. Une sortie avec des montées et des descentes aide.');
    if (gSpread < 0.01) warnings.push('Le parcours est quasi plat : l\'erreur d\'altitude pèse peu, mais la séparation CdA / Crr est plus difficile.');
    if (!(Number(opts.windKmh) > 0)) warnings.push('Aucun vent saisi : l\'effet du vent éventuel sera attribué au CdA.');
    if (cda < 0.15 || cda > 0.6) warnings.push(`CdA de ${cda.toFixed(3)} m² peu plausible (0,15 à 0,60) : vérifie la masse, le vent et la puissance (étalonnage du capteur).`);
    if (crr < 0.001 || crr > 0.015) warnings.push(`Crr de ${crr.toFixed(4)} peu plausible (0,001 à 0,015) : l'altitude du fichier est probablement trop bruitée (surtout si elle vient du GPS).`);
    // série pour le graphique : une valeur par fenêtre de winLen secondes sans recouvrement, tenue sur toute la fenêtre
    const n = prep.n, Pm = new Float64Array(n).fill(NaN), Pmodel = new Float64Array(n).fill(NaN);
    const first = all.length ? all[0].t0 : 3;
    for (const wd of all) {
      if ((wd.t0 - first) % winLen !== 0 || !Number.isFinite(wd.y)) continue;
      const resid = (wd.y - crr * wd.x1 - cda * wd.x2) / (eta * winLen);   // W : ce que le modèle n'explique pas
      for (let t = wd.t0; t < wd.t0 + winLen && t < n; t++) { Pm[t] = wd.pMeas; Pmodel[t] = Math.max(0, wd.pMeas - resid); }
    }
    return {
      ok: true, mode, cda, crr, seCda, seCrr, corr, n: rows.length, seconds, share: seconds / prep.n, rmse, bias: sumRes / rows.length,
      r2: varY > 0 ? 1 - (se2 / sw / (winLen * winLen)) / varY : NaN, warnings, mass, eta, window: winLen,
      series: { s: prep.s, ele: prep.ele, v: prep.v, P: Pm, Pmodel },
    };
  }

  PYR.activity = { parse, prepare, fit, WIND_K };
})(globalThis.PYR = globalThis.PYR || {});
