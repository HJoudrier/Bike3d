/* author : Hugo Joudrier-Faure */
/* PaceYourRide — présence d'un cycliste dans la course : trois façons d'être au départ, dans le même monde.
 *   - avatar   : le cycliste numérique, avec la physiologie de l'utilisateur ; on règle sa puissance (barre, tactiques) ;
 *   - trainer  : sur un home-trainer (ou avec un capteur de puissance) : les watts réels font avancer le cycliste numérique ;
 *                le home-trainer reçoit la pente, le vent et l'abri du peloton (FTMS) pour que l'effort se sente dans les jambes ;
 *   - road     : sur la vraie route : la position vient du GPS (projetée sur le tracé), la puissance du capteur s'il y en a un.
 * Tous se retrouvent dans une course en direct (live.js) : chacun voit les autres sur la carte, le profil et la vue 3D.
 * Ce module ne touche ni au DOM ni aux capteurs : l'interface lui passe les mesures (puissance, positions GPS). */
(function (PYR) {
  'use strict';

  const U = PYR.util;
  const KINDS = ['avatar', 'trainer', 'road'];
  const CODE = { avatar: 'a', trainer: 't', road: 'r' };          // dans les messages de la course en direct
  const LABEL = { avatar: 'Avatar', trainer: 'Home-trainer', road: 'Sur la route' };
  const ICON = { avatar: '🎮', trainer: '🏠', road: '🚴' };
  const STALE_MS = 3000;     // une mesure de puissance plus vieille compte pour 0 W (on ne pédale plus, ou le capteur est perdu)
  const AVG_MS = 1500;       // puissance d'une seconde de course : moyenne des mesures des 1,5 dernières secondes
  const GRADE_AHEAD = 20;    // m : pente lue un peu devant (le home-trainer réagit avec retard)
  const GRADE_SPAN = 40;     // m : sur cette longueur (lissage)

  const normKind = (x) => (KINDS.includes(x) ? x : 'avatar');
  const fromCode = (c) => { for (const k of KINDS) if (CODE[k] === c) return k; return 'avatar'; };

  /**
   * Puissance mesurée : push(w, ts) à chaque mesure du capteur ; at(now) : moyenne des mesures récentes (W), 0 si la dernière
   * est trop vieille ; null tant qu'aucune mesure n'est arrivée.
   */
  function createPowerFeed() {
    const buf = [];
    return {
      get count() { return buf.length; },
      push(w, ts) {
        if (!Number.isFinite(w) || w < 0 || w > 2500) return;
        buf.push({ w, ts });
        while (buf.length > 64 || (buf.length && ts - buf[0].ts > 10000)) buf.shift();
      },
      at(now) {
        if (!buf.length) return null;
        if (now - buf[buf.length - 1].ts > STALE_MS) return 0;
        let s = 0, n = 0;
        for (let i = buf.length - 1; i >= 0 && now - buf[i].ts <= AVG_MS; i--) { s += buf[i].w; n++; }
        return n ? s / n : buf[buf.length - 1].w;
      },
      reset() { buf.length = 0; },
    };
  }

  /**
   * Position sur la vraie route : fix({lat, lng, acc, speed, ts}) à chaque point GPS (projeté sur le tracé par ride.createTracker,
   * qui sait retrouver le tracé après l'avoir quitté) ; at(now) donne {s, v, ok} pour la seconde de course : la dernière position
   * projetée, prolongée à la vitesse du moment jusqu'à 3 s (entre deux points GPS), jamais en arrière.
   */
  function createRoadFeed(course) {
    const tracker = PYR.ride.createTracker(course);
    let last = null, v = 0, sOut = 0;
    return {
      get last() { return last; },
      fix(f) {
        if (!f || !Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return null;
        const dt = last ? Math.max(0.2, (f.ts - last.ts) / 1000) : 1;
        const r = tracker.update(f.lat, f.lng, f.acc, dt, v);
        if (!r.ok) { if (last) last.lost = r.lost; return r; }
        const vGps = Number.isFinite(f.speed) && f.speed >= 0 ? f.speed : NaN;
        const vPos = last && !r.jumped ? Math.max(0, (r.s - last.s) / dt) : 0;
        const vNew = Number.isFinite(vGps) ? vGps : vPos;
        v = last ? v + (vNew - v) * 0.6 : vNew;
        last = { s: r.s, d: r.d, ts: f.ts, lost: 0 };
        return r;
      },
      at(now) {
        if (!last) return { s: NaN, v: 0, ok: false };
        const age = Math.min(3, Math.max(0, (now - last.ts) / 1000));
        const s = Math.min(course.length, last.s + v * age);
        sOut = Math.max(sOut, s);
        return { s: sOut, v: age >= 3 ? 0 : v, ok: !last.lost };
      },
      reset() { tracker.reset(); last = null; v = 0; sOut = 0; },
    };
  }

  /**
   * Charge à imposer à un home-trainer (FTMS, « Indoor Bike Simulation ») à la distance s : pente moyenne un peu devant (%),
   * vent de face au cycliste (m/s, > 0 de face), coefficient de roulement et cw = ½·ρ·CdA (kg/m) réduit par l'abri du peloton
   * (cdaK : part de la traînée qui reste, 1 = seul au vent). cond : conditions de la seconde (sim.conditions : wh, rho, crr).
   */
  function trainerLoad(course, setup, s, cond, cdaK) {
    const step = course.step, n = course.n, ele = course.ele;
    const eleAt = (x) => {
      const f = U.clamp(x / step, 0, n), i = Math.min(n - 1, Math.floor(f));
      return ele[i] + (ele[i + 1] - ele[i]) * (f - i);
    };
    const a = U.clamp(s + GRADE_AHEAD - GRADE_SPAN / 2, 0, course.length), b = U.clamp(a + GRADE_SPAN, 0, course.length);
    const grade = b > a ? (eleAt(b) - eleAt(a)) / (b - a) * 100 : 0;
    const c = cond || {};
    const rho = c.rho > 0 ? c.rho : 1.2;
    const k = cdaK > 0 ? Math.min(1, cdaK) : 1;
    return {
      grade: U.clamp(grade, -20, 20),
      wind: U.clamp(Number.isFinite(c.wh) ? c.wh : 0, -30, 30),
      crr: U.clamp(c.crr > 0 ? c.crr : setup.crr || 0.004, 0, 0.0254),
      cw: U.clamp(0.5 * rho * (setup.cda || 0.3) * k, 0, 2.54),
    };
  }

  PYR.presence = { KINDS, CODE, LABEL, ICON, STALE_MS, normKind, fromCode, createPowerFeed, createRoadFeed, trainerLoad };
})(globalThis.PYR = globalThis.PYR || {});
