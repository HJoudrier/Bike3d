/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page Équipements, partie Magasin (PaceYourRide/equipement.html), en deux rayons :
 *   Vélo : cadre, roues, pneus, transmission ;
 *   Cycliste : position sur le vélo (un réglage, gratuit), casque, lunettes, maillot ou combinaison, chaussettes,
 *   chaussures, épilation.
 * À gauche, l'illustration du vélo (et du cycliste dessus) reflète l'équipement monté — et l'article
 * survolé, en aperçu : en 3D, le vélo et le cycliste du jeu 3D (la vitrine de Bike3D, Jeu3D/univers/showroom.html, dans un
 * cadre : le cycliste pédale sur place sur un home-trainer, on tourne la caméra autour de lui), ou en photos ;
 * à droite, la liste des composants. Chaque achat modifie les réglages du vélo et
 * du cycliste (visibles sur la page Équipements) ; la synthèse compare l'équipement monté à
 * un équipement d'entrée de gamme. */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store, Ph = PYR.physics, Cat = PYR.catalog;
  const { h, $ } = D;

  const PAGES = [
    { id: 'bike', label: 'Vélo', art: 'Ton vélo', value: 'Valeur du vélo' },
    { id: 'rider', label: 'Cycliste', art: 'Toi sur ton vélo', value: 'Valeur de ta tenue' },
  ];

  let pending = null, dirty = true, preview = null;

  /* ---------- vélo en 3D : la vitrine de Bike3D, le même modèle que dans la vue 3D du mode jeu ---------- */

  const SHOWROOM = (PYR.root || '') + 'Jeu3D/univers/showroom.html';   // la vitrine de Bike3D (univers 3D du jeu)
  const ME_COLOR = '#eb6834'; // couleur du joueur dans le mode jeu (maillot et casque)
  /** frame : le cadre (iframe) ; ready : la vitrine a répondu ; failed : elle ne répond pas (retour aux photos) ; opts : équipement à montrer. */
  const v3 = { frame: null, ready: false, failed: false, opts: null, sent: null, timer: null };

  const view = () => (!v3.failed && !(store.state.ui && store.state.ui.shopView === 'photo') ? '3d' : 'photo');

  /** Couleur du fond (celle des encadrés de la page, claire ou sombre selon le thème). */
  function background() {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim();
    const hex = /^#[0-9a-f]{6}$/i.test(c) ? c : '#ebebea';
    const n = parseInt(hex.slice(1), 16);
    return { bg: hex, dark: 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128 };
  }

  function post3d(msg) {
    if (v3.frame && v3.frame.contentWindow) v3.frame.contentWindow.postMessage(Object.assign({ pyr3d: 1 }, msg), '*');
  }

  /** Envoie l'équipement à la vitrine (si elle est prête et qu'il a changé). */
  function send3d() {
    if (!v3.ready || !v3.opts) return;
    const msg = Object.assign({ type: 'gear', gear: PYR.gearArt.gear3d(v3.opts), color: ME_COLOR }, background());
    const key = JSON.stringify(msg);
    if (key === v3.sent) return;
    v3.sent = key;
    post3d(msg);
  }

  /** Crée le cadre de la vitrine (une fois : il garde son état quand on passe aux photos et qu'on revient). */
  function showroom() {
    if (v3.frame) return;
    v3.frame = h('iframe', { src: SHOWROOM, title: 'Ton vélo en 3D : glisse pour tourner autour du cycliste, molette ou pincement pour zoomer', allow: 'fullscreen' });
    $('#shop-art-3d').appendChild(v3.frame);
    // pas de réponse (fichiers de Bike3D absents, navigateur trop ancien) : les photos
    v3.timer = setTimeout(() => { if (!v3.ready) fail3d(); }, 10000);
  }

  function fail3d(text) {
    if (v3.failed) return;
    v3.failed = true;
    clearTimeout(v3.timer);
    D.toast(text || 'La vue 3D du vélo ne répond pas : retour aux photos.', 'error');
    T.renderArt();
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || m.pyr3d !== 1 || !v3.frame || e.source !== v3.frame.contentWindow) return;
      if (m.type === 'hello') { v3.ready = true; clearTimeout(v3.timer); v3.sent = null; send3d(); post3d({ type: 'run', on: visible() }); }
      else if (m.type === 'status' && m.state === 'error') fail3d('La 3D n\'est pas disponible dans ce navigateur : retour aux photos.');
    });
  }

  function selection() {
    if (!store.state.shop || typeof store.state.shop !== 'object') store.state.shop = {};
    return store.state.shop;
  }

  function page() {
    const p = store.state.ui && store.state.ui.shopPage;
    return PAGES.some((x) => x.id === p) ? p : 'bike';
  }

  const visible = () => document.body.dataset.tab === 'shop';

  /** Article monté dans une catégorie : celui acheté (s'il n'a pas été modifié ailleurs) ou le seul qui corresponde. */
  function mounted(cat) {
    const st = store.state, id = selection()[cat];
    if (id && Cat.isMounted(cat, id, st.rider, st.bike)) return id;
    const match = Cat.ITEMS[cat].filter((it) => Cat.isMounted(cat, it.id, st.rider, st.bike));
    return match.length === 1 || (match.length && !id) ? match[0].id : null;
  }

  /** Catégorie sans article monté parce qu'une autre occupe le même réglage (maillot / combinaison). */
  function replacedBy(cat) {
    for (const c of Cat.CATEGORIES) {
      if (Cat.rivals(cat, c.id)) {
        const id = mounted(c.id);
        if (id) return { cat: c, item: Cat.get(c.id, id) };
      }
    }
    return null;
  }

  const dcdaText = (x) => (x ? `ΔCdA ${x > 0 ? '+' : '−'}${U.fmt(Math.abs(x), 3)} m²` : 'ΔCdA 0');

  /** Caractéristiques techniques d'un article. */
  function specs(cat, it) {
    switch (cat) {
      case 'frame': return `${U.fmt(it.mass, 1)} kg sans les roues · ${dcdaText(Ph.byId(Ph.FRAMES, it.bike.frame).dcda)}`;
      case 'wheels': return `${U.fmt(it.mass, 2)} kg la paire · ${dcdaText(Ph.byId(Ph.WHEELS, it.bike.wheels).dcda)}`;
      case 'tires': {
        const t = Ph.byId(Ph.TIRES, it.bike.tire);
        // risque de crevaison par terrain (route, pavés, gravier, chemins), par rapport au pneu route standard
        const pt = Ph.PUNCT_TERRAINS.map((x, k) => `${x.label} ×${U.fmt(t.pt[k], 2)}`).join(', ');
        return `Crr ${U.fmt(t.crr, 4)} · crevaisons : ${pt}${t.sealant ? ' · préventif' : ''} · ${U.fmt(it.mass * 1000, 0)} g`;
      }
      case 'drivetrain': return `rendement ${U.fmt(Ph.byId(Ph.DRIVETRAINS, it.bike.drivetrain).eff * 100, 1)} %`;
      case 'helmet': return dcdaText(Ph.byId(Ph.HELMETS, it.rider.helmet).dcda);
      case 'glasses': return dcdaText(Ph.byId(Ph.GLASSES, it.rider.glasses).dcda);
      case 'kit': case 'suit': return dcdaText(Ph.byId(Ph.CLOTHING, it.rider.clothing).dcda);
      case 'socks': return dcdaText(Ph.byId(Ph.SOCKS, it.rider.socks).dcda);
      case 'shave': return dcdaText(Ph.byId(Ph.SHAVE, it.rider.shave).dcda);
      case 'shoes': {
        const s = Ph.byId(Ph.SHOES, it.bike.shoes);
        const parts = [`puissance transmise ${U.fmt(s.k * 100, 1)} %`];
        if (s.mass) parts.push(`${s.mass > 0 ? '+' : '−'}${U.fmt(Math.abs(s.mass) * 1000, 0)} g`);
        if (s.dcda) parts.push(dcdaText(s.dcda));
        return parts.join(' · ');
      }
      default: return '';
    }
  }

  /** Réglages si l'on montait l'article (masses comprises), à partir de l'équipement actuel ; « position » : la position sur le vélo. */
  function withItem(cat, id) {
    const st = store.state;
    if (cat === 'position') return { rider: Object.assign({}, st.rider, { position: id }), bike: Object.assign({}, st.bike) };
    const p = Cat.patchFor(cat, id, st.rider, st.bike, selection());
    return { rider: Object.assign({}, st.rider, p.rider), bike: Object.assign({}, st.bike, p.bike) };
  }

  /** Puissance de référence : 80 % de la FTP. */
  function refPower() {
    const ftp = PYR.physio.buildAthlete(store.state.rider).ftp;
    return Math.round(0.8 * ftp / 5) * 5;
  }

  const rho = () => Ph.airDensity(200, 20);
  const speedOf = (setup, P, g) => Ph.steadySpeed(setup, P, g, 1, rho(), 0, 0) * 3.6;

  /** Effet d'un article par rapport à ce qui est monté : km/h gagnés sur le plat et dans une pente à 6 %. */
  function gainText(cat, id, cur, P) {
    const alt = withItem(cat, id);
    const s1 = Ph.buildSetup(alt.rider, alt.bike);
    const round = (d) => (Math.abs(d) < 0.05 ? 0 : d);
    const dFlat = round(speedOf(s1, P, 0) - cur.flat), dClimb = round(speedOf(s1, P, 0.06) - cur.climb);
    const fmt = (d, where) => (d ? `${d > 0 ? '+' : '−'}${U.fmt(Math.abs(d), 1)} km/h ${where}` : `= ${where}`);
    if (!dFlat && !dClimb) return { text: 'même vitesse', sign: 0 };
    const sign = dFlat >= 0 && dClimb >= 0 ? 1 : dFlat <= 0 && dClimb <= 0 ? -1 : 0;
    return { text: `${fmt(dFlat, 'sur le plat')} · ${fmt(dClimb, 'en côte')}`, sign };
  }

  const signed = (x) => (Math.abs(x) < 0.0005 ? '0' : `${x > 0 ? '+' : '−'}${U.fmt(Math.abs(x), 3)}`);

  /** Écart de CdA dû à la tenue et aux accessoires, par rapport à ceux d'entrée de gamme (même vélo, même position). */
  function riderGain() {
    const st = store.state, r = Object.assign({}, st.rider), b = Object.assign({}, st.bike);
    for (const c of Cat.CATEGORIES) {
      const it = c.page === 'rider' && Cat.get(c.id, Cat.BASE[c.id]);
      if (it) { Object.assign(r, it.rider); Object.assign(b, it.bike); }
    }
    return Ph.buildSetup(st.rider, st.bike).cda - Ph.buildSetup(r, b).cda;
  }

  /** Temps sur le parcours à puissance constante (null sans parcours). */
  function courseTime(rider, bike, P) {
    if (!store.profile) return null;
    let inputs;
    try { inputs = PYR.simInputs.build({ rider, bike }); } catch (e) { return null; }
    const ctx = PYR.sim.createContext(inputs.course, inputs.setup, inputs.athlete, {});
    const st = PYR.sim.initState(ctx, 0);
    const cond = {};
    while (!st.finished && st.t < ctx.maxSteps) {
      PYR.sim.conditions(ctx, st.s, st.t, cond);
      PYR.sim.step(ctx, st, P, cond);
    }
    return st.finished ? st.tFinish : null;
  }

  const T = {
    init() {
      store.on('bike', () => T.render());
      store.on('rider', () => T.render());
      store.on('profile', () => T.renderSummary());
      for (const b of document.querySelectorAll('[data-shop-page]')) {
        b.addEventListener('click', () => T.showPage(b.dataset.shopPage));
      }
      for (const b of document.querySelectorAll('[data-shop-view]')) {
        b.addEventListener('click', () => { store.set('ui.shopView', b.dataset.shopView, true); T.renderArt(); });
      }
      T.render();
    },

    onShow() { if (dirty) T.render(); post3d({ type: 'run', on: true }); },

    /** La vitrine ne tourne que quand on la voit. */
    onHide() { post3d({ type: 'run', on: false }); },

    showPage(id) {
      if (!PAGES.some((x) => x.id === id)) return;
      store.set('ui.shopPage', id, true);
      preview = null;
      T.render(true);
    },

    /** Position sur le vélo : un réglage (le même que sur la page Équipements), qu'on essaie ici en 3D. */
    setPosition(id) {
      const pos = Ph.POSITIONS.find((x) => x.id === id);
      if (!pos) return;
      store.state.rider.position = id;
      preview = null;
      store.save();
      PYR.app.refreshBindings();
      store.emit('rider', { path: 'rider.position' });
      D.toast(`Position : ${pos.label.toLowerCase()}`);
    },

    /** Achat (ou remontage) d'un article. */
    buy(cat, id) {
      const st = store.state;
      const p = Cat.patchFor(cat, id, st.rider, st.bike, selection());
      Object.assign(st.rider, p.rider);
      Object.assign(st.bike, p.bike);
      const sel = selection();
      sel[cat] = id;
      // une combinaison remplace le maillot et le cuissard (et inversement)
      for (const c of Cat.CATEGORIES) if (Cat.rivals(cat, c.id)) delete sel[c.id];
      preview = null;
      store.save();
      PYR.app.refreshBindings();
      if (Object.keys(p.rider).length) store.emit('rider', { path: 'rider.shop' });
      if (Object.keys(p.bike).length) store.emit('bike', { path: 'bike.shop' });
      D.toast(`${Cat.get(cat, id).name} : c'est monté !`);
    },

    /** Ce que montre l'illustration : l'équipement monté, ou avec l'article `item` ({cat, id}) en aperçu. */
    artOptions(item) {
      const st = store.state;
      let rider = st.rider, bike = st.bike;
      const picks = { frame: mounted('frame'), wheels: mounted('wheels'), tires: mounted('tires') };
      if (item) {
        const alt = withItem(item.cat, item.id);
        rider = alt.rider; bike = alt.bike;
        if (item.cat in picks) picks[item.cat] = item.id;
      }
      return { rider, bike, picks };
    },

    /** Illustration : l'équipement monté, ou l'article survolé en aperçu ; en 3D (vitrine de Bike3D) ou en photos. */
    renderArt() {
      const box = $('#shop-art-photo'), box3 = $('#shop-art-3d');
      if (!box || !box3) return;
      const pg = page(), mode = view();
      const names = Cat.CATEGORIES.filter((c) => c.page === pg).map((c) => {
        const id = preview && preview.cat === c.id ? preview.id : mounted(c.id);
        return id ? `${c.label.toLowerCase()} ${Cat.get(c.id, id).name}` : null;
      }).filter(Boolean);
      const opts = Object.assign(T.artOptions(preview), { label: `${PAGES.find((x) => x.id === pg).art} : ${names.join(', ')}` });
      for (const b of document.querySelectorAll('[data-shop-view]')) {
        b.setAttribute('aria-pressed', String(b.dataset.shopView === mode));
        if (b.dataset.shopView === '3d') b.disabled = v3.failed;
      }
      box3.hidden = mode !== '3d';
      box.hidden = mode === '3d';
      if (mode === '3d') {
        showroom();
        v3.opts = opts;
        v3.frame.setAttribute('aria-label', opts.label);
        send3d();
      } else {
        PYR.gearArt.update(box, opts);
      }
      const cap = $('#shop-preview');
      if (cap) {
        const it = preview && (preview.cat === 'position' ? Ph.POSITIONS.find((x) => x.id === preview.id) : Cat.get(preview.cat, preview.id));
        cap.textContent = !it ? '' : preview.cat === 'position' ? `Aperçu : ${it.label.toLowerCase()} — clique pour la prendre` : `Aperçu : ${it.name} — clique pour le monter`;
        cap.hidden = !it;
      }
    },

    setPreview(p) {
      const same = (a, b) => (a && b ? a.cat === b.cat && a.id === b.id : a === b);
      if (same(p, preview)) return;
      preview = p;
      T.renderArt();
    },

    render(force) {
      const box = $('#shop-catalog');
      if (!box) return;
      if (!force && !visible()) { dirty = true; return; }
      dirty = false;
      const pg = page();
      for (const b of document.querySelectorAll('[data-shop-page]')) b.setAttribute('aria-pressed', String(b.dataset.shopPage === pg));
      D.clear(box);
      const P = refPower();
      const now = Ph.buildSetup(store.state.rider, store.state.bike);
      const cur = { flat: speedOf(now, P, 0), climb: speedOf(now, P, 0.06) };
      if (pg === 'rider') box.appendChild(T.positionSection(cur, P));
      for (const cat of Cat.CATEGORIES.filter((c) => c.page === pg)) {
        const on = mounted(cat.id);
        const bought = selection()[cat.id];
        const rep = on ? null : replacedBy(cat.id);
        let status;
        if (on) status = Cat.get(cat.id, on).name;
        else if (rep) status = `remplacé par : ${rep.item.name.toLowerCase()}`;
        else status = bought ? 'réglage modifié depuis l\'achat' : `réglage personnalisé (page Équipements)`;
        const sec = h('section', { class: 'shop-cat', 'data-cat': cat.id });
        sec.appendChild(h('div', { class: 'shop-cat-head' }, h('h3', null, cat.label), h('span', { class: 'shop-cur' + (on ? '' : ' none') }, status)));
        sec.appendChild(h('p', { class: 'hint' }, cat.hint));
        const list = h('div', { class: 'shop-opts', role: 'group', 'aria-label': cat.label });
        for (const it of Cat.ITEMS[cat.id]) {
          const isOn = on === it.id;
          const gain = isOn ? null : gainText(cat.id, it.id, cur, P);
          const btn = h('button', {
            type: 'button', class: 'shop-item', 'aria-pressed': String(isOn), 'data-item': it.id,
            onclick: () => { if (!isOn) T.buy(cat.id, it.id); },
          },
          h('span', { class: 'name' }, it.name),
          h('span', { class: 'price' }, it.price ? `${U.fmt(it.price, 0)} €` : 'gratuit'),
          h('span', { class: 'desc' }, it.desc),
          h('span', { class: 'specs' }, specs(cat.id, it)),
          isOn ? h('span', { class: 'gain on' }, 'Monté') : h('span', { class: 'gain' + (gain.sign > 0 ? ' up' : gain.sign < 0 ? ' down' : '') }, gain.text));
          const show = () => T.setPreview(isOn ? null : { cat: cat.id, id: it.id });
          btn.addEventListener('pointerenter', show);
          btn.addEventListener('focus', show);
          btn.addEventListener('blur', () => T.setPreview(null));
          list.appendChild(btn);
        }
        list.addEventListener('pointerleave', () => T.setPreview(null));
        sec.appendChild(list);
        box.appendChild(sec);
      }
      const note = $('#shop-gain-note');
      if (note) note.textContent = `Vitesses à ${P} W (80 % de ta FTP), par rapport à ce qui est monté.`;
      T.renderArt();
      // images des articles de la page, chargées d'avance pour un aperçu immédiat au survol
      const cats = Cat.CATEGORIES.filter((c) => c.page === pg);
      if (view() === 'photo') PYR.gearArt.preload([].concat(...cats.map((c) => Cat.ITEMS[c.id].map((it) => T.artOptions({ cat: c.id, id: it.id })))));
      T.renderSummary();
    },

    /** Position sur le vélo (page Cycliste) : chaque position se voit en 3D au survol, avec son effet sur la vitesse. */
    positionSection(cur, P) {
      const now = Ph.byId(Ph.POSITIONS, store.state.rider.position, 3).id;
      const sec = h('section', { class: 'shop-cat', 'data-cat': 'position' });
      sec.appendChild(h('div', { class: 'shop-cat-head' }, h('h3', null, 'Position sur le vélo'), h('span', { class: 'shop-cur' }, Ph.byId(Ph.POSITIONS, now).label)));
      sec.appendChild(h('p', { class: 'hint' }, 'Un réglage, pas un achat (aussi dans l\'page Équipements) : plus le buste est couché, moins l\'air freine. Les positions contre-la-montre montent des prolongateurs sur le cintre.'));
      const list = h('div', { class: 'shop-opts', role: 'group', 'aria-label': 'Position sur le vélo' });
      for (const pos of Ph.POSITIONS) {
        const isOn = pos.id === now;
        const gain = isOn ? null : gainText('position', pos.id, cur, P);
        const btn = h('button', {
          type: 'button', class: 'shop-item', 'aria-pressed': String(isOn), 'data-item': pos.id,
          onclick: () => { if (!isOn) T.setPosition(pos.id); },
        },
        h('span', { class: 'name' }, pos.label),
        h('span', { class: 'price' }, 'réglage'),
        h('span', { class: 'specs' }, `surface frontale ×${U.fmt(pos.factor, 2)}`),
        isOn ? h('span', { class: 'gain on' }, 'Ta position') : h('span', { class: 'gain' + (gain.sign > 0 ? ' up' : gain.sign < 0 ? ' down' : '') }, gain.text));
        const show = () => T.setPreview(isOn ? null : { cat: 'position', id: pos.id });
        btn.addEventListener('pointerenter', show);
        btn.addEventListener('focus', show);
        btn.addEventListener('blur', () => T.setPreview(null));
        list.appendChild(btn);
      }
      list.addEventListener('pointerleave', () => T.setPreview(null));
      sec.appendChild(list);
      return sec;
    },

    /** Synthèse : masse, CdA, Crr, rendement, valeur, et gain par rapport à un équipement d'entrée de gamme. */
    renderSummary() {
      clearTimeout(pending);
      pending = setTimeout(() => {
        const box = $('#shop-summary');
        if (!box) return;
        const st = store.state, pg = page();
        const setup = Ph.buildSetup(st.rider, st.bike);
        const base = Cat.fullSetup({}, st.rider, st.bike);
        const baseSetup = Ph.buildSetup(base.rider, base.bike);
        let value = 0, unknown = 0;
        for (const cat of Cat.CATEGORIES.filter((c) => c.page === pg)) {
          const id = mounted(cat.id);
          if (id) value += Cat.get(cat.id, id).price;
          else if (!replacedBy(cat.id)) unknown++;
        }
        const P = refPower();
        const v = (s, g) => speedOf(s, P, g);
        D.clear(box);
        const pgInfo = PAGES.find((x) => x.id === pg);
        const stats = pg === 'bike'
          ? [D.stat('Vélo complet', U.fmt(st.bike.weight, 1), 'kg'), D.stat('Crr', U.fmt(setup.crr, 4)), D.stat('Rendement', U.fmt(setup.eta * 100, 1), '%'), D.stat('CdA', U.fmt(setup.cda, 3), 'm²')]
          : [D.stat('CdA', U.fmt(setup.cda, 3), 'm²'), D.stat('Gain aéro de ta tenue', signed(riderGain()), 'm²')];
        stats.push(D.stat(unknown ? `${pgInfo.value} (articles connus)` : pgInfo.value, U.fmt(value, 0), '€'));
        box.appendChild(h('div', { class: 'stats' }, ...stats));
        const cmp = (a, b, unit, digits) => {
          const d = a - b;
          return `${U.fmt(a, digits)} ${unit}${Math.abs(d) >= Math.pow(10, -digits) / 2 ? ` (${d > 0 ? '+' : '−'}${U.fmt(Math.abs(d), digits)})` : ''}`;
        };
        const lines = [
          `À ${P} W : ${cmp(v(setup, 0), v(baseSetup, 0), 'km/h', 1)} sur le plat, ${cmp(v(setup, 0.06), v(baseSetup, 0.06), 'km/h', 1)} dans une pente à 6 %, par rapport à un équipement d'entrée de gamme.`,
        ];
        const tNow = courseTime(st.rider, st.bike, P), tBase = courseTime(base.rider, base.bike, P);
        if (tNow && tBase) {
          const d = tNow - tBase;
          lines.push(`Sur ton parcours : ${U.fmtDuration(tNow)}${Math.abs(d) >= 1 ? `, soit ${U.fmtDuration(Math.abs(d))} ${d < 0 ? 'de moins' : 'de plus'}` : ''}.`);
        }
        box.appendChild(h('p', { class: 'hint' }, lines.join(' ')));
      }, 30);
    },
  };

  PYR.tabShop = T;
})(globalThis.PYR = globalThis.PYR || {});
