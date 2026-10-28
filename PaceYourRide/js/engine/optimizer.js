/* author : Hugo Joudrier-Faure */
/* PaceYourRide — calcul de la stratégie d'allure optimale (temps minimal).
 *
 * Problème : minimiser le temps de parcours sous les contraintes
 *   - W′bal ≥ 0 (modèle PC / W′ de Skiba),
 *   - courbe de puissance record respectée sur toutes les fenêtres glissantes,
 *   - dynamique complète (inertie, vent, rafales, friction, virages).
 *
 * Méthode (principe du minimum de Pontryagin, approximation quasi-statique) :
 *   Hamiltonien par unité de distance  H = [1 + μ·(P − PC)⁺ − μ·c·(PC − P)⁺ + λ·P] / v
 *   où μ est le « prix » du W′ (co-état : constant quand P > PC, croissant pendant la récupération,
 *   μ·c restant constant), c = fraction de W′ consommée, λ le prix de l'énergie (fatigue longue durée).
 *   La condition d'optimalité donne une vitesse cible v* telle que  v·P′(v) − P(v) = G*,
 *   indépendante de la pente : on appuie dans les bosses et le vent de face, on récupère
 *   dans les descentes et le vent de dos.
 *   - μ initial : tir (dichotomie sur ln μ) pour épuiser W′ exactement à l'arrivée ; si W′ touche 0
 *     avant (sommet d'un col…), l'arc est figé et un nouvel arc repart de ce point ;
 *   - λ : méthode d'Illinois pour que la courbe record soit respectée sur les fenêtres longues
 *     (≥ 20 min) et sur la durée totale. */
(function (PYR) {
  'use strict';

  const G = 9.80665;
  const K_UP = 0.15;    // gain de relance quand on est nettement sous la vitesse cible (1/s)
  const K_SOFT = 0.04;  // gain de régulation autour de la vitesse cible (1/s)
  const VMAX = 30;      // m/s — borne de recherche de la vitesse cible
  const V_FLOOR = 1.2;  // m/s — vitesse cible minimale (on ne s'arrête jamais en montée)
  const ELL_MAX = 600;  // borne du log du co-état

  /* ---------- Condition d'optimalité locale ----------
   * Pour une branche b, coût par unité de distance h(v) = N(P(v)) / v avec
   *   N(P) = a0 + m·P + l4·P⁴     (a0 = 1 − μ_b·PC, m = μ_b, l4 = λ / FTP³)
   * et P(v) = A·v + k·v·|v_app|·(v + v_face) la puissance d'équilibre (bornée à 0).
   * dh/dv = 0  ⇔  F(v) = v·P′(v)·N′(P) − N(P) = 0, F étant croissante.
   * Sans coût énergétique (l4 = 0) on retrouve la loi classique v·P′ − P = a0/m. */
  function solveBranch(a0, m, l4, A, k, wh, wc, guess) {
    if (!(a0 > 0)) return 0;              // le temps ne vaut rien face au coût : roue libre
    if (!(m > 0) && !(l4 > 0)) return VMAX; // aucun coût : à fond
    let lo = 0, hi = VMAX;
    let v = guess > 0.05 && guess < VMAX ? guess : 10;
    for (let it = 0; it < 60; it++) {
      const x = v + wh, va = Math.sqrt(x * x + wc * wc);
      const P = A * v + k * v * va * x;
      let F, dF = 0;
      if (P <= 0) F = -a0;
      else {
        const q = va > 1e-9 ? (x * x + va * va) / va : 0;
        const dP = A + k * (va * x + v * q);
        const P2 = P * P, P3 = P2 * P;
        const Np = m + 4 * l4 * P3;
        F = v * dP * Np - (a0 + m * P + l4 * P3 * P);
        const d2P = va > 1e-9 ? k * (2 * q + v * x * (2 * x * x + 3 * wc * wc) / (va * va * va)) : 0;
        dF = v * d2P * Np + v * dP * dP * 12 * l4 * P2;
      }
      if (F > 0) hi = v; else lo = v;
      if (hi - lo < 1e-5) break;
      let vn = dF > 0 ? v - F / dF : 0.5 * (lo + hi);
      if (!(vn > lo && vn < hi)) vn = 0.5 * (lo + hi);
      if (Math.abs(vn - v) < 1e-7) { v = vn; break; }
      v = vn;
      if (it === 0 && hi === VMAX && lo === 0) {
        // premier pas : vérifier qu'une solution existe sous VMAX
        const xv = VMAX + wh, vav = Math.sqrt(xv * xv + wc * wc);
        const Pv = A * VMAX + k * VMAX * vav * xv;
        if (Pv > 0) {
          const qv = vav > 1e-9 ? (xv * xv + vav * vav) / vav : 0;
          const dPv = A + k * (vav * xv + VMAX * qv);
          const Fv = VMAX * dPv * (m + 4 * l4 * Pv * Pv * Pv) - (a0 + m * Pv + l4 * Pv * Pv * Pv * Pv);
          if (Fv <= 0) return VMAX;
        } else return VMAX;
      }
    }
    return v;
  }

  /** Vitesse d'équilibre pour la puissance P (Newton protégé) — P(v) = A·v + k·v·|v_app|·(v+wh). */
  function solveSteady(P, A, k, wh, wc, guess) {
    let lo = 0, hi = VMAX;
    const f = (v) => { const x = v + wh; return A * v + k * v * Math.sqrt(x * x + wc * wc) * x - P; };
    if (f(VMAX) < 0) return VMAX;
    let v = guess > 0 && guess < VMAX ? guess : 8;
    for (let it = 0; it < 30; it++) {
      const x = v + wh, va = Math.sqrt(x * x + wc * wc);
      const fv = A * v + k * v * va * x - P;
      if (Math.abs(fv) < 1e-3) return v;
      if (fv > 0) hi = v; else lo = v;
      const d = A + k * (va * x + (va > 1e-9 ? v * (x * x + va * va) / va : 0));
      let vn = d > 0 ? v - fv / d : 0.5 * (lo + hi);
      if (!(vn > lo && vn < hi)) vn = 0.5 * (lo + hi);
      if (Math.abs(vn - v) < 1e-6) return vn;
      v = vn;
    }
    return v;
  }

  /* ---------- Politique de puissance ---------- */
  function makePolicy(ctx) {
    const S = ctx.setup;
    const mg = S.mass * G, eta = S.eta, cda = S.cda, mEff = S.massEff;
    let gHi = 10, gLo = 10, gCp = 10;
    const invF3 = 1 / Math.pow(ctx.athlete.ftp, 3);
    const info = { branch: 0, vt: -1 };

    function policy(st, cond, mu, lam) {
      // PC et W′ du lieu (profil de capacité le long du parcours, modèle physiologique ; ctx.cp et ctx.w0 sans profil)
      const cp = ctx.cp * (cond.capS > 0 ? cond.capS : 1), w0 = ctx.w0 * (cond.wS > 0 ? cond.wS : 1);
      const k = 0.5 * cond.rho * cda / eta;
      const A = mg * (cond.sinT + cond.crr * cond.cosT) / eta;
      // la consigne suit le vent moyen : on ne « chasse » pas chaque rafale (inertie)
      const wh = cond.whM, wc = cond.wcM;
      let c = (w0 - st.wbal) / w0;
      if (c < 0) c = 0; else if (c > 1) c = 1;
      const l4 = lam * invF3;

      const vhi = solveBranch(1 - mu * cp, mu, l4, A, k, wh, wc, gHi);
      if (vhi > 0 && vhi < VMAX) gHi = vhi;
      let x = vhi + wh;
      const Phi = A * vhi + k * vhi * Math.sqrt(x * x + wc * wc) * x;

      let P, vt, branch;
      if (Phi > cp) {
        branch = 1; vt = vhi; P = Phi;                 // au-dessus de la PC : on puise dans W′
      } else {
        const muc = mu * c;
        const vlo = solveBranch(1 - muc * cp, muc, l4, A, k, wh, wc, gLo);
        if (vlo > 0 && vlo < VMAX) gLo = vlo;
        x = vlo + wh;
        const Plo = A * vlo + k * vlo * Math.sqrt(x * x + wc * wc) * x;
        if (Plo < cp) { branch = -1; vt = vlo; P = Plo > 0 ? Plo : 0; } // récupération sous la PC
        else {                                                          // exactement à la PC
          branch = 0; P = cp;
          vt = solveSteady(cp, A, k, wh, wc, gCp);
          if (vt > 0 && vt < VMAX) gCp = vt;
        }
      }
      if (vt < V_FLOOR) {
        // on ne s'arrête pas en montée : vitesse minimale, quitte à puiser dans W′
        vt = V_FLOOR;
        x = vt + wh;
        const Pf = A * vt + k * vt * Math.sqrt(x * x + wc * wc) * x;
        if (Pf > P) { P = Pf; if (P > cp) branch = 1; }
      }
      // on ne vise jamais plus vite que la vitesse limite (virage, freinage à venir)
      if (vt > cond.vlim) vt = cond.vlim;
      const v = st.v, dv = vt - v, vv = v > 3 ? v : 3;
      const base = P;
      // Régulation vers la vitesse cible : proportionnelle et symétrique pour les petits écarts
      // (rafales, micro-relief)…
      P += mEff * vv * K_SOFT * (dv < 1 ? dv : 1);
      if (dv > 1) {
        // … et relance au-delà de 1 m/s de retard (départ arrêté, sortie de virage).
        let extra = mEff * vv * K_UP * (dv - 1);
        if (l4 > 0) {
          // Avec un coût énergétique, la relance est bornée par la règle marginale (co-état de la
          // vitesse ≈ constant) : coût marginal accepté × v*/v, soit ≈ P·(v*/v)^⅓ — pas de sprint
          // « gratuit » en sortie d'épingle quand la puissance d'équilibre est faible.
          let r = vt / vv;
          if (r > 4) r = 4;
          const mLo = mu * c, mHi = mu;
          const mB = branch === 1 || branch === 0 ? mHi : mLo;
          const Nt = (mB + 4 * l4 * base * base * base) * r;
          let Pm = Nt > mLo ? Math.cbrt((Nt - mLo) / (4 * l4)) : 0;
          if (Pm > cp) Pm = Nt <= mHi + 4 * l4 * cp * cp * cp ? cp : Math.cbrt((Nt - mHi) / (4 * l4));
          const lim = Pm - base;
          if (extra > lim) extra = lim > 0 ? lim : 0;
        }
        P += extra;
      }
      if (branch <= 0 && P > cp) {
        // hors branche haute, on ne puise dans W′ que pour une vraie relance et s'il en reste
        const spare = st.wbal - 0.25 * w0;
        const lim = dv >= 1 && spare > 0 ? cp + spare : (base > cp ? base : cp);
        if (P > lim) P = lim;
      }
      if (st.v > cond.vlim - 0.3) P = 0; // freinage imminent : on ne pédale pas
      info.branch = branch; info.vt = vt;
      return P > 0 ? P : 0;
    }
    policy.info = info;
    return policy;
  }

  /**
   * Évolution du log du co-état μ pendant une seconde de récupération à la puissance P : μ·c reste constant quand W′ se
   * reconstitue (Skiba), d ln μ = recF·(PC − P)/W′, avec la PC et le W′ du lieu (cond.capS, cond.wS).
   */
  function costateRise(ctx, cond, P) {
    const cp = ctx.cp * (cond.capS > 0 ? cond.capS : 1);
    return P < cp ? (ctx.recF / (ctx.w0 * (cond.wS > 0 ? cond.wS : 1))) * (cp - P) : 0;
  }

  /* ---------- Simulation d'un arc (co-état initial exp(y)) ---------- */
  function runArc(ctx, policy, st0, y, lam, opts) {
    const st = PYR.sim.cloneState(st0);
    const cond = {};
    const wTol = 0.002 * ctx.w0 + 1;
    const tolTouch = opts && opts.tolTouch !== undefined ? opts.tolTouch : Infinity;
    // minimum de W′ « intérieur » : une fois sorti de la zone de contact du départ de l'arc
    let ell = y, left = st.wbal > tolTouch, minW = Infinity, exhausted = false;
    const rec = opts && opts.record;
    const stop = opts && opts.stopOnExhaust;
    while (!st.finished && st.t < ctx.maxSteps) {
      PYR.sim.conditions(ctx, st.s, st.t, cond);
      const Pcmd = policy(st, cond, Math.exp(ell < ELL_MAX ? ell : ELL_MAX), lam);
      const wBefore = st.wbal;
      const P = PYR.sim.step(ctx, st, Pcmd, cond);
      // épuisement : la politique veut puiser dans W′ (branche haute) alors qu'il est vide
      if (policy.info.branch === 1 && wBefore < wTol && Pcmd > st.capW + 0.5 && !st.braking) exhausted = true;
      ell += costateRise(ctx, cond, P);
      if (left) { if (st.wbal < minW) minW = st.wbal; } else if (st.wbal > tolTouch) left = true;
      if (rec) { const t = st.t; rec.s[t] = st.s; rec.v[t] = st.v; rec.w[t] = st.wbal; rec.a[t] = st.allout; }
      if (stop && exhausted) break;
    }
    return { st, minW, exhausted };
  }

  /** Ordonnanceur coopératif : rend la main au navigateur régulièrement. */
  function makeTicker(onProgress) {
    let last = Date.now();
    const yieldNow = () => new Promise((r) => setTimeout(r, 0));
    return {
      frac: 0,
      async tick() {
        if (Date.now() - last > 40) {
          if (onProgress) onProgress(this.frac);
          await yieldNow();
          last = Date.now();
        }
      },
    };
  }

  /** Dichotomie sur y = ln μ pour un arc démarrant à st0. */
  async function solveArc(ctx, policy, st0, lam, tolW, tolTouch, ticker) {
    const remaining = ctx.course.length - st0.s;
    const tEst = remaining / 4 + 120;
    const yHi0 = Math.log(1 / ctx.cp);
    const span = Math.min(700, Math.log(1e7) + ctx.recF * ctx.cp * tEst / ctx.w0);
    let yHi = yHi0, yLo = yHi0 - span;
    const opts = { stopOnExhaust: true, tolTouch };
    let r = runArc(ctx, policy, st0, yLo, lam, opts);
    await ticker.tick();
    if (!r.exhausted) return yLo; // effort si court que même « à fond » W′ n'est pas épuisé
    let evals = 0;
    while (yHi - yLo > 1e-6 && evals < 80) {
      const y = 0.5 * (yLo + yHi);
      r = runArc(ctx, policy, st0, y, lam, opts);
      evals++;
      await ticker.tick();
      if (r.exhausted) yLo = y;
      else {
        yHi = y;
        // W′ vidé à l'arrivée, ou contact intérieur atteint (l'arc suivant repartira de là)
        if (r.st.wbal <= tolW || r.minW <= 0.5 * tolTouch) break;
      }
    }
    return yHi;
  }

  /** Enchaîne les arcs (points de contact W′bal ≈ 0). */
  async function solveArcs(ctx, policy, lam, v0, ticker, start) {
    const H = new Float64Array(ctx.maxSteps + 2);
    const N = ctx.maxSteps + 2;
    const rec = { s: new Float64Array(N), v: new Float64Array(N), w: new Float64Array(N), a: new Int32Array(N) };
    let st = PYR.sim.initState(ctx, v0, H, start);
    const tolW = 0.004 * ctx.w0 + 20;
    const tolTouch = 0.03 * ctx.w0 + 50;
    const arcs = [];
    for (let a = 0; a < 40; a++) {
      const y = await solveArc(ctx, policy, st, lam, tolW, tolTouch, ticker);
      arcs.push({ t: st.t, y });
      const r = runArc(ctx, policy, st, y, lam, { record: rec });
      // premier contact intérieur W′ ≈ 0, une fois sortie de la zone de contact du départ de l'arc
      const tEnd = Math.floor(r.st.t) - 10;
      let t1 = st.t + 1;
      while (t1 < tEnd && rec.w[t1] <= tolTouch) t1++;
      let tMin = -1, minW = Infinity;
      for (let t = t1; t < tEnd; t++) if (rec.w[t] < minW) { minW = rec.w[t]; tMin = t; }
      if (r.st.finished && r.st.wbal > tolW && minW < tolTouch && tMin > st.t + 5) {
        // on repart à la fin du « plateau » W′ ≈ 0 (arc frontière tenu à la PC, ex. fin de montée)
        let t = tMin;
        while (t + 1 < tEnd && rec.w[t + 1] <= tolTouch) t++;
        const nst = PYR.sim.initState(ctx, 0, H);
        nst.t = t; nst.s = rec.s[t]; nst.v = rec.v[t]; nst.wbal = rec.w[t]; nst.allout = rec.a[t]; nst.work = H[t];
        st = nst;
        continue;
      }
      break;
    }
    return arcs;
  }

  /** Consigne de la stratégie optimale (arcs de co-état successifs). */
  function optimalCommand(ctx, policy, arcs, lam) {
    let ai = 0, ell = arcs[0].y;
    return {
      power(st, cond) {
        if (ai + 1 < arcs.length && st.t >= arcs[ai + 1].t) { ai++; ell = arcs[ai].y; }
        return policy(st, cond, Math.exp(ell < ELL_MAX ? ell : ELL_MAX), lam);
      },
      after(P, cond) { ell += costateRise(ctx, cond, P); },
      branch() { return policy.info.branch; },
    };
  }

  /** Consigne à puissance constante (sauf freinage). */
  function constantCommand(Pc) {
    return {
      power(st, cond) { return st.v > cond.vlim - 0.3 ? 0 : Pc; },
      after() {},
      branch() { return 0; },
    };
  }

  /** Rejoue une stratégie complète (optionnellement en enregistrant chaque seconde). */
  function replay(ctx, cmd, v0, record, start) {
    const H = new Float64Array(ctx.maxSteps + 2);
    const st = PYR.sim.initState(ctx, v0, H, start);
    const cond = {};
    const N = ctx.maxSteps + 1;
    let R = null;
    if (record) {
      R = {
        s: new Float32Array(N + 1), v: new Float32Array(N + 1), w: new Float32Array(N + 1),
        P: new Float32Array(N), W: new Float32Array(N), wh: new Float32Array(N), wc: new Float32Array(N),
        grade: new Float32Array(N), brk: new Uint8Array(N), branch: new Int8Array(N), capped: new Uint8Array(N),
      };
      R.s[st.t] = st.s; R.v[st.t] = st.v; R.w[st.t] = st.wbal;
    }
    while (!st.finished && st.t < ctx.maxSteps) {
      PYR.sim.conditions(ctx, st.s, st.t, cond);
      const t = st.t;
      const P = PYR.sim.step(ctx, st, cmd.power(st, cond), cond);
      cmd.after(P, cond);
      if (R) {
        R.P[t] = P; R.W[t] = cond.W; R.wh[t] = cond.wh; R.wc[t] = cond.wc; R.grade[t] = cond.grade;
        R.brk[t] = st.braking ? 1 : 0; R.branch[t] = cmd.branch(); R.capped[t] = st.capped ? 1 : 0;
        R.s[t + 1] = Math.min(st.s, ctx.course.length); R.v[t + 1] = st.v; R.w[t + 1] = st.wbal;
      }
    }
    return { st, R };
  }

  /* ---------- Référence : meilleure puissance constante tenable ---------- */
  function constantRun(ctx, Pc, v0, start) {
    const st = PYR.sim.initState(ctx, v0, undefined, start);
    const cond = {};
    while (!st.finished && st.t < ctx.maxSteps) {
      PYR.sim.conditions(ctx, st.s, st.t, cond);
      const Pcmd = st.v > cond.vlim - 0.3 ? 0 : Pc;
      PYR.sim.step(ctx, st, Pcmd, cond);
      if (st.capped) return { ok: false, st };
    }
    if (!st.finished) return { ok: false, st };
    // la puissance moyenne doit aussi respecter le record interpolé sur la durée totale
    const ok = PYR.sim.enduranceUse(ctx, st.hist, st.tFinish) <= 1.0005;
    return { ok, st };
  }

  async function bestConstant(ctx, v0, ticker, start) {
    let lo = 50, hi = ctx.capTot[0];
    const r0 = constantRun(ctx, lo, v0, start);
    if (!r0.ok) return null;
    let best = { power: lo, time: r0.st.tFinish };
    for (let it = 0; it < 26 && hi - lo > 0.2; it++) {
      const mid = 0.5 * (lo + hi);
      const r = constantRun(ctx, mid, v0, start);
      await ticker.tick();
      if (r.ok) { lo = mid; best = { power: mid, time: r.st.tFinish }; } else hi = mid;
    }
    return best;
  }

  /* ---------- Statistiques ---------- */
  function computeStats(R, tFinish, ctx, athlete, t0) {
    t0 = t0 || 0;
    const n = Math.ceil(tFinish);
    const ftp = athlete.ftp;
    let work = 0, pMax = 0, vMax = 0, brake = 0;
    const zones = new Array(PYR.physio.ZONES.length).fill(0);
    const dur = tFinish - t0, dist = ctx.course.length - (R.s[t0] || 0);
    for (let t = t0; t < n; t++) {
      const dt = t === n - 1 ? tFinish - (n - 1) : 1;
      const P = R.P[t];
      work += P * dt;
      if (P > pMax) pMax = P;
      if (R.v[t + 1] > vMax) vMax = R.v[t + 1];
      if (R.brk[t]) brake += dt;
      zones[PYR.physio.zoneIndex(P, ftp)] += dt;
    }
    // Puissance normalisée (moyenne glissante 30 s)
    let np;
    if (n - t0 >= 30) {
      let acc = 0, s4 = 0, cnt = 0;
      for (let t = t0; t < n; t++) {
        acc += R.P[t];
        if (t - t0 >= 30) acc -= R.P[t - 30];
        if (t - t0 >= 29) { const m = acc / 30; s4 += m * m * m * m; cnt++; }
      }
      np = Math.pow(s4 / cnt, 0.25);
    } else np = work / dur;
    let wMin = Infinity;
    for (let t = t0; t <= n; t++) if (R.w[t] < wMin) wMin = R.w[t];
    const avgP = work / dur;
    const IF = np / ftp;
    return {
      time: tFinish,
      dist,
      avgSpeed: dist / dur,
      maxSpeed: vMax,
      avgPower: avgP,
      np, IF,
      tss: (dur * np * IF) / (ftp * 3600) * 100,
      vi: np / avgP,
      work,
      pMax,
      wbalMin: wMin,
      wbalMinPct: wMin / ctx.w0,
      zones,
      brakingTime: brake,
      wkg: avgP / ctx.setup.mRider,
    };
  }

  /**
   * Point d'entrée.
   * input : {course, setup, athlete, v0 (m/s), margin, seed, withBaseline, algo, physio, capS, wS, endK}
   *   algo : 'analytic' (défaut : principe de Pontryagin), 'gradient' (descente de gradient depuis la puissance
   *   constante) ou 'hybrid' (descente de gradient depuis la stratégie analytique et depuis la constante, on garde
   *   le meilleur) — cf. gradient.js.
   *   physio : {card, kit, gut, state} — tenir compte du modèle physiologique (optimizePhysio) ; ignoré en replanification (start).
   *   capS, wS, endK : modèle réduit (sim.createContext) — facteurs de capacité de la PC et du W′ par cellule du parcours (null =
   *   capacité entière), endurance du jour (records de 20 min et plus, 1 par défaut).
   * onProgress(frac 0..1)
   */
  async function optimize(input, onProgress) {
    if (input.physio && !input.start && PYR.metabo && PYR.fuel) return optimizePhysio(input, onProgress);
    return optimizeOnce(input, onProgress);
  }

  /** Un calcul de la stratégie, avec la capacité du contexte (entière, ou profil capS / wS le long du parcours). */
  async function optimizeOnce(input, onProgress) {
    const started = Date.now();
    const ctx = PYR.sim.createContext(input.course, input.setup, input.athlete,
      { margin: input.margin, seed: input.seed, subSteps: input.subSteps, capS: input.capS, wS: input.wS, endK: input.endK });
    const policy = makePolicy(ctx);
    // Replanification en cours de sortie : start = {t, s, v, wbal, hist} (voir sim.initState) ; la descente de gradient part du
    // kilomètre 0 et n'est pas utilisée dans ce cas.
    const start = input.start || null;
    const t0 = start ? Math.max(0, Math.floor(Number(start.t) || 0)) : 0;
    const v0 = start ? Math.max(0, Number(start.v) || 0) : Math.max(0, Number(input.v0) || 0);
    ctx.fromT = t0;
    const ticker = makeTicker(onProgress);
    const TOL = 0.0015;
    const algo = !start && (input.algo === 'gradient' || input.algo === 'hybrid') ? input.algo : 'analytic';
    // l'analytique occupe toute la barre de progression, ou seulement le début si le gradient suit
    const fr = (x) => (algo === 'analytic' ? x : 0.4 * x);
    let evals = 0, best = null, rep = null;

    /** Algorithme analytique : renvoie une erreur, ou null si `best` et `rep` sont renseignés. */
    const analytic = async () => {
      // Phase de recherche : fenêtres longues non plafonnées, on mesure leur taux d'utilisation.
      ctx.longCap = false;
      const evalLam = async (lam) => {
        const arcs = await solveArcs(ctx, policy, lam, v0, ticker, start);
        const r = replay(ctx, optimalCommand(ctx, policy, arcs, lam), v0, false, start);
        evals++;
        const u = r.st.finished ? PYR.sim.enduranceUse(ctx, r.st.hist, r.st.tFinish) : Infinity;
        return { lam, arcs, u };
      };

      ticker.frac = fr(0.03);
      best = await evalLam(0);
      if (best.u > 1 + TOL) {
        // Encadrement de λ
        let a = best, b = null, lam = 2e-3;
        ticker.frac = fr(0.2);
        while (lam < 20) {
          const r = await evalLam(lam);
          if (r.u <= 1) { b = r; break; }
          a = r; lam *= 3;
        }
        if (!b) {
          best = a;
        } else {
          // Illinois (fausse position modifiée) sur ln λ
          let xa = a.lam > 0 ? Math.log(a.lam) : Math.log(b.lam) - 6, fa = a.u - 1;
          let xb = Math.log(b.lam), fb = b.u - 1;
          let side = 0;
          for (let it = 0; it < 16; it++) {
            ticker.frac = fr(0.3 + 0.55 * Math.min(1, it / 10));
            if (-fb < TOL || Math.abs(xb - xa) < 1e-4) break;
            let x = (xa * fb - xb * fa) / (fb - fa);
            if (!(x > Math.min(xa, xb) && x < Math.max(xa, xb))) x = 0.5 * (xa + xb);
            const r = await evalLam(Math.exp(x));
            const f = r.u - 1;
            if (f <= 0) { b = r; xb = x; fb = f; if (side === -1) fa /= 2; side = -1; }
            else { xa = x; fa = f; if (side === 1) fb /= 2; side = 1; }
          }
          best = b;
        }
      }

      // Rejeu final avec toutes les contraintes
      ctx.longCap = true;
      ticker.frac = fr(0.88);
      rep = replay(ctx, optimalCommand(ctx, policy, best.arcs, best.lam), v0, true, start);
      if (!rep.st.finished) {
        return { ok: false, error: 'La simulation n\'a pas pu atteindre l\'arrivée (pente trop raide ou puissance insuffisante).' };
      }
      return null;
    };

    if (algo !== 'gradient') {
      const err = await analytic();
      if (err) return err;
    }
    ctx.longCap = true;

    // Référence : meilleure puissance constante tenable. Si elle fait mieux (parcours très
    // régulier), c'est elle qui est proposée : le plan n'est jamais moins bon qu'une allure constante.
    let baseline = null, strategy = 'optimal', gradient = null;
    if (input.withBaseline !== false || algo !== 'analytic') {
      ticker.frac = fr(0.92);
      baseline = await bestConstant(ctx, v0, ticker, start);
    }

    // Descente de gradient. « gradient » part de la puissance constante ; « hybride » part du plan que proposerait
    // l'analytique (ou de la constante si elle fait mieux) et, en plus, de la constante : une descente est locale,
    // le meilleur des deux départs ne peut être moins bon ni que le gradient seul, ni que l'analytique.
    if (algo !== 'analytic') {
      const starts = [];
      const constStart = baseline ? { kind: 'constante', T: baseline.time, power: baseline.power } : null;
      if (algo === 'gradient' && constStart) starts.push(constStart);
      else {
        if (!rep) { const err = await analytic(); if (err) return err; ctx.longCap = true; }
        if (constStart && baseline.time < rep.st.tFinish - 0.5) starts.push(constStart);
        else {
          starts.push({ kind: 'analytique', T: rep.st.tFinish, s: rep.R.s, P: rep.R.P, n: Math.ceil(rep.st.tFinish) });
          if (algo === 'hybrid' && constStart) starts.push(constStart);
        }
      }
      gradient = { algo, runs: [] };
      for (let i = 0; i < starts.length; i++) {
        const lo = 0.4 + 0.55 * i / starts.length, hi = 0.4 + 0.55 * (i + 1) / starts.length;
        const g = await PYR.gradient.solvePortfolio(ctx, starts[i], {
          v0, ticker, onProgress: (f) => { ticker.frac = lo + (hi - lo) * f; },
        });
        if (!g.ok) continue;
        evals += g.evaluations;
        const alt = replay(ctx, g.cmd, v0, true);
        // le plan est rejoué avec le simulateur complet (rafales comprises) : il doit y rester faisable
        const ok = alt.st.finished && PYR.sim.enduranceUse(ctx, alt.st.hist, alt.st.tFinish) <= 1 + TOL;
        const run = { from: starts[i].kind, startTime: g.T0, time: ok ? alt.st.tFinish : null, iterations: g.iterations, levels: g.levels, ladder: g.ladder, chosen: false };
        gradient.runs.push(run);
        if (ok && (!rep || alt.st.tFinish < rep.st.tFinish)) {
          rep = alt; strategy = 'gradient';
          for (const r of gradient.runs) r.chosen = false;
          run.chosen = true;
        }
      }
      if (!rep) {
        return { ok: false, error: 'La simulation n\'a pas pu atteindre l\'arrivée (pente trop raide ou puissance insuffisante).' };
      }
    }

    if (baseline && baseline.time < rep.st.tFinish - 0.5) {
      const alt = replay(ctx, constantCommand(baseline.power), v0, true, start);
      if (alt.st.finished) { rep = alt; strategy = 'constant'; }
    }
    if (onProgress) onProgress(1);

    const st = rep.st;
    const stats = computeStats(rep.R, st.tFinish, ctx, input.athlete, t0);
    stats.stalled = st.stalled;
    stats.enduranceUse = PYR.sim.enduranceUse(ctx, st.hist, st.tFinish);

    const n = Math.ceil(st.tFinish);
    const R = rep.R;
    const ele = new Float32Array(n + 1 - t0);
    for (let t = t0; t <= n; t++) ele[t - t0] = PYR.course.eleAt(input.course, R.s[t]);
    // les séries commencent à t0 (0 sauf replanification) ; tFinish et n restent des instants de la sortie
    const cut = (a, len) => a.slice(t0, len);
    return {
      ok: true,
      strategy, algo, gradient,
      n, t0, tFinish: st.tFinish,
      series: {
        s: cut(R.s, n + 1), v: cut(R.v, n + 1), wbal: cut(R.w, n + 1), ele,
        P: cut(R.P, n), W: cut(R.W, n), wh: cut(R.wh, n), wc: cut(R.wc, n), grade: cut(R.grade, n),
        brk: cut(R.brk, n), branch: cut(R.branch, n), capped: cut(R.capped, n),
      },
      stats, baseline,
      lam: best ? best.lam : null, arcs: best ? best.arcs : null, evaluations: evals,
      cp: ctx.cp, w0: ctx.w0, ftp: input.athlete.ftp,
      elapsedMs: Date.now() - started,
    };
  }

  /* ---------- Modèle physiologique : modèle réduit pour optimiser, modèle complet pour vérifier ---------- */
  const PHYSIO_RUNS = 7;      // calculs analytiques au plus (le premier avec la capacité entière), puis un avec l'algorithme choisi
  const PHYSIO_TOL = 0.03;    // part du W′ que le plan peut creuser sous zéro sur le modèle complet (écart entre les deux modèles)

  /**
   * Vérification d'un plan sur le modèle physiologique complet (metabo.js), seconde par seconde : puissance, position et vitesse du
   * plan ; environnement de chaque seconde (metabo.envOf : température et humidité de la météo ou du parcours, soleil, altitude, vent
   * relatif, sans abri) ; prises du plan d'alimentation (nutrition.planNutrition avec le matériel `kit`), digérées par fuel.js. Le
   * W′bal est recalculé avec la PC et le W′ effectifs prévus (même modèle de Skiba que le simulateur) : s'il passe nettement sous zéro,
   * la PC effective est tombée sous la puissance du plan et le plan demande plus que ce que le cycliste pourra donner.
   * input : celui d'optimize, avec physio {card (metabo.card de l'athlète frais), kit ({slots, items}, voir fuel.normKit), gut (0–1),
   * state (état de départ, metabo.create)} ; res : résultat d'optimize (plan depuis le départ).
   * Renvoie {feasible, minW (J, W′bal effectif le plus bas), tMin (s), sMin (m), tol (J), cp et w0 (PC et W′ du plan : forme comprise,
   * sans réduction), séries d'une valeur par seconde (n + 1) :
   * cpK et wK (PC et W′ effectifs / ceux du plan), cpLoc et wLoc (leur part « locale », sans le glycogène ni la glycémie : chaleur,
   * eau, altitude, commande centrale, fatigue des fibres), Tc (température centrale, °C), wbal (W′bal effectif, J) ; maxTc, Tcrit,
   * endCpK, endWK, bonkT (s, première fringale, ou null), nutrition {carbsPerH, fluidPerH, eat, drink, warnings} (null sans
   * nutrition.js)}.
   */
  function physioCheck(input, res) {
    const Mx = PYR.metabo, Fu = PYR.fuel, ph = input.physio;
    const C = input.course, S = res.series, n = res.n;
    const ctx = PYR.sim.createContext(C, input.setup, input.athlete, { margin: input.margin, seed: input.seed });
    // carte à l'échelle du plan (forme comprise) : sa PC et son W′ sont ceux du contexte (comme race.addRider)
    const card = Mx.scaleCard(ph.card, ctx.cp / ph.card.CP2, ctx.w0 / 1000 / ph.card.Wp);
    const mass = input.setup.mRider, kit = Fu.normKit(ph.kit), gut = Number(ph.gut) || 0;
    const nut = PYR.nutrition ? PYR.nutrition.planNutrition({
      P: S.P, dur: res.tFinish, mass, cp: ctx.cp, ftp: input.athlete.ftp, tempC: C.temperature, gut, kit,
    }) : null;
    const ev = nut ? nut.events : [];
    const f = Fu.create(mass, { slots: kit.slots, items: kit.items, gutTraining: gut, physio: card, physioOpts: ph.state });
    const s = f.phy.s, bonkG = Mx.BONK_G * (card.GIcap + card.GIIcap);
    const cpK = new Float32Array(n + 1), wK = new Float32Array(n + 1), cpLoc = new Float32Array(n + 1), wLoc = new Float32Array(n + 1);
    const Tc = new Float32Array(n + 1), wbal = new Float32Array(n + 1);
    const cond = {}, env = {}, pos = { s: 0, v: 0, t: 0 };
    let w = Infinity, minW = Infinity, tMin = 0, ei = 0, bonkT = null;
    for (let t = 0; ; t++) {
      // capacité de la seconde : facteurs calculés avec l'état de la seconde précédente (comme en course)
      const k = s.f, cpE = ctx.cp * k.cpK, w0E = ctx.w0 * k.wK;
      if (w > w0E) w = w0E;
      cpK[t] = k.cpK; wK[t] = k.wK; Tc[t] = s.Tc; wbal[t] = w;
      // part locale : CP2e / CP2 = m_gly · (1 − ¼(ΦI + ΦII)) · m_T · m_hyd · m_alt · VA, sans m_gly ni VA_glu ; W′ : (1 − ΦII) · m_alt,W
      cpLoc[t] = k.gly * k.VA_glu > 0 ? k.cpK / (k.gly * k.VA_glu) : k.cpK;
      wLoc[t] = (1 - s.PhiII) * k.mAltW;
      if (w < minW) { minW = w; tMin = t; }
      if (t >= n) break;
      const P = S.P[t];
      if (P >= cpE) w -= P - cpE; else w = w0E - (w0E - w) * Math.exp(-ctx.recF * (cpE - P) / w0E);
      while (ei < ev.length && ev[ei].t <= t) {
        const e = ev[ei++];
        if (e.type === 'eat') { f.items[e.kind] = Math.max(1, f.items[e.kind] || 0); Fu.eat(f, t, e.kind, true); } else Fu.drink(f, t, e.slot);
      }
      PYR.sim.conditions(ctx, Math.min(S.s[t], C.length - 0.01), t, cond);
      pos.s = S.s[t]; pos.v = 0.5 * (S.v[t] + S.v[t + 1]); pos.t = t;
      Fu.step(f, P, ctx.cp, cond.Tapp, Mx.envOf(C, cond, pos, 0, env));
      if (bonkT === null && (s.GI + s.GII < bonkG || s.Glu / (0.18 * card.Vd) < 3.0)) bonkT = t + 1;
    }
    const tol = PHYSIO_TOL * ctx.w0;
    return {
      feasible: minW >= -tol, minW, tMin, sMin: S.s[Math.min(tMin, n)], tol, cp: ctx.cp, w0: ctx.w0,
      cpK, wK, cpLoc, wLoc, Tc, wbal, maxTc: Math.max(s.maxTc, s.Tc), Tcrit: card.Tcrit, endCpK: cpK[n], endWK: wK[n], bonkT,
      nutrition: nut ? {
        carbsPerH: nut.carbsPerH, fluidPerH: nut.fluidPerH, warnings: nut.warnings,
        eat: ev.filter((e) => e.type === 'eat').length, drink: ev.filter((e) => e.type === 'drink').length,
      } : null,
    };
  }

  /**
   * Facteurs de capacité par cellule du parcours C : ceux de la série k (une valeur par seconde du plan S, n secondes) à l'instant où
   * le plan passe au milieu de la cellule (1 au plus).
   */
  function capProfile(C, S, n, k) {
    const out = new Float32Array(C.n);
    let t = 0;
    for (let i = 0; i < C.n; i++) {
      const x = (i + 0.5) * C.step;
      while (t < n && S.s[t + 1] <= x) t++;
      out[i] = k[t] < 1 ? k[t] : 1;
    }
    return out;
  }

  /**
   * Part de puissance à retirer pour combler le déficit de W′ de la vérification c du plan res : le W′ qui manque, réparti sur la
   * descente qui y mène (depuis le dernier instant où le W′ effectif était presque plein, 10 min au moins), rapporté à la puissance
   * moyenne du plan sur cette descente.
   */
  function deficitShare(res, c) {
    const P = res.series.P, w = c.wbal, tm = c.tMin;
    let a = tm;
    while (a > 0 && w[a - 1] < 0.95 * c.w0 * c.wK[a - 1]) a--;
    const t0 = Math.max(0, Math.min(a, tm - 600));
    let sum = 0;
    for (let t = t0; t < tm; t++) sum += P[t];
    return sum > 0 ? -c.minW / sum : 0.05;
  }

  const PHYSIO_DK = 0.004;    // précision de la recherche de l'endurance du jour (0,4 % ≈ 1 W pour 250 W)
  const PHYSIO_KMIN = 0.3;    // endurance du jour la plus basse essayée

  /**
   * Endurance du jour du prochain calcul. lo : calcul tenu le plus endurant, hi : calcul non tenu le moins endurant, hi2 : le non tenu
   * précédent. Encadrée (lo et hi) : dichotomie. Sinon, sécante sur le W′bal effectif le plus bas des deux derniers calculs non tenus
   * (visée : 2 % du W′, pas allongé de 30 % : le gain sur le W′ s'amenuise à l'approche de la limite), et au premier essai
   * 70 % de la part de puissance qui manque (deficitShare : la PC effective chute vite quand le glycogène s'épuise, un peu moins
   * d'effort suffit souvent). Le pas reste entre 1 % et 15 % de l'endurance.
   */
  function nextEndK(lo, hi, hi2) {
    if (lo) return 0.5 * (lo.endK + hi.endK);
    const c = hi.chk;
    let d = 0.7 * deficitShare(hi.res, c) * hi.endK;
    if (hi2 && c.minW > hi2.chk.minW) d = 1.3 * (0.02 * c.w0 - c.minW) * (hi2.endK - hi.endK) / (c.minW - hi2.chk.minW);
    d = Math.min(0.15 * hi.endK, Math.max(0.01 * hi.endK, d));
    return Math.max(PHYSIO_KMIN, hi.endK - d);
  }

  /**
   * Stratégie optimale avec le modèle physiologique (rapport « Modèle physiologique du cycliste », section 18) : on optimise sur un
   * modèle réduit et l'on vérifie le plan sur le modèle complet (physioCheck). Modèle réduit : la signature (PC, W′, courbe record)
   *   - multipliée, le long du parcours, par la part locale des facteurs de capacité que le modèle complet prévoit au passage du plan
   *     précédent (capS, wS : chaleur, eau, altitude, commande centrale, fatigue des fibres ; cpLoc et wLoc de physioCheck) ;
   *   - avec une endurance du jour endK sur les records de 20 min et plus, qui tient lieu de glycogène agrégé : un plan qui roule
   *     plus fort au début vide davantage les réserves et paie à la fin. Le glycogène reste hors du profil : figé le long du parcours,
   *     il donnerait au plan suivant la capacité d'un plan plus doux ou plus dur que lui, et les calculs oscilleraient.
   * Premier calcul avec la capacité entière ; si le W′bal recalculé avec la PC et le W′ effectifs passe nettement sous zéro, on cherche
   * l'endurance du jour la plus haute que le modèle complet tient (nextEndK), le profil de capacité suivant chaque fois le dernier plan
   * vérifié ; PHYSIO_RUNS calculs au plus, avec l'algorithme analytique (rapide). L'algorithme choisi (gradient, hybride)
   * recalcule ensuite le plan sur le modèle réduit retenu, qui est vérifié à son tour. Le plan retenu est le plus rapide de ceux que
   * le modèle complet tient (à défaut, le moins déficitaire). res.physio : sa vérification (physioCheck), endK, capS et wS (null sans
   * réduction), runs (algorithme, endurance, temps, W′bal effectif le plus bas et verdict de chaque calcul).
   */
  async function optimizePhysio(input, onProgress) {
    const started = Date.now(), C = input.course;
    const algo = input.algo === 'gradient' || input.algo === 'hybrid' ? input.algo : 'analytic';
    const share = algo === 'analytic' ? 1 : 0.3;   // part de la barre de progression pour la recherche de l'endurance
    const runs = [];
    let best = null, fallback = null, endK = 1, capS = null, wS = null, evals = 0, failure = null;
    let lo = null, hi = null, hi2 = null;   // calcul tenu le plus endurant ; non tenu le moins endurant, et le précédent
    const calc = async (a, p0, p1) => {
      const r = await optimizeOnce(Object.assign({}, input, { algo: a, endK, capS, wS }), onProgress ? (x) => onProgress(p0 + (p1 - p0) * x) : null);
      if (!r.ok) { failure = r; return null; }
      evals += r.evaluations;
      const c = physioCheck(input, r);
      const item = { res: r, chk: c, endK, capS, wS };
      runs.push({ algo: a, endK, time: r.tFinish, minW: c.minW, feasible: c.feasible, strategy: r.strategy });
      if (c.feasible) { if (!best || r.tFinish < best.res.tFinish) best = item; }
      else if (!fallback || c.minW > fallback.chk.minW) fallback = item;
      return item;
    };
    for (let i = 0; i < PHYSIO_RUNS; i++) {
      const it = await calc('analytic', share * (1 - Math.pow(0.6, i)), share * (1 - Math.pow(0.6, i + 1)));
      if (!it) break;
      if (it.chk.feasible) { if (!lo || it.endK > lo.endK) lo = it; } else if (!hi || it.endK < hi.endK) { hi2 = hi; hi = it; }
      if (!hi) break;                                   // tenu d'emblée : rien à réduire
      capS = capProfile(C, it.res.series, it.res.n, it.chk.cpLoc);
      wS = capProfile(C, it.res.series, it.res.n, it.chk.wLoc);
      if (lo ? hi.endK - lo.endK < PHYSIO_DK : hi.endK <= PHYSIO_KMIN) break;
      endK = nextEndK(lo, hi, hi2);
    }
    if (algo !== 'analytic' && (best || fallback)) {
      const ref = best || fallback;
      endK = ref.endK; capS = ref.capS; wS = ref.wS;
      await calc(algo, share, 1);
    }
    const pick = best || fallback;
    if (!pick) return failure;
    if (onProgress) onProgress(1);
    const res = pick.res;
    res.physio = Object.assign(pick.chk, { endK: pick.endK, capS: pick.capS, wS: pick.wS, runs });
    res.evaluations = evals;
    res.elapsedMs = Date.now() - started;
    return res;
  }

  PYR.optimizer = {
    optimize, makePolicy, solveBranch, solveSteady, replay, optimalCommand, constantCommand, constantRun, bestConstant, makeTicker, computeStats,
    physioCheck, capProfile, PHYSIO_RUNS, PHYSIO_TOL,
  };
})(globalThis.PYR = globalThis.PYR || {});
