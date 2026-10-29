/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page Parcours : le parcours en 3D. Deux vues, au choix :
 *   - « 3D » : le terrain lui-même en relief (un modèle numérique d'altitude, les tuiles Terrarium), la carte plaquée dessus,
 *     et le tracé posé sur sa surface ;
 *   - « 2D + 3D » : le fond de carte posé à plat, et le tracé qui flotte au-dessus, chaque point à une hauteur proportionnelle à son
 *     altitude (un rideau le relie au fond, une ombre au sol rappelle son tracé).
 * Le fond de carte est au choix un plan, une carte topographique ou une image satellite. La vue remplace la carte (bouton
 * « 2D / 2D + 3D / 3D » de l'en-tête : « 2D » est la carte, « 2D + 3D » le fond à plat, « 3D » le terrain) ; la carte et ses outils
 * de tracé reviennent avec « 2D ».
 *
 * three.js n'est chargé qu'à la première ouverture (le fichier de Bike3D, Jeu/3D/univers/vendor/three.min.js). Le fond est une image
 * assemblée à partir des tuiles qui couvrent le parcours (au plus 8 × 8, au zoom le plus fin qui le permette) ; l'altitude vient de
 * tuiles Terrarium (altitude codée dans la couleur, au plus 8 × 8 aussi) échantillonnées sur un maillage d'au plus 256 × 256 mailles.
 * La projection est celle de Mercator, à l'échelle du centre du parcours (1 unité = 1 m). Une exagération verticale (réglable) rend
 * le relief lisible : à ×1 un col de 1 000 m sur 20 km est presque plat.
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
    plan: { sources: ['osm', 'carto'] },       // OpenStreetMap, puis CARTO si OpenStreetMap refuse les tuiles (Referer)
    topo: { sources: ['topo'] },               // OpenTopoMap : courbes de niveau
    sat: { sources: ['sat'] },                 // Esri
  };
  const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';   // altitude = R × 256 + V + B / 256 − 32768 (m)
  const DEM_ZOOM = 14;              // zoom maximal des tuiles d'altitude (≈ 10 m par pixel à 45°)
  const MESH_MAX = 256;             // mailles du terrain, par côté
  const DEM_ATTR = 'Relief : <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (AWS)';
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

  /** Exagération verticale conseillée : le relief atteint la part `share` de l'étendue (entre ×1 et ×max, au demi près). */
  function autoExag(extent, range, share = 0.3, max = 10) {
    if (!(range > 0)) return 1;
    return U.clamp(Math.round(2 * share * extent / range) / 2, 1, max);
  }

  /** Altitude d'un tableau de mailles (segX + 1 colonnes) à la position (u, v) ∈ [0, 1]², interpolée entre les quatre mailles voisines. */
  function sampleGrid(h, segX, segZ, u, v) {
    const fx = U.clamp(u, 0, 1) * segX, fz = U.clamp(v, 0, 1) * segZ;
    const i = Math.min(segX - 1, Math.floor(fx)), j = Math.min(segZ - 1, Math.floor(fz)), a = fx - i, b = fz - j, w = segX + 1;
    const k = j * w + i;
    return (h[k] * (1 - a) + h[k + 1] * a) * (1 - b) + (h[k + w] * (1 - a) + h[k + w + 1] * a) * b;
  }

  /** Altitude (m) codée dans un pixel de tuile Terrarium. */
  const terrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

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
    mode: 'terrain', base: 'plan', exagUser: null, exag: 1,
    tex: null, spec: null, grid: null, dem: null, ys: null, groundMat: null, status: {}, warn: '',
    renderer: null, scene: null, camera: null, root: null,
    nav: { az: 0, el: 0.8, r: 1000, t: null }, routeGroup: null, hoverMarker: null, groundSpan: 0,
    lay: null, sample: null, ground: null, demToken: 0, dirty: true, raf: 0, token: 0, hoverS: null,
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

  /** Géométries et matières (les textures sont à part : R.tex). */
  function dispose(o) {
    o.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    });
  }
  function clearRoute() {
    if (!R.routeGroup) return;
    for (const o of [...R.routeGroup.children]) { R.routeGroup.remove(o); dispose(o); }
    R.sample = null; R.hoverMarker = null; R.ys = null;
  }
  function clearGround() {
    if (!R.ground) return;
    R.root.remove(R.ground); dispose(R.ground); R.ground = null; R.groundMat = null;
  }

  /** Le terrain est-il affiché en relief (vue « 3D », altitudes chargées) ? Sinon le fond est à plat. */
  const terrain = () => R.mode === 'terrain' && !!R.dem;
  /** Altitude exagérée. */
  function yOf(alt) { return alt * R.exag; }
  /** Hauteur (m, exagérée) du relief affiché : sert à cadrer la caméra. */
  const heightSpan = () => yOf(terrain() ? R.dem.max - R.dem.min : R.lay.range);

  /** Tuiles du fond (les mêmes pour toutes les cartes) et rectangle qu'elles couvrent, en mètres autour du centre du tracé. */
  function gridOf(lay) {
    const [x0, y0, x1, y1] = lay.box, m = Math.max(x1 - x0, y1 - y0) * 0.12 + 1e-6;
    const t = pickTiles(x0 - m, y0 - m, x1 + m, y1 + m, MAX_ZOOM), n = 2 ** t.z;
    return Object.assign(t, {
      n, w: t.nx / n * lay.mPerUnit, d: t.ny / n * lay.mPerUnit,
      cx: ((t.tx0 + t.nx / 2) / n - lay.center[0]) * lay.mPerUnit, cz: ((t.ty0 + t.ny / 2) / n - lay.center[1]) * lay.mPerUnit,
    });
  }

  /** Exagération : celle de l'utilisateur, sinon une valeur qui rend le relief lisible (plus modeste sur un vrai terrain). */
  function chooseExag() {
    const l = R.lay;
    R.exag = R.exagUser != null ? R.exagUser : terrain() ? autoExag(Math.max(R.grid.w, R.grid.d), R.dem.max - R.dem.min, 0.12, 4) : autoExag(l.extent, l.range);
    el.exag.value = String(R.exag);
    el.exagOut.textContent = '×' + U.fmt(R.exag, R.exag % 1 ? 1 : 0);
  }

  /** Tout reconstruire : tracé, fond, relief et caméra. */
  function build() {
    const p = store.profile;
    clearRoute(); clearGround();
    if (R.tex) { R.tex.dispose(); R.tex = null; }
    R.dem = null; R.demToken++; R.token++; R.warn = '';
    el.tip.hidden = true;
    if (!p || p.n < 2) { R.lay = null; R.status = {}; say('Trace un parcours sur la carte pour le voir en 3D.'); el.info.textContent = ''; R.dirty = true; return; }
    const lay = R.lay = layout(p);
    R.grid = gridOf(lay);
    chooseExag();
    buildImagery();
    buildRoute();
    placeGround();
    resetView();
    info();
    if (R.mode === 'terrain') loadDem();
  }

  /** Le tracé, à la hauteur de l'exagération : posé sur le terrain, ou flottant au-dessus du fond à plat (avec son rideau et son ombre). */
  function buildRoute() {
    const p = store.profile, lay = R.lay, T = R.three, g = R.grid;
    clearRoute();
    const onTerrain = terrain();
    const radius = onTerrain ? Math.max(1.2, lay.extent * 0.0022) : Math.max(1.5, lay.extent * 0.0032);
    // hauteur du tracé en chaque point du profil
    const ys = R.ys = new Float32Array(p.n);
    for (let i = 0; i < p.n; i++) {
      if (onTerrain) {
        const dem = R.dem, u = (lay.pos[3 * i] - g.cx + g.w / 2) / g.w, v = (lay.pos[3 * i + 2] - g.cz + g.d / 2) / g.d;
        ys[i] = (sampleGrid(dem.h, dem.segX, dem.segZ, u, v) - dem.min) * R.exag + radius * 1.2;
      } else ys[i] = yOf(lay.pos[3 * i + 1]);
    }
    // échantillons du tracé (sous-échantillonnage régulier, dernier point compris)
    const stride = Math.max(1, Math.ceil(p.n / MAX_SAMPLES));
    const idx = [];
    for (let i = 0; i < p.n; i += stride) idx.push(i);
    if (idx[idx.length - 1] !== p.n - 1) idx.push(p.n - 1);
    R.sample = { idx, s: idx.map((i) => i * p.step) };
    const pts = idx.map((i) => new T.Vector3(lay.pos[3 * i], ys[i], lay.pos[3 * i + 2]));
    const G = R.routeGroup;

    // tube du tracé
    const curve = new T.CatmullRomCurve3(pts, false, 'centripetal');
    G.add(new T.Mesh(new T.TubeGeometry(curve, Math.min(2000, pts.length * 2), radius, 6, false), new T.MeshLambertMaterial({ color: ROUTE_COLOR })));

    if (!onTerrain) {
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
    }

    // départ, arrivée, point survolé
    const ball = (color, r) => new T.Mesh(new T.SphereGeometry(r, 16, 12), new T.MeshLambertMaterial({ color }));
    const a = ball(0x2fa84f, radius * 2.4), b = ball(0xe5484d, radius * 2.4);
    a.position.copy(pts[0]); b.position.copy(pts[pts.length - 1]);
    G.add(a, b);
    R.hoverMarker = ball(HOVER_COLOR, radius * 2.6);
    R.hoverMarker.visible = false;
    G.add(R.hoverMarker);
    lastHover = null;
    R.dirty = true;
  }

  function info() {
    const l = R.lay, p = store.profile;
    if (!l || !p) return;
    el.info.textContent = `${U.fmt(p.length / 1000, 1)} km · altitude ${U.fmt(l.eleMin)} à ${U.fmt(l.eleMax)} m · relief ×${U.fmt(R.exag, R.exag % 1 ? 1 : 0)}`;
  }

  /** Message d'état : chargements en cours, ou avertissement qui reste (fond ou relief indisponible). */
  function refreshMsg() {
    const loading = [R.status.tiles === 'loading' && 'du fond de carte', R.status.dem === 'loading' && 'du relief'].filter(Boolean);
    say(loading.length ? `Chargement ${loading.join(' et ')}…` : R.warn);
  }

  /** Le sol : un plan, ou le terrain en relief ; il porte l'image du fond de carte (R.tex). */
  function placeGround() {
    const T = R.three, g = R.grid;
    if (!R.tex || !g) return;
    clearGround();
    const group = new T.Group();
    group.position.set(g.cx, 0, g.cz);
    if (terrain()) {
      const dem = R.dem;
      const geo = new T.PlaneGeometry(g.w, g.d, dem.segX, dem.segZ);
      geo.rotateX(-Math.PI / 2);          // la première rangée de mailles est au nord
      const pos = geo.attributes.position;
      for (let k = 0; k < pos.count; k++) pos.setY(k, (dem.h[k] - dem.min) * R.exag);
      geo.computeVertexNormals();
      R.groundMat = new T.MeshLambertMaterial({ map: R.tex });
      group.add(new T.Mesh(geo, R.groundMat), skirt(dem));
    } else {
      R.groundMat = new T.MeshBasicMaterial({ map: R.tex });
      const plane = new T.Mesh(new T.PlaneGeometry(g.w, g.d), R.groundMat);
      plane.rotation.x = -Math.PI / 2;
      group.add(plane);
    }
    R.ground = group;
    R.root.add(group);
    el.attr.innerHTML = (R.spec ? R.spec.attribution || '' : '') + (terrain() ? ' | ' + DEM_ATTR : '');
    R.dirty = true;
  }

  /** Flancs du bloc de terrain, du bord du relief jusqu'à une base plate : la carte devient une maquette. */
  function skirt(dem) {
    const T = R.three, g = R.grid, w = dem.segX + 1;
    const top = (i, j) => [(i / dem.segX - 0.5) * g.w, (dem.h[j * w + i] - dem.min) * R.exag, (j / dem.segZ - 0.5) * g.d];
    const edges = [];
    for (let i = 0; i <= dem.segX; i++) edges.push([i, 0]);
    for (let j = 1; j <= dem.segZ; j++) edges.push([dem.segX, j]);
    for (let i = dem.segX - 1; i >= 0; i--) edges.push([i, dem.segZ]);
    for (let j = dem.segZ - 1; j >= 0; j--) edges.push([0, j]);   // se referme sur le premier point
    const base = -Math.max(heightSpan() * 0.1, g.w * 0.012);
    const pos = new Float32Array(edges.length * 6), ind = [];
    edges.forEach(([i, j], k) => {
      const t = top(i, j);
      pos.set([t[0], t[1], t[2], t[0], base, t[2]], k * 6);
      if (k) { const a = (k - 1) * 2; ind.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setIndex(ind);
    geo.computeVertexNormals();
    return new T.Mesh(geo, new T.MeshLambertMaterial({ color: 0x7a746b, side: T.DoubleSide }));
  }

  /** Fond de carte : les tuiles qui couvrent le tracé, assemblées sur une image (R.tex) qui se remplit au fil des chargements. */
  function buildImagery() {
    const T = R.three, g = R.grid;
    const token = ++R.token;
    const list = BASES[R.base].sources.map(specById).filter(Boolean);
    if (!list.length) { R.warn = 'Fond de carte indisponible.'; refreshMsg(); return; }
    let attempt = 0;
    const start = () => {
      const spec = R.spec = list[attempt];
      const canvas = document.createElement('canvas');
      canvas.width = g.nx * 256; canvas.height = g.ny * 256;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#e9e7e1'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const tex = new T.CanvasTexture(canvas);
      if ('colorSpace' in tex) tex.colorSpace = T.SRGBColorSpace;
      tex.generateMipmaps = false; tex.minFilter = T.LinearFilter;
      tex.anisotropy = R.renderer.capabilities.getMaxAnisotropy();
      if (R.tex) R.tex.dispose();
      R.tex = tex;
      if (R.groundMat) { R.groundMat.map = tex; R.groundMat.needsUpdate = true; }
      el.attr.innerHTML = (spec.attribution || '') + (terrain() ? ' | ' + DEM_ATTR : '');
      R.status.tiles = 'loading'; R.warn = ''; refreshMsg();

      let ok = 0, err = 0, done = 0, pending = false;
      const total = g.nx * g.ny;
      const refresh = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; tex.needsUpdate = true; R.dirty = true; }); };
      for (let j = 0; j < g.ny; j++) {
        for (let i = 0; i < g.nx; i++) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            if (token !== R.token) return;
            ctx.drawImage(img, i * 256, j * 256, 256, 256);
            ok++; done++; refresh();
            if (done === total) { R.status.tiles = 'ok'; refreshMsg(); }
          };
          img.onerror = () => {
            if (token !== R.token) return;
            err++; done++;
            // le premier fond refuse les tuiles (OpenStreetMap sans Referer…) : on passe au suivant
            if (!ok && err >= 3 && attempt + 1 < list.length) { attempt++; start(); return; }
            if (done === total) {
              R.status.tiles = ok ? 'ok' : 'fail';
              if (!ok) R.warn = 'Fond de carte indisponible (connexion ?) : le tracé reste visible.';
              refreshMsg();
            }
          };
          img.src = tileUrl(spec, g.z, g.tx0 + i, g.ty0 + j);
        }
      }
    };
    start();
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('tuile d\'altitude indisponible'));
      img.src = url;
    });
  }

  /**
   * Altitudes du terrain sur le rectangle du fond : les tuiles Terrarium qui le couvrent (au plus 8 × 8), échantillonnées sur un
   * maillage de segX × segZ mailles (≤ 256). Renvoie {h, segX, segZ, min, max} ; h : (segX + 1) × (segZ + 1) altitudes, rangées du
   * nord au sud.
   */
  async function fetchDem(g) {
    const e = 1e-9;
    const t = pickTiles(g.tx0 / g.n + e, g.ty0 / g.n + e, (g.tx0 + g.nx) / g.n - e, (g.ty0 + g.ny) / g.n - e, DEM_ZOOM), m = 2 ** t.z;
    const W = t.nx * 256, H = t.ny * 256;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const jobs = [];
    for (let j = 0; j < t.ny; j++) {
      for (let i = 0; i < t.nx; i++) {
        jobs.push(loadImage(tileUrl({ url: DEM_URL }, t.z, t.tx0 + i, t.ty0 + j)).then((img) => ctx.drawImage(img, i * 256, j * 256, 256, 256)));
      }
    }
    await Promise.all(jobs);
    const px = ctx.getImageData(0, 0, W, H).data;     // échoue si le serveur n'autorise pas la lecture des pixels (CORS)
    const at = (x, y) => {
      const k = 4 * (U.clamp(y, 0, H - 1) * W + U.clamp(x, 0, W - 1));
      return terrarium(px[k], px[k + 1], px[k + 2]);
    };
    const segX = Math.min(MESH_MAX, g.nx * 40), segZ = Math.min(MESH_MAX, g.ny * 40);
    const h = new Float32Array((segX + 1) * (segZ + 1));
    let min = Infinity, max = -Infinity;
    for (let j = 0; j <= segZ; j++) {
      const fy = ((g.ty0 + j / segZ * g.ny) / g.n * m - t.ty0) * 256 - 0.5, y0 = Math.floor(fy), b = fy - y0;
      for (let i = 0; i <= segX; i++) {
        const fx = ((g.tx0 + i / segX * g.nx) / g.n * m - t.tx0) * 256 - 0.5, x0 = Math.floor(fx), a = fx - x0;
        const v = (at(x0, y0) * (1 - a) + at(x0 + 1, y0) * a) * (1 - b) + (at(x0, y0 + 1) * (1 - a) + at(x0 + 1, y0 + 1) * a) * b;
        h[j * (segX + 1) + i] = v;
        if (v < min) min = v; if (v > max) max = v;
      }
    }
    return { h, segX, segZ, min, max };
  }

  /** Charge le relief, puis passe le sol et le tracé en 3D ; sans lui (hors connexion, serveur refusant la lecture), retour à plat. */
  async function loadDem() {
    const token = ++R.demToken;
    R.status.dem = 'loading';
    refreshMsg();
    let dem = null;
    try { dem = await fetchDem(R.grid); } catch (err) { dem = null; }
    if (token !== R.demToken || !R.on || !R.lay) return;
    R.status.dem = dem ? 'ok' : 'fail';
    if (dem) R.dem = dem;
    else { R.warn = 'Relief indisponible (connexion ?) : affichage en 2D + 3D.'; setMode('flat', true); }
    refresh3d();
  }

  /** Sol, tracé et caméra refaits d'après le mode et le relief courants. */
  function refresh3d() {
    chooseExag();
    buildRoute();
    placeGround();
    resetView();
    info();
    refreshMsg();
  }

  function setMode(mode, keepWarn) {
    R.mode = mode;
    syncSwitch();
    if (!R.lay || !R.on) return;
    R.exagUser = null;                     // l'exagération conseillée n'est pas la même à plat et sur un terrain
    if (!keepWarn) R.warn = '';
    R.demToken++;
    if (mode === 'terrain' && !R.dem) { R.status.dem = 'loading'; refreshMsg(); loadDem(); return; }
    R.status.dem = R.dem ? 'ok' : '';
    if (!keepWarn) refresh3d();
  }

  /** Exagération changée : le sol et le tracé sont refaits, les images restent. */
  function rebuildRelief() {
    placeGround();
    buildRoute();
    if (R.nav.t) R.nav.t.y = targetY();
    applyCamera();
    info();
  }

  /* ---------- Caméra ---------- */

  /** Hauteur visée par la caméra : le tiers du relief affiché, ou la hauteur moyenne du tracé sur un terrain. */
  function targetY() {
    if (terrain() && R.ys) { let t = 0; for (let i = 0; i < R.ys.length; i++) t += R.ys[i]; return t / R.ys.length; }
    return heightSpan() * 0.3;
  }

  function resetView() {
    const l = R.lay;
    if (!l) return;
    R.nav.t = new R.three.Vector3(0, targetY(), 0);
    // la caméra recule jusqu'à voir toute la boîte du tracé (étendue × étendue × relief)
    const rho = 0.5 * Math.hypot(l.extent, l.extent, heightSpan());
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
    if (!R.sample || !R.lay || !R.ys) return;
    const r = R.renderer.domElement.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const v = new R.three.Vector3();
    let best = 22 * 22, bi = -1;
    R.sample.idx.forEach((i, k) => {
      v.set(R.lay.pos[3 * i], R.ys[i], R.lay.pos[3 * i + 2]).project(R.camera);
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
    if (!m || !l || !p || !R.ys) return;
    if (s == null) { m.visible = false; el.tip.hidden = true; R.dirty = true; return; }
    const f = U.clamp(s / p.step, 0, p.n - 1), i = Math.min(p.n - 2, Math.floor(f)), t = f - i;
    const at = (c) => l.pos[3 * i + c] * (1 - t) + l.pos[3 * (i + 1) + c] * t;
    m.position.set(at(0), R.ys[i] * (1 - t) + R.ys[i + 1] * t, at(2));
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
    if (!l || !p || !R.camera || !R.ys) return null;
    const i = U.clamp(Math.round(s / p.step), 0, p.n - 1);
    const v = new R.three.Vector3(l.pos[3 * i], R.ys[i], l.pos[3 * i + 2]).project(R.camera);
    return { x: (v.x + 1) / 2 * el.box.clientWidth, y: (1 - v.y) / 2 * el.box.clientHeight };
  }

  /* ---------- Affichage ---------- */

  function frame() {
    R.raf = 0;
    if (!R.on) return;
    if (R.dirty && R.renderer) { R.dirty = false; R.renderer.render(R.scene, R.camera); }
    R.raf = requestAnimationFrame(frame);
  }

  /** Bouton de l'en-tête : 2D (la carte), 2D + 3D (fond à plat, tracé en relief au-dessus) ou 3D (le terrain en relief). */
  function syncSwitch() {
    const now = R.on ? R.mode : 'map';
    for (const b of el.switch.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === now));
  }

  function setView(view) {
    if (view === 'map') { setOn(false); return; }
    if (R.on) setMode(view);
    else { R.mode = view; R.exagUser = null; setOn(true); }
  }

  async function setOn(on) {
    R.on = on;
    document.body.dataset.view3d = on ? 'on' : 'off';
    el.box.hidden = !on;
    syncSwitch();
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
    for (const b of el.switch.querySelectorAll('button')) b.addEventListener('click', () => setView(b.dataset.view));
    for (const b of el.box.querySelectorAll('[data-base]')) {
      b.addEventListener('click', () => {
        R.base = b.dataset.base;
        for (const o of el.box.querySelectorAll('[data-base]')) o.setAttribute('aria-pressed', String(o === b));
        if (R.on && R.lay) buildImagery();
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

  PYR.route3d = { init, screenOf, sampleGrid, terrarium, merc, pickTiles, autoExag, layout, tileUrl, get on() { return R.on; } };
})(globalThis.PYR = globalThis.PYR || {});
