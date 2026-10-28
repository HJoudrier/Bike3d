/* Bike3D — route 3D : chaussée, marquages, glissières, ponts, bornes, panneaux, arches départ/arrivée. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { mat, addOutline, outlineAll, textTexture, merge, tr } = B3D.toon;
  const { mulberry32 } = B3D.util;

  const FONT = '"Fredoka", "Baloo 2", "Arial Rounded MT Bold", "Trebuchet MS", Arial, sans-serif';
  const TEX_LEN = 12; // longueur de route couverte par la texture (m)

  let roadTex = null;
  function roadTexture() {
    if (roadTex) return roadTex;
    roadTex = textTexture((ctx, w, h) => {
      ctx.fillStyle = '#5f6675';
      ctx.fillRect(0, 0, w, h);
      const rnd = mulberry32(42);
      for (let k = 0; k < 3500; k++) {
        const v = rnd();
        ctx.fillStyle = v < 0.5 ? 'rgba(40,44,56,0.18)' : 'rgba(150,156,170,0.16)';
        ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2);
      }
      // bords légèrement plus clairs (usure)
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, 'rgba(120,124,135,0.45)'); g.addColorStop(0.12, 'rgba(0,0,0,0)');
      g.addColorStop(0.88, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(120,124,135,0.45)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#f6f6f0';
      ctx.fillRect(w * 0.045, 0, w * 0.035, h);
      ctx.fillRect(w * 0.92, 0, w * 0.035, h);
      ctx.fillRect(w * 0.485, 0, w * 0.03, h * 0.26);
    }, 256, 512);
    roadTex.wrapS = THREE.ClampToEdgeWrapping;
    roadTex.wrapT = THREE.RepeatWrapping;
    roadTex.anisotropy = 8;
    return roadTex;
  }

  // Constructeur de géométrie simple (positions, normales, uv, couleurs).
  class GB {
    constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.i = []; this.color = new THREE.Color('#ffffff'); }
    v(x, y, z, nx, ny, nz, u, w) {
      this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u || 0, w || 0);
      this.c.push(this.color.r, this.color.g, this.color.b);
      return this.p.length / 3 - 1;
    }
    tri(a, b, c) { this.i.push(a, b, c); }
    // quadrilatère plan a,b,c,d (sens trigonométrique vu de la face avant)
    quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = dx - ax, vy = dy - ay, vz = dz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const a = this.v(ax, ay, az, nx, ny, nz, 0, 0), b = this.v(bx, by, bz, nx, ny, nz, 1, 0);
      const c = this.v(cx, cy, cz, nx, ny, nz, 1, 1), d = this.v(dx, dy, dz, nx, ny, nz, 0, 1);
      this.tri(a, b, c); this.tri(a, c, d);
    }
    // boîte orientée : centre, demi-tailles, axes (f = avant, r = droite) dans le plan horizontal
    box(cx, cy, cz, hw, hh, hd, fx, fz) {
      const rx = fz, rz = -fx; // axe "gauche" pour un repère direct (gauche, haut, avant)
      const P = (sx, sy, sz) => [cx + rx * hw * sx + fx * hd * sz, cy + hh * sy, cz + rz * hw * sx + fz * hd * sz];
      const f = [
        [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)],
        [P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)],
        [P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1)],
        [P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)],
        [P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1)],
        [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)]
      ];
      for (const q of f) this.quad(...q[0], ...q[1], ...q[2], ...q[3]);
    }
    build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      g.setIndex(this.i);
      g.computeBoundingSphere();
      return g;
    }
  }

  function buildSurface(route, L, group) {
    const half = L.roadHalf;
    const n = route.n;
    const roadMat = new THREE.MeshToonMaterial({
      map: roadTexture(), gradientMap: B3D.toon.gradientMap(),
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4
    });
    // chaussée mouillée : bitume plus sombre et flaques qui reflètent le ciel (couleur du brouillard)
    roadMat.onBeforeCompile = (shader) => {
      shader.uniforms.uWet = B3D.toon.shared.uWet;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRoadW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRoadW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', [
          '#include <common>',
          'varying vec3 vRoadW;',
          'uniform float uWet;',
          'float rh21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
          'float rnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);',
          '  return mix(mix(rh21(i), rh21(i+vec2(1,0)), f.x), mix(rh21(i+vec2(0,1)), rh21(i+vec2(1,1)), f.x), f.y); }'
        ].join('\n'))
        .replace('#include <map_fragment>', [
          '#include <map_fragment>',
          'if (uWet > 0.01) {',
          '  diffuseColor.rgb *= 1.0 - 0.32 * uWet;',
          '  float pud = smoothstep(0.6, 0.66, rnoise(vRoadW.xz * 0.28) * 0.7 + rnoise(vRoadW.xz * 1.1) * 0.3) * uWet;',
          '  #ifdef USE_FOG',
          '  diffuseColor.rgb = mix(diffuseColor.rgb, fogColor * 0.75, pud * 0.6);',
          '  #endif',
          '}'
        ].join('\n'));
    };
    roadMat.customProgramCacheKey = () => 'road-wet';
    const skirtMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: B3D.toon.gradientMap() });
    const CH = 160;
    for (let a = 0; a < n - 1; a += CH) {
      const b = Math.min(n - 1, a + CH);
      const gb = new GB(), sk = new GB();
      for (let i = a; i <= b; i++) {
        const x = route.x[i], y = route.y[i] + 0.04, z = route.z[i];
        const rx = -route.tz[i], rz = route.tx[i];
        const v = (i * route.spacing) / TEX_LEN;
        gb.v(x - rx * half, y, z - rz * half, 0, 1, 0, 0, v);
        gb.v(x + rx * half, y, z + rz * half, 0, 1, 0, 1, v);
        if (i > a && !(route.dup[i] && route.dup[i - 1])) {
          const k = (i - a) * 2;
          gb.tri(k - 2, k - 1, k); gb.tri(k - 1, k + 1, k);
        }
        // bords (jupes) : plus épais sur les ponts
        const bridge = L.bridgeMask[i];
        const depth = bridge ? 1.6 : 0.7;
        sk.color.set(bridge ? '#c9b48f' : '#4d525e');
        for (const side of [-1, 1]) {
          const ex = x + rx * half * side, ez = z + rz * half * side;
          sk.v(ex, y, ez, rx * side, 0, rz * side);
          sk.v(ex + rx * side * 0.25, y - depth, ez + rz * side * 0.25, rx * side, 0, rz * side);
        }
        if (i > a && !(route.dup[i] && route.dup[i - 1])) {
          const k = (i - a) * 4;
          // gauche (side -1) : normale vers la gauche
          sk.tri(k - 4, k, k - 3); sk.tri(k - 3, k, k + 1);
          // droite
          sk.tri(k - 2, k - 1, k + 2); sk.tri(k - 1, k + 3, k + 2);
        }
      }
      const m = new THREE.Mesh(gb.build(), roadMat);
      m.receiveShadow = true;
      group.add(m);
      const s = new THREE.Mesh(sk.build(), skirtMat);
      s.receiveShadow = true;
      group.add(s);
    }
  }

  // Glissières de sécurité (côtés en surplomb) et parapets de ponts.
  function buildRails(route, L, group) {
    const half = L.roadHalf;
    const gb = new GB();
    const n = route.n;
    const runs = (mask) => {
      const out = [];
      let a = -1;
      for (let i = 0; i <= n; i++) {
        if (i < n && mask[i]) { if (a < 0) a = i; }
        else if (a >= 0) { out.push([a, i - 1]); a = -1; }
      }
      return out;
    };
    const rail = (a, b, side) => {
      gb.color.set('#d9dde4');
      const off = half + 0.55;
      for (let i = a; i < b; i++) {
        const P = (k, lift, extra) => {
          const rx = -route.tz[k], rz = route.tx[k];
          return [route.x[k] + rx * (off + extra) * side, route.y[k] + lift, route.z[k] + rz * (off + extra) * side];
        };
        const a0 = P(i, 0.42, 0), a1 = P(i, 0.78, 0), b0 = P(i + 1, 0.42, 0), b1 = P(i + 1, 0.78, 0);
        const c0 = P(i, 0.42, 0.08), c1 = P(i, 0.78, 0.08), d0 = P(i + 1, 0.42, 0.08), d1 = P(i + 1, 0.78, 0.08);
        if (side < 0) {
          gb.quad(...a0, ...b0, ...b1, ...a1);
          gb.quad(...d0, ...c0, ...c1, ...d1);
          gb.quad(...a1, ...b1, ...d1, ...c1);
        } else {
          gb.quad(...b0, ...a0, ...a1, ...b1);
          gb.quad(...c0, ...d0, ...d1, ...c1);
          gb.quad(...b1, ...a1, ...c1, ...d1);
        }
      }
      gb.color.set('#8b6a45');
      for (let i = a; i <= b; i += 1) {
        const rx = -route.tz[i], rz = route.tx[i];
        const off2 = off + 0.2;
        gb.box(route.x[i] + rx * off2 * side, route.y[i] + 0.3, route.z[i] + rz * off2 * side, 0.07, 0.55, 0.07, route.tx[i], route.tz[i]);
      }
    };
    // sur une portion parcourue deux fois, une seule série de glissières (celle du premier passage)
    const notDup = (m) => m.map((v, i) => (v && !route.dup[i] ? 1 : 0));
    for (const [a, b] of runs(notDup(L.railL))) rail(a, b, -1);
    for (const [a, b] of runs(notDup(L.railR))) rail(a, b, 1);
    // parapets des ponts
    for (const [a, b] of L.bridges) {
      for (const side of [-1, 1]) {
        for (let i = a; i < b; i++) {
          gb.color.set((i & 1) ? '#d8c7a4' : '#cdb994');
          const off = half + 0.3;
          const mx = (route.x[i] + route.x[i + 1]) / 2, mz = (route.z[i] + route.z[i + 1]) / 2, my = (route.y[i] + route.y[i + 1]) / 2;
          const rx = -route.tz[i], rz = route.tx[i];
          const len = Math.hypot(route.x[i + 1] - route.x[i], route.z[i + 1] - route.z[i]);
          gb.box(mx + rx * off * side, my + 0.35, mz + rz * off * side, 0.25, 0.55, len / 2 + 0.05, route.tx[i], route.tz[i]);
        }
      }
    }
    if (!gb.p.length) return;
    const m = new THREE.Mesh(gb.build(), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: B3D.toon.gradientMap() }));
    m.castShadow = true; m.receiveShadow = true;
    addOutline(m, { width: 0.8, maxW: 0.12 });
    group.add(m);
  }

  // ------------------------------------------------------------------ objets ponctuels
  function placeOnRoad(route, obj, s, lateral, yaw) {
    const p = route.sample(s, {});
    obj.position.set(p.x + p.rx * lateral, p.y, p.z + p.rz * lateral);
    obj.rotation.y = Math.atan2(p.tx, p.tz) + (yaw || 0);
    return p;
  }

  function banner(text, opts) {
    return textTexture((ctx, w, h) => {
      ctx.fillStyle = opts.bg;
      ctx.fillRect(0, 0, w, h);
      if (opts.dots) {
        ctx.fillStyle = opts.dots;
        for (let y = 18; y < h; y += 44) for (let x = (y / 44) % 2 ? 30 : 8; x < w; x += 44) { ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.font = '700 ' + (opts.size || 88) + 'px ' + FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 14; ctx.strokeStyle = opts.stroke || '#1d1a2b';
      ctx.strokeText(text, w / 2, h / 2 + 4);
      ctx.fillStyle = opts.fg;
      ctx.fillText(text, w / 2, h / 2 + 4);
    }, 1024, 160);
  }

  function makeArch(L, text, opts) {
    const half = L.roadHalf;
    const g = new THREE.Group();
    const span = half + 1.4;
    const pm = mat(opts.pillar);
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 5.6, 14), pm);
      p.position.set(sx * span, 2.8, 0);
      p.castShadow = true;
      g.add(p);
      const top = new THREE.Mesh(new THREE.SphereGeometry(0.52, 12, 8), pm);
      top.position.set(sx * span, 5.6, 0);
      g.add(top);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.6, 1.5, 0.8), mat(opts.beam));
    beam.position.y = 5.5;
    beam.castShadow = true;
    g.add(beam);
    outlineAll(g, { width: 1.0 });
    const tex = banner(text, opts.banner);
    const pmat = new THREE.MeshBasicMaterial({ map: tex });
    for (const face of [-1, 1]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(span * 2 - 0.2, 1.25), pmat);
      pl.position.set(0, 5.5, face * 0.42);
      if (face < 0) pl.rotation.y = Math.PI;
      pl.userData.noOutline = true;
      g.add(pl);
    }
    return g;
  }

  function signTexture(lines, opts) {
    return textTexture((ctx, w, h) => {
      ctx.fillStyle = opts.border || '#f2c230';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = opts.bg || '#ffffff';
      ctx.fillRect(14, 14, w - 28, h - 28);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const lh = (h - 40) / lines.length;
      lines.forEach((ln, k) => {
        ctx.font = '700 ' + (ln.size || 44) + 'px ' + FONT;
        ctx.fillStyle = ln.color || '#1d1a2b';
        ctx.fillText(ln.text, w / 2, 20 + lh * (k + 0.5));
      });
    }, opts.w || 512, opts.h || 384);
  }

  function makeSign(tex, w, h, poleH) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, poleH, 6), mat('#9aa0aa'));
    pole.position.y = poleH / 2;
    g.add(pole);
    const back = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.06), mat('#7c828c'));
    back.position.y = poleH + h / 2 - 0.1;
    g.add(back);
    outlineAll(g, { width: 0.8 });
    const front = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
    front.position.set(0, poleH + h / 2 - 0.1, -0.04);
    front.rotation.y = Math.PI;
    g.add(front);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return g;
  }

  function makeKmMarker(km) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.7, 0.28), mat('#f7f5ee'));
    body.position.y = 0.35;
    g.add(body);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.225, 0.225, 0.28, 12, 1, false, 0, Math.PI), mat('#e2463a'));
    cap.rotation.z = Math.PI / 2; cap.rotation.y = Math.PI / 2;
    cap.position.y = 0.7;
    g.add(cap);
    outlineAll(g, { width: 0.8 });
    const tex = textTexture((ctx, w, h) => {
      ctx.fillStyle = '#f7f5ee'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#1d1a2b'; ctx.font = '700 70px ' + FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(km), w / 2, h / 2 + 3);
    }, 128, 128);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), new THREE.MeshBasicMaterial({ map: tex }));
    face.position.set(0, 0.38, -0.145);
    face.rotation.y = Math.PI;
    g.add(face);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return g;
  }

  // Marquage peint sur la route (texte "ALLEZ !", damier d'arrivée…)
  function roadDecal(route, s, lateral, len, wid, tex, rot) {
    const gb = new GB();
    const steps = Math.max(2, Math.ceil(len / 1.5));
    for (let k = 0; k <= steps; k++) {
      const ss = s - len / 2 + (len * k) / steps;
      const p = route.sample(ss, {});
      const cx = p.x + p.rx * lateral, cz = p.z + p.rz * lateral;
      const y = p.y + 0.06;
      gb.v(cx - p.rx * wid / 2, y, cz - p.rz * wid / 2, 0, 1, 0, rot ? 1 : 0, k / steps);
      gb.v(cx + p.rx * wid / 2, y, cz + p.rz * wid / 2, 0, 1, 0, rot ? 0 : 1, k / steps);
      if (k > 0) { const q = k * 2; gb.tri(q - 2, q - 1, q); gb.tri(q - 1, q + 1, q); }
    }
    const m = new THREE.Mesh(gb.build(), new THREE.MeshToonMaterial({
      map: tex, transparent: true, gradientMap: B3D.toon.gradientMap(), depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8
    }));
    m.receiveShadow = true;
    m.renderOrder = 1;
    return m;
  }

  // Texte peint lisible depuis le vélo : écrit en travers, lettres étirées dans le sens de la route.
  function paintTexture(text) {
    return textTexture((ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      let size = 200;
      ctx.font = '700 ' + size + 'px ' + FONT;
      while (ctx.measureText(text).width > w * 0.92 && size > 60) { size -= 10; ctx.font = '700 ' + size + 'px ' + FONT; }
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.93)';
      ctx.fillText(text, w / 2, h / 2 + 8);
    }, 1024, 256);
  }

  function checkerTexture() {
    const t = textTexture((ctx, w, h) => {
      const n = 12, m = 2;
      for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#1d1a2b' : '#ffffff';
        ctx.fillRect(i * w / n, j * h / m, w / n + 1, h / m + 1);
      }
    }, 384, 64);
    t.magFilter = THREE.NearestFilter;
    return t;
  }

  function buildFeatures(route, L, group) {
    const half = L.roadHalf;
    const rnd = mulberry32(L.seed ^ 0xfeed);
    // Arches départ / arrivée
    const start = makeArch(L, 'DÉPART', { pillar: '#3d7be0', beam: '#3d7be0', banner: { bg: '#3d7be0', fg: '#ffffff', size: 96 } });
    placeOnRoad(route, start, route.sStart + 3, 0);
    group.add(start);
    const finish = makeArch(L, 'ARRIVÉE', { pillar: '#e2463a', beam: '#f2c230', banner: { bg: '#f2c230', fg: '#e2463a', stroke: '#1d1a2b', size: 96 } });
    placeOnRoad(route, finish, route.sEnd, 0);
    group.add(finish);
    const chk = checkerTexture();
    group.add(roadDecal(route, route.sEnd, 0, 1.2, half * 2 - 0.1, chk, true));
    // Flamme rouge à 1 km de l'arrivée
    if (route.length > 2500) {
      const fr = makeArch(L, '▼ 1 KM ▼', { pillar: '#e2463a', beam: '#e2463a', banner: { bg: '#e2463a', fg: '#ffffff', size: 84 } });
      fr.scale.set(1, 0.85, 1);
      placeOnRoad(route, fr, route.sEnd - 1000, 0);
      group.add(fr);
    }

    // Bornes kilométriques
    for (let km = 1; km * 1000 < route.length - 150; km++) {
      const g = makeKmMarker(km);
      const p = placeOnRoad(route, g, route.sStart + km * 1000, half + 1.1, 0);
      g.position.y = L.heightAt(g.position.x, g.position.z) - 0.05;
      if (Math.abs(g.position.y - p.y) > 1.5) g.position.y = p.y;
      group.add(g);
    }

    // Panneaux de col + bannière de sommet
    route.climbs.forEach((c, ci) => {
      const name = L.climbNames[ci];
      const summitS = route.sStart + c.d1;
      for (let k = Math.floor(c.length / 1000); k >= 1; k--) {
        const s = summitS - k * 1000;
        if (s < route.sStart + 100) continue;
        const a = route.sample(s, {}), b = route.sample(Math.min(s + 1000, summitS), {});
        const pct = ((b.y - a.y) / Math.max(1, Math.min(1000, summitS - s)) * 100).toFixed(1).replace('.', ',');
        const tex = signTexture([
          { text: name, size: 40 },
          { text: 'Sommet ' + k + ' km', size: 54, color: '#e2463a' },
          { text: 'Alt. ' + Math.round(a.y) + ' m · ' + pct + ' %', size: 36 }
        ], { border: '#f2c230' });
        const g = makeSign(tex, 1.5, 1.1, 1.6);
        placeOnRoad(route, g, s, half + 1.6, 0);
        g.position.y = Math.min(L.heightAt(g.position.x, g.position.z), a.y + 0.5) - 0.1;
        group.add(g);
      }
      // grand panneau du sommet
      const tex = signTexture([
        { text: name.toUpperCase(), size: 46, color: '#ffffff' },
        { text: 'Altitude ' + Math.round(c.summitEle) + ' m', size: 40, color: '#ffe9b0' }
      ], { border: '#5b3a1e', bg: '#7a4f2a', w: 640, h: 256 });
      const g = makeSign(tex, 3.2, 1.3, 2.0);
      const sp = placeOnRoad(route, g, summitS + 15, -(half + 2.2), 0);
      g.position.y = Math.min(L.heightAt(g.position.x, g.position.z), sp.y + 0.5) - 0.1;
      group.add(g);
      // encouragements peints sur la route
      const words = ['ALLEZ !', 'VAS-Y !', 'COURAGE', 'ALLEZ ALLEZ', 'BRAVO !', 'GO GO GO', 'ON LÂCHE RIEN', 'PLUS QUE ' + Math.max(1, Math.round(c.length / 2000)) + ' KM'];
      for (let s = summitS - Math.min(c.length, 3000); s < summitS - 40; s += 90 + rnd() * 120) {
        const w = words[Math.floor(rnd() * words.length)];
        group.add(roadDecal(route, s, (rnd() - 0.5) * 0.6, 3.6, 5.0, paintTexture(w), false));
      }
    });
  }

  // Groupes de supporters répartis sur le parcours (plus nombreux en montée), parfois avec un camping-car.
  function planFans(route, L) {
    if (L.fanGroups) return L.fanGroups;
    const rnd = mulberry32(L.seed ^ 0xfa5);
    const half = L.roadHalf;
    const groups = [];
    L.keepOut = L.keepOut || [];
    const noFans = (L.race && L.race.noFans) || [];
    const o = {};
    let s = route.sStart + 250 + rnd() * 200;
    while (s < route.sEnd - 320) {
      const r = route.sample(s, {});
      const climbing = r.grade > 0.035;
      const i = r.i;
      if (L.villageW[i] < 0.02 && !L.bridgeMask[i] && !route.dup[i] && !noFans.some(([a, b]) => s > a && s < b)) {
        const side = rnd() < 0.5 ? -1 : 1;
        const rail = side < 0 ? L.railL[i] : L.railR[i];
        const drop = side < 0 ? L.dropL[i] : L.dropR[i];
        if (!rail && drop < 1.5) {
          const g = { s, side, n: 3 + Math.floor(rnd() * (climbing ? 8 : 5)), len: 5 + rnd() * 9, van: null };
          if (climbing && rnd() < 0.5) {
            // camping-car garé derrière le groupe, si le terrain est assez plat
            const off = half + 7.5;
            const x = r.x + r.rx * off * side, z = r.z + r.rz * off * side;
            let flat = true;
            for (const [a, b] of [[-3, -1.2], [3, -1.2], [-3, 1.2], [3, 1.2], [0, 0]]) {
              L.sample(x + r.tx * a + r.rx * b * side, z + r.tz * a + r.rz * b * side, o);
              if (Math.abs(o.h - r.y) > 1.0 || o.under || o.roadD < half + 4.5) flat = false;
            }
            if (flat) {
              g.van = { x, z, y: L.heightAt(x, z), rot: Math.atan2(-r.rx * side, -r.rz * side), color: rnd.pick(['#3d7be0', '#e2463a', '#4cc35a', '#f2c230', '#9b6bff']) };
              L.keepOut.push({ x, z, r: 5.5 });
            }
          }
          groups.push(g);
        }
      }
      s += (climbing ? 150 : 330) + rnd() * (climbing ? 220 : 520);
    }
    L.fanGroups = groups;
    return groups;
  }

  // Camping-cars de supporters (fusionnés en un seul maillage).
  function buildVans(route, L, group) {
    const parts = [];
    const W = '#f4f2ec', DK = '#34405a', BK = '#26232f';
    for (const g of planFans(route, L)) {
      const v = g.van;
      if (!v) continue;
      const M = new THREE.Matrix4().compose(new THREE.Vector3(v.x, v.y, v.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, v.rot, 0)), new THREE.Vector3(1, 1, 1));
      const P = (geo, color, x, y, z, sx, sy, sz, rx, ry, rz) => {
        const lm = tr(x, y, z, rx || 0, ry || 0, rz || 0, sx, sy, sz);
        parts.push({ geo, color, matrix: new THREE.Matrix4().multiplyMatrices(M, lm) });
      };
      const box = new THREE.BoxGeometry(1, 1, 1), cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
      P(box, W, 0, 1.5, 0, 5.6, 2.1, 2.2);
      P(box, v.color, 0, 0.82, 0, 5.62, 0.26, 2.22);
      P(box, W, 3.2, 1.0, 0, 1.0, 1.2, 2.1);
      P(box, W, 2.95, 2.35, 0, 1.4, 0.75, 2.12);
      P(box, DK, 3.72, 1.35, 0, 0.08, 0.6, 1.9);
      P(box, DK, 0.9, 1.75, 1.11, 1.3, 0.62, 0.05);
      P(box, DK, -1.6, 1.75, 1.11, 1.0, 0.62, 0.05);
      P(box, '#dedad0', 2.0, 1.25, 1.11, 0.8, 1.8, 0.05);
      for (const [x, z] of [[-1.9, 1.05], [1.9, 1.05], [-1.9, -1.05], [1.9, -1.05]]) P(cyl, BK, x, 0.42, z, 0.84, 0.3, 0.84, Math.PI / 2, 0, 0);
      // store déroulé, table et chaises de camping
      P(box, v.color, -0.8, 2.45, 1.95, 3.2, 0.06, 1.7, 0.18, 0, 0);
      P(box, '#bfc5cf', -1.6, 2.15, 2.75, 0.06, 0.7, 0.06);
      P(box, '#bfc5cf', 0.0, 2.15, 2.75, 0.06, 0.7, 0.06);
      P(cyl, '#f2f2f2', -0.8, 0.7, 2.4, 0.9, 0.05, 0.9);
      P(cyl, '#8a8f99', -0.8, 0.35, 2.4, 0.06, 0.7, 0.06);
      for (const x of [-1.6, 0.0]) {
        P(box, v.color, x, 0.45, 2.6, 0.5, 0.06, 0.5);
        P(box, v.color, x, 0.72, 2.37, 0.5, 0.55, 0.06);
      }
    }
    if (!parts.length) return;
    const geo = merge(parts);
    const m = new THREE.Mesh(geo, new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: B3D.toon.gradientMap() }));
    m.castShadow = true; m.receiveShadow = true;
    addOutline(m, { width: 0.9, maxW: 0.2 });
    group.add(m);
  }

  // Spectateurs (sommets, arrivée, groupes le long du parcours) et alignements de platanes, placés dans les pools d'instances.
  function placeRoadsideInstances(route, L, tiles) {
    const rnd = mulberry32(L.seed ^ 0xabcde);
    const half = L.roadHalf;
    const list = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const col = new THREE.Color();
    const shirts = ['#e2463a', '#f2c230', '#3d7be0', '#5cc85a', '#ffffff', '#ff7aa8', '#9b6bff', '#ff9a2b', '#1d1a2b'];
    const put = (pool, x, y, z, rot, s, sy, color) => {
      const P = tiles.pools[pool];
      const i = P.alloc();
      if (i < 0) return;
      e.set(0, rot, 0); q.setFromEuler(e); p.set(x, y, z); sc.set(s, s * (sy || 1), s);
      m.compose(p, q, sc);
      P.set(i, m, color);
      list.push(pool, i);
    };
    L.crowd = L.crowd || new Float32Array(route.n);
    // un supporter au bord de la route (ignoré s'il tomberait dans un ravin, sur un pont ou dans un village)
    const fan = (s, side, off) => {
      const r = route.sample(s, {});
      const i = r.i;
      if ((side < 0 ? L.railL[i] : L.railR[i]) || L.bridgeMask[i] || L.villageW[i] > 0.05) return;
      if ((side < 0 ? L.dropL[i] : L.dropR[i]) > 1.5) return;
      const x = r.x + r.rx * off * side, z = r.z + r.rz * off * side;
      const y = L.heightAt(x, z);
      if (Math.abs(y - r.y) > 1.3) return;
      col.set(shirts[Math.floor(rnd() * shirts.length)]);
      const sc = rnd() < 0.15 ? 0.7 + rnd() * 0.1 : 0.88 + rnd() * 0.22; // quelques enfants
      put('spectator', x, y, z, Math.atan2(r.tx, r.tz) + (side > 0 ? Math.PI / 2 : -Math.PI / 2) + (rnd() - 0.5) * 0.8, sc, 1, col);
      L.crowd[i] += 1;
    };
    const crowd = (s0, s1, density) => {
      for (let s = s0; s < s1; s += 1.6) {
        for (const side of [-1, 1]) {
          if (rnd() > density) continue;
          fan(s, side, half + 1.3 + rnd() * 2.2);
        }
      }
    };
    // petits groupes de supporters tout au long du parcours
    for (const g of planFans(route, L)) {
      for (let k = 0; k < g.n; k++) fan(g.s + (rnd() - 0.5) * g.len, g.side, half + 1.3 + rnd() * 2.6);
    }
    route.climbs.forEach((c) => {
      const summit = route.sStart + c.d1;
      crowd(summit - Math.min(900, c.length * 0.4), summit + 60, c.cat <= 2 ? 0.45 : 0.25);
    });
    crowd(route.sEnd - 260, route.sEnd + 30, 0.7);
    // public massé derrière les barrières des sprints
    if (L.race) for (const sp of L.race.sprints) crowd(sp.s - 130, sp.s + 25, 0.6);
    crowd(route.sStart - 20, route.sStart + 50, 0.5);

    // Alignements de platanes en plaine
    const P = L.P;
    if (P.planeTrees > 0.25) {
      const o = {};
      for (let s = route.sStart + 150; s < route.sEnd - 150; s += 12) {
        const r = route.sample(s, {});
        if (r.y > 650 || Math.abs(r.grade) > 0.035 || L.bridgeMask[r.i] || L.villageW[r.i] > 0.02) continue;
        if (L.noiseB.noise(s / 1600 + 77.7, 3.3) < 1.0 - P.planeTrees * 1.2) continue;
        for (const side of [-1, 1]) {
          const off = half + 3.4;
          const x = r.x + r.rx * off * side, z = r.z + r.rz * off * side;
          L.sample(x, z, o);
          if (o.under || o.lakeRn < 1.3 || o.dr < o.rw + 6 || Math.abs(o.h - r.y) > 1.2) continue;
          if (L.keepOut.some((c) => Math.hypot(c.x - x, c.z - z) < c.r + 2.5)) continue;
          // platanes au nord, cyprès dans le Sud
          if (L.bio.south) {
            col.set(L.amb.cypress[Math.floor(rnd() * L.amb.cypress.length)]);
            put('cypress', x, o.h - 0.2, z, rnd() * 6.28, 1.0 + rnd() * 0.2, 1.1, col);
          } else {
            col.set(L.amb.decid[Math.floor(rnd() * L.amb.decid.length)]);
            put('deciduous', x, o.h - 0.2, z, rnd() * 6.28, 1.15 + rnd() * 0.2, 1.25, col);
          }
        }
      }
    }
    for (const pl of Object.values(tiles.pools)) pl.flush();
    return list;
  }

  B3D.road = {
    build(route, L) {
      const group = new THREE.Group();
      group.name = 'road';
      buildSurface(route, L, group);
      buildRails(route, L, group);
      if (B3D.race) group.add(B3D.race.build(route, L));
      buildFeatures(route, L, group);
      buildVans(route, L, group);
      return group;
    },
    placeRoadsideInstances,
    makeSign,
    placeOnRoad,
    makeArch,
    signTexture,
    roadDecal,
    FONT
  };
})(typeof window !== 'undefined' ? window : globalThis);
