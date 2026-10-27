/* Bike3D — cycliste cartoon et son vélo, animés (pédalage, roues, danseuse, position aéro). */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { mat, addOutline, textTexture } = B3D.toon;
  const { clamp, lerp } = B3D.util;

  const JERSEYS = {
    jaune: { name: 'Maillot jaune', base: '#ffd23a', accent: '#1d1a2b', style: 'plain' },
    pois: { name: 'Maillot à pois', base: '#ffffff', accent: '#e2463a', style: 'dots' },
    vert: { name: 'Maillot vert', base: '#4cc35a', accent: '#ffffff', style: 'plain' },
    arcenciel: { name: 'Champion du monde', base: '#ffffff', accent: '#000000', style: 'rainbow' },
    bleu: { name: 'Équipe bleue', base: '#3d7be0', accent: '#ffffff', style: 'stripe' }
  };

  const R = 0.34; // rayon de roue
  const UP = new THREE.Vector3(0, 1, 0);

  function jerseyTexture(j) {
    return textTexture((ctx, w, h) => {
      ctx.fillStyle = j.base;
      ctx.fillRect(0, 0, w, h);
      // texture plaquée sur un ellipsoïde : u = tour du buste, v = du bas (0) vers le haut (1)
      if (j.style === 'dots') {
        ctx.fillStyle = j.accent;
        for (let y = 16; y < h; y += 30) for (let x = ((y / 30) % 2) * 16 + 8; x < w; x += 32) { ctx.beginPath(); ctx.ellipse(x, y, 9, 8, 0, 0, Math.PI * 2); ctx.fill(); }
      } else if (j.style === 'rainbow') {
        const cols = ['#3d7be0', '#e2463a', '#1d1a2b', '#f2c230', '#4cc35a'];
        cols.forEach((c, k) => { ctx.fillStyle = c; ctx.fillRect(0, h * 0.42 + k * 10, w, 10); });
      } else if (j.style === 'stripe') {
        ctx.fillStyle = j.accent;
        ctx.fillRect(0, h * 0.42, w, 22);
      } else {
        ctx.fillStyle = j.accent;
        ctx.fillRect(0, h * 0.2, w, 10);
      }
    }, 256, 256);
  }

  class Cyclist {
    constructor(opts = {}) {
      this.jersey = JERSEYS[opts.jersey] || JERSEYS.jaune;
      this.bikeColor = opts.bikeColor || '#e2463a';
      this.root = new THREE.Group(); // positionné / orienté dans le monde
      this.body = new THREE.Group(); // inclinaison (danseuse)
      this.root.add(this.body);
      this.crank = 0;
      this.strokes = 0; // nombre de coups de pédale (un par demi-tour de pédalier)
      this.wheelAngle = 0;
      this.rock = 0;
      this.standT = 0;
      this.tuckT = 0;
      this.time = 0;
      this._v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      this._buildBike();
      this._buildRider();
      this.root.traverse((o) => { if (o.isMesh && !o.userData.isOutline) { o.castShadow = true; } });
    }

    // Cylindre entre deux points (statique)
    _tube(a, b, r, m, parent) {
      const len = a.distanceTo(b);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), m);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
      (parent || this.bikeGroup).add(mesh);
      addOutline(mesh, { width: 0.7, minW: 0.005, maxW: 0.03 });
      return mesh;
    }

    _buildBike() {
      const V = (x, y, z) => new THREE.Vector3(x, y, z);
      const frame = mat(this.bikeColor);
      const dark = mat('#26232f');
      const metal = mat('#c9ced8');
      const g = this.bikeGroup = new THREE.Group();
      this.body.add(g);
      const rearAxle = V(0, R, -0.5), frontAxle = V(0, R, 0.52);
      const BB = this.BB = V(0, 0.28, -0.08);
      const stTop = V(0, 0.815, -0.244), htTop = V(0, 0.86, 0.40), htBot = V(0, 0.70, 0.45);
      this._tube(BB, stTop, 0.022, frame);
      this._tube(stTop, htTop, 0.02, frame);
      this._tube(BB, htBot, 0.026, frame);
      this._tube(htBot, htTop, 0.028, frame);
      for (const sx of [-1, 1]) {
        this._tube(stTop, V(sx * 0.055, R, -0.5), 0.012, frame);
        this._tube(BB, V(sx * 0.055, R, -0.5), 0.014, frame);
        this._tube(V(sx * 0.04, 0.70, 0.45), V(sx * 0.05, R, 0.52), 0.014, frame);
      }
      // tige de selle + selle
      this._tube(stTop, V(0, 0.95, -0.287), 0.013, metal);
      const saddle = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), dark);
      saddle.scale.set(0.07, 0.03, 0.14);
      saddle.position.set(0, 0.965, -0.29);
      g.add(saddle);
      addOutline(saddle, { width: 0.7, minW: 0.004, maxW: 0.03 });
      // potence + cintre
      const stemEnd = V(0, 0.885, 0.5);
      this._tube(htTop, stemEnd, 0.016, dark);
      this._tube(V(-0.21, 0.885, 0.5), V(0.21, 0.885, 0.5), 0.013, dark);
      for (const sx of [-1, 1]) {
        this._tube(V(sx * 0.21, 0.885, 0.5), V(sx * 0.21, 0.9, 0.6), 0.013, dark);
        this._tube(V(sx * 0.21, 0.9, 0.6), V(sx * 0.21, 0.78, 0.6), 0.013, dark);
        this._tube(V(sx * 0.21, 0.78, 0.6), V(sx * 0.21, 0.78, 0.53), 0.013, dark);
        const hood = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.05, 0.06), dark);
        hood.position.set(sx * 0.21, 0.915, 0.585);
        g.add(hood);
      }
      // bidon
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 10), mat('#ffffff'));
      bottle.position.set(0, 0.47, 0.15);
      bottle.rotation.x = -1.05;
      g.add(bottle);
      addOutline(bottle, { width: 0.7, minW: 0.004, maxW: 0.03 });

      // roues
      this.wheels = [];
      for (const axle of [rearAxle, frontAxle]) {
        const w = new THREE.Group();
        w.position.copy(axle);
        const tire = new THREE.Mesh(new THREE.TorusGeometry(R - 0.018, 0.02, 8, 30), dark);
        tire.rotation.y = Math.PI / 2;
        w.add(tire);
        addOutline(tire, { width: 0.7, minW: 0.005, maxW: 0.03 });
        // jante carbone haute : bande noire épaisse avec un liseré de couleur
        const rim = new THREE.Mesh(new THREE.TorusGeometry(R - 0.06, 0.03, 6, 30), mat('#2a2a32'));
        rim.rotation.y = Math.PI / 2;
        rim.scale.set(1, 1, 0.55);
        w.add(rim);
        const deco = new THREE.Mesh(new THREE.TorusGeometry(R - 0.06, 0.008, 4, 30), mat(this.bikeColor === '#1d1a2b' ? '#ffd23a' : '#ffffff'));
        deco.rotation.y = Math.PI / 2;
        deco.position.x = 0.018;
        w.add(deco);
        const deco2 = deco.clone();
        deco2.position.x = -0.018;
        w.add(deco2);
        for (let k = 0; k < 3; k++) {
          const a = k / 3 * Math.PI * 2;
          const sp = new THREE.Mesh(new THREE.BoxGeometry(0.014, R - 0.05, 0.045), mat(this.bikeColor));
          sp.position.set(0, Math.cos(a) * (R - 0.05) / 2, Math.sin(a) * (R - 0.05) / 2);
          sp.rotation.x = a;
          w.add(sp);
          addOutline(sp, { width: 0.6, minW: 0.003, maxW: 0.02 });
        }
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.11, 10), metal);
        hub.rotation.z = Math.PI / 2;
        w.add(hub);
        g.add(w);
        this.wheels.push(w);
      }
      // pédalier
      const cr = this.crankGroup = new THREE.Group();
      cr.position.copy(BB);
      g.add(cr);
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.012, 20), metal);
      ring.rotation.z = Math.PI / 2;
      ring.position.x = -0.06;
      cr.add(ring);
      addOutline(ring, { width: 0.6, minW: 0.003, maxW: 0.02 });
      for (const sx of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.03), dark);
        arm.position.set(sx * 0.085, -sx * 0.085, 0);
        cr.add(arm);
        const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.07), dark);
        pedal.position.set(sx * 0.13, -sx * 0.17, 0);
        cr.add(pedal);
      }
    }

    _limb(r, m) {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, 1, 8), m);
      this.body.add(mesh);
      addOutline(mesh, { width: 0.8, minW: 0.005, maxW: 0.035 });
      return mesh;
    }

    _ball(r, m, parent) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), m);
      (parent || this.body).add(mesh);
      addOutline(mesh, { width: 0.8, minW: 0.005, maxW: 0.035 });
      return mesh;
    }

    _buildRider() {
      const skin = mat('#f1c29b');
      const shorts = mat('#26232f');
      const jerseyMat = new THREE.MeshToonMaterial({ map: jerseyTexture(this.jersey), gradientMap: B3D.toon.gradientMap() });
      const sleeve = mat(this.jersey.base);
      const white = mat('#ffffff');
      const shoe = mat('#ffffff');
      // torse
      this.torso = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 14), jerseyMat);
      this.body.add(this.torso);
      addOutline(this.torso, { width: 0.9, minW: 0.006, maxW: 0.04 });
      this.pelvis = this._ball(0.15, shorts);
      this.pelvis.scale.set(1.1, 0.75, 1.0);
      // tête + casque + lunettes
      this.head = new THREE.Group();
      this.body.add(this.head);
      const face = this._ball(0.135, skin, this.head);
      face.scale.set(0.95, 1.0, 1.0);
      const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.155, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(this.jersey.style === 'plain' && this.jersey.base === '#ffd23a' ? '#ffd23a' : this.bikeColor));
      helmet.scale.set(1.0, 0.95, 1.3);
      helmet.position.set(0, 0.03, -0.03);
      helmet.rotation.x = -0.25;
      this.head.add(helmet);
      addOutline(helmet, { width: 0.8, minW: 0.005, maxW: 0.035 });
      const glasses = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.05), mat('#1d1a2b'));
      glasses.position.set(0, 0.02, 0.12);
      this.head.add(glasses);
      const lens = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.035, 0.02), new THREE.MeshBasicMaterial({ color: '#4fd0ff' }));
      lens.position.set(0, 0.02, 0.146);
      this.head.add(lens);
      const nose = this._ball(0.03, skin, this.head);
      nose.position.set(0, -0.025, 0.135);
      // sourire
      const smile = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.007, 4, 10, Math.PI), mat('#7a2b2b'));
      smile.position.set(0, -0.058, 0.112);
      smile.rotation.z = Math.PI;
      this.head.add(smile);
      this.neck = this._limb(0.05, skin);

      // bras / jambes : segments recalculés à chaque image
      this.arms = [];
      for (const sx of [-1, 1]) {
        this.arms.push({
          sx,
          upper: this._limb(0.055, sleeve), fore: this._limb(0.045, skin),
          elbow: this._ball(0.05, skin), hand: this._ball(0.05, mat('#26232f')), shoulder: this._ball(0.065, sleeve)
        });
      }
      this.legs = [];
      for (const sx of [-1, 1]) {
        this.legs.push({
          sx,
          thigh: this._limb(0.078, shorts), shin: this._limb(0.058, skin), knee: this._ball(0.065, skin),
          sock: this._ball(0.05, white),
          shoe: (() => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.25), shoe); this.body.add(m); addOutline(m, { width: 0.8, minW: 0.005, maxW: 0.035 }); return m; })()
        });
      }
    }

    _setLimb(mesh, a, b) {
      const d = this._v[3].copy(b).sub(a);
      const len = d.length();
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(UP, d.multiplyScalar(1 / (len || 1)));
      mesh.scale.set(1, len, 1);
    }

    // IK 2 segments dans le plan contenant "bend" : renvoie la position du genou/coude.
    _ik(a, target, l1, l2, bend, out) {
      const d = this._v[0].copy(target).sub(a);
      let dist = d.length();
      dist = clamp(dist, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
      d.normalize();
      const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
      const ang = Math.acos(clamp(cosA, -1, 1));
      // direction perpendiculaire à d, côté "bend"
      const perp = this._v[1].copy(bend).addScaledVector(d, -bend.dot(d)).normalize();
      out.copy(a).addScaledVector(d, Math.cos(ang) * l1).addScaledVector(perp, Math.sin(ang) * l1);
      return out;
    }

    // state : { speed (m/s), pedaling, power (0..1), standing, tuck, steer (-1..1), dt }
    update(dt, st) {
      this.time += dt;
      const v = st.speed;
      // roues
      this.wheelAngle += v / R * dt;
      for (const w of this.wheels) w.rotation.x = this.wheelAngle;
      // pédalage : braquet "automatique" pour garder ~90 tr/min
      if (st.pedaling && v > 0.3) {
        const wheelRpm = v / (2 * Math.PI * R) * 60;
        const ratio = clamp(wheelRpm / 88, 1.3, 4.4);
        const cadence = wheelRpm / ratio; // tr/min
        const before = Math.floor(this.crank / Math.PI);
        this.crank += cadence / 60 * Math.PI * 2 * dt;
        this.strokes += Math.floor(this.crank / Math.PI) - before;
      } else {
        // pédales à l'horizontale en roue libre
        const target = Math.round((this.crank - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
        this.crank = lerp(this.crank, target, 1 - Math.exp(-dt * 4));
      }
      this.crankGroup.rotation.x = this.crank;

      this.standT = lerp(this.standT, st.standing ? 1 : 0, 1 - Math.exp(-dt * 5));
      this.tuckT = lerp(this.tuckT, st.tuck ? 1 : 0, 1 - Math.exp(-dt * 3));
      const stand = this.standT, tuck = this.tuckT;

      // balancement du vélo en danseuse
      this.rock = Math.sin(this.crank) * 0.13 * stand;
      this.bikeGroup.rotation.z = this.rock;

      const V = this._v;
      const P = (x, y, z, out) => out.set(x, y, z);
      // bassin / épaules
      const pelvis = new THREE.Vector3(0, 1.0 + 0.16 * stand - 0.03 * tuck, -0.26 + 0.2 * stand + 0.03 * tuck);
      const bob = Math.sin(this.crank * 2) * 0.008 * (st.pedaling ? 1 : 0);
      pelvis.y += bob;
      const sway = -Math.sin(this.crank) * 0.08 * stand;
      pelvis.x += sway;
      const shoulder = new THREE.Vector3(sway * 1.4, 1.37 - 0.16 * tuck + 0.06 * stand + bob, 0.2 + 0.08 * tuck + 0.1 * stand);
      this.pelvis.position.copy(pelvis);
      // torse : capsule orientée du bassin aux épaules
      const tdir = shoulder.clone().sub(pelvis);
      const tlen = tdir.length();
      this.torso.position.copy(pelvis).addScaledVector(tdir, 0.5);
      this.torso.quaternion.setFromUnitVectors(UP, tdir.normalize());
      this.torso.scale.set(0.2, tlen * 0.5 + 0.1, 0.16);
      // tête
      const neckBase = shoulder.clone().add(new THREE.Vector3(0, 0.05, 0.03));
      const headPos = shoulder.clone().add(new THREE.Vector3(0, 0.17 - 0.03 * tuck, 0.14 + 0.03 * tuck));
      this._setLimb(this.neck, neckBase, headPos);
      this.head.position.copy(headPos);
      this.head.rotation.set(-0.15 + 0.2 * tuck - 0.1 * stand, st.steer * 0.25, 0);

      // bras
      const handY = 0.93 - 0.12 * tuck, handZ = 0.58 - 0.02 * tuck;
      for (const arm of this.arms) {
        const sh = P(arm.sx * 0.19 + sway * 1.4, shoulder.y - 0.02, shoulder.z - 0.02, V[2]).clone();
        const hand = new THREE.Vector3(arm.sx * 0.205 + this.rock * 0.0, handY, handZ);
        // le guidon suit le balancement du vélo
        if (stand > 0.01) { hand.applyAxisAngle(new THREE.Vector3(0, 0, 1), this.rock); }
        const elbow = this._ik(sh, hand, 0.3, 0.3, new THREE.Vector3(arm.sx * 0.6, -0.3, -0.75).normalize(), new THREE.Vector3());
        arm.shoulder.position.copy(sh);
        this._setLimb(arm.upper, sh, elbow);
        this._setLimb(arm.fore, elbow, hand);
        arm.elbow.position.copy(elbow);
        arm.hand.position.copy(hand);
      }
      // jambes : pédales dans le repère du vélo (avec balancement)
      for (const leg of this.legs) {
        // même convention que les manivelles du pédalier : pédale droite (x < 0) en haut à crank = 0
        const sgn = -leg.sx;
        const pedal = new THREE.Vector3(leg.sx * 0.12, this.BB.y + sgn * Math.cos(this.crank) * 0.17, this.BB.z + sgn * Math.sin(this.crank) * 0.17);
        if (stand > 0.01) pedal.applyAxisAngle(new THREE.Vector3(0, 0, 1), this.rock);
        const ankle = pedal.clone().add(new THREE.Vector3(0, 0.07, -0.05));
        const hip = new THREE.Vector3(leg.sx * 0.095 + pelvis.x, pelvis.y - 0.03, pelvis.z + 0.02);
        const knee = this._ik(hip, ankle, 0.46, 0.45, new THREE.Vector3(leg.sx * 0.12, 0.25, 1).normalize(), new THREE.Vector3());
        this._setLimb(leg.thigh, hip, knee);
        this._setLimb(leg.shin, knee, ankle);
        leg.knee.position.copy(knee);
        leg.sock.position.copy(ankle);
        // chaussure posée sur la pédale, pointe vers l'avant
        const toe = pedal.clone().add(new THREE.Vector3(0, 0.03, 0.09));
        leg.shoe.position.copy(ankle).add(toe).multiplyScalar(0.5);
        leg.shoe.lookAt(this._toWorldDir(toe.clone().sub(ankle), leg.shoe.position));
      }
    }

    // lookAt travaille en coordonnées monde : on convertit une direction locale du corps.
    _toWorldDir(dirLocal, posLocal) {
      const p = posLocal.clone().add(dirLocal);
      return this.body.localToWorld(p);
    }

    dispose() {
      this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
  }

  Cyclist.JERSEYS = JERSEYS;
  B3D.Cyclist = Cyclist;
})(typeof window !== 'undefined' ? window : globalThis);
