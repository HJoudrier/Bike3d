/* Bike3D — objets du décor (arbres, rochers, herbes, vaches…) et pools d'instances. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { merge, tr, instancedMat, outlineMat, computeOutlineNormals } = B3D.toon;

  const WHITE = '#ffffff';
  const TRUNK = '#7a5232';

  function sphere(r, w = 8, h = 6) { return new THREE.SphereGeometry(r, w, h); }

  function conifer() {
    return merge([
      { geo: new THREE.CylinderGeometry(0.16, 0.24, 1.4, 6), color: TRUNK, matrix: tr(0, 0.7, 0) },
      { geo: new THREE.ConeGeometry(1.9, 2.6, 8), color: WHITE, tint: 1, matrix: tr(0, 2.1, 0) },
      { geo: new THREE.ConeGeometry(1.5, 2.2, 8), color: WHITE, tint: 1, matrix: tr(0, 3.3, 0, 0, 0.4, 0) },
      { geo: new THREE.ConeGeometry(1.05, 1.9, 8), color: WHITE, tint: 1, matrix: tr(0, 4.4, 0, 0, 0.8, 0) }
    ]);
  }

  function deciduous() {
    return merge([
      { geo: new THREE.CylinderGeometry(0.17, 0.27, 2.4, 6), color: TRUNK, matrix: tr(0, 1.2, 0) },
      { geo: new THREE.CylinderGeometry(0.07, 0.12, 1.2, 5), color: TRUNK, matrix: tr(0.45, 2.3, 0, 0, 0, -0.8) },
      { geo: sphere(1.75), color: WHITE, tint: 1, matrix: tr(0, 3.3, 0) },
      { geo: sphere(1.25), color: WHITE, tint: 1, matrix: tr(1.15, 2.85, 0.3) },
      { geo: sphere(1.3), color: WHITE, tint: 1, matrix: tr(-1.0, 2.95, -0.35) },
      { geo: sphere(1.15), color: WHITE, tint: 1, matrix: tr(0.15, 4.35, 0.2) }
    ]);
  }

  function poplar() {
    return merge([
      { geo: new THREE.CylinderGeometry(0.15, 0.22, 2.0, 6), color: TRUNK, matrix: tr(0, 1.0, 0) },
      { geo: sphere(1, 8, 8), color: WHITE, tint: 1, matrix: tr(0, 4.6, 0, 0, 0, 0, 1.25, 3.6, 1.25) }
    ]);
  }

  function bush() {
    return merge([
      { geo: sphere(0.85, 7, 5), color: WHITE, tint: 1, matrix: tr(0, 0.55, 0) },
      { geo: sphere(0.65, 7, 5), color: WHITE, tint: 1, matrix: tr(0.6, 0.45, 0.2) },
      { geo: sphere(0.6, 7, 5), color: WHITE, tint: 1, matrix: tr(-0.45, 0.4, -0.35) }
    ]);
  }

  function rock() {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const pos = g.attributes.position;
    const noise = new B3D.util.Noise2D(77);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const f = 1 + 0.28 * noise.noise(x * 1.7 + z * 0.6, y * 1.9 - z);
      pos.setXYZ(i, x * f, y * f * 0.75 + 0.35, z * f);
    }
    g.computeVertexNormals();
    return merge([{ geo: g, color: WHITE, tint: 1 }]);
  }

  function grass() {
    const parts = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + 0.3;
      parts.push({
        geo: new THREE.ConeGeometry(0.07, 0.65, 3),
        color: WHITE, tint: 1,
        matrix: tr(Math.cos(a) * 0.08, 0.3, Math.sin(a) * 0.08, Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35)
      });
    }
    return merge(parts);
  }

  function flowers() {
    const parts = [];
    const spots = [[0, 0, 0.42], [0.18, 0.1, 0.32], [-0.12, 0.15, 0.36], [0.05, -0.17, 0.28]];
    for (const s of spots) {
      parts.push({ geo: new THREE.CylinderGeometry(0.015, 0.015, s[2], 3), color: '#4c9a3a', matrix: tr(s[0], s[2] / 2, s[1]) });
      parts.push({ geo: sphere(0.075, 6, 4), color: WHITE, tint: 1, matrix: tr(s[0], s[2], s[1]) });
    }
    return merge(parts);
  }

  function hay() {
    return merge([
      { geo: new THREE.CylinderGeometry(0.72, 0.72, 1.25, 12), color: WHITE, tint: 1, matrix: tr(0, 0.72, 0, 0, 0, Math.PI / 2) },
      { geo: new THREE.CylinderGeometry(0.45, 0.45, 1.27, 12), color: '#c9a04a', matrix: tr(0, 0.72, 0, 0, 0, Math.PI / 2) }
    ]);
  }

  function cow() {
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const B = '#26222e', W = '#f7f5ef', P = '#f2a6b4';
    return merge([
      { geo: box(1.7, 0.85, 0.85), color: W, matrix: tr(0, 1.08, 0) },
      { geo: box(0.55, 0.62, 0.9), color: B, matrix: tr(0.25, 1.15, 0) },
      { geo: box(0.4, 0.5, 0.9), color: B, matrix: tr(-0.55, 1.0, 0.02) },
      { geo: box(0.5, 0.5, 0.46), color: W, matrix: tr(1.05, 1.42, 0) },
      { geo: box(0.22, 0.3, 0.42), color: P, matrix: tr(1.33, 1.32, 0) },
      { geo: box(0.14, 0.14, 0.22), color: B, matrix: tr(1.0, 1.62, 0.33) },
      { geo: box(0.14, 0.14, 0.22), color: B, matrix: tr(1.0, 1.62, -0.33) },
      { geo: new THREE.ConeGeometry(0.05, 0.22, 4), color: '#f3e3b0', matrix: tr(1.0, 1.75, 0.16) },
      { geo: new THREE.ConeGeometry(0.05, 0.22, 4), color: '#f3e3b0', matrix: tr(1.0, 1.75, -0.16) },
      { geo: box(0.2, 0.68, 0.2), color: W, matrix: tr(0.6, 0.34, 0.27) },
      { geo: box(0.2, 0.68, 0.2), color: W, matrix: tr(0.6, 0.34, -0.27) },
      { geo: box(0.2, 0.68, 0.2), color: W, matrix: tr(-0.6, 0.34, 0.27) },
      { geo: box(0.2, 0.68, 0.2), color: W, matrix: tr(-0.6, 0.34, -0.27) },
      { geo: sphere(0.17, 6, 4), color: P, matrix: tr(-0.35, 0.62, 0) },
      { geo: box(0.06, 0.6, 0.06), color: W, matrix: tr(-0.88, 0.95, 0, 0, 0, -0.25) }
    ]);
  }

  // Spectateur : bras modélisés tendus vers l'avant, animés dans le shader (applaudir, bras en l'air, coucou).
  function spectator() {
    const SK = '#f1c7a0';
    const parts = [
      { geo: new THREE.CylinderGeometry(0.07, 0.07, 0.8, 5), color: '#2d3346', matrix: tr(0.1, 0.4, 0) },
      { geo: new THREE.CylinderGeometry(0.07, 0.07, 0.8, 5), color: '#2d3346', matrix: tr(-0.1, 0.4, 0) },
      { geo: new THREE.CapsuleGeometry(0.23, 0.42, 3, 8), color: WHITE, tint: 1, matrix: tr(0, 1.08, 0) },
      { geo: sphere(0.19, 8, 6), color: SK, matrix: tr(0, 1.63, 0) },
      { geo: sphere(0.035, 6, 4), color: '#1d1a2b', matrix: tr(0.07, 1.67, 0.165) },
      { geo: sphere(0.035, 6, 4), color: '#1d1a2b', matrix: tr(-0.07, 1.67, 0.165) },
      { geo: new THREE.TorusGeometry(0.06, 0.012, 4, 8, Math.PI), color: '#8a2b2b', matrix: tr(0, 1.585, 0.16, 0, 0, Math.PI) },
      { geo: new THREE.SphereGeometry(0.2, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), color: WHITE, tint: 1, matrix: tr(0, 1.68, -0.01) },
      { geo: new THREE.BoxGeometry(0.22, 0.03, 0.14), color: WHITE, tint: 1, matrix: tr(0, 1.69, 0.2) }
    ];
    for (const side of [-1, 1]) {
      const x = 0.27 * side;
      parts.push({ geo: sphere(0.075, 6, 5), color: WHITE, tint: 1, matrix: tr(x, 1.42, 0) });
      parts.push({ geo: new THREE.CylinderGeometry(0.055, 0.05, 0.52, 5), color: WHITE, tint: 1, arm: side, matrix: tr(x, 1.42, 0.27, Math.PI / 2, 0, 0) });
      parts.push({ geo: sphere(0.075, 6, 4), color: SK, arm: side, matrix: tr(x, 1.42, 0.56) });
    }
    return merge(parts);
  }

  // ------------------------------------------------------------------ biomes
  // Segment de rang de vigne (4,4 m selon x) : piquets, ceps, feuillage et grappes.
  function vine() {
    const parts = [];
    for (const x of [-2.15, 2.15]) parts.push({ geo: new THREE.CylinderGeometry(0.04, 0.05, 1.45, 4), color: '#8a6a45', matrix: tr(x, 0.72, 0) });
    for (const x of [-1.3, 0, 1.3]) parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.08, 0.7, 4), color: '#6e4b2f', matrix: tr(x, 0.35, 0) });
    parts.push({ geo: sphere(1, 8, 5), color: WHITE, tint: 1, matrix: tr(0, 0.98, 0, 0, 0, 0, 2.2, 0.48, 0.42) });
    for (let k = 0; k < 4; k++) parts.push({ geo: sphere(0.12, 5, 4), color: '#5b2a6e', matrix: tr(-1.5 + k, 0.62, k % 2 ? 0.3 : -0.3) });
    return merge(parts);
  }

  const fruitCache = new Map();
  // Arbre fruitier : couronne ronde (teintée) et fruits ou fleurs selon la saison.
  function fruitTree(fruitColor) {
    if (fruitCache.has(fruitColor)) return fruitCache.get(fruitColor);
    const parts = [
      { geo: new THREE.CylinderGeometry(0.13, 0.2, 1.6, 6), color: TRUNK, matrix: tr(0, 0.8, 0) },
      { geo: sphere(1.55, 9, 7), color: WHITE, tint: 1, matrix: tr(0, 2.5, 0, 0, 0, 0, 1, 0.85, 1) }
    ];
    for (let k = 0; k < 9; k++) {
      const a = k * 2.4, y = 2.1 + (k % 3) * 0.45;
      parts.push({ geo: sphere(0.13, 5, 4), color: fruitColor, matrix: tr(Math.cos(a) * 1.35, y, Math.sin(a) * 1.35) });
    }
    const g = merge(parts);
    fruitCache.set(fruitColor, g);
    return g;
  }

  function cypress() {
    return merge([
      { geo: new THREE.CylinderGeometry(0.12, 0.16, 0.9, 5), color: TRUNK, matrix: tr(0, 0.45, 0) },
      { geo: sphere(1, 8, 8), color: WHITE, tint: 1, matrix: tr(0, 3.6, 0, 0, 0, 0, 0.75, 3.3, 0.75) },
      { geo: new THREE.ConeGeometry(0.35, 1.4, 6), color: WHITE, tint: 1, matrix: tr(0, 7.1, 0) }
    ]);
  }

  function olive() {
    const T = '#7d6a55';
    return merge([
      { geo: new THREE.CylinderGeometry(0.16, 0.3, 1.5, 6), color: T, matrix: tr(0.1, 0.7, 0, 0, 0, -0.2) },
      { geo: new THREE.CylinderGeometry(0.1, 0.16, 1.2, 5), color: T, matrix: tr(0.45, 1.55, 0.1, 0.2, 0, -0.6) },
      { geo: new THREE.CylinderGeometry(0.1, 0.16, 1.1, 5), color: T, matrix: tr(-0.25, 1.5, -0.1, -0.2, 0, 0.55) },
      { geo: sphere(1, 8, 6), color: WHITE, tint: 1, matrix: tr(0.7, 2.25, 0.2, 0, 0, 0, 1.25, 0.7, 1.1) },
      { geo: sphere(1, 8, 6), color: WHITE, tint: 1, matrix: tr(-0.6, 2.15, -0.25, 0, 0, 0, 1.1, 0.65, 1.15) },
      { geo: sphere(1, 8, 6), color: WHITE, tint: 1, matrix: tr(0.05, 2.7, 0.05, 0, 0, 0, 1.0, 0.6, 1.0) }
    ]);
  }

  // Pin parasol : haut tronc nu et couronne plate.
  function umbrellaPine() {
    return merge([
      { geo: new THREE.CylinderGeometry(0.16, 0.26, 3.2, 6), color: '#8a5a3a', matrix: tr(0.15, 1.6, 0, 0, 0, -0.1) },
      { geo: new THREE.CylinderGeometry(0.12, 0.16, 2.2, 6), color: '#8a5a3a', matrix: tr(0.45, 4.1, 0, 0, 0, -0.25) },
      { geo: sphere(1, 10, 6), color: WHITE, tint: 1, matrix: tr(0.7, 5.4, 0, 0, 0, 0, 3.1, 0.95, 2.8) },
      { geo: sphere(1, 8, 5), color: WHITE, tint: 1, matrix: tr(-0.6, 5.0, 0.6, 0, 0, 0, 1.6, 0.6, 1.5) }
    ]);
  }

  function birch() {
    const parts = [
      { geo: new THREE.CylinderGeometry(0.11, 0.16, 4.2, 6), color: '#f2efe6', matrix: tr(0, 2.1, 0) },
      { geo: sphere(1, 8, 7), color: WHITE, tint: 1, matrix: tr(0, 4.4, 0, 0, 0, 0, 1.15, 1.9, 1.15) },
      { geo: sphere(1, 7, 6), color: WHITE, tint: 1, matrix: tr(0.55, 3.4, 0.25, 0, 0, 0, 0.8, 1.1, 0.8) }
    ];
    for (let k = 0; k < 5; k++) parts.push({ geo: new THREE.BoxGeometry(0.12, 0.05, 0.12), color: '#2d2a33', matrix: tr(Math.cos(k * 2.1) * 0.12, 0.7 + k * 0.6, Math.sin(k * 2.1) * 0.12, 0, k, 0) });
    return merge(parts);
  }

  // Saule pleureur : dôme et rideau de branches retombantes.
  function willow() {
    return merge([
      { geo: new THREE.CylinderGeometry(0.22, 0.32, 2.6, 6), color: TRUNK, matrix: tr(0, 1.3, 0) },
      { geo: sphere(1, 10, 7), color: WHITE, tint: 1, matrix: tr(0, 3.5, 0, 0, 0, 0, 2.3, 1.5, 2.3) },
      { geo: new THREE.CylinderGeometry(2.2, 2.7, 2.4, 12, 1, true), color: WHITE, tint: 1, matrix: tr(0, 2.3, 0) }
    ]);
  }

  function reeds() {
    const parts = [];
    for (let k = 0; k < 8; k++) {
      const a = k * 0.8, r = 0.12 + (k % 3) * 0.1, h = 1.3 + (k % 4) * 0.2;
      parts.push({ geo: new THREE.ConeGeometry(0.04, h, 3), color: WHITE, tint: 1, matrix: tr(Math.cos(a) * r, h / 2, Math.sin(a) * r, Math.sin(a) * 0.12, 0, Math.cos(a) * 0.12) });
    }
    for (let k = 0; k < 3; k++) {
      const a = k * 2.2 + 0.4;
      parts.push({ geo: new THREE.CylinderGeometry(0.012, 0.012, 1.5, 3), color: '#6f8f45', matrix: tr(Math.cos(a) * 0.2, 0.75, Math.sin(a) * 0.2) });
      parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, 0.25, 6), color: '#6b4428', matrix: tr(Math.cos(a) * 0.2, 1.45, Math.sin(a) * 0.2) });
    }
    return merge(parts);
  }

  function heather() {
    return merge([
      { geo: sphere(1, 6, 4), color: WHITE, tint: 1, matrix: tr(0, 0.18, 0, 0, 0, 0, 0.5, 0.32, 0.5) },
      { geo: sphere(1, 6, 4), color: WHITE, tint: 1, matrix: tr(0.45, 0.14, 0.15, 0, 0, 0, 0.38, 0.26, 0.38) },
      { geo: sphere(1, 6, 4), color: WHITE, tint: 1, matrix: tr(-0.35, 0.13, -0.25, 0, 0, 0, 0.35, 0.24, 0.35) }
    ]);
  }

  // Segment de rang de lavande (3 m selon x).
  function lavenderRow() {
    return merge([
      { geo: sphere(1, 7, 4), color: WHITE, tint: 1, matrix: tr(-0.76, 0.3, 0, 0, 0, 0, 0.78, 0.45, 0.48) },
      { geo: sphere(1, 7, 4), color: WHITE, tint: 1, matrix: tr(0.76, 0.3, 0, 0, 0, 0, 0.78, 0.45, 0.48) }
    ]);
  }

  // Segment de rang de tournesols (3 fleurs selon x), têtes tournées vers +z.
  function sunflowerRow() {
    const parts = [];
    for (const x of [-0.85, 0, 0.85]) {
      parts.push({ geo: new THREE.CylinderGeometry(0.035, 0.045, 1.55, 4), color: '#4f8a2f', matrix: tr(x, 0.78, 0) });
      parts.push({ geo: sphere(1, 5, 3), color: '#5a9a35', matrix: tr(x + 0.15, 0.8, 0, 0, 0, 0.5, 0.22, 0.06, 0.14) });
      parts.push({ geo: new THREE.CylinderGeometry(0.3, 0.3, 0.06, 10), color: '#f7c925', matrix: tr(x, 1.62, 0.06, Math.PI / 2 - 0.25, 0, 0) });
      parts.push({ geo: new THREE.CylinderGeometry(0.14, 0.14, 0.08, 8), color: '#6b3d1e', matrix: tr(x, 1.62, 0.1, Math.PI / 2 - 0.25, 0, 0) });
    }
    return merge(parts);
  }

  function pumpkin() {
    return merge([
      { geo: sphere(1, 10, 6), color: WHITE, tint: 1, matrix: tr(0, 0.28, 0, 0, 0, 0, 0.45, 0.32, 0.45) },
      { geo: new THREE.CylinderGeometry(0.04, 0.05, 0.16, 4), color: '#5a7a2f', matrix: tr(0, 0.62, 0) }
    ]);
  }

  // ------------------------------------------------------------------ animaux (avant = +x, comme la vache)
  function horse() {
    const D = '#2a211c';
    const parts = [
      { geo: new THREE.CapsuleGeometry(0.36, 1.05, 3, 8), color: WHITE, tint: 1, matrix: tr(0, 1.25, 0, 0, 0, Math.PI / 2) },
      { geo: new THREE.BoxGeometry(0.62, 0.3, 0.28), color: WHITE, tint: 1, matrix: tr(0.82, 1.6, 0, 0, 0, 0.9) },
      { geo: new THREE.BoxGeometry(0.62, 0.26, 0.24), color: WHITE, tint: 1, matrix: tr(1.13, 1.93, 0, 0, 0, -0.5) },
      { geo: new THREE.BoxGeometry(0.5, 0.06, 0.08), color: D, matrix: tr(0.78, 1.82, 0, 0, 0, 0.9) },
      { geo: new THREE.ConeGeometry(0.05, 0.16, 4), color: WHITE, tint: 1, matrix: tr(0.98, 2.2, 0.08) },
      { geo: new THREE.ConeGeometry(0.05, 0.16, 4), color: WHITE, tint: 1, matrix: tr(0.98, 2.2, -0.08) },
      { geo: new THREE.BoxGeometry(0.1, 0.75, 0.12), color: D, matrix: tr(-0.92, 1.0, 0, 0, 0, -0.35) }
    ];
    for (const [x, z] of [[0.5, 0.18], [0.5, -0.18], [-0.5, 0.18], [-0.5, -0.18]]) {
      parts.push({ geo: new THREE.BoxGeometry(0.13, 0.95, 0.13), color: WHITE, tint: 1, matrix: tr(x, 0.5, z) });
      parts.push({ geo: new THREE.BoxGeometry(0.15, 0.1, 0.15), color: D, matrix: tr(x, 0.05, z) });
    }
    return merge(parts);
  }

  function sheep() {
    const D = '#3a3440';
    const parts = [];
    for (const [x, y, z, r] of [[0, 0.72, 0, 0.42], [0.3, 0.74, 0.12, 0.3], [-0.3, 0.72, -0.1, 0.32], [0.05, 0.92, 0, 0.3], [-0.25, 0.8, 0.18, 0.26]]) {
      parts.push({ geo: sphere(r, 7, 5), color: WHITE, tint: 1, matrix: tr(x, y, z) });
    }
    parts.push({ geo: sphere(0.17, 7, 5), color: D, matrix: tr(0.55, 0.88, 0, 0, 0, 0, 1.3, 1, 0.9) });
    parts.push({ geo: new THREE.BoxGeometry(0.06, 0.12, 0.2), color: D, matrix: tr(0.5, 0.98, 0.17, 0.5, 0, 0) });
    parts.push({ geo: new THREE.BoxGeometry(0.06, 0.12, 0.2), color: D, matrix: tr(0.5, 0.98, -0.17, -0.5, 0, 0) });
    for (const [x, z] of [[0.25, 0.14], [0.25, -0.14], [-0.25, 0.14], [-0.25, -0.14]]) parts.push({ geo: new THREE.BoxGeometry(0.08, 0.45, 0.08), color: D, matrix: tr(x, 0.22, z) });
    return merge(parts);
  }

  // Bouquetin : grandes cornes recourbées.
  function ibex() {
    const H = '#cdbf9c', D = '#3a3036';
    const parts = [
      { geo: new THREE.CapsuleGeometry(0.28, 0.75, 3, 8), color: WHITE, tint: 1, matrix: tr(0, 0.95, 0, 0, 0, Math.PI / 2) },
      { geo: new THREE.BoxGeometry(0.36, 0.22, 0.2), color: WHITE, tint: 1, matrix: tr(0.62, 1.22, 0, 0, 0, 0.8) },
      { geo: new THREE.BoxGeometry(0.4, 0.22, 0.2), color: WHITE, tint: 1, matrix: tr(0.82, 1.42, 0, 0, 0, -0.4) },
      { geo: new THREE.ConeGeometry(0.05, 0.22, 4), color: D, matrix: tr(0.92, 1.24, 0, 0, 0, Math.PI) },
      { geo: new THREE.BoxGeometry(0.08, 0.18, 0.08), color: D, matrix: tr(-0.55, 1.1, 0, 0, 0, -0.5) }
    ];
    for (const z of [-0.08, 0.08]) {
      parts.push({ geo: new THREE.TorusGeometry(0.34, 0.045, 5, 10, Math.PI * 1.05), color: H, matrix: tr(0.48, 1.6, z, 0, 0, 0.2) });
    }
    for (const [x, z] of [[0.35, 0.13], [0.35, -0.13], [-0.35, 0.13], [-0.35, -0.13]]) parts.push({ geo: new THREE.BoxGeometry(0.1, 0.7, 0.1), color: WHITE, tint: 1, matrix: tr(x, 0.35, z) });
    return merge(parts);
  }

  // Marmotte debout, aux aguets.
  function marmot() {
    const D = '#3a2a22';
    return merge([
      { geo: sphere(1, 8, 6), color: WHITE, tint: 1, matrix: tr(0, 0.28, 0, 0, 0, 0, 0.2, 0.3, 0.18) },
      { geo: sphere(0.13, 8, 6), color: WHITE, tint: 1, matrix: tr(0.02, 0.62, 0) },
      { geo: sphere(0.05, 5, 4), color: D, matrix: tr(0.13, 0.6, 0) },
      { geo: sphere(0.04, 5, 4), color: WHITE, tint: 1, matrix: tr(0.0, 0.73, 0.09) },
      { geo: sphere(0.04, 5, 4), color: WHITE, tint: 1, matrix: tr(0.0, 0.73, -0.09) },
      { geo: sphere(0.06, 5, 4), color: WHITE, tint: 1, matrix: tr(0.12, 0.38, 0.1) },
      { geo: sphere(0.06, 5, 4), color: WHITE, tint: 1, matrix: tr(0.12, 0.38, -0.1) },
      { geo: new THREE.CylinderGeometry(0.05, 0.03, 0.22, 5), color: D, matrix: tr(-0.18, 0.08, 0, 0, 0, 1.2) }
    ]);
  }

  // Chevreuil : silhouette fine, petits bois, miroir blanc.
  function deer() {
    const D = '#3b2a20';
    const parts = [
      { geo: new THREE.CapsuleGeometry(0.22, 0.7, 3, 8), color: WHITE, tint: 1, matrix: tr(0, 0.95, 0, 0, 0, Math.PI / 2) },
      { geo: new THREE.BoxGeometry(0.5, 0.15, 0.15), color: WHITE, tint: 1, matrix: tr(0.48, 1.25, 0, 0, 0, 1.0) },
      { geo: new THREE.BoxGeometry(0.32, 0.18, 0.16), color: WHITE, tint: 1, matrix: tr(0.68, 1.5, 0, 0, 0, -0.3) },
      { geo: sphere(0.05, 5, 4), color: D, matrix: tr(0.85, 1.46, 0) },
      { geo: sphere(0.14, 6, 4), color: '#f4efe4', matrix: tr(-0.5, 1.02, 0) }
    ];
    for (const z of [-0.06, 0.06]) {
      parts.push({ geo: new THREE.CylinderGeometry(0.015, 0.02, 0.28, 3), color: '#d9c7a4', matrix: tr(0.62, 1.72, z, z * 4, 0, 0.2) });
      parts.push({ geo: new THREE.ConeGeometry(0.05, 0.12, 4), color: WHITE, tint: 1, matrix: tr(0.58, 1.66, z * 2.2, z * 6, 0, 0.6) });
    }
    for (const [x, z] of [[0.3, 0.1], [0.3, -0.1], [-0.32, 0.1], [-0.32, -0.1]]) parts.push({ geo: new THREE.BoxGeometry(0.07, 0.8, 0.07), color: WHITE, tint: 1, matrix: tr(x, 0.4, z) });
    return merge(parts);
  }

  // Héron cendré, immobile au bord de l'eau.
  function heron() {
    const G = '#a9b0ba', D = '#2d2a33';
    return merge([
      { geo: sphere(1, 8, 6), color: G, matrix: tr(0, 1.0, 0, 0, 0, -0.5, 0.42, 0.22, 0.2) },
      { geo: new THREE.CylinderGeometry(0.04, 0.05, 0.55, 5), color: '#e9ecef', matrix: tr(0.3, 1.33, 0, 0, 0, -0.35) },
      { geo: sphere(0.08, 6, 5), color: '#f2f3f5', matrix: tr(0.4, 1.6, 0) },
      { geo: new THREE.ConeGeometry(0.03, 0.3, 4), color: '#e8b830', matrix: tr(0.6, 1.58, 0, 0, 0, -Math.PI / 2 + 0.1) },
      { geo: new THREE.BoxGeometry(0.2, 0.02, 0.02), color: D, matrix: tr(0.32, 1.66, 0, 0, 0, 0.4) },
      { geo: new THREE.CylinderGeometry(0.018, 0.018, 0.85, 3), color: '#8a7a50', matrix: tr(0.04, 0.43, 0.06) },
      { geo: new THREE.CylinderGeometry(0.018, 0.018, 0.85, 3), color: '#8a7a50', matrix: tr(-0.04, 0.43, -0.06) }
    ]);
  }

  // Pool d'instances avec allocation / libération de cases (pour le streaming par tuiles).
  class InstancePool {
    constructor(scene, geo, opts) {
      const cap = opts.capacity;
      this.capacity = cap;
      this.matrixAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      this.matrixAttr.setUsage(THREE.DynamicDrawUsage);
      this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      this.colorAttr.setUsage(THREE.DynamicDrawUsage);
      const material = instancedMat({ sway: opts.sway || 0, bounce: opts.bounce || 0, people: opts.people });
      this.mesh = new THREE.InstancedMesh(geo, material, cap);
      this.mesh.instanceMatrix = this.matrixAttr;
      this.mesh.instanceColor = this.colorAttr;
      this.mesh.frustumCulled = false;
      this.mesh.castShadow = !!opts.castShadow;
      this.mesh.receiveShadow = opts.receiveShadow !== false;
      this.mesh.count = 0;
      this.mesh.visible = false;
      scene.add(this.mesh);
      if (opts.outline) {
        computeOutlineNormals(geo);
        this.outline = new THREE.InstancedMesh(geo, outlineMat({ width: opts.outlineWidth || 1, sway: opts.sway || 0, bounce: opts.bounce || 0, people: opts.people, maxW: opts.maxW || 0.5 }), cap);
        this.outline.instanceMatrix = this.matrixAttr;
        this.outline.frustumCulled = false;
        this.outline.count = 0;
        this.outline.visible = false;
        scene.add(this.outline);
      }
      this.used = new Uint8Array(cap);
      this.free = new Int32Array(cap);
      for (let i = 0; i < cap; i++) this.free[i] = cap - 1 - i;
      this.top = cap;
      this.high = 0;
      this.dirty = false;
      this.scene = scene;
    }

    alloc() {
      if (this.top === 0) return -1;
      const i = this.free[--this.top];
      this.used[i] = 1;
      if (i + 1 > this.high) this.high = i + 1;
      return i;
    }

    set(i, matrix, color) {
      matrix.toArray(this.matrixAttr.array, i * 16);
      if (color) color.toArray(this.colorAttr.array, i * 3);
      this.dirty = true;
    }

    release(i) {
      if (!this.used[i]) return;
      this.used[i] = 0;
      this.matrixAttr.array.fill(0, i * 16, i * 16 + 16);
      this.free[this.top++] = i;
      this.dirty = true;
    }

    flush() {
      if (!this.dirty) return;
      while (this.high > 0 && !this.used[this.high - 1]) this.high--;
      this.mesh.count = this.high;
      if (this.outline) this.outline.count = this.high;
      this.matrixAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.dirty = false;
      // pas d'appel de dessin pour un pool vide
      this.mesh.visible = this.high > 0;
      if (this.outline) this.outline.visible = this.high > 0;
    }

    dispose() {
      this.scene.remove(this.mesh);
      this.mesh.material.dispose();
      if (this.outline) this.scene.remove(this.outline);
    }
  }

  let geoCache = null;
  function geometries() {
    if (!geoCache) {
      geoCache = {
        conifer: conifer(), deciduous: deciduous(), poplar: poplar(), bush: bush(), rock: rock(),
        grass: grass(), flowers: flowers(), hay: hay(), cow: cow(), spectator: spectator(),
        vine: vine(), cypress: cypress(), olive: olive(), pine: umbrellaPine(), birch: birch(), willow: willow(),
        reeds: reeds(), heather: heather(), lavender: lavenderRow(), sunflower: sunflowerRow(), pumpkin: pumpkin(),
        horse: horse(), sheep: sheep(), ibex: ibex(), marmot: marmot(), deer: deer(), heron: heron()
      };
    }
    return geoCache;
  }

  B3D.props = { geometries, fruitTree, InstancePool };
})(typeof window !== 'undefined' ? window : globalThis);
