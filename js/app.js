/* author : Hugo Joudrier-Faure */
/* PaceYourRide — démarrage d'une page de l'application. Le site a une page par section, toutes servies depuis la racine :
 *   index.html          accueil (js/home.js, sa propre liste de scripts)
 *   parcours.html       parcours, portions, météo
 *   athlete.html        athlète : profil, courbe de puissance record, modèle physiologique
 *   equipement.html     équipements : réglages du vélo, de la tenue et de la position, et magasin
 *   pacing.html         pacing optimal : stratégie d'allure
 *   Jeu/index.html      configuration de la partie (réglages, défis, course en direct)
 *   Jeu/Map2D/          écran de course sur la carte
 *   Jeu/3D/             écran de course dans l'univers 3D (Bike3D, Jeu/3D/univers/)
 *   Compteur/           compteur de la vraie sortie
 * Chaque page charge tous les scripts (js/boot.js) mais n'initialise que les parties qu'elle contient. L'état (le projet) est partagé
 * par le stockage local (js/core/store.js) : on le relit à l'ouverture de chaque page, on l'enregistre en la quittant.
 * Les « onglets » d'avant restent les sections du code (route, rider, bike, shop, perf, game, ride) : PYR.app.showTab montre la section
 * si elle est sur la page (Réglages / Magasin de la page Équipements), sinon ouvre la page qui la contient. */
(function (PYR) {
  'use strict';

  const D = PYR.dom, store = PYR.store;
  const { $, $$ } = D;

  const TABS = {
    route: { mapMode: 'grade', module: () => PYR.tabRoute },
    rider: { mapMode: 'grade', module: () => PYR.tabRider },
    bike: { mapMode: 'grade', module: () => PYR.tabBike },
    shop: { mapMode: 'grade', module: () => PYR.tabShop },
    perf: { mapMode: 'power', module: () => PYR.tabPerf },
    // page Jeu : la configuration (game-setup.js) ; écrans de course : la partie (tab-game.js)
    game: { mapMode: 'game', module: () => (racePage() ? PYR.tabGame : PYR.gameSetup) },
    ride: { mapMode: 'grade', module: () => PYR.tabRide },
  };

  /** Pages du site, depuis la racine : une par section (et les deux écrans de course). */
  const PAGES = {
    home: 'index.html',
    route: 'parcours.html',
    rider: 'athlete.html',
    bike: 'equipement.html',
    shop: 'equipement.html?vue=magasin',
    perf: 'pacing.html',
    game: 'Jeu/index.html',
    race2d: 'Jeu/Map2D/index.html',
    race3d: 'Jeu/3D/index.html',
    ride: 'Compteur/index.html',
  };

  const root = () => PYR.root || '';

  /** Adresse d'une page du site (clé de PAGES), avec des paramètres éventuels ({do, focus, start…}). */
  function url(page, params) {
    const base = root() + (PAGES[page] || PAGES.home);
    const q = new URLSearchParams(params || {}).toString();
    return q ? base + (base.includes('?') ? '&' : '?') + q : base;
  }

  /** Ouvre une autre page (le projet est enregistré avant). */
  function go(page, params) {
    store.saveNow();
    location.href = url(page, params);
  }

  /** « Retour » (compteur) : la page d'où l'on vient si elle est de ce site, sinon l'accueil. */
  function back() {
    let ref = '';
    try { ref = document.referrer ? new URL(document.referrer).href : ''; } catch (e) { ref = ''; }
    if (ref && ref.startsWith(root()) && ref.split('#')[0] !== location.href.split('#')[0]) { store.saveNow(); history.back(); } else go('home');
  }

  /** La section est-elle sur cette page ? */
  const has = (tab) => (tab === 'ride' ? !!$('#ride') : !!$(`.panel[data-panel="${tab}"]`));
  const hasMap = () => !!(PYR.map && PYR.map.map);

  /** Écran de course (Jeu/Map2D, Jeu/3D) : la partie configurée dans Jeu/index.html s'y joue. */
  const racePage = () => !!document.body.dataset.display;

  let current = null;

  function showTab(tab, params) {
    if (!TABS[tab]) tab = 'route';
    if (!has(tab)) { go(tab, params); return; }
    const prev = current;
    current = tab;
    store.state.ui.tab = tab;
    store.save();
    document.body.dataset.tab = tab;
    // sections d'une même page (Réglages / Magasin)
    $$('[data-section]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.section === tab)));
    $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    if (prev && prev !== tab) {
      const m = TABS[prev].module();
      if (m && m.onHide) m.onHide();
    }
    if (prev && prev !== tab) window.scrollTo(0, 0); // petit écran : on repart du haut de la page
    if (hasMap()) {
      PYR.map.drawEnabled = tab === 'route';
      if (tab !== 'game') PYR.map.setMode(TABS[tab].mapMode);
    }
    if (PYR.tabWeather.ready) PYR.tabWeather.onTab(tab);
    const m = TABS[tab].module();
    if (m && m.onShow) m.onShow();
    // la mise en page change : Leaflet doit recalculer la taille de la carte
    if (hasMap()) setTimeout(() => PYR.map.map.invalidateSize(), 60);
  }

  /** Remet les champs liés à jour depuis l'état (après un chargement de défi, par ex.). */
  function refreshBindings() {
    $$('[data-bind]').forEach((el) => {
      if (el === document.activeElement) return;
      const val = store.get(el.dataset.bind);
      if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val === undefined || val === null ? '' : val;
    });
  }

  /** Liaison générique des champs [data-bind="section.clé"] avec l'état. */
  function bindInputs() {
    $$('[data-bind]').forEach((el) => {
      const path = el.dataset.bind;
      const val = store.get(path);
      if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val === undefined || val === null ? '' : val;
      el.addEventListener('change', () => {
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'number') {
          if (el.value === '') v = '';
          else {
            v = Number(el.value);
            if (el.min !== '' && v < Number(el.min)) v = Number(el.min);
            if (el.max !== '' && v > Number(el.max)) v = Number(el.max);
            el.value = v;
          }
        } else v = el.value;
        store.set(path, v);
        // un même réglage peut apparaître à plusieurs endroits (ex. nom du cycliste)
        $$(`[data-bind="${path}"]`).forEach((o) => { if (o !== el && o.type !== 'checkbox') o.value = el.value; });
      });
    });
  }

  /** Petit écran : Exporter / Importer / Réinitialiser sont repliés derrière le bouton ⋯. */
  function bindMenu() {
    const btn = $('#btn-menu'), box = $('#top-actions');
    if (!btn || !box) return;
    const set = (open) => { box.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); set(!box.classList.contains('open')); });
    box.addEventListener('click', () => set(false));
    document.addEventListener('click', (e) => { if (!box.contains(e.target)) set(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  }

  /** La carte change de taille avec la mise en page (bloc du jeu, rotation du téléphone…) : Leaflet doit le savoir. */
  function watchMapSize() {
    if (typeof ResizeObserver === 'undefined' || !hasMap()) return;
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => PYR.map.map.invalidateSize());
    }).observe($('#map'));
  }

  /** Projet : export / import / réinitialisation (menu de l'en-tête, sur toutes les pages). */
  function bindProject() {
    const exp = $('#btn-export-project'), imp = $('#input-import-project'), reset = $('#btn-reset');
    if (exp) exp.addEventListener('click', () => D.download('projet-paceyourride.json', store.exportProject(), 'application/json'));
    if (imp) {
      imp.addEventListener('change', async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        try {
          store.importProject(JSON.parse(await D.readFile(f)));
          location.reload();
        } catch (err) { D.toast('Import impossible : ' + err.message, 'error'); }
      });
    }
    if (reset) {
      reset.addEventListener('click', () => {
        if (!confirm('Tout réinitialiser (parcours, portions, cycliste, vélo) ?')) return;
        store.reset();
        location.reload();
      });
    }
  }

  /**
   * Paramètres de l'adresse : &focus=<id> (met un champ en évidence, lien de l'accueil), &do=<action> (ouvre la fenêtre d'une course en
   * direct, lance le calcul), &start=1 (écran de course : départ dès l'ouverture). L'adresse redevient ensuite celle de la page.
   */
  function deepLink() {
    const q = new URLSearchParams(location.search);
    const act = q.get('do'), focus = q.get('focus'), start = q.get('start');
    if (!act && !focus && !start) return;
    const keep = new URLSearchParams();
    if (q.get('vue')) keep.set('vue', q.get('vue'));
    history.replaceState(null, '', location.pathname + (keep.toString() ? '?' + keep : '') + location.hash);
    const click = (sel, i) => { const b = $$(sel)[i || 0]; if (b && !b.disabled) b.click(); };
    setTimeout(() => {
      if (act === 'live-create' || act === 'live-join') {
        // la course en direct se prépare sur l'écran de course ; depuis la page Jeu, on y va (écran choisi)
        if ($('#live-box')) click('#live-box .toolbar .btn', act === 'live-create' ? 0 : 1);
        else click(act === 'live-create' ? '#g-live-create' : '#g-live-join');
      } else if (act === 'optimize') click('#btn-optimize');
      if (start && racePage() && PYR.tabGame) PYR.tabGame.autoStart();
      const el = focus && document.getElementById(focus);
      if (el) {
        const box = el.closest('label, button, .field') || el;     // un champ caché (import de fichier) : on montre son bouton
        box.scrollIntoView({ block: 'center', behavior: 'smooth' });
        box.classList.add('deeplink-flash');
        setTimeout(() => box.classList.remove('deeplink-flash'), 2600);
      }
    }, 150);
  }

  /** Section affichée à l'ouverture : celle demandée (?vue=magasin), la dernière vue si elle est sur la page, sinon la première. */
  function firstTab() {
    const want = new URLSearchParams(location.search).get('vue') === 'magasin' ? 'shop' : null;
    if (want && has(want)) return want;
    if (has(store.state.ui.tab)) return store.state.ui.tab;
    return document.body.dataset.tab;
  }

  /** Lien de partage qui s'ouvre sur une autre page : un défi sur la page Jeu, une invitation sur l'écran de course (carte 2D). */
  function sharedLink() {
    const h = location.hash;
    if (/^#defi=/.test(h) && !$('#challenge-box')) { location.replace(url('game') + h); return true; }
    if (/^#live=/.test(h) && !$('#live-box')) { location.replace(url('race2d') + h); return true; }
    return false;
  }

  function init() {
    if (sharedLink()) return;
    store.load();
    if ($('#map')) PYR.map.init();
    bindInputs();
    bindMenu();
    bindProject();
    watchMapSize();
    $$('[data-section]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.section)));

    // chaque partie de l'interface ne s'initialise que si elle est sur la page
    const part = (sel, fn) => { if ($(sel)) fn(); };
    part('[data-panel="route"]', () => PYR.tabRoute.init());
    part('[data-wx-api], #weather-chart, #weather-chart-perf', () => PYR.tabWeather.init());
    part('[data-panel="rider"]', () => { PYR.tabRider.init(); PYR.riderImport.init(); });
    part('[data-panel="bike"]', () => { PYR.tabBike.init(); PYR.calibration.init(); });
    part('[data-panel="shop"]', () => PYR.tabShop.init());
    part('[data-panel="perf"]', () => PYR.tabPerf.init());
    if (racePage()) {
      PYR.tabGame.init();
      PYR.gameSource.init();
      PYR.gameMobile.init();
    }
    part('#g-go', () => PYR.gameSetup.init());
    part('#ride', () => PYR.tabRide.init());
    PYR.chartConfig.init();
    part('#challenge-box', () => PYR.challenges.render());
    part('#live-box', () => PYR.live.init());

    // Tracé enregistré : on reconstruit le profil (et on recalcule les tronçons incomplets)
    PYR.routeModel.computeMissing();
    PYR.routeModel.rebuildProfile();
    if (hasMap()) {
      PYR.map.drawWaypoints();
      PYR.map.drawRoute();
      PYR.map.drawPortions();
      if (store.profile && !store.state.ui.center) PYR.map.fit();
    }

    showTab(firstTab());
    deepLink();

    // Liens de partage : #defi=… (défi en différé, page Jeu) ou #live=… (invitation à une course en direct, écran de course),
    // à l'ouverture de la page ou lorsqu'un lien est collé dans un onglet déjà ouvert
    const checkLinks = () => {
      if (sharedLink()) return;
      const ch = $('#challenge-box') ? PYR.challenges.checkHash() : Promise.resolve(false);
      ch.then((handled) => { if (!handled && $('#live-box')) PYR.live.checkHash(); });
    };
    checkLinks();
    window.addEventListener('hashchange', checkLinks);

    // Changement de thème clair/sombre : on redessine les graphiques
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        store.emit('profile', store.profile);
        if (store.plan && has('perf')) PYR.tabPerf.render();
        if (has('rider')) PYR.tabRider.render();
      });
    }
    window.addEventListener('beforeunload', () => store.saveNow());
    D.flushFlash();      // message laissé avant un rechargement (import d'un parcours complet)
  }

  PYR.app = { showTab, init, refreshBindings, url, go, back, PAGES, get racePage() { return racePage(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();   // chargé par js/boot.js, après le document
})(globalThis.PYR = globalThis.PYR || {});
