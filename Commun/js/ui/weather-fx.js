/* author : Hugo Joudrier-Faure */
/* PaceYourRide — animations météo du mode jeu, en superposition sur la carte (le nord est en haut) :
 *   - pluie : des gouttes qui tombent, penchées par le vent, plus nombreuses sous une pluie plus forte, et un voile
 *     sombre léger sous une grosse averse ;
 *   - vent : pas de particules (elles rendent mal quand la caméra file, a fortiori à x50) mais des manches à air
 *     posées le long du parcours (cf. map.js, `setWindsocks`) ; `sockParams` en donne l'aspect pour une vitesse de vent.
 * Les paramètres (`sockParams`, `rainParams`) sont des fonctions pures, testées ; la pluie est dessinée sur un canvas
 * pleine carte, sans interaction. Les animations s'arrêtent hors de l'écran de course, et ne se lancent pas si le système
 * demande de limiter les animations. */
(function (PYR) {
  'use strict';

  const MAX_RAIN = 560;                // nombre maximal de gouttes à l'écran
  const SOCK_FULL = 45;                // km/h : vitesse à laquelle une manche à air est tendue à l'horizontale

  /** Direction à l'écran (x vers la droite, y vers le bas, nord en haut) vers où souffle un vent venant de wd (°). */
  function blowing(wd) {
    const to = (((wd % 360) + 360) % 360 + 180) * Math.PI / 180;
    return { dx: Math.sin(to), dy: -Math.cos(to) };
  }

  /**
   * Aspect d'une manche à air pour un vent de kmh (km/h) :
   * k : longueur affichée, de 0,22 (qui pend) à 1 (tendue) ; flap : période du battement (s) ; amp : amplitude du battement (°).
   * Le battement ne se fige jamais tout à fait : même un vent faible agite la manche.
   */
  function sockParams(kmh) {
    const v = Math.max(0, Number(kmh) || 0);
    return {
      k: 0.22 + 0.78 * Math.min(1, v / SOCK_FULL),
      flap: Math.min(1.7, Math.max(0.35, 1.7 - v / 28)),
      amp: 3 + Math.min(14, v / 3),
    };
  }

  /**
   * Gouttes de pluie : rain (mm/h), ws (m/s), wd (° d'où vient le vent). null sous 0,2 mm/h (route humide, rien de visible).
   * density : gouttes par 10 000 px² ; vx, vy : px/s (le vent les penche horizontalement) ; len : px ; tint : opacité du voile.
   */
  function rainParams(rain, ws, wd) {
    if (!(rain >= 0.2)) return null;
    const intensity = Math.min(1, rain / 6);
    const dir = blowing(Number(wd) || 0);
    const slant = Math.min(1, Math.max(0, Number(ws) || 0) * 3.6 / 50) * 0.8;
    return {
      intensity,
      density: 6 + 28 * intensity,
      vx: dir.dx * slant * 360,
      vy: 520 + 380 * intensity,
      len: 8 + 12 * intensity,
      tint: 0.1 * intensity,
    };
  }

  /* ---------- dessin ---------- */

  const S = {
    host: null, canvas: null, ctx: null, ro: null,
    w: 0, h: 0, dpr: 1,
    enabled: true, running: false, raf: 0, last: 0,
    target: null,                                          // dernier échantillon météo reçu {ws, wd, gust, rain}
    cur: { rain: 0, rdens: 0, rvx: 0, rvy: 600, rlen: 10, tint: 0 },
    rain: [],
  };

  const reduced = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    if (!S.host) return;
    const r = S.host.getBoundingClientRect();
    S.dpr = window.devicePixelRatio || 1;
    S.w = Math.max(1, r.width); S.h = Math.max(1, r.height);
    S.canvas.width = Math.round(S.w * S.dpr); S.canvas.height = Math.round(S.h * S.dpr);
  }

  /** Crée le canevas dans l'élément hôte (la carte). */
  function attach(host) {
    if (S.canvas || !host) return;
    S.host = host;
    S.canvas = document.createElement('canvas');
    S.canvas.className = 'wx-fx';
    S.canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(S.canvas);
    S.ctx = S.canvas.getContext('2d');
    resize();
    if (typeof ResizeObserver !== 'undefined') { S.ro = new ResizeObserver(() => resize()); S.ro.observe(host); }
  }

  const spawn = (list, n, makeOne) => { while (list.length < n) list.push(makeOne()); if (list.length > n) list.length = n; };
  const mk = () => ({ x: Math.random() * S.w, y: Math.random() * S.h, v: 0.7 + 0.6 * Math.random(), a: 0.3 + 0.5 * Math.random() });

  /** Rapproche les valeurs affichées des valeurs visées (transitions douces quand le temps change). */
  function ease(dt) {
    const T = S.target, C = S.cur, k = Math.min(1, dt * 1.5);
    const rp = T ? rainParams(T.rain, T.ws, T.wd) : null;
    const lerp = (a, b) => a + (b - a) * k;
    C.rdens = lerp(C.rdens, rp ? rp.density : 0);
    C.tint = lerp(C.tint, rp ? rp.tint : 0);
    if (rp) { C.rvx = lerp(C.rvx, rp.vx); C.rvy = lerp(C.rvy, rp.vy); C.rlen = lerp(C.rlen, rp.len); }
  }

  function frame(now) {
    S.raf = 0;
    if (!S.running) return;
    const dt = Math.max(0, Math.min(0.05, (now - S.last) / 1000 || 0.016));   // jamais négatif : l'horodatage de l'image peut précéder `S.last` (performance.now() de la mise en route)
    S.last = now;
    const ctx = S.ctx, C = S.cur;
    ease(dt);
    const area = (S.w * S.h) / 10000;
    spawn(S.rain, Math.min(MAX_RAIN, Math.round(C.rdens * area)), mk);
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.clearRect(0, 0, S.w, S.h);
    if (!S.enabled) { S.raf = 0; return; }
    if (C.tint > 0.004) { ctx.fillStyle = `rgba(30, 50, 80, ${C.tint.toFixed(3)})`; ctx.fillRect(0, 0, S.w, S.h); }
    ctx.lineCap = 'round';
    // pluie : gouttes qui tombent, penchées par le vent
    if (S.rain.length) {
      const vn = Math.hypot(C.rvx, C.rvy) || 1, ux = C.rvx / vn, uy = C.rvy / vn;
      ctx.lineWidth = 1.3;
      for (const p of S.rain) {
        p.x += C.rvx * p.v * dt; p.y += C.rvy * p.v * dt;
        if (p.y > S.h + 20) { p.y -= S.h + 40; p.x = Math.random() * S.w; }
        if (p.x < -40) p.x += S.w + 80; else if (p.x > S.w + 40) p.x -= S.w + 80;
        const l = C.rlen * (0.7 + 0.3 * p.v);
        ctx.strokeStyle = `rgba(40, 100, 190, ${(0.25 + 0.45 * p.a).toFixed(2)})`;
        ctx.beginPath(); ctx.moveTo(p.x - ux * l, p.y - uy * l); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
    }
    // plus rien à montrer (pas de météo, ou sec) : on arrête la boucle jusqu'à la prochaine mise à jour
    const T = S.target, dry = !T || !(T.rain >= 0.2);
    const idle = dry && C.rdens < 0.05 && C.tint < 0.004 && !S.rain.length;
    if (idle) { ctx.clearRect(0, 0, S.w, S.h); S.running = false; return; }
    S.raf = requestAnimationFrame(frame);
  }

  function loop() {
    if (S.raf || !S.running || !S.canvas) return;
    S.last = performance.now();
    S.raf = requestAnimationFrame(frame);
  }

  /** Nouvelle météo à la position du cycliste : {ws (m/s), wd (°), gust (m/s), rain (mm/h)}, ou null (pas de météo). */
  function update(sample) {
    S.target = sample ? { ws: sample.ws || 0, wd: sample.wd || 0, gust: sample.gust || 0, rain: sample.rain || 0 } : null;
    if (S.running && !S.raf) loop();
    else if (!S.running && S.target && S.enabled && S.canvas && !reduced()) { S.running = true; loop(); }
  }

  function setEnabled(on) {
    S.enabled = !!on;
    if (!S.enabled && S.ctx) S.ctx.clearRect(0, 0, S.w, S.h);
    if (S.host) S.host.classList.toggle('no-fx', !S.enabled); // fige aussi le battement des manches à air
    if (S.enabled && S.target && !S.running && S.canvas && !reduced()) { S.running = true; loop(); }
  }

  /** Lance les animations (à l'ouverture de l'écran de course). */
  function start() {
    if (!S.canvas || reduced()) return;
    resize();
    S.running = true;
    loop();
  }

  /** Arrête et efface (hors de l'écran de course). */
  function stop() {
    S.running = false;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    if (S.ctx) S.ctx.clearRect(0, 0, S.w, S.h);
    S.rain.length = 0;
    Object.assign(S.cur, { rdens: 0, tint: 0 });
  }

  PYR.weatherFx = { MAX_RAIN, SOCK_FULL, sockParams, rainParams, blowing, attach, update, setEnabled, start, stop };
})(globalThis.PYR = globalThis.PYR || {});
