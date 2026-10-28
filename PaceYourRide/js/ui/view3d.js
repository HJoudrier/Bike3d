/* author : Hugo Joudrier-Faure */
/* PaceYourRide — vue 3D du mode jeu : le paysage cartoon de Bike3D (dossier parent du dépôt) à la place du fond de carte.
 *
 * La simulation reste ici (physiologie, météo, aspiration, coureurs virtuels, joueurs en direct) ; Bike3D ne fait que montrer la
 * course. Il est ouvert dans un cadre par-dessus la carte de la page de jeu (bouton « 3D »), ou dans une fenêtre à part
 * (bouton ⧉ : second écran, devant le home-trainer). Les deux échangent des messages (postMessage, champ pyr3d: 1) :
 *   - Bike3D annonce qu'il est prêt (hello) : on lui envoie le parcours (course) ; il construit le paysage autour ;
 *   - à chaque image du mode jeu, la position de chacun (frame) : joueur, coureurs virtuels, fantômes, autres joueurs en
 *     direct (avatars, home-trainers, cyclistes sur la vraie route), avec la météo lue à la position et à l'heure du joueur ;
 *   - Bike3D renvoie les touches pressées quand il a le focus (key), elles pilotent le jeu comme d'habitude.
 * La graine du paysage vient de l'empreinte du parcours : tous les joueurs d'une course en direct ont le même monde.
 * Le détail du protocole est en tête de js/bridge.js côté Bike3D. Adresse de la vue : ../index.html, ou celle enregistrée par
 * localStorage.setItem('pyr.view3d', 'https://…/index.html'). */
(function (PYR) {
  'use strict';

  // le module se charge aussi dans Node (tests des messages) : le DOM et l'état ne servent qu'à l'affichage
  const U = PYR.util, D = PYR.dom || {};
  const h = (...a) => D.h(...a), $ = (q) => D.$(q);
  const st = () => PYR.store.state;
  const V = 1;
  const DEFAULT_URL = '../index.html';
  const ME_COLOR = '#eb6834';

  let frameEl = null;      // cadre par-dessus la carte
  let win = null;          // fenêtre à part
  let stage = false;       // la page de jeu est affichée
  let courseRef = null, courseMsg = null; // dernier parcours envoyé (et l'objet de simulation dont il vient)
  let last = null;         // dernière image, renvoyée à une vue qui vient de s'ouvrir
  let sound = false;
  const btn = {};
  const status = new Map(); // fenêtre → dernier état annoncé ('building', 'ready', 'error')

  const on = () => !!st().ui.view3d;

  function baseUrl() {
    let u = null;
    try { u = localStorage.getItem('pyr.view3d'); } catch (e) { /* stockage indisponible */ }
    return u && /^(https?:|\.{0,2}\/|[\w.-]+\.html)/.test(u) ? u : DEFAULT_URL;
  }
  function urlOf(hud) { const b = baseUrl(); return b + (b.includes('?') ? '&' : '?') + 'pyr' + (hud ? '&hud=1' : ''); }

  /** Fenêtres de vue ouvertes (cadre, fenêtre à part). */
  function targets() {
    const out = [];
    if (frameEl && frameEl.contentWindow) out.push(frameEl.contentWindow);
    if (win && !win.closed) out.push(win); else win = null;
    return out;
  }

  function post(w, msg) {
    try { w.postMessage(Object.assign({ pyr3d: V }, msg), '*'); } catch (e) { /* fenêtre fermée */ }
  }
  function broadcast(msg) { for (const w of targets()) post(w, msg); }

  /* ---------- parcours ---------- */

  /** Empreinte d'un parcours de simulation (points, longueur) : la vue ne se reconstruit que si elle change. */
  function courseKey(c) {
    let x = 2166136261;
    const mix = (v) => { x ^= Math.round(v * 1e5) | 0; x = Math.imul(x, 16777619) >>> 0; };
    mix(c.n); mix(c.length);
    const k = Math.max(1, Math.floor(c.lat.length / 400));
    for (let i = 0; i < c.lat.length; i += k) { mix(c.lat[i]); mix(c.lng[i]); mix(c.ele[i] / 100); }
    return (x >>> 0).toString(36) + '-' + Math.round(c.length);
  }

  /**
   * Message « course » pour Bike3D : points du parcours (degrés arrondis au millionième, altitude au décimètre), points de passage,
   * zones de ravitaillement, joueur. La graine du paysage est tirée de l'empreinte : même parcours, même monde pour tous.
   */
  function courseMessage(course, cps, feed, me) {
    const n = Math.min(course.lat.length, course.lng.length, course.ele.length);
    const lat = new Array(n), lng = new Array(n), ele = new Array(n);
    for (let i = 0; i < n; i++) {
      lat[i] = Math.round(course.lat[i] * 1e6) / 1e6;
      lng[i] = Math.round(course.lng[i] * 1e6) / 1e6;
      ele[i] = Math.round(course.ele[i] * 10) / 10;
    }
    const key = courseKey(course);
    let seed = 0;
    for (let i = 0; i < key.length; i++) seed = (Math.imul(seed, 31) + key.charCodeAt(i)) >>> 0;
    return {
      type: 'course', key, seed: seed % 1000000, name: (PYR.store && st().route && st().route.name) || 'Parcours PaceYourRide',
      lat, lng, ele, length: course.length,
      cps: (cps || []).map((c) => ({ type: c.type, s: c.s, start: c.start, cat: c.cat })),
      feed: (feed || []).map((z) => ({ s: z.s, end: z.end })),
      me: { name: me.name, color: me.color || ME_COLOR }, cp: me.cp,
    };
  }

  /* ---------- météo à la position et à l'heure du joueur ---------- */

  /**
   * Conditions envoyées à la vue : {hour (heure locale, avec une météo datée), T, rain (mm/h), ws (m/s à 10 m), wd (° d'où vient le
   * vent), gust, rh, wet}. Sans météo, le vent saisi à la main (portions) et la température de l'onglet Performance.
   */
  function envAt(course, s, t) {
    const w = course.weather;
    if (w && PYR.weather) {
      const o = PYR.weather.at(w, s, (Number(w.start) || 0) + t);
      const env = { T: o.T, rain: o.rain, ws: o.ws, wd: o.wd, gust: o.gust, rh: o.rh, wet: o.wet };
      if (Number.isFinite(w.start) && Number.isFinite(w.off)) env.hour = ((((w.start + w.off + t) / 3600) % 24) + 24) % 24;
      return env;
    }
    const env = { T: course.temperature };
    const i = U.clamp(Math.floor(s / course.step), 0, course.n - 1);
    if (course.hasWind && course.wMean && course.wMean[i] > 0) { env.ws = course.wMean[i] / ((PYR.weather && PYR.weather.WIND_K) || 0.7); env.wd = course.windDir[i]; }
    return env;
  }

  /* ---------- images ---------- */

  /**
   * Image de la course pour la vue. o : {course, cps, feed, t (temps de course), k (secondes de course par seconde réelle), run,
   * me : {id, name, color, kind, s, y, v, P, w, dr, st, fin, cp}, others : [{id, name, color, kind, s, y, v, P, st, fin}]}.
   * Fonction pure (testée) : rien n'est envoyé.
   */
  function frameMessage(o) {
    const r2 = (x) => Math.round(x * 100) / 100;
    const rider = (x) => {
      const e = { id: String(x.id), name: String(x.name || 'Cycliste'), color: x.color || '#6f6d66', kind: x.kind || 'bot', s: r2(Number(x.s) || 0), v: r2(Number(x.v) || 0) };
      if (Number.isFinite(x.y)) e.y = r2(x.y);
      if (Number.isFinite(x.P)) e.P = Math.round(x.P);
      if (Number.isFinite(x.w)) e.w = r2(x.w);
      if (Number.isFinite(x.dr)) e.dr = r2(x.dr);
      if (x.st) e.st = true;
      if (x.fin) e.fin = true;
      return e;
    };
    const riders = [rider(o.me)].concat((o.others || []).map(rider));
    return { type: 'frame', t: r2(o.t || 0), k: o.k || 1, run: !!o.run, me: String(o.me.id), riders, env: o.course ? envAt(o.course, o.me.s || 0, o.t || 0) : {} };
  }

  /**
   * Appelée à chaque image du mode jeu (tab-game.js, render). Envoie le parcours s'il a changé, puis l'image.
   */
  function publish(o) {
    if (!targets().length) { last = o; return; }
    if (o.course !== courseRef) {
      courseRef = o.course;
      const msg = courseMessage(o.course, o.cps, o.feed, o.me);
      if (!courseMsg || msg.key !== courseMsg.key) { courseMsg = msg; broadcast(courseMsg); }
    }
    last = o;
    broadcast(frameMessage(o));
  }

  /* ---------- messages de la vue ---------- */

  function onMessage(e) {
    const m = e.data;
    if (!m || m.pyr3d !== V || typeof m.type !== 'string') return;
    const src = targets().find((w) => w === e.source);
    if (!src) return;
    if (m.type === 'hello') {
      // une vue qui s'ouvre (ou se recharge) : le parcours, puis la dernière image
      if (last && last.course) {
        courseRef = last.course;
        courseMsg = courseMessage(last.course, last.cps, last.feed, last.me);
        post(src, courseMsg);
        post(src, frameMessage(last));
      }
      post(src, { type: 'cmd', cmd: 'sound', on: src === win ? true : sound });
    } else if (m.type === 'status') {
      status.set(src, String(m.state || ''));
      if (m.state === 'error' && m.text) D.toast(`Vue 3D : ${String(m.text).slice(0, 160)}`, 'error');
      if (src !== win && typeof m.sound === 'boolean') sound = m.sound;
      render();
    } else if (m.type === 'key') {
      // touches pressées dans la vue : elles pilotent le jeu comme si la page avait le focus
      if (!PYR.tabGame || typeof m.key !== 'string' || m.key.length > 20) return;
      PYR.tabGame.onKey({
        key: m.key, code: String(m.code || ''), shiftKey: !!m.shift, ctrlKey: !!m.ctrl, altKey: !!m.alt, metaKey: !!m.meta,
        target: document.body, preventDefault() {},
      });
    }
  }

  /* ---------- cadre, fenêtre, boutons ---------- */

  function ensureFrame() {
    if (frameEl) return frameEl;
    frameEl = h('iframe', {
      class: 'v3d-frame', title: 'Vue 3D de la course', src: urlOf(false), hidden: true,
      allow: 'autoplay; fullscreen; xr-spatial-tracking',
    });
    $('.map-wrap').append(frameEl);
    return frameEl;
  }

  function render() {
    const visible = on() && stage;
    if (visible) ensureFrame();
    if (frameEl) frameEl.hidden = !visible;
    const wrap = $('.map-wrap');
    if (wrap) wrap.classList.toggle('v3d-on', visible);
    const any = visible || !!(win && !win.closed);
    if (btn.toggle) {
      btn.toggle.setAttribute('aria-pressed', String(on()));
      const st = frameEl ? status.get(frameEl.contentWindow) : null;
      btn.toggle.classList.toggle('v3d-busy', visible && st !== 'ready');
      btn.toggle.title = on() ? (st === 'ready' ? 'Revenir à la carte' : 'Vue 3D en préparation… (clique pour revenir à la carte)') : 'Vue 3D : le paysage de Bike3D à la place de la carte';
      btn.cam.hidden = !any;
      btn.sound.hidden = !visible;
      btn.sound.textContent = sound ? '🔊' : '🔇';
      btn.sound.setAttribute('aria-pressed', String(sound));
      btn.win.setAttribute('aria-pressed', String(!!(win && !win.closed)));
    }
  }

  function toggle(v) {
    PYR.store.set('ui.view3d', v === undefined ? !on() : !!v);
    render();
    if (on() && stage && last) publish(last);
  }

  /** Fenêtre à part (second écran) : la vue avec son propre compteur, le son allumé. */
  function openWindow() {
    if (win && !win.closed) { win.focus(); return; }
    win = window.open(urlOf(true), 'pyr3d', 'popup=yes,width=1280,height=720');
    if (!win) { D.toast('La fenêtre de la vue 3D a été bloquée par le navigateur : autorise les fenêtres surgissantes pour cette page.', 'error'); return; }
    const watch = setInterval(() => { if (!win || win.closed) { clearInterval(watch); win = null; render(); } }, 1000);
    render();
  }

  function command(cmd, extra) { broadcast(Object.assign({ type: 'cmd', cmd }, extra || {})); }

  /** Boutons de la colonne de la page de jeu (game-mobile.js les place) : 3D, caméra, son, fenêtre à part. */
  function buttons() {
    if (btn.toggle) return [btn.toggle, btn.cam, btn.sound, btn.win];
    btn.toggle = h('button', { class: 'rm-sq rm-card v3d-btn', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Vue 3D', onclick: () => toggle() }, '3D');
    // sur téléphone, toucher la vue change de caméra : le bouton n'est que sur grand écran
    btn.cam = h('button', { class: 'rm-sq rm-card wide-only', type: 'button', hidden: true, 'aria-label': 'Changer de caméra (vue 3D)', title: 'Changer de caméra : poursuite, large, TV, vue cycliste, drone (touche C ou clic dans la vue)', onclick: () => command('camera') }, '🎥');
    btn.sound = h('button', {
      class: 'rm-sq rm-card', type: 'button', hidden: true, 'aria-pressed': 'false', 'aria-label': 'Son de la vue 3D', title: 'Son de la vue 3D (vent, roues, public…)',
      onclick: () => { sound = !sound; if (frameEl) post(frameEl.contentWindow, { type: 'cmd', cmd: 'sound', on: sound }); render(); },
    }, '🔇');
    btn.win = h('button', {
      class: 'rm-sq rm-card wide-only', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Vue 3D dans une autre fenêtre',
      title: 'Vue 3D dans une autre fenêtre (second écran, téléviseur devant le home-trainer)', onclick: openWindow,
    }, '⧉');
    render();
    return [btn.toggle, btn.cam, btn.sound, btn.win];
  }

  /** La page de jeu s'affiche (vrai) ou se ferme : le cadre ne se montre que sur elle. */
  function setStage(v) {
    stage = !!v;
    render();
    if (stage && on() && last) publish(last);
  }

  if (typeof window !== 'undefined') window.addEventListener('message', onMessage);

  PYR.view3d = { V, courseKey, courseMessage, frameMessage, envAt, publish, buttons, setStage, toggle, openWindow, command, get on() { return on(); } };
})(globalThis.PYR = globalThis.PYR || {});
