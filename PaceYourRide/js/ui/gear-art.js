/* author : Hugo Joudrier-Faure */
/* PaceYourRide — illustration du magasin : superposition de photos détourées (PNG transparents de img/bike/),
 * toutes au même cadre (PHOTO) : les roues (la paire, recalée sur les axes du cadre), puis le cadre. Si le
 * cadre ou les roues montés n'ont pas d'image (voir PHOTOS), la silhouette par défaut (default.png) la remplace.
 * Ce module choisit les images selon l'équipement monté et les affiche ; une nouvelle combinaison ne remplace
 * l'ancienne qu'une fois toutes ses images chargées.
 * Pour ajouter une photo : un PNG au cadre PHOTO dans img/bike/ et une entrée dans PHOTOS.
 * gear3d donne le même équipement au vélo en 3D de Bike3D (vitrine du magasin, vue 3D du mode jeu). */
(function (PYR) {
  'use strict';

  const Cat = PYR.catalog;

  const BASE = 'img/bike/', DEFAULT = 'default';
  /** Cadre commun des photos (px). */
  const PHOTO = { w: 1304, h: 800 };
  /** Photos par article du magasin (nom du fichier PNG, sans extension) : cadres, et paires de roues. */
  const PHOTOS = {
    frame: { endurance: 'frame-endurance', climber: 'frame-climber', aero: 'frame-aero', tt: 'frame-tt' },
    wheels: { c45: 'wheels-c45', disc: 'wheels-disc' },
  };
  const FRAME_FALLBACK = { road: 'alu', climber: 'climber', aero: 'aero', tt: 'tt', gravel: 'gravel' };
  const WHEEL_FALLBACK = { box: 'box', low: 'alu', mid: 'c45', deep: 'c65', deep80: 'c80', disc: 'disc', spoked: 'gravel' };

  /** Article du magasin monté pour un réglage (l'article choisi s'il correspond, sinon le modèle de référence). */
  function pick(cat, id, field, value, fallback) {
    const it = Cat.get(cat, id);
    if (it && it.bike && it.bike[field] === value) return it.id;
    return fallback[value] || Cat.ITEMS[cat][0].id;
  }
  const frameKey = (b, picks) => pick('frame', picks.frame, 'frame', b.frame, FRAME_FALLBACK);
  const wheelKey = (b, picks) => pick('wheels', picks.wheels, 'wheels', b.wheels, WHEEL_FALLBACK);

  /** Images à superposer, du fond vers l'avant. opts : {bike, picks} (picks : articles du magasin, pour les
   * variantes qui partagent un même réglage). */
  function layers(opts) {
    const b = opts.bike || {}, picks = opts.picks || {};
    const frame = PHOTOS.frame[frameKey(b, picks)], wheels = PHOTOS.wheels[wheelKey(b, picks)];
    return frame && wheels ? [wheels, frame] : [DEFAULT];
  }

  const src = (id) => `${BASE}${id}.png`;

  /** Cadre de l'illustration, aux proportions des photos. */
  function shell() {
    const frame = document.createElement('div');
    frame.className = 'art-frame';
    frame.setAttribute('role', 'img');
    frame.style.aspectRatio = `${PHOTO.w} / ${PHOTO.h}`;
    frame.style.setProperty('--ratio', String(Math.round((PHOTO.w / PHOTO.h) * 1000) / 1000));
    const stack = document.createElement('div');
    stack.className = 'art-stack';
    stack.style.top = '0';
    stack.style.height = '100%';
    frame.appendChild(stack);
    return frame;
  }

  function image(id) {
    const img = document.createElement('img');
    img.src = src(id);
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.dataset.layer = id;
    // image introuvable : la silhouette par défaut la remplace
    if (id !== DEFAULT) img.addEventListener('error', () => { img.src = src(DEFAULT); }, { once: true });
    return img;
  }
  const loaded = (img) => (img.complete && img.naturalWidth ? Promise.resolve()
    : img.decode ? img.decode().catch(() => {}) : new Promise((ok) => { img.onload = img.onerror = ok; }));

  /** Affiche (ou met à jour) l'illustration dans `box`. opts : {bike, picks, label}. */
  function update(box, opts) {
    const list = layers(opts);
    let frame = box.querySelector('.art-frame');
    if (!frame) box.replaceChildren(frame = shell());
    frame.setAttribute('aria-label', opts.label || '');
    const stack = frame.firstChild, token = (stack.dataset.token = String(Number(stack.dataset.token || 0) + 1));
    const old = new Map([...stack.children].map((el) => [el.dataset.layer, el]));
    const next = list.map((id) => old.get(id) || image(id));
    Promise.all(next.filter((el) => !el.isConnected).map(loaded)).then(() => {
      if (stack.dataset.token === token) stack.replaceChildren(...next);
    });
  }

  /** Charge à l'avance les images de plusieurs combinaisons (articles survolables) : l'aperçu est alors immédiat. */
  const warm = new Map();
  function preload(optsList) {
    const todo = new Set();
    for (const o of optsList) for (const id of layers(o)) if (!warm.has(id)) todo.add(id);
    if (!todo.size) return;
    const run = () => { for (const id of todo) { const img = new Image(); img.src = src(id); warm.set(id, img); } };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 }); else setTimeout(run, 200);
  }

  /**
   * Équipement du vélo et du cycliste en 3D (le cycliste de Bike3D : vitrine du magasin et vue 3D du mode jeu) : le modèle de cadre et de
   * roues du magasin (ceux choisis, sinon ceux de référence pour le réglage), les pneus, la position, le casque, la tenue, les lunettes,
   * les chaussettes et les chaussures. opts : {rider, bike, picks}.
   */
  function gear3d(opts) {
    const r = opts.rider || {}, b = opts.bike || {}, picks = opts.picks || {}, Ph = PYR.physics;
    // valeurs absentes : celles que prend la simulation (buildSetup)
    const id = (list, v, k) => Ph.byId(Ph[list], v, k).id;
    return {
      frame: b.frame === 'mtb' || b.frame === 'city' ? b.frame : frameKey(b, picks), wheels: wheelKey(b, picks), tire: id('TIRES', b.tire, 2),
      position: id('POSITIONS', r.position, 3), helmet: id('HELMETS', r.helmet, 0), clothing: id('CLOTHING', r.clothing, 1),
      glasses: id('GLASSES', r.glasses, 1), socks: id('SOCKS', r.socks, 1), shoes: id('SHOES', b.shoes, 2),
    };
  }

  PYR.gearArt = { update, preload, layers, gear3d, PHOTOS, PHOTO, BASE };
})(globalThis.PYR = globalThis.PYR || {});
