/* Bike3D — pluie de confettis à l'arrivée. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};

  const COLORS = ['#e2463a', '#ffd23a', '#3d7be0', '#4cc35a', '#ff7aa8', '#ffffff', '#9b6bff'];

  class Confetti {
    constructor(scene, count) {
      this.n = count || 500;
      this.scene = scene;
      const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, fog: false });
      this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.16, 0.1), mat, this.n);
      this.mesh.frustumCulled = false;
      this.mesh.count = 0;
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const c = new THREE.Color();
      for (let i = 0; i < this.n; i++) this.mesh.setColorAt(i, c.set(COLORS[i % COLORS.length]));
      this.p = new Float32Array(this.n * 3);
      this.v = new Float32Array(this.n * 3);
      this.r = new Float32Array(this.n * 3);
      this.w = new Float32Array(this.n * 3);
      this.next = 0;
      this.active = 0;
      this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._s = new THREE.Vector3(1, 1, 1); this._v = new THREE.Vector3();
      scene.add(this.mesh);
    }

    // Lance count confettis depuis un point, vers le haut.
    burst(x, y, z, count) {
      for (let k = 0; k < count; k++) {
        const i = this.next;
        this.next = (this.next + 1) % this.n;
        this.p[i * 3] = x + (Math.random() - 0.5) * 0.6;
        this.p[i * 3 + 1] = y;
        this.p[i * 3 + 2] = z + (Math.random() - 0.5) * 0.6;
        const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 4.5;
        this.v[i * 3] = Math.cos(a) * sp;
        this.v[i * 3 + 1] = 5 + Math.random() * 7;
        this.v[i * 3 + 2] = Math.sin(a) * sp;
        for (let q = 0; q < 3; q++) { this.r[i * 3 + q] = Math.random() * 6; this.w[i * 3 + q] = (Math.random() - 0.5) * 14; }
      }
      this.active = Math.min(this.n, this.active + count);
      this.mesh.count = this.active;
      this.time = 0;
    }

    update(dt) {
      if (!this.active) return;
      this.time += dt;
      const drag = Math.exp(-dt * 1.6);
      for (let i = 0; i < this.active; i++) {
        const o = i * 3;
        this.v[o + 1] -= 6 * dt;
        for (let q = 0; q < 3; q++) {
          this.v[o + q] *= drag;
          this.p[o + q] += this.v[o + q] * dt;
          this.r[o + q] += this.w[o + q] * dt;
        }
        // flottement
        this.p[o] += Math.sin(this.time * 3 + i) * 0.4 * dt;
        this._e.set(this.r[o], this.r[o + 1], this.r[o + 2]);
        this._q.setFromEuler(this._e);
        this._m.compose(this._v.set(this.p[o], this.p[o + 1], this.p[o + 2]), this._q, this._s);
        this.mesh.setMatrixAt(i, this._m);
      }
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.time > 12) { this.active = 0; this.mesh.count = 0; }
    }

    dispose() {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
  }

  B3D.Confetti = Confetti;
})(typeof window !== 'undefined' ? window : globalThis);
