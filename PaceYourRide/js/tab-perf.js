/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page Pacing optimal (pacing.html) : calcul et restitution de la stratégie optimale. */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store;
  const { h, $ } = D;

  const SEC_PAGE = 60;
  const ALGO_LABEL = { analytic: 'équations d\'optimalité', gradient: 'descente de gradient', hybrid: 'analytique puis descente de gradient' };

  let chart = null;
  let shown = null;   // tronçons montrés sur la carte et les graphiques (dernier export ou découpage en cours)
  let cuts = null;    // découpage choisi : distances (m) des limites entre tronçons, null tant que le plan n'est pas découpé
  let editing = false; // les limites se modifient sur le profil et la carte
  const MIN_LEN = 100; // m : longueur minimale d'un tronçon

  /** Modifications du découpage depuis le profil ou la carte (s : distance en m). */
  const editor = {
    /** Déplace la limite k (début du tronçon k) ; renvoie la distance retenue, bornée par les limites voisines. */
    onMove(k, s) {
      const L = store.plan.inputs.length, lo = (k >= 2 ? cuts[k - 2] : 0) + MIN_LEN, hi = (k <= cuts.length - 1 ? cuts[k] : L) - MIN_LEN;
      if (hi >= lo) cuts[k - 1] = Math.round(U.clamp(s, lo, hi));
      T.refreshSections();
      return cuts[k - 1];
    },
    onAdd(s) {
      const L = store.plan.inputs.length;
      if (s < MIN_LEN || s > L - MIN_LEN || cuts.some((c) => Math.abs(c - s) < MIN_LEN)) return;
      cuts.push(s);
      cuts.sort((x, y) => x - y);
      T.refreshSections();
    },
    onRemove(k) {
      cuts.splice(k - 1, 1);
      T.refreshSections();
    },
  };
  let running = false;
  let secPage = 0;

  /**
   * Panneau W′bal : la courbe vire de la couleur de W′ à l'orange puis au rouge en s'approchant de zéro, et devient noire sous zéro
   * (profil de l'athlète dépassé). Les paliers de fatigue sont ceux de PYR.physio.WBAL_LEVELS.
   */
  function wbalPanel(plan, wkj, th, effKj) {
    const w0 = plan.w0Ref / 1000;
    let minKj = plan.wbalMinRef / 1000;
    if (effKj) for (let t = 0; t < effKj.length; t++) if (effKj[t] < minKj) minKj = effKj[t];
    const col = { moderate: th.s3, orange: '#f08c00', red: th.critical || '#d03b3b', neg: '#000000' };
    const Lv = PYR.physio.WBAL_LEVELS;
    return {
      id: 'wbal', label: 'W′bal', unit: 'kJ', color: th.s3, area: true, values: wkj, weight: 1.25, tickDigits: 0,
      min: minKj < 0 ? minKj * 1.1 - 0.02 * w0 : 0, max: w0,
      // modèle physiologique : W′bal recalculé avec la PC et le W′ effectifs prévus (vérification du plan)
      overlays: effKj ? [{ label: 'W′bal effectif (modèle physiologique)', color: th.ink2, values: effKj, fmt: (v) => `${U.fmt(v, 1)} kJ` }] : undefined,
      gradient: [
        { v: Lv[0].frac * w0, color: col.moderate }, { v: 0.25 * w0, color: col.orange }, { v: Lv[2].frac * w0, color: col.red },
        { v: 0, color: col.red }, { v: 0, color: col.neg },
      ],
      refs: Lv.map((l) => ({ v: l.frac * w0, label: l.frac === 0.05 ? '' : l.label, dash: l.frac > 0, color: l.frac === 0 ? undefined : th.muted })),
      fmt: (v) => `${U.fmt(v, 1)} kJ · ${U.fmt(v / w0 * 100, 0)} % · ${PYR.physio.wbalState(v / w0)}`,
    };
  }

  const T = {
    buildInputs: (machine, opts) => PYR.simInputs.build(machine, opts),   // aussi utilisé par le jeu et le compteur (Commun/js/ui/sim-inputs.js)

    init() {
      chart = new PYR.charts.SeriesChart($('#perf-chart'), {
        onHover: (t) => {
          const plan = store.plan;
          PYR.map.showHover(t === null || !plan ? null : plan.series.s[t]);
        },
        onTitleDblClick: (panelId) => PYR.chartConfig.open('perf', panelId),   // réglage de la hauteur du panneau
      });
      PYR.chartConfig.registerSeries('perf', chart);
      D.$$('[data-xaxis]').forEach((b) => b.addEventListener('click', () => {
        D.$$('[data-xaxis]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        chart.setXMode(b.dataset.xaxis);
      }));
      $('#btn-optimize').addEventListener('click', () => T.run());
      // forme ≠ 100 % : W′bal et temps avant épuisement sur le profil de l'athlète (défaut) ou sur le profil ajusté à la forme
      const refSel = $('#p-formref');
      const syncRef = () => {
        refSel.value = store.state.perf.formRef;
        $('#p-formref-row').hidden = !(Number(store.state.perf.formPct) > 0 && Number(store.state.perf.formPct) !== 100);
      };
      syncRef();
      refSel.addEventListener('change', () => store.set('perf.formRef', refSel.value));
      store.on('perf', syncRef);
      store.on('formref', () => {
        syncRef();
        if (store.plan && !store.planStale) { T.refreshCurves(store.plan); T.render(); }
      });
      $('#btn-hide-segments').addEventListener('click', () => T.hideSections());
      $('#btn-split').addEventListener('click', () => T.split());
      $('#btn-seg-edit').addEventListener('click', () => {
        if (editing) { editing = false; T.refreshSections(); } else T.split();
      });
      $('#btn-seg-auto').addEventListener('click', () => { cuts = T.autoCuts(); editing = true; T.refreshSections(); });
      $('#btn-export-csv').addEventListener('click', () => T.exportCsv());
      $('#btn-export-plan-gpx').addEventListener('click', () => T.exportGpx());
      $('#btn-export-plan-tcx').addEventListener('click', () => T.exportTcx());
      for (const kind of ['fit', 'zwo', 'mrc']) $(`#btn-export-plan-${kind}`).addEventListener('click', () => T.exportWorkout(kind));
      $('#btn-play-plan').addEventListener('click', () => { store.state.game.ghost = true; PYR.app.showTab('game'); });
      $('#btn-ride-plan').addEventListener('click', () => PYR.app.showTab('ride'));
      $('#sec-range').addEventListener('input', (e) => { secPage = Number(e.target.value); T.renderSeconds(); });
      $('#sec-prev').addEventListener('click', () => { secPage = Math.max(0, secPage - 1); T.renderSeconds(); });
      $('#sec-next').addEventListener('click', () => { secPage = Math.min(Number($('#sec-range').max), secPage + 1); T.renderSeconds(); });

      // toute modification des entrées rend le plan obsolète
      const stale = () => {
        if (!store.plan || store.planStale) return;
        store.planStale = true;
        T.hideSections();
        T.renderStale();
        if (PYR.map.mode === 'power') PYR.map.drawRoute();
      };
      ['profile', 'surfaces', 'winds', 'rider', 'bike', 'env', 'perf', 'weather'].forEach((e) => store.on(e, stale));
      store.on('kit', () => { if (store.plan && store.plan.physio) stale(); });   // matériel emporté (compteur) : plan d'alimentation
      store.on('hover', ({ s, from }) => {
        if (from === 'perf' || !store.plan || !chart) return;
        if (s === null) { chart.setHover(null); return; }
        const S = store.plan.series.s;
        let t = 0;
        while (t < S.length - 1 && S[t] < s) t++;
        chart.setHover(t);
      });
    },

    onShow() { if (chart) chart.surface.request(); if (shown) PYR.map.setSections(shown, cuts && editing ? editor : null); T.renderStale(); },
    onHide() { PYR.map.setSections(null); },

    async run() {
      if (running) return;
      let inputs;
      try { inputs = PYR.simInputs.build(undefined, { plan: true }); } catch (e) { setStatus(e.message, true); return; }
      inputs.algo = ALGO_LABEL[store.state.perf.algo] ? store.state.perf.algo : 'analytic';
      running = true;
      const btn = $('#btn-optimize');
      btn.disabled = true;
      btn.textContent = 'Calcul en cours…';
      const bar = $('#opt-progress'), fill = $('#opt-progress-fill');
      bar.hidden = false; fill.style.width = '2%';
      setStatus(inputs.physio ? 'Optimisation avec le modèle physiologique : chaque plan est vérifié seconde par seconde (glycogène, chaleur, eau, fatigue) et l\'effort réduit s\'il ne tient pas…'
        : inputs.algo === 'analytic' ? 'Optimisation : recherche de la répartition idéale du W′ et de l\'effort…'
          : 'Optimisation par descente de gradient : on déplace des watts d\'un tronçon à l\'autre, de plus en plus finement…');
      await U.sleep(20);
      try {
        const res = await PYR.optimizer.optimize(inputs, (f) => { fill.style.width = Math.round(Math.max(2, f * 100)) + '%'; });
        if (!res.ok) { setStatus(res.error, true); return; }
        res.inputs = { cp: inputs.athlete.cp, w0: inputs.athlete.w0, ftp: inputs.athlete.ftp, mass: inputs.setup.mRider, length: inputs.course.length };
        res.course = inputs.course;
        res.setup = inputs.setup; res.athlete = inputs.athlete; res.margin = inputs.margin;   // de quoi recalculer W′bal et le temps avant épuisement selon la référence choisie
        T.refreshCurves(res);
        store.plan = res;
        store.planStale = false;
        // enregistré avec le projet (forme compacte) : il part avec lui dans Dropbox, le compteur le suit et le jeu en fait son fantôme
        PYR.planLink.adoptPerfPlan(true);
        setStatus(`Calcul terminé en ${U.fmt(res.elapsedMs / 1000, 1)} s (${res.evaluations} évaluations, plan retenu : ${res.strategy === 'constant' ? 'puissance constante' : ALGO_LABEL[res.strategy === 'gradient' ? 'gradient' : 'analytic']}).${res.physio ? ' ' + T.physioSummary(res.physio) : ''}`,
          res.physio && !res.physio.feasible);
        secPage = 0;
        T.hideSections();
        T.render();
        store.emit('plan', res);
      } catch (e) {
        console.error(e);
        setStatus('Erreur pendant le calcul : ' + e.message, true);
      } finally {
        running = false;
        btn.disabled = false;
        btn.textContent = 'Calculer la stratégie optimale';
        setTimeout(() => { bar.hidden = true; }, 400);
      }
    },

    /**
     * W′bal et temps avant épuisement à la puissance de chaque seconde : d'après la seule courbe de puissance record (RPP : ni PC ni W′),
     * et d'après le seul W′bal (W′ restant / (P − PC)). Référence : le profil de l'athlète à 100 % (défaut) ou, si l'on choisit
     * « forme », le profil ajusté à la forme, celui avec lequel le plan a été calculé. Les courbes à 100 % peuvent descendre à 0 :
     * au-dessus de 100 % de forme, le plan demande plus que l'athlète ne peut donner.
     */
    refreshCurves(res) {
      const useForm = res.margin !== 0 && store.state.perf.formRef === 'form';
      const ctx = PYR.sim.createContext(res.course, res.setup, res.athlete, { margin: useForm ? res.margin : 0 });
      const S = res.series;
      S.wbalRef = useForm ? S.wbal : PYR.physio.wbalSeries(S.P, S.P.length, res.athlete);
      S.tte = PYR.sim.recordTimeLeft(ctx, S.P, res.n);
      S.tteW = PYR.sim.wprimeTimeLeft(S.P, S.wbalRef, ctx.cp, res.n);
      res.cpRef = ctx.cp; res.w0Ref = ctx.w0;
      let wMin = Infinity;
      for (let t = 0; t < S.wbalRef.length; t++) if (S.wbalRef[t] < wMin) wMin = S.wbalRef[t];
      res.wbalMinRef = wMin;
    },

    /** Résumé de la vérification du plan sur le modèle physiologique (res.physio, optimizer.optimizePhysio). */
    physioSummary(ph) {
      const n = ph.runs.length, calcs = `${n} calcul${n > 1 ? 's' : ''}`;
      const red = ph.endK < 0.9995 ? `endurance du jour ramenée à ${U.fmt(ph.endK * 100, 1)} % de la courbe record au-delà de 20 min` : 'sans réduction';
      if (!ph.feasible) {
        return `Modèle physiologique : même après ${calcs} (${red}), le W′ se viderait de ${U.fmt(-ph.minW / 1000, 1)} kJ vers le km ${U.fmt(ph.sMin / 1000, 1)} — allège l'effort ou emporte de quoi manger et boire (matériel du compteur).`;
      }
      return `Modèle physiologique : plan vérifié seconde par seconde (${calcs}, ${red} ; PC effective prévue à l'arrivée ${Math.round(ph.endCpK * 100)} % de la PC, température centrale jusqu'à ${U.fmt(ph.maxTc, 1)} °C).`;
    },

    renderStale() {
      const el = $('#perf-status');
      if (store.plan && store.planStale) {
        el.textContent = 'Les paramètres ont changé depuis le calcul : relance-le pour mettre la stratégie à jour.';
        el.classList.add('error');
      }
    },

    render() {
      const plan = store.plan;
      $('#perf-results').hidden = !plan;
      if (!plan) { chart.setData(null); return; }
      const S = plan.series, st = plan.stats;
      const timeEl = $('#res-time');
      timeEl.textContent = U.fmtDuration(plan.tFinish);
      timeEl.classList.toggle('long', plan.tFinish >= 3600);
      const cmp = $('#res-compare');
      D.clear(cmp);
      if (plan.baseline) {
        const gain = plan.baseline.time - plan.tFinish;
        if (plan.strategy === 'constant') {
          cmp.append('Sur ce parcours très régulier, l\'allure constante est optimale : ', h('strong', null, `${Math.round(plan.baseline.power)} W`), ' tout du long.');
        } else {
          cmp.append(`À puissance constante (${Math.round(plan.baseline.power)} W, le maximum tenable) : ${U.fmtDuration(plan.baseline.time)} — soit `,
            h('span', { class: 'good' }, gain >= 0.5 ? `${U.fmtDuration(gain)} gagnées` : 'un temps équivalent'), ' grâce à la gestion de l\'effort.');
        }
        if (plan.strategy === 'gradient') cmp.append(h('span', { class: 'hint' }, ` Plan obtenu par ${ALGO_LABEL.gradient}.`));
      }
      const tiles = $('#res-tiles');
      D.clear(tiles);
      const tile = (l, v, u) => tiles.appendChild(D.stat(l, v, u));
      tile('Vitesse moyenne', U.fmt(st.avgSpeed * 3.6, 1), 'km/h');
      tile('Puissance moyenne', U.fmt(st.avgPower, 0), 'W');
      tile('Puissance normalisée', U.fmt(st.np, 0), 'W');
      tile('Intensité (IF)', U.fmt(st.IF, 2));
      tile('Charge (TSS)', U.fmt(st.tss, 0));
      tile('Travail', U.fmt(st.work / 1000, 0), 'kJ');
      tile('W/kg moyen', U.fmt(st.wkg, 2));
      tile('W′ minimum', U.fmt(plan.wbalMinRef / 1000, 1), 'kJ');
      tile('Puissance max', U.fmt(st.pMax, 0), 'W');
      tile('Vitesse max', U.fmt(st.maxSpeed * 3.6, 1), 'km/h');
      if (st.brakingTime > 0) tile('Freinage', U.fmtClock(st.brakingTime));
      if (st.stalled > 0) tile('À pied (pente)', U.fmtClock(st.stalled));
      const ph = plan.physio;   // vérification sur le modèle physiologique (option), sinon null
      if (ph) {
        tile('PC effective à l\'arrivée', U.fmt(ph.endCpK * plan.cpRef, 0), 'W');
        tile('Temp. centrale max', U.fmt(ph.maxTc, 1), '°C');
        if (ph.endK < 0.9995) tile('Endurance du jour', U.fmt(ph.endK * 100, 1), '%');
        if (ph.bonkT !== null) tile('Fringale', U.fmtClock(ph.bonkT));
      }

      // zones
      const zones = $('#res-zones'), legend = $('#res-zones-legend');
      D.clear(zones); D.clear(legend);
      const total = st.zones.reduce((a, b) => a + b, 0) || 1;
      PYR.physio.ZONES.forEach((z, i) => {
        const col = PYR.map.HEAT[i];
        const frac = st.zones[i] / total;
        if (frac > 0) zones.appendChild(h('div', { style: { width: (frac * 100) + '%', background: col }, title: `${z.id} ${z.label} : ${U.fmtClock(st.zones[i])}` }));
        legend.appendChild(h('div', null, h('span', { class: 'sw', style: { background: col } }), `${z.id} ${z.label} — ${U.fmtClock(st.zones[i])} (${U.fmt(frac * 100, 0)} %)`));
      });

      T.renderSplits();
      T.renderSeconds();

      const th = PYR.charts.theme();
      const n = plan.n;
      const kmh = new Float32Array(n + 1), wkj = new Float32Array(n + 1);
      for (let t = 0; t <= n; t++) { kmh[t] = S.v[t] * 3.6; wkj[t] = S.wbalRef[t] / 1000; }
      // modèle physiologique : PC effective prévue (sur la PC de référence) et W′bal effectif (s'il est sur la même référence que W′bal)
      let pcEff = null, effKj = null;
      if (ph) {
        pcEff = new Float32Array(ph.cpK.length);
        for (let t = 0; t < pcEff.length; t++) pcEff[t] = ph.cpK[t] * plan.cpRef;
        if (plan.margin === 0 || store.state.perf.formRef === 'form') {
          effKj = new Float32Array(ph.wbal.length);
          for (let t = 0; t < effKj.length; t++) effKj[t] = ph.wbal[t] / 1000;
        }
      }
      const panels = [
        { id: 'elev', label: 'Altitude', unit: 'm', color: th.elevLine, area: true, values: S.ele, weight: 0.8, fmt: (v) => U.fmt(v, 0) + ' m' },
        { id: 'power', label: 'Puissance', unit: 'W', color: th.s1, values: S.P, min: 0, weight: 1.4, refs: [{ v: plan.cpRef, label: `PC ${Math.round(plan.cpRef)} W` }], fmt: (v) => U.fmt(v, 0) + ' W',
          overlays: pcEff ? [{ label: 'PC effective prévue (modèle physiologique)', color: th.ink2, values: pcEff, fmt: (v) => U.fmt(v, 0) + ' W' }] : undefined },
        { id: 'speed', label: 'Vitesse', unit: 'km/h', color: th.s2, values: kmh, min: 0, fmt: (v) => U.fmt(v, 1) + ' km/h' },
        wbalPanel(plan, wkj, th, effKj),
      ];
      if (ph) {
        panels.push({
          id: 'tc', label: 'Température centrale', unit: '°C', color: th.critical || '#d03b3b', values: ph.Tc, weight: 0.8, tickDigits: 1,
          fmt: (v) => U.fmt(v, 2) + ' °C', refs: [{ v: ph.Tcrit, label: `zone critique ${U.fmt(ph.Tcrit, 1)} °C`, dash: true }],
        });
      }
      if (S.tte) {
        // Temps avant épuisement si l'on poursuit l'effort à la puissance de la seconde, calculé de deux façons :
        //  - d'après la seule courbe de puissance record (RPP : ni PC ni W′), avec ce qui a déjà été roulé : courbe principale ;
        //  - d'après le seul W′bal : W′ restant / (P − PC), infini sous la PC : trait plein de la couleur de W′bal.
        // Les deux sont plafonnés à 1,5 × la durée du plan ; en pointillé, ce qu'il reste à rouler : sous ce trait, la
        // puissance du moment ne se tiendrait pas jusqu'à l'arrivée.
        const cap = 1.5 * plan.tFinish, len = S.tte.length;
        const tenable = new Float32Array(len), tenableW = new Float32Array(len), toGo = new Float32Array(len);
        for (let t = 0; t < len; t++) {
          tenable[t] = Math.min(S.tte[t], cap) / 60;
          tenableW[t] = Math.min(S.tteW ? S.tteW[t] : Infinity, cap) / 60;
          toGo[t] = Math.max(0, plan.tFinish - t) / 60;
        }
        const clock = (min) => U.fmtClock(Math.round(min * 60));
        const capped = (v) => (v * 60 >= cap - 1 ? '≥ ' : '') + clock(v);
        const overlays = [];
        if (S.tteW) overlays.push({ label: 'Temps avant épuisement de W′bal', color: th.s3, values: tenableW, fmt: capped, dash: false });
        overlays.push({ label: 'Temps restant avant l\'arrivée', color: th.ink2, values: toGo, fmt: clock });
        panels.push({
          id: 'tte', label: 'Temps avant épuisement', seriesLabel: 'Temps avant limite RPP (courbe de puissance record)',
          unit: 'min', color: th.s4, values: tenable, min: 0, weight: 1.1, fmt: capped, overlays,
        });
      }
      chart.setData({
        n, x: $('[data-xaxis][aria-pressed="true"]').dataset.xaxis, s: S.s, sEnd: plan.inputs.length, tEnd: plan.tFinish,
        panels,
        extraRows: (t) => {
          const i = Math.min(t, n - 1);
          const rows = [{ value: U.fmt(S.grade[i] * 100, 1) + ' %', label: 'pente' }];
          if (S.W[i] > 0.1) rows.push({ value: U.fmt(Math.abs(S.wh[i]) * 3.6, 0) + ' km/h', label: S.wh[i] >= 0 ? 'vent de face' : 'vent de dos' });
          if (S.brk[i]) rows.push({ value: 'freinage', label: '' });
          return rows;
        },
      });
    },

    renderSplits() {
      const plan = store.plan, S = plan.series;
      const L = plan.inputs.length;
      const stepKm = L <= 60000 ? 1 : L <= 200000 ? 5 : 10;
      const table = $('#res-splits');
      D.clear(table);
      table.appendChild(h('thead', null, h('tr', null, ...['Km', 'Passage', 'Durée', 'P moy.', 'Vitesse', 'Pente'].map((x) => h('th', null, x)))));
      const body = h('tbody');
      let t = 0, lastPass = 0, prev = 0;
      for (let km = stepKm; ; km += stepKm) {
        const target = Math.min(km * 1000, L);
        while (t < plan.n - 1 && S.s[t + 1] < target) t++;
        // instant de passage interpolé
        const sa = S.s[t], sb = S.s[t + 1];
        const tPass = target >= L ? plan.tFinish : Math.min(plan.tFinish, t + (sb > sa ? (target - sa) / (sb - sa) : 0));
        let sum = 0, cnt = 0;
        for (let k = Math.floor(lastPass); k < Math.min(plan.n, Math.ceil(tPass)); k++) { sum += S.P[k]; cnt++; }
        const segLen = target - prev;
        const dur = tPass - lastPass;
        const grade = (PYR.course.eleAt(plan.course, target) - PYR.course.eleAt(plan.course, prev)) / Math.max(1, segLen);
        body.appendChild(h('tr', null,
          h('td', null, U.fmt(target / 1000, target % 1000 ? 1 : 0)),
          h('td', null, U.fmtClock(tPass)),
          h('td', null, U.fmtClock(dur)),
          h('td', null, U.fmt(cnt ? sum / cnt : 0, 0) + ' W'),
          h('td', null, U.fmt(segLen / Math.max(1, dur) * 3.6, 1) + ' km/h'),
          h('td', null, U.fmt(grade * 100, 1) + ' %')));
        lastPass = tPass; prev = target;
        if (target >= L) break;
      }
      table.appendChild(body);
    },

    renderSeconds() {
      const plan = store.plan;
      if (!plan) return;
      const S = plan.series;
      const pages = Math.max(1, Math.ceil(plan.n / SEC_PAGE));
      const range = $('#sec-range');
      range.max = String(pages - 1);
      secPage = U.clamp(secPage, 0, pages - 1);
      range.value = String(secPage);
      const a = secPage * SEC_PAGE, b = Math.min(plan.n, a + SEC_PAGE);
      $('#sec-label').textContent = `${U.fmtClock(a)} → ${U.fmtClock(b)} (${secPage + 1}/${pages})`;
      const table = $('#res-seconds');
      D.clear(table);
      table.appendChild(h('thead', null, h('tr', null, ...['Temps', 'Km', 'Puissance', 'Vitesse', 'Pente', 'Vent face', 'W′bal'].map((x) => h('th', null, x)))));
      const body = h('tbody');
      for (let t = a; t < b; t++) {
        body.appendChild(h('tr', null,
          h('td', null, U.fmtClock(t)),
          h('td', null, U.fmt(S.s[t] / 1000, 2)),
          h('td', null, h('strong', null, U.fmt(S.P[t], 0) + ' W')),
          h('td', null, U.fmt(S.v[t] * 3.6, 1)),
          h('td', null, U.fmt(S.grade[t] * 100, 1) + ' %'),
          h('td', null, S.W[t] > 0.1 ? U.fmt(S.wh[t] * 3.6, 0) : '–'),
          h('td', null, U.fmt(S.wbalRef[t] / 1000, 1))));
      }
      table.appendChild(body);
    },

    /** Tronçons à exporter : ceux du découpage choisi, sinon le découpage automatique de l'export. */
    exportOpts() {
      return { name: 'Plan PaceYourRide', ftp: store.get('rider.ftp'), start: Math.floor(Date.now() / 60000) * 60000, cuts: cuts || undefined };
    },

    /** Limites du découpage automatique (au plus 50 tronçons, la limite des compteurs pour un entraînement). */
    autoCuts() {
      return PYR.planGpx.sections(store.plan, { max: PYR.planWorkout.FIT_MAX_STEPS }).slice(1).map((g) => g.a);
    },

    /** « Découper en tronçons » : découpe le plan (automatiquement la première fois) et rend les limites modifiables sur le profil et la carte. */
    split() {
      if (!store.plan) return;
      if (!cuts) cuts = T.autoCuts();
      editing = true;
      T.refreshSections();
    },

    /** Recalcule les tronçons du découpage en cours et les montre. */
    refreshSections() {
      if (cuts && store.plan) T.showSections(PYR.planGpx.sections(store.plan, { cuts }), 'Découpage');
    },

    /** Montre les tronçons retenus (carte : couleurs alternées, puissance cible à l'entrée ; graphiques : bandes et limites ; tableau). */
    showSections(secs, kind) {
      shown = secs.map((g) => {
        const P = Math.round(g.P / 5) * 5;
        return { a: g.a, b: g.b, t0: g.t0, t1: g.t1, kmh: (g.b - g.a) / Math.max(1e-6, g.t1 - g.t0) * 3.6, grade: g.grade, P, label: `${P} W`, title: `Km ${U.fmt(g.a / 1000, 1)} → ${U.fmt(g.b / 1000, 1)} : ${P} W · ${U.fmt((g.b - g.a) / Math.max(1e-6, g.t1 - g.t0) * 3.6, 1)} km/h · ${U.fmtClock(g.t1 - g.t0)}` };
      });
      const ed = cuts && editing ? editor : null;
      chart.setSegments(shown, ed);
      PYR.map.setSections(shown, ed);
      const n = shown.length, over = n > PYR.planWorkout.FIT_MAX_STEPS;
      $('#seg-note').textContent = cuts
        ? `${n} tronçons${over ? ` : au-delà de ${PYR.planWorkout.FIT_MAX_STEPS}, l'entraînement FIT est refusé (supprime des limites)` : ''}.${editing ? ' Glisse une limite sur le profil ou la carte ; double clic (profil) ou clic (carte, près du tracé) pour en ajouter, double clic sur une limite pour la supprimer.' : ''}`
        : `${kind} : ${n} tronçons affichés sur la carte et les graphiques`;
      $('#seg-note').classList.toggle('warn', !!(cuts && over));
      $('#btn-seg-edit').textContent = editing ? 'Terminer la modification' : 'Modifier le découpage';
      $('#btn-seg-auto').hidden = !cuts;
      $('#seg-bar').hidden = false;
      // tableau : un tronçon par ligne, ce que contiendra l'export
      const wrap = $('#seg-table-wrap'), table = $('#seg-table');
      wrap.hidden = !cuts;
      if (cuts) {
        D.clear(table);
        table.appendChild(h('thead', null, h('tr', null, ...['N°', 'Km', 'Longueur', 'Puissance cible', 'Vitesse', 'Temps', 'Pente'].map((x) => h('th', null, x)))));
        const body = h('tbody');
        shown.forEach((s, i) => body.appendChild(h('tr', null,
          h('td', null, i + 1),
          h('td', null, `${U.fmt(s.a / 1000, 2)} → ${U.fmt(s.b / 1000, 2)}`),
          h('td', null, U.fmt((s.b - s.a) / 1000, 2) + ' km'),
          h('td', null, s.P + ' W'),
          h('td', null, U.fmt(s.kmh, 1) + ' km/h'),
          h('td', null, U.fmtClock(s.t1 - s.t0)),
          h('td', null, U.fmt(s.grade * 100, 1) + ' %'))));
        table.appendChild(body);
      }
    },

    hideSections() {
      shown = null; cuts = null; editing = false;
      if (chart) chart.setSegments(null);
      PYR.map.setSections(null);
      $('#seg-bar').hidden = true;
    },

    /** GPX du plan pour un compteur : trace et heures de passage, avec un repère de puissance par tronçon. */
    exportGpx() {
      const plan = store.plan;
      if (!plan) return;
      const { gpx, sections } = PYR.planGpx.build(plan, T.exportOpts());
      D.download('plan-paceyourride.gpx', gpx, 'application/gpx+xml');
      T.showSections(sections, 'GPX');
      D.toast(`Plan exporté : ${sections.length} repères de puissance le long du parcours.`);
    },

    /** TCX du plan : un tour par tronçon (temps, distance) et un point de parcours avec puissance cible, vitesse moyenne et temps. */
    exportTcx() {
      const plan = store.plan;
      if (!plan) return;
      const { tcx, sections } = PYR.planGpx.buildTcx(plan, T.exportOpts());
      D.download('plan-paceyourride.tcx', tcx, 'application/vnd.garmin.tcx+xml');
      T.showSections(sections, 'TCX');
      D.toast(`Plan exporté (TCX) : ${sections.length} tronçons avec puissance cible, vitesse moyenne et temps.`);
    },

    /** Entraînement structuré du plan : FIT (étapes en distance, cible en watts), ZWO ou MRC (étapes en durée, % de la PMA). */
    exportWorkout(kind) {
      const plan = store.plan;
      if (!plan) return;
      const W = PYR.planWorkout, opts = T.exportOpts();
      if (kind === 'fit') {
        if (cuts && cuts.length + 1 > W.FIT_MAX_STEPS) {
          D.toast(`Un entraînement FIT est limité à ${W.FIT_MAX_STEPS} étapes (${cuts.length + 1} tronçons) : supprime des limites.`, 'error');
          return;
        }
        const { fit, sections } = W.buildFit(plan, opts);
        D.download('plan-paceyourride.fit', new Blob([fit], { type: 'application/octet-stream' }));
        T.showSections(sections, 'FIT');
        D.toast(`Entraînement FIT exporté : ${sections.length} étapes avec puissance cible et distance.`);
      } else if (kind === 'zwo') {
        const { zwo, steps } = W.buildZwo(plan, opts);
        D.download('plan-paceyourride.zwo', zwo, 'application/xml');
        T.showSections(steps.map((s) => s.g), 'ZWO');
        D.toast(`Entraînement ZWO exporté : ${steps.length} étapes, puissances en % de la PMA (${Math.round(opts.ftp)} W).`);
      } else {
        const { mrc, steps } = W.buildMrc(plan, opts);
        D.download('plan-paceyourride.mrc', mrc, 'text/plain;charset=utf-8');
        T.showSections(steps.map((s) => s.g), 'MRC');
        D.toast(`Entraînement MRC exporté : ${steps.length} étapes, puissances en % de la PMA (${Math.round(opts.ftp)} W).`);
      }
    },

    exportCsv() {
      const plan = store.plan;
      if (!plan) return;
      const S = plan.series;
      const num = (v, d) => Number(v).toFixed(d).replace('.', ',');
      const ph = plan.physio;   // modèle physiologique : PC effective prévue et température centrale en plus
      const lines = ['temps_s;temps;distance_m;altitude_m;pente_pct;puissance_W;vitesse_kmh;wbal_kJ;vent_face_kmh;vent_lateral_kmh;freinage'
        + (ph ? ';pc_effective_W;temp_centrale_C' : '')];
      for (let t = 0; t < plan.n; t++) {
        const row = [t, U.fmtClock(t), num(S.s[t], 1), num(S.ele[t], 1), num(S.grade[t] * 100, 2), num(S.P[t], 0), num(S.v[t] * 3.6, 2),
          num(S.wbalRef[t] / 1000, 2), num(S.wh[t] * 3.6, 1), num(S.wc[t] * 3.6, 1), S.brk[t] ? 1 : 0];
        if (ph) row.push(num(ph.cpK[t] * plan.cpRef, 0), num(ph.Tc[t], 2));
        lines.push(row.join(';'));
      }
      D.download('strategie-paceyourride.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    },
  };

  function setStatus(text, error) {
    const el = $('#perf-status');
    el.textContent = text || '';
    el.classList.toggle('error', !!error);
  }

  PYR.tabPerf = T;
})(globalThis.PYR = globalThis.PYR || {});
