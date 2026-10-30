/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page Athlète (PaceYourRide/athlete.html) : profil estimé depuis l'historique des sorties (archive d'export d'un compte Strava, dossier ou
 * fichiers FIT / GPX / TCX, éventuellement compressés en .gz), sur le modèle de la calibration (calibration.js) : lire, estimer, afficher,
 * puis « Appliquer » ce qui est coché (records, CP2, W′, FC maximale, VO₂max). Les fichiers sont lus sur l'appareil (zip.js, replay.load,
 * history.js), par lots, sans bloquer la page ; rien n'est envoyé. */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store, Pz = PYR.physio, H = PYR.history, Z = PYR.zip;
  const { h, $ } = D;
  const ACT_RE = /\.(fit|gpx|tcx)(\.gz)?$/i, CSV_RE = /(^|\/)activities\.csv$/i;
  const SLICE_MS = 40;        // ms de calcul entre deux pauses rendues au navigateur

  let data = null;            // dernière lecture : { rides, errors, other, ebike, total, read, stopped }
  let agg = null;             // profil sur la période choisie (history.aggregate)
  let checked = new Map();    // 'rec:60', 'cp' (CP2 et W′, ajustées ensemble), 'hrMax', 'vo2max' → coché
  let busy = false, stop = false;
  let chart = null;

  // pause rendue au navigateur : MessageChannel plutôt que setTimeout(0), ralenti à 1 s dans un onglet en arrière-plan
  const tick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
  const bytesOf = async (f) => new Uint8Array(await f.arrayBuffer());
  const day = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleDateString('fr-FR') : '?');

  /** Sorties à lire (fichiers isolés, dossier, archives zip) et index de l'export Strava (activities.csv : type de chaque activité). */
  async function collect(files) {
    const sources = [], csv = [], bad = [];
    for (const f of files) {
      const path = f.webkitRelativePath || f.name;
      if (/\.zip$/i.test(f.name)) {
        let entries;
        try { entries = await Z.list(f); } catch (e) { bad.push({ name: f.name, msg: e.message }); continue; }
        for (const e of entries) {
          if (e.dir) continue;
          if (CSV_RE.test(e.name)) csv.push(() => Z.read(f, e));
          else if (ACT_RE.test(e.name)) sources.push({ name: e.name, read: () => Z.read(f, e) });
        }
      } else if (CSV_RE.test(path)) csv.push(() => bytesOf(f));
      else if (ACT_RE.test(f.name)) sources.push({ name: path, read: () => bytesOf(f) });
    }
    const index = new Map();
    for (const c of csv) {
      try { for (const [k, v] of H.stravaIndex(new TextDecoder('utf-8').decode(await c()))) index.set(k, v); } catch (e) { /* index illisible : tout est lu */ }
    }
    // les plus récentes d'abord (numéros d'activité Strava croissants avec le temps, noms datés) : « Arrêter » garde les sorties récentes
    const num = (s) => { const m = /^(\d+)(\.[a-z]+)+$/i.exec(H.baseName(s.name)); return m ? Number(m[1]) : -1; };
    sources.sort((a, b) => num(b) - num(a) || (H.baseName(b.name) > H.baseName(a.name) ? 1 : -1));
    return { sources, index, bad };
  }

  function setBusy(on) {
    busy = on;
    $('#imp-progress').hidden = !on;
    ['#imp-files', '#imp-dir'].forEach((s) => { $(s).disabled = on; });
    D.$$('#imp-box label.btn').forEach((l) => l.classList.toggle('disabled', on));
  }

  function progress(i, n, res) {
    $('#imp-bar').style.width = `${Math.round(100 * i / Math.max(1, n))}%`;
    $('#imp-status').textContent = `Lecture : ${i} / ${n} fichiers — ${res.rides.length} sortie${res.rides.length > 1 ? 's' : ''} de vélo`
      + `, dont ${res.rides.filter((r) => r.hasPower).length} avec puissance`;
  }

  async function run(files) {
    if (busy || !files.length) return;
    setBusy(true);
    stop = false;
    $('#imp-name').textContent = files.length === 1 ? files[0].name : `${files.length} fichiers`;
    $('#imp-status').textContent = 'Recherche des sorties…';
    $('#imp-bar').style.width = '0%';
    try {
      const { sources, index, bad } = await collect(files);
      if (!sources.length) {
        D.toast(bad.length ? `Archive illisible : ${bad[0].name} (${bad[0].msg}).`
          : 'Aucune sortie trouvée : il faut des fichiers .fit, .gpx ou .tcx (éventuellement .gz), ou une archive zip qui en contient.', 'error', 7000);
        return;
      }
      const res = { rides: [], errors: bad.slice(), other: 0, ebike: 0, total: sources.length, read: 0, stopped: false };
      let t0 = performance.now();
      for (let i = 0; i < sources.length; i++) {
        if (stop) { res.stopped = true; break; }
        const s = sources[i], meta = index.get(H.baseName(s.name));
        const pre = meta ? H.sportClass(meta.type) : 'unknown';
        if (pre === 'other' || pre === 'ebike') res[pre]++;      // autre sport d'après l'export : pas besoin de lire le fichier
        else {
          try {
            let b = await s.read();
            if (Z.isGzip(b)) b = await Z.gunzip(b);
            if (/\.fit(\.gz)?$/i.test(s.name) && !PYR.replay.isFit(b)) throw new Error('ce n\'est pas un fichier FIT');
            const ride = H.analyze(PYR.replay.load(b, { anyPos: true }), { type: meta && meta.type, name: meta && meta.name, file: s.name });
            if (ride.sport === 'other' || ride.sport === 'ebike') res[ride.sport]++;
            else res.rides.push(ride);
          } catch (e) { res.errors.push({ name: s.name, msg: (e && e.message) || String(e) }); }
        }
        res.read = i + 1;
        if (performance.now() - t0 > SLICE_MS) { progress(i + 1, sources.length, res); await tick(); t0 = performance.now(); }
      }
      progress(res.read, sources.length, res);
      data = res;
      show(true);
      $('#imp-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      D.toast('Import impossible : ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  /** Coches par défaut : tout ce qui est estimé, sauf les valeurs de fiabilité faible (CP2 et W′ vont ensemble : il les faut toutes deux). */
  function defaultChecks(a) {
    const ok = (rl) => !!rl && rl.level !== 'faible';
    const m = new Map();
    Pz.DURATIONS.forEach((d, i) => m.set('rec:' + d, a.env[i] > 0 && ok(a.rel.records[i])));
    m.set('cp', !!a.fit && ok(a.rel.cp) && ok(a.rel.wPrime));
    m.set('hrMax', !!a.hr && ok(a.rel.hrMax));
    m.set('vo2max', a.vo2max > 0 && ok(a.rel.vo2max));
    return m;
  }

  /** Profil sur la période choisie ; reset : coches par défaut (nouvelle lecture, autre période). */
  function show(reset) {
    if (!data) return;
    const r = store.state.rider;
    agg = H.aggregate(data.rides, { days: Number($('#imp-window').value) || 0, mass: Number(r.weight) || 72, age: Number(r.age) || 35 });
    if (reset) checked = defaultChecks(agg);
    render();
    $('#imp-result').hidden = false;
  }

  const relCell = (rl) => (rl
    ? h('td', { class: 'imp-rel' }, h('b', { class: 'rel rel-' + rl.level }, rl.level), h('small', null, rl.why))
    : h('td', { class: 'imp-rel' }, h('span', { class: 'hint' }, '–')));

  function check(key, label, enabled) {
    const cb = h('input', { type: 'checkbox', 'data-key': key, 'aria-label': 'Appliquer : ' + label });
    cb.checked = enabled && !!checked.get(key);
    cb.disabled = !enabled;
    cb.addEventListener('change', () => { checked.set(key, cb.checked); syncChecks(); });
    return cb;
  }

  /** Une clé peut avoir deux cases (Pmax = record 1 s ; CP2 et W′) : on les aligne, et on compte la sélection. */
  function syncChecks() {
    D.$$('#imp-result input[data-key]').forEach((cb) => { if (!cb.disabled) cb.checked = !!checked.get(cb.dataset.key); });
    const recs = Pz.DURATIONS.filter((d, i) => agg.env[i] > 0);
    const all = $('#imp-rec-all');
    const n = recs.filter((d) => checked.get('rec:' + d)).length;
    all.checked = n > 0 && n === recs.length;
    all.indeterminate = n > 0 && n < recs.length;
    all.disabled = !recs.length;
    const total = n + (checked.get('cp') ? 2 : 0) + ['hrMax', 'vo2max'].filter((k) => checked.get(k)).length;
    $('#imp-apply').disabled = !total;
    $('#imp-apply').textContent = total ? `Appliquer la sélection (${total})` : 'Appliquer la sélection';
  }

  function render() {
    const a = agg, r = store.state.rider;
    const ath = Pz.buildAthlete(r), card = PYR.metabo.card(r, ath);
    const w = Number(r.weight) || 72;

    // synthèse
    const st = $('#imp-summary');
    D.clear(st);
    st.appendChild(D.stat('Sorties de vélo', `${a.nRides}`, data.rides.length !== a.nRides ? `sur ${data.rides.length}` : ''));
    st.appendChild(D.stat('Avec puissance', `${a.nPower}`));
    st.appendChild(D.stat('Avec FC', `${a.nHr}`));
    st.appendChild(D.stat('Période', a.nRides ? `${day(a.fromMs)} – ${day(a.toMs)}` : '–'));

    // remarques
    const ul = $('#imp-warnings');
    D.clear(ul);
    const li = (t) => ul.appendChild(h('li', null, t));
    if (data.stopped) li(`Lecture arrêtée : ${data.read} fichiers lus sur ${data.total} (les plus récents d'abord).`);
    if (data.other) li(`${data.other} activité${data.other > 1 ? 's' : ''} d'autres sports écartée${data.other > 1 ? 's' : ''} (course à pied, marche, natation…).`);
    if (data.ebike) li(`${data.ebike} sortie${data.ebike > 1 ? 's' : ''} à assistance électrique écartée${data.ebike > 1 ? 's' : ''}.`);
    if (data.errors.length) {
      const ex = data.errors.slice(0, 3).map((e) => `${H.baseName(e.name)} (${e.msg})`).join(' ; ');
      li(`${data.errors.length} fichier${data.errors.length > 1 ? 's' : ''} illisible${data.errors.length > 1 ? 's' : ''} : ${ex}${data.errors.length > 3 ? '…' : ''}`);
    }
    let spikes = 0, hrBad = 0;
    for (const x of a.rides) { spikes += x.spikes; hrBad += x.hrDropped; }
    if (spikes || hrBad) li(`Artefacts écartés sur la période : ${spikes} s de puissance (pics isolés, valeurs de plus de 2 500 W), ${hrBad} s de fréquence cardiaque (hors de 30–230 bpm, sauts de plus de 20 bpm/s).`);
    if (!a.nRides) li('Aucune sortie de vélo sur la période : élargis-la.');
    else if (!a.nPower) li('Aucune sortie avec puissance sur la période : pas de courbe de puissance (élargis la période ?).');

    // paramètres
    const fit = a.fit;
    const tb = $('#imp-params tbody');
    D.clear(tb);
    const est = (src) => (src === 'saisie' ? '' : ' (estimée)');
    const row = (key, label, value, cur, rl) => tb.appendChild(h('tr', null,
      h('td', null, check(key, label, value !== null)), h('td', null, label), h('td', { class: 'num' }, value === null ? '–' : value),
      h('td', { class: 'num cur' }, cur), relCell(rl)));
    row('cp', 'CP2 (puissance critique)', fit ? `${U.fmt(fit.cp, 0)} W` : null, `${U.fmt(ath.cp, 0)} W${est(ath.cpSource)}`, a.rel.cp);
    row('cp', 'W′ (avec CP2)', fit ? `${U.fmt(fit.wPrime / 1000, 1)} kJ` : null, `${U.fmt(ath.w0 / 1000, 1)} kJ${est(ath.w0Source)}`, a.rel.wPrime);
    row('rec:1', 'Pmax (record 1 s)', a.pmax > 0 ? `${U.fmt(a.pmax, 0)} W` : null,
      `${U.fmt(ath.pmax, 0)} W${est(ath.pmaxSource === 'saisie' || Number(r.records[1]) > 0 ? 'saisie' : '')}`, a.rel.pmax);
    row('hrMax', 'FC maximale', a.hr ? `${a.hr.value} bpm` : null, `${U.fmt(card.values.hrMax, 0)} bpm${est(card.src.hrMax)}`, a.rel.hrMax);
    row('vo2max', 'VO₂max', a.vo2max > 0 ? `${U.fmt(a.vo2max, 1)} mL/min/kg` : null,
      `${U.fmt(card.values.vo2max, 1)} mL/min/kg${est(card.src.vo2max)}`, a.rel.vo2max);
    $('#imp-model').textContent = fit
      ? `Modèle de Morton ajusté sur l'enveloppe de 1 s à 20 min : CP2 ${U.fmt(fit.cp, 0)} W, W′ ${U.fmt(fit.wPrime / 1000, 1)} kJ, Pmax du modèle ${U.fmt(fit.pmax, 0)} W (écart moyen ${U.fmt(fit.rms * 100, 1)} %). La Pmax retenue est ta meilleure seconde, artefacts écartés. VO₂max pour ${U.fmt(w, 1)} kg.`
      : 'Pas assez de durées avec puissance pour ajuster le modèle de Morton (il faut des sorties avec puissance de plus de 2 min).';

    // records
    const rb = $('#imp-records tbody');
    D.clear(rb);
    Pz.DURATIONS.forEach((d, i) => {
      const v = a.env[i], src = a.best[i], has = v > 0;
      const user = Number(r.records[d]) > 0;
      rb.appendChild(h('tr', null,
        h('td', null, check('rec:' + d, `record ${Pz.durationLabel(d)}`, has)),
        h('td', null, Pz.durationLabel(d)),
        h('td', { class: 'num' }, has ? `${U.fmt(v, 0)} W` : '–',
          has && src ? h('small', null, `${day(src.startMs)}${src.name ? ' · ' + src.name : ''}`) : null),
        h('td', { class: 'num cur' + (user ? '' : ' est') }, user ? `${U.fmt(r.records[d], 0)} W` : `${U.fmt(ath.curve.values[i], 0)} W`),
        relCell(a.rel.records[i])));
    });
    syncChecks();

    // graphique : enveloppe (points), courbe interpolée, modèle de Morton
    const recs = {};
    Pz.DURATIONS.forEach((d, i) => { if (a.env[i] > 0) recs[d] = a.env[i]; });
    $('#imp-chart-wrap').hidden = !a.nPower;
    if (a.nPower) {
      const curve = Pz.buildCurve(recs, 0);
      chart.setData({
        durations: Pz.DURATIONS, user: Pz.DURATIONS.map((d, i) => (a.env[i] > 0 ? a.env[i] : null)), curve: curve.fn,
        cp: fit ? fit.cp : curve.fn(1200), pmax: fit ? fit.pmax : 0, w0: fit ? fit.wPrime : 0, ftp: fit ? fit.cp : curve.fn(3600), weight: w,
        labels: { dot: 'Meilleure sortie', line: 'Enveloppe', model: 'Morton (CP2, W′, Pmax)', rec: 'meilleure sortie', est: 'interpolé', modelTip: 'modèle de Morton' },
      });
    }
  }

  function apply() {
    if (!agg) return;
    const r = store.state.rider, done = [];
    let n = 0;
    Pz.DURATIONS.forEach((d, i) => { if (checked.get('rec:' + d) && agg.env[i] > 0) { r.records[d] = Math.round(agg.env[i]); n++; } });
    if (n) done.push(`${n} record${n > 1 ? 's' : ''}`);
    // Pmax saisie dans les seuils : elle prime sur le record 1 s, on la remplace aussi
    if (checked.get('rec:1') && agg.env[0] > 0 && Number(r.pmax) > 0) r.pmax = Math.round(agg.env[0]);
    if (checked.get('cp') && agg.fit) {
      r.cp = Math.round(agg.fit.cp);
      r.wPrime = +(agg.fit.wPrime / 1000).toFixed(1);
      done.push(`CP2 ${r.cp} W et W′ ${U.fmt(r.wPrime, 1)} kJ`);
    }
    if (!r.physio || typeof r.physio !== 'object') r.physio = {};
    const F = PYR.metabo.FIELD;
    if (checked.get('hrMax') && agg.hr) { r.physio.hrMax = U.clamp(agg.hr.value, F.hrMax.min, F.hrMax.max); done.push(`FC max ${r.physio.hrMax} bpm`); }
    if (checked.get('vo2max') && agg.vo2max > 0) {
      r.physio.vo2max = U.clamp(Math.round(agg.vo2max * 2) / 2, F.vo2max.min, F.vo2max.max);
      done.push(`VO₂max ${U.fmt(r.physio.vo2max, 1)} mL/min/kg`);
    }
    if (!done.length) { D.toast('Rien n\'est coché.', 'error'); return; }
    store.emit('rider', { path: 'rider.records' });
    store.save();
    PYR.app.refreshBindings();
    D.toast(`Appliqué au profil : ${done.join(', ')}.`);
  }

  PYR.riderImport = {
    init() {
      if (!$('#imp-box')) return;
      chart = new PYR.charts.CurveChart($('#imp-chart'), { scale: 'log', yscale: 'log' });
      const pick = (e) => { const files = Array.from(e.target.files || []); e.target.value = ''; run(files); };
      $('#imp-files').addEventListener('change', pick);
      $('#imp-dir').addEventListener('change', pick);
      $('#imp-cancel').addEventListener('click', () => { stop = true; });
      $('#imp-window').addEventListener('change', () => show(true));
      $('#imp-apply').addEventListener('click', apply);
      $('#imp-rec-all').addEventListener('change', (e) => {
        Pz.DURATIONS.forEach((d, i) => { if (agg && agg.env[i] > 0) checked.set('rec:' + d, e.target.checked); });
        syncChecks();
      });
      // le poids (VO₂max) et les valeurs actuelles changent avec le profil : on recalcule sans toucher aux coches
      store.on('rider', () => { if (data && !busy && !$('#imp-result').hidden) show(false); });
    },
    onShow() { if (chart) chart.surface.request(); },
  };
})(globalThis.PYR = globalThis.PYR || {});
