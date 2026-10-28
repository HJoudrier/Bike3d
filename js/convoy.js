/* Bike3D — la caravane qui accompagne la course : motos de la télévision qui filment les groupes,
   voitures suiveuses (qui s'arrêtent pour dépanner un coureur crevé), voiture-balai derrière le dernier
   coureur et hélicoptère qui tourne au-dessus de la tête de la course. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { merge, tr, addOutline, textTexture } = B3D.toon;
  const { clamp, lerp } = B3D.util;
  const FONT = '"Fredoka", Arial, sans-serif';

  const box = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  const sph = new THREE.SphereGeometry(0.5, 12, 8);

  function toonMesh(parts, outline) {
    const m = new THREE.Mesh(merge(parts), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: B3D.toon.gradientMap() }));
    m.castShadow = true;
    if (outline !== false) addOutline(m, { width: 0.9, maxW: 0.12 });
    return m;
  }

  // personnage assis (pilote, caméraman) : origine = selle
  function seated(parts, x, z, color, helmet, back) {
    const f = back ? -1 : 1;
    parts.push({ geo: cyl, color: '#26232f', matrix: tr(x + 0.11, 0.08, z + f * 0.22, Math.PI / 2 - 0.3 * f, 0, 0, 0.13, 0.5, 0.13) });
    parts.push({ geo: cyl, color: '#26232f', matrix: tr(x - 0.11, 0.08, z + f * 0.22, Math.PI / 2 - 0.3 * f, 0, 0, 0.13, 0.5, 0.13) });
    parts.push({ geo: sph, color, matrix: tr(x, 0.42, z, -0.15 * f, 0, 0, 0.46, 0.66, 0.34) });
    parts.push({ geo: sph, color: helmet, matrix: tr(x, 0.92, z + f * 0.03, 0, 0, 0, 0.32, 0.32, 0.34) });
    parts.push({ geo: box, color: '#1d1a2b', matrix: tr(x, 0.92, z + f * 0.15, 0, 0, 0, 0.26, 0.09, 0.08) });
  }

  // moto de la télévision avec son pilote et le caméraman assis à l'envers
  function motoMesh() {
    const p = [];
    p.push({ geo: new THREE.TorusGeometry(0.3, 0.09, 6, 16), color: '#26232f', matrix: tr(0, 0.32, 0.72, 0, Math.PI / 2, 0) });
    p.push({ geo: new THREE.TorusGeometry(0.3, 0.09, 6, 16), color: '#26232f', matrix: tr(0, 0.32, -0.72, 0, Math.PI / 2, 0) });
    p.push({ geo: box, color: '#f4f2ec', matrix: tr(0, 0.62, 0, 0, 0, 0, 0.42, 0.42, 1.3) });
    p.push({ geo: sph, color: '#3d7be0', matrix: tr(0, 0.86, 0.38, 0, 0, 0, 0.5, 0.36, 0.7) });
    p.push({ geo: box, color: '#3d7be0', matrix: tr(0, 0.9, 0.82, -0.5, 0, 0, 0.62, 0.55, 0.12) });
    p.push({ geo: box, color: '#a8d8ff', matrix: tr(0, 1.22, 0.86, -0.35, 0, 0, 0.5, 0.32, 0.04) });
    p.push({ geo: box, color: '#26232f', matrix: tr(0, 0.86, -0.25, 0, 0, 0, 0.44, 0.12, 0.95) });
    p.push({ geo: box, color: '#3d7be0', matrix: tr(0.36, 0.6, -0.55, 0, 0, 0, 0.26, 0.4, 0.55) });
    p.push({ geo: box, color: '#3d7be0', matrix: tr(-0.36, 0.6, -0.55, 0, 0, 0, 0.26, 0.4, 0.55) });
    p.push({ geo: cyl, color: '#c9ced8', matrix: tr(0.24, 0.36, -0.5, Math.PI / 2, 0, 0, 0.1, 0.8, 0.1) });
    p.push({ geo: cyl, color: '#26232f', matrix: tr(0, 1.02, 0.62, 0, 0, Math.PI / 2, 0.04, 0.7, 0.04) });
    // pilote (vers l'avant) et caméraman (vers l'arrière)
    const pil = [], cam = [];
    seated(pil, 0, 0, '#2b3c66', '#ffffff', false);
    seated(cam, 0, 0, '#e2463a', '#f2c230', true);
    for (const q of pil) p.push({ geo: q.geo, color: q.color, matrix: new THREE.Matrix4().multiplyMatrices(tr(0, 0.92, 0.05), q.matrix) });
    for (const q of cam) p.push({ geo: q.geo, color: q.color, matrix: new THREE.Matrix4().multiplyMatrices(tr(0, 0.98, -0.55), q.matrix) });
    // caméra d'épaule
    p.push({ geo: box, color: '#26232f', matrix: tr(0.22, 2.0, -0.85, 0, 0, 0, 0.22, 0.26, 0.55) });
    p.push({ geo: cyl, color: '#1d1a2b', matrix: tr(0.22, 2.0, -1.18, Math.PI / 2, 0, 0, 0.17, 0.2, 0.17) });
    p.push({ geo: cyl, color: '#4fd0ff', matrix: tr(0.22, 2.0, -1.29, Math.PI / 2, 0, 0, 0.13, 0.02, 0.13) });
    p.push({ geo: box, color: '#e2463a', matrix: tr(0.22, 2.17, -0.75, 0, 0, 0, 0.08, 0.06, 0.08) });
    const g = new THREE.Group();
    g.add(toonMesh(p));
    // plaque « TV »
    const tex = textTexture((ctx, w, h) => {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#e2463a'; ctx.font = '700 84px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('TV', w / 2, h / 2 + 4);
    }, 128, 96);
    for (const sx of [-1, 1]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.3), new THREE.MeshBasicMaterial({ map: tex }));
      pl.position.set(sx * 0.495, 0.66, -0.55);
      pl.rotation.y = sx * Math.PI / 2;
      g.add(pl);
    }
    return g;
  }

  // plaque de texte posée sur le toit (« FIN DE COURSE », « ASSISTANCE »…)
  function roofSign(text, bg, fg, w) {
    const tex = textTexture((ctx, cw, ch) => {
      ctx.fillStyle = bg; ctx.fillRect(0, 0, cw, ch);
      ctx.strokeStyle = '#1d1a2b'; ctx.lineWidth = 10; ctx.strokeRect(5, 5, cw - 10, ch - 10);
      ctx.fillStyle = fg; ctx.font = '700 58px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, cw / 2, ch / 2 + 3);
    }, 512, 96);
    const g = new THREE.Group();
    for (const f of [-1, 1]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 96 / 512), new THREE.MeshBasicMaterial({ map: tex }));
      pl.position.set(0, 1.86, 0.55 + f * 0.012);
      if (f < 0) pl.rotation.y = Math.PI;
      g.add(pl);
    }
    const post = new THREE.Mesh(box, B3D.toon.mat('#9aa0aa'));
    post.scale.set(0.06, 0.4, 0.06);
    post.position.set(0, 1.6, 0.55);
    g.add(post);
    return g;
  }

  function carMesh(color, kind) {
    const p = [];
    if (kind === 'balai') {
      // fourgonnette sombre et son balai géant sur le toit
      p.push({ geo: box, color: '#3a3f4b', matrix: tr(0, 1.0, -0.1, 0, 0, 0, 1.85, 1.3, 4.4) });
      p.push({ geo: box, color: '#a8d8ff', matrix: tr(0, 1.25, 2.12, -0.15, 0, 0, 1.6, 0.6, 0.06) });
      p.push({ geo: box, color: '#a8d8ff', matrix: tr(0.93, 1.3, 1.1, 0, 0, 0, 0.04, 0.45, 1.3) });
      p.push({ geo: box, color: '#a8d8ff', matrix: tr(-0.93, 1.3, 1.1, 0, 0, 0, 0.04, 0.45, 1.3) });
      for (const [x, z] of [[-0.86, 1.4], [0.86, 1.4], [-0.86, -1.5], [0.86, -1.5]]) p.push({ geo: cyl, color: '#26232f', matrix: tr(x, 0.36, z, 0, 0, Math.PI / 2, 0.72, 0.26, 0.72) });
      p.push({ geo: cyl, color: '#c98a3d', matrix: tr(0, 2.0, -0.4, 0.25, 0, Math.PI / 2, 0.08, 3.2, 0.08) });
      p.push({ geo: new THREE.ConeGeometry(0.42, 0.9, 8), color: '#e8c25a', matrix: tr(1.95, 2.0, -0.4, 0, 0, -Math.PI / 2 + 0.25, 1, 1, 0.5) });
      p.push({ geo: box, color: '#e2463a', matrix: tr(1.45, 2.0, -0.4, 0, 0, 0.25, 0.12, 0.3, 0.32) });
      p.push({ geo: box, color: '#9aa0aa', matrix: tr(0.5, 1.75, -0.4, 0, 0, 0, 0.06, 0.25, 0.06) });
      p.push({ geo: box, color: '#9aa0aa', matrix: tr(-0.5, 1.75, -0.4, 0, 0, 0, 0.06, 0.25, 0.06) });
    } else {
      B3D.race.carParts(p, { x: 0, y: 0, z: 0, rot: 0, color });
    }
    const g = new THREE.Group();
    g.add(toonMesh(p));
    if (kind === 'balai') g.add(roofSign('FIN DE COURSE', '#ffffff', '#1d1a2b', 1.7));
    if (kind === 'neutral') { const sg = roofSign('ASSISTANCE', '#f2c230', '#1d1a2b', 1.5); sg.position.z = -0.1; sg.position.y = 0.32; g.add(sg); }
    return g;
  }

  function heliMesh() {
    const p = [];
    p.push({ geo: sph, color: '#3d7be0', matrix: tr(0, 0, 0, 0, 0, 0, 2.2, 1.9, 3.6) });
    p.push({ geo: sph, color: '#a8d8ff', matrix: tr(0, 0.15, 1.15, 0, 0, 0, 1.7, 1.4, 1.6) });
    p.push({ geo: sph, color: '#ffffff', matrix: tr(0, -0.35, 0, 0, 0, 0, 2.25, 0.9, 3.4) });
    p.push({ geo: cyl, color: '#3d7be0', matrix: tr(0, 0.2, -3.2, Math.PI / 2 - 0.08, 0, 0, 0.42, 3.8, 0.42) });
    p.push({ geo: box, color: '#ffffff', matrix: tr(0, 0.75, -4.9, -0.3, 0, 0, 0.12, 1.1, 0.7) });
    p.push({ geo: box, color: '#3d7be0', matrix: tr(0, 0.25, -4.6, 0, 0, 0, 1.3, 0.08, 0.4) });
    for (const sx of [-1, 1]) {
      p.push({ geo: cyl, color: '#26232f', matrix: tr(sx * 0.95, -1.35, 0, Math.PI / 2, 0, 0, 0.1, 3.2, 0.1) });
      p.push({ geo: cyl, color: '#26232f', matrix: tr(sx * 0.8, -1.05, 0.8, 0, 0, sx * 0.3, 0.08, 0.7, 0.08) });
      p.push({ geo: cyl, color: '#26232f', matrix: tr(sx * 0.8, -1.05, -0.8, 0, 0, sx * 0.3, 0.08, 0.7, 0.08) });
    }
    p.push({ geo: cyl, color: '#26232f', matrix: tr(0, 1.15, 0, 0, 0, 0, 0.25, 0.5, 0.25) });
    p.push({ geo: sph, color: '#26232f', matrix: tr(0, -0.85, 1.4, 0, 0, 0, 0.5, 0.5, 0.5) });
    p.push({ geo: sph, color: '#4fd0ff', matrix: tr(0, -0.85, 1.62, 0, 0, 0, 0.25, 0.25, 0.1) });
    const g = new THREE.Group();
    g.add(toonMesh(p));
    // rotor principal et rotor de queue (tournent à chaque image)
    const rotor = new THREE.Mesh(merge([
      { geo: box, color: '#26232f', matrix: tr(0, 0, 0, 0, 0, 0, 9.5, 0.06, 0.35) },
      { geo: box, color: '#26232f', matrix: tr(0, 0, 0, 0, Math.PI / 2, 0, 9.5, 0.06, 0.35) },
      { geo: cyl, color: '#3a3f4b', matrix: tr(0, 0, 0, 0, 0, 0, 0.35, 0.25, 0.35) }
    ]), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: B3D.toon.gradientMap() }));
    rotor.position.y = 1.45;
    // disque flou des pales
    const blur = new THREE.Mesh(new THREE.CircleGeometry(4.7, 32), new THREE.MeshBasicMaterial({ color: '#26232f', transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
    blur.rotation.x = -Math.PI / 2;
    blur.position.y = 1.45;
    const tail = new THREE.Mesh(merge([
      { geo: box, color: '#26232f', matrix: tr(0, 0, 0, 0, 0, 0, 0.05, 1.5, 0.18) },
      { geo: box, color: '#26232f', matrix: tr(0, 0, 0, Math.PI / 2, 0, 0, 0.05, 1.5, 0.18) }
    ]), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: B3D.toon.gradientMap() }));
    tail.position.set(0.28, 0.75, -5.0);
    g.add(rotor, blur, tail);
    g.userData.rotor = rotor;
    g.userData.tail = tail;
    return g;
  }

  // mécanicien qui change la roue d'un coureur crevé
  function mechanicMesh() {
    const p = B3D.race.personParts('#f2c230', 1).map((q) => ({ geo: q.geo, color: q.color, matrix: q.matrix }));
    p.push({ geo: new THREE.TorusGeometry(0.31, 0.04, 6, 18), color: '#26232f', matrix: tr(0.95, 1.2, 0.1, 0, Math.PI / 2, 0) });
    p.push({ geo: cyl, color: '#c9ced8', matrix: tr(0.95, 1.2, 0.1, 0, 0, Math.PI / 2, 0.06, 0.12, 0.06) });
    const g = new THREE.Group();
    g.add(toonMesh(p));
    return g;
  }

  // petites lampes non éclairées (phares, feux arrière), visibles la nuit
  function lamps(list) {
    const g = new THREE.Group();
    for (const [x, y, z, color, r] of list) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r || 0.1, 8, 6), new THREE.MeshBasicMaterial({ color, fog: false }));
      m.position.set(x, y, z);
      g.add(m);
    }
    g.visible = false;
    return g;
  }

  class Convoy {
    constructor(scene, route, L) {
      this.scene = scene;
      this.route = route;
      this.L = L;
      this.group = new THREE.Group();
      this.group.name = 'convoy';
      scene.add(this.group);
      const half = L.roadHalf;
      const teams = (B3D.race.TEAMS || []).filter((t) => t.color !== '#f2c230').slice(0, 2); // la voiture d'assistance est déjà jaune
      const V = (kind, obj, lat, extra) => { this.group.add(obj); return Object.assign({ kind, obj, s: 0, lat, latT: lat, v: 0, mode: 'follow' }, extra || {}); };
      this.motos = [V('moto', motoMesh(), -(half - 0.9), { role: 'head' }), V('moto', motoMesh(), -(half - 0.9), { role: 'player' })];
      this.cars = [
        V('car', carMesh('#f2c230', 'neutral'), -1.45, { k: 0, neutral: true }),
        V('car', carMesh(teams[0] ? teams[0].color : '#3d7be0'), -1.45, { k: 1 }),
        V('car', carMesh(teams[1] ? teams[1].color : '#e2463a'), -1.45, { k: 2 })
      ];
      this.balai = V('balai', carMesh(null, 'balai'), -1.2);
      this.heli = { obj: heliMesh(), pos: new THREE.Vector3(), yaw: 0, ang: 0, init: false };
      this.group.add(this.heli.obj);
      this.mechanic = mechanicMesh();
      this.mechanic.visible = false;
      this.group.add(this.mechanic);
      this.all = this.motos.concat(this.cars, [this.balai]);
      // feux de nuit
      this.lampGroups = [];
      const W = '#fff6d8', R = '#ff2a2a';
      for (const m of this.motos) {
        const g = lamps([[0, 0.95, 0.9, W, 0.11], [0, 0.85, -0.85, R, 0.07]]);
        m.obj.add(g);
        this.lampGroups.push(g);
      }
      for (const c of this.cars.concat([this.balai])) {
        const z = c === this.balai ? 2.25 : 2.17, zr = c === this.balai ? -2.33 : -2.17;
        const g = lamps([[0.6, 0.66, z, W, 0.12], [-0.6, 0.66, z, W, 0.12], [0.7, 0.8, zr, R, 0.09], [-0.7, 0.8, zr, R, 0.09]].concat(c === this.balai ? [[0, 1.75, 0.6, '#ff9a2b', 0.13]] : []));
        c.obj.add(g);
        this.lampGroups.push(g);
      }
      const hb = lamps([[0, 1.0, -5.2, R, 0.22], [0, -1.0, 0.8, '#ffffff', 0.18]]);
      this.heli.obj.add(hb);
      this.heli.beacon = hb;
      this.lightsOn = false;
      this.service = null;
      this.group.visible = false;
    }

    reset(peloton, player) {
      this.peloton = peloton;
      this.player = player;
      const s0 = this.route.sStart;
      this.motos[0].s = s0 + 22; this.motos[1].s = s0 + 12;
      this.cars.forEach((c, k) => { c.s = s0 - 26 - k * 9; c.mode = 'follow'; c.latT = c.lat = -1.45; });
      this.balai.s = s0 - 60;
      for (const v of this.all) v.v = 0;
      this.heli.init = false;
      this.service = null;
      this.mechanic.visible = false;
      this.group.visible = true;
      this.update(0, null);
    }

    // une crevaison : la voiture d'assistance neutre s'arrête derrière le coureur
    onFlat(r) {
      if (this.service) return;
      const car = this.cars[0];
      car.mode = 'service';
      this.service = { car, rider: r };
    }

    onFixed(r) {
      if (!this.service || this.service.rider !== r) return;
      this.service.car.mode = 'follow';
      this.service = null;
      this.mechanic.visible = false;
    }

    setLights(on) {
      if (on === this.lightsOn) return;
      this.lightsOn = on;
      for (const g of this.lampGroups) g.visible = on;
    }

    nearest(kind, P) {
      if (!this.group.visible) return 1e9;
      if (kind === 'heli') return this.heli.obj.position.distanceTo(P);
      let d = 1e9;
      for (const m of this.motos) d = Math.min(d, m.obj.position.distanceTo(P));
      return d;
    }

    // dt en temps de course
    update(dt, camera) {
      if (!this.group.visible || !this.player) return;
      const route = this.route, L = this.L, half = L.roadHalf, P = this.player;
      const pel = this.peloton;
      // groupes : celui du joueur et celui de tête
      const pg = pel && P.group ? P.group : { members: [P], head: P, last: P, leader: P };
      const groups = pel ? pel.groups.filter((g) => !g.leader.done) : [pg];
      const hg = groups[0] || pg;
      const headOf = (g) => g.head || g.leader;
      let last = P;
      if (pel) for (const r of pel.riders) if (!r.done && r.state !== 'flat' && r.s < last.s) last = r;
      const sEnd = route.sEnd;
      const move = (veh, sT, vBase, latT, sMax) => {
        const e = sT - veh.s;
        const vT = Math.max(0, vBase + clamp(e * 0.7, -8, 10));
        veh.v = lerp(veh.v, vT, 1 - Math.exp(-dt * 1.6));
        veh.s += veh.v * dt;
        if (sMax !== undefined) veh.s = Math.min(veh.s, sMax);
        veh.latT = latT;
        veh.lat = lerp(veh.lat, latT, 1 - Math.exp(-dt * 1.2));
      };
      // motos TV : devant la tête de course et devant le groupe du joueur (ou à ses côtés)
      const hh = headOf(hg), ph = headOf(pg);
      move(this.motos[0], hh.s + 15, hh.v, -(half - 0.9), sEnd + 120);
      if (pg !== hg) move(this.motos[1], ph.s + 12, ph.v, -(half - 0.9), sEnd + 120);
      else move(this.motos[1], (ph.s + pg.last.s) / 2 - 2, ph.v, -(half - 0.75), sEnd + 120);
      for (const m of this.motos) {
        // le joueur arrive dessus : la moto s'écarte en accélérant
        if (Math.abs(m.s - P.s) < 4 && Math.abs(m.lat - P.lat) < 1.3) m.s += 6 * dt;
      }
      // voitures suiveuses derrière le groupe du joueur, jamais à moins de 12 m derrière lui
      const tail = Math.min(pg.last.s, P.s);
      for (const c of this.cars) {
        if (c.mode === 'service') {
          const r = this.service.rider;
          if (r.v < 0.5) {
            // freinage dosé pour s'arrêter juste derrière le coureur (une voiture ne recule pas)
            const e = r.s - 6.5 - c.s;
            const vT = e > 0 ? Math.min(25, Math.sqrt(2 * 2.5 * e)) : 0;
            c.v = lerp(c.v, vT, 1 - Math.exp(-dt * 3));
            c.s += c.v * dt;
            c.lat = lerp(c.lat, half + 0.25, 1 - Math.exp(-dt * 1.2));
            c.latT = half + 0.25;
          } else move(c, r.s - 6.5, r.v, half + 0.25);
          if (r.v < 0.3 && c.v < 0.6 && c.s > r.s - 11 && c.s < r.s - 2) {
            // le mécanicien change la roue
            const q = route.sample(r.s - 0.7, this._mq || (this._mq = {}));
            const lat = r.lat - 0.85;
            this.mechanic.position.set(q.x + q.rx * lat, q.y, q.z + q.rz * lat);
            this.mechanic.rotation.y = Math.atan2(q.rx, q.rz);
            this.mechanic.visible = true;
          }
        } else {
          move(c, tail - 22 - c.k * 9, P.v, -1.45, sEnd - 40);
          c.s = Math.min(c.s, P.s - 12 - c.k * 9);
        }
      }
      // voiture-balai derrière le dernier coureur
      move(this.balai, Math.min(last.s - 45, tail - 55), last.v, -1.2, sEnd - 70);
      this.balai.s = Math.min(this.balai.s, P.s - 40);
      // placement
      const q = this._q || (this._q = {});
      for (const veh of this.all) {
        route.sample(veh.s, q);
        const o = veh.obj;
        o.position.set(q.x + q.rx * veh.lat, q.y, q.z + q.rz * veh.lat);
        if (veh.lat > half - 0.2) o.position.y = Math.max(q.y - 0.15, L.heightAt(o.position.x, o.position.z));
        o.rotation.set(-Math.atan(q.grade), Math.atan2(q.tx, q.tz) + (veh.latT - veh.lat) * 0.15, 0, 'YXZ');
      }
      this._updateHeli(dt, hg, pg);
    }

    // l'hélicoptère tourne au-dessus de la tête de course (ou du groupe du joueur si elle est loin)
    _updateHeli(dt, hg, pg) {
      const H = this.heli, route = this.route, P = this.player;
      const tgtR = (hg.head || hg.leader);
      const target = Math.abs(tgtR.s - P.s) < 700 ? tgtR : (pg.head || pg.leader);
      const q = route.sample(target.s + 35, this._hq || (this._hq = {}));
      H.ang += dt * 0.14;
      const R = 60;
      const want = this._hw || (this._hw = new THREE.Vector3());
      want.set(q.x + Math.cos(H.ang) * R, 0, q.z + Math.sin(H.ang) * R);
      want.y = Math.max(q.y, this.L.heightAt(want.x, want.z)) + 62;
      if (!H.init) { H.pos.copy(want); H.init = true; }
      const d = want.clone().sub(H.pos);
      const maxStep = 45 * dt;
      if (d.length() > maxStep) d.setLength(maxStep);
      H.pos.add(d);
      const o = H.obj;
      o.position.copy(H.pos);
      // le nez suit la trajectoire, légèrement penché vers l'avant
      const dirx = -Math.sin(H.ang), dirz = Math.cos(H.ang);
      o.rotation.set(0.12, Math.atan2(dirx, dirz), -0.18, 'YXZ');
      o.userData.rotor.rotation.y += dt * 38;
      // balise clignotante la nuit
      H.blink = (H.blink || 0) + dt;
      H.beacon.visible = this.lightsOn && (H.blink % 1.2) < 0.15;
      o.userData.tail.rotation.x += dt * 60;
    }

    dispose() {
      this.scene.remove(this.group);
      this.group.traverse((o) => {
        if (o.geometry && o.geometry !== box && o.geometry !== cyl && o.geometry !== sph) o.geometry.dispose();
        if (o.material && !o.userData.isOutline) { if (o.material.map) o.material.map.dispose(); if (!o.material.isMeshToonMaterial || o.material.vertexColors) o.material.dispose(); }
      });
    }
  }

  B3D.Convoy = Convoy;
})(typeof window !== 'undefined' ? window : globalThis);
