/* author : Hugo Joudrier-Faure */
/* PaceYourRide — démarrage de l'application. */
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
    game: { mapMode: 'game', module: () => PYR.tabGame },
    ride: { mapMode: 'grade', module: () => PYR.tabRide },
  };

  let current = null;

  function showTab(tab) {
    if (!TABS[tab]) tab = 'route';
    const prev = current;
    current = tab;
    store.state.ui.tab = tab;
    if (tab === 'ride' && prev && prev !== 'ride' && PYR.tabRide) PYR.tabRide.prev = prev;   // pour le bouton « Retour » de la page Sortie
    store.save();
    document.body.dataset.tab = tab;
    $$('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    const sel = $('.tabs [aria-selected="true"]');
    if (sel) { const bar = sel.parentElement; bar.scrollTo({ left: sel.offsetLeft - (bar.clientWidth - sel.offsetWidth) / 2, behavior: 'smooth' }); }
    $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    if (prev && prev !== tab) {
      const m = TABS[prev].module();
      if (m && m.onHide) m.onHide();
    }
    if (prev && prev !== tab) window.scrollTo(0, 0); // petit écran : on repart du haut de la page
    PYR.map.drawEnabled = tab === 'route';
    if (tab !== 'game') PYR.map.setMode(TABS[tab].mapMode);
    PYR.tabWeather.onTab(tab);
    const m = TABS[tab].module();
    if (m && m.onShow) m.onShow();
    // la mise en page change : Leaflet doit recalculer la taille de la carte
    setTimeout(() => PYR.map.map.invalidateSize(), 60);
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
    const set = (open) => { box.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); set(!box.classList.contains('open')); });
    box.addEventListener('click', () => set(false));
    document.addEventListener('click', (e) => { if (!box.contains(e.target)) set(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  }

  /** La carte change de taille avec la mise en page (bloc du jeu, rotation du téléphone…) : Leaflet doit le savoir. */
  function watchMapSize() {
    if (typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => PYR.map.map.invalidateSize());
    }).observe($('#map'));
  }

  /**
   * Liens venus de la page d'accueil (accueil.html) : ?go=<onglet>, puis éventuellement &focus=<id> (met un champ en évidence)
   * ou &do=<action> (ouvre la fenêtre d'une course en direct, lance le calcul). Renvoie vrai si l'onglet a été choisi.
   */
  function deepLink() {
    const q = new URLSearchParams(location.search);
    const go = q.get('go');
    if (!go) return false;
    history.replaceState(null, '', location.pathname + location.hash);   // l'adresse redevient celle de l'application
    if (!TABS[go]) return false;
    showTab(go);
    const act = q.get('do'), focus = q.get('focus');
    const click = (sel, i) => { const b = $$(sel)[i || 0]; if (b && !b.disabled) b.click(); };
    setTimeout(() => {
      if (act === 'live-create') click('#live-box .toolbar .btn', 0);
      else if (act === 'live-join') click('#live-box .toolbar .btn', 1);
      else if (act === 'optimize') click('#btn-optimize');
      const el = focus && document.getElementById(focus);
      if (el) {
        const box = el.closest('label, button, .field') || el;     // un champ caché (import de fichier) : on montre son bouton
        box.scrollIntoView({ block: 'center', behavior: 'smooth' });
        box.classList.add('deeplink-flash');
        setTimeout(() => box.classList.remove('deeplink-flash'), 2600);
      }
    }, 150);
    return true;
  }

  function init() {
    store.load();
    PYR.map.init();
    bindInputs();
    bindMenu();
    watchMapSize();

    PYR.tabRoute.init();
    PYR.tabWeather.init();
    PYR.tabRider.init();
    PYR.tabBike.init();
    PYR.calibration.init();
    PYR.riderImport.init();
    PYR.tabShop.init();
    PYR.tabPerf.init();
    PYR.tabGame.init();
    PYR.gameSource.init();
    PYR.gameMobile.init();
    PYR.tabRide.init();
    PYR.chartConfig.init();
    PYR.challenges.render();
    PYR.live.init();

    $$('.tabs [role="tab"]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

    // Projet : export / import / réinitialisation
    $('#btn-export-project').addEventListener('click', () => {
      D.download('projet-paceyourride.json', store.exportProject(), 'application/json');
    });
    $('#input-import-project').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        store.importProject(JSON.parse(await D.readFile(f)));
        location.reload();
      } catch (err) { D.toast('Import impossible : ' + err.message, 'error'); }
    });
    $('#btn-reset').addEventListener('click', () => {
      if (!confirm('Tout réinitialiser (parcours, portions, cycliste, vélo) ?')) return;
      store.reset();
      location.reload();
    });

    // Tracé enregistré : on reconstruit le profil (et on recalcule les tronçons incomplets)
    PYR.routeModel.computeMissing();
    PYR.routeModel.rebuildProfile();
    PYR.map.drawWaypoints();
    PYR.map.drawRoute();
    PYR.map.drawPortions();
    if (store.profile && !store.state.ui.center) PYR.map.fit();

    if (!deepLink()) showTab(store.state.ui.tab || 'route');

    // Liens de partage : #defi=… (défi en différé) ou #live=… (invitation à une course en direct),
    // à l'ouverture de la page ou lorsqu'un lien est collé dans un onglet déjà ouvert
    const checkLinks = () => PYR.challenges.checkHash().then((handled) => { if (!handled) PYR.live.checkHash(); });
    checkLinks();
    window.addEventListener('hashchange', checkLinks);

    // Changement de thème clair/sombre : on redessine les graphiques
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        store.emit('profile', store.profile);
        if (store.plan) PYR.tabPerf.render();
        PYR.tabRider.render();
      });
    }
    window.addEventListener('beforeunload', () => store.saveNow());
  }

  PYR.app = { showTab, init, refreshBindings };
  document.addEventListener('DOMContentLoaded', init);
})(globalThis.PYR = globalThis.PYR || {});
