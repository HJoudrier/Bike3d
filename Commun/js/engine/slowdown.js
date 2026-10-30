/* author : Hugo Joudrier-Faure */
/* PaceYourRide — retour à la vitesse ×1 aux évènements de course (mode jeu). Sans DOM, testable.
 *   - évènements « ponctuels » (attaque ou sprint d'un coureur, chute, crevaison) : ×1 pendant les N secondes de course
 *     qui suivent ;
 *   - points de passage (sprint intermédiaire qui offre encore des points, côte classée, arrivée) : ×1 sur les N derniers
 *     mètres avant la ligne (pour une côte classée : avant le sommet, pas dès le pied de la côte) ;
 *   - dans les deux cas, une pause de réaction (secondes réelles) peut figer la course pour laisser le temps de réagir.
 * Les réglages sont dans store.state.game : slowOn, puis slowAttack / slowCrash / slowPuncture (secondes) et
 * slowSprint / slowKom / slowFinish (mètres), chacun avec sa pause (…Pause, secondes). */
(function (PYR) {
  'use strict';

  /** Cas réglables : clé du réglage, libellé, unité de la durée ou de la distance. */
  const CASES = [
    { id: 'attack', key: 'slowAttack', label: 'Attaque ou sprint d\'un coureur', unit: 's' },
    { id: 'crash', key: 'slowCrash', label: 'Chute', unit: 's' },
    { id: 'puncture', key: 'slowPuncture', label: 'Crevaison', unit: 's' },
    { id: 'sprint', key: 'slowSprint', label: 'Sprint intermédiaire', unit: 'm' },
    { id: 'kom', key: 'slowKom', label: 'Côte classée', unit: 'm' },
    { id: 'finish', key: 'slowFinish', label: 'Arrivée', unit: 'm' },
  ];
  const BY_ID = Object.fromEntries(CASES.map((c) => [c.id, c]));
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

  /** Réglages d'un cas : { value (secondes ou mètres), pause (secondes) }, ou null s'il n'existe pas. */
  function setting(game, id) {
    const c = BY_ID[id];
    if (!c || !game) return null;
    return { value: num(game[c.key]), pause: num(game[c.key + 'Pause']) };
  }

  /** Évènement de course (type de PYR.race : attack, crash, puncture) → réglages, ou null s'il n'est pas concerné. */
  function eventSpec(game, type) {
    if (type !== 'attack' && type !== 'crash' && type !== 'puncture') return null;
    const s = setting(game, type);
    return s && (s.value > 0 || s.pause > 0) ? { dur: s.value, pause: s.pause } : null;
  }

  /**
   * Zone de ralentissement où se trouve le cycliste à la distance s, parmi les points de passage pas encore franchis
   * (à partir de nextCp) : { k, kind, pause } ou null. Un sprint intermédiaire ne compte que s'il offre encore des points.
   */
  function zoneFor(cps, nextCp, s, game) {
    if (!cps) return null;
    for (let k = Math.max(0, nextCp || 0); k < cps.length; k++) {
      const cp = cps[k], st = setting(game, cp.type);
      if (!st || !(st.value > 0)) continue;
      if (cp.type === 'sprint' && !(PYR.classif && PYR.classif.pointsFor(cp, 1) > 0)) continue;
      const from = cp.s - st.value; // la ligne d'un sprint, d'un sommet ou de l'arrivée : N mètres avant
      if (s >= from && s < cp.s) return { k, kind: cp.type, pause: st.pause };
    }
    return null;
  }

  PYR.slowdown = { CASES, setting, eventSpec, zoneFor };
})(globalThis.PYR = globalThis.PYR || {});
