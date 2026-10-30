/* author : Hugo Joudrier-Faure */
/* PaceYourRide — suivi d'une sortie réelle : capteur de puissance + GPS d'un téléphone contre un plan de puissance optimal.
 *
 * Ce module ne touche ni au DOM ni aux capteurs (il se teste sous Node comme le reste du moteur) : l'interface lui envoie, chaque
 * seconde, la puissance mesurée et la dernière position GPS (session.step) ; il tient à jour
 *   - la position sur le tracé, lissée sur quelques secondes (filtre α-β sur la projection du point GPS), et l'avance ou le retard
 *     sur le plan (écart de temps et de distance, lissé lui aussi) ;
 *   - la réserve W′ (modèle de Skiba), le glycogène et l'hydratation (fuel.js) à partir de la puissance réellement produite et de ce
 *     que le cycliste déclare avoir pris ; avec le modèle physiologique, ses états cachés (température centrale, eau, biais des FC de
 *     repos et maximale) sont recalés chaque seconde sur la fréquence cardiaque de la ceinture (metabo.observeHR, filtre de Kalman) ;
 *   - le tronçon en cours, la puissance cible et ce qui suit ;
 *   - le besoin de recalculer le plan : écart de temps durable, consigne non respectée, W′ qui s'éloigne de celui du plan.
 * Recalculer = relancer l'optimiseur (optimizer.js) depuis l'état réel : le passé est figé (la puissance réellement roulée sert
 * d'historique à la courbe de puissance record) et seul le reste du parcours est optimisé.
 *
 * Convention de temps : la sortie compte t secondes écoulées ; la seconde k (0 ≤ k < t) a la puissance P[k], et H[k] est l'énergie
 * cumulée avant elle, comme dans sim.js. */
(function (PYR) {
  'use strict';

  const U = PYR.util;
  const Fu = PYR.fuel;

  const G = 9.80665;
  const R_DEG = 6371008.8 * Math.PI / 180;   // mètres par degré de latitude
  const MAX_T = 12 * 3600;                   // s : durée maximale enregistrée
  const TOL_FRAC = 0.05, MIN_TOL = 5;        // tube de la consigne : ± 5 % (au moins 5 W)
  const TRAJ_AVG = 3;                        // s : moyenne glissante de la puissance suivie dans le tube, et de la consigne aux changements de tronçon
    const MAX_P = 2500;                        // W : au-delà, une mesure est aberrante
  const KIT_DEFAULT = { slots: ['iso', 'iso', '', ''], items: { gel: 3, gelglu: 0, gelplus: 0, bar: 2, barmini: 0 } };

  /** Sensibilité du recalcul automatique : écart de temps (s), écart de puissance (part de la cible), écart de W′ (part de W′), délai minimal (s), tenue (s). */
  const SENS = {
    low: { gapSec: 20, powerPct: 0.12, wbalPct: 0.20, minInterval: 90, hold: 25 },
    normal: { gapSec: 12, powerPct: 0.08, wbalPct: 0.12, minInterval: 60, hold: 20 },
    high: { gapSec: 6, powerPct: 0.05, wbalPct: 0.07, minInterval: 30, hold: 15 },
  };
  const DEFAULT_CFG = { gapTau: 8, sens: 'normal', auto: true, altAlpha: 0.3, powerAvg: 3 };
  const EST_WIN = 30;                        // s : fenêtre de la puissance moyenne estimée

  /* ======================================================================
   * Projection d'un point GPS sur le tracé
   * ====================================================================== */

  /** Projection sur la polyligne du parcours (grille régulière de course.js) ; coordonnées planes locales, en mètres. */
  function createMatcher(course) {
    const n1 = course.n + 1, step = course.step, L = course.length;
    const lat0 = course.lat[0], lng0 = course.lng[0];
    const cosL = Math.cos(U.toRad(course.lat[(course.n / 2) | 0]));
    const X = new Float64Array(n1), Y = new Float64Array(n1);
    for (let i = 0; i < n1; i++) { X[i] = (course.lng[i] - lng0) * cosL * R_DEG; Y[i] = (course.lat[i] - lat0) * R_DEG; }
    const D2 = new Float64Array(n1), FF = new Float64Array(n1);   // distance² et position sur le segment i, pour la recherche sur tout le parcours

    /** Meilleur segment i→i+1 pour i dans [i0, i1[ : { i, f (0–1), d2 }. */
    function scan(x, y, i0, i1) {
      let bi = -1, bf = 0, bd = Infinity;
      for (let i = i0; i < i1; i++) {
        const dx = X[i + 1] - X[i], dy = Y[i + 1] - Y[i], l2 = dx * dx + dy * dy;
        let f = l2 > 0 ? ((x - X[i]) * dx + (y - Y[i]) * dy) / l2 : 0;
        f = f < 0 ? 0 : f > 1 ? 1 : f;
        const ex = X[i] + f * dx - x, ey = Y[i] + f * dy - y, d2 = ex * ex + ey * ey;
        if (d2 < bd) { bd = d2; bi = i; bf = f; }
      }
      return { i: bi, f: bf, d2: bd };
    }

    /**
     * Projette (lat, lng). from/to : fenêtre de distances (m) où chercher (sans fenêtre : tout le parcours, et à égalité on prend le
     * plus proche du départ, utile sur une boucle). Renvoie { s (m), d (m, écart latéral) }.
     */
    function project(lat, lng, from, to) {
      const x = (lng - lng0) * cosL * R_DEG, y = (lat - lat0) * R_DEG;
      let i0 = 0, i1 = n1 - 1;
      const windowed = from !== undefined && to !== undefined;
      if (windowed) { i0 = Math.max(0, Math.floor(from / step)); i1 = Math.min(n1 - 1, Math.ceil(to / step)); }
      if (i1 <= i0) i1 = Math.min(n1 - 1, i0 + 1);
      let r;
      if (windowed) r = scan(x, y, i0, i1);
      else {
        // tout le parcours : plusieurs passages possibles près du point (boucle, aller-retour) ; on prend le premier passage
        // (premier minimum local de la distance) qui est à moins de 25 m du meilleur
        let bd = Infinity;
        for (let i = 0; i < n1 - 1; i++) {
          const dx = X[i + 1] - X[i], dy = Y[i + 1] - Y[i], l2 = dx * dx + dy * dy;
          let f = l2 > 0 ? ((x - X[i]) * dx + (y - Y[i]) * dy) / l2 : 0;
          f = f < 0 ? 0 : f > 1 ? 1 : f;
          const ex = X[i] + f * dx - x, ey = Y[i] + f * dy - y, d2 = ex * ex + ey * ey;
          D2[i] = d2; FF[i] = f;
          if (d2 < bd) bd = d2;
        }
        const lim = Math.pow(Math.sqrt(bd) + 25, 2), last = n1 - 2;
        r = null;
        for (let i = 0; i <= last; i++) {
          if (D2[i] <= lim && (i === 0 || D2[i] <= D2[i - 1]) && (i === last || D2[i] <= D2[i + 1])) { r = { i, f: FF[i], d2: D2[i] }; break; }
        }
        if (!r) { let bi = 0; for (let i = 1; i <= last; i++) if (D2[i] < D2[bi]) bi = i; r = { i: bi, f: FF[bi], d2: D2[bi] }; }
      }
      return { s: Math.min(L, (r.i + r.f) * step), d: Math.sqrt(r.d2) };
    }
    return { project, length: L };
  }

  /**
   * Suivi de position sur le tracé. update(lat, lng, acc, dt, v) renvoie { ok, s, d, jumped, lost } : la projection est cherchée
   * près de la dernière position connue (le cycliste ne saute pas d'un bout à l'autre du parcours) ; si les fixes s'éloignent
   * du tracé pendant 8 mises à jour de suite, on cherche sur tout le parcours (on a quitté le tracé puis on y revient).
   */
  function createTracker(course) {
    const M = createMatcher(course);
    let s = null, lost = 0;
    return {
      get s() { return s; },
      reset(to) { s = to === undefined ? null : to; lost = 0; },
      update(lat, lng, acc, dt, v) {
        acc = Number.isFinite(acc) && acc > 0 ? acc : 10;
        const tol = Math.max(60, 3 * acc + 25);
        if (s === null) {
          const r = M.project(lat, lng);
          if (r.d > Math.max(150, 3 * acc)) return { ok: false, s: 0, d: r.d, jumped: false, lost: ++lost };
          s = r.s; lost = 0;
          return { ok: true, s, d: r.d, jumped: false, lost: 0 };
        }
        const fwd = Math.min(3000, 60 + (Math.max(v, 3) * 1.6) * Math.max(1, dt) + 2 * acc);
        const r = M.project(lat, lng, s - 30 - acc, s + fwd);
        if (r.d <= tol) { s = r.s; lost = 0; return { ok: true, s, d: r.d, jumped: false, lost: 0 }; }
        lost++;
        if (lost >= 8) {
          const g = M.project(lat, lng);
          if (g.d <= Math.max(80, 3 * acc)) { const jumped = Math.abs(g.s - s) > 150; s = g.s; lost = 0; return { ok: true, s, d: g.d, jumped, lost: 0 }; }
        }
        return { ok: false, s, d: r.d, jumped: false, lost };
      },
    };
  }

  /* ======================================================================
   * Plan : consultable par distance ou par heure
   * ====================================================================== */

  /**
   * Plan consultable. Sources : résultat d'optimizer.optimize (série relative à res.t0) ou plan relu (unpackPlan).
   * s (m), wbal (J) : n + 1 valeurs, P (W) : n valeurs, à partir de l'instant t0 ; length : longueur du parcours ; tFinish : instant
   * d'arrivée (s de la sortie).
   */
  function makePlan(src) {
    const t0 = src.t0 || 0, S = src.s, P = src.P, W = src.wbal, L = src.length;
    const m = S.length - 1;
    const plan = {
      t0, s0: S[0], tFinish: src.tFinish, length: L, s: S, P, wbal: W, n: m,
      /** Instant (s de la sortie) où le plan passe à la distance s. */
      tAt(s) {
        if (s <= S[0]) return t0 - (S[0] - s) / Math.max(2, m > 0 ? S[1] - S[0] : 2);
        if (s >= L) return plan.tFinish;
        let lo = 0, hi = m;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid] <= s) lo = mid; else hi = mid; }
        const d = S[hi] - S[lo];
        return Math.min(plan.tFinish, t0 + lo + (d > 0 ? (s - S[lo]) / d : 0));
      },
      /** Distance (m) où le plan se trouve à l'instant t. */
      sAt(t) {
        const k = t - t0;
        if (k <= 0) return S[0];
        if (k >= m) return S[m];
        const i = Math.floor(k), f = k - i;
        return S[i] + (S[i + 1] - S[i]) * f;
      },
      /** Puissance (W) du plan à la distance s. */
      powerAt(s) { const k = Math.floor(plan.tAt(s) - t0); return P[k < 0 ? 0 : k >= P.length ? P.length - 1 : k] || 0; },
      /** W′bal (J) du plan à la distance s. */
      wbalAt(s) {
        const k = plan.tAt(s) - t0;
        if (k <= 0) return W[0];
        if (k >= m) return W[m];
        const i = Math.floor(k);
        return W[i] + (W[i + 1] - W[i]) * (k - i);
      },
    };
    return plan;
  }

  /**
   * Plan d'un résultat d'optimizer.optimize. ref (facultatif) : { athlete, w } — W′bal du plan recalculé avec cet athlète (w : W′bal
   * de départ en J, W′ plein par défaut), au lieu de celui de l'optimiseur qui suit le profil ajusté à la forme.
   */
  function planFromResult(res, length, ref) {
    const S = res.series;
    const wbal = ref ? PYR.physio.wbalSeries(S.P, S.P.length, ref.athlete, ref.w) : S.wbal;
    return makePlan({ t0: res.t0 || 0, s: S.s, P: S.P, wbal, tFinish: res.tFinish, length });
  }

  /**
   * Tronçons du plan, de sa position de départ à l'arrivée : fenêtres de `window` m regroupées tant que la puissance reste à moins de
   * `tol` W de la moyenne du groupe (au plus `max` tronçons, au moins `minLen` m chacun). Chaque tronçon : { i, a, b (m), P (W moyens),
   * t0, t1 (instants de la sortie), grade (pente moyenne), kmh }.
   */
  function segments(plan, course, opts) {
    const o = Object.assign({ window: 250, tol: 10, max: 40, minLen: 150 }, opts);
    const S = plan.s, P = plan.P, n = P.length, s0 = S[0], L = plan.length;
    const span = L - s0;
    if (!(span > 1) || !n) return [];
    const nb = Math.max(1, Math.ceil(span / o.window));
    const sum = new Float64Array(nb), cnt = new Float64Array(nb);
    for (let k = 0; k < n; k++) {
      const w = Math.min(nb - 1, Math.max(0, Math.floor((S[k] - s0) / o.window)));
      sum[w] += P[k]; cnt[w]++;
    }
    const avg = new Float64Array(nb);
    for (let k = 0; k < nb; k++) avg[k] = cnt[k] ? sum[k] / cnt[k] : k ? avg[k - 1] : P[0] || 0;
    let tol = o.tol, groups;
    for (;;) {
      groups = [];
      let g = null;
      for (let k = 0; k < nb; k++) {
        const c = cnt[k] || 1, sm = cnt[k] ? sum[k] : avg[k];
        if (g && Math.abs(avg[k] - g.sum / g.cnt) <= tol) { g.sum += sm; g.cnt += c; g.end = k + 1; }
        else groups.push(g = { start: k, end: k + 1, sum: sm, cnt: c });
      }
      if (groups.length <= o.max) break;
      tol *= 1.5;
    }
    // tronçons trop courts : fusionnés avec le voisin le plus proche en puissance
    const len = (g) => Math.min(span, g.end * o.window) - g.start * o.window;
    for (;;) {
      let w = -1, wl = o.minLen;
      for (let i = 0; i < groups.length; i++) { const l = len(groups[i]); if (l < wl) { wl = l; w = i; } }
      if (w < 0 || groups.length < 2) break;
      const m = (g) => g.sum / g.cnt;
      const left = w > 0 ? Math.abs(m(groups[w - 1]) - m(groups[w])) : Infinity;
      const right = w < groups.length - 1 ? Math.abs(m(groups[w + 1]) - m(groups[w])) : Infinity;
      const a = left <= right ? w - 1 : w, b = a + 1;
      groups.splice(a, 2, { start: groups[a].start, end: groups[b].end, sum: groups[a].sum + groups[b].sum, cnt: groups[a].cnt + groups[b].cnt });
    }
    return groups.map((g, i) => {
      const a = s0 + g.start * o.window, b = Math.min(L, s0 + g.end * o.window);
      const t0 = plan.tAt(a), t1 = plan.tAt(b);
      const grade = course ? (PYR.course.eleAt(course, b) - PYR.course.eleAt(course, a)) / Math.max(1, b - a) : 0;
      return { i, a, b, P: g.sum / g.cnt, t0, t1, grade, kmh: (b - a) / Math.max(1e-6, t1 - t0) * 3.6 };
    });
  }

  /* ---------- Sauvegarde compacte (séries d'entiers, en différences) ---------- */

  function packDelta(arr, n, scale) {
    const out = new Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) { const q = Math.round(arr[i] * scale); out[i] = q - prev; prev = q; }
    return out;
  }
  function unpackDelta(list, scale, Type, len) {
    const out = new Type(len !== undefined ? len : list.length);
    let acc = 0;
    for (let i = 0; i < list.length; i++) { acc += list[i]; out[i] = acc / scale; }
    return out;
  }

  /** Série de petits entiers en plages : [valeur, longueur, valeur, longueur…] sur les n premières valeurs. */
  function packRuns(arr, n) {
    const out = [];
    for (let i = 0; i < n;) { let j = i + 1; while (j < n && arr[j] === arr[i]) j++; out.push(arr[i], j - i); i = j; }
    return out;
  }
  function unpackRuns(list, n) {
    const out = new Uint8Array(n);
    for (let i = 0, k = 0; i + 1 < list.length && k < n; i += 2) { const v = list[i] | 0, e = Math.min(n, k + (list[i + 1] | 0)); out.fill(v, k, e); k = e; }
    return out;
  }

  /** Plan sous forme de JSON compact. */
  function packPlan(plan) {
    return {
      t0: plan.t0, tF: Math.round(plan.tFinish * 10) / 10, L: Math.round(plan.length * 10) / 10,
      s: packDelta(plan.s, plan.s.length, 10), P: Array.from(plan.P, (x) => Math.round(x)), w: packDelta(plan.wbal, plan.wbal.length, 0.1),
    };
  }
  function unpackPlan(o) {
    if (!o || !Array.isArray(o.s) || !Array.isArray(o.P) || !Array.isArray(o.w) || o.s.length < 2) return null;
    return makePlan({
      t0: o.t0 || 0, s: unpackDelta(o.s, 10, Float32Array), P: Float32Array.from(o.P), wbal: unpackDelta(o.w, 0.1, Float32Array),
      tFinish: o.tF, length: o.L,
    });
  }

  /* ======================================================================
   * Séance
   * ====================================================================== */

  /** Puissance (W) qui explique la vitesse v et l'accélération a à la position s : bilan des forces de sim.js, à l'envers. */
  function estimatePower(ctx, cond, s, t, v, a) {
    PYR.sim.conditions(ctx, s, t, cond);
    const S = ctx.setup, va = v + cond.wh;
    const Fa = 0.5 * cond.rho * S.cda * Math.sqrt(va * va + cond.wc * cond.wc) * va;
    const F = S.massEff * a + Fa + S.mass * G * cond.sinT + cond.crr * S.mass * G * cond.cosT;
    return Math.max(0, F * Math.max(v, 0.5) / S.eta);
  }

  /**
   * Nouvelle séance. o : { course, setup, athlete, mass (kg), plan (obligatoire pour guider), kit ({slots, items}), gut (0–1),
   * tempC, startMs (heure de départ, ms), cfg {gapTau, sens, auto}, physio (carte athlète, metabo.card, à l'échelle de l'athlète du jour :
   * les réserves suivent alors le modèle physiologique) }.
   */
  function createSession(o) {
    const course = o.course, athlete = o.athlete;
    const N = MAX_T + 2;
    const H = new Float64Array(N);
    const Pk = new Float32Array(N), Sk = new Float32Array(N), Vk = new Float32Array(N);
    const LAT = new Float64Array(N), LNG = new Float64Array(N), ELE = new Float32Array(N), HRK = new Uint8Array(N), CAD = new Uint8Array(N);
    const TG = new Uint16Array(N);                       // consigne affichée à chaque seconde (W)
    const OBS = new Uint8Array(N);                       // recalage du modèle physiologique par la FC : 0 non, 1 puissance mesurée, 2 puissance estimée
    const ALT = new Float32Array(N).fill(NaN);           // altitude mesurée (GPS) à chaque seconde, NaN sans mesure
    const WBk = new Float32Array(N), GBk = new Float32Array(N), GSk = new Float32Array(N);   // fin de chaque seconde : W′bal (J), glycogène dépensé depuis le départ (g), glycogène restant (g)
    const kit = Fu.normKit(o.kit || KIT_DEFAULT);
    const cfg = Object.assign({}, DEFAULT_CFG, o.cfg);
    const mass = o.mass > 0 ? o.mass : 72;
    const tempC = Number.isFinite(o.tempC) ? o.tempC : 20;
    const tracker = createTracker(course);
    const cp = athlete.cp, w0 = athlete.w0, recF = athlete.recF;
    let simCtx = null;
    const condBuf = {};
    const getCtx = () => (simCtx = simCtx || (o.setup ? PYR.sim.createContext(course, o.setup, athlete, { smoothRec: true }) : null));
    // modèle physiologique : carte athlète, et son environnement à chaque seconde
    const phyCard = o.physio && PYR.metabo ? o.physio : null;
    const newFuel = (gut) => Fu.create(mass, { slots: kit.slots, items: kit.items, gutTraining: gut || 0, physio: phyCard });
    const pCond = {}, pEnv = {}, pSt = { s: 0, v: 0, t: 0 };
    /** Environnement du modèle physiologique à la seconde k, à la position s et à la vitesse v (météo lue sur le parcours). */
    function phyEnv(k, s, v) {
      if (!phyCard) return undefined;
      const c = getCtx(), sc = Math.min(Math.max(0, s), course.length - 0.01);
      if (c) PYR.sim.conditions(c, sc, k, pCond);
      else { pCond.i = Math.min(course.n - 1, Math.floor(sc / course.step)); pCond.T = tempC; pCond.rh = 50; pCond.wh = 0; pCond.wc = 0; pCond.rain = 0; }
      if (!c || !course.weather) pCond.T = tempC;     // sans météo : la température de la page
      pSt.s = s; pSt.v = v; pSt.t = k;
      return PYR.metabo.envOf(course, pCond, pSt, 0, pEnv);
    }

    const S = {
      course, athlete, cfg, mass, tempC, kit, startMs: o.startMs || Date.now(),
      t: 0, s: 0, v: 0, wbal: w0,
      plan: null, plan0: null, segs: [], planLog: [],
      fuel: newFuel(o.gut),
      physio: phyCard,
      intakes: [],
      gap: 0, gap0: 0, gapRaw: 0, gapM: 0,
      positioned: false, offCourse: false, gpsLost: false, powerLost: false, powerEstimated: false, finished: false,
      replanning: false, replanRequest: null, lastReplanT: 0,
      zone: { i: -2, inT: 0, totT: 0 },                  // temps passé dans le tube de la consigne sur le tronçon en cours
      tenable: null, tenableT: -99, est: null, estT: -1, estAlpha: NaN,
      H, Pk, Sk, Vk, LAT, LNG, ELE, TG,
      lastLat: NaN, lastLng: NaN, lastAlt: NaN, hr: 0, cad: 0,
    };
    let lastFixK = -1, lastPowerK = -1, lastP = 0, noPower = 0, prevMeas = 0, prevMeasK = -1;
    let gapHold = 0, wbalHold = 0, offBack = false;
    const DEV_N = 60;
    const dev = new Float32Array(DEV_N), tgtW = new Float32Array(DEV_N);
    let devN = 0, devI = 0;
    let segI = 0;

    S.setPlan = function (plan, reason) {
      S.plan = plan;
      if (!S.plan0) S.plan0 = plan;
      S.segs = segments(plan, course);
      segI = 0;
      const raw = plan.tAt(S.s) - S.t;
      S.gapRaw = raw; S.gap = raw; S.gapM = S.s - plan.sAt(S.t);
      S.zone = { i: -2, inT: 0, totT: 0 };
      S.lastReplanT = S.t; gapHold = 0; wbalHold = 0; devN = 0; devI = 0; S.replanRequest = null;
      S.planLog.push({ t: S.t, s: S.s, reason: reason || 'plan', tFinish: plan.tFinish });
    };

    /** Tronçon contenant la distance s. */
    function segmentIndex(s) {
      const sg = S.segs;
      if (!sg.length) return -1;
      while (segI > 0 && s < sg[segI].a) segI--;
      while (segI < sg.length - 1 && s >= sg[segI].b) segI++;
      return segI;
    }

    /**
     * Une seconde de sortie. inp : { power (W mesurés, ou undefined), hr, cad (tr/min), sensorOn (le capteur de puissance est connecté : certains ne
     * transmettent rien quand on ne pédale pas, ce silence est alors de la roue libre et non une panne), estimate (W estimés),
     * fix: {lat, lng, acc, speed, alt, age} | null }.
     */
    S.step = function (inp) {
      inp = inp || {};
      if (S.t >= MAX_T || S.finished) return;
      const k = S.t;
      // --- puissance : mesurée, sinon estimée d'après la vitesse, sinon la dernière valeur (3 s au plus)
      let P = Number(inp.power);
      S.powerEstimated = false;
      if (!(P >= 0)) {
        noPower++;
        if (Number.isFinite(inp.estimate) && inp.estimate >= 0) { P = inp.estimate; S.powerEstimated = true; }
        else P = k - lastPowerK <= 2 ? lastP : 0;
      } else { noPower = 0; lastPowerK = k; lastP = P; }
      S.powerLost = noPower > 5 && !S.powerEstimated && !inp.sensorOn;
      P = P > MAX_P ? MAX_P : P;
      const hrOk = Number.isFinite(inp.hr) && inp.hr > 0;     // une FC reçue pendant la seconde (S.hr garde la dernière)
      if (hrOk) S.hr = inp.hr;
      S.cad = Number.isFinite(inp.cad) && inp.cad > 0 ? Math.min(250, inp.cad) : 0;

      // --- position : projection du point GPS puis filtre α-β (l'état est celui de la fin de la seconde)
      const fix = inp.fix;
      const pred = S.s + S.v;
      let got = false;
      if (fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lng)) {
        const r = tracker.update(fix.lat, fix.lng, fix.acc, Math.max(1, k + 1 - lastFixK), S.v);
        S.lastLat = fix.lat; S.lastLng = fix.lng; S.lastAlt = Number.isFinite(fix.alt) ? fix.alt : S.lastAlt;
        if (r.ok) {
          got = true;
          lastFixK = k + 1;
          if (S.offCourse) { S.offCourse = false; offBack = true; }   // retour sur le tracé : le plan ne correspond plus à ce qui a été roulé
          // le point GPS date de fix.age secondes (son horodatage est avant la fin de la seconde) : on le ramène à l'instant de l'état
          const age = Number.isFinite(fix.age) ? Math.min(2.5, Math.max(0, fix.age)) : 0;
          const meas = Math.min(course.length, r.s + S.v * age);
          // vitesse mesurée : celle du GPS, sinon d'après deux positions successives
          let vm = Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : NaN;
          if (!Number.isFinite(vm) && prevMeasK >= 0 && k + 1 - prevMeasK > 0 && k + 1 - prevMeasK <= 4) vm = Math.max(0, (meas - prevMeas) / (k + 1 - prevMeasK));
          prevMeas = meas; prevMeasK = k + 1;
          if (!S.positioned || r.jumped || Math.abs(meas - pred) > 150) { S.s = meas; if (!S.positioned) S.v = Number.isFinite(vm) ? vm : 0; S.positioned = true; }
          else {
            const innov = meas - pred;
            S.s = pred + 0.4 * innov;
            S.v += 0.08 * innov;
            if (Number.isFinite(vm)) S.v += 0.3 * (vm - S.v);
          }
        } else if (r.lost >= 5 && r.d > 150) S.offCourse = true;
      }
      if (!got) S.s = pred;                           // navigation à l'estime
      if (S.v < 0) S.v = 0; else if (S.v > 30) S.v = 30;
      if (S.s < 0) S.s = 0;
      S.gpsLost = k + 1 - lastFixK > 10 && S.positioned;
      if (S.gpsLost) S.v *= 0.97;
      if (S.s >= course.length - 15) { S.s = Math.min(S.s, course.length); S.finished = true; }

      // --- enregistrement
      Pk[k] = P; H[k + 1] = H[k] + P;
      Sk[k] = S.s; Vk[k] = S.v; HRK[k] = S.hr; CAD[k] = S.cad;
      // trace enregistrée : le point GPS tel quel, sinon la position estimée sur le tracé
      const ll = fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lng) ? [fix.lat, fix.lng] : PYR.course.latLngAt(course, S.s);
      LAT[k] = ll[0]; LNG[k] = ll[1];
      ELE[k] = got && Number.isFinite(fix.alt) ? fix.alt : PYR.course.eleAt(course, S.s);
      if (fix && Number.isFinite(fix.alt)) ALT[k] = fix.alt;      // même hors tracé : l'altitude GPS ne dépend pas du rattachement au parcours

      // --- réserves
      S.wbal = PYR.physio.wbalStep(S.wbal, P, cp, w0, 1, recF);
      for (const it of S.intakes) if (it.t === k && !it.done) { it.done = true; applyIntake(it); }
      Fu.step(S.fuel, P, cp, tempC, phyEnv(k, S.s, S.v));
      // recalage par la FC de la ceinture, si la puissance de la seconde est connue (mesurée, estimée, ou roue libre capteur allumé) ;
      // la FC enregistrée (HRK, au bpm) sert, pour que la reprise rejoue exactement le même recalage
      OBS[k] = phyCard && hrOk && (noPower === 0 || S.powerEstimated || inp.sensorOn) ? (S.powerEstimated ? 2 : 1) : 0;
      if (OBS[k]) Fu.observeHR(S.fuel, HRK[k], { estimated: OBS[k] === 2 });
      WBk[k] = S.wbal; GBk[k] = S.fuel.burned; GSk[k] = S.fuel.G;
      S.t = k + 1;

      // --- écart au plan
      const plan = S.plan;
      if (plan) {
        const a = 1 - Math.exp(-1 / Math.max(1, cfg.gapTau));
        S.gapRaw = plan.tAt(S.s) - S.t;
        S.gap += (S.gapRaw - S.gap) * a;
        S.gapM += ((S.s - plan.sAt(S.t)) - S.gapM) * a;
        if (S.plan0 && S.plan0 !== plan) S.gap0 += ((S.plan0.tAt(S.s) - S.t) - S.gap0) * a;
        else S.gap0 = S.gap;
        const i = segmentIndex(S.s);
        const target = i >= 0 ? Math.round(S.segs[i].P / 5) * 5 : 0;
        TG[k] = target;
        const z = S.zone;
        if (z.i !== i) { z.i = i; z.inT = 0; z.totT = 0; }
        z.totT++;
        if (inZone(avgLast(TRAJ_AVG), smoothTarget(target))) z.inT++;
        dev[devI] = P - target; tgtW[devI] = target; devI = (devI + 1) % DEV_N; if (devN < DEV_N) devN++;
        evalTriggers();
      }
    };

    /** Faut-il recalculer le plan ? Pose S.replanRequest = { reason, t } (l'interface le lit avec takeReplanRequest). */
    function evalTriggers() {
      if (S.replanRequest || S.replanning || !S.plan || course.length - S.s < 400) return;   // près de l'arrivée, rien à optimiser
      const sens = SENS[cfg.sens] || SENS.normal;
      gapHold = Math.abs(S.gap) > sens.gapSec ? gapHold + 1 : 0;
      const wDev = Math.abs(S.wbal - S.plan.wbalAt(S.s)) / w0;
      wbalHold = wDev > sens.wbalPct ? wbalHold + 1 : 0;
      if (offBack && cfg.auto) { offBack = false; S.replanRequest = { reason: 'retour sur le tracé', t: S.t }; return; }
      offBack = false;
      if (!cfg.auto || S.t < 30 || S.t - S.lastReplanT < sens.minInterval || S.v < 1 || S.offCourse || S.gpsLost) return;
      let reason = null;
      if (gapHold >= sens.hold) reason = S.gap > 0 ? `en avance de ${Math.round(S.gap)} s` : `en retard de ${Math.round(-S.gap)} s`;
      else if (wbalHold >= sens.hold) reason = S.wbal < S.plan.wbalAt(S.s) ? 'W′ plus bas que prévu' : 'W′ plus haut que prévu';
      else if (devN >= 40) {
        let d = 0, g = 0;
        for (let q = 0; q < devN; q++) { d += dev[q]; g += tgtW[q]; }
        d /= devN; g /= devN;
        if (g > 20 && Math.abs(d) > Math.max(10, sens.powerPct * g)) reason = d > 0 ? `${Math.round(d)} W au-dessus de la consigne` : `${Math.round(-d)} W sous la consigne`;
      }
      if (reason) S.replanRequest = { reason, t: S.t };
    }

    /** L'interface prend la demande de recalcul (une seule fois). */
    S.takeReplanRequest = function () { const r = S.replanRequest; S.replanRequest = null; return r; };
    /** Demande manuelle. */
    S.requestReplan = function (reason) { S.replanRequest = { reason: reason || 'à la demande', t: S.t }; };

    /** État de départ de l'optimiseur : la sortie telle qu'elle est, passé figé. */
    S.startState = function () { return { t: S.t, s: S.s, v: S.v, wbal: S.wbal, hist: H }; };

    /** Entrée de l'optimiseur pour la suite du parcours (base : buildInputs de la page Pacing optimal). */
    /** La météo du parcours vient d'être remplacée (course.weather) : les calculs mis en cache en tiennent compte à la prochaine lecture. */
    S.weatherChanged = function () { simCtx = null; S.estT = -1; S.tenableT = -99; };
    // wScale : rapport entre le W′ de l'optimiseur (ajusté à la forme) et celui que suit la séance (profil de l'athlète) ; 1 si ce sont les mêmes
    S.replanInput = function (base, wScale) {
      // fringale ou déshydratation (modèle physiologique : glycogène, fatigue des fibres, chaleur, eau…) : la capacité baisse
      const fc = Math.min(1, Fu.factor(S.fuel)), fw = Math.min(1, Fu.wFactor(S.fuel));
      // modèle physiologique : ses facteurs comptent déjà la chaleur du moment, on repart de l'athlète sans la chaleur moyenne du plan
      let athleteIn = phyCard && base.athleteFresh ? base.athleteFresh : base.athlete;
      if (fc < 0.995 || fw < 0.995) athleteIn = PYR.physio.scaleAthlete(athleteIn, fc, fw);
      const start = S.startState();
      if (wScale > 0 && wScale !== 1) start.wbal *= wScale;
      return Object.assign({}, base, { athlete: athleteIn, start, algo: 'analytic', v0: S.v });
    };

    /* ---------- nourriture et boisson ---------- */
    function applyIntake(it) {
      const f = S.fuel;
      if (it.type === 'eat') { f.items[it.kind] = Math.max(1, f.items[it.kind] || 0); f.lastEat = -1e9; Fu.eat(f, it.t, it.kind, true); }
      else { f.lastDrink = -1e9; if (it.fill) f.bottles[it.idx] = f.cont[it.idx].cap; else Fu.drink(f, it.t, it.idx); }
    }
    /** Le cycliste vient de manger (gel, barre…). Renvoie le nom de l'aliment. */
    S.eat = function (kind) {
      if (!Fu.FOODS[kind]) return null;
      const it = { t: S.t, type: 'eat', kind };
      S.intakes.push(it); it.done = true; applyIntake(it);
      return Fu.FOODS[kind].label;
    };
    /** Une gorgée (150 mL) au contenant idx (le premier non vide par défaut). Renvoie le volume bu (L). */
    S.drink = function (idx) {
      const f = S.fuel;
      const i = idx === undefined || idx === null ? f.bottles.findIndex((b) => b > 0.001) : idx;
      if (i < 0 || !f.cont[i] || !(f.bottles[i] > 0.001)) return 0;
      const before = f.bottles[i];
      const it = { t: S.t, type: 'drink', idx: i };
      S.intakes.push(it); it.done = true; applyIntake(it);
      return before - f.bottles[i];
    };
    /** Remplissage d'un bidon (ou de tous) à un ravitaillement. */
    S.refill = function (idx) {
      const f = S.fuel;
      const list = idx === undefined || idx === null ? f.cont.map((c, i) => i) : [idx];
      for (const i of list) { const it = { t: S.t, type: 'drink', idx: i, fill: true }; S.intakes.push(it); it.done = true; applyIntake(it); }
    };
    /** Un aliment de plus dans les poches (reçu en route). */
    S.addFood = function (kind, n) { if (Fu.FOODS[kind]) S.fuel.items[kind] = (S.fuel.items[kind] || 0) + (n || 1); };

    /* ---------- ce qu'il faut montrer ---------- */
    /** Durée (s) de la moyenne de la puissance affichée : réglage cfg.powerAvg (1 = instantanée, jusqu'à 60 s). */
    function dispWin() { return Math.min(60, Math.max(1, Math.round(Number(cfg.powerAvg) || 3))); }
    function avgLast(n) {
      const t = S.t;
      if (t <= 0) return 0;
      const m = Math.min(n, t);
      return (H[t] - H[t - m]) / m;
    }
    /**
     * Consigne lissée : moyenne sur TRAJ_AVG s de la consigne des tronçons parcourus (la consigne en cours `cur` et celle des secondes
     * précédentes), comme la puissance suivie ; à un changement de tronçon elle glisse donc de l'ancienne à la nouvelle en TRAJ_AVG s.
     */
    function smoothTarget(cur) {
      let sum = cur, n = 1;
      for (let j = 2; j <= TRAJ_AVG; j++) if (S.t - j >= 0) { sum += TG[S.t - j]; n++; }
      return Math.round(sum / n);
    }
    /** La puissance (moyenne 3 s) est-elle dans le tube de la consigne ? Roue libre : jusqu'à 40 W. */
    function inZone(p3, target) { return target < 15 ? p3 <= 40 : Math.abs(p3 - target) <= Math.max(MIN_TOL, TOL_FRAC * target); }

    /**
     * Consigne et situation. Renvoie null sans plan. cue : 'ok' | 'over' | 'under' | 'way_over' | 'way_under' | 'coast'.
     */
    S.guidance = function () {
      const plan = S.plan;
      if (!plan) return null;
      const i = segmentIndex(S.s), seg = i >= 0 ? S.segs[i] : null, next = i >= 0 && i + 1 < S.segs.length ? S.segs[i + 1] : null;
      const target = smoothTarget(seg ? Math.round(seg.P / 5) * 5 : 0);      // consigne lissée sur 3 s aux changements de tronçon
      const p3 = avgLast(TRAJ_AVG), p10 = avgLast(10), p30 = avgLast(30);
      const dispN = dispWin(), pDisp = avgLast(dispN);     // puissance affichée dans le HUD (réglage) ; le suivi du tube reste sur 3 s
      const tol = Math.max(MIN_TOL, TOL_FRAC * target);
      const diff = p3 - target;
      const zn = S.zone.i === i && S.zone.totT > 0 ? S.zone : null;
      let cue = 'ok';
      if (target < 15) cue = p3 > 40 ? 'over' : 'coast';
      else if (diff > 2.5 * tol) cue = 'way_over';
      else if (diff > tol) cue = 'over';
      else if (diff < -2.5 * tol) cue = 'way_under';
      else if (diff < -tol) cue = 'under';
      const toEnd = seg ? seg.b - S.s : 0;
      const kmhPlan = seg ? seg.kmh / 3.6 : 8;
      const remainPlanT = plan.tFinish - plan.tAt(S.s);
      const finishProj = S.t + remainPlanT;
      const fu = S.fuel, st = Fu.status(fu);
      // durée tenable à la puissance actuelle (coûteux : toutes les 3 s)
      if (S.t - S.tenableT >= 3 && p3 > 0) {
        const c = getCtx();
        if (c) { try { S.tenable = PYR.sim.timeToExhaustion(c, { t: S.t, hist: H, wbal: S.wbal, capK: 1 }, p3, 6 * 3600); } catch (e) { S.tenable = null; } }
        S.tenableT = S.t;
      }
      // puissance moyenne estimée sur 30 s (une fois par seconde, ou si alpha change)
      const alpha = S.altAlpha();
      if (S.estT !== S.t || S.estAlpha !== alpha) {
        try { S.est = S.estimateMean(alpha, EST_WIN); } catch (e) { S.est = null; }
        S.estT = S.t; S.estAlpha = alpha;
      }
      return {
        est30: S.est, p30meas: avgLast(EST_WIN), altForced: S.offCourse,
        // puissance affichée : moyenne sur cfg.powerAvg s (1 = instantanée, jusqu'à 60 s)
        pDispN: dispN, pDisp,
        t: S.t, s: S.s, v: S.v, remaining: course.length - S.s,
        seg, segIndex: i, segCount: S.segs.length, next, target, tol, cue,
        band: [Math.max(0, target - tol), target + tol],
        p3, p10, p30, diff, cad: S.cad, zonePct: zn ? zn.inT / zn.totT : null, zoneT: zn ? zn.totT : 0,
        toSegEnd: toEnd, segTimeLeft: toEnd / Math.max(1, S.v > 1.5 ? S.v : kmhPlan),
        gap: S.gap, gapRaw: S.gapRaw, gapM: S.gapM, gap0: S.gap0,
        finishProj, remainPlanT, finishPlan0: S.plan0 ? S.plan0.tFinish : plan.tFinish, finishDelta0: S.plan0 ? finishProj - S.plan0.tFinish : 0,
        wbal: S.wbal, wbalFrac: S.wbal / w0, wbalPlanFrac: plan.wbalAt(S.s) / w0, w0,
        energy: st.energy, hydration: st.hydration, lossPct: st.lossPct, bonk: st.bonk, trend: st.trend, gut: st.gut, absorbing: st.absorbing,
        timeToBonk: Fu.timeToBonk(fu, Math.max(p10, 50), cp), fuelStatus: st,
        tenable: S.tenable,
        offCourse: S.offCourse, gpsLost: S.gpsLost, powerLost: S.powerLost, powerEstimated: S.powerEstimated, finished: S.finished,
        replanning: S.replanning, grade: PYR.course ? course.grade[Math.min(course.n - 1, Math.max(0, Math.floor(S.s / course.step)))] : 0,
      };
    };

    /**
     * Trajectoire de puissance : le passé récent (`past` s, mesures brutes, moyenne glissante sur TRAJ_AVG s et consigne lissée sur TRAJ_AVG s en vigueur à
     * chaque seconde) et la consigne des `ahead` prochaines secondes d'après les tronçons (vitesse actuelle, ramenée à celle du plan).
     * Le tube est consigne ± max(MIN_TOL, TOL_FRAC × consigne). avg[n − 1] vaut guidance().p3 ; ahead[0] est la consigne de la seconde à
     * venir. Les séries du passé se terminent à l'instant courant t. Renvoie null sans plan.
     */
    S.trajectory = function (past, ahead) {
      const plan = S.plan;
      if (!plan) return null;
      const t = S.t, n = Math.max(0, Math.min(past, t));
      const raw = new Float32Array(n), avg = new Float32Array(n), tgt = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        const k = t - n + j, m = Math.min(TRAJ_AVG, k + 1);
        let ts = 0, tn = 0;
        for (let q = Math.max(0, k - TRAJ_AVG + 1); q <= k; q++) { ts += TG[q]; tn++; }
        raw[j] = Pk[k]; avg[j] = (H[k + 1] - H[k + 1 - m]) / m; tgt[j] = Math.round(ts / tn);
      }
      const fut = new Float32Array(ahead), i0 = segmentIndex(S.s);
      if (i0 >= 0) {
        const sg = S.segs, vPlan = Math.max(1, sg[i0].kmh / 3.6), vNow = S.v > 1.5 ? S.v : vPlan;
        const kf = Math.max(0.5, Math.min(2, vNow / vPlan));
        let si = i0, end = (sg[i0].b - S.s) / vNow;                 // instant (s d'ici) où l'on quitte le tronçon si
        for (let j = 0; j < ahead; j++) {
          while (j + 0.5 >= end && si < sg.length - 1) { si++; end += (sg[si].b - sg[si].a) / Math.max(1, sg[si].kmh / 3.6 * kf); }
          fut[j] = Math.round(sg[si].P / 5) * 5;
        }
      }
      return { t, n, raw, avg, tgt, ahead: fut, tolFrac: TOL_FRAC, minTol: MIN_TOL };
    };

    /**
     * Puissance moyenne (W) sur les `win` dernières secondes, déduite de la vitesse et du bilan d'énergie à la roue : traînée (vent et
     * densité de l'air de la météo à chaque position et seconde), roulement, énergie cinétique, et dénivelée. La dénivelée mélange deux
     * sources : celle des altitudes mesurées (début et fin de fenêtre moyennés, GPS bruité) avec le poids alpha, et celle du tracé précalculé
     * (altitude corrigée) avec le poids 1 − alpha. Sans mesure d'altitude exploitable, tout le poids va au tracé.
     * Renvoie null s'il manque la physique du vélo ou moins de 10 s de sortie, sinon
     * { P, n, alpha (poids réellement utilisé), dh, dhMeas (NaN sans mesure), dhCourse, aero, roll, grav, kin (J à la roue, sur la fenêtre) }.
     * Un bilan négatif (longue descente freinée) donne 0 W : le frein ne laisse pas de trace.
     */
    S.estimateMean = function (alpha, win) {
      const c = getCtx(), t = S.t, n = Math.min(win > 0 ? Math.floor(win) : EST_WIN, t);
      if (!c || n < 10) return null;
      const k0 = t - n, st = c.setup;
      let aero = 0, roll = 0;
      for (let k = k0; k < t; k++) {
        PYR.sim.conditions(c, Sk[k], k, condBuf);
        const v = Vk[k], va = v + condBuf.wh;
        aero += 0.5 * condBuf.rho * st.cda * Math.sqrt(va * va + condBuf.wc * condBuf.wc) * va * v;
        roll += condBuf.crr * st.mass * G * condBuf.cosT * v;
      }
      const sA = k0 > 0 ? Sk[k0 - 1] : Sk[0], sB = Sk[t - 1], v0 = k0 > 0 ? Vk[k0 - 1] : Vk[0], v1 = Vk[t - 1];
      const dhCourse = PYR.course.eleAt(course, sB) - PYR.course.eleAt(course, sA);
      // altitude mesurée : moyenne des quelques premières et dernières mesures de la fenêtre (le GPS est bruité)
      const m = Math.max(3, Math.round(n / 6));
      const mean = (a, b) => { let s = 0, q = 0; for (let k = a; k < b; k++) if (ALT[k] === ALT[k]) { s += ALT[k]; q++; } return q >= 2 ? s / q : NaN; };
      // les centres des deux moyennes sont distants de n − m s : on ramène à la fenêtre entière en supposant la pente constante
      const hA = mean(k0, k0 + m), hB = mean(t - m, t), dhMeas = (hB - hA) * n / (n - m);
      const a = Number.isFinite(dhMeas) ? Math.max(0, Math.min(1, Number(alpha) || 0)) : 0;
      const dh = a * (Number.isFinite(dhMeas) ? dhMeas : 0) + (1 - a) * dhCourse;
      const grav = st.mass * G * dh, kin = 0.5 * st.massEff * (v1 * v1 - v0 * v0);
      const P = Math.max(0, (aero + roll + grav + kin) / st.eta / n);
      return { P, n, alpha: a, dh, dhMeas, dhCourse, aero, roll, grav, kin };
    };

    /** Part de l'altitude mesurée dans l'estimation : le réglage, mais 100 % hors parcours (l'altitude du tracé n'y dit plus rien). */
    S.altAlpha = function () { return S.offCourse ? 1 : cfg.altAlpha; };

    /**
     * Puissance estimée à la position courante (capteur absent) : accélération sur 5 s, vitesse lissée, pente du tracé. Quand des altitudes
     * mesurées existent et que cfg.altAlpha > 0, on y ajoute ce que la dénivelée mesurée change à l'estimation sur 30 s (estimateMean avec
     * alpha moins estimateMean sans) : l'estimation reste réactive et sa pente suit en partie ce qui est réellement grimpé.
     */
    S.estimate = function (vNow) {
      const c = getCtx();
      if (!c || S.t < 6) return NaN;
      const a = (Vk[S.t - 1] - Vk[S.t - 6]) / 5;
      const base = estimatePower(c, condBuf, S.s, S.t, Number.isFinite(vNow) ? vNow : S.v, a);
      const alpha = S.altAlpha();
      if (!(alpha > 0)) return base;
      const mA = S.estimateMean(alpha, EST_WIN);
      if (!mA || !(mA.alpha > 0)) return base;
      const m0 = S.estimateMean(0, EST_WIN);
      return Math.max(0, base + mA.P - m0.P);
    };

    /* ---------- sauvegarde / reprise ---------- */
    S.pack = function () {
      const n = S.t;
      return {
        v: 1, startMs: S.startMs, t: n, cfg, kit: { slots: kit.slots, items: kit.items }, mass, tempC, gut: S.fuel.train,
        P: Array.from(Pk.subarray(0, n), (x) => Math.round(x)), S: packDelta(Sk, n, 10), V: packDelta(Vk, n, 100),
        lat: packDelta(LAT, n, 1e6), lng: packDelta(LNG, n, 1e6), ele: packDelta(ELE, n, 10), llK: 1e6, eleK: 10,   // 0,1 m ; anciennes sauvegardes : 1e5 et 1
        hr: Array.from(HRK.subarray(0, n)), cad: Array.from(CAD.subarray(0, n)), obs: packRuns(OBS, n),
        intakes: S.intakes.map((x) => ({ t: x.t, type: x.type, kind: x.kind, idx: x.idx, fill: x.fill ? 1 : undefined })),
        plan: S.plan ? packPlan(S.plan) : null, plan0: S.plan0 && S.plan0 !== S.plan ? packPlan(S.plan0) : null, planLog: S.planLog,
        lastReplanT: S.lastReplanT, positioned: S.positioned,
      };
    };

    /** Reprend une séance enregistrée (S.pack) : les réserves sont recalculées en rejouant les secondes et les prises. */
    S.restore = function (d) {
      if (!d || d.v !== 1) return false;
      const n = Math.min(d.t, MAX_T);
      const P = d.P, s = unpackDelta(d.S, 10, Float32Array), v = unpackDelta(d.V, 100, Float32Array);
      const la = unpackDelta(d.lat, d.llK || 1e5, Float64Array), lo = unpackDelta(d.lng, d.llK || 1e5, Float64Array), el = unpackDelta(d.ele, d.eleK || 1, Float32Array);
      const hrs = Array.isArray(d.hr) ? d.hr : null, cads = Array.isArray(d.cad) ? d.cad : null;
      // secondes recalées par la FC ; sauvegardes plus anciennes que le recalage : toutes celles qui ont une FC
      const obs = Array.isArray(d.obs) ? unpackRuns(d.obs, n) : null;
      S.startMs = d.startMs;
      S.intakes = (d.intakes || []).map((x) => Object.assign({}, x, { fill: !!x.fill, done: false }));
      S.fuel = newFuel(d.gut);
      S.wbal = w0; S.t = 0;
      for (let k = 0; k < n; k++) {
        Pk[k] = P[k]; H[k + 1] = H[k] + P[k]; Sk[k] = s[k]; Vk[k] = v[k]; LAT[k] = la[k]; LNG[k] = lo[k]; ELE[k] = el[k];
        S.wbal = PYR.physio.wbalStep(S.wbal, P[k], cp, w0, 1, recF);
        for (const it of S.intakes) if (it.t === k && !it.done) { it.done = true; applyIntake(it); }
        Fu.step(S.fuel, P[k], cp, tempC, phyEnv(k, s[k], v[k]));
        if (hrs) HRK[k] = hrs[k] || 0;
        OBS[k] = !phyCard ? 0 : obs ? obs[k] : HRK[k] > 0 ? 1 : 0;
        if (OBS[k]) Fu.observeHR(S.fuel, HRK[k], { estimated: OBS[k] === 2 });
        WBk[k] = S.wbal; GBk[k] = S.fuel.burned; GSk[k] = S.fuel.G;
        if (cads) CAD[k] = cads[k] || 0;
      }
      S.t = n;
      if (n) { S.s = s[n - 1]; S.v = v[n - 1]; S.lastLat = la[n - 1]; S.lastLng = lo[n - 1]; }
      for (const it of S.intakes) it.done = true;
      S.positioned = !!d.positioned;
      tracker.reset(S.positioned ? S.s : undefined);
      lastFixK = n; lastPowerK = n - 1; noPower = 0;
      S.plan0 = d.plan0 ? unpackPlan(d.plan0) : null;
      const pl = d.plan ? unpackPlan(d.plan) : null;
      if (pl) { if (!S.plan0) S.plan0 = pl; S.setPlan(pl, 'reprise'); S.lastReplanT = d.lastReplanT || S.t;
        const i0 = segmentIndex(S.s);
        for (let k = Math.max(0, n - TRAJ_AVG); k < n; k++) TG[k] = i0 >= 0 ? Math.round(S.segs[i0].P / 5) * 5 : 0;   // la consigne lissée repart de celle du tronçon
      }
      S.planLog = d.planLog || S.planLog;
      return true;
    };

    /** Traces de la sortie (pour l'export et les graphiques). */
    S.track = function () {
      const n = S.t;
      return {
        n, P: Pk.subarray(0, n), s: Sk.subarray(0, n), v: Vk.subarray(0, n), lat: LAT.subarray(0, n), lng: LNG.subarray(0, n), ele: ELE.subarray(0, n),
        target: TG.subarray(0, n), hr: HRK.subarray(0, n), cad: CAD.subarray(0, n),
        wbal: WBk.subarray(0, n), gBurned: GBk.subarray(0, n), gStock: GSk.subarray(0, n), w0, g0: S.fuel.G0,
      };
    };

    /**
     * Instant (s de la sortie) où le cycliste a atteint la distance s sur le tracé, interpolé ; null s'il n'y est pas encore. Sk[k] est la
     * position à la fin de la seconde k, donc à l'instant k + 1. Avant le premier point, on suppose un départ à 0 m à l'instant 0.
     */
    S.timeAt = function (s) {
      const n = S.t;
      if (n < 1 || !(Sk[n - 1] >= s)) return null;
      if (s <= Sk[0]) return Sk[0] > 0 ? Math.max(0, s) / Sk[0] : 1;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (Sk[m] < s) lo = m; else hi = m; }
      const span = Sk[hi] - Sk[lo];
      return lo + 1 + (span > 0 ? (s - Sk[lo]) / span : 1) * (hi - lo);
    };

    S.getCtx = getCtx;
    return S;
  }

  /* ======================================================================
   * Export GPX de la sortie réalisée
   * ====================================================================== */
  /** GPX de la sortie (voir activity-export.js, qui écrit aussi les formats FIT, TCX et CSV). */
  function toGpx(sess, name) { return PYR.activityExport.gpx(sess, name); }

  /* ======================================================================
   * Cycliste de démonstration (essai sans capteur, et tests)
   * ====================================================================== */

  /**
   * Un cycliste simulé qui roule sur le parcours en suivant (plus ou moins bien) la consigne. o : { course, setup, athlete, seed,
   * noise (part de bruit sur la puissance, 0,04), gps (écart type du GPS, m, 3) }. step(target) → { power, fix, s, v }.
   * mood(delta, secondes) : écart durable à la consigne (coup de mou −0,2 ; attaque +0,3).
   */
  function createDemo(o) {
    const ctx = PYR.sim.createContext(o.course, o.setup, o.athlete, { smoothRec: true });
    const st = PYR.sim.initState(ctx, 0);
    const rnd = U.mulberry32(o.seed || 7);
    const gauss = () => { let a = 0; for (let i = 0; i < 6; i++) a += rnd(); return (a - 3) / Math.sqrt(0.5); };
    const noise = o.noise === undefined ? 0.04 : o.noise, gpsSd = o.gps === undefined ? 3 : o.gps;
    const cond = {};
    let bias = o.bias || 0, moodDelta = 0, moodLeft = 0;
    const D = {
      st, ctx,
      setBias(b) { bias = b; },
      mood(delta, sec) { moodDelta = delta; moodLeft = sec; },
      step(target) {
        if (st.finished) return { power: 0, fix: null, s: st.s, v: 0, done: true };
        PYR.sim.conditions(ctx, st.s, st.t, cond);
        const b = (moodLeft > 0 ? moodDelta : 0) + bias;
        if (moodLeft > 0) moodLeft--;
        const cmd = target < 15 ? 0 : Math.max(0, target * (1 + b + noise * gauss()));
        const P = PYR.sim.step(ctx, st, st.v > cond.vlim - 0.3 ? 0 : cmd, cond);
        const ll = PYR.course.latLngAt(o.course, Math.min(st.s, o.course.length));
        const dLat = gpsSd * gauss() / R_DEG, dLng = gpsSd * gauss() / (R_DEG * Math.cos(U.toRad(ll[0])));
        return {
          power: Math.round(P), s: st.s, v: st.v, done: st.finished,
          fix: { lat: ll[0] + dLat, lng: ll[1] + dLng, acc: 4, speed: Math.max(0, st.v + 0.15 * gauss()), alt: PYR.course.eleAt(o.course, st.s) },
        };
      },
    };
    return D;
  }

  PYR.ride = {
    SENS, DEFAULT_CFG, KIT_DEFAULT, MAX_T,
    createMatcher, createTracker, makePlan, planFromResult, segments, packPlan, unpackPlan, packDelta, unpackDelta, packRuns, unpackRuns,
    createSession, estimatePower, toGpx, createDemo,
  };
})(globalThis.PYR = globalThis.PYR || {});
