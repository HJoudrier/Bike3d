/* author : Hugo Joudrier-Faure */
/* PaceYourRide — modèle physiologique du cycliste :
 * courbe de puissance record (MMP), puissance critique (PC / CP), W′ (≈ HIE), FTP, W′bal. */
(function (PYR) {
  'use strict';

  /** Durées de la courbe de puissance record (secondes). */
  const DURATIONS = [1, 5, 10, 15, 30, 45, 60, 120, 180, 240, 300, 600, 900, 1200,
    1800, 2700, 3600, 5400, 7200, 9000, 10800, 14400, 18000];

  /** Profil « type » d'un cycliste amateur entraîné, relatif à la FTP (≈ puissance 60 min). */
  const FTP_RATIOS = [4.6, 4.2, 3.8, 3.4, 2.6, 2.2, 1.95, 1.6, 1.45, 1.36, 1.3, 1.18, 1.12, 1.08,
    1.05, 1.02, 1.0, 0.95, 0.91, 0.88, 0.85, 0.8, 0.76];

  function durationLabel(d) {
    if (d <= 60) return d + ' s';
    return (d / 60) + ' min';
  }

  function logInterp(d, d0, p0, d1, p1) {
    const t = Math.log(d / d0) / Math.log(d1 / d0);
    return Math.exp(Math.log(p0) + t * (Math.log(p1) - Math.log(p0)));
  }

  /** Ratio type (× FTP) pour une durée quelconque — interpolation log-log, extrapolation au-delà de 5 h. */
  function templateRatio(d) {
    const n = DURATIONS.length;
    if (d <= DURATIONS[0]) return FTP_RATIOS[0];
    if (d >= DURATIONS[n - 1]) return FTP_RATIOS[n - 1] * Math.pow(d / DURATIONS[n - 1], -0.15);
    for (let i = 1; i < n; i++) {
      if (d <= DURATIONS[i]) return logInterp(d, DURATIONS[i - 1], FTP_RATIOS[i - 1], DURATIONS[i], FTP_RATIOS[i]);
    }
    return FTP_RATIOS[n - 1];
  }

  function curveFromFtp(ftp) {
    const c = {};
    DURATIONS.forEach((d, i) => { c[d] = Math.round(ftp * FTP_RATIOS[i]); });
    return c;
  }

  /**
   * Courbe MMP complète à partir des records saisis ({durée: W}).
   * - les records manquants sont interpolés (log-log) ;
   * - hors des records, on prolonge avec la forme du profil type ;
   * - la FTP sert d'ancre à 60 min si aucun record ≥ 45 min n'est saisi ;
   * - monotonie imposée : un record plus long ne peut dépasser un plus court.
   */
  function buildCurve(records, ftp) {
    records = records || {};
    const pts = [];
    for (const d of DURATIONS) {
      const p = Number(records[d]);
      if (p > 0 && isFinite(p)) pts.push({ d, p, user: true });
    }
    if (ftp > 0 && !pts.some((q) => q.d >= 2700)) {
      pts.push({ d: 3600, p: ftp, user: false });
      pts.sort((a, b) => a.d - b.d);
    }
    for (let i = pts.length - 2; i >= 0; i--) if (pts[i].p < pts[i + 1].p) pts[i].p = pts[i + 1].p;

    let fn;
    if (pts.length === 0) {
      const f = 250;
      fn = (d) => f * templateRatio(d);
    } else {
      fn = function (d) {
        const first = pts[0], last = pts[pts.length - 1];
        if (d <= first.d) return first.p * templateRatio(d) / templateRatio(first.d);
        if (d >= last.d) return last.p * templateRatio(d) / templateRatio(last.d);
        for (let i = 1; i < pts.length; i++) {
          if (d <= pts[i].d) return logInterp(d, pts[i - 1].d, pts[i - 1].p, pts[i].d, pts[i].p);
        }
        return last.p;
      };
    }
    const userSet = new Set(pts.filter((q) => q.user).map((q) => q.d));
    return {
      fn,
      values: DURATIONS.map((d) => fn(d)),
      isUser: DURATIONS.map((d) => userSet.has(d)),
      nUser: userSet.size,
    };
  }

  /** Modèle 2 paramètres travail–temps (W = CP·t + W′), ajusté sur la courbe entre 3 et 20 min. */
  function fitCpWprime(curveFn) {
    const ds = [180, 240, 300, 600, 900, 1200];
    const n = ds.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const d of ds) {
      const w = curveFn(d) * d;
      sx += d; sy += w; sxx += d * d; sxy += d * w;
    }
    const cp = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const wp = (sy - cp * sx) / n;
    return { cp: Math.max(cp, 50), wPrime: Math.max(wp, 3000) };
  }

  /** FTP estimée depuis la courbe (60 min, sinon 95 % des 20 min). */
  function estimateFtp(records) {
    const r = records || {};
    if (Number(r[3600]) > 0) return Number(r[3600]);
    if (Number(r[2700]) > 0) return Math.round(Number(r[2700]) * 0.97);
    if (Number(r[1200]) > 0) return Math.round(Number(r[1200]) * 0.95);
    if (Number(r[1800]) > 0) return Math.round(Number(r[1800]) * 0.96);
    return 0;
  }

  /** L'âge ralentit la reconstitution du W′ (approximation, ~ −8 %/décennie après 30 ans). */
  function ageRecoveryFactor(age) {
    const a = Number(age) > 0 ? Number(age) : 35;
    return Math.min(1.1, Math.max(0.6, 1 - 0.008 * (a - 30)));
  }

  /** Paramètres effectifs du cycliste utilisés par la simulation. */
  function buildAthlete(rider) {
    const ftpIn = Number(rider.ftp) > 0 ? Number(rider.ftp) : 0;
    const curve = buildCurve(rider.records, ftpIn);
    const fit = fitCpWprime(curve.fn);
    const cp = Number(rider.cp) > 0 ? Number(rider.cp) : fit.cp;
    const w0 = Number(rider.wPrime) > 0 ? Number(rider.wPrime) * 1000 : fit.wPrime;
    const ftp = ftpIn || estimateFtp(rider.records) || curve.fn(3600);
    return {
      cp, w0, ftp,
      mmp: curve.fn,
      curve, fit,
      recF: ageRecoveryFactor(rider.age),
      pmax: Number(rider.pmax) > 0 ? Number(rider.pmax) : curve.fn(1),   // saisie, sinon le record 1 s de la courbe
      cpSource: Number(rider.cp) > 0 ? 'saisie' : 'estimée',
      w0Source: Number(rider.wPrime) > 0 ? 'saisie' : 'estimée',
      pmaxSource: Number(rider.pmax) > 0 ? 'saisie' : 'estimée',
      ftpSource: ftpIn ? 'saisie' : 'estimée',
    };
  }

  /**
   * Athlète dont la PC et le W′ sont multipliés par cpK et wK (forme du jour, niveau d'un coureur
   * virtuel). La courbe record suit : les durées longues dépendent surtout de la PC, les courtes du W′
   * (part de travail « PC » = PC·d / (PC·d + W′) dans le modèle à deux paramètres).
   */
  function scaleAthlete(a, cpK, wK) {
    const cp = a.cp, w0 = a.w0, base = a.mmp;
    const mix = (d) => { const fc = (cp * d) / (cp * d + w0); return cpK * fc + wK * (1 - fc); };
    return Object.assign({}, a, {
      cp: cp * cpK, w0: w0 * wK, ftp: a.ftp * mix(3600), pmax: a.pmax * wK,
      mmp: (d) => base(d) * mix(d),
    });
  }

  /**
   * Forme du jour, tirée au hasard au départ : elle ne fait que dégrader (un peu) la PC et le W′.
   * rnd : générateur uniforme [0, 1[. La plupart du temps la baisse est faible.
   */
  function drawForm(rnd) {
    const cpLoss = 0.06 * Math.pow(rnd(), 1.6);
    const wLoss = 0.12 * Math.pow(rnd(), 1.6);
    const score = cpLoss + wLoss / 3;
    const label = score < 0.01 ? 'excellente' : score < 0.025 ? 'bonne' : score < 0.04 ? 'moyenne' : 'jour sans';
    return { cpK: 1 - cpLoss, wK: 1 - wLoss, label };
  }

  /** Un pas de W′bal (modèle différentiel de Skiba 2015). */
  function wbalStep(wbal, P, cp, w0, dt, recF) {
    if (P >= cp) return wbal - (P - cp) * dt;
    return w0 - (w0 - wbal) * Math.exp(-recF * (cp - P) * dt / w0);
  }

  /**
   * W′bal (J) au début de chaque seconde (n + 1 valeurs) quand on roule les puissances P (n valeurs) avec l'athlète a, en partant de
   * w (J ; W′ plein par défaut). Peut devenir négatif : le profil de l'athlète est dépassé (forme > 100 %, ou W′ sous-estimé) ;
   * la récupération repart alors de la valeur négative.
   */
  function wbalSeries(P, n, a, w) {
    const out = new Float32Array(n + 1);
    let b = w === undefined ? a.w0 : Math.min(a.w0, w);
    out[0] = b;
    for (let t = 0; t < n; t++) {
      b = wbalStep(b, P[t], a.cp, a.w0, 1, a.recF);
      out[t + 1] = b;
    }
    return out;
  }

  /**
   * Paliers de fatigue de W′bal, en fraction du W′ plein. Ce sont des conventions de l'application (les mêmes que la jauge du mode
   * jeu : 50 / 20 / 5 %), pas des seuils publiés : la littérature définit W′bal = 0 comme l'épuisement, sans graduer ce qui précède.
   */
  const WBAL_LEVELS = [
    { frac: 0.5, label: 'fatigue modérée' },
    { frac: 0.2, label: 'fatigue sévère' },
    { frac: 0.05, label: 'épuisement imminent' },
    { frac: 0, label: 'épuisement' },
  ];

  /** État de fatigue pour une fraction de W′ restant (négative : le profil de l'athlète est dépassé). */
  function wbalState(frac) {
    if (frac < 0) return 'au-delà des capacités';
    if (frac < 0.05) return 'épuisement imminent';
    if (frac < 0.2) return 'fatigue sévère';
    if (frac < 0.5) return 'fatigue modérée';
    return 'réserve confortable';
  }

  /** Zones de puissance (Coggan) en fraction de FTP. */
  const ZONES = [
    { id: 'Z1', label: 'Récupération', max: 0.55 },
    { id: 'Z2', label: 'Endurance', max: 0.75 },
    { id: 'Z3', label: 'Tempo', max: 0.90 },
    { id: 'Z4', label: 'Seuil', max: 1.05 },
    { id: 'Z5', label: 'PMA', max: 1.20 },
    { id: 'Z6', label: 'Anaérobie', max: 1.50 },
    { id: 'Z7', label: 'Neuromusculaire', max: Infinity },
  ];

  function zoneIndex(P, ftp) {
    const r = P / ftp;
    for (let i = 0; i < ZONES.length; i++) if (r <= ZONES[i].max) return i;
    return ZONES.length - 1;
  }

  PYR.physio = {
    DURATIONS, FTP_RATIOS, ZONES,
    durationLabel, templateRatio, curveFromFtp, buildCurve, fitCpWprime,
    estimateFtp, ageRecoveryFactor, buildAthlete, scaleAthlete, drawForm, wbalStep, wbalSeries, WBAL_LEVELS, wbalState, zoneIndex,
  };
})(globalThis.PYR = globalThis.PYR || {});
