/* Bike3D — génération procédurale du paysage autour de la route :
   relief, falaises, rivières, lacs, occupation du sol (prés, champs, forêts, alpages, neige). */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { clamp, lerp, smoothstep, mulberry32, Noise2D, voronoi } = B3D.util;

  const G = 32; // pas de la grille du champ d'altitude de base (m)
  const BLK = 32; // cellules par bloc du cache
  const SIGMA = 170; // portée du lissage de l'altitude de la route (m)
  const RIVER_CELL = 64;
  const RIVER_MARGIN = 80;

  const COVER = { SHOULDER: 0, MEADOW: 1, FOREST: 2, FIELD: 3, ROCK: 4, ALPINE: 5, SNOW: 6, SAND: 7, BED: 8, HEDGE: 9 };

  const COL_NAMES = ['des Marmottes', 'de la Tartiflette', 'du Grand Fromage', 'des Myrtilles', 'du Chamois Rieur',
    'de la Raclette', 'des Edelweiss', 'du Bouquetin', 'des Nuages', 'de la Crème Brûlée', 'du Vent Fou',
    'des Sapins Bleus', "de l'Aigle Royal", 'du Mollet Dur', 'de la Fondue', 'des Pédaleurs', 'du Bidon Perdu', 'des Cloches'];
  const COTE_NAMES = ['des Coquelicots', 'du Moulin', 'des Vaches', 'du Clocher', 'des Tournesols', 'de la Boulangerie',
    'du Pique-Nique', 'des Escargots', 'du Facteur', 'des Lavandes', 'du Lavoir'];

  function key(cx, cz) { return (cx + 32768) * 65536 + (cz + 32768); }

  class Landscape {
    constructor(route, seed) {
      this.route = route;
      this.seed = seed >>> 0;
      const rnd = this.rnd = mulberry32(Math.imul(this.seed ^ 0x9E3779B9, 0x85EBCA6B) ^ 0x27d4eb2d);
      rnd(); rnd();
      this.amb = rnd.pick(B3D.ambiances);
      this.noise = new Noise2D(this.seed ^ 0x1234567);
      this.noiseB = new Noise2D(this.seed ^ 0x0badf00);
      this.noiseC = new Noise2D(this.seed ^ 0x5eed5eed);
      this.ox = rnd.range(-20000, 20000);
      this.oz = rnd.range(-20000, 20000);
      this.roadHalf = 3.0;

      const P = this.P = {
        mountainAmp: rnd.range(300, 650),
        hillAmp: rnd.range(5, 17),
        forestThr: rnd.range(-0.2, 0.32),
        fieldThr: rnd.range(-0.12, 0.3),
        fieldCell: rnd.range(95, 170),
        fieldAngle: rnd.range(0, Math.PI),
        fieldMaxAlt: rnd.range(850, 1300),
        treeLine: rnd.range(1800, 2200),
        meadowTrees: rnd.range(0.008, 0.04),
        cows: rnd.range(0.0015, 0.007),
        rockiness: rnd.range(0.6, 1.4),
        riverHalf: rnd.range(5, 8.5),
        planeTrees: rnd.range(0, 1),
        flowers: rnd.range(0.2, 0.7)
      };
      P.snowLine = P.treeLine + rnd.range(450, 800);
      const fa = P.fieldAngle;
      this._fc = Math.cos(fa); this._fs = Math.sin(fa);

      // Couleurs de la palette converties (espace linéaire)
      const C = (h) => new THREE.Color(h);
      const a = this.amb;
      this.col = {
        grass: a.grass.map(C), meadow: C(a.meadow), forest: C(a.forestFloor), alpine: C(a.alpine),
        rock: C(a.rock), rockDark: C(a.rockDark), snow: C(a.snow), sand: C(a.sand), dirt: C(a.dirt),
        bed: C(a.sand).lerp(C('#3f7f74'), 0.55), hedge: C(a.forestFloor).lerp(C('#2f6a2c'), 0.4),
        crops: a.crops.map((c) => C(c[0]))
      };
      let tw = 0;
      this.cropCum = a.crops.map((c) => (tw += c[1]));
      this.cropTotal = tw;
      this.cropHay = a.crops.map((c) => {
        const hsl = {};
        C(c[0]).getHSL(hsl);
        return hsl.h > 0.09 && hsl.h < 0.17 && hsl.s > 0.45;
      });

      this.blocks = new Map();
      this._br = { b: new Int32Array(8), d: new Float64Array(8), y: new Float64Array(8), i: new Int32Array(8) };
      this._tmp = {};
      this._vor = {};

      this._computeMountainness();
      this._planRivers();
      this._buildBridgeMask();
      this._planLakes();
      this._planRoadside();
      this._nameClimbs();
    }

    // ---------------------------------------------------------------- champ de base
    _computeMountainness() {
      const R = this.route, ci = R.coarse, n = ci.length;
      const span = Math.round(1500 / (R.spacing * 4));
      this.cY = new Float64Array(n);
      this.cM = new Float64Array(n);
      for (let k = 0; k < n; k++) this.cY[k] = R.y[ci[k]];
      for (let k = 0; k < n; k++) {
        let mn = Infinity, mx = -Infinity;
        for (let q = Math.max(0, k - span); q <= Math.min(n - 1, k + span); q++) {
          const e = this.cY[q];
          if (e < mn) mn = e;
          if (e > mx) mx = e;
        }
        const relief = clamp((mx - mn) / 380, 0, 1);
        const alt = smoothstep(250, 1600, this.cY[k]);
        this.cM[k] = clamp(Math.max(relief, alt * 0.9), 0.1, 1);
      }
      // index des échantillons grossiers -> position dans cY
      this.cIndex = new Map();
      for (let k = 0; k < n; k++) this.cIndex.set(ci[k], k);
    }

    _computeCell(px, pz, out, o) {
      const R = this.route, CC = R.coarseCell, cells = R.coarseCells, X = R.x, Z = R.z;
      const cx = Math.floor(px / CC), cz = Math.floor(pz / CC);
      let dmin2 = Infinity;
      for (let r = 0; r < 80; r++) {
        for (let ix = cx - r; ix <= cx + r; ix++) {
          for (let iz = cz - r; iz <= cz + r; iz++) {
            if (Math.max(Math.abs(ix - cx), Math.abs(iz - cz)) !== r) continue;
            const arr = cells.get(key(ix, iz));
            if (!arr) continue;
            for (let k = 0; k < arr.length; k++) {
              const i = arr[k];
              const dx = X[i] - px, dz = Z[i] - pz;
              const d2 = dx * dx + dz * dz;
              if (d2 < dmin2) dmin2 = d2;
            }
          }
        }
        if (dmin2 < Infinity && r * CC > Math.sqrt(dmin2)) break;
      }
      if (dmin2 === Infinity) {
        for (let k = 0; k < R.coarse.length; k++) {
          const i = R.coarse[k];
          const d2 = (X[i] - px) * (X[i] - px) + (Z[i] - pz) * (Z[i] - pz);
          if (d2 < dmin2) dmin2 = d2;
        }
      }
      const dmin = Math.sqrt(dmin2);
      const rad = dmin + 3 * SIGMA;
      const rc = Math.ceil(rad / CC) + 1;
      // Ajustement pondéré d'un plan local (y = a + b.dx + c.dz) sur les altitudes de la route :
      // les lacets s'inscrivent ainsi dans un versant au lieu d'une moyenne "plate".
      let S = 0, Sx = 0, Sz = 0, Sxx = 0, Szz = 0, Sxz = 0, Sy = 0, Sxy = 0, Szy = 0, sm = 0;
      const inv = 1 / SIGMA;
      for (let ix = cx - rc; ix <= cx + rc; ix++) {
        for (let iz = cz - rc; iz <= cz + rc; iz++) {
          const arr = cells.get(key(ix, iz));
          if (!arr) continue;
          for (let k = 0; k < arr.length; k++) {
            const i = arr[k];
            const dx = X[i] - px, dz = Z[i] - pz;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d > rad) continue;
            const e = (d - dmin) * inv;
            const w = Math.exp(-0.5 * e * e);
            const c = this.cIndex.get(i);
            const y = this.cY[c];
            S += w; Sx += w * dx; Sz += w * dz; Sxx += w * dx * dx; Szz += w * dz * dz; Sxz += w * dx * dz;
            Sy += w * y; Sxy += w * dx * y; Szy += w * dz * y;
            sm += w * this.cM[c];
          }
        }
      }
      // régularisation : pentes amorties quand les points sont peu étalés
      const Lr = S * 60 * 60;
      const a11 = S, a12 = Sx, a13 = Sz, a22 = Sxx + Lr, a23 = Sxz, a33 = Szz + Lr;
      const det = a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13);
      let bS = 0, cS = 0;
      if (Math.abs(det) > 1e-9) {
        bS = (a11 * (Sxy * a33 - a23 * Szy) - Sy * (a12 * a33 - a23 * a13) + a13 * (a12 * Szy - Sxy * a13)) / det;
        cS = (a11 * (a22 * Szy - Sxy * a23) - a12 * (a12 * Szy - Sxy * a13) + Sy * (a12 * a23 - a22 * a13)) / det;
        const g = Math.hypot(bS, cS);
        if (g > 0.45) { bS *= 0.45 / g; cS *= 0.45 / g; }
      }
      out[o] = (Sy - bS * Sx - cS * Sz) / S;
      out[o + 1] = sm / S;
      out[o + 2] = dmin;
    }

    _cell(ix, iz) {
      const bx = Math.floor(ix / BLK), bz = Math.floor(iz / BLK);
      const k = key(bx, bz);
      let blk = this.blocks.get(k);
      if (!blk) {
        blk = new Float32Array(BLK * BLK * 3).fill(NaN);
        this.blocks.set(k, blk);
      }
      const o = ((ix - bx * BLK) * BLK + (iz - bz * BLK)) * 3;
      if (blk[o] !== blk[o]) this._computeCell(ix * G, iz * G, blk, o);
      this._cb = blk; this._co = o;
      return blk;
    }

    // Altitude de base B, "montagnitude" M et distance approximative D à la route.
    base(x, z, out) {
      const fx = x / G, fz = z / G;
      const ix = Math.floor(fx), iz = Math.floor(fz);
      const tx = fx - ix, tz = fz - iz;
      let b, o;
      b = this._cell(ix, iz); o = this._co;
      const b00 = b[o], m00 = b[o + 1], d00 = b[o + 2];
      b = this._cell(ix + 1, iz); o = this._co;
      const b10 = b[o], m10 = b[o + 1], d10 = b[o + 2];
      b = this._cell(ix, iz + 1); o = this._co;
      const b01 = b[o], m01 = b[o + 1], d01 = b[o + 2];
      b = this._cell(ix + 1, iz + 1); o = this._co;
      const b11 = b[o], m11 = b[o + 1], d11 = b[o + 2];
      const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
      out.B = b00 * w00 + b10 * w10 + b01 * w01 + b11 * w11;
      out.M = m00 * w00 + m10 * w10 + m01 * w01 + m11 * w11;
      out.D = d00 * w00 + d10 * w10 + d01 * w01 + d11 * w11;
      return out;
    }

    // Relief "naturel" (sans route, rivières ni lacs).
    natural(x, z, o) {
      this.base(x, z, o);
      const P = this.P, M = o.M, D = o.D;
      const X = x + this.ox, Z = z + this.oz;
      let h = o.B;
      const M2 = M * M;
      if (M2 > 0.012) {
        const wt = smoothstep(30, 1100, D);
        if (wt > 0) {
          const mtn = 0.6 * this.noise.ridged(X / 1100, Z / 1100, 3) / 0.45 + 0.4 * (0.5 + 0.5 * this.noiseC.fbm(X / 650, Z / 650, 3));
          h += M2 * P.mountainAmp * Math.pow(wt, 1.2) * (0.3 + 0.9 * mtn);
        }
      }
      const hillT = smoothstep(5, 90, D);
      if (hillT > 0) h += this.noise.fbm(X / 300, Z / 300, 3) * (P.hillAmp + 16 * M) * hillT;
      const detT = smoothstep(4, 22, D);
      if (detT > 0) h += this.noiseB.noise(X / 45, Z / 45) * (0.6 + 2.4 * M) * detT;
      o.hNat = h;
      return h;
    }

    // Échantillon complet : altitude finale + infos route / eau pour la couverture du sol.
    sample(x, z, o) {
      let h = this.natural(x, z, o);
      o.dr = 1e9; o.wl = 0; o.rw = 0; o.lakeRn = 9; o.lakeLevel = 0; o.waterLevel = -1e9;

      // --- Rivières
      if (this.riverCells) {
        const arr = this.riverCells.get(key(Math.floor(x / RIVER_CELL), Math.floor(z / RIVER_CELL)));
        if (arr) {
          const RS = this.riverSegs;
          let best = 1e9, bwl = 0, brw = 0;
          for (let k = 0; k < arr.length; k++) {
            const s = arr[k];
            const rv = RS[s * 2], i = RS[s * 2 + 1];
            const rx = this.rivers[rv].x, rz = this.rivers[rv].z;
            const ax = rx[i], az = rz[i];
            const bx = rx[i + 1] - ax, bz = rz[i + 1] - az;
            const l2 = bx * bx + bz * bz || 1e-9;
            let t = ((x - ax) * bx + (z - az) * bz) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + bx * t - x, pz = az + bz * t - z;
            const d = Math.sqrt(px * px + pz * pz);
            if (d < best) {
              best = d;
              const wl = this.rivers[rv].wl, rw = this.rivers[rv].rw;
              bwl = wl[i] + (wl[i + 1] - wl[i]) * t;
              brw = rw[i] + (rw[i + 1] - rw[i]) * t;
            }
          }
          if (best < 1e9) {
            o.dr = best; o.wl = bwl; o.rw = brw;
            const rw = brw;
            const bankW = 13 + 0.55 * Math.max(0, h - bwl);
            if (best < rw + 2 + bankW) {
              let hr;
              if (best <= rw) hr = bwl - 0.35 - 1.8 * (1 - (best / rw) * (best / rw));
              else if (best <= rw + 2) hr = lerp(bwl - 0.35, bwl + 0.45, (best - rw) / 2);
              else hr = lerp(bwl + 0.45, Math.max(h, bwl + 0.45), smoothstep(rw + 2, rw + 2 + bankW, best));
              // Le fond de vallée est plus plat près de la rivière
              h = hr;
            }
            if (best < rw + 1.4) o.waterLevel = bwl;
          }
        }
      }

      // --- Lacs
      for (let k = 0; k < this.lakes.length; k++) {
        const L = this.lakes[k];
        const dx = x - L.x, dz = z - L.z;
        const r2 = dx * dx + dz * dz;
        if (r2 > L.reach2) continue;
        const r = Math.sqrt(r2);
        const ang = Math.atan2(dz, dx);
        const Rt = L.r * (1 + 0.24 * this.noiseC.noise(L.nx + Math.cos(ang) * 0.55, L.nz + Math.sin(ang) * 0.55));
        const rn = r / Rt;
        if (rn < o.lakeRn) { o.lakeRn = rn; o.lakeLevel = L.level; }
        let hl;
        if (rn <= 1) hl = L.level - 0.3 - L.depth * (1 - rn * rn);
        else if (rn <= 1.12) hl = lerp(L.level - 0.3, L.level + 0.35, (rn - 1) / 0.12);
        else hl = lerp(L.level + 0.35, Math.max(h, L.level + 0.35), smoothstep(1.12, 1.65, rn));
        if (rn < 1.65) h = hl;
        if (rn < 1.07) o.waterLevel = L.level;
      }

      // --- Route : on aplanit le terrain sous chaque passage (branche) de la route.
      const br = this._br;
      const nb = this.route.branches(x, z, Landscape.ROAD_REACH, br);
      o.roadD = 1e9; o.roadY = 0; o.roadI = -1;
      if (nb > 0) {
        // du plus loin au plus proche : la branche la plus proche a le dernier mot
        const order = this._order || (this._order = new Int32Array(8));
        for (let q = 0; q < nb; q++) order[q] = q;
        for (let q = 1; q < nb; q++) {
          const v = order[q];
          let j = q - 1;
          while (j >= 0 && br.d[order[j]] < br.d[v]) { order[j + 1] = order[j]; j--; }
          order[j + 1] = v;
        }
        const half = this.roadHalf;
        for (let q = 0; q < nb; q++) {
          const k = order[q];
          const d = br.d[k], yk = br.y[k];
          if (d < o.roadD) { o.roadD = d; o.roadY = yk; o.roadI = br.i[k]; }
          if (this.bridgeMask[br.i[k]] && o.dr < o.rw + 3) continue; // pont : la rivière passe dessous
          const flat = yk - 0.12;
          const delta = Math.abs(h - flat);
          const inner = half + 2.0;
          const T = 3.5 + Math.min(delta * 0.42, 15);
          const w = 1 - smoothstep(inner, inner + T, d);
          if (w > 0) h = h + (flat - h) * w;
        }
      }
      o.h = h;
      o.under = o.waterLevel > h + 0.02;
      return o;
    }

    heightAt(x, z) { return this.sample(x, z, this._tmp).h; }

    // ---------------------------------------------------------------- couverture du sol
    // Calcule o.cover, o.crop et la couleur (dans col) à partir d'un échantillon et de la pente.
    cover(x, z, o, slope, col) {
      const P = this.P, C = this.col;
      const X = x + this.ox, Z = z + this.oz;
      const a = o.h;
      o.crop = 255;
      const half = this.roadHalf;

      if (o.roadD < half + 1.6) {
        o.cover = COVER.SHOULDER;
        col.copy(C.dirt).lerp(C.grass[0], clamp((o.roadD - half) / 1.6, 0, 1) * 0.55);
        return;
      }
      if (o.under) {
        o.cover = COVER.BED; col.copy(C.bed); return;
      }
      const nearWater = (o.lakeRn < 1.2) || (o.dr < o.rw + 3.2 && a < o.wl + 1.3);
      if (nearWater) {
        o.cover = COVER.SAND; col.copy(C.sand); return;
      }

      // couleur végétale de base
      const gn = this.noiseB.noise(X / 70, Z / 70);
      col.copy(C.grass[0]).lerp(C.grass[1], gn * 0.5 + 0.5);
      let cover = COVER.MEADOW;

      const treeL = P.treeLine + 110 * this.noiseC.noise(X / 260, Z / 260);
      if (a > treeL) {
        cover = COVER.ALPINE;
        col.copy(C.alpine).lerp(C.grass[2], clamp((treeL + 120 - a) / 120, 0, 1) * 0.5);
      } else {
        // Champs : décision par parcelle (cellule de Voronoï) pour garder des parcelles entières.
        let isField = false;
        if (a < P.fieldMaxAlt && slope < 0.35 && o.dr > o.rw + 14 && o.roadD > half + 3 && o.lakeRn > 1.3) {
          const u = x * this._fc + z * this._fs, v = (-x * this._fs + z * this._fc) * 1.6;
          const vr = voronoi(u, v, P.fieldCell, this.seed + 17, this._vor);
          const agri = this.noiseB.fbm(vr.cx / 900 + 33.3, vr.cy / 900 - 12.1, 2);
          if (agri > P.fieldThr) {
            isField = true;
            if (vr.d2 - vr.d1 < 3.2) {
              cover = COVER.HEDGE;
              col.copy(C.hedge);
            } else {
              const hsh = (Math.imul(vr.id, 0x9E3779B1) >>> 0) / 4294967296;
              const target = hsh * this.cropTotal;
              let ci = 0;
              while (ci < this.cropCum.length - 1 && this.cropCum[ci] < target) ci++;
              cover = COVER.FIELD;
              o.crop = ci;
              col.copy(C.crops[ci]);
            }
          }
        }
        if (!isField) {
          let forest = this.noiseC.fbm(X / 520, Z / 520, 3) + 0.28 * this.noiseC.noise(X / 110, Z / 110);
          if (a > 1000) forest += 0.12;
          forest += clamp(slope - 0.3, 0, 0.4) * 0.5;
          if (forest > P.forestThr + 0.22) {
            cover = COVER.FOREST;
            col.lerp(C.forest, clamp((forest - P.forestThr - 0.22) * 6, 0.55, 1));
          } else {
            const fl = this.noiseB.noise(X / 28, Z / 28);
            if (fl > 0.35) col.lerp(C.meadow, 0.6);
          }
        }
      }

      // falaises / rochers selon la pente
      const rn = this.noiseC.noise(X / 34, Z / 34);
      const rockSlope = 1.08 - 0.22 * rn * P.rockiness;
      if (slope > rockSlope - 0.25) {
        const t = smoothstep(rockSlope - 0.25, rockSlope, slope);
        const rc = this._rc || (this._rc = new THREE.Color());
        rc.copy(C.rock).lerp(C.rockDark, clamp(0.5 + 0.5 * this.noiseB.noise(X / 9, Z / 9), 0, 1) * 0.7);
        col.lerp(rc, t);
        if (t > 0.5) cover = COVER.ROCK;
      } else if (cover === COVER.ALPINE && rn > 0.45 && slope > 0.3) {
        col.lerp(C.rock, 0.65);
        cover = COVER.ROCK;
      }

      // neige
      const snowL = P.snowLine + 130 * this.noiseC.noise(X / 210, Z / 210);
      if (a > snowL - 40 && slope < 1.5) {
        const t = smoothstep(snowL - 40, snowL + 20, a) * (1 - smoothstep(1.1, 1.5, slope));
        col.lerp(C.snow, t);
        if (t > 0.5) cover = COVER.SNOW;
      }
      o.cover = cover;
    }

    // ---------------------------------------------------------------- rivières
    _planRivers() {
      const R = this.route, rnd = this.rnd, P = this.P;
      this.rivers = [];
      const want = rnd() < 0.78 ? (rnd() < 0.35 ? 2 : 1) : 0;
      this.riverCells = null;
      if (want === 0) return;

      // Tronçons peu pentus (fond de vallée)
      const win = 20;
      let intervals = [];
      for (const thr of [0.035, 0.055, 0.075]) {
        intervals = [];
        let a = -1;
        for (let i = R.iStart; i <= R.iEnd; i++) {
          const g = Math.abs(R.y[Math.min(R.n - 1, i + win)] - R.y[Math.max(0, i - win)]) / (2 * win * R.spacing);
          const ok = g < thr;
          if (ok && a < 0) a = i;
          if ((!ok || i === R.iEnd) && a >= 0) {
            if (i - a >= 900 / R.spacing) intervals.push([a, i]);
            a = -1;
          }
        }
        if (intervals.length) break;
      }
      if (!intervals.length) return;
      intervals.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
      const chosen = intervals.slice(0, want);
      for (const iv of chosen) {
        // Rivière limitée à ~5 km de route accompagnée
        let a = iv[0], b = iv[1];
        const maxLen = Math.round(5000 / R.spacing);
        if (b - a > maxLen) {
          const st = a + Math.floor(rnd() * (b - a - maxLen));
          a = st; b = st + maxLen;
        }
        const rv = this._buildRiver(a, b);
        if (rv) this.rivers.push(rv);
      }
      this._indexRivers();
    }

    _buildRiver(a, b) {
      const R = this.route, rnd = this.rnd, P = this.P;
      const step = 4;
      const sideBias = rnd.chance(0.5) ? 1 : -1;
      const crossing = rnd.chance(0.7);
      const phase = rnd.range(0, 1000);
      let xs = [], zs = [], wls = [];
      for (let i = a; i <= b; i += step) {
        const s = i * R.spacing;
        let nv = clamp(this.noiseB.noise(s / 2600 + phase, 3.7) + sideBias * 0.3, -1, 1);
        if (!crossing) nv = sideBias * (0.2 + 0.8 * Math.abs(nv));
        const off = (nv >= 0 ? 1 : -1) * (30 + 65 * Math.pow(Math.abs(nv), 0.8)) + 18 * this.noiseC.noise(s / 320 + phase, 1.3);
        const rx = -R.tz[i], rz = R.tx[i];
        xs.push(R.x[i] + rx * off);
        zs.push(R.z[i] + rz * off);
        wls.push(R.y[i] - 2.2 - 1.0 * Math.abs(nv));
      }
      if (xs.length < 4) return null;
      // Prolongements : la rivière s'éloigne de la route aux deux bouts.
      const extend = (fromStart) => {
        const n = xs.length;
        const i0 = fromStart ? 0 : n - 1, i1 = fromStart ? 1 : n - 2;
        let dx = xs[i0] - xs[i1], dz = zs[i0] - zs[i1];
        const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        // côté de la route où se trouve la rivière à ce bout
        const ri = fromStart ? a : b;
        const side = ((xs[i0] - R.x[ri]) * (-R.tz[ri]) + (zs[i0] - R.z[ri]) * R.tx[ri]) >= 0 ? 1 : -1;
        let ang = Math.atan2(dx, dz);
        // tourner vers l'extérieur (côté de la rivière)
        const outward = Math.atan2(-R.tz[ri] * side, R.tx[ri] * side);
        let diff = outward - ang;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const px = [], pz = [], pw = [];
        let x = xs[i0], z = zs[i0];
        const w0 = wls[i0];
        for (let k = 1; k <= 40; k++) {
          if (k <= 8) ang += diff * 0.09;
          else ang += (rnd() - 0.5) * 0.18;
          x += Math.sin(ang) * 20; z += Math.cos(ang) * 20;
          px.push(x); pz.push(z); pw.push(w0);
        }
        return { px, pz, pw };
      };
      const e0 = extend(true), e1 = extend(false);
      xs = e0.px.slice().reverse().concat(xs, e1.px);
      zs = e0.pz.slice().reverse().concat(zs, e1.pz);
      wls = e0.pw.slice().reverse().concat(wls, e1.pw);
      const nE = e0.px.length;
      // Sens d'écoulement : de l'extrémité la plus haute vers la plus basse.
      if (wls[nE] < wls[wls.length - 1 - nE]) { xs.reverse(); zs.reverse(); wls.reverse(); }
      const n = xs.length;
      for (let k = 0; k < nE; k++) {
        wls[k] += 0.012 * 20 * (nE - k); // amont : remonte doucement
        wls[n - 1 - k] -= 0.008 * 20 * (nE - k); // aval : descend
      }

      // Lissage du tracé + écartement de la route hors des traversées
      const smooth = (arr, sig) => {
        const out = arr.slice();
        const r = Math.ceil(sig * 3);
        for (let i = 0; i < arr.length; i++) {
          let s = 0, ws = 0;
          for (let k = -r; k <= r; k++) {
            const j = i + k;
            if (j < 0 || j >= arr.length) continue;
            const w = Math.exp(-(k * k) / (2 * sig * sig));
            s += arr[j] * w; ws += w;
          }
          out[i] = s / ws;
        }
        return out;
      };
      let X = smooth(xs, 1.4), Z = smooth(zs, 1.4);
      const tmp = {};
      const rwArr = new Float64Array(n);
      for (let i = 0; i < n; i++) rwArr[i] = P.riverHalf * (0.85 + 0.3 * (0.5 + 0.5 * this.noiseC.noise(i * 0.06, 7.7)));
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < n - 1; i++) {
          const near = R.nearest(X[i], Z[i], 40, tmp);
          if (near.i < 0) continue;
          const minD = rwArr[i] + 12;
          if (near.d >= minD) continue;
          // Traversée franche ? (les voisins sont de part et d'autre de la route)
          const pa = R.nearest(X[Math.max(0, i - 2)], Z[Math.max(0, i - 2)], 60, {});
          const pb = R.nearest(X[Math.min(n - 1, i + 2)], Z[Math.min(n - 1, i + 2)], 60, {});
          if (pa.i >= 0 && pb.i >= 0 && pa.side !== pb.side) continue;
          const sx = R.x[near.i] + (R.x[near.i + 1] - R.x[near.i]) * near.t;
          const sz = R.z[near.i] + (R.z[near.i + 1] - R.z[near.i]) * near.t;
          let dx = X[i] - sx, dz = Z[i] - sz;
          const l = Math.hypot(dx, dz);
          if (l < 1e-3) { dx = -R.tz[near.i] * near.side; dz = R.tx[near.i] * near.side; }
          else { dx /= l; dz /= l; }
          X[i] = sx + dx * minD; Z[i] = sz + dz * minD;
        }
        X = smooth(X, 0.8); Z = smooth(Z, 0.8);
      }

      // Niveau d'eau : sous la route quand elle est proche, puis monotone décroissant.
      const WL = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let wl = wls[i];
        const near = R.nearest(X[i], Z[i], 45, tmp);
        if (near.i >= 0 && near.d < rwArr[i] + 25) wl = Math.min(wl, near.y - 3.0);
        wl = Math.min(wl, this.natural(X[i], Z[i], tmp) - 1.2);
        WL[i] = wl;
      }
      for (let i = 1; i < n; i++) WL[i] = Math.min(WL[i], WL[i - 1]);
      return { x: Float64Array.from(X), z: Float64Array.from(Z), wl: WL, rw: rwArr, n };
    }

    _indexRivers() {
      const map = new Map();
      const segs = [];
      this.rivers.forEach((rv, r) => {
        for (let i = 0; i < rv.n - 1; i++) {
          const s = segs.length / 2;
          segs.push(r, i);
          const x0 = Math.min(rv.x[i], rv.x[i + 1]) - RIVER_MARGIN, x1 = Math.max(rv.x[i], rv.x[i + 1]) + RIVER_MARGIN;
          const z0 = Math.min(rv.z[i], rv.z[i + 1]) - RIVER_MARGIN, z1 = Math.max(rv.z[i], rv.z[i + 1]) + RIVER_MARGIN;
          for (let cx = Math.floor(x0 / RIVER_CELL); cx <= Math.floor(x1 / RIVER_CELL); cx++) {
            for (let cz = Math.floor(z0 / RIVER_CELL); cz <= Math.floor(z1 / RIVER_CELL); cz++) {
              const k = key(cx, cz);
              let arr = map.get(k);
              if (!arr) { arr = []; map.set(k, arr); }
              arr.push(s);
            }
          }
        }
      });
      this.riverSegs = Int32Array.from(segs);
      this.riverCells = this.rivers.length ? map : null;
    }

    _riverDist(x, z) {
      if (!this.riverCells) return { d: 1e9, rw: 0, wl: 0 };
      const o = { dr: 1e9, rw: 0, wl: 0 };
      const arr = this.riverCells.get(key(Math.floor(x / RIVER_CELL), Math.floor(z / RIVER_CELL)));
      if (!arr) return { d: 1e9, rw: 0, wl: 0 };
      for (const s of arr) {
        const rv = this.rivers[this.riverSegs[s * 2]], i = this.riverSegs[s * 2 + 1];
        const ax = rv.x[i], az = rv.z[i], bx = rv.x[i + 1] - ax, bz = rv.z[i + 1] - az;
        const l2 = bx * bx + bz * bz || 1e-9;
        let t = clamp(((x - ax) * bx + (z - az) * bz) / l2, 0, 1);
        const d = Math.hypot(ax + bx * t - x, az + bz * t - z);
        if (d < o.dr) { o.dr = d; o.rw = rv.rw[i]; o.wl = rv.wl[i]; }
      }
      return { d: o.dr, rw: o.rw, wl: o.wl };
    }

    _buildBridgeMask() {
      const R = this.route;
      this.bridgeMask = new Uint8Array(R.n);
      this.bridges = [];
      if (!this.riverCells) return;
      let run = -1;
      for (let i = 0; i < R.n; i++) {
        const q = this._riverDist(R.x[i], R.z[i]);
        const on = q.d < q.rw + 3.5;
        if (on) this.bridgeMask[i] = 1;
        if (on && run < 0) run = i;
        if ((!on || i === R.n - 1) && run >= 0) {
          this.bridges.push([Math.max(0, run - 2), Math.min(R.n - 1, i + 1)]);
          run = -1;
        }
      }
      // élargir légèrement le masque (culées)
      for (const [a, b] of this.bridges) for (let i = a; i <= b; i++) this.bridgeMask[i] = 1;
    }

    // ---------------------------------------------------------------- lacs
    _planLakes() {
      const R = this.route, rnd = this.rnd;
      this.lakes = [];
      let want = rnd.int(0, 3);
      want += Math.floor(R.length / 15000);
      want = Math.min(want, 6);
      const tmp = {};
      for (let attempt = 0; attempt < 80 && this.lakes.length < want; attempt++) {
        const s = R.sStart + rnd() * R.length;
        const p = R.sample(s, {});
        const side = rnd.chance(0.5) ? 1 : -1;
        const r = rnd.range(45, 150);
        const L = r * 1.25 + rnd.range(30, 170);
        const cx = p.x + p.rx * side * L, cz = p.z + p.rz * side * L;
        // Loin de la route
        const clear = r * 1.7 + 14;
        const nr = R.nearest(cx, cz, clear, tmp);
        if (nr.i >= 0 && nr.d < clear) continue;
        // Loin des autres lacs et rivières
        if (this.lakes.some((o) => Math.hypot(o.x - cx, o.z - cz) < o.r * 1.7 + r * 1.7 + 20)) continue;
        const rq = this._riverDist(cx, cz);
        if (rq.d < r * 1.7 + rq.rw + 20) continue;
        // Terrain pas trop pentu
        const b0 = this.base(cx, cz, {}).B;
        let maxDev = 0;
        for (let k = 0; k < 6; k++) {
          const ang = k / 6 * Math.PI * 2;
          const bk = this.base(cx + Math.cos(ang) * r * 1.3, cz + Math.sin(ang) * r * 1.3, {}).B;
          maxDev = Math.max(maxDev, Math.abs(bk - b0));
        }
        if (maxDev > 22) continue;
        const nearRoad = R.nearest(cx, cz, 600, {});
        let level = b0 - 2.5;
        if (nearRoad.i >= 0) level = Math.min(level, nearRoad.y - 3.5);
        this.lakes.push({
          x: cx, z: cz, r, level, depth: rnd.range(3, 7),
          nx: rnd.range(-500, 500), nz: rnd.range(-500, 500),
          reach2: (r * 1.24 * 1.7) * (r * 1.24 * 1.7)
        });
      }
    }

    // ---------------------------------------------------------------- bords de route
    _planRoadside() {
      const R = this.route, half = this.roadHalf;
      const n = R.n;
      const dropL = new Float32Array(n), dropR = new Float32Array(n);
      const o = {};
      for (let i = 0; i < n; i++) {
        const rx = -R.tz[i], rz = R.tx[i];
        const off = half + 6.5;
        dropR[i] = R.y[i] - this.sample(R.x[i] + rx * off, R.z[i] + rz * off, o).h;
        dropL[i] = R.y[i] - this.sample(R.x[i] - rx * off, R.z[i] - rz * off, o).h;
      }
      this.dropL = dropL; this.dropR = dropR;
      const rails = (drop) => {
        const m = new Uint8Array(n);
        for (let i = 0; i < n; i++) m[i] = drop[i] > 3.0 && !this.bridgeMask[i] ? 1 : 0;
        // combler les petits trous
        let last = -100;
        for (let i = 0; i < n; i++) {
          if (m[i]) {
            if (i - last > 1 && i - last <= 4) for (let k = last + 1; k < i; k++) if (!this.bridgeMask[k]) m[k] = 1;
            last = i;
          }
        }
        // supprimer les tronçons trop courts
        let a = -1;
        for (let i = 0; i <= n; i++) {
          if (i < n && m[i]) { if (a < 0) a = i; }
          else if (a >= 0) { if (i - a < 5) for (let k = a; k < i; k++) m[k] = 0; a = -1; }
        }
        return m;
      };
      this.railL = rails(dropL);
      this.railR = rails(dropR);
    }

    _nameClimbs() {
      const rnd = mulberry32(this.seed ^ 0xc0c0);
      const cols = COL_NAMES.slice(), cotes = COTE_NAMES.slice();
      this.climbNames = this.route.climbs.map((c) => {
        const big = c.cat <= 2 || c.gain > 250;
        const pool = big ? cols : cotes;
        const i = Math.floor(rnd() * pool.length);
        const nm = pool.splice(i, 1)[0] || 'Mystère';
        return (big ? 'Col ' : 'Côte ') + nm;
      });
    }

    describe() {
      const P = this.P;
      const forest = P.forestThr < -0.05 ? 'denses' : P.forestThr < 0.15 ? 'moyennes' : 'clairsemées';
      const fields = P.fieldThr < -0.1 ? 'nombreux' : P.fieldThr < 0.1 ? 'quelques-uns' : 'rares';
      const relief = P.mountainAmp > 520 ? 'spectaculaire' : P.mountainAmp > 400 ? 'marqué' : 'doux';
      return [
        { icon: '🎨', label: 'Ambiance', value: this.amb.name },
        { icon: '⛰️', label: 'Relief', value: relief },
        { icon: '🌲', label: 'Forêts', value: forest },
        { icon: '🌾', label: 'Champs', value: fields },
        { icon: '🏞️', label: 'Lacs', value: String(this.lakes.length) },
        { icon: '🌊', label: 'Rivières', value: String(this.rivers.length) + (this.bridges.length ? ' (' + this.bridges.length + ' pont' + (this.bridges.length > 1 ? 's' : '') + ')' : '') }
      ];
    }
  }

  Landscape.ROAD_REACH = 64;
  Landscape.COVER = COVER;
  B3D.Landscape = Landscape;
})(typeof window !== 'undefined' ? window : globalThis);
