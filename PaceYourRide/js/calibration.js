/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page Équipements (PaceYourRide/equipement.html) : calibration du CdA et du Crr depuis une sortie réelle (GPX / TCX avec puissance). */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store, A = PYR.activity;
  const { h, $ } = D;

  let act = null;       // sortie lue (activity.parse)
  let chart = null;
  let result = null;    // dernière estimation

  const setup = () => PYR.physics.buildSetup(store.state.rider, store.state.bike);
  const inputs = () => ({
    windKmh: Math.max(0, Number($('#cal-wind').value) || 0),
    windDir: ((Number($('#cal-wdir').value) || 0) % 360 + 360) % 360,
    tempC: Number.isFinite(Number($('#cal-temp').value)) && $('#cal-temp').value !== '' ? Number($('#cal-temp').value) : 15,
    mass: Number($('#cal-mass').value) > 0 ? Number($('#cal-mass').value) : 0,
    mode: $('#cal-mode').value,
  });

  /** Valeurs manquantes (trou, bords) remplacées par la dernière valeur connue : le graphique n'aime pas les NaN. */
  function fill(a, n) {
    const out = new Float32Array(n);
    let last = 0;
    for (let i = 0; i < n; i++) { if (Number.isFinite(a[i])) last = a[i]; out[i] = last; }
    let first = a.findIndex(Number.isFinite);
    if (first > 0) for (let i = 0; i < first; i++) out[i] = out[first];
    return out;
  }

  function showSummary(prep) {
    const box = $('#cal-summary');
    D.clear(box);
    const dur = prep.duration, km = prep.length / 1000;
    let gain = 0, pSum = 0, pCnt = 0;
    for (let t = 1; t < prep.n; t++) { const d = prep.ele[t] - prep.ele[t - 1]; if (d > 0) gain += d; }
    for (let t = 0; t < prep.n; t++) if (Number.isFinite(prep.Praw[t])) { pSum += prep.Praw[t]; pCnt++; }
    box.appendChild(D.stat('Distance', U.fmt(km, 1), 'km'));
    box.appendChild(D.stat('Durée', U.fmtClock(dur)));
    box.appendChild(D.stat('Vitesse moyenne', U.fmt(km / (dur / 3600), 1), 'km/h'));
    box.appendChild(D.stat('Dénivelé +', U.fmt(gain, 0), 'm'));
    box.appendChild(D.stat('Puissance moyenne', pCnt ? U.fmt(pSum / pCnt, 0) : '–', pCnt ? 'W' : ''));
  }

  async function onFile(e) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      act = A.parse(await D.readFile(f));
    } catch (err) {
      D.toast('Import impossible : ' + err.message, 'error');
      return;
    }
    result = null;
    $('#cal-name').textContent = `${f.name} — ${act.format.toUpperCase()}, ${act.points.length} points`;
    $('#cal-body').hidden = false;
    $('#cal-result').hidden = true;
    $('#cal-temp').value = Number.isFinite(Number(store.state.env.temperature)) ? store.state.env.temperature : 15;
    $('#cal-mass').placeholder = `${U.fmt(setup().mass, 1)} (cycliste + vélo)`;
    // résumé, et ce qui manque éventuellement à l'estimation
    const problems = [];
    if (!act.hasTime) problems.push('pas d\'heure');
    if (!act.hasEle) problems.push('pas d\'altitude');
    if (!act.hasPower) problems.push('pas de puissance');
    const prob = $('#cal-problem');
    try {
      showSummary(A.prepare(act, inputs()));
    } catch (err) {
      D.clear($('#cal-summary'));
      problems.push(err.message);
    }
    prob.hidden = !problems.length;
    prob.textContent = problems.length ? `Estimation impossible : ${problems.join(' ; ')}. Le tracé peut tout de même servir de parcours.` : '';
    $('#cal-controls').hidden = !!problems.length && (!act.hasTime || !act.hasEle || !act.hasPower);
  }

  function run() {
    if (!act) return;
    const o = inputs();
    let prep, r;
    try {
      prep = A.prepare(act, o);
      r = A.fit(prep, setup(), { mode: o.mode, mass: o.mass, windKmh: o.windKmh });
    } catch (err) { D.toast(err.message, 'error'); return; }
    if (!r.ok) { D.toast(r.error, 'error', 7000); $('#cal-result').hidden = true; return; }
    result = r;
    showSummary(prep);
    render(prep, r);
  }

  function render(prep, r) {
    const s = setup(), st = $('#cal-stats');
    D.clear(st);
    const pm = (v, se, d) => (Number.isFinite(se) ? `${U.fmt(v, d)} ± ${U.fmt(se, d)}` : U.fmt(v, d));
    const cdaFree = r.mode !== 'crr', crrFree = r.mode !== 'cda';
    st.appendChild(D.stat(cdaFree ? 'CdA estimé' : 'CdA (inchangé)', pm(r.cda, r.seCda, 3), 'm²'));
    st.appendChild(D.stat('CdA actuel du vélo', U.fmt(s.cda, 3), 'm²'));
    st.appendChild(D.stat(crrFree ? 'Crr estimé' : 'Crr (inchangé)', pm(r.crr, r.seCrr, 4)));
    st.appendChild(D.stat('Crr actuel du vélo', U.fmt(s.crr, 4)));
    st.appendChild(D.stat('Écart modèle / mesure', U.fmt(r.rmse, 1), 'W'));
    st.appendChild(D.stat('Données exploitées', U.fmt(r.share * 100, 0), '%'));
    if (r.mode === 'both') st.appendChild(D.stat('Corrélation CdA / Crr', U.fmt(r.corr, 2)));
    const ul = $('#cal-warnings');
    D.clear(ul);
    for (const w of r.warnings) ul.appendChild(h('li', null, w));
    $('#cal-apply-cda').hidden = !cdaFree;
    $('#cal-apply-crr').hidden = !crrFree;
    $('#cal-result').hidden = false;

    const n = prep.n;
    chart.setData({
      n, x: 'dist', s: Float32Array.from(prep.s), sEnd: prep.length, tEnd: prep.duration,
      panels: [
        { id: 'elev', label: 'Altitude', unit: 'm', color: PYR.charts.theme().elevLine, area: true, values: fill(prep.ele, n), weight: 0.8, fmt: (v) => U.fmt(v, 0) + ' m' },
        {
          id: 'power', label: 'Puissance moyenne sur 30 s', seriesLabel: 'mesurée', unit: 'W', color: PYR.charts.theme().s1, values: fill(r.series.P, n), min: 0, weight: 1.6, fmt: (v) => U.fmt(v, 0) + ' W',
          overlays: [{ label: 'modélisée', color: PYR.charts.theme().s2, values: fill(r.series.Pmodel, n), fmt: (v) => U.fmt(v, 0) + ' W', dash: false }],
        },
        { id: 'speed', label: 'Vitesse', unit: 'km/h', color: PYR.charts.theme().s3, values: fill(Float32Array.from(r.series.v, (x) => x * 3.6), n), min: 0, weight: 0.8, fmt: (v) => U.fmt(v, 1) + ' km/h' },
      ],
    });
  }

  function apply(what) {
    if (!result) return;
    if (what === 'cda') {
      store.set('bike.cdaOverride', +result.cda.toFixed(3));
      D.toast(`CdA de ${U.fmt(result.cda, 3)} m² appliqué (champ « CdA total mesuré »).`);
    } else {
      store.set('bike.tire', 'custom');
      store.set('bike.crrCustom', +result.crr.toFixed(4));
      D.toast(`Crr de ${U.fmt(result.crr, 4)} appliqué (pneus « Personnalisé »). Il vaut pour le revêtement de référence : les portions du parcours le modulent.`);
    }
    PYR.app.refreshBindings();
  }

  function asRoute() {
    if (!act) return;
    if (store.state.route.waypoints.length && !confirm('Remplacer le tracé actuel par celui de la sortie ?')) return;
    try {
      const points = act.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)).map((p) => [p.lat, p.lng, Number.isFinite(p.ele) ? p.ele : null]);
      PYR.routeModel.importGpx({ name: act.name, points, hasEle: act.hasEle });
      D.toast(`Tracé importé : ${points.length} points.`);
      PYR.app.showTab('route');
    } catch (err) { D.toast('Import du tracé impossible : ' + err.message, 'error'); }
  }

  PYR.calibration = {
    init() {
      chart = new PYR.charts.SeriesChart($('#cal-chart'), {});
      $('#cal-file').addEventListener('change', onFile);
      $('#cal-run').addEventListener('click', run);
      $('#cal-apply-cda').addEventListener('click', () => apply('cda'));
      $('#cal-apply-crr').addEventListener('click', () => apply('crr'));
      $('#cal-as-route').addEventListener('click', asRoute);
      // l'estimation dépend de tout ce qui est saisi : on invite à la refaire plutôt que d'afficher un résultat périmé
      ['cal-wind', 'cal-wdir', 'cal-temp', 'cal-mass', 'cal-mode'].forEach((id) => $('#' + id).addEventListener('change', () => { if (result) run(); }));
    },
  };
})(globalThis.PYR = globalThis.PYR || {});
