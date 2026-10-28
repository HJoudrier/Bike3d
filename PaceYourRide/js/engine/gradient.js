/* author : Hugo Joudrier-Faure */
/* PaceYourRide — stratégie d'allure par descente de gradient (second algorithme, au choix de l'utilisateur).
 *
 * Là où optimizer.js résout les équations d'optimalité (principe de Pontryagin), on part ici d'une stratégie
 * faisable et on la corrige par petites touches, directement sur le simulateur seconde par seconde :
 *
 *   1. Départ : la puissance constante maximale (mode « gradient »), ou la stratégie analytique (mode « hybride »).
 *   2. La consigne est une fonction de la DISTANCE : des nœuds espacés de l'équivalent de `dt` secondes, reliés
 *      linéairement. Chaque tronçon reste attaché à son bout de route même si l'on arrive plus tôt ou plus tard.
 *   3. Gradient « physique » : pour chaque nœud on retire 5 W (DELTA) sur son tronçon (ou on en ajoute s'il n'y a rien à
 *      retirer), on resimule jusqu'à ce que la vitesse revienne sur celle du plan de base, et on mesure le temps perdu
 *      (ou gagné) par joule. C'est le coût d'un watt à cet endroit.
 *   4. Contraintes : W′bal ≥ 0 et la courbe record relient toutes les secondes entre elles (un watt dépensé ici réduit
 *      ce qu'il reste plus loin). Un passage arrière (état adjoint) reporte sur chaque seconde la valeur des contraintes
 *      saturées qui en dépendent. Les contraintes qui bloquent le pas sont ajoutées à un ensemble actif, chacune avec
 *      son gradient, et la direction est projetée dessus (multiplicateurs par moindres carrés, ν ≥ 0) : on retrouve
 *      l'égalité « gain de temps par joule dépensé » entre tous les tronçons, sans jamais sortir du domaine faisable.
 *   5. Le pas suit la courbure estimée (≈ temps du tronçon / P²), borné par la faisabilité linéarisée, puis une
 *      recherche linéaire sur le simulateur réel : un pas n'est gardé que s'il fait gagner du temps et reste faisable.
 *   6. Raffinement : on recommence avec des nœuds deux fois plus serrés (32 s → 16 → 8 → 4 → 2 → 1 s).
 *
 * L'optimisation se fait sans rafales (comme l'algorithme analytique, on ne « chasse » pas le vent instantané) ;
 * le plan final est ensuite rejoué avec elles par l'appelant. */
(function (PYR) {
  'use strict';

  const DT_LADDER = [32, 16, 8, 4, 2, 1];   // s — espacement des nœuds, de grossier à fin
  const LADDERS = [                         // échelles essayées par solvePortfolio (la première est DT_LADDER)
    DT_LADDER,
    [48, 32, 21, 14, 9, 6, 4, 3, 2, 1],
    [81, 27, 9, 3, 1],
    [16, 8, 4, 2, 1],
    [512, 256, 128, 64, 32, 16, 8, 4, 2, 1],
  ];
  const ITERS = [50000, 4000, 3000, 2000, 1000, 1000];    // itérations maximales par niveau
  const DELTA = 5;          // W — retrait (ou ajout) d'essai pour mesurer le gradient
  const TOL_REL = 5e-4;      // tolérance relative pour dire qu'une contrainte est « saturée »
  const U_LIM = 1.0005;      // taux d'utilisation de la courbe record toléré (cf. enduranceUse)
  const U_TARGET = 1.0;      // taux visé quand on remet un candidat à l'échelle
  const U_ACTIVE = 0.996;    // au-delà : la contrainte d'endurance est considérée comme active
  const MAX_TAIL = 300;      // s — durée maximale d'une resimulation après le tronçon perturbé
  const TOL_V = 3e-4;        // m/s — écart de vitesse à partir duquel la trajectoire est « revenue » sur la base
  const TR_MAX = 100;         // W — pas maximal par nœud avant recherche linéaire
  const P_FLOOR = 50;        // W — plancher de la puissance servant à normaliser le pas
  const MAX_ACTIVE = 16;      // contraintes ajoutées à l'ensemble actif par itération au maximum
  // classes de seconde (état des contraintes)
  const C_FREE = 0, C_BLOCK = 1, C_CLIP_W = 2, C_CLIP_M = 3, C_TIGHT_W = 4, C_TIGHT_M = 5;

  /* ---------- Consigne : nœuds régulièrement espacés en distance ---------- */
  function makeSchedule(L, ds, fn) {
    const K = Math.ceil(L / ds);
    const P = new Float64Array(K + 1);
    for (let k = 0; k <= K; k++) P[k] = fn(k * ds);
    return { ds, K, P };
  }

  function sample(sch, s) {
    const x = s / sch.ds;
    if (x <= 0) return sch.P[0];
    const k = Math.floor(x);
    if (k >= sch.K) return sch.P[sch.K];
    return sch.P[k] + (sch.P[k + 1] - sch.P[k]) * (x - k);
  }

  function resample(sch, L, ds) { return makeSchedule(L, ds, (s) => sample(sch, s)); }

  /** Consigne utilisable par optimizer.replay (même règle de freinage que la simulation interne). */
  function scheduleCommand(sch) {
    return {
      power(st, cond) { return st.v > cond.vlim - 0.3 ? 0 : sample(sch, st.s); },
      after() {},
      branch() { return 0; },
    };
  }

  /** Nœuds à partir d'une série seconde par seconde (positions s[t], puissances P[t]) : moyenne pondérée par la fonction chapeau. */
  function scheduleFromSeries(L, ds, s, P, n) {
    const K = Math.ceil(L / ds);
    const num = new Float64Array(K + 1), den = new Float64Array(K + 1);
    for (let t = 0; t < n; t++) {
      const x = s[t] / ds;
      let k = Math.floor(x);
      if (k >= K) { num[K] += P[t]; den[K] += 1; continue; }
      if (k < 0) k = 0;
      const f = x - k;
      num[k] += (1 - f) * P[t]; den[k] += 1 - f;
      num[k + 1] += f * P[t]; den[k + 1] += f;
    }
    const out = new Float64Array(K + 1);
    let last = -1;
    for (let k = 0; k <= K; k++) {
      if (den[k] > 1e-6) {
        out[k] = num[k] / den[k];
        // trous (nœuds sans seconde échantillonnée) : interpolation avec le nœud précédent
        for (let j = last + 1; j < k; j++) out[j] = last >= 0 ? out[last] + (out[k] - out[last]) * (j - last) / (k - last) : out[k];
        last = k;
      }
    }
    for (let j = last + 1; j <= K; j++) out[j] = last >= 0 ? out[last] : 0;
    return { ds, K, P: out };
  }

  /* ---------- Simulation d'une consigne, avec enregistrement seconde par seconde ---------- */
  function makeRec(N) {
    return {
      n: 0, T: Infinity, finished: false,
      s: new Float64Array(N + 1), v: new Float64Array(N + 1), wb: new Float64Array(N + 1),
      cmd: new Float64Array(N + 1), R: new Float64Array(N + 1), capW: new Float64Array(N + 1), capM: new Float64Array(N + 1),
      brk: new Uint8Array(N + 1), H: new Float64Array(N + 2),
      kc: new Float64Array(N + 1), kw: new Float64Array(N + 1),   // capacité du lieu à chaque seconde (PC et records courts, W′)
    };
  }

  function simulate(ctx, sch, v0, rec) {
    const st = PYR.sim.initState(ctx, v0, rec.H);
    const cond = {};
    while (!st.finished && st.t < ctx.maxSteps) {
      const t = st.t;
      PYR.sim.conditions(ctx, st.s, t, cond);
      const raw = sample(sch, st.s);
      const brake = st.v > cond.vlim - 0.3;
      rec.s[t] = st.s; rec.v[t] = st.v; rec.wb[t] = st.wbal; rec.cmd[t] = raw; rec.brk[t] = brake ? 1 : 0;
      rec.kc[t] = cond.capS; rec.kw[t] = cond.wS;
      rec.R[t] = PYR.sim.step(ctx, st, brake ? 0 : raw, cond);
      rec.capW[t] = st.capW; rec.capM[t] = st.capM;
    }
    rec.n = st.t; rec.s[st.t] = st.s; rec.v[st.t] = st.v; rec.wb[st.t] = st.wbal;
    rec.finished = st.finished;
    rec.T = st.finished ? st.tFinish : Infinity;
    return rec;
  }

  /* ---------- Endurance : NP (ou puissance moyenne) / record de la durée ---------- */
  /** Taux d'utilisation u (hors fenêtres glissantes, déjà imposées par le limiteur) et son gradient par seconde. */
  function enduranceTerm(ctx, rec, grad) {
    const T = rec.T, n = Math.floor(T);
    if (!(T >= 120) || n < 1) return { u: 0, active: false };
    const mm = ctx.athlete.mmp(T) * ctx.marginK * (T >= PYR.sim.LONG_WINDOW && ctx.endK > 0 ? ctx.endK : 1), H = rec.H;
    let u = (H[n] / n) / mm, np = false, s4 = 0, cnt = 0;
    if (T >= PYR.sim.LONG_WINDOW && n > 30) {
      for (let t = 30; t <= n; t++) { const a = (H[t] - H[t - 30]) / 30; s4 += a * a * a * a; cnt++; }
      const r = Math.pow(s4 / cnt, 0.25) / mm;
      if (r > u) { u = r; np = true; }
    }
    const active = u >= U_ACTIVE;
    if (grad) {
      if (!np) {
        const c = 1 / (n * mm);
        for (let t = 0; t < n; t++) grad[t] = c;
      } else {
        // ∂NP/∂R_τ = (s4/cnt)^(-3/4) / (30·cnt) · Σ_{t=τ+1..τ+30} ma_t³
        const cum = new Float64Array(n + 2);
        for (let t = 0; t <= n; t++) {
          let m3 = 0;
          if (t >= 30) { const a = (H[t] - H[t - 30]) / 30; m3 = a * a * a; }
          cum[t + 1] = cum[t] + m3;
        }
        const c = Math.pow(s4 / cnt, -0.75) / (30 * cnt) / mm;
        for (let t = 0; t < n; t++) {
          const hi = Math.min(n, t + 30) + 1, lo = t + 1;
          grad[t] = lo < hi ? c * (cum[hi] - cum[lo]) : 0;
        }
      }
    }
    return { u, active, np };
  }

  /* ---------- Espace de travail ---------- */
  function makeWorkspace(N) {
    return {
      kk: new Int32Array(N + 1), ff: new Float64Array(N + 1),
      Rin: new Float64Array(N + 1), tauT: new Float64Array(N + 1),
      cls: new Int8Array(N + 1), win: new Int16Array(N + 1), eff: new Int8Array(N + 1),
      a: new Float64Array(N + 1), aC: new Float64Array(N + 1), eE: new Float64Array(N + 1), srcC: new Float64Array(N + 1),
      zero: new Float64Array(N + 1), rem: new Float64Array(N + 2),
      dR: new Float64Array(N + 1), pre: new Float64Array(N + 2),
      scratchH: new Float64Array(N + 2), start: null, K: 0, tw: null,
    };
  }

  /** Plafond (J) de la fenêtre j à une seconde de capacité kc (profil du parcours : records de moins de 20 min seulement, cf. sim.step). */
  const capOf = (ctx, j, kc) => ctx.capTot[j] * (j < ctx.nWinShort ? kc : 1);

  /** Fenêtre la plus contraignante à la seconde t (0 : plafond de 1 s, sans mémoire), capacité du lieu kc. */
  function bindingWindow(ctx, H, t, kc) {
    let best = ctx.capTot[0] * kc, jb = 0;
    for (let j = 1; j < ctx.nWin; j++) {
      const i0 = t - ctx.win[j] + 1;
      const c = capOf(ctx, j, kc) - (H[t] - H[i0 > 0 ? i0 : 0]);
      if (c < best) { best = c; jb = j; }
    }
    return jb;
  }

  /* ---------- Gradient physique : temps perdu par joule retiré à un nœud ---------- */
  function nodeSensitivity(rctx, rec, ws, j, K, cond) {
    const { kk, ff, start, Rin } = ws;
    const ta = start[j > 0 ? j - 1 : 0], tb = start[j + 1 <= K + 1 ? j + 1 : K + 1] - 1;
    if (tb < ta) return 0;
    const n = rec.n, sB = rec.s;
    // sens de l'essai : on retire DELTA watts, sauf s'il n'y a (presque) rien à retirer
    let sh = 0, sp = 0;
    for (let t = ta; t <= tb; t++) { const h = kk[t] === j ? 1 - ff[t] : ff[t]; sh += h; sp += h * rec.R[t]; }
    if (sh < 1e-6) return 0;
    const dir = sp / sh > 1.5 * DELTA ? -1 : 1;

    const st = PYR.sim.initState(rctx, 0, ws.scratchH);
    st.t = ta; st.s = sB[ta]; st.v = rec.v[ta];
    let q = ta, dE = 0, dvPrev = 0, dvCur = 0, vb = st.v;
    for (;;) {
      const t = st.t;
      if (t >= rctx.maxSteps) return 0;
      PYR.sim.conditions(rctx, st.s, t, cond);
      let Pin;
      if (t <= tb) {
        const h = kk[t] === j ? 1 - ff[t] : ff[t];
        Pin = Rin[t] + dir * DELTA * h;
        if (Pin < 0) Pin = 0;
      } else {
        // après le tronçon : même consigne que le plan de base, à la même position
        while (q + 1 < n && sB[q + 1] <= st.s) q++;
        if (q + 1 < n) {
          const d = sB[q + 1] - sB[q];
          const f = d > 1e-9 ? (st.s - sB[q]) / d : 0;
          Pin = Rin[q] + (Rin[q + 1] - Rin[q]) * (f < 1 ? f : 1);
        } else Pin = Rin[q];
      }
      st.wbal = 1e9;
      const P = PYR.sim.step(rctx, st, Pin, cond);
      if (t <= tb) dE += P - rec.R[t];
      if (st.finished) {
        if (Math.abs(dE) < 0.5) return 0;
        return (st.tFinish - rec.T) / dE;
      }
      if (t >= tb) {
        const p = st.s;
        while (q + 1 < n && sB[q + 1] <= p) q++;
        if (q + 1 >= n) continue; // au-delà de l'arrivée du plan de base : on va jusqu'à la ligne
        const d = sB[q + 1] - sB[q];
        const f = d > 1e-9 ? (p - sB[q]) / d : 0;
        vb = rec.v[q] + (rec.v[q + 1] - rec.v[q]) * f;
        dvPrev = dvCur; dvCur = st.v - vb;
        if ((t - tb >= 2 && Math.abs(dvCur) < TOL_V) || t - tb > MAX_TAIL) {
          if (Math.abs(dE) < 0.5) return 0;
          let dT = st.t - (q + f);
          // vitesse encore en excès : elle s'éteint de façon géométrique, on ajoute le temps qu'elle fera encore gagner
          let r = dvPrev !== 0 ? dvCur / dvPrev : 0;
          if (r > 0.98) r = 0.98;
          if (r > 0 && vb > 0.5) dT -= dvCur * r / ((1 - r) * vb);
          const tau = dT / dE;
          return isFinite(tau) ? tau : 0;
        }
      }
    }
  }

  /* ---------- Passage arrière (état adjoint) ---------- */
  /**
   * Pour chaque seconde t ≤ tStart : a_t = dF/dR_t, où F est la quantité portée par `src` (dérivée directe par
   * seconde) et par V0 (valeur d'un joule de W′ à l'instant tStart + 1), en tenant compte des contraintes saturées :
   * une seconde écrêtée par une fenêtre ou par W′ suit un plafond qui dépend des secondes précédentes.
   * decide=true : classe aussi chaque seconde (libre / bloquée / saturée) dans ws.eff.
   */
  function adjoint(ctx, rec, ws, src, a, decide, tStart, V0) {
    const { rem, cls, win, eff } = ws;
    rem.fill(0, 0, tStart + 2);
    let V = V0, run = 0;   // V : valeur d'un joule de W′ ; run : somme des événements « fenêtre » qui couvrent la seconde
    for (let t = tStart; t >= 0; t--) {
      run -= rem[t];
      const R = rec.R[t];
      const cp = ctx.cp * rec.kc[t], w0 = ctx.w0 * rec.kw[t], kr = ctx.recF / w0;   // PC et W′ de la seconde
      let E, dW;
      if (R >= cp) { E = 1; dW = -1; } else { const e = Math.exp(-kr * (cp - R)); E = e; dW = -(w0 - rec.wb[t]) * kr * e; }
      const at = src[t] - run + V * dW;
      a[t] = at;
      if (decide) {
        const c = cls[t];
        eff[t] = c === C_FREE ? 0 : c === C_BLOCK ? 1 : c === C_CLIP_W ? 2 : c === C_CLIP_M ? 3
          : c === C_TIGHT_W ? (at < 0 ? 2 : 0) : (at < 0 ? 3 : 0);
      }
      const ef = eff[t];
      if (ef === 3) {
        const lo0 = t - ctx.win[win[t]] + 1, lo = lo0 > 0 ? lo0 : 0;
        if (t - 1 >= lo) { run += at; if (lo > 0) rem[lo - 1] += at; }
      }
      V = (ef === 2 ? at : 0) + V * E;
    }
  }

  /** Cumule les valeurs par seconde sur les nœuds (secondes libres seulement). */
  function toKnots(ws, rec, a, out) {
    const n = rec.n, K = ws.K, { kk, ff, eff } = ws;
    out.fill(0);
    for (let t = 0; t < n; t++) {
      if (eff[t] !== 0) continue;
      const k = kk[t], f = ff[t];
      out[k] += (1 - f) * a[t]; if (k < K) out[k + 1] += f * a[t];
    }
    return out;
  }

  /* ---------- Gradient réduit ---------- */
  /** Prépare les positions des secondes parmi les nœuds, et la sensibilité physique (la partie coûteuse). */
  async function prepare(ctx, rctx, rec, sch, ws, ticker) {
    const n = rec.n, K = sch.K, ds = sch.ds, spin = ctx.setup.vSpin;
    const { kk, ff, Rin, tauT } = ws;
    const start = new Int32Array(K + 3);
    const tw = new Float64Array(K + 1);
    for (let t = 0; t < n; t++) {
      const x = rec.s[t] / ds;
      let k = Math.floor(x), f;
      if (k >= K) { k = K; f = 0; } else { if (k < 0) k = 0; f = x - k; }
      kk[t] = k; ff[t] = f;
      tw[k] += 1 - f; if (k < K) tw[k + 1] += f;
      start[k + 1]++;
      const fs = rec.v[t] > spin ? Math.max(0, 1 - (rec.v[t] - spin) / 3) : 1;
      Rin[t] = fs > 1e-6 ? rec.R[t] / fs : 0;
    }
    for (let k = 0; k <= K + 1; k++) start[k + 1] += start[k];
    ws.start = start; ws.K = K; ws.tw = tw;

    const tauK = new Float64Array(K + 1), cond = {};
    for (let j = 0; j <= K; j++) {
      tauK[j] = tw[j] > 0.05 ? nodeSensitivity(rctx, rec, ws, j, K, cond) : 0;
      if (ticker && (j & 255) === 255) await ticker.tick();   // laisse respirer l'interface sur les longues sorties
    }
    for (let t = 0; t < n; t++) {
      const k = kk[t], f = ff[t];
      tauT[t] = k < K ? tauK[k] * (1 - f) + tauK[k + 1] * f : tauK[K];
    }
  }

  /** Classe chaque seconde selon l'état des contraintes, puis passage arrière sur le temps d'arrivée. */
  function reduce(ctx, rec, ws) {
    const n = rec.n, K = ws.K, { cls, win, eff, a, eE } = ws;
    const tolW = TOL_REL * ctx.w0 + 5, H = rec.H;
    for (let t = 0; t < n; t++) {
      if (rec.brk[t]) { cls[t] = C_BLOCK; continue; }
      const R = rec.R[t], raw = rec.cmd[t], capW = rec.capW[t], capM = rec.capM[t];
      if (R < raw - 0.5) {
        if (Math.abs(R - capW) <= 0.6 && capW <= capM + 0.6) cls[t] = C_CLIP_W;
        else if (Math.abs(R - capM) <= 0.6) {
          const jb = bindingWindow(ctx, H, t, rec.kc[t]);
          if (jb > 0) { cls[t] = C_CLIP_M; win[t] = jb; } else cls[t] = C_BLOCK;
        } else cls[t] = C_BLOCK;
      } else {
        const sW = capW - R, sM = capM - R;
        cls[t] = C_FREE;
        if (sW <= tolW && sW <= sM + 1e-9) cls[t] = C_TIGHT_W;
        else {
          const jb = bindingWindow(ctx, H, t, rec.kc[t]);
          if (jb > 0 && sM <= TOL_REL * capOf(ctx, jb, rec.kc[t]) + 2) { cls[t] = C_TIGHT_M; win[t] = jb; }
        }
      }
    }
    adjoint(ctx, rec, ws, ws.tauT, a, true, n - 1, 0);
    const g = toKnots(ws, rec, a, new Float64Array(K + 1));
    const E = enduranceTerm(ctx, rec, eE);
    let gE = null;
    if (E.u > 0) { adjoint(ctx, rec, ws, eE, ws.aC, false, n - 1, 0); gE = toKnots(ws, rec, ws.aC, new Float64Array(K + 1)); }
    const counts = [0, 0, 0, 0];
    for (let t = 0; t < n; t++) counts[eff[t]]++;
    return { g, gE, u: E.u, uActive: E.active, counts };
  }

  /** Gradient (vers la violation) d'une contrainte de l'ensemble actif, par un passage arrière dédié. */
  function constraintGradient(ctx, rec, ws, kind, t, j) {
    const K = ws.K, a = ws.aC, out = new Float64Array(K + 1);
    if (kind === 'W') {
      // W′ au début de la seconde t+1 ≥ 0 : la violation croît quand on en consomme plus
      adjoint(ctx, rec, ws, ws.zero, a, false, t, 1);
      for (let u = 0; u <= t; u++) a[u] = -a[u];
    } else {
      // fenêtre j se terminant à la seconde t : somme de la puissance ≤ plafond
      const src = ws.srcC, lo = Math.max(0, t - ctx.win[j] + 1);
      src.fill(0, 0, t + 1);
      for (let u = lo; u <= t; u++) src[u] = 1;
      adjoint(ctx, rec, ws, src, a, false, t, 0);
    }
    return toKnots(ws, { n: t + 1 }, a, out);
  }

  /**
   * Plus grand pas α qui, au premier ordre, n'écrête rien de nouveau : W′bal reste ≥ 0 et chaque fenêtre de la
   * courbe record reste sous son plafond. Les secondes déjà saturées sont gérées par le passage arrière et ne
   * limitent pas le pas ; `exclude` liste les contraintes tenues par l'ensemble actif.
   * Renvoie {alpha, limit} (limit : contrainte qui borne le pas, ou null).
   */
  function maxFeasibleStep(ctx, rec, ws, d, exclude) {
    const n = rec.n, K = ws.K;
    const { kk, ff, eff, dR, pre } = ws;
    for (let t = 0; t < n; t++) {
      if (eff[t] !== 0) { dR[t] = 0; continue; }
      const k = kk[t], f = ff[t];
      dR[t] = k < K ? d[k] * (1 - f) + d[k + 1] * f : d[K];
    }
    let amax = Infinity, limit = null;
    // W′bal : propagation avant de la variation
    let dw = 0;
    for (let t = 0; t < n; t++) {
      const R = rec.R[t];
      const cp = ctx.cp * rec.kc[t], w0 = ctx.w0 * rec.kw[t], kr = ctx.recF / w0;   // PC et W′ de la seconde
      let E, dW;
      if (R >= cp) { E = 1; dW = -1; } else { const e = Math.exp(-kr * (cp - R)); E = e; dW = -(w0 - rec.wb[t]) * kr * e; }
      if (eff[t] === 2) { dw = 0; continue; }       // W′ saturé : il retombe à zéro quoi qu'il arrive
      dw = E * dw + dW * dR[t];
      if (dw < -1e-9 && !exclude.has('W' + t)) {
        const slack = rec.wb[t + 1] > 0 ? rec.wb[t + 1] : 0, a = slack / -dw;
        if (a < amax) { amax = a; limit = { kind: 'W', t, j: 0, slack, delta: -dw }; }
      }
    }
    // fenêtres de la courbe record
    const H = rec.H;
    pre[0] = 0;
    for (let t = 0; t < n; t++) pre[t + 1] = pre[t] + dR[t];
    for (let j = 1; j < ctx.nWin; j++) {
      const w = ctx.win[j];
      for (let t = 0; t < n; t++) {
        if (eff[t] === 3) continue;
        const i0 = t + 1 - w > 0 ? t + 1 - w : 0;
        const dsum = pre[t + 1] - pre[i0];
        if (dsum > 1e-9 && !exclude.has('M' + t + ':' + j)) {
          const slack = capOf(ctx, j, rec.kc[t]) - (H[t + 1] - H[i0]), a = slack / dsum;
          if (a < amax) { amax = a; limit = { kind: 'M', t, j, slack, delta: dsum }; }
        }
      }
    }
    return { alpha: amax > 0 ? amax : 0, limit };
  }

  /** Multiplicateurs ν ≥ 0 de l'ensemble actif (moindres carrés dans la métrique w, avec rejet des négatifs). */
  function solveMultipliers(set, g, w) {
    const m = set.length, nu = new Float64Array(m);
    if (m === 0) return nu;
    const K1 = g.length;
    const G = [], r = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      G.push(new Float64Array(m));
      let x = 0; const ci = set[i].vec;
      for (let j = 0; j < K1; j++) x += w[j] * ci[j] * g[j];
      r[i] = -x;
    }
    for (let i = 0; i < m; i++) for (let k = i; k < m; k++) {
      let x = 0; const ci = set[i].vec, ck = set[k].vec;
      for (let j = 0; j < K1; j++) x += w[j] * ci[j] * ck[j];
      G[i][k] = G[k][i] = x;
    }
    const act = Array.from({ length: m }, (_, i) => i);
    for (let guard = 0; guard < m + 1 && act.length; guard++) {
      const q = act.length, A = [], b = [];
      for (let i = 0; i < q; i++) {
        A.push(act.map((k) => G[act[i]][k] + (act[i] === k ? 1e-9 * (G[act[i]][act[i]] + 1e-12) : 0)));
        b.push(r[act[i]]);
      }
      // élimination de Gauss
      for (let c = 0; c < q; c++) {
        let p = c;
        for (let i = c + 1; i < q; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
        [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
        if (Math.abs(A[c][c]) < 1e-30) continue;
        for (let i = c + 1; i < q; i++) {
          const f = A[i][c] / A[c][c];
          for (let k = c; k < q; k++) A[i][k] -= f * A[c][k];
          b[i] -= f * b[c];
        }
      }
      const x = new Float64Array(q);
      for (let i = q - 1; i >= 0; i--) {
        let s = b[i];
        for (let k = i + 1; k < q; k++) s -= A[i][k] * x[k];
        x[i] = Math.abs(A[i][i]) < 1e-30 ? 0 : s / A[i][i];
      }
      let worst = -1, wv = 0;
      for (let i = 0; i < q; i++) if (x[i] < wv) { wv = x[i]; worst = i; }
      if (worst < 0) { nu.fill(0); for (let i = 0; i < q; i++) nu[act[i]] = x[i]; return nu; }
      act.splice(worst, 1);
    }
    return nu;
  }

  /* ---------- Résolution ---------- */
  /**
   * ctx : contexte de simulation de l'optimiseur.
   * init : {T, power} (puissance constante) ou {T, s, P, n} (série seconde par seconde, ex. stratégie analytique).
   * opts : {v0, ladder, iters, maxEvals, maxKnots, ticker, onProgress, trace}
   *   ladder : espacements des nœuds (s), du plus grossier au plus fin ; iters : itérations maximales par niveau ;
   *   maxEvals : simulations complètes au plus ; maxKnots : les niveaux qui auraient plus de nœuds sont sautés
   *   (très longues sorties) ; trace(essai) : diagnostic de chaque essai de la recherche linéaire.
   * Renvoie {ok, sched, T, u, T0, cmd, evaluations, iterations, levels} ; cmd est utilisable par optimizer.replay.
   */
  async function solve(ctx, init, opts) {
    opts = opts || {};
    const iters = opts.iters || ITERS;
    const maxEvals = opts.maxEvals || 1200;
    const v0 = Math.max(0, Number(opts.v0) || 0);
    const ticker = opts.ticker || { async tick() {} };
    const progress = opts.onProgress || (() => {});
    const L = ctx.course.length, N = ctx.maxSteps + 2;
    const vref = L / init.T;
    // niveaux de raffinement, en sautant ceux qui auraient trop de nœuds (le plus grossier est toujours gardé)
    const all = (opts.ladder || DT_LADDER).map((dt, i) => ({ dt, maxIt: iters[Math.min(i, iters.length - 1)] }));
    const maxKnots = opts.maxKnots || 20000;
    let ladder = all.filter((l) => Math.ceil(L / (l.dt * vref)) <= maxKnots);
    if (!ladder.length) ladder = [all[0]];

    // contexte sans rafales (on n'optimise pas contre un tirage de vent), et sa version « sans limiteur »
    const ctxO = Object.assign({}, ctx, { gusts: null, longCap: true, smoothRec: false });
    const rctx = Object.assign({}, ctxO, { capTot: Float64Array.of(1e9), nWin: 1, nWinShort: 1, longCap: false });
    const PMAX = ctx.capTot[0];

    const ws = makeWorkspace(N);
    let cur = makeRec(N), trial = makeRec(N);
    let evals = 0, iterations = 0;
    const levels = [];

    const evalSched = (sch, rec) => {
      simulate(ctxO, sch, v0, rec);
      evals++;
      return rec.finished ? PYR.sim.enduranceUse(ctxO, rec.H, rec.T) : Infinity;
    };

    let sch = init.power !== undefined
      ? makeSchedule(L, ladder[0].dt * vref, () => init.power)
      : scheduleFromSeries(L, ladder[0].dt * vref, init.s, init.P, init.n);
    let uCur = evalSched(sch, cur);
    if (!cur.finished) return { ok: false, evaluations: evals };
    const T0 = cur.T;
    let best = { sch, T: cur.T, u: uCur };
    let alpha = 1;

    for (let li = 0; li < ladder.length; li++) {
      const dt = ladder[li].dt, ds = dt * vref;
      if (li > 0) {
        sch = resample(sch, L, ds);
        uCur = evalSched(sch, cur);
        if (!cur.finished) { sch = best.sch; uCur = evalSched(sch, cur); }
      }
      const Tstart = cur.T;
      let it = 0, fails = 0;
      const maxIt = ladder[li].maxIt;
      for (; it < maxIt && evals < maxEvals; it++) {
        progress((li + Math.min(1, it / maxIt)) / ladder.length);
        await ticker.tick();
        const K = sch.K;
        await prepare(ctxO, rctx, cur, sch, ws, ticker);
        const gr = reduce(ctxO, cur, ws);

        // métrique du pas : courbure estimée ≈ temps du tronçon / P²
        const w = new Float64Array(K + 1);
        for (let j = 0; j <= K; j++) {
          const p = sch.P[j] > P_FLOOR ? sch.P[j] : P_FLOOR;
          w[j] = ws.tw[j] > 0.05 ? p * p / ws.tw[j] : 0;
        }

        // ensemble actif : l'endurance si elle est proche de sa limite, puis les contraintes qui bloquent le pas
        const set = [];
        if (gr.uActive && gr.gE) set.push({ kind: 'E', key: 'E', vec: gr.gE });
        let d = new Float64Array(K + 1), nu = null, limit = null, aFeas = Infinity;
        for (let round = 0; round <= MAX_ACTIVE; round++) {
          nu = solveMultipliers(set, gr.g, w);
          for (let j = 0; j <= K; j++) {
            let c = gr.g[j];
            for (let i = 0; i < set.length; i++) c += nu[i] * set[i].vec[j];
            let x = -w[j] * c;
            if (x > TR_MAX) x = TR_MAX; else if (x < -TR_MAX) x = -TR_MAX;
            d[j] = x;
          }
          const exclude = new Set();
          for (let i = 0; i < set.length; i++) if (nu[i] > 0) exclude.add(set[i].key);
          const r = maxFeasibleStep(ctxO, cur, ws, d, exclude);
          aFeas = 0.9 * r.alpha; limit = r.limit;
          if (!r.limit || aFeas >= 0.5 * alpha || set.length >= MAX_ACTIVE) break;
          const key = r.limit.kind === 'W' ? 'W' + r.limit.t : 'M' + r.limit.t + ':' + r.limit.j;
          if (set.some((c) => c.key === key)) break;
          set.push({ kind: r.limit.kind, key, vec: constraintGradient(ctxO, cur, ws, r.limit.kind, r.limit.t, r.limit.j) });
        }
        let gd = 0, gdd = 0, gEd = 0;
        for (let j = 0; j <= K; j++) {
          gd += gr.g[j] * d[j];
          if (gr.gE) gEd += gr.gE[j] * d[j];
          gdd += d[j] * d[j] * ws.tw[j] / (Math.max(sch.P[j], P_FLOOR) ** 2);
        }
        // Niveau d'endurance auquel on remet un candidat à l'échelle : celui du point courant (sans descendre sous
        // U_TARGET). Viser U_TARGET quand le point courant est à U_LIM retirait ~0,05 % de puissance (≈ 1 s sur
        // une heure) à tout candidat, et aucun pas ne pouvait plus battre le point courant.
        const uFix = Math.max(U_TARGET, Math.min(uCur, U_LIM) - 2e-5);
        let a = alpha;
        if (gEd > 0 && gr.u > 0) { const aMax = Math.max(0, uFix - gr.u) / gEd; if (aMax < a) a = Math.max(aMax, 0.02); }
        if (aFeas < a) a = Math.max(aFeas, 1e-3);

        // recherche linéaire sur le simulateur réel
        const uLim = Math.max(U_LIM, uCur);
        const eps = 2e-6 * cur.T;
        let accepted = false;
        for (let tries = 0; tries < 7 && evals < maxEvals; tries++) {
          const cand = { ds, K, P: new Float64Array(K + 1) };
          for (let j = 0; j <= K; j++) {
            const p = sch.P[j] + a * d[j];
            cand.P[j] = p < 0 ? 0 : p > PMAX ? PMAX : p;
          }
          let u = evalSched(cand, trial);
          // restauration de faisabilité : l'endurance dérive au second ordre, on remet l'échelle plutôt que de rejeter le pas
          for (let fix = 0; fix < 3 && trial.finished && u > U_LIM && u < 1.2 && evals < maxEvals; fix++) {
            const f = uFix / u;
            for (let j = 0; j <= K; j++) cand.P[j] *= f;
            u = evalSched(cand, trial);
          }
          if (opts.trace) opts.trace({ level: dt, it, a, aFeas, nActive: set.length, limit, predicted: a * gd + 0.5 * a * a * gdd, actual: trial.T - cur.T, u, uCur, finished: trial.finished });
          if (trial.finished && trial.T < cur.T - eps && u <= uLim) {
            sch = cand; uCur = u; accepted = true;
            const tmp = cur; cur = trial; trial = tmp; // l'essai devient la base : on échange les tampons
            break;
          }
          a *= 0.5;
        }
        iterations++;
        if (!accepted) { alpha = Math.max(alpha * 0.5, 0.05); fails++; if (fails >= 2) break; continue; }
        fails = 0;
        alpha = Math.min(a * 1.6, 4);
        if (cur.T < best.T) best = { sch, T: cur.T, u: uCur };
      }
      levels.push({ dt, nodes: sch.K + 1, iterations: it, T: cur.T, gain: Tstart - cur.T });
    }
    progress(1);
    return {
      ok: true, sched: best.sch, T: best.T, u: best.u, T0,
      cmd: scheduleCommand(best.sch), evaluations: evals, iterations, levels,
    };
  }

  /**
   * Plusieurs descentes depuis le même départ, avec des échelles de raffinement différentes, et on garde la meilleure.
   * Le simulateur avance par pas de 1 s sur un relief par cellules : T(P) est « rugueux » (marches de ~0,5 s) et la
   * descente s'arrête sur un point qui dépend du chemin suivi (plusieurs secondes d'écart d'une échelle à l'autre).
   * Le résultat n'est jamais moins bon que celui de la première échelle.
   * opts.ladders : liste d'échelles (défaut LADDERS) ; le reste des options est transmis à solve.
   * Renvoie le résultat de solve de l'échelle gagnante, avec `ladder` (laquelle) et `runs` (temps de chacune).
   */
  async function solvePortfolio(ctx, init, opts) {
    opts = opts || {};
    const ladders = opts.ladders || LADDERS;
    const progress = opts.onProgress || (() => {});
    let best = null, evaluations = 0;
    const runs = [];
    for (let i = 0; i < ladders.length; i++) {
      const g = await solve(ctx, init, Object.assign({}, opts, {
        ladder: ladders[i],
        onProgress: (f) => progress((i + f) / ladders.length),
      }));
      if (!g.ok) { if (!best) return g; continue; }
      evaluations += g.evaluations;
      runs.push({ ladder: ladders[i], T: g.T });
      if (!best || g.T < best.T) best = g;
    }
    progress(1);
    return Object.assign({}, best, { evaluations, runs, ladder: runs.reduce((a, r) => (r.T < a.T ? r : a)).ladder });
  }

  PYR.gradient = {
    DT_LADDER, LADDERS, DELTA,
    solve, solvePortfolio, scheduleCommand, makeSchedule, sample, scheduleFromSeries,
    // exposé pour les tests
    _internal: { simulate, makeRec, makeWorkspace, prepare, reduce, constraintGradient, maxFeasibleStep, solveMultipliers, enduranceTerm },
  };
})(globalThis.PYR = globalThis.PYR || {});
