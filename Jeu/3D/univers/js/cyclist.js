/* Bike3D — cycliste cartoon et son vélo, animés (pédalage, roues, danseuse, position aéro).
   L'équipement se règle (opts.gear, le magasin de PaceYourRide) : cadre (route alu, endurance, grimpeur, aéro, contre-la-montre,
   gravel, VTT, ville), roues (jante plate, alu 25 mm, carbone 30, 45, 60 ou 80 mm, lenticulaire, gravel), pneus, position sur le vélo
   (buste relevé, cocottes, bas du cintre, prolongateurs…), casque, tenue, lunettes, chaussettes et chaussures, et le sexe (une cycliste a
   sa morphologie). Sans équipement : le vélo de course du jeu, roues à bâtons. Trois niveaux de détail du cycliste (opts.detail) : simple
   (le modèle cartoon, pour les petites configurations), détaillé et réaliste (js/anatomy.js), dans la même pose. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { mat, addOutline, textTexture } = B3D.toon;
  const { clamp, lerp } = B3D.util;

  const JERSEYS = {
    jaune: { name: 'Maillot jaune', base: '#ffd23a', accent: '#1d1a2b', style: 'plain' },
    pois: { name: 'Maillot à pois', base: '#ffffff', accent: '#e2463a', style: 'dots' },
    vert: { name: 'Maillot vert', base: '#4cc35a', accent: '#ffffff', style: 'plain' },
    arcenciel: { name: 'Champion du monde', base: '#ffffff', accent: '#000000', style: 'rainbow' },
    bleu: { name: 'Équipe bleue', base: '#3d7be0', accent: '#ffffff', style: 'stripe' }
  };

  const R = 0.34; // rayon de roue (pneu compris)
  const TORSO = 0.59; // du bassin aux épaules
  const UP = new THREE.Vector3(0, 1, 0), ZAX = new THREE.Vector3(0, 0, 1);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  /* Cadres : couleur et liseré, hauteur du haut du tube de selle (st), pente du tube de selle (seat, dz/dy), hauteur du haut de la douille
     (ht) et bas de la douille (hb : [y, z]), recul de la selle (saddleZ), grosseur des tubes (k), profil des tubes (prof : profondeur
     sur largeur, 1 = rond), haubans abaissés (stays : hauteur sur le tube de selle), cintre (bar), évasement du cintre (flare), fourche,
     garde-boue et porte-bagages, bidon. hug : jeu (m) d'un tube oblique qui épouse la roue avant (contre-la-montre). classic : le vélo
     du jeu, à la couleur imposée. */
  const FRAME_BASE = { st: 0.815, seat: 0.3065, ht: 0.86, hb: [0.70, 0.41], k: 1, prof: 1, stays: 0, bar: 'drop', flare: 0, fork: 'road', bottle: true };
  const FRAMES = {
    classic: {},
    alu: { color: '#3d7be0', accent: '#ffffff', k: 1.3 },
    endurance: { color: '#e2463a', accent: '#ffffff', st: 0.80, ht: 0.895, k: 1.05 },
    climber: { color: '#f4f1ea', accent: '#e2463a', k: 0.78 },
    aero: { color: '#2a2833', accent: '#ff4d6d', st: 0.80, k: 1.1, prof: 2.3, stays: 0.6, bar: 'aero' },
    tt: { color: '#2a2833', accent: '#ffd23a', st: 0.79, seat: 0.2126, saddleZ: -0.215, ht: 0.80, hb: [0.66, 0.422], k: 1.1, prof: 2.7, stays: 0.58, bar: 'tt', bottle: false, hug: 0.02 },
    gravel: { color: '#6f8f5a', accent: '#e9d8a6', st: 0.76, ht: 0.90, hb: [0.71, 0.407], k: 1.15, flare: 0.045 },
    mtb: { color: '#ff7a1a', accent: '#26232f', st: 0.74, ht: 0.88, hb: [0.73, 0.41], k: 1.4, bar: 'flat', fork: 'susp' },
    city: { color: '#2f8f83', accent: '#f4f1ea', st: 0.75, ht: 0.92, k: 1.15, bar: 'city', fenders: true, rack: true }
  };
  const HEAD = 0.3125; // pente de l'axe de direction (dz/dy, 72,6°)
  const BOTTLE_R = 0.035;

  /* Points du cadre dans le repère du vélo (y en haut, z vers l'avant) : axes des roues (la roue avant devant l'axe de direction, comme
     avec le déport d'une vraie fourche), boîtier, tube de selle, douille, tube oblique et bidon. Le tube oblique est droit, ou (hug)
     droit jusqu'à son point de tangence avec un cercle autour de l'axe avant, puis en arc sur ce cercle jusqu'à la douille : il
     épouse la roue sans la toucher. dtHalf : demi-épaisseur du tube oblique dans le plan du cadre (un tube profilé est plus profond). */
  function frameLayout(F) {
    const rearAxle = V(0, R, -0.5), frontAxle = V(0, R, 0.57);
    const BB = V(0, 0.28, -0.08);
    const onSeat = (y) => V(0, y, BB.z - (y - BB.y) * F.seat); // point du tube de selle (ou de son prolongement) à la hauteur y
    const onHead = (y) => V(0, y, F.hb[1] - (y - F.hb[0]) * HEAD); // point de l'axe de direction à la hauteur y
    const L = { rearAxle, frontAxle, BB, onSeat, onHead, stTop: onSeat(F.st), htTop: onHead(F.ht), htBot: V(0, F.hb[0], F.hb[1]), saddle: onSeat(0.965) };
    if (F.saddleZ) L.saddle.z = F.saddleZ;
    L.dtHalf = 0.026 * F.k * (F.prof > 1.2 ? Math.sqrt(F.prof) : 1);
    L.dt = [BB, onHead(F.hb[0] + 0.05)]; // partie droite (le liseré et le bidon s'y posent)
    L.arc = null;
    if (F.hug) {
      const A = frontAxle, rc = R + L.dtHalf + F.hug, at = (a) => V(0, A.y + Math.sin(a) * rc, A.z + Math.cos(a) * rc);
      // point de tangence depuis le boîtier, au-dessus de la roue (angles mesurés depuis l'avant, dans le plan z, y)
      let a0 = Math.atan2(BB.y - A.y, BB.z - A.z);
      if (a0 < 0) a0 += Math.PI * 2;
      const from = a0 - Math.acos(rc / Math.hypot(BB.y - A.y, BB.z - A.z));
      // arrivée sur l'axe de direction (y = hb + s), à la même distance de l'axe de roue : racine haute
      const c0 = F.hb[0] - A.y, c1 = F.hb[1] - A.z, qa = 1 + HEAD * HEAD, qb = 2 * (c0 - c1 * HEAD), qc = c0 * c0 + c1 * c1 - rc * rc;
      const s = (-qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
      const to = Math.atan2(c0 + s, c1 - s * HEAD);
      if (to < from) { L.dt = [BB, at(from)]; L.arc = { center: A, r: rc, from, to, at }; }
    }
    // bidon : contre le tube oblique, côté intérieur du cadre, parallèle au tube, bouchon vers la douille
    const u = L.dt[1].clone().sub(BB).normalize(), inward = V(0, u.z, -u.y);
    L.bottle = { center: BB.clone().addScaledVector(u, 0.25).addScaledVector(inward, L.dtHalf + BOTTLE_R + 0.003), dir: u };
    return L;
  }
  const frameOf = (id) => Object.assign({}, FRAME_BASE, FRAMES[id]);

  /* Roues : hauteur de jante (depth, m), couleur, piste de freinage, nombre de rayons, rayons croisés ou radiaux, jante large (gravel).
     tri : les roues à trois bâtons du jeu ; disc : lenticulaire à l'arrière et 80 mm à l'avant. */
  const WHEELS = {
    tri: { tri: true },
    box: { depth: 0.018, rim: '#c9ced8', track: '#e4e7ee', spokes: 32, spoke: '#b9bec8', cross: true },
    alu: { depth: 0.025, rim: '#2f2e36', track: '#c9ced8', spokes: 24, cross: true },
    climb: { depth: 0.03, carbon: true, spokes: 24 },
    c45: { depth: 0.045, carbon: true, spokes: 20 },
    c65: { depth: 0.06, carbon: true, spokes: 20 },
    c80: { depth: 0.08, carbon: true, spokes: 18 },
    disc: { rear: 'lenticular', front: 'c80' },
    gravel: { depth: 0.025, rim: '#2f2e36', spokes: 28, cross: true, wide: true }
  };

  /* Pneus : demi-section (m), flanc beige (wall), crampons (knobs : hauteur). */
  const TIRES = {
    race: { r: 0.016, wall: '#c8955a' },
    road: { r: 0.018 },
    tubeless: { r: 0.019 },
    training: { r: 0.02 },
    gravel: { r: 0.029, wall: '#b88a52', knobs: 0.006 },
    mtb: { r: 0.035, knobs: 0.01 }
  };

  /* Positions (celles de PaceYourRide) : prise des mains et extension des bras (e, 1 = tendus) ; pads : coudes sur les manchettes. */
  const POSITIONS = {
    upright: { grip: 'tops', e: 1.0 },
    tops: { grip: 'tops', e: 0.97 },
    hoods: { grip: 'hoods', e: 0.97 },
    hoods_bent: { grip: 'hoods', e: 0.8 },
    drops: { grip: 'drops', e: 0.86 },
    forearms: { grip: 'forearms', tuckK: 0.4 },
    tt: { grip: 'pads', tuckK: 0.25 },
    tt_pro: { grip: 'pads', tuckK: 0.25, pro: true }
  };
  const HELMETS = { road: 1, city: 1, aero: 1, tt: 1 };
  const CLOTHING = { loose: 1, fitted: 1, aero: 1, skinsuit: 1, skinsuit_tt: 1 };
  const GLASSES = { none: 1, sport: 1, shield: 1 };
  const SOCKS = { short: 0, classic: 0.11, aero: 0.2 }; // hauteur au-dessus de la cheville
  const SHOES = { flat: '#e3ddcf', mtb: '#3a3944', road: '#ffffff', carbon: '#26232f', aero: '#1d1a2b' };
  // semelle et molettes (ou lacets) des chaussures des niveaux détaillé et réaliste
  const SHOE_PARTS = { flat: ['#b9905e', '#f4f1ea'], mtb: ['#26232f', '#c9ced8'], road: ['#1d1a2b', '#26232f'], carbon: ['#1d1a2b', '#e2463a'], aero: ['#1d1a2b', '#3a3944'] };
  const SEXES = { m: 1, f: 1 };

  /* Niveaux de détail du cycliste : simple (le modèle cartoon d'origine, pour les petites configurations), détaillé et réaliste
     (B3D.anatomy : visage, buste, jambes et pieds modelés, proportions réelles ; le réaliste est plus fin et ajoute les finitions). */
  const DETAILS = ['simple', 'detailed', 'realistic'];
  const detailLevel = (d) => (typeof d === 'number' ? clamp(Math.round(d), 0, 2) : Math.max(0, DETAILS.indexOf(d)));
  const SKIN = '#f1c29b';
  const HAIR = { m: '#4a3426', f: '#6b4423' };
  const HEAD_FINE = 0.8; // tête à l'échelle réelle (le modèle simple a une grosse tête de dessin animé)

  const has = (t, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(t, k);
  /** Équipement complet et valide (les valeurs inconnues prennent celles du vélo du jeu). */
  function normGear(g) {
    g = g || {};
    const pick = (t, k, d) => (has(t, k) ? k : d);
    return {
      frame: pick(FRAMES, g.frame, 'classic'), wheels: pick(WHEELS, g.wheels, 'tri'), tire: pick(TIRES, g.tire, 'road'),
      position: pick(POSITIONS, g.position, 'hoods'), helmet: pick(HELMETS, g.helmet, 'road'), clothing: pick(CLOTHING, g.clothing, 'fitted'),
      glasses: pick(GLASSES, g.glasses, 'sport'), socks: pick(SOCKS, g.socks, 'short'), shoes: pick(SHOES, g.shoes, 'road'),
      sex: pick(SEXES, g.sex, 'm')
    };
  }

  // Textures et matériaux partagés (le magasin reconstruit le cycliste à chaque essai d'article)
  const texCache = new Map();
  function cached(key, make) {
    if (!texCache.has(key)) texCache.set(key, make());
    return texCache.get(key);
  }
  const toonMap = (map) => new THREE.MeshToonMaterial({ map, gradientMap: B3D.toon.gradientMap() });

  function jerseyTexture(j) {
    return cached('jersey|' + j.base + '|' + j.accent + '|' + j.style, () => textTexture((ctx, w, h) => {
      ctx.fillStyle = j.base;
      ctx.fillRect(0, 0, w, h);
      // texture plaquée sur un ellipsoïde : u = tour du buste, v = du bas (0) vers le haut (1)
      if (j.style === 'dots') {
        ctx.fillStyle = j.accent;
        for (let y = 16; y < h; y += 30) for (let x = ((y / 30) % 2) * 16 + 8; x < w; x += 32) { ctx.beginPath(); ctx.ellipse(x, y, 9, 8, 0, 0, Math.PI * 2); ctx.fill(); }
      } else if (j.style === 'rainbow') {
        const cols = ['#3d7be0', '#e2463a', '#1d1a2b', '#f2c230', '#4cc35a'];
        cols.forEach((c, k) => { ctx.fillStyle = c; ctx.fillRect(0, h * 0.42 + k * 10, w, 10); });
      } else if (j.style === 'stripe') {
        ctx.fillStyle = j.accent;
        ctx.fillRect(0, h * 0.42, w, 22);
      } else {
        ctx.fillStyle = j.accent;
        ctx.fillRect(0, h * 0.2, w, 10);
      }
    }, 256, 256));
  }

  /* Jante ou roue pleine tournée (LatheGeometry) : u = tour de roue, v = le long du profil (bandes : bands[k] = [v0, v1, couleur]) ;
     text : inscription répétée sur les bandes marquées « txt ». */
  function rimMaterial(key, base, bands, text) {
    return cached('rim|' + key, () => toonMap(textTexture((ctx, w, h) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);
      for (const [v0, v1, col] of bands) {
        const y0 = (1 - v1) * h, y1 = (1 - v0) * h;
        if (col !== 'txt') { ctx.fillStyle = col; ctx.fillRect(0, y0, w, y1 - y0); continue; }
        ctx.fillStyle = '#f4f1ea';
        ctx.font = '700 ' + Math.round((y1 - y0) * 0.78) + 'px Fredoka, Arial, sans-serif';
        ctx.textBaseline = 'middle';
        for (let k = 0; k < 4; k++) ctx.fillText(text, k * w / 4 + 10, (y0 + y1) / 2);
      }
    }, 1024, 128)));
  }

  class Cyclist {
    /* opts : jersey (maillot du jeu) ou custom (maillot imposé {base, accent, style}, par exemple la couleur du joueur dans
       PaceYourRide), bikeColor, gear (équipement, voir GEAR ; gear.sex : 'f' pour une cycliste), sex (sans équipement), detail (niveau de
       détail : 'simple', 'detailed', 'realistic'). */
    constructor(opts = {}) {
      this.jersey = opts.custom || JERSEYS[opts.jersey] || JERSEYS.jaune;
      this.bikeColor = opts.bikeColor || '#e2463a';
      this.gear = normGear(Object.assign({ sex: opts.sex }, opts.gear)); // le sexe de l'équipement l'emporte (profil de PaceYourRide)
      this.custom = !!opts.gear; // équipement choisi (sinon le vélo du jeu)
      this.detail = detailLevel(opts.detail);
      this.fem = this.gear.sex === 'f';
      this.root = new THREE.Group(); // positionné / orienté dans le monde
      this.body = new THREE.Group(); // inclinaison (danseuse)
      this.root.add(this.body);
      this.crank = 0;
      this.strokes = 0; // nombre de coups de pédale (un par demi-tour de pédalier)
      this.wheelAngle = 0;
      this.rock = 0;
      this.standT = 0;
      this.tuckT = 0;
      this.time = 0;
      this.effortT = 0;
      this._v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      this._w = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      this._m = new THREE.Matrix4();
      this._buildBike();
      this._buildRider();
      this.plan = this._plan(this.gear.position, false);
      this.planStand = this._plan('hoods', true);
      this.root.traverse((o) => { if (o.isMesh && !o.userData.isOutline && !o.userData.noShadow) { o.castShadow = true; } });
      this._buildLights();
    }

    // Phare (projecteur qui éclaire la route) et feu arrière, allumés la nuit. Le projecteur existe toujours
    // (intensité nulle le jour) pour ne pas recompiler tous les matériaux quand il s'allume.
    _buildLights() {
      const front = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.06, 10), new THREE.MeshBasicMaterial({ color: '#fffbe6' }));
      front.rotation.x = Math.PI / 2;
      front.position.copy(this.ck.lamp);
      const rear = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.025), new THREE.MeshBasicMaterial({ color: '#ff2a2a' }));
      rear.position.set(0, this.saddle.y - 0.105, this.saddle.z - 0.07);
      this.bikeGroup.add(front, rear);
      this.lamps = [front, rear];
      const spot = this.spot = new THREE.SpotLight('#fff1d0', 0, 55, 0.5, 0.55, 1.6);
      spot.position.set(0, 0.95, 0.6);
      spot.target.position.set(0, 0, 14);
      spot.castShadow = false;
      this.root.add(spot, spot.target);
      this.setLights(0);
    }

    setLights(k) {
      this.spot.intensity = 90 * k;
      for (const m of this.lamps) m.visible = k > 0.05;
    }

    // Cylindre entre deux points (statique) ; prof : tube profilé (profondeur / largeur) pour les cadres aéro
    _tube(a, b, r, m, parent, prof) {
      const len = a.distanceTo(b);
      const geo = new THREE.CylinderGeometry(r, r, len, prof > 1.2 ? 12 : 8);
      if (prof > 1.2) geo.scale(1 / Math.sqrt(prof), 1, Math.sqrt(prof));
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
      (parent || this.bikeGroup).add(mesh);
      addOutline(mesh, { width: 0.7, minW: 0.005, maxW: 0.03 });
      return mesh;
    }

    // Tube courbe (cintre, prolongateurs) passant par des points
    _curve(pts, r, m, outline = true) {
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), 24, r, 6, false), m);
      this.bikeGroup.add(mesh);
      if (outline) addOutline(mesh, { width: 0.7, minW: 0.004, maxW: 0.03 });
      return mesh;
    }

    _box(sx, sy, sz, m, x, y, z, rx = 0, parent) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
      mesh.position.set(x, y, z);
      mesh.rotation.x = rx;
      (parent || this.bikeGroup).add(mesh);
      addOutline(mesh, { width: 0.7, minW: 0.004, maxW: 0.03 });
      return mesh;
    }

    _buildBike() {
      const G = this.gear;
      const F = this.F = frameOf(G.frame);
      if (G.frame === 'classic') { F.color = this.bikeColor; F.accent = this.bikeColor === '#1d1a2b' ? '#ffd23a' : '#ffffff'; }
      const frame = mat(F.color);
      const accent = mat(F.accent);
      const dark = mat('#26232f');
      const metal = mat('#c9ced8');
      const g = this.bikeGroup = new THREE.Group();
      this.body.add(g);
      const L = this.layout = frameLayout(F);
      const { rearAxle, frontAxle, BB, onSeat, onHead, stTop, htTop, htBot, saddle } = L;
      this.BB = BB;
      this.htTop = htTop;
      this.saddle = saddle;
      const k = F.k, pf = F.prof, aero = pf > 1.2;
      this._tube(BB, stTop, 0.022 * k, frame, null, pf);
      this._tube(stTop, onHead(F.ht - 0.02), 0.02 * k, frame, null, aero ? 1.5 : 1);
      if (L.arc) this._downTubeHug(L, 0.026 * k, frame, pf);
      else this._tube(L.dt[0], L.dt[1], 0.026 * k, frame, null, pf);
      this._tube(htBot, htTop, 0.028 * k, frame, null, aero ? 1.6 : 1);
      const stayTop = F.stays ? onSeat(F.stays) : stTop;
      for (const sx of [-1, 1]) {
        this._tube(stayTop, V(sx * 0.055, R, -0.5), 0.012 * Math.min(k, 1.2), frame);
        this._tube(BB, V(sx * 0.055, R, -0.5), 0.014 * Math.min(k, 1.2), frame);
      }
      this._fork(F, htBot, frontAxle, frame, dark, metal);
      if (G.frame !== 'classic') this._decals(F, stTop, L.dt, accent);
      // tige de selle + selle
      this._tube(stTop, V(0, saddle.y - 0.015, saddle.z + 0.003), 0.013 * (aero ? 1.3 : 1), aero ? frame : metal, null, aero ? 2 : 1);
      const sad = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), dark);
      sad.scale.set(F.bar === 'tt' ? 0.06 : 0.07, 0.03, 0.14);
      sad.position.set(0, saddle.y, saddle.z);
      g.add(sad);
      addOutline(sad, { width: 0.7, minW: 0.004, maxW: 0.03 });
      this._cockpit(F, frame, dark, metal);
      if (F.bottle) this._bottle(L.bottle, dark);
      if (F.fenders) this._fenders(F, frame);
      if (F.rack) this._rack(stTop, dark);

      // roues
      const W = WHEELS[G.wheels];
      this.wheels = [];
      for (const [axle, front] of [[rearAxle, false], [frontAxle, true]]) {
        const w = W.tri ? this._triWheel(axle) : this._wheel(axle, W.rear ? (front ? WHEELS[W.front] : { lenticular: true }) : W, TIRES[G.tire], front);
        g.add(w);
        this.wheels.push(w);
      }
      // pédalier (et chaîne, avec l'équipement choisi)
      const cr = this.crankGroup = new THREE.Group();
      cr.position.copy(BB);
      g.add(cr);
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.012, 20), metal);
      ring.rotation.z = Math.PI / 2;
      ring.position.x = -0.06;
      cr.add(ring);
      addOutline(ring, { width: 0.6, minW: 0.003, maxW: 0.02 });
      const flat = G.shoes === 'flat';
      for (const sx of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.03), dark);
        arm.position.set(sx * 0.085, -sx * 0.085, 0);
        cr.add(arm);
        const pedal = new THREE.Mesh(new THREE.BoxGeometry(flat ? 0.1 : 0.09, 0.02, flat ? 0.1 : 0.07), dark);
        pedal.position.set(sx * 0.13, -sx * 0.17, 0);
        cr.add(pedal);
      }
      if (this.custom) {
        const cas = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.035, 0.035, 14), metal);
        cas.rotation.z = Math.PI / 2;
        cas.position.set(-0.055, R, -0.5);
        g.add(cas);
        addOutline(cas, { width: 0.6, minW: 0.003, maxW: 0.02 });
        const chain = mat('#4a4852');
        this._tube(V(-0.06, BB.y + 0.1, BB.z), V(-0.06, R + 0.045, -0.5), 0.005, chain);
        this._tube(V(-0.06, BB.y - 0.1, BB.z), V(-0.06, R - 0.07, -0.47), 0.005, chain);
        this._box(0.012, 0.09, 0.03, dark, -0.07, R - 0.05, -0.5, 0.3); // dérailleur
      }
    }

    // Fourche : route (fines), aéro (profilées), suspendue (VTT)
    _fork(F, htBot, axle, frame, dark, metal) {
      for (const sx of [-1, 1]) {
        if (F.fork === 'susp') {
          // plongeurs du té jusqu'à y = 0,53, fourreaux de y = 0,56 jusqu'à l'axe
          const crown = V(sx * 0.06, htBot.y - 0.03, htBot.z + 0.01), foot = V(sx * 0.06, R, axle.z);
          const at = (y) => crown.clone().lerp(foot, (crown.y - y) / (crown.y - foot.y));
          this._tube(crown, at(0.53), 0.017, metal);
          this._tube(at(0.56), foot, 0.024, dark);
        } else {
          this._tube(V(sx * 0.04, htBot.y, htBot.z), V(sx * 0.05, R, axle.z), 0.014 * (F.prof > 1.2 ? 1.25 : 1), frame, null, F.prof > 1.2 ? 2 : 1);
        }
      }
      if (F.fork === 'susp') this._box(0.15, 0.035, 0.05, dark, 0, htBot.y - 0.03, htBot.z + 0.01);
    }

    // Liseré de couleur sur le tube oblique (sa partie droite : [BB, fin]) et le tube de selle
    _decals(F, stTop, [BB, end], accent) {
      const k = F.k, pf = F.prof;
      const dt = end.clone().sub(BB);
      const a = BB.clone().addScaledVector(dt, 0.42), b = BB.clone().addScaledVector(dt, 0.72);
      const m = this._tube(a, b, 0.0262 * k * 1.03, accent, null, pf);
      m.scale.x = 1.06;
      const ds = stTop.clone().sub(BB);
      this._tube(BB.clone().addScaledVector(ds, 0.78), BB.clone().addScaledVector(ds, 0.9), 0.0222 * k * 1.03, accent, null, pf).scale.x = 1.06;
    }

    // Cintre et prises de mains (dans le repère du vélo) : cocottes, haut et bas du cintre, manchettes et prolongateurs.
    _cockpit(F, frame, dark, metal) {
      const ht = this.htTop, P = POSITIONS[this.gear.position];
      const pads = P.grip === 'pads';
      const ck = this.ck = {};
      if (F.bar === 'drop' || F.bar === 'aero') {
        const aero = F.bar === 'aero';
        const by = ht.y + (aero ? 0.012 : 0.025), bz = ht.z + 0.14, w = 0.21, fl = F.flare;
        if (aero) {
          // cintre et potence d'une pièce, haut du cintre plat
          this._tube(ht, V(0, by, bz - 0.01), 0.018, frame, null, 1.8);
          this._box(2 * (w - 0.02), 0.014, 0.06, frame, 0, by, bz);
        } else {
          this._tube(ht, V(0, by, bz), 0.016, dark);
        }
        for (const sx of [-1, 1]) {
          const pts = [V(sx * (aero ? w - 0.025 : 0), by, bz), V(sx * (w - 0.03), by, bz + 0.002), V(sx * w, by + 0.006, bz + 0.05),
            V(sx * (w + fl * 0.15), by + 0.01, bz + 0.1), V(sx * (w + fl * 0.4), by - 0.035, bz + 0.12), V(sx * (w + fl * 0.8), by - 0.09, bz + 0.095),
            V(sx * (w + fl), by - 0.115, bz + 0.035)];
          this._curve(pts, 0.012, dark);
          this._box(0.035, 0.05, 0.06, dark, sx * (w + fl * 0.15), by + 0.03, bz + 0.085, -0.25); // cocotte
          this._box(0.012, 0.09, 0.016, dark, sx * (w + fl * 0.3), by - 0.035, bz + 0.122, 0.12); // levier
        }
        Object.assign(ck, {
          hoods: [w + fl * 0.15 - 0.005, by + 0.045, bz + 0.08], tops: [0.15, by + 0.038, bz - 0.005], drops: [w + fl * 0.7, by - 0.075, bz + 0.07],
          forearm: [0.14, by + 0.048, bz - 0.02], forearmHand: [0.1, by + 0.035, bz + 0.24], lamp: V(0, by - 0.045, bz + 0.06), dropBar: true
        });
        if (pads) this._clipOns(by + 0.012, bz - 0.03, P.pro, dark);
      } else if (F.bar === 'tt') {
        // cintre de base (aile) avec cornes et leviers, manchettes sur rehausses, prolongateurs
        const by = ht.y - 0.015, bz = ht.z + 0.115;
        this._tube(ht, V(0, by, bz), 0.02, frame, null, 1.8);
        this._box(0.3, 0.014, 0.05, frame, 0, by, bz);
        for (const sx of [-1, 1]) {
          this._curve([V(sx * 0.145, by, bz), V(sx * 0.19, by - 0.003, bz + 0.035), V(sx * 0.205, by - 0.008, bz + 0.09), V(sx * 0.205, by - 0.012, bz + 0.13)], 0.012, dark);
          this._box(0.02, 0.025, 0.05, dark, sx * 0.205, by - 0.012, bz + 0.15);
        }
        this._clipOns(by, bz - 0.04, P.pro, dark, 0.07);
        Object.assign(ck, { hoods: [0.205, by + 0.038, bz + 0.1], tops: [0.12, by + 0.04, bz], drops: [0.205, by + 0.038, bz + 0.1], lamp: V(0, by - 0.045, bz + 0.05) });
        ck.dropsE = 0.86;
        if (!pads) { ck.forearm = ck.pad; ck.forearmHand = ck.ext; }
      } else if (F.bar === 'flat') {
        const by = ht.y + 0.05, bz = ht.z + 0.11;
        this._tube(ht, V(0, by, bz), 0.018, dark);
        this._tube(V(-0.33, by, bz), V(0.33, by, bz), 0.013, dark);
        for (const sx of [-1, 1]) {
          this._tube(V(sx * 0.255, by, bz), V(sx * 0.335, by, bz), 0.019, mat('#3a3944'));
          this._box(0.1, 0.012, 0.02, dark, sx * 0.21, by + 0.005, bz + 0.05);
        }
        Object.assign(ck, { hoods: [0.29, by + 0.04, bz], tops: [0.29, by + 0.04, bz], drops: [0.29, by + 0.04, bz], lamp: V(0, by - 0.04, bz + 0.05) });
        if (pads) this._clipOns(by + 0.01, bz - 0.03, P.pro, dark);
      } else {
        // ville : cintre relevé, poignées ramenées vers le cycliste
        const by = ht.y + 0.06, bz = ht.z + 0.07;
        this._tube(ht, V(0, by, bz), 0.018, dark);
        for (const sx of [-1, 1]) {
          this._curve([V(0, by, bz), V(sx * 0.15, by + 0.01, bz + 0.012), V(sx * 0.24, by + 0.02, bz - 0.045), V(sx * 0.268, by + 0.025, bz - 0.12)], 0.013, dark);
          this._tube(V(sx * 0.262, by + 0.024, bz - 0.085), V(sx * 0.272, by + 0.026, bz - 0.165), 0.019, mat('#7a5232'));
        }
        Object.assign(ck, { hoods: [0.27, by + 0.06, bz - 0.12], tops: [0.27, by + 0.06, bz - 0.12], drops: [0.27, by + 0.06, bz - 0.12], lamp: V(0, by - 0.05, bz + 0.06) });
        if (pads) this._clipOns(by + 0.01, bz + 0.02, P.pro, dark);
      }
      if (!ck.dropsE) ck.dropsE = ck.dropBar ? 0.86 : 0.8;
    }

    // Manchettes et prolongateurs (cintre de contre-la-montre, ou rapportés sur un autre cintre) ; pro : mains hautes
    _clipOns(y, z, pro, dark, rise = 0.035) {
      const px = pro ? 0.075 : 0.09, py = y + rise;
      for (const sx of [-1, 1]) {
        if (rise > 0.04) this._tube(V(sx * px, y, z), V(sx * px, py - 0.01, z), 0.01, dark);
        this._box(0.075, 0.02, 0.12, mat('#3a3944'), sx * px, py, z);
        const tx = pro ? 0.04 : 0.05, ty = py + (pro ? 0.1 : 0.06), tz = z + (pro ? 0.29 : 0.31);
        this._curve([V(sx * (px - 0.015), py - 0.005, z + 0.03), V(sx * (px - 0.025), py, z + 0.16), V(sx * (tx + 0.004), py + (pro ? 0.04 : 0.02), z + 0.26), V(sx * tx, ty, tz)], 0.011, dark);
      }
      this.ck.pad = [px, py + 0.06, z];
      this.ck.ext = pro ? [0.045, py + 0.085, z + 0.25] : [0.055, py + 0.06, z + 0.27];
    }

    // Tube oblique qui épouse la roue avant (L.arc) : un seul tube profilé, droit puis en arc, ses bouts fermés
    _downTubeHug(L, r, m, prof) {
      const [BB, T] = L.dt, { from, to, at } = L.arc;
      const u = T.clone().sub(BB).normalize(), path = [[BB, u]];
      const n = Math.max(2, Math.ceil((from - to) / 0.04));
      for (let i = 0; i <= n; i++) {
        const a = from + (to - from) * i / n; // tangente : sens de parcours, l'angle décroît
        path.push([at(a), V(0, -Math.cos(a), Math.sin(a))]);
      }
      return this._sweep(path, r, m, prof);
    }

    // Tube le long d'un chemin du plan du cadre ([point, tangente unitaire], x = 0) ; section en ellipse comme _tube (prof), bouts fermés
    _sweep(path, r, m, prof) {
      const seg = 12, rx = prof > 1.2 ? r / Math.sqrt(prof) : r, rn = prof > 1.2 ? r * Math.sqrt(prof) : r;
      const pos = [], idx = [];
      const ring = (p, t) => {
        for (let j = 0; j < seg; j++) {
          const a = (j / seg) * Math.PI * 2, c = Math.cos(a) * rx, s = Math.sin(a) * rn; // s : le long de la normale (0, -tz, ty)
          pos.push(p.x + c, p.y - t.z * s, p.z + t.y * s);
        }
      };
      for (const [p, t] of path) ring(p, t);
      for (let i = 0; i + 1 < path.length; i++) {
        for (let j = 0; j < seg; j++) {
          const a = i * seg + j, b = i * seg + (j + 1) % seg;
          idx.push(a, a + seg, b, b, a + seg, b + seg);
        }
      }
      // bouts : anneaux à part (arêtes vives, comme un cylindre) et un centre
      for (const [end, sgn] of [[0, -1], [path.length - 1, 1]]) {
        const [p, t] = path[end], o = pos.length / 3;
        ring(p, t);
        pos.push(p.x, p.y, p.z);
        for (let j = 0; j < seg; j++) {
          const a = o + j, b = o + (j + 1) % seg;
          if (sgn < 0) idx.push(o + seg, a, b); else idx.push(o + seg, b, a);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, m);
      this.bikeGroup.add(mesh);
      addOutline(mesh, { width: 0.7, minW: 0.005, maxW: 0.03 });
      return mesh;
    }

    // Bidon sur son porte-bidon, bouchon vers le haut du tube
    _bottle(B, dark) {
      const g = new THREE.Group();
      g.position.copy(B.center);
      g.quaternion.setFromUnitVectors(UP, B.dir);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(BOTTLE_R, BOTTLE_R, 0.17, 12), mat('#ffffff'));
      body.position.y = -0.015;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.026, 0.03, 10), dark);
      cap.position.y = 0.085;
      // porte-bidon : deux arceaux sombres autour du bidon
      for (const y of [-0.07, 0.035]) {
        const hoop = new THREE.Mesh(new THREE.TorusGeometry(BOTTLE_R + 0.002, 0.0035, 4, 16), dark);
        hoop.rotation.x = Math.PI / 2;
        hoop.position.y = y;
        g.add(hoop);
      }
      g.add(body, cap);
      for (const o of [body, cap]) addOutline(o, { width: 0.7, minW: 0.004, maxW: 0.03 });
      this.bikeGroup.add(g);
    }

    _fenders(F, frame) {
      const m = mat(F.accent);
      for (const [z, start] of [[this.layout.rearAxle.z, -0.35], [this.layout.frontAxle.z, 1.3]]) {
        const geo = new THREE.TorusGeometry(R + 0.03, 0.016, 5, 28, 2.2);
        geo.rotateZ(start);
        geo.scale(1, 1, 1.9);
        const f = new THREE.Mesh(geo, m);
        f.rotation.y = Math.PI / 2;
        f.position.set(0, R, z);
        this.bikeGroup.add(f);
        addOutline(f, { width: 0.6, minW: 0.003, maxW: 0.02 });
      }
    }

    _rack(stTop, dark) {
      for (const sx of [-1, 1]) {
        this._tube(V(sx * 0.07, 0.74, -0.24), V(sx * 0.07, 0.74, -0.66), 0.008, dark);
        this._tube(V(sx * 0.07, 0.74, -0.6), V(sx * 0.06, R, -0.5), 0.008, dark);
      }
      this._tube(V(-0.07, 0.74, -0.66), V(0.07, 0.74, -0.66), 0.008, dark);
      this._tube(V(0, 0.74, -0.24), stTop.clone().lerp(V(0, 0.74, -0.24), 0.2), 0.008, dark);
    }

    // Roue à trois bâtons du jeu
    _triWheel(axle) {
      const dark = mat('#26232f');
      const w = new THREE.Group();
      w.position.copy(axle);
      const tire = new THREE.Mesh(new THREE.TorusGeometry(R - 0.018, 0.02, 8, 30), dark);
      tire.rotation.y = Math.PI / 2;
      w.add(tire);
      addOutline(tire, { width: 0.7, minW: 0.005, maxW: 0.03 });
      // jante carbone haute : bande noire épaisse avec un liseré de couleur
      const rim = new THREE.Mesh(new THREE.TorusGeometry(R - 0.06, 0.03, 6, 30), mat('#2a2a32'));
      rim.rotation.y = Math.PI / 2;
      rim.scale.set(1, 1, 0.55);
      w.add(rim);
      const deco = new THREE.Mesh(new THREE.TorusGeometry(R - 0.06, 0.008, 4, 30), mat(this.bikeColor === '#1d1a2b' ? '#ffd23a' : '#ffffff'));
      deco.rotation.y = Math.PI / 2;
      deco.position.x = 0.018;
      w.add(deco);
      const deco2 = deco.clone();
      deco2.position.x = -0.018;
      w.add(deco2);
      for (let k = 0; k < 3; k++) {
        const a = k / 3 * Math.PI * 2;
        const sp = new THREE.Mesh(new THREE.BoxGeometry(0.014, R - 0.05, 0.045), mat(this.bikeColor));
        sp.position.set(0, Math.cos(a) * (R - 0.05) / 2, Math.sin(a) * (R - 0.05) / 2);
        sp.rotation.x = a;
        w.add(sp);
        addOutline(sp, { width: 0.6, minW: 0.003, maxW: 0.02 });
      }
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.11, 10), mat('#c9ced8'));
      hub.rotation.z = Math.PI / 2;
      w.add(hub);
      return w;
    }

    // Roue : pneu (flanc beige, crampons), jante profilée (ou roue pleine), rayons, moyeu
    _wheel(axle, W, T, front) {
      const dark = mat('#26232f');
      const w = new THREE.Group();
      w.position.copy(axle);
      const tr = T.r;
      const torus = (r, tube, m) => {
        const t = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 40), m);
        t.rotation.y = Math.PI / 2;
        w.add(t);
        return t;
      };
      if (T.wall) {
        torus(R - tr, tr * 0.97, mat(T.wall));
        const tread = torus(R - tr, tr * 1.02, dark);
        tread.scale.z = 0.66;
        addOutline(tread, { width: 0.7, minW: 0.005, maxW: 0.03 });
      } else {
        addOutline(torus(R - tr, tr, dark), { width: 0.7, minW: 0.005, maxW: 0.03 });
      }
      if (T.knobs) w.add(this._knobs(T, dark));
      const r0 = R - 2 * tr + 0.004; // bord de la jante, sous le talon du pneu
      const lathe = (pts) => {
        const geo = new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p[0], p[1])), 48);
        geo.rotateZ(Math.PI / 2); // axe de révolution : l'axe de la roue (x)
        return geo;
      };
      const sideLogo = this.custom ? 'PACE YOUR RIDE' : '';
      if (W.lenticular) {
        // roue pleine lenticulaire : une lentille du moyeu à la jante, logo en cercle
        const pts = [[0.035, -0.03], [0.12, -0.026], [0.22, -0.019], [r0 - 0.012, -0.013], [r0, -0.009], [r0, 0.009], [r0 - 0.012, 0.013], [0.22, 0.019], [0.12, 0.026], [0.035, 0.03]];
        const n = pts.length - 1;
        const m = rimMaterial('disc' + sideLogo, '#2a2833', [[1 / n, 2 / n, 'txt'], [7 / n, 8 / n, 'txt'], [3 / n, 4 / n, '#3a3944'], [5 / n, 6 / n, '#3a3944']], sideLogo || 'BIKE 3D');
        const disc = new THREE.Mesh(lathe(pts), m);
        w.add(disc);
        addOutline(disc, { width: 0.7, minW: 0.005, maxW: 0.03 });
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.075, 14), mat('#c9ced8'));
        hub.rotation.z = Math.PI / 2;
        w.add(hub);
        return w;
      }
      // jante : profil en U arrondi (carbone) ou plus plat (alu), plus large pour le gravel
      const d = W.depth, rb = r0 - d, w0 = W.wide ? 0.0125 : 0.0105;
      // profil parcouru pour que les faces regardent vers l'extérieur : fond de jante, flanc, face, rayonnage, et retour par l'autre côté
      const pts = [[r0, -w0], [r0, w0], [r0 - 0.12 * d, w0 * 1.06], [r0 - 0.82 * d, w0 * 0.88], [rb, 0], [r0 - 0.82 * d, -w0 * 0.88], [r0 - 0.12 * d, -w0 * 1.06], [r0, -w0]];
      const n = pts.length - 1;
      const track = W.track || '#3a3944', bands = [[1 / n, 2 / n, track], [6 / n, 1, track]];
      if (W.carbon && d >= 0.03) bands.push([2 / n, 3 / n, 'txt'], [5 / n, 6 / n, 'txt']);
      const rimMesh = new THREE.Mesh(lathe(pts), rimMaterial((W.carbon ? 'c' : W.rim) + d + (W.track || '') + sideLogo, W.carbon ? '#2a2833' : W.rim, bands, sideLogo || 'BIKE 3D'));
      w.add(rimMesh);
      addOutline(rimMesh, { width: 0.6, minW: 0.004, maxW: 0.025 });
      // rayons (une seule géométrie) : radiaux à l'avant pour le carbone, croisés sinon
      const n2 = W.spokes, parts = [], fx = front ? 0.03 : 0.036;
      const spokeGeo = new THREE.CylinderGeometry(0.0021, 0.0021, 1, 3, 1, true);
      const q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
      for (let k = 0; k < n2; k++) {
        const a = (k / n2) * Math.PI * 2, side = k % 2 ? 1 : -1;
        const off = W.cross || !front ? (k % 4 < 2 ? 1 : -1) * (W.cross ? 0.55 : 0.3) : 0;
        const hub = V(side * fx, Math.cos(a + off) * 0.026, Math.sin(a + off) * 0.026);
        const rim = V(side * 0.002, Math.cos(a) * (rb + 0.003), Math.sin(a) * (rb + 0.003));
        const dir = rim.clone().sub(hub);
        const len = dir.length();
        q.setFromUnitVectors(UP, dir.normalize());
        p.copy(hub).add(rim).multiplyScalar(0.5);
        s.set(1, len, 1);
        parts.push({ geo: spokeGeo, matrix: new THREE.Matrix4().compose(p, q, s) });
      }
      const spokes = new THREE.Mesh(B3D.toon.merge(parts), mat(W.spoke || '#3a3944'));
      spokeGeo.dispose();
      spokes.userData.noShadow = true;
      w.add(spokes);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, front ? 0.1 : 0.12, 10), mat('#c9ced8'));
      hub.rotation.z = Math.PI / 2;
      w.add(hub);
      for (const sx of [-1, 1]) {
        const fl = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.006, 12), mat('#c9ced8'));
        fl.rotation.z = Math.PI / 2;
        fl.position.x = sx * fx;
        w.add(fl);
      }
      return w;
    }

    // Crampons des pneus de gravel et de VTT (une seule géométrie)
    _knobs(T, m) {
      const n = T.knobs > 0.008 ? 34 : 46, parts = [], tr = T.r;
      const box = new THREE.BoxGeometry(1, 1, 1);
      const e = new THREE.Euler(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        for (const x of k % 2 ? [-0.5, 0.5] : [0]) {
          const lat = x * tr * 1.3, rr = R - tr + Math.sqrt(Math.max(0, tr * tr - lat * lat)) - T.knobs * 0.3;
          p.set(lat, Math.cos(a) * rr, Math.sin(a) * rr);
          e.set(a, 0, 0);
          q.setFromEuler(e);
          s.set(tr * (x ? 0.55 : 0.75), T.knobs * 1.6, tr * 0.5);
          parts.push({ geo: box, matrix: new THREE.Matrix4().compose(p, q, s) });
        }
      }
      const mesh = new THREE.Mesh(B3D.toon.merge(parts), m);
      box.dispose();
      mesh.userData.noShadow = true;
      return mesh;
    }

    _limb(r, m) {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, 1, 8), m);
      this.body.add(mesh);
      addOutline(mesh, { width: 0.8, minW: 0.005, maxW: 0.035 });
      return mesh;
    }

    _ball(r, m, parent) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), m);
      (parent || this.body).add(mesh);
      addOutline(mesh, { width: 0.8, minW: 0.005, maxW: 0.035 });
      return mesh;
    }

    _buildRider() {
      this.shoulderX = this.fem ? 0.18 : 0.19; // épaules (attache des bras)
      this.headDist = 0.22; // de l'épaule au centre de la tête
      if (this.detail) this._buildRiderFine();
      else this._buildRiderSimple();
    }

    // Modèle simple : sphères et cylindres
    _buildRiderSimple() {
      const G = this.gear, J = this.jersey;
      const skin = mat('#f1c29b');
      const suit = G.clothing === 'skinsuit' || G.clothing === 'skinsuit_tt';
      const loose = G.clothing === 'loose';
      const shorts = mat(suit ? J.base : loose ? '#5a6b7d' : '#26232f');
      const jerseyMat = toonMap(jerseyTexture(J));
      const sleeve = mat(J.base);
      const sockMat = mat(G.socks === 'aero' ? '#1d1a2b' : '#ffffff');
      const shoe = mat(SHOES[G.shoes]);
      this.torsoK = loose ? 1.16 : suit ? 0.96 : 1;
      // torse
      this.torso = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 14), jerseyMat);
      this.body.add(this.torso);
      addOutline(this.torso, { width: 0.9, minW: 0.006, maxW: 0.04 });
      this.pelvis = this._ball(0.15, shorts);
      this.pelvis.scale.set(loose ? 1.2 : 1.1, 0.75, loose ? 1.1 : 1.0);
      // tête + casque + lunettes
      this.head = new THREE.Group();
      this.body.add(this.head);
      const face = this._ball(0.135, skin, this.head);
      face.scale.set(0.95, 1.0, 1.0);
      // casque : blanc (route), noir (chrono), à la couleur du maillot (aéro, urbain) ; le vélo du jeu garde son casque assorti
      const helmetColor = !this.custom ? (this.jersey.style === 'plain' && this.jersey.base === '#ffd23a' ? '#ffd23a' : this.bikeColor)
        : { road: '#f4f1ea', tt: '#2a2833' }[G.helmet] || J.base;
      this._helmet(G.helmet, mat(helmetColor));
      if (G.helmet !== 'tt') this._glasses(G.glasses);
      const nose = this._ball(0.03, skin, this.head);
      nose.position.set(0, -0.025, 0.135);
      // sourire
      const smile = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.007, 4, 10, Math.PI), mat('#7a2b2b'));
      smile.position.set(0, -0.058, 0.112);
      smile.rotation.z = Math.PI;
      this.head.add(smile);
      this.neck = this._limb(0.05, skin);
      if (this.fem) {
        // cycliste : poitrine (dans le repère de la sphère du buste) et queue de cheval sous le casque
        for (const sx of [-1, 1]) {
          const b = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), sleeve);
          b.position.set(sx * 0.36, 0.28, 0.76);
          b.scale.set(0.3, 0.17, 0.34);
          this.torso.add(b);
          addOutline(b, { width: 0.7, minW: 0.004, maxW: 0.03 });
        }
        const tail = this._ball(1, mat(HAIR.f), this.head);
        tail.position.set(0, -0.08, -0.17);
        tail.rotation.x = -0.35;
        tail.scale.set(0.04, 0.095, 0.045);
      }

      // bras / jambes : segments recalculés à chaque image ; manches longues (combinaison chrono) ou jusqu'au coude (maillot aéro)
      const longSleeves = G.clothing === 'skinsuit_tt';
      const elbowSleeve = longSleeves || G.clothing === 'aero';
      this.arms = [];
      for (const sx of [-1, 1]) {
        this.arms.push({
          sx,
          upper: this._limb(loose ? 0.068 : 0.055, sleeve), fore: this._limb(0.045, longSleeves ? sleeve : skin),
          elbow: this._ball(0.05, elbowSleeve ? sleeve : skin), hand: this._ball(0.05, mat('#26232f')), shoulder: this._ball(loose ? 0.075 : 0.065, sleeve)
        });
      }
      this.sockH = SOCKS[G.socks];
      const over = G.shoes === 'aero'; // couvre-chaussures
      this.legs = [];
      for (const sx of [-1, 1]) {
        this.legs.push({
          sx,
          thigh: this._limb(loose ? 0.09 : 0.078, shorts), shin: this._limb(0.058, skin), knee: this._ball(0.065, skin),
          sock: this._ball(0.05, over ? shoe : sockMat),
          sockTube: this.sockH ? this._limb(0.062, sockMat) : null,
          cover: over ? this._limb(0.066, shoe) : null,
          shoe: (() => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.09, over ? 0.095 : 0.08, 0.25), shoe); this.body.add(m); addOutline(m, { width: 0.8, minW: 0.005, maxW: 0.035 }); return m; })()
        });
      }
    }

    // Pièces de B3D.anatomy fusionnées (couleurs par sommet) ; outline : épaisseur du contour (sans : pas de contour) ; pivot : la
    // géométrie est recentrée sur ce point, où le mesh est placé (bouche qui s'ouvre, queue de cheval qui se balance)
    _parts(parts, outline, parent, pivot) {
      const geo = B3D.toon.merge(parts);
      const mesh = new THREE.Mesh(geo, cached('vc', () => new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: B3D.toon.gradientMap() })));
      if (pivot) { geo.translate(-pivot.x, -pivot.y, -pivot.z); mesh.position.copy(pivot); }
      (parent || this.body).add(mesh);
      if (outline) addOutline(mesh, { width: outline, minW: outline < 0.5 ? 0.0015 : 0.004, maxW: outline < 0.5 ? 0.004 : 0.03 });
      else mesh.userData.noShadow = true;
      return mesh;
    }

    // Modèles détaillé et réaliste (B3D.anatomy) : mêmes articulations que le modèle simple, posées par update
    _buildRiderFine() {
      const G = this.gear, J = this.jersey, q = this.detail, fem = this.fem, A = B3D.anatomy;
      const suit = G.clothing === 'skinsuit' || G.clothing === 'skinsuit_tt';
      const loose = G.clothing === 'loose';
      const shorts = suit ? J.base : loose ? '#5a6b7d' : '#26232f';
      const gripper = new THREE.Color(shorts).offsetHSL(0, 0, shorts === '#26232f' ? 0.1 : -0.12).getStyle();
      const sleeve = J.base, glove = '#26232f';
      this.shoulderX = fem ? 0.175 : 0.19;
      this.headDist = 0.2;
      this.torsoK = loose ? 1.14 : suit ? 0.97 : 1;
      // buste au motif du maillot ; col, fermeture et poches en réaliste
      this.torso = new THREE.Mesh(A.torsoGeometry({ q, fem }), toonMap(jerseyTexture(J)));
      this.body.add(this.torso);
      addOutline(this.torso, { width: 0.9, minW: 0.006, maxW: 0.04 });
      if (q > 1) this._parts(A.torsoTrim({ q, fem, base: J.base, accent: J.accent }), 0, this.torso);
      this.pelvis = this._parts(A.pelvisParts({ q, fem, color: shorts }), 0.8);
      // tête : crâne et visage, nez et oreilles (contour fin), yeux et lèvres, cheveux, casque et lunettes
      this.head = new THREE.Group();
      this.head.scale.setScalar(HEAD_FINE);
      this.body.add(this.head);
      const H = A.headParts({ q, fem, skin: SKIN, hair: HAIR[G.sex], eyes: G.glasses === 'none' || G.helmet === 'tt', tie: J.accent === '#ffffff' ? J.base : J.accent });
      this._parts(H.skull, 0.8, this.head);
      this._parts(H.features, 0.35, this.head);
      this._parts(H.marks, 0, this.head);
      const mouth = H.mouth[0].matrix.elements;
      this.mouth = this._parts(H.mouth, 0, this.head, new THREE.Vector3(mouth[12], mouth[13], mouth[14]));
      this._parts(H.hair, 0.6, this.head);
      this.tail = H.tail.length ? this._parts(H.tail, 0.6, this.head, H.tailRoot) : null;
      if (H.straps.length) this._parts(H.straps, 0, this.head);
      const helmetColor = !this.custom ? (this.jersey.style === 'plain' && this.jersey.base === '#ffd23a' ? '#ffd23a' : this.bikeColor)
        : { road: '#f4f1ea', tt: '#2a2833' }[G.helmet] || J.base;
      // casque du modèle simple, ajusté à la tête réduite (la visière du chrono passe devant le nez) ; lunettes à la forme du visage
      this.gearGroup = new THREE.Group();
      this.gearGroup.scale.set(0.87, 0.87, G.helmet === 'tt' ? 1 : 0.87);
      this.gearGroup.position.set(0, 0.006, G.helmet === 'tt' ? 0.012 : -0.003);
      this.head.add(this.gearGroup);
      this._helmet(G.helmet, mat(helmetColor));
      if (G.helmet !== 'tt' && G.glasses !== 'none') this._parts(A.glassesParts({ q, fem, type: G.glasses }), 0.35, this.head);
      this.neck = this._parts(A.limbParts('neck', { q, fem, bands: [[1, SKIN]] }), 0.8);

      // bras : manche courte (à mi-biceps), jusqu'au coude (maillot aéro) ou longue (combinaison chrono) ; mains gantées
      const long = G.clothing === 'skinsuit_tt', toElbow = long || G.clothing === 'aero';
      const hem = q > 1 ? J.accent : sleeve, cut = loose ? 0.58 : toElbow ? 0.93 : 0.5;
      const upperBands = long ? [[1, sleeve]] : q > 1 ? [[cut - 0.05, sleeve], [cut, hem], [1, SKIN]] : [[cut, sleeve], [1, SKIN]];
      this.arms = [];
      for (const sx of [-1, 1]) {
        this.arms.push({
          sx,
          upper: this._parts(A.limbParts('upper', { q, fem, side: sx, bands: upperBands, loose: loose ? 0.012 : 0 }), 0.8),
          fore: this._parts(A.limbParts('fore', { q, fem, side: sx, bands: [[1, long ? sleeve : SKIN]] }), 0.8),
          elbow: this._ball(0.034, mat(toElbow ? sleeve : SKIN)),
          hand: this._parts(A.handParts({ q, side: sx, glove, skin: SKIN, fem }), 0.8),
          shoulder: null // l'épaule est dans le buste
        });
      }
      // jambes : cuissard (bande élastique en réaliste), chaussettes ou couvre-chaussures dans le galbe du mollet, chaussures
      const over = G.shoes === 'aero', sockH = SOCKS[G.socks], sockMat = G.socks === 'aero' ? '#1d1a2b' : '#ffffff';
      const legLen = A.LENGTHS.shin, sockFrom = 1 - (sockH + 0.045) / legLen, coverFrom = 1 - 0.09 / legLen;
      const shinBands = !over ? [[sockFrom, SKIN], [1, sockMat]]
        : sockFrom < coverFrom ? [[sockFrom, SKIN], [coverFrom, sockMat], [1, SHOES.aero]] : [[coverFrom, SKIN], [1, SHOES.aero]];
      const hemT = loose ? 0.86 : 0.78;
      const thighBands = q > 1 ? [[hemT - 0.05, shorts], [hemT, gripper], [1, SKIN]] : [[hemT, shorts], [1, SKIN]];
      const [sole, detail] = SHOE_PARTS[G.shoes];
      this.sockH = 0;
      this.legs = [];
      for (const sx of [-1, 1]) {
        this.legs.push({
          sx,
          thigh: this._parts(A.limbParts('thigh', { q, fem, side: sx, bands: thighBands, loose: loose ? 0.014 : 0 }), 0.8),
          shin: this._parts(A.limbParts('shin', { q, fem, side: sx, bands: shinBands }), 0.8),
          knee: this._ball(0.046, mat(SKIN)),
          sock: null, sockTube: null, cover: null,
          shoe: this._parts(A.shoeParts({ q, side: sx, kind: G.shoes, upper: SHOES[G.shoes], sole, detail }), 0.8)
        });
      }
    }

    // Membre galbé posé de a à b, sa face avant (+z) tournée vers front
    _setLimbFront(mesh, a, b, front) {
      const d = this._w[0].copy(b).sub(a), len = d.length();
      d.multiplyScalar(1 / (len || 1));
      const z = this._w[1].copy(front).addScaledVector(d, -front.dot(d));
      if (z.lengthSq() < 1e-8) z.set(0, 0, 1).addScaledVector(d, -d.z);
      z.normalize();
      this._m.makeBasis(this._w[2].crossVectors(d, z), d, z);
      mesh.quaternion.setFromRotationMatrix(this._m);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.scale.set(1, len, 1);
    }

    // Côté vers lequel pointe l'articulation j (genou, coude) par rapport à la droite a-c, dans out
    _bendDir(a, j, c, out) {
      const d = this._w[3].copy(c).sub(a).normalize();
      out.copy(j).sub(a);
      return out.addScaledVector(d, -out.dot(d)).normalize();
    }

    // Main dans le prolongement de l'avant-bras, dos de la main vers le haut
    _setHand(mesh, elbow, hand) {
      const z = this._w[0].copy(hand).sub(elbow).normalize();
      const y = this._w[1].set(0, 1, 0).addScaledVector(z, -z.y).normalize();
      this._m.makeBasis(this._w[2].crossVectors(y, z), y, z);
      mesh.quaternion.setFromRotationMatrix(this._m);
      mesh.position.copy(hand);
    }

    // Casques : route (aérations), urbain (visière), aéro route (coque lisse), chrono (goutte d'eau et visière)
    _helmet(type, m) {
      const H = this.gearGroup || this.head;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.155, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), m);
      dome.position.set(0, 0.03, -0.03);
      dome.rotation.x = -0.25;
      H.add(dome);
      addOutline(dome, { width: 0.8, minW: 0.005, maxW: 0.035 });
      const dark = mat('#26232f');
      if (type === 'road') {
        dome.scale.set(1.0, 0.95, 1.3);
        for (const [x, z] of [[-0.055, 0.02], [0.055, 0.02], [0, 0.03], [-0.05, -0.07], [0.05, -0.07]]) {
          const vent = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.012, 0.075), dark);
          vent.position.set(x, Math.sqrt(0.155 * 0.155 - x * x - z * z) - 0.003, z);
          vent.quaternion.setFromUnitVectors(UP, vent.position.clone().normalize()); // couché sur la coque
          dome.add(vent);
        }
      } else if (type === 'aero') {
        dome.scale.set(1.04, 0.97, 1.4);
        dome.position.z = -0.04;
      } else if (type === 'city') {
        dome.scale.set(1.08, 1.02, 1.14);
        dome.position.set(0, 0.035, -0.015);
        const brim = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.012, 0.07), m);
        brim.position.set(0, 0.085, 0.15);
        brim.rotation.x = 0.35;
        H.add(brim);
        addOutline(brim, { width: 0.8, minW: 0.005, maxW: 0.035 });
      } else {
        // coque en goutte d'eau (tournée autour de l'axe avant-arrière, ouverte dessous), la pointe sur le dos
        H.remove(dome);
        const prof = [[0, -0.15], [0.085, -0.125], [0.15, -0.055], [0.165, 0.03], [0.145, 0.12], [0.1, 0.22], [0.05, 0.31], [0.006, 0.37]];
        const geo = new THREE.LatheGeometry(prof.map((p) => new THREE.Vector2(p[0], p[1])), 24, -1.68, 3.36);
        geo.rotateX(-Math.PI / 2); // axe de révolution : vers l'arrière
        const shell = new THREE.Mesh(geo, mat('#' + m.color.getHexString(), { side: THREE.DoubleSide }));
        shell.position.set(0, 0.03, -0.02);
        shell.rotation.x = -0.38;
        shell.scale.set(0.98, 0.92, 1);
        H.add(shell);
        addOutline(shell, { width: 0.8, minW: 0.005, maxW: 0.035 });
        // visière teintée
        const visor = new THREE.Mesh(new THREE.CylinderGeometry(0.153, 0.15, 0.1, 20, 1, true, -1.2, 2.4),
          cached('visor', () => new THREE.MeshBasicMaterial({ color: '#7fdcff', transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide })));
        visor.position.set(0, 0.012, -0.012);
        visor.userData.noShadow = true;
        H.add(visor);
        const edge = new THREE.Mesh(new THREE.CylinderGeometry(0.156, 0.156, 0.016, 20, 1, true, -1.2, 2.4), m);
        edge.position.set(0, 0.064, -0.012);
        H.add(edge);
      }
    }

    // Lunettes : sans (les yeux), de sport, écran panoramique
    _glasses(type) {
      const H = this.head;
      if (type === 'none') {
        for (const sx of [-1, 1]) {
          const eye = this._ball(0.018, mat('#1d1a2b'), H);
          eye.position.set(sx * 0.045, 0.025, 0.122);
          eye.scale.set(1, 1.35, 0.6);
        }
        return;
      }
      if (type === 'shield') {
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.152, 0.148, 0.07, 20, 1, true, -1.15, 2.3), mat('#6b5ce0'));
        lens.position.set(0, 0.018, -0.008);
        H.add(lens);
        const top = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.014, 20, 1, true, -1.2, 2.4), mat('#f4f1ea'));
        top.position.set(0, 0.056, -0.008);
        H.add(top);
        return;
      }
      const glasses = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.05), mat('#1d1a2b'));
      glasses.position.set(0, 0.02, 0.12);
      H.add(glasses);
      const lens = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.035, 0.02), new THREE.MeshBasicMaterial({ color: '#4fd0ff' }));
      lens.position.set(0, 0.02, 0.146);
      H.add(lens);
    }

    /* Plan d'une position : bassin, épaules, mains et coudes posés (repère du corps, sans danseuse ni recroquevillement). L'angle du
       buste est cherché pour que l'épaule soit à e × longueur du bras des mains ; sur les manchettes, pour que les coudes y reposent.
       stand : en danseuse (mains sur les cocottes, bassin au-dessus de la selle). */
    _plan(posId, stand) {
      const P = POSITIONS[posId], ck = this.ck;
      const side = (p) => [V(-p[0], p[1], p[2]), V(p[0], p[1], p[2])];
      const pelvis = V(0, 1.0, this.saddle.z + 0.03);
      let hands, elbows = null, e = P.e;
      if (P.grip === 'pads' && ck.pad) { hands = side(ck.ext); elbows = side(ck.pad); }
      else if (P.grip === 'forearms' && ck.forearm) { hands = side(ck.forearmHand); elbows = side(ck.forearm); }
      else if (P.grip === 'pads' || P.grip === 'forearms' || P.grip === 'drops') { hands = side(ck.drops); e = ck.dropsE; }
      else hands = side(ck[P.grip]);
      let a;
      if (elbows) {
        a = Math.asin(clamp((elbows[1].y + 0.28 - pelvis.y) / TORSO, 0.05, 0.95));
      } else {
        const h = hands[1], reach = 0.6 * e;
        let lo = 0.08, hi = 1.3;
        for (let k = 0; k < 22; k++) {
          a = (lo + hi) / 2;
          const d = Math.hypot(Math.abs(h.x) - this.shoulderX, h.y - (pelvis.y + TORSO * Math.sin(a) - 0.02), h.z - (pelvis.z + TORSO * Math.cos(a) - 0.02));
          if (d < reach) lo = a; else hi = a;
        }
      }
      const shoulder = V(0, pelvis.y + TORSO * Math.sin(a), pelvis.z + TORSO * Math.cos(a));
      if (stand) { pelvis.y += 0.16; pelvis.z += 0.2; shoulder.y += 0.06; shoulder.z += 0.1; }
      // recroquevillé (descente) : mains en bas du cintre si elles étaient en haut
      const drops = ck.dropBar && (P.grip === 'hoods' || P.grip === 'tops') ? side(ck.drops) : null;
      return { pelvis, shoulder, hands, elbows, drops, pro: !!P.pro, tuckK: P.tuckK || 1 };
    }

    _setLimb(mesh, a, b) {
      const d = this._v[3].copy(b).sub(a);
      const len = d.length();
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(UP, d.multiplyScalar(1 / (len || 1)));
      mesh.scale.set(1, len, 1);
    }

    // IK 2 segments dans le plan contenant "bend" : renvoie la position du genou/coude.
    _ik(a, target, l1, l2, bend, out) {
      const d = this._v[0].copy(target).sub(a);
      let dist = d.length();
      dist = clamp(dist, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
      d.normalize();
      const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
      const ang = Math.acos(clamp(cosA, -1, 1));
      // direction perpendiculaire à d, côté "bend"
      const perp = this._v[1].copy(bend).addScaledVector(d, -bend.dot(d)).normalize();
      out.copy(a).addScaledVector(d, Math.cos(ang) * l1).addScaledVector(perp, Math.sin(ang) * l1);
      return out;
    }

    // state : { speed (m/s), pedaling, effort (0..1 : la bouche s'ouvre ; sinon d'après le pédalage), standing, tuck, steer (-1..1) }
    update(dt, st) {
      this.time += dt;
      const fine = this.detail > 0;
      const v = st.speed;
      // roues
      this.wheelAngle += v / R * dt;
      for (const w of this.wheels) w.rotation.x = this.wheelAngle;
      // pédalage : braquet "automatique" pour garder ~90 tr/min
      if (st.pedaling && v > 0.3) {
        const wheelRpm = v / (2 * Math.PI * R) * 60;
        const ratio = clamp(wheelRpm / 88, 1.3, 4.4);
        const cadence = wheelRpm / ratio; // tr/min
        const before = Math.floor(this.crank / Math.PI);
        this.crank += cadence / 60 * Math.PI * 2 * dt;
        this.strokes += Math.floor(this.crank / Math.PI) - before;
      } else {
        // pédales à l'horizontale en roue libre
        const target = Math.round((this.crank - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
        this.crank = lerp(this.crank, target, 1 - Math.exp(-dt * 4));
      }
      this.crankGroup.rotation.x = this.crank;

      this.standT = lerp(this.standT, st.standing ? 1 : 0, 1 - Math.exp(-dt * 5));
      this.tuckT = lerp(this.tuckT, st.tuck ? 1 : 0, 1 - Math.exp(-dt * 3));
      const stand = this.standT, tuck = this.tuckT;

      // balancement du vélo en danseuse
      this.rock = Math.sin(this.crank) * 0.13 * stand;
      this.bikeGroup.rotation.z = this.rock;

      const A = this.plan, B = this.planStand, tk = tuck * (1 - stand) * A.tuckK;
      // bassin / épaules : la position choisie, la danseuse, le recroquevillement en descente
      const pelvis = A.pelvis.clone().lerp(B.pelvis, stand);
      pelvis.y -= 0.03 * tk; pelvis.z += 0.03 * tk;
      const bob = Math.sin(this.crank * 2) * 0.008 * (st.pedaling ? 1 : 0);
      pelvis.y += bob;
      const sway = -Math.sin(this.crank) * 0.08 * stand;
      pelvis.x += sway;
      const shoulder = A.shoulder.clone().lerp(B.shoulder, stand);
      shoulder.x = sway * 1.4; shoulder.y += bob - 0.16 * tk; shoulder.z += 0.08 * tk;
      this.pelvis.position.copy(pelvis);
      // torse : capsule orientée du bassin aux épaules
      const tdir = shoulder.clone().sub(pelvis);
      const tlen = tdir.length();
      const back = Math.atan2(tdir.y, tdir.z);
      this.torso.position.copy(pelvis).addScaledVector(tdir, 0.5);
      this.torso.quaternion.setFromUnitVectors(UP, tdir.normalize());
      // respiration (modèles fins) : plus ample et plus rapide à l'effort ; la bouche s'ouvre
      const effort = st.effort !== undefined ? clamp(st.effort, 0, 1) : st.standing ? 0.8 : st.pedaling ? 0.35 : 0.05;
      this.effortT = lerp(this.effortT, effort, 1 - Math.exp(-dt * 2));
      const breath = fine ? 1 + (0.008 + 0.018 * this.effortT) * Math.sin(this.time * (1.6 + 2.4 * this.effortT) * Math.PI) : 1;
      this.torso.scale.set(0.2 * this.torsoK, tlen * 0.5 + 0.1, 0.16 * this.torsoK * breath);
      if (this.mouth) this.mouth.scale.set(1, 1 + 1.7 * this.effortT * (0.8 + 0.2 * breath), 1);
      if (this.tail) this.tail.rotation.set(0.1 * Math.sin(this.crank * 2) * (st.pedaling ? 1 : 0.3) + 0.15 * tk, 0, 0.1 * Math.sin(this.crank) + 0.2 * this.rock);
      // tête : dans le prolongement du dos (plus en avant quand le buste est couché ; rentrée dans les épaules en chrono optimisé)
      const pro = A.pro ? 1 - stand : 0;
      const ha = back + 0.21 - 0.12 * pro;
      const neckBase = shoulder.clone().add(new THREE.Vector3(0, 0.05, 0.03));
      const headPos = shoulder.clone().add(new THREE.Vector3(0, Math.sin(ha) * this.headDist - 0.02 * pro, Math.cos(ha) * this.headDist));
      if (fine) this._setLimbFront(this.neck, neckBase, headPos, this._v[2].set(0, -tdir.z, tdir.y)); // nuque côté dos
      else this._setLimb(this.neck, neckBase, headPos);
      this.head.position.copy(headPos);
      this.head.rotation.set(-0.15 + 0.2 * tuck - 0.1 * stand + 0.1 * pro, st.steer * 0.25, 0);

      // bras : mains sur le cintre (qui suit le balancement du vélo), coudes posés sur les manchettes
      for (const arm of this.arms) {
        const i = arm.sx < 0 ? 0 : 1;
        const sh = new THREE.Vector3(arm.sx * this.shoulderX + sway * 1.4, shoulder.y - 0.02, shoulder.z - 0.02);
        const hand = A.hands[i].clone().lerp(B.hands[i], stand);
        if (A.drops && tk > 0.001) hand.lerp(A.drops[i], tk);
        if (stand > 0.01) hand.applyAxisAngle(ZAX, this.rock);
        let elbow = this._ik(sh, hand, 0.3, 0.3, new THREE.Vector3(arm.sx * 0.6, -0.3, -0.75).normalize(), new THREE.Vector3());
        if (A.elbows) elbow = A.elbows[i].clone().lerp(elbow, stand);
        if (arm.shoulder) arm.shoulder.position.copy(sh);
        arm.elbow.position.copy(elbow);
        if (fine) {
          // biceps à l'intérieur du coude
          const front = this._bendDir(sh, elbow, hand, this._v[2]).negate();
          this._setLimbFront(arm.upper, sh, elbow, front);
          this._setLimbFront(arm.fore, elbow, hand, front);
          this._setHand(arm.hand, elbow, hand);
        } else {
          this._setLimb(arm.upper, sh, elbow);
          this._setLimb(arm.fore, elbow, hand);
          arm.hand.position.copy(hand);
        }
      }
      // jambes : pédales dans le repère du vélo (avec balancement)
      for (const leg of this.legs) {
        // même convention que les manivelles du pédalier : pédale droite (x < 0) en haut à crank = 0
        const sgn = -leg.sx;
        const pedal = new THREE.Vector3(leg.sx * 0.12, this.BB.y + sgn * Math.cos(this.crank) * 0.17, this.BB.z + sgn * Math.sin(this.crank) * 0.17);
        if (stand > 0.01) pedal.applyAxisAngle(ZAX, this.rock);
        const ankle = pedal.clone().add(new THREE.Vector3(0, 0.07, -0.05));
        const hip = new THREE.Vector3(leg.sx * 0.095 + pelvis.x, pelvis.y - 0.03, pelvis.z + 0.02);
        const knee = this._ik(hip, ankle, 0.46, 0.45, new THREE.Vector3(leg.sx * 0.12, 0.25, 1).normalize(), new THREE.Vector3());
        leg.knee.position.copy(knee);
        if (fine) {
          // quadriceps et tibia du côté où pointe le genou, mollet derrière
          const front = this._bendDir(hip, knee, ankle, this._v[2]);
          this._setLimbFront(leg.thigh, hip, knee, front);
          this._setLimbFront(leg.shin, knee, ankle, front);
        } else {
          this._setLimb(leg.thigh, hip, knee);
          this._setLimb(leg.shin, knee, ankle);
          leg.sock.position.copy(ankle);
        }
        const up = this._v[2].copy(knee).sub(ankle).normalize();
        if (leg.sockTube) this._setLimb(leg.sockTube, ankle, ankle.clone().addScaledVector(up, this.sockH));
        if (leg.cover) this._setLimb(leg.cover, ankle, ankle.clone().addScaledVector(up, 0.075));
        // chaussure posée sur la pédale, pointe vers l'avant
        const toe = pedal.clone().add(new THREE.Vector3(0, 0.03, 0.09));
        leg.shoe.position.copy(ankle).add(toe).multiplyScalar(0.5);
        leg.shoe.lookAt(this._toWorldDir(toe.clone().sub(ankle), leg.shoe.position));
      }
    }

    // Montre ou cache le cycliste (le vélo seul, dans la vitrine du magasin)
    setRiderVisible(v) {
      for (const o of this.body.children) if (o !== this.bikeGroup) o.visible = !!v;
    }

    // lookAt travaille en coordonnées monde : on convertit une direction locale du corps.
    _toWorldDir(dirLocal, posLocal) {
      const p = posLocal.clone().add(dirLocal);
      return this.body.localToWorld(p);
    }

    dispose() {
      this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
  }

  Cyclist.JERSEYS = JERSEYS;
  // listes de l'équipement (pour la vitrine et la vue pilotée par PaceYourRide)
  Cyclist.GEAR = {
    frames: Object.keys(FRAMES), wheels: Object.keys(WHEELS), tires: Object.keys(TIRES), positions: Object.keys(POSITIONS),
    helmets: Object.keys(HELMETS), clothing: Object.keys(CLOTHING), glasses: Object.keys(GLASSES), socks: Object.keys(SOCKS), shoes: Object.keys(SHOES)
  };
  Cyclist.normGear = normGear;
  Cyclist.DETAILS = DETAILS;
  Cyclist.detailLevel = detailLevel;
  // géométrie d'un cadre (tests : la roue avant ne touche pas le cadre, le bidon est sur le tube oblique)
  Cyclist.layout = (frame) => {
    const F = frameOf(has(FRAMES, frame) ? frame : 'classic');
    return Object.assign(frameLayout(F), { F, R, HEAD, BOTTLE_R });
  };
  B3D.Cyclist = Cyclist;
})(typeof window !== 'undefined' ? window : globalThis);
