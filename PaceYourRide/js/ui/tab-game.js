/* author : Hugo Joudrier-Faure */
/* PaceYourRide — mode jeu : le joueur règle la puissance ou choisit une tactique, le cycliste
 * numérique avance sur la carte. Trois situations :
 *   - solo      : contre des coureurs virtuels et/ou le fantôme du plan optimal ;
 *   - défi      : contre les fantômes des autres participants, l'arrivée s'ajoute au classement ;
 *   - direct    : course en temps réel contre d'autres joueurs (départ à l'heure fixée).
 * La course elle-même (aspiration, tactiques, incidents, énergie, coureurs virtuels, passages aux
 * sprints et aux sommets) est simulée par PYR.race ; ce module gère les commandes et l'affichage.
 * Peloton en deux dimensions (règle `peloton`, peloton.js) : grille de départ, position latérale de chacun sur la carte (route
 * dessinée à sa largeur, vélos à l'échelle de près, « Zoom peloton » : touche Z), changement de rang au clavier (← →). */
(function (PYR) {
  'use strict';

  const BIG_FIELD = 12; // au-delà de 12 coureurs, on n'annonce plus tous les évènements des autres
  const MAX_LEGEND = 8; // au-delà, la légende ne nomme plus les coureurs virtuels
  const LIVE_SEND_MS = 200; // direct : une position envoyée toutes les 200 ms
  const STEP_BUDGET_MS = 9; // temps maximal passé à simuler entre deux images (gros pelotons à grande vitesse)
  const CURVE_MAX = PYR.charts.RaceCurveChart.MAX; // puissance selon la durée : un point par seconde, de 1 s à 5 h
  const curveDurations = new Map();               // xmax → [1, 2 … xmax]
  const FWD_TAUS = [5, 15, 60, 300, 1200, 3600]; // durées (s) de la courbe « disponible à partir de maintenant »
  const TTE_HELP = 'Durée pendant laquelle tu peux encore tenir ta puissance actuelle : le plus petit du temps avant épuisement de W′ et du temps avant d\'être limité par la courbe de puissance record.';
  const U = PYR.util, D = PYR.dom, store = PYR.store, R = PYR.raceData, Race = PYR.race, Tac = PYR.tactics, Fu = PYR.fuel, Pel = PYR.peloton;
  const Cl = PYR.classif, CV = PYR.classifView;
  const { h, $ } = D;
  const ME_COLOR = '#eb6834';
  const SPRINT_COLOR = '#1d9a4a', KOM_COLOR = '#d62828', FEED_COLOR = '#0a7ea4';

  const G = {
    ready: false, running: false, finished: false, mode: 'solo',
    race: null, me: null, ctx: null, st: null, rules: null, inputs: null,
    closeUp: false,             // « Zoom peloton » : carte au plus près du joueur, vélos à l'échelle
    tilt: null, tiltOn: false,  // téléphone, peloton en 2D : changer de rang en penchant l'appareil (contrôleur d'inclinaison, actif ou non)
    cps: null, seen: new Set(), // points de passage de la course, passages déjà annoncés
    feed: [],                   // zones de ravitaillement (étapes longues, avec l'alimentation)
    cmd: 0, auto: false, usedAuto: false,
    acc: 0, last: 0,
    gaugeMax: 1000,
    ghosts: [],
    liveStart: null, liveTimer: null, lastSent: 0, liveLoop: 0,
    recording: false,
    lastHud: 0, lastAnnounce: 0, lastChart: 0, lastProg: 0, lastSock: 0, renderS: 0,
    lastBoard: 0, boardAll: false, boardDirty: true, // classement de l'étape en direct
    ctab: 'stage', classif: null,                   // onglet des classements ; données des classements points, montagne, passages
    pHist: [], savedHist: [],
    slowUntil: 0, holdUntil: 0, holdWhy: '', zoneSeen: new Set(), zoneNow: null, slowed: false, slowWhy: '', // retour à ×1 aux évènements
    chart: null,
    // page de jeu (écran de course), affichée du décompte jusqu'à « Quitter » ; décompte avant le départ en cours, et son minuteur
    inGame: false, counting: false, cdTimer: null,
  };

  function plan() {
    const p = store.plan;
    return p && !store.planStale ? p : null;
  }

  /** Temps (s) auquel le plan passe à la distance s. */
  function planTimeAt(p, s) { return R.traceTimeAt(p.series.s, s, p.tFinish); }

  function liveActive() { return !!(PYR.live && PYR.live.inRace()); }

  /** Vent subi par un coureur : {kmh, rot (° : sens où il souffle, 0 = vers l'avant du cycliste), app (km/h, vent apparent), head, side (km/h)} ou null. */
  function windOf(r) {
    const c = r && r.cond;
    if (!c || !Number.isFinite(c.W)) return null;
    const head = c.wh || 0, side = Number.isFinite(c.wcS) ? c.wcS : 0; // > 0 : de face ; > 0 : vient de la droite
    const v = r.st.v;
    return {
      kmh: c.W * 3.6, rot: (Math.atan2(-side, -head) * 180) / Math.PI,
      app: Math.hypot(v + head, side) * 3.6, head: head * 3.6, side: side * 3.6,
    };
  }

  function myName() { return String(store.state.rider.name || '').trim() || 'Toi'; }

  /** Durée du décompte avant le départ (s, réglage du panneau ; 0 : départ immédiat). */
  function countdownSec() { return U.clamp(Math.round(Number(store.state.game.countdown) || 0), 0, 600); }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  /** Durée en toutes lettres : « 45 s », « 1 min 05 s », « 5 min », « 1 h 30 min ». */
  function durLabel(d) {
    if (d < 60) return `${Math.round(d)} s`;
    return U.fmtDuration(d).replace(/ 00 s$/, '').replace(/ 00 min$/, '');
  }

  /** Appelle une fonction de l'écran de course mobile (game-mobile.js), s'il est chargé. */
  function mobile(fn, ...args) {
    const m = PYR.gameMobile;
    if (m && m[fn]) m[fn](...args);
  }

  /** Consigne affichée : la jauge en manuel, la puissance de relais en relais, sinon celle de la tactique. */
  function shownCmd() {
    const me = G.me;
    return !me || me.tac.mode === 'manual' ? G.cmd : me.tac.mode === 'relay' ? me.tac.pull : (me.lastPcmd || 0);
  }

  /** Règles de la course : celles de l'organisateur (direct), du créateur (défi) ou les tiennes. */
  function currentRules() {
    if (G.mode === 'live' && PYR.live) return Race.normRules(PYR.live.rules());
    if (G.mode === 'challenge') return Race.normRules(PYR.challenges.rules());
    return Race.normRules(store.state.game);
  }

  /** Points de passage (sprints, sommets, arrivée) : ceux de l'organisateur ou du créateur, sinon ceux choisis dans l'onglet Parcours. */
  function currentCps(course) {
    const given = G.mode === 'live' && PYR.live ? PYR.live.checkpoints() : G.mode === 'challenge' ? PYR.challenges.checkpoints() : null;
    return given ? Cl.normalize(given, course.length) : Cl.fromList(store.state.checkpoints, course);
  }

  /** Zones de ravitaillement (avec l'option alimentation) : celles de l'organisateur ou du créateur, sinon celles de l'onglet Parcours. */
  function currentFeed(course, rules) {
    if (!rules || !rules.fuel) return [];
    const given = G.mode === 'live' && PYR.live ? PYR.live.feedZones() : G.mode === 'challenge' ? PYR.challenges.feedZones() : null;
    return given ? PYR.feed.normalize(given, course.length) : PYR.feed.fromList(store.state.feedZones, course);
  }

  /** Repères du profil : bande de chaque côte classée, ligne des sprints et des sommets. */
  function flagsFor(cps, feed) {
    const flags = cps.filter((c) => c.type !== 'finish').map((c) => (c.type === 'sprint'
      ? { s: c.s, label: 'S', color: SPRINT_COLOR }
      : { s: c.s, from: c.start, label: Cl.catOf(c.cat).short.replace(' cat.', ''), color: KOM_COLOR }));
    for (const z of feed || []) flags.push({ s: z.end, from: z.s, label: 'R', color: FEED_COLOR, band: 'rgba(10, 126, 164, 0.22)' });
    return flags;
  }

  /**
   * Coureurs des classements au temps de course t : toi, les coureurs virtuels, les fantômes du défi
   * (seulement les passages déjà « vécus » à t) et les joueurs en direct. [{id, name, splits, s, me}]
   */
  function classRiders(t) {
    const out = [];
    if (!G.race) return out;
    for (const r of G.race.riders) out.push({ id: r.id, name: r.name, splits: r.splits, s: r.st.s, me: r === G.me });
    if (G.mode === 'challenge') {
      for (const g of G.ghosts) {
        if (!g.sp) continue;
        out.push({ id: g.id, name: g.name, splits: g.sp.map((x) => (x !== null && x <= t ? x : null)), s: R.tracePosAt(g.s, t), ghost: true });
      }
    }
    if (G.mode === 'live' && PYR.live) {
      for (const o of PYR.live.opponents()) out.push({ id: 'live-' + o.id, name: o.name, splits: o.splits || [], s: o.s, live: true });
    }
    return out;
  }

  /**
   * Facteur de rafale au temps de course t, lissé sur ~0,3 s d'affichage : à x50, une rafale de 5 s ne dure que
   * 0,1 s à l'écran, on montre donc la moyenne sur la durée écoulée entre deux images plutôt qu'un vent qui clignote.
   */
  function gustNow(t) {
    const gs = G.ctx && G.ctx.gusts;
    if (!gs) return 0;
    const scale = G.mode === 'live' ? 1 : Number(store.state.game.timeScale) || 1;
    const w = U.clamp(Math.round(scale * 0.3), 1, 40);
    const t1 = Math.min(gs.length - 1, Math.floor(t));
    let sum = 0, n = 0;
    for (let j = Math.max(0, t1 - w + 1); j <= t1; j++) { sum += gs[j]; n++; }
    return n ? sum / n : 0;
  }

  /** Vent lu par les manches à air au temps de course t : la météo si elle est chargée, sinon les portions de vent saisies. */
  function sockWind(t) {
    const C = G.ctx.course, g = gustNow(t), tmp = {};
    return (s, i) => {
      if (C.weather) {
        const wx = PYR.weather.at(C.weather, s, C.weather.start + t, tmp);
        return { kmh: Math.max(0, wx.ws + (wx.gust - wx.ws) * g) * 3.6, dir: wx.wd };
      }
      if (!Number.isFinite(C.windDir[i])) return null;
      return { kmh: Math.max(0, C.wMean[i] + C.wAmp[i] * g) * 3.6, dir: C.windDir[i] };
    };
  }

  const T = {
    init() {
      // page de préparation (téléphone) : les infobulles ne s'affichent pas au toucher, on touche la vignette « Tenable » ou une réserve pour
      // ouvrir une fenêtre qui explique ce qu'elle mesure
      const tap = (el, kind) => {
        if (!el) return;
        el.classList.add('hud-info');
        el.setAttribute('role', 'button'); el.tabIndex = 0;
        el.addEventListener('click', () => T.explain(kind));
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); T.explain(kind); } });
      };
      tap($('#hud-tte').parentElement, 'tte');
      for (const [meter, text, kind] of [['#hud-wbal-meter', '#hud-wbal', 'wbal'], ['#hud-energy-meter', '#hud-energy', 'energy'], ['#hud-hydra-fill', '#hud-hydra', 'hydra']]) {
        tap($(meter).closest('.meter'), kind);
        tap($(text).parentElement, kind);
      }
      G.chart = new PYR.charts.ProfileChart($('#game-chart'), {
        tracks: false,
        follow: true, // le profil suit le cycliste : 30 % de la partie visible derrière lui, 70 % devant (largeur réglée par le zoom)
        anchor: 0.3,
        emptyText: 'Trace un parcours pour jouer.',
        onHover: (s) => PYR.map.showHover(s),
      });
      $('#board-all').addEventListener('click', (e) => {
        G.boardAll = !G.boardAll; G.boardDirty = true; G.boardToggled = true;
        e.currentTarget.setAttribute('aria-pressed', String(G.boardAll));
        e.currentTarget.textContent = G.boardAll ? 'Résumé' : 'Tous';
        $('#pane-stage').classList.toggle('all', G.boardAll);
        T.renderBoard();
      });
      $('#g-start').addEventListener('click', () => T.start());
      $('#g-pause').addEventListener('click', () => T.togglePause());
      // « Recommencer » : depuis la page de jeu, une nouvelle partie repart aussitôt (avec le décompte) ; depuis les réglages, elle attend « Démarrer »
      $('#g-reset').addEventListener('click', () => {
        if (G.mode === 'live' && G.running && !G.finished) return;
        const again = G.inGame;
        T.reset();
        if (again) T.start();
      });
      $('#g-quit').addEventListener('click', () => T.quit());
      $('#g-auto').addEventListener('change', (e) => { G.auto = e.target.checked && G.mode !== 'live'; if (G.auto) G.usedAuto = true; T.renderHud(true); });
      $('#hud-eat').addEventListener('click', () => T.eat());
      $('#hud-drink').addEventListener('click', () => T.drink());
      $('#hud-feed').addEventListener('click', () => T.feed());
      PYR.weatherFx.attach($('.map-wrap')); // animation de la pluie par-dessus la carte
      G.curve = new PYR.charts.RaceCurveChart($('#game-curve')); // grand écran : puissance selon la durée, sous le profil
      T.bindCurveGrip();
      T.bindSideGrip();
      T.bindGauge();
      T.buildTactics();
      document.addEventListener('keydown', (e) => T.onKey(e));
      // pendant le décompte, la partie est prête et ne doit plus changer (G.counting), comme une fois partie
      store.on('profile', () => { if (!(G.mode === 'live' && G.liveStart)) T.reset(); });
      store.on('plan', () => { T.renderLegend(); if (!G.running && !G.counting) T.reset(); });
      store.on('challenge', () => { if (!G.running && !G.counting && !G.recording && G.mode !== 'live') T.reset(); });
      store.on('rider', () => { if (!G.running && !G.counting && !G.liveStart) T.reset(); });
      store.on('bike', () => { if (!G.running && !G.counting && !G.liveStart) T.reset(); });
      // le vent, la météo et les revêtements font partie du parcours simulé (et des manches à air affichées)
      ['winds', 'weather', 'surfaces', 'env', 'road', 'checkpoints', 'feedZones'].forEach((e) => store.on(e, () => { if (!G.running && !G.counting && !G.liveStart) T.reset(); }));
      store.on('game', (ev) => {
        if (ev && /^game\.(bots|botLevel|events|form|fuel|physio|pullSec|peloton)$/.test(ev.path) && !G.running && !G.counting && !G.liveStart) T.reset();
      });
      T.renderLegend();
    },

    onShow() {
      PYR.map.setMode('game');
      if (!G.ready) T.reset();
      T.focus(false);
      G.chart.setProfile(store.profile);
      G.chart.surface.request();
      PYR.map.setCheckpoints(G.cps, G.feed);
      PYR.map.setWindsocks(G.ctx ? G.ctx.course : null);
      PYR.map.setRoad(G.ctx && G.rules && G.rules.peloton ? G.ctx.course : null);
      PYR.weatherFx.start();
      T.render(0);
      T.renderHud(true);
      PYR.challenges.render();
      // page de réglages, ou retour sur la page de jeu laissée en changeant d'onglet (la course y est en pause)
      mobile(G.inGame ? 'enter' : 'sync');
    },

    /** Centre la carte sur le cycliste (toujours, ou seulement s'il est hors champ ou la carte trop dézoomée). */
    focus(always) {
      const pos = PYR.map.latLngAt(G.renderS || 0, G.me && G.me.lat ? G.me.lat.y : undefined);
      if (!pos) return;
      const map = PYR.map.map;
      if (always || map.getZoom() < 13 || !map.getBounds().contains(pos)) map.setView(pos, Math.max(map.getZoom(), 14));
    },

    onHide() {
      if (G.counting) T.reset(); // décompte interrompu : la partie reste à lancer
      if (G.running && G.mode !== 'live') T.togglePause();
      if (G.tiltOn) T.setTilt(false); // le capteur ne sert qu'en course
      mobile('leave');
      PYR.map.followSettle();
      $('#game-hud').hidden = true;
      PYR.weatherFx.stop();
      PYR.map.setGameMarkers(null);
      PYR.map.setProgress(null);
      PYR.map.setCheckpoints(null);
      PYR.map.setWindsocks(null);
      PYR.map.setRoad(null);
      PYR.map.setHeadingUp(null); // la carte, partagée avec les autres onglets, reprend sa place et son orientation
      if (G.closeUp) T.toggleCloseUp();
    },

    /** Boussole : nord en haut (vrai) ou carte orientée dans le sens du cycliste (faux, par défaut). */
    setNorthUp(on) {
      store.state.game.northUp = !!on;
      store.save();
      if (G.ready && !G.running) T.render(1); // en pause ou à l'arrivée, la boucle ne redessine pas
      mobile('refresh');
    },

    /** Peloton en 2D : changer de rang (← : dir = −1, → : +1) ; le placement automatique reprend après quelques secondes. */
    nudge(dir) {
      const me = G.me;
      if (!me || !me.lat || G.finished || me.incident) return;
      Pel.nudge(me, dir, me.st.t, G.ctx.course);
    },

    /**
     * Téléphone, peloton en 2D : change de rang en penchant l'appareil à droite ou à gauche (comme ← →). Demande l'accès au capteur
     * d'orientation (iOS : à partir d'un toucher) ; la posture du moment sert de neutralité. Renvoie vrai si le mode est actif.
     */
    async setTilt(on) {
      if (!on) {
        if (G.tiltHandler) window.removeEventListener('deviceorientation', G.tiltHandler);
        G.tiltHandler = null; G.tiltOn = false; G.tilt = null;
        mobile('tiltOffset', 0);
        mobile('refresh');
        return false;
      }
      if (G.tiltOn) return true;
      const DOE = window.DeviceOrientationEvent;
      if (!DOE || window.isSecureContext === false) {
        D.toast('Inclinaison indisponible : le capteur d\'orientation demande une page en HTTPS.', 'error');
        return false;
      }
      if (typeof DOE.requestPermission === 'function') {
        let ok = false;
        try { ok = (await DOE.requestPermission()) === 'granted'; } catch (e) { ok = false; }
        if (!ok) { D.toast('Accès au capteur d\'orientation refusé : autorise-le dans les réglages du navigateur.', 'error'); return false; }
      }
      const Tilt = PYR.tilt;
      G.tilt = Tilt.create();
      let seen = false, shown = 0;
      G.tiltHandler = (e) => {
        if (e.beta === null || e.beta === undefined || e.gamma === null || e.gamma === undefined) return;
        seen = true;
        const ang = (window.screen && screen.orientation && Number.isFinite(screen.orientation.angle)) ? screen.orientation.angle : Number(window.orientation) || 0;
        const dir = Tilt.feed(G.tilt, Tilt.rollFrom(e.alpha || 0, e.beta, e.gamma, ang), performance.now());
        const off = Math.round(Tilt.offset(G.tilt));
        if (off !== shown) { shown = off; mobile('tiltOffset', off); }
        if (dir && G.running && G.me && G.me.lat && !G.finished) T.nudge(dir);
      };
      window.addEventListener('deviceorientation', G.tiltHandler);
      G.tiltOn = true;
      mobile('refresh');
      setTimeout(() => { if (G.tiltOn && !seen) { T.setTilt(false); D.toast('Pas de capteur d\'inclinaison sur cet appareil.', 'error'); } }, 2000);
      return true;
    },

    /** Reprend la posture actuelle comme neutralité de l'inclinaison (départ, reprise après une pause). */
    calibrateTilt() {
      if (G.tiltOn && G.tilt) PYR.tilt.recalibrate(G.tilt);
    },

    /** « Zoom peloton » : la carte au plus près du joueur (vélos à l'échelle), et retour à la vue d'avant. */
    toggleCloseUp() {
      G.closeUp = !G.closeUp;
      const me = G.me;
      PYR.map.closeUp(G.closeUp, G.closeUp && me ? PYR.map.latLngAt(G.renderS || 0, me.lat ? me.lat.y : undefined) : null);
      mobile('refresh');
    },

    renderLegend() {
      const el = $('#game-legend');
      D.clear(el);
      const th = PYR.charts.theme();
      const key = (color, label) => h('span', { class: 'key' }, h('span', { class: 'sw', style: { background: color, borderRadius: '50%', width: '9px', height: '9px' } }), label);
      el.appendChild(key(th.s2, 'Toi'));
      for (const g of G.ghosts) el.appendChild(key(g.color, g.name));
      const bots = G.race ? G.race.riders.filter((r) => r !== G.me) : [];
      if (bots.length > MAX_LEGEND) el.appendChild(h('span', { class: 'key' }, `${bots.length} coureurs virtuels`)); // trop pour les nommer tous
      else for (const r of bots) el.appendChild(key(r.color, r.name));
      if (G.mode === 'live' && PYR.live) for (const o of PYR.live.opponents()) el.appendChild(key(o.color, o.name));
    },

    /** Qui fixe les règles (affiché sous les options de course). */
    renderRulesNote() {
      const note = $('#g-rules-note');
      const r = G.mode === 'solo' ? null : currentRules();
      note.hidden = !r;
      if (!r) return;
      const on = [r.events && 'incidents', r.form && 'forme du jour', r.fuel && 'alimentation', r.physio && 'modèle physiologique', r.peloton && 'peloton en 2D'].filter(Boolean);
      const cl = CV.cpsText(G.cps);
      note.textContent = `${G.mode === 'live' ? 'Course en direct : règles fixées par l\'organisateur' : 'Défi : règles fixées par son créateur'} — ${on.length ? on.join(', ') : 'sans incidents, forme ni alimentation'}, ${r.pullSec > 0 ? `relais de ${r.pullSec} s` : 'relais sans limite de durée'}, ${cl ? 'classements : ' + cl : 'sans classements annexes'}. Pas de coureurs virtuels.`;
    },

    /** Points de passage du parcours (sous les options de course). */
    renderCpsNote() {
      const note = $('#g-cps-note');
      const cps = G.cps;
      const list = cps ? cps.filter((c) => c.type !== 'finish') : [];
      if (!list.length) {
        note.textContent = G.mode === 'solo' && store.profile ? 'Pas de sprint ni de côte classée : ajoutes-en dans l\'onglet Parcours (à la main ou automatiquement).' : '';
        note.hidden = !note.textContent;
        return;
      }
      const parts = list.map((c) => `${Cl.shortLabel(c, cps)} au km ${U.fmt(c.s / 1000, 1)}${c.type === 'kom' && Cl.climbText(c) ? ` (${Cl.climbText(c)})` : ''}`);
      note.textContent = `Points en jeu : ${parts.join(' · ')}, et à l'arrivée.${G.mode === 'solo' ? ' Ils se règlent dans l\'onglet Parcours.' : ''}`;
      note.hidden = false;
    },

    /** Prépare une nouvelle partie (sans la démarrer). */
    reset() {
      T.cancelCountdown();
      G.inGame = false; // une nouvelle partie se lance depuis la page de réglages
      mobile('leave');
      T.stopLiveTimer();
      G.boardDirty = true;
      if (G.chart) G.chart.zoom.manual = false; // une nouvelle partie : le profil zoomé suit de nouveau le cycliste
      G.running = false; G.finished = false; G.ready = false;
      G.mode = liveActive() ? 'live' : PYR.challenges && PYR.challenges.isCurrent() ? 'challenge' : 'solo';
      if (G.mode !== 'live') G.liveStart = null;
      const isLive = G.mode === 'live';
      $('#g-start').textContent = 'Démarrer';
      $('#g-start').disabled = isLive;
      $('#g-pause').disabled = true;
      $('#g-pause').textContent = 'Pause';
      $('#g-speed').disabled = isLive;
      $('#g-auto').disabled = isLive;
      $('#g-quit').disabled = isLive; // en direct, on reste sur la page de jeu jusqu'à l'arrivée
      if (isLive) { $('#g-auto').checked = false; G.auto = false; }
      $('#game-result').hidden = true;
      $('#hud-banner').hidden = true;
      PYR.map.setProgress(null);
      if (G.closeUp) T.toggleCloseUp(); // une nouvelle partie repart de la vue d'ensemble
      T.renderRulesNote();
      if (!store.profile) {
        setStatus('Trace un parcours dans l\'onglet Parcours pour jouer.');
        G.race = null; G.me = null; G.ctx = null; G.st = null; G.ghosts = []; G.cps = null; G.feed = [];
        G.chart.setFlags(null);
        if (store.state.ui.tab === 'game') { PYR.map.setGameMarkers(null); PYR.map.setCheckpoints(null); PYR.map.setWindsocks(null); PYR.map.setRoad(null); }
        T.renderLegend();
        T.renderCpsNote();
        T.renderClassif();
        mobile('sync');
        return;
      }
      const machine = isLive ? PYR.live.machine() : G.mode === 'challenge' ? PYR.challenges.machine() : null;
      let inputs;
      try { inputs = PYR.tabPerf.buildInputs(machine); } catch (e) { setStatus(e.message, true); return; }
      G.inputs = inputs;
      G.machineFrom = machine ? machine.from : null;
      const rules = G.rules = currentRules();
      const cps = G.cps = currentCps(inputs.course);
      G.feed = currentFeed(inputs.course, rules);
      G.seen = new Set();
      const seed = (Math.random() * 4294967296) >>> 0;
      const race = G.race = Race.create({ course: inputs.course, rules, seed, gustSeed: inputs.seed, cps, feed: G.feed });
      const form = rules.form ? PYR.physio.drawForm(U.mulberry32(seed ^ 0x9e3779b9)) : null;
      G.cmd = Math.round(inputs.athlete.ftp * 0.75 / 10) * 10;
      // le profil du cycliste (celui de la machine imposée en armes égales) donne sa carte athlète au modèle physiologique
      const riderIn = machine && machine.rider ? machine.rider : store.state.rider;
      G.me = Race.addRider(race, { id: 'me', name: myName(), color: ME_COLOR, human: true, setup: inputs.setup, athlete: inputs.athlete, v0: inputs.v0, margin: inputs.margin, form, cmd: G.cmd, gut: Number(store.state.rider.gut) || 0, kit: Fu.normKit(store.state.game.kit), rider: riderIn });
      G.ctx = G.me.ctx; G.st = G.me.st;
      T.applyFollowLimits();
      const nBots = G.mode === 'solo' ? Math.max(0, Math.min(Race.MAX_BOTS, Math.floor(Number(store.state.game.bots) || 0))) : 0;
      if (nBots > 0) {
        Race.addBots(race, { n: nBots, level: store.state.game.botLevel, rider: store.state.rider, bike: store.state.bike, v0: inputs.v0, colors: Race.palette(PYR.challenges.COLORS, nBots) });
      }
      // peloton en deux dimensions : grille de départ (le joueur au premier rang, les autres derrière, côte à côte) ; en direct,
      // une voie tirée de l'identifiant (les autres joueurs envoient la leur)
      if (rules.peloton) { if (isLive) Pel.place(race, G.me); else Pel.grid(race); }
      race.onEvent = (ev) => T.onRaceEvent(ev);
      G.acc = 0; G.renderS = 0; G.pHist = []; G.savedHist = []; G.tteKey = null;
      G.boostT = 0;
      G.best = new Float64Array(CURVE_MAX); G.lastCurve = 0;
      G.slowUntil = 0; G.holdUntil = 0; G.zoneSeen = new Set(); G.zoneNow = null; G.slowed = false;
      G.usedAuto = G.auto;
      G.gaugeMax = Math.max(600, Math.ceil(G.me.athlete.pmax / 100) * 100);
      G.lastP = 0; G.lastPcmd = 0;
      // fantômes
      G.ghosts = [];
      const th = PYR.charts.theme();
      const p = plan();
      if (!isLive && p && store.state.game.ghost) G.ghosts.push({ id: 'plan', name: 'Plan optimal', color: th.s1, s: p.series.s, time: p.tFinish });
      if (G.mode === 'challenge') G.ghosts.push(...PYR.challenges.ghosts());
      G.ready = true;
      G.chart.setFlags(flagsFor(cps, G.feed));
      if (store.state.ui.tab === 'game') { PYR.map.setCheckpoints(cps, G.feed); PYR.map.setWindsocks(inputs.course); PYR.map.setRoad(rules.peloton ? inputs.course : null); }
      T.renderZones();
      T.renderLegend();
      T.renderTactics();
      T.renderRulesNote();
      T.renderCpsNote();
      T.renderClassif();
      const formText = form ? ` Forme du jour : ${form.label} (PC −${U.fmt((1 - form.cpK) * 100, 1)} %, HIE −${U.fmt((1 - form.wK) * 100, 1)} %).` : '';
      if (isLive) setStatus('Course en direct : le départ est donné automatiquement à l\'heure prévue.' + formText);
      else if (G.mode === 'challenge') setStatus((G.ghosts.length ? `Défi : ${G.ghosts.length} fantôme${G.ghosts.length > 1 ? 's' : ''} à battre. Ton arrivée sera ajoutée au classement.` : 'Défi : sois le premier à poser un temps !') + formText);
      else if (nBots) setStatus(`Prêt ! ${nBots} coureur${nBots > 1 ? 's' : ''} virtuel${nBots > 1 ? 's' : ''} au départ (${nBots + 1} avec toi) : reste dans les roues, prends des relais, attaque… (touches 1 à 9 et S${rules.peloton ? ' ; ← → pour changer de rang, Z pour le zoom peloton' : ''}).` + formText);
      else setStatus((p ? 'Prêt ! Bats le fantôme de la stratégie optimale.' : 'Prêt ! (Calcule la stratégie dans l\'onglet Performance pour affronter un fantôme.)') + formText);
      if (store.state.ui.tab === 'game') {
        T.focus(true);
        T.render(0);
        T.renderHud(true);
      }
      T.renderStats();
      mobile('sync');
    },

    /** « Démarrer » : on passe sur la page de jeu, puis la course part au bout du décompte (réglage du panneau). */
    start() {
      if (G.mode === 'live' || G.counting) return;
      if (G.mode === 'challenge' && !String(store.state.rider.name || '').trim()) { askName(() => T.start()); return; }
      if (!G.ready || G.finished) T.reset();
      if (!G.ready || G.running) return;
      $('#g-start').disabled = true;
      T.enterGame();
      const n = countdownSec();
      if (n > 0) T.countdown(n); else T.go(false);
    },

    /** Le départ est donné (counted : après un décompte, « Partez ! » s'affiche une seconde). */
    go(counted) {
      G.running = true;
      T.calibrateTilt();
      G.last = performance.now();
      $('#g-pause').disabled = false;
      setStatus('En route ! Règle la puissance avec la jauge ou les flèches ↑ ↓, ou choisis une tactique (1 à 9).');
      if (counted) T.flashGo();
      mobile('refresh');
      requestAnimationFrame((t) => T.frame(t));
    },

    /** Décompte de n secondes (temps réel) : la carte et les commandes restent actives, on règle sa puissance ou sa tactique avant le départ. */
    countdown(n) {
      G.counting = true;
      const end = Date.now() + n * 1000;
      setStatus('Départ imminent : règle ta puissance (↑ ↓) ou choisis une tactique (1 à 9) avant le top.');
      const tick = () => {
        G.cdTimer = null;
        if (!G.counting) return;
        const left = Math.ceil((end - Date.now()) / 1000);
        if (left > 0) { T.showCount(left); G.cdTimer = setTimeout(tick, 100); return; }
        G.counting = false;
        T.go(true);
      };
      tick();
    },

    /** Arrête le décompte (ou l'affichage de « Partez ! ») et efface le grand chiffre. */
    cancelCountdown() {
      G.counting = false;
      if (G.cdTimer) { clearTimeout(G.cdTimer); G.cdTimer = null; }
      T.showCount(null);
    },

    /** Grand chiffre du décompte au centre de l'écran de course, « Partez ! » (go), ou rien (null). */
    showCount(text, go) {
      const box = $('#game-countdown'), key = text === null ? '' : String(text);
      if (box.dataset.v === key) return;
      box.dataset.v = key;
      D.clear(box);
      box.hidden = !key;
      if (key) box.appendChild(h('span', go ? { class: 'go' } : null, key)); // un nouvel élément à chaque seconde relance l'animation
    },

    flashGo() {
      T.showCount('Partez !', true);
      G.cdTimer = setTimeout(() => { G.cdTimer = null; if (!G.counting) T.showCount(null); }, 1000);
    },

    /** Page de jeu : l'écran de course remplace la page de réglages (sur téléphone, en plein écran). */
    enterGame() {
      G.inGame = true;
      mobile('enter');
    },

    /**
     * « Quitter » : retour à la page de réglages. Une course partie y reste en pause (« Reprendre » y ramène) ; pas encore partie, elle
     * redevient une partie prête. En direct, la course continue : on ne quitte la page de jeu qu'après l'arrivée.
     */
    quit() {
      if (G.mode === 'live' && !G.finished) return;
      if (G.counting || (!G.finished && G.st && G.st.t === 0 && !G.running)) { T.reset(); return; }
      if (G.running) T.togglePause();
      G.inGame = false;
      mobile('leave');
    },

    togglePause() {
      if (!G.ready || G.finished || G.mode === 'live' || G.counting) return;
      if (G.running) {
        G.running = false;
        PYR.map.followSettle();
        $('#g-pause').textContent = 'Reprendre';
        setStatus('Pause.');
        mobile('refresh');
      } else {
        G.running = true;
        T.calibrateTilt();
        G.last = performance.now();
        $('#g-pause').textContent = 'Pause';
        setStatus('');
        requestAnimationFrame((t) => T.frame(t));
        T.enterGame(); // reprise depuis la page de réglages (après Quitter) : retour sur la page de jeu
      }
    },

    frame(now) {
      if (!G.running || G.mode === 'live') return;
      const dt = Math.min(0.25, (now - G.last) / 1000);
      G.last = now;
      if (now < G.holdUntil) { // pause de réaction : la course est figée, les commandes restent actives
        T.render(Math.min(1, G.acc));
        if (now - G.lastHud > 90) { T.renderHud(); G.lastHud = now; } else T.renderLimits();
        requestAnimationFrame((t) => T.frame(t));
        return;
      }
      T.decayBoost(now);
      const base = Number(store.state.game.timeScale) || 1;
      const scale = T.effScale(base);
      G.acc += dt * scale;
      // la simulation ne prend jamais plus de STEP_BUDGET_MS par image : à 90 coureurs et ×50, mieux vaut ralentir un peu le temps de course que saccader l'affichage
      const deadline = performance.now() + STEP_BUDGET_MS;
      let n = 0;
      while (G.acc >= 1 && !G.st.finished && n < 400) {
        T.stepOnce(); G.acc -= 1; n++;
        if (performance.now() > deadline) break;
        if (performance.now() < G.holdUntil) { G.acc = Math.min(G.acc, 0.99); break; } // une pause vient de commencer
        if (T.effScale(base) < scale) { G.acc = Math.min(G.acc, 0.99); break; }       // retour à ×1 : on ne rattrape pas le temps accéléré
      }
      if (G.acc > 2 * scale + 1) G.acc = scale; // retard accumulé : on le laisse tomber plutôt que de le rattraper
      if (G.st.finished) { PYR.map.followSettle(); T.finish(); return; }
      T.render(Math.min(1, G.acc));
      if (now - G.lastHud > 90) { T.renderHud(); G.lastHud = now; } else T.renderLimits(); // limites et durée tenable : à chaque image
      requestAnimationFrame((t) => T.frame(t));
    },

    /* ---------- course en direct : horloge réelle ---------- */
    /** Arme la partie pour un départ à startLocal (ms, horloge locale). */
    armLive(startLocal) {
      G.liveStart = startLocal;
      T.reset();
      if (!G.ready) return;
      G.liveTimer = setInterval(() => T.liveTick(), 100);
      // une seule boucle d'affichage, même si le départ est réarmé plusieurs fois
      const loop = ++G.liveLoop;
      requestAnimationFrame((t) => T.liveFrame(t, loop));
      T.liveTick();
    },

    stopLiveTimer() {
      if (G.liveTimer) { clearInterval(G.liveTimer); G.liveTimer = null; }
    },

    /** Fin de session en direct : on revient au jeu ordinaire. */
    leaveLive() {
      T.stopLiveTimer();
      G.liveStart = null;
      T.reset();
    },

    liveTick() {
      if (G.mode !== 'live' || !G.ready || G.finished) return;
      const raceT = (Date.now() - G.liveStart) / 1000;
      const b = $('#hud-banner');
      if (raceT < 0) {
        const left = Math.ceil(-raceT), n = countdownSec();
        // dernières secondes (durée du décompte réglé) : la page de jeu s'ouvre et le grand chiffre remplace l'alerte
        if (n > 0 && left <= n) {
          if (!G.inGame) T.enterGame();
          b.hidden = true;
          T.showCount(left);
          return;
        }
        b.hidden = false; b.classList.add('info');
        b.textContent = left > 60 ? `Départ à ${new Date(G.liveStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (dans ${U.fmtClock(left)})` : `Départ dans ${left}…`;
        return;
      }
      if (!G.running) {
        G.running = true;
        T.enterGame();
        if (countdownSec() > 0) T.flashGo();
        setStatus('C\'est parti ! Règle la puissance avec la jauge ou les flèches ↑ ↓, ou choisis une tactique (1 à 9).');
      }
      let n = 0;
      while (G.st.t < Math.floor(raceT) && !G.st.finished && n < 3600) { T.stepOnce(); n++; }
      const now = Date.now();
      if (now - G.lastSent >= LIVE_SEND_MS - 20 || G.st.finished) {
        G.lastSent = now;
        const me = G.me;
        // position à l'instant de l'envoi (extrapolée depuis la dernière seconde simulée) et datée du temps de
        // course : les autres la replacent à l'instant présent sans le décalage de la seconde simulée
        const ext = G.st.finished ? 0 : U.clamp(raceT - G.st.t, 0, 1.5);
        PYR.live.sendState({
          t: Math.round((G.st.t + ext) * 100) / 100, s: Math.round(Math.min(G.st.s + G.st.v * ext, G.ctx.course.length) * 100) / 100, v: G.st.v, P: G.lastP || 0,
          w: G.st.wbal / G.ctx.w0, tac: me.tac.mode, ph: me.tac.phase, inc: me.incident ? me.incident.type : null,
          sp: Cl.packSplits(me.splits), // temps de passage aux sprints et aux sommets
          y: me.lat ? Math.round(me.lat.y * 100) / 100 : undefined, // peloton en 2D : position latérale
        });
      }
      if (G.st.finished) T.finish();
    },

    liveFrame(now, loop) {
      // on continue d'afficher les adversaires après son arrivée, tant que la course dure
      if (loop !== G.liveLoop || G.mode !== 'live' || !G.ready || !G.liveStart) return;
      const raceT = (Date.now() - G.liveStart) / 1000;
      // la simulation avance par secondes entières : entre deux pas, on prolonge le mouvement à la vitesse
      // courante (position lisse, sans le retard d'une seconde ni les sauts d'un pas à l'autre)
      if (G.finished || raceT < 0) T.render(raceT < 0 ? 0 : 1);
      else T.render(1, U.clamp(raceT - G.st.t, 0, 1.5));
      if (G.running) T.decayBoost(now);
      if (now - G.lastHud > 150) { T.renderHud(); G.lastHud = now; } else T.renderLimits();
      requestAnimationFrame((t) => T.liveFrame(t, loop));
    },

    /** Une seconde de course : les autres joueurs (direct), le pilote automatique, puis la simulation. */
    stepOnce() {
      const me = G.me, race = G.race;
      if (G.mode === 'live' && PYR.live) {
        race.external = PYR.live.opponents(me.st.t).map((o) => ({
          id: 'live-' + o.id, s: o.s, v: o.v, mode: o.mode || 'manual', phase: o.phase || null, stopped: !!o.stopped, finished: o.finished,
          y: Number.isFinite(o.y) ? o.y : undefined, // sans position latérale (ancienne version) : placé par peloton.js
        }));
      }
      const p = plan();
      if (G.auto && p && G.mode !== 'live') {
        if (me.tac.mode !== 'manual') Tac.setMode(me, 'manual', me.st.t);
        me.tac.cmd = p.series.P[Math.min(p.n - 1, Math.floor(planTimeAt(p, me.st.s)))];
        G.cmd = Math.round(me.tac.cmd);
      }
      if (G.auto && G.feed.length) Race.takeFeed(race, me, true); // pilote automatique : musette s'il reste peu de vivres
      Race.step(race);
      G.lastP = me.lastP;
      G.lastPcmd = me.lastPcmd;
      G.pHist.push(me.lastP);
      if (G.pHist.length > 5) G.pHist.shift();
      G.savedHist.push(me.savedW);
      if (G.savedHist.length > 3) G.savedHist.shift();
      // meilleures moyennes de puissance de l'étape, pour chaque durée déjà roulée (fenêtre se terminant à cette seconde)
      const Hh = G.st.hist, tt = G.st.t;
      const dmax = tt < CURVE_MAX ? tt : CURVE_MAX, best = G.best;
      for (let d = 1; d <= dmax; d++) { const a = (Hh[tt] - Hh[tt - d]) / d; if (a > best[d - 1]) best[d - 1] = a; }
      T.updateSlow();
    },

    /* ---------- retour à ×1 aux évènements ---------- */
    slowOn() { return !!store.state.game.slowOn && G.mode !== 'live'; },

    /** Vitesse du temps réellement appliquée : ×1 pendant un évènement ou avant un point de passage, sinon celle choisie. */
    effScale(base) {
      return base > 1 && T.slowOn() && (G.st.t < G.slowUntil || G.zoneNow) ? 1 : base;
    },

    /** Annonce le passage à ×1 (et le retour à la vitesse choisie). */
    watchSlow() {
      const base = Number(store.state.game.timeScale) || 1;
      const slow = T.effScale(base) < base;
      if (slow === G.slowed) return;
      G.slowed = slow;
      if (G.running) D.toast(slow ? `Vitesse ×1 : ${G.slowWhy}` : `Vitesse ×${base} rétablie`);
    },

    /** Fige la course quelques secondes (temps réel) pour laisser le temps de réagir. */
    hold(sec, why) {
      if (!(sec > 0)) return;
      G.holdUntil = Math.max(G.holdUntil, performance.now() + sec * 1000);
      G.holdWhy = why;
    },

    /** Évènement de course (attaque, chute, crevaison) : ×1 pendant la durée réglée, et pause éventuelle. */
    onSlowEvent(ev) {
      if (!T.slowOn()) return;
      const spec = PYR.slowdown.eventSpec(store.state.game, ev.type);
      if (!spec) return;
      const why = { attack: 'attaque', crash: 'chute', puncture: 'crevaison' }[ev.type];
      if (spec.dur > 0) { G.slowUntil = Math.max(G.slowUntil, G.st.t + spec.dur); G.slowWhy = why; }
      T.hold(spec.pause, why);
    },

    /** Entrée dans la zone d'un point de passage : ×1 jusqu'à la ligne, pause éventuelle à l'entrée. */
    updateSlow() {
      const me = G.me;
      if (!T.slowOn() || !me || G.finished || !G.cps) { G.zoneNow = null; return; }
      const z = PYR.slowdown.zoneFor(G.cps, me.nextCp, me.st.s, store.state.game);
      if (z && !G.zoneSeen.has(z.k)) {
        G.zoneSeen.add(z.k);
        const why = { sprint: 'sprint intermédiaire', kom: 'côte classée', finish: 'arrivée' }[z.kind];
        G.slowWhy = why;
        T.hold(z.pause, why);
      }
      G.zoneNow = z;
    },

    /**
     * Dans un gros peloton, les évènements des autres sont trop nombreux pour être tous annoncés :
     * seuls ceux qui se passent près de toi (250 m) le sont, au plus un toutes les 4 s.
     */
    worthAnnouncing(ev) {
      const race = G.race;
      if (!race || race.riders.length <= BIG_FIELD) return true;
      const r = race.riders.find((x) => x.id === ev.id);
      if (!r || !G.me || Math.abs(r.st.s - G.me.st.s) > 250) return false;
      const now = performance.now();
      if (now - G.lastAnnounce < 4000) return false;
      G.lastAnnounce = now;
      return true;
    },

    /** Évènements de course : incidents, attaques des coureurs virtuels. */
    onRaceEvent(ev) {
      const me = ev.id === 'me';
      if (!me && !T.worthAnnouncing(ev)) return;
      T.onSlowEvent(ev);
      if (ev.type === 'puncture') D.toast(me ? `Crevaison ! Dépannage pendant ${ev.dur} s.` : `${ev.name} a crevé.`, me ? 'error' : undefined);
      else if (ev.type === 'crash') D.toast(me ? `Chute ! Tu repars dans ${ev.dur} s, un peu diminué (−${U.fmt(ev.hurt * 100, 0)} %).` : `${ev.name} est tombé.`, me ? 'error' : undefined);
      else if (ev.type === 'sealed' && me) D.toast('Crevaison colmatée par le liquide préventif : tu continues !');
      else if (ev.type === 'feed' && me) {
        const bits = [ev.gels ? `${ev.gels} gel${ev.gels > 1 ? 's' : ''}` : '', ev.bars ? `${ev.bars} barre${ev.bars > 1 ? 's' : ''}` : '', 'bidons pleins'].filter(Boolean);
        D.toast(`Musette saisie : ${bits.join(', ')}. Tu lèves le pied quelques secondes.`);
      } else if (ev.type === 'feedmiss' && me) D.toast('Zone de ravitaillement manquée !', 'error');
      else if (ev.type === 'attack' && !me) D.toast(ev.kom ? `${ev.name} attaque pour les points du sommet !` : `${ev.name} attaque !`);
    },

    /** Positions des autres (fantômes, coureurs virtuels, joueurs en direct) au temps de course t. */
    others(t, frac, ext) {
      const f = frac === undefined ? 1 : frac;
      const out = store.state.game.ghost || G.mode !== 'solo'
        ? G.ghosts.map((g) => ({ id: g.id, name: g.name, color: g.color, s: R.tracePosAt(g.s, t), time: g.time, trace: g.s }))
        : G.ghosts.filter((g) => g.id !== 'plan').map((g) => ({ id: g.id, name: g.name, color: g.color, s: R.tracePosAt(g.s, t), time: g.time, trace: g.s }));
      if (G.race) {
        const L = G.race.course.length;
        for (const r of G.race.riders) {
          if (r === G.me) continue;
          const s = r.finished ? L : Math.min(L, ext === undefined ? r.prevS + (r.st.s - r.prevS) * f : r.st.s + r.st.v * ext);
          const y = r.lat ? (ext === undefined ? r.lat.prevY + (r.lat.y - r.lat.prevY) * f : r.lat.y) : undefined;
          out.push({ id: r.id, name: r.name, color: r.color, s, y, v: r.st.v, time: r.finished ? r.time : null, bot: true, stopped: !!r.incident });
        }
      }
      if (G.mode === 'live' && PYR.live) {
        const ext2 = G.race && G.race.pelExt;
        for (const o of PYR.live.opponents()) {
          const p = ext2 && ext2.get('live-' + o.id);
          const y = Number.isFinite(o.y) ? o.y : p ? p.y : undefined;
          out.push({ id: 'live-' + o.id, name: o.name, color: o.color, s: o.s, y, v: o.v, time: o.finished ? o.time : null, live: true, stopped: !!o.stopped });
        }
      }
      return out;
    },

    /** frac : avancement entre les deux derniers pas (0 à 1) ; ext (direct) : secondes écoulées depuis le dernier pas, positions prolongées à la vitesse courante. */
    render(frac, ext) {
      const me = G.me;
      if (!me || !G.ctx) return;
      const s = ext === undefined ? Math.min(G.ctx.course.length, me.prevS + (me.st.s - me.prevS) * frac)
        : Math.min(G.ctx.course.length, me.st.s + me.st.v * ext);
      const tNow = Math.max(0, ext === undefined ? me.st.t - 1 + frac : me.st.t + ext);
      const others = T.others(tNow, frac, ext);
      // peloton en 2D : position latérale du joueur, interpolée comme sa position sur la route
      const y = me.lat ? (ext === undefined ? me.lat.prevY + (me.lat.y - me.lat.prevY) * frac : me.lat.y) : undefined;
      PYR.map.setGameMarkers(s, others, y);
      const now = performance.now();
      // gros peloton : les repères du profil se redessinent 30 fois par seconde (le dessin de 90 points coûte)
      if (others.length < 20 || (frac >= 1 && ext === undefined) || now - G.lastChart > 33) {
        const th = PYR.charts.theme();
        G.chart.setMarkers(others.map((o) => ({ s: o.s, color: o.color })).concat([{ s, color: th.s2 }]));
        G.lastChart = now;
      }
      if (now - G.lastProg > 250 || (frac >= 1 && ext === undefined)) { PYR.map.setProgress(s); G.lastProg = now; }
      // caméra recalée à chaque image : défilement continu (toujours au « Zoom peloton »)
      // carte tournée dans le sens de la marche (par défaut) pendant la course, tant que la caméra suit ; sinon nord en haut
      const follows = store.state.game.follow || G.closeUp;
      PYR.map.setHeadingUp(G.inGame && follows && !store.state.game.northUp ? s : null);
      if (follows) PYR.map.follow(PYR.map.latLngAt(s, y));
      if (now - G.lastSock > 250) { PYR.map.updateWindsocks(sockWind(tNow)); G.lastSock = now; }
      G.renderS = s;
    },

    /** Classement instantané et écart avec l'adversaire le plus proche devant (ou derrière). */
    standings() {
      const st = G.st;
      const t = st.t;
      const rivals = T.others(t);
      if (!rivals.length) return null;
      let ahead = 0, bestAhead = null, bestBehind = null;
      for (const o of rivals) {
        let gap; // > 0 : l'adversaire est devant (secondes)
        if (o.live || o.bot) gap = o.time !== null && o.time !== undefined ? Infinity : (o.s - st.s) / Math.max(1, st.v);
        else gap = t - R.traceTimeAt(o.trace, st.s, o.time);
        if (gap > 0) { ahead++; if (!bestAhead || gap < bestAhead.gap) bestAhead = { o, gap }; }
        else if (!bestBehind || gap > bestBehind.gap) bestBehind = { o, gap };
      }
      return { rank: ahead + 1, total: rivals.length + 1, ahead: bestAhead, behind: bestBehind };
    },

    /**
     * Classement en direct : tous les coureurs (toi compris) dans l'ordre de la course, avec leur écart avec toi en temps
     * et en distance. Écart en temps : d'après leur trace pour un fantôme (le plan, un défi), sinon la distance divisée
     * par la vitesse du poursuivant. Les arrivés sont classés au temps, avant ceux qui roulent encore.
     */
    boardRows() {
      const st = G.st, L = G.ctx.course.length, t = st.t;
      const myFin = st.finished;
      const myS = myFin ? L : G.mode === 'live' && G.renderS !== undefined ? G.renderS : st.s;
      const myV = Math.max(1, st.v);
      const rows = [{ me: true, id: 'me', name: 'Toi', color: PYR.charts.theme().s2, s: myS, v: st.v, fin: myFin, time: myFin ? st.tFinish : null, dt: 0, dd: 0 }];
      for (const o of T.others(t)) {
        const ghost = !o.live && !o.bot;
        const fin = ghost ? o.s >= L - 0.5 : o.time !== null && o.time !== undefined;
        const row = { me: false, id: o.id, name: o.name, color: o.color, s: fin ? L : o.s, v: o.stopped ? 0 : o.v, fin, time: fin ? o.time : null, stopped: !!o.stopped };
        row.dd = row.s - myS; // > 0 : devant toi (m)
        if (myFin && fin) row.dt = row.time !== null ? st.tFinish - row.time : 0; // > 0 : arrivé avant toi
        else if (myFin) row.dt = -Infinity;                                       // encore en route : derrière toi
        else if (fin) row.dt = t + (L - myS) / myV - (row.time ?? t); // estimé : quand tu passeras la ligne, à ta vitesse, moins son temps
        else if (ghost) row.dt = t - R.traceTimeAt(o.trace, myS, o.time);
        else row.dt = row.dd >= 0 ? row.dd / myV : row.dd / Math.max(1, row.v || myV);
        rows.push(row);
      }
      rows.sort((a, b) => {
        if (a.fin && b.fin) return (a.time ?? 0) - (b.time ?? 0) || (a.me ? -1 : b.me ? 1 : 0);
        if (a.fin !== b.fin) return a.fin ? -1 : 1;
        return b.s - a.s || (a.me ? -1 : b.me ? 1 : 0);
      });
      return rows;
    },

    renderBoard() {
      const box = $('#game-classif'), title = $('#game-classif-title');
      if (!box) return;
      const rows = G.me && G.st && G.ctx ? T.boardRows() : null;
      const on = !!rows && rows.length >= 2;
      box.hidden = !on; title.hidden = !on;
      if (!on) return;
      if (G.ctab !== 'stage' && T.classTabs().some((x) => x.id === G.ctab)) return; // un autre onglet est affiché
      const nowMs = performance.now();
      if (nowMs - G.lastBoard < 350 && !G.boardDirty) return; // quelques fois par seconde suffisent
      G.lastBoard = nowMs; G.boardDirty = false;
      const meIdx = rows.findIndex((r) => r.me), lead = rows[0];
      const myFin = rows[meIdx].fin;
      const time = (x) => { const a = Math.abs(x); return a < 60 ? `${U.fmt(a, 1)} s` : U.fmtClock(a); };
      const dist = (x) => { const a = Math.abs(x); return a < 1000 ? `${U.fmt(a, 0)} m` : `${U.fmt(a / 1000, 2)} km`; };
      // résumé : le premier, et l'écart avec lui
      const lead_ = $('#board-lead');
      if (meIdx === 0) {
        const next = rows[1];
        lead_.textContent = next.fin && !rows[0].fin ? '' : `Tu mènes${Number.isFinite(next.dt) ? ` : ${time(next.dt)} · ${dist(next.dd)} d'avance sur ${next.name}` : ''}`;
        if (rows[0].fin) lead_.textContent = `Tu as gagné${Number.isFinite(next.dt) ? `, ${time(next.dt)} devant ${next.name}` : ''}`;
      } else {
        lead_.textContent = lead.fin ? `${lead.name} est arrivé en ${U.fmtClock(lead.time)}`
          : `${lead.name} mène : ${time(lead.dt)} · ${dist(lead.dd)} devant toi`;
      }
      // lignes affichées : tous si peu nombreux (ou « Tous »), sinon le podium et ceux qui t'entourent
      const n = rows.length;
      const keep = new Set();
      if (n <= 10 || G.boardAll) rows.forEach((_, i) => keep.add(i));
      else {
        for (let i = 0; i < 3; i++) keep.add(i);
        for (let i = Math.max(0, meIdx - 3); i <= Math.min(n - 1, meIdx + 3); i++) keep.add(i);
      }
      const table = $('#board-table'), sc = $('#board-scroll'), prevTop = sc.scrollTop, toggled = G.boardToggled;
      G.boardToggled = false;
      D.clear(table);
      table.appendChild(h('thead', null, h('tr', null,
        h('th', null, '#'), h('th', null, 'Coureur'), h('th', { class: 'r', title: 'Écart avec toi en temps' }, 'Temps'), h('th', { class: 'r', title: 'Écart avec toi en distance' }, 'Distance'), h('th', { class: 'r' }, 'km/h'))));
      const body = h('tbody');
      let prev = -1;
      rows.forEach((r, i) => {
        if (!keep.has(i)) return;
        if (prev >= 0 && i > prev + 1) body.appendChild(h('tr', { class: 'skip' }, h('td', { colspan: '5' }, `… ${i - prev - 1} autre${i - prev - 1 > 1 ? 's' : ''} coureur${i - prev - 1 > 1 ? 's' : ''}`)));
        prev = i;
        let tCell, dCell;
        if (r.me) { tCell = '—'; dCell = r.fin ? `arrivé ${U.fmtClock(r.time)}` : `km ${U.fmt(r.s / 1000, 2)}`; }
        else {
          const sign = r.dd >= 0 ? '▲' : '▼';
          const cls = r.dd >= 0 ? 'ahead' : 'behind';
          if (r.fin && myFin) { tCell = h('span', { class: r.dt > 0 ? 'ahead' : 'behind' }, `${r.dt > 0 ? '▲' : '▼'} ${time(r.dt)}`); dCell = h('span', { class: 'done' }, `arrivé ${U.fmtClock(r.time)}`); }
          else if (r.fin) { tCell = h('span', { class: 'ahead' }, `▲ ${time(r.dt)}`); dCell = h('span', { class: 'done' }, `arrivé ${U.fmtClock(r.time)}`); }
          else if (myFin) { tCell = h('span', { class: 'behind' }, '▼ en route'); dCell = h('span', { class: 'behind' }, `▼ ${dist(r.dd)}`); }
          else { tCell = h('span', { class: cls }, `${sign} ${time(r.dt)}`); dCell = h('span', { class: cls }, `${sign} ${dist(r.dd)}`); }
        }
        body.appendChild(h('tr', { class: r.me ? 'me' : '' },
          h('td', null, String(i + 1)),
          h('td', { class: 'name', title: r.name }, (r.me && PYR.avatar.span(20, r.color)) || h('span', { class: 'dot', style: { '--c': r.color } }), r.name, r.stopped ? ' ⚠' : ''),
          h('td', { class: 'r' }, tCell), h('td', { class: 'r' }, dCell),
          h('td', { class: 'r' }, r.v !== undefined && r.v !== null && !r.fin ? U.fmt(r.v * 3.6, 0) : '–')));
      });
      table.appendChild(body);
      // ta ligne reste visible ; avec « Tous », la liste garde la position où on l'a laissée
      const meRow = body.querySelector('tr.me');
      if (G.boardAll && !toggled) sc.scrollTop = prevTop;
      else if (meRow && sc.scrollHeight > sc.clientHeight) sc.scrollTop = Math.max(0, meRow.offsetTop - (sc.clientHeight - meRow.offsetHeight) / 2);
    },

    renderHud(force) {
      const me = G.me, st = G.st, ctx = G.ctx;
      if (!me || !st || !ctx) return;
      $('#hud-speed').textContent = U.fmt(st.v * 3.6, 1);
      $('#hud-power').textContent = U.fmt(G.lastP || 0, 0);
      const cond = {};
      PYR.sim.conditions(ctx, Math.min(st.s, ctx.course.length - 1), st.t, cond);
      $('#hud-grade').textContent = U.fmt(cond.grade * 100, 1);
      T.renderWeather(cond);
      $('#hud-time').textContent = U.fmtClock(st.t);
      const gap = $('#hud-gap');
      const sd = st.t > 0 ? T.standings() : null;
      if (sd) {
        const ref = sd.ahead || sd.behind;
        const vs = ref ? (Number.isFinite(ref.gap) ? `${U.fmtDelta(ref.gap)} vs ${ref.o.name}` : `${ref.o.name} est arrivé`) : '';
        gap.textContent = `${sd.rank}ᵉ/${sd.total}${vs ? ' · ' + vs : ''}`;
      } else gap.textContent = '';
      T.renderDraft();
      for (const id of ['#hud-gap', '#hud-draft-sub', '#hud-tte-sub']) { const n = $(id); n.title = n.textContent; } // texte tronqué sur petit écran
      T.renderNext();
      T.renderBoard();
      T.watchCrossings();
      T.watchSlow();
      // W′bal (rapporté au W′ du moment : fringale, blessure, modèle physiologique)
      const w0 = PYR.sim.w0Of(ctx, st);
      const f = U.clamp(st.wbal / w0, 0, 1);
      const fill = $('#hud-wbal-fill');
      fill.style.width = (f * 100).toFixed(1) + '%';
      fill.style.background = levelColor(f);
      $('#hud-wbal').textContent = `${U.fmt(f * 100, 0)} % · ${U.fmt(st.wbal / 1000, 1)} kJ${f > 0.5 ? '' : f > 0.2 ? ' — attention' : f > 0.05 ? ' — presque vide' : ' — épuisé'}`;
      T.renderFuel();
      T.renderFeed();
      T.renderTactics();
      const avail = T.computeLimits();
      T.renderTte();
      G.hudx = { grade: cond.grade * 100, sd, avail, wf: f };
      // bannière (hors compte à rebours du direct)
      if (!(G.mode === 'live' && Date.now() < G.liveStart) && !G.finished) {
        let banner = '', info = false;
        const fs = me.fuel ? Fu.status(me.fuel) : null;
        const holdLeft = G.holdUntil - performance.now();
        if (holdLeft > 0 && G.running) { banner = `Pause (${G.holdWhy}) : ${Math.ceil(holdLeft / 1000)} s pour réagir`; info = true; }
        else if (me.incident) banner = `${me.incident.type === 'crash' ? 'Chute ! Tu repars' : 'Crevaison ! Dépannage'} dans ${U.fmtClock(me.incident.until - st.t)}`;
        else if (G.auto) { banner = 'Pilote automatique : le cycliste suit la stratégie optimale'; info = true; }
        else if (st.wbal < 1 && (G.lastPcmd || 0) > ctx.cp * st.capK + 1) banner = 'W′ épuisé : impossible de dépasser la puissance critique !';
        else if (fs && fs.phys && fs.phys.critical) banner = `Coup de chaleur : ${U.fmt(fs.phys.Tc, 1)} °C au noyau, ta commande centrale lâche — ralentis et bois`;
        else if (fs && fs.phys && fs.phys.hypo) banner = `Hypoglycémie (${U.fmt(fs.phys.glu, 1)} mmol/L) : mange des glucides rapides (gel, touche M)`;
        else if (fs && fs.bonk) banner = 'Fringale ! Mange vite (touche M)';
        else if (fs && fs.dehydrated && fs.fluid > 0) banner = 'Déshydratation : bois (touche B)';
        else if (fs && fs.phys && fs.phys.hypoNa) banner = `Natrémie basse (${U.fmt(fs.phys.Na, 0)} mmol/L) : trop d'eau pure, préfère une boisson salée`;
        else if (cond.wet > 0.4) banner = `Route mouillée : adhérence réduite, risque de chute ×${U.fmt(cond.crashK, 1)}`;
        else if (fs && fs.phys && fs.phys.hot) { banner = `Chaleur : ${U.fmt(fs.phys.Tc, 1)} °C au noyau, capacité −${U.fmt((1 - fs.phys.mT * fs.phys.VA_T) * 100, 0)} % — bois (touche B)`; info = true; }
        else if (fs && fs.phys && fs.phys.gutFull) { banner = `Estomac chargé : ${U.fmt(fs.phys.gut, 0)} g de glucides en attente, risque d'inconfort digestif`; info = true; }
        else if (!(fs && fs.phys) && cond.heatK < 0.97) { banner = `Chaleur : −${U.fmt((1 - cond.heatK) * 100, 0)} % de capacité, pense à boire (touche B)`; info = true; }
        else if (T.inFeedZone()) { banner = 'Zone de ravitaillement : prends ta musette (touche R)'; info = true; }
        else if (st.capped && avail.capM < avail.capW) banner = T.recordText();
        else if (G.usage.use >= 0.97 && st.t > 5) { banner = `Courbe record presque atteinte (${durLabel(G.usage.d)} : ${U.fmt(G.usage.use * 100, 0)} %) : tu vas être limité`; info = true; }
        else if (cond.W > 0.5 && ctx.gusts && ctx.course.wAmp[cond.i] > 0 && cond.W > ctx.course.wMean[cond.i] * 1.25) { banner = `Rafale ! ${U.fmt(cond.W * 3.6, 0)} km/h`; info = true; }
        const b = $('#hud-banner');
        b.hidden = !banner;
        b.textContent = banner;
        b.classList.toggle('info', info);
      }
      if (force || Math.random() < 0.35) T.renderStats();
      if (PYR.gameMobile) PYR.gameMobile.update(T.snapshot());
    },

    /**
     * Instantané du HUD pour l'écran de course mobile (game-mobile.js) : valeurs calculées par renderHud, plus l'état
     * des commandes. null tant que la partie n'est pas prête.
     */
    snapshot() {
      const x = G.hudx, me = G.me, st = G.st, ctx = G.ctx;
      if (!x || !me || !st || !ctx) return null;
      const kc = st.capK > 0 ? st.capK : 1;
      const fs = me.fuel ? Fu.status(me.fuel) : null;
      return {
        v: st.v * 3.6, p: G.lastP || 0, capped: !!st.capped, grade: x.grade, t: st.t, s: st.s, rest: Math.max(0, ctx.course.length - st.s),
        rank: x.sd ? x.sd.rank : 0, total: x.sd ? x.sd.total : 0,
        shown: shownCmd(), cap: x.avail.cap, cp: ctx.cp * kc, ftp: me.athlete.ftp,
        max: Math.min(G.gaugeMax, Math.ceil(1.5 * me.athlete.ftp / 10) * 10), // la barre s'arrête à la zone Z6 : au-delà, le sprint
        wf: x.wf, wkJ: st.wbal / 1000,
        fuel: fs ? {
          energy: fs.energy, hydration: fs.hydration, gut: fs.gut, fluid: fs.fluid, gutFrac: fs.gutFrac, gutParts: fs.gutParts, split: fs.split,
          stomach: fs.stomach, intestine: fs.intestine, absorbing: fs.absorbing, ceiling: fs.ceiling, trend: fs.trend,
          bonk: fs.bonk, dehydrated: fs.dehydrated, gels: fs.gels, bars: fs.bars,
          phys: fs.phys,             // modèle physiologique (metabo.status), sinon null
          // poches et bidons : contenants (contenu, volume restant), stock par aliment, délais avant de pouvoir remanger ou reboire
          containers: fs.containers, stock: fs.stock,
          eatIn: Math.max(0, Fu.EAT_COOLDOWN - (st.t - me.fuel.lastEat)), drinkIn: Math.max(0, Fu.DRINK_COOLDOWN - (st.t - me.fuel.lastDrink)),
        } : null,
        // durée tenable : les trois limites séparément (W′, courbe de puissance record, fringale), la puissance moyenne sur 5 s et la PC
        tte: G.tteKey && G.tteVal ? { t: G.tteVal.t, by: G.tteVal.by, wprime: G.tteVal.wprime, record: G.tteVal.record, fuel: G.tteVal.fuel } : null,
        ttP: avg(G.pHist), tteHelp: TTE_HELP, tteTitle: $('#hud-tte').parentElement.title, gutTitle: $('#hud-energy-meter').title,
        draft: me.incident || st.t === 0 ? 0 : avg(G.savedHist), savedKJ: me.stats.savedJ / 1000,
        // statistiques de l'étape en cours (colonne de gauche sur grand écran)
        avgV: st.s / Math.max(1, st.t) * 3.6, avgP: me.stats.sumP / Math.max(1, st.t), np: me.stats.npCnt ? Race.np(me) : 0,
        workKJ: me.stats.sumP / 1000, shelteredPct: 100 * me.stats.shelteredS / Math.max(1, st.t),
        started: st.t > 0 || G.running, kit: Fu.normKit(store.state.game.kit), // avant le départ, le matériel se prépare
        wMinKJ: Math.max(0, me.stats.wMin) / 1000, pMaxW: me.stats.pMax, pulls: me.tac.pulls || 0,
        formLabel: me.form ? me.form.label : '', machine: G.machineFrom || '',
        mode: G.auto ? 'auto' : me.tac.mode, layers: G.auto ? { follow: false, cover: false, relay: false } : Tac.layersOf(me),
        paused: G.ready && !G.running && !G.finished, finished: G.finished, live: G.mode === 'live',
        fwd: G.fwd || [], usage: G.usage || { use: 0, d: 1 },
        slowed: G.slowed, scale: Number(store.state.game.timeScale) || 1,
        boost: me.tac.mode === 'sprint' && me.human ? me.tac.boost || 0 : 0,
        // mode relais : « Passer le relais » (possible en tête du groupe) et durée d'un relais (fixée hors partie solo)
        followW: Number(store.state.game.followW) || 0, followPpr: Number(store.state.game.followPpr) || 100,
        relayW: Number(store.state.game.relayW) || 0, relayPpr: Number(store.state.game.relayPpr) || 100,
        pulling: me.tac.mode === 'relay' && me.tac.phase === 'pull',
        // peloton en 2D : zoom peloton, en bordure (vent de côté, contre le bord, mal abrité)
        // vent au cycliste (conditions de la seconde écoulée) : vitesse du vent, direction où il souffle dans le repère du cycliste
        // (0° : vers l'avant, 180° : vers l'arrière, donc vent de face), vitesse du vent apparent, composantes de face et de côté
        wind: windOf(me), hr: fs && fs.phys ? fs.phys : null,
        northUp: !!store.state.game.northUp, peloton: !!me.lat, closeUp: !!G.closeUp, tiltable: 'DeviceOrientationEvent' in window, tilt: !!G.tiltOn, edge: !!(me.lat && me.draft && me.draft.edge),
        pullSec: G.race ? G.race.rules.pullSec : Number.isFinite(Number(store.state.game.pullSec)) ? Number(store.state.game.pullSec) : 30, pullFixed: G.mode !== 'solo',
      };
    },

    /** Fenêtre d'explication d'une jauge de la page de préparation : tenable, W′, glycogène ou hydratation. */
    explain(kind) {
      const p = (t) => h('p', null, t);
      const now = (t) => h('p', { class: 'hint' }, t);
      const E = {
        tte: ['Durée tenable', [p(TTE_HELP), p('Trois limites jouent : la réserve W′ (au-dessus de la puissance critique), la courbe de puissance record (PPR : ce que tu sais produire pour chaque durée) et le glycogène (fringale). La plus proche fixe la durée affichée ; « roue libre » veut dire qu\'aucune ne te limite à cette puissance.'), now(`Maintenant : ${$('#hud-tte').textContent} ${$('#hud-tte-sub').textContent}`.trim())]],
        wbal: ['W′ (réserve d\'effort)', [p('W′ est ta réserve d\'énergie au-dessus de ta puissance critique : elle se vide quand tu roules plus fort que ta puissance critique et se reconstitue quand tu roules en dessous.'), p('À 0 %, tu es à bout : tu ne peux plus tenir qu\'une puissance proche de ta puissance critique.'), now(`Maintenant : ${$('#hud-wbal').textContent}`)]],
        energy: ['Énergie (glycogène)', [p('Le glycogène est le carburant stocké dans tes muscles et ton foie. Il baisse avec l\'effort, plus vite quand tu roules fort ; à zéro, c\'est la fringale et ta puissance s\'effondre.'), p('Avec le modèle physiologique, la barre montre le glycogène des muscles (vert) puis celui du foie (jaune pâle). La partie hachurée représente les glucides avalés et pas encore absorbés : dans l\'intestin (vert), ou encore dans l\'estomac (marron) ; manger (gels, barres, boissons) recharge la barre.'), now(`Maintenant : ${$('#hud-energy').textContent}`)]],
        hydra: ['Hydratation', [p('L\'hydratation baisse avec la durée et la chaleur ; une fois déshydraté, tu perds en puissance et tu digères moins bien.'), p('Bois régulièrement dans tes bidons ou ton camelback pour la maintenir.'), now(`Maintenant : ${$('#hud-hydra').textContent}`)]],
      }[kind];
      if (E) D.modal({ title: E[0], body: E[1], actions: [{ label: 'Fermer', primary: true }] });
    },

    /** Limites « W′ > » et « PPR < » du joueur (réglage enregistré, en %) transmises à sa tactique. */
    applyFollowLimits() {
      const me = G.me, g = store.state.game;
      if (!me) return;
      // téléphone : pas de réglages W′ > ni PPR <, donc aucune limite pour « Suivre » (ni pour le relais, voir plus bas)
      const phone = !!(PYR.gameMobile && PYR.gameMobile.isPhone());
      me.tac.wLimit = phone ? 0 : U.clamp(Number(g.followW) || 0, 0, 95) / 100;
      me.tac.pprLimit = phone ? 1 : U.clamp(Number(g.followPpr) || 100, 5, 100) / 100;
      me.tac.relayW = U.clamp(Number(g.relayW) || 0, 0, 95) / 100;
      me.tac.relayPpr = U.clamp(Number(g.relayPpr) || 100, 5, 100) / 100;
      // téléphone : le joueur gère lui-même son effort et reprend le relais en le désactivant puis en le réactivant : ni durée ni limites
      me.tac.relayFree = phone;
    },

    /**
     * Règle une limite en % (clé 'followW', 'followPpr', 'relayW' ou 'relayPpr') en cours de partie : enregistrée sans relancer la
     * partie, appliquée aussitôt.
     */
    setFollowLimit(key, v) {
      const n = Number(v);
      if (!Number.isFinite(n) || !/^(follow|relay)(W|Ppr)$/.test(key)) return;
      store.set('game.' + key, /W$/.test(key) ? U.clamp(Math.round(n), 0, 95) : U.clamp(Math.round(n), 5, 100), true);
      T.applyFollowLimits();
    },

    /** « Passer le relais » : le joueur qui mène se laisse glisser tout de suite. */
    passRelay() {
      const me = G.me;
      if (!me || G.finished || G.auto) return;
      if (Tac.passRelay(me, me.st.t)) { T.renderTactics(); T.renderHud(true); }
    },

    /** Durée d'un relais en cours (s) ; 0 : sans limite de durée. */
    pullSec() {
      const v = G.race ? G.race.rules.pullSec : Number(store.state.game.pullSec);
      return Number.isFinite(v) ? v : 30;
    },

    /**
     * Durée d'un relais (s), réglable en cours de partie solo : elle s'applique tout de suite aux relais de tous les coureurs.
     * Enregistrée sans relancer la partie (le réglage du panneau, lui, la relance quand elle n'a pas commencé).
     */
    setPullSec(v) {
      const n = Number(v);
      if (G.mode !== 'solo' || v === '' || !Number.isFinite(n)) return;
      const sec = n === 0 ? 0 : Math.min(300, Math.max(5, Math.round(n))); // de 5 s à 5 min ; 0 : aucune limite de durée (« inf »)
      store.set('game.pullSec', sec, true);
      if (G.race) G.race.rules.pullSec = sec;
      if (G.rules) G.rules.pullSec = sec;
      const sel = $('#g-pull');
      if (sel) {
        if (![...sel.options].some((o) => Number(o.value) === sec)) { // durée absente de la liste du panneau : on l'y ajoute
          const o = h('option', { value: String(sec) }, sec === 0 ? 'Sans limite' : sec % 60 === 0 ? `${sec / 60} min` : `${sec} s`);
          const after = [...sel.options].find((x) => Number(x.value) > sec);
          sel.insertBefore(o, after || null);
        }
        sel.value = String(sec);
      }
      T.renderTactics();
    },

    /**
     * Poignée entre la carte et la bande latérale (grand écran) : glisser vers la gauche agrandit la bande et réduit la carte, vers la droite
     * l'inverse ; double clic : largeur par défaut ; ← → au clavier. La largeur est enregistrée (0 = par défaut) et reste dans des bornes
     * qui gardent une carte et une bande utilisables, même après un redimensionnement de la fenêtre.
     */
    bindSideGrip() {
      const grip = $('#side-grip');
      if (!grip) return;
      const root = document.documentElement;
      const MIN = 340;
      const maxW = () => Math.max(MIN, Math.min(Math.round(innerWidth * 0.7), innerWidth - 420)); // la carte garde 420 px au moins
      const clampW = (w) => Math.min(maxW(), Math.max(MIN, Math.round(w)));
      const defaultW = () => parseFloat(getComputedStyle(root).getPropertyValue('--side-w')) || 420;
      const refit = () => { try { PYR.map.map.invalidateSize({ pan: false }); } catch (e) { /* carte pas encore prête */ } };
      const apply = (w) => {
        if (w) root.style.setProperty('--game-side-w', clampW(w) + 'px'); else root.style.removeProperty('--game-side-w');
        refit();
      };
      const current = () => parseFloat(getComputedStyle($('#side')).width) || defaultW();
      const save = (w) => { store.set('ui.gameSideW', w ? clampW(w) : 0, true); };
      apply(store.state.ui.gameSideW);
      window.addEventListener('resize', () => apply(store.state.ui.gameSideW));
      let drag = null;
      grip.addEventListener('pointerdown', (e) => {
        grip.setPointerCapture(e.pointerId);
        drag = { x0: e.clientX, w0: current() };
        grip.classList.add('drag');
        document.body.classList.add('side-resizing');
        e.preventDefault();
      });
      grip.addEventListener('pointermove', (e) => {
        if (!drag) return;
        apply(drag.w0 + (drag.x0 - e.clientX)); // vers la gauche : bande plus large
      });
      const end = () => {
        if (!drag) return;
        drag = null;
        grip.classList.remove('drag');
        document.body.classList.remove('side-resizing');
        save(current());
        refit();
      };
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
      grip.addEventListener('dblclick', () => { apply(0); save(0); });
      grip.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const w = current() + (e.key === 'ArrowLeft' ? 20 : -20);
        apply(w); save(w);
      });
    },

    /** Poignée au-dessus du graphique de puissance : glisser vers le haut l'agrandit, vers le bas le réduit (hauteur enregistrée). */
    bindCurveGrip() {
      const cc = PYR.chartConfig;
      /** Poignée de bord : `size()` donne la taille actuelle, `set(px|null)` la règle ; `sign` : +1 si tirer vers le haut / la droite agrandit. */
      const bind = (grip, axis, size, set, sign) => {
        if (!grip) return;
        const pos = (e) => (axis === 'y' ? e.clientY : e.clientX);
        let drag = null;
        grip.addEventListener('pointerdown', (e) => {
          grip.setPointerCapture(e.pointerId);
          drag = { p0: pos(e), s0: size() };
          e.preventDefault();
        });
        grip.addEventListener('pointermove', (e) => {
          if (drag) set(drag.s0 + sign * (pos(e) - drag.p0));
        });
        const end = () => { drag = null; };
        grip.addEventListener('pointerup', end);
        grip.addEventListener('pointercancel', end);
        grip.addEventListener('dblclick', () => set(null)); // retour à la taille par défaut
        grip.addEventListener('keydown', (e) => {
          const k = axis === 'y' ? { ArrowUp: 20, ArrowDown: -20 } : { ArrowRight: 20, ArrowLeft: -20 };
          if (!(e.key in k)) return;
          e.preventDefault();
          set(size() + k[e.key]);
        });
      };
      const box = $('#game-curve'), prof = $('#game-chart');
      bind($('#game-curve-grip'), 'y', () => box.getBoundingClientRect().height, (px) => cc.setHeight('gamecurve', px), -1);
      // la vignette du profil : bord haut = hauteur du tracé, bord droit = largeur (grand écran)
      bind($('#game-prof-grip-h'), 'y', () => prof.getBoundingClientRect().height, (px) => cc.setHeight('game', px), -1);
      bind($('#game-prof-grip-w'), 'x', () => $('#bottom').getBoundingClientRect().width, (px) => cc.setWidth('game', px), 1);
      // la puissance selon la durée, sous le profil : même réglage de largeur
      bind($('#game-curve-grip-w'), 'x', () => $('#game-curve-wrap').getBoundingClientRect().width, (px) => cc.setWidth('gamecurve', px), 1);
    },

    /**
     * Puissance selon la durée (grand écran) : record de référence et record du jour (forme, chutes, fringale, chaleur),
     * meilleures moyennes de l'étape en cours, et ce qui reste disponible à partir de maintenant. Deux fois par seconde.
     */
    updateCurve() {
      if (!G.curve || document.body.dataset.race !== 'wide' || !G.ctx || !G.me) return;
      const now = performance.now();
      if (now - G.lastCurve < 500) return;
      G.lastCurve = now;
      const ctx = G.ctx, st = G.st, kc = st.capK > 0 ? st.capK : 1, mmpR = ctx.mmpAt || ctx.athlete.mmp;
      const xmax = st.t > 3000 ? 18000 : 3600;
      let ds = curveDurations.get(xmax);
      if (!ds) { ds = Array.from({ length: xmax }, (_, i) => i + 1); curveDurations.set(xmax, ds); }
      const baseMmp = G.inputs && G.inputs.athlete ? G.inputs.athlete.mmp : ctx.athlete.mmp;
      G.curve.setData({
        xmax, durations: ds,
        base: ds.map((d) => baseMmp(d) * ctx.marginK),
        day: ds.map((d) => mmpR(d) * ctx.marginK * kc),
        now: PYR.sim.forwardCurve(ctx, st, ds),
        stage: ds.map((d, k) => (G.best[k] > 0 ? G.best[k] : null)), // un point par seconde de durée
        cp: ctx.cp * kc, ftp: G.me.athlete.ftp,
      });
    },

    /**
     * Limites de puissance du moment : limite de la seconde qui vient (jauge), courbe disponible à partir de maintenant (5 s … 1 h) et
     * part de la courbe record utilisée. Renvoie la limite de la seconde (availablePower).
     */
    computeLimits() {
      const ctx = G.ctx, st = G.st;
      const avail = PYR.sim.availablePower(ctx, st);
      G.capNow = avail.cap;
      T.renderGauge(avail.cap);
      const kcr = st.capK > 0 ? st.capK : 1, mmpR = ctx.mmpAt || ctx.athlete.mmp;
      const fw = PYR.sim.forwardCurve(ctx, st, FWD_TAUS);
      G.fwd = FWD_TAUS.map((tau, i) => ({ tau, P: fw[i], rec: mmpR(tau) * ctx.marginK * kcr }));
      G.usage = PYR.sim.recordUsage(ctx, st);
      T.updateCurve();
      return avail;
    },

    /**
     * Rafraîchit tout ce qui dépend des limites : jauge, durée tenable, bandes de la barre, ligne Record. Appelé à chaque image,
     * à chaque modification de la consigne (curseur, boutons, tactiques) et même en pause : la durée tenable suit aussitôt la puissance
     * demandée sans attendre le prochain rafraîchissement du HUD.
     */
    renderLimits() {
      if (!G.me || !G.st || !G.ctx || !G.hudx) return;
      G.hudx.avail = T.computeLimits();
      T.renderTte();
      if (PYR.gameMobile) PYR.gameMobile.update(T.snapshot());
    },

    /** Puissance (W) à laquelle on calcule la durée tenable : la consigne du moment, au plus la limite de la seconde qui vient. */
    tenablePower() {
      const cap = G.capNow === undefined ? Infinity : G.capNow;
      return Math.max(0, Math.min(shownCmd(), cap));
    },

    /**
     * Message de fatigue : la puissance limite et le point de la courbe de puissance record qui la fixe (durée de la fenêtre et
     * record de cette durée, interpolé linéairement entre les deux points voisins de la courbe).
     */
    recordText() {
      const b = PYR.sim.recordBinding(G.ctx, G.st);
      const ahead = G.fwd ? G.fwd.filter((f) => f.tau === 15 || f.tau === 60 || f.tau === 300).map((f) => `${durLabel(f.tau)} : ${U.fmt(f.P, 0)} W`).join(', ') : '';
      return `Fatigue : puissance limitée à ${U.fmt(b.P, 0)} W par ta courbe record (${durLabel(b.d)}${b.sustain ? ', anticipé' : ''} : record ${U.fmt(b.rec, 0)} W)${ahead ? ` · tenable ${ahead}` : ''}`;
    },

    /** Watts économisés grâce à l'aspiration (dans les roues, ou un peu devant un groupe). */
    renderDraft() {
      const me = G.me, d = me.draft;
      const el = $('#hud-draft'), sub = $('#hud-draft-sub');
      const saved = avg(G.savedHist);
      el.parentElement.classList.toggle('shelter', d.role === 'follow');
      el.parentElement.classList.toggle('edge', !!d.edge && !me.incident);
      if (me.incident || me.st.t === 0) { el.textContent = '–'; sub.textContent = ''; return; }
      if (d.edge) {
        // peloton en 2D, vent de côté : contre le bord sous le vent, sans place dans l'éventail
        el.textContent = `−${U.fmt(saved, 0)} W`;
        sub.textContent = `en bordure · abri ${U.fmt(d.R * 100, 0)} %`;
      } else if (d.role === 'follow') {
        const wheel = d.wheel && G.race ? (G.race.riders.find((r) => r.id === d.wheel) || {}).name : null;
        el.textContent = `−${U.fmt(saved, 0)} W`;
        sub.textContent = `abri ${U.fmt(d.R * 100, 0)} %${wheel ? ' · ' + wheel : ''}`;
      } else if (d.R > 0.004) {
        el.textContent = `−${U.fmt(saved, 0)} W`;
        sub.textContent = 'en tête du groupe';
      } else {
        el.textContent = '0 W';
        sub.textContent = 'seul au vent';
      }
    },

    /**
     * Durée pendant laquelle la puissance actuelle (moyenne sur 5 s) peut encore être tenue : le plus petit du temps avant
     * épuisement de W′ (au-dessus de la PC seulement) et du temps avant d'être limité par la courbe de puissance record
     * (les fenêtres glissantes que le jeu impose, calculées comme la courbe de la page Performance), et de la fringale.
     * Le détail est dans l'info-bulle.
     */
    renderTte() {
      const el = $('#hud-tte'), sub = $('#hud-tte-sub'), card = el.parentElement;
      const P = T.tenablePower();
      if (G.me.incident || P < 30) { el.textContent = '–'; sub.textContent = G.me.st.t ? 'roue libre' : ''; card.title = TTE_HELP; G.tteKey = null; G.tteNow = null; return; }
      // le calcul parcourt les fenêtres de la courbe record : une fois par seconde de jeu et par puissance arrondie suffit
      const key = G.me.st.t + '|' + Math.round(P);
      if (key !== G.tteKey) { G.tteKey = key; G.tteVal = Race.timeToExhaustion(G.me, P); }
      const tte = G.tteVal;
      G.tteNow = tte.t;
      const clock = (t) => (Number.isFinite(t) ? U.fmtClock(t) : '> 6 h');
      el.textContent = clock(tte.t);
      sub.textContent = `à ${U.fmt(P, 0)} W${tte.by ? ' · ' + { wprime: 'W′', record: 'courbe record', fuel: 'fringale' }[tte.by] : ''}`;
      card.title = `${TTE_HELP}\nÀ ${U.fmt(P, 0)} W : épuisement de W′ dans ${clock(tte.wprime)}, limité par la courbe de puissance record dans ${clock(tte.record)}`
        + (G.me.fuel ? `, fringale dans ${clock(tte.fuel)}` : '') + '.';
    },

    /** Prochain point de passage : sprint, sommet classé (pied puis sommet) ou arrivée. */
    renderNext() {
      const el = $('#hud-next');
      const cps = G.cps, me = G.me;
      const on = !!(cps && Cl.active(cps) && me && !G.finished);
      el.hidden = !on;
      if (!on) return;
      const cp = cps[Math.min(me.nextCp, cps.length - 1)];
      const dist = (d) => (d >= 1000 ? `${U.fmt(d / 1000, 1)} km` : `${Math.max(0, Math.round(d / 10) * 10)} m`);
      let text;
      if (cp.type === 'finish') text = `Arrivée dans ${dist(cp.s - me.st.s)}`;
      else if (cp.type === 'sprint') text = `${Cl.shortLabel(cp, cps)} : ligne dans ${dist(cp.s - me.st.s)}`;
      else if (me.st.s < cp.start) text = `${Cl.shortLabel(cp, cps)} : pied dans ${dist(cp.start - me.st.s)}, ${Cl.climbText(cp)}`;
      else text = `${Cl.shortLabel(cp, cps)} : sommet dans ${dist(cp.s - me.st.s)}`;
      D.clear(el);
      el.append(CV.cpBadge(cp), h('span', { class: 'txt' }, text));
      el.title = text;
    },

    /**
     * Annonce les passages, dans l'ordre : les tiens (rang, points, écart) et le premier passage d'un
     * adversaire à chaque point. En direct, on attend 2 s que les passages des autres arrivent.
     */
    watchCrossings() {
      const cps = G.cps;
      if (!cps || !Cl.active(cps) || !G.me || !G.st) return;
      const t = G.st.t, lag = G.mode === 'live' ? 2 : 0;
      const riders = classRiders(t);
      const fresh = [];
      for (const r of riders) {
        (r.splits || []).forEach((x, k) => {
          if (x === null || x === undefined || !cps[k] || cps[k].type === 'finish' || x > t - lag) return;
          const key = k + ':' + r.id;
          if (G.seen.has(key)) return;
          G.seen.add(key);
          fresh.push({ r, k, t: x });
        });
      }
      if (!fresh.length) return;
      fresh.sort((a, b) => a.t - b.t);
      const sd = Cl.standings(cps, riders);
      const name = (id) => (riders.find((x) => x.id === id) || {}).name || '?';
      for (const f of fresh) {
        const cp = cps[f.k], label = Cl.shortLabel(cp, cps);
        const ps = sd.passages[f.k], p = ps.find((x) => x.id === f.r.id);
        if (!p) continue;
        if (f.r.me) {
          if (riders.length > 1) {
            const behind = p.gap < 0.05 ? 'juste derrière' : p.gap < 60 ? `${U.fmt(p.gap, 1)} s après` : `${U.fmtDuration(p.gap)} après`;
            D.toast(p.rank === 1
              ? `${label} : tu passes en tête${p.pts ? ` (+${CV.pts(p.pts)})` : ''} !`
              : `${label} : tu passes ${CV.ordinal(p.rank)}${p.pts ? ` (+${CV.pts(p.pts)})` : ', sans point'}, ${behind} ${name(ps[0].id)}.`);
          } else {
            // seul contre la montre : pointage par rapport au plan optimal
            const pl = plan();
            if (pl && store.state.game.ghost && G.mode === 'solo') {
              const d = f.t - planTimeAt(pl, cp.s);
              D.toast(`${label} (km ${U.fmt(cp.s / 1000, 1)}) : ${Math.abs(d) < 0.5 ? 'dans les temps du' : d < 0 ? `${U.fmtDuration(-d)} d'avance sur le` : `${U.fmtDuration(d)} de retard sur le`} plan optimal.`);
            }
          }
        } else if (p.rank === 1) {
          D.toast(`${name(f.r.id)} passe en tête ${cp.type === 'sprint' ? 'au sprint' : 'au sommet'} (${label}${p.pts ? `, +${CV.pts(p.pts)}` : ''}).`);
        }
      }
    },

    renderFuel() {
      const f = G.me && G.me.fuel;
      $('#hud-fuel').hidden = !f;
      $('#hud-fuel-actions').hidden = !f;
      if (!f) return;
      const s = Fu.status(f);
      const e = $('#hud-energy-fill'), w = $('#hud-hydra-fill');
      // modèle physiologique : glycogène des muscles (vert) puis du foie (jaune pâle) ; sinon un seul stock, de la couleur de son niveau.
      // Hachuré à la suite : glucides dans l'intestin (vert), puis dans l'estomac (marron)
      const sp = s.split, pc = (x) => (U.clamp(x, 0, 1) * 100).toFixed(1) + '%';
      e.style.width = pc(sp ? sp.muscle : s.energy);
      e.style.background = sp ? 'var(--gly-muscle)' : levelColor(s.energy / 0.6);
      $('#hud-energy-liver').style.width = pc(sp ? sp.liver : 0);
      $('#hud-energy-gut').style.width = pc(s.gutParts.intestine);
      $('#hud-energy-stomach').style.width = pc(s.gutParts.stomach);
      const legend = sp ? 'Vert : glycogène des muscles. Jaune pâle : glycogène du foie. ' : 'Plein : glycogène. ';
      $('#hud-energy-meter').title = s.gut > 1
        ? `${legend}Hachuré : glucides avalés pas encore absorbés — intestin (vert) ${U.fmt(s.intestine, 0)} g, estomac (marron) ${U.fmt(s.stomach, 0)} g. Absorption : ${U.fmt(s.absorbing, 0)} g/h (plafond ${U.fmt(s.ceiling, 0)} g/h).`
        : `${legend}Hachuré : glucides avalés, dans l'intestin (vert) et dans l'estomac (marron).`;
      w.style.width = (s.hydration * 100).toFixed(1) + '%';
      w.style.background = levelColor((s.hydration - 0.3) / 0.5);
      // tendance : manger la ralentit (ou l'inverse si l'on roule doucement), sans forcément la faire remonter
      const trend = Math.abs(s.trend) < 0.005 ? '' : ` · ${s.trend > 0 ? '+' : '−'}${U.fmt(Math.abs(s.trend) * 100, 0)} %/h`;
      $('#hud-energy').textContent = `${U.fmt(s.energy * 100, 0)} %${s.gut > 1 ? ` · +${U.fmt(s.gut, 0)} g à absorber` : ''}${trend}${s.bonk ? ' — fringale !' : s.energy < 0.35 ? ' — mange !' : ''}`;
      $('#hud-hydra').textContent = `${U.fmt(s.hydration * 100, 0)} %${s.dehydrated ? ' — bois !' : ''}`;
      $('#hud-eat-count').textContent = `${s.gels} gel${s.gels > 1 ? 's' : ''} · ${s.bars} barre${s.bars > 1 ? 's' : ''}`;
      $('#hud-drink-count').textContent = `${U.fmt(s.fluid, 2)} L`;
      $('#hud-eat').disabled = s.gels + s.bars === 0;
      $('#hud-drink').disabled = s.fluid < 0.001;
    },

    /** Puce météo du HUD : température, vent sur le cap (à hauteur de cycliste), pluie. */
    renderWeather(cond) {
      const el = $('#hud-wx');
      const on = !!(G.ctx && G.ctx.course.weather);
      el.hidden = !on;
      // animation de la pluie à la position du cycliste (celle du HUD) ; le vent est montré par les manches à air de la carte
      PYR.weatherFx.setEnabled(store.state.game.fx !== false);
      PYR.weatherFx.update(on && cond.wx ? { ws: cond.wx.ws, wd: cond.wx.wd, gust: cond.wx.gust, rain: cond.wx.rain } : null);
      if (!on) return;
      const wind = Math.abs(cond.wh) < 0.3 ? 'vent nul' : `${U.fmt(Math.abs(cond.wh) * 3.6, 0)} km/h de ${cond.wh > 0 ? 'face' : 'dos'}`;
      el.textContent = `${U.fmt(cond.T, 0)} °C · ${wind}${cond.rain >= 0.2 ? ` · pluie ${U.fmt(cond.rain, 1)} mm/h` : ''}`;
      el.classList.toggle('rain', cond.wet > 0.4);
    },

    /** Zone de ravitaillement où se trouve le cycliste et dont il n'a pas encore pris la musette (indice), sinon -1. */
    openFeedZone() {
      const me = G.me;
      if (!me || !me.fuel || !G.feed.length) return -1;
      const k = PYR.feed.zoneAt(G.feed, me.st.s);
      return k >= 0 && !me.feedTaken.has(k) ? k : -1;
    },

    inFeedZone() { return T.openFeedZone() >= 0; },

    /** Bouton « Ravito » : visible sur les étapes longues, actif dans une zone. */
    renderFeed() {
      const btn = $('#hud-feed'), me = G.me;
      const on = !!(me && me.fuel && G.feed.length && !G.finished);
      btn.hidden = !on;
      if (!on) return;
      const dist = (d) => (d >= 1000 ? `${U.fmt(d / 1000, 1)} km` : `${Math.max(0, Math.round(d / 10) * 10)} m`);
      const here = PYR.feed.zoneAt(G.feed, me.st.s), open = T.openFeedZone() >= 0;
      let sub;
      if (here >= 0) sub = open ? `zone ! encore ${dist(G.feed[here].end - me.st.s)}` : 'musette prise';
      else {
        const k = PYR.feed.nextZone(G.feed, me.st.s);
        sub = k >= 0 ? `dans ${dist(G.feed[k].s - me.st.s)}` : ''; // juste la distance jusqu'au prochain ravito, sans compter les zones
      }
      $('#hud-feed-sub').textContent = sub;
      btn.disabled = !open;
      btn.classList.toggle('active', open);
    },

    /** Prend la musette de la zone de ravitaillement où l'on se trouve. */
    feed() {
      const me = G.me;
      if (!me || !me.fuel || G.finished || !G.feed.length) return;
      if (!Race.takeFeed(G.race, me)) {
        const here = PYR.feed.zoneAt(G.feed, me.st.s);
        D.toast(here >= 0 ? 'Tu as déjà pris la musette de cette zone.' : 'Pas de zone de ravitaillement ici : surveille le prochain repère « R ».', 'error');
      }
      T.renderFeed();
      T.renderFuel();
    },

    /**
     * Manger : un aliment précis choisi dans les poches (« gel », « gelglu », « gelplus », « bar », « barmini »), ou, sans argument
     * (touche M), le plus adapté.
     */
    eat(kind) {
      const me = G.me;
      if (!me || !me.fuel || G.finished) return;
      const id = typeof kind === 'string' ? kind : undefined;
      const what = Fu.eat(me.fuel, me.st.t, id, !!id);
      const food = Fu.FOOD_IDS.map((k) => ({ k, f: Fu.FOODS[k] })).find((x) => x.f.label === what);
      if (what) {
        const f = food.f, src = f.fructose > 0.2 ? 'double source' : f.fructose > 0 ? 'surtout du glucose' : 'glucose seul';
        D.toast(`Tu ${f.cat === 'gel' ? 'avales' : 'manges'} ${f.name.toLowerCase()} : ${f.carbs} g de glucides (${src}), la moitié a quitté l'estomac en ≈ ${U.fmt(Fu.halfMinutes(food.k), 0)} min.`);
      } else if (id && !(me.fuel.items[id] > 0)) D.toast('Plus de ' + Fu.FOODS[id].name.toLowerCase() + ' dans les poches !', 'error');
      else D.toast(Fu.count(me.fuel, 'gel') + Fu.count(me.fuel, 'bar') ? 'Laisse passer un peu de temps avant de remanger.' : 'Plus rien à manger dans les poches !', 'error');
      T.renderFuel();
    },

    /** Boire : une gorgée au contenant n° idx (bidon ou camelback), ou, sans argument (touche B), au premier qui n'est pas vide. */
    drink(idx) {
      const me = G.me;
      if (!me || !me.fuel || G.finished) return;
      const i = typeof idx === 'number' ? idx : undefined;
      const used = i !== undefined ? i : me.fuel.bottles.findIndex((b) => b > 0.001); // le contenant auquel on boit
      const q = Fu.drink(me.fuel, me.st.t, i);
      if (q > 0) {
        const c = me.fuel.cont[used];
        D.toast(`Tu bois ${U.fmt(q * 1000, 0)} mL${c ? ' (' + Fu.MIXES[c.mix].label.toLowerCase() + ')' : ''}.`);
      } else if (i !== undefined ? !(me.fuel.bottles[i] > 0.001) : Fu.status(me.fuel).fluid < 0.001) D.toast(i !== undefined ? 'Ce contenant est vide !' : 'Bidons vides !', 'error');
      T.renderFuel();
    },

    /**
     * Équipement emporté (contenants et contenus, gels et barres) : enregistré avec le projet ; avant le départ, la partie en cours
     * est rééquipée tout de suite (pas de relance). Prend un morceau de matériel { slots, items } et le fusionne avec l'existant.
     */
    setKit(part) {
      const cur = Fu.normKit(store.state.game.kit);
      const next = Fu.normKit({ slots: part.slots || cur.slots, items: Object.assign({}, cur.items, part.items) });
      store.set('game.kit', next, true);
      const me = G.me;
      if (me && me.fuel && G.st && G.st.t === 0 && !G.running && !G.finished) {
        me.fuel = Fu.create(me.setup.mRider, Object.assign({}, next, { gutTraining: Number(store.state.rider.gut) || 0 }));
        T.renderFuel();
        T.renderHud(true);
      }
      return next;
    },

    /* ---------- tactiques ---------- */
    buildTactics() {
      const box = $('#hud-tactic-buttons');
      D.clear(box);
      for (const m of Tac.MODES) {
        if (m.id === 'attack') continue; // attaque et sprint ne font qu'un : un seul bouton (touches 6 et 7)
        const title = m.id === 'sprint' ? 'Sprint (touches 6 et 7) : appuie plusieurs fois pour monter et maintenir l\'effort' : `${m.label} (touche ${m.key})`;
        const b = h('button', { type: 'button', 'data-mode': m.id, 'aria-pressed': 'false', title },
          h('kbd', null, m.id === 'sprint' ? '6·7' : m.key.toUpperCase()), m.id === 'sprint' ? 'Sprint' : m.label, h('small'));
        b.addEventListener('click', () => { T.setTactic(m.id); b.blur(); });
        box.appendChild(b);
      }
    },

    renderTactics() {
      const me = G.me;
      const chip = $('#hud-tactic');
      if (!me) { chip.textContent = ''; return; }
      const tac = me.tac;
      const lay = Tac.layersOf(me); // suivre, suivre les attaques et relais peuvent être actifs ensemble
      for (const b of $('#hud-tactic-buttons').children) {
        const id = b.dataset.mode;
        b.setAttribute('aria-pressed', String(!G.auto && (id in lay ? lay[id] : tac.mode === id)));
        const P = Tac.steadyPower(me, id);
        const small = b.querySelector('small');
        small.textContent = P !== null ? `${U.fmt(P, 0)} W` : id === 'relay' && lay.relay ? `${U.fmt(tac.pull, 0)} W` : '';
      }
      chip.textContent = G.auto ? 'Pilote automatique' : tac.mode === 'manual' ? `Manuel · ${U.fmt(G.cmd, 0)} W` : Tac.describe(me, G.rules || {});
    },

    /**
     * Appui sur « Sprint » (attaque et sprint réunis) : chaque appui monte la consigne de 20 % de l'écart entre le haut de la zone
     * PMA et le record de puissance le plus élevé ; sans nouvel appui elle retombe (decayBoost). Le simulateur plafonne ensuite
     * la consigne (W′, courbe de puissance record) : on ne peut pas dépasser ce que le cycliste peut produire.
     */
    sprintTap() {
      const me = G.me;
      if (!me || G.finished || !G.running) return;
      if (G.auto) { G.auto = false; $('#g-auto').checked = false; }
      const line = Tac.lineFor(me, G.cps, 'sprint') ?? Tac.lineFor(me, G.cps, 'attack');
      Tac.sprintTap(me, me.st.t, line);
      if (!G.sprintHinted) {
        G.sprintHinted = true;
        D.toast('Appuie plusieurs fois sur Sprint pour monter et maintenir l\'effort : chaque appui ajoute 20 % de l\'écart entre le haut de la zone PMA et ton record de puissance.', undefined, 6000);
      }
      T.renderTactics();
      if (G.ctx) T.renderGauge(PYR.sim.availablePower(G.ctx, G.st).cap);
      T.renderLimits();
    },

    /** Fait retomber l'effort « sprint » avec le temps réel écoulé (hors pause de réaction), puis rend la main à la tactique d'avant. */
    decayBoost(now) {
      const me = G.me;
      if (!me || me.tac.mode !== 'sprint' || !me.human) { G.boostT = now; return; }
      const dt = Math.min(0.5, Math.max(0, (now - (G.boostT || now)) / 1000));
      G.boostT = now;
      if (Tac.decayBoost(me, dt)) {
        if (me.tac.mode === 'manual') G.cmd = Math.round(me.tac.cmd || G.cmd);
        T.renderTactics();
      }
    },

    /** Choisit une tactique ; la même touche une seconde fois rend la main (mode manuel). */
    setTactic(mode) {
      const me = G.me;
      if (!me || G.finished) return;
      if (mode === 'attack' || mode === 'sprint') { T.sprintTap(); return; }
      if (G.auto) { G.auto = false; $('#g-auto').checked = false; }
      const t = me.st.t;
      if (mode === 'follow' || mode === 'relay' || mode === 'cover') {
        // « Suivre », « Suivre les attaques » et « Relais » s'activent chacun à leur tour, indépendamment ; la dernière coupée rend la main
        const wasOn = Tac.layersOf(me);
        if (!(wasOn.follow || wasOn.cover || wasOn.relay)) me.tac.cmd = me.tac.mode === 'manual' ? G.cmd : Math.round(me.lastPcmd || G.cmd);
        const on = Tac.toggleLayer(me, mode, t);
        if (!(on.follow || on.cover || on.relay)) {
          G.cmd = Math.round(me.lastPcmd || G.cmd);
          me.tac.cmd = G.cmd;
        } else if (mode === 'relay' && on.relay) G.cmd = Math.round(me.tac.pull);
      } else if (me.tac.mode === mode && mode !== 'attack' && mode !== 'sprint') {
        G.cmd = Math.round(me.lastPcmd || G.cmd);
        Tac.setMode(me, 'manual', t);
        me.tac.cmd = G.cmd;
      } else {
        // sprint à l'approche d'une ligne, attaque dans une côte classée : l'effort vise la ligne
        Tac.setMode(me, mode, t, Tac.lineFor(me, G.cps, mode));
        if (mode === 'relay') G.cmd = Math.round(me.tac.pull);
      }
      T.renderTactics();
      if (G.ctx) T.renderGauge(PYR.sim.availablePower(G.ctx, G.st).cap);
      T.renderLimits();
    },

    renderZones() {
      const box = $('#gauge-zones');
      D.clear(box);
      const ftp = G.me ? G.me.athlete.ftp : 250;
      let lo = 0;
      PYR.physio.ZONES.forEach((z, i) => {
        const hi = Math.min(G.gaugeMax, z.max === Infinity ? G.gaugeMax : z.max * ftp);
        if (hi <= lo) return;
        box.appendChild(h('div', { style: { left: (lo / G.gaugeMax * 100) + '%', width: ((hi - lo) / G.gaugeMax * 100) + '%', background: PYR.map.HEAT[i] }, title: `${z.id} ${z.label}` }));
        lo = hi;
      });
    },

    renderGauge(cap) {
      const pct = (v) => (U.clamp(v, 0, G.gaugeMax) / G.gaugeMax * 100) + '%';
      const me = G.me;
      const shown = shownCmd();
      $('#gauge-fill').style.width = pct(G.lastP || 0);
      $('#gauge-handle').style.left = pct(shown);
      $('#gauge-max').style.left = pct(cap);
      $('#gauge-cp').style.left = pct(G.ctx ? G.ctx.cp * (G.st.capK > 0 ? G.st.capK : 1) : 0);
      $('#gauge-value').textContent = String(Math.round(shown));
      $('#gauge').setAttribute('aria-valuenow', String(Math.round(shown)));
      $('#gauge').setAttribute('aria-valuemax', String(G.gaugeMax));
    },

    /** Réglage à la jauge : reprise en main (ou puissance de relais si on est en mode relais). */
    setCmd(v) {
      if (G.auto) { G.auto = false; $('#g-auto').checked = false; }
      G.cmd = U.clamp(Math.round(v), 0, G.gaugeMax);
      const me = G.me;
      if (me) {
        if (me.tac.mode === 'relay') me.tac.pull = G.cmd;
        else if (me.tac.mode === 'cover' && !Tac.layersOf(me).follow) me.tac.cmd = G.cmd; // « Suivre les attaques » seul : la jauge règle la puissance de base
        else if (me.tac.mode !== 'manual') Tac.setMode(me, 'manual', me.st.t);
        me.tac.cmd = G.cmd;
      }
      T.renderTactics();
      if (G.ctx) T.renderGauge(PYR.sim.availablePower(G.ctx, G.st).cap);
      T.renderLimits(); // durée tenable et bandes suivent aussitôt la consigne, même en pause
    },

    bindGauge() {
      const track = $('#gauge-track'), gauge = $('#gauge');
      let drag = false;
      const pick = (e) => {
        const r = track.getBoundingClientRect();
        T.setCmd((e.clientX - r.left) / r.width * G.gaugeMax);
      };
      gauge.addEventListener('pointerdown', (e) => { drag = true; gauge.setPointerCapture(e.pointerId); pick(e); e.preventDefault(); });
      gauge.addEventListener('pointermove', (e) => { if (drag) pick(e); });
      gauge.addEventListener('pointerup', () => { drag = false; });
      gauge.addEventListener('pointercancel', () => { drag = false; });
      gauge.addEventListener('wheel', (e) => { e.preventDefault(); T.setCmd(G.cmd + (e.deltaY < 0 ? 10 : -10)); }, { passive: false });
    },

    onKey(e) {
      if (store.state.ui.tab !== 'game' || document.querySelector('dialog[open]')) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if ((tag === 'input' || tag === 'select' || tag === 'textarea') && e.target.id !== 'gauge') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      let handled = true;
      const mode = Tac.MODES.find((m) => m.key === e.key.toLowerCase());
      if (e.key === 'ArrowUp') T.setCmd(G.cmd + (e.shiftKey ? 50 : 10));
      else if (e.key === 'ArrowDown') T.setCmd(G.cmd - (e.shiftKey ? 50 : 10));
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && G.me && G.me.lat) T.nudge(e.key === 'ArrowLeft' ? -1 : 1);
      else if ((e.key === 'z' || e.key === 'Z') && G.ready) T.toggleCloseUp();
      else if (e.key === 'PageUp') T.setCmd(G.cmd + 50);
      else if (e.key === 'PageDown') T.setCmd(G.cmd - 50);
      else if (e.key === '0') T.setCmd(0);
      else if (mode) T.setTactic(mode.id);
      else if (e.key === 'm' || e.key === 'M') T.eat();
      else if (e.key === 'b' || e.key === 'B') T.drink();
      else if (e.key === 'r' || e.key === 'R') T.feed();
      else if (e.key === ' ') {
        if (G.mode === 'live') return;
        if (!G.running && !G.finished && G.st && G.st.t === 0) T.start(); else T.togglePause();
      } else if ((e.key === 'a' || e.key === 'A') && G.mode !== 'live') {
        const c = $('#g-auto'); c.checked = !c.checked; G.auto = c.checked; if (G.auto) G.usedAuto = true;
      } else handled = false;
      if (handled) e.preventDefault();
    },

    renderStats() {
      const el = $('#game-stats');
      D.clear(el);
      const me = G.me, st = G.st;
      if (!me || !st || !G.ctx) return;
      const S = me.stats;
      const L = G.ctx.course.length;
      const t = Math.max(1, st.t);
      el.appendChild(D.stat('Distance', U.fmt(Math.min(st.s, L) / 1000, 2), 'km'));
      el.appendChild(D.stat('Reste', U.fmt(Math.max(0, L - st.s) / 1000, 2), 'km'));
      el.appendChild(D.stat('Vitesse moy.', U.fmt(st.s / t * 3.6, 1), 'km/h'));
      el.appendChild(D.stat('Puissance moy.', U.fmt(S.sumP / t, 0), 'W'));
      el.appendChild(D.stat('NP', S.npCnt ? U.fmt(Race.np(me), 0) : '–', 'W'));
      el.appendChild(D.stat('Travail', U.fmt(S.sumP / 1000, 0), 'kJ'));
      el.appendChild(D.stat('W′ mini', U.fmt(Math.max(0, S.wMin) / 1000, 1), 'kJ'));
      el.appendChild(D.stat('P max', U.fmt(S.pMax, 0), 'W'));
      if (G.race && (G.race.riders.length > 1 || G.race.external.length)) {
        el.appendChild(D.stat('Économisé (aspiration)', U.fmt(S.savedJ / 1000, 0), 'kJ'));
        el.appendChild(D.stat('Temps abrité', U.fmt(100 * S.shelteredS / t, 0), '%'));
        if (me.tac.pulls) el.appendChild(D.stat('Relais pris', String(me.tac.pulls)));
      }
      if (me.form) el.appendChild(D.stat('Forme du jour', me.form.label));
      if (G.machineFrom) el.appendChild(D.stat('Machine', G.machineFrom));
      const ph = me.fuel && me.fuel.phy ? Fu.status(me.fuel).phys : null;
      if (ph) {
        el.appendChild(D.stat('PC effective', `${U.fmt(ph.CP2e, 0)} W · ${U.fmt(ph.cpK * 100, 0)} %`));
        el.appendChild(D.stat('Glycogène I · II · foie', `${U.fmt(ph.gI * 100, 0)} · ${U.fmt(ph.gII * 100, 0)} · ${U.fmt(ph.gL * 100, 0)}`, '%'));
        el.appendChild(D.stat('Glycémie', U.fmt(ph.glu, 1), 'mmol/L'));
        el.appendChild(D.stat('Température centrale', U.fmt(ph.Tc, 1), '°C'));
        el.appendChild(D.stat('FC estimée', U.fmt(ph.HR, 0), 'bpm'));
        el.appendChild(D.stat('Lipides · glucides', `${U.fmt(ph.fat, 0)} · ${U.fmt(ph.cho, 0)}`, 'g/h'));
        el.appendChild(D.stat('Sueur', `${U.fmt(ph.SR, 1)} L/h · Na⁺ ${U.fmt(ph.Na, 0)}`));
      }
      T.renderClassif();
    },

    /** Classements annexes : leaders, passages (et classements complets après l'arrivée). */
    /** Onglets disponibles : l'étape (toujours), puis points, montagne et passages quand des sprints ou des côtes sont en jeu. */
    classTabs() {
      const tabs = [{ id: 'stage', label: 'Étape' }];
      const cps = G.cps;
      if (cps && Cl.active(cps)) {
        tabs.push({ id: 'points', label: 'Points', jersey: 'green' });
        if (cps.some((c) => c.type === 'kom')) tabs.push({ id: 'kom', label: 'Montagne', jersey: 'kom' });
        tabs.push({ id: 'passages', label: 'Passages' });
      }
      return tabs;
    },

    showClassTab(id) {
      const tabs = T.classTabs();
      G.ctab = tabs.some((x) => x.id === id) ? id : 'stage';
      for (const b of document.querySelectorAll('#classif-tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === G.ctab));
      for (const p of document.querySelectorAll('#game-classif .classif-pane')) p.hidden = p.dataset.pane !== G.ctab;
      if (G.ctab === 'stage') { G.boardDirty = true; T.renderBoard(); }
    },

    /** Classements points, montagne et passages (recalculés à chaque passage) et leurs onglets. */
    renderClassif() {
      const cps = G.cps;
      const riders = G.me && cps && Cl.active(cps) ? classRiders(G.finished ? Infinity : G.st.t) : [];
      const active = riders.length > 1;
      const tabs = T.classTabs().filter((x) => x.id === 'stage' || active);
      const bar = $('#classif-tabs');
      D.clear(bar);
      for (const tb of tabs) {
        bar.appendChild(h('button', { type: 'button', role: 'tab', 'data-tab': tb.id, 'aria-selected': String(tb.id === G.ctab), onclick: () => T.showClassTab(tb.id) },
          tb.jersey ? CV.jersey(tb.jersey) : null, tb.label));
      }
      bar.hidden = tabs.length < 2;
      if (!tabs.some((x) => x.id === G.ctab)) G.ctab = 'stage';
      const leads = $('#classif-leads'), pPoints = $('#pane-points'), pKom = $('#pane-kom'), pPass = $('#pane-passages');
      D.clear(leads); D.clear(pPoints); D.clear(pKom); D.clear(pPass);
      if (active) {
        const sd = Cl.standings(cps, riders);
        const names = new Map(riders.map((r) => [r.id, r.name]));
        const name = (id) => names.get(id) || '?';
        leads.appendChild(CV.leaders(cps, sd, name, 'me'));
        pPoints.appendChild(CV.table(sd.points, name, 'me', 'green'));
        if (cps.some((c) => c.type === 'kom')) pKom.appendChild(CV.table(sd.kom, name, 'me', 'kom'));
        pPass.appendChild(CV.passages(cps, sd, name, 'me'));
      }
      for (const p of document.querySelectorAll('#game-classif .classif-pane')) p.hidden = p.dataset.pane !== G.ctab;
    },

    /** Résultat de la partie (sert au classement du défi ou de la course en direct). */
    entry() {
      const me = G.me, st = G.st, time = st.tFinish;
      const name = String(store.state.rider.name || '').trim() || 'Cycliste anonyme';
      return {
        id: U.uid() + U.uid(), name, time, date: new Date().toISOString(), auto: G.usedAuto,
        avgP: Math.round(me.stats.sumP / time), np: Math.round(Race.np(me)),
        rider: { weight: G.inputs.setup.mRider, ftp: Math.round(G.inputs.athlete.ftp) },
        rules: { events: G.rules.events, form: G.rules.form, fuel: G.rules.fuel, physio: G.rules.physio },
        s: me.trace.s.slice(), P: me.trace.P.slice(),
        sp: Cl.packSplits(me.splits), // temps de passage aux sprints, aux sommets et à l'arrivée
      };
    },

    finish() {
      if (G.finished) return;
      G.running = false; G.finished = true;
      T.stopLiveTimer();
      const me = G.me, st = G.st;
      T.render(1);
      T.renderHud(true);
      mobile('finished');
      $('#g-start').disabled = G.mode === 'live';
      $('#g-start').textContent = 'Rejouer';
      $('#g-pause').disabled = true;
      $('#g-quit').disabled = false;
      const time = st.tFinish;
      const entry = T.entry();
      const S = me.stats;
      const box = $('#game-result');
      D.clear(box);
      box.appendChild(h('h4', null, `Arrivée en ${U.fmtDuration(time)} !`));
      box.appendChild(h('div', null, `Vitesse moyenne ${U.fmt(G.ctx.course.length / time * 3.6, 1)} km/h · puissance moyenne ${U.fmt(S.sumP / time, 0)} W · W′ mini ${U.fmt(Math.max(0, S.wMin) / 1000, 1)} kJ.`));
      const extra = [];
      if (S.savedJ > 1000) extra.push(`aspiration : ${U.fmt(S.savedJ / 1000, 0)} kJ économisés, abrité ${U.fmt(100 * S.shelteredS / time, 0)} % du temps`);
      if (me.tac.pulls) extra.push(`${me.tac.pulls} relais pris`);
      if (me.fuel) extra.push(`${U.fmt(me.fuel.eatenG, 0)} g de glucides mangés, ${U.fmt(me.fuel.drunkL, 2)} L bus`);
      const inc = S.incidents.filter((ev) => ev.type === 'puncture' || ev.type === 'crash');
      if (inc.length) extra.push(inc.map((ev) => (ev.type === 'crash' ? 'chute' : 'crevaison') + ` au km ${U.fmt(me.trace.s[Math.min(ev.t, me.trace.s.length - 1)] / 1000, 1)}`).join(', '));
      if (extra.length) box.appendChild(h('div', { class: 'hint', style: { marginTop: '4px' } }, extra.join(' · ') + '.'));
      if (G.mode === 'challenge') {
        let ch;
        G.recording = true; // le résultat reste affiché : pas de nouvelle partie à l'ajout au classement
        try { ch = PYR.challenges.addEntry(entry); } finally { G.recording = false; }
        if (ch) {
          const rank = ch.entries.slice().sort((a, b) => a.time - b.time).findIndex((e) => e.id === entry.id) + 1;
          box.appendChild(h('div', { style: { marginTop: '6px' } }, `Classement du défi « ${ch.title} » : ${rank}ᵉ sur ${ch.entries.length}.`));
          const cl = PYR.challenges.classif(ch);
          if (cl) {
            const place = (list, label) => { const x = list.find((y) => y.id === entry.id); return x ? `${label} : ${CV.ordinal(x.rank)} (${CV.pts(x.pts)})` : `${label} : aucun point`; };
            box.appendChild(h('div', null, [place(cl.sd.points, 'points'), cl.cps.some((c) => c.type === 'kom') ? place(cl.sd.kom, 'montagne') : null].filter(Boolean).join(' · ') + '.'));
          }
          box.appendChild(h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => document.querySelector('#challenge-box .btn.primary') && document.querySelector('#challenge-box .btn.primary').click() }, 'Partager le défi')));
        }
      } else if (G.mode === 'live') {
        PYR.live.finish(entry);
        box.appendChild(h('div', { style: { marginTop: '6px' } }, 'Ton temps est envoyé aux autres joueurs. Le classement s\'affiche dans « Course en direct ».'));
      } else {
        if (G.race.riders.length > 1) T.renderRaceResults(box);
        const p = plan();
        if (p && G.race.riders.length === 1) {
          const d = time - p.tFinish;
          box.appendChild(h('div', { style: { marginTop: '6px' } },
            d > 0.5 ? `Le plan optimal a été plus rapide de ${U.fmtDuration(d)}. Essaie de pousser davantage dans les montées et le vent de face, et de récupérer dans les descentes !`
              : `Bravo : tu as égalé ou battu le plan optimal (${U.fmtDelta(d)}) !`));
        }
      }
      box.hidden = false;
      setStatus('Arrivée !');
      const b = $('#hud-banner');
      b.hidden = false; b.textContent = `Arrivée : ${U.fmtClock(time)}`; b.classList.add('info');
      T.renderStats();
    },

    /** Classement final contre les coureurs virtuels (on les laisse finir leur course), avec points et montagne. */
    renderRaceResults(box) {
      Race.runToEnd(G.race);
      const res = Race.results(G.race);
      const rank = res.indexOf(G.me) + 1;
      const best = res[0].finished ? res[0].time : NaN;
      box.appendChild(h('div', { style: { marginTop: '6px', fontWeight: '650' } }, rank === 1 ? `Victoire ! Tu gagnes devant ${res.length - 1} coureur${res.length > 2 ? 's' : ''} virtuel${res.length > 2 ? 's' : ''}.` : `Tu termines ${rank}ᵉ sur ${res.length}.`));
      const cps = G.cps, act = Cl.active(cps), hasKom = act && cps.some((c) => c.type === 'kom');
      const sd = act ? Race.standings(G.race) : null;
      const worn = sd ? CV.holders(sd, true) : new Map();
      const ptsOf = (list, id) => { const x = list.find((y) => y.id === id); return x ? String(x.pts) : '–'; };
      const tb = h('tbody');
      res.forEach((r, i) => {
        tb.appendChild(h('tr', { class: r === G.me ? 'me' : '' },
          h('td', null, String(i + 1)),
          h('td', null, (r === G.me && PYR.avatar.span(20, r.color)) || h('span', { class: 'dot', style: { background: r.color } }), r === G.me ? `${r.name} (toi)` : r.name, ' ', ...CV.jerseysOf(worn, r.id)),
          h('td', null, r.finished ? U.fmtClock(r.time) : 'abandon'),
          h('td', null, r.finished && i > 0 ? U.fmtDelta(r.time - best) : '–'),
          act ? h('td', null, ptsOf(sd.points, r.id)) : null,
          hasKom ? h('td', null, ptsOf(sd.kom, r.id)) : null));
      });
      const head = ['#', 'Cycliste', 'Temps', 'Écart'].concat(act ? ['Points'] : [], hasKom ? ['Montagne'] : []);
      box.appendChild(CV.scrollable(h('div', { class: 'table-wrap' }, h('table', { class: 'simple num leaderboard race-results' },
        h('thead', null, h('tr', null, ...head.map((x) => h('th', null, x)))), tb)), res.length));
      T.render(1);
    },

    get state() { return G; },
  };

  /** Couleur d'une jauge selon son niveau (1 = plein). */
  function levelColor(f) {
    return f > 0.5 ? 'var(--good)' : f > 0.2 ? 'var(--warning)' : f > 0.05 ? 'var(--serious)' : 'var(--critical)';
  }

  /** Demande le nom du cycliste (affiché au classement du défi et chez les adversaires). */
  function askName(then) {
    const inp = h('input', { type: 'text', maxlength: '30', autocomplete: 'nickname', placeholder: 'Ton nom ou pseudo', 'aria-label': 'Ton nom' });
    const m = D.modal({
      title: 'Qui roule ?',
      body: [h('p', { class: 'hint' }, 'Ton nom apparaîtra dans le classement du défi et sur la carte de tes adversaires.'), h('div', { class: 'field' }, inp)],
      actions: [
        { label: 'Annuler' },
        {
          label: 'C\'est parti', primary: true, onClick: () => {
            const name = inp.value.trim();
            if (!name) { inp.focus(); return false; }
            store.set('rider.name', name);
            PYR.app.refreshBindings();
            setTimeout(then, 0);
            return true;
          },
        },
      ],
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.el.querySelector('.modal-actions .btn.primary').click(); } });
    inp.focus();
  }

  function setStatus(text, error) {
    const el = $('#game-status');
    el.textContent = text || '';
    el.classList.toggle('error', !!error);
  }

  PYR.tabGame = T;
})(globalThis.PYR = globalThis.PYR || {});
