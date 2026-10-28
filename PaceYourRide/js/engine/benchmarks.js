/* author : Hugo Joudrier-Faure */
/* PaceYourRide — niveau du cycliste par rapport à des valeurs de référence publiées, et zones de puissance.
 *
 * Source des seuils : « profil de puissance » d'Hunter Allen et Andrew Coggan, Training and Racing with a
 * Power Meter (VeloPress, 2e éd., 2010) : puissance moyenne en W/kg que l'on doit pouvoir tenir sur 5 s, 1 min,
 * 5 min et au seuil (FTP) pour entrer dans chaque niveau, de « non entraîné » à « classe mondiale ».
 * Les valeurs de 5 s, 1 min et 5 min sont celles de la table. Trois autres efforts n'y figurent pas ; ils sont déduits, et signalés comme tels :
 *   - 15 s : interpolée entre les seuils à 5 s et à 1 min, linéairement en logarithme de la durée ;
 *   - 3 min : de même, entre les seuils à 1 min et à 5 min ;
 *   - 20 min : FTP / 0,95 (la FTP est, par convention, 95 % de la meilleure puissance sur 20 min).
 * Repère complémentaire sur les professionnels : Valenzuela et al., Int J Sports Physiol Perform 2022 (144
 * coureurs de 7 équipes WorldTour / ProTeam, 2013–2021) : 20 min entre 5,47 (10ᵉ centile) et 6,59 W/kg (90ᵉ). */
(function (PYR) {
  'use strict';

  /** Niveaux, du meilleur au plus faible (même ordre que les colonnes de TABLE). */
  const LEVELS = [
    { id: 'world', label: 'Classe mondiale', who: 'pro WorldTour', color: '#b3261e' },
    { id: 'exceptional', label: 'Exceptionnel', who: 'pro continental, élite nationale', color: '#d9622b' },
    { id: 'excellent', label: 'Excellent', who: 'élite amateur (Cat 1)', color: '#d89a1d' },
    { id: 'verygood', label: 'Très bon', who: 'amateur confirmé (Cat 2)', color: '#3f9d4f' },
    { id: 'good', label: 'Bon', who: 'amateur (Cat 3)', color: '#2a9d8f' },
    { id: 'moderate', label: 'Moyen', who: 'cyclosportif (Cat 4)', color: '#3d85c6' },
    { id: 'fair', label: 'Passable', who: 'loisir actif (Cat 5)', color: '#6a7fb5' },
    { id: 'untrained', label: 'Non entraîné', who: 'pratique occasionnelle', color: '#8a8f98' },
  ];
  const BELOW = { id: 'below', label: 'Débutant', who: 'sous le niveau « non entraîné »', color: '#a5a8ad' };

  /** Seuils (W/kg) de chaque niveau, de « classe mondiale » à « non entraîné ». m : hommes, f : femmes. */
  const TABLE = {
    m: {
      p5: [24.00, 22.22, 20.44, 18.66, 16.59, 14.81, 13.04, 11.26],
      p60: [11.04, 10.35, 9.66, 8.97, 8.17, 7.48, 6.79, 6.10],
      p300: [7.19, 6.57, 5.95, 5.33, 4.60, 3.98, 3.36, 2.74],
      ftp: [6.04, 5.51, 4.98, 4.44, 3.82, 3.29, 2.75, 2.22],
    },
    f: {
      p5: [18.56, 17.26, 15.97, 14.68, 13.17, 11.88, 10.58, 9.29],
      p60: [8.93, 8.38, 7.84, 7.30, 6.66, 6.12, 5.57, 5.03],
      p300: [6.36, 5.79, 5.21, 4.64, 3.98, 3.40, 2.83, 2.26],
      ftp: [5.36, 4.87, 4.38, 3.88, 3.31, 2.82, 2.32, 1.83],
    },
  };

  /** Efforts évalués : durée (s) du record, ou FTP. derived : valeur de référence déduite et non publiée. */
  const EFFORTS = [
    { id: 'p5', label: '5 s', dur: 5, what: 'neuromusculaire' },
    { id: 'p15', label: '15 s', dur: 15, what: 'sprint', derived: 'interpolée entre les seuils à 5 s et 1 min' },
    { id: 'p60', label: '1 min', dur: 60, what: 'anaérobie' },
    { id: 'p180', label: '3 min', dur: 180, what: 'PMA courte', derived: 'interpolée entre les seuils à 1 min et 5 min' },
    { id: 'p300', label: '5 min', dur: 300, what: 'PMA' },
    { id: 'p1200', label: '20 min', dur: 1200, what: 'seuil', derived: 'FTP ÷ 0,95' },
    { id: 'ftp', label: 'FTP', dur: 3600, what: 'seuil 1 h' },
  ];

  const sexKey = (sex) => (sex === 'f' ? 'f' : 'm');

  /** Seuils (W/kg) de chaque niveau pour un effort, dans l'ordre de LEVELS. */
  function thresholds(sex, effortId) {
    const t = TABLE[sexKey(sex)];
    switch (effortId) {
      case 'p5': return t.p5.slice();
      case 'p60': return t.p60.slice();
      case 'p15': {
        const k = Math.log(15 / 5) / Math.log(60 / 5);
        return t.p5.map((v, i) => v + (t.p60[i] - v) * k);
      }
      case 'p180': {
        const k = Math.log(180 / 60) / Math.log(300 / 60);
        return t.p60.map((v, i) => v + (t.p300[i] - v) * k);
      }
      case 'p300': return t.p300.slice();
      case 'p1200': return t.ftp.map((v) => v / 0.95);
      case 'ftp': return t.ftp.slice();
      default: throw new Error('effort inconnu : ' + effortId);
    }
  }

  /**
   * Niveau atteint pour une valeur en W/kg : {index (0 = classe mondiale … 7 = non entraîné, 8 = en dessous),
   * level, next (niveau suivant et son seuil, null au sommet), progress (0–1 entre le seuil atteint et le suivant)}.
   */
  function classify(sex, effortId, wkg) {
    const th = thresholds(sex, effortId);
    let index = th.length;
    for (let i = 0; i < th.length; i++) if (wkg >= th[i] - 1e-9) { index = i; break; }
    const level = index < LEVELS.length ? LEVELS[index] : BELOW;
    const lo = index < th.length ? th[index] : 0;
    let next = null, progress = 1;
    if (index > 0) {
      const hi = th[index - 1];
      next = { level: LEVELS[index - 1], wkg: hi };
      progress = Math.max(0, Math.min(1, (wkg - lo) / (hi - lo)));
    }
    return { index, level, next, progress, wkg, thresholds: th };
  }

  /**
   * Zones de puissance d'après la FTP (Coggan, regroupées en six) :
   * [{id, label, from, to (fractions de la FTP ; to = Infinity pour la dernière), lo, hi (W), use}].
   * pmax (W) borne la dernière zone.
   */
  function zones(ftp, pmax) {
    const Z = PYR.physio.ZONES;
    const uses = ['récupération active', 'sorties longues, plusieurs heures', 'allure soutenue, 1 à 2 h', '20 à 60 min', '3 à 8 min', 'moins de 2 min'];
    const six = [Z[0], Z[1], Z[2], Z[3], Z[4], { id: 'Z6', label: 'Sprint / attaque', max: Infinity }];
    let from = 0;
    return six.map((z, i) => {
      const to = z.max;
      const o = {
        id: 'Z' + (i + 1), label: z.label, from, to, use: uses[i],
        lo: from * ftp, hi: to === Infinity ? Math.max(pmax || 0, from * ftp) : to * ftp,
      };
      from = to;
      return o;
    });
  }

  PYR.bench = { LEVELS, BELOW, EFFORTS, TABLE, thresholds, classify, zones };
})(globalThis.PYR = globalThis.PYR || {});
