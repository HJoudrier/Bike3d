/* author : Hugo Joudrier-Faure */
/* PaceYourRide — zones de ravitaillement des étapes longues (mode jeu, option « alimentation »).
 * Les zones se choisissent sur la page Parcours (liste enregistrée avec le projet, voir fromList) : posées
 * à la main (début et fin) ou ajoutées automatiquement (build : un parcours d'au moins 75 km en compte une
 * tous les ≈ 50 km, au plus 6, de 500 m, placée sur du plat ou une descente douce : jamais dans une côte, à son
 * pied ni juste avant, jamais dans les 8 derniers kilomètres). Un défi ou une course en direct fige les zones
 * avec le parcours : tous les joueurs ont les mêmes. Elles ne servent qu'avec l'option « alimentation ».
 * Dans une zone, on peut prendre sa musette une fois : bidons pleins, gels et barres (dans la limite des
 * poches), au prix d'un petit ralentissement le temps de la saisir. */
(function (PYR) {
  'use strict';

  const U = PYR.util;
  const ZONE_LEN = 500;        // m
  const SPACING = 50000;       // m : une zone tous les 50 km environ (à partir de 75 km de parcours)
  const MAX_ZONES = 6;
  const MIN_START = 5000;      // m : pas de zone avant le km 5…
  const TO_FINISH = 8000;      // … ni dans les 8 derniers km
  const GRAB_TIME = 6;         // s : durée pendant laquelle on roule au ralenti pour saisir la musette
  const GRAB_SPEED = 8.5;      // m/s (≈ 30 km/h) : vitesse à ne pas dépasser pendant ce temps

  /**
   * Zones de ravitaillement d'un parcours (profil ou parcours de simulation : {ele, step}) :
   * [{s (début), end, n}]. Vide sans l'option « alimentation » (rules.fuel) ou sur un parcours court.
   */
  function build(src, rules) {
    if (!rules || !rules.fuel || !src || !src.ele || !(src.step > 0)) return [];
    const ele = src.ele, step = src.step, n = ele.length, L = step * (n - 1);
    const count = Math.min(MAX_ZONES, Math.floor(L / SPACING - 0.5));
    if (!(count >= 1)) return [];
    const at = (s) => {
      const x = U.clamp(s / step, 0, n - 1), i = Math.min(n - 2, Math.floor(x));
      return ele[i] + (ele[i + 1] - ele[i]) * (x - i);
    };
    const climbs = PYR.classif.findClimbs(ele, step);
    const span = L / (count + 1), win = 0.25 * span, out = [];
    for (let k = 1; k <= count; k++) {
      const target = k * span;
      let best = null, bestScore = Infinity;
      const lo = Math.max(MIN_START, target - win), hi = Math.min(L - TO_FINISH - ZONE_LEN, target + win);
      for (let s = lo; s <= hi; s += 50) {
        if (climbs.some((c) => s + ZONE_LEN > c.start - 300 && s < c.end + 500)) continue;
        // pente de la zone (1 % ≈ 1 point) et éloignement de la position idéale (1 point par quart d'intervalle)
        const score = (Math.abs(at(s + ZONE_LEN) - at(s)) / ZONE_LEN) * 100 + Math.abs(s - target) / win;
        if (score < bestScore) { bestScore = score; best = s; }
      }
      if (best !== null) out.push({ s: Math.round(best), end: Math.round(best) + ZONE_LEN });
    }
    out.forEach((z, i) => { z.n = i + 1; });
    return out;
  }

  const MAX_LIST = 40;
  const MIN_LEN = 50;      // m : longueur minimale d'une zone

  /** Zones vérifiées (liste reçue d'un autre joueur) : [{s, end}] triées, de MIN_LEN au moins, dans le parcours de longueur L, numérotées. */
  function normalize(list, L) {
    const out = [];
    for (const z of Array.isArray(list) ? list.slice(0, MAX_LIST) : []) {
      if (!z) continue;
      const s = U.clamp(Number(z.s), 0, L), end = U.clamp(Number(z.end), 0, L);
      if (!(end - s >= MIN_LEN)) continue;
      out.push({ s: Math.round(s), end: Math.round(end) });
    }
    out.sort((a, b) => a.s - b.s);
    out.forEach((z, i) => { z.n = i + 1; });
    return out;
  }

  /** Zones d'une liste de la page Parcours [{id, startKm, endKm}], vérifiée, pour un parcours {ele, step}. */
  function fromList(items, src) {
    const L = src.step * (src.ele.length - 1);
    return normalize((Array.isArray(items) ? items : []).map((it) => ({ s: Number(it && it.startKm) * 1000, end: Number(it && it.endKm) * 1000 })), L);
  }

  /** Zones calculées (build) sous la forme d'éléments de liste de la page Parcours. */
  function toItems(zones) {
    return zones.map((z) => ({ id: U.uid(), startKm: z.s / 1000, endKm: z.end / 1000 }));
  }

  /** Indice de la zone où l'on se trouve à la distance s (m), -1 sinon. */
  function zoneAt(zones, s) {
    for (let i = 0; i < zones.length; i++) if (s >= zones[i].s && s <= zones[i].end) return i;
    return -1;
  }

  /** Première zone dont la fin est encore devant s (indice), -1 s'il n'y en a plus. */
  function nextZone(zones, s) {
    for (let i = 0; i < zones.length; i++) if (zones[i].end > s) return i;
    return -1;
  }

  PYR.feed = { ZONE_LEN, SPACING, MAX_ZONES, MIN_LEN, GRAB_TIME, GRAB_SPEED, build, normalize, fromList, toItems, zoneAt, nextZone };
})(globalThis.PYR = globalThis.PYR || {});
