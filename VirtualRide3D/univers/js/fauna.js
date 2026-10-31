/* Bike3D — faune animée : aigles qui planent, corbeaux, hirondelles, mouettes, vols d'oies en V,
   pigeons de village qui s'envolent au passage du coureur, canards sur les mares et les lacs ;
   la nuit, chauves-souris qui virevoltent autour du coureur et chouettes au-dessus des bois. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { merge, tr, instancedMat, outlineMat, computeOutlineNormals } = B3D.toon;
  const { mulberry32 } = B3D.util;

  const sph = (r, w, h) => new THREE.SphereGeometry(r, w || 7, h || 5);

  // Aile effilée (vue de dessus) : bord d'attaque droit, pointe repliée vers l'arrière.
  // tipShape 0 = pointue (hirondelle, mouette), 1 = « doigts » larges (aigle, oie).
  function wingOutline(wl, c, tipShape) {
    return tipShape
      ? [[0, c * 0.5], [wl * 0.6, c * 0.48], [wl, c * 0.2], [wl * 0.96, -c * 0.2], [wl * 0.6, -c * 0.5], [0, -c * 0.5]]
      : [[0, c * 0.5], [wl * 0.5, c * 0.42], [wl, -c * 0.25], [wl * 0.7, -c * 0.3], [wl * 0.35, -c * 0.5], [0, -c * 0.5]];
  }
  function extrudeWing(side, pts, th, yOff) {
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(side * x, -z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false, curveSegments: 1 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, -th / 2 + (yOff || 0), 0);
    g.deleteAttribute('uv');
    return g;
  }
  function wingGeo(side, wl, c, th, tipShape) { return extrudeWing(side, wingOutline(wl, c, tipShape), th); }
  // bout d'aile d'une autre couleur : la partie extérieure du contour
  function wingTipGeo(side, wl, c, th, tipShape) {
    const pts = wingOutline(wl, c, tipShape).filter(([x]) => x >= wl * 0.5);
    const cut = wl * 0.68;
    return extrudeWing(side, [[cut, c * 0.45]].concat(pts.filter(([x]) => x > cut)).concat([[cut, -c * 0.38]]), th * 1.15, th * 0.03);
  }

  // Oiseau générique : avant = +z, ailes selon x (attribut wingSide pour le battement).
  function bird(o) {
    const L = o.len, S = o.span, W = o.width || L * 0.34;
    const parts = [
      { geo: sph(1, 8, 6), color: o.body, matrix: tr(0, 0, 0, 0, 0, 0, W * 0.5, W * 0.46, L * 0.5) },
      { geo: sph(1, 6, 4), color: o.belly || o.body, matrix: tr(0, -W * 0.14, L * 0.04, 0, 0, 0, W * 0.4, W * 0.34, L * 0.38) },
      { geo: new THREE.BoxGeometry(W * 0.7, W * 0.06, L * 0.32), color: o.tail || o.wing, matrix: tr(0, W * 0.04, -L * 0.55) }
    ];
    if (o.fork) {
      for (const sd of [-1, 1]) parts.push({ geo: new THREE.BoxGeometry(W * 0.12, W * 0.05, L * 0.45), color: o.tail || o.wing, matrix: tr(sd * W * 0.2, W * 0.04, -L * 0.82, 0, sd * 0.3, 0) });
    }
    if (o.neck) {
      parts.push({ geo: new THREE.CylinderGeometry(W * 0.13, W * 0.16, L * 0.42, 6), color: o.neck, matrix: tr(0, W * 0.2, L * 0.62, Math.PI / 2 - 0.25, 0, 0) });
      parts.push({ geo: sph(W * 0.28, 7, 5), color: o.head, matrix: tr(0, W * 0.32, L * 0.86) });
      parts.push({ geo: new THREE.BoxGeometry(W * 0.16, W * 0.06, W * 0.12), color: '#f4f1ea', matrix: tr(0, W * 0.3, L * 0.86) });
      parts.push({ geo: new THREE.ConeGeometry(W * 0.09, L * 0.14, 4), color: o.beak, matrix: tr(0, W * 0.3, L * 1.0, Math.PI / 2, 0, 0) });
    } else {
      parts.push({ geo: sph(W * 0.36, 7, 5), color: o.head || o.body, matrix: tr(0, W * 0.2, L * 0.47) });
      parts.push({ geo: new THREE.ConeGeometry(W * 0.1, L * 0.17, 4), color: o.beak, matrix: tr(0, W * 0.16, L * 0.62, Math.PI / 2, 0, 0) });
      if (o.throat) parts.push({ geo: sph(W * 0.2, 6, 4), color: o.throat, matrix: tr(0, W * 0.02, L * 0.5) });
    }
    const wl = Math.max(0.02, S / 2 - W * 0.4), c = L * 0.46;
    for (const side of [-1, 1]) {
      const x0 = side * W * 0.4;
      parts.push({ geo: wingGeo(side, wl, c, W * 0.07, o.tipShape || 0), color: o.wing, wing: side, matrix: tr(x0, W * 0.06, L * 0.02) });
      if (o.tip) parts.push({ geo: wingTipGeo(side, wl, c, W * 0.075, o.tipShape || 0), color: o.tip, wing: side, matrix: tr(x0, W * 0.06, L * 0.02) });
    }
    const g = merge(parts);
    g.userData.pivot = W * 0.4;
    return g;
  }

  // Chauve-souris : petit corps, oreilles pointues, ailes en membrane festonnée.
  function bat() {
    const D = '#2b2430', M = '#3d3240';
    const parts = [
      { geo: sph(1, 7, 5), color: D, matrix: tr(0, 0, 0, 0, 0, 0, 0.05, 0.05, 0.09) },
      { geo: sph(0.045, 6, 4), color: D, matrix: tr(0, 0.02, 0.09) },
      { geo: new THREE.ConeGeometry(0.018, 0.05, 4), color: D, matrix: tr(0.022, 0.06, 0.09) },
      { geo: new THREE.ConeGeometry(0.018, 0.05, 4), color: D, matrix: tr(-0.022, 0.06, 0.09) }
    ];
    const wl = 0.2, c = 0.16;
    const outline = [[0, c * 0.5], [wl * 0.5, c * 0.6], [wl, c * 0.15], [wl * 0.86, -c * 0.32], [wl * 0.66, -c * 0.06], [wl * 0.48, -c * 0.38], [wl * 0.28, -c * 0.1], [0, -c * 0.5]];
    for (const side of [-1, 1]) parts.push({ geo: extrudeWing(side, outline, 0.01), color: M, wing: side, matrix: tr(side * 0.04, 0.01, 0) });
    const g = merge(parts);
    g.userData.pivot = 0.04;
    return g;
  }

  // Canard qui nage (pas d'ailes déployées).
  function duck() {
    return merge([
      { geo: sph(1, 8, 6), color: '#9c9184', matrix: tr(0, 0.12, 0, 0, 0, 0, 0.19, 0.14, 0.32) },
      { geo: sph(1, 6, 4), color: '#7a5a3f', matrix: tr(0, 0.16, 0.18, 0, 0, 0, 0.15, 0.13, 0.13) },
      { geo: new THREE.BoxGeometry(0.12, 0.04, 0.12), color: '#3a3440', matrix: tr(0, 0.17, -0.31, 0.45, 0, 0) },
      { geo: sph(0.1, 7, 5), color: '#ffffff', tint: 1, matrix: tr(0, 0.33, 0.27) },
      { geo: new THREE.BoxGeometry(0.07, 0.03, 0.13), color: '#f2b230', matrix: tr(0, 0.31, 0.39) },
      { geo: new THREE.BoxGeometry(0.2, 0.04, 0.06), color: '#ffffff', matrix: tr(0, 0.25, 0.25) },
      { geo: new THREE.BoxGeometry(0.05, 0.05, 0.12), color: '#3d6fd0', matrix: tr(0.17, 0.16, -0.05) },
      { geo: new THREE.BoxGeometry(0.05, 0.05, 0.12), color: '#3d6fd0', matrix: tr(-0.17, 0.16, -0.05) }
    ]);
  }

  const SPECIES = {
    eagle: { cap: 6, outline: true, geo: () => bird({ len: 0.95, span: 2.1, body: '#6b4a2f', belly: '#5a3d27', head: '#d9c9a5', beak: '#e8b830', wing: '#5e4129', tip: '#2d241e', tipShape: 1 }), flap: { freq: 2.6, amp: 0.25, glide: 0.9 } },
    crow: { cap: 40, outline: true, geo: () => bird({ len: 0.45, span: 0.95, body: '#26232f', beak: '#3a3846', wing: '#2b2834', tip: '#1a1820', tipShape: 1 }), flap: { freq: 13, amp: 0.65, glide: 0.3 } },
    swallow: { cap: 30, outline: true, geo: () => bird({ len: 0.2, span: 0.36, body: '#243a7a', belly: '#f4efe4', head: '#243a7a', throat: '#c8442f', beak: '#222222', wing: '#1f3068', fork: true }), flap: { freq: 24, amp: 0.9, glide: 0.4 } },
    gull: { cap: 24, outline: true, geo: () => bird({ len: 0.42, span: 1.05, body: '#f6f6f2', head: '#ffffff', beak: '#f2c230', wing: '#b9c2cf', tip: '#26232f' }), flap: { freq: 8, amp: 0.5, glide: 0.7 } },
    goose: { cap: 16, outline: true, geo: () => bird({ len: 0.8, span: 1.6, body: '#8c8478', belly: '#d8d0c0', head: '#26232f', neck: '#26232f', beak: '#3a3846', wing: '#7d756a', tip: '#4a443d', tipShape: 1 }), flap: { freq: 7.5, amp: 0.55, glide: 0 } },
    pigeon: { cap: 30, outline: true, geo: () => bird({ len: 0.32, span: 0.62, body: '#a2a6ae', head: '#5d6370', belly: '#b0b3ba', throat: '#6f8f80', beak: '#4a4a52', wing: '#a9adb6', tip: '#3a3e48' }), flap: { freq: 18, amp: 0.95, glide: 0 } },
    pigeonGround: { cap: 30, outline: true, geo: () => bird({ len: 0.32, span: 0.13, body: '#a2a6ae', head: '#5d6370', belly: '#b0b3ba', throat: '#6f8f80', beak: '#4a4a52', wing: '#9a9ea8' }) },
    duck: { cap: 80, outline: true, geo: duck },
    // la nuit
    bat: { cap: 24, outline: true, geo: bat, flap: { freq: 26, amp: 1.0, glide: 0 } },
    owl: { cap: 6, outline: true, geo: () => bird({ len: 0.5, span: 1.15, width: 0.24, body: '#8a6a4a', belly: '#d2bc96', head: '#8a6a4a', beak: '#e8b830', wing: '#7d5f42', tip: '#4f3b2a', tipShape: 1 }), flap: { freq: 5, amp: 0.45, glide: 0.65 } }
  };

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

  class Fauna {
    constructor(scene, L, route) {
      this.scene = scene;
      this.L = L;
      this.route = route;
      this.rnd = mulberry32(L.seed ^ 0xb1ed);
      this.types = {};
      for (const [name, sp] of Object.entries(SPECIES)) {
        const geo = sp.geo();
        const flap = sp.flap ? Object.assign({ pivot: geo.userData.pivot || 0.1 }, sp.flap) : null;
        const mesh = new THREE.InstancedMesh(geo, instancedMat({ flap }), sp.cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(sp.cap * 3).fill(1), 3);
        mesh.frustumCulled = false;
        mesh.count = 0;
        mesh.castShadow = name === 'eagle' || name === 'goose';
        scene.add(mesh);
        let ol = null;
        if (sp.outline) {
          computeOutlineNormals(geo);
          ol = new THREE.InstancedMesh(geo, outlineMat({ flap, width: 0.8, maxW: 0.12 }), sp.cap);
          ol.instanceMatrix = mesh.instanceMatrix;
          ol.frustumCulled = false;
          ol.count = 0;
          scene.add(ol);
        }
        this.types[name] = { mesh, ol, cap: sp.cap };
      }
      this.eagles = [];
      this.crows = { members: [], cx: 0, cz: 0, tx: 0, tz: 0, alt: 0, retarget: 0 };
      this.swallows = [];
      this.gulls = [];
      this.geese = null;
      this.geeseTimer = 35 + this.rnd() * 50;
      this.pigeons = [];
      this.pigeonVillages = new Set();
      this.ducks = new Map(); // lac -> canards
      this.bats = [];
      this.winter = L.amb.id === 'hiver';
      this.owls = [];
      this.dayK = 1; // luminosité du jour (donnée par l'atmosphère)
      this.ctxTimer = 0;
      this.time = 0;
      // distances au coureur, pour les cris (mises à jour à chaque image)
      this.audio = { eagle: 1e9, crow: 1e9, goose: 1e9, duck: 1e9, swallow: 1e9, gull: 1e9, owl: 1e9, bat: 1e9, takeoff: 0 };
    }

    // ------------------------------------------------------------ peuplement selon le décor
    _context(P, fwd, tiles) {
      const L = this.L, rnd = this.rnd;
      const M = L.base(P.x, P.z, {}).M;
      const mix = tiles ? tiles.coverMix(P.x, P.z) : { meadow: 0.5, alpine: 0 };
      // la nuit : chauves-souris (près des villages, des prés et de l'eau) et chouettes (près des bois)
      const nearVil = L.villages.some((v) => Math.hypot(this.route.x[v.ic] - P.x, this.route.z[v.ic] - P.z) < 400);
      const wantB = this.night ? (nearVil || mix.meadow > 0.2 || mix.wet > 0.05 ? 6 : 3) : 0;
      while (this.bats.length < wantB) this.bats.push({ p: [rnd() * 6, rnd() * 6, rnd() * 6], w: [1.6 + rnd() * 1.4, 1.3 + rnd() * 1.3, 2.5 + rnd() * 1.5], r: 5 + rnd() * 7, h: 3.5 + rnd() * 3, prev: null });
      while (this.bats.length > wantB) this.bats.pop();
      const wantO = this.night && (mix.forest > 0.15 || mix.meadow > 0.3) ? 2 : 0;
      while (this.owls.length < wantO) {
        const a = rnd() * Math.PI * 2, d = 40 + rnd() * 110;
        const cx = P.x + fwd.x * 60 + Math.cos(a) * d, cz = P.z + fwd.z * 60 + Math.sin(a) * d;
        this.owls.push({ cx, cz, alt: L.heightAt(cx, cz) + 14 + rnd() * 10, a: rnd() * 6.28, r: 18 + rnd() * 20, w: (0.2 + rnd() * 0.12) * (rnd() < 0.5 ? -1 : 1) });
      }
      while (this.owls.length > wantO) this.owls.pop();
      for (let k = 0; k < this.owls.length; k++) if (Math.hypot(this.owls[k].cx - P.x, this.owls[k].cz - P.z) > 300) this.owls.splice(k--, 1);
      // aigles en montagne
      const wantE = M > 0.45 || mix.alpine > 0.25 ? (M > 0.7 ? 3 : 2) : 0;
      while (this.eagles.length < wantE) this.eagles.push(this._newEagle(P, fwd));
      while (this.eagles.length > wantE) this.eagles.pop();
      for (let k = 0; k < this.eagles.length; k++) {
        const e = this.eagles[k];
        if (Math.hypot(e.cx - P.x, e.cz - P.z) > 480) this.eagles[k] = this._newEagle(P, fwd);
      }
      // corbeaux au-dessus des champs et des prés de plaine
      const wantC = mix.meadow > 0.3 && M < 0.6 ? 6 + Math.floor(rnd() * 5) : 0;
      const C = this.crows;
      if (wantC && !C.members.length) {
        const a = rnd() * Math.PI * 2, d = 60 + rnd() * 120;
        C.cx = P.x + Math.cos(a) * d; C.cz = P.z + Math.sin(a) * d;
        C.tx = C.cx; C.tz = C.cz;
        C.alt = L.heightAt(C.cx, C.cz) + 18 + rnd() * 12;
        for (let k = 0; k < wantC; k++) C.members.push({ a: rnd() * 6.28, r: 5 + rnd() * 14, w: (0.5 + rnd() * 0.5) * (rnd() < 0.5 ? -1 : 1), dy: rnd() * 6, ph: rnd() * 6 });
      } else if (!wantC && C.members.length && Math.hypot(C.cx - P.x, C.cz - P.z) > 300) C.members.length = 0;
      // hirondelles dans les prés et les villages
      const nearVillage = L.villages.some((v) => Math.hypot(this.route.x[v.ic] - P.x, this.route.z[v.ic] - P.z) < 300);
      const wantS = !this.winter && (mix.meadow > 0.25 || nearVillage) ? 7 : 0; // en hiver, les hirondelles sont parties
      while (this.swallows.length < wantS) this.swallows.push({ p: [rnd() * 6, rnd() * 6, rnd() * 6], w: [0.9 + rnd() * 0.8, 0.7 + rnd() * 0.8, 1.5 + rnd()], r: 8 + rnd() * 10, prev: null });
      if (!wantS) this.swallows.length = 0;
      // mouettes au-dessus des lacs
      let lake = null, ld = 500;
      for (const lk of L.lakes) {
        if (lk.kind === 'pond') continue;
        const d = Math.hypot(lk.x - P.x, lk.z - P.z);
        if (d < ld) { ld = d; lake = lk; }
      }
      if (lake && (!this.gulls.length || this.gulls[0].lake !== lake)) {
        this.gulls = [];
        const n = 3 + Math.floor(rnd() * 4);
        for (let k = 0; k < n; k++) this.gulls.push({ lake, a: rnd() * 6.28, r: Math.max(14, lake.r * (0.3 + rnd() * 0.5)), w: (0.25 + rnd() * 0.25) * (rnd() < 0.5 ? -1 : 1), alt: lake.level + 10 + rnd() * 16 });
      } else if (!lake) this.gulls = [];
      // pigeons sur la place du village
      for (let i = 0; i < L.villages.length; i++) {
        const v = L.villages[i];
        const cx = this.route.x[v.ic], cz = this.route.z[v.ic];
        if (this.pigeonVillages.has(i) || Math.hypot(cx - P.x, cz - P.z) > 230) continue;
        this.pigeonVillages.add(i);
        const n = 10 + Math.floor(rnd() * 8);
        for (let k = 0; k < n; k++) {
          const s = v.ic * this.route.spacing + (rnd() - 0.5) * 70;
          const q = this.route.sample(s, {});
          const side = rnd() < 0.5 ? -1 : 1, off = L.roadHalf + 0.4 + rnd() * 1.4;
          const x = q.x + q.rx * side * off, z = q.z + q.rz * side * off;
          this.pigeons.push({ x, z, y: q.y + 0.19, ground: q.y + 0.19, yaw: rnd() * 6.28, mode: 'ground', hop: rnd(), t: 0, vx: 0, vy: 0, vz: 0, peck: rnd() * 6 });
        }
      }
      // canards sur les mares et lacs proches
      for (const lk of L.lakes) {
        const d = Math.hypot(lk.x - P.x, lk.z - P.z) - lk.r;
        const has = this.ducks.has(lk);
        if (d < 230 && !has) {
          const n = lk.kind === 'pond' ? 2 + Math.floor(rnd() * 4) : 4 + Math.floor(rnd() * 5);
          const list = [];
          for (let k = 0; k < n; k++) {
            list.push({ a: rnd() * 6.28, r: (lk.kind === 'pond' ? 0.3 + rnd() * 0.4 : 0.55 + rnd() * 0.35), w: (0.08 + rnd() * 0.12) * (rnd() < 0.5 ? -1 : 1) * (lk.kind === 'pond' ? 2 : 1), ph: rnd() * 6, male: rnd() < 0.55 });
          }
          this.ducks.set(lk, list);
        } else if (d > 320 && has) this.ducks.delete(lk);
      }
    }

    _newEagle(P, fwd) {
      const rnd = this.rnd;
      const d = 80 + rnd() * 220, lat = (rnd() - 0.5) * 300;
      const cx = P.x + fwd.x * d - fwd.z * lat, cz = P.z + fwd.z * d + fwd.x * lat;
      const alt = Math.max(this.L.heightAt(cx, cz) + 50 + rnd() * 70, P.y + 35);
      return { cx, cz, alt, a: rnd() * 6.28, r: 35 + rnd() * 55, w: (0.12 + rnd() * 0.08) * (rnd() < 0.5 ? -1 : 1), ph: rnd() * 6 };
    }

    // ------------------------------------------------------------ animation
    // P : position du coureur (ou du point visé en aperçu), fwd : direction de la route.
    // dk : luminosité du jour (1 plein jour, 0 nuit) ; les oiseaux de jour se posent pour la nuit
    setDaylight(dk) {
      this.dayK = dk;
      this.night = this._nightOn ? dk < 0.42 : dk < 0.28;
      this._nightOn = this.night;
    }

    update(dt, P, fwd, tiles) {
      this.time += dt;
      const t = this.time, rnd = this.rnd, L = this.L;
      this.ctxTimer -= dt;
      if (this.ctxTimer <= 0) { this.ctxTimer = 1; this._context(P, fwd, tiles); }
      const out = { eagle: [], crow: [], swallow: [], gull: [], goose: [], pigeon: [], pigeonGround: [], duck: [], bat: [], owl: [] };
      const A = this.audio;
      A.eagle = A.crow = A.goose = A.duck = A.swallow = A.gull = A.owl = A.bat = 1e9;
      const day = !this.night;
      const dist = (x, y, z) => Math.hypot(x - P.x, y - P.y, z - P.z);

      for (const e of this.eagles) {
        e.a += e.w * dt;
        const x = e.cx + Math.cos(e.a) * e.r, z = e.cz + Math.sin(e.a) * e.r;
        const y = e.alt + Math.sin(t * 0.3 + e.ph) * 4;
        const yaw = Math.atan2(-Math.sin(e.a) * e.w, Math.cos(e.a) * e.w);
        out.eagle.push([x, y, z, yaw, 0, e.w > 0 ? -0.35 : 0.35, 1, null]);
        A.eagle = Math.min(A.eagle, dist(x, y, z));
      }

      const C = this.crows;
      if (C.members.length) {
        C.retarget -= dt;
        if (C.retarget <= 0) {
          C.retarget = 8 + rnd() * 8;
          const a = rnd() * Math.PI * 2, d = 40 + rnd() * 140;
          C.tx = P.x + Math.cos(a) * d; C.tz = P.z + Math.sin(a) * d;
          C.alt = L.heightAt(C.tx, C.tz) + 18 + rnd() * 12;
        }
        const k = 1 - Math.exp(-dt * 0.25);
        C.cx += (C.tx - C.cx) * k; C.cz += (C.tz - C.cz) * k;
        for (const m of C.members) {
          m.a += m.w * dt;
          const x = C.cx + Math.cos(m.a) * m.r, z = C.cz + Math.sin(m.a) * m.r;
          const y = C.alt + m.dy + Math.sin(t * 0.8 + m.ph) * 1.5;
          out.crow.push([x, y, z, Math.atan2(-Math.sin(m.a) * m.w, Math.cos(m.a) * m.w), 0, m.w > 0 ? -0.3 : 0.3, 1, null]);
          A.crow = Math.min(A.crow, dist(x, y, z));
        }
      }

      // hirondelles : boucles rapides autour d'un point qui accompagne le coureur
      const ax = P.x + fwd.x * 9, az = P.z + fwd.z * 9;
      for (const s of this.swallows) {
        const x = ax + Math.sin(t * s.w[0] + s.p[0]) * s.r;
        const z = az + Math.sin(t * s.w[1] + s.p[1]) * s.r;
        const y = P.y + 2.6 + Math.sin(t * s.w[2] + s.p[2]) * 1.8;
        let yaw = 0, pitch = 0;
        if (s.prev) {
          const dx = x - s.prev[0], dz = z - s.prev[2];
          yaw = Math.atan2(dx, dz);
          pitch = -Math.atan2(y - s.prev[1], Math.hypot(dx, dz) + 1e-4);
        }
        s.prev = [x, y, z];
        out.swallow.push([x, y, z, yaw, pitch, 0, 1, null]);
        A.swallow = Math.min(A.swallow, dist(x, y, z));
      }

      for (const g of this.gulls) {
        g.a += g.w * dt;
        const x = g.lake.x + Math.cos(g.a) * g.r, z = g.lake.z + Math.sin(g.a) * g.r;
        const y = g.alt + Math.sin(t * 0.6 + g.a) * 2;
        out.gull.push([x, y, z, Math.atan2(-Math.sin(g.a) * g.w, Math.cos(g.a) * g.w), 0, g.w > 0 ? -0.3 : 0.3, 1, null]);
        A.gull = Math.min(A.gull, dist(x, y, z));
      }

      // vol d'oies en V qui traverse le ciel de temps en temps
      this.geeseTimer -= dt;
      if (!this.geese && this.geeseTimer <= 0 && day) {
        const a = rnd() * Math.PI * 2;
        const dx = Math.cos(a), dz = Math.sin(a);
        const lat = (rnd() - 0.5) * 160;
        this.geese = { x: P.x - dx * 520 - dz * lat, z: P.z - dz * 520 + dx * lat, y: P.y + 65 + rnd() * 35, dx, dz, n: 7 + 2 * Math.floor(rnd() * 3), t: 0 };
      }
      if (this.geese) {
        const G = this.geese;
        G.t += dt;
        G.x += G.dx * 14 * dt; G.z += G.dz * 14 * dt;
        const yaw = Math.atan2(G.dx, G.dz);
        for (let k = 0; k < G.n; k++) {
          const rank = Math.ceil(k / 2), side = k % 2 ? 1 : -1;
          const back = rank * 2.2, lat = rank * 2.0 * side;
          const x = G.x - G.dx * back - G.dz * lat, z = G.z - G.dz * back + G.dx * lat;
          const y = G.y + Math.sin(t * 1.3 + k) * 0.4;
          out.goose.push([x, y, z, yaw, 0, 0, 1, null]);
          A.goose = Math.min(A.goose, dist(x, y, z));
        }
        if (G.t > 80) { this.geese = null; this.geeseTimer = 70 + rnd() * 80; }
      }

      // pigeons : picorent sur la place, s'envolent quand le coureur arrive
      A.takeoff = 0;
      for (let i = this.pigeons.length - 1; i >= 0; i--) {
        const g = this.pigeons[i];
        if (g.mode === 'ground') {
          const d = Math.hypot(g.x - P.x, g.z - P.z);
          if (d < 11) {
            g.mode = 'fly';
            let ux = g.x - P.x, uz = g.z - P.z;
            const l = Math.hypot(ux, uz) || 1;
            ux /= l; uz /= l;
            const sp = 6 + rnd() * 4;
            g.vx = ux * sp + (rnd() - 0.5) * 3; g.vz = uz * sp + (rnd() - 0.5) * 3; g.vy = 4 + rnd() * 3;
            g.t = 0;
            A.takeoff++;
          } else {
            g.hop -= dt;
            if (g.hop <= 0) {
              g.hop = 0.6 + rnd() * 1.4;
              g.yaw += (rnd() - 0.5) * 2;
              const st = 0.15 + rnd() * 0.35;
              g.x += Math.sin(g.yaw) * st; g.z += Math.cos(g.yaw) * st;
            }
            const hopY = Math.max(0, Math.sin((1 - g.hop / 2) * Math.PI * 6)) * 0.03;
            const peck = Math.max(0, Math.sin(t * 5 + g.peck)) * 0.5;
            out.pigeonGround.push([g.x, g.ground + 0.1 + hopY, g.z, g.yaw, peck, 0, 1.4, null]);
          }
        } else {
          g.t += dt;
          g.vy -= 1.2 * dt;
          g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
          out.pigeon.push([g.x, g.y, g.z, Math.atan2(g.vx, g.vz), -Math.atan2(g.vy, Math.hypot(g.vx, g.vz)) * 0.6, 0, 1.4, null]);
          if (g.t > 7) this.pigeons.splice(i, 1);
        }
      }

      // canards
      for (const [lk, list] of this.ducks) {
        for (const d of list) {
          d.a += d.w * dt;
          const rr = L.lakeRadius(lk, d.a) * d.r;
          const x = lk.x + Math.cos(d.a) * rr, z = lk.z + Math.sin(d.a) * rr;
          const y = lk.level - 0.04 + Math.sin(t * 2 + d.ph) * 0.015;
          out.duck.push([x, y, z, Math.atan2(-Math.sin(d.a) * d.w, Math.cos(d.a) * d.w), 0, Math.sin(t * 1.7 + d.ph) * 0.06, 1.3, d.male ? '#2f7a4a' : '#8a6a48']);
          A.duck = Math.min(A.duck, dist(x, y, z));
        }
      }

      // la nuit, les oiseaux du jour sont posés (on ne les dessine plus) ; en hiver, mares gelées : pas de canards
      if (!day) {
        for (const k of ['eagle', 'crow', 'swallow', 'gull', 'goose', 'pigeon', 'pigeonGround', 'duck']) out[k].length = 0;
        A.eagle = A.crow = A.goose = A.duck = A.swallow = A.gull = 1e9;
        A.takeoff = 0;
      }
      if (this.winter) { out.duck.length = 0; A.duck = 1e9; }
      // chauves-souris : vol saccadé, en zigzag, autour du coureur (elles chassent les insectes attirés par le phare)
      const bx = P.x + fwd.x * 6, bz = P.z + fwd.z * 6;
      for (const b of this.bats) {
        const x = bx + Math.sin(t * b.w[0] + b.p[0]) * b.r + Math.sin(t * 7.3 + b.p[1]) * 0.8;
        const z = bz + Math.sin(t * b.w[1] + b.p[1]) * b.r + Math.cos(t * 6.1 + b.p[2]) * 0.8;
        const y = P.y + b.h + Math.sin(t * b.w[2] + b.p[2]) * 1.5;
        let yaw = 0, pitch = 0;
        if (b.prev) {
          const dx = x - b.prev[0], dz = z - b.prev[2];
          yaw = Math.atan2(dx, dz);
          pitch = -Math.atan2(y - b.prev[1], Math.hypot(dx, dz) + 1e-4) * 0.6;
        }
        b.prev = [x, y, z];
        out.bat.push([x, y, z, yaw, pitch, 0, 1.6, null]);
        A.bat = Math.min(A.bat, dist(x, y, z));
      }
      // chouettes : vol lent et silencieux en grands cercles au-dessus des bois et des prés
      for (const o of this.owls) {
        o.a += o.w * dt;
        const x = o.cx + Math.cos(o.a) * o.r, z = o.cz + Math.sin(o.a) * o.r;
        const y = o.alt + Math.sin(t * 0.4 + o.a) * 2;
        out.owl.push([x, y, z, Math.atan2(-Math.sin(o.a) * o.w, Math.cos(o.a) * o.w), 0, o.w > 0 ? -0.3 : 0.3, 1.3, null]);
        A.owl = Math.min(A.owl, dist(x, y, z));
      }

      // écriture des matrices d'instance
      for (const [name, arr] of Object.entries(out)) {
        const T = this.types[name];
        const n = Math.min(arr.length, T.cap);
        for (let i = 0; i < n; i++) {
          const b = arr[i];
          _e.set(b[4], b[3], b[5], 'YXZ');
          _q.setFromEuler(_e);
          _m.compose(_p.set(b[0], b[1], b[2]), _q, _s.set(b[6], b[6], b[6]));
          T.mesh.setMatrixAt(i, _m);
          if (b[7]) T.mesh.setColorAt(i, _c.set(b[7]));
        }
        T.mesh.count = n;
        if (T.ol) T.ol.count = n;
        T.mesh.visible = n > 0;
        if (T.ol) T.ol.visible = n > 0;
        if (n) {
          T.mesh.instanceMatrix.needsUpdate = true;
          if (T.mesh.instanceColor) T.mesh.instanceColor.needsUpdate = true;
        }
      }
    }

    dispose() {
      for (const T of Object.values(this.types)) {
        this.scene.remove(T.mesh);
        if (T.ol) this.scene.remove(T.ol);
        T.mesh.geometry.dispose();
        T.mesh.material.dispose();
      }
    }
  }

  B3D.Fauna = Fauna;
})(typeof window !== 'undefined' ? window : globalThis);
