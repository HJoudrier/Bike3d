/* author : Hugo Joudrier-Faure */
/* PaceYourRide — aspiration (drafting) : un cycliste abrité derrière d'autres subit moins de traînée,
 * et celui qui mène gagne un peu grâce à la surpression créée derrière lui.
 * Modèle simplifié, calé sur la littérature (Kyle 1979 ; Blocken et al. 2013, 2018 ; Barry et al. 2015) :
 *   - suiveur direct d'un seul coureur : −35 % de CdA roue dans roue (0,3 m) ; l'abri s'estompe avec l'écart
 *     (≈ −23 % à 2 m, −15 % à 4 m, −9 % à 6 m, quasi nul au-delà de 15 m) ;
 *   - plusieurs coureurs devant : l'abri se renforce avec leur nombre, chacun compte de moins en moins avec son éloignement
 *     (≈ −43 % avec 2 coureurs devant, ≈ −50 % avec 3, ≈ −55 % avec 4 à 5, ≈ −65 % et plus au cœur d'un grand groupe) ;
 *   - celui qui mène gagne 2 à 4 % quand quelqu'un est collé à sa roue ;
 *   - le vent de côté réduit l'abri d'une file indienne.
 * Les positions sont des distances le long du parcours ; deux coureurs qui se chevauchent
 * roulent côte à côte (pas d'abri). */
(function (PYR) {
  'use strict';

  const BIKE = 1.8;      // m : longueur d'un vélo ; espace entre les roues = écart des positions − BIKE
  const RANGE = 15;      // m entre les roues : au-delà, plus d'abri
  const GROUP_GAP = 15;  // m : coureurs espacés de moins de 15 m (entre les roues) = même groupe
  const MAX_R = 0.7;       // réduction maximale du CdA : cœur d'un grand groupe
  const PACK_REACH = 12;   // m : portée de l'abri collectif ; un coureur devant à cet écart compte pour 1/e
  const PACK_MAX = 40;     // m entre les roues : au-delà, un coureur devant n'ajoute plus rien
  const PACK_SCALE = 3.5;  // nombre de coureurs devant (pondéré) à partir duquel l'abri collectif est saturé aux 2/3

  /** Réduction de CdA d'un suiveur selon l'espace entre les roues (m). */
  function followReduction(gap) {
    if (!(gap >= -0.5) || gap > RANGE) return 0;
    const g = gap < 0.3 ? 0.3 : gap;
    return 0.35 * Math.exp(-(g - 0.3) / 4);
  }

  /** Réduction de CdA de celui qui mène, selon l'espace avec le coureur collé derrière lui. */
  function leadReduction(gapBehind) {
    if (!(gapBehind >= -0.5) || gapBehind > 3) return 0;
    const g = gapBehind < 0.3 ? 0.3 : gapBehind;
    return 0.03 * Math.exp(-(g - 0.3) / 0.8);
  }

  /**
   * Renforcement de l'abri par les autres coureurs devant (en plus de la roue suivie) : `extra` est leur nombre pondéré par
   * l'éloignement. 1 avec personne d'autre devant, ≈ 1,25 avec un coureur de plus à 3 m, ≈ 1,45 avec deux, tend vers 2 dans un grand groupe.
   */
  function packBoost(extra) {
    return 1 + (1 - Math.exp(-Math.max(0, extra) / PACK_SCALE));
  }

  /** Atténuation de l'abri par le vent de côté wc (m/s) à la vitesse v. */
  function crossFactor(wc, v) {
    const r = (wc || 0) / Math.max(3, v || 0);
    return 1 / (1 + 2 * r * r);
  }

  /**
   * Aspiration de tous les coureurs actifs (ni arrêtés, ni arrivés).
   * list : [{id, s, v, wc}] ; renvoie Map id → {R, k, role, gapAhead, gapBehind, wheel, chain, group, groupSize, rank}
   *   R : réduction du CdA (0 = seul au vent) et k = 1 − R ;
   *   role : 'solo' | 'lead' (en tête d'un groupe) | 'follow' (abrité) ;
   *   wheel : id du coureur dont on suit la roue ; rank : place dans le groupe (0 = en tête).
   */
  function field(list) {
    const order = list.slice().sort((a, b) => b.s - a.s);
    const n = order.length;
    const wheel = new Array(n).fill(-1), chain = new Array(n).fill(0), group = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      // roue suivie : le premier coureur devant qui ne roule pas à côté de nous
      for (let j = i - 1; j >= 0; j--) {
        const d = order[j].s - order[i].s;
        if (d - BIKE > RANGE) break;
        if (d >= BIKE - 0.5) { wheel[i] = j; break; }
      }
      if (wheel[i] >= 0) chain[i] = chain[wheel[i]] + 1;
      if (i > 0) group[i] = group[i - 1] + (order[i - 1].s - order[i].s - BIKE > GROUP_GAP ? 1 : 0);
    }
    const size = [], first = [];
    for (let i = 0; i < n; i++) {
      size[group[i]] = (size[group[i]] || 0) + 1;
      if (first[group[i]] === undefined) first[group[i]] = i;
    }
    const out = new Map();
    for (let i = 0; i < n; i++) {
      let behind = -1;
      for (let j = i + 1; j < n; j++) {
        const d = order[i].s - order[j].s;
        if (d - BIKE > 3) break;
        if (d >= BIKE - 0.5) { behind = j; break; }
      }
      const x = order[i];
      const gapAhead = wheel[i] >= 0 ? order[wheel[i]].s - x.s - BIKE : Infinity;
      const gapBehind = behind >= 0 ? x.s - order[behind].s - BIKE : Infinity;
      const gs = size[group[i]];
      // autres coureurs devant, hors la roue suivie et ceux qui roulent à côté : plus ils sont nombreux et proches, plus l'abri est fort
      let extra = 0;
      if (wheel[i] >= 0) {
        for (let j = i - 1; j >= 0; j--) {
          const d = order[j].s - x.s - BIKE;
          if (d > PACK_MAX) break;
          if (j === wheel[i] || order[j].s - x.s < BIKE - 0.5) continue;
          extra += Math.exp(-d / PACK_REACH);
        }
      }
      // cœur d'un grand groupe : abrité aussi sur les côtés (le modèle ne connaît qu'une file), jusqu'à +20 % d'abri
      const wide = gs > 8 && i - first[group[i]] >= 5 ? 1 + 0.2 * (1 - Math.exp(-(gs - 8) / 20)) : 1;
      const follow = wheel[i] >= 0 ? followReduction(gapAhead) * packBoost(extra) * wide : 0;
      const lead = leadReduction(gapBehind) * (gs >= 3 ? 1.4 : 1);
      let R = follow + (follow > 0 ? 0.5 * lead : lead);
      R *= crossFactor(x.wc, x.v);
      if (R > MAX_R) R = MAX_R;
      const role = follow > 0.02 ? 'follow' : gs > 1 && first[group[i]] === i ? 'lead' : 'solo';
      out.set(x.id, {
        R, k: 1 - R, role, gapAhead, gapBehind,
        wheel: wheel[i] >= 0 ? order[wheel[i]].id : null, chain: chain[i],
        group: group[i], groupSize: gs, rank: i - first[group[i]],
      });
    }
    return out;
  }

  /** Puissance aérodynamique (W aux pédales) qu'il faudrait seul au vent à la vitesse v. */
  function aeroPower(setup, cond, v) {
    const va = v + cond.wh;
    if (!(v > 0) || va <= 0) return 0;
    return 0.5 * cond.rho * setup.cda * Math.sqrt(va * va + cond.wc * cond.wc) * va * v / setup.eta;
  }

  PYR.draft = { BIKE, RANGE, GROUP_GAP, MAX_R, followReduction, leadReduction, packBoost, crossFactor, field, aeroPower };
})(globalThis.PYR = globalThis.PYR || {});
