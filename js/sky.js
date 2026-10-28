/* Bike3D — ciel dégradé, soleil, nuages cartoon et montagnes lointaines. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { mulberry32, Noise2D, clamp } = B3D.util;

  class Sky {
    constructor(scene, L) {
      this.scene = scene;
      const amb = L.amb;
      this.group = new THREE.Group();
      this.group.name = 'sky';
      scene.add(this.group);

      const sunEl = amb.sun.elev * Math.PI / 180, sunAz = amb.sun.azim * Math.PI / 180;
      this.sunDir = new THREE.Vector3(Math.cos(sunEl) * Math.sin(sunAz), Math.sin(sunEl), Math.cos(sunEl) * Math.cos(sunAz)).normalize();

      // --- dôme
      const domeMat = new THREE.ShaderMaterial({
        uniforms: {
          uTop: { value: new THREE.Color(amb.sky.top) },
          uHorizon: { value: new THREE.Color(amb.sky.horizon) },
          uGround: { value: new THREE.Color(amb.sky.fog) },
          uSunDir: { value: this.sunDir },
          uSunColor: { value: new THREE.Color('#fff8e0') }
        },
        vertexShader: [
          'varying vec3 vDir;',
          'void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
        ].join('\n'),
        fragmentShader: [
          'uniform vec3 uTop, uHorizon, uGround, uSunDir, uSunColor;',
          'varying vec3 vDir;',
          'void main() {',
          '  vec3 d = normalize(vDir);',
          '  float e = d.y;',
          '  vec3 c = e > 0.0 ? mix(uHorizon, uTop, smoothstep(0.0, 0.5, pow(e, 0.8))) : uGround;',
          '  float s = dot(d, normalize(uSunDir));',
          '  c = mix(c, mix(c, uSunColor, 0.35), smoothstep(0.985, 0.996, s));',
          '  c = mix(c, uSunColor, step(0.9985, s));',
          '  gl_FragColor = vec4(c, 1.0);',
          '  #include <colorspace_fragment>',
          '}'
        ].join('\n'),
        side: THREE.BackSide,
        depthWrite: false,
        fog: false
      });
      this.dome = new THREE.Mesh(new THREE.SphereGeometry(4500, 32, 16), domeMat);
      this.dome.renderOrder = -10;
      this.dome.frustumCulled = false;
      this.group.add(this.dome);

      // --- montagnes lointaines (silhouettes)
      let mAvg = 0;
      for (let k = 0; k < L.cM.length; k++) mAvg += L.cM[k];
      mAvg /= L.cM.length;
      this.mountains = new THREE.Group();
      const fogC = new THREE.Color(amb.sky.fog);
      const layers = [
        { r: 3900, amp: 120 + 900 * mAvg * mAvg, base: '#7d97b8', haze: 0.55, seed: 1 },
        { r: 3300, amp: 80 + 650 * mAvg * mAvg, base: '#6f8fa6', haze: 0.38, seed: 2 }
      ];
      for (const ly of layers) this.mountains.add(this._ring(ly, fogC, L.seed, mAvg));
      this.group.add(this.mountains);

      // --- nuages
      this.clouds = [];
      const rnd = mulberry32(L.seed ^ 0xc10d);
      const cloudMat = new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: B3D.toon.gradientMap(), emissive: new THREE.Color('#8fa4bf'), fog: false });
      const outline = B3D.toon.outlineMat({ color: '#5d6c8a', width: 1.2, minW: 0.5, maxW: 12 });
      outline.fog = false;
      const nClouds = 10 + Math.floor(rnd() * 10);
      for (let k = 0; k < nClouds; k++) {
        const parts = [];
        const nb = 4 + Math.floor(rnd() * 5);
        for (let b = 0; b < nb; b++) {
          const r = 40 + rnd() * 50;
          parts.push({ geo: new THREE.SphereGeometry(r, 12, 9), matrix: B3D.toon.tr((b - nb / 2) * 55 + rnd() * 20, rnd() * 25, (rnd() - 0.5) * 60, 0, 0, 0, 1, 0.7, 1) });
        }
        const geo = B3D.toon.merge(parts);
        B3D.toon.computeOutlineNormals(geo);
        const m = new THREE.Mesh(geo, cloudMat);
        const o = new THREE.Mesh(geo, outline);
        m.add(o);
        const ang = rnd() * Math.PI * 2, dist = 1400 + rnd() * 1800;
        m.position.set(Math.cos(ang) * dist, 380 + rnd() * 520, Math.sin(ang) * dist);
        m.rotation.y = rnd() * Math.PI;
        m.frustumCulled = false; o.frustumCulled = false;
        this.group.add(m);
        this.clouds.push(m);
      }
      this.wind = new THREE.Vector3(rnd() - 0.5, 0, rnd() - 0.5).normalize().multiplyScalar(6);
    }

    _ring(ly, fogC, seed, mAvg) {
      const SEG = 220;
      const noise = new Noise2D(seed + ly.seed * 101);
      const pos = [], col = [], idx = [];
      const base = new THREE.Color(ly.base).lerp(fogC, ly.haze);
      const snow = new THREE.Color('#ffffff').lerp(fogC, ly.haze * 0.6);
      const snowLine = 0.62;
      for (let k = 0; k <= SEG; k++) {
        const a = k / SEG * Math.PI * 2;
        const cx = Math.cos(a), cz = Math.sin(a);
        let h = 0.15 + 0.85 * noise.ridged(cx * 2.2 + 10, cz * 2.2 - 4, 4);
        h = Math.pow(clamp(h, 0, 1), 1.4);
        const top = -250 + ly.amp * (0.25 + h);
        const x = cx * ly.r, z = cz * ly.r;
        const peak = h > snowLine && mAvg > 0.45;
        pos.push(x, -900, z); col.push(base.r, base.g, base.b);
        const mid = peak ? top - ly.amp * 0.18 * (h - snowLine) / (1 - snowLine) - 25 : top;
        pos.push(x, mid, z); col.push(base.r, base.g, base.b);
        const tc = peak ? snow : base;
        pos.push(x, top, z); col.push(tc.r, tc.g, tc.b);
      }
      for (let k = 0; k < SEG; k++) {
        const a = k * 3, b = (k + 1) * 3;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
        idx.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, depthWrite: false }));
      m.renderOrder = -9;
      m.frustumCulled = false;
      return m;
    }

    update(camera, dt) {
      // position monde (en réalité virtuelle, la caméra est dans une nacelle)
      camera.getWorldPosition(this.group.position);
      for (const c of this.clouds) {
        c.position.x += this.wind.x * dt;
        c.position.z += this.wind.z * dt;
        const d = Math.hypot(c.position.x, c.position.z);
        if (d > 3400) { c.position.x *= -0.95; c.position.z *= -0.95; }
      }
    }

    dispose() {
      this.scene.remove(this.group);
      this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
  }

  B3D.Sky = Sky;
})(typeof window !== 'undefined' ? window : globalThis);
