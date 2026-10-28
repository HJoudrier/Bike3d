/* author : Hugo Joudrier-Faure */
/* PaceYourRide — changer de rang en penchant le téléphone (peloton en 2D, mode jeu). Sans DOM (testable) : le navigateur envoie les
 * angles du capteur d'orientation (alpha, beta, gamma, en degrés) et l'angle de l'écran ; on en tire l'inclinaison à droite ou à
 * gauche dans le repère de l'écran, et un contrôleur la transforme en décalages d'un rang (← : −1, → : +1), comme les flèches.
 *
 * Inclinaison : direction du « haut » (opposée à la pesanteur) dans le repère de l'appareil, u = (−cos β sin γ, sin β, cos β cos γ),
 * projetée sur l'écran (tourné de θ par rapport à sa position naturelle) ; roll = atan2(−u_x,écran ; √(u_y,écran² + u_z²)) :
 * > 0 quand le bord droit de l'écran descend, qu'on tienne le téléphone en portrait ou en paysage, penché sur le côté ou tourné
 * comme un volant (alpha n'intervient pas : la pesanteur ne dépend pas du cap). */
(function (PYR) {
  'use strict';

  const DEG = Math.PI / 180;
  const DEAD = 5;         // ° : en deçà de la neutralité ± DEAD, on est « droit » (la neutralité suit alors la posture, très lentement)
  const THRESH = 12;      // ° : au-delà, un rang de plus ; on ne se réarme qu'en revenant sous REARM
  const REARM = 7;
  const FAST = 25;        // ° : très penché, les rangs s'enchaînent plus vite
  const REPEAT = 750, REPEAT_FAST = 400; // ms entre deux rangs quand on garde le téléphone penché
  const SMOOTH = 0.4;     // lissage des mesures (0 : figé, 1 : brut)
  const DRIFT = 0.002;    // vitesse à laquelle la neutralité rejoint la posture quand on est droit (par mesure)

  /** Inclinaison (°, > 0 : bord droit de l'écran vers le bas) d'après alpha, beta, gamma (°) et l'angle de l'écran (°, 0 en portrait). */
  function rollFrom(alpha, beta, gamma, angle) {
    const b = beta * DEG, g = gamma * DEG, th = (angle || 0) * DEG;
    const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b), uz = Math.cos(b) * Math.cos(g);
    const sx = ux * Math.cos(th) - uy * Math.sin(th), sy = ux * Math.sin(th) + uy * Math.cos(th);
    return Math.atan2(-sx, Math.hypot(sy, uz)) / DEG;
  }

  /** Contrôleur : neutralité (calibrée à la première mesure ou à la demande), lissage, déclenchement des rangs. */
  function create() {
    return { neutral: null, smooth: null, active: false, dir: 0, nextAt: 0 };
  }

  /** Reprend la posture actuelle comme neutralité (à l'activation, à la reprise de la course). */
  function recalibrate(c) {
    c.neutral = c.smooth;
    c.active = false; c.dir = 0;
  }

  /** Écart (°) entre l'inclinaison lissée et la neutralité ; 0 sans mesure. */
  function offset(c) {
    return c.neutral === null || c.smooth === null ? 0 : c.smooth - c.neutral;
  }

  /**
   * Nouvelle mesure d'inclinaison roll (°) à l'instant now (ms). Renvoie −1 (un rang à gauche), +1 (un rang à droite) ou 0.
   * Le premier dépassement du seuil décale tout de suite ; gardé penché, le téléphone décale encore à intervalle régulier.
   */
  function feed(c, roll, now) {
    if (!Number.isFinite(roll)) return 0;
    c.smooth = c.smooth === null ? roll : c.smooth + SMOOTH * (roll - c.smooth);
    if (c.neutral === null) { c.neutral = c.smooth; return 0; }
    const d = c.smooth - c.neutral, a = Math.abs(d), sg = d < 0 ? -1 : 1;
    if (a < DEAD) c.neutral += DRIFT * d;
    if (a < REARM) { c.active = false; c.dir = 0; return 0; }
    if (a < THRESH) return 0;
    if (c.active && sg === c.dir && now < c.nextAt) return 0;
    c.active = true; c.dir = sg;
    c.nextAt = now + (a >= FAST ? REPEAT_FAST : REPEAT);
    return sg;
  }

  PYR.tilt = { DEAD, THRESH, REARM, FAST, rollFrom, create, recalibrate, offset, feed };
})(globalThis.PYR = globalThis.PYR || {});
