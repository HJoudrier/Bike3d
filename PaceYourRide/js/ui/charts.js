/* author : Hugo Joudrier-Faure */
/* PaceYourRide — graphiques canvas (sans dépendance) :
 *   ProfileChart : profil altimétrique coloré par la pente, portions, sélection, marqueurs ;
 *   SeriesChart  : petits multiples synchronisés (altitude, puissance, vitesse, W′bal) ;
 *   CurveChart   : courbe de puissance record (durées en échelle logarithmique ou linéaire, zoomable) ;
 *   RaceCurveChart : mode jeu, puissance selon la durée (record du jour, étape en cours, disponible maintenant) ;
 *   WeatherChart : météo le long du parcours.
 * Les courbes en fonction de la distance ou du temps se zooment (ZoomView) : molette ou boutons + / −, glisser
 * pour se déplacer (Maj + glisser sur le profil du parcours, où le glisser sélectionne), pincement au doigt,
 * double clic pour revenir à la vue d'ensemble. */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom;

  /* ---------- Thème ---------- */
  function theme() {
    const v = (n) => D.cssVar(n);
    return {
      surface: v('--surface'), ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'),
      grid: v('--grid'), axis: v('--axis'), accent: v('--accent'),
      s1: v('--series-1'), s2: v('--series-2'), s3: v('--series-3'), s4: v('--series-4'), s7: v('--series-7'),
      elevLine: v('--elev-line'), elevFill: v('--elev-fill'), critical: v('--critical'),
      font: '11px system-ui, -apple-system, "Segoe UI", sans-serif',
    };
  }

  /** Fond sombre ? (couleur CSS « #rrggbb » ou « rgb(r, g, b) » ; clair par défaut) */
  function darkSurface(c) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(c).trim()) || /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(c));
    if (!m) return false;
    const hex = m[0][0] === '#';
    const [r, g, b] = [m[1], m[2], m[3]].map((x) => (hex ? parseInt(x, 16) : Number(x)));
    return 0.299 * r + 0.587 * g + 0.114 * b < 110;
  }

  /** Classes de pente (palette divergente bleu ↔ rouge, milieu neutre). */
  const GRADE_CLASSES = [
    { max: -0.08, color: '#1c5cab', label: '< −8 %' },
    { max: -0.04, color: '#3987e5', label: '−8 à −4 %' },
    { max: -0.015, color: '#86b6ef', label: '−4 à −1,5 %' },
    { max: 0.015, color: '#cfcdc6', label: 'plat' },
    { max: 0.04, color: '#f4b9b1', label: '1,5 à 4 %' },
    { max: 0.07, color: '#ec8a80', label: '4 à 7 %' },
    { max: 0.10, color: '#e34948', label: '7 à 10 %' },
    { max: 0.14, color: '#b3261e', label: '10 à 14 %' },
    { max: Infinity, color: '#7f1d1a', label: '> 14 %' },
  ];
  const gradeColor = (g) => { for (const c of GRADE_CLASSES) if (g <= c.max) return c.color; return GRADE_CLASSES[GRADE_CLASSES.length - 1].color; };

  function niceStep(range, count) {
    const raw = range / Math.max(1, count);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }
  function ticks(min, max, count) {
    if (!(max > min)) return [min];
    const st = niceStep(max - min, count);
    const out = [];
    for (let v = Math.ceil(min / st) * st; v <= max + 1e-9; v += st) out.push(+v.toFixed(10));
    return out;
  }
  /** Graduations de distance (km) entre lo et hi : valeurs + nombre de décimales cohérent avec le pas. */
  function rangeTicks(lo, hi, count) {
    const st = niceStep(Math.max(1e-6, hi - lo), Math.max(2, count));
    const digits = st < 0.1 ? 2 : st < 1 ? 1 : 0;
    const values = [];
    for (let v = Math.ceil(lo / st - 1e-9) * st; v <= hi + 1e-9; v += st) values.push(+v.toFixed(10));
    return { values, digits };
  }
  /** Graduations de distance (km) : valeurs + nombre de décimales cohérent avec le pas. */
  function kmTicks(km, count) {
    const st = niceStep(km, Math.max(2, count));
    const digits = st < 0.1 ? 2 : st < 1 ? 1 : 0;
    const values = [];
    for (let v = 0; v <= km + 1e-9; v += st) values.push(+v.toFixed(10));
    return { values, digits };
  }

  /* ---------- Canvas haute densité avec redimensionnement automatique ---------- */
  class Surface {
    constructor(container, draw) {
      this.box = container;
      this.canvas = D.h('canvas');
      this.box.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.drawFn = draw;
      this.w = 0; this.h = 0;
      this.raf = 0;
      this.ro = new ResizeObserver(() => this.request());
      this.ro.observe(this.box);
    }
    request() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
    }
    paint() {
      const r = this.box.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
      if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
      this.w = r.width; this.h = r.height;
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      this.drawFn(ctx, this.w, this.h);
    }
  }

  function makeTip(box) {
    const tip = D.h('div', { class: 'chart-tip', hidden: true });
    box.appendChild(tip);
    return {
      show(x, y, title, rows) {
        D.clear(tip);
        tip.appendChild(D.h('div', { class: 't' }, title));
        for (const r of rows) {
          tip.appendChild(D.h('div', { class: 'r' },
            r.color ? D.h('i', { style: { background: r.color } }) : null,
            D.h('b', null, r.value), D.h('span', null, r.label)));
        }
        tip.hidden = false;
        const bw = box.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
        let left = x + 14;
        if (left + tw > bw - 4) left = x - tw - 14;
        tip.style.left = Math.max(2, left) + 'px';
        tip.style.top = Math.max(2, Math.min(y - th / 2, box.clientHeight - th - 2)) + 'px';
      },
      hide() { tip.hidden = true; },
    };
  }

  function emptyMessage(box, text) {
    let el = box.querySelector('.chart-empty');
    if (!text) { if (el) el.remove(); return; }
    if (!el) { el = D.h('div', { class: 'chart-empty' }); box.appendChild(el); }
    el.textContent = text;
  }

  const fmtKmAxis = (m, span) => U.fmt(m / 1000, span < 5000 ? 1 : 0);


  /* ======================================================================
   * Zoom horizontal : fenêtre [a, b] (fractions de l'étendue complète) sur l'axe des x d'une courbe
   * ==================================================================== */
  class ZoomView {
    /** chart : courbe (surface, L = zone de tracé à jour après un dessin, opts) ; opts.follow : suit un marqueur. */
    constructor(chart, opts) {
      this.chart = chart;
      this.a = 0; this.b = 1;
      this.minSpan = 1 / 250;
      this.follow = !!(opts && opts.follow);
      // opts.anchor (0 à 1) : la vue suit toujours le marqueur, qui reste à cette fraction de la largeur visible (0,3 : 30 % du parcours visible
      // derrière lui, 70 % devant) ; la largeur visible est celle du zoom choisi, sinon la fenêtre par défaut (defaultSpan)
      this.anchor = opts && typeof opts.anchor === 'number' ? opts.anchor : null;
      this.userSpan = null;      // largeur choisie par le zoom (boutons, molette) quand la vue suit le marqueur
      this.lastF = 0;            // dernière position du marqueur suivi
      this.manual = false;       // l'utilisateur a déplacé la vue : on ne la recentre plus sur le marqueur
      this.lock = false;         // téléphone : pas de boutons, pas de déplacement ; seul le zoom au pincement, centré sur le marqueur suivi
      this.anchor0 = this.anchor;
      const box = chart.box;
      const btn = (label, title, fn, cls) => {
        const b = D.h('button', { type: 'button', class: 'zoom-btn' + (cls ? ' ' + cls : ''), title, 'aria-label': title }, label);
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('dblclick', (e) => e.stopPropagation());
        return b;
      };
      this.bar = D.h('div', { class: 'chart-zoom', role: 'group', 'aria-label': 'Zoom' },
        btn('◀', 'Déplacer vers la gauche', () => this.panBy(-0.25), 'pan'),
        btn('▶', 'Déplacer vers la droite', () => this.panBy(0.25), 'pan'),
        btn('⟲', this.anchor !== null ? 'Revenir au suivi du cycliste' : 'Vue d\'ensemble', () => this.reset(), 'pan'),
        btn('−', 'Dézoomer', () => this.zoomBy(1.6)),
        btn('+', 'Zoomer', () => this.zoomBy(1 / 1.6)));
      box.appendChild(this.bar);
      this.sync();
      this.bindEvents();
    }

    /** Vue verrouillée (téléphone) : boutons masqués, déplacement impossible, seul le zoom (pincement à deux doigts) reste, la vue suivant le marqueur
     * à la fraction `anchor` de la largeur (0,5 : centré). Hors verrou, retour au réglage d'origine. */
    setLock(on, anchor) {
      this.lock = !!on;
      this.bar.hidden = this.lock;
      this.anchor = this.lock && this.follow ? (typeof anchor === 'number' ? anchor : 0.5) : this.anchor0;
      this.manual = false;
      this.userSpan = null;
      this.chart.box.classList.toggle('zoom-locked', this.lock);
      if (this.follow) this.ensureVisible(this.lastF); else this.chart.surface.request();
    }

    get span() { return this.b - this.a; }
    zoomed() { return this.span < 0.999; }

    /** Fraction de l'étendue complète sous l'abscisse x (pixels, dans la zone de tracé). */
    fracAt(x) {
      const L = this.chart.L;
      if (!L) return this.a;
      return this.a + U.clamp((x - L.l) / L.pw, 0, 1) * this.span;
    }

    sync() {
      this.bar.classList.toggle('zoomed', this.zoomed());
      this.chart.box.classList.toggle('is-zoomed', this.zoomed());
    }

    set(a, b) {
      const span = U.clamp(b - a, this.minSpan, 1);
      a = U.clamp(a, 0, 1 - span);
      this.a = a; this.b = a + span;
      this.sync();
      this.chart.surface.request();
    }

    /** Multiplie la largeur visible par k autour de la fraction f (par défaut le centre). */
    zoomBy(k, f) {
      const span = U.clamp(this.span * k, this.minSpan, 1);
      if (this.anchor !== null && this.follow && !this.manual) { // la vue suit le marqueur : le zoom change seulement la largeur visible
        this.userSpan = span;
        this.ensureVisible(this.lastF);
        return;
      }
      const c = f === undefined ? (this.a + this.b) / 2 : f;
      const r = (c - this.a) / this.span;
      this.set(c - r * span, c - r * span + span);
    }

    panBy(frac) { this.manual = true; this.set(this.a + frac * this.span, this.b + frac * this.span); }

    /** Vue d'ensemble ; quand la vue suit le marqueur (anchor), retour au suivi avec la largeur par défaut. */
    reset() {
      this.manual = false;
      if (this.anchor !== null && this.follow) {
        this.userSpan = null;
        const span = this.defaultSpan(), a = U.clamp(this.lastF - this.anchor * span, 0, 1 - span);
        this.set(a, a + span);
        return;
      }
      this.set(0, 1);
    }

    /** Largeur visible (fraction du parcours) d'une vue qui suit le marqueur : 10 % du parcours, entre 2 et 10 km. */
    defaultSpan() {
      const len = this.chart.profile && this.chart.profile.length;
      if (!len) return 1;
      return U.clamp(U.clamp(0.1 * len, 2000, 10000) / len, this.minSpan, 1);
    }

    /** Vue qui suit un marqueur (fraction f) : la recentre, un tiers de la fenêtre en arrière, quand il en sort. */
    ensureVisible(f) {
      if (!this.follow) return;
      this.lastF = f;
      if (this.manual) return;
      if (this.anchor !== null) { // le marqueur reste toujours à `anchor` de la largeur visible
        const span = this.userSpan || this.defaultSpan(), a = U.clamp(f - this.anchor * span, 0, 1 - span);
        if (Math.abs(a - this.a) < 1e-9 && Math.abs(span - this.span) < 1e-9) return;
        this.a = a; this.b = a + span;
        this.sync();
        this.chart.surface.request();
        return;
      }
      if (!this.zoomed()) return;
      if (f >= this.a + 0.05 * this.span && f <= this.b - 0.15 * this.span) return;
      const span = this.span;
      this.a = U.clamp(f - 0.35 * span, 0, 1 - span); this.b = this.a + span;
      this.chart.surface.request();
    }

    bindEvents() {
      const c = this.chart.surface.canvas, ch = this.chart;
      const local = (e) => e.clientX - c.getBoundingClientRect().left;
      c.addEventListener('wheel', (e) => {
        if (!ch.L) return;
        // zoomWheel : 'ctrl' → la molette ne zoome qu'avec Ctrl (ou le pincement d'un pavé tactile), sinon la page défile
        if (ch.opts && ch.opts.zoomWheel === 'ctrl' && !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        if (this.lock && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) return;
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { this.panBy((e.deltaX || e.deltaY) / 400); return; }
        const k = Math.pow(1.0018, U.clamp(e.deltaY, -300, 300));   // ≈ 1,2 par cran de molette
        this.zoomBy(k, this.fracAt(local(e)));
      }, { passive: false });
      c.addEventListener('dblclick', () => { if (!this.lock && this.zoomed()) this.reset(); });

      // déplacement au glisser (Maj ou bouton du milieu quand le glisser sert à sélectionner) et pincement
      const touches = new Map();
      let pan = null, pinch = null;
      const dist = () => { const [p, q] = [...touches.values()]; return Math.abs(p - q) || 1; };
      const mid = () => { const [p, q] = [...touches.values()]; return (p + q) / 2; };
      c.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') {
          touches.set(e.pointerId, local(e));
          if (touches.size === 2 && ch.L) {
            pinch = { d: dist(), m: mid(), a: this.a, b: this.b, span: this.span };
            pan = null;
            c.setPointerCapture(e.pointerId);
            e.stopImmediatePropagation();
            return;
          }
        }
        const can = !this.lock && (e.button === 1 || e.shiftKey || (!ch.opts.selectable && this.zoomed()));
        if (!can || !ch.L) return;
        pan = { x: local(e), a: this.a, b: this.b };
        this.manual = true;
        c.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopImmediatePropagation();
      }, true);
      c.addEventListener('pointermove', (e) => {
        if (touches.has(e.pointerId)) touches.set(e.pointerId, local(e));
        if (pinch && touches.size >= 2) {
          if (this.lock) { // zoom seul : la largeur change avec l'écart des doigts, la vue reste centrée sur le marqueur
            const span = U.clamp(pinch.span * (pinch.d / dist()), this.minSpan, 1);
            if (this.follow && this.anchor !== null) { this.userSpan = span; this.ensureVisible(this.lastF); } else this.set(this.a, this.a + span);
            e.stopImmediatePropagation();
            return;
          }
          const L = ch.L;
          const f0 = pinch.a + ((pinch.m - L.l) / L.pw) * (pinch.b - pinch.a);
          const span = U.clamp((pinch.b - pinch.a) * (pinch.d / dist()), this.minSpan, 1);
          const a = f0 - ((mid() - L.l) / L.pw) * span;
          this.manual = true;
          this.set(a, a + span);
          e.stopImmediatePropagation();
          return;
        }
        if (pan) {
          const df = ((local(e) - pan.x) / ch.L.pw) * (pan.b - pan.a);
          this.set(pan.a - df, pan.b - df);
          e.stopImmediatePropagation();
        }
      }, true);
      const up = (e) => {
        touches.delete(e.pointerId);
        if (touches.size < 2) pinch = null;
        if (pan) { pan = null; try { c.releasePointerCapture(e.pointerId); } catch (err) { /* déjà relâché */ } }
      };
      c.addEventListener('pointerup', up, true);
      c.addEventListener('pointercancel', up, true);
    }
  }

  /* ======================================================================
   * Profil altimétrique
   * ==================================================================== */
  class ProfileChart {
    /**
     * opts : {selectable, onSelect(a,b), onHover(s|null), onBandClick(kind,id), emptyText}
     */
    constructor(container, opts) {
      this.opts = opts || {};
      this.box = container;
      this.profile = null;
      this.bands = [];
      this.markers = [];
      this.flags = [];          // points de passage : [{s, label, color, from (pied d'une côte)}]
      this.hoverS = null;
      this.sel = null;          // {a, b} en mètres (sélection en cours ou figée)
      this.highlight = null;    // {a, b}
      this.surface = new Surface(container, (ctx, w, h) => this.draw(ctx, w, h));
      this.tip = makeTip(container);
      this.bindEvents();
      this.zoom = new ZoomView(this, { follow: this.opts.follow, anchor: this.opts.anchor });
    }

    setProfile(p) {
      // un autre parcours : retour à la vue d'ensemble (ou, si la vue suit le cycliste, à la fenêtre par défaut)
      const changed = !p || !this.profile || Math.abs(p.length - this.profile.length) > 1;
      this.profile = p;
      if (changed) this.zoom.reset();
      this.sel = null; this.surface.request();
    }
    setBands(b) { this.bands = b || []; this.surface.request(); }
    setMarkers(m) {
      this.markers = m || [];
      const p = this.profile, last = this.markers[this.markers.length - 1];
      if (p && last && last.s >= 0) this.zoom.ensureVisible(last.s / p.length);
      this.surface.request();
    }
    setFlags(f) { this.flags = f || []; this.surface.request(); }
    setHighlight(r) { this.highlight = r; this.surface.request(); }
    setHover(s) { this.hoverS = s; this.surface.request(); }
    clearSelection() { this.sel = null; this.surface.request(); }


    xOf(s) {
      const len = this.profile.length, v0 = this.zoom.a * len, v1 = this.zoom.b * len;
      return this.L.l + ((s - v0) / (v1 - v0)) * this.L.pw;
    }
    sOf(x) { return this.zoom.fracAt(x) * this.profile.length; }

    draw(ctx, w, h) {
      const T = theme();
      this.T = T;
      const p = this.profile;
      emptyMessage(this.box, p ? '' : (this.opts.emptyText || 'Trace un parcours sur la carte pour voir son profil.'));
      if (!p) return;
      const topM = this.opts.tracks !== false ? 30 : 6, bottom = 20, ph = h - topM - bottom;
      const n = p.n, ele = p.ele;
      const len = p.length, v0 = this.zoom.a * len, v1 = this.zoom.b * len;
      let emin = p.stats.emin, emax = p.stats.emax;
      if (this.zoom.zoomed()) { // zoom : l'échelle verticale suit la partie visible
        emin = Infinity; emax = -Infinity;
        for (let i = U.clamp(Math.floor(v0 / p.step), 0, n - 1), i1 = U.clamp(Math.ceil(v1 / p.step), 0, n - 1); i <= i1; i++) {
          if (ele[i] < emin) emin = ele[i];
          if (ele[i] > emax) emax = ele[i];
        }
      }
      const pad = Math.max(10, (emax - emin) * 0.08);
      emin -= pad; emax += pad;
      const yt = ticks(emin, emax, Math.max(2, Math.floor(ph / 40)));
      emin = Math.min(emin, yt[0]);
      ctx.font = T.font;
      // marge gauche ajustée à la plus longue étiquette d'altitude
      const lw = Math.max(34, ...yt.map((v) => ctx.measureText(U.fmt(v, 0) + ' m').width));
      const L = this.L = { l: Math.ceil(lw) + 10, r: 12, t: topM, b: bottom, ph };
      L.pw = w - L.l - L.r;
      const yOf = (e) => L.t + L.ph - ((e - emin) / (emax - emin)) * L.ph;
      this.yOf = yOf;

      // grille horizontale + étiquettes
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.fillStyle = T.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (const v of yt) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(L.l, y); ctx.lineTo(L.l + L.pw, y); ctx.stroke();
        ctx.fillText(U.fmt(v, 0) + ' m', L.l - 5, y);
      }
      // axe des x
      const xt = rangeTicks(v0 / 1000, v1 / 1000, Math.floor(L.pw / 70));
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (const v of xt.values) ctx.fillText(U.fmt(v, xt.digits) + ' km', this.xOf(v * 1000), L.t + L.ph + 5);
      ctx.strokeStyle = T.axis;
      ctx.beginPath(); ctx.moveTo(L.l, L.t + L.ph + 0.5); ctx.lineTo(L.l + L.pw, L.t + L.ph + 0.5); ctx.stroke();

      // tout le reste est tracé dans la zone visible (le zoom peut faire sortir portions, repères et marqueurs)
      ctx.save();
      ctx.beginPath(); ctx.rect(L.l, 0, L.pw, h); ctx.clip();

      // surbrillance d'une portion
      if (this.highlight) {
        const a = this.xOf(this.highlight.a), b = this.xOf(this.highlight.b);
        ctx.fillStyle = 'rgba(42,120,214,0.10)';
        ctx.fillRect(Math.min(a, b), L.t, Math.abs(b - a), L.ph);
      }

      // aire colorée par la pente (une colonne par pixel)
      const cols = Math.max(1, Math.floor(L.pw));
      const top = new Float32Array(cols + 1);
      for (let c = 0; c <= cols; c++) {
        // interpolation linéaire : pas d'escalier quand le parcours compte moins de points que de pixels
        const f = U.clamp((v0 + (c / cols) * (v1 - v0)) / p.step, 0, n - 1), i = Math.min(Math.max(0, n - 2), Math.floor(f));
        top[c] = n > 1 ? ele[i] + (ele[i + 1] - ele[i]) * (f - i) : ele[0];
      }
      for (let c = 0; c < cols; c++) {
        const i0 = U.clamp(Math.floor((v0 + (c / cols) * (v1 - v0)) / p.step), 0, n - 2), i1 = Math.max(i0 + 1, Math.floor((v0 + ((c + 1) / cols) * (v1 - v0)) / p.step));
        const g = (ele[Math.min(n - 1, i1)] - ele[i0]) / ((Math.min(n - 1, i1) - i0) * p.step || 1);
        const yTop = yOf(Math.max(top[c], top[c + 1]));
        ctx.fillStyle = gradeColor(g);
        ctx.globalAlpha = 0.75;
        ctx.fillRect(L.l + c, yTop, 1.05, L.t + L.ph - yTop);
      }
      ctx.globalAlpha = 1;
      // ligne d'altitude
      ctx.strokeStyle = T.ink; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let c = 0; c <= cols; c++) {
        const x = L.l + c, y = yOf(top[c]);
        if (c === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // pistes des portions (revêtement / vent)
      if (this.opts.tracks !== false) {
        const tracks = [{ kind: 'surface', y: 3, label: 'Revêt.' }, { kind: 'wind', y: 16, label: 'Vent' }];
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        for (const tr of tracks) {
          ctx.fillStyle = T.muted;
          ctx.fillText(tr.label, L.l - 5, tr.y + 5);
          ctx.fillStyle = T.grid;
          ctx.fillRect(L.l, tr.y, L.pw, 10);
        }
        this.bandRects = [];
        for (const b of this.bands) {
          const tr = tracks.find((t) => t.kind === b.kind);
          if (!tr) continue;
          const x0 = this.xOf(U.clamp(b.start, 0, p.length)), x1 = this.xOf(U.clamp(b.end, 0, p.length));
          if (x1 - x0 < 0.5 || x1 < L.l || x0 > L.l + L.pw) continue;
          ctx.fillStyle = b.color;
          ctx.fillRect(x0 + 1, tr.y, Math.max(1, x1 - x0 - 2), 10);
          const vx0 = Math.max(x0, L.l), vx1 = Math.min(x1, L.l + L.pw); // part visible
          this.bandRects.push({ x0: vx0, x1: vx1, y0: tr.y, y1: tr.y + 10, kind: b.kind, id: b.id });
          if (b.label && vx1 - vx0 > ctx.measureText(b.label).width + 8) {
            ctx.fillStyle = b.textColor || '#fff'; ctx.textAlign = 'center';
            ctx.font = '9px system-ui, sans-serif';
            ctx.fillText(b.label, (vx0 + vx1) / 2, tr.y + 5.5);
            ctx.font = T.font; ctx.textAlign = 'right';
          }
        }
      }

      // sélection au pinceau
      if (this.sel) {
        const a = this.xOf(Math.min(this.sel.a, this.sel.b)), b = this.xOf(Math.max(this.sel.a, this.sel.b));
        ctx.fillStyle = 'rgba(42,120,214,0.18)';
        ctx.fillRect(a, L.t, b - a, L.ph);
        ctx.strokeStyle = T.accent; ctx.lineWidth = 1;
        ctx.strokeRect(a + 0.5, L.t + 0.5, b - a - 1, L.ph - 1);
      }

      // points de passage : côte (bande), ligne (pointillés) et étiquette en haut du graphique
      for (const f of this.flags) {
        const x = Math.round(this.xOf(U.clamp(f.s, 0, p.length))) + 0.5;
        if (f.from !== undefined) {
          const a = this.xOf(U.clamp(f.from, 0, p.length));
          ctx.fillStyle = f.band || 'rgba(214, 40, 40, 0.10)';
          ctx.fillRect(a, L.t, x - a, L.ph);
        }
        if (x < L.l || x > L.l + L.pw) continue; // ligne hors de la vue
        ctx.strokeStyle = f.color; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, L.t); ctx.lineTo(x, L.t + L.ph); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '600 10px system-ui, sans-serif';
        const w = Math.ceil(ctx.measureText(f.label).width) + 8;
        const bx = U.clamp(x - w / 2, L.l, L.l + L.pw - w);
        ctx.fillStyle = f.color;
        ctx.fillRect(bx, L.t + 1, w, 14);
        ctx.fillStyle = f.text || '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(f.label, bx + w / 2, L.t + 8.5);
        ctx.font = T.font;
      }

      // marqueurs (cycliste / fantôme)
      for (const m of this.markers) {
        if (!(m.s >= 0)) continue;
        const x = this.xOf(Math.min(m.s, p.length));
        if (x < L.l - 8 || x > L.l + L.pw + 8) continue;
        const e = PYR.course.eleAt({ step: p.step, n: p.n - 1, ele: p.ele }, Math.min(m.s, p.length));
        const y = yOf(e);
        ctx.strokeStyle = m.color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + 0.5, L.t); ctx.lineTo(x + 0.5, L.t + L.ph); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = m.color; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = T.surface; ctx.stroke();
      }

      // réticule de survol
      if (this.hoverS !== null && this.hoverS !== undefined) {
        const s = U.clamp(this.hoverS, 0, p.length);
        const x = this.xOf(s);
        const e = PYR.course.eleAt({ step: p.step, n: p.n - 1, ele: p.ele }, s);
        ctx.strokeStyle = T.ink2; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, L.t); ctx.lineTo(Math.round(x) + 0.5, L.t + L.ph); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, yOf(e), 4.5, 0, Math.PI * 2);
        ctx.fillStyle = T.ink; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = T.surface; ctx.stroke();
      }
      ctx.restore();
    }

    gradeAt(s) {
      const p = this.profile;
      const i = U.clamp(Math.floor(s / p.step), 0, p.n - 2);
      const j0 = Math.max(0, i - 3), j1 = Math.min(p.n - 1, i + 4);
      return (p.ele[j1] - p.ele[j0]) / ((j1 - j0) * p.step);
    }

    bindEvents() {
      const c = this.surface.canvas;
      let dragging = false, downX = 0, moved = false;
      const local = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      const inPlot = (pt) => this.L && pt.x >= this.L.l - 2 && pt.x <= this.L.l + this.L.pw + 2;

      c.addEventListener('pointerdown', (e) => {
        if (!this.profile || !this.L) return;
        const pt = local(e);
        const band = this.hitBand(pt);
        if (band) { if (this.opts.onBandClick) this.opts.onBandClick(band.kind, band.id); return; }
        if (!this.opts.selectable || !inPlot(pt)) return;
        dragging = true; moved = false; downX = pt.x;
        c.setPointerCapture(e.pointerId);
        const s = this.sOf(pt.x);
        this.sel = { a: s, b: s };
        this.surface.request();
      });
      c.addEventListener('pointermove', (e) => {
        if (!this.profile || !this.L) return;
        const pt = local(e);
        if (dragging) {
          if (Math.abs(pt.x - downX) > 3) moved = true;
          this.sel.b = this.sOf(pt.x);
        }
        if (inPlot(pt)) {
          const s = this.sOf(pt.x);
          this.hoverS = s;
          const e0 = PYR.course.eleAt({ step: this.profile.step, n: this.profile.n - 1, ele: this.profile.ele }, s);
          const rows = [
            { value: U.fmt(e0, 0) + ' m', label: 'altitude' },
            { value: U.fmt(this.gradeAt(s) * 100, 1) + ' %', label: 'pente' },
          ];
          if (this.opts.extraTip) rows.push(...this.opts.extraTip(s));
          this.tip.show(pt.x, pt.y, 'km ' + U.fmt(s / 1000, 2), rows);
          if (this.opts.onHover) this.opts.onHover(s);
        } else {
          this.hoverS = null; this.tip.hide();
          if (this.opts.onHover) this.opts.onHover(null);
        }
        this.surface.request();
      });
      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        try { c.releasePointerCapture(e.pointerId); } catch (err) { /* déjà relâché */ }
        const a = Math.min(this.sel.a, this.sel.b), b = Math.max(this.sel.a, this.sel.b);
        if (!moved || b - a < this.profile.length * 0.004) { this.sel = null; this.surface.request(); if (this.opts.onSelect) this.opts.onSelect(null); return; }
        this.sel = { a, b };
        this.surface.request();
        if (this.opts.onSelect) this.opts.onSelect({ a, b });
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('pointerleave', () => {
        if (dragging) return;
        this.hoverS = null; this.tip.hide(); this.surface.request();
        if (this.opts.onHover) this.opts.onHover(null);
      });
    }

    hitBand(pt) {
      if (!this.bandRects) return null;
      return this.bandRects.find((r) => pt.x >= r.x0 && pt.x <= r.x1 && pt.y >= r.y0 - 2 && pt.y <= r.y1 + 2) || null;
    }
  }

  /* ======================================================================
   * Petits multiples synchronisés (résultats de l'optimisation)
   * ==================================================================== */
  /** Courbes ajoutées à un panneau, sur son échelle : `overlays` (liste) ou `overlay` (une seule). */
  const overlaysOf = (pn) => pn.overlays || (pn.overlay ? [pn.overlay] : []);

  class SeriesChart {
    /**
     * opts : {onHover(t|null)}
     * setData({n, x: 'dist'|'time', s: Float32Array (distance à chaque seconde), panels: [...]})
     * panel : {label, unit, color, area, values (Float32Array longueur n+1 ou n), fmt(v), refs: [{v, label, color, dash}], min, max,
     *          gradient : [{v, color}] par valeur décroissante — la courbe change de couleur avec sa valeur (deux paliers à la même valeur : arête vive),
     *          overlay | overlays: [{label, color, values, fmt(v), dash}] — courbes en plus sur la même échelle (pointillé
     *          par défaut, `dash: false` pour un trait plein), seriesLabel : nom de la courbe principale dans l'infobulle}
     */
    constructor(container, opts) {
      this.opts = opts || {};
      this.box = container;
      this.data = null;
      this.hoverT = null;
      this.heights = {};        // hauteurs réglées par panneau (px de la zone de tracé), par id de panneau
      this.customPx = null;     // hauteurs effectives quand au moins un panneau est réglé (sinon : répartition par poids)
      this.titleHits = [];      // zones des titres de panneaux (double clic : réglage)
      this.surface = new Surface(container, (ctx, w, h) => this.draw(ctx, w, h));
      this.tip = makeTip(container);
      this.bindEvents();
      this.zoom = new ZoomView(this);
    }

    setData(d) {
      // un autre calcul : même vue si c'est le même parcours (même étendue), sinon vue d'ensemble
      if (!d || !this.data || d.sEnd !== this.data.sEnd) this.zoom.reset();
      if (d) d.panels.forEach((pn, i) => { if (!pn.id) pn.id = 'p' + i; });
      this.data = d;
      this.fitHeight();
      this.surface.request();
    }

    /* ----- hauteurs des panneaux ----- */
    /** Hauteur nominale de l'ensemble (celle de la feuille de style) : sert de base à la répartition par poids. */
    static get BASE_H() { return 430; }
    static get GEOM() { return { t: 2, b: 20, titleH: 15, gap: 8 }; }

    /** Hauteur de tracé par défaut de chaque panneau (px) : l'ensemble nominal réparti selon les poids. */
    defaultHeights() {
      const d = this.data, g = SeriesChart.GEOM, out = {};
      if (!d) return out;
      const np = d.panels.length, sumW = d.panels.reduce((a, pn) => a + (pn.weight || 1), 0);
      const avail = SeriesChart.BASE_H - g.t - g.b - np * g.titleH - (np - 1) * g.gap;
      for (const pn of d.panels) out[pn.id] = Math.round(Math.max(20, avail * (pn.weight || 1) / sumW));
      return out;
    }

    /** Panneaux avec leur hauteur effective et leur hauteur par défaut : pour la fenêtre de réglage. */
    panelInfo() {
      const d = this.data;
      if (!d) return [];
      const def = this.defaultHeights();
      return d.panels.map((pn) => ({ id: pn.id, label: pn.label, unit: pn.unit, def: def[pn.id], px: this.heights[pn.id] > 0 ? this.heights[pn.id] : def[pn.id] }));
    }

    /** Hauteur totale du graphique (px) si les panneaux avaient ces hauteurs de tracé. */
    totalHeight(px) {
      const d = this.data, g = SeriesChart.GEOM;
      if (!d) return 0;
      const np = d.panels.length;
      return Math.round(g.t + g.b + (np - 1) * g.gap + d.panels.reduce((a, pn) => a + g.titleH + px[pn.id], 0));
    }

    /** map : id de panneau → hauteur de tracé (px) ; un panneau absent garde sa hauteur par défaut. */
    setHeights(map) {
      this.heights = map || {};
      this.fitHeight();
      this.surface.request();
    }

    /** Dès qu'un panneau est réglé, le graphique prend la somme des hauteurs ; sinon la hauteur de la feuille de style. */
    fitHeight() {
      const d = this.data;
      if (!d || !d.panels.some((pn) => this.heights[pn.id] > 0)) { this.customPx = null; this.box.style.height = ''; return; }
      const def = this.defaultHeights(), px = {};
      for (const pn of d.panels) px[pn.id] = this.heights[pn.id] > 0 ? this.heights[pn.id] : def[pn.id];
      this.customPx = px;
      this.box.style.height = this.totalHeight(px) + 'px';
    }
    /** Tronçons exportés à repérer sur tous les panneaux : [{ t0, t1 (s), label }] ; null pour effacer.
     * editor : { onMove(k, s), onAdd(s), onRemove(k) } rend les limites modifiables (k : n° de la limite, début du tronçon k ; s : distance en m) :
     * glisser une limite la déplace, double clic dans le graphique en ajoute une, double clic sur une limite la supprime. */
    setSegments(list, editor) {
      this.segments = list && list.length ? list : null;
      this.segEditor = this.segments && editor ? editor : null;
      if (!this.segEditor) { this.segCursor = ''; this.surface.canvas.style.cursor = ''; }
      this.surface.request();
    }
    setXMode(m) { if (this.data) { this.data.x = m; this.surface.request(); } }
    setHover(t) { this.hoverT = t; this.surface.request(); }

    /** Abscisse (pixels) d'une fraction f de l'étendue complète de l'axe des x. */
    xOfF(f) { return this.L.l + ((f - this.zoom.a) / this.zoom.span) * this.L.pw; }

    xOfT(t) {
      const d = this.data;
      return this.xOfF(d.x === 'time' ? t / d.tEnd : sAt(d.s, t) / d.sEnd);
    }

    tOfX(x) {
      const d = this.data, L = this.L;
      const f = this.zoom.a + U.clamp((x - L.l) / L.pw, 0, 1) * this.zoom.span;
      if (d.x === 'time') return f * d.tEnd;
      const target = f * d.sEnd;
      // recherche dichotomique dans s (croissant)
      let lo = 0, hi = d.s.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (d.s[m] < target) lo = m; else hi = m; }
      const span = d.s[hi] - d.s[lo];
      return lo + (span > 0 ? (target - d.s[lo]) / span : 0);
    }

    draw(ctx, w, h) {
      const T = theme();
      const d = this.data;
      emptyMessage(this.box, d ? '' : 'Lance le calcul de la stratégie pour afficher la puissance, la vitesse et le W′ seconde par seconde.');
      if (!d) return;
      const g0 = SeriesChart.GEOM;
      const L = this.L = { l: 50, r: 12, t: g0.t, b: g0.b, pw: w - 62 };
      const np = d.panels.length, gap = g0.gap, titleH = g0.titleH;
      this.titleHits = [];
      const sumW = d.panels.reduce((a, pn) => a + (pn.weight || 1), 0);
      const avail = h - L.t - L.b - np * titleH - (np - 1) * gap;
      ctx.font = T.font;
      let cursor = L.t;
      const cols = Math.max(1, Math.floor(L.pw));
      // index de seconde à chaque bord de colonne
      const colT = new Float64Array(cols + 1);
      for (let c = 0; c <= cols; c++) colT[c] = this.tOfX(L.l + c);
      this.panelBoxes = [];

      d.panels.forEach((pn) => {
        const titleTop = cursor;
        const top = cursor + titleH;
        const ph = this.customPx ? this.customPx[pn.id] : Math.max(20, avail * (pn.weight || 1) / sumW);
        cursor = top + ph + gap;
        const vals = pn.values;
        const nv = vals.length;
        // agrégation par colonne : moyenne, min, max
        const mean = new Float32Array(cols), vmin = new Float32Array(cols), vmax = new Float32Array(cols);
        const ovs = overlaysOf(pn), omeans = ovs.map(() => new Float32Array(cols));
        let gmin = Infinity, gmax = -Infinity;
        for (let c = 0; c < cols; c++) {
          let a = Math.floor(colT[c]), b = Math.max(a + 1, Math.floor(colT[c + 1]));
          const a0 = a, b0 = b;
          a = U.clamp(a, 0, nv - 1); b = U.clamp(b, a + 1, nv);
          let s = 0, mn = Infinity, mx = -Infinity;
          for (let i = a; i < b; i++) { const v = vals[i]; s += v; if (v < mn) mn = v; if (v > mx) mx = v; }
          mean[c] = s / (b - a); vmin[c] = mn; vmax[c] = mx;
          if (mn < gmin) gmin = mn;
          if (mx > gmax) gmax = mx;
          ovs.forEach((o, k) => {
            const ov = o.values, oa = U.clamp(a0, 0, ov.length - 1), ob = U.clamp(b0, oa + 1, ov.length);
            let so = 0;
            for (let i = oa; i < ob; i++) so += ov[i];
            const m = omeans[k][c] = so / (ob - oa);
            if (m < gmin) gmin = m;
            if (m > gmax) gmax = m;
          });
        }
        let lo = pn.min !== undefined ? pn.min : gmin, hi = pn.max !== undefined ? pn.max : gmax;
        if (pn.refs) for (const r of pn.refs) { if (r.v > hi) hi = r.v; }
        if (!(hi > lo)) hi = lo + 1;
        if (pn.max === undefined) hi += (hi - lo) * 0.1;   // marge au-dessus des courbes
        if (pn.min === undefined) lo -= (hi - lo) * 0.05;
        const yt = ticks(lo, hi, Math.max(2, Math.floor(ph / 26)));
        hi = Math.max(hi, yt[yt.length - 1]);
        const yOf = (v) => top + ph - ((v - lo) / (hi - lo)) * ph;
        this.panelBoxes.push({ top, ph });

        // grille
        ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.fillStyle = T.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        for (const v of yt) {
          const y = Math.round(yOf(v)) + 0.5;
          ctx.beginPath(); ctx.moveTo(L.l, y); ctx.lineTo(L.l + L.pw, y); ctx.stroke();
          ctx.fillText(U.fmt(v, pn.tickDigits || 0), L.l - 5, y);
        }
        // titre du panneau (bandeau dédié, sans recouvrir les données)
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = T.ink2;
        ctx.font = '600 11px system-ui, sans-serif';
        const titleText = `${pn.label} (${pn.unit})`;
        ctx.fillText(titleText, L.l, titleTop + 1);
        this.titleHits.push({ id: pn.id, x0: L.l - 2, x1: L.l + ctx.measureText(titleText).width + 4, y0: titleTop, y1: titleTop + titleH });
        ctx.font = T.font;

        // tronçons exportés : un sur deux teinté
        if (this.segments) {
          ctx.fillStyle = 'rgba(142, 68, 173, 0.13)';
          this.segments.forEach((sg, k) => {
            if (k % 2) return;
            const x0 = Math.max(L.l, this.xOfT(sg.t0)), x1 = Math.min(L.l + L.pw, this.xOfT(sg.t1));
            if (x1 > x0) ctx.fillRect(x0, top, x1 - x0, ph);
          });
        }
        // courbe colorée selon sa valeur : dégradé vertical dont les paliers sont placés à leurs valeurs
        let ink = pn.color;
        if (pn.gradient) {
          ink = ctx.createLinearGradient(0, top, 0, top + ph);
          for (const g of pn.gradient) ink.addColorStop(U.clamp((hi - g.v) / (hi - lo), 0, 1), g.color);
        }
        // bande min–max (lavis) + ligne moyenne ; une aire part de zéro quand l'axe passe sous zéro
        ctx.fillStyle = ink; ctx.globalAlpha = pn.area ? (pn.gradient ? 0.22 : 0.14) : 0.12;
        if (pn.area) {
          const base = yOf(lo < 0 && hi > 0 ? 0 : lo);
          ctx.beginPath(); ctx.moveTo(L.l, base);
          for (let c = 0; c < cols; c++) ctx.lineTo(L.l + c + 0.5, yOf(mean[c]));
          ctx.lineTo(L.l + cols, base); ctx.closePath(); ctx.fill();
        } else {
          for (let c = 0; c < cols; c++) {
            const y0 = yOf(vmax[c]), y1 = yOf(vmin[c]);
            if (y1 - y0 > 1) ctx.fillRect(L.l + c, y0, 1, y1 - y0);
          }
        }
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        const trace = () => {
          ctx.beginPath();
          for (let c = 0; c < cols; c++) { const x = L.l + c + 0.5, y = yOf(mean[c]); if (c === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        };
        if (pn.gradient && lo < 0 && darkSurface(T.surface)) {
          // fond sombre : la partie négative (noire) est cernée d'un liseré clair pour rester lisible
          ctx.save();
          ctx.beginPath(); ctx.rect(L.l, yOf(0), L.pw, top + ph - yOf(0) + 2); ctx.clip();
          trace(); ctx.lineWidth = 4.5; ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'; ctx.stroke();
          ctx.restore(); ctx.lineWidth = 2;
        }
        trace(); ctx.strokeStyle = ink; ctx.stroke();
        ovs.forEach((o, k) => {
          const dashed = o.dash !== false;     // pointillé par défaut ; `dash: false` pour un trait plein
          ctx.strokeStyle = o.color || T.ink2; ctx.lineWidth = dashed ? 1.5 : 2; ctx.setLineDash(dashed ? [5, 4] : []);
          ctx.beginPath();
          for (let c = 0; c < cols; c++) { const x = L.l + c + 0.5, y = yOf(omeans[k][c]); if (c === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
          ctx.stroke();
          ctx.setLineDash([]);
        });

        // lignes de référence (PC…)
        if (pn.refs) {
          for (const r of pn.refs) {
            const y = Math.round(yOf(r.v)) + 0.5;
            ctx.strokeStyle = r.color || T.ink2; ctx.lineWidth = 1; ctx.setLineDash(r.dash ? [4, 3] : []);
            ctx.beginPath(); ctx.moveTo(L.l, y); ctx.lineTo(L.l + L.pw, y); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = r.color || T.ink2; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
            ctx.fillText(r.label, L.l + L.pw - 2, y - 2);
          }
        }
      });

      // tronçons exportés : limites en pointillés, puissance cible de chaque tronçon en haut du premier panneau
      if (this.segments && this.panelBoxes.length) {
        const pb0 = this.panelBoxes[0], pbN = this.panelBoxes[this.panelBoxes.length - 1];
        ctx.save();
        ctx.beginPath(); ctx.rect(L.l, 0, L.pw, h); ctx.clip();
        ctx.strokeStyle = 'rgba(142, 68, 173, 0.75)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.font = '600 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (const sg of this.segments) {
          const xa = this.xOfT(sg.t0), xb = this.xOfT(sg.t1);
          if (xb < L.l || xa > L.l + L.pw) continue;
          const x = Math.round(xa) + 0.5;
          ctx.beginPath(); ctx.moveTo(x, pb0.top); ctx.lineTo(x, pbN.top + pbN.ph); ctx.stroke();
          const vx0 = Math.max(xa, L.l), vx1 = Math.min(xb, L.l + L.pw);
          if (sg.label && vx1 - vx0 > ctx.measureText(sg.label).width + 6) {
            ctx.fillStyle = T.ink; ctx.fillText(sg.label, (vx0 + vx1) / 2, pb0.top + 2);
          }
        }
        if (this.segEditor) { // poignées des limites, en bas du dernier panneau
          ctx.setLineDash([]);
          this.segments.forEach((sg, k) => {
            const xa = this.xOfT(sg.t0);
            if (!k || xa < L.l || xa > L.l + L.pw) return;
            ctx.beginPath(); ctx.arc(Math.round(xa) + 0.5, pbN.top + pbN.ph - 7, 5, 0, Math.PI * 2);
            ctx.fillStyle = '#8e44ad'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = T.surface; ctx.stroke();
          });
        }
        ctx.restore();
        ctx.font = T.font;
      }

      // axe des x
      const bottom = cursor - gap;
      ctx.strokeStyle = T.axis; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L.l, bottom + 0.5); ctx.lineTo(L.l + L.pw, bottom + 0.5); ctx.stroke();
      ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      if (d.x === 'time') {
        const t0 = this.zoom.a * d.tEnd, t1 = this.zoom.b * d.tEnd;
        const st = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].find((s) => (t1 - t0) / s <= Math.max(2, L.pw / 80)) || 7200;
        for (let t = Math.ceil(t0 / st) * st; t <= t1 + 1e-6; t += st) ctx.fillText(U.fmtClock(t), this.xOfF(t / d.tEnd), bottom + 5);
      } else {
        const xt = rangeTicks(this.zoom.a * d.sEnd / 1000, this.zoom.b * d.sEnd / 1000, Math.floor(L.pw / 70));
        for (const v of xt.values) ctx.fillText(U.fmt(v, xt.digits) + ' km', this.xOfF(v * 1000 / d.sEnd), bottom + 5);
      }

      // réticule
      if (this.hoverT !== null && this.hoverT !== undefined) {
        const x = Math.round(this.xOfT(this.hoverT)) + 0.5;
        if (x >= L.l && x <= L.l + L.pw) {
          ctx.strokeStyle = T.ink2; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, L.t + 15); ctx.lineTo(x, bottom); ctx.stroke();
        }
      }
    }

    /** Titre de panneau sous le pointeur (pixels du canvas), ou null. */
    titleAt(x, y) {
      return this.titleHits.find((t) => x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1) || null;
    }

    bindEvents() {
      const c = this.surface.canvas;
      // double clic sur le titre d'un panneau : réglage de sa hauteur. Enregistré avant le zoom (qui réinitialise la vue
      // au double clic) : le titre prend le double clic pour lui.
      c.addEventListener('dblclick', (e) => {
        if (!this.opts.onTitleDblClick) return;
        const r = c.getBoundingClientRect();
        const hit = this.titleAt(e.clientX - r.left, e.clientY - r.top);
        if (!hit) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        this.opts.onTitleDblClick(hit.id);
      });
      // limites de tronçons modifiables (enregistré avant le zoom : une limite saisie ne déplace pas la vue)
      const segHit = (x) => {
        let best = -1, bd = 6;
        if (this.segments && this.L) this.segments.forEach((sg, k) => { const dx = Math.abs(this.xOfT(sg.t0) - x); if (k && dx < bd) { bd = dx; best = k; } });
        return best;
      };
      const sOfX = (x) => sAt(this.data.s, this.tOfX(x));
      const xOf = (e) => e.clientX - c.getBoundingClientRect().left;
      let drag = null;
      c.addEventListener('pointerdown', (e) => {
        if (!this.segEditor || !this.data || !this.L || e.button !== 0) return;
        const k = segHit(xOf(e));
        if (k < 1) return;
        drag = { k };
        try { c.setPointerCapture(e.pointerId); } catch (err) { /* pointeur déjà relâché */ }
        e.preventDefault();
        e.stopImmediatePropagation();
      }, true);
      c.addEventListener('pointermove', (e) => {
        if (!this.segEditor || !this.data || !this.L) return;
        if (drag) { this.segEditor.onMove(drag.k, Math.round(sOfX(xOf(e)))); e.stopImmediatePropagation(); return; }
        this.segCursor = segHit(xOf(e)) > 0 ? 'col-resize' : '';
        c.style.cursor = this.segCursor;
      }, true);
      const endDrag = (e) => { if (drag) { drag = null; try { c.releasePointerCapture(e.pointerId); } catch (err) { /* déjà relâché */ } } };
      c.addEventListener('pointerup', endDrag, true);
      c.addEventListener('pointercancel', endDrag, true);
      c.addEventListener('dblclick', (e) => {
        if (!this.segEditor || !this.data || !this.L) return;
        const x = xOf(e);
        if (x < this.L.l || x > this.L.l + this.L.pw) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        const k = segHit(x);
        if (k > 0) this.segEditor.onRemove(k); else this.segEditor.onAdd(Math.round(sOfX(x)));
      });
      c.addEventListener('pointermove', (e) => {
        if (!this.data || !this.L) return;
        const r = c.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        if (this.opts.onTitleDblClick) {
          const over = !!this.titleAt(x, y);
          c.style.cursor = over ? 'pointer' : (this.segCursor || '');
          c.title = over ? 'Double-clique pour régler la hauteur du graphique' : '';
        }
        if (x < this.L.l || x > this.L.l + this.L.pw) { this.leave(); return; }
        const t = U.clamp(Math.round(this.tOfX(x)), 0, this.data.n - 1);
        this.hoverT = t;
        const d = this.data;
        const rows = [];
        for (const pn of d.panels) {
          rows.push({ color: pn.color, value: pn.fmt(pn.values[Math.min(t, pn.values.length - 1)]), label: (pn.seriesLabel || pn.label).toLowerCase() });
          for (const o of overlaysOf(pn)) rows.push({ color: o.color || undefined, value: o.fmt(o.values[Math.min(t, o.values.length - 1)]), label: o.label.toLowerCase() });
        }
        if (d.extraRows) rows.push(...d.extraRows(t));
        this.tip.show(x, y, `${U.fmtClock(t)} · km ${U.fmt(d.s[t] / 1000, 2)}`, rows);
        this.surface.request();
        if (this.opts.onHover) this.opts.onHover(t);
      });
      c.addEventListener('pointerleave', () => this.leave());
    }

    leave() {
      this.hoverT = null; this.tip.hide(); this.surface.request();
      if (this.opts.onHover) this.opts.onHover(null);
    }
  }

  function sAt(s, t) {
    const i = Math.floor(t);
    if (i >= s.length - 1) return s[s.length - 1];
    return s[i] + (s[i + 1] - s[i]) * (t - i);
  }

  /* ======================================================================
   * Courbe de puissance record
   * ==================================================================== */
  class CurveChart {
    /**
     * opts : {scale: 'log' (défaut) | 'lin' : échelle des durées en abscisse ; yscale : idem pour les puissances en ordonnée}
     * Échelle logarithmique : 1 s à 5 h, le sprint et l'endurance restent lisibles. Échelle linéaire : la vraie échelle de
     * temps, de 0 à 5 h ; le sprint y tient en quelques pixels, d'où le zoom (boutons, glisser, Ctrl + molette).
     */
    constructor(container, opts) {
      this.opts = Object.assign({ zoomWheel: 'ctrl' }, opts);
      this.scale = this.opts.scale === 'lin' ? 'lin' : 'log';
      this.yscale = this.opts.yscale === 'lin' ? 'lin' : 'log';   // puissances : logarithmique ou linéaire à partir de 0
      this.box = container;
      this.data = null;
      this.hoverD = null;
      this.surface = new Surface(container, (ctx, w, h) => this.draw(ctx, w, h));
      this.tip = makeTip(container);
      this.bind();
      this.zoom = new ZoomView(this);
    }

    /**
     * data : {durations, user: [W|null], curve: fn(d), cp (CP2), cp1 (optionnel), pmax (optionnel), w0 (W′, J), ftp,
     *         weight (kg, optionnel : axe W/kg), zones: [{id, label, lo, hi (W), color}],
     *         markers: [{s (durée), p (W), title, sub, color}],
     *         labels (optionnel) : {dot, line, model (légende), rec, est, modelTip (bulle)}}
     */
    setData(d) { this.data = d; this.surface.request(); }

    /** Modèle de puissance tenable pendant s secondes : Morton à trois paramètres (CP2, W′, Pmax), ou PC/W′ sans Pmax. */
    modelAt(s) {
      const d = this.data;
      return d.pmax > d.cp ? d.cp + d.w0 / (s + d.w0 / (d.pmax - d.cp)) : d.cp + d.w0 / s;
    }

    /** 'log' ou 'lin' ; la vue revient à l'ensemble de l'axe. */
    setScale(mode) {
      this.scale = mode === 'lin' ? 'lin' : 'log';
      this.zoom.reset();
      this.hoverD = null;
      this.tip.hide();
      this.surface.request();
    }

    /** Échelle des puissances en ordonnée : 'log' ou 'lin' (linéaire, de 0 à la puissance maximale). */
    setYScale(mode) {
      this.yscale = mode === 'lin' ? 'lin' : 'log';
      this.surface.request();
    }

    /** Étendue des durées (s) de l'axe des x. */
    static get RANGE() { return { dmin: 1, dmax: 18000 }; }

    /** Fraction (0–1) de l'axe complet des x pour une durée s, selon l'échelle. */
    fracOf(s) {
      const { dmin, dmax } = CurveChart.RANGE;
      return this.scale === 'lin' ? U.clamp(s, 0, dmax) / dmax : Math.log(Math.max(s, dmin) / dmin) / Math.log(dmax / dmin);
    }

    /** Durée (s) pour une fraction de l'axe complet. */
    secOf(f) {
      const { dmin, dmax } = CurveChart.RANGE;
      return this.scale === 'lin' ? f * dmax : dmin * Math.exp(f * Math.log(dmax / dmin));
    }

    /** Durée (s) sous l'abscisse x (pixels du canvas), vue zoomée comprise. */
    secAtX(x) {
      const L = this.L, z = this.zoom;
      return this.secOf(z.a + U.clamp((x - L.l) / L.pw, 0, 1) * z.span);
    }

    /** Durée en texte : « 45 s », « 5 min », « 1 h 30 ». */
    static durationText(s) {
      s = Math.round(s);
      if (s < 60) return `${s} s`;
      if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
      const m = Math.round((s % 3600) / 60);
      return m ? `${Math.floor(s / 3600)} h ${String(m).padStart(2, '0')}` : `${s / 3600} h`;
    }

    draw(ctx, w, h) {
      const T = theme();
      const d = this.data;
      if (!d) return;
      const kg = d.weight > 0 ? d.weight : 0;
      const L = this.L = { l: 46, r: kg ? 46 : 14, t: 26, b: 22 };
      L.pw = w - L.l - L.r; L.ph = h - L.t - L.b;
      const dmin = 1, dmax = CurveChart.RANGE.dmax;
      const zoom = this.zoom;
      const xOf = (s) => L.l + ((this.fracOf(s) - zoom.a) / zoom.span) * L.pw;
      this.xOf = xOf;
      const lin = this.scale === 'lin';
      // puissance : échelle logarithmique (les zones restent lisibles malgré l'écart entre sprint et endurance) ou linéaire à partir de 0
      const ylin = this.yscale === 'lin';
      const hi = Math.max(d.curve(1), ...d.user.filter(Boolean)) * 1.05;
      const pmin = ylin ? 0 : Math.max(20, 0.3 * (d.ftp || 200));
      const yOf = ylin
        ? (p) => L.t + L.ph - (Math.max(p, 0) / hi) * L.ph
        : (p) => L.t + L.ph - (Math.log(Math.max(p, pmin) / pmin) / Math.log(hi / pmin)) * L.ph;
      this.yOf = yOf;
      const logTicks = (cand, lo, up, gap, k) => { // cand : valeurs, k : watts par unité (1 en W, poids en W/kg)
        const out = [];
        let last = Infinity;
        for (const v of cand) {
          if (v < lo || v > up) continue;
          const y = yOf(v * k);
          if (last - y >= gap || last === Infinity) { out.push(v); last = y; }
        }
        return out;
      };
      const yCount = Math.max(3, Math.floor(L.ph / 34));
      const yt = ylin ? ticks(0, hi, yCount)
        : logTicks([20, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1200, 1500, 2000, 2500, 3000], pmin, hi, 24, 1);
      ctx.font = T.font;

      // zones de puissance : bandes horizontales sous la courbe
      const narrow = w < 520, taken = []; // taken : emplacements des étiquettes de zones, à éviter par les repères
      if (d.zones) {
        d.zones.forEach((z, i) => {
          if (z.lo >= hi || z.hi <= pmin) return;
          const y0 = yOf(Math.min(z.hi, hi)), y1 = yOf(z.lo);
          ctx.globalAlpha = 0.2; ctx.fillStyle = z.color;
          ctx.fillRect(L.l, y0, L.pw, y1 - y0);
          ctx.globalAlpha = 1;
          if (y1 - y0 < 13) return;
          const last = i === d.zones.length - 1;
          ctx.textBaseline = 'middle'; ctx.textAlign = last ? 'right' : 'left';
          const x = last ? L.l + L.pw - 6 : L.l + 6, y = (y0 + y1) / 2;
          const txt = `${z.id} ${z.label}`;
          ctx.fillStyle = T.ink; ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
          ctx.fillText(txt, x, y);
          const wTxt = ctx.measureText(txt).width;
          ctx.font = T.font; ctx.fillStyle = T.ink2;
          let total = wTxt;
          if (!narrow) {
            const range = last ? `> ${U.fmt(z.lo, 0)} W` : `${U.fmt(z.lo, 0)}–${U.fmt(z.hi, 0)} W`;
            ctx.fillText(range, last ? x - wTxt - 8 : x + wTxt + 8, y);
            total += 8 + ctx.measureText(range).width;
          }
          taken.push({ x: last ? x - total : x, y: y - 8, w: total, h: 16 });
        });
      }

      ctx.strokeStyle = T.grid; ctx.fillStyle = T.muted; ctx.lineWidth = 1; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (const v of yt) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(L.l, y); ctx.lineTo(L.l + L.pw, y); ctx.stroke();
        ctx.fillText(U.fmt(v, 0), L.l - 5, y);
      }
      if (kg) { // axe de droite : W/kg
        ctx.textAlign = 'left';
        const kt = ylin ? ticks(0, hi / kg, yCount) : logTicks([0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 30, 40], pmin / kg, hi / kg, 24, kg);
        for (const v of kt) ctx.fillText(U.fmt(v, v % 1 ? 1 : 0), L.l + L.pw + 5, yOf(v * kg));
        ctx.textAlign = 'right'; ctx.fillText('W/kg', w - 2, L.t - 10);
        ctx.fillText('W', L.l - 5, L.t - 10);
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.strokeStyle = T.axis;
      ctx.beginPath(); ctx.moveTo(L.l, L.t + L.ph + 0.5); ctx.lineTo(L.l + L.pw, L.t + L.ph + 0.5); ctx.stroke();
      ctx.fillStyle = T.muted;
      // graduations : repères fixes en échelle logarithmique ; pas « rond » (1 s … 3 h) selon la vue en échelle linéaire
      let xt;
      if (lin) {
        const s0 = this.secAtX(L.l), s1 = this.secAtX(L.l + L.pw);
        const maxTicks = Math.max(2, Math.floor(L.pw / 74));
        const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800].find((x) => (s1 - s0) / x <= maxTicks) || 10800;
        xt = [];
        for (let s = Math.ceil(Math.max(s0, 0.5) / step) * step; s <= s1 + 1e-6; s += step) xt.push([s, CurveChart.durationText(s)]);
        ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
        for (const [s] of xt) { const x = Math.round(xOf(s)) + 0.5; ctx.beginPath(); ctx.moveTo(x, L.t); ctx.lineTo(x, L.t + L.ph); ctx.stroke(); }
        ctx.fillStyle = T.muted;
      } else {
        xt = [[1, '1 s'], [5, '5 s'], [15, '15 s'], [60, '1 min'], [300, '5 min'], [1200, '20 min'], [3600, '1 h'], [10800, '3 h'], [18000, '5 h']];
      }
      for (const [s, lab] of xt) {
        const x = xOf(s);
        if (x < L.l - 4 || x > L.l + L.pw + 4) continue;
        ctx.fillText(lab, Math.min(Math.max(x, L.l + 10), L.l + L.pw - 12), L.t + L.ph + 5);
      }

      // tout ce qui suit est écrêté à la zone de tracé (vue zoomée)
      ctx.save();
      ctx.beginPath(); ctx.rect(L.l, L.t - 2, L.pw, L.ph + 4); ctx.clip();

      // modèle CP1, CP2, W′, Pmax (Morton : valable de la seconde à plusieurs heures grâce à Pmax)
      ctx.strokeStyle = T.s2; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      let first = true;
      for (let px = L.l; px <= L.l + L.pw; px += 2) {
        const s = this.secAtX(px);
        if (s < (d.pmax > d.cp ? 1 : 60)) continue;
        const p = this.modelAt(s);
        if (p > hi) continue;
        const y = yOf(p);
        if (first) { ctx.moveTo(px, y); first = false; } else ctx.lineTo(px, y);
      }
      ctx.stroke();
      // courbe estimée
      ctx.strokeStyle = T.s1; ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let px = L.l; px <= L.l + L.pw; px += 2) {
        const y = yOf(d.curve(Math.max(this.secAtX(px), dmin)));
        if (px === L.l) ctx.moveTo(px, y); else ctx.lineTo(px, y);
      }
      ctx.stroke();
      // CP2 (puissance critique) et CP1 (premier seuil) en pointillés
      const hline = (p, label) => {
        const y = Math.round(yOf(p)) + 0.5;
        ctx.strokeStyle = T.ink2; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(L.l, y); ctx.lineTo(L.l + L.pw, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(label + ' ' + U.fmt(p, 0) + ' W', L.l + 4, y - 2);
      };
      hline(d.cp, d.cp1 > 0 ? 'CP2' : 'PC');
      if (d.cp1 > 0 && d.cp1 < d.cp) hline(d.cp1, 'CP1');
      // records saisis
      d.durations.forEach((s, i) => {
        const p = d.user[i];
        if (!p) return;
        ctx.beginPath(); ctx.arc(xOf(s), yOf(p), 4.5, 0, Math.PI * 2);
        ctx.fillStyle = T.s1; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = T.surface; ctx.stroke();
      });
      // efforts de référence (15 s, 5 min, 20 min, FTP) : valeur et niveau
      if (d.markers) this.drawMarkers(ctx, T, d.markers, L, xOf, yOf, taken);
      ctx.restore();
      // légende (data.labels la remplace : autre usage du graphique, comme l'enveloppe des sorties importées)
      const lb = d.labels;
      const items = lb ? [['dot', T.s1, lb.dot], ['line', T.s1, lb.line], ['line', T.s2, lb.model]]
        : narrow ? [['dot', T.s1, 'Record'], ['line', T.s1, 'Courbe'], ['line', T.s2, 'CP1/CP2/W′/Pmax']]
          : [['dot', T.s1, 'Record saisi'], ['line', T.s1, 'Courbe (records + estimation)'], ['line', T.s2, 'Modèle CP1, CP2, W′, Pmax']];
      let x = narrow ? L.l : L.l + 14;
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      for (const [kind, col, lab] of items) {
        if (kind === 'dot') { ctx.beginPath(); ctx.arc(x + 5, 10, 4, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); }
        else { ctx.fillStyle = col; ctx.fillRect(x, 9, 14, 2); }
        ctx.fillStyle = T.ink2; ctx.fillText(lab, x + 18, 10);
        x += 18 + ctx.measureText(lab).width + 14;
      }
      // survol
      if (this.hoverD) {
        const xx = Math.round(xOf(this.hoverD)) + 0.5;
        if (xx >= L.l && xx <= L.l + L.pw) {
          ctx.strokeStyle = T.ink2; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(xx, L.t); ctx.lineTo(xx, L.t + L.ph); ctx.stroke();
        }
      }
    }

    /** Repères sur la courbe, avec une étiquette (valeur, niveau) placée là où elle ne gêne pas les autres. */
    drawMarkers(ctx, T, markers, L, xOf, yOf, taken) {
      const placed = (taken || []).slice();
      const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      const bold = '650 12px system-ui, -apple-system, "Segoe UI", sans-serif';
      for (const m of markers) {
        const x = xOf(m.s), y = yOf(m.p);
        if (x < L.l || x > L.l + L.pw) continue;   // hors de la vue zoomée
        ctx.font = bold;
        const w1 = ctx.measureText(m.title).width;
        ctx.font = T.font;
        const w2 = ctx.measureText(m.sub).width;
        const bw = Math.max(w1, w2) + 4, bh = 30;
        // positions essayées : au-dessus à droite, au-dessus à gauche, en dessous à droite, en dessous à gauche
        const tries = [];
        for (let k = 0; k < 4; k++) tries.push([8, -bh - 8 - k * (bh + 4)], [-bw - 8, -bh - 8 - k * (bh + 4)]);
        for (let k = 0; k < 4; k++) tries.push([8, 8 + k * (bh + 4)], [-bw - 8, 8 + k * (bh + 4)]);
        let box = null;
        for (const [dx, dy] of tries) {
          const b = { x: x + dx, y: y + dy, w: bw, h: bh };
          if (b.x < L.l + 2 || b.x + b.w > L.l + L.pw - 2 || b.y < L.t + 2 || b.y + b.h > L.t + L.ph - 2) continue;
          if (placed.some((o) => hit(b, o))) continue;
          box = b; break;
        }
        // échelle linéaire non zoomée : les repères se touchent, une étiquette sans place est omise (le point reste)
        const crowded = !box && this.scale === 'lin';
        if (!box) box = { x: Math.min(Math.max(x + 8, L.l + 2), L.l + L.pw - bw - 2), y: Math.min(Math.max(y - bh - 8, L.t + 2), L.t + L.ph - bh - 2), w: bw, h: bh };
        if (!crowded) placed.push(box);
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = m.color; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = T.surface; ctx.stroke();
        if (crowded) continue;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = T.surface;
        ctx.font = bold;
        ctx.strokeText(m.title, box.x, box.y); ctx.fillStyle = T.ink; ctx.fillText(m.title, box.x, box.y);
        ctx.font = T.font;
        ctx.strokeText(m.sub, box.x, box.y + 15); ctx.fillStyle = m.color; ctx.fillText(m.sub, box.x, box.y + 15);
      }
    }

    bind() {
      const c = this.surface.canvas;
      c.addEventListener('pointermove', (e) => {
        if (!this.data || !this.L) return;
        const r = c.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        const L = this.L;
        if (x < L.l || x > L.l + L.pw) { this.hoverD = null; this.tip.hide(); this.surface.request(); return; }
        const s = this.secAtX(x);
        const d = this.data;
        // durée de la liste la plus proche, à l'écran (en échelle linéaire : seulement à moins de 9 px, sinon la durée
        // sous le curseur, lue sur la courbe estimée)
        let bi = 0;
        d.durations.forEach((q, i) => { if (Math.abs(this.xOf(q) - x) < Math.abs(this.xOf(d.durations[bi]) - x)) bi = i; });
        const near = Math.abs(this.xOf(d.durations[bi]) - x) <= 9;
        const exact = this.scale === 'lin' && !near;
        const q = exact ? Math.max(s, 1) : d.durations[bi];
        this.hoverD = q;
        const rows = [];
        const rec = exact ? null : d.user[bi];
        const p = rec || d.curve(q);
        const perKg = d.weight > 0 ? ` · ${U.fmt(p / d.weight, 2)} W/kg` : '';
        const lb = d.labels || {};
        rows.push({ color: this.theme().s1, value: U.fmt(p, 0) + ' W' + perKg, label: rec ? lb.rec || 'record' : lb.est || 'estimé' });
        if (q >= 60 || d.pmax > d.cp) rows.push({ color: this.theme().s2, value: U.fmt(this.modelAt(q), 0) + ' W', label: lb.modelTip || 'modèle CP1, CP2, W′, Pmax' });
        const z = d.zones && d.zones.find((zz) => p >= zz.lo && p < zz.hi);
        if (z) rows.push({ color: z.color, value: `${z.id} ${z.label}`, label: 'zone' });
        this.tip.show(x, y, exact ? CurveChart.durationText(q) : PYR.physio.durationLabel(q), rows);
        this.surface.request();
      });
      c.addEventListener('pointerleave', () => { this.hoverD = null; this.tip.hide(); this.surface.request(); });
    }

    theme() { return theme(); }
  }


  /* ======================================================================
   * Mode jeu (grand écran) : puissance en fonction de la durée, sous le profil d'élévation.
   *   - record de référence (la courbe du cycliste) et record du jour (forme du jour, chutes, fringale, chaleur) ;
   *   - meilleures moyennes de puissance de l'étape en cours, pour chaque durée déjà roulée ;
   *   - puissance disponible à partir de maintenant (ce qui reste de la courbe record après ce qui vient d'être roulé).
   * ==================================================================== */
  class RaceCurveChart {
    /** Durée maximale (s) de l'axe des x : 5 h. Les points sont calculés à chaque seconde de 1 s à cette durée. */
    static get MAX() { return 18000; }

    constructor(container) {
      this.box = container;
      this.data = null;
      this.hoverK = null;
      this.surface = new Surface(container, (ctx, w, h) => this.draw(ctx, w, h));
      this.tip = makeTip(container);
      const c = this.surface.canvas;
      c.addEventListener('pointermove', (e) => this.onMove(e));
      c.addEventListener('pointerleave', () => { this.hoverK = null; this.tip.hide(); this.surface.request(); });
    }

    /**
     * d : {xmax (s), durations: [1, 2, 3 … xmax] (un point par seconde), base: [W], day: [W], stage: [W|null], now: [W],
     *      cp (W), ftp (W)} — tableaux de même longueur.
     */
    setData(d) { this.data = d; this.surface.request(); }

    xOf(s) {
      const L = this.L, d = this.data;
      return L.l + (Math.log(Math.max(s, 1)) / Math.log(d.xmax)) * L.pw;
    }

    onMove(e) {
      const d = this.data, L = this.L;
      if (!d || !L) return;
      const r = this.surface.canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < L.l || x > L.l + L.pw) { this.hoverK = null; this.tip.hide(); this.surface.request(); return; }
      // durée sous le curseur, à la seconde près (abscisse logarithmique : la durée d'indice k est k + 1)
      const k = U.clamp(Math.round(Math.exp((x - L.l) / L.pw * Math.log(d.xmax))) - 1, 0, d.durations.length - 1);
      this.hoverK = k;
      const T = theme(), fmt = (p) => `${U.fmt(p, 0)} W`;
      const rows = [
        { color: T.s1, value: fmt(d.day[k]), label: 'record du jour' },
        { color: T.axis, value: fmt(d.base[k]), label: 'record de référence' },
        { color: T.s4, value: fmt(d.now[k]), label: 'disponible maintenant' },
      ];
      if (d.stage[k] !== null) rows.push({ color: T.s3, value: fmt(d.stage[k]), label: 'meilleure moyenne de l\'étape' });
      this.tip.show(x, y, RaceCurveChart.label(d.durations[k]), rows);
      this.surface.request();
    }

    /** Durée en texte : « 45 s », « 5 min », « 1 h 30 ». */
    static label(s) {
      if (s < 60) return `${s} s`;
      if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
      const m = Math.round((s % 3600) / 60);
      return m ? `${Math.floor(s / 3600)} h ${String(m).padStart(2, '0')}` : `${s / 3600} h`;
    }

    draw(ctx, w, h) {
      const T = theme(), d = this.data;
      if (!d) return;
      const L = this.L = { l: 44, r: 12, t: 20, b: 18 };
      L.pw = w - L.l - L.r; L.ph = h - L.t - L.b;
      const n = d.durations.length;
      const hi = Math.max(...d.base, ...d.day) * 1.05, pmin = Math.max(20, 0.35 * (d.ftp || 200));
      const yOf = (p) => L.t + L.ph - (Math.log(Math.max(p, pmin) / pmin) / Math.log(hi / pmin)) * L.ph;
      ctx.font = T.font; ctx.lineWidth = 1;
      // graduations de puissance (logarithmiques) et de durée
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      let last = Infinity;
      for (const v of [50, 75, 100, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1200, 1500, 2000]) {
        if (v < pmin || v > hi) continue;
        const y = yOf(v);
        if (last - y < 22) continue;
        last = y;
        ctx.strokeStyle = T.grid; ctx.beginPath(); ctx.moveTo(L.l, Math.round(y) + 0.5); ctx.lineTo(L.l + L.pw, Math.round(y) + 0.5); ctx.stroke();
        ctx.fillStyle = T.muted; ctx.fillText(String(v), L.l - 5, y);
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (const [s, lab] of [[1, '1 s'], [5, '5 s'], [15, '15 s'], [60, '1 min'], [300, '5 min'], [1200, '20 min'], [3600, '1 h'], [10800, '3 h'], [18000, '5 h']]) {
        if (s > d.xmax) continue;
        const x = this.xOf(s);
        ctx.strokeStyle = T.grid; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, L.t); ctx.lineTo(Math.round(x) + 0.5, L.t + L.ph); ctx.stroke();
        ctx.fillStyle = T.muted; ctx.fillText(lab, Math.min(Math.max(x, L.l + 10), L.l + L.pw - 12), L.t + L.ph + 3);
      }
      ctx.strokeStyle = T.axis; ctx.beginPath(); ctx.moveTo(L.l, L.t + L.ph + 0.5); ctx.lineTo(L.l + L.pw, L.t + L.ph + 0.5); ctx.stroke();

      ctx.save();
      ctx.beginPath(); ctx.rect(L.l, L.t - 2, L.pw, L.ph + 4); ctx.clip();
      const line = (vals, color, width, dash) => {
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.setLineDash(dash || []);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          if (vals[i] === null) continue;
          const x = this.xOf(d.durations[i]), y = yOf(vals[i]);
          if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
        }
        ctx.stroke(); ctx.setLineDash([]);
      };
      // PC
      if (d.cp) {
        const y = Math.round(yOf(d.cp)) + 0.5;
        ctx.strokeStyle = T.ink2; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(L.l, y); ctx.lineTo(L.l + L.pw, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`PC ${U.fmt(d.cp, 0)} W`, L.l + 4, y - 2);
      }
      line(d.base, T.axis, 1.5, [5, 3]);
      line(d.day, T.s1, 2.5);
      line(d.now, T.s4, 2, [2, 3]);
      line(d.stage, T.s3, 2.5);
      // repères sur la courbe de l'étape aux durées usuelles (la courbe elle-même a un point par seconde)
      for (const s of [1, 5, 15, 60, 300, 1200, 3600, 10800]) {
        const i = s - 1;
        if (i >= n || d.stage[i] === null) continue;
        ctx.beginPath(); ctx.arc(this.xOf(s), yOf(d.stage[i]), 3, 0, Math.PI * 2);
        ctx.fillStyle = T.s3; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = T.surface; ctx.stroke();
      }
      ctx.restore();
      // légende
      let x = L.l + 8;
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      for (const [col, lab, dash] of [[T.s1, 'Record du jour', 0], [T.axis, 'Record de référence', 1], [T.s4, 'Disponible maintenant', 2], [T.s3, 'Étape en cours (meilleures moyennes)', 0]]) {
        ctx.strokeStyle = col; ctx.lineWidth = dash === 1 ? 1.5 : 2.5; ctx.setLineDash(dash === 1 ? [5, 3] : dash === 2 ? [2, 3] : []);
        ctx.beginPath(); ctx.moveTo(x, 9); ctx.lineTo(x + 16, 9); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = T.ink2; ctx.fillText(lab, x + 21, 9);
        x += 21 + ctx.measureText(lab).width + 14;
      }
      if (this.hoverK !== null) {
        const xx = Math.round(this.xOf(d.durations[this.hoverK])) + 0.5;
        ctx.strokeStyle = T.ink2; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xx, L.t); ctx.lineTo(xx, L.t + L.ph); ctx.stroke();
      }
    }
  }

  /* ======================================================================
   * Météo le long du parcours : température et humidité, vent (de face / de dos), pluie et pression,
   * lues à l'heure estimée de passage en chaque point.
   * ==================================================================== */
  class WeatherChart {
    /** opts : {onHover(s|null)} */
    constructor(container, opts) {
      this.opts = opts || {};
      this.box = container;
      this.data = null;
      this.hoverI = -1;
      this.surface = new Surface(container, (ctx, w, h) => this.draw(ctx, w, h));
      this.tip = makeTip(container);
      this.bind();
      this.zoom = new ZoomView(this);
    }

    /**
     * d : {L (m), samples: [{s, T, rh, p, rain, ws, gust, head (m/s : > 0 de face), clock (epoch s)}], offset (décalage UTC, s)}
     */
    setData(d) {
      if (!d || !this.data || Math.abs(d.L - this.data.L) > 1) this.zoom.reset();
      this.data = d; this.hoverI = -1; this.surface.request();
    }

    clockText(epoch) {
      return new Date((epoch + (this.data.offset || 0)) * 1000).toISOString().slice(11, 16);
    }

    draw(ctx, w, h) {
      const T = theme();
      const d = this.data;
      if (!d || !d.samples || d.samples.length < 2) { emptyMessage(this.box, 'Récupère la météo pour la voir ici.'); return; }
      emptyMessage(this.box, '');
      const S = d.samples;
      const L = this.L = { l: 46, r: 46, t: 16, b: 34 };
      L.pw = w - L.l - L.r; L.ph = h - L.t - L.b;
      const gap = 16, strip = 42, panelH = (L.ph - 2 * gap - strip - 6) / 3;
      const z0 = this.zoom.a * d.L, z1 = this.zoom.b * d.L;   // partie visible du parcours (m)
      const xOf = (s) => L.l + ((s - z0) / (z1 - z0)) * L.pw;
      this.xOf = xOf;
      const inView = (s) => { const x = xOf(s); return x >= L.l - 30 && x <= L.l + L.pw + 30; };
      // les tracés ne débordent pas de la zone visible (les graduations, à gauche et à droite, restent hors du détourage)
      const clipped = (fn) => { ctx.save(); ctx.beginPath(); ctx.rect(L.l, 0, L.pw, h); ctx.clip(); fn(); ctx.restore(); };
      const yWind = L.t + panelH + gap, yStrip = yWind + panelH + 6;
      this.panels = [{ y0: L.t, h: panelH }, { y0: yWind, h: panelH }, { y0: yStrip + strip + gap, h: panelH }];
      this.strip = { y0: yStrip, h: strip };
      ctx.font = T.font;
      const kmh = (v) => v * 3.6;

      const axis = (p, lo, hi, side, fmt, color) => {
        ctx.fillStyle = color || T.muted; ctx.textBaseline = 'middle';
        ctx.textAlign = side === 'l' ? 'right' : 'left';
        const x = side === 'l' ? L.l - 5 : L.l + L.pw + 5;
        for (const v of ticks(lo, hi, 3)) {
          const y = p.y0 + p.h - ((v - lo) / (hi - lo)) * p.h;
          ctx.fillText(fmt(v), x, y);
        }
      };
      const grid = (p, lo, hi) => {
        ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
        for (const v of ticks(lo, hi, 3)) {
          const y = Math.round(p.y0 + p.h - ((v - lo) / (hi - lo)) * p.h) + 0.5;
          ctx.beginPath(); ctx.moveTo(L.l, y); ctx.lineTo(L.l + L.pw, y); ctx.stroke();
        }
      };
      const line = (p, lo, hi, key, color, width, dash, map) => clipped(() => {
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.setLineDash(dash || []);
        ctx.beginPath();
        S.forEach((q, i) => {
          const v = map ? map(q[key]) : q[key];
          const x = xOf(q.s), y = p.y0 + p.h - ((v - lo) / (hi - lo)) * p.h;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke(); ctx.setLineDash([]);
      });
      const title = (p, text) => { ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(text, L.l + 6, p.y0 + 3); };
      const range = (key, pad, map) => {
        let lo = Infinity, hi = -Infinity;
        for (const q of S) { const v = map ? map(q[key]) : q[key]; if (v < lo) lo = v; if (v > hi) hi = v; }
        const m = Math.max(pad, (hi - lo) * 0.15);
        return [lo - m, hi + m];
      };

      // 1. température (°C) et humidité (%)
      let p = this.panels[0];
      let [tLo, tHi] = range('T', 1);
      grid(p, tLo, tHi); axis(p, tLo, tHi, 'l', (v) => U.fmt(v, 0), T.s2);
      axis(p, 0, 100, 'r', (v) => U.fmt(v, 0) + ' %', T.s1);
      line(p, 0, 100, 'rh', T.s1, 1.5, [3, 3]);
      line(p, tLo, tHi, 'T', T.s2, 2.5);
      title(p, 'Température (°C) · humidité (%)');

      // 2. vent (km/h) : vitesse, rafales, composante de face (+) ou de dos (−)
      p = this.panels[1];
      const wMax = Math.max(10, Math.ceil(Math.max(...S.map((q) => kmh(q.gust))) / 5) * 5);
      const wLo = -wMax, wHi = wMax;
      grid(p, wLo, wHi); axis(p, wLo, wHi, 'l', (v) => U.fmt(Math.abs(v), 0));
      const y0 = p.y0 + p.h / 2;
      // composante de face / de dos : surface autour de zéro
      clipped(() => {
        for (const sign of [1, -1]) {
          ctx.fillStyle = sign > 0 ? 'rgba(208, 59, 59, 0.28)' : 'rgba(27, 175, 122, 0.28)';
          ctx.beginPath(); ctx.moveTo(xOf(S[0].s), y0);
          S.forEach((q) => {
            const v = Math.max(0, sign * kmh(q.head));
            ctx.lineTo(xOf(q.s), y0 - sign * (v / wHi) * (p.h / 2));
          });
          ctx.lineTo(xOf(S[S.length - 1].s), y0); ctx.closePath(); ctx.fill();
        }
      });
      ctx.strokeStyle = T.axis; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L.l, Math.round(y0) + 0.5); ctx.lineTo(L.l + L.pw, Math.round(y0) + 0.5); ctx.stroke();
      line(p, wLo, wHi, 'gust', T.s4, 1.5, [3, 3], kmh);
      line(p, wLo, wHi, 'ws', T.s1, 2.5, null, kmh);
      title(p, 'Vent (km/h) : vitesse, rafales · rouge = de face, vert = de dos');

      // sens du vent : une flèche tous les ≈ 55 px, orientée vers où il souffle (rouge : de face, vert : de dos), vitesse dessous
      const sb = this.strip;
      ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('Sens du vent (la flèche va où il souffle) · km/h', L.l + 6, sb.y0);
      const visible = S.filter((q) => inView(q.s)).length;
      const every = Math.max(1, Math.round(visible / Math.max(2, Math.floor(L.pw / 55))));
      for (let i = 0; i < S.length; i += every) {
        if (!inView(S[i].s)) continue;
        const q = S[i], x = xOf(q.s), y = sb.y0 + 22;
        const ratio = q.head / Math.max(q.ws, 0.1);
        const col = ratio > 0.35 ? T.critical : ratio < -0.35 ? T.s3 : T.ink2;
        ctx.save(); ctx.translate(x, y); ctx.rotate(((q.wd + 180) * Math.PI) / 180);
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(0, 7); ctx.lineTo(0, -7); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(-3.5, -4); ctx.lineTo(3.5, -4); ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.fillStyle = T.ink2; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(U.fmt(q.ws * 3.6, 0), x, y + 11);
      }

      // 3. pluie (mm/h) en barres et pression (hPa)
      p = this.panels[2];
      const rMax = Math.max(1, Math.ceil(Math.max(...S.map((q) => q.rain))));
      grid(p, 0, rMax); axis(p, 0, rMax, 'l', (v) => U.fmt(v, v % 1 ? 1 : 0), T.s1);
      const bw = Math.max(2, L.pw / Math.max(1, visible) * 0.8);
      ctx.fillStyle = 'rgba(42, 120, 214, 0.55)';
      clipped(() => {
        for (const q of S) {
          const hh = (Math.min(q.rain, rMax) / rMax) * p.h;
          ctx.fillRect(xOf(q.s) - bw / 2, p.y0 + p.h - hh, bw, hh);
        }
      });
      const [pLo, pHi] = range('p', 2);
      axis(p, pLo, pHi, 'r', (v) => U.fmt(v, 0), T.muted);
      line(p, pLo, pHi, 'p', T.ink2, 1.5);
      title(p, `Pluie (mm/h) · pression (hPa) — ${U.fmt(S[S.length - 1].rainCum, 1)} mm reçus au total`);

      // axes du bas : kilomètres puis heure de passage estimée
      const kt = rangeTicks(z0 / 1000, z1 / 1000, Math.max(3, Math.floor(L.pw / 70)));
      ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const yb = L.t + L.ph + 4;
      const clockAt = (s) => {
        let i = 0;
        while (i < S.length - 2 && S[i + 1].s < s) i++;
        const a = S[i], b = S[i + 1], f = b.s > a.s ? Math.min(1, Math.max(0, (s - a.s) / (b.s - a.s))) : 0;
        return a.clock + (b.clock - a.clock) * f;
      };
      for (const km of kt.values) {
        const x = xOf(km * 1000);
        ctx.fillText(U.fmt(km, kt.digits) + ' km', x, yb);
        ctx.fillStyle = T.s2; ctx.fillText(this.clockText(clockAt(km * 1000)), x, yb + 13); ctx.fillStyle = T.muted;
      }
      // repères horaires : un trait à chaque heure pleine (heure locale du départ)
      const off = d.offset || 0, c0 = S[0].clock, c1 = S[S.length - 1].clock;
      if (c1 > c0) {
        ctx.setLineDash([2, 4]); ctx.strokeStyle = T.axis; ctx.lineWidth = 1; ctx.fillStyle = T.s2; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        for (let hh = Math.ceil((c0 + off) / 3600) * 3600; hh <= c1 + off; hh += 3600) {
          const clock = hh - off;
          let i = 0;
          while (i < S.length - 2 && S[i + 1].clock < clock) i++;
          const a = S[i], b = S[i + 1], f = b.clock > a.clock ? U.clamp((clock - a.clock) / (b.clock - a.clock), 0, 1) : 0;
          const x = Math.round(xOf(a.s + (b.s - a.s) * f)) + 0.5;
          if (x < L.l || x > L.l + L.pw) continue;
          ctx.beginPath(); ctx.moveTo(x, L.t); ctx.lineTo(x, L.t + L.ph); ctx.stroke();
          ctx.fillText(`${new Date(hh * 1000).getUTCHours()} h`, x, L.t - 2);
        }
        ctx.setLineDash([]);
      }
      // survol
      if (this.hoverI >= 0) {
        const x = Math.round(xOf(S[this.hoverI].s)) + 0.5;
        if (x >= L.l && x <= L.l + L.pw) {
          ctx.strokeStyle = T.ink2; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, L.t); ctx.lineTo(x, L.t + L.ph); ctx.stroke();
        }
      }
    }

    bind() {
      const c = this.surface.canvas;
      c.addEventListener('pointermove', (e) => {
        if (!this.data || !this.L || !this.data.samples) return;
        const r = c.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        const L = this.L, S = this.data.samples;
        if (x < L.l || x > L.l + L.pw) { this.leave(); return; }
        const s = this.zoom.fracAt(x) * this.data.L;
        let bi = 0;
        S.forEach((q, i) => { if (Math.abs(q.s - s) < Math.abs(S[bi].s - s)) bi = i; });
        this.hoverI = bi;
        const q = S[bi];
        const th = theme();
        const rows = [
          { color: th.s2, value: `${U.fmt(q.T, 1)} °C · ${U.fmt(q.rh, 0)} %`, label: 'température · humidité' },
          { color: th.s1, value: `${U.fmt(q.ws * 3.6, 0)} km/h (rafales ${U.fmt(q.gust * 3.6, 0)}) du ${PYR.weather.compass(q.wd)} (${U.fmt(q.wd, 0)}°)`, label: 'vent' },
          { color: q.head > 0 ? th.critical : th.s3, value: `${U.fmt(Math.abs(q.head) * 3.6, 0)} km/h ${q.head > 0 ? 'de face' : 'de dos'}`, label: 'sur ton cap' },
          { color: th.s1, value: `${U.fmt(q.rain, 1)} mm/h · ${U.fmt(q.rainCum, 1)} mm cumulés`, label: 'pluie' },
          { color: th.ink2, value: `${U.fmt(q.p, 0)} hPa`, label: 'pression' },
        ];
        this.tip.show(x, y, `km ${U.fmt(q.s / 1000, 1)} · vers ${this.clockText(q.clock)}`, rows);
        if (this.opts.onHover) this.opts.onHover(q.s);
        this.surface.request();
      });
      c.addEventListener('pointerleave', () => this.leave());
    }

    leave() {
      this.hoverI = -1; this.tip.hide();
      if (this.opts.onHover) this.opts.onHover(null);
      this.surface.request();
    }
  }

  PYR.charts = { theme, GRADE_CLASSES, gradeColor, ticks, kmTicks, rangeTicks, ZoomView, ProfileChart, SeriesChart, CurveChart, RaceCurveChart, WeatherChart, Surface };
})(globalThis.PYR = globalThis.PYR || {});
