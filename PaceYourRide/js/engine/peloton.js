/* author : Hugo Joudrier-Faure */
/* PaceYourRide — peloton en deux dimensions (mode jeu, règle `peloton`) : chaque coureur a une position latérale y sur
 * une route dont la largeur dépend du revêtement (course.width), et l'aspiration tient compte de cette position.
 *
 * Conventions : y en mètres depuis l'axe de la route, + = à droite dans le sens de la marche ; vent de côté signé
 * cond.wcS > 0 quand il vient de la droite (le sillage part alors vers −y). tb = tangente du lacet du vent apparent.
 *
 * Aspiration (field) : le sillage d'un coureur part de toute sa silhouette (de la roue avant à la roue arrière), poussé
 * sous le vent par le vent de côté. Pour un coureur i derrière j (dx entre les roues avant, dy = y_i − y_j) :
 *   écart effectif le long du sillage a, écart latéral au sillage c, recouvrement λ = exp(−(c / (σ0 + σk·a))²),
 *   abri de la paire = followReduction(a) · λ (draft.js) — sans vent et dans l'axe, c'est exactement le modèle en file.
 * La roue est la paire la plus abritante ; la rangée devant la complète (couverture), les coureurs plus loin devant
 * renforcent l'abri (packBoost, pondéré par leur décalage latéral) et les voisins des deux côtés (du côté du vent par vent
 * de côté) l'enferment : au cœur d'un grand peloton compact, on ne subit plus que ≈ 7 à 12 % de la traînée seul
 * (Blocken et al. 2018 : 5 à 10 %). Un coureur contre le bord sous le vent, dont la place idéale tombe hors de la route,
 * est « en bordure » (edge).
 *
 * Placement (steer, chaque seconde, d'avant en arrière) : besoin d'abri `need` (effort seul au vent rapporté à la FTP,
 * vitesse, vent de côté) ; on se tient dans le sillage de sa roue (en quinconce si la place est prise), on remonte par une
 * voie libre (coureurs virtuels qui « flottent » dans le groupe, « Suivre les attaques », attaques et sprints), celui qui
 * relaie s'écarte côté vent pour se laisser glisser (il abrite ainsi la ligne qui monte), celui qui mène glisse vers le bord
 * au vent pour laisser l'éventail se déployer. Vitesse latérale bornée, écartement minimal entre voisins, route à sa
 * largeur (rétrécissement anticipé). Allure faible : groupe large et compact, un couloir libre le long des bords ; allure
 * forte : on se range au bout de la file (fermeture éclair, pickWheel) ; fort vent de côté : éventail, et ceux qui n'y
 * tiennent pas roulent en bordure, à peine abrités.
 * Garde-fou (guard) : on ne traverse pas un coureur qui roule devant dans sa voie (les coureurs avancent d'avant en arrière :
 * on connaît sa position de fin de seconde), on passe derrière le voisin quand la place manque à côté, et l'on ouvre un trou
 * à celui qui doit rentrer dans sa voie quand la route se rétrécit. */
(function (PYR) {
  'use strict';

  const Dr = PYR.draft;
  const BIKE = Dr.BIKE;
  const RIDER_W = 0.45;   // m : largeur d'un cycliste (guidon, épaules)
  const LANE = 0.6;       // m : écart latéral entre deux coureurs côte à côte dans un peloton compact (rang de changement de voie)
  const MIN_DY = 0.5;     // m : écart latéral minimal entre deux coureurs qui se chevauchent en longueur
  const OFF_MAX = 0.2, WOB = 0.08; // m : décalage personnel de chacun par rapport à la roue qu'il suit, et son oscillation lente
  const EDGE = 0.35;      // m : marge au bord de la route (centre du coureur)
  const SIGMA0 = 0.40, SIGMA_K = 0.04; // m, sans unité : largeur du cœur du sillage au contact, et son élargissement avec la distance
  const SHOULDER = 0.4, SIGMA_W0 = 1.0, SIGMA_WK = 0.05; // part et largeur de l'« épaule » du sillage : un peu d'abri en diagonale, derrière et sur le côté
  const PACK_REACH = 12, PACK_MAX = 40, PACK_SIGMA = 1.2; // abri collectif : portée, limite (m), largeur latérale (m)
  const ENC = 0.4;        // renforcement maximal de l'abri par l'enfermement (voisins des deux côtés)
  const CROSS_K = 0.5;    // le vent de côté brasse le sillage : abri divisé par 1 + 0,5·tb²
  const MAX_R = 0.93;     // réduction maximale du CdA : 7 % de la traînée seul au vent
  const VY_MAX = 0.6, VY_FORCE = 1.2; // m/s : vitesse latérale ; pour rentrer sur la route qui se rétrécit
  const FREE_MAX = 20;    // m : route dégagée devant prise en compte pour choisir une voie
  const SWITCH = 1;       // m : on ne change de roue que pour une nettement meilleure
  const RELAY_FRONT = 12; // places : les coureurs virtuels ne prennent les relais qu'en tête du groupe
  const NUDGE_S = 3;      // s : décalage demandé par le joueur (← →), avant que le placement automatique reprenne
  const ROW = 2.2;        // m : écart entre deux rangs de la grille de départ
  const OVERLAP = 0.2;    // m : deux coureurs dont les positions sont à moins de BIKE + 0,2 m se chevauchent (côte à côte)
  const ROAM_FROM = 30;   // s : les coureurs virtuels commencent à remonter le groupe après le départ
  const CENTER_DRIFT = 0.1; // m/s : dérive vers le milieu de la route de celui qui n'est dans aucun sillage
  const LAYER_MODES = ['follow', 'cover', 'relay'];
  const EDGE_R = 0.25;    // abri sous lequel le coureur contre le bord sous le vent est « en bordure »
  const R_NONE = 300, R_FULL = 90; // m : au-delà de R_NONE (rayon du tracé), pas de corde ; en deçà de R_FULL, on la prend à fond
  const LINE_LOOK = 5;    // s : on se place à la corde dès que le virage est à moins de 5 s
  const LINE_MARGIN = 0.25; // m : la corde passe à cette distance du bord intérieur de la route (en plus de EDGE)
  const LINE_MIX = 0.9;   // part de la corde dans la consigne latérale en plein virage (le reste : sillage, relais…)
  const X_MAX = 0.3;      // part maximale du rayon de courbure dont la trajectoire s'écarte du tracé (borne le gain et la perte de chemin)

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const sm = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const idLess = (a, b) => String(a) < String(b);

  /** Demi-largeur praticable (m) à la distance s : la moitié de la largeur de route, moins la marge au bord. */
  function halfWidth(course, s) {
    if (!course || !course.width) return Infinity;
    let i = (s / course.step) | 0;
    if (i < 0) i = 0; else if (i >= course.n) i = course.n - 1;
    return Math.max(0.2, course.width[i] / 2 - EDGE);
  }

  /** Plus petite demi-largeur sur les 5 prochaines secondes (anticipe l'entrée d'un secteur pavé, d'un chemin). */
  function halfAhead(course, s, v) {
    if (!course || !course.width) return Infinity;
    const n = course.n, a = clamp((s / course.step) | 0, 0, n - 1), b = clamp(((s + 5 * Math.max(3, v || 0)) / course.step) | 0, 0, n - 1);
    let w = Infinity;
    for (let i = a; i <= b; i++) if (course.width[i] < w) w = course.width[i];
    return Math.max(0.2, w / 2 - EDGE);
  }

  /**
   * Virages du parcours pour la trajectoire : force signée de la corde à chaque cellule, de 0 (route droite ou courbe douce, rayon
   * ≥ R_NONE) à ±1 (rayon ≤ R_FULL) ; > 0 virage à droite (la corde est à droite). null sans courbure (parcours synthétique).
   */
  const lineCache = new WeakMap();
  function lineWeights(course) {
    if (!course || !course.kappa) return null;
    let w = lineCache.get(course);
    if (w) return w;
    const k = course.kappa, n = course.n, a0 = 1 / R_NONE, a1 = 1 / R_FULL;
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = (k[i] < 0 ? -1 : 1) * sm((Math.abs(k[i]) - a0) / (a1 - a0));
    lineCache.set(course, w);
    return w;
  }

  /**
   * Corde à prendre : force signée (cf. lineWeights) du prochain virage dans les LINE_LOOK secondes devant, ou du virage en cours ;
   * 0 sans virage. Un virage de sens inverse qui suit le premier ne compte pas avant que le premier soit fini.
   */
  function cornerAhead(course, s, v) {
    const w = lineWeights(course);
    if (!w) return 0;
    const n = course.n, i0 = clamp((s / course.step) | 0, 0, n - 1);
    const i1 = Math.min(n - 1, i0 + Math.ceil((LINE_LOOK * Math.max(4, v)) / course.step));
    let side = 0, best = 0;
    for (let i = i0; i <= i1; i++) {
      const a = Math.abs(w[i]);
      if (a < 0.05) continue;
      const sg = w[i] < 0 ? -1 : 1;
      if (side === 0) { side = sg; best = a; } else if (sg === side) { if (a > best) best = a; } else break;
    }
    return side * best;
  }

  /**
   * Effets d'une position latérale y (m, + = à droite) dans un virage à la cellule i : x = y·κ est la part du rayon dont on
   * s'écarte du tracé (> 0 à la corde, < 0 au large). Le chemin parcouru par mètre de tracé est 1 − x : à la corde il est plus
   * court, au large plus long ; pathK = 1 / (1 − x) est donc la distance de tracé couverte par mètre de chemin (> 1 à la corde :
   * à vitesse égale, on avance plus vite sur le tracé). La limite de vitesse en virage n'en dépend pas : on suppose que celui qui
   * prend la corde s'y prépare en se plaçant large à l'entrée, ce qui lui garde un rayon au moins égal à celui du tracé.
   */
  function pathFactor(course, i, y) {
    const k = course && course.kappa ? course.kappa[i] : 0;
    if (!k || !y) return 1;
    return 1 / (1 - clamp(y * k, -X_MAX, X_MAX));
  }

  /** Applique la trajectoire du coureur (position latérale moyenne de la seconde) à ses conditions (race.stepRider, après Sim.conditions). */
  function applyLine(course, r) {
    const L = r.lat;
    if (L) r.cond.pathK = pathFactor(course, r.cond.i, 0.5 * (L.prevY + L.y));
  }

  /** Tangente du lacet du vent apparent d'un coureur (conditions de la seconde écoulée) : > 0, vent venant de sa droite. */
  function yaw(r) {
    const c = r.cond;
    if (!c || !Number.isFinite(c.wcS)) return 0;
    return clamp(c.wcS / Math.max(3, r.st.v + (c.wh || 0)), -1.2, 1.2);
  }

  /**
   * Abri d'une paire : coureur i derrière j, dx = s_j − s_i (roues avant), dy = y_i − y_j, tb = lacet du vent apparent de i.
   * out (facultatif, réutilisé) reçoit {a (écart le long du sillage), c (écart latéral au sillage), lam (recouvrement), R}.
   */
  const PAIR = { a: 0, c: 0, lam: 0, R: 0 };
  function pair(dx, dy, tb, out) {
    const o = out || PAIR;
    let a, c;
    if (tb === 0) { a = dx - BIKE; c = dy; } else {
      const cb = 1 / Math.sqrt(1 + tb * tb), sb = tb * cb;
      const c0 = dx * sb + dy * cb;
      const tau = clamp(c0 / sb, 0, BIKE); // point de la silhouette de j dont le sillage passe au plus près de i
      c = c0 - tau * sb;
      a = (dx - tau) * cb - dy * sb;
    }
    const aa = a > 0 ? a : 0, sig = SIGMA0 + SIGMA_K * aa, sw = SIGMA_W0 + SIGMA_WK * aa;
    // cœur étroit (derrière la roue) et épaule large (un peu derrière, sur le côté : l'abri y est partiel, bien moindre qu'en ligne)
    const lam = (1 - SHOULDER) * Math.exp(-(c * c) / (sig * sig)) + SHOULDER * Math.exp(-(c * c) / (sw * sw));
    o.a = a; o.c = c; o.lam = lam; o.R = Dr.followReduction(a) * lam;
    return o;
  }

  /* tableaux de travail de field, agrandis au besoin */
  let cap = 0, gA, gC, gL, gJ, wheelA, chainA, groupA, tailA, tailI;
  function scratch(n, k) {
    if (n > cap || k > (gA ? gA.length : 0)) {
      cap = Math.max(n, cap, 16);
      const m = Math.max(k, gA ? gA.length : 0, 64);
      gA = new Float64Array(m); gC = new Float64Array(m); gL = new Float64Array(m); gJ = new Int32Array(m);
      wheelA = new Int32Array(cap); chainA = new Int32Array(cap); groupA = new Int32Array(cap);
      tailA = new Float64Array(cap); tailI = new Int32Array(cap);
    }
  }

  /**
   * Aspiration de tous les coureurs actifs, en deux dimensions.
   * list : [{id, s, v, y, tb}] ; course (facultatif) : largeur de route, pour « en bordure ».
   * Renvoie Map id → {R, k, role, gapAhead, gapBehind, wheel, chain, group, groupSize, rank, edge, tail, cov}, comme draft.field,
   * plus edge (en bordure) et tail (id du coureur collé dans notre sillage). Écrit aussi tail / tailA sur les entrées (pickWheel).
   */
  function field(list, course) {
    const order = list.slice().sort((a, b) => b.s - a.s);
    const n = order.length;
    scratch(n, n);
    const wheel = wheelA, chain = chainA, group = groupA;
    const ys = new Float64Array(n), tbs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ys[i] = Number.isFinite(order[i].y) ? order[i].y : 0;
      tbs[i] = Number.isFinite(order[i].tb) ? order[i].tb : 0;
      group[i] = i > 0 ? group[i - 1] + (order[i - 1].s - order[i].s - BIKE > Dr.GROUP_GAP ? 1 : 0) : 0;
      tailA[i] = Infinity; tailI[i] = -1;
    }
    const size = [], first = [];
    for (let i = 0; i < n; i++) {
      size[group[i]] = (size[group[i]] || 0) + 1;
      if (first[group[i]] === undefined) first[group[i]] = i;
    }
    const res = new Array(n);
    const P = { a: 0, c: 0, lam: 0, R: 0 };
    for (let i = 0; i < n; i++) {
      const x = order[i], s = x.s, y = ys[i], tb = tbs[i];
      // coureurs devant à portée : écart le long du sillage, écart latéral, recouvrement
      let k = 0, best = -1, bestR = 0;
      for (let j = i - 1; j >= 0; j--) {
        const dx = order[j].s - s;
        if (dx - BIKE > PACK_MAX + 2) break;
        pair(dx, y - ys[j], tb, P);
        if (P.a < -0.5 || P.a > PACK_MAX) continue;
        gA[k] = P.a; gC[k] = P.c; gL[k] = P.lam; gJ[k] = j;
        if (P.R > bestR) { bestR = P.R; best = k; }
        k++;
      }
      let follow = 0, extra = 0, cov = 0, aStar = Infinity;
      wheel[i] = -1;
      if (best >= 0) {
        aStar = gA[best];
        wheel[i] = gJ[best];
        for (let q = 0; q < k; q++) {
          if (Math.abs(gA[q] - aStar) < 1 && gA[q] <= Dr.RANGE) cov += gL[q]; // la rangée devant
          else extra += Math.exp(-gA[q] / PACK_REACH) * Math.exp(-(gC[q] * gC[q]) / (PACK_SIGMA * PACK_SIGMA));
        }
        if (cov > 1) cov = 1;
        // enfermement : voisins à côté et un peu devant, de chaque côté
        let wl = 0, wr = 0;
        for (let j = i - 1; j >= 0 && order[j].s - s <= 8; j--) {
          const d = Math.abs(ys[j] - y);
          if (d < 0.35 || d > 2.5) continue;
          const dx = order[j].s - s;
          const w = Math.exp(-Math.max(0, dx - BIKE) / 6) * Math.exp(-((d - LANE) / 0.9) * ((d - LANE) / 0.9));
          if (ys[j] > y) wr += w; else wl += w;
        }
        for (let j = i + 1; j < n && s - order[j].s <= BIKE; j++) {
          const d = Math.abs(ys[j] - y);
          if (d < 0.35 || d > 2.5) continue;
          const w = Math.exp(-((d - LANE) / 0.9) * ((d - LANE) / 0.9));
          if (ys[j] > y) wr += w; else wl += w;
        }
        const fL = 1 - Math.exp(-wl / 1.2), fR = 1 - Math.exp(-wr / 1.2);
        const om = Math.min(1, Math.abs(tb));
        const E = (1 - om) * fL * fR + om * (tb > 0 ? fR : fL);
        follow = Dr.followReduction(aStar) * cov * Dr.packBoost(extra) * (1 + ENC * E);
        chain[i] = chain[wheel[i]] + 1;
        // sillage de la roue : le plus proche des coureurs qui s'y abritent vraiment
        if (gL[best] >= 0.5 && aStar < tailA[wheel[i]]) { tailA[wheel[i]] = aStar; tailI[wheel[i]] = i; }
      } else chain[i] = 0;
      res[i] = { follow, cov, aStar, tb };
    }
    const out = new Map();
    for (let i = 0; i < n; i++) {
      const x = order[i], r = res[i], gs = size[group[i]];
      const gapBehind = tailI[i] >= 0 && tailA[i] <= 3 ? tailA[i] : Infinity; // comme draft.js : quelqu'un collé à notre roue
      const lead = Dr.leadReduction(gapBehind) * (gs >= 3 ? 1.4 : 1);
      let R = r.follow + (r.follow > 0 ? 0.5 * lead : lead);
      R /= 1 + CROSS_K * r.tb * r.tb;
      if (R > MAX_R) R = MAX_R;
      const role = r.follow > 0.02 ? 'follow' : gs > 1 && first[group[i]] === i ? 'lead' : 'solo';
      // en bordure : vent de côté, contre le bord sous le vent, la place idéale derrière le coureur devant tombe hors de la route,
      // et on y est mal abrité
      let edge = false;
      if (Math.abs(r.tb) > 0.2 && course && R < EDGE_R) {
        const hw = halfWidth(course, x.s), lee = r.tb > 0 ? -1 : 1, y = ys[i];
        if (y * lee > hw - 0.15) {
          for (let j = i - 1; j >= 0; j--) {
            const dx = order[j].s - x.s;
            if (dx - BIKE > Dr.RANGE) break;
            if (dx < BIKE - 0.5) continue;
            const ideal = ys[j] - (dx - BIKE + 0.1) * r.tb;
            edge = ideal * lee > hw;
            break;
          }
        }
      }
      if (tailI[i] >= 0) { x.tail = order[tailI[i]].id; x.tailA = tailA[i]; } else { x.tail = null; x.tailA = Infinity; }
      out.set(x.id, {
        R, k: 1 - R, role,
        gapAhead: wheel[i] >= 0 ? order[wheel[i]].s - x.s - BIKE : Infinity, gapBehind,
        wheel: wheel[i] >= 0 ? order[wheel[i]].id : null, chain: chain[i],
        group: group[i], groupSize: gs, rank: i - first[group[i]],
        edge, tail: x.tail, cov: r.cov,
      });
    }
    return out;
  }

  /* ---------- état latéral d'un coureur ---------- */

  /** État latéral d'un coureur simulé (race.addRider, règle peloton). */
  function state(r) {
    // décalage personnel et phase de l'oscillation : tirés de l'identifiant (sans toucher aux flux aléatoires de la course)
    let h = 2166136261;
    for (const ch of String(r.id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    const u1 = (h & 0xffff) / 0xffff, u2 = ((h >>> 16) & 0xffff) / 0xffff, u3 = ((Math.imul(h, 2654435761) >>> 8) & 0xffff) / 0xffff;
    return {
      off: (u1 - 0.5) * 2 * OFF_MAX, per: 4 + 3 * u2, ph: 6.2832 * u3, wobPrev: 0,
      y: 0, prevY: 0, ty: 0, tb: 0, need: 0,
      mode: 'hold', roam: !!r.bot, rho: null, rhoT: 0, upT: 0, upBest: 0, upAgain: 0,
      nudge: null, squeezed: false, blocker: null, swingY: null, freeTy: null, line: 0,
    };
  }

  /** Place le coureur à la position latérale y (départ, tests). */
  function setY(r, y) {
    const L = r.lat;
    if (!L) return;
    L.y = L.prevY = L.ty = y;
  }

  /** Puissance qu'il faudrait seul au vent pour rouler à v (conditions de la seconde écoulée, abri exclu). */
  function soloPower(r, v) {
    const c = r.cond, S = r.setup;
    if (!c || !(c.rho > 0) || !(v > 0)) return 0;
    const va = v + (c.wh || 0);
    const Fa = 0.5 * c.rho * S.cda * Math.sqrt(va * va + (c.wc || 0) * (c.wc || 0)) * va;
    const Fg = S.mass * 9.80665 * (c.sinT || 0);
    const Fr = (c.crr || 0) * S.mass * 9.80665 * (c.cosT === undefined ? 1 : c.cosT);
    return Math.max(0, (Fa + Fg + Fr) * v / (S.eta || 1));
  }

  /**
   * Besoin d'abri (0–1), lissé : effort qu'il faudrait seul au vent à l'allure du groupe (celle de sa tête : celui qui remonte ou
   * revient sur le groupe n'en a pas plus besoin), rapporté à la FTP ; vitesse ; vent de côté.
   */
  function updateNeed(r, L, vGroup) {
    const v = vGroup > 0 ? vGroup : r.st.v;
    const ftp = r.athlete.ftp * (r.st.capK > 0 ? r.st.capK : 1);
    const tau = ftp > 0 ? soloPower(r, v) / ftp : 0;
    // la file indienne ne s'impose qu'à très forte allure (descente, emballage) ou par fort vent de côté : un peloton qui roule
    // vite reste large, chacun profitant de l'abri en diagonale et cherchant à se placer devant pour pouvoir réagir
    const raw = Math.max(sm((tau - 1.6) / 0.6), sm((v - 14) / 4), sm((Math.abs(L.tb) - 0.25) / 0.4));
    L.need += 0.25 * (raw - L.need);
  }

  /**
   * Coureur virtuel qui « flotte » dans le groupe : une place visée (rho, fraction du groupe depuis la tête, retirée de temps à
   * autre) ; derrière elle, il remonte (mode 'up') tant qu'il en a les moyens, puis se laisse de nouveau glisser au gré des relais.
   */
  function roam(race, r, L, info, rnd, ups) {
    const t = r.st.t;
    if (!L.roam || !info || info.groupSize < 4 || r.tac.mode !== 'follow') { L.mode = 'hold'; return; }
    if (L.rhoT === 0) L.rhoT = ROAM_FROM + Math.floor(120 * rnd()); // premières envies de remonter étalées après le départ
    if (t < L.rhoT && L.rho === null) return;
    if (t >= L.rhoT) {
      // place visée : plutôt vers l'avant du groupe (on veut pouvoir réagir à une attaque), d'autant plus qu'on est offensif
      const amb = r.bot ? r.bot.aggr : 0.2;
      L.rho = Math.pow(rnd(), 1.6 + 2 * amb) * 0.9;
      L.rhoT = t + 60 + Math.floor(120 * rnd());
    }
    const frac = info.rank / (info.groupSize - 1);
    const wf = r.st.wbal / Math.max(1, PYR.sim.w0Of(r.ctx, r.st));
    const toGo = race.course.length - r.st.s;
    if (L.mode === 'up') {
      let done = frac <= L.rho || L.need > 0.7 || wf < 0.4 || toGo < 2000;
      if (!done) {
        if (info.rank < L.upBest) { L.upBest = info.rank; L.upT = t; } else if (t - L.upT > 20) done = true; // bloqué : on renonce
      }
      if (done) { L.mode = 'hold'; L.upAgain = t + 10 + Math.floor(40 * rnd()); }
    } else if (frac > L.rho + 0.1 && L.need < 0.6 && wf > 0.5 && toGo > 2000 && t >= L.upAgain
      && (ups.get(info.group) || 0) < Math.max(1, Math.floor(info.groupSize / 6))) {
      L.mode = 'up'; L.upBest = info.rank; L.upT = t;
      ups.set(info.group, (ups.get(info.group) || 0) + 1);
    }
  }

  /**
   * Placement latéral de tous les coureurs pour la seconde à venir (race.step, après le snapshot). Les coureurs sont traités
   * d'avant en arrière : chacun respecte la place déjà prise par ceux de devant, et celle qu'occupent encore ceux de derrière.
   * Les autres joueurs (course en direct) gardent la position qu'ils envoient ; sans elle, ils sont placés ici (race.pelExt).
   */
  function steer(race, view) {
    const C = race.course;
    const rnd = race.pelRnd || (race.pelRnd = PYR.util.mulberry32((race.seed ^ 0x6a09e667) >>> 0));
    const newY = race.pelY || (race.pelY = new Map());
    newY.clear();
    const ents = view.field.filter((e) => !e.finished);
    ents.sort((a, b) => b.s - a.s || (idLess(a.id, b.id) ? -1 : idLess(b.id, a.id) ? 1 : 0));
    const n = ents.length;
    const local = race.pelLocal || (race.pelLocal = new Map());
    if (local.size !== race.riders.length) { local.clear(); for (const r of race.riders) local.set(r.id, r); }
    const byId = new Map();
    for (const e of ents) byId.set(e.id, e);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) ys[i] = Number.isFinite(ents[i].y) ? ents[i].y : 0;
    // allure de chaque groupe : celle de son premier coureur
    const vGroup = new Map();
    for (const e of ents) {
      const inf = view.info.get(e.id);
      if (inf && !vGroup.has(inf.group)) vGroup.set(inf.group, e.v || 0);
    }
    // coureurs en train de remonter, par groupe (on n'en lance pas d'autres au-delà d'un sur dix)
    const ups = new Map();
    for (const r of race.riders) {
      if (!r.lat || r.lat.mode !== 'up') continue;
      const inf = view.info.get(r.id);
      if (inf) ups.set(inf.group, (ups.get(inf.group) || 0) + 1);
    }
    const ctx = { race, view, ents, ys, byId, newY, rnd, C, vGroup, ups };
    for (let i = 0; i < n; i++) {
      const e = ents[i], r = local.get(e.id);
      let ny;
      if (r && r.lat) ny = steerRider(ctx, i, r);
      else if (e.pelLocal) ny = steerPassive(ctx, i);
      else ny = ys[i];
      ys[i] = ny;
      newY.set(e.id, ny);
    }
  }

  /** Position latérale (nouvelle si déjà placée cette seconde) d'une entrée du snapshot. */
  function yOf(ctx, e) {
    const y = ctx.newY.get(e.id);
    return y !== undefined ? y : Number.isFinite(e.y) ? e.y : 0;
  }

  /** Route dégagée (m entre les roues, FREE_MAX au plus) devant le coureur i dans la voie yc. */
  function freeAt(ctx, i, yc) {
    const { ents, ys } = ctx, s = ents[i].s;
    for (let j = i - 1; j >= 0; j--) {
      const dx = ents[j].s - s;
      if (dx - BIKE > FREE_MAX) break;
      if (ents[j].stopped || dx < BIKE - 0.5) continue;
      if (Math.abs(ys[j] - yc) < MIN_DY) return Math.max(0, dx - BIKE);
    }
    return FREE_MAX;
  }

  /**
   * Place latérale libre autour du coureur i : [lo, hi], en évitant les voisins qui le chevauchent en longueur (ou vont le faire
   * dans la seconde : on le rattrape, ou il nous rattrape) ; un coureur juste devant ou juste derrière dans la même voie n'en
   * est pas un. Ceux de devant (déjà placés, à leur nouvelle place) comme ceux de derrière (à leur place actuelle) s'imposent,
   * sauf ceux de derrière déjà trop près (c'est à eux de s'écarter) : rester où l'on est reste ainsi toujours possible, sauf
   * quand la route se rétrécit. blocker : le coureur de devant le plus gênant quand la place manque (le garde-fou nous fait
   * passer derrière lui).
   */
  function room(ctx, i, y, hw) {
    const { ents, ys } = ctx, e = ents[i], s = e.s, v = e.v || 0;
    let lo = -hw, hi = hw, blocker = null, bd = Infinity, left = null, right = null, dl = Infinity, dr = Infinity;
    const side = (j) => ys[j] < y || (ys[j] === y && idLess(ents[j].id, e.id));
    const near = (j) => { const d = Math.abs(ys[j] - y); if (side(j)) { if (d < dl) { dl = d; left = ents[j].id; } } else if (d < dr) { dr = d; right = ents[j].id; } };
    // dans notre voie, juste devant ou juste derrière (sans chevauchement) : c'est le garde-fou qui règle l'écart, pas un écart latéral
    const inLine = (j, dx) => dx >= BIKE && Math.abs(ys[j] - y) < MIN_DY;
    for (let j = i - 1; j >= 0; j--) {
      const o = ents[j], dx = o.s - s;
      if (dx > BIKE + 6) break;
      if (o.stopped || dx - Math.max(0, v - (o.v || 0)) >= BIKE + OVERLAP || inLine(j, dx)) continue;
      if (side(j)) lo = Math.max(lo, ys[j] + MIN_DY); else hi = Math.min(hi, ys[j] - MIN_DY);
      near(j);
      const d = Math.abs(ys[j] - y);
      if (d < bd) { bd = d; blocker = o.id; }
    }
    for (let j = i + 1; j < ents.length; j++) {
      const o = ents[j], dx = s - o.s;
      if (dx > BIKE + 6) break;
      if (o.stopped || dx - Math.max(0, (o.v || 0) - v) >= BIKE + OVERLAP || inLine(j, dx)) continue;
      near(j);
      if (Math.abs(ys[j] - y) < MIN_DY - 1e-9) continue;
      if (side(j)) lo = Math.max(lo, ys[j] + MIN_DY); else hi = Math.min(hi, ys[j] - MIN_DY);
    }
    return { lo, hi, blocker, left, right };
  }

  /** Voie libre visée pour remonter : la plus dégagée devant, sans trop s'écarter, avec hystérésis. */
  function freeLane(ctx, i, L, y, hw, rm) {
    const cand = [y, y - LANE / 2, y + LANE / 2, y - LANE, y + LANE, y - 2 * LANE, y + 2 * LANE, -hw, hw];
    const score = (yc) => freeAt(ctx, i, yc) - 2 * Math.abs(yc - y) - (yc < rm.lo - 0.05 || yc > rm.hi + 0.05 ? 4 : 0);
    let best = y, bestS = -Infinity;
    for (let yc of cand) {
      yc = clamp(yc, -hw, hw);
      const sc = score(yc);
      if (sc > bestS + 1e-9) { bestS = sc; best = yc; }
    }
    if (L.freeTy !== null) {
      const keep = clamp(L.freeTy, -hw, hw);
      if (score(keep) >= bestS - 2) best = keep;
    }
    L.freeTy = best;
    return best;
  }

  /** Place idéale dans le sillage de l'entrée w, pour un coureur en s avec le lacet tb. */
  function wakeY(ctx, w, s, tb) {
    return yOf(ctx, w) - (Math.max(0, w.s - s - BIKE) + 0.1) * tb;
  }

  /** La place juste derrière w est-elle prise par un autre (plus près de sa roue que nous) ? */
  function taken(w, id, gap) {
    return !!w.tail && w.tail !== id && w.tailA < gap + 0.5;
  }

  /** Sillage libre le plus proche devant, à moins d'une demi-voie de y (on s'y glisse sans changer de voie), ou null. */
  function snapWake(ctx, i, id, y, tb) {
    const { ents } = ctx, s = ents[i].s;
    for (let j = i - 1; j >= 0; j--) {
      const o = ents[j], dx = o.s - s;
      if (dx - BIKE > 10) break;
      if (o.stopped || dx < BIKE - 0.5) continue;
      const wy = wakeY(ctx, o, s, tb);
      if (Math.abs(wy - y) < LANE / 2) return taken(o, id, dx - BIKE) ? null : wy;
    }
    return null;
  }

  function steerRider(ctx, i, r) {
    const { race, view, ents, byId, rnd, C } = ctx;
    const L = r.lat, e = ents[i], s = e.s, v = e.v || 0, t = r.st.t, tac = r.tac;
    L.prevY = L.y;
    const hw = halfWidth(C, s), hwA = Math.min(hw, halfAhead(C, s, v));
    // arrêté (crevaison, chute) : on se range au bord le plus proche ; les autres ne nous comptent plus
    if (r.incident) {
      const ty = (L.y >= 0 ? 1 : -1) * hw;
      L.y += clamp(ty - L.y, -VY_FORCE, VY_FORCE);
      L.ty = ty; L.squeezed = false; L.mode = 'hold';
      return L.y;
    }
    const info = view.info.get(r.id);
    updateNeed(r, L, info ? ctx.vGroup.get(info.group) : 0);
    roam(race, r, L, info, rnd, ctx.ups);
    const rm = room(ctx, i, L.y, hw);
    const tb = L.tb, sgn = tb > 0 ? 1 : tb < 0 ? -1 : 0, om = clamp(Math.abs(tb) / 0.3, 0, 1);
    let ty = L.y, free = false, idle = false, plain = false;
    // décalage personnel (de moins en moins quand on se range en file) et oscillation lente : on n'est pas exactement dans la roue
    const wob = WOB * Math.sin(t / L.per + L.ph), loose = 1 - L.need;
    if (tac.mode !== 'relay' || tac.phase !== 'swing') L.swingY = null;
    if (L.nudge && t < L.nudge.until) {
      ty = L.nudge.y;
    } else if (tac.mode === 'relay' && tac.phase === 'swing') {
      // on s'écarte d'un rang, côté vent (on abrite la ligne qui monte), sinon vers le milieu de la route
      if (L.swingY === null) {
        const side = Math.abs(tb) > 0.1 ? sgn : L.y > 0.2 ? -1 : L.y < -0.2 ? 1 : -1;
        let sy = clamp(L.y + side * LANE, -hwA, hwA);
        if (Math.abs(sy - L.y) < 0.4) sy = clamp(L.y - side * LANE, -hwA, hwA);
        L.swingY = sy;
      }
      ty = L.swingY;
    } else if (tac.mode === 'relay' && tac.phase === 'pull') {
      ty = L.y + om * (sgn * (hwA - LANE) - L.y); // un rang de marge côté vent, pour ceux qui se laissent glisser
    } else if (L.mode === 'up' || tac.phase === 'move' || tac.mode === 'attack' || tac.mode === 'sprint') {
      free = true;
    } else {
      const w = tac.wheel ? byId.get(tac.wheel) : null;
      if (w && !w.stopped && w.s - s > -(BIKE - 0.5)) {
        const gap = w.s - s - BIKE;
        if (gap > 1 && gap > freeAt(ctx, i, L.y) + 1) free = true; // quelqu'un entre la roue et nous : on la rejoint par une voie libre
        // par vent de côté, loin derrière sa roue et sans abri : on mène la chasse côté vent, l'éventail se forme derrière nous
        else if (gap > 5 && Math.abs(tb) > 0.2 && info && info.R < 0.05) ty = L.y + om * (sgn * hwA - L.y);
        else if (!taken(w, r.id, gap)) { ty = wakeY(ctx, w, s, tb); plain = true; }
        else idle = true;
      } else {
        const front = info && info.groupSize > 1 && info.rank === 0 && info.role !== 'follow';
        const snap = snapWake(ctx, i, r.id, L.y, tb);
        if (snap !== null) { ty = snap; plain = true; }
        else if (front) ty = L.y + om * (sgn * hwA - L.y); // en tête : vers le bord au vent, l'éventail se déploie derrière
        else idle = true;
      }
    }
    // (le joueur en allure libre garde exactement la voie qu'il a choisie)
    const lively = r.bot || LAYER_MODES.includes(tac.mode);
    if (plain && lively) ty += loose * (L.off + wob);             // dans un sillage : décalé de quelques centimètres, qui oscillent
    else if (idle && lively) ty += loose * (wob - L.wobPrev);     // sans sillage : la voie garde son oscillation lente
    L.wobPrev = wob;
    // sans sillage à prendre, dans un groupe : on se rapproche doucement du milieu de la route ; le peloton se resserre et laisse
    // ses côtés libres pour ceux qui remontent (le joueur en allure libre garde la voie qu'il a choisie)
    const calm = Math.abs(tb) < 0.2, auto = r.bot || LAYER_MODES.includes(tac.mode);
    if (idle && calm && auto && info && info.groupSize > 1 && Math.abs(L.y) > LANE / 2) ty = L.y - Math.sign(L.y) * CENTER_DRIFT;
    // sans vent de côté, sur une route assez large, le groupe laisse un couloir libre le long de chaque bord : c'est par là
    // qu'on remonte (sauf qui y remonte, qui s'y laisse glisser après son relais, ou le joueur en allure libre)
    const band = hwA - LANE;
    if (!free && calm && auto && band >= LANE && !(L.nudge && t < L.nudge.until) && tac.phase !== 'swing') ty = clamp(ty, -band, band);
    if (free) ty = freeLane(ctx, i, L, L.y, hwA, rm); else L.freeTy = null;
    // virage : on descend à la corde, côté intérieur, dès qu'il approche (le joueur en allure libre garde sa voie, ← → pour la prendre)
    L.line = 0;
    if (lively && !(L.nudge && t < L.nudge.until) && !(tac.mode === 'relay' && tac.phase === 'swing')) {
      const cw = cornerAhead(C, s, v);
      if (cw) {
        L.line = cw;
        const mix = clamp(2 * Math.abs(cw), 0, 1) * LINE_MIX * (free ? 0.5 : 1);
        ty += mix * (lineY(ctx, i, v, cw, hwA) - ty);
      }
    }
    return move(L, ty, rm, hw, hwA);
  }

  /**
   * Voie de la corde pour un virage de force cw (> 0 à droite) : contre le bord intérieur de la route (d'autant moins que le
   * virage est doux). Si un coureur nettement plus lent roule juste devant dans cette voie, on prend celle d'à côté, vers
   * l'extérieur : on ne s'enferme pas derrière lui.
   */
  function lineY(ctx, i, v, cw, hwA) {
    const { ents, ys } = ctx, s = ents[i].s;
    const side = cw > 0 ? 1 : -1, edge = Math.max(0, hwA - LINE_MARGIN) * Math.abs(cw);
    for (let k = 0; k < 4; k++) {
      const yc = side * Math.max(0, edge - k * LANE);
      let slow = false;
      for (let j = i - 1; j >= 0; j--) {
        const dx = ents[j].s - s;
        if (dx - BIKE > 10) break;
        if (ents[j].stopped || dx < BIKE - 0.5) continue;
        if (Math.abs(ys[j] - yc) < MIN_DY && (ents[j].v || 0) < v - 0.5) { slow = true; break; }
      }
      if (!slow) return yc;
    }
    return side * Math.max(0, edge - 3 * LANE);
  }

  /** Déplacement latéral vers ty, borné (vitesse, place libre, route) ; squeezed quand la place manque. */
  function move(L, ty, rm, hw, hwA) {
    ty = clamp(ty, -hwA, hwA);
    L.ty = ty;
    const forced = Math.abs(L.y) > hwA + 1e-9 || L.y < rm.lo - 1e-9 || L.y > rm.hi + 1e-9;
    const vmax = forced ? VY_FORCE : VY_MAX;
    let ny = L.y + clamp(ty - L.y, -vmax, vmax);
    const lo = Math.max(rm.lo, -hw, L.y - VY_FORCE), hi = Math.min(rm.hi, hw, L.y + VY_FORCE);
    L.squeezed = lo > hi + 1e-9;
    L.blocker = L.squeezed ? rm.blocker : null;
    L.narrow = false;
    if (L.squeezed) {
      // coincé : on ne bouge pas, le garde-fou nous fait passer derrière celui qui nous gêne ; hors de la route (elle vient de se
      // rétrécir et la place manque), on mord le bas-côté le temps de se glisser derrière le voisin intérieur plutôt que de le percuter
      ny = L.y;
      if (Math.abs(ny) > hw) {
        const inner = ny > 0 ? rm.left : rm.right;
        if (inner) { L.blocker = inner; L.narrow = true; } else ny = clamp(ny, -hw, hw);
      }
    } else ny = clamp(ny, lo, hi);
    // la route se rétrécit devant et la place manque pour rentrer : on lève le pied derrière le voisin côté intérieur (fermeture éclair)
    if (!L.squeezed && Math.abs(ny) > hwA + 0.02) {
      const inner = ny > 0 ? rm.left : rm.right;
      if (inner) { L.squeezed = true; L.blocker = inner; L.narrow = true; }
    }
    L.y = ny;
    return ny;
  }

  /** Autre joueur sans position latérale (ancienne version) : placé ici, dans le sillage devant lui s'il y en a un. */
  function steerPassive(ctx, i) {
    const { race, ents, C } = ctx, e = ents[i];
    const ext = race.pelExt || (race.pelExt = new Map());
    let L = ext.get(e.id);
    if (!L) { L = { y: Number.isFinite(e.y) ? e.y : 0, prevY: 0, ty: 0 }; ext.set(e.id, L); }
    L.prevY = L.y;
    const hw = halfWidth(C, e.s), hwA = Math.min(hw, halfAhead(C, e.s, e.v));
    const rm = room(ctx, i, L.y, hw);
    const snap = snapWake(ctx, i, e.id, L.y, 0);
    return move(L, snap !== null ? snap : L.y, rm, hw, hwA);
  }

  /**
   * Garde-fou (stepRider, après la consigne) : on ne traverse pas un coureur qui roule devant dans notre voie, et on lève le pied
   * quand on n'a pas de place à côté. Renvoie la consigne, réduite au besoin (freinage léger par cond.vCap si nécessaire).
   */
  function guard(race, r, view, Pcmd) {
    const L = r.lat;
    if (!L || r.incident) return Pcmd;
    const s = r.st.s, v = r.st.v, t = r.st.t, c = r.cond, newY = race.pelY, local = race.pelLocal;
    const pk = c.pathK > 0 ? c.pathK : 1; // à la corde, on avance plus sur le tracé qu'on ne roule (virage)
    let vc = Infinity;
    for (const o of view.field) {
      if (o.id === r.id || o.stopped || o.finished) continue;
      const dx = o.s - s;
      const block = o.id === L.blocker && Math.abs(dx) < BIKE + OVERLAP;
      if (!block && (dx <= 0 || dx > BIKE + 1 + 1.5 * Math.max(0, v - o.v))) continue;
      const rr = local && local.get(o.id);
      // fermeture éclair : un coureur juste devant, qui doit rentrer dans notre voie (la route se rétrécit), passe d'abord
      const merging = !!(rr && rr.lat && rr.lat.narrow && dx > 0.3 && Math.abs(rr.lat.ty - L.y) < MIN_DY);
      const oy = merging ? L.y : newY && newY.has(o.id) ? newY.get(o.id) : Number.isFinite(o.y) ? o.y : 0;
      const oy0 = Number.isFinite(o.y) ? o.y : 0;
      // dans notre voie : d'après les positions de la seconde à venir (et celles d'avant pour qui nous coupe la route en se rabattant) ;
      // à l'écart latéral minimal, on roule côte à côte (tolérance pour les arrondis)
      const lane = MIN_DY - 0.02;
      if (!block && Math.abs(oy - L.y) >= lane && (dx < BIKE || Math.abs(oy0 - L.prevY) >= lane)) continue;
      // où il sera à la fin de la seconde : déjà avancé (les coureurs avancent d'avant en arrière), sinon d'après son allure
      const done = !!rr && rr.st.t > t;
      const vEnd = done ? rr.st.v : Math.max(0, o.v + clamp(o.a || 0, -2, 1));
      const sEnd = done ? rr.st.s : o.s + 0.5 * (o.v + vEnd);
      // à côté de nous sans place pour s'écarter : on se laisse glisser derrière lui ; dans notre voie : à la fin de la seconde, au
      // moins 0,2 m entre sa roue arrière et notre roue avant (on avance de (v + v′)/2 dans la seconde)
      const gap = (sEnd - BIKE - 0.2 - s) / pk;
      let cv = block ? vEnd - (L.narrow ? 0.8 : 0.4) : 2 * gap - v;
      // on arrive vite sur lui : assez tôt pour pouvoir encore freiner (2 m/s²) jusqu'à sa vitesse avant de le toucher
      if (!block) cv = Math.min(cv, vEnd + Math.sqrt(2 * 2 * Math.max(0, gap - v)));
      if (cv < vc) vc = cv;
    }
    if (!(vc < Infinity)) return Pcmd;
    if (vc < 0) vc = 0;
    const need = PYR.tactics.powerForSpeedRaw(r.setup, v, vc, c);
    if (need < 0) { c.vCap = Math.min(c.vCap, vc); return 0; }
    return Math.min(Pcmd, need);
  }

  /**
   * Roue à suivre en deux dimensions (tactics.wheelToFollow) : la plus proche devant, pénalisée par l'écart latéral entre son
   * sillage et la voie visée (pénalité forte quand on a peu besoin d'abri : on garde sa voie, groupe large ; faible quand
   * l'allure monte : on se range dans les roues), et par une place déjà prise. On garde sa roue sauf pour une nettement
   * meilleure. Fermeture éclair (besoin d'abri fort) : si un voisin d'à côté, devant nous, vise la même roue, on prend la sienne.
   */
  function pickWheel(field, r, maxGap, filter) {
    const L = r.lat, s = r.st.s, cur = r.tac.wheel;
    const k = L.mode === 'up' ? 20 : 1.5 + 4.5 * (1 - L.need);
    const yOfE = (o) => (Number.isFinite(o.y) ? o.y : 0);
    const cost = (o) => {
      const d = o.s - s;
      const wy = yOfE(o) - (Math.max(0, d - BIKE) + 0.1) * L.tb;
      return d + k * Math.max(0, Math.abs(wy - L.ty) - 0.3) + (taken(o, r.id, d - BIKE) ? 3 : 0);
    };
    // devant nous au sens strict (position, puis identifiant à égalité) : le graphe des roues reste sans cycle
    const ahead = (o) => o.s > s || (o.s === s && idLess(o.id, r.id));
    let best = null, bestC = Infinity, curE = null, curC = Infinity;
    for (const o of field) {
      if (o.id === r.id || o.stopped || o.finished) continue;
      if (filter && !filter(o)) continue;
      const d = o.s - s;
      if (o.id === cur) {
        if (ahead(o) && d - BIKE <= maxGap) { curE = o; curC = cost(o); }
        continue;
      }
      if (d < BIKE - 0.5 || d - BIKE > maxGap) continue;
      const c = cost(o);
      if (c < bestC) { bestC = c; best = o; }
    }
    let w = curE && !(bestC < curC - SWITCH) ? curE : best;
    if (L.need > 0.5) {
      // personne devant, mais quelqu'un à notre hauteur (et devant nous, à égalité selon l'identifiant) : on se range derrière lui
      if (!w) {
        for (const o of field) {
          if (o.id === r.id || o.stopped || o.finished || (filter && !filter(o))) continue;
          const d = o.s - s;
          if (d >= 0 && d < BIKE - 0.5 && ahead(o) && (!w || o.s > w.s)) w = o;
        }
      }
      // fermeture éclair : la place derrière la roue est prise (la file s'est formée) : on se range au bout de la file, quitte à
      // laisser passer celui qui roule à notre hauteur et s'y est glissé avant nous
      for (let k = 0; w && k < 6 && w.tail && w.tail !== r.id; k++) {
        const id = w.tail, q = field.find((o) => o.id === id);
        if (!q || q.stopped || q.finished || (!ahead(q) && q.s - s <= -BIKE) || (filter && !filter(q))) break;
        w = q;
      }
    }
    return w;
  }

  /** Décalage d'un rang demandé par le joueur (← : dir = −1, → : +1), pendant quelques secondes. */
  function nudge(r, dir, t, course) {
    const L = r.lat;
    if (!L) return null;
    const hw = halfWidth(course || (r.ctx && r.ctx.course), r.st.s);
    const from = L.nudge && t < L.nudge.until ? L.nudge.y : L.y;
    L.nudge = { y: clamp(from + dir * LANE, -hw, hw), until: t + NUDGE_S };
    return L.nudge.y;
  }

  /** Voies d'une route de demi-largeur hw, écartées de LANE et centrées. */
  function lanes(hw) {
    const n = Math.max(1, Math.floor((2 * hw) / LANE + 1e-9) + 1);
    const out = [];
    for (let k = 0; k < n; k++) out.push((k - (n - 1) / 2) * LANE);
    return out.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b); // du centre vers les bords
  }

  /**
   * Grille de départ (mode solo) : rangs de LANE de large sur la largeur de la route au départ, le joueur (human) au premier
   * rang au centre, les autres derrière lui rang par rang (s négatif : derrière la ligne, comme un départ en masse).
   */
  function grid(race) {
    const rs = race.riders.filter((r) => r.lat);
    if (!rs.length) return;
    const hw = halfWidth(race.course, 0);
    const ln = lanes(hw - LANE >= LANE ? hw - LANE : hw); // un couloir libre le long des bords, si la route le permet
    rs.sort((a, b) => (b.human ? 1 : 0) - (a.human ? 1 : 0)); // le joueur d'abord (tri stable : les autres dans l'ordre)
    // rangs décalés d'une demi-voie un sur deux, comme sur une vraie grille : on ne part pas sur des rails
    const ln2 = ln.map((y) => y + LANE / 2).filter((y) => y <= hw), slots = [ln, ln2.length ? ln2 : ln];
    let row = 0, k = 0;
    for (const r of rs) {
      let line = slots[row % 2];
      if (k >= line.length) { row++; k = 0; line = slots[row % 2]; }
      r.st.s = -row * ROW;
      r.prevS = r.st.s;
      setY(r, line[k++]);
    }
  }

  /** Course en direct : une voie de départ tirée de la graine et de l'identifiant du joueur. */
  function place(race, r) {
    const ln = lanes(halfWidth(race.course, 0));
    let h = race.seed >>> 0;
    for (const ch of String(r.id)) h = Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0;
    setY(r, ln[h % ln.length]);
  }

  PYR.peloton = {
    RIDER_W, LANE, MIN_DY, EDGE, MAX_R, RELAY_FRONT, ROW,
    halfWidth, halfAhead, yaw, pair, field, state, setY, steer, guard, pickWheel, nudge, lanes, grid, place,
    lineWeights, cornerAhead, pathFactor, applyLine,
  };
})(globalThis.PYR = globalThis.PYR || {});
