/* Bike3D — le peloton : coureurs virtuels qui roulent en groupe.
   Physique identique au joueur (puissance, pente, roulement, air) avec aspiration derrière les autres,
   réserve d'énergie, groupes qui se forment et se cassent, relais, attaques, sprints, crevaisons.
   Rendu instancié : corps et vélo fusionnés, jambes (pédalage) et roues animées instance par instance,
   sillage visible derrière le coureur qui précède le joueur (vert quand il est dans l'aspiration). */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { merge, tr, instancedMat, outlineMat, computeOutlineNormals, textTexture } = B3D.toon;
  const { mulberry32, clamp, lerp } = B3D.util;

  const FIRST = ['Kévin', 'Jean-Mi', 'Lulu', 'Bernard', 'Momo', 'Toto', 'Gégé', 'Fanfan', 'Dédé', 'Pépette', 'Riri', 'Nono',
    'Jojo', 'Titi', 'Mimi', 'Loulou', 'Bébert', 'Zézette', 'Polo', 'Jacquot', 'Fifi', 'Gigi', 'Lolo', 'Nanard'];
  const LAST = ['Watts', 'Danseuse', 'Lagrimpette', 'Braquet', 'Moulinette', 'Tubeless', 'Gruppetto', 'Fringale', 'Dérailleur',
    'Pignon', 'Rouleur', 'Bidon', 'Cassette', 'Guidon', 'Rayon', 'Bordure', 'Musette', 'Socquette', 'Cuissard', 'Chambre-à-Air', 'Patate', 'Bonbon'];

  const WR = 0.34; // rayon de roue
  const GROUP_GAP = 10; // au-delà de cet écart (m), on forme un autre groupe
  const ROW = 1.85; // distance entre deux rangs (m)
  const COL = 0.72; // distance entre deux files (m)
  const MIN_GAP = 1.55; // on ne rentre pas dans la roue de devant
  const LAT_OVERLAP = 0.6; // deux coureurs plus proches que ça latéralement se touchent

  // ------------------------------------------------------------------ aspiration
  // Abri (0..0.62) d'un coureur en (s, lat) derrière les coureurs triés par s décroissante.
  // Réduit la traînée aérodynamique : jusqu'à ~40 % dans la roue, davantage au cœur d'un groupe.
  function shelter(sorted, s, lat, self) {
    let keep = 1, best = 0, src = null;
    for (let i = 0; i < sorted.length; i++) {
      const o = sorted[i];
      const ds = o.s - s;
      if (ds > 10) continue;
      if (ds < 0.3) break;
      if (o === self || o.done || o.state === 'flat') continue;
      const dl = Math.abs(o.lat - lat);
      if (dl > 1.1) continue;
      const g = ds <= 1.3 ? 0.42 : 0.42 * (10 - ds) / 8.7;
      const sh = g * (1 - dl / 1.1);
      keep *= 1 - sh;
      if (sh > best) { best = sh; src = o; }
    }
    return { f: Math.min(0.62, 1 - keep), src };
  }

  // ------------------------------------------------------------------ géométries
  const UP = new THREE.Vector3(0, 1, 0), FWD = new THREE.Vector3(0, 0, 1);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  function tubeM(a, b, r) {
    const d = b.clone().sub(a), len = d.length();
    return new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()), V(r, len, r));
  }
  function ik(a, target, l1, l2, bend, out) {
    const d = target.clone().sub(a);
    const dist = clamp(d.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    d.normalize();
    const ang = Math.acos(clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1));
    const perp = bend.clone().addScaledVector(d, -bend.dot(d)).normalize();
    return out.copy(a).addScaledVector(d, Math.cos(ang) * l1).addScaledVector(perp, Math.sin(ang) * l1);
  }

  let geoCache = null;
  function geometries() {
    if (geoCache) return geoCache;
    const cyl = new THREE.CylinderGeometry(1, 0.92, 1, 7);
    const sph = (w, h) => new THREE.SphereGeometry(1, w || 10, h || 7);
    const W = '#ffffff', DK = '#26232f', SK = '#f1c29b';
    const parts = [];
    const tube = (a, b, r, color, tint) => parts.push({ geo: cyl, color, tint, matrix: tubeM(a, b, r) });
    // vélo (cadre à la couleur de l'équipe)
    const BB = V(0, 0.28, -0.08), stTop = V(0, 0.815, -0.244), htTop = V(0, 0.86, 0.40), htBot = V(0, 0.70, 0.45);
    tube(BB, stTop, 0.026, W, 1); tube(stTop, htTop, 0.024, W, 1); tube(BB, htBot, 0.03, W, 1); tube(htBot, htTop, 0.032, W, 1);
    for (const sx of [-1, 1]) {
      tube(stTop, V(sx * 0.055, WR, -0.5), 0.014, W, 1);
      tube(BB, V(sx * 0.055, WR, -0.5), 0.016, W, 1);
      tube(V(sx * 0.04, 0.7, 0.45), V(sx * 0.05, WR, 0.52), 0.016, W, 1);
    }
    tube(stTop, V(0, 0.95, -0.287), 0.014, '#c9ced8');
    parts.push({ geo: sph(), color: DK, matrix: tr(0, 0.965, -0.29, 0, 0, 0, 0.07, 0.03, 0.14) });
    tube(htTop, V(0, 0.885, 0.5), 0.017, DK);
    tube(V(-0.21, 0.885, 0.5), V(0.21, 0.885, 0.5), 0.015, DK);
    for (const sx of [-1, 1]) {
      tube(V(sx * 0.21, 0.885, 0.5), V(sx * 0.21, 0.9, 0.6), 0.015, DK);
      tube(V(sx * 0.21, 0.9, 0.6), V(sx * 0.21, 0.78, 0.6), 0.015, DK);
    }
    parts.push({ geo: new THREE.CylinderGeometry(0.035, 0.035, 0.2, 8), color: W, matrix: tr(0, 0.47, 0.15, -1.05, 0, 0) });
    parts.push({ geo: new THREE.CylinderGeometry(0.1, 0.1, 0.014, 14), color: '#c9ced8', matrix: tr(-0.06, BB.y, BB.z, 0, 0, Math.PI / 2) });
    // coureur assis, mains sur les cocottes
    const pelvis = V(0, 1.0, -0.26), shoulder = V(0, 1.37, 0.2);
    const tdir = shoulder.clone().sub(pelvis), tlen = tdir.length();
    parts.push({ geo: sph(14, 10), color: W, tint: 1, matrix: new THREE.Matrix4().compose(pelvis.clone().addScaledVector(tdir, 0.5), new THREE.Quaternion().setFromUnitVectors(UP, tdir.clone().normalize()), V(0.2, tlen * 0.5 + 0.1, 0.16)) });
    // dossard dans le dos
    parts.push({ geo: new THREE.BoxGeometry(0.2, 0.15, 0.015), color: '#fbfaf5', matrix: new THREE.Matrix4().compose(V(0, 1.2, -0.18), new THREE.Quaternion().setFromUnitVectors(FWD, V(0, 0.75, -0.66).normalize()), V(1, 1, 1)) });
    parts.push({ geo: sph(), color: DK, matrix: tr(pelvis.x, pelvis.y, pelvis.z, 0, 0, 0, 0.165, 0.11, 0.15) });
    const neckBase = shoulder.clone().add(V(0, 0.05, 0.03)), head = shoulder.clone().add(V(0, 0.17, 0.14));
    tube(neckBase, head, 0.05, SK);
    parts.push({ geo: sph(), color: SK, matrix: tr(head.x, head.y, head.z, 0, 0, 0, 0.128, 0.135, 0.135) });
    parts.push({ geo: new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), color: W, tint: 1, matrix: tr(head.x, head.y + 0.03, head.z - 0.03, -0.4, 0, 0, 0.155, 0.147, 0.2) });
    parts.push({ geo: new THREE.BoxGeometry(0.24, 0.05, 0.05), color: '#1d1a2b', matrix: tr(head.x, head.y, head.z + 0.12, -0.15, 0, 0) });
    parts.push({ geo: new THREE.BoxGeometry(0.22, 0.035, 0.02), color: '#4fd0ff', matrix: tr(head.x, head.y, head.z + 0.146, -0.15, 0, 0) });
    for (const sx of [-1, 1]) {
      const sh = V(sx * 0.19, shoulder.y - 0.02, shoulder.z - 0.02), hand = V(sx * 0.205, 0.93, 0.58);
      const elbow = ik(sh, hand, 0.3, 0.3, V(sx * 0.6, -0.3, -0.75).normalize(), new THREE.Vector3());
      parts.push({ geo: sph(), color: W, tint: 1, matrix: tr(sh.x, sh.y, sh.z, 0, 0, 0, 0.068) });
      tube(sh, elbow, 0.056, W, 1);
      tube(elbow, hand, 0.045, SK);
      parts.push({ geo: sph(), color: DK, matrix: tr(hand.x, hand.y, hand.z, 0, 0, 0, 0.05) });
    }
    const body = merge(parts);
    // roue : pneu, jante haute, 3 bâtons à la couleur de l'équipe
    const wparts = [
      { geo: new THREE.TorusGeometry(WR - 0.018, 0.022, 6, 24), color: DK, matrix: tr(0, 0, 0, 0, Math.PI / 2, 0) },
      { geo: new THREE.TorusGeometry(WR - 0.06, 0.03, 5, 24), color: '#2a2a32', matrix: tr(0, 0, 0, 0, Math.PI / 2, 0, 1, 1, 0.55) },
      { geo: new THREE.CylinderGeometry(0.03, 0.03, 0.11, 8), color: '#c9ced8', matrix: tr(0, 0, 0, 0, 0, Math.PI / 2) }
    ];
    for (let k = 0; k < 3; k++) {
      const a = k / 3 * Math.PI * 2;
      wparts.push({ geo: new THREE.BoxGeometry(0.016, WR - 0.05, 0.05), color: W, tint: 1, matrix: tr(0, Math.cos(a) * (WR - 0.05) / 2, Math.sin(a) * (WR - 0.05) / 2, a, 0, 0) });
    }
    const wheel = merge(wparts);
    // segment de jambe (cylindre unité, teinté par instance) et chaussure
    const limb = merge([{ geo: new THREE.CylinderGeometry(1, 0.85, 1, 7), color: W, tint: 1 }]);
    const shoe = merge([{ geo: new THREE.BoxGeometry(0.09, 0.08, 0.25), color: W }]);
    for (const g of [body, wheel, limb, shoe]) computeOutlineNormals(g);
    geoCache = { body, wheel, limb, shoe };
    return geoCache;
  }

  // Sillage : demi-tube ouvert vers le bas, qui s'élargit vers l'arrière, rayé de filets d'air qui défilent.
  function wakeGeometry() {
    const NU = 16, NV = 14, L = 9.5;
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= NV; j++) {
      const v = j / NV, r = lerp(0.5, 1.15, v);
      for (let i = 0; i <= NU; i++) {
        const u = i / NU, th = u * Math.PI;
        pos.push(Math.cos(th) * r, 0.12 + Math.sin(th) * r * 0.95, -0.55 - v * L);
        uv.push(u, v);
      }
    }
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
      const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }
  function wakeMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color('#e9eef4') }, uAlpha: { value: 0 }, uTime: B3D.toon.shared.uTime },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: [
        'uniform vec3 uColor; uniform float uAlpha, uTime; varying vec2 vUv;',
        'void main(){',
        '  float band = floor(vUv.x * 8.0);',
        '  float lane = abs(fract(vUv.x * 8.0) - 0.5);',
        '  float lines = 1.0 - smoothstep(0.1, 0.22, lane);',
        '  float f = fract(vUv.y * 3.0 - uTime * 2.2 + band * 0.37);',
        '  float dash = smoothstep(0.0, 0.15, f) * (1.0 - smoothstep(0.6, 0.85, f));',
        '  float fade = pow(1.0 - vUv.y, 0.8) * smoothstep(0.0, 0.05, vUv.y) * (0.35 + 0.65 * sin(vUv.x * 3.14159));',
        '  float l = lines * dash;',
        '  float a = (0.2 + 0.8 * l) * fade * uAlpha;',
        '  if (a < 0.01) discard;',
        '  gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.35 * l), a);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    });
  }

  // Chevrons peints par le vent sur la chaussée, qui filent vers l'arrière dans le sillage.
  function wakeGroundGeometry() {
    const NV = 10, L = 9.5;
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= NV; j++) {
      const v = j / NV, w = lerp(0.45, 1.05, v);
      for (const u of [0, 1]) { pos.push((u - 0.5) * 2 * w, 0.05, -0.55 - v * L); uv.push(u, v); }
    }
    for (let j = 0; j < NV; j++) { const a = j * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }
  function wakeGroundMaterial(shared) {
    return new THREE.ShaderMaterial({
      uniforms: shared,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: [
        'uniform vec3 uColor; uniform float uAlpha, uTime; varying vec2 vUv;',
        'void main(){',
        '  float x = abs(vUv.x - 0.5) * 2.0;',
        '  float f = fract(vUv.y * 7.0 - x * 0.9 - uTime * 2.6);',
        '  float chev = smoothstep(0.0, 0.08, f) * (1.0 - smoothstep(0.3, 0.42, f));',
        '  float fade = pow(1.0 - vUv.y, 0.9) * smoothstep(0.0, 0.06, vUv.y) * (1.0 - smoothstep(0.75, 1.0, x));',
        '  float a = (0.12 + 0.75 * chev) * fade * uAlpha;',
        '  if (a < 0.01) discard;',
        '  gl_FragColor = vec4(uColor, a);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4
    });
  }

  // ------------------------------------------------------------------ le peloton
  class Peloton {
    // opts : { count, phys (physique du joueur), playerColor, teams }
    constructor(scene, route, L, opts) {
      this.scene = scene;
      this.route = route;
      this.L = L;
      this.phys = opts.phys;
      const rnd = this.rnd = mulberry32((L.seed ^ 0x9e10) + opts.count * 7919);
      // équipes : on évite les couleurs proches du maillot du joueur
      const pc = new THREE.Color(opts.playerColor || '#ffd23a');
      const teams = (opts.teams || [{ name: 'Équipe', color: '#3d7be0' }]).filter((t) => {
        const c = new THREE.Color(t.color);
        return Math.abs(c.r - pc.r) + Math.abs(c.g - pc.g) + Math.abs(c.b - pc.b) > 0.35;
      });
      const names = [];
      const used = new Set();
      while (names.length < opts.count) {
        const n = FIRST[Math.floor(rnd() * FIRST.length)] + ' ' + LAST[Math.floor(rnd() * LAST.length)];
        if (!used.has(n)) { used.add(n); names.push(n); }
      }
      this.riders = names.map((name, i) => {
        const sprinter = rnd() < 0.3 ? 0.6 + rnd() * 0.4 : rnd() * 0.45;
        const climber = rnd() < 0.3 ? 0.6 + rnd() * 0.4 : rnd() * 0.45;
        const team = teams[i % teams.length];
        return {
          id: i, name, team, color: new THREE.Color(team.color),
          sprinter, climber, aggr: rnd(),
          mass: 76 + rnd() * 10 - climber * 6 + sprinter * 3,
          cp: 285 + rnd() * 60 + climber * 15, wp: 15000 + rnd() * 9000, pmax: 760 + sprinter * 420,
          pull: 14 + rnd() * 26, form: 0.97 + rnd() * 0.06,
          s: 0, lat: 0, v: 0, latV: 0, power: 0, reserve: 0, bonk: false, state: 'follow', stateT: 0,
          latT: 0, sT: null, vT: null, pullT: 0, crank: rnd() * 6.28, wheelA: rnd() * 6.28, lean: 0, rock: 0,
          cross: {}, finishT: null, done: false, flatT: 0, sprintDone: new Set(), komDone: new Set()
        };
      });
      this.lines = [];
      if (L.race) {
        L.race.sprints.forEach((sp, k) => this.lines.push({ key: 's' + k, s: sp.s, kind: 'sprint' }));
        L.race.koms.forEach((c, k) => this.lines.push({ key: 'k' + k, s: c.s1, s0: c.s0, cat: c.cat, kind: 'kom' }));
      }
      this.lines.push({ key: 'fin', s: route.sEnd, kind: 'finish' });
      this.events = [];
      this.groups = [];
      this._buildRender();
    }

    // Grille de départ derrière la ligne : le joueur au centre du premier rang.
    reset(player) {
      const route = this.route, half = this.L.roadHalf;
      const lanes = [-1.2, -0.4, 0.4, 1.2].map((x) => clamp(x, -(half - 0.5), half - 0.5));
      let row = 0, col = 0;
      const slots = [];
      // premier rang : de part et d'autre du joueur
      slots.push([0, -1.15], [0, 1.15]);
      for (row = 1; slots.length < this.riders.length; row++) for (col = 0; col < 4 && slots.length < this.riders.length; col++) slots.push([row, lanes[col]]);
      this.riders.forEach((r, i) => {
        const [rw, lat] = slots[i];
        Object.assign(r, {
          s: route.sStart - 4 - rw * ROW - (i % 2) * 0.3, lat, v: 0, latV: 0, latT: lat, power: 0, reserve: r.wp, bonk: false,
          state: 'follow', stateT: 0, pullT: 0, cross: {}, finishT: null, done: false, flatT: 0, sT: null, vT: null
        });
        r.sprintDone = new Set(); r.komDone = new Set();
      });
      this.player = player;
      this.list = this.riders.concat([player]);
      this.sortList();
      this.time = 0;
      this.decideT = 0;
      this.attackCool = 60;
      this.flatTimer = 100 + this.rnd() * 120;
      this.playerLeadT = 0;
      this.msgCool = 0;
      this.events.length = 0;
      this._decide();
    }

    sortList() {
      const a = this.list;
      for (let i = 1; i < a.length; i++) {
        const x = a[i];
        let j = i - 1;
        while (j >= 0 && a[j].s < x.s) { a[j + 1] = a[j]; j--; }
        a[j + 1] = x;
      }
    }

    // abri du joueur (ou de tout coureur)
    shelterFor(r) { return shelter(this.list, r.s, r.lat, r); }

    // ------------------------------------------------------------ décisions (toutes les 0,2 s)
    _decide() {
      const list = this.list, half = this.L.roadHalf, route = this.route, player = this.player;
      const laneMax = half - 0.5;
      // groupes : coureurs séparés de moins de GROUP_GAP mètres
      const groups = [];
      let g = null;
      for (const r of list) {
        if (r.done) continue;
        if (!g || g.last.s - r.s > GROUP_GAP) { g = { members: [], leader: r, last: r, form: [] }; groups.push(g); }
        g.members.push(r);
        g.last = r;
        r.group = g;
      }
      const outOfForm = (r) => !r.isPlayer && (r.state === 'swing' || r.state === 'attack' || r.state === 'flat' || r.state === 'relay' || r.state === 'bridge');
      for (let gi = 0; gi < groups.length; gi++) {
        const G = groups[gi];
        for (const r of G.members) if (!outOfForm(r)) G.form.push(r);
        if (!G.form.length) G.form.push(G.members[0]);
        G.head = G.form[0];
        G.cols = G.form.length <= 6 ? 1 : G.form.length <= 15 ? 2 : 3;
        // file de référence : celle de la tête, qui serre doucement à droite (sauf si c'est le joueur)
        G.lane = clamp(lerp(G.head.lat, 0.55, G.head.isPlayer ? 0 : 0.08), -laneMax + (G.cols - 1) * COL / 2, laneMax - (G.cols - 1) * COL / 2);
        const prev = groups[gi - 1];
        G.chasing = !!prev && prev.last.s - G.head.s < 250 && G.form.length >= 3;
        G.form.forEach((r, k) => { r.rank = k; });
      }
      this.groups = groups;
      this.playerGroup = player.group;

      // le joueur mène depuis longtemps : un coureur vient prendre le relais
      const PG = player.group;
      if (PG && PG.head === player && PG.form.length >= 2) this.playerLeadT += 0.2; else this.playerLeadT = 0;
      if (this.playerLeadT > 22) {
        const cand = PG.form.find((r) => !r.isPlayer && r.state === 'follow' && r.reserve > r.wp * 0.4);
        if (cand) {
          this._setState(cand, 'relay');
          cand.relaySide = player.lat > 0 ? -1 : 1;
          this.playerLeadT = 0;
          this._event('relay', cand);
        }
      }

      for (const r of this.riders) this._decideRider(r);
    }

    _setState(r, st) { r.state = st; r.stateT = 0; }

    _event(type, r, extra) {
      this.events.push(Object.assign({ type, rider: r }, extra || {}));
    }

    _decideRider(r) {
      if (r.done) return;
      const route = this.route, L = this.L, half = L.roadHalf, player = this.player;
      const G = r.group, head = G.head;
      const laneMax = half - 0.45;
      const q = route.sample(r.s + 40, this._tmp || (this._tmp = {}));
      const gradeAhead = q.grade;
      const pace = (f) => r.cp * r.form * f;
      let flatPace = 0.86;
      if (gradeAhead > 0.03) flatPace = 0.96; else if (gradeAhead < -0.06) flatPace = 0; else if (gradeAhead < -0.03) flatPace = 0.45;
      if (G.chasing) flatPace += 0.06;
      const st = r.state;

      // déclencheurs : sprint, grimpée, attaque, crevaison
      if (st === 'follow' || st === 'chase') {
        for (const ln of this.lines) {
          const d = ln.s - r.s;
          if (ln.kind !== 'kom' && d > 0 && d < 160 + 160 * r.sprinter && !r.sprintDone.has(ln.key) && r.reserve > r.wp * 0.15 && (ln.kind === 'finish' || r.sprinter > 0.35)) {
            r.sprintDone.add(ln.key);
            this._setState(r, 'sprint');
            r.sprintLine = ln.s;
            break;
          }
          if (ln.kind === 'kom' && ln.cat <= 2 && d > 0 && d < 700 && r.climber > 0.55 && !r.komDone.has(ln.key) && r.reserve > r.wp * 0.5 && this.rnd() < 0.02) {
            r.komDone.add(ln.key);
            this._attack(r, 1.28, 30 + this.rnd() * 30);
            break;
          }
        }
      }
      if (r.state === 'follow' && r.rank > 0 && G.form.length >= 3 && this.attackCool <= 0 && r.reserve > r.wp * 0.85) {
        const climbing = gradeAhead > 0.035;
        const late = (r.s - route.sStart) / route.length > 0.7;
        if (this.rnd() < 0.0009 * (0.5 + r.aggr) * (climbing ? 3 : 1) * (late ? 2 : 1)) this._attack(r, 1.32, 20 + this.rnd() * 25);
      }

      // comportement selon l'état
      r.vT = null; r.sT = null; r.brake = 0; r.cap = 0;
      switch (r.state) {
        case 'follow': {
          if (r.rank === 0 || r === head) {
            // seul juste derrière un groupe : il fait l'effort pour rentrer
            const ahead = this._riderAhead(r);
            if (ahead && ahead.s - r.s < 45 && r.reserve > r.wp * 0.35) { this._setState(r, 'chase'); r.chaseTarget = ahead; break; }
            // en tête : il donne le rythme, puis se décale pour passer le relais
            r.target = pace(flatPace);
            r.latT = clamp(G.lane - (G.cols - 1) / 2 * COL, -laneMax, laneMax);
            r.pullT += 0.2;
            if (r.pullT > r.pull * (gradeAhead > 0.04 ? 1.6 : 1) && G.form.length >= 2) {
              this._setState(r, 'swing');
              r.swingSide = G.lane > 0 ? -1 : 1;
              r.pullT = 0;
              const next = G.form[1];
              if (next && next.isPlayer && G.form.length >= 3) this._event('yourTurn', r);
            }
          } else {
            // place dans la formation : rangs de 1 à 3 files derrière la tête
            const k = r.rank, cols = G.cols;
            const row = Math.floor(k / cols), col = k % cols;
            r.sT = head.s - row * ROW - (col % 2) * 0.55;
            r.vT = head.v;
            r.latT = clamp(G.lane + (col - (cols - 1) / 2) * COL, -laneMax, laneMax);
            // décroché mais pas loin : il essaie de revenir
            const ahead = this._riderAhead(r);
            if (ahead && ahead.group !== G && ahead.s - r.s < 60 && r.reserve > r.wp * 0.4) { this._setState(r, 'chase'); r.chaseTarget = ahead; }
          }
          break;
        }
        case 'swing': {
          r.latT = clamp(G.lane + r.swingSide * (G.cols * COL / 2 + 0.85), -laneMax, laneMax);
          r.target = pace(flatPace) * 0.55;
          if (r.s < G.last.s - 1.2 || r.stateT > 40) this._setState(r, 'follow');
          break;
        }
        case 'attack': {
          r.target = Math.min(r.pmax, r.cp * r.attackF);
          r.latT = r.s > head.s + 3 ? clamp(r.lat * 0.98 + 0.02 * 0.4, -laneMax, laneMax) : clamp(G.lane + r.attackSide * (G.cols * COL / 2 + 0.9), -laneMax, laneMax);
          if (r.stateT > r.attackDur || r.reserve < r.wp * 0.2) this._setState(r, 'follow');
          break;
        }
        case 'bridge': {
          const t = r.chaseTarget;
          if (!t || t.done) { this._setState(r, 'follow'); break; }
          r.sT = t.s - 1.6; r.vT = t.v; r.latT = t.lat;
          r.cap = r.cp * 1.3;
          if ((t.s - r.s < 2.5 && Math.abs(t.lat - r.lat) < 0.3) || r.stateT > 50 || r.reserve < r.wp * 0.2) this._setState(r, 'follow');
          break;
        }
        case 'chase': {
          const t = r.chaseTarget;
          if (!t || t.done || r.reserve < r.wp * 0.25 || r.stateT > 90) { this._setState(r, 'follow'); break; }
          r.sT = t.s - 1.6; r.vT = t.v + 0.6; r.latT = clamp(t.lat, -laneMax, laneMax);
          r.cap = r.cp * 1.12;
          if (t.s - r.s < 3) this._setState(r, 'follow');
          break;
        }
        case 'relay': {
          // il double le joueur puis se rabat devant lui
          const side = r.relaySide;
          if (r.s < player.s + 2.4) { r.sT = player.s + 3.5; r.vT = player.v + 1.2; r.latT = clamp(player.lat + side * 0.85, -laneMax, laneMax); }
          else { r.sT = player.s + 3; r.vT = player.v; r.latT = player.lat; }
          if ((r.s > player.s + 2.6 && Math.abs(r.lat - player.lat) < 0.25) || r.stateT > 25) { this._setState(r, 'follow'); r.pullT = 0; }
          break;
        }
        case 'sprint': {
          r.target = r.pmax;
          if (r.s > r.sprintLine + 5 || r.reserve <= 0) this._setState(r, 'follow');
          break;
        }
        case 'flat': {
          r.target = 0;
          r.latT = laneMax;
          r.brake = r.v > 0.3 ? 220 : 0;
          if (r.v < 0.3) {
            r.flatT += 0.2;
            if (r.flatT > 10) {
              r.flatT = 0;
              const ahead = this._riderAhead(r);
              this._setState(r, 'chase');
              r.chaseTarget = ahead;
              this._event('fixed', r);
            }
          }
          break;
        }
        default: break;
      }
    }

    _attack(r, f, dur) {
      const G = r.group;
      this._setState(r, 'attack');
      r.attackF = f; r.attackDur = dur;
      r.attackSide = G && G.lane > 0 ? -1 : 1;
      this.attackCool = 45 + this.rnd() * 30;
      this._event('attack', r);
      // un coureur saute dans sa roue
      if (G && this.rnd() < 0.45) {
        const f2 = G.form.find((o) => !o.isPlayer && o !== r && o.state === 'follow' && o.reserve > o.wp * 0.6);
        if (f2) { this._setState(f2, 'bridge'); f2.chaseTarget = r; }
      }
    }

    _riderAhead(r) {
      const i = this.list.indexOf(r);
      for (let k = i - 1; k >= 0; k--) { const o = this.list[k]; if (!o.done && o.state !== 'flat') return o; }
      return null;
    }

    // crevaison d'un coureur proche du joueur (la voiture suiveuse vient le dépanner)
    _maybeFlat(dt) {
      this.flatTimer -= dt;
      if (this.flatTimer > 0) return;
      this.flatTimer = 120 + this.rnd() * 160;
      const P = this.player;
      const cands = this.riders.filter((r) => !r.done && r.state === 'follow' && Math.abs(r.s - P.s) < 120 && r.s < this.route.sEnd - 800);
      if (!cands.length) return;
      const r = cands[Math.floor(this.rnd() * cands.length)];
      this._setState(r, 'flat');
      r.flatT = 0;
      this._event('flat', r);
    }

    // ------------------------------------------------------------ physique (pas de temps h)
    step(h) {
      const route = this.route, L = this.L, half = L.roadHalf, phys = this.phys;
      const laneMax = half - 0.45;
      this.time += h;
      this.attackCool -= h;
      this.decideT -= h;
      if (this.decideT <= 0) { this.decideT = 0.2; this._decide(); }
      this._maybeFlat(h);
      const tmp = this._tmp2 || (this._tmp2 = {});
      for (const r of this.riders) {
        r.stateT += h;
        const q = route.sample(r.s, tmp);
        const grade = q.grade;
        const sinA = grade / Math.sqrt(1 + grade * grade);
        const sh = shelter(this.list, r.s, r.lat, r).f;
        r.draft = sh;
        const m = r.mass;
        const resist = (v) => m * phys.g * (sinA + phys.crr) + 0.5 * phys.rho * phys.cda * (1 - sh) * v * v;
        // puissance disponible (réserve vide = il « explose » et roule sous son seuil)
        if (r.reserve <= 0) r.bonk = true;
        if (r.bonk && r.reserve > r.wp * 0.3) r.bonk = false;
        const avail = r.bonk ? r.cp * 0.88 : (r.cap || r.pmax);
        let P, brake = 0;
        if (r.done) {
          P = 0;
          brake = r.v > 0.5 ? 60 : 0;
        } else if (r.sT !== null) {
          // régulateur : rejoindre sa place (s visée) à la vitesse de son groupe
          const e = r.sT - r.s;
          const vT = Math.max(0, r.vT + clamp(e * 0.55, -2, 2.5));
          const F = resist(Math.max(vT, 0.5)) + m * (vT - r.v) / 1.2;
          P = clamp(F * Math.max(r.v, 2), 0, avail);
          if (e < -1.2 && r.v > vT + 0.4) brake = Math.min(260, (r.v - vT) * 120);
        } else {
          P = clamp(r.target || 0, 0, avail);
          brake = r.brake || 0;
        }
        // montée en puissance progressive
        r.power += clamp(P - r.power, -2500 * h, 1600 * h);
        const drive = r.power / Math.max(r.v, 1.6);
        const fr = r.v > 0.05 ? phys.crr * m * phys.g : 0;
        let a = (drive - m * phys.g * sinA - fr - 0.5 * phys.rho * phys.cda * (1 - sh) * r.v * r.v - brake) / m;
        if (r.v <= 0.01 && a < 0) a = 0;
        const s0 = r.s;
        r.v = clamp(r.v + a * h, 0, phys.vMax);
        r.s += r.v * h;
        r.reserve = clamp(r.reserve + (r.cp - r.power) * h * (r.power < r.cp ? 0.6 : 1), 0, r.wp);
        // passages de lignes (sprints, sommets, arrivée)
        for (const ln of this.lines) {
          if (s0 < ln.s && r.s >= ln.s && r.cross[ln.key] === undefined) {
            r.cross[ln.key] = this.time - (r.s - ln.s) / Math.max(0.5, r.v);
            if (ln.kind === 'finish') { r.finishT = r.cross.fin; r.done = true; r.state = 'done'; r.latT = clamp((r.id % 5 - 2) * 0.9, -laneMax, laneMax); }
          }
        }
        // déplacement latéral, bloqué si un voisin est à côté
        const want = clamp((r.latT - r.lat) * 1.6, -1.1, 1.1);
        r.latV = lerp(r.latV, want, 1 - Math.exp(-h * 5));
        const nl = this.lateralBlock(r, r.lat + r.latV * h);
        if (nl === r.lat) r.latV = 0;
        r.lat = clamp(nl, -laneMax, laneMax);
      }
      this.sortList();
      this._resolve();
    }

    // On ne se décale pas sur un coureur qui roule à côté (renvoie la position latérale permise).
    lateralBlock(r, nl) {
      for (const o of this.list) {
        if (o === r || o.done || r.done || o.state === 'flat') continue;
        if (Math.abs(o.s - r.s) > 1.9) continue;
        const before = Math.abs(o.lat - r.lat), after = Math.abs(o.lat - nl);
        if (after < LAT_OVERLAP && after < before) return r.lat;
      }
      return nl;
    }

    // Personne ne rentre dans la roue de devant : celui de derrière est ralenti (le joueur compris).
    _resolve() {
      const list = this.list;
      for (let i = 1; i < list.length; i++) {
        const r = list[i];
        if (r.done) continue;
        for (let k = i - 1; k >= 0; k--) {
          const o = list[k];
          if (o.s - r.s > MIN_GAP) break;
          // un coureur arrêté (crevaison) est sur le bas-côté : on le contourne
          if (o.done || o.state === 'flat' || r.state === 'flat' || Math.abs(o.lat - r.lat) >= LAT_OVERLAP) continue;
          r.s = o.s - MIN_GAP;
          if (r.v > o.v) {
            if (r.isPlayer && r.v - o.v > 1.2) this._event('bump', o);
            r.v = o.v;
          }
        }
      }
    }

    // ------------------------------------------------------------ infos pour le HUD et la caravane
    raceInfo() {
      const P = this.player;
      let ahead = 0;
      for (const r of this.riders) if (r.done || r.s > P.s) ahead++;
      const head = this.groups.find((g) => !g.leader.done);
      const pg = P.group;
      const lead = head ? head.leader : null;
      return {
        position: ahead + 1, total: this.riders.length + 1,
        groupSize: pg ? pg.members.length : 1,
        gapHead: lead && lead !== P ? Math.max(0, (lead.s - P.s) / Math.max(4, P.v)) : 0,
        inHead: !!pg && pg === head,
        groups: this.groups.length
      };
    }

    // classement à l'arrivée du joueur
    standings(playerTime) {
      const rows = this.riders.map((r) => ({ name: r.name, team: r.team.name, color: r.team.color, t: r.finishT, s: r.s }));
      rows.push({ name: 'Toi', player: true, t: playerTime, s: this.route.sEnd });
      rows.sort((a, b) => {
        if (a.t !== null && b.t !== null) return a.t - b.t;
        if (a.t !== null) return -1;
        if (b.t !== null) return 1;
        return b.s - a.s;
      });
      return rows;
    }

    // ------------------------------------------------------------ rendu
    _buildRender() {
      const G = geometries();
      const n = Math.max(1, this.riders.length);
      const mk = (geo, cap, ow, shadow) => {
        const mesh = new THREE.InstancedMesh(geo, instancedMat(), cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
        mesh.frustumCulled = false;
        mesh.castShadow = shadow;
        mesh.count = 0;
        this.scene.add(mesh);
        const ol = new THREE.InstancedMesh(geo, outlineMat({ width: ow, minW: 0.004, maxW: 0.04 }), cap);
        ol.instanceMatrix = mesh.instanceMatrix;
        ol.frustumCulled = false;
        ol.count = 0;
        this.scene.add(ol);
        return { mesh, ol };
      };
      this.mBody = mk(G.body, n, 0.85, true);
      this.mWheel = mk(G.wheel, n * 2, 0.7, true);
      this.mLimb = mk(G.limb, n * 4, 0.8, true);
      this.mShoe = mk(G.shoe, n * 2, 0.8, false);
      const skin = new THREE.Color('#f1c29b'), shorts = new THREE.Color('#26232f'), white = new THREE.Color('#ffffff');
      this.riders.forEach((r, i) => {
        this.mBody.mesh.setColorAt(i, r.color);
        this.mWheel.mesh.setColorAt(i * 2, r.color); this.mWheel.mesh.setColorAt(i * 2 + 1, r.color);
        for (let k = 0; k < 4; k++) this.mLimb.mesh.setColorAt(i * 4 + k, k < 2 ? shorts : skin);
        this.mShoe.mesh.setColorAt(i * 2, white); this.mShoe.mesh.setColorAt(i * 2 + 1, white);
      });
      for (const M of [this.mBody, this.mWheel, this.mLimb, this.mShoe]) M.mesh.instanceColor.needsUpdate = true;
      // sillage
      this.wake = new THREE.Mesh(wakeGeometry(), wakeMaterial());
      this.wake.frustumCulled = false;
      this.wake.renderOrder = 4;
      this.wake.visible = false;
      const ground = new THREE.Mesh(wakeGroundGeometry(), wakeGroundMaterial(this.wake.material.uniforms));
      ground.frustumCulled = false;
      ground.renderOrder = 3;
      this.wake.add(ground);
      this.scene.add(this.wake);
      this.wakeAlpha = 0;
      // étiquettes de nom
      this.tags = [];
      for (let k = 0; k < 3; k++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: true }));
        sp.scale.set(1.6, 0.26, 1);
        sp.visible = false;
        sp.renderOrder = 6;
        this.scene.add(sp);
        this.tags.push(sp);
      }
      this.tagTex = new Map();
    }

    _tagTexture(r) {
      let t = this.tagTex.get(r);
      if (t) return t;
      t = textTexture((ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(29,26,43,0.72)';
        const rr = 26;
        ctx.beginPath();
        ctx.moveTo(rr, 4); ctx.lineTo(w - rr, 4); ctx.quadraticCurveTo(w - 4, 4, w - 4, h / 2); ctx.quadraticCurveTo(w - 4, h - 4, w - rr, h - 4);
        ctx.lineTo(rr, h - 4); ctx.quadraticCurveTo(4, h - 4, 4, h / 2); ctx.quadraticCurveTo(4, 4, rr, 4); ctx.fill();
        ctx.fillStyle = r.team.color;
        ctx.beginPath(); ctx.arc(34, h / 2, 14, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 34px Fredoka, Arial, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(r.name, 58, h / 2 + 2);
      }, 400, 64);
      this.tagTex.set(r, t);
      return t;
    }

    render(dt, camera) {
      const route = this.route, n = this.riders.length;
      const q = this._rq || (this._rq = {});
      const m4 = new THREE.Matrix4(), ml = new THREE.Matrix4(), mw = new THREE.Matrix4();
      const quat = new THREE.Quaternion(), eul = new THREE.Euler(0, 0, 0, 'YXZ'), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
      const BB = this._BB || (this._BB = V(0, 0.28, -0.08));
      const hip = new THREE.Vector3(), pedal = new THREE.Vector3(), ankle = new THREE.Vector3(), knee = new THREE.Vector3(), toe = new THREE.Vector3(), d = new THREE.Vector3();
      const bend = V(0, 0.25, 1), mid = new THREE.Vector3(), q2 = new THREE.Quaternion(), sc = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const r = this.riders[i];
        route.sample(r.s, q);
        const steer = Math.atan2(r.latV, Math.max(r.v, 2));
        const lean = clamp(-Math.atan(r.v * r.v * q.curv / 9.81) + r.latV * 0.06, -0.5, 0.5);
        r.lean = lerp(r.lean, lean, 1 - Math.exp(-dt * 5));
        // danseuse dans les fortes pentes : le vélo se balance
        const dancing = q.grade > 0.07 && r.power > r.cp * 0.9;
        r.rock = lerp(r.rock, dancing ? Math.sin(r.crank) * 0.1 : 0, 1 - Math.exp(-dt * 6));
        pos.set(q.x + q.rx * r.lat, q.y, q.z + q.rz * r.lat);
        eul.set(-Math.atan(q.grade), Math.atan2(q.tx, q.tz) - steer, r.lean + r.rock, 'YXZ');
        quat.setFromEuler(eul);
        m4.compose(pos, quat, one);
        r.pos = r.pos || new THREE.Vector3();
        r.pos.copy(pos);
        this.mBody.mesh.setMatrixAt(i, m4);
        // roues
        r.wheelA += r.v / WR * dt;
        for (let w = 0; w < 2; w++) {
          ml.makeRotationX(r.wheelA);
          ml.setPosition(0, WR, w ? 0.52 : -0.5);
          mw.multiplyMatrices(m4, ml);
          this.mWheel.mesh.setMatrixAt(i * 2 + w, mw);
        }
        // pédalage (braquet automatique ~90 tr/min) ; pédales à l'horizontale en roue libre
        if (r.power > 25 && r.v > 0.3) {
          const wheelRpm = r.v / (2 * Math.PI * WR) * 60;
          r.crank += wheelRpm / clamp(wheelRpm / 88, 1.3, 4.4) / 60 * Math.PI * 2 * dt;
        } else {
          const target = Math.round((r.crank - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
          r.crank = lerp(r.crank, target, 1 - Math.exp(-dt * 4));
        }
        for (let side = 0; side < 2; side++) {
          const sx = side ? 1 : -1, sgn = -sx;
          pedal.set(sx * 0.12, BB.y + sgn * Math.cos(r.crank) * 0.17, BB.z + sgn * Math.sin(r.crank) * 0.17);
          ankle.copy(pedal).add(d.set(0, 0.07, -0.05));
          hip.set(sx * 0.095, 0.97, -0.24);
          bend.set(sx * 0.12, 0.25, 1).normalize();
          ik(hip, ankle, 0.46, 0.45, bend, knee);
          const seg = (a, b, rad, idx) => {
            d.copy(b).sub(a);
            const len = d.length();
            ml.compose(mid.copy(a).add(b).multiplyScalar(0.5), q2.setFromUnitVectors(UP, d.divideScalar(len || 1)), sc.set(rad, len, rad));
            mw.multiplyMatrices(m4, ml);
            this.mLimb.mesh.setMatrixAt(idx, mw);
          };
          seg(hip, knee, 0.078, i * 4 + side);
          seg(knee, ankle, 0.058, i * 4 + 2 + side);
          toe.copy(pedal).add(d.set(0, 0.03, 0.09));
          d.copy(toe).sub(ankle).normalize();
          ml.compose(mid.copy(ankle).add(toe).multiplyScalar(0.5), q2.setFromUnitVectors(FWD, d), one);
          mw.multiplyMatrices(m4, ml);
          this.mShoe.mesh.setMatrixAt(i * 2 + side, mw);
        }
      }
      for (const [M, k] of [[this.mBody, 1], [this.mWheel, 2], [this.mLimb, 4], [this.mShoe, 2]]) {
        M.mesh.count = M.ol.count = n * k;
        M.mesh.instanceMatrix.needsUpdate = true;
      }
      this._renderWake(dt);
      this._renderTags(camera);
    }

    // sillage derrière le coureur qui précède le joueur : vert dans l'aspiration, gris clair sinon
    _renderWake(dt) {
      const P = this.player;
      if (!P) return;
      let src = null, best = 1e9;
      for (const r of this.riders) {
        if (r.done || r.state === 'flat') continue;
        const ds = r.s - P.s, dl = Math.abs(r.lat - P.lat);
        if (ds < 0.4 || ds > 16 || dl > 2.6) continue;
        const c = ds + dl * 4;
        if (c < best) { best = c; src = r; }
      }
      const inDraft = (this.playerDraft || 0) > 0.04;
      if (inDraft && this.playerDraftSrc && !this.playerDraftSrc.isPlayer) src = this.playerDraftSrc;
      const target = src ? (inDraft ? 0.9 : 0.55) : 0;
      this.wakeAlpha = lerp(this.wakeAlpha, target, 1 - Math.exp(-dt * 6));
      if (src) this.wakeSrc = src;
      const w = this.wake;
      w.visible = this.wakeAlpha > 0.02 && !!this.wakeSrc;
      if (!w.visible) return;
      const r = this.wakeSrc, q = this.route.sample(r.s, this._wq || (this._wq = {}));
      w.position.set(q.x + q.rx * r.lat, q.y, q.z + q.rz * r.lat);
      w.rotation.set(-Math.atan(q.grade), Math.atan2(q.tx, q.tz), 0, 'YXZ');
      w.material.uniforms.uColor.value.set(inDraft ? '#3fe87a' : '#f4f8ff');
      w.material.uniforms.uAlpha.value = this.wakeAlpha * (inDraft ? 1 : 0.75);
    }

    // étiquettes de nom des coureurs devant la caméra, ni trop près ni trop loin
    _renderTags(camera) {
      const cp = camera.getWorldPosition(this._cp || (this._cp = new THREE.Vector3()));
      const fwd = camera.getWorldDirection(this._cf || (this._cf = new THREE.Vector3()));
      const near = [];
      for (const r of this.riders) {
        if (!r.pos || r.done) continue;
        const d = r.pos.distanceTo(cp);
        if (d < 7 || d > 30) continue;
        const ahead = (r.pos.x - cp.x) * fwd.x + (r.pos.y - cp.y) * fwd.y + (r.pos.z - cp.z) * fwd.z;
        if (ahead < d * 0.8) continue;
        near.push([d, r]);
      }
      near.sort((a, b) => a[0] - b[0]);
      this.tags.forEach((sp, k) => {
        const e = near[k];
        if (!e) { sp.visible = false; return; }
        const [d, r] = e;
        sp.visible = true;
        const tex = this._tagTexture(r);
        if (sp.material.map !== tex) { sp.material.map = tex; sp.material.needsUpdate = true; }
        sp.material.opacity = clamp((30 - d) / 8, 0, 1) * clamp((d - 7) / 3, 0, 1) * 0.95;
        sp.position.copy(r.pos);
        sp.position.y += 2.0;
      });
    }

    dispose() {
      for (const M of [this.mBody, this.mWheel, this.mLimb, this.mShoe]) { this.scene.remove(M.mesh); this.scene.remove(M.ol); }
      this.scene.remove(this.wake);
      this.wake.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      for (const sp of this.tags) { this.scene.remove(sp); sp.material.dispose(); }
      for (const t of this.tagTex.values()) t.dispose();
    }
  }

  Peloton.shelter = shelter;
  B3D.Peloton = Peloton;
})(typeof window !== 'undefined' ? window : globalThis);
