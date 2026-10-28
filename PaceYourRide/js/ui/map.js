/* author : Hugo Joudrier-Faure */
/* PaceYourRide — carte Leaflet : fonds, tracé, points de passage, portions, marqueurs.
 * Mode jeu, peloton en deux dimensions : chaque coureur à sa place sur la largeur de la route ; la carte zoome au-delà du zoom
 * natif des tuiles (agrandies) jusqu'à GAME_MAX_ZOOM, la route est dessinée à sa largeur et, de près, les coureurs à l'échelle
 * (vélo et cycliste vus de dessus, orientés dans le sens de la route). Le mode jeu peut aussi garder la carte orientée dans le
 * sens de la marche (setHeadingUp), comme la page Sortie : l'élément carte, tourné, est agrandi jusqu'à sa diagonale. */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store;
  const GAME_MAX_ZOOM = 22;  // mode jeu : zoom maximal (≈ 3 cm par pixel), tuiles agrandies au-delà de leur zoom natif
  const SCALE_ZOOM = 19;     // à partir de ce zoom, les coureurs sont dessinés à l'échelle
  const ROAD_ZOOM = 17;      // à partir de ce zoom, la route est dessinée à sa largeur
  const CLOSE_ZOOM = 21;     // « Zoom peloton »

  const BASE_LAYERS = [
    { id: 'osm', label: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
    { id: 'carto', label: 'CARTO Voyager', url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', maxZoom: 20, subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>' },
    { id: 'cyclosm', label: 'CyclOSM (vélo)', url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', maxZoom: 20, subdomains: 'abc',
      attribution: '<a href="https://www.cyclosm.org">CyclOSM</a> | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
    { id: 'topo', label: 'OpenTopoMap (relief)', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', maxZoom: 17, subdomains: 'abc',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a>' },
    { id: 'ign', label: 'IGN Plan (France)', url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/png&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', maxZoom: 19,
      attribution: '&copy; <a href="https://www.ign.fr">IGN</a>' },
    { id: 'sat', label: 'Satellite (Esri)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19,
      attribution: 'Imagerie &copy; Esri' },
  ];

  /** Rampe séquentielle « chaleur » pour la puissance (avec légende). */
  const HEAT = ['#fde6a8', '#fbc463', '#f59a3b', '#e8672a', '#cc3d20', '#9c2217', '#6a1510'];
  function heatColor(f) {
    f = U.clamp(f, 0, 0.9999);
    return HEAT[Math.floor(f * HEAT.length)];
  }

  const M = {
    map: null,
    mode: 'grade',   // 'grade' | 'power' | 'plain' | 'game'
    layers: {},
    drawEnabled: true,
  };

  M.init = function () {
    const map = L.map('map', { zoomControl: true, preferCanvas: false, worldCopyJump: true });
    M.map = map;
    M.renderer = L.canvas({ padding: 0.5, tolerance: 6 });
    // trait reliant l'épingle du départ et de l'arrivée à son point : au-dessus du tracé (400), sous les points et les drapeaux (marqueurs : 600)
    map.createPane('wpLeaders').style.zIndex = 450;
    map.getPane('wpLeaders').style.pointerEvents = 'none';

    const bases = {};
    for (const b of BASE_LAYERS) {
      // au-delà de son zoom natif, la tuile est agrandie (mode jeu : zoom peloton) ; ailleurs, la carte s'arrête au zoom natif (applyMaxZoom)
      bases[b.label] = L.tileLayer(b.url, { maxZoom: GAME_MAX_ZOOM, maxNativeZoom: b.maxZoom, subdomains: b.subdomains || 'abc', attribution: b.attribution, crossOrigin: true });
      bases[b.label]._pyrId = b.id;
    }
    // Fond par défaut : OpenStreetMap. Il exige un en-tête Referer (politique d'usage des tuiles) : sans lui —
    // fichier local, hébergement qui le supprime — les tuiles sont bloquées. On bascule alors sur CARTO,
    // sans retenir ce choix : OpenStreetMap reste le fond par défaut à la prochaine ouverture.
    const wanted = store.state.ui.baseLayer || 'osm';
    const first = BASE_LAYERS.find((b) => b.id === wanted) || BASE_LAYERS[0];
    bases[first.label].addTo(map);
    const osmLayer = bases[BASE_LAYERS[0].label], cartoLayer = bases[BASE_LAYERS[1].label];
    let osmErrors = 0;
    osmLayer.on('tileerror', () => {
      if (++osmErrors < 3 || !map.hasLayer(osmLayer)) return;
      map.removeLayer(osmLayer);
      cartoLayer.addTo(map);
    });
    // surcouches : points d'eau, boulangeries et cafés (map-poi.js), cochés dans ce même contrôle
    const overlays = PYR.mapPoi ? PYR.mapPoi.init(map) : null;
    L.control.layers(bases, overlays, { position: 'topright' }).addTo(map);
    // choix du fond depuis l'extérieur (bouton du mode jeu, où le contrôle de Leaflet est masqué) ; la sauvegarde passe par « baselayerchange »
    M.baseLayers = BASE_LAYERS.map((b) => ({ id: b.id, label: b.label }));
    M.baseId = () => { for (const b of BASE_LAYERS) if (map.hasLayer(bases[b.label])) return b.id; return first.id; };
    M.baseSpec = () => BASE_LAYERS.find((b) => b.id === M.baseId()) || BASE_LAYERS[0];     // fond affiché (url, attribution), pour les cartes annexes
    M.setBase = (id) => {
      const pick = BASE_LAYERS.find((b) => b.id === id);
      if (!pick) return;
      for (const b of BASE_LAYERS) if (b !== pick && map.hasLayer(bases[b.label])) map.removeLayer(bases[b.label]);
      if (!map.hasLayer(bases[pick.label])) bases[pick.label].addTo(map);
    };
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    map.on('baselayerchange', (e) => { store.state.ui.baseLayer = e.layer._pyrId; store.save(); M.applyMaxZoom(); });
    M.applyMaxZoom();

    M.layers.road = L.layerGroup().addTo(map); // mode jeu, peloton en 2D : la route à sa largeur, sous le tracé
    M.layers.surfaces = L.layerGroup().addTo(map);
    M.layers.route = L.layerGroup().addTo(map);
    M.layers.progress = L.layerGroup().addTo(map);
    M.layers.winds = L.layerGroup().addTo(map);
    M.layers.waypoints = L.layerGroup().addTo(map);
    M.layers.checkpoints = L.layerGroup().addTo(map);
    M.layers.sections = L.layerGroup().addTo(map);
    M.layers.weather = L.layerGroup().addTo(map);
    M.layers.socks = L.layerGroup().addTo(map);
    M.layers.markers = L.layerGroup().addTo(map);

    const ui = store.state.ui;
    if (ui.center && ui.zoom) map.setView(ui.center, ui.zoom);
    else map.setView([45.9, 6.12], 10);
    if (PYR.mapPoi) PYR.mapPoi.start();      // surcouches : après la vue initiale (elles chargent ce qui est visible)
    map.on('moveend', U.debounce(() => {
      const c = map.getCenter();
      ui.center = [+c.lat.toFixed(5), +c.lng.toFixed(5)];
      ui.zoom = map.getZoom();
      store.save();
    }, 300));

    map.on('zoomend', () => { M.refreshWindsocks(); M.styleRoad(); });

    map.on('click', (e) => {
      // découpage du plan en tronçons : un clic près du tracé y ajoute une limite
      if (M.sectionEditor && store.state.ui.tab === 'perf') {
        const s = M.nearestDistance(e.latlng), ll = s === null ? null : M.latLngAt(s);
        if (ll && map.latLngToContainerPoint(ll).distanceTo(e.containerPoint) <= 16) M.sectionEditor.onAdd(Math.round(s));
        return;
      }
      if (!M.drawEnabled || store.state.ui.tab !== 'route') return;
      PYR.routeModel.add(e.latlng);
    });

    M.hoverMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="hover-icon"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false, keyboard: false });

    // Légende de la carte (pente / puissance)
    M.legend = L.control({ position: 'bottomright' });
    M.legend.onAdd = () => { M.legendEl = D.h('div', { class: 'map-legend' }); return M.legendEl; };
    M.legend.addTo(map);

    store.on('route-geometry', () => { M.drawWaypoints(); M.drawRoute(); });
    store.on('profile', () => { M.drawRoute(); M.drawPortions(); });
    store.on('surfaces', () => M.drawPortions());
    store.on('winds', () => M.drawPortions());
    store.on('plan', () => { if (M.mode === 'power') M.drawRoute(); });
  };

  /** Zoom maximal : celui du fond de carte, ou GAME_MAX_ZOOM en mode jeu (tuiles agrandies, pour voir le peloton de près). */
  M.applyMaxZoom = function () {
    if (!M.map || !M.baseSpec) return;
    M.map.setMaxZoom(M.mode === 'game' ? GAME_MAX_ZOOM : M.baseSpec().maxZoom);
  };

  M.setMode = function (mode) {
    M.mode = mode;
    M.applyMaxZoom();
    // mode jeu : les flèches du clavier changent de rang ou de puissance, pas la vue de la carte
    if (M.map.keyboard) { if (mode === 'game') M.map.keyboard.disable(); else M.map.keyboard.enable(); }
    if (PYR.mapPoi) PYR.mapPoi.setVisible(mode !== 'game');
    M.drawRoute();
    M.drawWaypoints();
    M.drawPortions();
  };

  M.fit = function () {
    const p = store.profile;
    const wps = store.state.route.waypoints;
    let pts = [];
    if (p) for (let i = 0; i < p.n; i += Math.max(1, Math.floor(p.n / 400))) pts.push([p.lat[i], p.lng[i]]);
    else pts = wps.map((w) => [w.lat, w.lng]);
    // onglet Parcours : les outils de tracé couvrent le haut de la carte
    const tools = store.state.ui.tab === 'route' ? D.$('#route-tools') : null;
    const top = tools && tools.offsetHeight ? tools.offsetTop + tools.offsetHeight + 16 : 30;
    if (pts.length >= 2) M.map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [30, top], paddingBottomRight: [30, 30] });
    else if (pts.length === 1) M.map.setView(pts[0], 14);
  };

  /* ---------- Points de passage ---------- */
  /**
   * Départ et arrivée : un petit point posé sur le tracé (de la taille d'un point de passage, pour le saisir ou le supprimer
   * précisément) et, reliée à lui par un trait, une épingle « D » / « A » déportée : à gauche pour le départ, à droite pour l'arrivée,
   * pour ne pas se chevaucher sur une boucle. L'épingle fait partie du même marqueur : la toucher agit sur le même point.
   */
  const PIN = 30;      // décalage de l'épingle (px) : vers le haut, et de côté
  function wpIcon(kind, n) {
    if (kind === 'start' || kind === 'end') {
      const dx = kind === 'start' ? -PIN : PIN, dy = -PIN - 4, c = 7;      // c : centre du point (14 px)
      const html = `<div class="wp-pin wp-pin-${kind}">`
        + `<span class="wp-pin-badge" style="left:${c + dx - 12}px;top:${c + dy - 12}px">${kind === 'start' ? 'D' : 'A'}</span></div>`;
      return L.divIcon({ className: '', html, iconSize: [14, 14], iconAnchor: [7, 7] });
    }
    return L.divIcon({ className: '', html: '<div class="wp-icon wp-mid" title="Point ' + n + '"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
  }

  /** Trait de l'épingle, dans son propre volet (sous les marqueurs) : il part du point GPS et suit le décalage de l'épingle. */
  function leaderMarker(kind, latlng) {
    const dx = kind === 'start' ? -PIN : PIN, dy = -PIN - 4;
    const html = `<svg class="wp-pin-leader" width="1" height="1" aria-hidden="true"><line x1="0" y1="0" x2="${dx}" y2="${dy}"/></svg>`;
    return L.marker(latlng, { icon: L.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] }), pane: 'wpLeaders', interactive: false, keyboard: false });
  }

  M.drawWaypoints = function () {
    const g = M.layers.waypoints;
    g.clearLayers();
    if (M.mode === 'game') return;
    const wps = store.state.route.waypoints;
    const editable = store.state.ui.tab === 'route';
    wps.forEach((w, i) => {
      const kind = i === 0 ? 'start' : i === wps.length - 1 ? 'end' : 'mid';
      const loopEnd = i === wps.length - 1 && wps.length > 2 && U.haversine(w.lat, w.lng, wps[0].lat, wps[0].lng) < 5;
      const m = L.marker([w.lat, w.lng], {
        icon: wpIcon(loopEnd ? 'end' : kind, i), draggable: editable, keyboard: false, zIndexOffset: kind === 'mid' ? 0 : 500,
        title: kind === 'start' ? 'Départ' : kind === 'end' ? 'Arrivée' : `Point ${i}`,
      });
      let leader = null;
      if (kind !== 'mid') { leader = leaderMarker(loopEnd ? 'end' : kind, m.getLatLng()); g.addLayer(leader); m.on('drag', (e) => leader.setLatLng(e.latlng)); }
      m.on('dragend', (e) => PYR.routeModel.move(i, e.target.getLatLng()));
      m.on('contextmenu', (e) => { L.DomEvent.stop(e); if (editable) PYR.routeModel.remove(i); });
      m.on('click', (e) => {
        L.DomEvent.stop(e);
        if (!editable) return;
        const pop = D.h('div', null,
          D.h('div', { style: { marginBottom: '6px', fontWeight: 600 } }, kind === 'start' ? 'Départ' : kind === 'end' ? 'Arrivée' : `Point de passage ${i}`),
          D.h('button', { class: 'btn small danger', onclick: () => { M.map.closePopup(); PYR.routeModel.remove(i); } }, 'Supprimer ce point'));
        L.popup({ offset: [0, -6] }).setLatLng(m.getLatLng()).setContent(pop).openOn(M.map);
      });
      // appui long (mobile) = suppression
      let timer = null;
      m.on('touchstart', () => { timer = setTimeout(() => { if (editable) PYR.routeModel.remove(i); }, 700); });
      m.on('touchend touchmove', () => clearTimeout(timer));
      g.addLayer(m);
    });
  };

  /* ---------- Tracé ---------- */
  M.drawRoute = function () {
    const g = M.layers.route;
    g.clearLayers();
    const p = store.profile;
    const legs = store.state.route.legs;
    const renderer = M.renderer;
    const casing = { color: '#ffffff', weight: 9, opacity: 0.9, renderer, interactive: false };
    const pendingStyle = { color: '#2a78d6', weight: 4, opacity: 0.6, renderer, interactive: false };

    if (!p) {
      // tronçons déjà connus (le profil complet n'est pas encore prêt)
      for (const leg of legs) {
        const c = leg.coords ? leg.coords.map((x) => [x[0], x[1]]) : [[leg.from.lat, leg.from.lng], [leg.to.lat, leg.to.lng]];
        g.addLayer(L.polyline(c, casing));
        g.addLayer(L.polyline(c, leg.coords ? Object.assign({}, pendingStyle, { opacity: 0.9 }) : pendingStyle));
      }
      M.updateLegend();
      return;
    }

    const all = [];
    for (let i = 0; i < p.n; i++) all.push([p.lat[i], p.lng[i]]);
    g.addLayer(L.polyline(all, casing));

    const plan = store.plan;
    if (M.mode === 'power' && plan && !store.planStale) {
      // couleur = puissance moyenne sur chaque ~100 m
      const S = plan.series;
      const pmax = Math.max(plan.cp * 1.5, 1);
      const chunk = Math.max(2, Math.round(100 / p.step));
      let t = 0;
      for (let i = 0; i < p.n - 1; i += chunk) {
        const a = i * p.step, b = Math.min(p.n - 1, i + chunk) * p.step;
        let sum = 0, cnt = 0;
        while (t < S.P.length && S.s[t] < a) t++;
        let k = t;
        while (k < S.P.length && S.s[k] < b) { sum += S.P[k]; cnt++; k++; }
        const P = cnt ? sum / cnt : (k < S.P.length ? S.P[k] : 0);
        const seg = all.slice(i, Math.min(p.n, i + chunk + 1));
        g.addLayer(L.polyline(seg, { color: heatColor(P / pmax), weight: 5, opacity: 1, renderer, interactive: false }));
      }
    } else if (M.mode === 'grade') {
      // couleur = pente par tronçons de même classe (~50 m)
      const chunk = Math.max(2, Math.round(50 / p.step));
      let cur = null, seg = [];
      for (let i = 0; i < p.n - 1; i += chunk) {
        const j = Math.min(p.n - 1, i + chunk);
        const gcol = PYR.charts.gradeColor((p.ele[j] - p.ele[i]) / ((j - i) * p.step));
        if (gcol !== cur && seg.length) {
          seg.push(all[i]);
          g.addLayer(L.polyline(seg, { color: cur, weight: 5, opacity: 1, renderer, interactive: false }));
          seg = [];
        }
        cur = gcol;
        for (let k = i; k < j; k++) seg.push(all[k]);
      }
      seg.push(all[p.n - 1]);
      if (seg.length > 1) g.addLayer(L.polyline(seg, { color: cur, weight: 5, opacity: 1, renderer, interactive: false }));
    } else {
      g.addLayer(L.polyline(all, { color: '#2a78d6', weight: 5, opacity: 1, renderer, interactive: false }));
    }

    // couche de capture (survol → profil, clic → insertion d'un point)
    const hit = L.polyline(all, { color: '#000', opacity: 0, weight: 16, renderer, interactive: true });
    hit.on('mousemove', (e) => {
      const s = M.nearestDistance(e.latlng);
      if (s !== null) store.emit('hover', { s, from: 'map' });
    });
    hit.on('mouseout', () => store.emit('hover', { s: null, from: 'map' }));
    hit.on('click', (e) => {
      L.DomEvent.stop(e);
      if (store.state.ui.tab !== 'route' || !M.drawEnabled) return;
      const leg = PYR.routeModel.isFixed ? -1 : PYR.routeModel.nearestLeg(e.latlng);
      if (leg >= 0 || PYR.routeModel.isFixed) PYR.routeModel.insert(leg, e.latlng);
    });
    g.addLayer(hit);

    // tronçons en cours de recalcul
    for (const leg of legs) {
      if (leg.coords) continue;
      g.addLayer(L.polyline([[leg.from.lat, leg.from.lng], [leg.to.lat, leg.to.lng]], pendingStyle));
    }
    M.updateLegend();
  };

  /** Distance (m) le long du profil du point le plus proche de latlng. */
  M.nearestDistance = function (latlng) {
    const p = store.profile;
    if (!p) return null;
    const kx = Math.cos(U.toRad(latlng.lat));
    let best = 0, bestD = Infinity;
    const stride = Math.max(1, Math.floor(p.n / 4000));
    for (let i = 0; i < p.n; i += stride) {
      const dy = p.lat[i] - latlng.lat, dx = (p.lng[i] - latlng.lng) * kx;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    // affinage local
    for (let i = Math.max(0, best - stride); i < Math.min(p.n, best + stride); i++) {
      const dy = p.lat[i] - latlng.lat, dx = (p.lng[i] - latlng.lng) * kx;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best * p.step;
  };

  /**
   * Garde un point au centre de la carte, sans animation (caméra qui suit, appelée à chaque image).
   * Leaflet déplace la carte par pixels entiers et, à chaque fin de déplacement (« moveend »), redessine tous
   * les tracés du canevas et recharge les tuiles : trop lourd à 60 images/s. On décale donc directement le volet
   * de la carte (le canevas déborde d'une demi-fenêtre de chaque côté) et on ne termine le déplacement
   * que de temps en temps.
   */
  const FOLLOW_SETTLE_MS = 400;
  let followSettled = 0;
  /**
   * Décalage {x, y} (pixels) du point suivi par rapport au centre de la carte : l'écran de course mobile y superpose le HUD et
   * les réserves, et le cycliste reste au milieu de la zone libre. La caméra le rejoint en douceur (ouverture d'une feuille).
   */
  M.followOffset = null;
  const offsetNow = { x: 0, y: 0 };
  M.follow = function (latlng) {
    if (!latlng || M.map._animatingZoom) return; // pas pendant une animation de zoom (la vue n'est pas encore à son nouveau zoom)
    const map = M.map, size = map.getSize();
    const want = M.followOffset || { x: 0, y: 0 };
    // carte tournée : le cycliste est placé plus bas sur l'écran (on voit plus de route devant lui)
    const ahead = head.angle === null ? 0 : 0.18 * Math.min(head.w || 300, head.h || 300);
    offsetNow.x += (want.x - offsetNow.x) * 0.15;
    offsetNow.y += (want.y + ahead - offsetNow.y) * 0.15;
    let ox = offsetNow.x, oy = offsetNow.y;
    if (head.angle !== null) { // décalage d'écran → repère de la carte (tournée de −angle)
      const a = (head.angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
      ox = offsetNow.x * ca - offsetNow.y * sa; oy = offsetNow.x * sa + offsetNow.y * ca;
    }
    const c = map.latLngToContainerPoint(latlng);
    const dx = Math.trunc(c.x - (size.x / 2 + ox)), dy = Math.trunc(c.y - (size.y / 2 + oy));
    const now = performance.now();
    if (!dx && !dy) { if (followSettled && now - followSettled > FOLLOW_SETTLE_MS) { followSettled = 0; map.fire('moveend'); } return; }
    // très loin du centre (carte déplacée à la main, premier affichage), ou volet interne indisponible : déplacement complet
    if (Math.abs(dx) > size.x / 2 || Math.abs(dy) > size.y / 2 || typeof map._rawPanBy !== 'function') {
      map.panBy([dx, dy], { animate: false });
      followSettled = 0;
      return;
    }
    map._rawPanBy([dx, dy]);
    map.fire('move');
    if (!followSettled) followSettled = now;
    else if (now - followSettled > FOLLOW_SETTLE_MS) { followSettled = 0; map.fire('moveend'); }
  };
  /* ---------- carte orientée dans le sens de la marche (mode jeu) ---------- */
  const head = { angle: null, last: 0, key: '', dimAt: 0, w: 0, h: 0, saved: null };

  /** Mode jeu : place l'orientation voulue de la carte (° , cap vers le haut de l'écran) ou null pour le nord en haut. */
  function layoutHeading(angle) {
    const map = M.map, el = map.getContainer(), box = el.parentElement, rot = angle !== null;
    const nowMs = performance.now();
    if (!head.dimAt || nowMs - head.dimAt > 500) { head.dimAt = nowMs; head.w = box.clientWidth; head.h = box.clientHeight; } // mesures : pas à chaque image
    const key = rot ? head.w + 'x' + head.h : '';
    if (box.classList.contains('rot') !== rot) {
      box.classList.toggle('rot', rot);
      // les commandes de la carte (zoom, attribution) sortent de l'élément tourné pour rester droites aux coins visibles
      const cc = map._controlContainer;
      if (cc) (rot ? box : el).appendChild(cc);
      // pas de déplacement à la main (la caméra suit), zoom autour du centre : ni l'un ni l'autre ne tient compte de la rotation
      if (rot) {
        head.saved = { wheel: map.options.scrollWheelZoom, touch: map.options.touchZoom, drag: map.dragging.enabled() };
        map.options.scrollWheelZoom = 'center'; map.options.touchZoom = 'center'; map.dragging.disable();
      } else if (head.saved) {
        map.options.scrollWheelZoom = head.saved.wheel; map.options.touchZoom = head.saved.touch;
        if (head.saved.drag) map.dragging.enable();
        head.saved = null;
      }
    }
    if (head.key !== key) {
      head.key = key;
      const s = el.style;
      if (rot) {
        const D = Math.ceil(Math.hypot(head.w, head.h));
        s.right = s.bottom = 'auto'; s.width = s.height = D + 'px'; s.left = (head.w - D) / 2 + 'px'; s.top = (head.h - D) / 2 + 'px';
      } else { s.right = s.bottom = s.width = s.height = s.left = s.top = s.transform = ''; }
      map.invalidateSize({ animate: false });
    }
    if (rot) el.style.transform = `rotate(${-angle}deg)`;
    el.style.setProperty('--rot', rot ? `${angle}deg` : '0deg'); // les étiquettes des marqueurs se contre-tournent (voir style.css)
    box.style.setProperty('--north', rot ? `${-angle}deg` : '0deg'); // l'aiguille de la boussole montre où est le nord
  }

  /**
   * Mode jeu : la carte tourne pour que la route devant le cycliste (distance s, un peu en avance) soit vers le haut, avec une
   * constante de temps de 0,3 s ; null remet le nord en haut (et la carte dans son état d'origine).
   */
  M.setHeadingUp = function (s) {
    if (s === null || s === undefined || !store.profile || !PYR.nav) {
      if (head.angle !== null || M.map.getContainer().parentElement.classList.contains('rot')) layoutHeading(null);
      head.angle = null; head.last = 0;
      return;
    }
    const p = store.profile, now = performance.now();
    const dt = head.last ? Math.min(0.25, (now - head.last) / 1000) : 0.25;
    head.last = now;
    const target = PYR.nav.bearingAt(p, U.clamp(s + 25, 0, p.length));
    const prev = head.angle === null ? target : head.angle;
    head.angle = prev + (((target - prev + 540) % 360) - 180) * (1 - Math.exp(-dt / 0.3));
    layoutHeading(head.angle);
  };
  M.headingAngle = () => head.angle;

  /** Termine le déplacement de la caméra en cours (pause, arrivée, changement d'onglet). */
  M.followSettle = function () {
    if (!followSettled) return;
    followSettled = 0;
    M.map.fire('moveend');
  };
  /** Position sur le tracé à la distance s ; y (m, + = à droite) : décalée sur la largeur de la route (peloton en 2D). */
  M.latLngAt = function (s, y) {
    const p = store.profile;
    if (!p) return null;
    if (y !== undefined && y !== null && PYR.nav) return PYR.nav.offsetAt(p, s, y);
    const x = U.clamp(s / p.step, 0, p.n - 1);
    const i = Math.min(p.n - 2, Math.floor(x)), f = x - i;
    return [p.lat[i] + (p.lat[i + 1] - p.lat[i]) * f, p.lng[i] + (p.lng[i + 1] - p.lng[i]) * f];
  };

  M.showHover = function (s) {
    if (s === null || s === undefined || !store.profile) { M.hoverMarker.remove(); return; }
    M.hoverMarker.setLatLng(M.latLngAt(s));
    if (!M.map.hasLayer(M.hoverMarker)) M.hoverMarker.addTo(M.map);
  };

  /* ---------- Portions ---------- */
  M.drawPortions = function () {
    M.layers.surfaces.clearLayers();
    M.layers.winds.clearLayers();
    const p = store.profile;
    if (!p || M.mode === 'game') return;
    const slice = (a, b) => {
      const i0 = U.clamp(Math.floor(a / p.step), 0, p.n - 1), i1 = U.clamp(Math.ceil(b / p.step), 0, p.n - 1);
      const out = [];
      for (let i = i0; i <= i1; i++) out.push([p.lat[i], p.lng[i]]);
      return out;
    };
    for (const sp of store.state.surfaces) {
      const pts = slice(sp.startKm * 1000, sp.endKm * 1000);
      if (pts.length < 2) continue;
      const color = PYR.tabRoute ? PYR.tabRoute.surfaceColor(sp) : '#8a5a2b';
      const line = L.polyline(pts, { color, weight: 15, opacity: 0.55, renderer: M.renderer, interactive: false });
      M.layers.surfaces.addLayer(line);
    }
    for (const w of store.state.winds) {
      const a = w.startKm * 1000, b = Math.min(w.endKm * 1000, p.length);
      if (b <= a) continue;
      const count = Math.max(1, Math.min(8, Math.round((b - a) / 3000)));
      for (let k = 0; k < count; k++) {
        const s = a + ((k + 0.5) / count) * (b - a);
        const pos = M.latLngAt(s);
        // la flèche pointe vers où souffle le vent (provenance + 180°)
        const rot = (Number(w.dir) + 180) % 360;
        const size = 26 + Math.min(14, Number(w.speed) / 3);
        const html = `<div class="wind-arrow" style="transform: rotate(${rot}deg); width:${size}px; height:${size}px">` +
          `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M12 2 L18 12 L13.5 11 L13.5 22 L10.5 22 L10.5 11 L6 12 Z" fill="currentColor"/></svg></div>`;
        const mk = L.marker(pos, {
          icon: L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
          interactive: true, keyboard: false,
          title: `Vent de ${U.cardinal(w.dir)} (${Math.round(w.dir)}°), ${w.speed} km/h${w.gusty ? `, rafales ${w.gust} km/h` : ''}`,
        });
        M.layers.winds.addLayer(mk);
      }
    }
  };

  M.updateLegend = function () {
    const el = M.legendEl;
    if (!el) return;
    D.clear(el);
    if (!store.profile) { el.hidden = true; return; }
    el.hidden = false;
    if (M.mode === 'power' && store.plan && !store.planStale) {
      el.appendChild(D.h('div', null, 'Puissance planifiée'));
      el.appendChild(D.h('div', { class: 'bar', style: { background: `linear-gradient(90deg, ${HEAT.join(',')})` } }));
      const pmax = store.plan.cp * 1.5;
      el.appendChild(D.h('div', { class: 'ticks' }, D.h('span', null, '0 W'), D.h('span', null, `PC ${Math.round(store.plan.cp)}`), D.h('span', null, `≥ ${Math.round(pmax)} W`)));
    } else if (M.mode === 'grade') {
      const cls = PYR.charts.GRADE_CLASSES;
      el.appendChild(D.h('div', null, 'Pente'));
      el.appendChild(D.h('div', { class: 'bar', style: { background: `linear-gradient(90deg, ${cls.map((c) => c.color).join(',')})` } }));
      el.appendChild(D.h('div', { class: 'ticks' }, D.h('span', null, '−8 %'), D.h('span', null, '0'), D.h('span', null, '+14 %')));
    } else el.hidden = true;
  };

  /* ---------- Marqueurs du jeu ---------- */
  M.gameMarkers = { rider: null, others: new Map() };

  /** Pixels par mètre au zoom courant, à la latitude lat (tuiles de 256 px). */
  function pxPerMeter(lat) {
    return Math.pow(2, M.map.getZoom()) / (156543.03392 * Math.cos((lat * Math.PI) / 180));
  }

  /**
   * Vue de près (mode jeu, à partir de SCALE_ZOOM) : coureurs dessinés à l'échelle (classe .to-scale et --ppm, pixels par mètre,
   * sur la carte). Renvoie vrai si elle est active.
   */
  function scaleView(lat) {
    const box = M.map.getContainer();
    const on = M.mode === 'game' && M.map.getZoom() >= SCALE_ZOOM && Number.isFinite(lat);
    if (on !== box.classList.contains('to-scale')) box.classList.toggle('to-scale', on);
    if (on) {
      const ppm = pxPerMeter(lat).toFixed(2);
      if (box.style.getPropertyValue('--ppm') !== ppm) box.style.setProperty('--ppm', ppm);
    }
    return on;
  }

  /** Oriente le vélo d'un marqueur dans le sens de la route à la distance s (vue de près). */
  function headTo(el, s) {
    if (!el || !store.profile || !PYR.nav) return;
    const hd = Math.round((PYR.nav.headingAt(store.profile, s) * 180) / Math.PI);
    if (el._pyrHd !== hd) { el._pyrHd = hd; el.style.setProperty('--hd', hd + 'deg'); }
  }

  /**
   * others : [{id, name, color, s, y}] — fantômes, coureurs virtuels et adversaires en direct (noms insérés en texte) ;
   * riderY, y : position latérale (m, peloton en 2D ; absente : sur le tracé).
   */
  const LABELS_ALL = 12, LABELS_NEAR = 6; // au-delà de 12 autres coureurs, on ne nomme que les 6 plus proches
  M.setGameMarkers = function (riderS, others, riderY) {
    const g = M.layers.markers;
    if (riderS === null) { g.clearLayers(); M.gameMarkers = { rider: null, others: new Map() }; M.map.getContainer().classList.remove('to-scale'); return; }
    if (!M.gameMarkers.rider) {
      // avec une photo d'avatar (onglet Cycliste), le marqueur du joueur la montre, plus grande ; de près, son vélo à l'échelle
      const photo = PYR.avatar ? PYR.avatar.get() : '';
      const dot = photo ? D.h('div', { class: 'rider-icon avatar', style: { backgroundImage: `url("${photo}")` } }) : D.h('div', { class: 'rider-icon' });
      const el = D.h('div', { class: 'me-icon', style: { '--c': '#eb6834' } }, dot, D.h('i', { class: 'bk' }));
      el.style.setProperty('--c', '#eb6834');
      const px = photo ? 34 : 22;
      M.gameMarkers.rider = L.marker([0, 0], { icon: L.divIcon({ className: '', html: el, iconSize: [px, px], iconAnchor: [px / 2, px / 2] }), interactive: false, zIndexOffset: 1000 });
      g.addLayer(M.gameMarkers.rider);
    }
    const here = M.latLngAt(riderS, riderY);
    M.gameMarkers.rider.setLatLng(here);
    const near = here ? scaleView(here[0]) : false;
    if (near) headTo(M.gameMarkers.rider.getElement() && M.gameMarkers.rider.getElement().firstElementChild, riderS);
    const seen = new Set();
    // gros peloton : seuls les coureurs les plus proches du joueur affichent leur nom
    let named = null;
    const crowd = !!others && others.length > LABELS_ALL;
    if (crowd !== M.map.getContainer().classList.contains('crowd')) M.map.getContainer().classList.toggle('crowd', crowd);
    if (crowd) {
      named = new Set(others.filter((o) => isFinite(o.s)).sort((a, b) => Math.abs(a.s - riderS) - Math.abs(b.s - riderS)).slice(0, LABELS_NEAR).map((o) => o.id));
    }
    for (const o of others || []) {
      if (o.s === null || o.s === undefined || !isFinite(o.s)) continue;
      seen.add(o.id);
      let mk = M.gameMarkers.others.get(o.id);
      if (!mk) {
        const el = D.h('div', { class: 'opp-icon', style: { '--c': o.color } }, D.h('span'), D.h('i', { class: 'bk' }), D.h('b', null, o.name));
        el.style.setProperty('--c', o.color);
        mk = L.marker([0, 0], { icon: L.divIcon({ className: '', html: el, iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, keyboard: false, zIndexOffset: 900 });
        g.addLayer(mk);
        M.gameMarkers.others.set(o.id, mk);
      }
      // arrêtés ou arrivés : rien à déplacer
      if (mk._pyrS !== o.s || mk._pyrY !== o.y) { mk._pyrS = o.s; mk._pyrY = o.y; mk.setLatLng(M.latLngAt(o.s, o.y)); }
      if (near) headTo(mk.getElement() && mk.getElement().firstElementChild, o.s);
      const label = !named || named.has(o.id);
      if (mk._pyrLabel !== label) {
        mk._pyrLabel = label;
        const el = mk.getElement() && mk.getElement().firstElementChild; // le .opp-icon dans l'icône Leaflet
        if (el) el.classList.toggle('no-label', !label);
      }
    }
    for (const [id, mk] of M.gameMarkers.others) {
      if (!seen.has(id)) { g.removeLayer(mk); M.gameMarkers.others.delete(id); }
    }
  };

  /** Points de passage de la course (mode jeu) : sprints, sommets classés, arrivée. null pour effacer. */
  M.setCheckpoints = function (cps, feed) {
    const g = M.layers.checkpoints;
    g.clearLayers();
    if (!store.profile) return;
    // zones de ravitaillement : une pastille « R » au début de chaque zone
    for (const z of feed || []) {
      const pos = M.latLngAt(z.s);
      if (!pos) continue;
      g.addLayer(L.marker(pos, {
        icon: L.divIcon({ className: '', html: D.h('div', { class: 'cp-icon feed' }, 'R'), iconSize: [24, 24], iconAnchor: [12, 12] }),
        keyboard: false, zIndexOffset: 500,
        title: `Ravitaillement n°${z.n}, km ${PYR.util.fmt(z.s / 1000, 1)} à ${PYR.util.fmt(z.end / 1000, 1)}`,
      }));
    }
    if (!cps) return;
    const Cl = PYR.classif;
    for (const cp of cps) {
      const pos = M.latLngAt(cp.s);
      if (!pos) continue;
      const text = cp.type === 'sprint' ? 'S' : cp.type === 'kom' ? (cp.cat === 'hc' ? 'HC' : cp.cat) : 'A';
      const el = D.h('div', { class: 'cp-icon ' + cp.type }, text);
      g.addLayer(L.marker(pos, {
        icon: L.divIcon({ className: '', html: el, iconSize: [24, 24], iconAnchor: [12, 12] }),
        keyboard: false, zIndexOffset: 600,
        title: Cl.longLabel(cp, cps) + (cp.type === 'kom' ? ' : ' + Cl.climbText(cp) : ''),
      }));
    }
  };

  /** Tronçons d'un export du plan (onglet Performance) : chaque tronçon en couleur alternée, avec sa puissance cible à son début.
   * list : [{ a, b (m), label }] ; null pour effacer. editor : { onMove(k, s) → s retenu, onAdd(s), onRemove(k) } rend les limites modifiables :
   * poignées à glisser le long du parcours (double clic ou clic droit : supprimer), clic sur le tracé pour en ajouter une. */
  let cutHandles = [], cutDragging = false;
  M.sectionEditor = null;
  M.setSections = function (list, editor) {
    const g = M.layers.sections;
    g.clearLayers();
    const p = store.profile;
    M.sectionEditor = list && p && editor ? editor : null;
    if (!list || !p) { cutHandles.forEach((h) => h.remove()); cutHandles = []; return; }
    const colors = ['#8e44ad', '#e67e22'];
    list.forEach((sg, k) => {
      const i0 = U.clamp(Math.floor(sg.a / p.step), 0, p.n - 1), i1 = U.clamp(Math.ceil(sg.b / p.step), 0, p.n - 1);
      const pts = [];
      for (let i = i0; i <= i1; i++) pts.push([p.lat[i], p.lng[i]]);
      if (pts.length < 2) return;
      g.addLayer(L.polyline(pts, { color: colors[k % 2], weight: 9, opacity: 0.55, renderer: M.renderer, interactive: false }));
      const pos = M.latLngAt(sg.a);
      if (!pos) return;
      g.addLayer(L.marker(pos, {
        icon: L.divIcon({ className: '', html: D.h('div', { class: 'seg-pin', style: { background: colors[k % 2] } }, sg.label), iconSize: [null, 18], iconAnchor: [0, 9] }),
        keyboard: false, interactive: false, zIndexOffset: 400,
      }));
    });
    // poignées des limites : gardées pendant un glissement (même nombre de limites), sinon recréées
    const want = M.sectionEditor ? list.length - 1 : 0;
    if (cutHandles.length === want && want > 0) {
      cutHandles.forEach((h, i) => { if (!cutDragging || !h.dragging) h.setLatLng(M.latLngAt(list[i + 1].a)); });
      return;
    }
    cutHandles.forEach((h) => h.remove());
    cutHandles = [];
    for (let k = 1; k <= want; k++) {
      const h = L.marker(M.latLngAt(list[k].a), {
        icon: L.divIcon({ className: '', html: D.h('div', { class: 'seg-handle' }), iconSize: [18, 18], iconAnchor: [9, 9] }),
        draggable: true, keyboard: false, zIndexOffset: 800, title: 'Glisser pour déplacer la limite · double clic pour la supprimer',
      });
      let lastKept = list[k].a;
      h.on('dragstart', () => { cutDragging = true; h.dragging = true; });
      h.on('drag', (e) => {
        const s = M.nearestDistance(e.target.getLatLng());
        if (s === null || !M.sectionEditor) return;
        lastKept = M.sectionEditor.onMove(k, Math.round(s));
        const ll = M.latLngAt(lastKept);
        if (ll) h.setLatLng(ll);
      });
      h.on('dragend', () => { cutDragging = false; h.dragging = false; const ll = M.latLngAt(lastKept); if (ll) h.setLatLng(ll); });
      h.on('dblclick contextmenu', (e) => { L.DomEvent.stop(e); if (M.sectionEditor) M.sectionEditor.onRemove(k); });
      h.addTo(M.map);
      cutHandles.push(h);
    }
  };

  /**
   * Météo aux stations du parcours (onglets Parcours et Performance) : flèche de vent (dans le sens où il souffle),
   * température, pluie et heure estimée de passage. items : [{s, T, ws, wd, rain, clock}] ; null pour effacer.
   */
  M.setWeather = function (items) {
    const g = M.layers.weather;
    g.clearLayers();
    if (!items || !store.profile) return;
    for (const it of items) {
      const pos = M.latLngAt(it.s);
      if (!pos) continue;
      const raining = it.rain >= 0.2;
      const pin = D.h('div', { class: 'wx-pin' + (raining ? ' rain' : '') },
        D.h('span', { class: 'wx-arrow', style: { transform: `rotate(${Math.round(it.wd + 180)}deg)` } }, '↑'),
        D.h('b', null, `${PYR.util.fmt(it.T, 0)}°`),
        D.h('small', null, `${PYR.util.fmt(it.ws * 3.6, 0)} km/h${raining ? ` · ${PYR.util.fmt(it.rain, 1)} mm/h` : ''}`));
      g.addLayer(L.marker(pos, {
        icon: L.divIcon({ className: '', html: pin, iconSize: [74, 40], iconAnchor: [37, 56] }),
        keyboard: false, zIndexOffset: 400,
        title: `km ${PYR.util.fmt(it.s / 1000, 1)}, vers ${it.clock} : ${PYR.util.fmt(it.T, 1)} °C, vent ${PYR.util.fmt(it.ws * 3.6, 0)} km/h, pluie ${PYR.util.fmt(it.rain, 1)} mm/h`,
      }));
    }
  };

  /* ---------- Manches à air (mode jeu) ----------
   * Posées à intervalles réguliers le long du parcours, à côté de la route : elles restent à leur place quand la
   * caméra file (contrairement à des particules), pointent dans le sens du vent et s'allongent avec sa force. */
  const SOCK = { spacing: 500, side: 14, len: 44, h: 14, pole: 8 };
  M.socks = [];
  M.sockSample = null;

  function sockEl() {
    const n = 5, w = SOCK.len / n, mid = SOCK.h / 2;
    const half = (x) => mid - 1 - (mid - 4) * (x / SOCK.len); // demi-hauteur : large au piquet, étroite au bout
    let stripes = '';
    for (let k = 0; k < n; k++) {
      const x0 = k * w, x1 = x0 + w;
      stripes += `<polygon points="${x0},${mid - half(x0)} ${x1},${mid - half(x1)} ${x1},${mid + half(x1)} ${x0},${mid + half(x0)}" fill="${k % 2 ? '#fff' : '#e8541e'}"/>`;
    }
    const el = D.h('div', { class: 'wsock' });
    el.innerHTML = '<div class="wsock-body"><div class="wsock-flap">' +
      `<svg viewBox="0 0 ${SOCK.len} ${SOCK.h}" width="${SOCK.len}" height="${SOCK.h}" preserveAspectRatio="none">${stripes}</svg>` +
      '</div></div><span class="wsock-pole"></span>';
    el.firstChild.firstChild.style.animationDelay = (-Math.random() * 2).toFixed(2) + 's'; // elles ne battent pas toutes en cadence
    return el;
  }

  /**
   * Une manche tous les 500 m. course : parcours simulé (avec `weather`, ou `windDir`/`wMean`/`wAmp` des portions de vent
   * saisies à la main : on n'en pose alors que là où il y a du vent). null pour effacer.
   */
  M.setWindsocks = function (course) {
    M.layers.socks.clearLayers();
    M.socks = [];
    if (!course || !course.hasWind || !store.profile) return;
    for (let s = SOCK.spacing / 2; s < course.length; s += SOCK.spacing) {
      const i = Math.min(course.n - 1, Math.floor(s / course.step));
      if (!course.weather && !(course.wMean[i] > 0 || course.wAmp[i] > 0)) continue;
      // peloton en 2D : au-delà du bord de la route (sa largeur), pour ne pas se planter au milieu du peloton vu de près
      const pos = course.width ? M.latLngAt(s, course.width[i] / 2 + 0.6) : M.latLngAt(s);
      if (!pos) continue;
      const b = course.bear[i], el = sockEl();
      // le piquet est posé à droite de la route, à distance fixe en pixels quel que soit le zoom
      const ax = SOCK.pole - SOCK.side * Math.cos(b), ay = SOCK.h / 2 - SOCK.side * Math.sin(b);
      const marker = L.marker(pos, {
        icon: L.divIcon({ className: '', html: el, iconSize: [SOCK.pole + SOCK.len, SOCK.h], iconAnchor: [ax, ay] }),
        interactive: false, keyboard: false, zIndexOffset: 300,
      });
      M.socks.push({ idx: M.socks.length, s, i, el, marker, on: false, rot: null });
    }
    M.refreshWindsocks();
  };

  /**
   * Mode jeu, peloton en 2D : la route dessinée à sa largeur (course.width), en bandes de même largeur, à partir de ROAD_ZOOM.
   * course : parcours simulé ; null pour effacer.
   */
  M.setRoad = function (course) {
    M.layers.road.clearLayers();
    M.roadRuns = [];
    const p = store.profile;
    if (!course || !course.width || !p) return;
    const n = Math.min(course.n, p.n - 1);
    let i0 = 0;
    for (let i = 1; i <= n; i++) {
      if (i < n && course.width[i] === course.width[i0]) continue;
      const pts = [];
      for (let k = i0; k <= Math.min(i, p.n - 1); k++) pts.push([p.lat[k], p.lng[k]]);
      if (pts.length > 1) {
        const line = L.polyline(pts, { color: '#7d7d78', opacity: 0.5, weight: 1, lineCap: 'butt', lineJoin: 'round', renderer: M.renderer, interactive: false });
        M.roadRuns.push({ line, w: course.width[i0], lat: p.lat[i0] });
      }
      i0 = i;
    }
    M.styleRoad();
  };

  /** Épaisseur de la route à l'écran (sa largeur en pixels au zoom courant) ; masquée de loin. */
  M.styleRoad = function () {
    if (!M.roadRuns || !M.roadRuns.length) return;
    const show = M.mode === 'game' && M.map.getZoom() >= ROAD_ZOOM;
    for (const r of M.roadRuns) {
      if (!show) { if (M.layers.road.hasLayer(r.line)) M.layers.road.removeLayer(r.line); continue; }
      r.line.setStyle({ weight: Math.max(1, r.w * pxPerMeter(r.lat)) });
      if (!M.layers.road.hasLayer(r.line)) M.layers.road.addLayer(r.line);
    }
  };

  /**
   * « Zoom peloton » : on = vrai, la carte se centre au plus près sur `at` (zoom CLOSE_ZOOM) ; faux, elle revient au zoom d'avant.
   */
  let zoomBefore = null;
  M.closeUp = function (on, at) {
    const map = M.map;
    if (on) {
      if (zoomBefore === null) zoomBefore = map.getZoom();
      if (at) map.setView(at, CLOSE_ZOOM, { animate: false });
      else map.setZoom(CLOSE_ZOOM, { animate: false });
    } else if (zoomBefore !== null) {
      map.setZoom(Math.min(zoomBefore, map.getMaxZoom()), { animate: false });
      zoomBefore = null;
    }
  };

  /** Moins de manches quand on dézoome : une sur deux à z13, une sur quatre à z12… */
  M.refreshWindsocks = function () {
    const stride = Math.pow(2, Math.max(0, 14 - Math.round(M.map.getZoom())));
    for (const k of M.socks) {
      const want = k.idx % stride === 0;
      if (want && !k.on) M.layers.socks.addLayer(k.marker);
      else if (!want && k.on) M.layers.socks.removeLayer(k.marker);
      k.on = want;
    }
    if (M.sockSample) M.updateWindsocks(M.sockSample);
  };

  /** sample(s, i) : vent à la distance s (m, cellule i) → {kmh, dir (° d'où il vient)}, ou null (pas de vent ici). */
  M.updateWindsocks = function (sample) {
    M.sockSample = sample;
    const Fx = PYR.weatherFx;
    for (const k of M.socks) {
      if (!k.on) continue;
      const w = sample(k.s, k.i);
      k.el.style.visibility = w ? '' : 'hidden';
      if (!w) continue;
      const p = Fx.sockParams(w.kmh);
      const rot = w.dir + 90; // corps dessiné vers l'est : un vent d'ouest (270°) le souffle tel quel (rotation 360° = 0°)
      // angle cumulé : la transition CSS prend toujours le chemin le plus court
      k.rot = k.rot === null ? rot : k.rot + ((((rot - k.rot) % 360) + 540) % 360) - 180;
      k.el.style.setProperty('--rot', k.rot.toFixed(1) + 'deg');
      k.el.style.setProperty('--k', p.k.toFixed(2));
      k.el.style.setProperty('--flap', p.flap.toFixed(2) + 's');
      k.el.style.setProperty('--amp', p.amp.toFixed(1) + 'deg');
    }
  };

  /** Portion déjà parcourue en mode jeu. */
  M.setProgress = function (s) {
    const p = store.profile;
    if (s === null || s === undefined || !p) { M.layers.progress.clearLayers(); M.progressLine = null; return; }
    const i1 = Math.min(p.n - 1, Math.floor(s / p.step));
    const stride = Math.max(1, Math.floor(i1 / 2000));
    const pts = [];
    for (let i = 0; i <= i1; i += stride) pts.push([p.lat[i], p.lng[i]]);
    pts.push(M.latLngAt(s));
    if (!M.progressLine) {
      M.progressLine = L.polyline(pts, { color: '#eb6834', weight: 6, opacity: 1, renderer: M.renderer, interactive: false });
      M.layers.progress.addLayer(M.progressLine);
    } else M.progressLine.setLatLngs(pts);
  };

  M.status = function (text) {
    const el = D.$('#map-status');
    el.hidden = !text;
    el.textContent = text || '';
  };

  M.HEAT = HEAT;
  M.heatColor = heatColor;
  PYR.map = M;
})(globalThis.PYR = globalThis.PYR || {});
