/* author : Hugo Joudrier-Faure */
/* PaceYourRide — surcouches de la carte : points d'eau, boulangeries et cafés, d'après OpenStreetMap (API Overpass, gratuite et sans clé).
 * Chaque surcouche se coche dans le contrôle des fonds de carte (en haut à droite) ; ce qui se trouve dans la zone visible est chargé au
 * déplacement de la carte, au-delà d'un niveau de zoom minimal (sinon la zone est trop grande). Le choix des surcouches est retenu (ui.poi). */
(function (PYR) {
  'use strict';

  const D = PYR.dom, store = PYR.store;
  const { h } = D;

  // Points d'eau potable : fontaines et robinets signalés buvables, sources, points de remplissage (sauf ceux notés « non potable »).
  const TYPES = {
    water: {
      label: 'Points d’eau', emoji: '💧', color: '#2a78d6', minZoom: 11, noun: 'point d’eau',
      query: (b) => `nwr["amenity"="drinking_water"]["drinking_water"!="no"]${b};nwr["natural"="spring"]["drinking_water"="yes"]${b};`
        + `nwr["amenity"="fountain"]["drinking_water"="yes"]${b};nwr["man_made"="water_tap"]["drinking_water"!="no"]${b};nwr["amenity"="water_point"]${b};`,
    },
    bakery: { label: 'Boulangeries', emoji: '🥖', color: '#c9822b', minZoom: 12, noun: 'boulangerie', query: (b) => `nwr["shop"="bakery"]${b};` },
    cafe: { label: 'Cafés', emoji: '☕', color: '#7b4a2a', minZoom: 12, noun: 'café', query: (b) => `nwr["amenity"="cafe"]${b};` },
  };
  const IDS = Object.keys(TYPES);
  const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const MAX_ITEMS = 2500;           // marqueurs gardés en mémoire par surcouche
  const LIMIT = 1000;               // éléments demandés par requête
  const TIMEOUT = 30000;

  let map = null, hint = null, hintEl = null, attributed = false;
  let queue = Promise.resolve();    // file des requêtes Overpass
  const S = {};                   // par surcouche : { layer, items (id → marqueur), bbox (zone déjà chargée), ctrl, error }

  /** Requête Overpass avec repli sur un second serveur. */
  async function overpass(ql, signal) {
    let last = null;
    for (const url of ENDPOINTS) {
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), TIMEOUT);
      const onAbort = () => ctrl.abort();
      signal.addEventListener('abort', onAbort);
      try {
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(ql), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) {
        if (signal.aborted) throw e;
        last = e;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    }
    throw last || new Error('Overpass indisponible');
  }

  function icon(t) {
    return L.divIcon({ className: '', html: `<div class="poi-icon" style="border-color:${t.color}">${t.emoji}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
  }

  /** Fenêtre d'un lieu : nom, horaires, et un lien vers sa fiche OpenStreetMap (le texte vient d'OpenStreetMap : jamais inséré comme HTML). */
  function popup(t, el) {
    const tg = el.tags || {};
    const rows = [h('b', null, tg.name || t.label.replace(/s$/, ''))];
    if (tg.opening_hours) rows.push(h('div', { class: 'poi-line' }, 'Horaires : ' + tg.opening_hours));
    if (tg.cuisine && tg.amenity === 'cafe') rows.push(h('div', { class: 'poi-line' }, 'Cuisine : ' + tg.cuisine));
    if (tg.drinking_water === 'yes' || tg.amenity === 'drinking_water') rows.push(h('div', { class: 'poi-line' }, 'Eau potable'));
    if (tg.seasonal === 'yes' || tg.seasonal === 'summer') rows.push(h('div', { class: 'poi-line' }, 'Saisonnier : peut être fermé hors saison'));
    if (tg.phone) rows.push(h('div', { class: 'poi-line' }, 'Tél. ' + tg.phone));
    rows.push(h('a', { class: 'poi-line', href: `https://www.openstreetmap.org/${el.type}/${el.id}`, target: '_blank', rel: 'noopener' }, 'Fiche OpenStreetMap'));
    return h('div', { class: 'poi-pop' }, ...rows);
  }

  function setHint(text, error) {
    if (!hintEl) return;
    hintEl.textContent = text || '';
    hintEl.hidden = !text;
    hintEl.classList.toggle('error', !!error);
  }

  /** Message d'état de la carte : zoom insuffisant, chargement en cours ou erreur. */
  function refreshHint() {
    const active = IDS.filter((id) => map.hasLayer(S[id].layer));
    if (!active.length) return setHint('');
    const z = map.getZoom();
    const far = active.filter((id) => z < TYPES[id].minZoom);
    const failed = active.some((id) => S[id].error);
    if (failed) return setHint('Données OpenStreetMap indisponibles pour le moment', true);
    if (active.some((id) => S[id].ctrl)) return setHint('Chargement…');
    if (far.length) return setHint('Zoome pour voir : ' + far.map((id) => TYPES[id].label.toLowerCase()).join(', '));
    setHint('');
  }

  async function load(id) {
    const st = S[id], t = TYPES[id];
    if (!map.hasLayer(st.layer) || map.getZoom() < t.minZoom) return;
    const view = map.getBounds();
    if (st.bbox && st.bbox.contains(view)) return;
    const want = view.pad(0.35);
    if (st.ctrl) st.ctrl.abort();
    const ctrl = st.ctrl = new AbortController();
    const b = `(${want.getSouth().toFixed(5)},${want.getWest().toFixed(5)},${want.getNorth().toFixed(5)},${want.getEast().toFixed(5)})`;
    st.error = false;
    refreshHint();
    // une requête à la fois : Overpass refuse ou ralentit les requêtes simultanées d'un même client
    queue = queue.then(() => run(id, st, t, ctrl, b, want));
  }

  async function run(id, st, t, ctrl, b, want) {
    if (ctrl.signal.aborted) return;
    try {
      const data = await overpass(`[out:json][timeout:25];(${t.query(b)});out center ${LIMIT};`, ctrl.signal);
      if (st.ctrl !== ctrl) return;
      if (st.items.size > MAX_ITEMS) { st.layer.clearLayers(); st.items.clear(); }
      for (const el of data.elements || []) {
        const lat = el.lat !== undefined ? el.lat : el.center && el.center.lat, lng = el.lon !== undefined ? el.lon : el.center && el.center.lon;
        const key = el.type + el.id;
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || st.items.has(key)) continue;
        const m = L.marker([lat, lng], { icon: icon(t), pane: 'poi', title: (el.tags && el.tags.name) || t.label, keyboard: false, riseOnHover: true });
        m.bindPopup(() => popup(t, el), { offset: [0, -6] });
        st.items.set(key, m);
        st.layer.addLayer(m);
      }
      st.bbox = want;
    } catch (e) {
      if (st.ctrl !== ctrl) return;          // remplacée par une requête plus récente
      st.error = true;
    } finally {
      if (st.ctrl === ctrl) st.ctrl = null;
      refreshHint();
    }
  }

  const refresh = () => { IDS.forEach(load); refreshHint(); };

  /** À appeler avant le contrôle des couches : crée les surcouches et renvoie {nom affiché → couche} pour L.control.layers. */
  function init(m) {
    map = m;
    map.createPane('poi').style.zIndex = 550;           // au-dessus du tracé et des surcouches, sous les points de passage (marqueurs : 600)
    const overlays = {};
    for (const id of IDS) {
      const t = TYPES[id];
      S[id] = { layer: L.layerGroup(), items: new Map(), bbox: null, ctrl: null, error: false };
      S[id].layer._poiId = id;
      overlays[`<span class="poi-lbl">${t.emoji} ${t.label}</span>`] = S[id].layer;
    }
    return overlays;
  }

  /** Rétablit les surcouches cochées la dernière fois, puis les tient à jour quand la carte bouge. */
  function start() {
    const saved = store.state.ui.poi || {};
    for (const id of IDS) if (saved[id]) S[id].layer.addTo(map);
    hint = L.control({ position: 'bottomleft' });
    hint.onAdd = () => { hintEl = D.h('div', { class: 'poi-hint', hidden: true }); return hintEl; };
    hint.addTo(map);
    const onChange = (e) => {
      const id = e.layer && e.layer._poiId;
      if (!id) return;
      store.state.ui.poi = Object.assign({}, store.state.ui.poi, { [id]: e.type === 'overlayadd' });
      store.save();
      if (e.type === 'overlayadd' && !attributed) {
        attributed = true;
        map.attributionControl.addAttribution('Points : &copy; contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> (Overpass)');
      }
      refresh();
    };
    map.on('overlayadd overlayremove', onChange);
    map.on('moveend', PYR.util.debounce(refresh, 400));
    if (IDS.some((id) => saved[id])) {
      attributed = true;
      map.attributionControl.addAttribution('Points : &copy; contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> (Overpass)');
    }
    refresh();
  }

  /** Pas de surcouches en mode jeu (la carte y sert de décor). */
  function setVisible(on) {
    if (map) map.getPane('poi').style.display = on ? '' : 'none';
    if (hintEl) hintEl.style.display = on ? '' : 'none';
  }

  PYR.mapPoi = { init, start, setVisible, TYPES };
})(globalThis.PYR = globalThis.PYR || {});
