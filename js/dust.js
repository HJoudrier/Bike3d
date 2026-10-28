/* Bike3D — nuages de poussière soulevés par les roues sur les chemins blancs, le gravier, la terre et les pavés secs (portions de
   revêtement de PaceYourRide) ou le bas-côté : des boules cartoon qui naissent au contact de la roue arrière, montent, gonflent,
   dérivent avec le vent et s'effacent. Plus le revêtement est poussiéreux et plus on roule vite, plus le nuage est épais ; la caravane
   (voitures, motos) en soulève davantage. Rien sur une route mouillée ou enneigée. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { clamp } = B3D.util;

  const CAP = { low: 700, medium: 1400, high: 2200 }; // particules au plus, selon la qualité
  const NEAR = 110;                                    // m : on n'émet que près de la caméra

  function material() {
    return new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uLight: { value: 1 } },
      vertexShader: [
        'attribute vec3 aColor; attribute float aSize; attribute float aAlpha;',
        'uniform float uScale;',
        'varying vec3 vColor; varying float vAlpha;',
        'void main(){',
        '  vColor = aColor; vAlpha = aAlpha;',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  gl_PointSize = clamp(aSize * uScale / max(0.5, -mv.z), 1.0, 500.0);',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform float uLight;',
        'varying vec3 vColor; varying float vAlpha;',
        'void main(){',
        '  vec2 c = gl_PointCoord - 0.5;',
        '  float r = length(c) * 2.0;',
        '  if (r > 1.0) discard;',
        // boule de poussière cartoon : un peu plus claire en haut, ombrée en bas, bord très doux
        '  float hl = 1.0 - smoothstep(0.0, 0.6, length(c - vec2(-0.12, -0.16)) * 2.0);',
        '  float sh = smoothstep(0.25, 0.9, length(c - vec2(-0.08, -0.12)) * 2.0);',
        '  vec3 col = vColor * mix(1.0, 0.82, sh) + 0.12 * hl;',
        '  float a = vAlpha * (1.0 - smoothstep(0.62, 1.0, r));',
        '  gl_FragColor = vec4(col * uLight, a);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false
    });
  }

  class Dust {
    constructor(scene, quality) {
      this.scene = scene;
      const n = this.cap = CAP[quality] || CAP.medium;
      // particules : position, vitesse, âge, durée de vie, tailles de départ et d'arrivée, couleur, opacité maximale
      this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
      this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
      this.age = new Float32Array(n); this.life = new Float32Array(n);
      this.s0 = new Float32Array(n); this.s1 = new Float32Array(n); this.a0 = new Float32Array(n);
      this.cr = new Float32Array(n); this.cg = new Float32Array(n); this.cb = new Float32Array(n);
      this.count = 0;
      const g = new THREE.BufferGeometry();
      this.aPos = new Float32Array(n * 3); this.aCol = new Float32Array(n * 3); this.aSize = new Float32Array(n); this.aAlpha = new Float32Array(n);
      g.setAttribute('position', new THREE.BufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aColor', new THREE.BufferAttribute(this.aCol, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
      g.setDrawRange(0, 0);
      this.points = new THREE.Points(g, material());
      this.points.frustumCulled = false;
      this.points.renderOrder = 5;
      scene.add(this.points);
      this._c = new THREE.Color();
      this._cam = new THREE.Vector3();
    }

    /**
     * Source de poussière : une roue (ou un véhicule) au point (x, y, z) qui roule à la vitesse v (m/s) dans la direction (hx, hz) ;
     * jusqu'à 14 bouffées par seconde pour un vélo à 8 m/s et plus, 30 pour un véhicule, sur le revêtement le plus poussiéreux ;
     * sur un revêtement de poussière k (0–1) et de couleur color ; o garde le reste à émettre d'une image à l'autre (o.dustAcc) ;
     * big : véhicule (nuage plus gros et plus épais) ; dt : temps réel écoulé.
     */
    emit(o, x, y, z, hx, hz, v, k, color, dt, big) {
      if (!(k > 0) || v < 1.5) return;
      const cam = this._cam;
      if (Math.abs(x - cam.x) > NEAR || Math.abs(z - cam.z) > NEAR) return;
      // bouffées par seconde : avec la vitesse jusqu'à 8 m/s, et moins quand les particules manquent (gros peloton)
      const room = 1 - this.count / this.cap;
      const rate = (big ? 30 : 14) * k * clamp((v - 1.5) / 6.5, 0, 1) * clamp(room * 2, 0, 1);
      o.dustAcc = (o.dustAcc || 0) + rate * dt;
      const c = this._c.set(color);
      while (o.dustAcc >= 1 && this.count < this.cap) {
        o.dustAcc -= 1;
        const i = this.count++;
        const r = Math.random(), side = (Math.random() - 0.5) * (big ? 1.6 : 0.35);
        // derrière la roue, la poussière part en arrière et sur les côtés, puis monte doucement
        this.px[i] = x - hx * (0.1 + 0.3 * r) - hz * side; this.py[i] = y + 0.08; this.pz[i] = z - hz * (0.1 + 0.3 * r) + hx * side;
        const back = v * (0.08 + 0.12 * Math.random());
        this.vx[i] = -hx * back + (Math.random() - 0.5) * 0.9; this.vz[i] = -hz * back + (Math.random() - 0.5) * 0.9;
        this.vy[i] = 0.45 + Math.random() * 0.7 + (big ? 0.5 : 0);
        this.age[i] = 0;
        // le nuage traîne derrière le groupe quelques secondes, gonfle et monte à hauteur des coureurs
        this.life[i] = (big ? 3.5 : 2.6) + Math.random() * (big ? 2 : 1.6);
        this.s0[i] = big ? 0.7 : 0.3 + 0.15 * Math.random();
        this.s1[i] = ((big ? 4.2 : 2.2) + Math.random() * (big ? 2 : 1.3)) * (0.6 + 0.4 * k);
        this.a0[i] = (big ? 0.6 : 0.5) * (0.5 + 0.5 * k);
        const sh = 0.94 + 0.12 * Math.random();
        this.cr[i] = c.r * sh; this.cg[i] = c.g * sh; this.cb[i] = c.b * sh;
      }
    }

    // dt : temps réel ; wind : {x, z} (m/s, sens où il souffle) ; light : luminosité du jour (0–1) ; camera : pour la taille à l'écran
    update(dt, wind, light, camera) {
      const n0 = this.count, wx = wind ? wind.x * 0.55 : 0, wz = wind ? wind.z * 0.55 : 0;
      let n = 0;
      for (let i = 0; i < n0; i++) {
        const age = this.age[i] + dt;
        if (age >= this.life[i]) continue;
        // freinée par l'air, emportée par le vent, elle retombe à peine
        const f = Math.exp(-dt * 1.6);
        const vx = (this.vx[i] - wx) * f + wx, vz = (this.vz[i] - wz) * f + wz, vy = this.vy[i] * Math.exp(-dt * 0.9);
        if (n !== i) {
          this.s0[n] = this.s0[i]; this.s1[n] = this.s1[i]; this.a0[n] = this.a0[i]; this.life[n] = this.life[i];
          this.cr[n] = this.cr[i]; this.cg[n] = this.cg[i]; this.cb[n] = this.cb[i];
        }
        this.px[n] = this.px[i] + vx * dt; this.py[n] = this.py[i] + vy * dt; this.pz[n] = this.pz[i] + vz * dt;
        this.vx[n] = vx; this.vy[n] = vy; this.vz[n] = vz; this.age[n] = age;
        const u = age / this.life[n];
        this.aPos[n * 3] = this.px[n]; this.aPos[n * 3 + 1] = this.py[n]; this.aPos[n * 3 + 2] = this.pz[n];
        this.aCol[n * 3] = this.cr[n]; this.aCol[n * 3 + 1] = this.cg[n]; this.aCol[n * 3 + 2] = this.cb[n];
        this.aSize[n] = this.s0[n] + (this.s1[n] - this.s0[n]) * Math.sqrt(u);
        this.aAlpha[n] = this.a0[n] * Math.min(1, age * 6) * (1 - u) * (1 - u * 0.4);
        n++;
      }
      this.count = n;
      const g = this.points.geometry;
      g.setDrawRange(0, n);
      for (const k of ['position', 'aColor', 'aSize', 'aAlpha']) g.attributes[k].needsUpdate = true;
      const U = this.points.material.uniforms;
      U.uLight.value = light === undefined ? 1 : light;
      if (this._pointScale) U.uScale.value = this._pointScale;
      else if (camera) U.uScale.value = (this._vh || 600) * 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      if (camera) camera.getWorldPosition(this._cam);
    }

    setViewHeight(h) { this._vh = h; }
    // en réalité virtuelle : taille des particules calculée pour l'écran du casque (null = écran normal)
    setPointScale(v) { this._pointScale = v; }

    dispose() {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      this.points.material.dispose();
    }
  }

  B3D.Dust = Dust;
})(window);
