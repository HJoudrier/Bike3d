/* author : Hugo Joudrier-Faure */
/* PaceYourRide — mode mixte de la sortie : le cycliste roule pour de vrai (GPS, capteur), des coureurs virtuels du mode jeu parcourent le
 * même tracé à son niveau, sans aspiration, avec les sprints et les côtes classées. Ce module ne touche ni au DOM ni aux capteurs.
 *
 * Les coureurs virtuels ne dépendent pas du cycliste (pas de race.external) : leur course est déterministe à partir d'une graine. Ils
 * partent quand le cycliste franchit la ligne (t0) et avancent à la demande, dans un budget de temps par appel, jusqu'à quelques
 * secondes en avance sur lui. Temps de course τ = temps de la sortie − t0 ; les temps de passage de tout le monde sont en temps de course.
 * Seul { graine, réglages, t0, temps de passage du cycliste } est à sauvegarder : la reprise reconstruit la course et la rattrape. */
(function (PYR) {
  'use strict';

  const Race = PYR.race, Cl = PYR.classif;

  const START_S = 20;    // m : le cycliste a franchi la ligne de départ
  const AHEAD = 5;       // s : de combien les coureurs virtuels sont simulés en avance sur le temps de course
  const ME = 'me';
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /** Position (m) d'une trace « une position par seconde » au temps t (interpolée, bornée à la dernière valeur). */
  function posAt(sArr, t) {
    if (t <= 0) return sArr[0] || 0;
    const i = Math.floor(t);
    if (i >= sArr.length - 1) return sArr[sArr.length - 1];
    return sArr[i] + (sArr[i + 1] - sArr[i]) * (t - i);
  }
  /** Temps (s) où la trace atteint la distance s ; null si elle n'y est pas encore. */
  function timeAt(sArr, s) {
    const n = sArr.length - 1;
    if (!(n >= 1) || !(sArr[n] >= s)) return null;
    if (s <= sArr[0]) return 0;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sArr[m] < s) lo = m; else hi = m; }
    const span = sArr[hi] - sArr[lo];
    return lo + (span > 0 ? (s - sArr[lo]) / span : 0);
  }

  /** Temps (s) d'un coureur « moyen » de niveau k × celui du cycliste sur tout le parcours, sans aspiration (sonde déterministe). */
  function probeTime(o, cps, k) {
    const race = Race.create({ course: o.course, rules: { draft: false }, seed: 1, gustSeed: o.gustSeed, cps });
    const athlete = PYR.physio.scaleAthlete(PYR.physio.buildAthlete(o.rider), k, k);
    const r = Race.addRider(race, {
      id: 'probe', name: 'probe', color: '#000', setup: PYR.physics.buildSetup(o.rider, o.bike), athlete, v0: 0,
      bot: { aggr: 0.25, team: 0.6, level: k, sprint: 0.5, climb: 0.5 },
    });
    Race.runToEnd(race);
    return r.finished ? r.time : Infinity;
  }

  /**
   * Étalonnage du niveau « égal » : facteur k (≈ 1) pour qu'un coureur virtuel de ce niveau boucle le parcours en `target` s (le temps du plan
   * du cycliste), par sécante sur le logarithme (le temps varie à peu près comme k^-0.6). Au plus 4 simulations ; k reste dans [0.7, 1.6].
   */
  function calibrate(o, cps, target) {
    if (!(target > 0)) return 1;
    const clampK = (k) => Math.min(1.6, Math.max(0.7, k));
    let k0 = 1, t0 = probeTime(o, cps, k0);
    if (!Number.isFinite(t0)) return 1;
    let k1 = clampK(k0 * Math.pow(t0 / target, 1 / 0.6));
    for (let i = 0; i < 3 && Math.abs(k1 - k0) > 1e-3; i++) {
      const t1 = probeTime(o, cps, k1);
      if (!Number.isFinite(t1) || Math.abs(t1 / target - 1) < 0.01) return Number.isFinite(t1) ? k1 : k0;
      const slope = Math.log(t1 / t0) / Math.log(k1 / k0);                // < 0 : plus fort, plus rapide
      const k2 = slope < -0.1 ? clampK(Math.exp(Math.log(k1) + (Math.log(target) - Math.log(t1)) / slope)) : clampK(k1 * Math.pow(t1 / target, 1 / 0.6));
      k0 = k1; t0 = t1; k1 = k2;
    }
    return k1;
  }

  /**
   * Prépare le défi. o : { course, cps (points de passage, cf. classif.js), rules {sprints, kom}, seed, gustSeed, n (coureurs virtuels), level
   * ('weaker' | 'equal' | 'stronger' | 'mixed'), rider, bike (profils du cycliste et de son vélo), colors, levelK (étalonnage déjà connu) ou
   * targetTime (s : temps du plan du cycliste, sur lequel le niveau « égal » est étalonné) }.
   */
  function create(o) {
    const rules = { sprints: Math.floor(Number(o.rules && o.rules.sprints) || 0), kom: !!(o.rules && o.rules.kom), draft: false };
    const race = Race.create({ course: o.course, rules, seed: o.seed, gustSeed: o.gustSeed, cps: o.cps });
    const levelK = o.levelK > 0 ? o.levelK : o.targetTime > 0 && o.n > 0 ? calibrate(o, race.cps, o.targetTime) : 1;
    Race.addBots(race, { n: o.n, level: o.level, levelK, rider: o.rider, bike: o.bike, v0: 0, colors: o.colors });
    return {
      race, cps: race.cps, seed: race.seed, n: race.riders.length, level: o.level, levelK, rules: { sprints: rules.sprints, kom: rules.kom },
      length: o.course.length,
      t0: null,                                  // instant de la sortie où le cycliste a franchi la ligne
      splits: race.cps.map(() => null),          // temps de passage du cycliste (temps de course)
      pending: [],                               // passages du cycliste dont le rang n'est pas encore connu (coureurs virtuels pas assez avancés)
    };
  }

  /** Temps de course (s) à l'instant t de la sortie ; 0 tant que le cycliste n'a pas franchi la ligne. */
  function tau(m, t) { return m.t0 === null ? 0 : Math.max(0, t - m.t0); }

  /** Le cycliste a-t-il franchi la ligne ? Fixe alors t0 (instant interpolé du passage à START_S). */
  function startLine(m, sess) {
    if (m.t0 !== null) return true;
    if (!(sess.s >= START_S)) return false;
    const t = sess.timeAt ? sess.timeAt(START_S) : null;
    m.t0 = t === null ? sess.t : t;
    return true;
  }

  /** Fait avancer les coureurs virtuels jusqu'à τ + AHEAD, au plus budgetMs ms. Renvoie true s'ils ont rattrapé. */
  function advance(m, sess, budgetMs) {
    if (m.t0 === null) return true;
    const target = Math.ceil(tau(m, sess.t)) + AHEAD, t0 = now();
    while (m.race.t < target && m.race.riders.some((r) => !r.finished)) {
      Race.step(m.race);
      if (budgetMs !== undefined && now() - t0 > budgetMs) return m.race.t >= target;
    }
    return true;
  }

  /**
   * Un tour d'horloge : départ, avance des coureurs virtuels, passages du cycliste aux points de passage. Renvoie les événements
   * { cp (indice), point, rank, pts, gap (s, par rapport au premier : > 0 en retard, < 0 d'avance sur le suivant), t (temps de course) }
   * dont le rang est maintenant connu, dans l'ordre.
   */
  function update(m, sess, budgetMs) {
    if (!startLine(m, sess)) return [];
    advance(m, sess, budgetMs);
    // passages du cycliste
    for (let k = m.splits.findIndex((x) => x === null); k >= 0 && k < m.cps.length; k++) {
      const cp = m.cps[k];
      let t;
      if (cp.type === 'finish') { if (!sess.finished) break; t = sess.t; }
      else { t = sess.timeAt(cp.s); if (t === null) break; }
      m.splits[k] = Math.max(0, t - m.t0);
      m.pending.push(k);
    }
    // rang : connu quand la seconde du passage est simulée pour tous les coureurs virtuels
    const out = [];
    while (m.pending.length) {
      const k = m.pending[0], t = m.splits[k];
      if (m.race.t < Math.ceil(t) + 1 && m.race.riders.some((r) => !r.finished)) break;
      m.pending.shift();
      const others = m.race.riders.map((r) => r.splits[k]).filter((x) => x !== null && x !== undefined && Number.isFinite(x));
      const rank = 1 + others.filter((x) => x <= t).length;
      // écart : en retard sur le premier (> 0) ; en tête, d'avance sur le suivant (< 0), estimé d'après sa distance restante et sa vitesse
      let gap = 0;
      if (rank > 1) gap = t - Math.min(...others);
      else {
        const behind = m.race.riders.filter((r) => !Number.isFinite(r.splits[k]));
        if (behind.length) gap = -Math.min(...behind.map((r) => Math.max(0, m.cps[k].s - r.st.s) / Math.max(2, r.st.v) + (m.race.t - t)));
      }
      out.push({ cp: k, point: m.cps[k], rank, pts: Cl.pointsFor(m.cps[k], rank), gap, t });
    }
    return out;
  }

  /** Positions des coureurs virtuels à l'instant t de la sortie (pour la carte) : [{ id, name, color, s }]. */
  function positions(m, t) {
    const x = tau(m, t);
    return m.race.riders.map((r) => ({ id: r.id, name: r.name, color: r.color, s: m.t0 === null ? 0 : (r.finished && x >= r.time ? m.length : posAt(r.trace.s, x)) }));
  }

  /**
   * Classement en course à l'instant t : tous les coureurs, du premier au dernier, avec leur écart au cycliste.
   * [{ id, name, color, s, rank, me, dt (s : > 0 s'ils ont déjà passé ta position depuis dt secondes, < 0 si tu es déjà passé là depuis |dt| s),
   *    dm (m : position moins la tienne) }]
   */
  function board(m, sess, t) {
    const x = tau(m, t), sMe = sess.s;
    const rows = [{ id: ME, name: 'Toi', color: null, s: sMe, me: true, dt: 0, dm: 0 }];
    for (const r of m.race.riders) {
      const s = m.t0 === null ? 0 : (r.finished && x >= r.time ? m.length : posAt(r.trace.s, x));
      let dt = 0;
      if (m.t0 !== null) {
        if (s >= sMe) { const tb = timeAt(r.trace.s, sMe); dt = tb === null ? 0 : x - tb; }
        else { const tm = sess.timeAt(s); dt = tm === null ? 0 : -(x - (tm - m.t0)); }
      }
      rows.push({ id: r.id, name: r.name, color: r.color, s, me: false, dt, dm: s - sMe });
    }
    rows.sort((a, b) => b.s - a.s || (a.me ? -1 : b.me ? 1 : 0));
    rows.forEach((row, i) => { row.rank = i + 1; });
    return rows;
  }

  /** Classements (passages, points, montagne, général) : coureurs virtuels et cycliste. */
  function standings(m, sess) {
    const riders = m.race.riders.map((r) => ({ id: r.id, splits: r.splits, s: r.st.s }));
    riders.push({ id: ME, splits: m.splits, s: sess.s });
    return Cl.standings(m.cps, riders);
  }

  /** Noms et couleurs, par identifiant. */
  function names(m) {
    const map = new Map([[ME, { name: 'Toi', color: null }]]);
    for (const r of m.race.riders) map.set(r.id, { name: r.name, color: r.color });
    return map;
  }

  /** Termine la course des coureurs virtuels (bilan), au plus budgetMs ms. Renvoie true quand tous sont arrivés. */
  function finishAll(m, budgetMs) {
    const t0 = now();
    while (m.race.riders.some((r) => !r.finished) && m.race.t < 8 * 3600) {
      Race.step(m.race);
      if (budgetMs !== undefined && now() - t0 > budgetMs) return false;
    }
    return true;
  }

  /** État à sauvegarder (JSON) : la course des coureurs virtuels se reconstruit à partir de là. */
  function pack(m) {
    return { v: 1, seed: m.seed, n: m.n, level: m.level, levelK: m.levelK, rules: m.rules, cps: m.cps.filter((c) => c.type !== 'finish'), t0: m.t0, splits: m.splits.slice() };
  }

  /** Reconstruit le défi sauvegardé ; o : { course, rider, bike, gustSeed, colors }. Les coureurs virtuels sont rattrapés par advance/update. */
  function unpack(p, o) {
    if (!p || p.v !== 1 || !(p.n >= 0)) return null;
    const cps = Cl.normalize(p.cps, o.course.length);
    const m = create({ course: o.course, cps, rules: p.rules, seed: p.seed, gustSeed: o.gustSeed, n: p.n, level: p.level, levelK: p.levelK, rider: o.rider, bike: o.bike, colors: o.colors });
    m.t0 = Number.isFinite(p.t0) ? p.t0 : null;
    if (Array.isArray(p.splits) && p.splits.length === m.splits.length) m.splits = p.splits.map((x) => (Number.isFinite(x) ? x : null));
    return m;
  }

  PYR.rideMixed = { START_S, AHEAD, ME, calibrate, probeTime, create, tau, startLine, advance, update, positions, board, standings, names, finishAll, pack, unpack };
})(globalThis.PYR = globalThis.PYR || {});
