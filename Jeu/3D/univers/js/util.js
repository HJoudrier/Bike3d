/* Bike3D — utilitaires : maths, aléatoire déterministe, bruit procédural. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // Générateur pseudo-aléatoire déterministe (mulberry32).
  function mulberry32(seed) {
    let a = seed >>> 0;
    const rnd = function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rnd.range = (lo, hi) => lo + (hi - lo) * rnd();
    rnd.int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
    rnd.pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    rnd.chance = (p) => rnd() < p;
    return rnd;
  }

  // Hachage entier 2D -> [0,1).
  function hash2(x, y, seed) {
    let h = (seed | 0) ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Bruit simplex 2D (d'après S. Gustavson), permutation dépendante de la graine.
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  // 16 gradients répartis régulièrement (évite les alignements diagonaux du bruit "crêtes").
  const GX = new Float32Array(16), GY = new Float32Array(16);
  for (let k = 0; k < 16; k++) { const a = (k + 0.5) / 16 * Math.PI * 2; GX[k] = Math.cos(a); GY[k] = Math.sin(a); }
  // rotation entre octaves
  const RC = Math.cos(0.65), RS = Math.sin(0.65);

  class Noise2D {
    constructor(seed) {
      const rnd = mulberry32(seed);
      const p = new Uint8Array(256);
      for (let i = 0; i < 256; i++) p[i] = i;
      for (let i = 255; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const t = p[i]; p[i] = p[j]; p[j] = t;
      }
      this.perm = new Uint8Array(512);
      for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    }

    noise(xin, yin) {
      const perm = this.perm;
      const s = (xin + yin) * F2;
      const i = Math.floor(xin + s);
      const j = Math.floor(yin + s);
      const t = (i + j) * G2;
      const x0 = xin - (i - t);
      const y0 = yin - (j - t);
      let i1, j1;
      if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
      const x1 = x0 - i1 + G2;
      const y1 = y0 - j1 + G2;
      const x2 = x0 - 1 + 2 * G2;
      const y2 = y0 - 1 + 2 * G2;
      const ii = i & 255;
      const jj = j & 255;
      let n = 0;
      let t0 = 0.5 - x0 * x0 - y0 * y0;
      if (t0 > 0) {
        const g = perm[ii + perm[jj]] & 15;
        t0 *= t0;
        n += t0 * t0 * (GX[g] * x0 + GY[g] * y0);
      }
      let t1 = 0.5 - x1 * x1 - y1 * y1;
      if (t1 > 0) {
        const g = perm[ii + i1 + perm[jj + j1]] & 15;
        t1 *= t1;
        n += t1 * t1 * (GX[g] * x1 + GY[g] * y1);
      }
      let t2 = 0.5 - x2 * x2 - y2 * y2;
      if (t2 > 0) {
        const g = perm[ii + 1 + perm[jj + 1]] & 15;
        t2 *= t2;
        n += t2 * t2 * (GX[g] * x2 + GY[g] * y2);
      }
      return 99 * n; // ~[-1, 1]
    }

    fbm(x, y, octaves, lacunarity = 2.0, gain = 0.5) {
      let sum = 0, amp = 1, norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * this.noise(x + o * 17.3, y - o * 9.1);
        norm += amp;
        amp *= gain;
        const nx = (x * RC - y * RS) * lacunarity;
        y = (x * RS + y * RC) * lacunarity;
        x = nx;
      }
      return sum / norm;
    }

    // Bruit "crêtes" : valeurs dans [0,1], pics marqués.
    ridged(x, y, octaves) {
      let sum = 0, amp = 0.5, norm = 0, prev = 1;
      for (let o = 0; o < octaves; o++) {
        let n = 1 - Math.abs(this.noise(x + o * 31.7, y + o * 7.7));
        n *= n;
        sum += n * amp * prev;
        norm += amp;
        prev = n;
        amp *= 0.5;
        const nx = (x * RC - y * RS) * 2.03;
        y = (x * RS + y * RC) * 2.03;
        x = nx;
      }
      return sum / norm;
    }
  }

  // Cellules de Voronoï (grille perturbée) : renvoie id, distances aux 2 plus proches germes.
  function voronoi(x, y, cell, seed, out) {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    let d1 = 1e9, d2 = 1e9, id = 0, cx = 0, cy = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const ix = gx + ox, iy = gy + oy;
        const px = (ix + 0.15 + 0.7 * hash2(ix, iy, seed)) * cell;
        const py = (iy + 0.15 + 0.7 * hash2(ix, iy, seed + 101)) * cell;
        const dx = px - x, dy = py - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < d1) {
          d2 = d1; d1 = d; id = ((ix * 73856093) ^ (iy * 19349663)) >>> 0; cx = px; cy = py;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
    out.id = id; out.d1 = d1; out.d2 = d2; out.cx = cx; out.cy = cy;
    return out;
  }

  function formatTime(sec) {
    sec = Math.max(0, sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return (h > 0 ? h + ':' + pad(m) : m) + ':' + pad(s);
  }

  // Couleur de pente façon profils du Tour de France.
  function gradeColor(g) {
    const p = g * 100;
    if (p < 0) return '#4fb3e8';
    if (p < 3) return '#5cc85a';
    if (p < 6) return '#f2d33a';
    if (p < 9) return '#f39a2b';
    if (p < 12) return '#e2463a';
    return '#5a2340';
  }

  B3D.util = { clamp, lerp, smoothstep, mulberry32, hash2, hashString, Noise2D, voronoi, formatTime, gradeColor };
})(typeof window !== 'undefined' ? window : globalThis);
