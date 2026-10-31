/* author : Hugo Joudrier-Faure */
/* PaceYourRide — mode jeu : comment tu participes à la course (presence.js).
 *   - Avatar : la barre de puissance et les tactiques, comme d'habitude ;
 *   - Home-trainer ou capteur de puissance (Bluetooth) : tes watts réels font avancer ton cycliste ; un home-trainer FTMS reçoit la
 *     pente, le vent de face et l'abri du peloton, pour que l'effort se sente dans les jambes ;
 *   - Sur la vraie route : la position vient du GPS du téléphone (projetée sur le tracé), la puissance du capteur s'il y en a un.
 * Le choix est dans les réglages de la partie (#g-source) ; ce module gère les capteurs et donne, à chaque seconde de course, la
 * puissance mesurée (power) ou la position (road) ; tab-game.js les passe au moteur (race.js : coureur measured ou driven). */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store, Pr = PYR.presence;
  let Sx = PYR.sensors; // sensors.js se charge plus loin dans la page : relu à l'initialisation
  const { h, $ } = D;

  const feed = Pr.createPowerFeed();
  let road = null, roadCourse = null;    // position sur la vraie route, pour le parcours de la partie en cours
  let gps = 'off', gpsErr = '', lastFix = null, lastProj = null;
  let pwr = 'off';
  let lastRender = 0;

  const kind = () => { const k = Pr.normKind(store.state.game.source); return k === 'road' ? 'avatar' : k; };   // le GPS n'est plus proposé dans les jeux (c'est le Compteur)
  const trainerSim = () => store.state.game.trainerSim !== false;
  const secure = () => typeof window === 'undefined' || window.isSecureContext !== false;

  /* ---------- capteur de puissance / home-trainer ---------- */

  function onPower(v, ts) {
    if (v && Number.isFinite(v.w)) feed.push(v.w, ts || Date.now());
    if (Date.now() - lastRender > 1000) render();
  }
  function onPowerState(s) {
    pwr = s;
    if (s === 'on' && kind() === 'trainer' && trainerSim() && Sx.trainer.state !== 'on' && Sx.power.device) Sx.trainer.attach(Sx.power.device).then(render);
    if (s !== 'on') Sx.trainer.detach();
    render();
  }
  async function connectPower(mode) {
    try {
      await (mode === 'again' ? Sx.power.reconnect(onPower, onPowerState) : Sx.power.connect(mode || 'service', onPower, onPowerState));
      if (kind() === 'trainer' && trainerSim() && Sx.power.device) await Sx.trainer.attach(Sx.power.device);
    } catch (e) {
      if (!/cancel|annul|User/i.test(e.message || '')) D.toast(e.message || String(e), 'error');
    }
    render();
  }

  /* ---------- GPS ---------- */

  function onFix(f) {
    lastFix = f;
    if (road) { const r = road.fix(f); if (r) lastProj = r; }
    if (Date.now() - lastRender > 1000) render();
  }
  function startGps() {
    gpsErr = '';
    const ok = Sx.gps.start(onFix, (e) => { gpsErr = e && e.message ? e.message : 'GPS indisponible.'; gps = 'error'; render(); });
    gps = ok ? 'on' : 'error';
    if (!ok) gpsErr = 'Géolocalisation indisponible sur cet appareil.';
    Sx.wake.request(); // l'écran reste allumé pendant la sortie
    render();
  }
  function stopGps() { Sx.gps.stop(); gps = 'off'; Sx.wake.release(); render(); }

  /* ---------- pour tab-game.js ---------- */

  /** Nouvelle partie sur ce parcours de simulation : la position GPS repart de zéro (le tracé a pu changer). */
  function prepare(course) {
    if (course !== roadCourse) { roadCourse = course; road = course ? Pr.createRoadFeed(course) : null; lastProj = null; }
    else if (road) road.reset();
    if (road && lastFix) road.fix(lastFix);
  }

  /** Puissance mesurée de la seconde (W) ; 0 si le capteur se tait. */
  function power(now) { const w = feed.at(now === undefined ? Date.now() : now); return w === null ? 0 : w; }

  /** Position sur la vraie route pour la seconde de course : {s, v, P} (P : capteur, s'il est relié). */
  function drive(now) {
    const t = now === undefined ? Date.now() : now;
    const r = road ? road.at(t) : { s: NaN, v: 0, ok: false };
    const w = feed.at(t);
    return { s: r.s, v: r.v, P: w === null ? NaN : w, ok: r.ok };
  }

  /** Charge du home-trainer d'après la seconde de course du joueur (pente devant, vent de face, abri). */
  function load(me) {
    if (kind() !== 'trainer' || !trainerSim() || Sx.trainer.state !== 'on' || !me) return;
    const L = Pr.trainerLoad(me.ctx.course, me.setup, me.st.s, me.cond, me.draft && me.draft.k > 0 ? me.draft.k : 1);
    Sx.trainer.set(L);
  }

  /** Avant le départ : ce qui manque pour participer ainsi (null si tout est prêt). */
  function missing() {
    const k = kind();
    if (k === 'trainer' && pwr !== 'on') return 'Connecte ton home-trainer ou ton capteur de puissance (Bluetooth) pour participer avec tes watts réels.';
    if (k === 'road' && gps !== 'on') return 'Active le GPS du téléphone pour participer depuis la vraie route.';
    return null;
  }

  /* ---------- réglages ---------- */

  function render() {
    lastRender = Date.now();
    const box = $('#g-source-box');
    if (!box) return;
    const k = kind();
    D.clear(box);
    const line = (txt, cls) => h('p', { class: 'hint' + (cls ? ' ' + cls : '') }, txt);
    if (k === 'avatar') {
      box.append(line('Ton cycliste numérique a ta physiologie (page Athlète) : c\'est elle qui limite l\'effort que tu lui demandes.'));
      return;
    }
    const btns = h('div', { class: 'toolbar' });
    const pw = feed.at(Date.now());
    // capteur (indispensable sur home-trainer, facultatif sur la route)
    const pState = pwr === 'on' ? `Relié : ${Sx.power.name || 'capteur'}${Sx.power.profile ? ` (${Sx.power.profile.replace(/^un /, '')})` : ''}${pw !== null ? ` · ${Math.round(pw)} W` : ''}`
      : pwr === 'connecting' || pwr === 'reconnecting' ? 'Connexion au capteur…' : pwr === 'lost' ? 'Capteur perdu.' : null;
    if (pwr !== 'on') {
      btns.append(h('button', { class: 'btn small' + (k === 'trainer' ? ' primary' : ''), type: 'button', onclick: () => connectPower('service') }, k === 'trainer' ? 'Connecter le home-trainer' : 'Capteur de puissance'));
      if (Sx.power.canReconnect) btns.append(h('button', { class: 'btn small', type: 'button', onclick: () => connectPower('again') }, `Reconnecter ${Sx.power.known && Sx.power.known.name ? Sx.power.known.name : ''}`.trim()));
      btns.append(h('button', { class: 'btn small ghost', type: 'button', onclick: () => connectPower('any') }, 'Autre appareil…'));
    } else btns.append(h('button', { class: 'btn small ghost', type: 'button', onclick: () => { Sx.power.disconnect(); Sx.trainer.detach(); pwr = 'off'; render(); } }, 'Déconnecter'));
    if (k === 'road') {
      btns.prepend(gps === 'on'
        ? h('button', { class: 'btn small ghost', type: 'button', onclick: stopGps }, 'Couper le GPS')
        : h('button', { class: 'btn small primary', type: 'button', onclick: startGps }, 'Activer le GPS'));
    }
    box.append(btns);
    if (pState) box.append(line(pState));
    if (k === 'trainer') {
      const cb = h('input', { type: 'checkbox', checked: trainerSim(), onchange: (e) => { store.set('game.trainerSim', e.target.checked); if (!e.target.checked) Sx.trainer.detach(); else if (pwr === 'on' && Sx.power.device) Sx.trainer.attach(Sx.power.device).then(render); render(); } });
      box.append(h('div', { class: 'field checks' }, h('label', null, cb, ' Le home-trainer suit la pente, le vent et l\'abri du peloton (FTMS)')));
      if (pwr === 'on' && trainerSim()) box.append(line(Sx.trainer.state === 'on' ? 'Résistance pilotée par la course.' : 'Cet appareil ne se pilote pas (capteur de puissance seul, ou home-trainer sans FTMS) : la résistance reste la sienne.'));
      box.append(line('Tes watts réels font avancer ton cycliste, sans plafond du modèle : ce sont les tiens. Le temps s\'écoule à ×1. L\'aspiration dans les roues allège la résistance.'));
    } else {
      if (gps === 'on') {
        const p = lastProj, f = lastFix;
        let txt = 'GPS : en attente d\'une position…';
        if (f) txt = `GPS : précision ${Math.round(f.acc || 0)} m` + (p ? (p.ok ? ` · au km ${U.fmt(p.s / 1000, 2)} du tracé (à ${Math.round(p.d)} m)` : ` · à ${U.fmt((p.d || 0) / 1000, 1)} km du tracé : rejoins le départ`) : '');
        box.append(line(txt));
      } else if (gps === 'error') box.append(line(`GPS : ${gpsErr}`, 'warn'));
      if (!secure()) box.append(line('Le GPS et le Bluetooth demandent une page en https (ou localhost).', 'warn'));
      box.append(line('Fais le vrai parcours : ta position vient du GPS, tes watts du capteur (sinon 0). Les autres joueurs te voient sur la carte, le profil et la vue 3D. Pas d\'aspiration (tu roules pour de vrai), pas de pause, ni d\'incident tiré au sort. Garde l\'écran allumé et l\'onglet au premier plan.'));
    }
  }

  function init() {
    Sx = PYR.sensors;
    store.on('game', (ev) => { if (!ev || /^game\.(source|trainerSim)$/.test(ev.path)) render(); });
    render();
  }

  PYR.gameSource = { init, render, prepare, power, drive, load, missing, kind, get gps() { return gps; }, get pwr() { return pwr; } };
})(globalThis.PYR = globalThis.PYR || {});
