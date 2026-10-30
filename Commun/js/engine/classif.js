/* author : Hugo Joudrier-Faure */
/* PaceYourRide — classements annexes d'une course en ligne, à la manière du Tour de France :
 *   - grand prix de la montagne (maillot à pois) : les côtes sont repérées sur le profil et classées
 *     de la 4ᵉ catégorie à « hors catégorie » d'après l'indice FIETS (dénivelé² / (10 × longueur),
 *     plus un bonus d'altitude au-delà de 1 000 m) ; les premiers au sommet marquent des points ;
 *   - classement par points (maillot vert) : sprints intermédiaires, placés sur du plat loin des
 *     côtes, et arrivée ;
 *   - classements intermédiaires : ordre et écarts de passage à chaque point.
 * Les points de passage (« cps ») sont triés par distance ; le dernier est toujours l'arrivée.
 * Ils sont choisis sur la page Parcours (liste enregistrée avec le projet, voir fromList) : posés à la main
 * (distance, catégorie, points distribués) ou ajoutés automatiquement, un par un (nextSprint, nextClimb). */
(function (PYR) {
  'use strict';

  const U = PYR.util;

  /** Catégories de côtes, de la plus dure à la plus facile : seuil d'indice FIETS et barème (Tour de France). */
  const CATS = [
    { id: 'hc', short: 'HC', name: 'hors catégorie', min: 7.5, pts: [20, 15, 12, 10, 8, 6, 4, 2] },
    { id: '1', short: '1ʳᵉ cat.', name: '1ʳᵉ catégorie', min: 3.5, pts: [10, 8, 6, 4, 2, 1] },
    { id: '2', short: '2ᵉ cat.', name: '2ᵉ catégorie', min: 1.7, pts: [5, 3, 2, 1] },
    { id: '3', short: '3ᵉ cat.', name: '3ᵉ catégorie', min: 0.8, pts: [2, 1] },
    { id: '4', short: '4ᵉ cat.', name: '4ᵉ catégorie', min: 0.2, pts: [1] },
  ];
  const SPRINT_PTS = [20, 17, 15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const FINISH_PTS = [30, 25, 22, 19, 17, 15, 13, 11, 9, 7, 6, 5, 4, 3, 2];
  const MAX_SPRINTS = 3;
  const MAX_CPS = 40;
  const MAX_PTS = 20;      // places qui marquent des points, au plus
  const TYPE_ORDER = { sprint: 0, kom: 1, finish: 2 };

  const catOf = (id) => CATS.find((c) => c.id === String(id)) || null;
  const cmpId = (a, b) => { a = String(a); b = String(b); return a < b ? -1 : a > b ? 1 : 0; };
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const r1 = (x) => Math.round(x * 10) / 10;

  /** Barème personnalisé vérifié : entiers positifs (au plus MAX_PTS), ou null (barème par défaut). */
  function cleanPts(a) {
    if (!Array.isArray(a)) return null;
    const out = a.slice(0, MAX_PTS).map((x) => Math.round(Number(x))).filter((x) => x > 0 && x <= 1000);
    return out.length ? out : null;
  }

  /** Indice FIETS d'une côte (dénivelé² / (10 × longueur), plus un bonus d'altitude au-delà de 1 000 m) et catégorie qui en découle (null : non classée). */
  function fiets(len, gain, top) {
    return len > 0 ? (gain * gain) / (10 * len) + Math.max(0, (top - 1000) / 1000) : 0;
  }
  function catFor(len, gain, top) {
    const f = fiets(len, gain, top), cat = CATS.find((c) => f >= c.min);
    return { fiets: f, cat: cat ? cat.id : null };
  }

  /**
   * Montées d'un profil (altitudes tous les `step` m) :
   * [{start, end (sommet), len, gain (m), grade, top (altitude du sommet), fiets, cat (null = non classée)}].
   * Une montée s'arrête au sommet quand la route redescend de plus de 20 m, ou après 1 km sans
   * repasser au-dessus. Son pied est avancé jusqu'au début de la vraie pente (≥ 2 % sur 50 m) et
   * son sommet ramené à la fin de la pente (un replat au sommet n'en fait pas partie).
   */
  function findClimbs(ele, step) {
    const n = ele ? ele.length : 0, out = [];
    if (!(n > 2) || !(step > 0)) return out;
    const DROP = 20, FLAT = Math.max(1, Math.round(1000 / step)), W = Math.max(1, Math.round(50 / step));
    let start = 0, peak = 0;
    const flush = () => {
      let a = start, b = peak;
      while (a + W <= b && ele[a + W] - ele[a] < 0.02 * W * step) a++;
      while (b > a && ele[b] - ele[b - 1] < 0.005 * step) b--;
      const len = (b - a) * step, gain = ele[b] - ele[a];
      if (len < 300 || gain < 20 || gain < 0.025 * len) return;
      const top = ele[b];
      const k = catFor(len, gain, top);
      out.push({ start: a * step, end: b * step, len, gain, grade: gain / len, top, fiets: k.fiets, cat: k.cat });
    };
    for (let j = 1; j < n; j++) {
      if (ele[j] > ele[peak]) { peak = j; continue; }
      if (ele[peak] - ele[j] > DROP || j - peak > FLAT) { flush(); start = peak = j; continue; }
      if (ele[j] < ele[start]) start = peak = j;
    }
    flush();
    return out;
  }

  /**
   * Sprints intermédiaires : `count` lignes réparties sur le parcours. Chacune va sur la portion la
   * plus plate, de préférence près de sa position idéale, jamais dans une côte ; sur un parcours
   * accidenté, elle peut s'en éloigner pour trouver du plat. Faute de plat, le sprint est supprimé.
   */
  function placeSprints(ele, step, climbs, count) {
    const n = ele.length, L = step * (n - 1);
    if (!(count > 0) || L < 4000) return [];
    count = Math.min(count, MAX_SPRINTS, Math.max(1, Math.floor(L / 5000)));
    const at = (s) => {
      const x = U.clamp(s / step, 0, n - 1), i = Math.min(n - 2, Math.floor(x));
      return ele[i] + (ele[i + 1] - ele[i]) * (x - i);
    };
    const span = L / (count + 1), win = 0.3 * span, out = [];
    for (let k = 1; k <= count; k++) {
      const target = k * span;
      let best = null, bestScore = Infinity;
      for (let s = 1000; s <= L - 1500; s += 50) {
        // pente des 300 derniers mètres (1 % ≈ 1 point), éloignement de la position idéale (1 point par 30 % d'intervalle)
        let score = Math.abs(at(s) - at(s - 300)) / 3 + Math.abs(s - target) / win;
        for (const c of climbs) {
          if (s > c.start - 500 && s < c.end + 300) score += 8;        // dans la côte ou à son pied
          else if (s >= c.end + 300 && s < c.end + 1000) score += 3;   // au début de la descente
        }
        for (const p of out) if (Math.abs(s - p) < 0.5 * span) score += 10; // trop près d'un autre sprint
        if (score < bestScore) { bestScore = score; best = s; }
      }
      if (best !== null && bestScore <= 5) out.push(best);
    }
    return out.sort((a, b) => a - b);
  }

  const SPRINT_GAP = 2000;   // distance minimale (m) entre un sprint ajouté et un autre sprint, le départ ou l'arrivée

  /**
   * Un sprint intermédiaire de plus, là où il n'y en a pas encore : vers le milieu du plus grand intervalle libre entre le
   * départ, les sprints déjà posés (taken : distances en m) et l'arrivée, sur la portion la plus plate des environs, loin des
   * côtes détectées (climbs) et des zones à éviter (avoid : [{start, end}] en m, côtes posées à la main, ravitaillements).
   * Faute de plat dans cet intervalle, on essaie le suivant. Renvoie la distance de la ligne (m), ou null s'il n'y a plus de place.
   */
  function nextSprint(ele, step, climbs, taken, avoid) {
    const n = ele ? ele.length : 0, L = step * (n - 1);
    if (!(n > 2) || L < 4000) return null;
    const at = (s) => {
      const x = U.clamp(s / step, 0, n - 1), i = Math.min(n - 2, Math.floor(x));
      return ele[i] + (ele[i + 1] - ele[i]) * (x - i);
    };
    const marks = [0, ...(taken || []).filter((s) => s > 0 && s < L).sort((a, b) => a - b), L];
    const gaps = [];
    for (let k = 1; k < marks.length; k++) gaps.push({ a: marks[k - 1], b: marks[k] });
    gaps.sort((x, y) => (y.b - y.a) - (x.b - x.a));
    for (const g of gaps) {
      const span = (g.b - g.a) / 2, target = (g.a + g.b) / 2, win = 0.3 * span;
      const lo = Math.max(1000, g.a + SPRINT_GAP), hi = Math.min(L - 1500, g.b - SPRINT_GAP);
      let best = null, bestScore = Infinity;
      for (let s = lo; s <= hi; s += 50) {
        // mêmes critères que placeSprints : pente des 300 derniers mètres (3 % au plus), éloignement du milieu de l'intervalle, côtes
        const rise = Math.abs(at(s) - at(s - 300));
        if (rise > 9) continue;
        let score = rise / 3 + Math.abs(s - target) / win;
        for (const c of climbs || []) {
          if (s > c.start - 500 && s < c.end + 300) score += 8;
          else if (s >= c.end + 300 && s < c.end + 1000) score += 3;
        }
        for (const z of avoid || []) if (s > z.start - 300 && s < z.end + 300) score += 8;
        if (score < bestScore) { bestScore = score; best = s; }
      }
      if (best !== null && bestScore <= 5) return Math.round(best);
    }
    return null;
  }

  /** Une côte détectée c ({start, end, len}) est-elle déjà posée (t : {start, end}, du pied au sommet, en m) ? */
  function sameClimb(c, t) {
    if (Math.abs(t.end - c.end) < 300) return true;
    const common = Math.min(c.end, t.end) - Math.max(c.start, t.start);
    return common > 0 && common >= 0.3 * Math.min(c.len, Math.max(1, t.end - t.start));
  }

  /**
   * Une côte classée de plus : la plus dure (indice FIETS) des montées détectées et classées qui n'est pas déjà dans la liste
   * (taken : [{start, end}] en m, du pied au sommet). Renvoie un point de passage {type: 'kom', s, cat, start, len, gain}, ou null.
   */
  function nextClimb(ele, step, taken) {
    const L = step * (ele.length - 1);
    const free = findClimbs(ele, step).filter((c) => c.cat && !(taken || []).some((t) => sameClimb(c, t)));
    if (!free.length) return null;
    const c = free.reduce((a, b) => (b.fiets > a.fiets ? b : a));
    return { type: 'kom', s: L - c.end < 200 ? L : c.end, cat: c.cat, start: c.start, len: c.len, gain: c.gain };
  }

  /**
   * Points de passage d'un parcours selon les règles {sprints (nombre), kom (GPM)}.
   * src : profil ou parcours de simulation ({ele, step}).
   */
  function build(src, rules) {
    const ele = src.ele, step = src.step, L = step * (ele.length - 1);
    rules = rules || {};
    const climbs = findClimbs(ele, step);
    const list = [];
    if (rules.kom) {
      for (const c of climbs) {
        if (!c.cat) continue;
        list.push({ type: 'kom', s: L - c.end < 200 ? L : c.end, cat: c.cat, start: c.start, len: c.len, gain: c.gain });
      }
    }
    for (const s of placeSprints(ele, step, climbs, Math.floor(Number(rules.sprints) || 0))) list.push({ type: 'sprint', s });
    return normalize(list, L);
  }

  /**
   * Liste de points de passage vérifiée (construite ici ou reçue d'un autre joueur) : triée, numérotée,
   * l'arrivée (longueur L du parcours) en dernier.
   */
  function normalize(list, L) {
    const out = [];
    for (const x of Array.isArray(list) ? list.slice(0, MAX_CPS) : []) {
      if (!x || (x.type !== 'sprint' && x.type !== 'kom')) continue;
      const s0 = Number(x.s);
      if (!(s0 > 0) || !(L > 0)) continue;
      const s = s0 > L - 0.05 ? L : r1(s0);
      const cp = { type: x.type, s };
      const pts = cleanPts(x.pts);
      if (pts) cp.pts = pts;
      if (x.type === 'kom') {
        const cat = catOf(x.cat);
        if (!cat) continue;
        cp.cat = cat.id;
        cp.start = r1(U.clamp(Number(x.start) || 0, 0, s));
        cp.len = r1(U.clamp(Number(x.len) || s - cp.start, 0, s));
        cp.gain = r1(Math.max(0, Number(x.gain) || 0));
      } else if (s >= L) continue; // pas de sprint intermédiaire sur la ligne d'arrivée
      out.push(cp);
    }
    out.push({ type: 'finish', s: L });
    out.sort((a, b) => a.s - b.s || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
    let ns = 0, nk = 0;
    for (const cp of out) {
      if (cp.type === 'sprint') cp.n = ++ns;
      else if (cp.type === 'kom') cp.n = ++nk;
    }
    return out;
  }

  /**
   * Points de passage d'une liste choisie sur la page Parcours : [{ id, type: 'sprint' | 'kom', km, startKm (pied de la
   * côte), cat, pts (barème personnalisé, facultatif) }], vérifiée et complétée (longueur et dénivelé de chaque côte
   * d'après le profil src = {ele, step}), puis l'arrivée.
   */
  function fromList(items, src) {
    const L = src.step * (src.ele.length - 1);
    const at = (s) => {
      const x = U.clamp(s / src.step, 0, src.ele.length - 1), i = Math.min(src.ele.length - 2, Math.floor(x));
      return src.ele[i] + (src.ele[i + 1] - src.ele[i]) * (x - i);
    };
    const list = [];
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || (it.type !== 'sprint' && it.type !== 'kom')) continue;
      const s = Number(it.km) * 1000;
      if (!(s > 0) || s > L + 1) continue; // le parcours a pu être raccourci depuis
      const cp = { type: it.type, s: s > L - 0.05 ? L : s, cat: it.cat, pts: it.pts };
      if (it.type === 'kom') {
        const a = U.clamp(Number(it.startKm) * 1000 || 0, 0, cp.s);
        cp.start = a; cp.len = cp.s - a; cp.gain = Math.max(0, at(cp.s) - at(a));
      }
      list.push(cp);
    }
    return normalize(list, L);
  }

  /** Points de passage calculés (build) sous la forme d'éléments de liste de la page Parcours. */
  function toItems(cps) {
    return cps.filter((c) => c.type !== 'finish').map((c) => (c.type === 'kom'
      ? { id: U.uid(), type: 'kom', km: Math.round(c.s) / 1000, startKm: Math.round(c.start) / 1000, cat: c.cat }
      : { id: U.uid(), type: 'sprint', km: Math.round(c.s) / 1000 }));
  }

  /** Y a-t-il des classements annexes (au moins un sprint ou un sommet) ? */
  function active(cps) { return !!cps && cps.some((c) => c.type !== 'finish'); }

  /* ---------- Noms ---------- */
  const sprintCount = (cps) => (cps ? cps.filter((c) => c.type === 'sprint').length : 0);

  /** Nom court : « Sprint », « Sprint 2 », « GPM 3ᵉ cat. », « Arrivée ». */
  function shortLabel(cp, cps) {
    if (cp.type === 'finish') return 'Arrivée';
    if (cp.type === 'sprint') return sprintCount(cps) > 1 ? `Sprint ${cp.n}` : 'Sprint';
    return `GPM ${catOf(cp.cat).short}`;
  }

  /** Nom complet : « Sprint intermédiaire du km 12,4 », « Côte du km 18,2 (4ᵉ catégorie) »… */
  function longLabel(cp, cps) {
    const km = U.fmt(cp.s / 1000, 1);
    if (cp.type === 'finish') return `Arrivée (km ${km})`;
    if (cp.type === 'sprint') return `Sprint intermédiaire du km ${km}`;
    const cat = catOf(cp.cat);
    const L = cps && cps.length ? cps[cps.length - 1].s : Infinity;
    const what = cp.s >= L ? 'Arrivée au sommet' : `${cat.id === 'hc' || cat.id === '1' || cat.id === '2' ? 'Col' : 'Côte'} du km ${km}`;
    return `${what} (${cat.name})`;
  }

  /** Profil d'une côte : « 2,4 km à 6,1 % ». */
  function climbText(cp) {
    return cp.type === 'kom' && cp.len > 0 ? `${U.fmt(cp.len / 1000, 1)} km à ${U.fmt((cp.gain / cp.len) * 100, 1)} %` : '';
  }

  /* ---------- Points et classements ---------- */
  /** Barème par défaut d'un sprint, d'une arrivée ou d'une côte de catégorie `cat`. */
  function defaultScale(type, cat) {
    if (type === 'sprint') return SPRINT_PTS;
    if (type === 'finish') return FINISH_PTS;
    const c = catOf(cat);
    return c ? c.pts : [];
  }

  /** Points distribués à un point de passage : son barème personnalisé, sinon celui par défaut. */
  function scale(cp) {
    return cleanPts(cp.pts) || defaultScale(cp.type, cp.cat);
  }

  /** Points du coureur classé `rank` (1 = premier) au point de passage cp. */
  function pointsFor(cp, rank) { return scale(cp)[rank - 1] || 0; }

  /** Importance d'un point de passage pour départager les ex æquo (0 = le plus important). */
  function importance(cp) {
    if (cp.type === 'finish') return 0;
    if (cp.type === 'sprint') return 1;
    return Math.max(0, CATS.findIndex((c) => c.id === cp.cat));
  }

  /** Cumul des points ; à égalité, le plus de victoires aux points les plus importants, puis le meilleur au général. */
  function tally(cps, passages, types, gc) {
    const acc = new Map();
    cps.forEach((cp, k) => {
      if (!types.includes(cp.type)) return;
      const lvl = importance(cp);
      for (const p of passages[k]) {
        if (!p.pts) continue;
        let a = acc.get(p.id);
        if (!a) { a = { id: p.id, pts: 0, wins: [0, 0, 0, 0, 0] }; acc.set(p.id, a); }
        a.pts += p.pts;
        if (p.rank === 1) a.wins[lvl]++;
      }
    });
    const list = [...acc.values()];
    list.sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      for (let i = 0; i < a.wins.length; i++) if (b.wins[i] !== a.wins[i]) return b.wins[i] - a.wins[i];
      return (gc.get(a.id) || 1e9) - (gc.get(b.id) || 1e9) || cmpId(a.id, b.id);
    });
    list.forEach((x, i) => { x.rank = i + 1; });
    return list;
  }

  /**
   * Classements à partir des temps de passage.
   * riders : [{id, splits: [t | null, …] (un par point de passage), s (distance, pour les non-arrivés)}]
   * Renvoie {passages, points, kom, general} :
   *   passages[k] : [{id, t, rank, gap, pts}] dans l'ordre de passage au point k ;
   *   points, kom : [{id, pts, rank}] coureurs ayant marqué, du premier au dernier ;
   *   general     : [{id, time (ou null), s, rank}] arrivés au temps, puis les autres à la distance.
   */
  function standings(cps, riders) {
    const fin = cps.length - 1;
    const split = (r, k) => num(r.splits ? r.splits[k] : null);
    const passages = cps.map((cp, k) => {
      const list = [];
      for (const r of riders) { const t = split(r, k); if (t !== null) list.push({ id: r.id, t }); }
      list.sort((a, b) => a.t - b.t || cmpId(a.id, b.id));
      list.forEach((p, i) => { p.rank = i + 1; p.gap = p.t - list[0].t; p.pts = pointsFor(cp, i + 1); });
      return list;
    });
    const general = riders.map((r) => ({ id: r.id, time: split(r, fin), s: Number(r.s) || 0 }));
    general.sort((a, b) => {
      if (a.time !== null && b.time !== null) return a.time - b.time || cmpId(a.id, b.id);
      if (a.time !== null) return -1;
      if (b.time !== null) return 1;
      return b.s - a.s || cmpId(a.id, b.id);
    });
    general.forEach((g, i) => { g.rank = i + 1; });
    const gc = new Map(general.map((g) => [g.id, g.rank]));
    return { passages, points: tally(cps, passages, ['finish', 'sprint'], gc), kom: tally(cps, passages, ['kom'], gc), general };
  }

  /* ---------- Temps de passage d'un résultat enregistré ---------- */
  /** Temps (s) auquel une trace « position à chaque seconde » atteint la distance s (null si jamais). */
  function traceTime(sArr, s) {
    const n = sArr.length - 1;
    if (!(n >= 1) || !(sArr[n] >= s)) return null;
    if (s <= sArr[0]) return 0;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sArr[m] < s) lo = m; else hi = m; }
    const span = sArr[hi] - sArr[lo];
    return lo + (span > 0 ? (s - sArr[lo]) / span : 0);
  }

  /** Temps de passage d'un résultat (défi, course en direct) : ceux enregistrés, sinon d'après sa trace. */
  function entrySplits(cps, e) {
    if (Array.isArray(e.sp) && e.sp.length === cps.length) return e.sp.map(num);
    const L = cps[cps.length - 1].s;
    return cps.map((cp) => {
      if (cp.s >= L) return num(e.time);
      return Array.isArray(e.s) ? traceTime(e.s, cp.s) : null;
    });
  }

  /** Temps de passage reçus du réseau : n valeurs au plus, nombres positifs ou null. */
  function cleanSplits(sp, n) {
    return Array.isArray(sp) ? sp.slice(0, n).map(num) : null;
  }

  /** Temps de passage à transmettre (centièmes de seconde). */
  function packSplits(sp) {
    return sp.map((t) => (t === null || t === undefined ? null : Math.round(t * 100) / 100));
  }

  PYR.classif = {
    CATS, SPRINT_PTS, FINISH_PTS, MAX_SPRINTS, MAX_PTS,
    catOf, catFor, cleanPts, defaultScale, findClimbs, placeSprints, nextSprint, nextClimb, build, fromList, toItems, normalize, active,
    shortLabel, longLabel, climbText, pointsFor, standings,
    traceTime, entrySplits, cleanSplits, packSplits,
  };
})(globalThis.PYR = globalThis.PYR || {});
