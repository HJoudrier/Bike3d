/* Bike3D — traversées de villages : maisons, église et son clocher, boulangerie, café, commerces,
   mairie, trottoirs, lampadaires, fanions, panneaux d'entrée et de sortie, habitants qui encouragent. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { mulberry32 } = B3D.util;
  const { textTexture, merge, computeOutlineNormals, outlineMat, gradientMap } = B3D.toon;

  const FONT = '"Fredoka", "Baloo 2", "Arial Rounded MT Bold", "Trebuchet MS", Arial, sans-serif';
  const FLOOR_H = 2.9;

  const STYLES = {
    nord: {
      walls: ['#f3ede0', '#efe2c8', '#e8d9bf', '#f1e8d6', '#e9dcc9', '#f5f0e6', '#e3d4bd', '#dfe3e8'],
      roofs: ['#55607a', '#5b6478', '#4f586c', '#8f4e36', '#9a5a3c'],
      shutters: ['#4a7fb5', '#6b9a5b', '#9b3d3d', '#e8e1d0', '#5e7d8a', '#3d5f8a'],
      pitch: 0.48, overhang: 0.35
    },
    sud: {
      walls: ['#f2d9a6', '#efc98d', '#f4dfb8', '#e8b98a', '#f1d3b0', '#f6e3c4', '#efc6a0', '#f3e6cc'],
      roofs: ['#c8603f', '#d06e45', '#b9553a', '#c96b4a'],
      shutters: ['#7fb8c8', '#93b98c', '#b89ccf', '#6fa0c8', '#e0d5b0', '#5e9e9a'],
      pitch: 0.28, overhang: 0.4
    },
    montagne: {
      walls: ['#e9e1d2', '#efe6d6', '#e3d8c6'],
      wood: ['#9b6a43', '#8a5b38', '#a8774c', '#7d5233'],
      roofs: ['#4f5666', '#5a5f6b', '#6f5a48', '#55606f'],
      shutters: ['#7a4e2e', '#a0522d', '#5c7a3a', '#9b3d3d'],
      pitch: 0.32, overhang: 1.0
    }
  };

  const SHOPS = [
    ['ÉPICERIE', '#3d7be0'], ['BOUCHERIE', '#c0392b'], ['FROMAGERIE', '#e6a817'], ['FLEURISTE', '#e267a8'],
    ['PRIMEUR', '#3f9e4a'], ['LIBRAIRIE', '#8e5bd6'], ['COIFFURE', '#2d2a3e'], ['QUINCAILLERIE', '#7b5a3a'],
    ['CRÉMERIE', '#4f95d6'], ['CHOCOLATIER', '#6b3d26'], ['CYCLES · RÉPARATION', '#e2463a'], ['GLACES', '#ff7aa8']
  ];
  const CAFES = ['CAFÉ DU COMMERCE', 'BAR DES SPORTS', 'CAFÉ DE LA PLACE', 'AU P\'TIT VÉLO', 'CAFÉ DES CYCLISTES', 'LE RAYON VERT', 'BAR DU TOUR'];

  // ------------------------------------------------------------------ géométries unitaires
  // Solide convexe : chaque face est orientée vers l'extérieur d'après le centre du solide.
  function convexSolid(verts, faces) {
    const c = new THREE.Vector3();
    for (const v of verts) c.add(new THREE.Vector3(...v));
    c.multiplyScalar(1 / verts.length);
    const pos = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3(), fc = new THREE.Vector3();
    for (const f of faces) {
      a.set(...verts[f[0]]); b.set(...verts[f[1]]); d.set(...verts[f[2]]);
      n.subVectors(b, a).cross(d.clone().sub(a));
      fc.set(0, 0, 0);
      for (const k of f) fc.add(new THREE.Vector3(...verts[k]));
      fc.multiplyScalar(1 / f.length).sub(c);
      const idx = n.dot(fc) < 0 ? f.slice().reverse() : f;
      for (let k = 1; k < idx.length - 1; k++) pos.push(...verts[idx[0]], ...verts[idx[k]], ...verts[idx[k + 1]]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }

  let U = null;
  function unit() {
    if (U) return U;
    U = {
      box: new THREE.BoxGeometry(1, 1, 1),
      // toit à deux pans, faîtage selon x, base en y = 0, sommet en y = 1
      prism: convexSolid(
        [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, 0], [0.5, 1, 0]],
        [[0, 1, 5, 4], [2, 3, 4, 5], [3, 0, 4], [1, 2, 5], [0, 3, 2, 1]]
      ),
      pyramid: new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0),
      cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
      cone: new THREE.ConeGeometry(0.5, 1, 12).translate(0, 0.5, 0),
      sphere: new THREE.SphereGeometry(0.5, 8, 6),
      ball: new THREE.SphereGeometry(0.5, 5, 3) // petites fleurs
    };
    return U;
  }

  // ------------------------------------------------------------------ assemblage
  const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
  function local(x, y, z, sx, sy, sz, rx, ry, rz) {
    _e.set(rx || 0, ry || 0, rz || 0);
    _q.setFromEuler(_e);
    return new THREE.Matrix4().compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
  }

  class Kit {
    constructor() { this.struct = []; this.detail = []; this.texts = []; this.flags = []; }
    // pièce dans le repère M : centre (x, y, z), tailles, rotations locales
    add(list, geo, M, x, y, z, sx, sy, sz, color, rx, ry, rz) {
      list.push({ geo, color, matrix: new THREE.Matrix4().multiplyMatrices(M, local(x, y, z, sx, sy, sz, rx, ry, rz)) });
    }
    box(list, M, x, y, z, sx, sy, sz, color, ry) { this.add(list, unit().box, M, x, y, z, sx, sy, sz, color, 0, ry || 0, 0); }
    // repère d'une façade : origine (x, y, z) dans M, tourné de ry autour de y
    sub(M, x, y, z, ry) { return new THREE.Matrix4().multiplyMatrices(M, local(x, y, z, 1, 1, 1, 0, ry || 0, 0)); }
    text(M, x, y, z, w, h, tex, ry) {
      this.texts.push({ matrix: new THREE.Matrix4().multiplyMatrices(M, local(x, y, z, 1, 1, 1, 0, ry || 0, 0)), w, h, tex });
    }
  }

  function signTex(text, bg, fg, w, h) {
    return textTexture((ctx, W, H) => {
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 6; ctx.strokeRect(8, 8, W - 16, H - 16);
      let size = Math.round(H * 0.58);
      ctx.font = '700 ' + size + 'px ' + FONT;
      while (ctx.measureText(text).width > W * 0.9 && size > 16) { size -= 2; ctx.font = '700 ' + size + 'px ' + FONT; }
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(4, size * 0.14); ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.strokeText(text, W / 2, H / 2 + 3);
      ctx.fillStyle = fg; ctx.fillText(text, W / 2, H / 2 + 3);
    }, w || 512, h || 96);
  }

  let clockTex = null;
  function clockTexture() {
    if (clockTex) return clockTex;
    clockTex = textTexture((ctx, W, H) => {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#1d1a2b'; ctx.beginPath(); ctx.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f7f1e1'; ctx.beginPath(); ctx.arc(W / 2, H / 2, W / 2 - 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1d1a2b';
      for (let k = 0; k < 12; k++) {
        const a = k / 12 * Math.PI * 2;
        ctx.beginPath(); ctx.arc(W / 2 + Math.cos(a) * (W / 2 - 26), H / 2 + Math.sin(a) * (H / 2 - 26), k % 3 ? 4 : 8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.lineCap = 'round'; ctx.strokeStyle = '#1d1a2b';
      ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(W / 2, H / 2); ctx.lineTo(W / 2 + 34, H / 2 - 22); ctx.stroke();
      ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(W / 2, H / 2); ctx.lineTo(W / 2 - 8, H / 2 - 70); ctx.stroke();
    }, 256, 256);
    return clockTex;
  }

  // ------------------------------------------------------------------ éléments de façade
  // Fenêtre dans le repère F d'une façade (x le long de la façade, z vers l'extérieur).
  function windowAt(K, F, x, y, shutter, opts = {}) {
    const D = K.detail;
    K.box(D, F, x, y, 0.02, 1.02, 1.28, 0.08, '#f4f1ea');
    K.box(D, F, x, y, 0.05, 0.82, 1.08, 0.08, '#3f5378');
    K.box(D, F, x, y - 0.68, 0.1, 1.12, 0.08, 0.22, '#e7e1d4');
    if (shutter) {
      K.box(D, F, x - 0.78, y, 0.05, 0.46, 1.24, 0.07, shutter);
      K.box(D, F, x + 0.78, y, 0.05, 0.46, 1.24, 0.07, shutter);
    }
    if (opts.flowers) {
      K.box(D, F, x, y - 0.6, 0.22, 0.95, 0.2, 0.24, '#8a5a3a');
      for (let k = -1; k <= 1; k++) K.add(D, unit().ball, F, x + k * 0.3, y - 0.43, 0.24, 0.24, 0.2, 0.24, opts.flowers);
    }
  }

  function doorAt(K, F, x, color) {
    K.box(K.detail, F, x, 1.08, 0.04, 1.05, 2.16, 0.1, color || '#8a5a3a');
    K.box(K.detail, F, x, 0.08, 0.3, 1.4, 0.16, 0.6, '#cfc8bb');
  }

  // Devanture : vitrine, porte, enseigne et store rayé.
  function shopFront(K, F, w, sign, color, opts = {}) {
    const D = K.detail;
    K.box(D, F, -w * 0.12, 1.3, 0.05, w * 0.58, 1.75, 0.1, '#3f5378');
    K.box(D, F, -w * 0.12, 0.3, 0.07, w * 0.6, 0.22, 0.12, color);
    K.box(D, F, w * 0.3, 1.08, 0.05, 1.0, 2.16, 0.1, '#4a5d82');
    K.box(D, F, 0, 2.62, 0.08, w - 0.7, 0.66, 0.14, color);
    K.text(F, 0, 2.62, 0.16, w - 0.95, 0.5, signTex(sign, color, opts.fg || '#ffffff'));
    if (opts.awning !== false) {
      // store rayé, penché vers la rue
      const n = Math.max(4, Math.round((w - 1) / 0.55));
      const sw = (w - 1) / n;
      for (let k = 0; k < n; k++) {
        K.add(D, unit().box, F, -(w - 1) / 2 + sw * (k + 0.5), 2.1, 0.62, sw, 0.06, 1.3, k % 2 ? '#ffffff' : (opts.awning || color), 0.38, 0, 0);
      }
    }
  }

  // ------------------------------------------------------------------ bâtiments
  // Repère M : origine au milieu du bas de la façade côté route, +z vers la route, bâtiment en z < 0.
  function house(K, M, o) {
    const { w, d, floors, st, rnd } = o;
    const S = K.struct;
    const H = floors * FLOOR_H;
    const wall = o.wall, roof = o.roof;
    K.box(S, M, 0, -1.4, -d / 2, w + 0.3, 3.4, d + 0.3, '#bdb3a3');
    if (st.wood) {
      K.box(S, M, 0, FLOOR_H / 2, -d / 2, w, FLOOR_H, d, wall);
      if (floors > 1) K.box(S, M, 0, FLOOR_H + (H - FLOOR_H) / 2, -d / 2, w + 0.06, H - FLOOR_H, d + 0.06, o.wood);
    } else {
      K.box(S, M, 0, H / 2, -d / 2, w, H, d, wall);
    }
    const roofH = d * st.pitch;
    const ov = st.overhang;
    K.add(S, unit().prism, M, 0, H, -d / 2, w + ov * 2, roofH, d + ov * 2, roof);
    if (rnd() < 0.8) K.box(S, M, w * (rnd() < 0.5 ? 0.28 : -0.28), H + roofH * 0.55, -d * 0.32, 0.6, roofH * 0.9 + 0.5, 0.6, st.wood ? '#8d8576' : '#c2724f');

    // façade avant
    const F = K.sub(M, 0, 0, 0, 0);
    const nWin = Math.max(1, Math.floor((w - 1.2) / 2.4));
    const xs = [];
    for (let k = 0; k < nWin; k++) xs.push(-w / 2 + (w / nWin) * (k + 0.5));
    const flowers = st.wood || (o.styleName === 'sud' && rnd() < 0.5) ? (rnd() < 0.7 ? '#e2463a' : '#ff7aa8') : null;
    for (let f = 0; f < floors; f++) {
      const y = f * FLOOR_H + 1.55;
      if (f === 0 && o.shop) continue;
      for (let k = 0; k < xs.length; k++) {
        if (f === 0 && !o.shop && k === Math.floor(xs.length / 2)) { doorAt(K, F, xs[k], o.door); continue; }
        windowAt(K, F, xs[k], y, o.shutter, { flowers: f > 0 ? flowers : null });
      }
    }
    if (o.shop) o.shop(F);
    // balcon de chalet
    if (st.wood && floors > 1) {
      K.box(S, M, 0, FLOOR_H + 0.05, 0.6, w * 0.8, 0.14, 1.2, o.wood);
      K.box(S, M, 0, FLOOR_H + 0.55, 1.15, w * 0.8, 0.9, 0.1, o.wood);
      for (let k = -2; k <= 2; k++) K.add(K.detail, unit().ball, M, k * w * 0.16, FLOOR_H + 1.05, 1.18, 0.35, 0.28, 0.3, flowers || '#e2463a');
    }
    // façade arrière et pignons (moins détaillés)
    const B = K.sub(M, 0, 0, -d, Math.PI);
    for (let f = 0; f < floors; f++) {
      for (let k = 0; k < xs.length; k += 2) windowAt(K, B, xs[k], f * FLOOR_H + 1.55, null);
    }
    for (const side of [-1, 1]) {
      const Sd = K.sub(M, side * w / 2, 0, -d / 2, side * Math.PI / 2);
      for (let f = 0; f < floors; f++) windowAt(K, Sd, 0, f * FLOOR_H + 1.55, f === floors - 1 ? null : o.shutter);
    }
  }

  function church(K, M, o) {
    const S = K.struct, D = K.detail;
    const stone = '#ddd0b4', slate = o.st === STYLES.sud ? '#c8603f' : '#4f586c';
    const tw = 4.6, th = 17;
    // parvis pavé, bancs et fontaine
    K.box(S, M, 0, -0.05, 6, 15, 0.3, 12, '#d9cfbd');
    for (const sx of [-1, 1]) {
      K.box(D, M, sx * 5.5, 0.45, 8, 2.2, 0.12, 0.6, '#8a5a3a');
      K.box(D, M, sx * 5.5, 0.22, 8, 0.2, 0.44, 0.5, '#5b5f6a');
    }
    K.add(S, unit().cyl, M, 0, 0.35, 7, 3.2, 0.7, 3.2, '#cbbfa8');
    K.add(D, unit().cyl, M, 0, 0.68, 7, 2.7, 0.06, 2.7, '#5fc4e8');
    K.add(S, unit().cyl, M, 0, 1.2, 7, 0.45, 1.6, 0.45, '#cbbfa8');
    // nef
    K.box(S, M, 0, -1.4, -13, 10.4, 3.4, 26.6, '#bdb3a3');
    K.box(S, M, 0, 4.5, -15, 9.5, 9, 20, stone);
    K.add(S, unit().prism, M, 0, 9, -15, 21, 4.5, 10.3, slate, 0, Math.PI / 2, 0);
    // abside
    K.add(S, unit().cyl, M, 0, 3.8, -25, 7, 7.6, 7, stone);
    K.add(S, unit().cone, M, 0, 7.6, -25, 8, 3, 8, slate);
    // clocher
    K.box(S, M, 0, th / 2, -tw / 2, tw, th, tw, stone);
    K.add(S, unit().pyramid, M, 0, th, -tw / 2, tw + 0.5, 9, tw + 0.5, slate);
    K.box(S, M, 0, th + 9.4, -tw / 2, 0.14, 1.4, 0.14, '#d4a933');
    K.box(S, M, 0, th + 9.6, -tw / 2, 0.8, 0.14, 0.14, '#d4a933');
    // corniche, abat-sons, portail, vitraux
    K.box(S, M, 0, th - 4.2, -tw / 2, tw + 0.4, 0.3, tw + 0.4, '#cfc2a6');
    for (let k = 0; k < 4; k++) {
      const F = K.sub(M, Math.sin(k * Math.PI / 2) * tw / 2, 0, -tw / 2 + Math.cos(k * Math.PI / 2) * tw / 2, k * Math.PI / 2);
      K.box(D, F, 0, th - 2.2, 0.03, 1.3, 2.4, 0.1, '#3a3346');
      for (let j = 0; j < 4; j++) K.box(D, F, 0, th - 3.1 + j * 0.55, 0.1, 1.3, 0.12, 0.1, '#8d6b4a');
    }
    const Ff = K.sub(M, 0, 0, 0, 0);
    K.box(D, Ff, 0, 1.6, 0.05, 1.9, 3.2, 0.12, '#6b4a33');
    K.add(D, unit().cyl, Ff, 0, 3.2, 0.05, 1.9, 0.12, 1.9, '#6b4a33', Math.PI / 2, 0, 0);
    K.text(Ff, 0, 11.6, 0.06, 2.4, 2.4, clockTexture());
    for (const side of [-1, 1]) {
      const Sd = K.sub(M, side * 4.75, 0, -15, side * Math.PI / 2);
      for (let k = -2; k <= 2; k++) {
        K.box(D, Sd, k * 3.4, 4.6, 0.04, 1.1, 3.2, 0.1, k % 2 ? '#4f7fd0' : '#d0574f');
        K.add(D, unit().cyl, Sd, k * 3.4, 6.2, 0.04, 1.1, 0.1, 1.1, k % 2 ? '#4f7fd0' : '#d0574f', Math.PI / 2, 0, 0);
      }
    }
  }

  function mairie(K, M, o) {
    house(K, M, Object.assign({}, o, { floors: 2, shop: null, door: '#3d5f8a' }));
    const F = K.sub(M, 0, 0, 0, 0);
    K.box(K.detail, F, 0, 3.0, 0.1, 3.2, 0.62, 0.12, '#2f4a7a');
    K.text(F, 0, 3.0, 0.17, 3.0, 0.5, signTex('MAIRIE', '#2f4a7a', '#ffffff', 384, 64));
    // drapeau tricolore
    const fl = K.sub(M, 0, 3.6, 0.2, 0);
    K.add(K.detail, unit().cyl, fl, 0, 0.9, 0.55, 0.06, 2.2, 0.06, '#d8d8d8', 0.75, 0, 0);
    const FL = K.sub(fl, 0, 1.55, 1.3, 0);
    K.flags.push({ m: FL, colors: ['#2a4fa8', '#ffffff', '#e2463a'] });
  }

  // ------------------------------------------------------------------ village complet
  function obbOf(cx, cz, ax, az, hw, hd) { return { cx, cz, ax, az, hw, hd }; }
  function obbOverlap(a, b, margin) {
    const axes = [[a.ax, a.az], [-a.az, a.ax], [b.ax, b.az], [-b.az, b.ax]];
    for (const [ux, uz] of axes) {
      const proj = (o) => {
        const c = o.cx * ux + o.cz * uz;
        const r = Math.abs(o.ax * ux + o.az * uz) * o.hw + Math.abs(-o.az * ux + o.ax * uz) * o.hd;
        return [c - r, c + r];
      };
      const pa = proj(a), pb = proj(b);
      if (pa[1] + margin < pb[0] || pb[1] + margin < pa[0]) return false;
    }
    return true;
  }

  function buildVillage(route, L, tiles, v, group) {
    const rnd = mulberry32(v.seed);
    const st = STYLES[v.style];
    const styleName = v.style;
    const sp = route.spacing, half = L.roadHalf;
    const s0 = v.i0 * sp + 8, s1 = v.i1 * sp - 8, sc = v.ic * sp;
    const K = new Kit();
    const placed = [];
    const tmp = {}, o = {};
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const churchSide = rnd() < 0.5 ? 1 : -1;
    const shops = SHOPS.slice().sort(() => rnd() - 0.5).slice(0, 2 + Math.floor(rnd() * 3));
    const specials = {};
    specials[churchSide] = ['tabac', 'church', 'pharmacie'].concat(shops.slice(0, 1).map((x) => ({ shop: x })));
    specials[-churchSide] = ['bakery', 'cafe', 'mairie'].concat(shops.slice(1).map((x) => ({ shop: x })));
    const cafeName = pick(CAFES);
    const sidewalk = 1.9;

    // trottoirs
    const walk = new GB2();
    for (const side of [-1, 1]) {
      let prev = null;
      for (let s = s0 - 18; s <= s1 + 18; s += sp) {
        const p = route.sample(s, tmp);
        const y = p.y + 0.04;
        const a = [p.x + p.rx * half * side, p.z + p.rz * half * side];
        const b = [p.x + p.rx * (half + sidewalk) * side, p.z + p.rz * (half + sidewalk) * side];
        const cur = { a, b, y };
        if (prev) {
          walk.quadUp(prev.a, prev.b, cur.b, cur.a, prev.y + 0.15, cur.y + 0.15, '#d3cec4');
          walk.wall(prev.a, cur.a, prev.y - 0.05, cur.y - 0.05, 0.2, '#ece8e0');
          walk.wall(prev.b, cur.b, prev.y - 0.6, cur.y - 0.6, 0.75, '#bdb6aa');
        }
        prev = cur;
      }
    }

    // bâtiments
    for (const side of [-1, 1]) {
      const queue = specials[side].slice();
      let s = s0 + rnd() * 6;
      let guard = 0;
      while (s < s1 && guard++ < 200) {
        const inCenter = Math.abs(s - sc) < 115;
        let type = 'house';
        if (inCenter && queue.length) {
          type = queue[0];
          if (type === 'church' && s < sc - 14) type = 'house';
          else queue.shift();
        }
        const isObj = typeof type === 'object';
        let w, d, setback, floors = 1 + (rnd() < 0.75 ? 1 : 0) + (rnd() < (inCenter ? 0.35 : 0.08) ? 1 : 0);
        if (type === 'church') { w = 15; d = 28; setback = 12.5; }
        else if (type === 'mairie') { w = 13; d = 10; setback = 3; floors = 2; }
        else if (type === 'cafe') { w = 9 + rnd() * 2; d = 9; setback = 4.6; floors = Math.max(floors, 2); }
        else if (type !== 'house' || isObj) { w = 7.5 + rnd() * 2.5; d = 8.5; setback = 0.5 + rnd() * 0.6; floors = Math.max(floors, 2); }
        else { w = 6.5 + rnd() * 4.5; d = 7 + rnd() * 2.5; setback = inCenter ? 0.4 + rnd() * 1.2 : 2 + rnd() * 5; }
        if (st.wood && type === 'house') { floors = Math.max(2, floors); d += 1; }
        const sMid = s + w / 2;
        const p = route.sample(sMid, {});
        const off = half + sidewalk + setback;
        const fx = p.x + p.rx * off * side, fz = p.z + p.rz * off * side;
        const nx = -p.rx * side, nz = -p.rz * side; // normale de façade (vers la route)
        const ax = nz, az = -nx; // axe x local (le long de la façade)
        const cx = fx - nx * d / 2, cz = fz - nz * d / 2;
        const ob = obbOf(cx, cz, ax, az, w / 2, d / 2);
        let ok = !placed.some((q) => obbOverlap(ob, q, 0.4));
        if (ok) {
          for (const [kx, kz] of [[-1, 0], [1, 0], [-1, -1], [1, -1], [0, -1]]) {
            const x = fx + ax * kx * w / 2 + nx * kz * d, z = fz + az * kx * w / 2 + nz * kz * d;
            const nr = route.nearest(x, z, 14, tmp);
            if (nr.i >= 0 && nr.d < half + sidewalk + 0.2) { ok = false; break; }
            L.sample(x, z, o);
            if (o.under || o.lakeRn < 1.3 || o.dr < o.rw + 5) { ok = false; break; }
          }
        }
        if (!ok) {
          if (type !== 'house') queue.unshift(type);
          s += 3;
          continue;
        }
        placed.push(ob);
        const M = new THREE.Matrix4().compose(new THREE.Vector3(fx, p.y - 0.1, fz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(nx, nz), 0)), new THREE.Vector3(1, 1, 1));
        const base = {
          w, d, floors, st, styleName, rnd,
          wall: pick(st.walls), roof: pick(st.roofs), shutter: pick(st.shutters), wood: st.wood ? pick(st.wood) : null
        };
        if (type === 'church') church(K, M, { st });
        else if (type === 'mairie') mairie(K, M, Object.assign(base, { wall: '#f1ebdd', roof: st === STYLES.sud ? '#c8603f' : '#4f586c' }));
        else if (type === 'bakery') {
          base.shop = (F) => {
            shopFront(K, F, w, 'BOULANGERIE · PÂTISSERIE', '#7a4a2a', { fg: '#ffd98a', awning: '#e2463a' });
            // baguette géante sur l'enseigne
            K.add(K.detail, unit().cyl, F, 0.2, 3.15, 0.25, 0.22, 2.2, 0.22, '#e3a95b', 0, 0, 1.35);
            K.add(K.detail, unit().sphere, F, 0.2 - 1.07, 2.93, 0.25, 0.26, 0.26, 0.26, '#e3a95b');
            K.add(K.detail, unit().sphere, F, 0.2 + 1.07, 3.37, 0.25, 0.26, 0.26, 0.26, '#e3a95b');
          };
          house(K, M, base);
        } else if (type === 'cafe') {
          base.shop = (F) => {
            shopFront(K, F, w, cafeName, '#1f6f5c', { awning: '#1f6f5c' });
            // terrasse : tables, chaises, parasols
            for (let k = 0; k < 3; k++) {
              const tx = -w / 2 + 1.6 + k * (w - 3.2) / 2, tz = 2.4 + (k % 2) * 0.8;
              K.add(K.detail, unit().cyl, F, tx, 0.74, tz, 0.8, 0.05, 0.8, '#f2f2f2');
              K.add(K.detail, unit().cyl, F, tx, 0.37, tz, 0.07, 0.74, 0.07, '#4a4f5c');
              for (const cxs of [-0.7, 0.7]) {
                K.box(K.detail, F, tx + cxs, 0.45, tz, 0.42, 0.06, 0.42, '#c0392b');
                K.box(K.detail, F, tx + cxs * 1.25, 0.75, tz, 0.06, 0.6, 0.42, '#c0392b');
              }
              K.add(K.detail, unit().cyl, F, tx, 1.2, tz, 0.06, 2.4, 0.06, '#e8e8e8');
              K.add(K.struct, unit().cone, F, tx, 2.3, tz, 2.6, 0.55, 2.6, k % 2 ? '#ffffff' : '#e2463a');
            }
          };
          house(K, M, base);
        } else if (type === 'tabac') {
          base.shop = (F) => {
            shopFront(K, F, w, 'TABAC · PRESSE', '#b8322a', { awning: false });
            // carotte rouge en drapeau
            const C = K.sub(F, w / 2 - 0.4, 3.1, 0.7, 0);
            K.box(K.detail, C, 0, 0, -0.35, 0.08, 0.08, 0.7, '#3a3a44');
            K.add(K.struct, unit().cone, C, 0, 0, 0, 0.7, 0.45, 0.22, '#e2463a');
            K.add(K.struct, unit().cone, C, 0, 0, 0, 0.7, 0.45, 0.22, '#e2463a', Math.PI, 0, 0);
          };
          house(K, M, base);
        } else if (type === 'pharmacie') {
          base.shop = (F) => {
            shopFront(K, F, w, 'PHARMACIE', '#1f8f4e', { awning: false });
            const C = K.sub(F, -w / 2 + 0.5, 3.2, 0.75, 0);
            K.box(K.detail, C, 0, 0, -0.4, 0.08, 0.08, 0.8, '#3a3a44');
            K.box(K.struct, C, 0, 0, 0, 0.16, 0.36, 1.05, '#2fdc68');
            K.box(K.struct, C, 0, 0, 0, 0.16, 1.05, 0.36, '#2fdc68');
          };
          house(K, M, base);
        } else if (isObj) {
          base.shop = (F) => shopFront(K, F, w, type.shop[0], type.shop[1], { awning: rnd() < 0.7 ? type.shop[1] : false });
          house(K, M, base);
        } else {
          house(K, M, base);
        }
        s += w + (inCenter ? 0.4 + rnd() * 1.6 : 2 + rnd() * 7);
      }
    }

    // lampadaires
    let lampSide = 1;
    for (let s = s0 + 6; s < s1; s += 22) {
      const p = route.sample(s, tmp);
      const off = (half + sidewalk - 0.35) * lampSide;
      const M = new THREE.Matrix4().compose(new THREE.Vector3(p.x + p.rx * off, p.y + 0.15, p.z + p.rz * off), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(-p.rx * lampSide, -p.rz * lampSide), 0)), new THREE.Vector3(1, 1, 1));
      K.add(K.struct, unit().cyl, M, 0, 2.1, 0, 0.12, 4.2, 0.12, '#2f4a3e');
      K.box(K.struct, M, 0, 4.15, 0.45, 0.08, 0.08, 0.9, '#2f4a3e');
      K.box(K.detail, M, 0, 3.72, 0.85, 0.3, 0.36, 0.3, '#fff3b0');
      K.add(K.struct, unit().pyramid, M, 0, 3.9, 0.85, 0.52, 0.3, 0.52, '#2f4a3e');
      lampSide = -lampSide;
    }

    // fanions au-dessus de la route
    for (const fs of [sc + 6, s0 + 45, s1 - 45]) {
      const p = route.sample(fs, tmp);
      const ends = [-1, 1].map((sd) => {
        const off = (half + sidewalk - 0.3) * sd;
        const x = p.x + p.rx * off, z = p.z + p.rz * off;
        const M = new THREE.Matrix4().makeTranslation(x, p.y + 0.1, z);
        K.add(K.struct, unit().cyl, M, 0, 3.3, 0, 0.12, 6.6, 0.12, '#f2f2f2');
        return new THREE.Vector3(x, p.y + 6.4, z);
      });
      K.flags.push({ line: ends });
    }

    // panneaux d'entrée et de sortie d'agglomération
    for (const [s, exit] of [[v.i0 * sp - 6, false], [v.i1 * sp + 6, true]]) {
      const tex = textTexture((ctx, W, H) => {
        ctx.fillStyle = '#e2463a'; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(16, 16, W - 32, H - 32);
        let size = 64;
        const name = v.name.toUpperCase();
        ctx.font = '700 ' + size + 'px ' + FONT;
        while (ctx.measureText(name).width > W - 60 && size > 20) { size -= 2; ctx.font = '700 ' + size + 'px ' + FONT; }
        ctx.fillStyle = '#1d1a2b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(name, W / 2, H / 2 + 2);
        if (exit) {
          ctx.strokeStyle = '#e2463a'; ctx.lineWidth = 16;
          ctx.beginPath(); ctx.moveTo(24, H - 20); ctx.lineTo(W - 24, 20); ctx.stroke();
        }
      }, 640, 200);
      const g = B3D.road.makeSign(tex, 2.3, 0.72, 1.7);
      const sp2 = B3D.road.placeOnRoad(route, g, s, half + 1.6, 0);
      g.position.y = sp2.y;
      group.add(g);
    }

    // maillage du village
    const toonMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradientMap() });
    if (K.struct.length) {
      const geo = merge(K.struct);
      computeOutlineNormals(geo);
      const m = new THREE.Mesh(geo, toonMat);
      m.castShadow = true; m.receiveShadow = true;
      const ol = new THREE.Mesh(geo, outlineMat({ width: 0.9, maxW: 0.2 }));
      ol.userData.isOutline = true;
      m.add(ol);
      group.add(m);
    }
    if (K.detail.length) {
      const m = new THREE.Mesh(merge(K.detail), toonMat);
      m.receiveShadow = true;
      group.add(m);
    }
    const wg = walk.build();
    if (wg) {
      const m = new THREE.Mesh(wg, new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradientMap(), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
      m.receiveShadow = true;
      group.add(m);
    }
    for (const t of K.texts) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(t.w, t.h), new THREE.MeshBasicMaterial({ map: t.tex, transparent: t.tex === clockTex }));
      pl.matrixAutoUpdate = false;
      pl.matrix.copy(t.matrix);
      group.add(pl);
    }
    buildFlags(K.flags, group);

    // habitants qui encouragent le long des trottoirs (plus nombreux au centre) et en terrasse
    const spect = [];
    for (let s = s0; s < s1; s += 2.1) {
      const center = Math.exp(-Math.pow((s - sc) / 110, 2));
      for (const side of [-1, 1]) {
        if (rnd() > 0.1 + 0.5 * center) continue;
        const p = route.sample(s + rnd() * 1.5, {});
        const off = (half + 0.55 + rnd() * 1.1) * side;
        spect.push({ x: p.x + p.rx * off, y: p.y + 0.19, z: p.z + p.rz * off, rot: Math.atan2(-p.rx * side, -p.rz * side) + (rnd() - 0.5) * 0.7, i: p.i });
      }
    }
    return spect;
  }

  // Fanions : triangles colorés le long de cordes affaissées, et drapeau de la mairie.
  function buildFlags(list, group) {
    const pos = [], col = [];
    const c = new THREE.Color();
    const palette = ['#e2463a', '#ffd23a', '#3d7be0', '#4cc35a', '#ffffff', '#ff7aa8'];
    const tri = (a, b, d, color) => { pos.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z); c.set(color); for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b); };
    for (const f of list) {
      if (f.line) {
        const [A, Bp] = f.line;
        const n = Math.max(6, Math.round(A.distanceTo(Bp) / 0.65));
        const along = Bp.clone().sub(A).normalize();
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          const p = A.clone().lerp(Bp, t);
          p.y -= 1.1 * 4 * t * (1 - t);
          tri(p.clone().addScaledVector(along, -0.24), p.clone().addScaledVector(along, 0.24), p.clone().add(new THREE.Vector3(0, -0.5, 0)), palette[k % palette.length]);
        }
      } else if (f.m) {
        // drapeau à trois bandes verticales
        for (let k = 0; k < 3; k++) {
          const q = [[k * 0.4, 0], [(k + 1) * 0.4, 0], [(k + 1) * 0.4, -0.8], [k * 0.4, -0.8]].map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(f.m));
          tri(q[0], q[1], q[2], f.colors[k]); tri(q[0], q[2], q[3], f.colors[k]);
        }
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    group.add(new THREE.Mesh(g, new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide, gradientMap: gradientMap() })));
  }

  // Petit constructeur pour les trottoirs (dessus + bordures).
  class GB2 {
    constructor() { this.p = []; this.c = []; this.col = new THREE.Color(); }
    tri(a, b, d, color) {
      this.col.set(color);
      this.p.push(...a, ...b, ...d);
      for (let k = 0; k < 3; k++) this.c.push(this.col.r, this.col.g, this.col.b);
    }
    quadUp(a, b, c2, d, y0, y1, color) {
      const A = [a[0], y0, a[1]], B = [b[0], y0, b[1]], C = [c2[0], y1, c2[1]], D = [d[0], y1, d[1]];
      // orientation vers le haut quel que soit le côté
      const ux = B[0] - A[0], uz = B[2] - A[2], vx = D[0] - A[0], vz = D[2] - A[2];
      if (uz * vx - ux * vz > 0) { this.tri(A, B, C, color); this.tri(A, C, D, color); }
      else { this.tri(A, C, B, color); this.tri(A, D, C, color); }
    }
    wall(a, b, y0, y1, h, color) {
      const A = [a[0], y0, a[1]], B = [b[0], y1, b[1]], C = [b[0], y1 + h, b[1]], D = [a[0], y0 + h, a[1]];
      this.tri(A, B, C, color); this.tri(A, C, D, color);
      this.tri(A, C, B, color); this.tri(A, D, C, color);
    }
    build() {
      if (!this.p.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      g.computeVertexNormals();
      return g;
    }
  }

  B3D.villages = {
    // Construit tous les villages ; place les habitants dans le pool de spectateurs.
    build(route, L, tiles) {
      const group = new THREE.Group();
      group.name = 'villages';
      const P = tiles.pools.spectator;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3();
      const col = new THREE.Color();
      const shirts = ['#e2463a', '#f2c230', '#3d7be0', '#5cc85a', '#ffffff', '#ff7aa8', '#9b6bff', '#ff9a2b', '#1d1a2b', '#7fd0e8'];
      const rnd = mulberry32(L.seed ^ 0x7e0);
      L.crowd = L.crowd || new Float32Array(route.n);
      for (const v of L.villages) {
        const g = new THREE.Group();
        g.name = 'village ' + v.name;
        g.userData.center = new THREE.Vector3(route.x[v.ic], route.y[v.ic], route.z[v.ic]);
        g.userData.radius = (v.i1 - v.i0) * route.spacing / 2 + 60;
        const people = buildVillage(route, L, tiles, v, g);
        group.add(g);
        for (const pp of people) {
          const i = P.alloc();
          if (i < 0) break;
          e.set(0, pp.rot, 0); q.setFromEuler(e);
          const s = 0.8 + rnd() * 0.3;
          m.compose(new THREE.Vector3(pp.x, pp.y, pp.z), q, sc.set(s, s, s));
          P.set(i, m, col.set(shirts[Math.floor(rnd() * shirts.length)]));
          L.crowd[pp.i] += 1;
        }
      }
      P.flush();
      return group;
    },

    // Masque les villages trop loin de la caméra (au-delà du brouillard).
    cull(group, camPos, maxDist) {
      for (const g of group.children) {
        const c = g.userData.center;
        if (c) g.visible = camPos.distanceTo(c) - g.userData.radius < maxDist;
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
