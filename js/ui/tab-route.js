/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page Parcours (parcours.html) : tracé, profil, portions de revêtement et de vent. */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store, Ph = PYR.physics;
  const { h, $ } = D;

  /** Rampe séquentielle (brun) selon le coefficient de friction. */
  const SURFACE_RAMP = ['#c9a77c', '#b88a55', '#a1733f', '#86592b', '#6b421c', '#4f2e10'];
  const WIND_COLOR = '#4a3aa7';
  const SPRINT_COLOR = '#1d9a4a', KOM_COLOR = '#d62828', FEED_COLOR = '#0a7ea4';
  const Cl = PYR.classif;

  function surfaceFactor(sp) { return Ph.surfaceFactor(sp); }
  function surfaceColor(sp) {
    const f = surfaceFactor(sp);
    if (f < 1) return '#9fb7a0';
    const t = U.clamp(Math.log(f) / Math.log(6), 0, 0.999);
    return SURFACE_RAMP[Math.floor(t * SURFACE_RAMP.length)];
  }

  let chart = null;
  let selection = null;
  let activeId = null;

  const T = {
    surfaceColor,

    init() {
      // mode de tracé
      D.fillSelect($('#routing-mode'), PYR.services.ROUTING_MODES, store.state.route.mode);
      $('#routing-mode').addEventListener('change', (e) => PYR.routeModel.setMode(e.target.value));

      // nom du parcours : enregistré avec le projet, repris dans la bibliothèque de l'accueil
      // le nom tient lieu de titre de la page ; le crayon le transforme en champ de saisie (Entrée ou clic ailleurs : terminé, Échap : annuler)
      const nameIn = $('#route-name'), title = $('#route-title'), pen = $('#btn-rename-route');
      let before = '';
      const showName = () => {
        const name = store.state.route.name || '';
        if (document.activeElement !== nameIn) nameIn.value = name;
        title.textContent = name || 'Tracé du parcours';
      };
      const edit = (on) => { nameIn.hidden = !on; title.hidden = on; pen.hidden = on; };
      pen.addEventListener('click', () => { before = store.state.route.name || ''; edit(true); nameIn.focus(); nameIn.select(); });
      nameIn.addEventListener('input', () => { store.state.route.name = nameIn.value.slice(0, 60); store.save(); });
      nameIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') nameIn.blur();
        else if (e.key === 'Escape') { store.state.route.name = before; nameIn.value = before; store.save(); nameIn.blur(); }
      });
      nameIn.addEventListener('blur', () => { edit(false); showName(); });
      store.on('profile', showName);
      store.on('route-geometry', showName);
      showName();

      $('#btn-undo').addEventListener('click', () => PYR.routeModel.undo());
      $('#btn-loop').addEventListener('click', () => PYR.routeModel.loop());
      $('#btn-reverse').addEventListener('click', () => PYR.routeModel.reverse());
      $('#btn-fit').addEventListener('click', () => PYR.map.fit());
      $('#btn-clear').addEventListener('click', () => {
        if (!store.state.route.waypoints.length || confirm('Effacer tout le parcours ?')) PYR.routeModel.clear();
      });
      $('#btn-demo').addEventListener('click', () => { PYR.routeModel.demo(); setTimeout(() => PYR.map.fit(), 50); });
      $('#input-gpx').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        try {
          const parsed = PYR.services.parseGpx(await D.readFile(f));
          PYR.routeModel.importGpx(parsed);
          D.toast(`GPX importé : ${parsed.points.length} points${parsed.hasEle ? '' : ' (altitude récupérée en ligne)'}.`);
          setTimeout(() => PYR.map.fit(), 50);
        } catch (err) { D.toast(err.message, 'error'); }
      });
      // le projet ne contient qu'un parcours : la bibliothèque (page d'accueil) en garde plusieurs, mais seulement ceux qu'on y enregistre
      $('#btn-save-lib').addEventListener('click', () => {
        const Lib = PYR.library, p = store.profile;
        if (!p) { D.toast('Aucun parcours à enregistrer', 'error'); return; }
        if (!store.state.route.name.trim()) { store.state.route.name = Lib.defaultRouteName(); $('#route-name').value = store.state.route.name; $('#route-title').textContent = store.state.route.name; store.save(); }
        const name = store.state.route.name.trim();
        try {
          let raw = null;
          try { raw = JSON.parse(localStorage.getItem(Lib.STORAGE_KEY)); } catch (e) { /* bibliothèque illisible : on repart d'une vide */ }
          const lib = Lib.normalize(raw), data = Lib.extract('route', store.state);
          let r = Lib.save(lib, 'route', name, data);
          if (r.exists) {
            if (!confirm(`Un parcours nommé « ${r.exists.name} » existe déjà dans ta bibliothèque. Veux-tu vraiment l'écraser ?`)) return;
            r = Lib.save(lib, 'route', name, data, Date.now(), true);
          }
          localStorage.setItem(Lib.STORAGE_KEY, JSON.stringify(lib));
          D.toast(`« ${r.item.name} » ${r.replaced ? 'mis à jour dans' : 'enregistré dans'} ta bibliothèque (page d'accueil › Sélectionner un parcours).`);
        } catch (e) { D.toast('Enregistrement impossible : stockage du navigateur indisponible.', 'error'); }
      });
      $('#btn-export-gpx').addEventListener('click', () => {
        const p = store.profile;
        if (!p) { D.toast('Aucun parcours à exporter', 'error'); return; }
        D.download('parcours-paceyourride.gpx', PYR.services.toGpx(store.state.route.name || 'Parcours PaceYourRide', p.lat, p.lng, p.ele, p.n), 'application/gpx+xml');
      });

      // recherche de lieu
      const results = $('#search-results');
      $('#search-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const q = $('#search-input').value.trim();
        if (!q) return;
        D.clear(results);
        results.hidden = false;
        results.appendChild(h('li', null, 'Recherche…'));
        try {
          const list = await PYR.services.geocode(q);
          D.clear(results);
          if (!list.length) results.appendChild(h('li', null, 'Aucun résultat'));
          for (const r of list) {
            const li = h('li', { tabindex: 0 }, r.label, r.sub ? h('small', null, r.sub) : null);
            const go = () => { PYR.map.map.setView([r.lat, r.lng], 13); results.hidden = true; };
            li.addEventListener('click', go);
            li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
            results.appendChild(li);
          }
        } catch (err) {
          D.clear(results);
          results.appendChild(h('li', null, 'Recherche indisponible (connexion ?)'));
        }
      });
      document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; });

      // profil
      chart = new PYR.charts.ProfileChart($('#profile-chart'), {
        selectable: true,
        onSelect: (sel) => { selection = sel; T.renderSelection(); },
        onHover: (s) => store.emit('hover', { s, from: 'profile' }),
        onBandClick: (kind, id) => T.focusPortion(kind, id),
      });
      T.renderProfileLegend();

      $('#sel-add-surface').addEventListener('click', () => { if (selection) T.addSurface(selection.a / 1000, selection.b / 1000); T.cancelSelection(); });
      $('#sel-add-wind').addEventListener('click', () => { if (selection) T.addWind(selection.a / 1000, selection.b / 1000); T.cancelSelection(); });
      $('#sel-add-sprint').addEventListener('click', () => { if (selection) T.addSprint(selection.b / 1000); T.cancelSelection(); });
      $('#sel-add-kom').addEventListener('click', () => { if (selection) T.addKom(selection.a / 1000, selection.b / 1000); T.cancelSelection(); });
      $('#sel-add-feed').addEventListener('click', () => { if (selection) T.addFeed(selection.a / 1000, selection.b / 1000); T.cancelSelection(); });
      $('#sel-cancel').addEventListener('click', () => T.cancelSelection());

      $('#btn-add-sprint').addEventListener('click', () => {
        const L = store.profile ? store.profile.length / 1000 : 0;
        if (!L) { D.toast('Trace d\'abord un parcours', 'error'); return; }
        T.addSprint(L / 2);
      });
      $('#btn-add-kom').addEventListener('click', () => {
        const L = store.profile ? store.profile.length / 1000 : 0;
        if (!L) { D.toast('Trace d\'abord un parcours', 'error'); return; }
        T.addKom(Math.max(0, L / 2 - 1), L / 2);
      });
      $('#btn-add-feed').addEventListener('click', () => {
        const L = store.profile ? store.profile.length / 1000 : 0;
        if (!L) { D.toast('Trace d\'abord un parcours', 'error'); return; }
        const mid = L / 2;
        T.addFeed(Math.max(0, mid - PYR.feed.ZONE_LEN / 2000), Math.min(L, mid + PYR.feed.ZONE_LEN / 2000));
      });
      $('#btn-auto-feed').addEventListener('click', () => T.autoFeed());
      $('#btn-auto-kom').addEventListener('click', () => T.autoCheckpoints('kom'));
      $('#btn-auto-sprint').addEventListener('click', () => T.autoCheckpoints('sprint'));

      $('#btn-add-surface').addEventListener('click', () => {
        const L = store.profile ? store.profile.length / 1000 : 1;
        T.addSurface(0, Math.min(L, 1));
      });
      $('#btn-add-wind').addEventListener('click', () => {
        const L = store.profile ? store.profile.length / 1000 : 1;
        T.addWind(0, Math.min(L, 5));
      });
      $('#btn-add-wind-all').addEventListener('click', () => {
        const L = store.profile ? store.profile.length / 1000 : 0;
        if (!L) { D.toast('Trace d\'abord un parcours', 'error'); return; }
        T.addWind(0, +L.toFixed(2));
      });

      store.on('profile', (p) => { chart.setProfile(p); T.renderStats(); T.renderBands(); T.renderPortions(); T.renderMarks(); });
      store.on('checkpoints', () => T.renderMarks());
      store.on('feedZones', () => T.renderMarks());
      store.on('route-status', (s) => {
        const el = $('#route-status');
        el.textContent = s.text;
        el.classList.toggle('error', s.error);
        PYR.map.status(s.text && !s.error ? s.text : '');
      });
      store.on('route-geometry', () => T.renderStats());
      store.on('surfaces', () => { T.renderBands(); });
      store.on('winds', () => { T.renderBands(); });
      // largeur par défaut changée : les largeurs proposées (et affichées) des portions suivent
      store.on('road', (ev) => { if (ev && ev.path === 'road.width') renderSurfaceList(); });
      store.on('hover', ({ s, from }) => {
        if (from !== 'profile' && chart) chart.setHover(s);
        if (from !== 'map') PYR.map.showHover(s);
      });

      chart.setProfile(store.profile);
      T.renderStats();
      T.renderPortions();
      T.renderBands();
      T.renderMarks();
    },

    onShow() { if (chart) { chart.surface.request(); T.renderMarks(); } },

    renderProfileLegend() {
      const el = $('#profile-legend');
      D.clear(el);
      const cls = PYR.charts.GRADE_CLASSES.filter((c, i) => i % 2 === 0 || i === 3);
      for (const c of cls) el.appendChild(h('span', { class: 'key' }, h('span', { class: 'sw', style: { background: c.color } }), c.label));
    },

    renderSelection() {
      const bar = $('#selection-bar');
      if (!selection) { bar.hidden = true; return; }
      $('#selection-text').textContent = `km ${U.fmt(selection.a / 1000, 2)} → ${U.fmt(selection.b / 1000, 2)}`;
      bar.hidden = false;
    },

    cancelSelection() {
      selection = null;
      chart.clearSelection();
      T.renderSelection();
    },

    renderStats() {
      const el = $('#route-stats');
      D.clear(el);
      const p = store.profile;
      const wps = store.state.route.waypoints.length;
      if (!p) {
        el.appendChild(D.stat('Points de passage', String(wps)));
        el.appendChild(D.stat('Distance', '–'));
        return;
      }
      const s = p.stats;
      el.appendChild(D.stat('Distance', U.fmt(s.length / 1000, s.length < 10000 ? 2 : 1), 'km'));
      el.appendChild(D.stat('Dénivelé +', U.fmt(s.up, 0), 'm'));
      el.appendChild(D.stat('Dénivelé −', U.fmt(s.down, 0), 'm'));
      el.appendChild(D.stat('Altitude max', U.fmt(s.emax, 0), 'm'));
      el.appendChild(D.stat('Altitude min', U.fmt(s.emin, 0), 'm'));
      el.appendChild(D.stat('Pente max (100 m)', U.fmt(s.gmax * 100, 1), '%'));
      el.appendChild(D.stat('Descente max', U.fmt(-s.gmin * 100, 1), '%'));
      el.appendChild(D.stat('Points de passage', String(wps)));
      const parent = el.parentElement;
      let extra = parent.querySelector('#route-extra');
      if (extra) extra.remove();
      extra = h('div', { id: 'route-extra' });
      if (p.eleMissing) extra.appendChild(h('div', { class: 'note warn' }, 'Altitude indisponible pour tout ou partie du parcours : le profil y est interpolé (vérifie ta connexion, ou importe un GPX avec altitude).'));
      if (p.climbs && p.climbs.length) {
        // les plus dures d'abord (indice FIETS), puis dans l'ordre du parcours
        const shown = p.climbs.slice().sort((a, b) => b.fiets - a.fiets).slice(0, 8).sort((a, b) => a.start - b.start);
        const list = h('div', { class: 'note' }, h('strong', null, `Montées principales (${p.climbs.length})`));
        for (const c of shown) {
          const cat = c.cat ? PYR.classif.catOf(c.cat) : null;
          list.appendChild(h('div', null,
            cat ? PYR.classifView.cpBadge({ type: 'kom', cat: c.cat }) : null, cat ? ' ' : '',
            `km ${U.fmt(c.start / 1000, 1)} → ${U.fmt(c.end / 1000, 1)} : ${U.fmt(c.len / 1000, 1)} km à ${U.fmt(c.grade * 100, 1)} % (+${U.fmt(c.gain, 0)} m)`,
            cat ? ` · ${cat.name}` : ' · non classée'));
        }
        list.appendChild(h('div', { class: 'hint' }, 'Catégories du grand prix de la montagne (mode jeu), de la 4ᵉ à « hors catégorie », selon la longueur, la pente et l\'altitude.'));
        extra.appendChild(list);
      }
      el.after(extra);
    },

    renderBands() {
      if (!chart) return;
      const bands = [];
      for (const sp of store.state.surfaces) {
        bands.push({ kind: 'surface', id: sp.id, start: sp.startKm * 1000, end: sp.endKm * 1000, color: surfaceColor(sp), label: '×' + U.fmt(surfaceFactor(sp), 1) });
      }
      for (const w of store.state.winds) {
        bands.push({ kind: 'wind', id: w.id, start: w.startKm * 1000, end: w.endKm * 1000, color: WIND_COLOR, label: `${U.cardinal(w.dir)} ${Math.round(w.speed)}${w.gusty ? '↯' : ''}` });
      }
      chart.setBands(bands);
    },

    addSurface(a, b) {
      const sp = { id: U.uid(), startKm: +(+a).toFixed(2), endKm: +(+b).toFixed(2), surface: 'cobbles', factor: 2.2 };
      store.state.surfaces.push(sp);
      activeId = sp.id;
      store.emit('surfaces');
      store.save();
      T.renderPortions();
    },

    addWind(a, b) {
      const w = { id: U.uid(), startKm: +(+a).toFixed(2), endKm: +(+b).toFixed(2), dir: 270, speed: 20, gusty: false, gust: 40 };
      store.state.winds.push(w);
      activeId = w.id;
      store.emit('winds');
      store.save();
      T.renderPortions();
    },

    /** Sprint intermédiaire au kilomètre km. */
    addSprint(km) {
      const L = store.profile ? store.profile.length / 1000 : 0;
      if (!L) { D.toast('Trace d\'abord un parcours', 'error'); return; }
      const it = { id: U.uid(), type: 'sprint', km: +U.clamp(km, 0.1, L).toFixed(2) };
      store.state.checkpoints.push(it);
      T.cpChanged(it.id);
    },

    /** Côte classée du pied (startKm) au sommet (km) ; catégorie proposée d'après sa longueur, sa pente et son altitude. */
    addKom(startKm, km) {
      const L = store.profile ? store.profile.length / 1000 : 0;
      if (!L) { D.toast('Trace d\'abord un parcours', 'error'); return; }
      const top = +U.clamp(Math.max(km, startKm), 0.1, L).toFixed(2), foot = +U.clamp(Math.min(km, startKm), 0, top).toFixed(2);
      const it = { id: U.uid(), type: 'kom', km: top, startKm: foot, cat: '4' };
      it.cat = suggestedCat(it) || '4';
      store.state.checkpoints.push(it);
      T.cpChanged(it.id);
    },

    /** Ajoute automatiquement les côtes classées (type « kom ») ou des sprints (« sprint ») : remplace ceux de ce type. */
    autoCheckpoints(type) {
      const p = store.profile;
      if (!p) { D.toast('Trace d\'abord un parcours', 'error'); return; }
      const have = store.state.checkpoints.filter((c) => c.type === type);
      if (have.length && !confirm(`Remplacer les ${have.length} ${type === 'kom' ? 'côte(s) classée(s)' : 'sprint(s)'} existant(s) ?`)) return;
      const n = Number($('#auto-sprints').value) || 1;
      const found = Cl.toItems(Cl.build(p, type === 'kom' ? { kom: true } : { sprints: n })).filter((c) => c.type === type);
      store.state.checkpoints = store.state.checkpoints.filter((c) => c.type !== type).concat(found);
      T.cpChanged(null);
      D.toast(found.length ? (type === 'kom' ? `${found.length} côte${found.length > 1 ? 's' : ''} classée${found.length > 1 ? 's' : ''} ajoutée${found.length > 1 ? 's' : ''}.` : `${found.length} sprint${found.length > 1 ? 's' : ''} placé${found.length > 1 ? 's' : ''}.`)
        : (type === 'kom' ? 'Aucune côte classée sur ce parcours.' : 'Pas assez de plat pour un sprint intermédiaire.'), found.length ? undefined : 'error');
    },

    /** Zone de ravitaillement du kilomètre a au kilomètre b (au moins MIN_LEN de long). */
    addFeed(a, b) {
      const L = store.profile ? store.profile.length / 1000 : 0;
      if (!L) { D.toast('Trace d\'abord un parcours', 'error'); return; }
      const minLen = PYR.feed.MIN_LEN / 1000;
      let x = U.clamp(Math.min(a, b), 0, L), y = U.clamp(Math.max(a, b), 0, L);
      if (y - x < minLen) { x = Math.max(0, y - PYR.feed.ZONE_LEN / 1000); y = Math.min(L, x + PYR.feed.ZONE_LEN / 1000); }
      const it = { id: U.uid(), startKm: +x.toFixed(3), endKm: +y.toFixed(3) };
      store.state.feedZones.push(it);
      T.feedChanged(it.id);
    },

    /** Ajoute automatiquement des zones de ravitaillement (une tous les 50 km environ, à partir de 75 km) : remplace celles qui existent. */
    autoFeed() {
      const p = store.profile;
      if (!p) { D.toast('Trace d\'abord un parcours', 'error'); return; }
      const found = PYR.feed.toItems(PYR.feed.build(p, { fuel: true }));
      if (!found.length) { D.toast('Parcours trop court pour un placement automatique (75 km au moins) : ajoute les zones à la main.', 'error'); return; }
      const have = store.state.feedZones.length;
      if (have && !confirm(`Remplacer les ${have} zone(s) de ravitaillement existante(s) ?`)) return;
      store.state.feedZones = found;
      T.feedChanged(null);
      D.toast(`${found.length} zone${found.length > 1 ? 's' : ''} de ravitaillement ajoutée${found.length > 1 ? 's' : ''}.`);
    },

    feedChanged(focusId) {
      store.state.feedZones.sort((a, b) => a.startKm - b.startKm);
      if (focusId) activeId = focusId;
      store.emit('feedZones');
      store.save();
      renderFeedList();
    },

    /** Liste modifiée : tri par distance, sauvegarde, affichage. */
    cpChanged(focusId) {
      store.state.checkpoints.sort((a, b) => a.km - b.km);
      if (focusId) activeId = focusId;
      store.emit('checkpoints');
      store.save();
      renderCpList();
    },

    /** Repères sur le profil et la carte : sprints, côtes (bande du pied au sommet) et arrivée. */
    renderMarks() {
      if (!chart) return;
      const p = store.profile;
      const cps = p ? Cl.fromList(store.state.checkpoints, p) : null;
      const feed = p ? PYR.feed.fromList(store.state.feedZones, p) : [];
      const flags = cps ? cps.filter((c) => c.type !== 'finish').map((c) => (c.type === 'sprint'
        ? { s: c.s, label: 'S', color: SPRINT_COLOR }
        : { s: c.s, from: c.start, label: Cl.catOf(c.cat).short.replace(' cat.', ''), color: KOM_COLOR })) : [];
      for (const z of feed) flags.push({ s: z.end, from: z.s, label: 'R', color: FEED_COLOR, band: 'rgba(10, 126, 164, 0.22)' });
      chart.setFlags(p ? flags : null);
      if (store.state.ui.tab === 'route') PYR.map.setCheckpoints(cps && Cl.active(cps) ? cps : p ? [] : null, feed);
      renderCpList();
      renderFeedList();
    },

    focusPortion(kind, id) {
      activeId = id;
      const list = kind === 'surface' ? store.state.surfaces : kind === 'cp' ? store.state.checkpoints : kind === 'feed' ? store.state.feedZones : store.state.winds;
      const found = list.find((x) => x.id === id);
      if (!found) return;
      // un sprint se voit sur 200 m autour de sa ligne, une côte du pied au sommet
      const it = kind === 'cp' ? { startKm: found.type === 'kom' ? found.startKm : Math.max(0, found.km - 0.1), endKm: found.type === 'kom' ? found.km : found.km + 0.1 } : found;
      chart.setHighlight({ a: it.startKm * 1000, b: it.endKm * 1000 });
      const p = store.profile;
      if (p) {
        const pts = [];
        const i0 = U.clamp(Math.floor(it.startKm * 1000 / p.step), 0, p.n - 1), i1 = U.clamp(Math.ceil(it.endKm * 1000 / p.step), 0, p.n - 1);
        for (let i = i0; i <= i1; i += Math.max(1, Math.floor((i1 - i0) / 200))) pts.push([p.lat[i], p.lng[i]]);
        if (pts.length >= 2) PYR.map.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16 });
      }
      T.renderPortions();
      const el = document.querySelector(`[data-portion="${id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },

    renderPortions() {
      renderSurfaceList();
      renderWindList();
      renderCpList();
      renderFeedList();
    },
  };

  /* ---------- Éditeurs de portions ---------- */
  function kmInputs(item, onChange) {
    const L = store.profile ? store.profile.length / 1000 : 9999;
    const a = h('input', { type: 'number', step: '0.1', min: '0', max: String(L.toFixed(2)), value: item.startKm, 'aria-label': 'Début (km)' });
    const b = h('input', { type: 'number', step: '0.1', min: '0', max: String(L.toFixed(2)), value: item.endKm, 'aria-label': 'Fin (km)' });
    const apply = () => {
      let x = Number(a.value), y = Number(b.value);
      if (!isFinite(x) || !isFinite(y)) return;
      if (y < x) [x, y] = [y, x];
      item.startKm = U.clamp(x, 0, L); item.endKm = U.clamp(y, 0, L);
      onChange();
    };
    a.addEventListener('change', apply);
    b.addEventListener('change', apply);
    return h('div', { class: 'km' }, a, h('span', null, '→'), b, h('span', null, 'km'));
  }

  function headButtons(kind, item, list, evt) {
    return [
      h('button', { class: 'btn icon ghost', title: 'Voir sur la carte et le profil', 'aria-label': 'Voir', onclick: () => T.focusPortion(kind, item.id) }, '◎'),
      h('button', {
        class: 'btn icon ghost danger', title: 'Supprimer la portion', 'aria-label': 'Supprimer',
        onclick: () => {
          const i = list.indexOf(item);
          if (i >= 0) list.splice(i, 1);
          if (activeId === item.id) { activeId = null; chart.setHighlight(null); }
          store.emit(evt); store.save(); T.renderPortions();
        },
      }, '✕'),
    ];
  }

  function renderSurfaceList() {
    const box = $('#surface-list');
    D.clear(box);
    const list = store.state.surfaces;
    if (!list.length) { box.appendChild(h('div', { class: 'empty-list' }, 'Aucune portion : asphalte standard partout.')); return; }
    const crrTire = Ph.buildSetup(store.state.rider, store.state.bike).crr;
    const dfltW = () => Ph.roadWidth(store.state.road ? store.state.road.width : undefined);
    for (const sp of list) {
      const changed = () => { store.emit('surfaces'); store.save(); updateEffect(); card.style.setProperty('--swatch', surfaceColor(sp)); };
      const sel = h('select', { 'aria-label': 'Revêtement' });
      D.fillSelect(sel, Ph.SURFACES, sp.surface);
      const factor = h('input', { type: 'number', step: '0.05', min: '0.3', max: '10', value: U.fmt(surfaceFactor(sp), 2).replace(',', '.'), 'aria-label': 'Coefficient de friction' });
      // largeur de la portion : vide = celle du revêtement (placeholder) ; elle ne touche que le peloton du mode jeu (pas la stratégie)
      const width = h('input', { type: 'number', step: '0.5', min: String(Ph.ROAD_W_MIN), max: String(Ph.ROAD_W_MAX), value: Number(sp.width) > 0 ? sp.width : '', 'aria-label': 'Largeur de la route (m)' });
      const widthHint = () => { width.placeholder = U.fmt(Ph.surfaceWidth({ surface: sp.surface }, dfltW()), 1); };
      widthHint();
      const effect = h('p', { class: 'effect' });
      const updateEffect = () => {
        const f = surfaceFactor(sp);
        effect.textContent = `Crr effectif : ${U.fmt(crrTire, 4)} × ${U.fmt(f, 2)} = ${U.fmt(crrTire * f, 4)} · largeur ${U.fmt(Ph.surfaceWidth(sp, dfltW()), 1)} m`;
      };
      sel.addEventListener('change', () => {
        sp.surface = sel.value;
        const preset = Ph.SURFACES.find((s) => s.id === sel.value);
        if (preset && preset.f !== null) factor.value = preset.f;
        else sp.factor = Number(factor.value) || 1;
        widthHint(); // une largeur saisie reste celle de la portion
        changed();
      });
      width.addEventListener('change', () => {
        const v = Number(width.value);
        if (width.value === '' || !(v > 0)) { delete sp.width; width.value = ''; } else { sp.width = U.clamp(v, Ph.ROAD_W_MIN, Ph.ROAD_W_MAX); width.value = sp.width; }
        store.emit('road'); store.save(); updateEffect(); // seul le mode jeu s'en sert : la stratégie calculée reste valable
      });
      factor.addEventListener('change', () => {
        sp.surface = 'custom'; sel.value = 'custom';
        sp.factor = U.clamp(Number(factor.value) || 1, 0.3, 10);
        changed();
      });
      const card = h('div', { class: 'portion' + (activeId === sp.id ? ' active' : ''), 'data-portion': sp.id, style: { '--swatch': surfaceColor(sp) } },
        h('div', { class: 'portion-head' }, kmInputs(sp, changed), ...headButtons('surface', sp, list, 'surfaces')),
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('label', null, 'Revêtement'), sel),
          h('div', { class: 'field', style: { flex: '0 0 110px' } }, h('label', null, 'Friction ×'), factor),
          h('div', { class: 'field', style: { flex: '0 0 110px' } }, h('label', null, 'Largeur (m)'), width)),
        effect);
      card.style.setProperty('--swatch', surfaceColor(sp));
      updateEffect();
      box.appendChild(card);
    }
  }

  /* ---------- Zones de ravitaillement ---------- */
  function renderFeedList() {
    const box = $('#feed-list');
    if (!box) return;
    D.clear(box);
    const list = store.state.feedZones;
    if (!list.length) { box.appendChild(h('div', { class: 'empty-list' }, 'Aucune zone de ravitaillement.')); return; }
    const L = store.profile ? store.profile.length / 1000 : 9999;
    list.forEach((z, i) => {
      const effect = h('p', { class: 'effect' });
      const changed = () => {
        const moved = list.some((x, k) => k && list[k - 1].startKm > x.startKm);
        store.emit('feedZones'); store.save();
        if (moved) { list.sort((a, b) => a.startKm - b.startKm); renderFeedList(); } else updateEffect();
      };
      const updateEffect = () => {
        const len = Math.max(0, (z.endKm - z.startKm) * 1000);
        const grade = len > 0 ? (eleAtKm(z.endKm) - eleAtKm(z.startKm)) / len : 0;
        const bits = [`${U.fmt(len, 0)} m`, `pente ${U.fmt(grade * 100, 1)} %`];
        if (len < PYR.feed.MIN_LEN) bits.push(`trop courte (${PYR.feed.MIN_LEN} m au moins) : ignorée`);
        if (z.startKm > L + 0.001) bits.push('au-delà de l\'arrivée : ignorée');
        effect.textContent = bits.join(' · ');
      };
      const card = h('div', { class: 'portion' + (activeId === z.id ? ' active' : ''), 'data-portion': z.id, style: { '--swatch': FEED_COLOR } },
        h('div', { class: 'portion-head' },
          h('span', { class: 'cp-badge feed', 'aria-hidden': 'true' }, 'R'),
          h('strong', null, `Ravitaillement n°${i + 1}`),
          kmInputs(z, changed),
          ...headButtons('feed', z, list, 'feedZones')),
        effect);
      updateEffect();
      box.appendChild(card);
    });
  }

  /* ---------- Sprints intermédiaires et côtes classées ---------- */
  const eleAtKm = (km) => {
    const p = store.profile;
    return p ? PYR.course.eleAt({ step: p.step, n: p.n - 1, ele: p.ele }, U.clamp(km * 1000, 0, p.length)) : 0;
  };

  /** Longueur (m), dénivelé (m), altitude du sommet (m) et catégorie d'après l'indice FIETS d'une côte posée à la main. */
  function climbInfo(it) {
    const len = Math.max(0, (it.km - it.startKm) * 1000), top = eleAtKm(it.km), gain = Math.max(0, top - eleAtKm(it.startKm));
    const k = Cl.catFor(len, gain, top);
    return { len, gain, top, fiets: k.fiets, cat: k.cat };
  }
  const suggestedCat = (it) => climbInfo(it).cat;

  const ptsText = (a) => a.join(', ');

  function renderCpList() {
    const box = $('#cp-list');
    if (!box) return;
    D.clear(box);
    const list = store.state.checkpoints;
    if (!list.length) { box.appendChild(h('div', { class: 'empty-list' }, 'Aucun point en jeu : seule l\'arrivée donne des points.')); return; }
    const L = store.profile ? store.profile.length / 1000 : 9999;
    for (const it of list) {
      const isKom = it.type === 'kom';
      const color = isKom ? KOM_COLOR : SPRINT_COLOR;
      const effect = h('p', { class: 'effect' });
      const changed = () => {
        if (isKom && it.startKm > it.km) [it.startKm, it.km] = [it.km, it.startKm];
        const moved = list.some((x, i) => i && list[i - 1].km > x.km);
        store.emit('checkpoints'); store.save();
        if (moved) { list.sort((a, b) => a.km - b.km); renderCpList(); } else updateEffect();
      };
      const km = h('input', { type: 'number', step: '0.1', min: '0', max: L.toFixed(2), value: it.km, 'aria-label': isKom ? 'Sommet (km)' : 'Position (km)' });
      km.addEventListener('change', () => { const x = Number(km.value); if (!isFinite(x)) return; it.km = +U.clamp(x, 0.1, L).toFixed(3); if (isKom) it.startKm = Math.min(it.startKm, it.km); changed(); if (isKom) foot.value = it.startKm; });
      const foot = isKom ? h('input', { type: 'number', step: '0.1', min: '0', max: L.toFixed(2), value: it.startKm, 'aria-label': 'Pied de la côte (km)' }) : null;
      if (foot) foot.addEventListener('change', () => { const x = Number(foot.value); if (!isFinite(x)) return; it.startKm = +U.clamp(x, 0, it.km).toFixed(3); foot.value = it.startKm; changed(); });
      const pts = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Points distribués, du premier au dernier', value: it.pts ? ptsText(it.pts) : '' });
      const defaultPts = () => ptsText(Cl.defaultScale(it.type, it.cat));
      const setPlaceholder = () => { pts.placeholder = defaultPts(); };
      pts.addEventListener('change', () => {
        const parsed = Cl.cleanPts(pts.value.split(/[\s,;]+/).filter(Boolean));
        if (parsed) it.pts = parsed; else delete it.pts;
        pts.value = it.pts ? ptsText(it.pts) : '';
        changed();
      });
      const cat = isKom ? h('select', { 'aria-label': 'Catégorie' }) : null;
      if (cat) {
        D.fillSelect(cat, Cl.CATS.map((c) => ({ id: c.id, label: c.name })), it.cat);
        cat.addEventListener('change', () => { it.cat = cat.value; setPlaceholder(); changed(); });
      }
      function updateEffect() {
        const bits = [];
        if (it.km > L + 0.001) bits.push('au-delà de l\'arrivée : ignoré');
        if (isKom) {
          const c = climbInfo(it);
          bits.push(c.len > 0 ? `${U.fmt(c.len / 1000, 1)} km à ${U.fmt((c.gain / c.len) * 100, 1)} % (+${U.fmt(c.gain, 0)} m), sommet à ${U.fmt(c.top, 0)} m` : 'pied et sommet confondus');
          const sug = c.cat ? Cl.catOf(c.cat).name : 'non classée';
          if (c.cat !== it.cat) bits.push(`d'après l'indice FIETS (${U.fmt(c.fiets, 1)}) : ${sug}`);
        } else bits.push(`altitude ${U.fmt(eleAtKm(it.km), 0)} m`);
        effect.textContent = bits.join(' · ');
      }
      const head = h('div', { class: 'portion-head' },
        PYR.classifView.cpBadge({ type: it.type, cat: it.cat }),
        h('strong', null, isKom ? 'Côte classée' : 'Sprint intermédiaire'),
        h('div', { class: 'km' }, ...(isKom ? [foot, h('span', null, '→')] : []), km, h('span', null, 'km')),
        ...headButtons('cp', it, list, 'checkpoints'));
      const card = h('div', { class: 'portion' + (activeId === it.id ? ' active' : ''), 'data-portion': it.id, style: { '--swatch': color } },
        head,
        h('div', { class: 'row' },
          isKom ? h('div', { class: 'field' }, h('label', null, 'Catégorie'), cat) : null,
          h('div', { class: 'field' }, h('label', null, 'Points distribués (1ᵉʳ, 2ᵉ…)'), pts)),
        effect);
      setPlaceholder();
      updateEffect();
      box.appendChild(card);
    }
  }

  function compass(w, onChange) {
    const S = D.svg;
    const needle = S('path', { class: 'needle', d: 'M32 8 L37 34 L32 30 L27 34 Z' });
    const g = S('g', null, needle);
    const svg = S('svg', { class: 'compass', viewBox: '0 0 64 64', role: 'img', 'aria-label': 'Provenance du vent' },
      S('circle', { class: 'ring', cx: 32, cy: 32, r: 30 }),
      S('text', { x: 32, y: 8 }, 'N'), S('text', { x: 57, y: 33 }, 'E'), S('text', { x: 32, y: 57 }, 'S'), S('text', { x: 7, y: 33 }, 'O'),
      g);
    // l'aiguille pointe vers la provenance du vent
    const set = () => g.setAttribute('transform', `rotate(${w.dir} 32 32)`);
    set();
    let drag = false;
    const pick = (e) => {
      const r = svg.getBoundingClientRect();
      const x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
      w.dir = Math.round(((U.toDeg(Math.atan2(x, -y)) + 360) % 360) / 5) * 5 % 360;
      set();
      onChange(true);
    };
    svg.addEventListener('pointerdown', (e) => { drag = true; svg.setPointerCapture(e.pointerId); pick(e); });
    svg.addEventListener('pointermove', (e) => { if (drag) pick(e); });
    svg.addEventListener('pointerup', () => { drag = false; onChange(false); });
    svg.update = set;
    return svg;
  }

  function windEffect(w) {
    const p = store.profile;
    if (!p) return '';
    const i0 = U.clamp(Math.floor(w.startKm * 1000 / p.step), 0, p.n - 2), i1 = U.clamp(Math.ceil(w.endKm * 1000 / p.step), 1, p.n - 1);
    if (i1 <= i0) return '';
    let head = 0, cross = 0, n = 0;
    const dir = U.toRad(w.dir);
    for (let i = i0; i < i1; i++) {
      const b = U.toRad(U.bearing(p.lat[i], p.lng[i], p.lat[i + 1], p.lng[i + 1]));
      head += Math.cos(dir - b); cross += Math.abs(Math.sin(dir - b)); n++;
    }
    head = (head / n) * w.speed; cross = (cross / n) * w.speed;
    const kind = head > 1 ? `vent de face ${U.fmt(head, 0)} km/h` : head < -1 ? `vent de dos ${U.fmt(-head, 0)} km/h` : 'ni de face ni de dos';
    return `Effet moyen sur la portion : ${kind}, latéral ${U.fmt(cross, 0)} km/h.`;
  }

  function renderWindList() {
    const box = $('#wind-list');
    D.clear(box);
    const list = store.state.winds;
    if (!list.length) { box.appendChild(h('div', { class: 'empty-list' }, 'Aucune portion : air calme partout.')); return; }
    for (const w of list) {
      const effect = h('p', { class: 'effect' });
      const dirIn = h('input', { type: 'number', min: '0', max: '359', step: '5', value: w.dir, 'aria-label': 'Provenance en degrés' });
      const card = h('div', { class: 'portion' + (activeId === w.id ? ' active' : ''), 'data-portion': w.id, style: { '--swatch': WIND_COLOR } });
      const dirLabel = h('label', null, `Provenance : ${U.cardinal(w.dir)}`);
      const changed = (live) => {
        dirIn.value = w.dir;
        dirLabel.textContent = `Provenance : ${U.cardinal(w.dir)}`;
        effect.textContent = windEffect(w);
        if (!live) { store.emit('winds'); store.save(); }
      };
      const cmp = compass(w, changed);
      dirIn.addEventListener('change', () => { w.dir = ((Number(dirIn.value) % 360) + 360) % 360; cmp.update(); changed(false); });
      const speed = h('input', { type: 'number', min: '0', max: '150', step: '1', value: w.speed, 'aria-label': 'Vitesse moyenne (km/h)' });
      speed.addEventListener('change', () => { w.speed = U.clamp(Number(speed.value) || 0, 0, 150); if (w.gust < w.speed) { w.gust = w.speed; gust.value = w.gust; } changed(false); });
      const gust = h('input', { type: 'number', min: '0', max: '200', step: '1', value: w.gust, disabled: !w.gusty, 'aria-label': 'Rafales (km/h)' });
      gust.addEventListener('change', () => { w.gust = Math.max(w.speed, Number(gust.value) || 0); gust.value = w.gust; changed(false); });
      const name = 'type-' + w.id;
      const rCont = h('input', { type: 'radio', name, checked: !w.gusty });
      const rGust = h('input', { type: 'radio', name, checked: !!w.gusty });
      rCont.addEventListener('change', () => { w.gusty = false; gust.disabled = true; changed(false); });
      rGust.addEventListener('change', () => { w.gusty = true; gust.disabled = false; if (w.gust <= w.speed) { w.gust = Math.round(w.speed * 1.8); gust.value = w.gust; } changed(false); });
      card.append(
        h('div', { class: 'portion-head' }, kmInputs(w, () => changed(false)), ...headButtons('wind', w, list, 'winds')),
        h('div', { class: 'row' },
          cmp,
          h('div', { class: 'field' }, dirLabel, dirIn),
          h('div', { class: 'field' }, h('label', null, 'Vitesse moyenne (km/h)'), speed)),
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('label', null, 'Type'), h('div', { class: 'radio-row' }, h('label', null, rCont, 'Continu'), h('label', null, rGust, 'En rafales'))),
          h('div', { class: 'field' }, h('label', null, 'Rafales jusqu\'à (km/h)'), gust)),
        effect);
      effect.textContent = windEffect(w);
      box.appendChild(card);
    }
  }

  PYR.tabRoute = T;
})(globalThis.PYR = globalThis.PYR || {});
