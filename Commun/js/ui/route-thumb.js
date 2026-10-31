/* author : Hugo Joudrier-Faure */
/* PaceYourRide — un parcours en vue 3D pour la page de choix des jeux : le tracé en ruban coloré selon la pente, posé à son altitude (relief
 * exagéré pour qu'il se voie), avec un rideau jusqu'au sol qui dessine le profil, le départ (vert) et l'arrivée (rouge). Il tourne doucement ;
 * on le fait tourner à la souris ou au doigt.
 * Un seul moteur WebGL sert toutes les vignettes (les navigateurs limitent le nombre de contextes) : à chaque image, chaque vignette
 * visible est rendue puis recopiée dans son propre canvas. three.js est celui de l'univers de Bike3D, chargé à la demande ; sans WebGL,
 * la vignette montre le profil d'altitude à plat.
 *   const view = PYR.routeThumb.mount(canvas, profile);   // profile : PYR.library.routeProfile → { n, length, lat, lng, ele, up, down, hasEle }
 *   view.destroy();                                    // retire la vignette
 * La géométrie (pure, testable sous Node) est dans PYR.routeThumb.geometry. */
(function (PYR) {
  'use strict';

  const THREE_SRC = 'VirtualRide3D/univers/vendor/three.min.js';
  const MAX_PTS = 500;          // points du ruban
  const SPAN = 10;              // étendue horizontale du tracé dans la scène (unités)
  const RIBBON_W = 0.1;         // demi-largeur du ruban

  // pente (fraction) → couleur du ruban
  const GRADE_COLORS = [
    [-0.03, [0.29, 0.56, 0.85]], [0.03, [0.25, 0.64, 0.30]], [0.06, [0.95, 0.76, 0.19]],
    [0.09, [0.94, 0.55, 0.0]], [0.12, [0.84, 0.16, 0.16]], [1, [0.48, 0.06, 0.06]],
  ];
  function gradeColor(g) {
    for (let i = 0; i < GRADE_COLORS.length; i++) if (g < GRADE_COLORS[i][0]) return GRADE_COLORS[i][1];
    return GRADE_COLORS[GRADE_COLORS.length - 1][1];
  }

  /**
   * Géométrie d'un parcours : points échantillonnés (au plus MAX_PTS), centrés, mis à l'échelle de la scène, avec le relief exagéré.
   * Renvoie { n, x[], y[], z[], grade[], height (hauteur max du relief dans la scène), exag (exagération verticale), span } ou null.
   */
  function geometry(profile) {
    if (!profile || !(profile.n >= 2) || !profile.lat || !profile.lng) return null;
    const N = Math.min(profile.n, MAX_PTS), idx = [];
    for (let i = 0; i < N; i++) idx.push(Math.round((i * (profile.n - 1)) / (N - 1)));
    const lat0 = profile.lat[idx[0]], lng0 = profile.lng[idx[0]], kx = Math.cos(lat0 * Math.PI / 180) * 111320, kz = 111320;
    const mx = [], mz = [], me = [];
    for (const i of idx) {
      mx.push((profile.lng[i] - lng0) * kx);
      mz.push(-(profile.lat[i] - lat0) * kz);
      me.push(profile.ele ? profile.ele[i] : 0);
    }
    const minX = Math.min(...mx), maxX = Math.max(...mx), minZ = Math.min(...mz), maxZ = Math.max(...mz);
    const extent = Math.max(maxX - minX, maxZ - minZ, 1);
    const k = SPAN / extent;
    const eMin = Math.min(...me), eMax = Math.max(...me), relief = eMax - eMin;
    // le relief réel est écrasé à cette échelle : on l'exagère pour que la montée se voie (de ×1 à ×8), sans dépasser le tiers de l'étendue
    const ratio = relief / extent;
    const exag = ratio > 0 ? Math.min(8, Math.max(1, 0.2 / ratio)) : 1;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const x = [], y = [], z = [], grade = [];
    for (let i = 0; i < N; i++) {
      x.push((mx[i] - cx) * k);
      z.push((mz[i] - cz) * k);
      y.push((me[i] - eMin) * k * exag + 0.05);
    }
    // pente réelle lissée sur ≈ 5 % du tracé (mètres réels, pas ceux de la scène)
    const dist = [0];
    for (let i = 1; i < N; i++) dist.push(dist[i - 1] + Math.hypot(mx[i] - mx[i - 1], mz[i] - mz[i - 1]));
    const h = Math.max(1, Math.round(N * 0.025));
    for (let i = 0; i < N; i++) {
      const a = Math.max(0, i - h), b = Math.min(N - 1, i + h), d = dist[b] - dist[a];
      grade.push(d > 1 && profile.ele ? (me[b] - me[a]) / d : 0);
    }
    return { n: N, x, y, z, grade, height: relief * k * exag, exag, span: SPAN };
  }

  /** Ruban plat suivant le tracé : sommets (haut gauche/droite par point), couleurs, indices ; et rideau jusqu'au sol (haut/bas par point). */
  function meshData(g) {
    const n = g.n, pos = new Float32Array(n * 2 * 3), col = new Float32Array(n * 2 * 3), idx = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = g.x[b] - g.x[a], tz = g.z[b] - g.z[a];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      const nx = -tz * RIBBON_W, nz = tx * RIBBON_W, c = gradeColor(g.grade[i]);
      pos.set([g.x[i] + nx, g.y[i], g.z[i] + nz, g.x[i] - nx, g.y[i], g.z[i] - nz], i * 6);
      col.set([c[0], c[1], c[2], c[0], c[1], c[2]], i * 6);
      if (i < n - 1) { const v = i * 2; idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    }
    const cPos = new Float32Array(n * 2 * 3), cCol = new Float32Array(n * 2 * 3), cIdx = [];
    for (let i = 0; i < n; i++) {
      const c = gradeColor(g.grade[i]);
      cPos.set([g.x[i], g.y[i], g.z[i], g.x[i], 0, g.z[i]], i * 6);
      cCol.set([c[0], c[1], c[2], c[0] * 0.5 + 0.35, c[1] * 0.5 + 0.35, c[2] * 0.5 + 0.35], i * 6);
      if (i < n - 1) { const v = i * 2; cIdx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    }
    return { pos, col, idx, cPos, cCol, cIdx };
  }

  /* ---------- three.js, chargé à la demande ---------- */

  let threeP = null;
  function loadThree() {
    if (globalThis.THREE) return Promise.resolve(globalThis.THREE);
    if (!threeP) {
      threeP = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = (PYR.root || '') + THREE_SRC;
        s.onload = () => resolve(globalThis.THREE || null);
        s.onerror = () => resolve(null);
        document.head.appendChild(s);
      });
    }
    return threeP;
  }

  /* ---------- moteur commun à toutes les vignettes ---------- */

  const E = { three: null, renderer: null, ok: null, views: new Set(), raf: 0, last: 0, tried: false };
  const reduced = () => !!(globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  async function ensureEngine() {
    if (E.tried) return E.ok;
    E.tried = true;
    const T = await loadThree();
    if (!T) { E.ok = false; return false; }
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) { E.ok = false; return false; }
      E.renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: true });
      E.renderer.setClearColor(0x000000, 0);
      E.three = T; E.ok = true;
    } catch (e) { E.ok = false; }
    return E.ok;
  }

  function buildScene(T, g) {
    const scene = new T.Scene();
    const d = meshData(g);
    const make = (pos, col, idx, opts) => {
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      geo.setAttribute('color', new T.BufferAttribute(col, 3));
      geo.setIndex(idx);
      return new T.Mesh(geo, new T.MeshBasicMaterial(Object.assign({ vertexColors: true, side: T.DoubleSide }, opts)));
    };
    scene.add(make(d.cPos, d.cCol, d.cIdx, { transparent: true, opacity: 0.32, depthWrite: false }));
    scene.add(make(d.pos, d.col, d.idx, {}));
    // sol : disque léger et grille
    const grid = new T.GridHelper(SPAN * 1.35, 12, 0x8a8f98, 0x8a8f98);
    grid.material.transparent = true; grid.material.opacity = 0.28; grid.position.y = -0.005;
    scene.add(grid);
    const marker = (i, color) => {
      const m = new T.Mesh(new T.SphereGeometry(0.2, 16, 12), new T.MeshBasicMaterial({ color }));
      m.position.set(g.x[i], g.y[i] + 0.1, g.z[i]);
      scene.add(m);
    };
    marker(0, 0x2e9e4f); marker(g.n - 1, 0xd62828);
    return scene;
  }

  function frame(now) {
    E.raf = 0;
    let any = false;
    const dt = Math.min(0.1, (now - (E.last || now)) / 1000);
    E.last = now;
    for (const v of E.views) {
      if (!v.visible) continue;
      any = true;
      v.draw(dt);
    }
    if (any) E.raf = requestAnimationFrame(frame);
  }
  function kick() { if (!E.raf && E.views.size) { E.last = 0; E.raf = requestAnimationFrame(frame); } }

  /* ---------- repli sans WebGL : le profil d'altitude à plat ---------- */

  function drawFlat(canvas, profile) {
    const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!profile || !profile.ele) return;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < profile.n; i++) { lo = Math.min(lo, profile.ele[i]); hi = Math.max(hi, profile.ele[i]); }
    const span = Math.max(30, hi - lo), pad = 14;
    ctx.beginPath();
    ctx.moveTo(pad, h - pad);
    for (let i = 0; i < profile.n; i += Math.max(1, Math.floor(profile.n / 300))) {
      ctx.lineTo(pad + (i / (profile.n - 1)) * (w - 2 * pad), h - pad - ((profile.ele[i] - lo) / span) * (h - 2 * pad));
    }
    ctx.lineTo(w - pad, h - pad); ctx.closePath();
    ctx.fillStyle = 'rgba(42,120,214,.35)'; ctx.fill();
    ctx.strokeStyle = '#2a78d6'; ctx.lineWidth = 2 * (globalThis.devicePixelRatio || 1); ctx.stroke();
  }

  /** Vignette 3D d'un parcours dans `canvas`. */
  function mount(canvas, profile) {
    const g = geometry(profile);
    const view = { visible: true, az: 0.6 + Math.random() * 1.2, hold: 0, scene: null, camera: null, destroyed: false };
    const sync = () => {
      const r = canvas.getBoundingClientRect(), dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      const w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      return { w, h };
    };
    view.draw = (dt) => {
      if (view.destroyed || !g) return;
      const { w, h } = sync();
      if (!E.ok) { drawFlat(canvas, profile); return; }
      const T = E.three;
      if (!view.scene) {
        view.scene = buildScene(T, g);
        view.camera = new T.PerspectiveCamera(36, 1, 0.1, 100);
      }
      if (view.hold > 0) view.hold -= dt; else if (!reduced()) view.az += dt * 0.28;
      const dist = g.span * 1.5, el = 0.62, ty = g.height * 0.4;
      const cam = view.camera;
      cam.aspect = w / h; cam.updateProjectionMatrix();
      cam.position.set(Math.sin(view.az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, Math.cos(view.az) * Math.cos(el) * dist);
      cam.lookAt(0, ty, 0);
      E.renderer.setSize(w, h, false);
      E.renderer.render(view.scene, cam);
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(E.renderer.domElement, 0, 0, w, h);
    };
    // rotation à la main
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, az: view.az }; canvas.dataset.dragged = ''; view.hold = 4; try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignoré */ } });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) > 4) canvas.dataset.dragged = '1';      // un glissé n'est pas un clic (la vignette ne se choisit pas)
      view.az = drag.az - (e.clientX - drag.x) * 0.012; view.hold = 4; if (reduced()) view.draw(0);
    });
    const end = () => { drag = null; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    let io = null;
    if (globalThis.IntersectionObserver) {
      io = new IntersectionObserver((entries) => { for (const en of entries) view.visible = en.isIntersecting; kick(); }, { rootMargin: '80px' });
      io.observe(canvas);
    }
    view.destroy = () => { view.destroyed = true; E.views.delete(view); if (io) io.disconnect(); };
    ensureEngine().then(() => { if (view.destroyed) return; E.views.add(view); view.draw(0); kick(); });
    return view;
  }

  /**
   * Vignette 2D d'un parcours dans `box` : le tracé (liseré blanc, trait bleu, départ vert, arrivée rouge) sur le fond de carte de l'application,
   * cadré sur le parcours. La carte ne bouge pas (rien ne capte la molette ni le doigt : la page continue de défiler) et n'est créée que
   * lorsque la vignette devient visible (un fond de carte par parcours, c'est autant de tuiles à charger).
   */
  function mountMap(box, profile) {
    const view = { destroyed: false, map: null, destroy() { view.destroyed = true; if (io) io.disconnect(); if (view.map) { view.map.remove(); view.map = null; } } };
    let io = null;
    const build = () => {
      if (view.destroyed || view.map || !globalThis.L || !profile || !(profile.n >= 2)) return;
      const L = globalThis.L, pts = [], stride = Math.max(1, Math.floor(profile.n / 400));
      for (let i = 0; i < profile.n; i += stride) pts.push([profile.lat[i], profile.lng[i]]);
      pts.push([profile.lat[profile.n - 1], profile.lng[profile.n - 1]]);
      const map = view.map = L.map(box, { zoomControl: false, dragging: false, touchZoom: false, doubleClickZoom: false, scrollWheelZoom: false, boxZoom: false, keyboard: false, tap: false, zoomSnap: 0.25, attributionControl: true });
      map.attributionControl.setPrefix('');
      const spec = PYR.map && PYR.map.baseSpec ? PYR.map.baseSpec() : { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '&copy; OpenStreetMap' };   // sans la carte principale (accueil)
      if (spec) L.tileLayer(spec.url, { maxZoom: spec.maxZoom, subdomains: spec.subdomains || 'abc', attribution: spec.attribution, crossOrigin: true }).addTo(map);
      const line = L.polyline(pts, { color: '#fff', weight: 7, opacity: 0.9, interactive: false }).addTo(map);
      L.polyline(pts, { color: '#2a78d6', weight: 4, opacity: 1, interactive: false }).addTo(map);
      const dot = (p, color) => L.circleMarker(p, { radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, interactive: false }).addTo(map);
      dot(pts[0], '#2e9e4f'); dot(pts[pts.length - 1], '#d62828');
      map.invalidateSize({ animate: false });
      map.fitBounds(line.getBounds(), { padding: [18, 18], animate: false });
    };
    if (globalThis.IntersectionObserver) {
      io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { build(); if (io) io.disconnect(); } }, { rootMargin: '200px' });
      io.observe(box);
    } else build();
    return view;
  }

  PYR.routeThumb = { geometry, meshData, gradeColor, mount, mountMap, loadThree, get webgl() { return E.ok; } };
})(globalThis.PYR = globalThis.PYR || {});
