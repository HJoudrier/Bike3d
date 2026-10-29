/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page Parcours : le parcours en 3D. Le fond de carte (plan ou topographique) est posé à plat, et le tracé flotte au-dessus,
 * chaque point à une hauteur proportionnelle à son altitude (un rideau le relie au fond, une ombre au sol rappelle son tracé).
 * La vue remplace la carte (bouton « Carte | 3D » de l'en-tête) ; la carte et ses outils de tracé reviennent avec « Carte ».
 *
 * three.js n'est chargé qu'à la première ouverture (le fichier de Bike3D, Jeu/3D/univers/vendor/three.min.js). Le fond est une image
 * assemblée à partir des tuiles qui couvrent le parcours (au plus 8 × 8, au zoom le plus fin qui le permette) ; la projection est celle de
 * Mercator, à l'échelle du centre du parcours (1 unité = 1 m). Une exagération verticale (réglable) rend le relief lisible : à ×1 un
 * col de 1 000 m sur 20 km est presque plat.
 * Souris : glisser pour tourner, Maj + glisser (ou clic droit) pour déplacer, molette pour zoomer ; doigt : un doigt tourne, deux
 * doigts zooment et déplacent. Survoler le tracé le montre sur le profil, et inversement (évènement « hover » du store). */
(function (PYR) {
  'use strict';

  const U = PYR.util;
  const D = PYR.dom || {};
  const store = PYR.store;

  const EARTH = 40075016.686;       // circonférence de l'équateur (m)
  const MAX_SIDE = 8, MAX_TILES = 48; // tuiles du fond : au plus 8 × 8 (2 048 px de large) et 48 en tout
  const MAX_ZOOM = 17;
  const MAX_SAMPLES = 900;          // points du tracé dessiné (le profil complet reste utilisé pour le survol)
  const BASES = {
    plan: { label: 'Plan', sources: ['osm', 'carto'] },       // OpenStreetMap, puis CARTO si OpenStreetMap refuse les tuiles (Referer)
    topo: { label: 'Topographique', sources: ['topo'] },
  };
  const ROUTE_COLOR = 0x2a78d6, HOVER_COLOR = 0xf2b327;
  const THREE_FILE = 'Jeu/3D/univers/vendor/three.min.js';  // depuis la racine du site

  /* ---------- Géométrie (testée dans Node) ---------- */

  /** Mercator « monde 0..1 » : x vers l'est, y vers le sud. */
  function merc(lat, lng) {
    const s = Math.sin(U.clamp(lat, -85, 85) * Math.PI / 180);
    return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  }

  /**
   * Tuiles à assembler pour couvrir la boîte (x0,y0)-(x1,y1) en coordonnées Mercator 0..1 : le zoom le plus fin (≤ maxZoom) qui tient
   * dans MAX_SIDE × MAX_SIDE tuiles et MAX_TILES en tout. Renvoie {z, tx0, ty0, nx, ny}.
   */
  function pickTiles(x0, y0, x1, y1, maxZoom) {
    for (let z = Math.min(maxZoom, MAX_ZOOM); z >= 0; z--) {
      const n = 2 ** z;
      const tx0 = U.clamp(Math.floor(x0 * n), 0, n - 1), tx1 = U.clamp(Math.floor(x1 * n), 0, n - 1);
      const ty0 = U.clamp(Math.floor(y0 * n), 0, n - 1), ty1 = U.clamp(Math.floor(y1 * n), 0, n - 1);
      const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
      if (z === 0 || (nx <= MAX_SIDE && ny <= MAX_SIDE && nx * ny <= MAX_TILES)) return { z, tx0, ty0, nx, ny };
    }
    return { z: 0, tx0: 0, ty0: 0, nx: 1, ny: 1 };
  }

  /** Exagération verticale conseillée : le relief atteint environ 30 % de l'étendue du parcours (entre ×1 et ×10, au demi près). */
  function autoExag(extent, range) {
    if (!(range > 0)) return 1;
    return U.clamp(Math.round(2 * 0.3 * extent / range) / 2, 1, 10);
  }

  /**
   * Parcours placé dans l'espace : x vers l'est, z vers le sud (m, par rapport au centre de la boîte du tracé), altitude en m.
   * Renvoie {pos: Float32Array [x, alt, z] par point du profil, extent, range, eleMin, eleMax, center: [mx, my], mPerUnit, box}.
   */
  function layout(p) {
    const n = p.n;
    const mx = new Float64Array(n), my = new Float64Array(n);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, eMin = Infinity, eMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const m = merc(p.lat[i], p.lng[i]);
      mx[i] = m[0]; my[i] = m[1];
      if (m[0] < x0) x0 = m[0]; if (m[0] > x1) x1 = m[0];
      if (m[1] < y0) y0 = m[1]; if (m[1] > y1) y1 = m[1];
      if (p.ele[i] < eMin) eMin = p.ele[i]; if (p.ele[i] > eMax) eMax = p.ele[i];
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const latC = Math.atan(Math.sinh(Math.PI * (1 - 2 * cy))) * 180 / Math.PI;
    const k = EARTH * Math.cos(latC * Math.PI / 180);   // mètres par unité Mercator, à la latitude du centre
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[3 * i] = (mx[i] - cx) * k; pos[3 * i + 1] = p.ele[i] - eMin; pos[3 * i + 2] = (my[i] - cy) * k; }
    const extent = Math.max((x1 - x0) * k, (y1 - y0) * k, 200);
    return { pos, extent, range: eMax - eMin, eleMin: eMin, eleMax: eMax, center: [cx, cy], mPerUnit: k, box: [x0, y0, x1, y1] };
  }

  /** Adresse d'une tuile d'après le modèle du fond (cf. BASE_LAYERS de map.js). */
  function tileUrl(spec, z, x, y) {
    const sub = spec.subdomains || 'abc';
    return spec.url.replace('{s}', sub[(x + y) % sub.length]).replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{r}', '');
  }

  /* ---------- Vue ---------- */

  const R = {
    on: false, three: null, loading: null,
    base: 'plan', exagUser: null, exag: 1,
    renderer: null, scene: null, camera: null, root: null,
    nav: { az: 0, el: 0.8, r: 1000, t: null }, routeGroup: null, hoverMarker: null, groundSpan: 0,
    lay: null, sample: null, ground: null, dirty: true, raf: 0, token: 0, hoverS: null,
  };
  const el = {};

  /** Charge three.js une seule fois (script classique, global THREE). */
  function loadThree() {
    if (globalThis.THREE) return Promise.resolve(globalThis.THREE);
    if (R.loading) return R.loading;
    R.loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = (PYR.root || '') + THREE_FILE;
      s.onload = () => (globalThis.THREE ? resolve(globalThis.THREE) : reject(new Error('three.js introuvable')));
      s.onerror = () => { R.loading = null; reject(new Error('three.js n\'a pas pu être chargé')); };
      document.head.appendChild(s);
    });
    return R.loading;
  }

  function say(text) {
    el.msg.textContent = text || '';
    el.msg.hidden = !text;
  }

  function specById(id) { return (PYR.map && PYR.map.baseSpecs || []).find((b) => b.id === id); }

  function setupRenderer() {
    const T = R.three;
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.domElement.className = 'r3-canvas';
    el.box.insertBefore(renderer.domElement, el.box.firstChild);
    R.renderer = renderer;
    R.scene = new T.Scene();
    R.camera = new T.PerspectiveCamera(45, 1, 1, 1e6);
    R.root = new T.Group();
    R.routeGroup = new T.Group();
    R.root.add(R.routeGroup);
    R.scene.add(R.root);
    R.scene.add(new T.AmbientLight(0xffffff, 0.75));
    const sun = new T.DirectionalLight(0xffffff, 0.8);
    sun.position.set(-1, 2, 1);
    R.scene.add(sun);
    bindControls(renderer.domElement);
    new ResizeObserver(resize).observe(el.box);
    resize();
  }

  function resize() {
    if (!R.renderer) return;
    const w = el.box.clientWidth, h = el.box.clientHeight;
    if (!w || !h) return;
    R.renderer.setSize(w, h, false);
    R.camera.aspect = w / h;
    R.camera.updateProjectionMatrix();
    R.dirty = true;
  }

  function dispose(o) {
    o.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
    });
  }
  function clearRoute() {
    if (!R.routeGroup) return;
    for (const o of [...R.routeGroup.children]) { R.routeGroup.remove(o); dispose(o); }
    R.sample = null; R.hoverMarker = null;
  }
  function clearGround() {
    if (!R.ground) return;
    R.root.remove(R.ground); dispose(R.ground); R.ground = null;
  }

  /** Tracé placé à la hauteur de l'exagération courante. */
  function yOf(alt) { return alt * R.exag; }

  /** Tout reconstruire : tracé, fond et caméra. */
  function build() {
    const p = store.profile;
    clearRoute(); clearGround();
    el.tip.hidden = true;
    if (!p || p.n < 2) { R.lay = null; say('Trace un parcours sur la carte pour le voir en 3D.'); el.info.textContent = ''; R.dirty = true; return; }
    say('');
    const lay = R.lay = layout(p);
    R.exag = R.exagUser != null ? R.exagUser : autoExag(lay.extent, lay.range);
    showExag();
    buildRoute();
    buildGround();
    resetView();
    info();
  }

  function showExag() {
    el.exag.value = String(R.exag);
    el.exagOut.textContent = '×' + U.fmt(R.exag, R.exag % 1 ? 1 : 0);
  }

  /** Le tracé, son rideau, son ombre et les repères, à la hauteur de l'exagération courante. */
  function buildRoute() {
    const p = store.profile, lay = R.lay, T = R.three;
    clearRoute();
    // échantillons du tracé (sous-échantillonnage régulier, dernier point compris)
    const stride = Math.max(1, Math.ceil(p.n / MAX_SAMPLES));
    const idx = [];
    for (let i = 0; i < p.n; i += stride) idx.push(i);
    if (idx[idx.length - 1] !== p.n - 1) idx.push(p.n - 1);
    R.sample = { idx, s: idx.map((i) => i * p.step) };
    const pts = idx.map((i) => new T.Vector3(lay.pos[3 * i], yOf(lay.pos[3 * i + 1]), lay.pos[3 * i + 2]));
    const G = R.routeGroup;

    // tube du tracé
    const radius = Math.max(1.5, lay.extent * 0.0032);
    const curve = new T.CatmullRomCurve3(pts, false, 'centripetal');
    G.add(new T.Mesh(new T.TubeGeometry(curve, Math.min(2000, pts.length * 2), radius, 6, false), new T.MeshLambertMaterial({ color: ROUTE_COLOR })));

    // rideau du tracé au fond, de plus en plus transparent vers le bas
    const pos = new Float32Array(pts.length * 6), col = new Float32Array(pts.length * 8), ind = [];
    const c = new T.Color(ROUTE_COLOR);
    pts.forEach((v, i) => {
      pos.set([v.x, v.y, v.z, v.x, 0, v.z], i * 6);
      col.set([c.r, c.g, c.b, 0.42, c.r, c.g, c.b, 0.04], i * 8);
      if (i) { const a = (i - 1) * 2; ind.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    const cg = new T.BufferGeometry();
    cg.setAttribute('position', new T.BufferAttribute(pos, 3));
    cg.setAttribute('color', new T.BufferAttribute(col, 4));
    cg.setIndex(ind);
    G.add(new T.Mesh(cg, new T.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: T.DoubleSide })));

    // ombre du tracé sur le fond
    G.add(new T.Line(new T.BufferGeometry().setFromPoints(pts.map((v) => new T.Vector3(v.x, 0.4, v.z))), new T.LineBasicMaterial({ color: 0x1a1a19, transparent: true, opacity: 0.55 })));

    // départ, arrivée, point survolé
    const ball = (color, r) => new T.Mesh(new T.SphereGeometry(r, 16, 12), new T.MeshLambertMaterial({ color }));
    const a = ball(0x2fa84f, radius * 2.4), b = ball(0xe5484d, radius * 2.4);
    a.position.copy(pts[0]); b.position.copy(pts[pts.length - 1]);
    G.add(a, b);
    R.hoverMarker = ball(HOVER_COLOR, radius * 2.6);
    R.hoverMarker.visible = false;
    G.add(R.hoverMarker);
    lastHover = null;
  }

  function info() {
    const l = R.lay, p = store.profile;
    if (!l || !p) return;
    el.info.textContent = `${U.fmt(p.length / 1000, 1)} km · altitude ${U.fmt(l.eleMin)} à ${U.fmt(l.eleMax)} m · relief ×${U.fmt(R.exag, R.exag % 1 ? 1 : 0)}`;
  }

  /** Fond de carte : les tuiles qui couvrent le tracé, assemblées sur une image posée à plat (altitude 0). */
  function buildGround() {
    const T = R.three, lay = R.lay;
    const token = ++R.token;
    const list = BASES[R.base].sources.map(specById).filter(Boolean);
    if (!list.length) { say('Fond de carte indisponible.'); return; }
    let attempt = 0;
    const start = () => {
      const spec = list[attempt];
      const [x0, y0, x1, y1] = lay.box, m = Math.max(x1 - x0, y1 - y0) * 0.12 + 1e-6;
      const t = pickTiles(x0 - m, y0 - m, x1 + m, y1 + m, spec.maxZoom);
      const n = 2 ** t.z;
      const canvas = document.createElement('canvas');
      canvas.width = t.nx * 256; canvas.height = t.ny * 256;
      const g = canvas.getContext('2d');
      g.fillStyle = '#e9e7e1'; g.fillRect(0, 0, canvas.width, canvas.height);
      const tex = new T.CanvasTexture(canvas);
      if ('colorSpace' in tex) tex.colorSpace = T.SRGBColorSpace;
      tex.generateMipmaps = false; tex.minFilter = T.LinearFilter;
      tex.anisotropy = R.renderer.capabilities.getMaxAnisotropy();
      // le plan couvre exactement la grille de tuiles
      const w = t.nx / n * lay.mPerUnit, d = t.ny / n * lay.mPerUnit;
      const cx = ((t.tx0 + t.nx / 2) / n - lay.center[0]) * lay.mPerUnit, cz = ((t.ty0 + t.ny / 2) / n - lay.center[1]) * lay.mPerUnit;
      const plane = new T.Mesh(new T.PlaneGeometry(w, d), new T.MeshBasicMaterial({ map: tex }));
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(cx, 0, cz);
      clearGround();
      R.ground = plane;
      R.root.add(plane);
      el.attr.innerHTML = spec.attribution || '';
      R.groundSpan = Math.max(w, d);

      let ok = 0, err = 0, done = 0, pending = false;
      const total = t.nx * t.ny;
      const refresh = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; tex.needsUpdate = true; R.dirty = true; }); };
      for (let j = 0; j < t.ny; j++) {
        for (let i = 0; i < t.nx; i++) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            if (token !== R.token) return;
            g.drawImage(img, i * 256, j * 256, 256, 256);
            ok++; done++; refresh();
            if (done === total) say('');
          };
          img.onerror = () => {
            if (token !== R.token) return;
            err++; done++;
            // le premier fond refuse les tuiles (OpenStreetMap sans Referer…) : on passe au suivant
            if (!ok && err >= 3 && attempt + 1 < list.length) { attempt++; start(); return; }
            if (done === total) say(ok ? '' : 'Fond de carte indisponible (connexion ?) : le tracé reste visible.');
          };
          img.src = tileUrl(spec, t.z, t.tx0 + i, t.ty0 + j);
        }
      }
      say('Chargement du fond de carte…');
    };
    start();
    R.dirty = true;
  }

  /** Exagération changée : le tracé est refait, le fond reste. */
  function rebuildRelief() {
    buildRoute();
    if (R.nav.t) R.nav.t.y = yOf(R.lay.range) * 0.3;
    applyCamera();
    info();
  }

  /* ---------- Caméra ---------- */

  function resetView() {
    const l = R.lay;
    if (!l) return;
    R.nav.t = new R.three.Vector3(0, yOf(l.range) * 0.3, 0);
    // la caméra recule jusqu'à voir toute la boîte du tracé (étendue × étendue × relief)
    const rho = 0.5 * Math.hypot(l.extent, l.extent, yOf(l.range));
    R.nav.r = rho / Math.tan(R.camera.fov * Math.PI / 360) * 1.1;
    R.nav.az = 0; R.nav.el = 0.7;
    applyCamera();
  }

  function applyCamera() {
    const n = R.nav, c = R.camera;
    if (!n.t || !c) return;
    c.position.set(n.t.x + n.r * Math.cos(n.el) * Math.sin(n.az), n.t.y + n.r * Math.sin(n.el), n.t.z + n.r * Math.cos(n.el) * Math.cos(n.az));
    c.near = Math.max(1, n.r / 200); c.far = n.r * 60 + 1e5;
    c.updateProjectionMatrix();
    c.lookAt(n.t);
    R.dirty = true;
  }

  function bindControls(cv) {
    const ptrs = new Map();
    let moved = false, pinch = 0;
    cv.style.touchAction = 'none';
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    });
    cv.addEventListener('pointermove', (e) => {
      const q = ptrs.get(e.pointerId);
      if (!q) { hoverAt(e); return; }
      const dx = e.clientX - q.x, dy = e.clientY - q.y;
      q.x = e.clientX; q.y = e.clientY;
      moved = true;
      const n = R.nav;
      if (ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) n.r = U.clamp(n.r * pinch / d, minR(), maxR());
        pinch = d;
        pan(dx / 2, dy / 2);
      } else if (e.shiftKey || e.buttons & 6) pan(dx, dy);
      else {
        n.az -= dx * 0.006;
        n.el = U.clamp(n.el + dy * 0.006, 0.05, 1.53);
      }
      applyCamera();
    });
    const up = (e) => { ptrs.delete(e.pointerId); pinch = 0; if (!ptrs.size && !moved) hoverAt(e); };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (!ptrs.size) emitHover(null); });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      R.nav.r = U.clamp(R.nav.r * Math.exp(e.deltaY * 0.0012), minR(), maxR());
      applyCamera();
    }, { passive: false });
    cv.addEventListener('dblclick', resetView);
  }
  const minR = () => Math.max(30, R.lay ? R.lay.extent * 0.04 : 30);
  const maxR = () => (R.lay ? R.lay.extent * 8 : 1e5);

  /** Déplacement dans le plan du sol, selon l'orientation de la caméra (dx, dy en pixels). */
  function pan(dx, dy) {
    const n = R.nav, k = n.r * 0.0016;
    const rx = Math.cos(n.az), rz = -Math.sin(n.az), fx = -Math.sin(n.az), fz = -Math.cos(n.az);
    n.t.x -= (rx * dx - fx * dy) * k;
    n.t.z -= (rz * dx - fz * dy) * k;
  }

  /* ---------- Survol : tracé 3D ↔ profil ---------- */

  let lastHover = null;
  function emitHover(s) {
    if (s === lastHover) return;
    lastHover = s;
    store.emit('hover', { s, from: 'map3d' });
  }

  /** Point du tracé le plus proche du pointeur (à moins de 22 px) → survol partagé avec le profil. */
  function hoverAt(e) {
    if (!R.sample || !R.lay) return;
    const r = R.renderer.domElement.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const v = new R.three.Vector3();
    let best = 22 * 22, bi = -1;
    R.sample.idx.forEach((i, k) => {
      v.set(R.lay.pos[3 * i], yOf(R.lay.pos[3 * i + 1]), R.lay.pos[3 * i + 2]).project(R.camera);
      if (v.z > 1) return;
      const dx = (v.x + 1) / 2 * r.width - px, dy = (1 - v.y) / 2 * r.height - py;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bi = k; }
    });
    emitHover(bi < 0 ? null : R.sample.s[bi]);
  }

  /** Repère jaune à la distance s (m) : survol venu du profil ou du tracé 3D. */
  function showHover(s) {
    const m = R.hoverMarker, l = R.lay, p = store.profile;
    if (!m || !l || !p) return;
    if (s == null) { m.visible = false; el.tip.hidden = true; R.dirty = true; return; }
    const f = U.clamp(s / p.step, 0, p.n - 1), i = Math.min(p.n - 2, Math.floor(f)), t = f - i;
    const at = (c) => l.pos[3 * i + c] * (1 - t) + l.pos[3 * (i + 1) + c] * t;
    m.position.set(at(0), yOf(at(1)), at(2));
    m.visible = true;
    // étiquette près du repère
    const v = m.position.clone().project(R.camera), w = el.box.clientWidth, h = el.box.clientHeight;
    el.tip.textContent = `km ${U.fmt(s / 1000, 1)} · ${U.fmt(l.eleMin + at(1))} m`;
    el.tip.style.left = U.clamp((v.x + 1) / 2 * w + 12, 4, w - 130) + 'px';
    el.tip.style.top = U.clamp((1 - v.y) / 2 * h - 30, 4, h - 30) + 'px';
    el.tip.hidden = false;
    R.dirty = true;
  }

  /** Position à l'écran (px, dans la vue) du point à la distance s (m), ou null : pour vérifier le survol. */
  function screenOf(s) {
    const l = R.lay, p = store.profile;
    if (!l || !p || !R.camera) return null;
    const i = U.clamp(Math.round(s / p.step), 0, p.n - 1);
    const v = new R.three.Vector3(l.pos[3 * i], yOf(l.pos[3 * i + 1]), l.pos[3 * i + 2]).project(R.camera);
    return { x: (v.x + 1) / 2 * el.box.clientWidth, y: (1 - v.y) / 2 * el.box.clientHeight };
  }

  /* ---------- Affichage ---------- */

  function frame() {
    R.raf = 0;
    if (!R.on) return;
    if (R.dirty && R.renderer) { R.dirty = false; R.renderer.render(R.scene, R.camera); }
    R.raf = requestAnimationFrame(frame);
  }

  async function setOn(on) {
    R.on = on;
    document.body.dataset.view3d = on ? 'on' : 'off';
    el.box.hidden = !on;
    for (const b of el.switch.querySelectorAll('button')) b.setAttribute('aria-pressed', String((b.dataset.view === '3d') === on));
    if (!on) { emitHover(null); return; }
    say('Chargement de la vue 3D…');
    try {
      R.three = await loadThree();
      if (!R.renderer) setupRenderer();
    } catch (e) {
      say(e && /WebGL/i.test(e.message) ? 'La vue 3D demande WebGL, indisponible ici.' : `Vue 3D indisponible : ${e.message}`);
      return;
    }
    if (!R.on) return;
    resize();
    build();
    if (!R.raf) R.raf = requestAnimationFrame(frame);
  }

  const init = function () {
    el.box = D.$ && D.$('#route3d');
    if (!el.box) return;
    el.switch = D.$('#view-switch');
    el.msg = D.$('#r3-msg'); el.info = D.$('#r3-info'); el.tip = D.$('#r3-tip'); el.attr = D.$('#r3-attr');
    el.exag = D.$('#r3-exag'); el.exagOut = D.$('#r3-exag-out');
    for (const b of el.switch.querySelectorAll('button')) b.addEventListener('click', () => setOn(b.dataset.view === '3d'));
    for (const b of el.box.querySelectorAll('[data-base]')) {
      b.addEventListener('click', () => {
        R.base = b.dataset.base;
        for (const o of el.box.querySelectorAll('[data-base]')) o.setAttribute('aria-pressed', String(o === b));
        if (R.on && R.lay) buildGround();
      });
    }
    el.exag.addEventListener('input', () => {
      R.exagUser = R.exag = parseFloat(el.exag.value);
      el.exagOut.textContent = '×' + U.fmt(R.exag, R.exag % 1 ? 1 : 0);
      if (R.on && R.lay) rebuildRelief();
    });
    D.$('#r3-reset').addEventListener('click', resetView);
    store.on('profile', U.debounce(() => { if (R.on && R.three && R.renderer) build(); }, 150));
    store.on('hover', ({ s }) => { if (R.on) showHover(s); });
  };

  PYR.route3d = { init, screenOf, merc, pickTiles, autoExag, layout, tileUrl, get on() { return R.on; } };
})(globalThis.PYR = globalThis.PYR || {});
