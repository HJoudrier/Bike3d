/* author : Hugo Joudrier-Faure */
/* PaceYourRide — onglet « Cycliste », modèle physiologique (metabo.js) :
 *   - la carte athlète dans le formulaire (panneau de droite) : champs vides = valeurs estimées, affichées en gris ;
 *   - sa synthèse au-dessus du niveau (signature, seuils, carburants, chaleur) ;
 *   - lipides et glucides selon la puissance, avec les zones de puissance (d'après la FTP), les seuils CP1 et CP2 et FATmax ;
 *   - recrutement des fibres I, IIa et IIx selon la puissance, frais et à la fin de la sortie simulée (mêmes zones et seuils) ;
 *   - en bas de page, une sortie simulée à puissance constante sur le plat (durée, intensité, ravitaillement, météo) : signature effective,
 *     glycogène, glycémie, températures, eau, FC et substrats seconde par seconde, et ce qui a fait baisser la PC. */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store, Mx = PYR.metabo;
  const { h, $ } = D;

  let simChart = null, subSurf = null, recSurf = null;
  let last = null;            // dernier calcul : {card, sub, recFresh, recEnd, sim}
  const inputs = {};          // champs de la carte athlète
  const SIM_DEFAULT = { h: 4, pct: 70, cho: 60, fluid: 500, na: 20, T: 20, rh: 50, sun: 300, alt: 200, caf: 0 };

  /** Réglages de la sortie simulée (enregistrés dans ui.physSim), bornés. */
  function simCfg() {
    const c = Object.assign({}, SIM_DEFAULT, store.state.ui.physSim || {});
    const n = (k, a, b) => { c[k] = U.clamp(Number(c[k]), a, b); if (!Number.isFinite(c[k])) c[k] = SIM_DEFAULT[k]; };
    n('h', 0.5, 8); n('pct', 40, 105); n('cho', 0, 150); n('fluid', 0, 2000); n('na', 0, 100); n('T', -5, 45); n('rh', 5, 100); n('sun', 0, 1000); n('alt', 0, 4000); n('caf', 0, 6);
    return c;
  }

  /** Carte athlète du profil en cours. */
  function currentCard() {
    const r = store.state.rider;
    const ath = PYR.physio.buildAthlete(r);
    return { card: Mx.card(r, ath), ath };
  }

  const fmtV = (f, v) => U.fmt(v, f.step < 0.1 ? 2 : f.step < 1 ? 1 : 0);

  /* ---------- formulaire (panneau de droite) ---------- */
  function buildForm() {
    const box = $('#physio-fields');
    if (!box) return;
    D.clear(box);
    const field = (f) => {
      const id = 'phy-' + f.key;
      const inp = h('input', { type: 'number', id, min: String(f.min), max: String(f.max), step: String(f.step), inputmode: 'decimal', title: f.help || '' });
      inp.addEventListener('change', () => {
        let v = inp.value === '' ? '' : Number(inp.value);
        if (v !== '' && !Number.isFinite(v)) v = '';
        if (v !== '') { v = U.clamp(v, f.min, f.max); inp.value = v; }
        store.set('rider.physio.' + f.key, v);
      });
      inputs[f.key] = inp;
      return h('div', { class: 'field', 'data-phy': f.key }, h('label', { for: id, title: f.help || '' }, `${f.label} (${f.unit})`), inp,
        h('small', { class: 'hint phy-src', id: id + '-src' }));
    };
    // seuils (CP1) : en tête de la grille des seuils, avant CP2, W′, Pmax et FTP
    const tgrid = $('#phy-thresholds-grid');
    if (tgrid) {
      tgrid.querySelectorAll('[data-phy]').forEach((el) => el.remove());
      Mx.FIELDS.filter((x) => x.group === 'thresholds').reverse().forEach((f) => tgrid.prepend(field(f)));
    }
    for (const [g, title] of Object.entries(Mx.GROUPS)) {
      box.appendChild(h('h4', { class: 'phy-group' }, title));
      const grid = h('div', { class: 'grid2' });
      for (const f of Mx.FIELDS.filter((x) => x.group === g)) grid.appendChild(field(f));
      box.appendChild(grid);
    }
  }

  function renderForm(c) {
    const p = store.state.rider.physio || {};
    for (const f of Mx.FIELDS) {
      const inp = inputs[f.key];
      if (!inp) continue;
      if (document.activeElement !== inp) inp.value = p[f.key] === '' || p[f.key] === undefined || p[f.key] === null ? '' : p[f.key];
      inp.placeholder = fmtV(f, c.values[f.key]);
      inp.classList.toggle('estimated', c.src[f.key] !== 'saisie');
      const src = document.getElementById('phy-' + f.key + '-src');
      if (src) src.textContent = c.src[f.key] === 'saisie' ? 'saisie' : `estimée : ${fmtV(f, c.values[f.key])}`;
    }
  }

  /* ---------- synthèse ---------- */
  function renderKpis(c) {
    const box = $('#phy-kpis');
    if (!box) return;
    D.clear(box);
    const v = c.values, s = c.src;
    const est = (...keys) => keys.some((k) => s[k] !== 'saisie');
    const chip = (label, value, sub, estimated) => h('div', { class: 'phy-kpi' + (estimated ? ' est' : '') },
      h('span', { class: 'l' }, label), h('strong', null, value), sub ? h('small', null, sub) : null);
    const pf = c.kFat * c.CP1;
    box.append(
      chip('CP1 (premier seuil)', `${U.fmt(c.CP1, 0)} W`, `${U.fmt(c.CP1 / c.CP2 * 100, 0)} % de CP2`, est('cp1')),
      chip('CP2 (puissance critique)', `${U.fmt(c.CP2, 0)} W`, `${U.fmt(c.CP2 / c.mass, 2)} W/kg`, false),
      chip('W′', `${U.fmt(c.Wp, 1)} kJ`, 'signature (onglet Cycliste)', false),
      chip('Pmax', `${U.fmt(c.Pmax, 0)} W`, `${U.fmt(c.Pmax / c.mass, 1)} W/kg`, false),
      chip('VO₂max', `${U.fmt(v.vo2max, 1)} mL/min/kg`, `FC ${U.fmt(c.HRrest, 0)}–${U.fmt(c.HRmax, 0)}`, est('vo2max', 'hrRest', 'hrMax')),
      chip('Fibres lentes (I)', `${U.fmt(c.fI * 100, 0)} %`, c.fI >= 0.6 ? 'profil endurant' : c.fI <= 0.45 ? 'profil explosif' : 'profil mixte', est('fI')),
      chip('Lipides : MFO à FATmax', `${U.fmt(c.MFO, 2)} g/min`, `à ${U.fmt(pf, 0)} W`, est('mfo', 'fatmax')),
      chip('Glycogène', `${U.fmt(c.GIcap + c.GIIcap, 0)} + ${U.fmt(c.GLcap, 0)} g`, `muscles + foie, rempli à ${U.fmt(c.gluFill * 100, 0)} %`, est('glyMuscle', 'glyLiver', 'glyFill')),
      chip('Chaleur · altitude', `T crit. ${U.fmt(c.Tcrit, 1)} °C`, `acclimatation ${U.fmt(c.heatAcc * 100, 0)} % · ${U.fmt(c.altAcc * 100, 0)} %`, est('tcrit', 'heatAcc', 'altAcc')),
      chip('Sueur', `${U.fmt(c.SRmax, 1)} L/h max`, `${U.fmt(c.NaSweat, 0)} mmol/L de sodium`, est('sweatMax', 'sweatNa')));
  }

  /* ---------- petits graphiques : en fonction de la puissance ---------- */
  /**
   * Graphique « en fonction de la puissance » (canvas) : bandes des zones, courbes, repères verticaux et info-bulle.
   * spec : {xMax, yMax, yUnit, bands: [{from, to, color, alpha, id, name}], lines: [{label, color, values: [{x, y}], dash, area, stack}],
   *         marks: [{x, label, strong (seuil : trait plein)}], tip(x) → rows}
   */
  function drawPowerChart(surf, ctx, w, hgt, spec) {
    const T = PYR.charts.theme(), bold = '600 ' + T.font;
    const L = { l: 44, r: 10, t: 22, b: 24 };   // en haut : la légende
    const pw = w - L.l - L.r, ph = hgt - L.t - L.b;
    if (pw < 40 || ph < 30) return;
    const xOf = (x) => L.l + (x / spec.xMax) * pw, yOf = (y) => L.t + ph - (y / spec.yMax) * ph;
    ctx.font = T.font;
    // zones : « Z2 Endur » en haut de la bande, sur deux lignes si elle est étroite, « Z2 » seul si elle l'est encore plus
    for (const b of spec.bands || []) {
      const x0 = xOf(Math.max(0, b.from)), bw = xOf(Math.min(b.to, spec.xMax)) - x0;
      if (bw <= 0) continue;
      ctx.globalAlpha = b.alpha === undefined ? 1 : b.alpha;
      ctx.fillStyle = b.color; ctx.fillRect(x0, L.t, bw, ph);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.font = bold; const wId = ctx.measureText(b.id).width;
      ctx.font = T.font; const wName = ctx.measureText(b.name).width;
      if (wId > bw - 6) continue;
      ctx.font = bold; ctx.fillStyle = T.ink; ctx.fillText(b.id, x0 + 3, L.t + 3);
      ctx.font = T.font; ctx.fillStyle = T.ink2;
      if (wId + 4 + wName <= bw - 6) ctx.fillText(b.name, x0 + 3 + wId + 4, L.t + 3);
      else if (wName <= bw - 6) ctx.fillText(b.name, x0 + 3, L.t + 16);
    }
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.fillStyle = T.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of PYR.charts.ticks(0, spec.yMax, Math.max(2, Math.floor(ph / 32)))) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L.l, y); ctx.lineTo(L.l + pw, y); ctx.stroke();
      ctx.fillText(U.fmt(v, 0), L.l - 5, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of PYR.charts.ticks(0, spec.xMax, Math.max(2, Math.floor(pw / 70)))) ctx.fillText(U.fmt(v, 0) + ' W', xOf(v), L.t + ph + 6);
    ctx.save(); ctx.translate(11, L.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(spec.yUnit, 0, 0); ctx.restore();
    for (const ln of spec.lines) {
      const pts = ln.values;
      if (ln.area) {
        ctx.fillStyle = ln.color; ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.moveTo(xOf(pts[0].x), yOf(ln.base ? ln.base[0] : 0));
        pts.forEach((p) => ctx.lineTo(xOf(p.x), yOf(p.y)));
        for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(xOf(pts[i].x), yOf(ln.base ? ln.base[i] : 0));
        ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = ln.color; ctx.lineWidth = ln.dash ? 1.5 : 2; ctx.setLineDash(ln.dash ? [5, 4] : []);
      ctx.beginPath(); pts.forEach((p, i) => { if (i) ctx.lineTo(xOf(p.x), yOf(p.y)); else ctx.moveTo(xOf(p.x), yOf(p.y)); }); ctx.stroke();
      ctx.setLineDash([]);
    }
    // repères verticaux : seuils (CP1, CP2) en trait plein, les autres en pointillés ; étiquettes en bas, sur la plus basse ligne libre
    const rowEnd = [];
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    for (const m of (spec.marks || []).filter((q) => q.x > 0 && q.x < spec.xMax).sort((a, b) => a.x - b.x)) {
      const x = Math.round(xOf(m.x)) + 0.5;
      ctx.strokeStyle = m.strong ? T.ink : T.ink2; ctx.lineWidth = m.strong ? 1.5 : 1; ctx.setLineDash(m.strong ? [] : [3, 3]);
      ctx.beginPath(); ctx.moveTo(x, L.t); ctx.lineTo(x, L.t + ph); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = m.strong ? bold : T.font;
      const tw = ctx.measureText(m.label).width;
      const tx = x + 4 + tw <= L.l + pw ? x + 4 : x - 4 - tw;   // à droite du trait, à gauche au bord du graphique
      let r = 0;
      while (rowEnd[r] !== undefined && rowEnd[r] > tx - 4) r++;
      rowEnd[r] = tx + tw;
      const ty = L.t + ph - 3 - 14 * r;
      ctx.globalAlpha = 0.8; ctx.fillStyle = T.surface; ctx.fillRect(tx - 2, ty - 13, tw + 4, 14); ctx.globalAlpha = 1;
      ctx.fillStyle = m.strong ? T.ink : T.ink2; ctx.fillText(m.label, tx, ty);
    }
    ctx.font = T.font; ctx.lineWidth = 1;
    // légende
    let lx = L.l + pw;
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    for (const ln of spec.lines.slice().reverse()) {
      if (ln.noLegend) continue;
      const tw = ctx.measureText(ln.label).width;
      ctx.fillStyle = T.ink2; ctx.fillText(ln.label, lx, 4);
      ctx.fillStyle = ln.color; ctx.fillRect(lx - tw - 14, 8, 10, 3);
      lx -= tw + 24;
    }
    surf.geom = { L, pw, ph, xMax: spec.xMax };
    if (surf.hoverX !== null && surf.hoverX !== undefined) {
      const x = Math.round(xOf(surf.hoverX)) + 0.5;
      ctx.strokeStyle = T.ink2; ctx.beginPath(); ctx.moveTo(x, L.t); ctx.lineTo(x, L.t + ph); ctx.stroke();
    }
  }

  /** Graphique canvas avec info-bulle : draw(ctx, w, h) dessine d'après spec(), tip(P) donne les lignes de l'info-bulle. */
  function powerChart(boxId, specFn, tipFn) {
    const box = $('#' + boxId);
    if (!box) return null;
    const surf = new PYR.charts.Surface(box, (ctx, w, hgt) => { const sp = specFn(); if (sp) drawPowerChart(surf, ctx, w, hgt, sp); });
    const tip = D.h('div', { class: 'chart-tip', hidden: true });
    box.appendChild(tip);
    surf.hoverX = null;
    surf.canvas.addEventListener('pointermove', (e) => {
      const g = surf.geom;
      if (!g) return;
      const r = surf.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < g.L.l || x > g.L.l + g.pw) { surf.hoverX = null; tip.hidden = true; surf.request(); return; }
      const P = (x - g.L.l) / g.pw * g.xMax;
      surf.hoverX = P;
      const rows = tipFn(P);
      D.clear(tip);
      tip.appendChild(D.h('div', { class: 't' }, `${U.fmt(P, 0)} W`));
      for (const rw of rows) tip.appendChild(D.h('div', { class: 'r' }, rw.color ? D.h('i', { style: { background: rw.color } }) : null, D.h('b', null, rw.value), D.h('span', null, rw.label)));
      tip.hidden = false;
      const bw = box.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = Math.max(2, x + 14 + tw > bw - 4 ? x - tw - 14 : x + 14) + 'px';
      tip.style.top = Math.max(2, Math.min(y - th / 2, box.clientHeight - th - 2)) + 'px';
      surf.request();
    });
    surf.canvas.addEventListener('pointerleave', () => { surf.hoverX = null; tip.hidden = true; surf.request(); });
    return surf;
  }

  const powersOf = (c) => { const xMax = Math.ceil(c.CP2 * 1.25 / 50) * 50, out = []; for (let P = 0; P <= xMax; P += Math.max(2, Math.round(xMax / 160))) out.push(P); return { xMax, out }; };

  /** Zones de puissance du cycliste (d'après la FTP, comme le tableau des zones), avec les couleurs de la courbe record. */
  function powerZones(ath) {
    if (!PYR.bench || !PYR.map) return [];
    return PYR.bench.zones(ath.ftp, ath.pmax).map((z, i) => Object.assign(z, { color: PYR.map.HEAT[i] }));
  }

  const ZONE_SHORT = { Z1: 'Récup', Z2: 'Endur', Z3: 'Tempo', Z4: 'Seuil', Z5: 'PMA', Z6: 'Sprint' };

  function zoneBands() {
    return last.zones.map((z) => ({ from: z.lo, to: z.to === Infinity ? Infinity : z.hi, color: z.color, alpha: 0.22, id: z.id, name: ZONE_SHORT[z.id] || z.label }));
  }

  /** Seuils CP1 et CP2 : repères en trait plein. */
  const cpMarks = (c) => [{ x: c.CP1, label: `CP1 ${U.fmt(c.CP1, 0)} W`, strong: true }, { x: c.CP2, label: `CP2 ${U.fmt(c.CP2, 0)} W`, strong: true }];

  /** Lignes de l'info-bulle communes aux deux graphiques : zone de puissance et domaine d'intensité. */
  function zoneTip(P) {
    const c = last.card, z = last.zones.find((q) => P < q.hi) || last.zones[last.zones.length - 1];
    const dom = P < c.CP1 ? ['modéré', 'domaine (sous CP1)'] : P < c.CP2 ? ['lourd', 'domaine (entre CP1 et CP2)'] : ['sévère', 'domaine (au-dessus de CP2)'];
    return (z ? [{ color: z.color, value: `${z.id} ${z.label}`, label: 'zone' }] : []).concat([{ value: dom[0], label: dom[1] }]);
  }

  function subSpec() {
    if (!last) return null;
    const c = last.card, T = PYR.charts.theme(), xs = last.sub;
    const yMax = Math.ceil(Math.max(...xs.map((q) => q.cho), 60) / 50) * 50;
    const cross = xs.find((q) => q.cho * 16.5 >= q.fat * 39.4 && q.P > 0);
    const fatMax = xs.reduce((b, q) => (q.fat > b.fat ? q : b), xs[0]);
    return {
      xMax: last.xMax, yMax, yUnit: 'g/h', bands: zoneBands(),
      lines: [
        { label: 'Glucides', color: T.s2, values: xs.map((q) => ({ x: q.P, y: q.cho })) },
        { label: 'Lipides', color: T.s1, values: xs.map((q) => ({ x: q.P, y: q.fat })) },
      ],
      marks: [{ x: fatMax.P, label: 'FATmax' }].concat(cross ? [{ x: cross.P, label: 'croisement' }] : [], cpMarks(c)),
    };
  }

  function subTip(P) {
    if (!last) return [];
    const q = Mx.substrateCurve(last.card, [P])[0], T = PYR.charts.theme();
    const fatE = q.fat * 39.4, choE = q.cho * 16.5;
    return [
      { color: T.s2, value: `${U.fmt(q.cho, 0)} g/h`, label: 'glucides' },
      { color: T.s1, value: `${U.fmt(q.fat, 0)} g/h`, label: `lipides (${U.fmt(fatE / Math.max(1, fatE + choE) * 100, 0)} % de l'énergie)` },
      { value: `${U.fmt(q.GE * 100, 1)} %`, label: 'rendement brut' },
      { value: `${U.fmt(q.HR, 0)} bpm`, label: 'FC en régime établi' },
    ].concat(zoneTip(P));
  }

  function recSpec() {
    if (!last) return null;
    const T = PYR.charts.theme(), F = last.recFresh, E = last.recEnd;
    const I = F.map((q) => ({ x: q.P, y: q.pI })), IIa = F.map((q) => ({ x: q.P, y: q.pI + q.pIIa })), IIx = F.map((q) => ({ x: q.P, y: q.pI + q.pIIa + q.pIIx }));
    return {
      xMax: last.xMax, yMax: last.xMax, yUnit: 'W fournis', bands: zoneBands(),
      lines: [
        { label: 'Fibres I', color: T.s3, values: I, area: true },
        { label: 'IIa', color: T.s4, values: IIa, area: true, base: I.map((p) => p.y) },
        { label: 'IIx', color: T.critical || '#d03b3b', values: IIx, area: true, base: IIa.map((p) => p.y) },
        { label: 'Fibres I en fin de sortie', color: T.ink2, dash: true, values: E.map((q) => ({ x: q.P, y: q.pI })) },
      ],
      marks: cpMarks(last.card),
    };
  }

  function recTip(P) {
    if (!last) return [];
    const i = Math.max(0, Math.min(last.recFresh.length - 1, Math.round(P / last.dP))), q = last.recFresh[i], e = last.recEnd[i], T = PYR.charts.theme();
    const pct = (x) => `${U.fmt(x / Math.max(1, q.P) * 100, 0)} %`;
    return [
      { color: T.s3, value: `${U.fmt(q.pI, 0)} W (${pct(q.pI)})`, label: 'fibres I' },
      { color: T.s4, value: `${U.fmt(q.pIIa, 0)} W (${pct(q.pIIa)})`, label: 'fibres IIa' },
      { color: T.critical || '#d03b3b', value: `${U.fmt(q.pIIx, 0)} W (${pct(q.pIIx)})`, label: 'fibres IIx' },
      { value: `${U.fmt(e.pIIa + e.pIIx, 0)} W`, label: 'fibres II en fin de sortie simulée' },
    ].concat(zoneTip(P));
  }

  /** Recrutement avec l'état de fin de la sortie simulée (fibres fatiguées, glycogène entamé). */
  function recruitWith(c, state, powers) {
    const f = state.f;
    return powers.map((P) => {
      const Paero = Math.min(P, f.CP2e);
      const r = Mx.recruit(Paero, f.CP1e, f.CP2e, {});
      return { P, pI: r.PI, pIIa: r.PIIa, pIIx: r.PIIx };
    });
  }

  /* ---------- sortie simulée ---------- */
  function buildSimControls() {
    const box = $('#phy-sim-controls');
    if (!box) return;
    D.clear(box);
    const cfg = simCfg();
    const set = (k, v) => { const o = Object.assign({}, simCfg(), { [k]: v }); store.set('ui.physSim', o, true); render(); };
    const num = (k, label, unit, min, max, step) => {
      const inp = h('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(cfg[k]), 'aria-label': label });
      inp.addEventListener('change', () => { const v = U.clamp(Number(inp.value), min, max); inp.value = Number.isFinite(v) ? v : cfg[k]; set(k, Number(inp.value)); });
      return h('label', { class: 'phy-ctl' }, h('span', null, label), h('span', { class: 'phy-ctl-in' }, inp, h('em', null, unit)));
    };
    const sel = (k, label, opts) => {
      const s = h('select', { 'aria-label': label }, ...opts.map(([v, t]) => h('option', { value: String(v) }, t)));
      s.value = String(cfg[k]);
      s.addEventListener('change', () => set(k, Number(s.value)));
      return h('label', { class: 'phy-ctl' }, h('span', null, label), s);
    };
    box.append(
      sel('h', 'Durée', [[1, '1 h'], [2, '2 h'], [3, '3 h'], [4, '4 h'], [5, '5 h'], [6, '6 h']]),
      num('pct', 'Intensité', '% CP2', 40, 105, 1),
      num('cho', 'Glucides', 'g/h', 0, 150, 5),
      num('fluid', 'Boisson', 'mL/h', 0, 2000, 50),
      num('na', 'Sodium de la boisson', 'mmol/L', 0, 100, 5),
      num('T', 'Température', '°C', -5, 45, 1),
      num('rh', 'Humidité', '%', 5, 100, 5),
      sel('sun', 'Soleil', [[0, 'nuit ou ciel couvert'], [300, 'voilé'], [600, 'éclaircies'], [900, 'plein soleil']]),
      num('alt', 'Altitude', 'm', 0, 4000, 100),
      num('caf', 'Caféine à mi-parcours', 'mg/kg', 0, 6, 0.5));
  }

  function runSim(c) {
    const cfg = simCfg(), st = store.state;
    const setup = PYR.physics.buildSetup(st.rider, st.bike);
    const P = c.CP2 * cfg.pct / 100;
    const rho = PYR.physics.airDensity(cfg.alt, cfg.T);
    const v = PYR.physics.steadySpeed(setup, P, 0, 1, rho);
    const dur = Math.round(cfg.h * 3600);
    const r = Mx.simulate(c, {
      dur, P, v, rec: 1, env: { Ta: cfg.T, RH: cfg.rh, sun: cfg.sun, h: cfg.alt },
      choGh: cfg.cho, fluidMLh: cfg.fluid, drinkNa: cfg.na, cafMg: cfg.caf * c.mass, cafAt: Math.round(dur / 2),
    });
    r.P = P; r.v = v; r.cfg = cfg;
    return r;
  }

  function renderSim(c, sim) {
    const S = sim.series, n = sim.n, T = PYR.charts.theme(), L = sim.last;
    const kp = $('#phy-sim-kpis'), lim = $('#phy-lim');
    if (kp) {
      D.clear(kp);
      const tile = (label, value, warn) => h('div', { class: 'phy-kpi' + (warn ? ' warn' : '') }, h('span', { class: 'l' }, label), h('strong', null, value));
      kp.append(
        tile('Allure', `${U.fmt(sim.P, 0)} W · ${U.fmt(sim.v * 3.6, 1)} km/h`),
        tile('PC effective à la fin', `${U.fmt(L.CP2e, 0)} W (${U.fmt(L.cpK * 100, 0)} %)`, L.CP2e < sim.P),
        tile('W′ effectif à la fin', `${U.fmt(L.WpE, 1)} kJ (${U.fmt(L.wK * 100, 0)} %)`),
        tile('Fringale', sim.bonkT === null ? 'aucune' : `à ${U.fmtClock(sim.bonkT)}`, sim.bonkT !== null),
        tile('Glycémie la plus basse', `${U.fmt(L.minGlu, 1)} mmol/L`, L.minGlu < Mx.HYPO),
        tile('Température centrale max', `${U.fmt(L.maxTc, 1)} °C`, L.maxTc >= 39.5),
        tile('Eau', `${U.fmt(L.dehy, 1)} % du poids · sueur ${U.fmt(L.sweatL, 1)} L`, L.dehy > 2 || L.dehy < -1),
        tile('Natrémie finale', `${U.fmt(L.Na, 0)} mmol/L`, L.Na < 135),
        tile('Brûlé', `${U.fmt(L.choTot, 0)} g de glucides (${U.fmt(L.exoTot, 0)} g ingérés) · ${U.fmt(L.fatTot, 0)} g de lipides`));
      if (L.CP2e < sim.P) kp.append(h('p', { class: 'hint phy-warn' }, `À la fin, ta PC effective est passée sous l'allure simulée : en course, tu ne pourrais plus la tenir (le W′ se viderait).`));
    }
    if (lim) {
      D.clear(lim);
      const items = [['Glycogène musculaire', L.gly], ['Fatigue des fibres', L.phi], ['Chaleur', L.mT * L.VA_T], ['Déshydratation', L.mHyd], ['Altitude', L.mAlt], ['Hypoglycémie', L.VA_glu], ['Caféine, sommeil, motivation', L.VA_other]];
      lim.appendChild(h('h4', null, 'Ce qui fait baisser la PC à la fin'));
      for (const [label, k] of items) {
        const pct = (1 - k) * 100, gain = pct < 0;
        lim.appendChild(h('div', { class: 'phy-lim-row' }, h('span', null, label),
          h('span', { class: 'bar' }, h('i', { class: gain ? 'gain' : '', style: { width: Math.min(100, Math.abs(pct) / 30 * 100).toFixed(1) + '%' } })),
          h('span', { class: 'v' }, Math.abs(pct) < 0.05 ? '0 %' : `${gain ? '+' : '−'}${U.fmt(Math.abs(pct), 1)} %`)));
      }
    }
    if (!simChart) return;
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = sim.v * i;
    const pct = (a) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * 100; return o; };
    const f = (d, u) => (x) => `${U.fmt(x, d)} ${u}`;
    simChart.setData({
      n, x: 'time', s, sEnd: s[n - 1] || 1, tEnd: n - 1,
      panels: [
        { id: 'p', label: 'Puissance', unit: 'W', color: T.s1, values: S.P, fmt: f(0, 'W'), weight: 1.2, min: 0, seriesLabel: 'Puissance simulée',
          overlays: [{ label: 'CP2 effective', color: T.s2, values: S.CP2e, fmt: f(0, 'W') }, { label: 'CP1 effective', color: T.s3, values: S.CP1e, fmt: f(0, 'W') }] },
        { id: 'g', label: 'Glycogène', unit: '%', color: T.s3, values: pct(S.gI), fmt: f(0, '%'), min: 0, max: 100, seriesLabel: 'Fibres I',
          overlays: [{ label: 'Fibres II', color: T.s2, values: pct(S.gII), fmt: f(0, '%'), dash: false }, { label: 'Foie', color: T.s7, values: pct(S.gL), fmt: f(0, '%'), dash: false }] },
        { id: 'u', label: 'Glycémie', unit: 'mmol/L', color: T.s1, values: S.glu, fmt: f(1, 'mmol/L'), tickDigits: 0, min: 0, refs: [{ v: Mx.HYPO, label: 'hypoglycémie', dash: true }] },
        { id: 't', label: 'Températures', unit: '°C', color: T.critical || '#d03b3b', values: S.Tc, fmt: f(2, '°C'), seriesLabel: 'Noyau', tickDigits: 0,
          overlays: [{ label: 'Peau', color: T.s2, values: S.Tsk, fmt: f(2, '°C') }], refs: [{ v: 40, label: 'zone critique', dash: true }] },
        { id: 'w', label: 'Déshydratation', unit: '% du poids', color: T.s1, values: S.dehy, fmt: f(1, '%'), area: true, tickDigits: 1, refs: [{ v: 2, label: 'seuil 2 %', dash: true }] },
        { id: 'h', label: 'Fréquence cardiaque', unit: 'bpm', color: T.critical || '#d03b3b', values: S.HR, fmt: f(0, 'bpm') },
        { id: 'o', label: 'Oxydation', unit: 'g/h', color: T.s2, values: S.cho, fmt: f(0, 'g/h'), seriesLabel: 'Glucides', min: 0,
          overlays: [{ label: 'Lipides', color: T.s1, values: S.fat, fmt: f(0, 'g/h'), dash: false }, { label: 'Glucides ingérés', color: T.s3, values: S.exo, fmt: f(0, 'g/h') }] },
      ],
    });
  }

  /* ---------- rendu ---------- */
  function render() {
    if (!$('#rs-physio')) return;
    let cc;
    try { cc = currentCard(); } catch (e) { console.warn('Carte athlète', e); return; }
    const c = cc.card;
    renderForm(c);
    renderKpis(c);
    const { xMax, out } = powersOf(c);
    const sim = runSim(c);
    const fresh = Mx.substrateCurve(c, out);
    last = { card: c, xMax, dP: out[1] - out[0], sub: fresh, recFresh: fresh, recEnd: recruitWith(c, sim.state, out), sim, zones: powerZones(cc.ath) };
    renderSim(c, sim);
    if (subSurf) subSurf.request();
    if (recSurf) recSurf.request();
  }

  const RP = {
    init() {
      if (!Mx || !$('#rs-physio')) return;
      buildForm();
      buildSimControls();
      subSurf = powerChart('phy-sub-chart', subSpec, subTip);
      recSurf = powerChart('phy-rec-chart', recSpec, recTip);
      const box = $('#phy-sim-chart');
      if (box) simChart = new PYR.charts.SeriesChart(box, {});
      store.on('bike', render);   // le vélo fixe la vitesse de la sortie simulée (le profil : tabRider.render)
    },
    render,
    onShow() { if (simChart) simChart.surface.request(); if (subSurf) subSurf.request(); if (recSurf) recSurf.request(); },
  };

  PYR.riderPhysio = RP;
})(globalThis.PYR = globalThis.PYR || {});
