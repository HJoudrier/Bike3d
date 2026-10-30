/* author : Hugo Joudrier-Faure */
/* PaceYourRide — configuration des graphiques : un double clic sur le titre d'un graphique ouvre une fenêtre de réglage
 * de sa hauteur. Les graphiques à panneaux (stratégie : altitude, puissance, vitesse…) se règlent panneau par panneau,
 * les autres d'un seul tenant. Les hauteurs sont enregistrées avec les réglages (store.state.ui.chartH), donc retrouvées
 * au rechargement et dans l'export du projet. */
(function (PYR) {
  'use strict';

  const D = PYR.dom, store = PYR.store;
  const { h, $, $$ } = D;

  /** Les graphiques réglables : id → cadre du tracé. `series` : graphique à panneaux (SeriesChart), réglé par panneau. */
  const REGISTRY = {
    profile: { box: '#profile-chart', name: 'Profil altimétrique' },
    weather: { box: '#weather-chart', name: 'Météo' },
    perf: { box: '#perf-chart', name: 'Stratégie', series: true },
    pweather: { box: '#weather-chart-perf', name: 'Météo' },
    // grand écran, mode jeu : le profil et la puissance selon la durée sont des vignettes sur la carte, dont on règle aussi la largeur
    // (clés `gamew` et `gamecurvew`) ; `block` : l'élément qui porte la largeur
    // `place` : réglage (store.state.ui) qui envoie le graphique dans le panneau de droite, sous le classement, plutôt que sur la carte
    game: { box: '#game-chart', name: 'Profil et position', place: 'gameProfileSide', order: 'profile', width: { key: 'gamew', min: 200, max: 900, def: 320, block: '#bottom' } },
    curve: { box: '#curve-chart', name: 'Courbe de puissance record' },
    gamecurve: { box: '#game-curve', name: 'Puissance selon la durée', place: 'gameCurveSide', order: 'curve', width: { key: 'gamecurvew', min: 200, max: 900, def: 320, block: '#game-curve-wrap' } },
  };
  const BOX_MIN = 120, BOX_MAX = 900;       // px : hauteur d'un graphique d'un seul tenant
  const PANEL_MIN = 30, PANEL_MAX = 400;    // px : hauteur de tracé d'un panneau
  const series = Object.create(null);       // id → SeriesChart

  const heights = () => store.state.ui.chartH;
  const boxOf = (id) => $(REGISTRY[id].box);
  const visible = (el) => !!el && el.offsetParent !== null;
  /** Titre (h3) du bloc qui contient le cadre du graphique. */
  const headOf = (id) => {
    const box = boxOf(id);
    const block = box && box.closest('.bottom-view, .rs-chart, .game-curve');
    return block ? block.querySelector('.chart-head h3') : null;
  };

  function setHeight(key, px) {
    const next = Object.assign({}, heights());
    if (px === null || px === undefined) delete next[key]; else next[key] = Math.round(px);
    store.set('ui.chartH', next, true);
  }

  /** Hauteurs réglées des panneaux d'un graphique à panneaux : { idPanneau: px }. */
  function panelMap(id) {
    const out = {}, pre = id + ':';
    for (const k of Object.keys(heights())) if (k.startsWith(pre)) out[k.slice(pre.length)] = heights()[k];
    return out;
  }

  /**
   * Applique les hauteurs réglées. Un graphique d'un seul tenant prend sa hauteur sur son cadre, et le conteneur (barre du
   * bas, bloc de la page Athlète) s'ajuste au contenu tant qu'un graphique visible est réglé ; sinon les feuilles de style
   * décident. `plain` ignore les réglages (pour mesurer les hauteurs par défaut).
   */
  function apply(plain) {
    const custom = new Set();
    for (const id of Object.keys(REGISTRY)) {
      const box = boxOf(id);
      if (!box) continue;
      if (REGISTRY[id].series) {
        if (series[id]) series[id].setHeights(plain ? {} : panelMap(id));
        continue;
      }
      const px = plain ? null : heights()[id];
      box.style.height = px ? px + 'px' : '';
      box.style.flex = px ? 'none' : '';
      if (px && visible(box)) custom.add(box.closest('.bottom, .rs-chart, .game-curve'));
    }
    for (const id of Object.keys(REGISTRY)) {
      const W = REGISTRY[id].width, block = W && $(W.block);
      if (block) block.style.setProperty('--vg-w', !plain && heights()[W.key] ? heights()[W.key] + 'px' : '');
    }
    for (const el of $$('.bottom, .rs-chart, .game-curve')) {
      const on = custom.has(el);
      el.style.flex = on && (el.classList.contains('bottom') || el.classList.contains('game-curve')) ? 'none' : '';
      el.style.height = on ? 'auto' : '';
    }
  }

  /** Hauteur (px) d'un graphique d'un seul tenant sans réglage : celle que donnent les feuilles de style. */
  function defaultHeight(id) {
    apply(true);
    const box = boxOf(id);
    const px = visible(box) ? Math.round(box.getBoundingClientRect().height) : 300;
    apply();
    return Math.min(BOX_MAX, Math.max(BOX_MIN, px));
  }

  /** Une ligne de réglage : curseur et champ numérique liés, bouton de retour à la valeur par défaut. */
  function row({ label, min, max, value, def, onChange }) {
    const range = h('input', { type: 'range', min: String(min), max: String(max), step: '1', 'aria-label': label });
    const num = h('input', { type: 'number', min: String(min), max: String(max), step: '1', 'aria-label': label + ' (px)' });
    const reset = h('button', { type: 'button', class: 'btn small ghost', title: `Valeur par défaut : ${def} px` }, '↺');
    const set = (v, notify) => {
      v = Math.round(Math.min(max, Math.max(min, Number(v) || def)));
      range.value = String(v);
      if (document.activeElement !== num) num.value = String(v);
      if (notify) onChange(v);
    };
    range.addEventListener('input', () => set(range.value, true));
    num.addEventListener('input', () => { if (num.value !== '' && Number(num.value) >= min) set(num.value, true); });
    num.addEventListener('change', () => set(num.value, true));
    reset.addEventListener('click', () => { set(def, false); onChange(null); });
    set(value, false);
    const el = h('div', { class: 'cc-row' }, h('span', { class: 'cc-label' }, label), range, h('span', { class: 'cc-num' }, num, ' px'), reset);
    return { el, set, range };
  }

  /** Fenêtre de réglage d'un graphique ; `focus` : id du panneau à mettre en avant. */
  function open(id, focus) {
    const reg = REGISTRY[id];
    if (!reg || !boxOf(id)) return;
    const head = headOf(id);
    const title = (head ? head.textContent : reg.name).trim();
    const rows = [], nodes = [];
    let total = null;
    const chart = reg.series ? series[id] : null;
    let refresh = () => {};
    let widthRow = null;
    let refreshPlace = () => {};
    let posRow = null; // ligne « Position » (monter / descendre) du bloc, pour les graphiques du mode jeu

    if (chart && chart.data) {
      // graphique à panneaux : une hauteur par panneau
      const info = chart.panelInfo();
      const px = () => { const o = {}; for (const p of chart.panelInfo()) o[p.id] = p.px; return o; };
      total = h('p', { class: 'hint cc-total' });
      refresh = () => { total.textContent = `Hauteur totale du graphique : ${chart.totalHeight(px())} px`; };
      nodes.push(h('p', { class: 'hint' }, 'Hauteur de la zone de tracé de chaque graphique, en pixels. Le réglage est enregistré.'));
      for (const p of info) {
        const r = row({
          label: `${p.label} (${p.unit})`, min: PANEL_MIN, max: PANEL_MAX, value: p.px, def: p.def,
          onChange: (v) => { setHeight(`${id}:${p.id}`, v); chart.setHeights(panelMap(id)); refresh(); },
        });
        r.id = p.id;
        rows.push(r);
        nodes.push(r.el);
        if (p.id === focus) r.el.classList.add('focus');
      }
      nodes.push(total);
    } else {
      const def = defaultHeight(id);
      nodes.push(h('p', { class: 'hint' }, reg.series
        ? 'Calcule d\'abord la stratégie : les graphiques de la stratégie se règlent ensuite un par un. En attendant, voici la hauteur de l\'ensemble.'
        : 'Hauteur du graphique, en pixels. Le réglage est enregistré.'));
      const r = row({
        label: 'Hauteur du graphique', min: BOX_MIN, max: BOX_MAX, value: heights()[id] || def, def,
        onChange: (v) => { setHeight(id, v); apply(); },
      });
      rows.push(r);
      nodes.push(r.el);
      if (reg.place) {
        // mode jeu, grand écran : sur la carte, ou dans le panneau de droite (sous le classement, au-dessus du texte « Gère toi-même l'effort… »)
        const setPlace = (side) => {
          store.set('ui.' + reg.place, side, true);
          refreshPlace();
          apply();
          if (PYR.gameMobile && PYR.gameMobile.placeCharts) PYR.gameMobile.placeCharts();
          if (posRow) posRow.refresh(); // carte ou bande : les voisins possibles ne sont plus les mêmes
        };
        const bMap = h('button', { type: 'button', onclick: () => setPlace(false) }, 'Sur la carte');
        const bSide = h('button', { type: 'button', onclick: () => setPlace(true) }, 'Panneau de droite');
        refreshPlace = () => {
          const side = !!store.state.ui[reg.place];
          bMap.setAttribute('aria-pressed', String(!side));
          bSide.setAttribute('aria-pressed', String(side));
        };
        nodes.push(h('p', { class: 'hint' }, 'En mode jeu sur grand écran, le graphique s\'affiche sur la carte ou dans le panneau de droite, sous le classement et au-dessus du texte « Gère toi-même l\'effort… ».'),
          h('div', { class: 'cc-place' }, h('span', { class: 'cc-label' }, 'Affichage'), h('div', { class: 'seg-control', role: 'radiogroup', 'aria-label': 'Où afficher le graphique' }, bMap, bSide)));
        refreshPlace();
      }
      // place du bloc parmi les autres (classements, statistiques, profil, puissance) : monter ou descendre
      if (reg.order && PYR.gameMobile && PYR.gameMobile.positionRow) {
        posRow = PYR.gameMobile.positionRow(reg.order);
        nodes.push(posRow);
      }
      if (reg.width) {
        const W = reg.width;
        widthRow = row({
          label: 'Largeur de la vignette', min: W.min, max: W.max, value: heights()[W.key] || W.def, def: W.def,
          onChange: (v) => { setHeight(W.key, v); apply(); },
        });
        nodes.push(h('p', { class: 'hint' }, 'En mode jeu sur grand écran, ce graphique est une vignette posée sur la carte : on peut aussi l\'étirer à la souris par son bord droit (largeur) et son bord haut (hauteur).'), widthRow.el);
      }
    }
    refresh();

    const modal = D.modal({
      title: `Configuration du graphique — ${title}`,
      body: nodes,
      actions: [
        {
          label: 'Tout réinitialiser', onClick: () => {
            for (const k of Object.keys(heights())) if (k === id || k.startsWith(id + ':')) setHeight(k, null);
            if (reg.width) setHeight(reg.width.key, null);
            if (reg.place) { store.set('ui.' + reg.place, false, true); refreshPlace(); }
            apply();
            if (reg.place && PYR.gameMobile && PYR.gameMobile.placeCharts) PYR.gameMobile.placeCharts();
            if (widthRow) widthRow.set(reg.width.def, false);
            // les curseurs reprennent les valeurs par défaut
            if (chart && chart.data) chart.panelInfo().forEach((p) => { const r = rows.find((x) => x.id === p.id); if (r) r.set(p.px, false); });
            else if (rows[0]) rows[0].set(defaultHeight(id), false);
            refresh();
            return false;
          },
        },
        { label: 'Fermer', primary: true },
      ],
    });
    const target = (focus && rows.find((r) => r.id === focus)) || rows[0];
    if (target) target.range.focus();
    return modal;
  }

  PYR.chartConfig = {
    /** Un graphique à panneaux se déclare ici : ses hauteurs réglées lui sont transmises tout de suite et à chaque changement. */
    registerSeries(id, chart) {
      series[id] = chart;
      chart.setHeights(panelMap(id));
    },
    open,
    apply,
    /** Règle la hauteur (px) d'un graphique d'un seul tenant, ou la remet par défaut (null), et l'applique tout de suite. */
    setHeight(id, px) {
      setHeight(id, px === null || px === undefined ? null : Math.min(BOX_MAX, Math.max(BOX_MIN - 40, px)));
      apply();
    },
    /** Règle la largeur (px) de la vignette d'un graphique (profil ou puissance du mode jeu), ou la remet par défaut (null). */
    setWidth(id, px) {
      const W = REGISTRY[id] && REGISTRY[id].width;
      if (!W) return;
      setHeight(W.key, px === null || px === undefined ? null : Math.min(W.max, Math.max(W.min, px)));
      apply();
    },
    /** Largeur (px) réglée ou par défaut de la vignette. */
    width(id) {
      const W = REGISTRY[id] && REGISTRY[id].width;
      return W ? heights()[W.key] || W.def : 0;
    },

    init() {
      for (const id of Object.keys(REGISTRY)) {
        const head = headOf(id);
        if (!head) continue;
        head.classList.add('chart-title-editable');
        head.title = 'Double-clique pour régler la hauteur du graphique';
        head.addEventListener('dblclick', (e) => { e.preventDefault(); open(id); });
      }
      apply();
      // l'onglet ou le graphique du bas change : les conteneurs s'ajustent à ce qui est affiché
      new MutationObserver(() => apply()).observe(document.body, { attributes: true, attributeFilter: ['data-tab', 'data-rbottom', 'data-race'] });
    },
  };
})(globalThis.PYR = globalThis.PYR || {});
