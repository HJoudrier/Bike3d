/* Bike3D — terrain par tuiles chargées autour du joueur, avec végétation instanciée. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { clamp, mulberry32, hash2 } = B3D.util;
  const COVER = B3D.Landscape.COVER;
  const STRIPE = B3D.Landscape.STRIPE;

  const QUALITY = {
    low: { tile: 120, seg: 24, radius: 480, veg: 300, vegNear: 150, detail: 90, treeStep: 8.5, pixelRatio: 1, shadow: 1024, treeShadows: false, caps: 0.45 },
    medium: { tile: 120, seg: 30, radius: 660, veg: 430, vegNear: 210, detail: 120, treeStep: 7, pixelRatio: 1.5, shadow: 2048, treeShadows: false, caps: 0.8 },
    high: { tile: 120, seg: 40, radius: 860, veg: 580, vegNear: 290, detail: 160, treeStep: 6.5, pixelRatio: 2, shadow: 2048, treeShadows: true, caps: 1.3 }
  };

  const POOLS = [
    { name: 'conifer', snow: 1, cap: 17000, outline: true, sway: 0.0015, shadow: true },
    { name: 'deciduous', snow: 0.9, cap: 15000, outline: true, sway: 0.0012, shadow: true },
    { name: 'poplar', snow: 0.8, cap: 3000, outline: true, sway: 0.0012, shadow: true },
    { name: 'bush', snow: 1, cap: 8000, outline: true, sway: 0.004 },
    { name: 'rock', snow: 1, cap: 5000, outline: true },
    { name: 'hay', snow: 1, cap: 1500, outline: true },
    { name: 'cow', cap: 600, outline: true },
    { name: 'spectator', cap: 2600, outline: true, people: true, outlineWidth: 0.8 },
    { name: 'grass', snow: 0.85, cap: 16000, outline: false, sway: 0.08 },
    { name: 'flowers', snow: 0.85, cap: 9000, outline: false, sway: 0.15 },
    // biomes
    { name: 'vine', snow: 0.8, cap: 7000, outline: false },
    { name: 'fruittree', snow: 0.9, cap: 2500, outline: true, sway: 0.0012, shadow: true },
    { name: 'cypress', snow: 0.8, cap: 2500, outline: true, sway: 0.0008, shadow: true },
    { name: 'olive', snow: 0.9, cap: 3000, outline: true, sway: 0.001, shadow: true },
    { name: 'pine', snow: 1, cap: 3000, outline: true, sway: 0.0008, shadow: true },
    { name: 'birch', snow: 0.9, cap: 6000, outline: true, sway: 0.0015, shadow: true },
    { name: 'willow', snow: 0.8, cap: 600, outline: true, sway: 0.002, shadow: true },
    { name: 'reeds', snow: 0.6, cap: 6000, outline: false, sway: 0.06 },
    { name: 'heather', snow: 1, cap: 5000, outline: false },
    { name: 'lavender', snow: 1, cap: 7000, outline: false, sway: 0.03 },
    { name: 'sunflower', snow: 0.7, cap: 6000, outline: false },
    { name: 'pumpkin', snow: 0.9, cap: 3000, outline: true, maxW: 0.05 },
    // faune
    { name: 'horse', cap: 800, outline: true },
    { name: 'sheep', cap: 2000, outline: true },
    { name: 'ibex', cap: 600, outline: true },
    { name: 'marmot', cap: 600, outline: true },
    { name: 'deer', cap: 400, outline: true },
    { name: 'heron', cap: 300, outline: true },
    // faune de la nuit
    { name: 'boar', cap: 700, outline: true },
    { name: 'fox', cap: 400, outline: true },
    { name: 'hedgehog', cap: 400, outline: true, maxW: 0.04 }
  ];
  // qui sort quand : le jour (vaches, chevaux…), la nuit (sangliers, renards, hérissons), à l'aube, au crépuscule et la nuit (chevreuils)
  const ACTIVITY = {
    day: ['cow', 'horse', 'sheep', 'ibex', 'marmot', 'heron'],
    night: ['boar', 'fox', 'hedgehog'],
    twilight: ['deer']
  };

  // Éléments plantés en rangs réguliers, alignés sur les rangs dessinés au sol par le shader du terrain.
  const ROWS = {
    vine: { stripe: STRIPE.VINE, spacing: 3.2, step: 4.6, pool: 'vine', dy: -0.05 },
    orchard: { cover: COVER.ORCHARD, spacing: 8, step: 8, pool: 'fruittree', dy: -0.2, oneWay: true },
    lavender: { stripe: STRIPE.LAVENDER, spacing: 2.6, step: 3.1, pool: 'lavender', dy: -0.08 },
    sunflower: { stripe: STRIPE.SUNFLOWER, spacing: 2.6, step: 2.7, pool: 'sunflower', dy: -0.05 }
  };
  const COATS = {
    horse: ['#8a5a3a', '#5a3a28', '#2d2622', '#e9e4dc', '#b07a45', '#d8c39a', '#9a9aa0'],
    sheep: ['#f4f0e8', '#ece6da', '#f8f6f0', '#efe7d8', '#3a3440'],
    ibex: ['#8f7a62', '#7d6a55', '#9a8670'],
    marmot: ['#9a7350', '#8a6545', '#a07c58'],
    deer: ['#a0603a', '#8f5533', '#9a6a42'],
    boar: ['#4a3a30', '#3f322b', '#56443a'],
    fox: ['#d9692a', '#cf5d22', '#e07a36']
  };

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const _c = new THREE.Color();

  class TileManager {
    constructor(scene, landscape, qualityName) {
      this.scene = scene;
      this.L = landscape;
      this.setQuality(qualityName, true);
      this.tiles = new Map();
      this.queue = [];
      this.group = new THREE.Group();
      this.group.name = 'terrain';
      scene.add(this.group);
      this.material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: B3D.toon.terrainGradientMap() });
      this._patchTerrainMaterial(this.material);
      this._createPools();
      this._o = {};
      this._oc = {};
    }

    setQuality(name, initial) {
      this.qName = name;
      this.Q = QUALITY[name] || QUALITY.medium;
      this.S = this.Q.tile;
      this.N = this.Q.seg;
      this.step = this.S / this.N;
      this._buildIndex();
      if (!initial) this.clear();
    }

    // Petite texture de "grain" procédural dans le shader du terrain pour éviter l'aspect trop lisse.
    _patchTerrainMaterial(m) {
      const L = this.L;
      const rowDir = new THREE.Vector2(L.bio.rowDir[0], L.bio.rowDir[1]);
      const vineGreen = new THREE.Color(L.amb.vineGreen), soil = new THREE.Color(L.amb.soil);
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uRowDir = { value: rowDir };
        shader.uniforms.uVineGreen = { value: vineGreen };
        shader.uniforms.uSoil = { value: soil };
        shader.uniforms.uWet = B3D.toon.shared.uWet;
        shader.uniforms.uSnow = B3D.toon.shared.uSnow;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying float vUpN;\nattribute float stripe;\nflat varying float vStripe;')
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvUpN = normal.y;\nvStripe = stripe;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', [
            '#include <common>',
            'varying vec3 vWPos;',
            'varying float vUpN;',
            'flat varying float vStripe;',
            'uniform vec2 uRowDir;',
            'uniform vec3 uVineGreen, uSoil;',
            'uniform float uWet, uSnow;',
            'float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
            'float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);',
            '  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }'
          ].join('\n'))
          .replace('#include <color_fragment>', [
            '#include <color_fragment>',
            'float gN = vnoise(vWPos.xz * 0.35) * 0.6 + vnoise(vWPos.xz * 1.7) * 0.4;',
            'float fade = clamp(1.0 - length(vWPos - cameraPosition) / 260.0, 0.0, 1.0);',
            'diffuseColor.rgb *= 1.0 + (gN - 0.5) * 0.16 * fade;',
            'diffuseColor.rgb *= 1.0 - 0.16 * uWet;',
            // strates horizontales sur les parois raides (falaises)
            'float steep = smoothstep(0.78, 0.5, vUpN);',
            'float band = fract(vWPos.y / 7.0 + vnoise(vWPos.xz * 0.04) * 1.2);',
            'float sFade = clamp(1.0 - length(vWPos - cameraPosition) / 380.0, 0.0, 1.0);',
            'diffuseColor.rgb *= 1.0 - steep * sFade * (step(0.6, band) * 0.16 + step(0.92, band) * 0.12);',
            // rangs : sillons des champs, vignes, lavande, tournesols (atténués au loin pour éviter le moiré)
            'if (vStripe > 0.5) {',
            '  float ori = vStripe > 7.5 ? 1.0 : 0.0;',
            '  float kind = vStripe - ori * 8.0;',
            '  vec2 rdir = ori > 0.5 ? vec2(-uRowDir.y, uRowDir.x) : uRowDir;',
            '  float spacing = (kind < 1.5 || kind > 4.5) ? 2.2 : (kind < 2.5 ? 3.2 : 2.6);',
            '  float row = 0.5 + 0.5 * sin(dot(vWPos.xz, rdir) / spacing * 6.2831853);',
            '  float rf = clamp(1.0 - length(vWPos - cameraPosition) / 420.0, 0.0, 1.0);',
            '  if (kind < 1.5 || kind > 4.5) diffuseColor.rgb *= 1.0 - 0.13 * smoothstep(0.5, 0.85, row) * rf;',
            '  else if (kind < 2.5) diffuseColor.rgb = mix(diffuseColor.rgb, uVineGreen, mix(0.35, smoothstep(0.55, 0.85, row) * 0.8, rf));',
            '  else diffuseColor.rgb = mix(diffuseColor.rgb, uSoil, mix(0.15, smoothstep(0.6, 0.9, 1.0 - row) * 0.6, rf));',
            '}',
            // manteau neigeux : tout ce qui n'est pas trop raide blanchit, avec des taches où l'herbe perce
            'if (uSnow > 0.01) {',
            '  float snP = vnoise(vWPos.xz * 0.11) * 0.65 + vnoise(vWPos.xz * 0.7) * 0.35;',
            '  float snK = uSnow * smoothstep(0.5, 0.8, vUpN) * smoothstep(0.18, 0.42, snP + uSnow * 0.35);',
            '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.99) * (0.96 + 0.06 * gN), snK);',
            '}'
          ].join('\n'));
      };
      m.customProgramCacheKey = () => 'terrain-grain-rows';
    }

    _buildIndex() {
      const N = this.N, V = N + 1;
      const idx = new Uint16Array(N * N * 6);
      let k = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
          if ((i + j) & 1) { idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d; }
          else { idx[k++] = a; idx[k++] = c; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = b; }
        }
      }
      // le tableau est partagé, mais chaque tuile a son propre attribut (et donc son propre buffer GPU) :
      // libérer une tuile ne doit pas détruire l'index des autres.
      this.indexArray = idx;
    }

    _createPools() {
      const geos = B3D.props.geometries();
      this.pools = {};
      for (const p of POOLS) {
        const cap = Math.round(p.cap * this.Q.caps);
        const geo = p.name === 'fruittree' ? B3D.props.fruitTree(this.L.amb.fruit) : geos[p.name];
        this.pools[p.name] = new B3D.props.InstancePool(this.scene, geo, {
          capacity: cap, outline: p.outline, sway: p.sway, bounce: p.bounce, people: p.people, outlineWidth: p.outlineWidth, maxW: p.maxW, snow: p.snow,
          castShadow: p.shadow && this.Q.treeShadows || p.name === 'spectator'
        });
      }
    }

    clear() {
      if (!this.tiles) return;
      for (const t of this.tiles.values()) this._disposeTile(t);
      this.tiles.clear();
      this.queue.length = 0;
    }

    dispose() {
      this.clear();
      for (const p of Object.values(this.pools)) p.dispose();
      this.scene.remove(this.group);
      this.material.dispose();
    }

    _disposeTile(t) {
      if (t.mesh) {
        this.group.remove(t.mesh);
        t.mesh.geometry.dispose();
      }
      this._releaseList(t.veg);
      this._releaseList(t.details);
      t.veg = null; t.details = null;
    }

    _releaseList(list) {
      if (!list) return;
      for (let k = 0; k < list.length; k += 2) this.pools[list[k]].release(list[k + 1]);
    }

    // Met à jour les tuiles autour du point focal ; construit dans la limite d'un budget de temps (ms).
    update(fx, fz, budgetMs) {
      const S = this.S, Q = this.Q;
      const R = Q.radius;
      const ctx = Math.floor(fx / S), ctz = Math.floor(fz / S);
      const rc = Math.ceil(R / S) + 1;
      const need = [];
      for (let tz = ctz - rc; tz <= ctz + rc; tz++) {
        for (let tx = ctx - rc; tx <= ctx + rc; tx++) {
          const cx = (tx + 0.5) * S, cz = (tz + 0.5) * S;
          const d = Math.hypot(cx - fx, cz - fz) - S * 0.7;
          const key = tx + ',' + tz;
          const t = this.tiles.get(key);
          if (d < R) {
            if (!t) need.push({ key, tx, tz, d });
            else t.d = d;
          }
        }
      }
      // suppression des tuiles lointaines
      for (const [key, t] of this.tiles) {
        const cx = (t.tx + 0.5) * S, cz = (t.tz + 0.5) * S;
        t.d = Math.hypot(cx - fx, cz - fz) - S * 0.7;
        if (t.d > R + S) { this._disposeTile(t); this.tiles.delete(key); }
      }
      need.sort((a, b) => a.d - b.d);
      const t0 = performance.now();
      let built = 0;
      for (const n of need) {
        if (built > 0 && performance.now() - t0 > budgetMs) break;
        const t = this._buildTile(n.tx, n.tz);
        t.d = n.d;
        this.tiles.set(n.key, t);
        built++;
      }
      // végétation / détails selon la distance
      for (const t of this.tiles.values()) {
        if (performance.now() - t0 > budgetMs * 1.5) break;
        // végétation en 2 niveaux de détail : forêts éclaircies au loin
        const lvl = t.d < Q.vegNear ? 0 : 1;
        if (!t.veg && t.d < Q.veg) { t.veg = this._buildVeg(t, lvl); t.vegLevel = lvl; }
        else if (t.veg && t.d > Q.veg + 80) { this._releaseList(t.veg); t.veg = null; t.fauna = null; }
        else if (t.veg && lvl !== t.vegLevel && Math.abs(t.d - Q.vegNear) > 25) {
          this._releaseList(t.veg);
          t.veg = this._buildVeg(t, lvl);
          t.vegLevel = lvl;
        }
        if (!t.details && t.d < Q.detail && (t.nearRoad || t.rowCrop || t.pumpkins)) { t.details = this._buildDetails(t); }
        else if (t.details && t.d > Q.detail + 50) { this._releaseList(t.details); t.details = null; }
      }
      for (const p of Object.values(this.pools)) p.flush();
      return need.length - built; // tuiles restantes
    }

    pendingCount(fx, fz) {
      const S = this.S, R = this.Q.radius;
      const ctx = Math.floor(fx / S), ctz = Math.floor(fz / S);
      const rc = Math.ceil(R / S) + 1;
      let n = 0, total = 0;
      for (let tz = ctz - rc; tz <= ctz + rc; tz++) {
        for (let tx = ctx - rc; tx <= ctx + rc; tx++) {
          const d = Math.hypot((tx + 0.5) * S - fx, (tz + 0.5) * S - fz) - S * 0.7;
          if (d < R) { total++; if (!this.tiles.has(tx + ',' + tz)) n++; }
        }
      }
      return { missing: n, total };
    }

    _buildTile(tx, tz) {
      const L = this.L, N = this.N, S = this.S, step = this.step;
      const V = N + 1, NB = N + 3;
      const x0 = tx * S, z0 = tz * S;
      const H = new Float32Array(NB * NB);
      const cnt = V * V;
      const roadD = new Float32Array(cnt), dr = new Float32Array(cnt), rw = new Float32Array(cnt), wl = new Float32Array(cnt);
      const lakeRn = new Float32Array(cnt), under = new Uint8Array(cnt), vill = new Float32Array(cnt), pond = new Uint8Array(cnt);
      let hasPond = false;
      const o = this._o;
      let nearRoad = false;
      for (let j = 0; j < NB; j++) {
        for (let i = 0; i < NB; i++) {
          const x = x0 + (i - 1) * step, z = z0 + (j - 1) * step;
          L.sample(x, z, o);
          H[j * NB + i] = o.h;
          if (i >= 1 && j >= 1 && i <= V && j <= V) {
            const k = (j - 1) * V + (i - 1);
            roadD[k] = o.roadD; dr[k] = o.dr; rw[k] = o.rw; wl[k] = o.wl; lakeRn[k] = o.lakeRn; under[k] = o.under ? 1 : 0; vill[k] = o.vill;
            pond[k] = o.lakePond ? 1 : 0;
            if (o.lakePond && o.lakeRn < 1.6) hasPond = true;
            if (o.roadD < 40) nearRoad = true;
          }
        }
      }
      const pos = new Float32Array(cnt * 3), nor = new Float32Array(cnt * 3), col = new Float32Array(cnt * 3);
      const cover = new Uint8Array(cnt), crop = new Uint8Array(cnt), slopeA = new Float32Array(cnt), stripe = new Float32Array(cnt);
      let rowCrop = false, pumpkins = false;
      const oc = this._oc;
      for (let j = 0; j < V; j++) {
        for (let i = 0; i < V; i++) {
          const k = j * V + i;
          const hb = (j + 1) * NB + (i + 1);
          const h = H[hb];
          const dx = (H[hb + 1] - H[hb - 1]) / (2 * step);
          const dz = (H[hb + NB] - H[hb - NB]) / (2 * step);
          const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
          pos[k * 3] = i * step; pos[k * 3 + 1] = h; pos[k * 3 + 2] = j * step;
          nor[k * 3] = -dx * inv; nor[k * 3 + 1] = inv; nor[k * 3 + 2] = -dz * inv;
          const slope = Math.sqrt(dx * dx + dz * dz);
          slopeA[k] = slope;
          oc.h = h; oc.roadD = roadD[k]; oc.dr = dr[k]; oc.rw = rw[k]; oc.wl = wl[k]; oc.lakeRn = lakeRn[k]; oc.under = !!under[k]; oc.vill = vill[k]; oc.lakePond = !!pond[k];
          L.cover(x0 + i * step, z0 + j * step, oc, slope, _c);
          cover[k] = oc.cover; crop[k] = oc.crop; stripe[k] = oc.stripe;
          const sk = oc.stripe % 8;
          if (sk === STRIPE.LAVENDER || sk === STRIPE.SUNFLOWER) rowCrop = true;
          if (sk === STRIPE.PUMPKIN) pumpkins = true;
          col[k * 3] = _c.r; col[k * 3 + 1] = _c.g; col[k * 3 + 2] = _c.b;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('stripe', new THREE.BufferAttribute(stripe, 1));
      geo.setIndex(new THREE.BufferAttribute(this.indexArray, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.position.set(x0, 0, z0);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      return {
        tx, tz, x0, z0, mesh, H, NB, V, cover, crop, stripe, slope: slopeA, roadD, dr, rw, under, lakeRn, vill, pond,
        nearRoad, rowCrop, pumpkins, hasPond, veg: null, details: null, fauna: null, d: 0
      };
    }

    // Animal le plus proche d'un point (dans les tuiles voisines) : { x, y, z, d } ou null.
    // type : 'cow', 'horse', 'sheep', 'marmot', 'ibex'
    nearestAnimal(type, x, z, maxD) {
      if (this.pools[type] && !this.pools[type].active) return null; // il dort
      const S = this.S;
      const tx0 = Math.floor(x / S), tz0 = Math.floor(z / S);
      let best = null, bd = maxD;
      for (let tz = tz0 - 1; tz <= tz0 + 1; tz++) {
        for (let tx = tx0 - 1; tx <= tx0 + 1; tx++) {
          const t = this.tiles.get(tx + ',' + tz);
          if (!t || !t.fauna) continue;
          const c = t.fauna[type];
          for (let k = 0; k < c.length; k += 3) {
            const d = Math.hypot(c[k] - x, c[k + 2] - z);
            if (d < bd) { bd = d; best = { x: c[k], y: c[k + 1], z: c[k + 2], d }; }
          }
        }
      }
      return best;
    }

    nearestCow(x, z, maxD) { return this.nearestAnimal('cow', x, z, maxD); }

    // Animaux de jour et de nuit : dk = luminosité du jour (1 plein jour, 0 nuit noire).
    // Les animaux du jour rentrent au crépuscule, ceux de la nuit sortent (avec un petit chevauchement).
    setActivity(dk) {
      const day = this._dayOn === undefined ? dk > 0.3 : this._dayOn ? dk > 0.22 : dk > 0.38;
      const night = dk < 0.45;
      const twilight = dk < 0.85;
      this._dayOn = day;
      for (const n of ACTIVITY.day) this.pools[n].setActive(day);
      for (const n of ACTIVITY.night) this.pools[n].setActive(night);
      for (const n of ACTIVITY.twilight) this.pools[n].setActive(twilight);
    }

    // Proportion de couvertures du sol autour d'un point (pour l'ambiance sonore).
    coverMix(x, z) {
      const t = this.tiles.get(Math.floor(x / this.S) + ',' + Math.floor(z / this.S));
      const out = { forest: 0, meadow: 0, garrigue: 0, wet: 0, alpine: 0, n: 0 };
      if (!t) return out;
      for (let k = 0; k < t.cover.length; k += 7) {
        const c = t.cover[k];
        out.n++;
        if (c === COVER.FOREST) out.forest++;
        else if (c === COVER.MEADOW || c === COVER.ORCHARD || c === COVER.HEDGE || c === COVER.FIELD || c === COVER.VINEYARD) out.meadow++;
        else if (c === COVER.GARRIGUE) out.garrigue++;
        else if (c === COVER.WETLAND || t.pond[k]) out.wet++;
        else if (c === COVER.ALPINE || c === COVER.HEATH || c === COVER.ROCK) out.alpine++;
      }
      for (const key of ['forest', 'meadow', 'garrigue', 'wet', 'alpine']) out[key] /= Math.max(1, out.n);
      out.ponds = t.hasPond;
      return out;
    }

    // Interpolations sur la grille de la tuile
    _hAt(t, x, z) {
      const fx = (x - t.x0) / this.step + 1, fz = (z - t.z0) / this.step + 1;
      const i = clamp(Math.floor(fx), 0, t.NB - 2), j = clamp(Math.floor(fz), 0, t.NB - 2);
      const u = fx - i, v = fz - j;
      const H = t.H, NB = t.NB;
      return (H[j * NB + i] * (1 - u) + H[j * NB + i + 1] * u) * (1 - v) + (H[(j + 1) * NB + i] * (1 - u) + H[(j + 1) * NB + i + 1] * u) * v;
    }

    _roadDAt(t, x, z) {
      const fx = (x - t.x0) / this.step, fz = (z - t.z0) / this.step;
      const V = t.V;
      const i = clamp(Math.floor(fx), 0, V - 2), j = clamp(Math.floor(fz), 0, V - 2);
      const u = fx - i, v = fz - j, R = t.roadD;
      return (R[j * V + i] * (1 - u) + R[j * V + i + 1] * u) * (1 - v) + (R[(j + 1) * V + i] * (1 - u) + R[(j + 1) * V + i + 1] * u) * v;
    }

    _vIndex(t, x, z) {
      const i = clamp(Math.round((x - t.x0) / this.step), 0, t.V - 1);
      const j = clamp(Math.round((z - t.z0) / this.step), 0, t.V - 1);
      return j * t.V + i;
    }

    _place(list, pool, x, y, z, rotY, scale, color, sx, sy, tiltX, tiltZ) {
      const p = this.pools[pool];
      const i = p.alloc();
      if (i < 0) return;
      _e.set(tiltX || 0, rotY, tiltZ || 0);
      _q.setFromEuler(_e);
      _p.set(x, y, z);
      _s.set(scale * (sx || 1), scale * (sy || 1), scale * (sx || 1));
      _m.compose(_p, _q, _s);
      p.set(i, _m, color);
      list.push(pool, i);
    }

    _tint(rnd, palette, vary) {
      _c.set(palette[Math.floor(rnd() * palette.length)]);
      const v = 1 + (rnd() - 0.5) * (vary || 0.12);
      _c.r *= v; _c.g *= v; _c.b *= v;
      return _c;
    }

    _buildVeg(t, lvl) {
      const L = this.L, P = L.P, B = L.bio, amb = L.amb, half = L.roadHalf;
      const list = [];
      // positions des animaux (pour leurs cris)
      const F = t.fauna = { cow: [], horse: [], sheep: [], marmot: [], ibex: [], deer: [], boar: [], fox: [], hedgehog: [] };
      const st = this.Q.treeStep;
      const n = Math.floor(this.S / st);
      const V = t.V;
      // troupeaux : chaque espèce a ses prés
      const herd = (x, z, ox, oz, thr) => L.noiseB.noise(x / 330 + ox, z / 330 + oz) > thr;
      const animal = (type, x, y, z, rot, rnd, sc) => {
        this._place(list, type, x, y, z, rot, sc || 1, COATS[type] ? this._tint(rnd, COATS[type], 0.08) : null);
        if (F[type]) F[type].push(x, y, z);
      };
      for (let gj = 0; gj < n; gj++) {
        for (let gi = 0; gi < n; gi++) {
          // générateur propre à chaque emplacement : le résultat ne dépend pas des emplacements voisins
          const rnd = mulberry32((hash2(t.tx * 64 + gi, t.tz * 64 + gj, L.seed) * 4294967296) >>> 0);
          const x = t.x0 + (gi + 0.15 + rnd() * 0.7) * st;
          const z = t.z0 + (gj + 0.15 + rnd() * 0.7) * st;
          const r = rnd();
          const k = this._vIndex(t, x, z);
          if (t.pond[k] && t.lakeRn[k] < 1.6) {
            // abords des mares : saules, hérons
            if (!t.under[k] && t.lakeRn[k] > 1.15) {
              const y = this._hAt(t, x, z);
              if (r < 0.06) this._place(list, 'willow', x, y - 0.2, z, rnd() * 6.28, 0.8 + rnd() * 0.4, this._tint(rnd, amb.willow));
              else if (r < 0.09) animal('heron', x, y, z, rnd() * 6.28, rnd);
            }
            continue;
          }
          if (t.under[k] || t.lakeRn[k] < 1.2) continue;
          const rd = this._roadDAt(t, x, z);
          if (rd < half + 3.2) continue;
          const cov = t.cover[k];
          const slope = t.slope[k];
          const y = this._hAt(t, x, z);
          const rot = rnd() * Math.PI * 2;
          const sc = 0.8 + rnd() * 0.6;
          // pas d'arbre sur les camping-cars des supporters
          if (L.keepOut && L.keepOut.length && L.keepOut.some((c) => Math.abs(c.x - x) < c.r && Math.abs(c.z - z) < c.r)) continue;
          // village : les maisons occupent le terrain, seulement quelques haies de jardin au fond
          if (t.vill[k] > 0.15 && rd < 36) {
            if (r < 0.06 && rd > half + 14) this._place(list, 'bush', x, y - 0.1, z, rot, sc, this._tint(rnd, amb.bush));
            else if (r < 0.07 && rd > half + 6) animal('hedgehog', x, y, z, rot, rnd, 0.9 + rnd() * 0.3); // dans les jardins, la nuit
            continue;
          }
          const nearRiver = t.dr[k] < t.rw[k] + 16 && t.dr[k] > t.rw[k] + 3;
          if (nearRiver && r < 0.14) {
            this._place(list, 'poplar', x, y - 0.2, z, rot, sc, this._tint(rnd, amb.poplar));
            continue;
          }
          if (nearRiver && r > 0.985) { animal('heron', x, y, z, rot, rnd); continue; }
          let acc;
          switch (cov) {
            case COVER.FOREST: {
              // au loin, un arbre sur deux (choix stable, indépendant de la séquence aléatoire)
              if (lvl === 1 && hash2(t.tx * 64 + gi, t.tz * 64 + gj, L.seed + 5) < 0.45) break;
              if (r < 0.88) {
                const south = B.south && y < 800;
                if (south && rnd() < 0.6) this._place(list, 'pine', x, y - 0.3, z, rot, sc * 0.9, this._tint(rnd, amb.pine));
                else if (!south && y < 1300 && rnd() < B.birch) this._place(list, 'birch', x, y - 0.3, z, rot, sc, this._tint(rnd, amb.birch));
                else {
                  const conif = y > 1050 + 250 * L.noiseC.noise(x / 300, z / 300) || rnd() < 0.18;
                  if (conif) this._place(list, 'conifer', x, y - 0.3, z, rot, sc * 1.1, this._tint(rnd, amb.conifer), 1, 1 + rnd() * 0.25, (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.06);
                  else this._place(list, 'deciduous', x, y - 0.3, z, rot, sc, this._tint(rnd, amb.decid));
                }
              } else if (r < 0.93) {
                this._place(list, 'bush', x, y - 0.1, z, rot, sc, this._tint(rnd, amb.bush));
              } else if (r < 0.945) {
                // chevreuil en lisière
                const edge = [k - 1, k + 1, k - V, k + V].some((q) => q >= 0 && q < t.cover.length && t.cover[q] !== COVER.FOREST);
                if (edge) animal('deer', x, y, z, rot, rnd, 0.9 + rnd() * 0.2);
              } else if (r < 0.962) {
                // compagnie de sangliers qui fouille le sous-bois
                if (herd(x, z, -61.7, 140.3, 0.3)) animal('boar', x, y, z, rot, rnd, 0.85 + rnd() * 0.3);
              } else if (r < 0.966) {
                const edge = [k - 1, k + 1, k - V, k + V].some((q) => q >= 0 && q < t.cover.length && t.cover[q] !== COVER.FOREST);
                if (edge) animal('fox', x, y, z, rot, rnd, 0.9 + rnd() * 0.2);
              }
              break;
            }
            case COVER.MEADOW: {
              acc = P.meadowTrees;
              if (r < acc) {
                if (y > 1200) this._place(list, 'conifer', x, y - 0.3, z, rot, sc, this._tint(rnd, amb.conifer));
                else this._place(list, 'deciduous', x, y - 0.3, z, rot, sc * 1.1, this._tint(rnd, amb.decid));
              } else if (r < (acc += 0.02)) {
                this._place(list, 'bush', x, y - 0.1, z, rot, sc, this._tint(rnd, amb.bush));
              } else if (r < (acc += P.cows * (herd(x, z, 50.5, -20.5, 0.3) ? 9 : 0.25)) && slope < 0.35) {
                animal('cow', x, y, z, rot, rnd);
              } else if (r < (acc += herd(x, z, -130.2, 77.7, 0.38) ? 0.03 : 0) && slope < 0.3 && y < 1700) {
                animal('horse', x, y, z, rot, rnd, 0.95 + rnd() * 0.15);
              } else if (r < (acc += herd(x, z, 210.1, -310.4, 0.36) ? 0.07 : 0) && slope < 0.55) {
                animal('sheep', x, y, z, rot, rnd, 0.85 + rnd() * 0.3);
              } else if (r < (acc += 0.006 * P.rockiness)) {
                this._place(list, 'rock', x, y - 0.2, z, rot, 0.5 + rnd() * 1.2, this._tint(rnd, amb.rockTint), 1, 0.7 + rnd() * 0.5);
              } else if (r < (acc += 0.0025)) {
                animal('fox', x, y, z, rot, rnd, 0.9 + rnd() * 0.2); // renard qui chasse les mulots
              } else if (r < (acc += herd(x, z, -61.7, 140.3, 0.45) ? 0.012 : 0) && slope < 0.4) {
                animal('deer', x, y, z, rot, rnd, 0.9 + rnd() * 0.2); // chevreuils sortis brouter à la tombée du jour
              }
              break;
            }
            case COVER.ORCHARD: {
              // les arbres sont plantés en rangs (voir _buildRows) ; quelques moutons tondent l'herbe
              if (r < 0.025 && herd(x, z, 210.1, -310.4, 0.1)) animal('sheep', x, y, z, rot, rnd, 0.9);
              break;
            }
            case COVER.HEDGE: {
              if (r < 0.5) this._place(list, 'bush', x, y - 0.1, z, rot, sc * 1.1, this._tint(rnd, amb.bush));
              else if (r < 0.62) this._place(list, 'deciduous', x, y - 0.3, z, rot, sc, this._tint(rnd, amb.decid));
              else if (r < 0.66) animal('hedgehog', x, y, z, rot, rnd, 0.9 + rnd() * 0.3);
              break;
            }
            case COVER.FIELD: {
              if (L.cropHay[t.crop[k]] && r < 0.03) {
                this._place(list, 'hay', x, y, z, rot, 0.9 + rnd() * 0.2, this._tint(rnd, ['#e9cf6a', '#dcc060'], 0.08));
              } else if (r > 0.99 && herd(x, z, -61.7, 140.3, 0.35)) {
                animal('boar', x, y, z, rot, rnd, 0.85 + rnd() * 0.3); // les sangliers ravagent les champs la nuit
              }
              break;
            }
            case COVER.GARRIGUE: {
              if (r < 0.045) this._place(list, 'olive', x, y - 0.2, z, rot, sc, this._tint(rnd, amb.olive));
              else if (r < 0.06) this._place(list, 'cypress', x, y - 0.2, z, rot, sc, this._tint(rnd, amb.cypress));
              else if (r < 0.075) this._place(list, 'pine', x, y - 0.3, z, rot, sc * 0.9, this._tint(rnd, amb.pine));
              else if (r < 0.2) this._place(list, 'bush', x, y - 0.15, z, rot, sc * 0.65, this._tint(rnd, amb.shrub));
              else if (r < 0.22) this._place(list, 'rock', x, y - 0.2, z, rot, 0.4 + rnd() * 0.9, this._tint(rnd, amb.rockTint), 1, 0.7);
              else if (r < 0.27) this._place(list, 'heather', x, y - 0.05, z, rot, 1 + rnd() * 0.5, this._tint(rnd, ['#9d80d8', '#a989df'], 0.06));
              else if (r < 0.29 && herd(x, z, 210.1, -310.4, 0.2)) animal('sheep', x, y, z, rot, rnd, 0.85);
              break;
            }
            case COVER.HEATH: {
              if (r < 0.2) this._place(list, 'heather', x, y - 0.05, z, rot, 0.9 + rnd() * 0.7, this._tint(rnd, amb.heather));
              else if (r < 0.22) this._place(list, 'rock', x, y - 0.2, z, rot, 0.4 + rnd() * 1.0, this._tint(rnd, amb.rockTint), 1, 0.7);
              else if (r < 0.235) this._place(list, 'conifer', x, y - 0.2, z, rot, sc * 0.5, this._tint(rnd, amb.conifer));
              else if (r < 0.245 && y < 1500) this._place(list, 'birch', x, y - 0.3, z, rot, sc * 0.8, this._tint(rnd, amb.birch));
              else if (r < 0.31 && herd(x, z, 210.1, -310.4, 0.3)) animal('sheep', x, y, z, rot, rnd, 0.85 + rnd() * 0.3);
              else if (r < 0.325 && y > 1250) animal('marmot', x, y, z, rot, rnd, 0.9 + rnd() * 0.3);
              break;
            }
            case COVER.WETLAND: {
              if (r < 0.1) this._place(list, 'reeds', x, y - 0.05, z, rot, 0.9 + rnd() * 0.5, this._tint(rnd, amb.reeds));
              else if (r < 0.115) this._place(list, 'willow', x, y - 0.2, z, rot, sc * 0.9, this._tint(rnd, amb.willow));
              else if (r < 0.13) this._place(list, 'poplar', x, y - 0.2, z, rot, sc, this._tint(rnd, amb.poplar));
              else if (r < 0.136) animal('heron', x, y, z, rot, rnd);
              else if (r < 0.15 && herd(x, z, 50.5, -20.5, 0.2)) animal('cow', x, y, z, rot, rnd);
              break;
            }
            case COVER.ALPINE: {
              if (r < 0.05 * P.rockiness) this._place(list, 'rock', x, y - 0.3, z, rot, 0.6 + rnd() * 1.6, this._tint(rnd, amb.rockTint), 1, 0.6 + rnd() * 0.6);
              else if (r < 0.07) this._place(list, 'conifer', x, y - 0.3, z, rot, sc * 0.7, this._tint(rnd, amb.conifer));
              else if (r < 0.07 + P.cows * (herd(x, z, 50.5, -20.5, 0.2) ? 10 : 0.5) && slope < 0.4) animal('cow', x, y, z, rot, rnd);
              else if (r > 0.9 && r < 0.93 && herd(x, z, 77.3, 91.1, 0.15)) animal('marmot', x, y, z, rot, rnd, 0.9 + rnd() * 0.3);
              else if (r > 0.93 && r < 0.99 && herd(x, z, 210.1, -310.4, 0.35) && slope < 0.6) animal('sheep', x, y, z, rot, rnd, 0.85 + rnd() * 0.3);
              else if (r > 0.995 && y > 1500) animal('ibex', x, y, z, rot, rnd, 0.9 + rnd() * 0.2);
              break;
            }
            case COVER.ROCK: {
              // blocs rocheux à flanc de falaise, et parfois un bouquetin perché
              if (r < 0.16) this._place(list, 'rock', x, y - 0.8, z, rot, 1.2 + rnd() * 2.6, this._tint(rnd, amb.rockTint), 1, 0.7 + rnd() * 0.6, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5);
              else if (r < 0.19 && slope < 1.2) this._place(list, 'conifer', x, y - 0.3, z, rot, sc * 0.8, this._tint(rnd, amb.conifer));
              else if (r < 0.205 && y > 1150) animal('ibex', x, y, z, rot, rnd, 0.9 + rnd() * 0.2);
              break;
            }
            default: break;
          }
        }
      }
      // roseaux serrés sur le pourtour des mares
      if (t.hasPond) {
        const rnd = mulberry32((hash2(t.tx, t.tz, L.seed + 4242) * 4294967296) >>> 0);
        for (const lk of L.ponds) {
          if (lk.x < t.x0 - lk.r * 1.5 || lk.x > t.x0 + this.S + lk.r * 1.5 || lk.z < t.z0 - lk.r * 1.5 || lk.z > t.z0 + this.S + lk.r * 1.5) continue;
          const nb = Math.ceil(lk.r * 2 * Math.PI / 1.3);
          for (let q = 0; q < nb; q++) {
            const a = (q + rnd() * 0.6) / nb * Math.PI * 2;
            const rr = L.lakeRadius(lk, a) * (1.0 + rnd() * 0.14);
            const x = lk.x + Math.cos(a) * rr, z = lk.z + Math.sin(a) * rr;
            if (x < t.x0 || x >= t.x0 + this.S || z < t.z0 || z >= t.z0 + this.S || rnd() > 0.7) continue;
            this._place(list, 'reeds', x, lk.level - 0.15, z, rnd() * 6.28, 0.8 + rnd() * 0.6, this._tint(rnd, amb.reeds));
          }
        }
      }
      // vignes (seulement de près : au loin, les rangs peints au sol suffisent) et vergers
      this._buildRows(t, list, lvl === 0 ? ['vine', 'orchard'] : ['orchard']);
      return list;
    }

    // Plantations en rangs réguliers, sur un réseau aligné avec les rangs du shader du terrain.
    _buildRows(t, list, kinds) {
      const L = this.L, amb = L.amb, dir = L.bio.rowDir, S = this.S;
      const lavColor = L.amb.crops.find((c) => c[2] === 'lavender');
      for (const kind of kinds) {
        const spec = ROWS[kind];
        for (const ori of [0, 1]) {
          if (spec.oneWay && ori === 1) continue;
          const nx = ori ? -dir[1] : dir[0], nz = ori ? dir[0] : dir[1]; // normale aux rangs
          const tx = -nz, tz = nx; // direction des rangs
          const rotY = Math.atan2(-tz, tx); // axe x des modèles le long du rang
          let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
          for (const [cx, cz] of [[t.x0, t.z0], [t.x0 + S, t.z0], [t.x0, t.z0 + S], [t.x0 + S, t.z0 + S]]) {
            const u = cx * nx + cz * nz, w = cx * tx + cz * tz;
            u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w);
          }
          const rnd = mulberry32((hash2(t.tx * 7 + ori, t.tz * 7, L.seed + kind.length) * 4294967296) >>> 0);
          for (let kk = Math.ceil(u0 / spec.spacing - 0.25); kk <= Math.floor(u1 / spec.spacing - 0.25); kk++) {
            const u = (kk + 0.25) * spec.spacing;
            const off = (kk & 1) * spec.step * 0.5;
            for (let mm = Math.ceil((w0 - off) / spec.step); mm <= Math.floor((w1 - off) / spec.step); mm++) {
              const w = mm * spec.step + off;
              const x = u * nx + w * tx, z = u * nz + w * tz;
              if (x < t.x0 || x >= t.x0 + S || z < t.z0 || z >= t.z0 + S) continue;
              const k = this._vIndex(t, x, z);
              if (spec.cover !== undefined && t.cover[k] !== spec.cover) continue;
              if (spec.stripe !== undefined && (t.stripe[k] % 8 !== spec.stripe || (t.stripe[k] >= 8 ? 1 : 0) !== ori)) continue;
              if (t.under[k] || t.vill[k] > 0.15 || this._roadDAt(t, x, z) < L.roadHalf + 3) continue;
              const y = this._hAt(t, x, z) + spec.dy;
              if (kind === 'vine') this._place(list, 'vine', x, y, z, rotY, 1, this._tint(rnd, [amb.vineGreen], 0.15));
              else if (kind === 'orchard') this._place(list, 'fruittree', x, y, z, rnd() * 6.28, 0.85 + rnd() * 0.3, this._tint(rnd, amb.orchard));
              else if (kind === 'lavender') this._place(list, 'lavender', x, y, z, rotY, 1, this._tint(rnd, [lavColor ? lavColor[0] : '#a989df'], 0.1));
              else this._place(list, 'sunflower', x, y, z, rotY, 0.9 + rnd() * 0.2, null);
            }
          }
        }
      }
    }

    // Petits détails : touffes d'herbe, fleurs et cailloux près de la route ; rangs de lavande et
    // de tournesols ; citrouilles.
    _buildDetails(t) {
      const L = this.L, P = L.P, amb = L.amb, half = L.roadHalf;
      const rnd = mulberry32((hash2(t.tx, t.tz, L.seed + 999) * 4294967296) >>> 0);
      const list = [];
      if (t.nearRoad) {
        const st = 2.4;
        const n = Math.floor(this.S / st);
        for (let gj = 0; gj < n; gj++) {
          for (let gi = 0; gi < n; gi++) {
            const x = t.x0 + (gi + rnd()) * st;
            const z = t.z0 + (gj + rnd()) * st;
            const rd = this._roadDAt(t, x, z);
            if (rd > 34 || rd < half + 0.9) { rnd(); rnd(); continue; }
            const k = this._vIndex(t, x, z);
            if (t.under[k] || t.lakeRn[k] < 1.15) continue;
            if (t.vill[k] > 0.15 && rd < half + 2.3) continue; // trottoirs
            const cov = t.cover[k];
            if (cov === COVER.SNOW || cov === COVER.SAND || cov === COVER.BED || t.slope[k] > 0.9) continue;
            const r = rnd();
            const y = this._hAt(t, x, z);
            const rot = rnd() * Math.PI * 2;
            if (cov === COVER.ROCK || cov === COVER.ALPINE) {
              if (r < 0.05) this._place(list, 'rock', x, y - 0.1, z, rot, 0.15 + rnd() * 0.3, this._tint(rnd, amb.rockTint));
              else if (r < 0.3 && cov === COVER.ALPINE) this._place(list, 'grass', x, y, z, rot, 0.8 + rnd() * 0.5, this._tint(rnd, amb.grassTuft));
              continue;
            }
            if (cov === COVER.VINEYARD || (cov === COVER.FIELD && t.stripe[k] % 8 > 2)) continue;
            const dens = rd < half + 2.4 ? 0.25 : 0.5;
            if (r < dens) {
              this._place(list, 'grass', x, y - 0.05, z, rot, 0.8 + rnd() * 0.7, this._tint(rnd, amb.grassTuft));
            } else if (r < dens + P.flowers * (cov === COVER.MEADOW ? 0.45 : 0.12)) {
              this._place(list, 'flowers', x, y - 0.02, z, rot, 0.9 + rnd() * 0.5, this._tint(rnd, amb.flowers, 0.05));
            } else if (r < dens + 0.5 && rd > half + 2.4 && rnd() < 0.03) {
              this._place(list, 'rock', x, y - 0.1, z, rot, 0.15 + rnd() * 0.35, this._tint(rnd, amb.rockTint));
            }
          }
        }
      }
      if (t.rowCrop) this._buildRows(t, list, ['lavender', 'sunflower']);
      if (t.pumpkins) {
        for (let z = t.z0 + 1; z < t.z0 + this.S; z += 3.2) {
          for (let x = t.x0 + 1; x < t.x0 + this.S; x += 3.2) {
            const jx = (rnd() - 0.5) * 2.5, jz = (rnd() - 0.5) * 2.5, r = rnd();
            const k = this._vIndex(t, x + jx, z + jz);
            if (t.stripe[k] % 8 !== STRIPE.PUMPKIN || r > 0.4) continue;
            this._place(list, 'pumpkin', x + jx, this._hAt(t, x + jx, z + jz) - 0.05, z + jz, rnd() * 6.28, 0.8 + rnd() * 0.6, this._tint(rnd, ['#f28a1e', '#e8781a', '#f5a02a'], 0.08));
          }
        }
      }
      return list;
    }
  }

  TileManager.QUALITY = QUALITY;
  B3D.TileManager = TileManager;
})(typeof window !== 'undefined' ? window : globalThis);
