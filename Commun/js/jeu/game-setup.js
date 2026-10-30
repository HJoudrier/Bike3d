/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page de choix des jeux (Jeu2D/index.html et Jeu3D/index.html) : le parcours (carrousel de vues 3D avec distance, D+ et D−),
 * l'athlète (avec son vélo et sa tenue), la météo (celle d'une date, ou un temps aléatoire qui évolue), puis les réglages de la partie
 * (liés à l'état par data-bind, comme avant). « Démarrer » ouvre l'écran de course de l'application (course.html).
 *
 * Les parcours, athlètes, vélos et tenues viennent de la bibliothèque de PaceYourRide, lue dans Dropbox (cloud.js pull) et gardée en
 * copie dans le stockage local de cette application pour jouer hors ligne. Le projet en cours de PaceYourRide, lu en même temps, est
 * proposé en tête de chaque liste ; ses réglages de stratégie (allure en virage, vitesse maximale, forme) et son plan optimal le suivent,
 * pour que le fantôme (le plan optimal) soit celui du parcours et de l'athlète choisis.
 * Le choix est recopié dans l'état de l'application (library.apply, comme l'accueil de PaceYourRide) que l'écran de course relit. */
(function (PYR) {
  'use strict';

  const D = PYR.dom, store = PYR.store, L = PYR.library, U = PYR.util, We = PYR.weather;
  const { $, $$, h } = D;

  const PROJECT_ID = '__project__';
  const NONE = 'none';            // vélo ou tenue : « réglages par défaut » (vide : le premier proposé)
  const PROJECT_KEY = (PYR.storageNs || 'paceyourride') + '.cloudproject.v1';     // copie du projet en cours de PaceYourRide (avec son plan)
  const KINDS = ['route', 'athlete', 'bike', 'outfit'];
  const is3d = () => PYR.appId === 'jeu3d';

  const S = { lib: L.empty(), project: null, projectAt: 0, pulledAt: 0, busy: false, error: '', profiles: new Map(), views: [], mode: 'random', memo: {} };

  /* ---------- données : copie locale de ce qui est dans Dropbox ---------- */

  function readJSON(k) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function loadCache() {
    S.memo = {};
    S.lib = L.normalize(readJSON(L.STORAGE_KEY));
    const c = readJSON(PROJECT_KEY);
    if (c && typeof c === 'object') { S.project = c.project || null; S.projectAt = Number(c.savedAt) || 0; S.pulledAt = Number(c.pulledAt) || 0; }
  }
  function saveCache() {
    try {
      localStorage.setItem(L.STORAGE_KEY, JSON.stringify(S.lib));
      localStorage.setItem(PROJECT_KEY, JSON.stringify({ project: S.project, savedAt: S.projectAt, pulledAt: S.pulledAt }));
    } catch (e) { D.toast('Copie locale impossible : stockage du navigateur plein ou indisponible.', 'error'); }
  }

  /** Ce que le projet en cours de PaceYourRide offre pour la rubrique, ou null. */
  function projectItem(kind) {
    const p = S.project;
    if (!p || typeof p !== 'object') return null;
    const has = kind === 'route' ? L.routeLength(p) > 0 : kind === 'bike' ? !!p.bike : !!p.rider;
    if (!has) return null;
    const own = kind === 'route' ? p.route && p.route.name : kind === 'bike' ? p.bike && p.bike.name : kind === 'outfit' ? p.rider && p.rider.outfitName : p.rider && p.rider.name;
    return { id: PROJECT_ID, name: (own ? own + ' · ' : '') + 'projet en cours', savedAt: S.projectAt, data: L.extract(kind, p), project: true };
  }
  /** Éléments proposés pour la rubrique : le projet en cours (sauf s'il est déjà dans la bibliothèque), puis la bibliothèque (le plus récent d'abord). */
  function items(kind) {
    if (S.memo[kind]) return S.memo[kind];
    const out = S.lib[L.KINDS[kind].list].slice();
    const pj = projectItem(kind);
    const json = pj ? JSON.stringify(pj.data) : '';
    S.memo[kind] = pj && !out.some((x) => JSON.stringify(x.data) === json) ? [pj].concat(out) : out;
    return S.memo[kind];
  }
  const find = (kind, id) => items(kind).find((x) => x.id === id) || null;
  const pickId = (kind) => { const all = items(kind), id = store.state.game.pick[kind]; return all.some((x) => x.id === id) ? id : (all[0] ? all[0].id : ''); };

  /** Profil du parcours d'un élément (calculé une fois par version). */
  function profileOf(it) {
    const key = it.id + '@' + it.savedAt;
    if (!S.profiles.has(key)) S.profiles.set(key, L.routeProfile(it.data));
    return S.profiles.get(key);
  }

  /* ---------- Dropbox ---------- */

  function renderCloud() {
    const box = $('#gs-cloud');
    D.clear(box);
    const st = PYR.cloud.status();
    box.classList.toggle('is-error', !!S.error);
    const n = (k) => S.lib[L.KINDS[k].list].length;
    const when = S.pulledAt ? new Date(S.pulledAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '';
    let txt;
    if (S.busy) txt = h('span', null, 'Lecture de ton Dropbox…');
    else if (S.error) txt = h('span', null, h('b', null, 'Dropbox : '), S.error);
    else if (!st.connected) txt = h('span', null, h('b', null, 'Dropbox non connecté. '), 'Tes parcours et tes athlètes sont créés dans PaceYourRide et lus ici dans ton Dropbox.' + (when ? ` Copie locale du ${when}.` : ''));
    else txt = h('span', null, h('b', null, 'Dropbox connecté. '), `${n('route')} parcours, ${n('athlete')} athlète${n('athlete') > 1 ? 's' : ''}, ${n('bike')} vélo${n('bike') > 1 ? 's' : ''}` + (when ? ` · lu le ${when}` : ''));
    box.append(h('div', { class: 'gs-cloud-txt' }, txt));
    if (st.connected) box.append(h('button', { class: 'btn', type: 'button', disabled: S.busy ? 'true' : null, onclick: () => refresh() }, '↻ Actualiser'));
    else box.append(h('button', { class: 'btn primary', type: 'button', onclick: () => PYR.cloud.login().catch((e) => D.toast(e.message, 'error')) }, 'Se connecter à Dropbox'));
    box.append(h('a', { class: 'btn ghost', href: '../PaceYourRide/index.html', title: 'Créer des parcours et des athlètes' }, 'PaceYourRide'));
  }

  async function refresh() {
    if (S.busy || !PYR.cloud.status().connected) return;
    S.busy = true; S.error = ''; renderCloud();
    try {
      const snap = await PYR.cloud.pull();
      if (snap) {
        S.memo = {};
        S.lib = snap.library; S.project = snap.project; S.projectAt = snap.savedAt; S.pulledAt = snap.pulledAt;
        saveCache();
      } else S.error = "Ton Dropbox ne contient encore rien : ouvre PaceYourRide, crée un parcours et un athlète, et enregistre-les dans la bibliothèque.";
    } catch (e) { S.error = e.message; }
    S.busy = false;
    renderAll();
  }

  /* ---------- 1. parcours ---------- */

  const fmt = (x, d) => (Math.round(x * Math.pow(10, d || 0)) / Math.pow(10, d || 0)).toLocaleString('fr-FR');

  function renderRoutes() {
    const track = $('#gs-track'), empty = $('#gs-route-empty');
    for (const v of S.views) v.destroy();
    S.views = [];
    D.clear(track);
    const list = items('route').map((it) => ({ it, p: profileOf(it) })).filter((x) => x.p);
    empty.hidden = list.length > 0;
    if (!list.length) empty.textContent = 'Aucun parcours pour le moment. Trace-en un dans PaceYourRide et enregistre-le dans la bibliothèque ; il apparaîtra ici après la synchronisation Dropbox.';
    const cur = pickId('route');
    for (const { it, p } of list) {
      // 3D : une vue qui tourne ; 2D : le tracé sur le fond de carte
      const canvas = is3d() ? h('canvas', { 'aria-hidden': 'true' }) : h('div', { class: 'gs-map', 'aria-hidden': 'true' });
      const stat = (cls, label, value) => h('span', { class: cls }, h('small', null, label), h('b', null, value));
      const card = h('div', { class: 'gs-route', role: 'option', tabindex: '-1', 'aria-selected': String(it.id === cur), dataset: { id: it.id },
        'aria-label': `${it.name}, ${fmt(p.length / 1000, 1)} km, D+ ${fmt(p.up)} m, D− ${fmt(p.down)} m` },
      canvas,
      h('div', { class: 'gs-route-info' },
        h('span', { class: 'gs-route-name', title: it.name }, it.name),
        h('div', { class: 'gs-route-stats' },
          stat('', 'Distance', fmt(p.length / 1000, 1) + ' km'),
          stat('up', 'D+', p.hasEle ? '▲ ' + fmt(p.up) + ' m' : '—'),
          stat('down', 'D−', p.hasEle ? '▼ ' + fmt(p.down) + ' m' : '—'),
          stat('', 'Altitude', p.hasEle ? fmt(Math.min.apply(null, p.ele)) + '–' + fmt(Math.max.apply(null, p.ele)) + ' m' : '—')),
        it.project ? h('span', { class: 'gs-route-tag' }, 'Projet en cours de PaceYourRide') : null,
        h('div', { class: 'gs-pick' }, it.id === cur ? '✓ Parcours choisi' : 'Choisir ce parcours')));
      card.addEventListener('click', () => { if (canvas.dataset.dragged === '1') { canvas.dataset.dragged = ''; return; } setPick('route', it.id); });
      track.appendChild(card);
      S.views.push(is3d() ? PYR.routeThumb.mount(canvas, p) : PYR.routeThumb.mountMap(canvas, p));
    }
    const sel = track.querySelector('[aria-selected="true"]');
    if (sel) track.scrollTo({ left: sel.offsetLeft - (track.clientWidth - sel.clientWidth) / 2, behavior: 'auto' });
    updateArrows();
  }

  function updateArrows() {
    const t = $('#gs-track');
    $('#gs-prev').disabled = t.scrollLeft <= 4;
    $('#gs-next').disabled = t.scrollLeft + t.clientWidth >= t.scrollWidth - 4;
  }

  /* ---------- 2. athlète, vélo, tenue ---------- */

  function renderAthletes() {
    const box = $('#gs-athletes'), cur = pickId('athlete'), list = items('athlete');
    D.clear(box);
    $('#gs-ath-empty').hidden = list.length > 0;
    if (!list.length) $('#gs-ath-empty').textContent = "Aucun athlète enregistré : la partie utilisera l'athlète par défaut. Crée le tien dans PaceYourRide (page Athlète) et enregistre-le dans la bibliothèque.";
    for (const it of list) {
      const s = L.summary('athlete', it.data) || { title: it.name, detail: '' };
      box.appendChild(h('button', { class: 'gs-ath', type: 'button', role: 'option', 'aria-selected': String(it.id === cur), onclick: () => setPick('athlete', it.id) },
        h('b', null, it.project ? s.title + ' (projet en cours)' : it.name), h('small', null, s.detail)));
    }
    for (const kind of ['bike', 'outfit']) {
      const sel = $(kind === 'bike' ? '#gs-bike' : '#gs-outfit'), all = items(kind), id = store.state.game.pick[kind];
      D.clear(sel);
      sel.appendChild(h('option', { value: NONE }, 'Réglages par défaut'));
      for (const it of all) {
        const s = L.summary(kind, it.data);
        sel.appendChild(h('option', { value: it.id }, it.name + (s && s.title ? ' — ' + s.title : '')));
      }
      sel.value = id === NONE ? NONE : (all.some((x) => x.id === id) ? id : (all[0] ? all[0].id : NONE));
      sel.onchange = () => setPick(kind, sel.value);
    }
  }

  /* ---------- composition de l'état de la partie ---------- */

  const freshWeather = (startAt) => ({ enabled: false, source: 'api', startAt: startAt || '', snapshot: null, utcOffset: 0, fetchedAt: 0, fetchedFor: '', custom: { baseT: 20, temp: [], rain: [] } });
  const tomorrow = () => { const d = new Date(Date.now() + 86400000); d.setHours(9, 0, 0, 0); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

  /** Recopie dans l'état de l'application le parcours, l'athlète, le vélo et la tenue choisis, puis la météo choisie. */
  function compose() {
    const st = store.state, G = st.game;
    G.display = is3d() ? '3d' : '2d';
    const keyBefore = store.profile ? We.routeKey(store.profile) : '';
    const wxBefore = st.weather;
    const route = find('route', pickId('route'));
    if (route) {
      L.startRoute(st, Date.now());
      L.apply('route', st, route.data);
      st.weather = wxBefore || freshWeather();       // (la météo du parcours enregistré n'est pas reprise : voir plus bas)
      PYR.routeModel.computeMissing();
      PYR.routeModel.rebuildProfile();
    }
    // la météo suit le parcours : changer de parcours abandonne celle qui avait été récupérée
    st.weather = keyBefore && store.profile && We.routeKey(store.profile) === keyBefore && wxBefore ? wxBefore : freshWeather(wxBefore && wxBefore.startAt);
    if (!st.weather.startAt) st.weather.startAt = tomorrow();
    const ath = find('athlete', pickId('athlete'));
    if (ath) L.apply('athlete', st, ath.data);
    const bike = G.pick.bike === NONE ? null : find('bike', pickId('bike')), outfit = G.pick.outfit === NONE ? null : find('outfit', pickId('outfit'));
    if (bike) L.apply('bike', st, bike.data);
    if (outfit) L.apply('outfit', st, outfit.data);
    // réglages de stratégie et plan optimal du projet de PaceYourRide : le fantôme n'est repris que s'il correspond au choix (plan-link.js)
    const pj = S.project;
    if (pj) {
      if (pj.perf && typeof pj.perf === 'object') st.perf = Object.assign({}, st.perf, pj.perf);
      if (pj.env && typeof pj.env === 'object') st.env = Object.assign({}, st.env, pj.env);
      if (pj.ride && pj.ride.plan && pj.ride.planInfo) { st.ride.plan = pj.ride.plan; st.ride.planInfo = pj.ride.planInfo; if (pj.ride.kit) st.ride.kit = pj.ride.kit; }
    }
    applyWeather();
    store.save();
    PYR.app.refreshBindings();
    store.emit('weather', { path: 'weather' });
  }

  function setPick(kind, id) {
    store.state.game.pick[kind] = id;
    store.save();
    if (kind === 'route') {
      $$('#gs-track .gs-route').forEach((c) => {
        const on = c.dataset.id === id;
        c.setAttribute('aria-selected', String(on));
        c.querySelector('.gs-pick').textContent = on ? '✓ Parcours choisi' : 'Choisir ce parcours';
      });
    }
    if (kind === 'athlete') $$('#gs-athletes .gs-ath').forEach((c, i) => c.setAttribute('aria-selected', String(items('athlete')[i] && items('athlete')[i].id === id)));
    compose();
    renderSummary();
  }

  /* ---------- 3. météo ---------- */

  /** Météo aléatoire : en 2D, un instantané tiré au hasard qui évolue (seed) et que la simulation lit ; en 3D, le ciel variable de Bike3D (sans effet sur la simulation). */
  function applyWeather() {
    const st = store.state, G = st.game;
    if (S.mode !== 'random') return;
    const p = store.profile;
    if (is3d() || !p) { st.weather.enabled = false; st.weather.snapshot = null; st.weather.fetchedFor = ''; return; }
    if (!G.weatherSeed) G.weatherSeed = 1 + Math.floor(Math.random() * 999999);
    const start = Math.floor(Date.now() / 1000);
    const snap = We.randomEvolving(p, G.weatherSeed, { start, hours: 24 });
    if (!snap) return;
    const startAt = We.epochToLocal(start, 0);
    Object.assign(st.weather, { enabled: true, source: 'api', startAt, snapshot: snap, utcOffset: 0, fetchedAt: Date.now(), fetchedFor: We.freshKey(p, startAt) });
  }

  function randomSummary() {
    const w = store.state.weather, el = $('#gs-wx-random-sum');
    if (is3d()) { el.textContent = ''; return; }
    if (!w.snapshot || !w.enabled) { el.textContent = ''; return; }
    const T = [].concat(...w.snapshot.T), rain = w.snapshot.rain[0];
    const wetH = rain.filter((x) => x >= 0.2).length;
    el.textContent = `Ce tirage : de ${fmt(Math.min(...T))} à ${fmt(Math.max(...T))} °C, ${wetH ? `pluie pendant ${wetH} h sur les ${rain.length} prochaines` : 'pas de pluie'}, vent jusqu'à ${fmt(Math.max(...[].concat(...w.snapshot.gust)) * 3.6)} km/h.`;
  }

  function setMode(mode, init) {
    const prev = S.mode;
    S.mode = mode === 'date' ? 'date' : 'random';
    store.state.game.weatherMode = S.mode;
    $$('[data-wx-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.wxMode === S.mode)));
    $('#gs-wx-random').hidden = S.mode !== 'random';
    $('#gs-wx-date').hidden = S.mode !== 'date';
    const w = store.state.weather;
    if (S.mode === 'random') applyWeather();
    else if (!init && prev === 'random') { w.enabled = false; w.snapshot = null; w.fetchedFor = ''; w.fetchedAt = 0; }    // le tirage au hasard ne vaut pas pour une date
    store.save();
    store.emit('weather', { path: 'weather' });
    randomSummary();
    renderSummary();
  }

  function renderWeatherPanel() {
    $('#gs-wx-random-note').textContent = is3d()
      ? "Le ciel de l'univers 3D change tout seul pendant la course : soleil, nuages, pluie, orage ou neige, avec des transitions douces."
      : 'Un temps tiré au hasard, qui évolue pendant la course : perturbations qui passent, pluie, vent qui tourne, température qui suit la journée et l\'altitude. Il agit sur la route (mouillée), la chaleur et le vent.';
    $('#gs-wx-reroll').hidden = is3d();
    $('#gs-wx-reroll').onclick = () => {
      store.state.game.weatherSeed = 1 + Math.floor(Math.random() * 999999);
      applyWeather(); store.save(); store.emit('weather', { path: 'weather' }); randomSummary(); renderSummary();
    };
    $$('[data-wx-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.wxMode)));
  }

  /* ---------- départ ---------- */

  function renderSummary() {
    const route = find('route', pickId('route')), ath = find('athlete', pickId('athlete')), p = store.profile;
    const w = store.state.weather;
    const wx = S.mode === 'random' ? (is3d() ? 'ciel variable' : 'météo aléatoire') : (w.snapshot && w.enabled ? 'météo du ' + String(w.startAt).replace('T', ' à ') : 'météo à récupérer');
    $('#gs-go-sum').textContent = route ? [route.name, ath ? (L.summary('athlete', ath.data) || {}).title || ath.name : 'athlète par défaut', wx].join(' · ') : 'Choisis un parcours pour commencer.';
    $('#g-go').disabled = !route || !p;
  }

  async function start(params) {
    if (!store.profile) { D.toast('Choisis d\'abord un parcours.', 'error'); return; }
    if (S.mode === 'date' && !PYR.tabWeather.isFresh()) {
      await PYR.tabWeather.fetch();
      if (!PYR.tabWeather.isFresh() && !confirm("La météo de cette date n'a pas pu être récupérée. Partir sans météo ?")) return;
    }
    PYR.app.go('race', params || { start: 1 });
  }

  function renderAll() {
    renderCloud();
    renderRoutes();
    renderAthletes();
    compose();
    randomSummary();
    renderSummary();
  }

  const G = {
    init() {
      const st = store.state;
      if (!st.game.pick || typeof st.game.pick !== 'object') st.game.pick = { route: '', athlete: '', bike: '', outfit: '' };
      S.mode = st.game.weatherMode === 'date' ? 'date' : 'random';
      loadCache();
      renderWeatherPanel();
      $('#gs-prev').addEventListener('click', () => $('#gs-track').scrollBy({ left: -$('#gs-track').clientWidth * 0.8 }));
      $('#gs-next').addEventListener('click', () => $('#gs-track').scrollBy({ left: $('#gs-track').clientWidth * 0.8 }));
      $('#gs-track').addEventListener('scroll', U.debounce(updateArrows, 80));
      $('#gs-track').addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); $('#gs-next').click(); } else if (e.key === 'ArrowLeft') { e.preventDefault(); $('#gs-prev').click(); }
      });
      $('#g-go').addEventListener('click', () => start());
      $('#g-live-create').addEventListener('click', () => start({ do: 'live-create' }));
      $('#g-live-join').addEventListener('click', () => start({ do: 'live-join' }));
      renderAll();
      setMode(S.mode, true);
      store.on('weather', () => { randomSummary(); renderSummary(); });      // météo récupérée, ou tirée à nouveau
      // lecture de Dropbox à l'ouverture, quand l'appareil est connecté
      if (PYR.cloud.status().connected) refresh();
      PYR.cloud.onChange(() => { if (!S.busy) renderCloud(); });
    },
    /** Pour les tests de l'interface. */
    _state: S,
  };

  PYR.gameSetup = G;
})(globalThis.PYR = globalThis.PYR || {});
