/* author : Hugo Joudrier-Faure */
/* PaceYourRide — météo du parcours. Deux sources, qui fournissent le même instantané aux simulations (state.weather.snapshot) :
 *  - les prévisions Open-Meteo : heure de départ et récupération, sur les pages Pacing optimal (stratégie) et Jeu (solo et multi) ;
 *  - une météo personnalisée : portions de température et de pluie (et de vent, page Parcours) saisies sur le tracé, sur la page Parcours.
 *    Son instantané est reconstruit à chaque changement de portion, de tracé ou d'heure de départ (weather.js fromCustom).
 * Synthèse, graphique le long du tracé (à l'heure estimée de passage), repères sur la carte, fourniture aux simulations. La météo suit la position ET l'heure. */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store, We = PYR.weather;
  const { h, $ } = D;

  const DEFAULT_SPEED = 30 / 3.6; // m/s : allure supposée pour dater les passages tant qu'il n'y a pas de stratégie calculée
  const SAMPLES = 120;

  let chart = null, chartPerf = null; // graphique de la page Parcours, graphique de la page Pacing optimal
  let busy = false;

  const isCustom = () => store.state.weather.source === 'custom';

  const blocks = [];      // blocs « prévisions Open-Meteo » (pages Pacing optimal et Jeu) : [{start, fetch, enabled, status, stats}]

  /** Bloc des prévisions Open-Meteo : heure de départ, récupération, case « utiliser », état et synthèse. */
  function buildApiBlock(root) {
    const tab = (root.closest('.panel') || { dataset: {} }).dataset.panel || 'x';
    const start = h('input', { type: 'datetime-local', id: 'w-start-' + tab, dataset: { bind: 'weather.startAt' } });
    const fetchBtn = h('button', { class: 'btn primary', type: 'button', id: 'btn-weather-' + tab }, 'Récupérer la météo');
    const enabled = h('input', { type: 'checkbox' });
    const status = h('div', { class: 'status-line', role: 'status', 'aria-live': 'polite' });
    const stats = h('div', { class: 'stats' });
    const b = { start, fetch: fetchBtn, enabled, status, stats };
    start.addEventListener('change', () => {
      store.set('weather.startAt', start.value);
      blocks.forEach((o) => { if (o !== b) o.start.value = start.value; });
    });
    fetchBtn.addEventListener('click', () => T.fetch());
    enabled.addEventListener('change', () => {
      const w = store.state.weather;
      if (isCustom() || !w.snapshot) { enabled.checked = !isCustom() && !!w.enabled; return; }
      w.enabled = enabled.checked;
      store.emit('weather', { path: 'weather' });
      store.save();
    });
    root.append(
      h('p', { class: 'hint' }, "Prévisions Open-Meteo : vent, pluie, température, humidité et pression, récupérées en plusieurs points du parcours pour l'heure de départ, puis lues à l'heure où tu y passes. Elles pèsent sur la stratégie optimale et sur la course, en solo comme en multi (route mouillée : plus de chutes, chaleur, vent de face…)."),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', { for: start.id }, 'Départ (heure locale du lieu)'), start),
        h('div', { class: 'field' }, h('label', null, ' '), fetchBtn)),
      h('label', { class: 'check' }, enabled, ' Utiliser la météo dans la simulation (remplace le vent saisi et la température)'),
      status, stats);
    blocks.push(b);
    return b;
  }

  /** Tracé et heure de départ actuels : si l'un change, les prévisions récupérées ne valent plus. */
  function currentKey() { return We.freshKey(store.profile, store.state.weather.startAt); }

  /** Les prévisions récupérées correspondent-elles au tracé et à l'heure de départ actuels ? */
  function isFresh() {
    const w = store.state.weather;
    return !!(w.snapshot && w.fetchedFor === currentKey());
  }

  /** La météo est-elle utilisée par les simulations ? */
  function active() { return !!(store.state.weather.enabled && isFresh()); }

  /** Instantané à donner à buildCourse (null si la météo n'est pas utilisée). */
  function snapshotForSim() { return active() ? store.state.weather.snapshot : null; }

  /** Heure (s depuis le départ) estimée de passage à la distance s : celle de la stratégie calculée, sinon 30 km/h. */
  function timeAt(s) {
    const plan = store.plan;
    if (plan && !store.planStale && plan.series && plan.series.s) return PYR.raceData.traceTimeAt(plan.series.s, s, plan.tFinish);
    return s / DEFAULT_SPEED;
  }

  /** Cap de la route (°) autour de la distance s. */
  function bearingAt(p, s) {
    const k = Math.max(1, Math.round(300 / p.step));
    const i = U.clamp(Math.round(s / p.step), 0, p.n - 1);
    const a = Math.max(0, i - k), b = Math.min(p.n - 1, i + k);
    return b > a ? U.bearing(p.lat[a], p.lng[a], p.lat[b], p.lng[b]) : 0;
  }

  /** Conditions le long du parcours, lues à l'heure estimée de passage (cf. weather.js alongRoute). */
  function samples() {
    const w = store.state.weather, p = store.profile;
    if (!p || !w.snapshot) return [];
    return We.alongRoute(w.snapshot, p.length, { n: SAMPLES, timeAt, bearing: (s) => bearingAt(p, s) });
  }

  /** Ce que le cycliste va vivre : températures, vent de face moyen, pluie reçue (cumul et durée), pression. */
  function ride(S) {
    if (S.length < 2) return null;
    let Tmin = Infinity, Tmax = -Infinity, gust = 0, pMin = Infinity, pMax = -Infinity, head = 0, rainMm = 0, rainS = 0, rhMax = 0;
    for (let i = 0; i < S.length; i++) {
      const q = S[i];
      Tmin = Math.min(Tmin, q.T); Tmax = Math.max(Tmax, q.T); gust = Math.max(gust, q.gust);
      pMin = Math.min(pMin, q.p); pMax = Math.max(pMax, q.p); rhMax = Math.max(rhMax, q.rh);
      head += q.head / S.length;
      if (i > 0) {
        const dt = Math.max(0, q.clock - S[i - 1].clock);
        rainMm += (q.rain * dt) / 3600;
        if (q.rain >= 0.2) rainS += dt;
      }
    }
    return { Tmin, Tmax, gust, pMin, pMax, rhMax, head, rainMm, rainMin: rainS / 60, duration: S[S.length - 1].clock - S[0].clock };
  }

  const clockText = (epoch, offset) => new Date((epoch + (offset || 0)) * 1000).toISOString().slice(11, 16);

  function localInput(d) {
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const T = {
    snapshotForSim, active, isFresh,

    /**
     * Facteur de capacité moyen dû à la chaleur ou au froid sur le parcours, à l'heure estimée de passage (1 sans météo).
     * Le solveur de stratégie travaille avec une PC et un W′ constants : on lui donne la moyenne ; en course, le facteur
     * est appliqué seconde par seconde.
     */
    meanHeatK() {
      const w = store.state.weather, p = store.profile;
      if (!active() || !p) return 1;
      const n = 12;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const s = (p.length * (i + 0.5)) / n;
        const x = We.at(w.snapshot, s, w.snapshot.start + timeAt(s));
        const e = p.ele[U.clamp(Math.round(s / p.step), 0, p.n - 1)];
        sum += We.heatFactor(x.T - 0.0065 * (e - x.ele), x.rh);
      }
      return sum / n;
    },

    /** Vrai une fois initialisé (sur les pages qui ont de la météo : parcours, pacing optimal, jeu). */
    ready: false,

    init() {
      // chaque page n'a qu'une partie de la météo : graphique du parcours, graphique du pacing, blocs Open-Meteo, météo personnalisée
      const hover = (s) => { if (PYR.map.map) PYR.map.showHover(s); };
      if ($('#weather-chart')) chart = new PYR.charts.WeatherChart($('#weather-chart'), { onHover: hover });
      if ($('#weather-chart-perf')) chartPerf = new PYR.charts.WeatherChart($('#weather-chart-perf'), { onHover: hover });
      // heure de départ proposée : demain à 9 h (heure locale du navigateur)
      const w = store.state.weather;
      if (!w.startAt) { const d = new Date(Date.now() + 86400000); d.setHours(9, 0, 0, 0); w.startAt = localInput(d); }
      D.$$('[data-wx-api]').forEach((el) => buildApiBlock(el));
      D.$$('[data-rbottom]').forEach((b) => b.addEventListener('click', () => T.showBottom(b.dataset.rbottom)));
      if ($('#w-custom-on')) {
        $('#w-custom-on').addEventListener('change', (e) => T.useCustom(e.target.checked));
        const baseT = $('#w-base-t');
        baseT.value = w.custom.baseT;
        baseT.addEventListener('change', () => { w.custom.baseT = U.clamp(Number(baseT.value) || 0, -20, 45); baseT.value = w.custom.baseT; T.customChanged(); });
        $('#btn-add-wtemp').addEventListener('click', () => T.addPortion('temp'));
        $('#btn-add-wrain').addEventListener('click', () => T.addPortion('rain'));
      }
      // météo personnalisée : l'instantané est refait dès que le tracé, le départ ou les portions de vent changent
      store.on('profile', () => { T.syncCustom(); T.renderCustomLists(); });
      store.on('weather', () => T.syncCustom());
      store.on('winds', () => T.customChanged());
      ['weather', 'profile', 'plan'].forEach((e) => store.on(e, () => T.render()));
      T.renderCustomLists();
      T.showBottom(document.body.dataset.rbottom || 'profile');
      T.ready = true;
      T.render();
    },

    /** Graphique du bas de la page Parcours : altitude ou météo. */
    showBottom(which) {
      document.body.dataset.rbottom = which;
      D.$$('[data-rbottom]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.rbottom === which)));
      if (which === 'weather' && chart) chart.surface.request();
    },

    onTab(tab) {
      T.drawMap(tab === 'route' || tab === 'perf');
      if (tab === 'route' && chart) chart.surface.request();
      if (tab === 'perf' && chartPerf) chartPerf.surface.request();
    },

    async fetch() {
      if (busy) return;
      const p = store.profile, w = store.state.weather;
      if (!p) { D.toast('Trace d\'abord un parcours.', 'error'); return; }
      if (!w.startAt) { D.toast('Indique la date et l\'heure de départ.', 'error'); return; }
      busy = true;
      blocks.forEach((b) => { b.fetch.disabled = true; });
      T.setStatus('Récupération des prévisions…');
      try {
        const res = await PYR.services.fetchWeather(We.stationsFor(p), w.startAt);
        w.source = 'api';
        w.snapshot = res.snapshot;
        w.utcOffset = res.utcOffset;
        w.fetchedAt = Date.now();
        w.fetchedFor = currentKey();
        w.enabled = true;
        store.emit('weather', { path: 'weather' });
        store.save();
        D.toast('Météo récupérée : elle est maintenant prise en compte dans les simulations.');
      } catch (e) {
        T.setStatus('Météo indisponible : ' + (e.message || e), true);
      } finally {
        busy = false;
        blocks.forEach((b) => { b.fetch.disabled = !store.profile; });
      }
    },

    /** Choix de la source : les prévisions Open-Meteo ou la météo personnalisée. Changer de source abandonne l'instantané de l'autre. */
    setSource(src) {
      const w = store.state.weather;
      src = src === 'custom' ? 'custom' : 'api';
      if (w.source === src) return;
      w.source = src;
      w.snapshot = null; w.fetchedAt = 0; w.fetchedFor = '';
      w.enabled = false;
      if (src === 'custom') { T.buildCustom(); w.enabled = !!w.snapshot; }
      store.emit('weather', { path: 'weather' });
      store.save();
      T.renderCustomLists();
    },

    /** Case « Utiliser la météo personnalisée » : elle remplace les prévisions Open-Meteo (et réciproquement quand on les récupère). */
    useCustom(on) {
      const w = store.state.weather;
      if (on && !store.profile) { D.toast("Trace d'abord un parcours.", 'error'); $('#w-custom-on').checked = false; return; }
      if (on && !isCustom()) { T.setSource('custom'); return; }
      w.enabled = on && !!w.snapshot;
      store.emit('weather', { path: 'weather' });
      store.save();
    },

    /** Reconstruit l'instantané de la météo personnalisée (sans événement). Renvoie vrai s'il a été refait. */
    buildCustom() {
      const w = store.state.weather, p = store.profile;
      if (!p || !isCustom()) return false;
      const start = We.localToEpoch(w.startAt, 0);
      const snap = We.fromCustom(p, w.custom, store.state.winds, { start: Number.isFinite(start) ? start : undefined, off: 0 });
      if (!snap) return false;
      w.snapshot = snap; w.utcOffset = 0; w.fetchedAt = Date.now(); w.fetchedFor = currentKey();
      return true;
    },

    /** Une portion (température, pluie ou vent) a changé : on refait l'instantané et on prévient les simulations. */
    customChanged() {
      if (isCustom() && T.buildCustom()) store.emit('weather', { path: 'weather' });
      store.save();
    },

    /** Tracé ou heure de départ différents depuis la dernière construction : on refait l'instantané (sinon il serait déclaré périmé). */
    syncCustom() {
      if (isCustom() && store.profile && !isFresh() && T.buildCustom()) { store.emit('weather', { path: 'weather' }); store.save(); }
    },

    /** Ajoute une portion de température ou de pluie : à la suite de la dernière, sur un quart du parcours. */
    addPortion(kind) {
      const p = store.profile, w = store.state.weather;
      if (!p) { D.toast("Trace d'abord un parcours.", 'error'); return; }
      const L = p.length / 1000, list = w.custom[kind];
      let a = list.length ? list[list.length - 1].endKm : 0;
      if (a >= L - 0.1) a = 0;
      const b = Math.min(L, a + Math.max(0.5, L / 4));
      list.push(Object.assign({ id: U.uid(), startKm: +a.toFixed(2), endKm: +b.toFixed(2) }, kind === 'temp' ? { T: 25 } : { rain: 2 }));
      T.renderCustomLists();
      T.customChanged();
    },

    /** Cartes des portions de température et de pluie. */
    renderCustomLists() {
      const w = store.state.weather, L = store.profile ? store.profile.length / 1000 : 9999;
      const level = (mm) => (mm <= 0 ? 'sec' : mm < 1 ? 'bruine' : mm < 3 ? 'pluie faible' : mm < 7 ? 'pluie modérée' : 'pluie forte');
      const card = (item, list, color, field) => {
        const a = h('input', { type: 'number', step: '0.1', min: '0', max: L.toFixed(2), value: item.startKm, 'aria-label': 'Début (km)' });
        const b = h('input', { type: 'number', step: '0.1', min: '0', max: L.toFixed(2), value: item.endKm, 'aria-label': 'Fin (km)' });
        const commitKm = () => {
          let x = Number(a.value), y = Number(b.value);
          if (!isFinite(x) || !isFinite(y)) return;
          if (y < x) [x, y] = [y, x];
          item.startKm = U.clamp(x, 0, L); item.endKm = U.clamp(y, 0, L);
          a.value = item.startKm; b.value = item.endKm;
          T.customChanged();
        };
        a.addEventListener('change', commitKm);
        b.addEventListener('change', commitKm);
        const temp = field === 'T';
        const note = h('span', { class: 'hint' });
        const showNote = () => { note.textContent = temp ? '' : level(item.rain); };
        const val = h('input', Object.assign({ type: 'number', value: item[field], 'aria-label': temp ? 'Température (°C)' : 'Intensité (mm/h)' },
          temp ? { min: '-30', max: '55', step: '1' } : { min: '0', max: '100', step: '0.1' }));
        val.addEventListener('change', () => {
          const lim = temp ? [-30, 55] : [0, 100];
          item[field] = U.clamp(Number(val.value) || 0, lim[0], lim[1]);
          val.value = item[field];
          showNote();
          T.customChanged();
        });
        showNote();
        const del = h('button', {
          class: 'btn icon ghost danger', title: 'Supprimer la portion', 'aria-label': 'Supprimer', type: 'button',
          onclick: () => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1); T.renderCustomLists(); T.customChanged(); },
        }, '✕');
        return h('div', { class: 'portion', style: { '--swatch': color } },
          h('div', { class: 'portion-head' }, h('div', { class: 'km' }, a, h('span', null, '→'), b, h('span', null, 'km')), del),
          h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', null, temp ? 'Température (°C)' : 'Intensité (mm/h)'), val), note));
      };
      const fill = (box, list, color, field, empty) => {
        D.clear(box);
        if (!list.length) { box.appendChild(h('div', { class: 'empty-list' }, empty)); return; }
        for (const it of list) box.appendChild(card(it, list, color, field));
      };
      if (!$('#wtemp-list')) return;   // pas sur cette page (météo personnalisée : page Parcours)
      fill($('#wtemp-list'), w.custom.temp, '#d9822b', 'T', 'Aucune portion : la température de base partout.');
      fill($('#wrain-list'), w.custom.rain, '#2a78d6', 'rain', 'Aucune portion : pas de pluie.');
    },

    /** État affiché dans les blocs Open-Meteo (pages Pacing optimal et Jeu). */
    setStatus(text, error) {
      for (const b of blocks) { b.status.textContent = text; b.status.classList.toggle('error', !!error); }
    },

    /** État affiché sous la case de la météo personnalisée (page Parcours). */
    setCustomStatus(text, error) {
      const el = $('#wcustom-status');
      if (!el) return;
      el.textContent = text;
      el.classList.toggle('error', !!error);
    },

    render() {
      const w = store.state.weather, p = store.profile;
      const custom = isCustom();
      const cstats = $('#wcustom-stats');
      if (cstats) D.clear(cstats);
      for (const b of blocks) {
        D.clear(b.stats);
        b.fetch.disabled = busy || !p;
        b.enabled.disabled = custom || !w.snapshot;
        b.enabled.checked = !custom && !!w.enabled;
        if (document.activeElement !== b.start) b.start.value = w.startAt;
      }
      if ($('#w-custom-on')) {
        $('#w-custom-on').checked = custom && !!w.enabled;
        if (document.activeElement !== $('#w-base-t')) $('#w-base-t').value = w.custom.baseT;
      }
      // la saisie manuelle est mise de côté tant que la météo est utilisée
      const act = active();
      const temp = $('#p-temp');
      if (temp) { temp.disabled = act; temp.title = act ? 'La température vient de la météo' : ''; }
      const note = $('#p-temp-note');
      if (note) note.hidden = !act;
      const fresh = !!w.snapshot && isFresh();
      const used = w.enabled ? ' Vent saisi à la main et température sont remplacés par la météo.' : ' Non utilisée par les simulations.';
      const when = w.fetchedAt ? new Date(w.fetchedAt).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      const noApi = "Aucune prévision : indique l'heure de départ puis récupère la météo.";
      if (!p) { T.setStatus("Trace d'abord un parcours."); T.setCustomStatus("Trace d'abord un parcours."); }
      else if (custom) {
        T.setStatus(w.enabled ? "La météo personnalisée de la page Parcours est utilisée ; récupérer les prévisions la remplace." : noApi);
        T.setCustomStatus(`${w.custom.temp.length} portion${w.custom.temp.length > 1 ? 's' : ''} de température, ${w.custom.rain.length} de pluie, ${store.state.winds.length} de vent ; ${U.fmt(w.custom.baseT, 0)} °C ailleurs.${used}`);
      } else {
        T.setCustomStatus(w.snapshot && w.enabled ? "Les prévisions Open-Meteo sont utilisées ; cocher cette case les remplace." : "Non utilisée : coche la case pour l'utiliser.");
        if (!w.snapshot) T.setStatus(noApi);
        else if (!fresh) T.setStatus("Le tracé ou l'heure de départ a changé depuis la récupération : recharge la météo (elle n'est plus utilisée).", true);
        else T.setStatus(`Prévisions Open-Meteo récupérées le ${when} sur ${w.snapshot.stations.length} points ; départ à ${clockText(w.snapshot.start, w.snapshot.off)} (heure locale).${used}`);
      }
      if (!w.snapshot) {
        if (chart) chart.setData(null);
        if (chartPerf) chartPerf.setData(null);
        T.drawMap(false);
        T.renderRideNote(null);
        return;
      }
      const S = fresh ? samples() : [];
      const data = S.length ? { L: p.length, samples: S, offset: w.snapshot.off } : null;
      if (chart) chart.setData(data);
      if (chartPerf) chartPerf.setData(data);
      const r = fresh ? ride(S) : null;
      if (r) {
        const targets = (custom ? [cstats] : blocks.map((b) => b.stats)).filter(Boolean);
        targets.forEach((box) => {
          box.appendChild(D.stat('Température', `${U.fmt(r.Tmin, 0)}–${U.fmt(r.Tmax, 0)}`, '°C'));
          box.appendChild(D.stat('Humidité max', U.fmt(r.rhMax, 0), '%'));
          box.appendChild(D.stat('Rafales max', U.fmt(r.gust * 3.6, 0), 'km/h'));
          box.appendChild(D.stat(r.head >= 0 ? 'Vent de face moy.' : 'Vent de dos moy.', U.fmt(Math.abs(r.head) * 3.6, 0), 'km/h'));
          box.appendChild(D.stat('Pluie reçue', `${U.fmt(r.rainMm, 1)}`, `mm · ${U.fmt(r.rainMin, 0)} min`));
          box.appendChild(D.stat('Pression', `${U.fmt(r.pMin, 0)}–${U.fmt(r.pMax, 0)}`, 'hPa'));
        });
      }
      T.drawMap(['route', 'perf'].includes(store.state.ui.tab));
      T.renderRideNote(r);
    },

    /** Mention sur la page Pacing optimal : conditions rencontrées avec la stratégie ou l'allure supposée. */
    renderRideNote(r) {
      const el = $('#p-weather-note');
      if (!el) return;
      el.hidden = !(active() && r);
      if (el.hidden) return;
      el.textContent = `Météo prise en compte : ${U.fmt(r.Tmin, 0)}–${U.fmt(r.Tmax, 0)} °C, vent ${r.head >= 0 ? 'de face' : 'de dos'} moyen ${U.fmt(Math.abs(r.head) * 3.6, 0)} km/h, ${r.rainMm >= 0.1 ? `pluie ${U.fmt(r.rainMin, 0)} min (${U.fmt(r.rainMm, 1)} mm)` : 'pas de pluie'}.`;
    },

    /** Repères sur la carte : vent (flèche), température et pluie à chaque station, à l'heure estimée de passage. */
    drawMap(show) {
      if (!PYR.map || !PYR.map.setWeather || !PYR.map.map) return;   // page sans carte
      const w = store.state.weather;
      if (!show || !isFresh() || !store.profile) { PYR.map.setWeather(null); return; }
      let marks = w.snapshot.stations;
      if (isCustom()) {      // deux stations par portion (une de chaque côté de ses limites) : un seul repère, au milieu
        const st = w.snapshot.stations;
        marks = [];
        for (let i = 0; i + 1 < st.length; i += 2) marks.push({ s: Math.round((st[i].s + st[i + 1].s) / 2) });
        if (st.length % 2) marks.push(st[st.length - 1]);
      }
      const items = marks.map((st) => {
        const clock = w.snapshot.start + timeAt(st.s);
        const x = We.at(w.snapshot, st.s, clock);
        return { s: st.s, T: x.T, ws: x.ws, wd: x.wd, rain: x.rain, clock: clockText(clock, w.snapshot.off) };
      });
      PYR.map.setWeather(items);
    },
  };

  PYR.tabWeather = T;
})(globalThis.PYR = globalThis.PYR || {});
