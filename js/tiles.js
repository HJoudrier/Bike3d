/* Bike3D — terrain par tuiles chargées autour du joueur, avec végétation instanciée. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { clamp, mulberry32, hash2 } = B3D.util;
  const COVER = B3D.Landscape.COVER;

  const QUALITY = {
    low: { tile: 120, seg: 24, radius: 480, veg: 300, vegNear: 150, detail: 90, treeStep: 8.5, pixelRatio: 1, shadow: 1024, treeShadows: false, caps: 0.45 },
    medium: { tile: 120, seg: 30, radius: 660, veg: 430, vegNear: 210, detail: 120, treeStep: 7, pixelRatio: 1.5, shadow: 2048, treeShadows: false, caps: 0.8 },
    high: { tile: 120, seg: 40, radius: 860, veg: 580, vegNear: 290, detail: 160, treeStep: 6.5, pixelRatio: 2, shadow: 2048, treeShadows: true, caps: 1.3 }
  };

  const POOLS = [
    { name: 'conifer', cap: 17000, outline: true, sway: 0.0015, shadow: true },
    { name: 'deciduous', cap: 15000, outline: true, sway: 0.0012, shadow: true },
    { name: 'poplar', cap: 3000, outline: true, sway: 0.0012, shadow: true },
    { name: 'bush', cap: 8000, outline: true, sway: 0.004 },
    { name: 'rock', cap: 5000, outline: true },
    { name: 'hay', cap: 1500, outline: true },
    { name: 'cow', cap: 600, outline: true },
    { name: 'spectator', cap: 1500, outline: true, bounce: 0.28, outlineWidth: 0.8 },
    { name: 'grass', cap: 16000, outline: false, sway: 0.08 },
    { name: 'flowers', cap: 9000, outline: false, sway: 0.15 }
  ];

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
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying float vUpN;')
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvUpN = normal.y;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', [
            '#include <common>',
            'varying vec3 vWPos;',
            'varying float vUpN;',
            'float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
            'float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);',
            '  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }'
          ].join('\n'))
          .replace('#include <color_fragment>', [
            '#include <color_fragment>',
            'float gN = vnoise(vWPos.xz * 0.35) * 0.6 + vnoise(vWPos.xz * 1.7) * 0.4;',
            'float fade = clamp(1.0 - length(vWPos - cameraPosition) / 260.0, 0.0, 1.0);',
            'diffuseColor.rgb *= 1.0 + (gN - 0.5) * 0.16 * fade;',
            // strates horizontales sur les parois raides (falaises)
            'float steep = smoothstep(0.78, 0.5, vUpN);',
            'float band = fract(vWPos.y / 4.5 + vnoise(vWPos.xz * 0.05) * 1.5);',
            'diffuseColor.rgb *= 1.0 - steep * (step(0.62, band) * 0.17 + step(0.93, band) * 0.12);'
          ].join('\n'));
      };
      m.customProgramCacheKey = () => 'terrain-grain';
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
      this.index = new THREE.BufferAttribute(idx, 1);
    }

    _createPools() {
      const geos = B3D.props.geometries();
      this.pools = {};
      for (const p of POOLS) {
        const cap = Math.round(p.cap * this.Q.caps);
        this.pools[p.name] = new B3D.props.InstancePool(this.scene, geos[p.name], {
          capacity: cap, outline: p.outline, sway: p.sway, bounce: p.bounce, outlineWidth: p.outlineWidth,
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
        else if (t.veg && t.d > Q.veg + 80) { this._releaseList(t.veg); t.veg = null; }
        else if (t.veg && lvl !== t.vegLevel && Math.abs(t.d - Q.vegNear) > 25) {
          this._releaseList(t.veg);
          t.veg = this._buildVeg(t, lvl);
          t.vegLevel = lvl;
        }
        if (!t.details && t.d < Q.detail && t.nearRoad) { t.details = this._buildDetails(t); }
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
      const lakeRn = new Float32Array(cnt), under = new Uint8Array(cnt);
      const o = this._o;
      let nearRoad = false;
      for (let j = 0; j < NB; j++) {
        for (let i = 0; i < NB; i++) {
          const x = x0 + (i - 1) * step, z = z0 + (j - 1) * step;
          L.sample(x, z, o);
          H[j * NB + i] = o.h;
          if (i >= 1 && j >= 1 && i <= V && j <= V) {
            const k = (j - 1) * V + (i - 1);
            roadD[k] = o.roadD; dr[k] = o.dr; rw[k] = o.rw; wl[k] = o.wl; lakeRn[k] = o.lakeRn; under[k] = o.under ? 1 : 0;
            if (o.roadD < 40) nearRoad = true;
          }
        }
      }
      const pos = new Float32Array(cnt * 3), nor = new Float32Array(cnt * 3), col = new Float32Array(cnt * 3);
      const cover = new Uint8Array(cnt), crop = new Uint8Array(cnt), slopeA = new Float32Array(cnt);
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
          oc.h = h; oc.roadD = roadD[k]; oc.dr = dr[k]; oc.rw = rw[k]; oc.wl = wl[k]; oc.lakeRn = lakeRn[k]; oc.under = !!under[k];
          L.cover(x0 + i * step, z0 + j * step, oc, slope, _c);
          cover[k] = oc.cover; crop[k] = oc.crop;
          col[k * 3] = _c.r; col[k * 3 + 1] = _c.g; col[k * 3 + 2] = _c.b;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(this.index);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.position.set(x0, 0, z0);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      return { tx, tz, x0, z0, mesh, H, NB, V, cover, crop, slope: slopeA, roadD, dr, rw, under, lakeRn, nearRoad, veg: null, details: null, d: 0 };
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
      const L = this.L, P = L.P, amb = L.amb, half = L.roadHalf;
      const list = [];
      const st = this.Q.treeStep;
      const n = Math.floor(this.S / st);
      for (let gj = 0; gj < n; gj++) {
        for (let gi = 0; gi < n; gi++) {
          // générateur propre à chaque emplacement : le résultat ne dépend pas des emplacements voisins
          const rnd = mulberry32((hash2(t.tx * 64 + gi, t.tz * 64 + gj, L.seed) * 4294967296) >>> 0);
          const x = t.x0 + (gi + 0.15 + rnd() * 0.7) * st;
          const z = t.z0 + (gj + 0.15 + rnd() * 0.7) * st;
          const r = rnd();
          const k = this._vIndex(t, x, z);
          if (t.under[k] || t.lakeRn[k] < 1.2) continue;
          const rd = this._roadDAt(t, x, z);
          if (rd < half + 3.2) continue;
          const cov = t.cover[k];
          const slope = t.slope[k];
          const y = this._hAt(t, x, z);
          const rot = rnd() * Math.PI * 2;
          const sc = 0.8 + rnd() * 0.6;
          const nearRiver = t.dr[k] < t.rw[k] + 16 && t.dr[k] > t.rw[k] + 3;
          if (nearRiver && r < 0.14) {
            this._place(list, 'poplar', x, y - 0.2, z, rot, sc, this._tint(rnd, amb.poplar));
            continue;
          }
          switch (cov) {
            case COVER.FOREST: {
              // au loin, un arbre sur deux (choix stable, indépendant de la séquence aléatoire)
              const far = lvl === 1;
              if (far && hash2(t.tx * 64 + gi, t.tz * 64 + gj, L.seed + 5) < 0.45) break;
              if (r < 0.88) {
                const conif = y > 1050 + 250 * L.noiseC.noise(x / 300, z / 300) || rnd() < 0.18;
                if (conif) this._place(list, 'conifer', x, y - 0.3, z, rot, sc * 1.1, this._tint(rnd, amb.conifer), 1, 1 + rnd() * 0.25, (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.06);
                else this._place(list, 'deciduous', x, y - 0.3, z, rot, sc, this._tint(rnd, amb.decid));
              } else if (r < 0.93) {
                this._place(list, 'bush', x, y - 0.1, z, rot, sc, this._tint(rnd, amb.bush));
              }
              break;
            }
            case COVER.MEADOW: {
              let acc = P.meadowTrees;
              if (r < acc) {
                if (y > 1200) this._place(list, 'conifer', x, y - 0.3, z, rot, sc, this._tint(rnd, amb.conifer));
                else this._place(list, 'deciduous', x, y - 0.3, z, rot, sc * 1.1, this._tint(rnd, amb.decid));
              } else if (r < (acc += 0.02)) {
                this._place(list, 'bush', x, y - 0.1, z, rot, sc, this._tint(rnd, amb.bush));
              } else if (r < (acc += P.cows) && slope < 0.35) {
                this._place(list, 'cow', x, y, z, rot, 1.0, null);
              } else if (r < (acc += 0.006 * P.rockiness)) {
                this._place(list, 'rock', x, y - 0.2, z, rot, 0.5 + rnd() * 1.2, this._tint(rnd, amb.rockTint), 1, 0.7 + rnd() * 0.5);
              }
              break;
            }
            case COVER.HEDGE: {
              if (r < 0.5) this._place(list, 'bush', x, y - 0.1, z, rot, sc * 1.1, this._tint(rnd, amb.bush));
              else if (r < 0.62) this._place(list, 'deciduous', x, y - 0.3, z, rot, sc, this._tint(rnd, amb.decid));
              break;
            }
            case COVER.FIELD: {
              if (L.cropHay[t.crop[k]] && r < 0.03) {
                this._place(list, 'hay', x, y, z, rot, 0.9 + rnd() * 0.2, this._tint(rnd, ['#e9cf6a', '#dcc060'], 0.08));
              }
              break;
            }
            case COVER.ALPINE: {
              if (r < 0.05 * P.rockiness) this._place(list, 'rock', x, y - 0.3, z, rot, 0.6 + rnd() * 1.6, this._tint(rnd, amb.rockTint), 1, 0.6 + rnd() * 0.6);
              else if (r < 0.07) this._place(list, 'conifer', x, y - 0.3, z, rot, sc * 0.7, this._tint(rnd, amb.conifer));
              else if (r < 0.07 + P.cows * 1.5 && slope < 0.4) this._place(list, 'cow', x, y, z, rot, 1.0, null);
              break;
            }
            case COVER.ROCK: {
              // blocs rocheux à flanc de falaise
              if (r < 0.16) this._place(list, 'rock', x, y - 0.8, z, rot, 1.2 + rnd() * 2.6, this._tint(rnd, amb.rockTint), 1, 0.7 + rnd() * 0.6, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5);
              else if (r < 0.19 && slope < 1.2) this._place(list, 'conifer', x, y - 0.3, z, rot, sc * 0.8, this._tint(rnd, amb.conifer));
              break;
            }
            default: break;
          }
        }
      }
      return list;
    }

    // Petits détails près de la route : touffes d'herbe, fleurs, cailloux.
    _buildDetails(t) {
      const L = this.L, P = L.P, amb = L.amb, half = L.roadHalf;
      const rnd = mulberry32((hash2(t.tx, t.tz, L.seed + 999) * 4294967296) >>> 0);
      const list = [];
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
      return list;
    }
  }

  TileManager.QUALITY = QUALITY;
  B3D.TileManager = TileManager;
})(typeof window !== 'undefined' ? window : globalThis);
