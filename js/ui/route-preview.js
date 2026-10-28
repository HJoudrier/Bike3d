/* author : Hugo Joudrier-Faure */
/* PaceYourRide — aperçu du parcours du projet sur la page d'accueil : distance, D+ / D−, carte du tracé entier (départ, arrivée,
 * sprints et côtes) et profil d'altitude. Même présentation que la préparation de la page Compteur (tab-ride.js), mais sans le magasin
 * de l'application : le profil vient de la bibliothèque (library.routeProfile) et la carte est une Leaflet annexe, sans interaction. */
(function (PYR) {
  'use strict';

  const D = PYR.dom, Lib = PYR.library;
  const { h } = D;

  const TILES = [
    { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
    { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', maxZoom: 20, subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>' },
  ];
  const CP_TEXT = (c) => (c.type === 'sprint' ? 'S' : c.cat === 'hc' ? 'HC' : String(c.cat));
  const fr = (x, d) => (Math.round(x * Math.pow(10, d || 0)) / Math.pow(10, d || 0)).toLocaleString('fr-FR');

  /** root : conteneur vide où l'aperçu est construit ; l'aperçu se redessine à chaque `update(project)`.
   *  La vignette (titre, stats, carte et profil) est un lien vers la page Parcours : le nom s'y modifie. */
  function create(root) {
    const title = h('b', { class: 'hm-rname' });
    const stats = h('p', { class: 'hm-rstats' });
    const mapBox = h('div', { class: 'hm-rmap', role: 'img', 'aria-label': 'Carte du parcours' });
    const canvas = h('canvas', { class: 'hm-rprof', role: 'img', 'aria-label': "Profil d'altitude du parcours" });
    const note = h('p', { class: 'hm-rnote', hidden: true });
    const empty = h('div', { class: 'hm-rempty', hidden: true },
      h('b', null, 'Aucun parcours'), h('small', null, 'Trace-en un, charge un GPX ou choisis-en un dans ta bibliothèque.'));
    const full = h('a', { class: 'hm-rfull', href: 'parcours.html', title: "Modifier le parcours sur la page Parcours" }, title, stats, mapBox, canvas, note);
    root.append(empty, full);

    let map = null, layers = null, sig = '', lastW = 0, cur = null, cps = [];

    function ensureMap() {
      if (map || typeof L === 'undefined') return;
      map = L.map(mapBox, { zoomControl: false, dragging: false, touchZoom: false, doubleClickZoom: false, scrollWheelZoom: false, boxZoom: false, keyboard: false, tap: false, zoomSnap: 0.25 });
      layers = L.layerGroup().addTo(map);
      // OpenStreetMap exige un en-tête Referer (fichier local, hébergement qui le supprime : tuiles bloquées) : repli sur CARTO après quelques erreurs
      let errors = 0, i = 0;
      const add = () => {
        const t = TILES[i], layer = L.tileLayer(t.url, { maxZoom: t.maxZoom, subdomains: t.subdomains || 'abc', attribution: t.attribution, crossOrigin: true }).addTo(map);
        layer.on('tileerror', () => { if (++errors >= 3 && i < TILES.length - 1) { map.removeLayer(layer); i++; add(); } });
      };
      add();
    }

    function drawMap(p) {
      ensureMap();
      if (!map) return;
      map.invalidateSize({ animate: false });
      const key = [Math.round(p.length), p.n, p.lat[0].toFixed(4), p.lng[p.n - 1].toFixed(4), cps.map((c) => c.type + Math.round(c.s)).join(',')].join('|');
      if (key === sig && lastW === mapBox.clientWidth) return;
      sig = key; lastW = mapBox.clientWidth;
      layers.clearLayers();
      const pts = [], stride = Math.max(1, Math.floor(p.n / 600));
      for (let i = 0; i < p.n; i += stride) pts.push([p.lat[i], p.lng[i]]);
      pts.push([p.lat[p.n - 1], p.lng[p.n - 1]]);
      layers.addLayer(L.polyline(pts, { color: '#fff', weight: 8, opacity: 0.9, interactive: false }));
      layers.addLayer(L.polyline(pts, { color: '#2a78d6', weight: 4.5, opacity: 1, interactive: false }));
      const icon = (cls, txt) => L.divIcon({ className: '', html: `<div class="${cls}">${txt}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
      const mark = (ll, cls, txt, z) => layers.addLayer(L.marker(ll, { icon: icon(cls, txt), interactive: false, keyboard: false, zIndexOffset: z }));
      mark(pts[0], 'wp-icon wp-start', 'D', 500);
      mark(pts[pts.length - 1], 'wp-icon wp-end', 'A', 500);
      for (const c of cps) {
        const i = Math.min(p.n - 1, Math.round(c.s / p.step));
        mark([p.lat[i], p.lng[i]], 'cp-icon ' + c.type, CP_TEXT(c), 600);
      }
      map.fitBounds(L.latLngBounds(pts), { padding: [26, 26], animate: false });
    }

    /** Profil du parcours entier : sommets des côtes classées (zone rouge et pastille de catégorie) et sprints (trait vert et « S »). */
    function drawProfile(p) {
      const cv = canvas;
      if (!p.ele || !cv.isConnected) return;
      const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, hgt = cv.clientHeight;
      if (!w || !hgt) return;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hgt);
      const css = getComputedStyle(document.documentElement), col = (k, d) => css.getPropertyValue(k).trim() || d;
      const ink2 = col('--ink-2', '#555'), border = col('--border', '#ddd'), accent = col('--accent', '#2a78d6');
      const L0 = p.length, left = 40, right = 8, top = 24, bot = hgt - 18, pw = w - left - right;
      const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
      const eleAt = (m) => p.ele[clamp(Math.round(m / p.step), 0, p.n - 1)];
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < p.n; i++) { const e = p.ele[i]; if (e < lo) lo = e; if (e > hi) hi = e; }
      const pad = Math.max(10, (hi - lo) * 0.1);
      lo = Math.floor((lo - pad) / 10) * 10; hi = Math.ceil((hi + pad) / 10) * 10;
      if (hi - lo < 40) hi = lo + 40;
      const X = (m) => left + m / L0 * pw, Y = (e) => bot - (e - lo) / (hi - lo) * (bot - top);
      const cols = Math.max(40, Math.min(p.n - 1, Math.floor(pw)));
      const curve = () => { for (let i = 0; i <= cols; i++) { const m = L0 * i / cols; if (i) ctx.lineTo(X(m), Y(eleAt(m))); else ctx.moveTo(X(m), Y(eleAt(m))); } };
      // repères : altitude (haut, bas) et kilomètres
      ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = ink2; ctx.strokeStyle = border; ctx.lineWidth = 1;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (const e of [hi, lo]) { ctx.beginPath(); ctx.moveTo(left, Y(e) + 0.5); ctx.lineTo(w - right, Y(e) + 0.5); ctx.stroke(); ctx.fillText(Math.round(e) + ' m', left - 4, Math.min(hgt - 20, Math.max(8, Y(e)))); }
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      const km = L0 / 1000, steps = [1, 2, 5, 10, 20, 25, 50, 100], want = Math.max(3, Math.floor(pw / 70));
      const stepKm = steps.find((s) => km / s <= want) || 100;
      for (let k = 0; k * stepKm <= km; k++) ctx.fillText(k * stepKm + (k === 0 ? ' km' : ''), Math.min(w - 12, Math.max(left + 8, X(k * stepKm * 1000))), hgt - 4);
      // surface sous la courbe, puis dénivelé des côtes classées en rouge
      ctx.beginPath(); curve(); ctx.lineTo(X(L0), bot); ctx.lineTo(X(0), bot); ctx.closePath();
      ctx.fillStyle = accent; ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1;
      for (const c of cps) {
        if (c.type !== 'kom') continue;
        const a = Math.max(0, c.start || 0), n = Math.max(8, Math.round((c.s - a) / L0 * cols));
        ctx.beginPath();
        for (let i = 0; i <= n; i++) { const m = a + (c.s - a) * i / n; if (i) ctx.lineTo(X(m), Y(eleAt(m))); else ctx.moveTo(X(m), Y(eleAt(m))); }
        ctx.lineTo(X(c.s), bot); ctx.lineTo(X(a), bot); ctx.closePath();
        ctx.fillStyle = '#d62828'; ctx.globalAlpha = 0.38; ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.beginPath(); curve(); ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      // sprints et sommets : trait vertical jusqu'à la courbe et pastille au-dessus
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      for (const c of cps) {
        const x = X(c.s), yc = Y(eleAt(c.s)), kom = c.type === 'kom', color = kom ? '#d62828' : '#1d9a4a', by = Math.max(11, yc - 15);
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, by); ctx.lineTo(x, yc); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, by, 9, 0, Math.PI * 2); ctx.fillStyle = kom ? '#fff' : color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = kom ? color : '#fff'; ctx.stroke();
        ctx.fillStyle = kom ? color : '#fff'; ctx.font = '700 10px system-ui, sans-serif'; ctx.fillText(CP_TEXT(c), x, by + 0.5);
      }
    }

    function redraw() { if (cur) { drawMap(cur); drawProfile(cur); } }

    /** Affiche le parcours du projet (ou l'invite à en choisir un). */
    function update(project) {
      const p = Lib.routeProfile(project);
      cur = p;
      empty.hidden = !!p; full.hidden = !p;
      if (!p) return;
      title.textContent = (project.route && project.route.name) || 'Parcours sans nom';
      cps = PYR.classif ? PYR.classif.fromList(project.checkpoints, p).filter((c) => c.type === 'sprint' || c.type === 'kom') : [];
      D.clear(stats);
      stats.append(
        h('span', null, h('small', null, 'Distance'), h('b', null, `${fr(p.length / 1000, 1)} km`)),
        h('span', null, h('small', null, 'D+'), h('b', null, p.hasEle ? `${fr(p.up)} m` : '—')),
        h('span', null, h('small', null, 'D−'), h('b', null, p.hasEle ? `${fr(p.down)} m` : '—')));
      canvas.hidden = !p.hasEle;
      note.hidden = p.hasEle;
      note.textContent = "Ce parcours n'a pas d'altitude : ouvre-le sur la page Parcours pour la récupérer en ligne.";
      redraw();
    }

    let t = 0;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(redraw, 120); });
    return { update, redraw };
  }

  PYR.routePreview = { create };
})(globalThis.PYR = globalThis.PYR || {});
