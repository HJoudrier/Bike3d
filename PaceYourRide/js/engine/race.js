/* author : Hugo Joudrier-Faure */
/* PaceYourRide — course à plusieurs : le joueur, des coureurs virtuels et, en direct, les autres
 * joueurs (positions reçues du réseau). Chaque seconde, pour chaque coureur simulé ici :
 *   1. aspiration, d'après les positions de tous au début de la seconde (avec la règle `peloton` : en deux dimensions,
 *      puis placement latéral de chacun pour la seconde à venir, cf. peloton.js) ;
 *   2. incidents éventuels (crevaison, chute) ;
 *   3. capacité du moment (fringale, déshydratation, blessure ; avec le modèle physiologique, la signature effective de metabo.js :
 *      glycogène, fatigue des fibres, chaleur, eau, altitude, commande centrale) ;
 *   4. tactique → consigne de puissance ;
 *   5. pas de simulation (W′, courbe record, mécanique ; en peloton, sans traverser le coureur devant dans sa voie), énergie et statistiques ;
 *   6. passages aux sprints, aux sommets et à l'arrivée (temps interpolé dans la seconde). */
(function (PYR) {
  'use strict';

  const Sim = PYR.sim, Feed = PYR.feed, Dr = PYR.draft, Pel = PYR.peloton, Tac = PYR.tactics, Fu = PYR.fuel, Ph = PYR.physio, Cl = PYR.classif;

  // peloton : positions latérales et aspiration en deux dimensions (peloton.js) ; sans elle, tout le monde roule dans l'axe (une file)
  const RULES = { events: false, form: false, fuel: false, physio: false, pullSec: 30, sprints: 0, kom: false, draft: true, peloton: false };
  // modèle physiologique : la courbe record ne limite que les efforts de 20 min au plus, la durabilité vient de la couche lente
  const PHYSIO_REC_MAX = 1200;
  const PUNCTURE_KM = 250;  // une crevaison tous les 250 km en moyenne (asphalte, pneus route) ; revêtement et pneus la modulent
  const CRASH_KM = 600;     // une chute tous les 600 km en moyenne, avant facteurs de risque
  // 89 coureurs virtuels au plus : avec le joueur, un peloton de 90
  const BOT_NAMES = [
    'Léa', 'Hugo', 'Inès', 'Tom', 'Jade', 'Noé', 'Lina',
    'Louis', 'Emma', 'Jules', 'Chloé', 'Adam', 'Manon', 'Gabriel', 'Camille', 'Raphaël', 'Zoé', 'Arthur', 'Sarah',
    'Lucas', 'Alice', 'Nathan', 'Clara', 'Théo', 'Anna', 'Maxime', 'Julie', 'Antoine', 'Elsa', 'Paul', 'Margaux',
    'Victor', 'Eva', 'Enzo', 'Louise', 'Baptiste', 'Romane', 'Axel', 'Maëlle', 'Clément', 'Océane', 'Mathis', 'Lola',
    'Quentin', 'Nina', 'Simon', 'Léna', 'Romain', 'Axelle', 'Samuel', 'Agathe', 'Yanis', 'Mila', 'Ethan', 'Salomé',
    'Valentin', 'Anaïs', 'Étienne', 'Pauline', 'Martin', 'Juliette', 'Kevin', 'Lou', 'Bastien', 'Mélanie', 'Florian', 'Capucine',
    'Dylan', 'Rose', 'Alexis', 'Éloïse', 'Thomas', 'Charlotte', 'Matteo', 'Apolline', 'Pierre', 'Maya', 'Benoît', 'Iris',
    'Sacha', 'Cécile', 'Damien', 'Noémie', 'Gaspard', 'Ambre', 'Léon', 'Violette', 'Marius', 'Sofia',
  ];
  const MAX_BOTS = BOT_NAMES.length;
  const BOT_LEVELS = { weaker: 0.9, equal: 1, stronger: 1.07 };
  const SOLO = { R: 0, k: 1, role: 'solo', gapAhead: Infinity, gapBehind: Infinity, wheel: null, chain: 0, group: 0, groupSize: 1, rank: 0 };

  /**
   * n couleurs distinctes : les couleurs de base d'abord, puis des teintes réparties (angle d'or) qui évitent
   * l'orange du joueur.
   */
  function palette(base, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (i < base.length) { out.push(base[i]); continue; }
      let hue = ((i - base.length) * 137.508 + 200) % 360;
      if (hue > 5 && hue < 40) hue += 40; // l'orange est celui du joueur
      out.push(`hsl(${Math.round(hue)}, ${62 + (i % 3) * 8}%, ${44 + (i % 2) * 8}%)`);
    }
    return out;
  }

  /** Durée d'un relais (s) : 30 par défaut, de 5 à 300, et 0 pour « sans limite de durée ». */
  function pullSecOf(v) {
    if (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) return 30;
    const n = Number(v);
    return n === 0 ? 0 : n > 0 ? Math.min(300, Math.max(5, Math.round(n))) : 5;
  }

  /** Règles de course normalisées (sprints : nombre de sprints intermédiaires ; kom : grand prix de la montagne). */
  function normRules(x) {
    x = x || {};
    return {
      // durée d'un relais : de 5 à 300 s, 30 s par défaut ; 0 = aucune limite de durée (affichée « inf » dans l'interface)
      events: !!x.events, form: !!x.form, fuel: !!x.fuel, pullSec: pullSecOf(x.pullSec),
      // modèle physiologique (metabo.js) : il remplace l'énergie et l'hydratation simplifiées, avec l'alimentation seulement
      physio: !!x.physio && !!x.fuel,
      sprints: Math.min(Cl.MAX_SPRINTS, Math.max(0, Math.floor(Number(x.sprints) || 0))), kom: !!x.kom,
      draft: x.draft !== false,   // aspiration : désactivée (false) pour les défis contre des coureurs virtuels en sortie réelle
      peloton: x.peloton === true && x.draft !== false, // seulement demandé explicitement : les anciens défis et courses restent en file
    };
  }

  /** opts : {course, rules, seed, gustSeed, cps (points de passage, cf. classif.js)} */
  function create(opts) {
    const seed = (opts.seed >>> 0) || 1;
    return {
      course: opts.course,
      rules: normRules(Object.assign({}, RULES, opts.rules)),
      seed,
      rnd: PYR.util.mulberry32(seed),
      gustSeed: opts.gustSeed,
      cps: Array.isArray(opts.cps) && opts.cps.length ? opts.cps : Cl.normalize([], opts.course.length),
      feed: Array.isArray(opts.feed) ? opts.feed : [], // zones de ravitaillement (cf. feed.js)
      riders: [],     // coureurs simulés localement
      external: [],   // autres joueurs (course en direct) : {id, s, v, mode, phase, stopped, finished}
      events: [],     // journal : crevaisons, chutes, attaques, passages, arrivées
      pending: [],    // passages de la seconde en cours (annoncés dans l'ordre, une fois tout le monde avancé)
      onEvent: null,
      t: 0,
    };
  }

  /** Le modèle physiologique est-il joué dans cette course ? */
  const physioOn = (race) => !!(race.rules.physio && race.rules.fuel && PYR.metabo);

  /**
   * Ajoute un coureur simulé.
   * o : {id, name, color, human, bot (personnalité), setup, athlete, v0, margin, form, kit, gut (entraînement de l'intestin, 0–1),
   *      rider (profil du cycliste : poids, taille, âge, sexe, carte athlète `physio`), physio (carte athlète déjà calculée, metabo.card),
   *      physioOpts (état de départ du modèle physiologique, metabo.create),
   *      measured (puissance mesurée : home-trainer ou capteur, donnée chaque seconde par r.tac.cmd, sans plafond du simulateur),
   *      driven (cycliste sur la vraie route : position mesurée, donnée chaque seconde par r.drive = {s, v, P}, cf. sim.drive)}
   * Un cycliste réel (measured ou driven) n'a pas d'incident tiré au sort ; sur la route, il n'est pas non plus abrité (il roule pour de vrai).
   */
  function addRider(race, o) {
    const athlete = o.form ? Ph.scaleAthlete(o.athlete, o.form.cpK, o.form.wK) : o.athlete;
    const phy = physioOn(race);
    const ctx = Sim.createContext(race.course, o.setup, athlete, { margin: o.margin || 0, seed: race.gustSeed, smoothRec: true, recMax: phy ? PHYSIO_REC_MAX : 0 });
    const st = Sim.initState(ctx, o.v0 || 0);
    st.capK = 1;
    // carte athlète à l'échelle du coureur du jour (forme, marge) : la PC et le W′ du simulateur sont ceux du modèle
    let card = null;
    if (phy) {
      const base = o.physio || PYR.metabo.card(o.rider || { weight: o.setup.mRider }, o.athlete);
      card = PYR.metabo.scaleCard(base, ctx.cp / base.CP2, ctx.w0 / 1000 / base.Wp);
    }
    const r = {
      id: o.id, name: o.name, color: o.color, human: !!o.human, bot: o.bot || null,
      measured: !!o.measured, driven: !!o.driven, drive: null,
      setup: o.setup, athlete, form: o.form || null, ctx, st, cond: {},
      fuel: race.rules.fuel ? Fu.create(o.setup.mRider, Object.assign({}, o.kit, { gutTraining: o.gut, physio: card, physioOpts: o.physioOpts })) : null,
      penv: phy ? {} : null,  // environnement du modèle physiologique (réutilisé chaque seconde)
      tac: { mode: o.bot ? 'follow' : 'manual', cmd: o.cmd || 0, pull: 0, phase: null, since: 0, phaseT: 0, pulls: 0, target: null },
      draft: SOLO, savedW: 0, injuryK: 1, incident: null,
      stats: { sumP: 0, pMax: 0, wMin: ctx.w0, np4: 0, npCnt: 0, p30: [], savedJ: 0, shelteredS: 0, incidents: [] },
      trace: { s: [0], P: [] },
      splits: race.cps.map(() => null), nextCp: 0, // temps de passage à chaque point, prochain point à franchir
      prevS: 0, prevV: st.v, lastP: 0, lastPcmd: 0,
      feedTaken: new Set(), feedUntil: -1, feedIn: -1, // zones où l'on a pris sa musette, fin du ralentissement, zone du moment
      finished: false, time: NaN,
    };
    r.lat = race.rules.peloton ? Pel.state(r) : null; // position latérale (peloton en deux dimensions)
    race.riders.push(r);
    return r;
  }

  /**
   * Coureurs virtuels, construits à partir du profil du joueur.
   * opts : {n, level ('weaker' | 'equal' | 'stronger' | 'mixed'), rider, bike, v0, colors}
   */
  function addBots(race, opts) {
    const rnd = race.rnd, out = [];
    // goûts pour les sprints et les sommets : tirage à part, pour ne pas décaler les autres tirages
    const taste = PYR.util.mulberry32((race.seed ^ 0x2545f491) >>> 0);
    const gutRnd = PYR.util.mulberry32((race.seed ^ 0x7f4a7c15) >>> 0); // entraînement de l'intestin : tirage à part aussi
    const phyRnd = PYR.util.mulberry32((race.seed ^ 0x51ed270b) >>> 0); // carte athlète (modèle physiologique) : tirage à part
    const n = Math.max(0, Math.min(MAX_BOTS, opts.n | 0));
    for (let i = 0; i < n; i++) {
      const lvl = opts.level === 'mixed' ? 0.9 + 0.18 * (n > 1 ? i / (n - 1) : 0.5) : (BOT_LEVELS[opts.level] || 1);
      const f = lvl * (opts.levelK > 0 ? opts.levelK : 1) * (0.97 + 0.06 * rnd());   // levelK : étalonnage du niveau « égal » (ride-mixed.js)
      const mass = (Number(opts.rider.weight) || 72) * (0.92 + 0.16 * rnd());
      const rider = Object.assign({}, opts.rider, { weight: Math.round(mass * 10) / 10 });
      const setup = PYR.physics.buildSetup(rider, opts.bike);
      // même profil de puissance que le joueur, à l'échelle du niveau et du poids
      const massK = Math.pow(mass / (Number(opts.rider.weight) || 72), 0.6);
      const athlete = Ph.scaleAthlete(Ph.buildAthlete(opts.rider), f * massK, f * massK);
      const light = 3 * (1 - mass / (Number(opts.rider.weight) || 72)); // les légers grimpent, les lourds sprintent
      // modèle physiologique : chacun sa carte athlète, autour de celle du joueur (fibres, lipides, glycogène, sueur)
      const physio = physioOn(race) ? botCard(rider, athlete, phyRnd) : null;
      out.push(addRider(race, {
        id: 'bot' + (i + 1), name: BOT_NAMES[i], color: opts.colors ? opts.colors[i % opts.colors.length] : '#6f6d66',
        bot: {
          aggr: 0.1 + 0.35 * rnd(), team: 0.2 + 0.8 * rnd(), level: f,
          sprint: PYR.util.clamp(0.3 + 0.55 * taste() - light, 0, 1), climb: PYR.util.clamp(0.3 + 0.55 * taste() + light, 0, 1),
        },
        setup, athlete, v0: opts.v0 || 0, form: race.rules.form ? Ph.drawForm(rnd) : null,
        gut: [0, 0.5, 1][Math.floor(gutRnd() * 3)], rider, physio,
      }));
    }
    return out;
  }

  /** Carte athlète d'un coureur virtuel : celle de son profil, avec des fibres, des lipides, du glycogène et une sueur bien à lui. */
  function botCard(rider, athlete, rnd) {
    const Mx = PYR.metabo;
    const d = Mx.card(rider, athlete).values, F = Mx.FIELD;
    const lim = (k, v) => PYR.util.clamp(v, F[k].min, F[k].max);
    const physio = Object.assign({}, rider.physio, {
      fI: Math.round(lim('fI', d.fI + 14 * (rnd() - 0.5))),
      mfo: Math.round(lim('mfo', d.mfo * (0.85 + 0.3 * rnd())) * 100) / 100,
      glyMuscle: Math.round(lim('glyMuscle', d.glyMuscle * (0.9 + 0.2 * rnd()))),
      sweatMax: Math.round(lim('sweatMax', d.sweatMax * (0.85 + 0.3 * rnd())) * 10) / 10,
      sweatNa: Math.round(lim('sweatNa', 25 + 45 * rnd())),
    });
    return Mx.card(Object.assign({}, rider, { physio }), athlete);
  }

  function log(race, r, type, data) {
    const ev = Object.assign({ t: r.st.t, id: r.id, name: r.name, type }, data || {});
    race.events.push(ev);
    if (r.stats) r.stats.incidents.push(ev);
    if (race.onEvent) race.onEvent(ev);
    return ev;
  }

  /**
   * Risque de crevaison dans la cellule i, par rapport à un pneu route standard sur l'asphalte : celui du revêtement (pavés, gravier,
   * chemins : 2,5 à 8 fois plus) × la résistance du pneu sur ce terrain (setup.punctT : route, pavés, gravier, chemins).
   */
  function punctureRisk(C, i, setup) {
    const surf = C.punctR ? C.punctR[i] : 1;
    const tire = setup.punctT ? setup.punctT[C.punctT ? C.punctT[i] : 0] : setup.puncture || 1;
    return surf * tire;
  }

  /** Tirage des incidents pour la seconde à venir. */
  function maybeIncident(race, r, d) {
    const st = r.st, c = r.cond, C = race.course, i = c.i;
    const km = st.v / 1000;
    if (!(km > 0.0005)) return;
    const pP = km / PUNCTURE_KM * punctureRisk(C, i, r.setup) * (c.punctK || 1);
    let risk = (C.crashR ? C.crashR[i] : 1) * (c.crashK || 1); // route mouillée, rafales, verglas (météo)
    if (st.v > 15) risk *= 2;                                   // plus de 54 km/h
    if (c.vlim < 16 && st.v > c.vlim - 1.5) risk *= 3;          // virage pris à la limite
    if (d.role === 'follow' && d.gapAhead < 0.8) risk *= 1.5;   // collé à la roue
    if (r.tac.mode === 'sprint' && d.groupSize > 1) risk *= 2;  // sprint en groupe
    const pC = km / CRASH_KM * risk;
    const u = race.rnd();
    if (u < pP) {
      if (r.setup.sealant && race.rnd() < 0.6) { log(race, r, 'sealed'); return; }
      incident(race, r, 'puncture');
    } else if (u < pP + pC) incident(race, r, 'crash');
  }

  /** Déclenche un incident : crevaison (arrêt 25–50 s) ou chute (arrêt 15–45 s, W′ entamé, blessure). */
  function incident(race, r, type) {
    const st = r.st;
    if (type === 'puncture') {
      const dur = Math.round(25 + 25 * race.rnd());
      r.incident = { type, until: st.t + dur, dur };
      return log(race, r, type, { dur });
    }
    const dur = Math.round(15 + 30 * race.rnd());
    const hurt = 0.01 + 0.04 * race.rnd();
    r.incident = { type: 'crash', until: st.t + dur, dur, hurt };
    r.injuryK *= 1 - hurt;
    st.wbal *= 0.6;
    return log(race, r, 'crash', { dur, hurt });
  }

  /**
   * Vue de la course au début de la seconde : positions de tous et aspiration. En peloton, chaque entrée a aussi sa position
   * latérale y, le lacet du vent apparent tb et la roue visée tw ; les autres joueurs sans position latérale (ancienne version)
   * sont placés ici (pelLocal).
   */
  function snapshot(race) {
    const field = [], pel = race.rules.peloton && race.rules.draft !== false;
    for (const r of race.riders) {
      const e = {
        id: r.id, s: r.st.s, v: r.st.v, a: r.st.v - r.prevV, mode: r.tac.mode, phase: r.tac.phase,
        stopped: !!r.incident, finished: r.finished, wc: r.cond.wc || 0,
      };
      if (pel && r.lat) { r.lat.tb = Pel.yaw(r); e.y = r.lat.y; e.tb = r.lat.tb; e.tw = r.tac.wheel || null; e.ref = r; }
      field.push(e);
    }
    for (const e of race.external) {
      if (pel && (e.pelLocal || !Number.isFinite(e.y))) {
        const p = race.pelExt && race.pelExt.get(e.id);
        e.y = p ? p.y : 0;
        e.pelLocal = true;
      }
      field.push(e);
    }
    // sans aspiration : aucun abri (tous en SOLO, k = 1) ; les tactiques de groupe ne se déclenchent alors pas
    const active = race.rules.draft === false ? null : field.filter((x) => !x.stopped && !x.finished);
    const info = !active ? new Map() : pel ? Pel.field(active, race.course) : Dr.field(active);
    return { field, info, t: race.t };
  }

  /**
   * Prend la musette de la zone de ravitaillement où se trouve le coureur (une fois par zone) : bidons
   * pleins, gels et barres, puis on roule au ralenti quelques secondes. Renvoie ce qui a été ajouté
   * {gels, bars, liters, zone}, ou null (pas de zone, déjà pris, arrêté, sans alimentation).
   * onlyIfLow : seulement s'il reste peu de vivres.
   */
  function takeFeed(race, r, onlyIfLow) {
    if (!r.fuel || r.incident || r.finished) return null;
    const k = Feed.zoneAt(race.feed, r.st.s);
    if (k < 0 || r.feedTaken.has(k)) return null;
    if (onlyIfLow && !Fu.runningLow(r.fuel)) return null;
    r.feedTaken.add(k);
    r.feedUntil = r.st.t + Feed.GRAB_TIME;
    const got = Fu.resupply(r.fuel);
    log(race, r, 'feed', Object.assign({ zone: k }, got));
    return Object.assign({ zone: k }, got);
  }

  /** Zone de ravitaillement : les coureurs virtuels prennent leur musette s'il leur reste peu de vivres ; on note les zones manquées. */
  function feedZone(race, r) {
    const k = Feed.zoneAt(race.feed, r.st.s);
    if (r.feedIn >= 0 && k !== r.feedIn && !r.feedTaken.has(r.feedIn) && r.human && r.fuel) log(race, r, 'feedmiss', { zone: r.feedIn });
    r.feedIn = k;
    if (k >= 0 && r.bot) takeFeed(race, r, true);
  }

  function stepRider(race, r, view) {
    const st = r.st, ctx = r.ctx, c = r.cond, S = r.stats;
    Sim.conditions(ctx, Math.min(st.s, race.course.length - 0.01), st.t, c);
    if (r.lat) Pel.applyLine(race.course, r); // peloton : la trajectoire (corde ou large) change le chemin parcouru et la vitesse en virage
    const d = view.info.get(r.id) || SOLO;
    if (r.incident && st.t >= r.incident.until) { log(race, r, 'restart', { of: r.incident.type }); r.incident = null; }
    if (!r.incident && race.rules.events && st.t > 5 && !r.measured && !r.driven) maybeIncident(race, r, d);
    r.draft = r.incident || r.driven ? SOLO : d;
    c.cdaK = r.draft.k;
    c.stopped = !!r.incident;
    if (r.penv && r.fuel && r.fuel.phy) {
      // modèle physiologique : signature effective (la chaleur agit par les températures du noyau et de la peau, pas par la météo)
      st.capK = r.injuryK * Fu.factor(r.fuel);
      st.wK = r.injuryK * Fu.wFactor(r.fuel);
    } else st.capK = r.injuryK * (r.fuel ? Fu.factor(r.fuel) : 1) * (c.heatK || 1); // chaleur et grand froid (météo)

    let Pcmd = 0;
    if (!c.stopped) {
      if (r.bot) Tac.think(r, view, race);
      // cycliste réel : ses watts mesurés (home-trainer) ; sur la route, ceux de son capteur
      Pcmd = r.driven ? (r.drive && Number.isFinite(r.drive.P) ? r.drive.P : 0) : r.measured ? Math.max(0, Number(r.tac.cmd) || 0) : Tac.command(r, view, race.rules);
      if (race.feed.length) {
        feedZone(race, r);
        if (st.t < r.feedUntil) c.vCap = Math.min(c.vCap, Feed.GRAB_SPEED); // on lève le pied pour saisir la musette
      }
      if (r.lat && !r.driven) Pcmd = Pel.guard(race, r, view, Pcmd); // peloton : pas à travers le coureur devant dans sa voie
    }
    r.prevS = st.s;
    r.prevV = st.v;
    const v0 = st.v, s0 = st.s, t0 = st.t;
    c.raw = r.measured;
    const P = r.driven ? Sim.drive(ctx, st, r.drive, c) : Sim.step(ctx, st, Pcmd, c);
    // peloton en 2D : on ne traverse personne, on ne finit pas la seconde dans la roue de celui de devant (contrainte stricte)
    if (r.lat) {
      const hit = Pel.resolve(race, r, view);
      if (hit && r.human && hit.dv > 1.2 && race.onEvent) race.onEvent({ t: st.t, id: r.id, name: r.name, type: 'bump', other: hit.id });
    }
    crossings(race, r, s0, t0);
    // ligne du sprint ou du sommet franchie : l'effort s'arrête là
    if (r.tac.target !== null && r.tac.target !== undefined && st.s >= r.tac.target) Tac.afterLine(r, st.t);
    if (r.fuel) {
      // modèle physiologique : température et humidité de l'air, vent relatif, abri, soleil, altitude ; sinon sueur d'après la température ressentie
      const env = r.penv ? PYR.metabo.envOf(race.course, c, st, c.stopped ? 0 : 1 - (r.draft.k > 0 ? r.draft.k : 1), r.penv) : undefined;
      Fu.step(r.fuel, P, ctx.cp * r.injuryK, c.Tapp, env);
      if (r.bot) Fu.autoFeed(r.fuel, st.t);
    }
    // watts économisés grâce à l'abri, à la vitesse moyenne de la seconde
    r.savedW = c.stopped ? 0 : r.draft.R * Dr.aeroPower(r.setup, c, 0.5 * (v0 + st.v));
    S.savedJ += r.savedW;
    if (r.draft.role === 'follow') S.shelteredS++;
    S.sumP += P;
    if (P > S.pMax) S.pMax = P;
    if (st.wbal < S.wMin) S.wMin = st.wbal;
    S.p30.push(P);
    if (S.p30.length > 30) S.p30.shift();
    if (S.p30.length === 30) { let m = 0; for (const x of S.p30) m += x; m /= 30; S.np4 += m * m * m * m; S.npCnt++; }
    r.trace.s.push(Math.min(st.s, race.course.length));
    r.trace.P.push(P);
    r.lastP = P;
    r.lastPcmd = Pcmd;
    if (st.finished && !r.finished) {
      r.finished = true;
      r.time = st.tFinish;
      log(race, r, 'finish', { time: r.time });
    }
  }

  /** Points de passage franchis pendant la seconde [t0, t0 + 1] (temps interpolé, comme l'arrivée). */
  function crossings(race, r, s0, t0) {
    const cps = race.cps, st = r.st, L = race.course.length;
    while (r.nextCp < cps.length) {
      const k = r.nextCp, cp = cps[k];
      let t;
      if (cp.s >= L) {
        if (!st.finished) return;
        t = st.tFinish;
      } else {
        if (st.s < cp.s) return;
        t = t0 + (st.s > s0 ? (cp.s - s0) / (st.s - s0) : 1);
      }
      r.splits[k] = t;
      r.nextCp = k + 1;
      if (cp.type !== 'finish') race.pending.push({ r, k, t });
    }
  }

  /** Avance la course d'une seconde (tous les coureurs simulés localement). */
  function step(race) {
    const view = snapshot(race);
    let order = race.riders;
    if (race.rules.peloton && race.rules.draft !== false) {
      Pel.steer(race, view); // placement latéral pour la seconde à venir
      // d'avant en arrière : le garde-fou connaît alors où sera, à la fin de la seconde, le coureur qui roule devant dans sa voie
      order = race.riders.slice().sort((a, b) => b.st.s - a.st.s || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    }
    for (const r of order) if (!r.finished) stepRider(race, r, view);
    if (race.pending.length) {
      // passages de la seconde, dans l'ordre où ils ont eu lieu
      race.pending.sort((a, b) => a.t - b.t);
      for (const p of race.pending) log(race, p.r, 'cp', { cp: p.k, at: p.t });
      race.pending.length = 0;
    }
    race.t++;
  }

  /** Termine la course des coureurs encore en route (ex. : les virtuels après l'arrivée du joueur). */
  function runToEnd(race, maxT) {
    const limit = maxT || race.t + 6 * 3600;
    while (race.t < limit && race.riders.some((r) => !r.finished)) step(race);
  }

  /** Classement : arrivés par temps, puis les autres par distance parcourue. */
  function results(race) {
    return race.riders.slice().sort((a, b) => {
      if (a.finished && b.finished) return a.time - b.time;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.st.s - a.st.s;
    });
  }

  /**
   * Durée tenable à la puissance P : le plus petit du temps avant épuisement de W′, du temps avant d'être limité par la
   * courbe de puissance record (les fenêtres glissantes que le limiteur impose, calculées comme la courbe « temps avant
   * épuisement » de la page Performance) et de la fringale. Les règles de l'optimiseur sur la durée totale (moyenne et NP
   * depuis le départ) ne comptent pas ici : le jeu ne les impose pas, et un sprint au départ les ferait dépasser pour la
   * suite de la course. Renvoie {t, by, wprime, record, fuel} : les trois durées séparément (Infinity si rien ne limite)
   * en plus du plus petit.
   */
  function timeToExhaustion(r, P) {
    const tte = Sim.timeToExhaustion(r.ctx, r.st, P);
    let fuel = Infinity;
    if (r.fuel) {
      const tb = Fu.timeToBonk(r.fuel, P, r.ctx.cp * r.injuryK);
      if (tb <= 6 * 3600) fuel = tb;
    }
    if (fuel < tte.t) return Object.assign({}, tte, { t: fuel, by: 'fuel', fuel });
    return Object.assign({}, tte, { fuel });
  }

  function np(r) {
    const S = r.stats;
    return S.npCnt ? Math.pow(S.np4 / S.npCnt, 0.25) : (r.st.t ? S.sumP / r.st.t : 0);
  }

  /** Classements (points, montagne, passages, général) des coureurs simulés localement. */
  function standings(race) {
    return Cl.standings(race.cps, race.riders.map((r) => ({ id: r.id, splits: r.splits, s: r.st.s })));
  }

  PYR.race = { RULES, PUNCTURE_KM, punctureRisk, takeFeed, BOT_NAMES, MAX_BOTS, palette, normRules, create, addRider, addBots, incident, snapshot, step, runToEnd, results, standings, timeToExhaustion, np };
})(globalThis.PYR = globalThis.PYR || {});
