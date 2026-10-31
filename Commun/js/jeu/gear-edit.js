/* author : Hugo Joudrier-Faure */
/* PaceYourRide — matériel du cycliste réglé sur la vue 3D (page de choix de VirtualRide3D) : le vélo et le cycliste de la vitrine de Bike3D
 * (VirtualRide3D/univers/showroom.html, celle du magasin de PaceYourRide), équipés comme ils rouleront dans la course. On choisit la partie à
 * modifier (cadre, roues, pneus, position, casque, lunettes, tenue, chaussettes, chaussures), puis les flèches gauche et droite
 * font défiler les articles ; la vitrine montre chaque choix aussitôt. Les articles sont ceux du catalogue du magasin (catalog.js) :
 * ils règlent les mêmes réglages du vélo et du cycliste que le magasin de PaceYourRide, donc la masse, l'aérodynamisme et le roulement
 * de la course. Les modifications sont gardées dans `game.gearEdit` (catégorie → article) et reprises après chaque nouveau choix de
 * parcours ou d'athlète ; choisir un autre vélo ou une autre tenue de la bibliothèque les remet à zéro. */
(function (PYR) {
  'use strict';

  const store = PYR.store, Cat = PYR.catalog, Ph = PYR.physics, D = PYR.dom;
  const { h, $, $$ } = D;

  const SHOWROOM = (PYR.root || '') + 'VirtualRide3D/univers/showroom.html';
  const ME_COLOR = '#eb6834';   // couleur du joueur (maillot et casque), comme dans la course
  const BIKE_CATS = ['frame', 'wheels', 'tires', 'drivetrain'];

  /** Les parties qu'on peut modifier. `cats` : catégories du catalogue qui y mènent (la tenue : maillot et cuissard, puis combinaisons). */
  const PARTS = [
    { id: 'frame', label: 'Cadre', cats: ['frame'] },
    { id: 'wheels', label: 'Roues', cats: ['wheels'] },
    { id: 'tires', label: 'Pneus', cats: ['tires'] },
    { id: 'position', label: 'Position', position: true },
    { id: 'helmet', label: 'Casque', cats: ['helmet'] },
    { id: 'glasses', label: 'Lunettes', cats: ['glasses'] },
    { id: 'clothing', label: 'Tenue', cats: ['kit', 'suit'] },
    { id: 'socks', label: 'Chaussettes', cats: ['socks'] },
    { id: 'shoes', label: 'Chaussures', cats: ['shoes'] },
  ];

  const S = { part: 'frame', ready: false, failed: false, sent: null, timer: null, frame: null, V: {}, init: false };

  const edits = () => {
    const G = store.state.game;
    if (!G.gearEdit || typeof G.gearEdit !== 'object' || Array.isArray(G.gearEdit)) G.gearEdit = {};
    return G.gearEdit;
  };
  const selection = () => {
    if (!store.state.shop || typeof store.state.shop !== 'object') store.state.shop = {};
    return store.state.shop;
  };

  /** Article monté dans une catégorie : celui choisi (s'il correspond encore aux réglages) ou le seul qui corresponde. */
  function mounted(cat) {
    const st = store.state, id = selection()[cat];
    if (id && Cat.isMounted(cat, id, st.rider, st.bike)) return id;
    const match = Cat.ITEMS[cat].filter((it) => Cat.isMounted(cat, it.id, st.rider, st.bike));
    return match.length === 1 || (match.length && !id) ? match[0].id : null;
  }

  /** Articles proposés pour une partie, dans l'ordre : [{cat, id, name, desc, mass}]. */
  function options(part) {
    if (part.position) return Ph.POSITIONS.map((p) => ({ cat: 'position', id: p.id, name: p.label, desc: `Aérodynamisme : ×${String(p.factor).replace('.', ',')} (plus c'est bas, plus c'est rapide).` }));
    const out = [];
    for (const cat of part.cats) for (const it of Cat.ITEMS[cat]) out.push({ cat, id: it.id, name: it.name, desc: it.desc || '', mass: it.mass });
    return out;
  }

  const isOn = (o) => (o.cat === 'position' ? store.state.rider.position === o.id : mounted(o.cat) === o.id);
  const currentIndex = (part) => options(part).findIndex(isOn);

  /** Monte un article (comme l'achat du magasin) : réglages du vélo et du cycliste, masse des roues et pneus comprise. */
  function equip(o) {
    const st = store.state;
    if (o.cat === 'position') { st.rider.position = o.id; return; }
    const p = Cat.patchFor(o.cat, o.id, st.rider, st.bike, selection());
    Object.assign(st.rider, p.rider);
    Object.assign(st.bike, p.bike);
    const sel = selection();
    sel[o.cat] = o.id;
    for (const c of Cat.CATEGORIES) if (Cat.rivals(o.cat, c.id)) delete sel[c.id];     // une combinaison remplace le maillot et le cuissard
  }

  /* ---------- vitrine 3D ---------- */

  function background() {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim();
    const hex = /^#[0-9a-f]{6}$/i.test(c) ? c : '#ebebea';
    const n = parseInt(hex.slice(1), 16);
    return { bg: hex, dark: 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128 };
  }
  const post = (msg) => { if (S.frame && S.frame.contentWindow) S.frame.contentWindow.postMessage(Object.assign({ pyr3d: 1 }, msg), '*'); };

  /** Équipement de la vitrine : celui du vélo et du cycliste de l'état (le sexe de l'athlète fixe la morphologie). */
  function gear() { return PYR.gearArt.gear3d({ rider: store.state.rider, bike: store.state.bike, picks: selection() }); }

  function send() {
    if (!S.ready) return;
    const msg = Object.assign({ type: 'gear', gear: gear(), color: ME_COLOR }, background());
    const key = JSON.stringify(msg);
    if (key === S.sent) return;
    S.sent = key;
    post(msg);
  }

  /* ---------- affichage ---------- */

  function render() {
    const V = S.V, part = PARTS.find((p) => p.id === S.part), opts = options(part), i = currentIndex(part);
    $$('[data-gear-part]', V.root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.gearPart === S.part)));
    V.partName.textContent = part.label;
    if (i >= 0) {
      const o = opts[i];
      V.name.textContent = o.name;
      V.desc.textContent = [o.desc, o.mass ? `${String(o.mass).replace('.', ',')} kg` : ''].filter(Boolean).join(' · ');
      V.count.textContent = `${i + 1} / ${opts.length}`;
    } else {
      V.name.textContent = 'Réglage de ta bibliothèque';
      V.desc.textContent = 'Ce réglage ne correspond à aucun article : une flèche te propose le premier ou le dernier.';
      V.count.textContent = `– / ${opts.length}`;
    }
  }

  /** Article suivant (dir = 1) ou précédent (dir = −1) de la partie choisie, en boucle. */
  function step(dir) {
    const part = PARTS.find((p) => p.id === S.part), opts = options(part), n = opts.length, i = currentIndex(part);
    const k = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
    equip(opts[k]);
    edits()[opts[k].cat === 'position' ? 'position' : opts[k].cat] = opts[k].id;
    // une combinaison vide la place du maillot, et inversement
    for (const c of Cat.CATEGORIES) if (opts[k].cat !== 'position' && Cat.rivals(opts[k].cat, c.id)) delete edits()[c.id];
    store.save();
    render();
    send();
    if (S.onChange) S.onChange();
  }

  function setPart(id) { S.part = id; render(); }

  /* ---------- pour la page de choix ---------- */

  /** Reprend les modifications après un nouveau choix de parcours, d'athlète, de vélo ou de tenue (l'état vient d'être recomposé). */
  function reapply() {
    const e = edits();
    for (const cat of Object.keys(e)) {
      const o = cat === 'position' ? options(PARTS[3]).find((x) => x.id === e[cat]) : (Cat.get(cat, e[cat]) ? { cat, id: e[cat] } : null);
      if (o) equip(o); else delete e[cat];
    }
  }

  /** Oublie les modifications du vélo ('bike') ou de la tenue ('outfit') : on repart de ce que la bibliothèque propose. */
  function clear(kind) {
    const e = edits();
    for (const cat of Object.keys(e)) if ((kind === 'bike') === BIKE_CATS.includes(cat)) delete e[cat];
  }

  function refresh() { if (S.init) { render(); send(); } }

  function build(root) {
    const V = S.V = { root };
    S.frame = h('iframe', { src: SHOWROOM, title: 'Ton vélo et ta tenue en 3D : glisse pour tourner autour du cycliste, molette ou pincement pour zoomer', allow: 'fullscreen' });
    V.name = h('b', { class: 'gs-g3-name' });
    V.desc = h('small', { class: 'gs-g3-desc' });
    V.count = h('span', { class: 'gs-g3-count' });
    V.partName = h('span', { class: 'gs-g3-part' });
    const arrow = (dir, label) => h('button', { class: 'gs-g3-arrow ' + (dir < 0 ? 'prev' : 'next'), type: 'button', 'aria-label': label, onclick: () => step(dir) }, dir < 0 ? '‹' : '›');
    V.msg = h('div', { class: 'gs-g3-msg', hidden: true });
    const view = h('div', { class: 'gs-g3-view' }, S.frame, arrow(-1, 'Article précédent'), arrow(1, 'Article suivant'), V.msg);
    const parts = h('div', { class: 'gs-g3-parts', role: 'group', 'aria-label': 'Partie à modifier' },
      PARTS.map((p) => h('button', { class: 'gs-g3-chip', type: 'button', dataset: { gearPart: p.id }, 'aria-pressed': String(p.id === S.part), onclick: () => setPart(p.id) }, p.label)));
    const info = h('div', { class: 'gs-g3-info', 'aria-live': 'polite' }, h('div', { class: 'gs-g3-head' }, V.partName, V.count), V.name, V.desc,
      h('p', { class: 'hint' }, 'Choisis une partie, puis fais défiler les articles avec les flèches de la vue (ou ← → au clavier). Ce matériel change la masse, l\'aérodynamisme et le roulement de ta course.'));
    root.append(view, h('div', { class: 'gs-g3-side' }, parts, info));
    root.setAttribute('tabindex', '0');
    root.setAttribute('aria-label', 'Matériel en 3D : flèches gauche et droite pour changer d\'article, haut et bas pour changer de partie');
    root.addEventListener('keydown', (e) => {
      if (e.target.closest('select, input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === 'ArrowRight' || k === 'ArrowLeft') { e.preventDefault(); step(k === 'ArrowRight' ? 1 : -1); }
      else if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        const i = PARTS.findIndex((p) => p.id === S.part);
        setPart(PARTS[(i + (k === 'ArrowDown' ? 1 : PARTS.length - 1)) % PARTS.length].id);
      }
    });
  }

  function fail(text) {
    if (S.failed) return;
    S.failed = true;
    clearTimeout(S.timer);
    S.V.msg.hidden = false;
    S.V.msg.textContent = text || 'La vue 3D ne répond pas : tu peux quand même choisir le matériel avec les flèches.';
  }

  /** Monte l'éditeur dans `root` ; onChange : appelée après chaque changement d'article. */
  function init(root, onChange) {
    if (S.init || !root) return;
    S.init = true; S.onChange = onChange;
    build(root);
    render();
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || m.pyr3d !== 1 || !S.frame || e.source !== S.frame.contentWindow) return;
      if (m.type === 'hello') { S.ready = true; clearTimeout(S.timer); S.sent = null; send(); post({ type: 'run', on: true }); }
      else if (m.type === 'status' && m.state === 'error') fail("La 3D n'est pas disponible dans ce navigateur : tu peux quand même choisir le matériel avec les flèches.");
    });
    S.timer = setTimeout(() => { if (!S.ready) fail(); }, 12000);
  }

  PYR.gearEdit = { PARTS, init, refresh, reapply, clear, step, setPart, options, currentIndex, equip, _state: S };
})(globalThis.PYR = globalThis.PYR || {});
