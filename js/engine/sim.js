/* author : Hugo Joudrier-Faure */
/* PaceYourRide — simulateur seconde par seconde (partagé par l'optimiseur et le mode jeu).
 *
 * Dynamique : m_eff·dv/dt = η·P/v − ½ρ·CdA·|v_air|·(v + v_face) − m·g·sin θ − Crr·m·g·cos θ
 * Physiologie :
 *   - W′bal (Skiba) : au-dessus de la PC on puise dans W′, en dessous il se reconstitue ;
 *   - limiteur « courbe record » : sur chaque fenêtre glissante de durée d (1 s … 5 h),
 *     la puissance moyenne ne peut pas dépasser le record MMP(d).
 * Mode jeu et courses à plusieurs (sans effet sur l'optimiseur, valeurs neutres par défaut) :
 *   - cond.cdaK : facteur de CdA dû à l'aspiration (1 = seul au vent) ;
 *   - cond.stopped : cycliste arrêté (crevaison, chute) ;
 *   - cond.vCap : vitesse à ne pas dépasser (freinage léger pour ne pas rouler sur la roue devant) ;
 *   - cond.wcS : vent de côté signé (> 0 : il vient de la droite du coureur), pour le placement dans le peloton (peloton.js) ;
 *     cond.wc reste sa valeur absolue, seule utile à la traînée ;
 *   - st.s peut être négatif (grille de départ du peloton, derrière la ligne) : on lit alors la première cellule ;
 *   - st.capK : facteur de capacité (fringale, déshydratation, blessure) appliqué à la PC,
 *     au W′ et à la courbe record ; st.wK (facultatif) : facteur propre au W′ (modèle physiologique, metabo.js) ;
 *   - opts.recMax de createContext : durée (s) au-delà de laquelle la courbe record ne limite plus (modèle physiologique : la
 *     durabilité des efforts longs vient alors du glycogène, de la fatigue des fibres, de la chaleur et de l'eau).
 * Stratégie optimale avec le modèle physiologique (modèle réduit, cf. optimizer.optimizePhysio) :
 *   - opts.capS et opts.wS de createContext : facteurs de capacité le long du parcours (un par cellule du tracé, lus par conditions dans
 *     cond.capS et cond.wS) : la PC, le W′ et les records des efforts de moins de 20 min y sont réduits comme avec st.capK et st.wK ;
 *   - opts.endK : endurance du jour, facteur des records de 20 min et plus (fenêtres longues, durée totale de enduranceUse). */
(function (PYR) {
  'use strict';

  const G = 9.80665;
  const LONG_WINDOW = 1200; // s — fenêtres « endurance » surveillées par l'optimiseur
  const SUSTAIN_H = 900;    // s — mode jeu : horizon sur lequel on vérifie qu'on pourra encore rouler à la PC
  // instants (s) où l'on vérifie les fenêtres longues, en progression géométrique jusqu'à SUSTAIN_H
  // mode jeu : une fenêtre de plus tous les ≈ 7 % de durée (15 % au-delà de 20 min, où l'anticipation de sustainCap les parcourt toutes) entre deux points de la courbe record
  const SMOOTH_RATIO = 1.07, SMOOTH_RATIO_LONG = 1.15;
  const SUSTAIN_GRID = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, SUSTAIN_H];

  /** Série de rafales normalisée (moyenne nulle, pics à 1), déterministe. */
  function makeGusts(seed, n) {
    const rnd = PYR.util.mulberry32(seed);
    const g = new Float32Array(n);
    let t = 0;
    while (t < n) {
      t += 3 + (-Math.log(1 - rnd()) * 10);
      const a = 0.35 + 0.65 * rnd(), r = 1 + 2 * rnd(), h = 1 + 3 * rnd(), dd = 2 + 4 * rnd();
      const t0 = Math.floor(t), len = Math.ceil(r + h + dd);
      for (let j = 0; j <= len && t0 + j < n; j++) {
        const sh = j < r ? j / r : j < r + h ? 1 : Math.max(0, 1 - (j - r - h) / dd);
        const v = a * sh;
        if (v > g[t0 + j]) g[t0 + j] = v;
      }
    }
    let mean = 0, max = 0;
    for (let i = 0; i < n; i++) { mean += g[i]; if (g[i] > max) max = g[i]; }
    mean /= n;
    const sc = max > mean ? 1 / (max - mean) : 0;
    for (let i = 0; i < n; i++) g[i] = (g[i] - mean) * sc;
    return g;
  }

  /**
   * Record de puissance (W) à la durée d, interpolé linéairement entre les deux points voisins de la courbe record
   * (les durées de physio.DURATIONS) ; hors de leur plage, la courbe elle-même.
   */
  function linearRecord(athlete) {
    const D = PYR.physio.DURATIONS, vals = D.map((d) => athlete.mmp(d));
    return (d) => {
      if (d <= D[0] || d >= D[D.length - 1]) return athlete.mmp(d);
      let i = 1;
      while (D[i] < d) i++;
      return vals[i - 1] + (vals[i] - vals[i - 1]) * (d - D[i - 1]) / (D[i] - D[i - 1]);
    };
  }

  /**
   * Contexte de simulation.
   * opts : {margin (−2…0.99 ; 1 − forme : 0,2 = 80 % des capacités, −0,1 = 110 %), seed, vMinProgress,
   *         capS, wS (facteurs de capacité de la PC et du W′ par cellule du parcours, null = 1 partout),
   *         endK (endurance du jour, ≤ 1 : records des efforts de 20 min et plus, fenêtres longues et durée totale)}
   */
  function createContext(course, setup, athlete, opts) {
    opts = opts || {};
    const k = Math.min(3, Math.max(0.01, 1 - (Number(opts.margin) || 0)));
    const endK = Number(opts.endK) > 0 ? Math.min(1, Number(opts.endK)) : 1;   // endurance du jour : records de 20 min et plus
    const L = course.length;
    const maxSteps = Math.ceil(L / 1.0) + 900;
    const recMax = Number(opts.recMax) > 0 ? Number(opts.recMax) : Infinity;   // au-delà, la courbe record ne limite plus
    const win = [], capTot = [], extra = [];
    const add = (d, p, isExtra) => {
      if (d > recMax) return;
      win.push(d); capTot.push(d * (p === undefined ? athlete.mmp(d) : p) * k * (d >= LONG_WINDOW ? endK : 1)); extra.push(isExtra ? 1 : 0);
    };
    for (const d of PYR.physio.DURATIONS) add(d);
    for (const d of [12600, 16200, 21600, 25200, 28800, 36000, 43200, 57600, 72000, 86400]) if (d < maxSteps) add(d);
    // Mode jeu : le record entre deux points de la courbe est interpolé linéairement (puissance en fonction de la durée) et
    // des fenêtres intermédiaires s'ajoutent entre les points : la limite de puissance évolue alors sans marches d'escalier
    // quand l'effort se prolonge (au lieu de ne changer qu'aux 25 durées de la courbe).
    const mmpAt = opts.smoothRec ? linearRecord(athlete) : null;
    if (mmpAt) {
      const D = PYR.physio.DURATIONS, used = new Set(win);
      for (let i = 1; i < D.length && D[i - 1] < maxSteps; i++) {
        const d0 = D[i - 1], d1 = D[i];
        const m = Math.ceil(Math.log(d1 / d0) / Math.log(d0 >= LONG_WINDOW ? SMOOTH_RATIO_LONG : SMOOTH_RATIO)) - 1;
        for (let q = 1; q <= m; q++) {
          const d = Math.round(d0 + (d1 - d0) * q / (m + 1));
          if (used.has(d) || d <= d0 || d >= d1 || d >= maxSteps) continue;
          used.add(d);
          add(d, mmpAt(d), true);
        }
      }
    }
    const order = win.map((d, i) => i).sort((a, b) => win[a] - win[b]);
    const sortedWin = order.map((i) => win[i]);
    // Enveloppe d'un effort maximal : P(τ) = d/dτ [τ·MMP(τ)] (profil lissé qui sature la courbe record)
    const nEnv = 3600;
    const env = new Float32Array(nEnv + 1);
    let prev = 0;
    for (let tau = 1; tau <= nEnv; tau++) { const w = tau * athlete.mmp(tau) * k; env[tau] = w - prev; prev = w; }
    return {
      course, setup, athlete,
      cp: athlete.cp * k,
      w0: athlete.w0 * k,
      recF: athlete.recF,
      win: Int32Array.from(sortedWin),
      capTot: Float64Array.from(order.map((i) => capTot[i])),
      extra: Uint8Array.from(order.map((i) => extra[i])), // 1 : fenêtre intermédiaire interpolée (mode jeu)
      mmpAt,                                              // record interpolé linéairement (mode jeu), sinon null
      nWin: win.length,
      nWinShort: sortedWin.filter((d) => d < LONG_WINDOW).length,
      longCap: true, // false : fenêtres ≥ 20 min non appliquées (phase de recherche de l'optimiseur)
      smoothRec: !!opts.smoothRec, // mode jeu : anticiper les records longs (cf. sustainCap)
      env, nEnv,
      marginK: k,
      endK,
      recMax,
      maxSteps,
      gusts: course.hasGusts ? makeGusts(Number(opts.seed) || 20240917, maxSteps + 2) : null,
      aBrake: course.aBrake || 3.5,
      vMinProgress: opts.vMinProgress !== undefined ? opts.vMinProgress : 1.0,
      subSteps: Math.max(1, Math.round(Number(opts.subSteps) || 1)), // sous-pas d'intégration par seconde (1 : pas de 1 s)
      // capacité le long du parcours (stratégie optimale avec le modèle physiologique), null : entière partout
      capS: opts.capS && opts.capS.length === course.n ? opts.capS : null,
      wS: opts.wS && opts.wS.length === course.n ? opts.wS : null,
    };
  }

  const subCond = {};  // conditions des sous-pas (réutilisées, aucune allocation dans la boucle)

  /**
   * État de départ. `from` (facultatif) : repartir d'une sortie déjà entamée — {t (s écoulées), s (m), v (m/s), wbal (J), hist
   * (énergie cumulée par seconde, hist[k] = ∑ des k premières puissances ; au moins t + 1 valeurs)}. L'historique est recopié dans
   * H : les secondes passées restent figées et la courbe de puissance record les compte dans ses fenêtres glissantes.
   */
  function initState(ctx, v0, hist, from) {
    const H = hist || new Float64Array(ctx.maxSteps + 2);
    const t0 = from ? Math.max(0, Math.min(ctx.maxSteps, Math.floor(Number(from.t) || 0))) : 0;
    H[0] = 0;
    if (from && from.hist) for (let k = 1; k <= t0; k++) H[k] = from.hist[k] !== undefined ? from.hist[k] : H[k - 1];
    return {
      t: t0, s: from ? Math.max(0, Number(from.s) || 0) : 0, v: Math.max(0, Number(from ? from.v : v0) || 0),
      wbal: from && Number.isFinite(from.wbal) ? Math.min(ctx.w0, Math.max(0, from.wbal)) : ctx.w0,
      work: H[t0], hist: H,
      capped: false, allout: 0,
      finished: false, tFinish: NaN, stalled: 0, braking: false,
      P: 0, capW: 0, capM: 0,
    };
  }

  /**
   * Mode jeu : plus forte puissance P ≤ pMax qui laisse encore possible de rouler ensuite, sans
   * dépasser les records des fenêtres longues (≥ 20 min), pendant les SUSTAIN_H prochaines secondes :
   * à P tant que le W′ le permet, puis à la puissance critique (ou à P si elle est plus basse).
   * Sans cette anticipation, le plafond « glouton » laisse dépenser tout le budget d'une fenêtre
   * longue (un effort sur le W′ au-dessus de la PC, puis la PC elle-même), puis ne laisse plus rien :
   * le coureur s'arrête de pédaler en attendant que les anciennes secondes sortent de la fenêtre.
   * Ici il ralentit progressivement jusqu'à rouler au record de la fenêtre, tant qu'il lui reste du W′.
   */
  function sustainCap(ctx, st, pMax) {
    if (!ctx.smoothRec || !(pMax > 0) || ctx.nWin <= ctx.nWinShort) return pMax;
    const H = st.hist, t = st.t;
    const kc = st.capK > 0 ? st.capK : 1;
    const cpE = ctx.cp * kc, w = st.wbal > 0 ? st.wbal : 0;
    const feasible = (P) => {
      const over = (P - cpE) * (P > cpE ? 1 : 0);
      for (let j = ctx.nWinShort; j < ctx.nWin; j++) {
        const d = ctx.win[j], cap = ctx.capTot[j] * kc;
        const xc = d - t; // fenêtre pas encore pleine : les premières secondes en sortent à cet instant
        for (let g = 0; g <= SUSTAIN_GRID.length; g++) {
          const x = g < SUSTAIN_GRID.length ? SUSTAIN_GRID[g] : xc;
          if (x < 1 || x > SUSTAIN_H || x > d) continue;
          const i0 = t - d + x;
          const E = (P < cpE ? P : cpE) * x + Math.min(over * x, w);
          if (H[t] - H[i0 > 0 ? i0 : 0] + E > cap) return false;
        }
      }
      return true;
    };
    if (feasible(pMax)) return pMax;
    let lo = 0, hi = pMax;
    for (let k = 0; k < 14; k++) {
      const mid = 0.5 * (lo + hi);
      if (feasible(mid)) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** Copie superficielle (l'historique des puissances est partagé). */
  function cloneState(st) { return Object.assign({}, st); }

  /**
   * Conditions avec la météo : lues à la position s et à l'heure (départ + t). Le vent, la densité de l'air
   * (humidité, pression, température à l'altitude de la cellule), la route mouillée (roulement, limite de
   * vitesse en virage et en descente, freinage, risques de chute et de crevaison) et la chaleur en dépendent.
   * Les portions de vent saisies à la main et la température de la page Pacing optimal sont ignorées.
   */
  function weatherConditions(ctx, C, i, s, t, out) {
    const We = PYR.weather;
    const wx = out.wx || (out.wx = {});
    We.at(C.weather, s, C.weather.start + t, wx);
    const e = 0.5 * (C.ele[i] + C.ele[i + 1]);
    const T = wx.T - 0.0065 * (e - wx.ele); // gradient de −6,5 °C/km entre la station et la cellule
    out.rho = PYR.physics.airDensityHumid(e, T, wx.rh, wx.p);
    const mean = wx.ws * We.WIND_K, amp = Math.max(0, wx.gust - wx.ws) * We.WIND_K;
    let W = mean;
    if (ctx.gusts !== null && amp > 0) {
      const gi = t < ctx.gusts.length ? t : ctx.gusts.length - 1;
      W += amp * ctx.gusts[gi];
      if (W < 0) W = 0;
    }
    const rel = (wx.wd * Math.PI) / 180 - C.bearS[i];
    const cr = Math.cos(rel), ss = Math.sin(rel), sr = Math.abs(ss);
    out.W = W; out.wh = W * cr; out.wc = W * sr; out.wcS = W * ss;
    out.whM = mean * cr; out.wcM = mean * sr;
    const fx = We.roadEffects(wx.wet, T, wx.rh, wx.gust);
    out.crr = ctx.setup.crr * C.crrF[i] * fx.crrK;
    out.vlim = C.vLim[i] * fx.vlimK;
    out.crashK = fx.crashK; out.punctK = fx.punctK; out.brakeK = fx.brakeK;
    out.heatK = We.heatFactor(T, wx.rh);
    out.Tapp = We.heatIndex(T, wx.rh);
    out.T = T; out.rh = wx.rh; out.p = wx.p; out.rain = wx.rain; out.wet = wx.wet;
  }

  /** Conditions locales à la position s (m) et au temps t (s entier). */
  function conditions(ctx, s, t, out) {
    const C = ctx.course;
    let i = (s / C.step) | 0;
    if (i < 0) i = 0; else if (i >= C.n) i = C.n - 1;
    out.i = i;
    out.sinT = C.sinT[i]; out.cosT = C.cosT[i]; out.grade = C.grade[i];
    // capacité le long du parcours (1 sans profil) : PC et records de moins de 20 min (capS), W′ (wS)
    out.capS = ctx.capS ? ctx.capS[i] : 1;
    out.wS = ctx.wS ? ctx.wS[i] : out.capS;
    // facteurs météo : neutres sans météo (valeurs inchangées)
    out.crashK = 1; out.punctK = 1; out.heatK = 1; out.brakeK = 1;
    out.T = C.temperature; out.Tapp = C.temperature; out.rh = 50; out.rain = 0; out.wet = 0;
    if (C.weather) weatherConditions(ctx, C, i, s, t, out);
    else {
      out.crr = ctx.setup.crr * C.crrF[i];
      out.rho = C.rho[i];
      let W = C.wMean[i];
      if (ctx.gusts !== null && C.wAmp[i] > 0) {
        const gi = t < ctx.gusts.length ? t : ctx.gusts.length - 1;
        W += C.wAmp[i] * ctx.gusts[gi];
        if (W < 0) W = 0;
      }
      out.W = W;
      out.wh = W * C.cosRel[i];
      out.wc = W * C.sinRel[i];
      out.wcS = W * C.sinRelS[i];
      out.whM = C.wMean[i] * C.cosRel[i]; // composantes du vent moyen (sans rafales)
      out.wcM = C.wMean[i] * C.sinRel[i];
      out.vlim = C.vLim[i];
    }
    out.cdaK = 1;
    out.pathK = 1; // trajectoire (peloton 2D) : mètres de tracé parcourus par mètre de chemin (> 1 à la corde dans un virage)
    out.stopped = false;
    out.vCap = Infinity;
    return out;
  }

  function accel(S, v, P, c) {
    const vd = v > 0.5 ? v : 0.5;
    let Fd = S.eta * P / vd;
    if (Fd > S.fMax) Fd = S.fMax;
    const va = v + c.wh;
    const Fa = 0.5 * c.rho * S.cda * (c.cdaK > 0 ? c.cdaK : 1) * Math.sqrt(va * va + c.wc * c.wc) * va;
    const Fg = S.mass * G * c.sinT;
    const Fr = c.crr * S.mass * G * c.cosT;
    return (Fd - Fa - Fg - Fr) / S.massEff;
  }

  /**
   * Puissance maximale disponible à cet instant (limiteur MMP + W′bal).
   * Renvoie {cap, capM, capW, capLong}.
   */
  function availablePower(ctx, st) {
    const H = st.hist, t = st.t;
    const kc = st.capK > 0 ? st.capK : 1;
    let capM = ctx.capTot[0] * kc, capLong = Infinity;
    for (let j = 1; j < ctx.nWin; j++) {
      const d = ctx.win[j];
      const i0 = t - d + 1;
      const c = ctx.capTot[j] * kc - (H[t] - H[i0 > 0 ? i0 : 0]);
      if (c < capM) capM = c;
      if (d >= LONG_WINDOW && c < capLong) capLong = c;
    }
    if (capM < 0) capM = 0;
    const capW = ctx.cp * kc + (st.wbal > 0 ? st.wbal : 0);
    capM = sustainCap(ctx, st, capM < capW ? capM : capW);
    return { cap: capM < capW ? capM : capW, capM, capW, capLong };
  }

  /**
   * Puissance maximale (W) qui respecte, pour la seconde qui vient, deux limites choisies par le joueur :
   *   - wMinFrac : fraction de W′ à conserver (0 = pas de limite) : au-dessus de la puissance critique, W′ baisse de ce qui dépasse,
   *     donc la plus forte puissance qui laisse W′ à sa limite est PC + (W′ − limite) ; à la limite, il ne reste que la PC ;
   *   - pprMax : part maximale de la courbe de puissance record utilisée (1 = pas de limite, c'est déjà la limite du simulateur) :
   *     sur chaque fenêtre, l'énergie roulée avec cette seconde ne doit pas dépasser pprMax × ce que le record autorise
   *     (même calcul que recordUsage, vu depuis la seconde qui vient).
   * Infinity quand aucune limite n'est demandée.
   */
  function limitCap(ctx, st, wMinFrac, pprMax) {
    const kc = st.capK > 0 ? st.capK : 1;
    let cap = Infinity;
    if (wMinFrac > 0) {
      const wMin = wMinFrac * w0Of(ctx, st), cp = ctx.cp * kc;
      cap = cp + Math.max(0, st.wbal - wMin);
    }
    if (pprMax > 0 && pprMax < 1) {
      const H = st.hist, t = st.t;
      for (let j = 0; j < ctx.nWin; j++) {
        const i0 = t - ctx.win[j] + 1;
        const c = pprMax * ctx.capTot[j] * kc - (H[t] - H[i0 > 0 ? i0 : 0]);
        if (c < cap) cap = c;
      }
    }
    return cap < 0 ? 0 : cap;
  }

  /**
   * Point de la courbe de puissance record qui limite la puissance à cet instant : { d (durée de la fenêtre, s), rec (record de
   * cette durée, W), P (limite de puissance, W), sustain (limite d'anticipation des records longs, vraie si elle est plus
   * basse que toutes les fenêtres) }. Les fenêtres sont celles du limiteur (en mode jeu : record interpolé linéairement,
   * fenêtres intermédiaires comprises).
   */
  function recordBinding(ctx, st) {
    const H = st.hist, t = st.t;
    const kc = st.capK > 0 ? st.capK : 1;
    let best = ctx.capTot[0] * kc, jb = 0, bestL = Infinity, jl = -1;
    for (let j = 1; j < ctx.nWin; j++) {
      const i0 = t - ctx.win[j] + 1;
      const c = ctx.capTot[j] * kc - (H[t] - H[i0 > 0 ? i0 : 0]);
      if (c < best) { best = c; jb = j; }
      if (j >= ctx.nWinShort && c < bestL) { bestL = c; jl = j; }
    }
    const P = availablePower(ctx, st).capM;
    const sustain = jl >= 0 && P < Math.max(0, best) - 0.5; // l'anticipation (sustainCap) a abaissé la limite sous toutes les fenêtres
    const j = sustain ? jl : jb;
    return { d: ctx.win[j], rec: ctx.capTot[j] * kc / ctx.win[j], P, sustain };
  }

  /**
   * Courbe « disponible à partir de maintenant » : pour chaque durée tau (s), la plus forte puissance constante que le cycliste
   * pourrait tenir pendant tau secondes sans dépasser un record de la courbe (en comptant ce qu'il vient de rouler) ni
   * son W′. À l'état frais, c'est la courbe de puissance record ; après un effort, elle s'affaisse, d'abord aux durées courtes
   * (le contre-effort) puis se reconstitue seconde après seconde. La limite d'une seule seconde (availablePower) ne la montre pas.
   */
  function forwardCurve(ctx, st, taus) {
    const H = st.hist, t = st.t;
    const kc = st.capK > 0 ? st.capK : 1;
    const w = st.wbal > 0 ? st.wbal : 0, cpE = ctx.cp * kc;
    let kmax = 1;
    for (const tau of taus) if (tau > kmax) kmax = tau;
    const out = taus.map((tau) => cpE + w / tau);
    const rm = new Float64Array(kmax + 1); // plus petite contrainte d'une fenêtre sur ses k premières secondes
    for (let j = 0; j < ctx.nWin; j++) {
      const d = ctx.win[j], cap = ctx.capTot[j] * kc, K = d < kmax ? d : kmax;
      // à chaque seconde k de l'effort, la fenêtre de d secondes contient k secondes de l'effort et d − k secondes déjà roulées : la
      // contrainte doit tenir à chaque seconde (les secondes anciennes qui sortent de la fenêtre peuvent être plus fortes que P)
      let m = Infinity;
      for (let k = 1; k <= K; k++) {
        const keep = d - k;
        const past = keep > 0 ? H[t] - H[t - keep > 0 ? t - keep : 0] : 0;
        const v = (cap - past) / k;
        if (v < m) m = v;
        rm[k] = m;
      }
      for (let i = 0; i < taus.length; i++) {
        const v = rm[taus[i] < K ? taus[i] : K];
        if (v < out[i]) out[i] = v;
      }
    }
    // jamais plus que ce que le limiteur autorise à la seconde qui vient (anticipation des records longs comprise)
    const now = availablePower(ctx, st).cap;
    return out.map((P) => (P > now ? now : P) > 0 ? (P > now ? now : P) : 0);
  }

  /**
   * Part de la courbe de puissance record utilisée : le plus fort rapport entre l'énergie roulée sur une fenêtre et ce que
   * son record autorise. 1 = une fenêtre est pleine (la limite va se resserrer). Renvoie { use, d (durée de cette fenêtre, s) }.
   */
  function recordUsage(ctx, st) {
    const H = st.hist, t = st.t;
    const kc = st.capK > 0 ? st.capK : 1;
    let use = 0, jb = 0;
    for (let j = 0; j < ctx.nWin; j++) {
      const d = ctx.win[j];
      const u = (H[t] - H[t - d > 0 ? t - d : 0]) / (ctx.capTot[j] * kc);
      if (u > use) { use = u; jb = j; }
    }
    return { use, d: ctx.win[jb] };
  }

  /* ---------- Limite imposée par la courbe de puissance record (cœur commun au jeu et à la page Performance) ---------- */
  const W_TOL = 0.5;   // W : en dessous de PC + 0,5 W on ne consomme pas W′ (même tolérance que `capped` dans step)
  const recWinCache = new WeakMap();

  /**
   * Fenêtres de la courbe record relues, interpolée, à intervalles de 4 % (les durées de la courbe sont peu nombreuses :
   * 1 s … 5 h). cap[j] = d·MMP(d) (J), marge de sécurité comprise.
   */
  function recordWindows(ctx, maxT) {
    let c = recWinCache.get(ctx);
    if (c && c.maxT === maxT) return c;
    const win = [], cap = [];
    // mode jeu : une fenêtre à chaque seconde jusqu'à 10 min (la durée tenable évolue alors seconde par seconde, sans marches d'escalier)
    const fine = ctx.smoothRec ? Math.min(600, maxT) : 0;
    const dMax = Math.min(maxT, ctx.recMax > 0 ? ctx.recMax : Infinity);   // modèle physiologique : pas de limite record au-delà
    for (let d = 2; d <= dMax; d = d < fine ? d + 1 : Math.max(d + 1, Math.round(d * 1.04))) {
      win.push(d); cap.push(d * (ctx.mmpAt || ctx.athlete.mmp)(d) * ctx.marginK);
    }
    c = { maxT, win, cap };
    recWinCache.set(ctx, c);
    return c;
  }

  /** Somme, pour les secondes 30 … t, des puissances moyennes glissantes sur 30 s élevées à la puissance 4 (base de la NP). */
  function npSum4(H, t) {
    let s4 = 0;
    for (let u = 30; u <= t; u++) { const a = (H[u] - H[u - 30]) / 30; s4 += a * a * a * a; }
    return s4;
  }

  /**
   * Durée (s) avant d'être limité par la courbe de puissance record si l'on roule à la puissance p à partir de l'instant
   * t0, en comptant ce qui a déjà été roulé (H : énergie cumulée par seconde). Le premier instant x où l'un de ces
   * critères dépasserait le record :
   *   - la moyenne glissante sur une durée d dépasse le record de d (le limiteur de la simulation et du jeu) ;
   *   - si `total` : la puissance moyenne depuis le départ dépasse le record de la durée écoulée t0 + x (dès 2 min) ;
   *   - si `total` : la puissance normalisée (NP) depuis le départ dépasse le record de t0 + x (dès 20 min) : c'est elle
   *     qui lie une sortie longue, car elle pénalise la variabilité, que la moyenne ne voit pas.
   * Les deux derniers critères sont les règles de l'optimiseur (enduranceUse) pour la durée d'un plan : c'est ce qui borne
   * un plan, pas ce que le jeu impose. Dans le jeu, un sprint au départ fait déjà dépasser la NP depuis le départ, et ce
   * critère serait alors à 0 en permanence alors que rien ne limite le coureur : `total` est donc réservé aux plans.
   * s4 : somme des puissances moyennes sur 30 s à la puissance 4 pour les secondes 30 … t0 (npSum4, utile avec `total`),
   * kc : facteur de fatigue appliqué aux records (1 : frais). Renvoie Infinity au-delà de maxT.
   */
  function recordLimit(ctx, H, t0, p, s4, kc, maxT, total) {
    if (!(p > 0)) return Infinity;
    const rec = recordWindows(ctx, maxT);
    const mm = (T) => (ctx.mmpAt || ctx.athlete.mmp)(T) * ctx.marginK * kc;
    let left = Infinity;
    if (total) {
      // durée totale : l'effort commence à t0 ; moyenne et NP depuis le départ, avec x secondes de plus à p
      const p4 = p * p * p * p, exK = new Float64Array(30);
      for (let k = 1; k < 30; k++) {   // contribution des k premières secondes (la fenêtre de 30 s mêle encore l'historique)
        const u = t0 + k;
        const a = u >= 30 ? (H[t0] - H[Math.max(0, u - 30)] + p * k) / 30 : 0;
        exK[k] = exK[k - 1] + (u >= 30 ? a * a * a * a : 0);
      }
      const over = (x) => {
        const T = t0 + x;
        if (T >= 120 && (H[t0] + p * x) / T > mm(T)) return true;
        if (T >= LONG_WINDOW && T > 30) {
          const extra = x < 30 ? exK[x] : exK[29] + (x - 29) * p4;
          if (Math.pow((s4 + extra) / (T - 29), 0.25) > mm(T)) return true;
        }
        return false;
      };
      let prev = 0;
      for (let x = 1; x <= maxT; x += Math.max(1, Math.floor(x / 60))) {
        if (over(x)) {
          let lo = prev, hi = x;              // affinage : le premier x qui dépasse est entre prev et x
          while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (over(mid)) hi = mid; else lo = mid; }
          left = hi; break;
        }
        prev = x;
      }
    }
    // fenêtres glissantes : l'historique est ce qui précède t0
    for (let j = 0; j < rec.win.length; j++) {
      const d = rec.win[j], cap = rec.cap[j] * kc;
      if (p * d <= cap) continue;   // une fenêtre entière à p reste sous le record
      const dx = d <= 120 || (ctx.smoothRec && d <= 600) ? 1 : Math.ceil(d / 120);
      for (let x = 0; x <= d && x < left; x += dx) {
        const i0 = t0 - (d - x);
        if (H[t0] - H[i0 > 0 ? i0 : 0] + p * x > cap) {
          let xe = x;
          // mode jeu : le pas du balayage peut dépasser une seconde (fenêtres longues) ; on affine à la seconde près
          if (dx > 1 && ctx.smoothRec) {
            for (let y = Math.max(0, x - dx + 1); y < x; y++) {
              const j0 = t0 - (d - y);
              if (H[t0] - H[j0 > 0 ? j0 : 0] + p * y > cap) { xe = y; break; }
            }
          }
          left = xe; break;
        }
      }
    }
    return left > maxT ? Infinity : left;
  }

  /**
   * Durée (s) pendant laquelle la puissance P peut encore être tenue à partir de maintenant : le plus petit du temps
   * avant épuisement de W′ (W′ restant / (P − PC), au-dessus de la PC) et du temps avant d'être limité par la courbe
   * de puissance record (recordLimit : fenêtres glissantes, avec ce qui a déjà été roulé) — ce que la simulation et le
   * jeu imposent réellement, calculé comme la courbe « temps avant épuisement » de la page Performance.
   * opts.total : ajoute les règles de l'optimiseur pour la durée d'un plan (moyenne et NP depuis le départ, cf. recordLimit),
   * que le jeu n'impose pas ; opts.np4 : somme des puissances moyennes sur 30 s à la puissance 4 déjà tenue à jour
   * (avec `total`, sinon recalculée sur l'historique).
   * Renvoie {t, by, wprime, record} : by = 'wprime' | 'record', t = Infinity au-delà de maxT ; wprime et record sont
   * les deux durées, séparément.
   */
  function timeToExhaustion(ctx, st, P, maxT, opts) {
    maxT = maxT || 6 * 3600;
    if (!(P > 0)) return { t: Infinity, by: null, wprime: Infinity, record: Infinity };
    const kc = st.capK > 0 ? st.capK : 1;
    const cpE = ctx.cp * kc;
    // W′ ne se consomme qu'au-dessus de la PC (tolérance de 0,5 W, comme `capped` dans step) : à la PC, W′ vide plafonne la
    // puissance sans la rendre intenable, et W′ / (P − PC) n'aurait pas de sens (0 / ε)
    const wprime = P > cpE + W_TOL ? Math.max(0, st.wbal) / (P - cpE) : Infinity;
    const total = !!(opts && opts.total);
    const s4 = !total ? 0 : opts.np4 !== undefined ? opts.np4 : npSum4(st.hist, st.t);
    const record = recordLimit(ctx, st.hist, st.t, P, s4, kc, maxT, total);
    const best = record < wprime ? record : wprime;
    const by = best > maxT ? null : record < wprime ? 'record' : 'wprime';
    return { t: best > maxT ? Infinity : best, by, wprime: wprime > maxT ? Infinity : wprime, record };
  }

  /**
   * Temps restant (s) à chaque seconde d'un plan si l'on poursuit l'effort à la puissance de cette seconde, d'après
   * la seule courbe de puissance record : ni PC ni W′ (recordLimit). À puissance constante le temps restant décroît
   * d'une seconde par seconde ; avec un effort neuf, c'est la durée où la courbe record passe sous cette puissance.
   * Pour un plan optimal limité par l'endurance, il tombe à zéro à l'arrivée.
   * P : puissances (W) à chaque seconde, n : nombre de secondes.
   * opts : {maxT (s, défaut 6 h : Infinity au-delà), step (s, défaut ≈ n/1500 : une valeur pour `step` secondes,
   *         calculée sur la puissance moyenne de ces secondes)}
   * Renvoie un Float32Array(n).
   */
  function recordTimeLeft(ctx, P, n, opts) {
    opts = opts || {};
    const maxT = opts.maxT || 6 * 3600;
    const step = Math.max(1, Math.round(opts.step || n / 1500));
    const H = new Float64Array(n + 1);
    for (let t = 0; t < n; t++) H[t + 1] = H[t] + P[t];
    // S4[u] = somme des (moyenne glissante de 30 s se terminant à la seconde v)^4, pour v = 30 … u : base de la NP
    const S4 = new Float64Array(n + 1);
    for (let u = 1; u <= n; u++) {
      S4[u] = S4[u - 1];
      if (u >= 30) { const a = (H[u] - H[u - 30]) / 30; S4[u] += a * a * a * a; }
    }
    const out = new Float32Array(n);
    for (let t0 = 0; t0 < n; t0 += step) {
      const t1 = Math.min(n, t0 + step);
      const left = recordLimit(ctx, H, t0, (H[t1] - H[t0]) / (t1 - t0), S4[t0], 1, maxT, true);
      for (let t = t0; t < t1; t++) out[t] = left - (t - t0) > 0 ? left - (t - t0) : 0;
    }
    return out;
  }

  /**
   * Temps restant (s) à chaque seconde d'un plan si l'on poursuit l'effort à la puissance de cette seconde, d'après le
   * seul W′bal : W′ restant / (P − PC) au-dessus de la PC (sans récupération), Infinity en dessous. À puissance
   * constante au-dessus de la PC, il décroît d'une seconde par seconde et s'annule quand W′ est vide.
   * P : puissances (W) à chaque seconde, wbal : W′bal (J) au début de chaque seconde, cp : puissance critique (W).
   * opts.step : comme recordTimeLeft (même découpage en blocs, pour que les deux courbes se comparent).
   * Renvoie un Float32Array(n).
   */
  function wprimeTimeLeft(P, wbal, cp, n, opts) {
    const step = Math.max(1, Math.round((opts && opts.step) || n / 1500));
    const out = new Float32Array(n);
    for (let t0 = 0; t0 < n; t0 += step) {
      const t1 = Math.min(n, t0 + step);
      let s = 0;
      for (let t = t0; t < t1; t++) s += P[t];
      const p = s / (t1 - t0);
      const left = p > cp + W_TOL ? Math.max(0, wbal[t0]) / (p - cp) : Infinity;   // au-dessus de la PC seulement (cf. timeToExhaustion)
      for (let t = t0; t < t1; t++) out[t] = left - (t - t0) > 0 ? left - (t - t0) : 0;
    }
    return out;
  }

  /**
   * Avance d'une seconde avec la consigne Pcmd. `cond` doit correspondre à (st.s, st.t).
   * Renvoie la puissance réellement produite.
   */
  /** W′ plein du moment (J) : celui du contexte × le facteur propre au W′ (modèle physiologique), sinon × le facteur de capacité. */
  function w0Of(ctx, st) {
    const k = st.wK > 0 ? st.wK : st.capK > 0 ? st.capK : 1;
    return ctx.w0 * k;
  }

  function step(ctx, st, Pcmd, cond) {
    const S = ctx.setup, C = ctx.course, H = st.hist;
    const t = st.t;
    // capacité du moment (st.capK, st.wK) et du lieu (profil le long du parcours : cond.capS, cond.wS). Le profil ne réduit pas
    // les fenêtres longues (≥ 20 min) de la courbe record : elles portent toute la sortie passée, et la durabilité qu'elles
    // représentent est justement ce que le profil remplace (sinon une capacité basse à l'arrivée plafonnerait tout ce qui précède).
    const kl = st.capK > 0 ? st.capK : 1;
    const kc = kl * (cond.capS > 0 ? cond.capS : 1);
    const cpE = ctx.cp * kc, w0E = w0Of(ctx, st) * (cond.wS > 0 ? cond.wS : 1);

    // Arrêt (crevaison, chute) : pas de mouvement, W′ se reconstitue
    if (cond.stopped) {
      st.v = 0; st.t = t + 1; st.braking = false; st.capped = false; st.allout = 0;
      st.wbal = w0E - (w0E - st.wbal) * Math.exp(-ctx.recF * cpE / w0E);
      H[t + 1] = H[t];
      st.P = 0;
      return 0;
    }

    // Limiteur MMP (causal) + W′
    let capM = ctx.capTot[0] * kc;
    const nw = ctx.longCap ? ctx.nWin : ctx.nWinShort;
    for (let j = 1; j < nw; j++) {
      const i0 = t - ctx.win[j] + 1;
      const c = ctx.capTot[j] * (j < ctx.nWinShort ? kc : kl) - (H[t] - H[i0 > 0 ? i0 : 0]);
      if (c < capM) capM = c;
    }
    if (capM < 0) capM = 0;
    const capW = cpE + (st.wbal > 0 ? st.wbal : 0);
    st.capM = capM; st.capW = capW;

    const v = st.v;
    // trajectoire hors de l'axe (peloton 2D) : à la corde dans un virage, le chemin est plus court que le tracé (pk > 1 : on avance
    // plus vite sur le tracé à vitesse égale) ; au large, plus long (pk < 1)
    const pk = cond.pathK > 0 ? cond.pathK : 1;
    let P = Pcmd > 0 ? Pcmd : 0;
    // Pas de pédalage efficace au-delà du développement max, ni en phase de freinage
    if (v > S.vSpin) { const f = 1 - (v - S.vSpin) / 3; P *= f > 0 ? f : 0; }
    if (v > cond.vlim + 0.1) P = 0;

    // Effort maximal prolongé : on suit l'enveloppe lissée plutôt que le plafond « glouton »
    // (évite les oscillations 1150 → 650 → 1150 W d'un sprint).
    if (st.allout > 0) {
      const e = ctx.env[st.allout + 1 < ctx.nEnv ? st.allout + 1 : ctx.nEnv] * kc;
      if (e < capM) capM = e;
    }
    st.allout = P >= capM ? st.allout + 1 : 0;
    let cap = capM < capW ? capM : capW;
    if (P > 0 && ctx.smoothRec && ctx.longCap) {
      const cs = sustainCap(ctx, st, P < cap ? P : cap);
      if (cs < cap) { cap = cs; capM = cs; st.capM = cs; }
    }
    // puissance mesurée (home-trainer, capteur) : le corps du cycliste est sa propre limite, le simulateur ne la plafonne pas
    if (cond.raw) cap = Infinity;
    st.capped = P > cap + 0.5;
    if (P > cap) P = cap;

    if (ctx.subSteps > 1) {
      // Même seconde, intégrée en sous-pas : la pente, le vent et la limite de vitesse sont relus à chaque sous-pas,
      // si bien qu'un décalage de quelques millimètres ne fait plus basculer toute une seconde sur la cellule voisine.
      const n = ctx.subSteps, h = 1 / n, sc = subCond;
      let vS = v, sS = st.s, brk = false, prog = false;
      for (let q = 0; q < n; q++) {
        const cc = q === 0 ? cond : conditions(ctx, sS, t, sc);
        const b1 = accel(S, vS, P, cc);
        let w1 = vS + h * b1; if (w1 < 0) w1 = 0;
        const b2 = accel(S, w1, P, cc);
        let w = vS + 0.5 * h * (b1 + b2); if (w < 0) w = 0;
        let j = ((sS + pk * 0.5 * (vS + w) * h) / C.step) | 0;
        if (j >= C.n) j = C.n - 1; else if (j < 0) j = 0;
        const lim = cc.vCap < C.vLim[j] ? cc.vCap : C.vLim[j];
        if (w > lim) {
          const wb = vS - ctx.aBrake * (cc.brakeK > 0 ? cc.brakeK : 1) * h;
          w = lim > wb ? lim : wb;
          if (w < 0) w = 0;
          brk = true;
        }
        if (w < ctx.vMinProgress && P > 20) { w = ctx.vMinProgress; prog = true; }
        const d = pk * 0.5 * (vS + w) * h;
        if (sS + d >= C.length) {
          st.tFinish = t + (q + (d > 0 ? (C.length - sS) / d : 1)) * h;
          st.finished = true;
          sS += d; vS = w;
          break;
        }
        sS += d; vS = w;
      }
      st.braking = brk;
      if (prog) st.stalled++;
      st.s = sS; st.v = vS; st.t = t + 1;
    } else {
    // Intégration (Heun, pas de 1 s)
    const a1 = accel(S, v, P, cond);
    let v1 = v + a1; if (v1 < 0) v1 = 0;
    const a2 = accel(S, v1, P, cond);
    let vn = v + 0.5 * (a1 + a2);
    if (vn < 0) vn = 0;

    // Freinage (virage / vitesse max)
    let iN = ((st.s + pk * 0.5 * (v + vn)) / C.step) | 0;
    if (iN >= C.n) iN = C.n - 1; else if (iN < 0) iN = 0;
    const vl = cond.vCap < C.vLim[iN] ? cond.vCap : C.vLim[iN];
    if (vn > vl) {
      const vb = v - ctx.aBrake * (cond.brakeK > 0 ? cond.brakeK : 1); // freinage moins franc sur route mouillée
      vn = vl > vb ? vl : vb;
      if (vn < 0) vn = 0;
      st.braking = true;
    } else st.braking = false;

    // Progression minimale (on pousse le vélo) quand on pédale mais que la pente est trop forte
    if (vn < ctx.vMinProgress && P > 20) { vn = ctx.vMinProgress; st.stalled++; }

    const ds = pk * 0.5 * (v + vn);
    if (st.s + ds >= C.length) {
      const frac = ds > 0 ? (C.length - st.s) / ds : 1;
      st.tFinish = t + frac;
      st.finished = true;
    }
    st.s += ds; st.v = vn; st.t = t + 1;
    }

    // W′bal (modèle différentiel de Skiba)
    if (P >= cpE) st.wbal -= (P - cpE);
    else st.wbal = w0E - (w0E - st.wbal) * Math.exp(-ctx.recF * (cpE - P) / w0E);

    H[t + 1] = H[t] + P;
    st.work += P;
    st.P = P;
    return P;
  }

  /**
   * Cycliste sur la vraie route : sa position est mesurée (GPS projeté sur le tracé), pas simulée. Avance l'état d'une seconde
   * jusqu'à d.s (jamais en arrière, au plus la longueur du parcours), à la vitesse d.v (sinon la distance parcourue), avec la
   * puissance d.P mesurée (sinon 0) : W′bal (Skiba), énergie cumulée et arrivée (instant interpolé dans la seconde) comme step.
   * Sans position (d.s absent : pas encore de GPS), le cycliste reste sur place. Renvoie la puissance.
   */
  function drive(ctx, st, d, cond) {
    const C = ctx.course, H = st.hist, t = st.t;
    const kc = (st.capK > 0 ? st.capK : 1) * (cond && cond.capS > 0 ? cond.capS : 1);
    const cpE = ctx.cp * kc, w0E = w0Of(ctx, st) * (cond && cond.wS > 0 ? cond.wS : 1);
    const s0 = st.s;
    const target = d && Number.isFinite(d.s) ? d.s : s0;
    const s1 = Math.min(C.length, Math.max(s0, target));
    const P = d && Number.isFinite(d.P) && d.P > 0 ? Math.min(d.P, 3000) : 0;
    if (s1 >= C.length && !st.finished) {
      st.finished = true;
      st.tFinish = t + (s1 > s0 ? (C.length - s0) / (s1 - s0) : 1);
    }
    st.v = d && Number.isFinite(d.v) && d.v >= 0 ? Math.min(d.v, 40) : s1 - s0;
    st.s = s1; st.t = t + 1; st.braking = false; st.capped = false; st.allout = 0;
    if (P >= cpE) st.wbal -= (P - cpE);
    else st.wbal = w0E - (w0E - st.wbal) * Math.exp(-ctx.recF * (cpE - P) / w0E);
    H[t + 1] = H[t] + P;
    st.work += P;
    st.P = P;
    return P;
  }

  /**
   * Taux d'utilisation de la courbe record : moyenne glissante sur les fenêtres longues (≥ 20 min),
   * moyenne et puissance normalisée sur la durée totale T (record interpolé).
   * 1 = à la limite, > 1 = infaisable.
   */
  function enduranceUse(ctx, H, tFinish) {
    const n = Math.floor(tFinish);
    let u = 0;
    for (let j = ctx.nWinShort; j < ctx.nWin; j++) {
      const d = ctx.win[j];
      if (d > n) break;
      let best = 0;
      // replanification en cours de sortie : les fenêtres déjà terminées à l'instant de départ ne se rattrapent plus
      for (let t = Math.max(d, (ctx.fromT || 0) + 1); t <= n; t++) { const w = H[t] - H[t - d]; if (w > best) best = w; }
      const r = best / ctx.capTot[j];
      if (r > u) u = r;
    }
    if (tFinish >= 120 && n >= 1) {
      const mm = ctx.athlete.mmp(tFinish) * ctx.marginK * (tFinish >= LONG_WINDOW && ctx.endK > 0 ? ctx.endK : 1);
      let r = (H[n] / n) / mm;
      // au-delà de 20 min : la puissance normalisée (NP) ne doit pas dépasser le record de la durée
      if (tFinish >= LONG_WINDOW && n > 30) {
        let s4 = 0, cnt = 0;
        for (let t = 30; t <= n; t++) { const a = (H[t] - H[t - 30]) / 30; s4 += a * a * a * a; cnt++; }
        const np = Math.pow(s4 / cnt, 0.25);
        if (np / mm > r) r = np / mm;
      }
      if (r > u) u = r;
    }
    return u;
  }

  PYR.sim = { LONG_WINDOW, SUSTAIN_H, enduranceUse, makeGusts, createContext, initState, cloneState, conditions, accel, availablePower, limitCap, recordBinding, forwardCurve, recordUsage, timeToExhaustion, recordTimeLeft, wprimeTimeLeft, w0Of, step, drive };
})(globalThis.PYR = globalThis.PYR || {});
