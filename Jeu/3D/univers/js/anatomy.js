/* Bike3D — anatomie du cycliste des niveaux de détail « détaillé » et « réaliste » (B3D.anatomy), pour B3D.Cyclist (le joueur, la
   vitrine du magasin) et B3D.Peloton (les coureurs proches de la caméra).
   Des géométries sans matériau : des pièces à fusionner ({geo, color, matrix?}, comme B3D.toon.merge) pour la tête (crâne et visage,
   nez, oreilles, lèvres, yeux, sourcils, cheveux, queue de cheval, jugulaire du casque), les bras et les jambes galbés (deltoïde,
   biceps, quadriceps, mollet, tibia, chevilles ; manches, cuissard, chaussettes, couvre-chaussures), les mains gantées, les
   chaussures, le bassin et les fessiers (une seule surface, avec le reflet du lycra) ; le buste (épaules arrondies d'où sortent les bras, omoplates, dos rond du cycliste,
   pectoraux ou poitrine chez une femme) est une géométrie simple qui garde les coordonnées de texture de la sphère du modèle
   simple, pour le motif du maillot.
   q : 1 (détaillé) ou 2 (réaliste : plus fin, avec les finitions : col et fermeture du maillot, poches, bande de cuissard, doigts,
   molettes et cales des chaussures, jugulaire, cils…). fem : morphologie féminine.
   Repères, ceux du modèle simple de B3D.Cyclist :
     tête   : centre du crâne, +z le visage, +y le haut ; mesures du modèle simple (rayon 0,135), le cycliste l'affiche réduite ;
     membre : axe y de -0,5 (première articulation) à 0,5 (seconde), étiré à sa longueur à la pose ; +z devant ; rayons en mètres ;
     buste  : sphère unité étirée du bassin aux épaules (y), +z la poitrine, x sur le côté ;
     main   : origine à la prise du cintre, +z le long de l'avant-bras, +y le dos de la main ;
     chaussure : centre entre la cheville et la pointe, +z vers la pointe, +y le dessus. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const bell = (x, c, w) => Math.exp(-((x - c) / w) * ((x - c) / w));
  const tr = (x, y, z, rx, ry, rz, sx, sy, sz) => B3D.toon.tr(x, y, z, rx, ry, rz, sx, sy, sz);

  /** Profil lisse passant par des points [t, valeur] (Hermite cubique, pentes de Catmull-Rom). */
  function curve(pts) {
    const n = pts.length - 1;
    const slope = (k) => { const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n, k + 1)]; return (b[1] - a[1]) / (b[0] - a[0]); };
    return (t) => {
      if (t <= pts[0][0]) return pts[0][1];
      if (t >= pts[n][0]) return pts[n][1];
      let i = 0;
      while (t > pts[i + 1][0]) i++;
      const h = pts[i + 1][0] - pts[i][0], u = (t - pts[i][0]) / h, u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * pts[i][1] + (u3 - 2 * u2 + u) * slope(i) * h + (-2 * u3 + 3 * u2) * pts[i + 1][1] + (u3 - u2) * slope(i + 1) * h;
    };
  }

  /** Normales lissées, y compris sur les coutures (sommets confondus). */
  function smoothNormals(geo) {
    geo.computeVertexNormals();
    const pos = geo.attributes.position, nor = geo.attributes.normal, acc = new Map(), keys = new Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const k = Math.round(pos.getX(i) * 1e4) + ',' + Math.round(pos.getY(i) * 1e4) + ',' + Math.round(pos.getZ(i) * 1e4);
      keys[i] = k;
      const a = acc.get(k) || [0, 0, 0];
      a[0] += nor.getX(i); a[1] += nor.getY(i); a[2] += nor.getZ(i);
      acc.set(k, a);
    }
    for (let i = 0; i < pos.count; i++) {
      const a = acc.get(keys[i]), l = Math.hypot(a[0], a[1], a[2]) || 1;
      nor.setXYZ(i, a[0] / l, a[1] / l, a[2] / l);
    }
    return geo;
  }

  /** Sphère déformée : fn(direction unité) → point ; keep(direction) : garde seulement ces triangles (cheveux). */
  function deformed(w, h, fn, keep) {
    const geo = new THREE.SphereGeometry(1, w, h);
    const pos = geo.attributes.position, n = new THREE.Vector3(), dirs = [];
    for (let i = 0; i < pos.count; i++) {
      n.fromBufferAttribute(pos, i).normalize();
      dirs.push(n.clone());
      const p = fn(n);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    if (keep) {
      const idx = geo.index.array, out = [];
      for (let k = 0; k < idx.length; k += 3) if (keep(dirs[idx[k]]) && keep(dirs[idx[k + 1]]) && keep(dirs[idx[k + 2]])) out.push(idx[k], idx[k + 1], idx[k + 2]);
      geo.setIndex(out);
    }
    return smoothNormals(geo);
  }

  /** Anneaux le long d'un axe : stations [{c (centre), t (tangente), n (normale « devant »), r(th) (m)}] ; th = 0 devant, th > 0 vers
      b = t × n. Les anneaux n'ont pas de couture (indices modulo seg). */
  function rings(stations, seg) {
    const pos = [], idx = [], b = new THREE.Vector3();
    for (const s of stations) {
      b.crossVectors(s.t, s.n);
      for (let j = 0; j < seg; j++) {
        const th = (j / seg) * Math.PI * 2, r = s.r(th);
        pos.push(s.c.x + (s.n.x * Math.cos(th) + b.x * Math.sin(th)) * r, s.c.y + (s.n.y * Math.cos(th) + b.y * Math.sin(th)) * r, s.c.z + (s.n.z * Math.cos(th) + b.z * Math.sin(th)) * r);
      }
    }
    for (let i = 0; i + 1 < stations.length; i++) {
      for (let j = 0; j < seg; j++) {
        const a = i * seg + j, c = i * seg + (j + 1) % seg;
        idx.push(a, c, a + seg, c, c + seg, a + seg);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return smoothNormals(geo);
  }

  /** Membre galbé : r(t, th) (m ; t de 0 à 1 de la première à la seconde articulation), len : longueur réelle (pour des bouts
      ronds), bands : [[t1, couleur, reflet du tissu (sheen, facultatif)], …] (chaque couleur jusqu'à t1, la dernière jusqu'au bout),
      q : finesse. Une pièce par couleur. */
  function limb(r, len, bands, q, caps) {
    const seg = q > 1 ? 18 : 12, n = q > 1 ? 18 : 10, K = q > 1 ? 4 : 3;
    const capA = caps ? caps[0] : 0.75, capB = caps ? caps[1] : 0.75;
    const Y = V(0, 1, 0), Z = V(0, 0, 1);
    const st = (t, y, k) => ({ c: V(0, y, 0), t: Y, n: Z, r: (th) => r(t, th) * k, tt: t });
    // stations : calotte du début, fût, calotte de la fin (le rayon moyen d'un bout donne la hauteur de sa calotte)
    const mean = (t) => (r(t, 0) + r(t, Math.PI / 2) + r(t, Math.PI) + r(t, -Math.PI / 2)) / 4;
    const all = [];
    for (let k = K; k >= 1; k--) { const f = (k / K) * Math.PI / 2; all.push(st(0, -0.5 - capA * mean(0) / len * Math.sin(f), Math.cos(f) * (k === K ? 0.02 : 1))); }
    const ts = [];
    for (let i = 0; i <= n; i++) ts.push(i / n);
    for (const [t1] of bands.slice(0, -1)) if (!ts.some((t) => Math.abs(t - t1) < 1e-6)) ts.push(t1);
    ts.sort((a, b) => a - b);
    for (const t of ts) all.push(st(t, t - 0.5, 1));
    for (let k = 1; k <= K; k++) { const f = (k / K) * Math.PI / 2; all.push(st(1, 0.5 + capB * mean(1) / len * Math.sin(f), Math.cos(f) * (k === K ? 0.02 : 1))); }
    // une pièce par couleur : les stations de sa plage, l'anneau de la limite en commun avec la suivante
    const parts = [];
    let from = 0;
    bands.forEach(([t1, color, sheen], i) => {
      const last = i === bands.length - 1, list = [];
      for (let k = 0; k < all.length; k++) {
        const s = all[k], inStart = k < K, inEnd = k >= all.length - K;
        if ((inStart && i === 0) || (inEnd && last) || (!inStart && !inEnd && s.tt >= from - 1e-6 && (last || s.tt <= t1 + 1e-6))) list.push(s);
      }
      parts.push({ geo: rings(list, seg), color, sheen: sheen || 0 });
      from = t1;
    });
    return parts;
  }

  // Muscles des membres (rayons en m) ; side : -1 à gauche, +1 à droite (le vaste interne est du côté du vélo)
  const THIGH = curve([[0, 0.084], [0.25, 0.079], [0.55, 0.07], [0.8, 0.058], [0.93, 0.05], [1, 0.048]]);
  const SHIN = curve([[0, 0.047], [0.12, 0.045], [0.3, 0.044], [0.55, 0.037], [0.78, 0.029], [0.9, 0.027], [1, 0.03]]);
  const UPPER = curve([[0, 0.05], [0.12, 0.05], [0.3, 0.043], [0.5, 0.041], [0.85, 0.034], [1, 0.033]]); // deltoïde à la racine
  const FORE = curve([[0, 0.035], [0.2, 0.037], [0.5, 0.032], [0.85, 0.025], [1, 0.024]]);
  const front = (th) => Math.max(0, Math.cos(th)), back = (th) => Math.max(0, -Math.cos(th));
  const PROFILES = {
    thigh: (side, fem) => (t, th) => {
      const inner = Math.max(0, -Math.sin(th) * side); // vers le vélo
      return THIGH(t) * (fem ? 1.02 : 1) + 0.009 * bell(t, 0.45, 0.28) * front(th) ** 1.5 + 0.008 * bell(t, 0.82, 0.1) * front(th) * inner * 2
        + 0.004 * bell(t, 0.5, 0.3) * back(th);
    },
    shin: (side) => (t, th) => {
      const inner = Math.max(0, -Math.sin(th) * side), outer = Math.max(0, Math.sin(th) * side);
      return SHIN(t) + 0.019 * bell(t, 0.3, 0.2) * back(th) ** 1.2 * (1 + 0.25 * inner) - 0.005 * ss(0.2, 0.5, t) * front(th) ** 2
        - 0.005 * bell(t, 0.9, 0.07) * back(th) + 0.004 * bell(t, 0.97, 0.05) * (inner + outer);
    },
    upper: () => (t, th) => UPPER(t) + 0.006 * bell(t, 0.5, 0.25) * front(th) ** 1.5 + 0.004 * bell(t, 0.4, 0.25) * back(th),
    fore: () => (t, th) => FORE(t) * (1 + 0.12 * Math.sin(th) * Math.sin(th) * ss(0.6, 1, t)) + 0.004 * bell(t, 0.2, 0.2) * back(th),
    neck: (side, fem) => (t, th) => (fem ? 0.044 : 0.05) * (1.08 - 0.12 * t) + 0.006 * bell(t, 0.1, 0.25) * back(th)
  };
  const LENGTHS = { thigh: 0.46, shin: 0.45, upper: 0.3, fore: 0.3, neck: 0.16 };

  /** Bras, jambe ou cou : kind ('thigh', 'shin', 'upper', 'fore', 'neck'), side, fem, bands, q ; loose : vêtement ample (m en plus
      sur la première couleur). */
  function limbParts(kind, o) {
    const base = PROFILES[kind](o.side || 1, o.fem);
    const until = o.bands.length > 1 ? o.bands[0][0] : 1, loose = o.loose || 0;
    const r = loose ? (t, th) => base(t, th) + loose * ss(until + 0.04, until - 0.06, t) : base;
    // le haut du bras s'enfonce dans l'épaule du buste : petite calotte, pas de boule
    return limb(r, o.len || LENGTHS[kind], o.bands, o.q || 1, o.caps || (kind === 'upper' ? [0.3, 0.75] : null));
  }

  /* ------------------------------------------------------------------ tête */
  /** Point du crâne et du visage dans la direction n (unité) ; fem : visage plus fin, menton plus petit. */
  function headPoint(n, fem) {
    const { x, y, z } = n;
    let px = x * (fem ? 0.1 : 0.103), py = y * 0.126, pz = z * 0.124;
    const fr = ss(-0.3, 0.75, z), low = ss(0.1, -0.85, y), bk = ss(0.2, -0.8, z);
    // mâchoire et menton : le bas du visage descend un peu, se resserre vers le menton (mâchoire plus carrée chez un homme)
    py -= (fem ? 0.022 : 0.03) * low * fr;
    px *= 1 - (fem ? 0.36 : 0.24) * ss(-0.3, -0.95, y) * (0.35 + 0.65 * fr) - (fem ? 0.08 : 0.04) * low * fr;
    pz += 0.008 * low * fr + (fem ? 0.007 : 0.012) * bell(y, -0.72, 0.16) * bell(x, 0, 0.3) * fr;
    // sous la mâchoire, entre le menton et le cou : la ligne de la mâchoire remonte vers l'oreille
    py += 0.03 * ss(-0.3, -0.95, y) * bell(z, 0.1, 0.42);
    px *= 1 - 0.1 * ss(-0.3, -0.95, y) * bell(z, 0.1, 0.5);
    // nuque : le bas de l'arrière remonte et rentre ; occiput
    py += 0.022 * bk * low;
    pz += 0.022 * bk * low - 0.012 * bk * bell(y, 0.1, 0.45);
    // visage : plat sur les côtés, front fuyant au-dessus des arcades, bouche un peu en avant ; tempes, pommettes, joues, orbites
    pz -= 0.03 * fr * x * x + 0.014 * ss(0.35, 0.95, y) * fr;
    pz += 0.006 * bell(y, -0.36, 0.14) * bell(x, 0, 0.35) * fr;
    px *= (1 - 0.07 * bell(y, 0.35, 0.3) * fr) * (1 + (fem ? 0.035 : 0.05) * bell(y, -0.08, 0.16) * fr) * (1 - 0.04 * bell(y, -0.38, 0.14) * fr);
    pz += (fem ? 0.004 : 0.008) * bell(y, 0.27, 0.08) * fr * bell(x, 0, 0.55);
    for (const s of [-1, 1]) pz -= 0.008 * bell(x, s * 0.33, 0.13) * bell(y, 0.16, 0.1) * fr;
    return V(px, py, pz);
  }
  const dir = (x, y, z) => V(x, y, z).normalize();
  const onHead = (x, y, z, fem, out = 0) => { const n = dir(x, y, z), p = headPoint(n, fem); return p.addScaledVector(n, out); };
  const ell = (q, rx, ry, rz) => new THREE.SphereGeometry(1, q > 1 ? 16 : 10, q > 1 ? 12 : 8).scale(rx, ry, rz);
  const at = (geo, color, m) => ({ geo, color, matrix: m });
  /** Pièce placée en p, tournée pour que son axe +y suive d (unité), étirée (sx, sy, sz). */
  function along(geo, color, p, d, s) {
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize());
    return { geo, color, matrix: new THREE.Matrix4().compose(p, q, s || V(1, 1, 1)) };
  }

  /** Tube à rayon variable le long de points (Catmull-Rom) : queue de cheval, jugulaire. r(u) avec u de 0 à 1. */
  function sweep(pts, r, q, segs) {
    const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal'), n = segs || (q > 1 ? 16 : 10), seg = q > 1 ? 10 : 7;
    const fr = c.computeFrenetFrames(n, false), st = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      st.push({ c: c.getPointAt(u), t: fr.tangents[i], n: fr.normals[i], r: () => r(u) });
    }
    return rings(st, seg);
  }

  /** Tête : { skull (crâne et visage), features (nez, oreilles), marks (yeux, sourcils, lèvres : sans contour), mouth (bouche : s'ouvre
      à l'effort, en l'étirant en y), hair (cheveux), tail (queue de cheval, accrochée en tailRoot), straps (jugulaire) }.
      o : {q, fem, skin, hair, eyes (les yeux se voient : sans lunettes, ou derrière la visière), iris, tie (élastique)}. */
  function headParts(o) {
    const q = o.q || 1, fem = !!o.fem, skin = o.skin || '#f1c29b', hair = o.hair || (fem ? '#6b4423' : '#4a3426');
    const out = { skull: [], features: [], marks: [], mouth: [], hair: [], tail: [], straps: [] };
    const w = q > 1 ? 44 : 28, h = q > 1 ? 32 : 20;
    out.skull.push(at(deformed(w, h, (n) => headPoint(n, fem)), skin));
    const deep = new THREE.Color(skin).multiplyScalar(0.86).getStyle();
    // nez d'une pièce : arête étroite, plus large et plus en avant vers la pointe et les ailes
    const root = onHead(0, 0.2, 1, fem, -0.003), nl = fem ? 0.041 : 0.048;
    out.features.push(at(deformed(q > 1 ? 16 : 10, q > 1 ? 12 : 8, (n) => {
      const t = (1 - n.y) / 2, w = (fem ? 0.0052 : 0.006) + (fem ? 0.0062 : 0.0075) * t + 0.0042 * bell(t, 0.86, 0.12);
      const f = 0.005 + (fem ? 0.021 : 0.025) * Math.pow(t, 1.3) - 0.009 * ss(0.9, 1, t);
      return V(n.x * w, root.y - t * nl + (n.z < 0 ? 0 : 0.004 * ss(0.75, 1, t) * n.z), root.z + (n.z > 0 ? n.z * f : n.z * 0.006));
    }), skin));
    if (q > 1) for (const s of [-1, 1]) out.marks.push(at(ell(q, 1, 1, 1), deep, tr(s * 0.0065, root.y - nl * 0.97, root.z + 0.012, 0, 0, 0, 0.0035, 0.0018, 0.004)));
    // oreilles (et le creux de l'oreille, en réaliste)
    for (const s of [-1, 1]) {
      const e = onHead(s, 0.05, -0.1, fem, -0.004);
      out.features.push(at(ell(q, 1, 1, 1), skin, tr(e.x + s * 0.006, e.y, e.z, 0.15, s * 0.25, 0, 0.009, fem ? 0.029 : 0.032, 0.021)));
      if (q > 1) out.marks.push(at(ell(q, 1, 1, 1), deep, tr(e.x + s * 0.0135, e.y - 0.002, e.z + 0.002, 0.15, s * 0.25, 0, 0.003, 0.017, 0.011)));
    }
    // bouche (ouverture sombre), lèvres
    const m = onHead(0, -0.34, 0.94, fem, -0.003), lip = fem ? '#c87470' : '#c58a7a';
    out.mouth.push(at(ell(q, 1, 1, 1), '#4a2226', tr(m.x, m.y, m.z - 0.002, 0, 0, 0, 0.017, 0.0035, 0.006)));
    out.marks.push(at(ell(q, 1, 1, 1), lip, tr(m.x, m.y + 0.005, m.z - 0.002, -0.2, 0, 0, fem ? 0.02 : 0.021, fem ? 0.005 : 0.0038, 0.006)));
    out.marks.push(at(ell(q, 1, 1, 1), lip, tr(m.x, m.y - 0.006, m.z - 0.003, 0.25, 0, 0, 0.018, fem ? 0.0062 : 0.005, 0.0062)));
    // yeux (blanc, iris, pupille, paupière ; cils en réaliste chez une femme) et sourcils
    for (const s of [-1, 1]) {
      const e = onHead(s * 0.33, 0.16, 0.93, fem, -0.0045);
      if (o.eyes) {
        out.marks.push(at(ell(q, 1, 1, 1), '#f6f3ee', tr(e.x, e.y, e.z, 0, 0, 0, 0.0145, 0.0095, 0.0085)));
        out.marks.push(at(ell(q, 1, 1, 1), o.iris || '#5b3b22', tr(e.x, e.y - 0.0005, e.z + 0.0072, 0, 0, 0, 0.0068, 0.0068, 0.0022)));
        out.marks.push(at(ell(q, 1, 1, 1), '#141218', tr(e.x, e.y - 0.0005, e.z + 0.009, 0, 0, 0, 0.0032, 0.0032, 0.001)));
        out.marks.push(at(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.36), skin, tr(e.x, e.y + 0.0012, e.z + 0.0005, 0.45, 0, 0, 0.0157, 0.0108, 0.0098)));
        if (q > 1 && fem) out.marks.push(at(new THREE.BoxGeometry(0.03, 0.0016, 0.006), '#1d1a2b', tr(e.x, e.y + 0.0085, e.z + 0.008, -0.35, 0, -s * 0.12)));
      }
      const b = onHead(s * 0.34, 0.33, 0.88, fem, 0.001);
      out.marks.push(at(ell(q, 1, 1, 1), new THREE.Color(hair).multiplyScalar(0.8).getStyle(), tr(b.x, b.y, b.z, -0.25, -s * 0.12, -s * 0.12, fem ? 0.02 : 0.023, fem ? 0.0028 : 0.0038, 0.005)));
    }
    // cheveux : courts sous le casque (nuque, tempes, pattes) ; plus bas dans la nuque chez une femme
    out.hair.push(at(deformed(w, h, (n) => headPoint(n, fem).multiplyScalar(1.035).add(V(0, 0, -0.002)),
      (n) => n.y > (fem ? -0.5 : -0.4) + 0.4 * ss(-0.6, 0.35, n.z) && (n.z < 0.3 || n.y > 0.58) && !(Math.abs(n.x) > 0.8 && n.y < 0.15 && n.y > -0.3 && n.z > -0.3 && n.z < 0.25)), hair));
    if (fem) {
      // queue de cheval qui sort sous le casque, posée sur la nuque, et son élastique
      // le buste du cycliste est penché : la queue de cheval part vers l'arrière et se pose sur le haut du dos
      const pts = [V(0, 0, -0.122), V(0, -0.012, -0.18), V(0, -0.025, -0.24), V(0, -0.045, -0.3), V(0, -0.075, -0.35)];
      out.tail.push(at(sweep(pts, (u) => 0.012 + 0.02 * Math.sin(Math.min(1, u * 1.6 + 0.25) * Math.PI) * (1 - 0.5 * u), q), hair));
      out.tail.push(at(new THREE.TorusGeometry(0.019, 0.005, 6, 14), o.tie || '#e2463a', tr(0, -0.006, -0.152, 1.35, 0, 0)));
      out.tailRoot = V(0, 0, -0.122);
    }
    // jugulaire du casque (réaliste) : devant et derrière l'oreille, sous le menton
    if (q > 1) {
      for (const s of [-1, 1]) {
        const join = onHead(s * 0.92, -0.42, 0.05, fem, 0.006);
        for (const pts of [[onHead(s, 0.32, 0.32, fem, 0.004), onHead(s, -0.05, 0.25, fem, 0.005), join],
          [onHead(s * 0.95, 0.3, -0.38, fem, 0.004), onHead(s, -0.12, -0.25, fem, 0.005), join],
          [join, onHead(s * 0.55, -0.85, 0.35, fem, 0.005), onHead(0, -0.72, 0.72, fem, 0.005)]]) out.straps.push(at(sweep(pts, () => 0.0024, q, 8), '#26232f'));
      }
    }
    return out;
  }

  /** Bande à la surface du visage (lunettes) : angles a0, a1 autour de la tête (0 devant), hauteurs y0, y1 (direction), décollée
      de off(a). */
  function faceBand(fem, a0, a1, y0, y1, off, q) {
    const nu = q > 1 ? 24 : 14, nv = 3, pos = [], idx = [];
    for (let j = 0; j <= nv; j++) {
      const y = y0 + (y1 - y0) * j / nv, c = Math.sqrt(1 - y * y);
      for (let i = 0; i <= nu; i++) {
        const a = a0 + (a1 - a0) * i / nu, n = V(Math.sin(a) * c, y, Math.cos(a) * c), p = headPoint(n, fem).addScaledVector(n, off(a));
        pos.push(p.x, p.y, p.z);
      }
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return smoothNormals(geo);
  }

  /** Lunettes ajustées au visage : sport (verre enveloppant, monture en haut, branches jusqu'aux oreilles) ou écran (shield). */
  function glassesParts(o) {
    const q = o.q || 1, fem = !!o.fem, shield = o.type === 'shield', parts = [];
    const w = shield ? 1.4 : 1.22, lo = shield ? 0.02 : 0.07, hi = shield ? 0.4 : 0.31;
    const off = (a) => 0.011 + 0.011 * bell(a, 0, 0.32); // le verre passe devant l'arête du nez
    parts.push({ geo: faceBand(fem, -w, w, lo, hi, off, q), color: shield ? '#6b5ce0' : '#4fd0ff' });
    parts.push({ geo: faceBand(fem, -w - 0.03, w + 0.03, hi - 0.03, hi + 0.012, (a) => off(a) + 0.002, q), color: shield ? '#f4f1ea' : '#1d1a2b' });
    for (const s of [-1, 1]) {
      const pts = [onHead(Math.sin(s * w), hi - 0.04, Math.cos(w), fem, 0.012), onHead(s, hi - 0.06, -0.15, fem, 0.008), onHead(s, hi - 0.12, -0.42, fem, 0.006)];
      parts.push({ geo: sweep(pts, () => 0.0035, q, 8), color: '#1d1a2b' });
    }
    return parts;
  }

  /* ------------------------------------------------------------------ buste */
  // demi-largeur et profondeurs (unités de la sphère du buste) du bassin (y = -1) au cou (y = 1)
  const TW = { m: curve([[-1, 0.78], [-0.85, 0.82], [-0.72, 0.79], [-0.42, 0.68], [-0.1, 0.74], [0.25, 0.84], [0.52, 0.88], [0.72, 0.86], [0.88, 0.68], [1, 0.36]]),
    f: curve([[-1, 0.84], [-0.85, 0.88], [-0.72, 0.84], [-0.42, 0.62], [-0.1, 0.68], [0.25, 0.78], [0.52, 0.8], [0.72, 0.78], [0.88, 0.62], [1, 0.32]]) };
  const TF = curve([[-1, 0.6], [-0.6, 0.62], [-0.2, 0.58], [0.25, 0.7], [0.6, 0.7], [0.9, 0.5], [1, 0.4]]);
  const TB = curve([[-1, 0.62], [-0.5, 0.66], [0, 0.7], [0.5, 0.78], [0.85, 0.62], [1, 0.45]]);

  /** Point du buste dans la direction n (sphère unité) ; inflate : décollé de la surface (finitions du maillot). */
  function torsoPoint(n, fem, inflate) {
    const y = n.y, rr = Math.hypot(n.x, n.z), cx = rr > 1e-6 ? n.x / rr : 0, cz = rr > 1e-6 ? n.z / rr : 1;
    // fermé en dôme au cou ; en bas, le maillot reste large jusqu'à son ourlet, sur les hanches, et se ferme sous le cuissard
    const close = y > 0 ? Math.cbrt(Math.max(0, 1 - y * y * y)) : Math.pow(Math.max(0, 1 - y ** 6), 1 / 6);
    const W = TW[fem ? 'f' : 'm'](y) * close, D = (cz > 0 ? TF(y) : TB(y)) * close;
    let x = cx * W, z = cz * D;
    // omoplates ; pectoraux, ou poitrine (plus marquée dessous : le sillon sous-mammaire)
    if (cz < 0) z += cz * 0.07 * bell(y, 0.5, 0.2) * (bell(x, 0.42, 0.24) + bell(x, -0.42, 0.24));
    if (cz > 0) {
      for (const s of [-1, 1]) {
        const dx = x - s * (fem ? 0.4 : 0.38), dy = y - (fem ? 0.3 : 0.42);
        z += cz * (fem ? 0.42 * Math.exp(-((dx / 0.27) ** 2) - (dy / (dy < 0 ? 0.13 : 0.24)) ** 2) : 0.07 * Math.exp(-((dx / 0.3) ** 2) - (dy / 0.16) ** 2));
      }
    }
    // épaules : le deltoïde arrondit le haut du buste sur les côtés jusqu'à l'attache des bras (un peu en avant : bras vers le cintre),
    // sous la pente des trapèzes ; les bras en sortent sans boule
    const sh = bell(y, 0.66, y > 0.66 ? 0.19 : 0.15) * Math.pow(Math.abs(cx), 2.2);
    x += Math.sign(cx) * (fem ? 0.2 : 0.26) * sh;
    z += 0.05 * sh;
    if (inflate) { const k = 1 + inflate / Math.max(0.2, Math.hypot(x, z)); x *= k; z *= k; }
    // dos rond du cycliste : le milieu du buste remonte côté dos
    z -= 0.07 * (1 - y * y);
    // le bas du maillot s'arrête net à hauteur du bassin (ourlet sur le haut des fessiers) : son fond est aplati sous le cuissard
    return V(x, y < -0.6 ? -0.6 + (y + 0.6) * 0.4 : y, z);
  }

  /** Buste (sphère unité déformée, avec ses coordonnées de texture). */
  function torsoGeometry(o) {
    const q = o.q || 1, fem = !!o.fem;
    return deformed(q > 1 ? 40 : 28, q > 1 ? 30 : 20, (n) => torsoPoint(n, fem));
  }

  /** Bande à la surface du buste entre les hauteurs y0, y1 et les angles a0, a1 (0 devant, π derrière). */
  function torsoStrip(fem, y0, y1, a0, a1, inflate, q) {
    const nu = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (q > 1 ? 0.12 : 0.2))), nv = Math.max(2, Math.ceil(Math.abs(y1 - y0) / 0.06));
    const pos = [], idx = [];
    for (let j = 0; j <= nv; j++) {
      const y = y0 + (y1 - y0) * j / nv, s = Math.sqrt(Math.max(0, 1 - y * y));
      for (let i = 0; i <= nu; i++) {
        const a = a0 + (a1 - a0) * i / nu, p = torsoPoint(V(Math.sin(a) * s, y, Math.cos(a) * s), fem, inflate);
        pos.push(p.x, p.y, p.z);
      }
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return smoothNormals(geo);
  }

  /** Finitions du maillot (réaliste) : col, fermeture éclair, trois poches dans le dos. */
  function torsoTrim(o) {
    const fem = !!o.fem, q = o.q || 2, pocket = new THREE.Color(o.base).multiplyScalar(0.82).getStyle();
    // col contre le cou, liseré en haut ; fermeture éclair devant
    const parts = [{ geo: torsoStrip(fem, 0.935, 0.975, -Math.PI, Math.PI, 0.02, q), color: o.base }, { geo: torsoStrip(fem, 0.965, 0.985, -Math.PI, Math.PI, 0.024, q), color: o.accent }];
    parts.push({ geo: torsoStrip(fem, 0.34, 0.968, -0.035, 0.035, 0.024, q), color: '#26232f' });
    for (const a of [-0.62, 0, 0.62]) parts.push({ geo: torsoStrip(fem, -0.66, -0.3, Math.PI + a - 0.27, Math.PI + a + 0.27, 0.03, q), color: pocket });
    parts.push({ geo: torsoStrip(fem, -0.34, -0.29, Math.PI - 0.9, Math.PI + 0.9, 0.04, q), color: o.accent });
    return parts;
  }

  /** Bande élastique au bas du maillot, posée sur le haut des fessiers : un ourlet net sur le cuissard. */
  function torsoHem(o) {
    return [{ geo: torsoStrip(!!o.fem, -0.9, -0.6, -Math.PI, Math.PI, 0.05, o.q || 1), color: new THREE.Color(o.base).multiplyScalar(0.88).getStyle() }];
  }

  /* Bassin et fessiers (cuissard) : une seule surface, de l'entrejambe (v = 0) à la taille (v = 1), décrite debout (m ; origine à
     la hauteur des hanches, +z devant), puis basculée comme le bassin d'un cycliste assis. Les fessiers arrondissent le dos du
     bassin et s'y fondent : ni bord en haut ni boule, pleins jusqu'au sillon, étroit et plus profond vers le bas ; arrondis
     dessous (le pli fessier) ; plus pleins et hanches plus larges chez une femme. */
  // profils de l'entrejambe (v = 0) à la taille (v = 1), debout : hauteur, demi-largeur (femme, homme), dos sans les fessiers,
  // creux des fessiers (fessiers compris, femme), ventre ; le profil des fessiers est un D arrondi, le plus saillant assez bas
  const PV = (() => {
    const K = [
      [0, -0.13, 0, 0, 0, 0, 0], [0.06, -0.128, 0.06, 0.055, 0.03, 0.05, 0.035], [0.14, -0.118, 0.115, 0.105, 0.055, 0.105, 0.055],
      [0.24, -0.1, 0.15, 0.137, 0.07, 0.135, 0.068], [0.34, -0.078, 0.168, 0.152, 0.08, 0.15, 0.075], [0.44, -0.052, 0.174, 0.157, 0.085, 0.155, 0.08],
      [0.54, -0.024, 0.17, 0.155, 0.088, 0.15, 0.083], [0.64, 0.006, 0.158, 0.146, 0.086, 0.136, 0.083], [0.74, 0.04, 0.138, 0.13, 0.08, 0.112, 0.08],
      [0.84, 0.075, 0.118, 0.114, 0.074, 0.09, 0.076], [0.92, 0.11, 0.106, 0.104, 0.068, 0.074, 0.072], [1, 0.15, 0.098, 0.098, 0.062, 0.062, 0.068]
    ];
    const col = (k) => curve(K.map((r) => [r[0], r[k]]));
    return { y: col(1), wf: col(2), wm: col(3), back: col(4), cheek: col(5), front: col(6),
      cleft: curve([[0, 0.012], [0.1, 0.03], [0.3, 0.04], [0.5, 0.034], [0.68, 0.018], [0.8, 0.005], [0.9, 0]]) };
  })();
  /** Point du bassin : a, angle autour du corps (0 au milieu du dos, π/2 sur le côté +x) ; v, hauteur (0 entrejambe, 1 taille). */
  function pelvisPoint(a, v, fem) {
    const sn = Math.sin(a), c = Math.cos(a), W = (fem ? PV.wf : PV.wm)(v), B = PV.back(v);
    const x = W * sn;
    let z = c > 0 ? -B * c : -PV.front(v) * c;
    // fessiers : pleins du sillon jusqu'aux deux tiers de la largeur, puis ils rejoignent la hanche ; moins saillants chez un homme
    const t = W > 1e-6 ? Math.abs(x) / W : 0, bk = ss(-0.05, 0.55, c), G = Math.max(0, PV.cheek(v) - B) * (fem ? 1 : 0.78);
    z -= G * ss(1, 0.38, t) * (0.85 + 0.15 * bell(t, 0.45, 0.2)) * bk;
    z += PV.cleft(v) * (fem ? 1.1 : 1) * Math.exp(-((x / 0.013) ** 2)) * bk;
    if (!fem) z += 0.008 * bell(t, 0.88, 0.1) * bell(v, 0.55, 0.15) * bk; // creux sur le côté de la hanche
    return V(x, PV.y(v), z);
  }
  /** Pose du bassin d'un cycliste : il bascule avec le buste (penché sur le cintre, les fessiers pointent vers l'arrière), autour
      d'un point placé au-dessus des hanches du gabarit pour que les fessiers reposent sur la selle et que les cuisses sortent
      dessous. tdir : du bassin aux épaules ; renvoie {offset (à ajouter au point du bassin), tilt (rad, rotation autour de x)}. */
  function pelvisPose(tdir) {
    return { offset: V(0, 0.015, -0.005), tilt: 0.8 * Math.atan2(tdir.z, tdir.y) };
  }

  /** Grille (a, v) de la surface : colonnes resserrées au milieu du dos (le sillon), bas fermé, haut fermé par une calotte. */
  function pelvisSurface(fem, q) {
    const N = q > 1 ? 72 : 44, M = q > 1 ? 40 : 24, pos = [], idx = [];
    const col = (i) => { const u = -1 + 2 * i / N; return Math.PI * Math.sign(u) * Math.pow(Math.abs(u), 1.6); };
    for (let j = 0; j <= M + 1; j++) {
      for (let i = 0; i < N; i++) {
        let p;
        if (j <= M) p = pelvisPoint(col(i), j / M, fem);
        else p = V(0, PV.y(1) + 0.035, (PV.front(1) - PV.back(1)) / 2); // calotte arrondie sous le maillot
        pos.push(p.x, p.y, p.z);
      }
    }
    for (let j = 0; j <= M; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * N + i, b = j * N + (i + 1) % N;
        idx.push(a, a + N, b, b, a + N, b + N);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return smoothNormals(geo);
  }

  /** Trait peint sur la surface du bassin le long de (a(t), v(t)), demi-largeur w(t) (m) : le sillon, dessiné comme un trait d'encre. */
  function pelvisLine(fem, a, v, w, n) {
    const pos = [], idx = [], e = 1e-3, P = (aa, vv) => pelvisPoint(aa, vv, fem);
    for (let k = 0; k <= n; k++) {
      const t = k / n, c = P(a(t), v(t));
      const tg = P(a(Math.min(1, t + 0.01)), v(Math.min(1, t + 0.01))).sub(P(a(Math.max(0, t - 0.01)), v(Math.max(0, t - 0.01)))).normalize();
      const nr = P(a(t) + e, v(t)).sub(P(a(t) - e, v(t))).cross(P(a(t), v(t) + e).sub(P(a(t), v(t) - e))).normalize();
      if (nr.dot(V(c.x, 0, c.z)) < 0) nr.negate();
      const side = nr.clone().cross(tg).normalize().multiplyScalar(w(t));
      for (const sg of [-1, 1]) { const p = c.clone().addScaledVector(side, sg).addScaledVector(nr, 0.0008); pos.push(p.x, p.y, p.z); }
    }
    for (let k = 0; k < n; k++) { const i = k * 2; idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return smoothNormals(geo);
  }

  /** Bassin et fessiers : la surface (couleur du cuissard, reflet du lycra) et le trait du sillon. */
  function pelvisParts(o) {
    const fem = !!o.fem, q = o.q || 1, color = o.color || '#26232f';
    const cleft = pelvisLine(fem, () => 0, (t) => 0.14 + 0.4 * t, (t) => 0.0004 + (q > 1 ? 0.0019 : 0.0024) * (1 - ss(0.35, 1, t)), q > 1 ? 24 : 12);
    return [{ geo: pelvisSurface(fem, q), color, sheen: 1 }, { geo: cleft, color: o.ink || '#141218' }];
  }

  /* ------------------------------------------------------------------ mains et pieds */
  /** Main gantée qui tient le cintre (paume dessous, doigts enroulés) ; side : -1 à gauche ; réaliste : gants sans doigts. */
  function handParts(o) {
    const q = o.q || 1, s = o.side || 1, glove = o.glove || '#26232f', skin = o.skin || '#f1c29b', inner = -s, fem = !!o.fem;
    const k = fem ? 0.92 : 1, parts = [];
    parts.push(at(ell(q, 1, 1, 1), glove, tr(0, 0.004, -0.008, 0, 0, 0, 0.039 * k, 0.021 * k, 0.046 * k)));
    parts.push(at(ell(q, 1, 1, 1), glove, tr(0, 0.004, -0.05 * k, 0, 0, 0, 0.032 * k, 0.019 * k, 0.018 * k))); // poignet
    if (q > 1) {
      // quatre doigts enroulés autour du cintre : phalange gantée, bout des doigts nu
      for (let i = 0; i < 4; i++) {
        const x = (-0.027 + i * 0.018) * k, rr = (i === 0 || i === 3 ? 0.0075 : 0.0085) * k;
        parts.push(at(new THREE.TorusGeometry(0.017 * k, rr, 6, 8, Math.PI * 0.55), glove, tr(x, -0.012, 0.03 * k, 0, Math.PI / 2, Math.PI / 2)));
        parts.push(at(new THREE.TorusGeometry(0.017 * k, rr * 0.92, 6, 8, Math.PI * 0.6), skin, tr(x, -0.012, 0.03 * k, 0, Math.PI / 2, Math.PI * 1.05)));
      }
      parts.push(at(new THREE.BoxGeometry(0.07 * k, 0.012, 0.022), glove, tr(0, 0.018, -0.052 * k, 0, 0, 0))); // attache du gant
    } else {
      parts.push(at(ell(q, 1, 1, 1), glove, tr(0, -0.012, 0.034 * k, 0, 0, 0, 0.037 * k, 0.02 * k, 0.019 * k)));
    }
    // pouce, côté intérieur
    parts.push(along(ell(q, 1, 1, 1), q > 1 ? skin : glove, V(inner * 0.034 * k, -0.006, 0.02 * k), V(-inner * 0.25, -0.35, 1), V(0.011 * k, 0.026 * k, 0.011 * k)));
    return parts;
  }

  const SHOE_W = curve([[0, 0.03], [0.18, 0.036], [0.6, 0.047], [0.84, 0.043], [1, 0.022]]);
  const SHOE_H = curve([[0, 0.05], [0.22, 0.056], [0.45, 0.04], [0.7, 0.027], [0.9, 0.02], [1, 0.014]]);
  /** Chaussure : kind ('road', 'carbon', 'mtb', 'flat', 'aero' : couvre-chaussure) ; colors : {upper, sole, detail} ; side : -1 à gauche. */
  function shoeParts(o) {
    const q = o.q || 1, s = o.side || 1, kind = o.kind || 'road', cover = kind === 'aero', flat = kind === 'flat', parts = [];
    const BOT = -0.036, high = cover ? 0.018 : 0;
    const upper = deformed(q > 1 ? 28 : 18, q > 1 ? 16 : 10, (n) => {
      const t = (n.z + 1) / 2, rr = Math.hypot(n.x, n.y), cx = rr > 1e-6 ? n.x / rr : 0, cy = rr > 1e-6 ? n.y / rr : 0;
      const close = Math.cbrt(Math.max(0, 1 - Math.abs(n.z * n.z * n.z))), top = SHOE_H(t) + high * ss(0.5, 0.1, t);
      const x = Math.sign(cx) * Math.pow(Math.abs(cx), 0.8) * SHOE_W(t) * (flat ? 1.06 : 1) * close;
      const y = cy >= 0 ? BOT + (top - BOT) * (0.42 + 0.58 * Math.pow(cy, 0.85) * close) : BOT + (top - BOT) * 0.42 * (1 - Math.pow(-cy, 0.4) * close);
      return V(x, y, 0.005 + n.z * 0.135);
    });
    parts.push(at(upper, o.upper));
    // semelle : le contour du pied, épais pour des baskets
    const shape = new THREE.Shape(), N = 14;
    for (let i = 0; i <= N; i++) { const t = i / N, z = -0.128 + t * 0.268, w = SHOE_W(t) * 1.04 + 0.002; i ? shape.lineTo(w, z) : shape.moveTo(w, z); }
    for (let i = N; i >= 0; i--) { const t = i / N; shape.lineTo(-(SHOE_W(t) * 1.04 + 0.002), -0.128 + t * 0.268); }
    const thick = flat ? 0.02 : 0.009;
    const sole = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, curveSegments: 4 });
    sole.rotateX(Math.PI / 2); // forme dans le plan x-z, épaisseur vers le bas
    parts.push(at(sole, o.sole, tr(0, BOT + 0.004, 0, 0, 0, 0)));
    if (q > 1 && !cover) {
      if (flat) {
        for (const z of [0.0, 0.025, 0.05, 0.075]) parts.push(at(new THREE.BoxGeometry(0.05, 0.004, 0.006), o.detail, tr(0, 0.044 - z * 0.25, z - 0.005, -0.25, 0, 0))); // lacets
      } else {
        // molettes de serrage et câble, cale sous la semelle (route), talonnette
        for (const [z, y, r] of [[-0.035, 0.05, 0.011], [0.035, 0.035, 0.009]]) parts.push(along(new THREE.CylinderGeometry(r, r, 0.009, 14), o.detail, V(s * 0.03, y, z), V(s * 0.8, 0.6, 0)));
        parts.push(at(new THREE.BoxGeometry(0.062, 0.004, 0.008), o.detail, tr(0, 0.046, -0.002, -0.32, 0, 0)));
        if (kind !== 'mtb') parts.push(at(new THREE.BoxGeometry(0.05, 0.008, 0.05), '#e2463a', tr(0, BOT - thick - 0.002, 0.045, 0, 0, 0)));
        parts.push(at(new THREE.BoxGeometry(0.03, 0.012, 0.014), o.sole, tr(0, BOT - 0.002, -0.124, 0, 0, 0)));
      }
    }
    if (q > 1 && cover) parts.push(at(new THREE.BoxGeometry(0.004, 0.06, 0.004), '#3a3944', tr(0, 0.04, -0.131, 0.2, 0, 0))); // fermeture du couvre-chaussure
    return parts;
  }

  B3D.anatomy = { curve, smoothNormals, deformed, rings, limb, limbParts, LENGTHS, headPoint, headParts, glassesParts, torsoPoint, torsoGeometry, torsoTrim, torsoHem, pelvisPoint, pelvisParts, pelvisPose, handParts, shoeParts };
})(typeof window !== 'undefined' ? window : globalThis);
