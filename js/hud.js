/* Bike3D — profil altimétrique, mini-carte et affichage tête haute. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { gradeColor, formatTime, clamp } = B3D.util;

  // Dessine le profil d'altitude (coloré par pente) dans un canvas. Renvoie une fonction de projection.
  function drawProfile(canvas, route, opts = {}) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const padL = opts.padL !== undefined ? opts.padL : 40, padR = 10, padT = 14, padB = opts.padB !== undefined ? opts.padB : 20;
    ctx.clearRect(0, 0, W, H);
    const st = route.stats;
    const span = Math.max(30, st.maxEle - st.minEle);
    const e0 = st.minEle - span * 0.12, e1 = st.maxEle + span * 0.12;
    const X = (d) => padL + (d / route.length) * (W - padL - padR);
    const Y = (e) => H - padB - ((e - e0) / (e1 - e0)) * (H - padT - padB);
    const tmp = {};
    const step = Math.max(10, route.length / (W * 1.5));
    // remplissage par tronçons colorés selon la pente
    const nSeg = Math.max(1, Math.ceil(route.length / Math.max(50, route.length / 120)));
    const seg = route.length / nSeg;
    for (let k = 0; k < nSeg; k++) {
      const d = k * seg;
      const d1 = k === nSeg - 1 ? route.length : d + seg;
      const a = route.sample(route.sStart + d, tmp).y;
      const b = route.sample(route.sStart + d1, tmp).y;
      const g = (b - a) / (d1 - d);
      ctx.fillStyle = gradeColor(g);
      ctx.beginPath();
      ctx.moveTo(X(d) - 0.6, H - padB);
      ctx.lineTo(X(d) - 0.6, Y(a));
      const nq = Math.max(1, Math.ceil((d1 - d) / step));
      for (let j = 0; j <= nq; j++) { const q = d + (d1 - d) * j / nq; ctx.lineTo(X(q), Y(route.sample(route.sStart + q, tmp).y)); }
      ctx.lineTo(X(d1) + 0.6, Y(b));
      ctx.lineTo(X(d1) + 0.6, H - padB);
      ctx.closePath();
      ctx.fill();
    }
    // contour
    ctx.strokeStyle = '#1d1a2b';
    ctx.lineWidth = opts.lineWidth || 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let d = 0; d <= route.length; d += step) {
      const y = Y(route.sample(route.sStart + d, tmp).y);
      if (d === 0) ctx.moveTo(X(d), y); else ctx.lineTo(X(d), y);
    }
    ctx.stroke();
    if (opts.axes !== false) {
      ctx.fillStyle = 'rgba(29,26,43,0.75)';
      ctx.font = '600 11px Fredoka, Arial, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(st.maxEle) + ' m', padL - 4, Y(st.maxEle) + 4);
      ctx.fillText(Math.round(st.minEle) + ' m', padL - 4, Y(st.minEle) + 4);
      ctx.textAlign = 'center';
      const kmStep = route.length > 40000 ? 10 : route.length > 15000 ? 5 : route.length > 4000 ? 1 : 0.5;
      for (let k = kmStep; k * 1000 < route.length; k += kmStep) {
        ctx.fillText(k + '', X(k * 1000), H - 5);
        ctx.fillRect(X(k * 1000) - 0.5, H - padB, 1, 4);
      }
    }
    return { X, Y };
  }

  // Repères de course sur le profil : sprints (vert), sommets du GPM (pois rouges), ravitaillement (orange).
  function drawRaceMarkers(ctx, route, L, proj) {
    const r = L.race;
    if (!r) return;
    const tmp = {};
    const mark = (s, fill, text, dots) => {
      const d = s - route.sStart;
      const x = proj.X(d), y = proj.Y(route.sample(s, tmp).y);
      const top = Math.max(12, y - 20);
      ctx.strokeStyle = '#1d1a2b'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top); ctx.stroke();
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.arc(x, top, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (dots) {
        ctx.fillStyle = '#e2463a';
        for (const [dx, dy] of [[-3.5, -3], [3.5, -3], [0, 3.5]]) { ctx.beginPath(); ctx.arc(x + dx, top + dy, 2.2, 0, Math.PI * 2); ctx.fill(); }
      }
      if (text) {
        ctx.fillStyle = '#ffffff'; ctx.font = '700 11px Fredoka, Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, x, top + 1);
      }
    };
    for (const k of r.koms) mark(k.s1, '#ffffff', '', true);
    for (const sp of r.sprints) mark(sp.s, '#2fa84f', 'S');
    for (const f of r.feeds) mark(f.s0, '#ff9a2b', 'R');
  }

  class Hud {
    constructor() {
      this.el = {
        speed: document.getElementById('hud-speed'),
        grade: document.getElementById('hud-grade'),
        gradeBox: document.getElementById('hud-grade-box'),
        alt: document.getElementById('hud-alt'),
        dist: document.getElementById('hud-dist'),
        remain: document.getElementById('hud-remain'),
        time: document.getElementById('hud-time'),

        timeScale: document.getElementById('hud-timescale'),
        cam: document.getElementById('hud-cam'),
        climb: document.getElementById('hud-climb'),
        next: document.getElementById('hud-next'),
        pos: document.getElementById('hud-pos'),
        gTrack: document.getElementById('g-track'),
        gFill: document.getElementById('g-fill'),
        gTarget: document.getElementById('g-target'),
        gTargetW: document.getElementById('g-target-w'),
        gCp: document.getElementById('g-cp'),
        gWatts: document.getElementById('g-watts'),
        gWkg: document.getElementById('g-wkg'),
        gReserve: document.getElementById('g-reserve'),
        gReserveBox: document.getElementById('g-reserve-box'),
        gDraft: document.getElementById('g-draft'),
        points: document.getElementById('hud-points'),
        profile: document.getElementById('hud-profile'),
        map: document.getElementById('hud-map'),
        speedlines: document.getElementById('speedlines')
      };
      this.lastDom = 0;
    }

    setup(route, L, phys) {
      this.route = route;
      this.L = L;
      // zones de la jauge (en % de la puissance max) : endurance < 75 % du seuil < tempo < seuil < 130 % du seuil < rouge
      if (phys) {
        const z = (w) => (w / phys.pMax * 100).toFixed(1) + '%';
        const tr = this.el.gTrack;
        tr.style.setProperty('--z1', z(phys.cp * 0.75));
        tr.style.setProperty('--z2', z(phys.cp));
        tr.style.setProperty('--z3', z(phys.cp * 1.3));
        this.el.gCp.style.bottom = z(phys.cp);
        this.pMax = phys.pMax;
      }
      // profil
      const pc = this.el.profile;
      this.profileBg = document.createElement('canvas');
      this.profileBg.width = pc.width; this.profileBg.height = pc.height;
      this.profileProj = drawProfile(this.profileBg, route, { padL: 6, padB: 6, axes: false, lineWidth: 2 });
      drawRaceMarkers(this.profileBg.getContext('2d'), route, L, this.profileProj);
      // mini-carte
      const mc = this.el.map;
      this.mapBg = document.createElement('canvas');
      this.mapBg.width = mc.width; this.mapBg.height = mc.height;
      const ctx = this.mapBg.getContext('2d');
      const bb = route.bbox;
      const w = bb.x1 - bb.x0, h = bb.z1 - bb.z0;
      const sc = Math.min((mc.width - 24) / w, (mc.height - 24) / h);
      const ox = (mc.width - w * sc) / 2 - bb.x0 * sc, oz = (mc.height - h * sc) / 2 - bb.z0 * sc;
      this.mapProj = (x, z) => [ox + x * sc, oz + z * sc];
      ctx.fillStyle = 'rgba(255,255,255,0.0)';
      ctx.clearRect(0, 0, mc.width, mc.height);
      // eau
      ctx.fillStyle = L.amb.water.shallow;
      for (const lk of L.lakes) { const [px, pz] = this.mapProj(lk.x, lk.z); ctx.beginPath(); ctx.arc(px, pz, Math.max(2, lk.r * sc), 0, Math.PI * 2); ctx.fill(); }
      ctx.strokeStyle = L.amb.water.shallow; ctx.lineWidth = 2.5;
      for (const rv of L.rivers) {
        ctx.beginPath();
        for (let i = 0; i < rv.n; i++) { const [px, pz] = this.mapProj(rv.x[i], rv.z[i]); if (i) ctx.lineTo(px, pz); else ctx.moveTo(px, pz); }
        ctx.stroke();
      }
      // route
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const [lw, col] of [[6, '#1d1a2b'], [3, '#ffffff']]) {
        ctx.strokeStyle = col; ctx.lineWidth = lw;
        ctx.beginPath();
        for (let i = route.iStart; i <= route.iEnd; i += 2) {
          const [px, pz] = this.mapProj(route.x[i], route.z[i]);
          if (i === route.iStart) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
        }
        ctx.stroke();
      }
      // villages
      for (const v of L.villages || []) {
        const [vx, vz] = this.mapProj(route.x[v.ic], route.z[v.ic]);
        ctx.fillStyle = '#f39a2b'; ctx.strokeStyle = '#1d1a2b'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(vx, vz - 8); ctx.lineTo(vx + 6, vz - 2); ctx.lineTo(vx + 6, vz + 5); ctx.lineTo(vx - 6, vz + 5); ctx.lineTo(vx - 6, vz - 2); ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      const [sx, sz] = this.mapProj(route.x[route.iStart], route.z[route.iStart]);
      const [ex, ez] = this.mapProj(route.x[route.iEnd], route.z[route.iEnd]);
      ctx.fillStyle = '#3d7be0'; ctx.beginPath(); ctx.arc(sx, sz, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e2463a'; ctx.beginPath(); ctx.arc(ex, ez, 5, 0, Math.PI * 2); ctx.fill();
    }

    update(st, now) {
      // canvases à chaque image
      const pc = this.el.profile, pctx = pc.getContext('2d');
      pctx.clearRect(0, 0, pc.width, pc.height);
      pctx.drawImage(this.profileBg, 0, 0);
      const px = this.profileProj.X(clamp(st.d, 0, this.route.length));
      const py = this.profileProj.Y(st.alt);
      pctx.fillStyle = 'rgba(29,26,43,0.25)';
      pctx.fillRect(px - 1, 0, 2, pc.height);
      pctx.fillStyle = '#ffffff'; pctx.strokeStyle = '#1d1a2b'; pctx.lineWidth = 3;
      pctx.beginPath(); pctx.arc(px, py, 7, 0, Math.PI * 2); pctx.fill(); pctx.stroke();

      const mc = this.el.map, mctx = mc.getContext('2d');
      mctx.clearRect(0, 0, mc.width, mc.height);
      mctx.drawImage(this.mapBg, 0, 0);
      const [mx, mz] = this.mapProj(st.x, st.z);
      mctx.save();
      mctx.translate(mx, mz);
      mctx.rotate(Math.atan2(st.hx, -st.hz));
      mctx.fillStyle = '#ffd23a'; mctx.strokeStyle = '#1d1a2b'; mctx.lineWidth = 2.5;
      mctx.beginPath(); mctx.moveTo(0, -9); mctx.lineTo(7, 7); mctx.lineTo(0, 3); mctx.lineTo(-7, 7); mctx.closePath();
      mctx.fill(); mctx.stroke();
      mctx.restore();

      // lignes de vitesse façon BD au-delà de ~50 km/h
      const sl = clamp((st.speed - 13.5) / 9, 0, 0.75);
      if (sl > 0 || this._sl > 0) {
        this.el.speedlines.style.opacity = sl.toFixed(2);
        this.el.speedlines.style.transform = 'rotate(' + (Math.random() * 7).toFixed(1) + 'deg)';
      }
      this._sl = sl;

      // jauge de puissance : à chaque image (on la manipule à la souris)
      const e = this.el;
      if (st.target !== undefined) {
        const tp = clamp(st.target, 0, 1) * 100;
        e.gTarget.style.bottom = tp.toFixed(1) + '%';
        e.gTargetW.textContent = Math.round(st.target * this.pMax) + ' W';
        e.gFill.style.height = clamp(st.watts / this.pMax, 0, 1) * 100 + '%';
      }

      // DOM à ~12 Hz
      if (now - this.lastDom < 80) return;
      this.lastDom = now;
      e.speed.textContent = Math.round(st.speed * 3.6);
      const gp = st.grade * 100;
      e.grade.textContent = (gp >= 0 ? '+' : '') + gp.toFixed(1).replace('.', ',') + ' %';
      e.gradeBox.style.background = gradeColor(st.grade);
      e.gradeBox.style.color = st.grade * 100 >= 9 || st.grade < 0 ? '#fff' : '#1d1a2b';
      e.alt.textContent = Math.round(st.alt) + ' m';
      e.dist.textContent = (Math.max(0, st.d) / 1000).toFixed(2).replace('.', ',') + ' km';
      e.remain.textContent = 'reste ' + (Math.max(0, this.route.length - st.d) / 1000).toFixed(1).replace('.', ',') + ' km';
      e.time.textContent = formatTime(st.time);
      if (st.target !== undefined) {
        e.gWatts.textContent = Math.round(st.watts);
        e.gWkg.textContent = st.wkg.toFixed(1).replace('.', ',') + ' W/kg' + (st.braking ? ' · frein' : '');
        e.gReserve.style.width = clamp(st.reserve, 0, 1) * 100 + '%';
        e.gReserve.style.background = st.reserve > 0.5 ? '#5cc85a' : st.reserve > 0.2 ? '#f39a2b' : '#e2463a';
        e.gReserveBox.classList.toggle('bonk', !!st.bonk);
        const dr = st.draft || 0;
        e.gDraft.classList.toggle('hidden', dr < 0.03);
        if (dr >= 0.03) e.gDraft.textContent = '🌀 Aspiration −' + Math.round(dr * 100) + ' %';
      }
      e.timeScale.textContent = '⏩ x' + st.timeScale;
      e.timeScale.classList.toggle('dim', st.timeScale === 1);
      e.cam.textContent = st.camName;
      // prochain évènement de course, boost, points
      if (st.next) {
        e.next.classList.remove('hidden');
        const html = st.next.icon + ' ' + st.next.label + ' <small>dans ' + st.next.dist + '</small>';
        if (e.next.innerHTML !== html) e.next.innerHTML = html;
      } else e.next.classList.add('hidden');
      // position dans la course
      if (st.race) {
        const rc = st.race;
        e.pos.classList.remove('hidden');
        const grp = rc.groupSize > 1 ? 'groupe de ' + rc.groupSize : 'seul';
        const gap = rc.position === 1 ? 'en tête' : rc.inHead ? 'groupe de tête' : 'tête à ' + formatTime(rc.gapHead);
        e.pos.innerHTML = '🏁 ' + rc.position + '<small>/' + rc.total + '</small> <small>· ' + grp + ' · ' + gap + '</small>';
      } else e.pos.classList.add('hidden');
      const r = this.L.race;
      if (r && (r.sprints.length || r.koms.length)) {
        e.points.classList.remove('hidden');
        const bits = [];
        if (r.sprints.length) bits.push('🟢 ' + B3D.race.ptsLabel(st.points.sprint));
        if (r.koms.length) bits.push('🔴 ' + B3D.race.ptsLabel(st.points.kom));
        e.points.textContent = bits.join(' · ');
      } else e.points.classList.add('hidden');
      // montée en cours
      const c = st.climb;
      if (c) {
        e.climb.classList.remove('hidden');
        e.climb.innerHTML = '<b>' + c.name + '</b><span>' + c.toGo + '</span>';
      } else e.climb.classList.add('hidden');
    }
  }

  B3D.Hud = Hud;
  B3D.drawProfile = drawProfile;
})(typeof window !== 'undefined' ? window : globalThis);
