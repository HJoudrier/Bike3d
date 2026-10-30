/* author : Hugo Joudrier-Faure */
/* PaceYourRide — guidage sur la carte de la sortie : virages du parcours (d'après la géométrie du tracé, le routage ne fournit pas les
 * intersections), prochain virage, et niveau de zoom de la caméra (plus près à l'approche d'un virage). Sans DOM (testable). */
(function (PYR) {
  'use strict';

  const R = 6371008.8;
  const DEG = Math.PI / 180;
  const wrap = (a) => { a %= 360; return a > 180 ? a - 360 : a < -180 ? a + 360 : a; };

  /**
   * Virages d'un profil { n, step, lat, lng } : liste triée { s (m), angle (° : + à droite, − à gauche), kind }.
   * Un virage est un changement de cap d'au moins `minAngle` (30° par défaut) entre les 40 m qui précèdent et les 40 m qui suivent
   * (une courbe de rayon jusqu'à ~75 m compte, une courbe plus douce non) ; les points voisins d'une même courbe sont regroupés en un seul
   * virage (l'angle est alors celui de la courbe entière, regroupement jusqu'à `merge` m (60) de trou). kind : 'slight' (jusqu'à 75°), 'turn' (jusqu'à 135°), 'sharp' (au-delà : épingle, demi-tour).
   */
  function turns(p, opts) {
    const o = Object.assign({ minAngle: 30, window: 40, merge: 60 }, opts);
    const n = p.n, step = p.step;
    const out = [];
    const m = Math.max(1, Math.round(o.window / step));
    if (!p || n < 2 * m + 2) return out;
    const lat0 = p.lat[0] * DEG, cos0 = Math.cos(lat0);
    const x = new Float64Array(n), y = new Float64Array(n);
    for (let i = 0; i < n; i++) { x[i] = (p.lng[i] - p.lng[0]) * DEG * R * cos0; y[i] = (p.lat[i] - p.lat[0]) * DEG * R; }
    const bearing = (a, b) => {
      const dx = x[b] - x[a], dy = y[b] - y[a];
      return dx * dx + dy * dy < 0.25 ? NaN : Math.atan2(dx, dy) / DEG;   // 0 = nord, sens horaire
    };
    const change = new Float64Array(n);
    for (let i = m; i < n - m; i++) {
      const d = wrap(bearing(i, i + m) - bearing(i - m, i));
      change[i] = Number.isFinite(d) ? d : 0;
    }
    const maxGap = Math.max(1, Math.round(o.merge / step / 2));
    let i = m;
    while (i < n - m) {
      if (Math.abs(change[i]) < o.minAngle) { i++; continue; }
      // regroupement des points consécutifs (à maxGap près) qui tournent dans le même sens
      const sign = Math.sign(change[i]);
      let j = i, last = i, peak = i;
      while (j < n - m && j - last <= maxGap) {
        if (Math.abs(change[j]) >= o.minAngle * 0.6 && Math.sign(change[j]) === sign) {
          last = j;
          if (Math.abs(change[j]) > Math.abs(change[peak])) peak = j;
        }
        j++;
      }
      const a0 = Math.max(m, i), a1 = Math.min(n - 1 - m, last);
      const total = wrap(bearing(a1, a1 + m) - bearing(a0 - m, a0));
      const angle = Number.isFinite(total) ? total : change[peak];
      if (Math.abs(angle) >= o.minAngle) {
        const ab = Math.abs(angle);
        out.push({ s: peak * step, angle, kind: ab <= 75 ? 'slight' : ab <= 135 ? 'turn' : 'sharp' });
      }
      i = last + m;                                   // la suite commence après la fin de la courbe
    }
    return out;
  }

  /** Premier virage à au plus `behind` m derrière la position s (par défaut 15 m : celui qu'on est en train de passer). null s'il n'y en a plus. */
  function nextTurn(list, s, behind) {
    const lim = s - (behind === undefined ? 15 : behind);
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].s < lim) lo = mid + 1; else hi = mid; }
    return lo < list.length ? list[lo] : null;
  }

  /**
   * Niveau de zoom de la carte. dist : distance (m) au prochain virage (Infinity sans virage), v : vitesse (m/s).
   * Large sur la route libre ; plus près quand le virage est à moins de ~12 s ; au plus près juste avant et pendant le virage.
   * lo, mid, hi : niveaux de zoom (16, 17, 18 par défaut).
   */
  function zoomFor(dist, v, z) {
    const Z = Object.assign({ lo: 16, mid: 17, hi: 18 }, z);
    const sp = Math.max(3, Number(v) || 0);
    if (!(dist < Infinity)) return Z.lo;
    if (dist <= 40 + 6 * sp) return Z.hi;
    if (dist <= 150 + 18 * sp) return Z.mid;
    return Z.lo;
  }

  /** Cap (° , 0 = nord, sens horaire) du profil à la distance s. */
  function bearingAt(p, s) {
    const i = Math.min(p.n - 2, Math.max(0, Math.floor(s / p.step)));
    const dx = (p.lng[i + 1] - p.lng[i]) * Math.cos(p.lat[i] * DEG), dy = p.lat[i + 1] - p.lat[i];
    return Math.atan2(dx, dy) / DEG;
  }

  const M_DEG = 6371008.8 * DEG; // m par degré de latitude

  /** Point [lat, lng] du profil à la distance s (m), prolongé en ligne droite avant le départ et après l'arrivée. */
  function pointAt(p, s) {
    const x = s / p.step;
    const i = Math.min(p.n - 2, Math.max(0, Math.floor(x))), f = x - i; // f < 0 avant le départ, > 1 après l'arrivée
    return [p.lat[i] + (p.lat[i + 1] - p.lat[i]) * f, p.lng[i] + (p.lng[i + 1] - p.lng[i]) * f];
  }

  /** Cap lissé (radians, 0 = nord, sens horaire) : direction de la corde entre s − 8 m et s + 8 m (sans à-coup aux sommets du tracé). */
  function headingAt(p, s) {
    const L = p.step * (p.n - 1);
    const a = pointAt(p, Math.max(0, Math.min(L - 1, s) - 8)), b = pointAt(p, Math.min(L, Math.max(1, s) + 8));
    return Math.atan2((b[1] - a[1]) * Math.cos(a[0] * DEG), b[0] - a[0]);
  }

  /**
   * Position [lat, lng] à la distance s, décalée de y m perpendiculairement à la route (+ = à droite dans le sens de la marche) :
   * place d'un coureur du peloton en deux dimensions. Avant le départ (grille), la route est prolongée en ligne droite.
   */
  function offsetAt(p, s, y) {
    const q = pointAt(p, s);
    if (!y) return q;
    const h = headingAt(p, s);
    return [q[0] - (Math.sin(h) * y) / M_DEG, q[1] + (Math.cos(h) * y) / (M_DEG * Math.cos(q[0] * DEG))];
  }

  /** Flèche et texte d'un virage. */
  function describe(t) {
    const right = t.angle > 0;
    if (t.kind === 'sharp') return { arrow: right ? '↷' : '↶', text: right ? 'demi-tour à droite' : 'demi-tour à gauche' };
    if (t.kind === 'slight') return { arrow: right ? '↗' : '↖', text: right ? 'légèrement à droite' : 'légèrement à gauche' };
    return { arrow: right ? '↱' : '↰', text: right ? 'à droite' : 'à gauche' };
  }

  PYR.nav = { turns, nextTurn, zoomFor, bearingAt, headingAt, offsetAt, describe };
})(globalThis.PYR = globalThis.PYR || {});
