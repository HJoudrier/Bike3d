/* author : Hugo Joudrier-Faure */
/* PaceYourRide — tactiques de course : consigne de puissance seconde par seconde selon le mode choisi,
 * pour le joueur comme pour les coureurs virtuels.
 *   récupérer / endurance / tempo / seuil / PMA : puissance fixe (50 %, 65 %, 83 %, 100 % de la FTP, record 3 min) ;
 *   attaquer : 12 s d'effort maximal puis 48 s à la PMA, puis retour au seuil ; dans une côte classée,
 *              la PMA est tenue jusqu'au sommet (coureurs virtuels) ;
 *   sprinter : effort maximal (jusqu'à 35 s, ou jusqu'à la ligne du sprint ou du sommet visé) pour les coureurs virtuels.
 *              Le joueur n'a qu'un bouton « Sprint » (attaque et sprint réunis) : chaque appui monte la consigne de 20 % de
 *              l'écart entre le haut de la zone PMA et son record de puissance le plus élevé, et elle retombe en une seconde
 *              dès qu'on cesse d'appuyer (voir sprintTap) ;
 *   dans les roues : on garde ≈ 0,6 m derrière la roue devant ; le joueur y revient sans à-coups
 *                    (1,3 × PMA au plus), reste avec son groupe quand ça attaque, laisse passer ceux
 *                    qui viennent relayer quand il se retrouve en tête, et suit les sprinteurs dans
 *                    les 400 derniers mètres ;
 *   relais : rotation entre les coureurs qui collaborent : on mène pendant la durée prévue, on
 *            s'écarte, on se laisse glisser en queue du groupe, puis on reprend la roue ;
 *   suivre les attaques : comme « dans les roues », mais en restant aux premières places du groupe
 *                         et en sautant dans la roue de ceux qui attaquent plutôt que de les laisser filer.
 * Peloton en deux dimensions (règle `peloton`, peloton.js) : la roue à suivre tient compte de la position latérale
 * (pickWheel), les coureurs virtuels ne relaient qu'en tête du groupe et remontent le reste du temps par une voie libre.
 * Les consignes passent ensuite par le simulateur, qui les plafonne (W′, courbe record). */
(function (PYR) {
  'use strict';

  const G = 9.80665;
  const Dr = PYR.draft;
  const Pel = PYR.peloton;

  const MODES = [
    { id: 'recover', key: '1', label: 'Récupérer' },
    { id: 'endurance', key: '2', label: 'Endurance' },
    { id: 'tempo', key: '3', label: 'Tempo' },
    { id: 'threshold', key: '4', label: 'Seuil' },
    { id: 'pma', key: '5', label: 'PMA' },
    { id: 'attack', key: '6', label: 'Attaquer' },
    { id: 'sprint', key: '7', label: 'Sprinter' },
    { id: 'follow', key: '8', label: 'Dans les roues' },
    { id: 'relay', key: '9', label: 'Relayer' },
    { id: 'cover', key: 's', label: 'Suivre les attaques' },
  ];
  const LABELS = Object.assign({ manual: 'Manuel' }, ...MODES.map((m) => ({ [m.id]: m.label })));

  const FOLLOW_GAP = 0.6;    // m entre les roues, dans les roues
  // m/s² : accélération maximale pour tenir ou reprendre une roue (plus franche au démarrage)
  const accelMax = (v) => Math.max(0.8, 1.8 - 0.1 * v);
  // Retour sur une roue : vitesse de rapprochement qui décroît avec l'écart e (m) pour arriver dans
  // la roue en relâchant simplement l'effort, sans freiner : Δv = min(0,35·e, √(2·0,08·e), 2 m/s)
  const CLOSE_GAIN = 0.35, CLOSE_DECEL = 0.08, CLOSE_DV = 2;
  const FOLLOW_EFFORT = 1.3; // × PMA : effort maximal du joueur pour tenir ou reprendre une roue
  const COMPANY = 10;        // m : quelqu'un roule juste derrière nous (on est dans un groupe)…
  const LET_GO = 5;          // m : … alors on ne court pas après une roue qui a pris plus de 5 m
  const CHASE_RANGE = 150;   // m : on revient sur une roue jusque-là (coureur virtuel, ou joueur seul)
  const EASE_MAX = 10;       // s : on laisse passer (en se relevant) au plus 10 s de suite
  const FINALE = 400;        // m : dans les 400 derniers mètres, on suit tout le monde, à fond
  const ATTACK_SURGE = 12, ATTACK_HOLD = 48, ATTACK_MAX = 300, SPRINT_MAX = 35, SWING_MAX = 25; // s
  const SWING_DEFICIT = 1.3; // m/s : écart maximal sous l'allure du groupe pendant qu'on se laisse glisser
  const COVER_EFFORT = 1.6;  // × PMA : effort maximal pour sauter dans la roue d'un attaquant
  const COVER_MIN_W = 0.2;   // fraction de W′ sous laquelle on ne suit plus les attaques
  const COVER_ANTICIPATE = 12; // m : un attaquant qui nous rattrape par l'arrière, on prend de la vitesse avant qu'il passe
  const MOVE_UP_DV = 1.2;    // m/s : de plus que la roue devant pour remonter le groupe
  const MOVE_UP_MIN_W = 0.5; // fraction de W′ sous laquelle on ne remonte plus
  const MOVE_UP_EFFORT = 1.1; // × FTP : effort maximal pour remonter, sauf s'il en faut plus pour tenir la roue
  const FRONT_MAX = 5;       // places de tête visées dans un groupe : 15 % de ses coureurs, de 2 à 5
  const SPRINT_REACH = 400;  // m : un sprint lancé à moins de 400 m d'une ligne la vise
  const BOOST_STEP = 0.2;    // part de l'écart (haut de la zone PMA → record le plus élevé) gagnée à chaque appui sur « Sprint »
  const BOOST_GRACE = 0.15;  // s : on tolère ce délai entre deux appuis avant que l'effort ne retombe
  const BOOST_RELEASE = 1;   // s : une seconde après le dernier appui, on est revenu à la consigne d'avant l'effort
  // m : les grimpeurs attaquent à cette distance du sommet, selon la catégorie de la côte
  const KOM_LEAD = { hc: 900, 1: 700, 2: 500, 3: 350, 4: 250 };

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const isAttack = (o) => o.mode === 'attack' || o.mode === 'sprint';

  /** Puissances de référence du coureur, fatigue comprise (fringale, déshydratation, blessure). */
  function levels(r) {
    const k = r.st.capK > 0 ? r.st.capK : 1;
    const a = r.athlete;
    return { ftp: a.ftp * k, pma: a.mmp(180) * k, pmax: a.pmax * k };
  }

  /** Puissance d'un mode à allure fixe (null pour les autres). */
  function steadyPower(r, mode) {
    const L = levels(r);
    switch (mode) {
      case 'recover': return 0.5 * L.ftp;
      case 'endurance': return 0.65 * L.ftp; // milieu de la zone 2 (56–75 % de la FTP)
      case 'tempo': return 0.83 * L.ftp;
      case 'threshold': return L.ftp;
      case 'pma': return L.pma;
      default: return null;
    }
  }

  /** Puissance (négative s'il faut freiner) pour passer de la vitesse v à vT en une seconde (dynamique inversée, abri compris). */
  function powerForSpeedRaw(setup, v, vT, c) {
    const vm = Math.max(0.5, 0.5 * (v + vT));
    const va = vm + c.wh;
    const Fa = 0.5 * c.rho * setup.cda * (c.cdaK > 0 ? c.cdaK : 1) * Math.sqrt(va * va + c.wc * c.wc) * va;
    const Fg = setup.mass * G * c.sinT;
    const Fr = c.crr * setup.mass * G * c.cosT;
    return (Fa + Fg + Fr + setup.massEff * (vT - v)) * vm / setup.eta;
  }

  function powerForSpeed(setup, v, vT, c) {
    const P = powerForSpeedRaw(setup, v, vT, c);
    return P > 0 ? P : 0;
  }

  /** Viser la vitesse vT : puissance nécessaire, ou freinage léger si ne plus pédaler ne suffit pas. */
  function aimSpeed(r, vT, maxP) {
    const P = powerForSpeedRaw(r.setup, r.st.v, vT, r.cond);
    if (P < 0) { r.cond.vCap = vT; return 0; }
    return Math.min(P, maxP);
  }

  /**
   * Variation (m/s²) de l'accélération due à la pente d'un coureur en s roulant à v, entre la seconde
   * écoulée et la suivante : en bas d'une descente ou au pied d'une côte, la roue devant va ralentir.
   */
  function slopeChange(course, s, v) {
    const sinAt = (x) => course.sinT[clamp((x / course.step) | 0, 0, course.n - 1)];
    return -G * (sinAt(s + 0.5 * v) - sinAt(s - 0.5 * v));
  }

  /**
   * Suivre la roue de `lead` : sa vitesse à la seconde suivante (changement de pente compris), plus une
   * vitesse de rapprochement qui décroît avec l'écart (on arrive dans la roue sans la dépasser ni
   * freiner) ; accélération et puissance bornées.
   */
  function followPower(r, lead, maxP) {
    // peloton : la roue a déjà avancé cette seconde (les coureurs avancent d'avant en arrière) : on se règle sur l'écart qu'il y aura
    // à la fin de la seconde, sans une seconde de retard sur elle — sinon, dans une longue file, chacun en rajoute sur celui de devant
    // et les à-coups grossissent jusqu'à la queue
    const ref = r.lat && lead.ref && lead.ref.st.t > r.st.t ? lead.ref.st : null;
    // > 0 : trop loin de la roue
    const e = ref ? ref.s - Dr.BIKE - FOLLOW_GAP - (r.st.s + 0.5 * (r.st.v + ref.v)) : lead.s - r.st.s - Dr.BIKE - FOLLOW_GAP;
    const vLead = ref ? ref.v : lead.v + clamp((lead.a || 0) + slopeChange(r.ctx.course, lead.s, lead.v), -2, 1.5);
    // peloton : la roue roule encore à notre hauteur (on se range derrière elle) : on se laisse glisser sans à-coup
    const back = r.lat && lead.s - r.st.s < Dr.BIKE ? -0.5 : -1.5;
    const dv = e > 0 ? Math.min(CLOSE_GAIN * e, Math.sqrt(2 * CLOSE_DECEL * e), CLOSE_DV) : Math.max(CLOSE_GAIN * e, back);
    let vT = Math.max(0, vLead + dv);
    if (vT > r.st.v + accelMax(r.st.v)) vT = r.st.v + accelMax(r.st.v);
    // la roue ralentit un peu : on arrête de pédaler et l'écart se resserre légèrement ; on ne freine
    // que trop près (moins de 0,35 m entre les roues) ou pour perdre beaucoup de vitesse (descente)
    if (e > -0.25 && vT > r.st.v - 0.6) return clamp(powerForSpeedRaw(r.setup, r.st.v, vT, r.cond), 0, maxP);
    return aimSpeed(r, vT, maxP);
  }

  /** Coureur le plus proche devant (hors côte à côte), jusqu'à maxGap m entre les roues. */
  function nearestAhead(field, r, maxGap, filter) {
    let best = null, bestD = Infinity;
    for (const o of field) {
      if (o.id === r.id || o.stopped || o.finished) continue;
      const d = o.s - r.st.s;
      if (d < Dr.BIKE - 0.5 || d - Dr.BIKE > maxGap || d >= bestD) continue;
      if (filter && !filter(o)) continue;
      best = o; bestD = d;
    }
    return best;
  }

  /** Coureur le plus proche derrière, jusqu'à maxGap m entre les roues. */
  function nearestBehind(field, r, maxGap, filter) {
    let best = null, bestD = Infinity;
    for (const o of field) {
      if (o.id === r.id || o.stopped || o.finished) continue;
      const d = r.st.s - o.s;
      if (d < Dr.BIKE - 0.5 || d - Dr.BIKE > maxGap || d >= bestD) continue;
      if (filter && !filter(o)) continue;
      best = o; bestD = d;
    }
    return best;
  }

  /**
   * Roue à suivre : on garde celle qu'on suivait tant que ce coureur n'est pas nettement derrière
   * nous (s'il ralentit brusquement et qu'on arrive à sa hauteur, on freine pour se recaler) ;
   * sinon le coureur le plus proche devant.
   */
  function wheelToFollow(field, r, maxGap, filter) {
    if (r.lat && Pel) return Pel.pickWheel(field, r, maxGap, filter); // peloton : la voie compte aussi
    const cur = r.tac.wheel;
    if (cur) {
      const o = field.find((x) => x.id === cur);
      if (o && !o.stopped && !o.finished && (!filter || filter(o))) {
        const d = o.s - r.st.s;
        if (d > -(Dr.BIKE - 0.5) && d - Dr.BIKE <= maxGap) return o;
      }
    }
    return nearestAhead(field, r, maxGap, filter);
  }

  /**
   * Couches tactiques du joueur, qui s'activent indépendamment : « Suivre » (rester dans les roues, jusqu'aux limites W′ > et PPR <),
   * « Suivre les attaques » (sauter dans la roue de ceux qui attaquent) et « Relais » (mener à son tour pendant la durée du relais).
   * tac.mode nomme la couche dominante (relais, puis suivre les attaques, puis suivre) et tac.on garde les trois drapeaux ;
   * les autres modes (manuel, allures fixes, attaque, sprint) n'en ont aucune. « Suivre les attaques » choisi seul par setMode
   * (tests, coureurs virtuels) reste « dans les roues » + « suivre les attaques », comme avant.
   */
  const LAYERS = ['follow', 'cover', 'relay'];
  function defaultLayers(mode) {
    if (!LAYERS.includes(mode)) return null;
    return { follow: mode === 'follow' || mode === 'cover', cover: mode === 'cover', relay: mode === 'relay' };
  }
  const layersMode = (on) => (on.relay ? 'relay' : on.cover ? 'cover' : on.follow ? 'follow' : 'manual');

  /** Couches actives de r (tous les drapeaux à faux hors tactique de roues / relais). */
  function layersOf(r) {
    const tac = r.tac;
    if (!LAYERS.includes(tac.mode)) return { follow: false, cover: false, relay: false };
    return tac.on || defaultLayers(tac.mode);
  }

  /** Fixe les couches actives ; la tactique passe en manuel quand plus aucune n'est active. Le nom de la couche dominante suit. */
  function setLayers(r, on, t) {
    const next = { follow: !!on.follow, cover: !!on.cover, relay: !!on.relay };
    const mode = layersMode(next);
    if (mode !== r.tac.mode) setMode(r, mode, t);
    r.tac.on = mode === 'manual' ? null : next;
    return mode;
  }

  /** Active ou coupe une couche (« follow », « cover » ou « relay ») sans toucher aux autres ; part de zéro depuis un mode sans couche. */
  function toggleLayer(r, layer, t) {
    if (!LAYERS.includes(layer)) return layersOf(r);
    const on = Object.assign({}, layersOf(r));
    on[layer] = !on[layer];
    setLayers(r, on, t);
    return layersOf(r);
  }

  /** Change de tactique. target : distance (m) de la ligne visée par un sprint ou une attaque. */
  function setMode(r, mode, t, target) {
    const tac = r.tac;
    // effort bref : on retient la tactique en cours pour la reprendre une fois la ligne passée
    const burst = (m) => m === 'sprint' || m === 'attack';
    if (burst(mode) && !burst(tac.mode)) tac.resume = { mode: tac.mode, cmd: tac.cmd, on: tac.on ? Object.assign({}, tac.on) : null };
    tac.mode = mode;
    tac.on = defaultLayers(mode);
    tac.since = t;
    tac.phase = null;
    tac.phaseT = t;
    tac.wheel = null;
    tac.target = burst(mode) && target > 0 ? target : null;
    tac.letGo = undefined;
    tac.front = undefined;
    if (mode === 'relay' && !(tac.pull > 0)) tac.pull = levels(r).ftp * (r.bot ? 0.95 + 0.1 * r.bot.team : 1);
  }

  /**
   * Fourchette de l'effort « sprint » du joueur, en W : du haut de la zone PMA (120 % de la FTP) à son record de puissance
   * le plus élevé. La consigne n'en sort jamais ; le simulateur la plafonne ensuite (W′, courbe record).
   */
  function boostRange(r) {
    const L = levels(r), lo = PYR.physio.ZONES[4].max * L.ftp;
    return { lo, hi: Math.max(lo, L.pmax) };
  }

  /** Consigne (W) de l'effort « sprint » du joueur à son niveau actuel (0 à 1 de la fourchette). */
  function boostPower(r) {
    const b = boostRange(r);
    return b.lo + clamp(r.tac.boost || 0, 0, 1) * (b.hi - b.lo);
  }

  /**
   * Appui sur « Sprint » : lance l'effort (en visant la ligne s'il y en a une) et monte le niveau de 20 % de la fourchette.
   * Renvoie la consigne obtenue.
   */
  function sprintTap(r, t, line) {
    const tac = r.tac;
    if (tac.mode !== 'sprint' && tac.mode !== 'attack') { setMode(r, 'sprint', t, line); tac.boost = 0; }
    else if (tac.mode === 'attack') { tac.mode = 'sprint'; tac.boost = 0; }
    tac.boost = Math.min(1, (tac.boost || 0) + BOOST_STEP);
    tac.boostFrom = tac.boost; // niveau au dernier appui : il retombe à zéro en BOOST_RELEASE secondes
    tac.idle = 0;
    return boostPower(r);
  }

  /**
   * Fait retomber l'effort « sprint » après dt secondes (réelles) écoulées : au-delà d'un court délai de grâce sans appui, le
   * niveau descend en ligne droite pour être nul une seconde après le dernier appui, et la tactique d'avant reprend.
   * Vrai si l'effort vient de se terminer.
   */
  function decayBoost(r, dt) {
    const tac = r.tac;
    if (tac.mode !== 'sprint' || !r.human) return false;
    tac.idle = (tac.idle || 0) + dt;
    if (tac.idle <= BOOST_GRACE) return false;
    tac.boost = (tac.boostFrom || 0) * (1 - (tac.idle - BOOST_GRACE) / (BOOST_RELEASE - BOOST_GRACE));
    if (tac.boost > 0) return false;
    tac.boost = 0;
    afterLine(r, r.st.t);
    return true;
  }

  /** Ligne passée : les coureurs virtuels reprennent les roues, le joueur sa tactique d'avant l'effort. */
  function afterLine(r, t) {
    const res = r.tac.resume;
    if (!r.bot && res && res.mode !== 'sprint' && res.mode !== 'attack') {
      setMode(r, res.mode, t);
      if (res.on) r.tac.on = res.on; // les couches d'avant l'effort (suivre + relais…) reprennent
      r.tac.cmd = res.cmd;
    } else setMode(r, 'follow', t);
  }

  /**
   * Ligne visée par un effort du joueur : le prochain sprint ou sommet à moins de 400 m (sprint),
   * ou le sommet de la côte classée où l'on se trouve (attaque). null sinon.
   */
  function lineFor(r, cps, mode) {
    const cp = cps && cps[r.nextCp];
    if (!cp || cp.type === 'finish') return null;
    const d = cp.s - r.st.s;
    if (!(d > 0)) return null;
    if (mode === 'sprint' && d <= SPRINT_REACH) return cp.s;
    if (mode === 'attack' && cp.type === 'kom' && r.st.s >= cp.start - 100) return cp.s;
    return null;
  }

  function setPhase(r, phase, t) {
    if (r.tac.phase === phase) return;
    r.tac.phase = phase;
    r.tac.phaseT = t;
    if (phase === 'pull') r.tac.pulls = (r.tac.pulls || 0) + 1;
  }

  /**
   * « Passer le relais » : celui qui mène se laisse glisser tout de suite, sans attendre la fin de son relais.
   * Vrai si c'était bien son tour de mener (mode relais, en tête du groupe).
   */
  function passRelay(r, t) {
    if (r.tac.mode !== 'relay' || r.tac.phase !== 'pull') return false;
    setPhase(r, 'swing', t);
    return true;
  }

  /** Durée d'un relais (s) d'après les règles : 0 = pas de limite de durée, 30 s si elle n'est pas donnée. */
  function pullLength(rules) {
    const n = rules ? rules.pullSec : undefined;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 30;
  }

  /** Durée du relais de ce coureur (s) : sans limite (0) quand son relais est libre (tac.relayFree : le joueur sur téléphone), sinon celle des règles. */
  function pullLenOf(r, rules) { return r.tac.relayFree ? 0 : pullLength(rules); }

  /**
   * Limites du joueur pour mener un relais : tac.relayW (fraction de W′ à conserver, « W′ > ») et tac.relayPpr (part maximale de la
   * courbe de puissance record utilisée, « PPR < »). Vrai dès que l'une est atteinte.
   */
  function relayLimitHit(r) {
    const tac = r.tac;
    if (tac.relayFree) return false;
    if (tac.relayW > 0 && wFrac(r) <= tac.relayW) return true;
    return tac.relayPpr > 0 && tac.relayPpr < 1 && PYR.sim.recordUsage(r.ctx, r.st).use >= tac.relayPpr;
  }

  /** Rotation des relais entre les coureurs qui collaborent (mode « relais »). */
  function relayPower(r, view, rules) {
    const tac = r.tac, t = r.st.t, L = levels(r);
    const pull = tac.pull > 0 ? tac.pull : L.ftp;
    const collab = (o) => o.mode === 'relay';
    // joueur avec « Suivre les attaques » : une attaque passe avant la rotation des relais ; avec « Suivre » : dans les roues
    // d'un coureur du relais, on les suit jusqu'aux limites « W′ > » et « PPR < » (en tête, on mène à la puissance de relais)
    const lay = r.bot ? null : layersOf(r);
    if (lay && lay.cover) {
      const react = reactToAttack(r, view);
      if (react !== null) return withLimits(r, react);
    }
    if (tac.phase === 'swing') {
      // on s'écarte et on se laisse glisser jusqu'à ce que tous ceux qui collaborent nous aient dépassés ; ceux qui se laissent
      // glisser eux aussi n'avancent pas : les attendre ferait ralentir tout le monde et décrocherait du groupe
      let vRef = Infinity, dMax = -Infinity, vGroup = 0;
      for (const o of view.field) {
        if (o.id === r.id || o.stopped || o.finished || !collab(o) || o.phase === 'swing') continue;
        const d = r.st.s - o.s; // > 0 : derrière nous
        if (Math.abs(d) <= Dr.GROUP_GAP + Dr.BIKE && o.v > vGroup) vGroup = o.v; // allure du groupe : devant ou derrière
        if (d > -(Dr.BIKE - 0.5) && d - Dr.BIKE <= Dr.GROUP_GAP) {
          if (o.v < vRef) vRef = o.v;
          if (d > dMax) dMax = d;
        }
      }
      if (vRef < Infinity && t - tac.phaseT < SWING_MAX) {
        // un peu moins vite que le groupe (≈ 3 km/h) pour se faire dépasser ; quand le dernier
        // arrive à notre hauteur, on ne cède plus que ≈ 1 km/h : sa roue se reprend sans à-coup.
        // Jamais plus de 1,3 m/s sous l'allure du groupe : un coureur lent derrière nous (qui a ralenti pour ne pas
        // dépasser ceux qui se laissent glisser) ne doit pas nous entraîner à lâcher le groupe.
        const vT = Math.max(2, vGroup - SWING_DEFICIT, dMax > Dr.BIKE + 1 ? Math.max(vRef - 0.9, r.st.v - 0.5) : vRef - 0.3);
        return aimSpeed(r, vT, 0.8 * pull);
      }
      setPhase(r, 'wheel', t);
    }
    const wheel = wheelToFollow(view.field, r, Dr.GROUP_GAP, (o) => collab(o) && o.phase !== 'swing');
    if (wheel) {
      setPhase(r, 'wheel', t);
      tac.wheel = wheel.id;
      const P = followPower(r, wheel, L.pmax);
      return lay && lay.follow ? withLimits(r, P) : P;
    }
    // personne devant parmi ceux qui collaborent : c'est notre tour de mener…
    tac.wheel = null;
    setPhase(r, 'pull', t);
    // …sauf si un autre mène à notre hauteur : le moins avancé des deux cède et se laisse glisser
    for (const o of view.field) {
      if (o.id === r.id || o.stopped || o.finished || !collab(o) || o.phase !== 'pull') continue;
      const d = o.s - r.st.s;
      if (Math.abs(d) < Dr.BIKE - 0.5 && (d > 0 || (d === 0 && String(o.id) < String(r.id)))) {
        setPhase(r, 'swing', t);
        return 0.6 * pull;
      }
    }
    // joueur : limite « W′ > » ou « PPR < » du relais atteinte, on laisse le relais tout de suite (sans attendre la fin de la durée)
    if (!r.bot && relayLimitHit(r)) {
      tac.relayLimitT = t;
      setPhase(r, 'swing', t);
      return 0.6 * pull;
    }
    const relief = nearestBehind(view.field, r, 3, collab);
    const len = pullLenOf(r, rules);
    if (relief && len > 0 && t - tac.phaseT >= len) { // 0 : relais sans limite de durée (on ne cède qu'à la limite W′ / PPR ou en passant le relais)
      setPhase(r, 'swing', t);
      return 0.6 * pull;
    }
    return pull;
  }

  /**
   * « Dans les roues » (joueur) : rester abrité en dépensant le moins possible.
   *   - on suit la roue la plus proche devant, sans dépasser 1,3 × PMA ; on garde une réserve : sous
   *     35 % de W′, l'effort redescend vers la puissance critique (atteinte à 15 %), quitte à lâcher ;
   *   - en groupe (quelqu'un roule à notre hauteur, juste derrière, ou juste devant sans attaquer), on
   *     reste avec les autres : on ne suit ni un attaquant ni un sprinteur, et on ne court pas après
   *     une roue qui a pris plus de 5 m ;
   *     seul, on suit tout le monde et on revient sur une roue jusqu'à 150 m ;
   *   - personne devant : on se glisse dans la roue de celui qui roule à notre hauteur, ou on se
   *     relève pour laisser passer celui qui arrive derrière (10 s au plus, s'il ne passe pas) ;
   *     sinon, personne ne relaie : on roule au tempo ;
   *   - dans les 400 derniers mètres, on suit tout le monde, sprinteurs compris, sans retenue.
   */
  function sitIn(r, view, cover) {
    const tac = r.tac, s = r.st.s, t = r.st.t, L = levels(r);
    const finale = r.ctx.course.length - s < FINALE;
    const other = (o) => o.id !== r.id && !o.stopped && !o.finished && o.phase !== 'swing';
    let company = false, side = null, relief = null;
    for (const o of view.field) {
      if (!other(o)) continue;
      const d = s - o.s; // > 0 : derrière nous
      if (Math.abs(d) < Dr.BIKE - 0.5) {
        company = true;
        if (!side || o.v > side.v) side = o;
      } else if (d > 0 && d - Dr.BIKE <= Dr.GROUP_GAP) {
        if (d - Dr.BIKE <= COMPANY) company = true;
        // il va passer : il prend son relais, ou il arrive plus vite que nous
        if ((o.mode === 'relay' || o.v > r.st.v + 0.3) && (!relief || o.s > relief.s)) relief = o;
      } else if (d < 0 && -d - Dr.BIKE <= LET_GO && !isAttack(o)) {
        company = true; // une roue devant, qui ne s'en va pas
      }
    }
    // en groupe (hors final), on laisse filer attaquants et sprinteurs (sauf si on les suit)
    const group = company && !finale;
    const escaping = (o) => group && !cover && isAttack(o);
    const cur = tac.wheel ? view.field.find((o) => o.id === tac.wheel) : null;
    if (cur && escaping(cur)) { tac.letGo = t; tac.letGoSprint = cur.mode === 'sprint'; }
    const w = wheelToFollow(view.field, r, group ? LET_GO : CHASE_RANGE, (o) => o.phase !== 'swing' && !escaping(o));
    if (w) {
      tac.phase = 'wheel';
      tac.wheel = w.id;
      tac.front = undefined;
      return followPower(r, w, finale ? L.pmax : followEffort(r, L));
    }
    tac.wheel = null;
    // à hauteur d'un autre : un peu moins vite que lui (0,5 m/s), pour se glisser dans sa roue ;
    // quelqu'un arrive derrière : nettement moins vite que lui (1 m/s), pour qu'il passe vite (sans
    // jamais freiner, entre l'allure de récupération et le tempo) ; au plus 10 s s'il ne passe pas
    const mate = side || relief;
    if (!mate) tac.front = undefined;
    else if (tac.front === undefined) tac.front = t;
    if (mate && t - tac.front < EASE_MAX) {
      tac.phase = side ? 'tuck' : 'ease';
      const P = powerForSpeedRaw(r.setup, r.st.v, Math.max(0, mate.v - (side ? 0.5 : 1)), r.cond);
      return clamp(P, steadyPower(r, 'recover'), side ? followEffort(r, L) : steadyPower(r, 'tempo'));
    }
    // personne ne prend le relais (ou personne autour) : tempo
    tac.phase = company ? 'lead' : null;
    return steadyPower(r, 'tempo');
  }

  /** Fraction de W′ restante. */
  function wFrac(r) {
    return r.st.wbal / Math.max(1, PYR.sim.w0Of(r.ctx, r.st));
  }

  /** Effort maximal « dans les roues » : 1,3 × PMA, ramené à la puissance critique quand le W′ passe de 35 à 15 %. */
  function followEffort(r, L, k) {
    const kc = r.st.capK > 0 ? r.st.capK : 1, cp = r.ctx.cp * kc;
    return cp + (Math.max(cp, (k || FOLLOW_EFFORT) * L.pma) - cp) * clamp((wFrac(r) - 0.15) / 0.2, 0, 1);
  }

  /**
   * Réaction à une attaque (« Suivre les attaques ») : sauter dans la roue d'un attaquant devant, ou prendre de la vitesse
   * avant qu'un attaquant nous rejoigne par l'arrière. null s'il n'y a rien à suivre (ou W′ trop entamé, ou dans le final).
   */
  function reactToAttack(r, view) {
    const tac = r.tac, L = levels(r);
    const finale = r.ctx.course.length - r.st.s < FINALE;
    if (finale || wFrac(r) < COVER_MIN_W) return null;
    const att = nearestAhead(view.field, r, CHASE_RANGE, isAttack);
    if (att) {
      tac.phase = 'cover';
      tac.wheel = att.id;
      tac.front = undefined;
      return followPower(r, att, followEffort(r, L, COVER_EFFORT));
    }
    const comer = nearestBehind(view.field, r, COVER_ANTICIPATE, (o) => isAttack(o) && o.v >= r.st.v - 0.3);
    if (comer) {
      tac.phase = 'brace';
      tac.wheel = null;
      tac.front = undefined;
      const vT = Math.min(Math.max(r.st.v, comer.v + Math.max(0, comer.a || 0)), r.st.v + accelMax(r.st.v));
      return aimSpeed(r, vT, followEffort(r, L, COVER_EFFORT));
    }
    return null;
  }

  /**
   * « Suivre les attaques » (joueur) : rester dans les premières roues du groupe, abrité, pour être
   * placé quand ça part.
   *   - un attaquant ou un sprinteur devant (jusqu'à 150 m) : on saute dans sa roue, jusqu'à 1,6 × PMA ;
   *     un qui nous rejoint par l'arrière : on prend de la vitesse avant qu'il passe. Sous 20 % de W′ on
   *     laisse filer, comme « dans les roues » ;
   *   - avec « Suivre » aussi : au-delà des places de tête du groupe (15 % de ses coureurs, de 2 à 5), on remonte en
   *     dépassant les roues une à une, à 1,2 m/s de plus que celle devant, sans dépasser 1,1 × FTP
   *     (ou la puissance qu'il faut pour tenir la roue) et tant qu'il reste la moitié du W′ ; une fois placé, on se
   *     comporte comme « dans les roues » : roue la plus proche devant, en laissant passer celui qui vient relayer ;
   *   - sans « Suivre » : seulement la réaction aux attaques, le reste du temps la puissance de la jauge.
   * Tout ce qui suit une roue est limité par « W′ > » et « PPR < ».
   */
  function coverPower(r, view) {
    const tac = r.tac;
    const finale = r.ctx.course.length - r.st.s < FINALE;
    // la réaction aux attaques et la remontée du groupe sont limitées par « W′ > » et « PPR < » (on se laisse décrocher)
    const react = reactToAttack(r, view);
    if (react !== null) return withLimits(r, react);
    // « Suivre les attaques » sans « Suivre » : rien d'autre que la réaction aux attaques, le reste du temps la puissance de la jauge
    if (!layersOf(r).follow) {
      tac.phase = null;
      tac.wheel = null;
      return tac.cmd || 0;
    }
    const info = view.info.get(r.id);
    if (!finale && info && info.groupSize > 1 && info.rank > frontPlaces(info.groupSize) && wFrac(r) > MOVE_UP_MIN_W) {
      const P = movePower(r, view, info);
      if (P !== null) return withLimits(r, P);
    }
    return withLimits(r, sitIn(r, view, true));
  }

  /**
   * Remonter le groupe : 1,2 m/s de plus que la roue devant, sans dépasser 1,1 × FTP (ou la puissance qu'il faut pour tenir la
   * roue). En peloton, sans roue qui nous abrite (voie libre), on se règle sur le coureur le plus proche devant, et c'est le
   * placement latéral qui trouve le passage. null s'il n'y a personne devant.
   */
  function movePower(r, view, info) {
    const tac = r.tac, L = levels(r);
    const ahead = (info && view.field.find((o) => o.id === info.wheel)) || (r.lat ? nearestAhead(view.field, r, Dr.GROUP_GAP) : null);
    if (!ahead) return null;
    const vLead = ahead.v + clamp((ahead.a || 0) + slopeChange(r.ctx.course, ahead.s, ahead.v), -2, 1.5);
    const vT = Math.min(vLead + MOVE_UP_DV, r.st.v + accelMax(r.st.v));
    const hold = Math.max(0, powerForSpeedRaw(r.setup, r.st.v, vLead, r.cond));
    const cap = Math.min(followEffort(r, L), Math.max(MOVE_UP_EFFORT * L.ftp, hold));
    tac.phase = 'move';
    tac.wheel = ahead.id;
    tac.front = undefined;
    return clamp(powerForSpeedRaw(r.setup, r.st.v, vT, r.cond), 0, cap);
  }

  /**
   * Limites du joueur en « Dans les roues » et « Suivre les attaques » : tac.wLimit (fraction de W′ à conserver, « W′ > ») et
   * tac.pprLimit (part maximale de la courbe de puissance record utilisée, « PPR < »). Quand la consigne pour tenir la roue ferait
   * franchir l'une des deux, elle est ramenée à la plus forte puissance qui ne la franchit pas : on se laisse décrocher.
   * tac.limitT garde l'instant où une limite a retenu l'effort (message du HUD).
   */
  function withLimits(r, P) {
    const tac = r.tac;
    if (r.bot || !(tac.wLimit > 0 || tac.pprLimit < 1)) return P;
    const cap = PYR.sim.limitCap(r.ctx, r.st, tac.wLimit || 0, tac.pprLimit || 1);
    if (P <= cap) return P;
    tac.limitT = r.st.t;
    return cap;
  }

  /** Nombre de places de tête (après le meneur) d'un groupe de n coureurs. */
  function frontPlaces(n) {
    return clamp(Math.ceil(0.15 * n), 2, FRONT_MAX);
  }

  /** Consigne (W) du coureur r pour la seconde à venir. view : {field, info}. */
  function command(r, view, rules) {
    const tac = r.tac, t = r.st.t;
    switch (tac.mode) {
      case 'recover': case 'endurance': case 'tempo': case 'threshold': case 'pma':
        return steadyPower(r, tac.mode);
      case 'attack': {
        if (tac.target !== null && r.st.s >= tac.target) { afterLine(r, t); return command(r, view, rules); }
        const dt = t - tac.since, L = levels(r);
        if (dt < ATTACK_SURGE) { tac.phase = 'surge'; return 1.8 * L.pma; }
        if (dt < (tac.target !== null ? ATTACK_MAX : ATTACK_SURGE + ATTACK_HOLD)) { tac.phase = 'hold'; return 1.02 * L.pma; }
        setMode(r, 'threshold', t);
        return steadyPower(r, 'threshold');
      }
      case 'sprint': {
        if (tac.target !== null && r.st.s >= tac.target) { afterLine(r, t); return command(r, view, rules); }
        if (r.human) return boostPower(r); // joueur : consigne montée par les appuis, voir sprintTap
        if (t - tac.since < SPRINT_MAX) return 1.5 * levels(r).pmax;
        setMode(r, 'recover', t);
        return steadyPower(r, 'recover');
      }
      case 'follow': {
        if (!r.bot) return withLimits(r, sitIn(r, view));
        // peloton : le coureur virtuel qui « flotte » dans le groupe remonte vers la place qu'il vise (peloton.js)
        if (r.lat && r.lat.mode === 'up') {
          const P = movePower(r, view, view.info.get(r.id));
          if (P !== null) return P;
        }
        // coureur virtuel : poursuit une roue jusqu'à 150 m, à 1,1 × PMA au plus
        const w = wheelToFollow(view.field, r, CHASE_RANGE, (o) => o.phase !== 'swing');
        if (w) {
          tac.phase = 'wheel';
          tac.wheel = w.id;
          return followPower(r, w, 1.1 * levels(r).pma);
        }
        tac.phase = null;
        tac.wheel = null;
        return steadyPower(r, 'tempo');
      }
      case 'relay':
        return relayPower(r, view, rules);
      case 'cover':
        return coverPower(r, view);
      default:
        return tac.cmd || 0;
    }
  }

  /* ---------- coureurs virtuels ---------- */

  /** Choix tactique d'un coureur virtuel (toutes les 3 à 5 s). */
  function think(r, view, race) {
    const tac = r.tac, t = r.st.t, b = r.bot;
    if (t < (tac.nextThink || 0)) return;
    tac.nextThink = t + 3 + Math.floor(race.rnd() * 3);
    if (tac.mode === 'attack' || tac.mode === 'sprint') return; // se terminent d'eux-mêmes
    const toGo = race.course.length - r.st.s;
    const wf = r.st.wbal / Math.max(1, PYR.sim.w0Of(r.ctx, r.st));
    const info = view.info.get(r.id);
    const inGroup = !!info && info.groupSize > 1;
    const change = (m) => { if (tac.mode !== m) setMode(r, m, t); };
    // emballage final
    if (toGo < 250 + 6 * r.st.v) {
      if (wf > 0.1 && (inGroup || nearestAhead(view.field, r, 60))) setMode(r, 'sprint', t);
      return;
    }
    if (wf < 0.1) { change(inGroup ? 'follow' : 'recover'); return; }
    // points en jeu : les sprinteurs disputent les sprints intermédiaires, les grimpeurs les sommets
    // (décision prise une fois par point de passage, à l'approche de la ligne)
    const cp = race.cps && race.cps[r.nextCp];
    if (cp && cp.type !== 'finish' && tac.cpSeen !== r.nextCp) {
      const d = cp.s - r.st.s;
      const reach = cp.type === 'sprint' ? 150 + 5 * r.st.v : KOM_LEAD[cp.cat] || 300;
      if (d > 0 && d < reach && (cp.type === 'sprint' || r.st.s > cp.start - 50)) {
        tac.cpSeen = r.nextCp;
        const keen = cp.type === 'sprint' ? b.sprint : b.climb;
        // encore des points à prendre ? (ceux déjà passés ou nettement devant les prendront)
        let ahead = 0;
        for (const o of view.field) if (o.id !== r.id && !o.stopped && o.s > r.st.s + 30) ahead++;
        if (PYR.classif.pointsFor(cp, ahead + 1) > 0 && wf > (cp.type === 'sprint' ? 0.4 : 0.5) && race.rnd() < (keen || 0)) {
          setMode(r, cp.type === 'sprint' ? 'sprint' : 'attack', t, cp.s);
          if (cp.type === 'kom') {
            tac.lastAttack = t;
            if (race.onEvent) race.onEvent({ t, id: r.id, name: r.name, type: 'attack', kom: true });
          }
          return;
        }
      }
    }
    // attaque (plutôt en montée, et plus souvent dans les derniers kilomètres)
    if (inGroup && wf > 0.85 && toGo > 1500 && t - (tac.lastAttack || -1e9) > 240) {
      const p = b.aggr * (r.cond.grade > 0.04 ? 0.25 : 0.03) * (toGo < 10000 ? 2 : 1);
      if (race.rnd() < p) {
        setMode(r, 'attack', t);
        tac.lastAttack = t;
        if (race.onEvent) race.onEvent({ t, id: r.id, name: r.name, type: 'attack' });
        return;
      }
    }
    // un coureur s'est échappé devant : on part en chasse (ou pas)
    const ahead = nearestAhead(view.field, r, CHASE_RANGE);
    if (ahead && ahead.s - r.st.s - Dr.BIKE > Dr.GROUP_GAP && wf > 0.35) {
      if (tac.mode === 'follow' || race.rnd() < 0.3 + b.aggr) { change('follow'); return; }
    }
    // en peloton, seules les premières places du groupe tournent ; les autres restent abrités (et remontent de temps à autre)
    if (inGroup) { change(wf > 0.3 && b.team > 0.25 && (!r.lat || info.rank < Pel.RELAY_FRONT) ? 'relay' : 'follow'); return; }
    change(toGo < 8000 ? 'threshold' : 'tempo');
  }

  /** Texte court décrivant la tactique en cours (HUD). */
  function describe(r, rules) {
    const tac = r.tac, t = r.st.t;
    // couches actives (relais, suivre, suivre les attaques) : « Relais + Dans les roues », « Relais + Suivre les attaques »…
    const lay = layersOf(r), parts = [];
    if (lay.relay) parts.push(LABELS.relay);
    if (lay.cover) parts.push(LABELS.cover); else if (lay.follow) parts.push(LABELS.follow);
    const label = parts.join(' + ') || LABELS[tac.mode] || 'Manuel';
    if ((lay.follow || lay.cover) && tac.limitT !== undefined && t - tac.limitT < 3) return `${label} : limite W′ ou PPR atteinte, tu te laisses décrocher`;
    if (lay.cover && tac.phase === 'cover') return `${label} : tu sautes dans la roue de l'attaque !`;
    if (lay.cover && tac.phase === 'brace') return `${label} : tu prends de la vitesse avant qu'il passe`;
    if (tac.mode === 'relay') {
      if (tac.relayLimitT !== undefined && t - tac.relayLimitT < 3) return `${label} : limite W′ ou PPR atteinte, tu laisses le relais`;
      if (tac.phase === 'pull') {
        const len = pullLenOf(r, rules);
        return len > 0 ? `${label} : en tête (${Math.max(0, Math.ceil(len - (t - tac.phaseT)))} s)` : `${label} : en tête, sans limite de durée`;
      }
      if (tac.phase === 'swing') return `${label} : tu te laisses glisser en queue`;
      if (tac.phase === 'wheel') return `${label} : dans les roues, en attendant ton tour`;
    }
    if (tac.mode === 'follow' || tac.mode === 'cover') {
      const cover = lay.cover, d = r.draft || {};
      const place = cover && d.groupSize > 1 ? ` (place ${d.rank + 1}/${d.groupSize})` : '';
      if (tac.letGo !== undefined && t - tac.letGo < 12) return `${label} : W′ trop entamé, tu laisses filer ${tac.letGoSprint ? 'le sprinteur' : "l'attaque"}`;
      if (cover && tac.phase === 'move') return `${label} : tu remontes le groupe${place}`;
      if (!lay.follow) return `${label} : à l'affût, tu roules à la puissance de la jauge`;
      if (tac.wheel) return cover ? `${label} : en place${place}` : label;
      if (tac.phase === 'ease') return `${label} : tu te relèves pour laisser passer`;
      if (tac.phase === 'tuck') return `${label} : tu te glisses dans une roue`;
      if (tac.phase === 'lead') return `${label} : personne ne relaie, tu roules au tempo`;
      return `${label} : aucune roue à moins de ${CHASE_RANGE} m`;
    }
    const toLine = tac.target !== null && tac.target !== undefined ? Math.max(0, tac.target - r.st.s) : null;
    if (tac.mode === 'attack') {
      if (toLine !== null) return `${label} : ${tac.phase === 'surge' ? 'démarrage !' : 'tiens bon'} (sommet dans ${Math.round(toLine)} m)`;
      return `${label} : ${tac.phase === 'surge' ? 'démarrage !' : 'tiens bon'} (${Math.max(0, ATTACK_SURGE + ATTACK_HOLD - (t - tac.since))} s)`;
    }
    if (tac.mode === 'sprint') return toLine !== null ? `${label} ! Ligne dans ${Math.round(toLine)} m` : `${label} !`;
    return label;
  }

  PYR.tactics = {
    MODES, LABELS, FOLLOW_GAP, CHASE_RANGE, SPRINT_REACH, frontPlaces,
    levels, steadyPower, powerForSpeed, powerForSpeedRaw, followPower, nearestAhead, nearestBehind,
    setMode, setLayers, toggleLayer, layersOf, afterLine, lineFor, passRelay, command, think, describe,
    BOOST_STEP, BOOST_GRACE, BOOST_RELEASE, boostRange, boostPower, sprintTap, decayBoost,
  };
})(globalThis.PYR = globalThis.PYR || {});
