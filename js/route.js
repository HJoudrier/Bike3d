/* Bike3D — conversion d'un tracé GPX en route 3D exploitable (rééchantillonnage, lissage, requêtes spatiales). */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { clamp } = B3D.util;

  const EARTH_R = 6371000;
  const DEG = Math.PI / 180;
  const EXT_LEN = 250; // prolongement virtuel de la route avant le départ et après l'arrivée (m)
  const CELL = 20; // taille des cellules de la grille spatiale des segments
  const COARSE_STEP = 4; // un échantillon grossier tous les 4 échantillons
  const COARSE_CELL = 100;

  function gaussianSmooth(src, sigma) {
    const n = src.length;
    if (sigma <= 0 || n < 3) return Float64Array.from(src);
    const r = Math.ceil(sigma * 3);
    const w = new Float64Array(2 * r + 1);
    for (let k = -r; k <= r; k++) w[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma));
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, ws = 0;
      for (let k = -r; k <= r; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        s += src[j] * w[k + r];
        ws += w[k + r];
      }
      out[i] = s / ws;
    }
    return out;
  }

  function medianFilter(src, half) {
    const n = src.length;
    const out = new Float64Array(n);
    const buf = [];
    for (let i = 0; i < n; i++) {
      buf.length = 0;
      for (let k = -half; k <= half; k++) buf.push(src[clamp(i + k, 0, n - 1)]);
      buf.sort((a, b) => a - b);
      out[i] = buf[half];
    }
    return out;
  }

  // Rééchantillonne une polyligne (x,z,y) à pas constant. Renvoie aussi le pas exact.
  function resample(xs, zs, ys, step) {
    const n = xs.length;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    const total = cum[n - 1];
    const count = Math.max(2, Math.round(total / step));
    const sp = total / count;
    const ox = new Float64Array(count + 1), oz = new Float64Array(count + 1), oy = new Float64Array(count + 1);
    let j = 0;
    for (let k = 0; k <= count; k++) {
      const s = Math.min(k * sp, total);
      while (j < n - 2 && cum[j + 1] < s) j++;
      const segLen = cum[j + 1] - cum[j];
      const f = segLen > 1e-9 ? (s - cum[j]) / segLen : 0;
      ox[k] = xs[j] + (xs[j + 1] - xs[j]) * f;
      oz[k] = zs[j] + (zs[j + 1] - zs[j]) * f;
      oy[k] = ys[j] + (ys[j + 1] - ys[j]) * f;
    }
    return { x: ox, z: oz, y: oy, spacing: sp, total };
  }

  class Route {
    constructor(data, opts = {}) {
      this.name = data.name || 'Parcours sans nom';
      const pts = data.points;
      const step = opts.step || 5;

      // --- Projection équirectangulaire locale (mètres). x = est, z = -nord.
      let lat0 = 0, lon0 = 0;
      for (const p of pts) { lat0 += p.lat; lon0 += p.lon; }
      lat0 /= pts.length; lon0 /= pts.length;
      this.lat0 = lat0; this.lon0 = lon0;
      this.kx = Math.cos(lat0 * DEG) * EARTH_R * DEG;
      this.kz = EARTH_R * DEG;

      // --- Altitudes manquantes
      const eles = pts.map((p) => p.ele);
      const known = eles.filter((e) => e !== null).length;
      this.syntheticElevation = known < pts.length * 0.5;
      if (this.syntheticElevation) {
        // Pas (assez) d'altitudes : on invente un relief doux.
        const noise = new B3D.util.Noise2D(1234);
        let d = 0;
        for (let i = 0; i < pts.length; i++) {
          if (i > 0) {
            d += Math.hypot((pts[i].lon - pts[i - 1].lon) * this.kx, (pts[i].lat - pts[i - 1].lat) * this.kz);
          }
          eles[i] = 180 + 35 * noise.fbm(d / 2500, 0.5, 3);
        }
      } else {
        // Interpolation linéaire des trous.
        let last = -1;
        for (let i = 0; i < eles.length; i++) {
          if (eles[i] === null) continue;
          if (last === -1) { for (let k = 0; k < i; k++) eles[k] = eles[i]; }
          else if (i - last > 1) {
            for (let k = last + 1; k < i; k++) eles[k] = eles[last] + (eles[i] - eles[last]) * (k - last) / (i - last);
          }
          last = i;
        }
        for (let k = last + 1; k < eles.length; k++) eles[k] = eles[last];
      }

      // --- Projection + suppression des doublons
      const xs = [], zs = [], ys = [];
      for (let i = 0; i < pts.length; i++) {
        const x = (pts[i].lon - lon0) * this.kx;
        const z = -(pts[i].lat - lat0) * this.kz;
        if (xs.length && Math.hypot(x - xs[xs.length - 1], z - zs[zs.length - 1]) < 1.0) continue;
        xs.push(x); zs.push(z); ys.push(eles[i]);
      }
      if (xs.length < 2) throw new Error('Le tracé est trop court.');

      // --- Rééchantillonnage, lissage du tracé (bruit GPS) puis de l'altitude
      let r = resample(xs, zs, ys, step);
      if (r.total < 300) throw new Error('Le parcours est trop court (moins de 300 m).');
      const sx = gaussianSmooth(r.x, 2.2), sz = gaussianSmooth(r.z, 2.2);
      r = resample(sx, sz, r.y, step);
      let ey = medianFilter(r.y, 3);
      ey = gaussianSmooth(ey, 30 / r.spacing);

      // --- Prolongements virtuels au départ et à l'arrivée (route plate et droite)
      const sp = r.spacing;
      const nExt = Math.round(EXT_LEN / sp);
      const nCore = r.x.length;
      const n = nCore + 2 * nExt;
      const X = new Float64Array(n), Z = new Float64Array(n), Y = new Float64Array(n);
      const k0 = Math.min(6, nCore - 1);
      let dx0 = r.x[0] - r.x[k0], dz0 = r.z[0] - r.z[k0];
      let l0 = Math.hypot(dx0, dz0) || 1; dx0 /= l0; dz0 /= l0;
      let dx1 = r.x[nCore - 1] - r.x[nCore - 1 - k0], dz1 = r.z[nCore - 1] - r.z[nCore - 1 - k0];
      let l1 = Math.hypot(dx1, dz1) || 1; dx1 /= l1; dz1 /= l1;
      for (let i = 0; i < nExt; i++) {
        const k = nExt - i;
        X[i] = r.x[0] + dx0 * sp * k;
        Z[i] = r.z[0] + dz0 * sp * k;
        Y[i] = ey[0];
      }
      for (let i = 0; i < nCore; i++) { X[nExt + i] = r.x[i]; Z[nExt + i] = r.z[i]; Y[nExt + i] = ey[i]; }
      for (let i = 0; i < nExt; i++) {
        const k = i + 1;
        X[nExt + nCore + i] = r.x[nCore - 1] + dx1 * sp * k;
        Z[nExt + nCore + i] = r.z[nCore - 1] + dz1 * sp * k;
        Y[nExt + nCore + i] = ey[nCore - 1];
      }
      // Raccord doux de l'altitude dans les prolongements
      const Ys = gaussianSmooth(Y, 3);
      for (let i = nExt; i < nExt + nCore; i++) Ys[i] = Y[i];

      this.n = n;
      this.spacing = sp;
      this.x = X; this.z = Z; this.y = Ys;
      this.sStart = nExt * sp;
      this.sEnd = (nExt + nCore - 1) * sp;
      this.length = this.sEnd - this.sStart;
      this.iStart = nExt;
      this.iEnd = nExt + nCore - 1;

      this._computeDerived();
      this._computeStats();
      this._buildSpatialIndex();
      this._detectClimbs();
    }

    _computeDerived() {
      const n = this.n, X = this.x, Z = this.z, Y = this.y, sp = this.spacing;
      this.tx = new Float64Array(n);
      this.tz = new Float64Array(n);
      this.grade = new Float64Array(n);
      this.curv = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        let dx = X[b] - X[a], dz = Z[b] - Z[a];
        const l = Math.hypot(dx, dz) || 1;
        this.tx[i] = dx / l; this.tz[i] = dz / l;
        const ga = Math.max(0, i - 4), gb = Math.min(n - 1, i + 4);
        this.grade[i] = (Y[gb] - Y[ga]) / ((gb - ga) * sp || 1);
      }
      const head = new Float64Array(n);
      for (let i = 0; i < n; i++) head[i] = Math.atan2(this.tx[i], this.tz[i]);
      const curv = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
        let d = head[b] - head[a];
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        curv[i] = d / ((b - a) * sp || 1);
      }
      this.curv = gaussianSmooth(curv, 3);
    }

    _computeStats() {
      let gain = 0, loss = 0, mn = Infinity, mx = -Infinity, maxGrade = -Infinity;
      for (let i = this.iStart; i <= this.iEnd; i++) {
        const e = this.y[i];
        if (e < mn) mn = e;
        if (e > mx) mx = e;
        if (i > this.iStart) {
          const d = e - this.y[i - 1];
          if (d > 0) gain += d; else loss -= d;
        }
        if (this.grade[i] > maxGrade) maxGrade = this.grade[i];
      }
      this.stats = { length: this.length, gain, loss, minEle: mn, maxEle: mx, maxGrade };
      let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
      for (let i = 0; i < this.n; i++) {
        bx0 = Math.min(bx0, this.x[i]); bx1 = Math.max(bx1, this.x[i]);
        bz0 = Math.min(bz0, this.z[i]); bz1 = Math.max(bz1, this.z[i]);
      }
      this.bbox = { x0: bx0, x1: bx1, z0: bz0, z1: bz1 };
    }

    static key(cx, cz) { return (cx + 32768) * 65536 + (cz + 32768); }

    _buildSpatialIndex() {
      const map = new Map();
      const n = this.n;
      for (let i = 0; i < n - 1; i++) {
        const x0 = Math.min(this.x[i], this.x[i + 1]), x1 = Math.max(this.x[i], this.x[i + 1]);
        const z0 = Math.min(this.z[i], this.z[i + 1]), z1 = Math.max(this.z[i], this.z[i + 1]);
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
          for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
            const k = Route.key(cx, cz);
            let arr = map.get(k);
            if (!arr) { arr = []; map.set(k, arr); }
            arr.push(i);
          }
        }
      }
      this.cells = map;

      // Échantillons grossiers (pour le champ d'altitude de base du paysage)
      const cmap = new Map();
      const idx = [];
      for (let i = 0; i < n; i += COARSE_STEP) idx.push(i);
      if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
      this.coarse = Int32Array.from(idx);
      for (const i of this.coarse) {
        const k = Route.key(Math.floor(this.x[i] / COARSE_CELL), Math.floor(this.z[i] / COARSE_CELL));
        let arr = cmap.get(k);
        if (!arr) { arr = []; cmap.set(k, arr); }
        arr.push(i);
      }
      this.coarseCells = cmap;
      this.coarseCell = COARSE_CELL;
    }

    // Segment le plus proche dans un rayon donné. out = {i, t, d, side, y}
    nearest(x, z, maxR, out) {
      out = out || {};
      out.d = Infinity; out.i = -1;
      const rc = Math.ceil(maxR / CELL);
      const cx0 = Math.floor(x / CELL), cz0 = Math.floor(z / CELL);
      const X = this.x, Z = this.z;
      for (let cx = cx0 - rc; cx <= cx0 + rc; cx++) {
        for (let cz = cz0 - rc; cz <= cz0 + rc; cz++) {
          const arr = this.cells.get(Route.key(cx, cz));
          if (!arr) continue;
          for (let k = 0; k < arr.length; k++) {
            const i = arr[k];
            const ax = X[i], az = Z[i];
            const bx = X[i + 1] - ax, bz = Z[i + 1] - az;
            const l2 = bx * bx + bz * bz || 1e-9;
            let t = ((x - ax) * bx + (z - az) * bz) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + bx * t - x, pz = az + bz * t - z;
            const d = Math.sqrt(px * px + pz * pz);
            if (d < out.d) {
              out.d = d; out.i = i; out.t = t;
              out.side = (bx * (z - az) - bz * (x - ax)) > 0 ? 1 : -1; // +1 = à droite
            }
          }
        }
      }
      if (out.i >= 0) {
        out.y = this.y[out.i] + (this.y[out.i + 1] - this.y[out.i]) * out.t;
        out.s = (out.i + out.t) * this.spacing;
      }
      return out;
    }

    // Index "large" : chaque segment est inscrit dans toutes les cellules à moins de WIDE_MARGIN,
    // une seule cellule suffit alors pour connaître tous les segments proches d'un point.
    _buildWideIndex() {
      const map = new Map();
      const C = Route.WIDE_CELL, M = Route.WIDE_MARGIN;
      for (let i = 0; i < this.n - 1; i++) {
        const x0 = Math.min(this.x[i], this.x[i + 1]) - M, x1 = Math.max(this.x[i], this.x[i + 1]) + M;
        const z0 = Math.min(this.z[i], this.z[i + 1]) - M, z1 = Math.max(this.z[i], this.z[i + 1]) + M;
        for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++) {
          for (let cz = Math.floor(z0 / C); cz <= Math.floor(z1 / C); cz++) {
            const k = Route.key(cx, cz);
            let arr = map.get(k);
            if (!arr) { arr = []; map.set(k, arr); }
            arr.push(i);
          }
        }
      }
      this.wide = map;
    }

    // Branches de route proches (par tronçons de ~80 m) : pour aplanir le terrain sous chaque passage.
    // Remplit out.d[], out.y[], out.i[] et renvoie le nombre de branches (rayon max = WIDE_MARGIN).
    branches(x, z, maxR, out) {
      if (!this.wide) this._buildWideIndex();
      const arr = this.wide.get(Route.key(Math.floor(x / Route.WIDE_CELL), Math.floor(z / Route.WIDE_CELL)));
      if (!arr) return 0;
      const X = this.x, Z = this.z, Y = this.y;
      let count = 0;
      for (let k = 0; k < arr.length; k++) {
        const i = arr[k];
        const ax = X[i], az = Z[i];
        const bx = X[i + 1] - ax, bz = Z[i + 1] - az;
        const l2 = bx * bx + bz * bz || 1e-9;
        let t = ((x - ax) * bx + (z - az) * bz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + bx * t - x, pz = az + bz * t - z;
        const d = Math.sqrt(px * px + pz * pz);
        if (d > maxR) continue;
        const bucket = i >> 4;
        let slot = -1;
        for (let q = 0; q < count; q++) {
          if (Math.abs(out.b[q] - bucket) <= 1) { slot = q; break; }
        }
        if (slot === -1) {
          if (count >= out.b.length) continue;
          slot = count++;
          out.b[slot] = bucket; out.d[slot] = Infinity;
        }
        if (d < out.d[slot]) {
          out.d[slot] = d;
          out.i[slot] = i;
          out.y[slot] = Y[i] + (Y[i + 1] - Y[i]) * t;
        }
      }
      return count;
    }

    // Échantillonne la route à l'abscisse curviligne s (coordonnées étendues).
    sample(s, out) {
      out = out || {};
      const sp = this.spacing;
      let f = s / sp;
      if (f < 0) f = 0;
      if (f > this.n - 1.0001) f = this.n - 1.0001;
      const i = Math.floor(f);
      const t = f - i;
      const j = i + 1;
      out.i = i; out.t = t;
      out.x = this.x[i] + (this.x[j] - this.x[i]) * t;
      out.z = this.z[i] + (this.z[j] - this.z[i]) * t;
      out.y = this.y[i] + (this.y[j] - this.y[i]) * t;
      let tx = this.tx[i] + (this.tx[j] - this.tx[i]) * t;
      let tz = this.tz[i] + (this.tz[j] - this.tz[i]) * t;
      const l = Math.hypot(tx, tz) || 1;
      out.tx = tx / l; out.tz = tz / l;
      out.rx = -out.tz; out.rz = out.tx; // vecteur "droite"
      out.grade = this.grade[i] + (this.grade[j] - this.grade[i]) * t;
      out.curv = this.curv[i] + (this.curv[j] - this.curv[i]) * t;
      return out;
    }

    // Distance jouable (0 = départ) -> abscisse étendue, et inversement.
    toS(d) { return this.sStart + d; }
    toD(s) { return s - this.sStart; }

    lonLatOf(x, z) {
      return { lon: this.lon0 + x / this.kx, lat: this.lat0 - z / this.kz };
    }

    _detectClimbs() {
      const step = 50;
      const m = Math.floor(this.length / step) + 1;
      const e = new Float64Array(m);
      const tmp = {};
      for (let k = 0; k < m; k++) e[k] = this.sample(this.sStart + Math.min(k * step, this.length), tmp).y;
      const climbs = [];
      let i = 0;
      while (i < m - 1) {
        while (i < m - 1 && e[i + 1] <= e[i]) i++;
        const start = i;
        let maxI = i, j = i;
        while (j < m - 1) {
          j++;
          if (e[j] > e[maxI]) maxI = j;
          const g = e[maxI] - e[start];
          if (e[maxI] - e[j] > Math.max(25, g * 0.2)) break;
        }
        const gain = e[maxI] - e[start];
        const len = (maxI - start) * step;
        if (gain >= 50 && len >= 500 && gain / len >= 0.03) {
          const avg = gain / len;
          const score = len * avg * 100;
          let cat = 4;
          if (score >= 80000) cat = 0; else if (score >= 64000) cat = 1; else if (score >= 32000) cat = 2; else if (score >= 16000) cat = 3;
          let maxG = 0;
          for (let q = start; q < maxI; q++) maxG = Math.max(maxG, (e[q + 1] - e[q]) / step);
          climbs.push({
            d0: start * step, d1: maxI * step, gain, length: len, avg, maxGrade: maxG, cat,
            summitEle: e[maxI]
          });
        }
        i = Math.max(maxI, start + 1);
      }
      this.climbs = climbs;
    }
  }

  Route.WIDE_CELL = 32;
  Route.WIDE_MARGIN = 72;

  B3D.Route = Route;
})(typeof window !== 'undefined' ? window : globalThis);
