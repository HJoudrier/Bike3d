/* Bike3D — la foule des cols hors catégorie : des spectateurs massés sur la chaussée qui ne laissent
   qu'un couloir et s'écartent juste avant le passage des coureurs, des drapeaux et des fumigènes colorés. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { merge, tr, instancedMat, outlineMat, computeOutlineNormals } = B3D.toon;
  const { mulberry32, clamp, lerp } = B3D.util;

  const SHIRTS = ['#e2463a', '#f2c230', '#3d7be0', '#5cc85a', '#ffffff', '#ff7aa8', '#9b6bff', '#ff9a2b', '#1d1a2b', '#ff5c38', '#2fd0c0'];
  const SMOKE = ['#ff3b3b', '#ff8a1d', '#ffe14d', '#3dd1ff', '#ff5ec4', '#62e86b', '#b07bff'];
  const FLAGS = ['#e2463a', '#3d7be0', '#f2c230', '#5cc85a', '#ffffff', '#ff9a2b', '#1d1a2b'];
  const WINDOW = 260; // on n'affiche que les spectateurs proches de la caméra (m le long de la route)
  const CAP = 2600, FLAG_CAP = 360, PCAP = 900;

  // drapeau : mât et tissu (tissu teinté par instance), tenu à bout de bras
  function flagGeometry() {
    return merge([
      { geo: new THREE.CylinderGeometry(0.025, 0.025, 1.9, 5), color: '#8a6a45', matrix: tr(0, 0.95, 0) },
      { geo: new THREE.BoxGeometry(0.02, 0.55, 0.85), color: '#ffffff', tint: 1, matrix: tr(0, 1.6, 0.44) }
    ]);
  }

  function smokeMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: [
        'attribute vec3 aColor; attribute float aSize; attribute float aAlpha;',
        'uniform float uScale;',
        'varying vec3 vColor; varying float vAlpha;',
        'void main(){',
        '  vColor = aColor; vAlpha = aAlpha;',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  gl_PointSize = clamp(aSize * uScale / max(0.5, -mv.z), 1.0, 600.0);',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vColor; varying float vAlpha;',
        'void main(){',
        '  vec2 c = gl_PointCoord - 0.5;',
        '  float r = length(c) * 2.0;',
        '  if (r > 1.0) discard;',
        // boule de fumée cartoon : reflet rond en haut à gauche, ombre en bas, bord doux
        '  float hl = step(length(c - vec2(-0.13, -0.15)) * 2.0, 0.55);',
        '  float sh = step(0.42, length(c - vec2(-0.1, -0.12)) * 2.0);',
        '  vec3 col = vColor * mix(1.0, 0.8, sh);',
        '  col = mix(col, mix(vColor, vec3(1.0), 0.35), hl);',
        '  float a = vAlpha * (1.0 - smoothstep(0.7, 1.0, r));',
        '  gl_FragColor = vec4(col, a);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false
    });
  }

  class HCCrowd {
    constructor(scene, route, L) {
      this.scene = scene;
      this.route = route;
      this.L = L;
      this.fans = [];
      this.emitters = [];
      this._plan();
      if (!this.fans.length) return;
      this._build();
    }

    get active() { return this.fans.length > 0; }

    _plan() {
      const route = this.route, L = this.L, half = L.roadHalf;
      const rnd = mulberry32(L.seed ^ 0x4c0f);
      const o = {};
      L.crowd = L.crowd || new Float32Array(route.n);
      this.zones = [];
      for (const c of route.climbs) {
        if (c.cat !== 0) continue;
        const s1 = route.sStart + c.d1, s0 = Math.max(route.sStart + c.d0, s1 - Math.min(4500, c.length * 0.75));
        this.zones.push([s0, s1]);
        let s = s0;
        while (s < s1 - 150) {
          const len = 120 + rnd() * 170;
          const hot = rnd() < 0.72 || s > s1 - 1300;
          if (hot) this._spot(s, Math.min(s + len, s1 - 100), rnd, o);
          s += len + (s > s1 - 1300 ? 20 : 60 + rnd() * 200);
        }
      }
      this.fans.sort((a, b) => a.s - b.s);
      this.emitters.sort((a, b) => a.s - b.s);
    }

    // un « point chaud » : deux rangs serrés, le premier sur la chaussée
    _spot(a, b, rnd, o) {
      const route = this.route, L = this.L, half = L.roadHalf;
      let nextSmoke = a + 20 + rnd() * 40;
      for (const side of [-1, 1]) {
        for (let s = a; s < b; s += 0.7 + rnd() * 0.5) {
          const q = route.sample(s, o);
          const i = q.i;
          if (L.bridgeMask[i] || route.dup[i] || L.villageW[i] > 0.05) continue;
          // au-dessus d'un ravin, on se serre contre la glissière, sur la chaussée, sans rangs derrière
          const edge = (side < 0 ? L.railL[i] : L.railR[i]) || (side < 0 ? L.dropL[i] : L.dropR[i]) > 1.6;
          const rows = edge ? 1 : 1 + (rnd() < 0.7 ? 1 : 0) + (rnd() < 0.3 ? 1 : 0);
          for (let row = 0; row < rows; row++) {
            const front = row === 0;
            const inLat = front ? half - 1.0 - rnd() * 1.1 : half + 0.8 + row * 0.85 + rnd() * 0.4;
            const outLat = front ? (edge ? half - 0.28 : half + 0.3 + rnd() * 0.45) : inLat + 0.25;
            const fan = {
              s: s + (rnd() - 0.5) * 0.4, side, inLat: side * inLat, outLat: side * outLat, k: 0, front,
              color: new THREE.Color(SHIRTS[Math.floor(rnd() * SHIRTS.length)]), phase: rnd() * 100,
              scale: rnd() < 0.12 ? 0.75 + rnd() * 0.1 : 0.9 + rnd() * 0.2, turn: (rnd() - 0.5) * 0.7,
              flag: rnd() < 0.1 ? new THREE.Color(FLAGS[Math.floor(rnd() * FLAGS.length)]) : null
            };
            this.fans.push(fan);
            L.crowd[i] += 1;
            // fumigène tenu par un spectateur du premier rang
            if (front && s > nextSmoke) {
              nextSmoke = s + 55 + rnd() * 90;
              this.emitters.push({ s: fan.s, fan, color: new THREE.Color(SMOKE[Math.floor(rnd() * SMOKE.length)]), acc: rnd(), flicker: rnd() * 10 });
            }
          }
        }
      }
    }

    _build() {
      // copie de la géométrie des spectateurs, avec en plus la phase des gestes par instance
      const geo = this.geo = B3D.props.geometries().spectator.clone();
      computeOutlineNormals(geo);
      const mk = (g, cap, opts, outlineW) => {
        const mesh = new THREE.InstancedMesh(g, instancedMat(opts), cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.count = 0;
        this.scene.add(mesh);
        const ol = new THREE.InstancedMesh(g, outlineMat(Object.assign({ width: outlineW, maxW: 0.5 }, opts)), cap);
        ol.instanceMatrix = mesh.instanceMatrix;
        ol.frustumCulled = false;
        ol.count = 0;
        this.scene.add(ol);
        return { mesh, ol };
      };
      // la phase des gestes est un attribut d'instance : elle ne change pas quand le spectateur se déplace
      this.phase = new THREE.InstancedBufferAttribute(new Float32Array(CAP), 1);
      this.phase.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aPhase', this.phase);
      this.people = mk(geo, CAP, { people: true, peoplePhase: true }, 1);
      const fg = flagGeometry();
      computeOutlineNormals(fg);
      this.flags = mk(fg, FLAG_CAP, { sway: 0.05 }, 0.8);
      // fumigènes
      const pg = new THREE.BufferGeometry();
      this.pPos = new Float32Array(PCAP * 3);
      this.pCol = new Float32Array(PCAP * 3);
      this.pSize = new Float32Array(PCAP);
      this.pAlpha = new Float32Array(PCAP);
      pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
      pg.setAttribute('aColor', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
      pg.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
      pg.setAttribute('aAlpha', new THREE.BufferAttribute(this.pAlpha, 1).setUsage(THREE.DynamicDrawUsage));
      pg.setDrawRange(0, 0);
      this.smoke = new THREE.Points(pg, smokeMaterial());
      this.smoke.frustumCulled = false;
      this.smoke.renderOrder = 5;
      this.scene.add(this.smoke);
      this.parts = [];
      this._t = 0;
      this.rnd = mulberry32(this.L.seed ^ 0x5a0e);
    }

    // premier indice de fan dont s >= x (tableau trié)
    _lower(arr, x) {
      let lo = 0, hi = arr.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].s < x) lo = m + 1; else hi = m; }
      return lo;
    }

    // dt réel ; dtRace en temps de course ; focusS : abscisse autour de laquelle on affiche ;
    // riders : abscisses des coureurs (le public s'écarte à leur approche)
    update(dt, camera, riders, focusS, dtRace) {
      if (!this.fans.length) return;
      const route = this.route, L = this.L;
      const hdt = dtRace === undefined ? dt : dtRace;
      const rs = this._rs || (this._rs = []);
      rs.length = 0;
      for (const x of riders) rs.push(x);
      rs.sort((a, b) => a - b);
      const q = this._q || (this._q = {});
      const m4 = new THREE.Matrix4(), quat = new THREE.Quaternion(), eul = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
      const i0 = this._lower(this.fans, focusS - WINDOW * 0.45), i1 = this._lower(this.fans, focusS + WINDOW);
      let n = 0, nf = 0;
      const ease = 1 - Math.exp(-hdt * 3.5);
      let j = 0;
      for (let i = i0; i < i1 && n < CAP; i++) {
        const f = this.fans[i];
        // coureur le plus proche qui arrive (ou vient de passer) : on s'écarte de 34 m avant à 8 m après
        while (j < rs.length && rs[j] <= f.s + 8) j++;
        const near = j > 0 ? rs[j - 1] : -1e9;
        const d = f.s - near;
        const kT = d < -8 ? 0 : d < 16 ? 1 : d < 34 ? (34 - d) / 18 : 0;
        f.k += (kT - f.k) * (f.front ? ease : 0);
        const lat = lerp(f.inLat, f.outLat, f.k);
        route.sample(f.s, q);
        const x = q.x + q.rx * lat, z = q.z + q.rz * lat;
        const onRoad = Math.abs(lat) < L.roadHalf + 0.2;
        const y = onRoad ? q.y : L.heightAt(x, z);
        // tourné vers la route, un peu vers les coureurs qui arrivent
        const face = Math.atan2(-q.rx * f.side, -q.rz * f.side) + f.turn * 0.6 + (kT > 0 && kT < 1 ? -f.side * 0.4 : 0);
        eul.set(0, face, 0);
        quat.setFromEuler(eul);
        m4.compose(pos.set(x, y, z), quat, sc.set(f.scale, f.scale, f.scale));
        this.people.mesh.setMatrixAt(n, m4);
        this.people.mesh.setColorAt(n, f.color);
        this.phase.array[n] = f.phase;
        f.pos = f.pos || new THREE.Vector3();
        f.pos.set(x, y, z);
        f.face = face;
        n++;
        if (f.flag && nf < FLAG_CAP) {
          // drapeau brandi au-dessus de la tête
          const fx = x + Math.cos(face) * 0.25 * f.scale, fz = z - Math.sin(face) * 0.25 * f.scale;
          eul.set(0, face + Math.PI / 2, 0.15 * Math.sin(this._t * 3 + f.phase));
          quat.setFromEuler(eul);
          m4.compose(pos.set(fx, y + 0.9 * f.scale, fz), quat, sc.set(1, 1, 1));
          this.flags.mesh.setMatrixAt(nf, m4);
          this.flags.mesh.setColorAt(nf, f.flag);
          nf++;
        }
      }
      for (const [M, c] of [[this.people, n], [this.flags, nf]]) {
        M.mesh.count = M.ol.count = c;
        M.mesh.visible = M.ol.visible = c > 0;
        if (c) { M.mesh.instanceMatrix.needsUpdate = true; M.mesh.instanceColor.needsUpdate = true; }
      }
      this.phase.needsUpdate = true;
      this._t = (this._t || 0) + dt;
      this._updateSmoke(dt, camera, focusS);
    }

    _updateSmoke(dt, camera, focusS) {
      const rnd = this.rnd, P = this.parts;
      // émission par les fumigènes proches
      const e0 = this._lower(this.emitters, focusS - 120), e1 = this._lower(this.emitters, focusS + WINDOW);
      for (let i = e0; i < e1; i++) {
        const em = this.emitters[i], f = em.fan;
        if (!f.pos) continue;
        const hx = f.pos.x + Math.cos(f.face) * 0.3, hz = f.pos.z - Math.sin(f.face) * 0.3, hy = f.pos.y + 1.9 * f.scale;
        em.acc += dt * 9;
        while (em.acc >= 1 && P.length < PCAP - 40) {
          em.acc -= 1;
          P.push({ x: hx, y: hy, z: hz, vx: (rnd() - 0.5) * 0.8 + 0.5, vy: 0.7 + rnd() * 0.6, vz: (rnd() - 0.5) * 0.8 + 0.3, t: 0, life: 3 + rnd() * 2, c: em.color, s0: 0.35 + rnd() * 0.2, s1: 2.6 + rnd() * 1.6 });
        }
        em.hand = em.hand || new THREE.Vector3();
        em.hand.set(hx, hy, hz);
      }
      let n = 0;
      for (let i = P.length - 1; i >= 0; i--) {
        const p = P[i];
        p.t += dt;
        if (p.t > p.life) { P[i] = P[P.length - 1]; P.pop(); continue; }
        p.vy *= Math.exp(-dt * 0.5);
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      }
      const flick = this._t || 0;
      for (const p of P) {
        const u = p.t / p.life;
        this.pPos[n * 3] = p.x; this.pPos[n * 3 + 1] = p.y; this.pPos[n * 3 + 2] = p.z;
        this.pCol[n * 3] = p.c.r; this.pCol[n * 3 + 1] = p.c.g; this.pCol[n * 3 + 2] = p.c.b;
        this.pSize[n] = lerp(p.s0, p.s1, Math.sqrt(u));
        this.pAlpha[n] = 0.85 * (1 - u) * Math.min(1, p.t * 4);
        n++;
      }
      // la flamme rouge vif au bout du fumigène
      for (let i = e0; i < e1 && n < PCAP; i++) {
        const em = this.emitters[i];
        if (!em.hand) continue;
        this.pPos[n * 3] = em.hand.x; this.pPos[n * 3 + 1] = em.hand.y; this.pPos[n * 3 + 2] = em.hand.z;
        this.pCol[n * 3] = 1; this.pCol[n * 3 + 1] = 0.55 + 0.25 * Math.sin(flick * 23 + em.flicker); this.pCol[n * 3 + 2] = 0.3;
        this.pSize[n] = 0.32 + 0.08 * Math.sin(flick * 31 + em.flicker);
        this.pAlpha[n] = 1;
        n++;
      }
      const g = this.smoke.geometry;
      g.setDrawRange(0, n);
      for (const k of ['position', 'aColor', 'aSize', 'aAlpha']) g.attributes[k].needsUpdate = true;
      if (this._pointScale) this.smoke.material.uniforms.uScale.value = this._pointScale;
      else if (camera) {
        const h = (this._vh || 600);
        this.smoke.material.uniforms.uScale.value = h * 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      }
    }

    setViewHeight(h) { this._vh = h; }

    // en réalité virtuelle : taille des particules calculée pour l'écran du casque (null = écran normal)
    setPointScale(v) { this._pointScale = v; }

    dispose() {
      if (!this.fans.length) return;
      for (const M of [this.people, this.flags]) { this.scene.remove(M.mesh); this.scene.remove(M.ol); M.mesh.material.dispose(); }
      this.flags.mesh.geometry.dispose();
      this.geo.dispose();
      this.scene.remove(this.smoke);
      this.smoke.geometry.dispose();
      this.smoke.material.dispose();
    }
  }

  B3D.HCCrowd = HCCrowd;
})(typeof window !== 'undefined' ? window : globalThis);
