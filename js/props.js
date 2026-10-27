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

  function spectator() {
    const SK = '#f1c7a0';
    return merge([
      { geo: new THREE.CylinderGeometry(0.07, 0.07, 0.8, 5), color: '#2d3346', matrix: tr(0.1, 0.4, 0) },
      { geo: new THREE.CylinderGeometry(0.07, 0.07, 0.8, 5), color: '#2d3346', matrix: tr(-0.1, 0.4, 0) },
      { geo: new THREE.CapsuleGeometry(0.23, 0.42, 3, 8), color: WHITE, tint: 1, matrix: tr(0, 1.08, 0) },
      { geo: sphere(0.19, 8, 6), color: SK, matrix: tr(0, 1.63, 0) },
      { geo: new THREE.CylinderGeometry(0.055, 0.055, 0.6, 5), color: WHITE, tint: 1, matrix: tr(0.33, 1.55, 0, 0, 0, -0.45) },
      { geo: new THREE.CylinderGeometry(0.055, 0.055, 0.6, 5), color: WHITE, tint: 1, matrix: tr(-0.33, 1.55, 0, 0, 0, 0.45) },
      { geo: sphere(0.08, 6, 4), color: SK, matrix: tr(0.46, 1.83, 0) },
      { geo: sphere(0.08, 6, 4), color: SK, matrix: tr(-0.46, 1.83, 0) },
      { geo: sphere(0.035, 6, 4), color: '#1d1a2b', matrix: tr(0.07, 1.67, 0.165) },
      { geo: sphere(0.035, 6, 4), color: '#1d1a2b', matrix: tr(-0.07, 1.67, 0.165) },
      { geo: new THREE.TorusGeometry(0.06, 0.012, 4, 8, Math.PI), color: '#8a2b2b', matrix: tr(0, 1.585, 0.16, 0, 0, Math.PI) },
      { geo: new THREE.SphereGeometry(0.2, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), color: WHITE, tint: 1, matrix: tr(0, 1.68, -0.01) },
      { geo: new THREE.BoxGeometry(0.22, 0.03, 0.14), color: WHITE, tint: 1, matrix: tr(0, 1.69, 0.2) }
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
      const material = instancedMat({ sway: opts.sway || 0, bounce: opts.bounce || 0 });
      this.mesh = new THREE.InstancedMesh(geo, material, cap);
      this.mesh.instanceMatrix = this.matrixAttr;
      this.mesh.instanceColor = this.colorAttr;
      this.mesh.frustumCulled = false;
      this.mesh.castShadow = !!opts.castShadow;
      this.mesh.receiveShadow = opts.receiveShadow !== false;
      this.mesh.count = 0;
      scene.add(this.mesh);
      if (opts.outline) {
        computeOutlineNormals(geo);
        this.outline = new THREE.InstancedMesh(geo, outlineMat({ width: opts.outlineWidth || 1, sway: opts.sway || 0, bounce: opts.bounce || 0, maxW: opts.maxW || 0.5 }), cap);
        this.outline.instanceMatrix = this.matrixAttr;
        this.outline.frustumCulled = false;
        this.outline.count = 0;
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
        grass: grass(), flowers: flowers(), hay: hay(), cow: cow(), spectator: spectator()
      };
    }
    return geoCache;
  }

  B3D.props = { geometries, InstancePool };
})(typeof window !== 'undefined' ? window : globalThis);
