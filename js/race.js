/* Bike3D — la course : sprints intermédiaires, Grand Prix de la Montagne (arches au pied et au sommet des cols),
   zone de ravitaillement avec soigneurs, musettes à attraper et voitures d'équipe.
   Le coureur est classé face à des rivaux virtuels qui roulent à puissance constante. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { mulberry32 } = B3D.util;
  const { merge, tr, addOutline, textTexture } = B3D.toon;

  const RIVAL_NAMES = ['Kévin Watts', 'Jean-Mi Danseuse', 'Lulu Lagrimpette', 'Bernard Braquet', 'Momo Moulinette', 'Toto Tubeless',
    'Gégé Gruppetto', 'Fanfan Fringale', 'Dédé Dérailleur', 'Pépette Pignon', 'Riri Rouleur', 'Nono Bidon'];
  const TEAMS = [
    { name: 'Croissant-Beurre', color: '#f2c230' }, { name: 'Pédale Joyeuse', color: '#3d7be0' },
    { name: 'Mollets d’Or', color: '#e2463a' }, { name: 'Team Baguette', color: '#c98a3d' },
    { name: 'Les Cigales', color: '#4cc35a' }, { name: 'Fromagerie Vélo', color: '#9b6bff' }, { name: 'Rayon de Soleil', color: '#ff7aa8' }
  ];
  // puissances (W) des rivaux, du plus lent au plus rapide
  const SPRINT_W = [250, 320, 390, 450, 510, 560, 610];
  const KOM_W = [215, 245, 270, 295, 315, 335, 355]; // à tenir sur toute la montée : autour du seuil
  const SPRINT_LEN = 400; // le sprint se joue sur les 400 derniers mètres
  const SPRINT_PTS = [20, 17, 15, 13, 11, 10, 9, 8];
  const KOM_PTS = [[20, 15, 12, 10, 8, 6, 4, 2], [10, 8, 6, 4, 2, 1], [5, 3, 2, 1], [2, 1], [1]];
  const MUSETTE_REFILL = 0.5; // une musette recharge la moitié de la réserve d'énergie
  const CAT_LABEL = (c) => (c === 0 ? 'HC' : c + (c === 1 ? 're' : 'e') + ' cat.');
  const CAT_BANNER = (c) => (c === 0 ? 'HC' : 'CAT. ' + c);

  // ------------------------------------------------------------------ planification
  function plan(route, L) {
    if (L.race) return L.race;
    const rnd = mulberry32(L.seed ^ 0x5e1ec7);
    const S0 = route.sStart, len = route.length, half = L.roadHalf;
    const o = {}, o2 = {};
    const busy = [];
    const free = (a, b) => busy.every(([c, d]) => b < c || a > d);
    const idx = (s) => route.sample(s, o).i;
    L.keepOut = L.keepOut || [];
    L.fenceL = L.fenceL || new Uint8Array(route.n);
    L.fenceR = L.fenceR || new Uint8Array(route.n);

    // rivaux : un nom tiré au sort par puissance
    const names = RIVAL_NAMES.slice();
    for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }

    // Grand Prix de la Montagne : chaque montée classée
    const koms = route.climbs.map((c, i) => ({
      i, name: L.climbNames[i], cat: c.cat, s0: S0 + c.d0, s1: S0 + c.d1, length: c.length, gain: c.gain,
      avg: c.gain / Math.max(1, c.length),
      arch: c.cat <= 3 || c.gain > 120,
      foot: (c.cat <= 2 || c.gain > 150) && c.length > 1200 && c.d0 > 120
    }));
    for (const k of koms) {
      busy.push([k.s1 - 350, k.s1 + 250]);
      if (k.foot) busy.push([k.s0 - 200, k.s0 + 150]);
    }
    busy.push([S0 - 100, S0 + 600], [route.sEnd - 1500, route.sEnd + 100]);

    // l'arche ne doit pas tomber sur un pont, au-dessus d'un ravin ni sur un tronçon qui se chevauche
    const archOk = (s) => {
      for (let d = -6; d <= 6; d += 3) {
        const i = idx(s + d);
        if (L.bridgeMask[i] || route.dup[i] || L.dropL[i] > 1.4 || L.dropR[i] > 1.4 || L.dropL[i] < -2.5 || L.dropR[i] < -2.5) return false;
      }
      return true;
    };
    const gradeOver = (a, b) => (route.sample(b, o).y - route.sample(a, o2).y) / Math.max(1, b - a);
    const maxCurv = (a, b) => { let m = 0; for (let s = a; s <= b; s += 10) m = Math.max(m, Math.abs(route.sample(s, o).curv)); return m; };
    const inClimb = (a, b) => koms.some((k) => b > k.s0 && a < k.s1);

    // sprints intermédiaires (de préférence sur le plat, dans un village)
    const sprints = [];
    const nS = len < 3500 ? 0 : Math.max(1, Math.min(3, Math.round(len / 35000)));
    for (let k = 0; k < nS; k++) {
      const target = S0 + len * ((k + 1) / (nS + 1) - (nS === 1 ? 0.1 : 0.05));
      let best = null, bestC = 1e9;
      for (let s = S0 + 600 + SPRINT_LEN; s < route.sEnd - 1600; s += 15) {
        if (!free(s - SPRINT_LEN - 150, s + 150)) continue;
        const g = gradeOver(s - SPRINT_LEN, s);
        if (g > 0.045 || g < -0.05) continue;
        if (!archOk(s)) continue;
        let gMax = 0;
        for (let d = 0; d <= SPRINT_LEN; d += 25) gMax = Math.max(gMax, Math.abs(route.sample(s - d, o).grade));
        let c = Math.abs(g) * 30 + gMax * 25 + maxCurv(s - 200, s + 20) * 120 + Math.abs(s - target) / len * 6;
        if (inClimb(s - SPRINT_LEN, s)) c += 1.5;
        if (L.villageW[idx(s)] > 0.5) c -= 0.6;
        if (c < bestC) { bestC = c; best = s; }
      }
      if (best === null) continue;
      const vi = L.villages.findIndex((v) => best >= v.i0 * route.spacing && best <= v.i1 * route.spacing);
      sprints.push({ s: best, village: vi >= 0 ? L.villages[vi].name : null, n: k + 1 });
      busy.push([best - SPRINT_LEN - 250, best + 250]);
    }
    sprints.sort((a, b) => a.s - b.s);
    sprints.forEach((sp, k) => { sp.n = k + 1; });

    // zone de ravitaillement : faux plat, hors village, un côté dégagé pour les soigneurs et les voitures
    const feeds = [];
    if (len > 3000) {
      const zl = Math.max(170, Math.min(320, len * 0.03));
      const target = S0 + len * (sprints.length ? 0.62 : 0.5);
      let best = null, bestC = 1e9;
      for (let s = S0 + 700; s + zl < route.sEnd - 1600; s += 20) {
        if (!free(s - 150, s + zl + 120)) continue;
        const g = gradeOver(s, s + zl);
        if (Math.abs(g) > 0.06) continue;
        if (!archOk(s)) continue;
        let bad = false;
        for (let d = 0; d <= zl && !bad; d += 10) { const i = idx(s + d); if (L.villageW[i] > 0.02 || L.bridgeMask[i] || route.dup[i]) bad = true; }
        if (bad) continue;
        const c = Math.abs(g) * 25 + maxCurv(s, s + zl) * 100 + Math.abs(s - target) / len * 5;
        if (c < bestC) { bestC = c; best = s; }
      }
      if (best !== null) {
        const feed = buildFeedPlan(route, L, best, best + zl, rnd);
        if (feed) { feeds.push(feed); busy.push([best - 150, best + zl + 120]); }
      }
    }

    // pas de groupes de supporters sur les barrières du sprint ni au milieu du ravitaillement
    const noFans = sprints.map((sp) => [sp.s - 160, sp.s + 50]).concat(feeds.map((f) => [f.s0 - 30, f.s1 + 30]));
    L.race = { sprints, koms, feeds, names, noFans };
    return L.race;
  }

  // Côté des soigneurs, positions des soigneurs, voitures d'équipe et tables.
  function buildFeedPlan(route, L, s0, s1, rnd) {
    const half = L.roadHalf, o = {};
    const spots = { '-1': [], '1': [] };
    for (const side of [-1, 1]) {
      for (let s = s0 + 30; s < s1 - 15; s += 21) {
        const r = route.sample(s, {});
        const i = r.i;
        if ((side < 0 ? L.railL[i] : L.railR[i]) || (side < 0 ? L.dropL[i] : L.dropR[i]) > 1.2) continue;
        const off = half + 0.55;
        const x = r.x + r.rx * off * side, z = r.z + r.rz * off * side;
        L.sample(x, z, o);
        if (o.under || Math.abs(o.h - r.y) > 0.6) continue;
        spots[side].push({ s, x, z, y: Math.max(o.h, r.y - 0.05), r });
      }
    }
    const side = spots['1'].length >= spots['-1'].length ? 1 : -1;
    const list = spots[side];
    if (list.length < 3) return null;
    const teams = TEAMS.slice().sort(() => rnd() - 0.5);
    const soigneurs = [], cars = [], tables = [];
    list.forEach((sp, k) => {
      const team = teams[k % teams.length];
      const r = sp.r;
      soigneurs.push({ s: sp.s, x: sp.x, z: sp.z, y: sp.y, yaw: Math.atan2(-r.tx, -r.tz), side, team, caught: false });
      // voiture de l'équipe garée derrière son soigneur, si le terrain est plat
      const off = half + 3.6;
      const cs = sp.s + 4;
      const c = route.sample(cs, {});
      const x = c.x + c.rx * off * side, z = c.z + c.rz * off * side;
      let flat = true;
      for (const [a, b] of [[-2.3, -1], [2.3, -1], [-2.3, 1], [2.3, 1], [0, 0]]) {
        L.sample(x + c.tx * a + c.rx * b, z + c.tz * a + c.rz * b, o);
        if (Math.abs(o.h - c.y) > 0.9 || o.under || o.lakeRn < 1.2) flat = false;
      }
      if (flat) {
        cars.push({ x, z, y: L.heightAt(x, z), rot: Math.atan2(c.tx, c.tz), color: team.color });
        L.keepOut.push({ x, z, r: 4 });
      }
      if (k % 2 === 1) {
        const t = route.sample(sp.s - 9, {});
        const toff = half + 1.9;
        const tx = t.x + t.rx * toff * side, tz = t.z + t.rz * toff * side;
        tables.push({ x: tx, z: tz, y: L.heightAt(tx, tz), rot: Math.atan2(t.tx, t.tz) });
        L.keepOut.push({ x: tx, z: tz, r: 1.5 });
      }
      // on ne peut pas rouler sur les soigneurs
      const fence = side < 0 ? L.fenceL : L.fenceR;
      for (let i = r.i - 2; i <= r.i + 2; i++) if (i >= 0 && i < route.n) fence[i] = 1;
    });
    return { s0, s1, side, soigneurs, cars, tables };
  }

  // ------------------------------------------------------------------ construction 3D
  const Z = new THREE.Vector3(0, 0, 1);
  const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _c = new THREE.Vector3();

  // barre (boîte) entre deux points
  function bar(parts, box, ax, ay, az, bx, by, bz, w, h, color) {
    _v.set(bx - ax, by - ay, bz - az);
    const l = _v.length();
    _v.divideScalar(l || 1);
    _q.setFromUnitVectors(Z, _v);
    _c.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    parts.push({ geo: box, color, matrix: new THREE.Matrix4().compose(_c.clone(), _q.clone(), new THREE.Vector3(w, h, l)) });
  }

  // texture de ligne peinte en travers de la route
  function lineTexture(kind) {
    return textTexture((ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      if (kind === 'kom') {
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#e2463a';
        for (let x = 16; x < w; x += 42) for (let y = 16; y < h; y += 34) { ctx.beginPath(); ctx.arc(x + ((y / 34) % 2) * 21, y, 10, 0, Math.PI * 2); ctx.fill(); }
      } else {
        ctx.fillStyle = '#2fa84f'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, h * 0.22, w, h * 0.56);
      }
    }, 512, 64);
  }

  function personParts(color, armDir) {
    const SK = '#f1c7a0';
    const parts = [
      { geo: new THREE.CylinderGeometry(0.07, 0.07, 0.8, 5), color: '#2d3346', matrix: tr(0.1, 0.4, 0) },
      { geo: new THREE.CylinderGeometry(0.07, 0.07, 0.8, 5), color: '#2d3346', matrix: tr(-0.1, 0.4, 0) },
      { geo: new THREE.CapsuleGeometry(0.23, 0.42, 3, 8), color, matrix: tr(0, 1.08, 0) },
      { geo: new THREE.BoxGeometry(0.47, 0.08, 0.47), color: '#ffffff', matrix: tr(0, 1.14, 0) },
      { geo: new THREE.SphereGeometry(0.19, 8, 6), color: SK, matrix: tr(0, 1.63, 0) },
      { geo: new THREE.SphereGeometry(0.2, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), color, matrix: tr(0, 1.68, -0.01) },
      { geo: new THREE.BoxGeometry(0.22, 0.03, 0.16), color, matrix: tr(0, 1.69, 0.2) },
      { geo: new THREE.SphereGeometry(0.035, 6, 4), color: '#1d1a2b', matrix: tr(0.07, 1.67, 0.165) },
      { geo: new THREE.SphereGeometry(0.035, 6, 4), color: '#1d1a2b', matrix: tr(-0.07, 1.67, 0.165) },
      // bras tendu vers la route, l'autre le long du corps
      { geo: new THREE.CylinderGeometry(0.055, 0.05, 0.62, 5), color, matrix: tr(armDir * 0.56, 1.42, 0.04, 0, 0, Math.PI / 2) },
      { geo: new THREE.SphereGeometry(0.075, 6, 4), color: SK, matrix: tr(armDir * 0.9, 1.42, 0.04) },
      { geo: new THREE.CylinderGeometry(0.055, 0.05, 0.5, 5), color, matrix: tr(-armDir * 0.29, 1.15, 0, 0, 0, armDir * 0.15) },
      { geo: new THREE.SphereGeometry(0.07, 6, 4), color: SK, matrix: tr(-armDir * 0.33, 0.88, 0) }
    ];
    return parts;
  }

  // musette : sac en coton avec sa bandoulière (origine = main du soigneur)
  let musetteGeo = null;
  function getMusetteGeo() {
    if (musetteGeo) return musetteGeo;
    musetteGeo = merge([
      { geo: new THREE.TorusGeometry(0.17, 0.014, 4, 12, Math.PI), color: '#ffffff', matrix: tr(0, -0.17, 0) },
      { geo: new THREE.BoxGeometry(0.36, 0.4, 0.06), color: '#ffffff', matrix: tr(0, -0.37, 0) },
      { geo: new THREE.BoxGeometry(0.37, 0.07, 0.065), color: '#f4f2ec', matrix: tr(0, -0.27, 0) }
    ]);
    return musetteGeo;
  }

  function carParts(parts, c) {
    const M = new THREE.Matrix4().compose(new THREE.Vector3(c.x, c.y, c.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, c.rot, 0)), new THREE.Vector3(1, 1, 1));
    const box = new THREE.BoxGeometry(1, 1, 1), cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 12), tor = new THREE.TorusGeometry(0.3, 0.035, 4, 14);
    const P = (geo, color, x, y, z, sx, sy, sz, rx, ry, rz) => parts.push({ geo, color, matrix: new THREE.Matrix4().multiplyMatrices(M, tr(x, y, z, rx || 0, ry || 0, rz || 0, sx, sy, sz)) });
    const DK = '#34405a';
    P(box, c.color, 0, 0.62, 0, 1.75, 0.62, 4.3);
    P(box, c.color, 0, 1.18, -0.25, 1.6, 0.55, 2.3);
    P(box, DK, 0, 1.2, 0.92, 1.45, 0.42, 0.06, -0.5, 0, 0);
    P(box, DK, 0, 1.2, -1.42, 1.45, 0.42, 0.06, 0.4, 0, 0);
    P(box, DK, 0.81, 1.2, -0.25, 0.04, 0.38, 2.0);
    P(box, DK, -0.81, 1.2, -0.25, 0.04, 0.38, 2.0);
    P(box, '#ffffff', 0, 0.68, 0, 1.77, 0.12, 4.32);
    P(box, '#fff2a8', 0.55, 0.65, 2.16, 0.32, 0.14, 0.04);
    P(box, '#fff2a8', -0.55, 0.65, 2.16, 0.32, 0.14, 0.04);
    for (const [x, z] of [[-0.82, 1.35], [0.82, 1.35], [-0.82, -1.35], [0.82, -1.35]]) P(cyl, '#26232f', x, 0.34, z, 0.68, 0.24, 0.68, 0, 0, Math.PI / 2);
    // galerie de toit avec trois vélos de rechange
    P(box, '#9aa0aa', 0.5, 1.5, -0.25, 0.05, 0.05, 2.2);
    P(box, '#9aa0aa', -0.5, 1.5, -0.25, 0.05, 0.05, 2.2);
    for (const bx of [-0.45, 0, 0.45]) {
      for (const bz of [-0.95, 0.45]) P(tor, '#1d1a2b', bx, 1.84, bz - 0.25, 1, 1, 1, 0, Math.PI / 2, 0);
      P(box, ['#e2463a', '#3d7be0', '#f2f2f2'][Math.round((bx + 0.45) / 0.45)], bx, 1.95, -0.5, 0.05, 0.05, 1.0, -0.25, 0, 0);
      P(box, '#1d1a2b', bx, 1.88, -0.25, 0.05, 0.4, 0.05);
    }
  }

  function tableParts(parts, t, rnd) {
    const M = new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, t.rot, 0)), new THREE.Vector3(1, 1, 1));
    const box = new THREE.BoxGeometry(1, 1, 1), cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
    const P = (geo, color, x, y, z, sx, sy, sz) => parts.push({ geo, color, matrix: new THREE.Matrix4().multiplyMatrices(M, tr(x, y, z, 0, 0, 0, sx, sy, sz)) });
    P(box, '#f4f2ec', 0, 0.76, 0, 0.7, 0.05, 1.6);
    for (const [x, z] of [[-0.3, -0.72], [0.3, -0.72], [-0.3, 0.72], [0.3, 0.72]]) P(box, '#8a8f99', x, 0.38, z, 0.04, 0.76, 0.04);
    for (let k = 0; k < 9; k++) {
      const col = ['#3d7be0', '#e2463a', '#f2c230', '#ffffff', '#4cc35a'][Math.floor(rnd() * 5)];
      P(cyl, col, -0.2 + (k % 3) * 0.13, 0.9, -0.6 + Math.floor(k / 3) * 0.14, 0.075, 0.22, 0.075);
    }
    P(box, '#c98a3d', 0.05, 0.92, 0.35, 0.45, 0.28, 0.5);
    P(box, '#ffffff', 0.05, 1.07, 0.35, 0.36, 0.04, 0.4);
  }

  // barrières de type Vauban habillées de bâches colorées
  function barrierParts(parts, route, L, s0, s1, side) {
    const half = L.roadHalf, off = (half + 0.45) * side;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const cols = ['#2fa84f', '#ffffff', '#f2c230', '#2fa84f', '#ffffff', '#3d7be0'];
    const fence = side < 0 ? L.fenceL : L.fenceR;
    let k = 0;
    for (let s = s0; s < s1; s += 2.5, k++) {
      const a = route.sample(s, {}), b = route.sample(s + 2.4, {});
      const i = a.i;
      if ((side < 0 ? L.railL[i] : L.railR[i]) || L.bridgeMask[i] || (side < 0 ? L.dropL[i] : L.dropR[i]) > 1.5) continue;
      const ax = a.x + a.rx * off, az = a.z + a.rz * off, bx = b.x + b.rx * off, bz = b.z + b.rz * off;
      const ay = a.y, by = b.y;
      for (const [x, y, z] of [[ax, ay, az], [bx, by, bz]]) {
        bar(parts, box, x, y, z, x, y + 1.1, z, 0.05, 0.05, '#c9ced6');
        bar(parts, box, x - a.rx * 0.3, y + 0.03, z - a.rz * 0.3, x + a.rx * 0.3, y + 0.03, z + a.rz * 0.3, 0.07, 0.05, '#9aa0aa');
      }
      bar(parts, box, ax, ay + 1.08, az, bx, by + 1.08, bz, 0.05, 0.05, '#c9ced6');
      bar(parts, box, ax, ay + 0.25, az, bx, by + 0.25, bz, 0.04, 0.04, '#c9ced6');
      // bâche (côté route)
      const px = -a.rx * side * 0.03, pz = -a.rz * side * 0.03;
      bar(parts, box, ax + px, ay + 0.68, az + pz, bx + px, by + 0.68, bz + pz, 0.02, 0.62, cols[k % cols.length]);
      fence[i] = 1;
    }
  }

  function build(route, L) {
    const group = new THREE.Group();
    group.name = 'race';
    const race = plan(route, L);
    const { makeArch, placeOnRoad, roadDecal, signTexture, makeSign } = B3D.road;
    const half = L.roadHalf;
    const rnd = mulberry32(L.seed ^ 0x7ab1e);
    const parts = [], fenceParts = [];

    // --- sprints
    for (const sp of race.sprints) {
      const arch = makeArch(L, 'SPRINT INTERMÉDIAIRE', { pillar: '#2fa84f', beam: '#2fa84f', banner: { bg: '#2fa84f', fg: '#ffffff', stroke: '#1d1a2b', size: 76 } });
      placeOnRoad(route, arch, sp.s, 0);
      group.add(arch);
      group.add(roadDecal(route, sp.s, 0, 0.7, half * 2 - 0.1, lineTexture('sprint'), true));
      for (const [dd, txt] of [[SPRINT_LEN, '400 m'], [200, '200 m']]) {
        const tex = signTexture([{ text: 'SPRINT', size: 64, color: '#2fa84f' }, { text: txt, size: 92 }], { border: '#2fa84f', w: 384, h: 320 });
        const g = makeSign(tex, 1.1, 0.92, 1.5);
        const p = placeOnRoad(route, g, sp.s - dd, half + 1.5, 0);
        g.position.y = Math.min(L.heightAt(g.position.x, g.position.z), p.y + 0.5) - 0.1;
        group.add(g);
      }
      for (const side of [-1, 1]) barrierParts(fenceParts, route, L, sp.s - 140, sp.s + 30, side);
    }

    // --- Grand Prix de la Montagne
    for (const k of race.koms) {
      if (k.arch) {
        const label = k.name.toUpperCase() + ' · ' + CAT_BANNER(k.cat);
        const arch = makeArch(L, label, { pillar: '#e2463a', beam: '#ffffff', banner: { bg: '#ffffff', fg: '#e2463a', dots: '#e2463a', stroke: '#ffffff', size: label.length > 22 ? 58 : label.length > 17 ? 68 : 80 } });
        placeOnRoad(route, arch, k.s1, 0);
        group.add(arch);
        group.add(roadDecal(route, k.s1, 0, 0.7, half * 2 - 0.1, lineTexture('kom'), true));
      }
      if (k.foot) {
        const txt = 'GPM ▲ ' + (k.length / 1000).toFixed(1).replace('.', ',') + ' KM À ' + (k.avg * 100).toFixed(1).replace('.', ',') + ' %';
        const arch = makeArch(L, txt, { pillar: '#ffffff', beam: '#e2463a', banner: { bg: '#e2463a', fg: '#ffffff', dots: '#ff8a7a', stroke: '#1d1a2b', size: 66 } });
        arch.scale.set(1, 0.85, 1);
        placeOnRoad(route, arch, k.s0, 0);
        group.add(arch);
      }
    }

    // --- ravitaillement
    for (const f of race.feeds) {
      const arch = makeArch(L, 'ZONE DE RAVITAILLEMENT', { pillar: '#ff9a2b', beam: '#ff9a2b', banner: { bg: '#ff9a2b', fg: '#ffffff', stroke: '#1d1a2b', size: 70 } });
      placeOnRoad(route, arch, f.s0, 0);
      group.add(arch);
      const pre = signTexture([{ text: 'RAVITAILLEMENT', size: 46, color: '#ff7a00' }, { text: '500 m', size: 90 }], { border: '#ff9a2b', w: 448, h: 320 });
      const gp = makeSign(pre, 1.3, 0.93, 1.5);
      const pp = placeOnRoad(route, gp, f.s0 - 500, f.side * (half + 1.5), 0);
      gp.position.y = Math.min(L.heightAt(gp.position.x, gp.position.z), pp.y + 0.5) - 0.1;
      group.add(gp);
      for (const side of [-1, 1]) {
        const tex = signTexture([{ text: 'FIN DE ZONE', size: 58, color: '#ff7a00' }, { text: 'DE RAVITAILLEMENT', size: 40 }], { border: '#ff9a2b', w: 448, h: 256 });
        const g = makeSign(tex, 1.5, 0.86, 1.6);
        const p = placeOnRoad(route, g, f.s1, side * (half + 1.6), 0);
        g.position.y = Math.min(L.heightAt(g.position.x, g.position.z), p.y + 0.5) - 0.1;
        group.add(g);
      }
      const mg = getMusetteGeo();
      for (const so of f.soigneurs) {
        // face aux coureurs (+z local), le x local pointe vers la droite de la route : le bras se tend vers la chaussée
        const M = new THREE.Matrix4().compose(new THREE.Vector3(so.x, so.y, so.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, so.yaw, 0)), new THREE.Vector3(1, 1, 1));
        const ad = -so.side;
        for (const p of personParts(so.team.color, ad)) parts.push({ geo: p.geo, color: p.color, matrix: new THREE.Matrix4().multiplyMatrices(M, p.matrix) });
        // musette tenue à bout de bras
        const hand = new THREE.Vector3(ad * 0.92, 1.42, 0.04).applyMatrix4(M);
        const m = new THREE.Mesh(mg, new THREE.MeshToonMaterial({ vertexColors: true, color: so.team.color, gradientMap: B3D.toon.gradientMap() }));
        m.position.copy(hand);
        m.rotation.y = so.yaw;
        m.castShadow = true;
        addOutline(m, { width: 0.8 });
        so.musette = m;
        so.home = hand.clone();
        group.add(m);
      }
      for (const c of f.cars) carParts(parts, c);
      for (const t of f.tables) tableParts(parts, t, rnd);
    }

    // les barrières (bâches très fines) ne reçoivent pas d'ombre : évite l'acné d'ombrage
    for (const [list, receive] of [[parts, true], [fenceParts, false]]) {
      if (!list.length) continue;
      const m = new THREE.Mesh(merge(list), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: B3D.toon.gradientMap() }));
      m.castShadow = true; m.receiveShadow = receive;
      addOutline(m, { width: 0.9, maxW: 0.2 });
      group.add(m);
    }
    return group;
  }

  // ------------------------------------------------------------------ rivaux virtuels
  // vitesse stable à puissance constante sur une pente donnée
  function steadySpeed(P, grade, phys) {
    const sinA = grade / Math.sqrt(1 + grade * grade), cosA = 1 / Math.sqrt(1 + grade * grade);
    const f = (v) => v * (phys.mass * phys.g * (sinA + phys.crr * cosA) + 0.5 * phys.rho * phys.cda * v * v) - P;
    let lo = 0.3, hi = phys.vMax;
    if (f(hi) < 0) return hi;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
    return (lo + hi) / 2;
  }
  // Même modèle que le coureur (inertie comprise), lancé à sa vitesse d'équilibre au début du tronçon.
  function rivalTimes(route, s0, s1, powers, phys) {
    const o = {}, dt = 0.1;
    return powers.map((P) => {
      let s = s0, t = 0;
      let v = steadySpeed(P, route.sample(s0, o).grade, phys);
      while (s < s1 && t < 36000) {
        const g = route.sample(s, o).grade;
        const sinA = g / Math.sqrt(1 + g * g);
        const a = (P / Math.max(v, 1.6) - phys.mass * phys.g * (sinA + phys.crr) - 0.5 * phys.rho * phys.cda * v * v) / phys.mass;
        v = Math.min(phys.vMax, Math.max(0.5, v + a * dt));
        s += v * dt; t += dt;
      }
      return t - (s - s1) / v;
    });
  }

  const ordinal = (n) => n + (n === 1 ? 'er' : 'e');
  const ptsLabel = (n) => n + (n > 1 ? ' pts' : ' pt');
  const fmtGap = (s) => (Math.round(s * 10) / 10).toFixed(1).replace('.', ',') + ' s';
  const fmtTime = (s) => { const m = Math.floor(s / 60); const r = Math.floor(s % 60); return m + ':' + String(r).padStart(2, '0'); };

  // ------------------------------------------------------------------ suivi pendant la course
  class Tracker {
    // peloton : coureurs virtuels (classement réel aux sprints et aux sommets) ou null (rivaux simulés)
    constructor(route, L, phys, peloton) {
      this.route = route;
      this.L = L;
      this.peloton = peloton && peloton.riders.length ? peloton : null;
      const race = this.race = plan(route, L);
      this.phys = phys;
      for (const sp of race.sprints) sp.rivals = sp.rivals || rivalTimes(route, sp.s - SPRINT_LEN, sp.s, SPRINT_W, phys);
      for (const k of race.koms) k.rivals = k.rivals || rivalTimes(route, k.s0, k.s1, KOM_W, phys);
      this.reset();
    }

    reset() {
      this.points = { sprint: 0, kom: 0 };
      this.musettes = 0;
      this.done = new Set();
      this.start = {};
      this.flying = [];
      this.results = [];
      for (const f of this.race.feeds) for (const so of f.soigneurs) {
        so.caught = false;
        if (so.musette) { so.musette.visible = true; so.musette.position.copy(so.home); so.musette.scale.set(1, 1, 1); }
      }
    }

    // rang face aux rivaux (temps plus courts = plus rapides)
    _rank(time, rivals) {
      let rank = 1, ahead = null, behind = null;
      rivals.forEach((t, k) => {
        if (t < time) { rank++; if (!ahead || t > ahead.t) ahead = { t, k }; }
        else if (!behind || t < behind.t) behind = { t, k };
      });
      return { rank, ahead, behind };
    }

    // Rang face aux vrais coureurs : ceux qui ont déjà franchi la ligne sont devant.
    _rankReal(key, lineS, time) {
      let rank = 1, ahead = null, behind = null;
      for (const r of this.peloton.riders) {
        const c = r.cross[key];
        if (c !== undefined && c <= time) { rank++; if (!ahead || c > ahead.t) ahead = { t: c, name: r.name }; }
        else if (!r.done && (!behind || r.s > behind.s)) behind = { s: r.s, v: r.v, name: r.name };
      }
      return { rank, ahead, behind: behind ? { name: behind.name, gap: (lineS - behind.s) / Math.max(2, behind.v) } : null };
    }

    // texte « devant X de… » / « à … de Y »
    _gapText(rank, real, t, rivals, ahead, behind) {
      const names = this.race.names;
      if (real) {
        if (rank === 1) return behind ? 'Devant ' + behind.name + ' de ' + fmtGap(behind.gap) : 'En solitaire !';
        return 'À ' + fmtGap(t - ahead.t) + ' de ' + ahead.name;
      }
      return rank === 1 ? 'Devant ' + names[behind.k] + ' de ' + fmtGap(behind.t - t) : 'À ' + fmtGap(t - ahead.t) + ' de ' + names[ahead.k];
    }

    // R : état de la course (s, lat, time, v) ; dt en temps de course, dtReal en temps réel.
    // Renvoie les messages à afficher.
    update(R, dt, dtReal, riderPos) {
      const out = [];
      const race = this.race, half = this.L.roadHalf;
      const real = !!this.peloton;
      // sprints
      race.sprints.forEach((sp, k) => {
        const key = 's' + k;
        if (this.done.has(key)) return;
        if (this.start[key] === undefined && R.s >= sp.s - SPRINT_LEN) {
          this.start[key] = R.time;
          out.push({ toast: '🟢 Sprint intermédiaire !<small>400 m à fond jusqu’à la ligne</small>', dur: 1800, sound: 'go' });
        }
        if (R.s >= sp.s) {
          this.done.add(key);
          const t = R.time - (this.start[key] !== undefined ? this.start[key] : R.time - SPRINT_LEN / Math.max(1, R.v));
          const { rank, ahead, behind } = real ? this._rankReal(key, sp.s, R.time) : this._rank(t, sp.rivals);
          const pts = SPRINT_PTS[rank - 1] || 0;
          this.points.sprint += pts;
          this.results.push({ kind: 'sprint', rank, pts, t, rivals: sp.rivals });
          const sub = this._gapText(rank, real, real ? R.time : t, sp.rivals, ahead, behind);
          out.push({ toast: (rank === 1 ? '🟢 Sprint gagné ! +' : '🟢 Sprint : ' + ordinal(rank) + ' · +') + ptsLabel(pts) + '<small>' + sub + '</small>', dur: 3400, sound: rank === 1 ? 'win' : 'line' });
        }
      });
      // montées
      race.koms.forEach((c, k) => {
        const key = 'k' + k;
        if (this.done.has(key)) return;
        if (this.start[key] === undefined && R.s >= c.s0) {
          this.start[key] = R.time;
          if (c.foot) out.push({ toast: '⛰️ ' + c.name + ' (' + CAT_LABEL(c.cat) + ')<small>' + (c.length / 1000).toFixed(1).replace('.', ',') + ' km à ' + (c.avg * 100).toFixed(1).replace('.', ',') + ' % · le chrono est lancé !</small>', dur: 2800, sound: 'go' });
        }
        if (R.s >= c.s1) {
          this.done.add(key);
          const t = R.time - (this.start[key] !== undefined ? this.start[key] : 0);
          const { rank } = real ? this._rankReal(key, c.s1, R.time) : this._rank(t, c.rivals);
          const table = KOM_PTS[Math.min(4, c.cat)];
          const pts = table[rank - 1] || 0;
          this.points.kom += pts;
          this.results.push({ kind: 'kom', rank, pts });
          const vam = Math.round(c.gain / Math.max(1, t) * 3600);
          const head = rank === 1 ? '🔴 ' + c.name + ' : 1er au sommet !' : '⛰️ ' + c.name + ' : ' + ordinal(rank);
          out.push({ toast: head + (pts ? ' +' + ptsLabel(pts) : '') + '<small>Montée en ' + fmtTime(t) + ' · VAM ' + vam + ' m/h · ' + Math.round(this.route.climbs[c.i].summitEle) + ' m</small>', dur: 3600, sound: rank === 1 ? 'win' : 'line' });
        }
      });
      // ravitaillement
      for (const [fi, f] of race.feeds.entries()) {
        const key = 'f' + fi;
        if (!this.done.has(key + 'in') && R.s >= f.s0) {
          this.done.add(key + 'in');
          out.push({ toast: '🥤 Zone de ravitaillement<small>Serre à ' + (f.side > 0 ? 'droite' : 'gauche') + ' pour attraper une musette !</small>', dur: 2600 });
        }
        if (R.s < f.s0 - 5 || R.s > f.s1 + 5) continue;
        for (const so of f.soigneurs) {
          if (so.caught || Math.abs(R.s - so.s) > 1.4) continue;
          if (so.side * R.lat > half - 1.3) {
            so.caught = true;
            this.musettes++;
            this.flying.push({ m: so.musette, t: 0 });
            out.push({ toast: '🥤 Musette attrapée !<small>🔋 +' + Math.round(MUSETTE_REFILL * 100) + ' % de réserve d\u2019énergie · merci ' + so.team.name + ' !</small>', dur: 2600, sound: 'musette', refill: MUSETTE_REFILL });
          }
        }
      }
      // musettes qui rejoignent l'épaule du coureur puis disparaissent
      for (let i = this.flying.length - 1; i >= 0; i--) {
        const fl = this.flying[i];
        fl.t += dtReal;
        const k = Math.min(1, fl.t / 0.35);
        fl.m.position.lerp(_v.set(riderPos.x, riderPos.y + 1.3, riderPos.z), k);
        const sc = 1 - k * 0.6;
        fl.m.scale.set(sc, sc, sc);
        if (k >= 1) { fl.m.visible = false; this.flying.splice(i, 1); }
      }
      return out;
    }

    // prochain évènement de course (pour le HUD)
    next(s) {
      const race = this.race;
      let best = null;
      const consider = (at, icon, label) => { if (at > s - 1 && (!best || at < best.at)) best = { at, icon, label }; };
      race.sprints.forEach((sp, k) => { if (!this.done.has('s' + k)) consider(sp.s, '🟢', 'Sprint'); });
      race.koms.forEach((c, k) => { if (!this.done.has('k' + k)) consider(c.s1, '🔴', 'GPM ' + CAT_LABEL(c.cat)); });
      race.feeds.forEach((f, k) => { if (!this.done.has('f' + k + 'in')) consider(f.s0, '🥤', 'Ravito'); });
      if (!best) return null;
      const d = Math.max(0, best.at - s);
      return { icon: best.icon, label: best.label, dist: d < 1000 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(1).replace('.', ',') + ' km' };
    }
  }

  // Résumé pour l'écran d'aperçu.
  function summary(L) {
    const r = L.race;
    if (!r) return '';
    const bits = [];
    if (r.sprints.length) bits.push(r.sprints.length + ' sprint' + (r.sprints.length > 1 ? 's' : ''));
    const gpm = r.koms.length;
    if (gpm) bits.push(gpm + ' GPM');
    if (r.feeds.length) bits.push('1 ravito');
    return bits.join(' · ') || 'aucune';
  }

  B3D.race = { plan, build, Tracker, summary, ptsLabel, CAT_LABEL, TEAMS, carParts, personParts, MUSETTE_REFILL };
})(typeof window !== 'undefined' ? window : globalThis);
