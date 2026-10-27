/* Bike3D — parcours de démonstration générés (pour tester sans fichier GPX). */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};

  // Trace une route "à la tortue" : liste d'étapes {len, turn (deg), grade}.
  function turtle(steps, origin) {
    const pts = [];
    let x = 0, z = 0, ele = origin.ele, head = origin.heading * Math.PI / 180;
    pts.push({ x, z, ele });
    const ds = 10;
    for (const st of steps) {
      const n = Math.max(1, Math.round(st.len / ds));
      const dTurn = ((st.turn || 0) * Math.PI / 180) / n;
      for (let k = 0; k < n; k++) {
        head += dTurn;
        x += Math.sin(head) * ds;
        z -= Math.cos(head) * ds; // cap 0 = nord
        ele += (st.grade || 0) * ds;
        pts.push({ x, z, ele });
      }
    }
    // Conversion en lat/lon autour de l'origine
    const R = 6371000, DEG = Math.PI / 180;
    const kx = Math.cos(origin.lat * DEG) * R * DEG, kz = R * DEG;
    return pts.map((p) => ({ lat: origin.lat - p.z / kz, lon: origin.lon + p.x / kx, ele: p.ele }));
  }

  // Petit col alpin avec lacets.
  function colDesMarmottes() {
    const s = [];
    // Fond de vallée
    s.push({ len: 600, turn: 10, grade: 0.012 });
    s.push({ len: 500, turn: -25, grade: 0.015 });
    s.push({ len: 400, turn: 15, grade: 0.02 });
    // Début de la montée
    s.push({ len: 450, turn: -20, grade: 0.055 });
    s.push({ len: 350, turn: 30, grade: 0.07 });
    // Lacets
    const lacets = [
      { len: 380, turn: 10 }, { len: 330, turn: -8 }, { len: 300, turn: 6 },
      { len: 280, turn: -5 }, { len: 320, turn: 8 }, { len: 260, turn: -6 }
    ];
    let dir = 1;
    for (const l of lacets) {
      s.push({ len: l.len, turn: l.turn, grade: 0.088 });
      s.push({ len: 50, turn: 180 * dir, grade: 0.065 });
      dir = -dir;
    }
    // Fin de montée en balcon
    s.push({ len: 500, turn: 35, grade: 0.07 });
    s.push({ len: 300, turn: -20, grade: 0.085 });
    s.push({ len: 250, turn: 15, grade: 0.05 });
    // Sommet
    s.push({ len: 200, turn: 0, grade: 0.0 });
    // Descente
    s.push({ len: 400, turn: -40, grade: -0.06 });
    s.push({ len: 350, turn: 60, grade: -0.07 });
    s.push({ len: 400, turn: -70, grade: -0.065 });
    s.push({ len: 450, turn: 30, grade: -0.05 });
    s.push({ len: 400, turn: -15, grade: -0.03 });
    return turtle(s, { lat: 45.06, lon: 6.42, ele: 1320, heading: 20 });
  }

  // Balade vallonnée en campagne.
  function balade() {
    const s = [];
    const segs = [
      [700, 15, 0.01], [600, -30, 0.025], [500, 20, -0.02], [800, 45, 0.0],
      [600, -20, 0.035], [400, 10, 0.045], [700, 60, -0.03], [500, -15, -0.01],
      [900, 40, 0.015], [600, -35, -0.025], [700, 25, 0.02], [500, 50, -0.02],
      [800, -10, 0.0]
    ];
    for (const g of segs) s.push({ len: g[0], turn: g[1], grade: g[2] });
    return turtle(s, { lat: 47.32, lon: 4.85, ele: 210, heading: 80 });
  }

  const list = [
    { id: 'col', name: 'Col des Marmottes (démo)', make: colDesMarmottes, desc: 'Vallée, 6 lacets et descente — environ 8 km' },
    { id: 'campagne', name: 'Balade en campagne (démo)', make: balade, desc: 'Champs, collines et lacs — environ 8 km' }
  ];

  B3D.demoRoutes = {
    list,
    get(id) {
      const d = list.find((r) => r.id === id);
      return { name: d.name, points: d.make() };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
