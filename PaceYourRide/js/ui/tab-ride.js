/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page « Sortie » (téléphone) : suivre le plan de puissance optimal pendant une vraie sortie, avec un capteur de
 * puissance Bluetooth et le GPS du téléphone.
 *
 * La page affiche l'avance ou le retard sur le plan (position lissée sur quelques secondes), la puissance à tenir sur le tronçon en
 * cours, les réserves (W′, glycogène, hydratation) et les rappels d'alimentation. Quand on s'écarte du plan (écart de temps, consigne non
 * respectée, W′ qui s'éloigne de celui du plan), le plan du reste du parcours est recalculé depuis l'état réel : le passé est figé
 * (js/engine/ride.js, optimizer.js avec `start`).
 * La logique est dans js/engine/ride.js et nutrition.js ; ce module ne fait que relier les capteurs, l'état et l'affichage. */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store, R = PYR.ride, Fu = PYR.fuel, Nu = PYR.nutrition, Sx = PYR.sensors;
  const { h, $ } = D;

  const SESSION_KEY = 'paceyourride.ride.session.v1';
  const SAVE_EVERY = 15;                    // s : sauvegarde de la sortie en cours
  const SPEEDS = [1, 5, 10, 20, 50];        // vitesses du mode démo
  const KEEP_MS = 90000;                    // ms : mesures des capteurs gardées en attendant leur seconde
  const MIXES = [['', 'Aucun'], ['water', 'Eau'], ['hypo', 'Hypotonique'], ['iso', 'Énergétique'], ['hyper', 'Hypertonique']];
  const SLOT_LABEL = ['Bidon 1', 'Bidon 2', 'Bidon 3', 'Camelback'];
  const FOOD_LABEL = { gel: 'Gel double source', gelglu: 'Gel glucose', gelplus: 'Gel haute dose', gelcaf: 'Gel caféiné', bar: 'Barre', barmini: 'Mini-barre' };
  const SENS_LABEL = { low: 'Faible', normal: 'Normale', high: 'Forte' };

  const V = {};                             // éléments du DOM
  const run = {
    mode: 'prep',                           // 'prep' | 'live' | 'done'
    plan: null, planRes: null, adopted: null, base: null, baseFp: '',
    sess: null, coach: null, nut: null, timer: null,
    demo: null, demoWall: 0, demoSpeed: 5,
    replayAct: null, replayName: '', replayInfo: null,   // sortie enregistrée à rejouer dans le mode démo (GPX, TCX, FIT)
    power: [], fix: [], hrs: [], cads: [],  // mesures des capteurs, datées
    panels: new Set(),                      // panneaux de capteurs affichés (page de démarrage, menu de la sortie)
    mapOn: false, mapHome: null, turns: [], mapRaf: 0,   // carte de la sortie (attachMap)
    mix: null, mixTab: 'course', mixSig: '',                                           // défi contre des coureurs virtuels (ride-mixed.js)
    lastFix: null, powerOn: false, hrOn: false, gpsOn: false, gpsErr: '',
    paused: false, replanning: false, lastSave: 0, lastRender: 0,
    profNear: true, profPts: null,
    al: { seg: -1, over: null, under: null, last: 0, eat: null, drink: null, wbal: false, gps: false, pwr: false },
    busy: false, segPlan: null, nutKey: '',
  };

  const setTxt = (el, s) => { if (el && el._t !== s) { el.textContent = s; el._t = s; } };
  const setAttr = (el, k, v) => { if (el && el.getAttribute(k) !== String(v)) el.setAttribute(k, v); };
  const cfg = () => store.state.ride.cfg;
  const hmm = (sec) => U.fmtClock(sec);
  const mmss = (sec) => { const t = Math.max(0, Math.round(sec)); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
  const km = (m, d = 1) => U.fmt(m / 1000, d);
  const gapText = (sec) => (Math.abs(sec) < 1 ? '0:00' : hmm(Math.abs(sec)));

  /* ---------- empreinte des réglages d'un plan ---------- */
  function fingerprint() {
    const st = store.state, p = store.profile;
    const parts = [p ? Math.round(p.length) : 0, p ? p.n : 0, st.rider.ftp, st.rider.cp, st.rider.wPrime, st.rider.pmax, st.rider.weight, st.rider.age, JSON.stringify(st.rider.records),
      st.bike.weight, st.bike.load, st.bike.frame, st.bike.wheels, st.bike.tire, st.bike.cdaOverride, st.bike.cdaAdjust, st.perf.formPct, st.perf.formPct !== 100 ? st.perf.formRef : '', st.perf.cornering, st.perf.vmaxKmh,
      st.env.temperature, JSON.stringify(st.winds), JSON.stringify(st.surfaces), st.weather.enabled ? st.weather.fetchedFor : 0];
    // plan vérifié sur le modèle physiologique : la carte athlète, l'intestin et le matériel emporté comptent aussi
    if (st.perf.physio) parts.push('physio', JSON.stringify(st.rider.physio), st.rider.gut, st.rider.sex, st.rider.height, JSON.stringify(st.ride.kit));
    const s = parts.join('|');
    let hsh = 5381;
    for (let i = 0; i < s.length; i++) hsh = ((hsh << 5) + hsh + s.charCodeAt(i)) | 0;
    return String(hsh);
  }

  /* ---------- entrées de l'optimiseur ---------- */
  function buildBase() {
    const base = PYR.tabPerf.buildInputs(undefined, { plan: true });
    return base;
  }

  /**
   * Forme ≠ 100 % : le plan est calculé avec les capacités ajustées à la forme, mais W′bal et le temps avant épuisement se lisent par
   * défaut sur le profil de l'athlète à 100 % (réglage `perf.formRef`). « form » : tout reste sur le profil ajusté.
   */
  const refIsForm = (margin) => margin !== 0 && store.state.perf.formRef === 'form';
  /** Référence pour R.planFromResult : null quand W′bal de l'optimiseur est déjà la bonne référence. */
  function planRef(athlete, margin, w) { return margin === 0 || refIsForm(margin) ? null : { athlete, w }; }
  /** Athlète suivi pendant la sortie (W′bal de la jauge, temps tenable). */
  function sessionAthlete(base) {
    if (!refIsForm(base.margin)) return base.athlete;
    const k = 1 - base.margin;
    return PYR.physio.scaleAthlete(base.athlete, k, k);
  }

  /** Entrées de la sortie : la météo est lue à l'heure réelle (départ + temps écoulé), pas à l'heure prévue au départ. */
  function sessionBase(startMs) {
    const base = buildBase();
    const w = base.course.weather;
    if (w) base.course = Object.assign({}, base.course, { weather: Object.assign({}, w, { start: Math.floor(startMs / 1000) }) });
    base.athleteFresh = PYR.physio.buildAthlete(store.state.rider);   // sans la chaleur moyenne du plan (modèle physiologique)
    return base;
  }

  /**
   * Carte athlète du modèle physiologique pour la sortie (réglage « Modèle physiologique », activé par défaut) : celle du profil, à
   * l'échelle de la forme quand la sortie se lit sur le profil ajusté. null sans le modèle.
   */
  function physioCard(base) {
    if (!PYR.metabo || cfg().physio === false) return null;
    const c = PYR.metabo.card(store.state.rider, base.athleteFresh || PYR.physio.buildAthlete(store.state.rider));
    const k = refIsForm(base.margin) ? 1 - base.margin : 1;
    return k === 1 ? c : PYR.metabo.scaleCard(c, k, k);
  }

  /* ======================================================================
   * Plan
   * ====================================================================== */
  function loadStoredPlan() {
    const r = store.state.ride;
    run.plan = r.plan ? R.unpackPlan(r.plan) : null;
    if (!run.plan) run.planRes = null;
  }

  function savePlan(plan, source) {
    const r = store.state.ride;
    run.plan = plan;
    r.plan = R.packPlan(plan);
    r.planInfo = { fp: fingerprint(), at: Date.now(), source, length: plan.length };
    store.save();
  }

  /** Le plan calculé dans l'onglet Performance, s'il est à jour, devient celui de la sortie. */
  function adoptPerfPlan(force) {
    const res = store.plan;
    if (!res || store.planStale || !store.profile || (!force && run.adopted === res)) return false;
    run.adopted = res;
    savePlan(R.planFromResult(res, res.inputs ? res.inputs.length : store.profile.length, planRef(res.athlete, res.margin)), 'perf');
    return true;
  }

  async function computePlan() {
    if (run.busy) return;
    let inputs;
    try { inputs = buildBase(); } catch (e) { D.toast(e.message, 'error'); return; }
    const algo = store.state.perf.algo;
    inputs.algo = algo === 'analytic' || algo === 'gradient' || algo === 'hybrid' ? algo : 'analytic';
    run.busy = true;
    V.planBtn.disabled = true; V.planProg.hidden = false; V.planFill.style.width = '2%';
    setTxt(V.planBtn, 'Calcul en cours…');
    await U.sleep(20);
    try {
      const res = await PYR.optimizer.optimize(inputs, (f) => { V.planFill.style.width = Math.round(Math.max(2, f * 100)) + '%'; });
      if (!res.ok) { D.toast(res.error, 'error'); return; }
      savePlan(R.planFromResult(res, inputs.course.length, planRef(inputs.athlete, inputs.margin)), 'ride');
      D.toast(`Plan calculé en ${U.fmt(res.elapsedMs / 1000, 1)} s : ${U.fmtDuration(res.tFinish)}.`);
    } catch (e) {
      console.error(e);
      D.toast('Erreur pendant le calcul : ' + e.message, 'error');
    } finally {
      run.busy = false; V.planBtn.disabled = false; setTxt(V.planBtn, 'Calculer le plan');
      setTimeout(() => { V.planProg.hidden = true; }, 400);
      renderPrep();
    }
  }

  /* ======================================================================
   * Préparation
   * ====================================================================== */
  const card = (title, ...kids) => h('div', { class: 'rd-card' }, title ? h('h3', null, title) : null, ...kids);
  const rowEl = (label, ...kids) => h('div', { class: 'rd-row' }, h('span', { class: 'rd-lbl' }, label), h('span', { class: 'rd-ctl' }, ...kids));

  function selectEl(options, value, onChange) {
    const s = h('select', null, ...options.map(([v, l]) => h('option', { value: v }, l)));
    s.value = String(value);
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function checkEl(label, value, onChange) {
    const c = h('input', { type: 'checkbox' });
    c.checked = !!value;
    c.addEventListener('change', () => onChange(c.checked));
    return h('label', { class: 'rd-check' }, c, label);
  }
  /**
   * Curseur avec sa valeur affichée à côté. L'étiquette suit le doigt (« input ») ; on.input(v) est appelée pendant le glissement,
   * on.change(v) quand on relâche (ou après une touche du clavier).
   */
  function sliderEl(value, min, max, step, fmt, on) {
    const r = h('input', { type: 'range', min, max, step, 'aria-label': 'Durée de la moyenne (s)' });
    r.value = value;
    const lbl = h('span', { class: 'val' }, fmt(Number(value)));
    r.addEventListener('input', () => { lbl.textContent = fmt(Number(r.value)); if (on.input) on.input(Number(r.value)); });
    r.addEventListener('change', () => on.change(Number(r.value)));
    return h('span', { class: 'rd-slider' }, r, lbl);
  }
  function numEl(value, min, max, step, onChange) {
    const n = h('input', { type: 'number', min, max, step, inputmode: 'numeric' });
    n.value = value;
    n.addEventListener('change', () => { const v = Math.min(max, Math.max(min, Number(n.value) || 0)); n.value = v; onChange(v); });
    return n;
  }

  /**
   * Champ de la forme du plan (% de capacités) : même réglage que « Forme » de l'onglet Performance, changer
   * l'un change l'autre. after(v) est appelée avec la nouvelle valeur.
   */
  function marginEl(after) {
    const n = h('input', { type: 'number', min: 10, max: 300, step: 1, inputmode: 'decimal', 'aria-label': 'Forme du plan (% de mes capacités)' });
    n.value = store.state.perf.formPct;
    n.addEventListener('change', () => {
      const v = Math.min(300, Math.max(10, Number(n.value) || 100));
      n.value = v;
      store.set('perf.formPct', v);
      document.querySelectorAll('[data-bind="perf.formPct"]').forEach((o) => { o.value = v; });
      if (after) after(v);
    });
    return n;
  }

  function buildPrep() {
    const rs = store.state.ride;
    V.prep = h('section', { class: 'rd-prep' });

    // reprise d'une sortie interrompue
    V.resume = h('div', { class: 'rd-card rd-resume', hidden: true },
      h('h3', null, 'Une sortie est en cours'), V.resumeTxt = h('p', null),
      h('div', { class: 'rd-btns' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => resumeSession() }, 'Reprendre'),
        h('button', { class: 'btn', type: 'button', onclick: () => { clearSaved(); renderPrep(); } }, 'Abandonner')));

    V.pmapBox = h('div', { class: 'rd-pmap' });
    V.distLine = h('p', { class: 'rd-line' });
    V.mapCard = h('div', { class: 'rd-pblock' }, V.distLine, V.pmapBox);
    V.pprof = h('canvas', { class: 'rd-pprof' });
    V.pprofAuto = h('button', { class: 'btn', type: 'button', onclick: () => autoCheckpoints() }, 'Placer sprints et côtes automatiquement');
    V.upLine = h('p', { class: 'rd-line' });
    V.pprofCard = h('div', { class: 'rd-pblock' }, V.upLine, V.pprof, h('div', { class: 'rd-btns' }, V.pprofAuto));
    // parcours et plan
    V.routeLine = h('p', { class: 'rd-line' });
    V.planLine = h('p', { class: 'rd-line' });
    V.planWarn = h('p', { class: 'rd-warn', hidden: true });
    V.planBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => computePlan() }, 'Calculer le plan');
    V.perfBtn = h('button', { class: 'btn', type: 'button', onclick: () => { adoptPerfPlan(true); renderPrep(); D.toast('Plan de l\'onglet Performance repris.'); } }, 'Reprendre celui de l\'onglet Performance');
    V.planFill = h('div', { class: 'progress-fill' });
    V.planProg = h('div', { class: 'progress', hidden: true }, V.planFill);
    V.segTable = h('table', { class: 'rd-table' });
    V.margin = marginEl();
    V.routeCard = card('Parcours', V.routeLine, V.mapCard, V.pprofCard);
    V.formRef = selectEl([['athlete', 'Profil de l\'athlète à 100 %'], ['form', 'Profil ajusté à la forme']], store.state.perf.formRef, (v) => store.set('perf.formRef', v));
    V.formRefRow = rowEl('W′bal et temps tenable sur', V.formRef);
    V.formRefRow.hidden = true;
    V.planCard = card('Plan', V.planLine, V.planWarn,
      rowEl('Forme du plan (% de mes capacités)', h('span', { class: 'rd-inline' }, V.margin, ' %')), V.formRefRow,
      h('div', { class: 'rd-btns' }, V.planBtn, V.perfBtn), V.planProg,
      h('details', { class: 'rd-details' }, h('summary', null, 'Voir les tronçons du plan'), h('div', { class: 'rd-scroll-x' }, V.segTable)));

    // parcours en intégralité (carte) et profil avec les sprints et les côtes classées

    // défi contre des coureurs virtuels : réglages du mode jeu (nombre, niveau) et points de passage de l'onglet Parcours
    V.mixSum = h('p', { class: 'rd-line' });
    V.mixWarn = h('p', { class: 'rd-warn', hidden: true });
    V.mixAuto = h('button', { class: 'btn', type: 'button', onclick: () => autoCheckpoints() }, 'Placer sprints et côtes automatiquement');
    V.mixCard = card('Défi contre des coureurs virtuels',
      checkEl('Rouler contre des coureurs virtuels', rs.cfg.mixed, (v) => { store.set('ride.cfg.mixed', v); renderPrep(); }),
      h('p', { class: 'rd-note' }, 'Des coureurs de ton niveau parcourent le même tracé, sans aspiration : sprints et côtes classées, classement et position de chacun sur la carte. Ils partent quand tu franchis la ligne.'),
      V.mixSum, V.mixWarn, h('div', { class: 'rd-btns' }, V.mixAuto));

    // capteurs
    V.sens = sensorPanel();
    V.sens.keep = true;
    V.pwrNote = h('p', { class: 'rd-note' }, Sx.power.supported
      ? 'Capteurs de puissance (pédales, manivelle, moyeu) et home-trainers, en Bluetooth basse consommation. Réveille le capteur (quelques tours de pédale) ; il ne se connecte qu\'à un appareil à la fois (coupe-le sur ton compteur). Si ton capteur n\'apparaît pas, « Autre appareil… » liste tout ce qui émet. L\'ANT+ n\'est pas accessible depuis un navigateur : la plupart des capteurs sont aussi en Bluetooth.'
      : 'Ce navigateur n\'a pas de Bluetooth : la puissance sera estimée d\'après la vitesse et la pente (moins précis). Sur iPhone, le navigateur Bluefy permet le Bluetooth ; sur Android, Chrome.');
    const dm = rs.demo;
    V.demoChk = checkEl('Mode démo : un cycliste simulé roule à ta place', false, (v) => { V.demoOpts.hidden = !v; renderPrep(); });
    V.replayFile = h('input', { type: 'file', accept: '.gpx,.tcx,.fit,application/gpx+xml,application/xml,text/xml,application/octet-stream', hidden: true, onchange: onReplayFile });
    V.replayPick = h('button', { class: 'btn', type: 'button', onclick: () => V.replayFile.click() }, 'Choisir une sortie…');
    V.replayClear = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => { run.replayAct = null; run.replayName = ''; run.replayInfo = null; renderReplay(); renderPrep(); } }, 'Retirer');
    V.replaySt = h('p', { class: 'rd-note' });
    V.biasRow = rowEl('Il suit la consigne à', h('span', { class: 'rd-inline' }, numEl(dm.bias, -40, 40, 1, (v) => store.set('ride.demo.bias', v)), ' % près'));
    V.demoOpts = h('div', { class: 'rd-demo-opts', hidden: true },
      rowEl('Rejouer une sortie enregistrée', V.replayPick, V.replayClear, V.replayFile),
      V.replaySt,
      rowEl('Vitesse du temps', selectEl(SPEEDS.map((x) => [x, '×' + x]), dm.speed, (v) => store.set('ride.demo.speed', Number(v)))),
      V.biasRow);
    renderReplay();
    V.sensCard = card('Capteurs',
      V.sens.gps, ...V.sens.pwr, V.pwrNote, V.sens.avg, V.sens.alt, ...V.sens.hr,
      h('div', { class: 'rd-sep' }), V.demoChk, V.demoOpts);

    // alimentation
    V.kitBox = h('div', { class: 'rd-kit' });
    V.nutSum = h('div', { class: 'rd-nutsum' });
    V.nutList = h('ol', { class: 'rd-events' });
    V.nutCard = card('Alimentation et boisson',
      h('p', { class: 'rd-note' }, 'Ce que tu emportes. Le plan d\'alimentation en découle : combien de glucides par heure, quand boire, quand manger.'),
      V.kitBox, V.nutSum, h('details', { class: 'rd-details' }, h('summary', null, 'Voir le calendrier prévu'), V.nutList));

    // réglages
    const c = rs.cfg;
    V.setCard = card('Réglages',
      checkEl('Recalculer le plan automatiquement', c.auto, (v) => store.set('ride.cfg.auto', v)),
      rowEl('Sensibilité du recalcul', selectEl(Object.entries(SENS_LABEL), c.sens, (v) => store.set('ride.cfg.sens', v))),
      rowEl('Lissage de l\'écart', selectEl([[5, '5 s'], [8, '8 s'], [12, '12 s'], [20, '20 s']], c.gapTau, (v) => store.set('ride.cfg.gapTau', Number(v)))),
      rowEl('Annoncer un changement de consigne', selectEl([[0, 'jamais'], [5, '5 s avant'], [10, '10 s avant'], [15, '15 s avant'], [20, '20 s avant']], c.lookahead, (v) => store.set('ride.cfg.lookahead', Number(v)))),
      rowEl('Mises à jour météo', selectEl([[5, 'toutes les 5 min'], [15, 'toutes les 15 min'], [30, 'toutes les 30 min'], [60, 'toutes les 60 min']], c.weatherMin, (v) => { store.set('ride.cfg.weatherMin', Number(v)); }), h('span', { class: 'rd-st' }, 'si la météo est activée')),
      h('div', { class: 'rd-checks' },
        checkEl('Bips', c.sound, (v) => { store.set('ride.cfg.sound', v); if (v) Sx.alerts.unlock(); }),
        checkEl('Vibrations', c.vibrate, (v) => store.set('ride.cfg.vibrate', v)),
        checkEl('Voix', c.voice, (v) => { store.set('ride.cfg.voice', v); if (v) { Sx.alerts.unlock(); Sx.alerts.speak('Voix activée'); } })),
      h('div', { class: 'rd-checks' },
        checkEl('Profil d\'élévation sur la carte', c.mapProfile, (v) => store.set('ride.cfg.mapProfile', v)),
        // réserves du modèle physiologique (carte athlète de l'onglet Cycliste) : glycogène par fibres, glycémie, température, eau, FC prévue
        checkEl('Modèle physiologique (carte athlète)', c.physio !== false, (v) => store.set('ride.cfg.physio', v)),
        ));

    V.startBtn = h('button', { class: 'btn primary big', type: 'button', onclick: () => startLive() }, 'Démarrer la sortie');
    V.startHint = h('p', { class: 'rd-note center' });
    V.prep.append(V.resume, V.routeCard, V.planCard, V.mixCard, V.sensCard, V.nutCard, V.setCard, V.startBtn, V.startHint);
    buildKit();
  }

  function buildKit() {
    const rs = store.state.ride;
    D.clear(V.kitBox);
    // 'kit' : le plan de l'onglet Performance vérifié sur le modèle physiologique dépend du matériel emporté
    const save = () => { store.save(); renderNutrition(); store.emit('kit'); };
    SLOT_LABEL.forEach((lbl, i) => {
      V.kitBox.append(rowEl(lbl, selectEl(MIXES, rs.kit.slots[i] || '', (v) => { rs.kit.slots[i] = v; save(); })));
    });
    const foods = h('div', { class: 'rd-foods' });
    for (const k of Fu.FOOD_IDS) {
      foods.append(h('label', { class: 'rd-food' }, h('span', null, `${FOOD_LABEL[k]} (${Fu.FOODS[k].carbs} g)`), numEl(rs.kit.items[k] || 0, 0, 6, 1, (v) => { rs.kit.items[k] = v; save(); })));
    }
    V.kitBox.append(h('div', { class: 'rd-sep' }), foods);
  }

  function renderPrep() {
    if (run.mode !== 'prep') return;
    const p = store.profile, rs = store.state.ride;
    adoptPerfPlan(false);
    if (!run.plan) loadStoredPlan();
    // parcours
    V.routeLine.hidden = !!p;                                    // sans parcours : seul ce message s'affiche
    setTxt(V.routeLine, 'Aucun parcours : trace-le dans l\'onglet Parcours (ou importe un projet).');
    if (p) {
      const st = p.stats || {};
      setTxt(V.distLine, `Distance : ${km(p.length)} km`);
      setTxt(V.upLine, `Dénivelé positif : ${U.fmt(st.up || 0)} m / Dénivelé négatif : ${U.fmt(st.down || 0)} m`);
    }
    const plan = run.plan;
    if (document.activeElement !== V.margin) V.margin.value = store.state.perf.formPct;   // modifiée dans l'onglet Performance
    V.formRef.value = store.state.perf.formRef;
    V.formRefRow.hidden = Number(store.state.perf.formPct) === 100;                        // sans effet à 100 % de forme
    V.planBtn.disabled = !p || run.busy;
    V.perfBtn.hidden = !(store.plan && !store.planStale);
    if (plan) {
      const avg = plan.P.length ? plan.P.reduce((a, b) => a + b, 0) / plan.P.length : 0;
      const dur = plan.tFinish - plan.t0;
      setTxt(V.planLine, `Plan : ${U.fmtDuration(dur)} · ${U.fmt(plan.length / Math.max(1, dur) * 3.6, 1)} km/h · ${U.fmt(avg)} W en moyenne`);
      const stale = rs.planInfo && rs.planInfo.fp !== fingerprint();
      const diffLen = p && Math.abs(plan.length - p.length) > 50;
      V.planWarn.hidden = !(stale || diffLen);
      setTxt(V.planWarn, diffLen ? 'Ce plan ne correspond plus au parcours : recalcule-le.' : 'Le parcours, le cycliste ou le vélo ont changé depuis le calcul : recalcule le plan.');
      renderSegTable(plan);
    } else {
      setTxt(V.planLine, 'Pas encore de plan. Calcule-le ici ou dans l\'onglet Performance.');
      V.planWarn.hidden = true;
      D.clear(V.segTable);
    }
    renderPrepMap();
    renderPrepProfile();
    // défi contre des coureurs virtuels
    renderMixPrep();
    // capteurs
    renderSensors();
    // départ
    const demo = V.demoChk.querySelector('input').checked;
    const can = !!p && !!plan && (demo || run.gpsOn || run.lastFix);
    V.startBtn.disabled = !can;
    setTxt(V.startHint, !p ? 'Il faut un parcours.' : !plan ? 'Il faut un plan.' : !(demo || run.gpsOn) ? 'Active le GPS (ou le mode démo) pour démarrer.' : demo ? (run.replayAct ? `Mode démo : la sortie « ${run.replayName} » est rejouée, rien n'est mesuré.` : 'Mode démo : rien n\'est mesuré, un cycliste simulé suit la consigne.')
      : Sx.power.state === 'on' ? 'Prêt : GPS et capteur de puissance.' : 'Sans capteur de puissance, elle sera estimée d\'après la vitesse, la météo et la pente.');
    renderNutrition();
    renderResume();
  }

  /* ---------- parcours en intégralité et profil, avant le départ ---------- */
  const CP_TEXT = (c) => (c.type === 'sprint' ? 'S' : c.cat === 'hc' ? 'HC' : String(c.cat));

  /** Sprints et côtes classées du parcours (sans l'arrivée). */
  function prepCps() {
    const cps = mixCps();
    return cps ? cps.filter((c) => c.type === 'sprint' || c.type === 'kom') : [];
  }

  /** Carte annexe (sans lien avec celle de l'onglet Parcours) : tout le tracé, départ, arrivée, sprints et côtes. Aucune interaction, pour ne pas gêner le défilement. */
  function renderPrepMap() {
    const p = store.profile;
    V.mapCard.hidden = !p;
    if (!p) return;
    const spec = PYR.map.baseSpec();
    if (!run.pmap) {
      run.pmap = L.map(V.pmapBox, { zoomControl: false, dragging: false, touchZoom: false, doubleClickZoom: false, scrollWheelZoom: false, boxZoom: false, keyboard: false, tap: false, zoomSnap: 0.25 });
      run.pmapLayers = L.layerGroup().addTo(run.pmap);
      run.pmapSig = '';
    }
    if (run.pmapBase !== spec.id) {
      if (run.pmapTiles) run.pmap.removeLayer(run.pmapTiles);
      run.pmapTiles = L.tileLayer(spec.url, { maxZoom: spec.maxZoom, subdomains: spec.subdomains || 'abc', attribution: spec.attribution, crossOrigin: true }).addTo(run.pmap);
      run.pmapBase = spec.id;
    }
    const cps = prepCps();
    const sig = [Math.round(p.length), p.n, p.lat[0].toFixed(4), p.lng[p.n - 1].toFixed(4), cps.map((c) => c.type + Math.round(c.s)).join(',')].join('|');
    const map = run.pmap;
    map.invalidateSize({ animate: false });
    if (sig === run.pmapSig && run.pmapW === V.pmapBox.clientWidth) return;
    run.pmapSig = sig; run.pmapW = V.pmapBox.clientWidth;
    const g = run.pmapLayers;
    g.clearLayers();
    const pts = [], stride = Math.max(1, Math.floor(p.n / 600));
    for (let i = 0; i < p.n; i += stride) pts.push([p.lat[i], p.lng[i]]);
    pts.push([p.lat[p.n - 1], p.lng[p.n - 1]]);
    g.addLayer(L.polyline(pts, { color: '#fff', weight: 8, opacity: 0.9, interactive: false }));
    g.addLayer(L.polyline(pts, { color: '#2a78d6', weight: 4.5, opacity: 1, interactive: false }));
    const icon = (cls, txt, size) => L.divIcon({ className: '', html: `<div class="${cls}">${txt}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    g.addLayer(L.marker(pts[0], { icon: icon('wp-icon wp-start', 'D', 24), interactive: false, keyboard: false, zIndexOffset: 500 }));
    g.addLayer(L.marker(pts[pts.length - 1], { icon: icon('wp-icon wp-end', 'A', 24), interactive: false, keyboard: false, zIndexOffset: 500 }));
    for (const c of cps) {
      const ll = PYR.map.latLngAt(c.s);
      if (ll) g.addLayer(L.marker(ll, { icon: icon('cp-icon ' + c.type, CP_TEXT(c), 24), interactive: false, keyboard: false, zIndexOffset: 600 }));
    }
    map.fitBounds(L.latLngBounds(pts), { padding: [26, 26], animate: false });
  }

  function renderPrepProfile() {
    const p = store.profile;
    V.pprofCard.hidden = !p;
    if (!p) return;
    const cps = prepCps();
    V.pprofAuto.parentNode.hidden = cps.length > 0;
    drawPrepProfile(cps);
  }

  /** Profil du parcours entier : sommets des côtes classées (zone rouge sous la courbe et pastille de catégorie) et sprints (trait vert et « S »). */
  function drawPrepProfile(cps) {
    const cv = V.pprof, p = store.profile;
    if (!p || !cv.isConnected) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, hgt = cv.clientHeight;
    if (!w || !hgt) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const css = getComputedStyle(document.documentElement), col = (k, d) => css.getPropertyValue(k).trim() || d;
    const ink2 = col('--ink-2', '#555'), border = col('--border', '#ddd'), accent = col('--accent', '#2a78d6');
    const L0 = p.length, left = 40, right = 8, top = 24, bot = hgt - 18, pw = w - left - right;
    const eleAt = (m) => p.ele[U.clamp(Math.round(m / p.step), 0, p.n - 1)];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < p.n; i++) { const e = p.ele[i]; if (e < lo) lo = e; if (e > hi) hi = e; }
    const pad = Math.max(10, (hi - lo) * 0.1);
    lo = Math.floor((lo - pad) / 10) * 10; hi = Math.ceil((hi + pad) / 10) * 10;
    if (hi - lo < 40) hi = lo + 40;
    const X = (m) => left + m / L0 * pw, Y = (e) => bot - (e - lo) / (hi - lo) * (bot - top);
    const cols = Math.max(40, Math.min(p.n - 1, Math.floor(pw)));
    const curve = () => { for (let i = 0; i <= cols; i++) { const m = L0 * i / cols; if (i) ctx.lineTo(X(m), Y(eleAt(m))); else ctx.moveTo(X(m), Y(eleAt(m))); } };
    // repères : altitude (haut, bas) et kilomètres
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = ink2; ctx.strokeStyle = border; ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const e of [hi, lo]) { ctx.beginPath(); ctx.moveTo(left, Y(e) + 0.5); ctx.lineTo(w - right, Y(e) + 0.5); ctx.stroke(); ctx.fillText(Math.round(e) + ' m', left - 4, Math.min(hgt - 20, Math.max(8, Y(e)))); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const km = L0 / 1000, steps = [1, 2, 5, 10, 20, 25, 50, 100], want = Math.max(3, Math.floor(pw / 70));
    const stepKm = steps.find((s) => km / s <= want) || 100;
    for (let k = 0; k * stepKm <= km; k++) ctx.fillText(k * stepKm + (k === 0 ? ' km' : ''), Math.min(w - 12, Math.max(left + 8, X(k * stepKm * 1000))), hgt - 4);
    // surface sous la courbe, puis dénivelé des côtes classées en rouge
    ctx.beginPath(); curve(); ctx.lineTo(X(L0), bot); ctx.lineTo(X(0), bot); ctx.closePath();
    ctx.fillStyle = accent; ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1;
    for (const c of cps) {
      if (c.type !== 'kom') continue;
      const a = Math.max(0, c.start || 0), n = Math.max(8, Math.round((c.s - a) / L0 * cols));
      ctx.beginPath();
      for (let i = 0; i <= n; i++) { const m = a + (c.s - a) * i / n; if (i) ctx.lineTo(X(m), Y(eleAt(m))); else ctx.moveTo(X(m), Y(eleAt(m))); }
      ctx.lineTo(X(c.s), bot); ctx.lineTo(X(a), bot); ctx.closePath();
      ctx.fillStyle = '#d62828'; ctx.globalAlpha = 0.38; ctx.fill(); ctx.globalAlpha = 1;
    }
    ctx.beginPath(); curve(); ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    // sprints et sommets : trait vertical jusqu'à la courbe et pastille au-dessus
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    for (const c of cps) {
      const x = X(c.s), yc = Y(eleAt(c.s)), kom = c.type === 'kom', color = kom ? '#d62828' : '#1d9a4a', by = Math.max(11, yc - 15);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, by); ctx.lineTo(x, yc); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, by, 9, 0, Math.PI * 2); ctx.fillStyle = kom ? '#fff' : color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = kom ? color : '#fff'; ctx.stroke();
      ctx.fillStyle = kom ? color : '#fff'; ctx.font = '700 10px system-ui, sans-serif'; ctx.fillText(CP_TEXT(c), x, by + 0.5);
    }
  }

  /* ---------- défi contre des coureurs virtuels : réglages ---------- */
  const LEVEL_TXT = { weaker: 'plus faible que toi', equal: 'de ton niveau', stronger: 'plus forts que toi', mixed: 'de niveaux variés' };

  /** Points de passage du défi : ceux de l'onglet Parcours (sprints, côtes classées) et l'arrivée. */
  function mixCps() {
    const p = store.profile;
    return p ? PYR.classif.fromList(store.state.checkpoints, p) : null;
  }

  function renderMixPrep() {
    const on = !!cfg().mixed, g = store.state.game;
    V.mixSum.hidden = V.mixWarn.hidden = !on;
    V.mixAuto.parentNode.hidden = !on;
    if (!on) return;
    const n = Math.max(0, Math.min(PYR.race.MAX_BOTS, Math.floor(Number(g.bots) || 0))), cps = mixCps(), txt = cps ? PYR.classifView.cpsText(cps) : '';
    setTxt(V.mixSum, `${n} coureur${n > 1 ? 's' : ''} virtuel${n > 1 ? 's' : ''}, ${LEVEL_TXT[g.botLevel] || LEVEL_TXT.equal} (réglages du mode jeu)${txt ? ' · ' + txt : ''}.`);
    const warn = !n ? 'Aucun coureur virtuel : règle leur nombre dans le mode jeu.' : cps && !PYR.classif.active(cps) ? 'Pas de sprint ni de côte classée sur ce parcours : seule l\'arrivée compte.' : '';
    V.mixWarn.hidden = !warn;
    setTxt(V.mixWarn, warn);
    V.mixAuto.hidden = !(cps && !PYR.classif.active(cps));
  }

  /** Place des sprints et des côtes classées sur le parcours (comme l'onglet Parcours) quand il n'y en a pas. */
  function autoCheckpoints() {
    const p = store.profile;
    if (!p) return;
    const found = PYR.classif.toItems(PYR.classif.build(p, { sprints: 2, kom: true }));
    if (!found.length) { D.toast('Aucun sprint ni côte classée possible sur ce parcours.', 'error'); return; }
    store.state.checkpoints = found;
    PYR.tabRoute.cpChanged(null);                                // trie, enregistre et prévient l'onglet Parcours
    D.toast(`${PYR.classifView.cpsText(PYR.classif.fromList(found, p))} placé(s). Tu peux les modifier dans l'onglet Parcours.`);
    renderPrep();
  }

  const BLE_STATE = { on: 'connecté', connecting: 'connexion…', reconnecting: 'reconnexion…', lost: 'perdu', off: 'non connecté' };

  /**
   * Panneau des capteurs (GPS, puissance, cardio) : lignes à placer dans la page de démarrage et dans le menu de la sortie. Tous les
   * panneaux ouverts sont tenus à jour par renderSensors. on.alpha(α) : appelée quand on change la part de l'altitude mesurée ; on.avg(n) :
   * quand on change la durée de la moyenne de la puissance affichée.
   * Renvoie { gps, pwr: [lignes], avg (puissance affichée), alt (réglage de l'estimation, masqué quand un capteur de puissance est connecté),
   * hr: [lignes], refresh }.
   */
  function sensorPanel(on) {
    on = on || {};
    const avg = rowEl('Puissance affichée', sliderEl(cfg().powerAvg, 1, 60, 1, (v) => (v === 1 ? 'instantanée' : `moy. ${v} s`), {
      input: (v) => { if (on.avg) on.avg(v); },
      change: (v) => { store.set('ride.cfg.powerAvg', v); if (on.avg) on.avg(v); },
    }));
    avg.title = 'Valeur de la vignette Puissance du bandeau : de la puissance instantanée (1 s) à la moyenne sur 60 s.';
    const gpsBtn = h('button', { class: 'btn', type: 'button', onclick: () => toggleGps() }, 'Activer le GPS');
    const gpsSt = h('span', { class: 'rd-st' });
    const pwrBtn = h('button', { class: 'btn', type: 'button', onclick: () => connectPower('service') }, 'Connecter');
    const pwrAny = h('button', { class: 'btn ghost', type: 'button', onclick: () => connectPower('any') }, 'Autre appareil…');
    const pwrRec = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => reconnectKnown('power') }, 'Reconnecter');
    const pwrSt = h('div', { class: 'rd-st rd-live-st' });
    const hrBtn = h('button', { class: 'btn', type: 'button', onclick: () => connectHr('service') }, 'Connecter');
    const hrRec = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => reconnectKnown('hr') }, 'Reconnecter');
    const hrSt = h('div', { class: 'rd-st rd-live-st' });
    const alt = h('div', { class: 'rd-alt' },
      rowEl('Sans capteur : part de l\'altitude mesurée', h('span', { class: 'rd-inline' }, numEl(Math.round(cfg().altAlpha * 100), 0, 100, 10, (v) => {
        store.set('ride.cfg.altAlpha', v / 100);
        if (on.alpha) on.alpha(v / 100);
      }), ' %')),
      h('p', { class: 'rd-note' }, 'Sans capteur, la puissance est estimée d\'après la vitesse, la météo et la pente. Cette part de la dénivelée vient des altitudes mesurées par le GPS (bruitées), le reste de l\'altitude corrigée du parcours. 0 % : le parcours seul.'));
    const P = {
      gps: rowEl('GPS', gpsBtn, gpsSt),
      pwr: [rowEl('Puissance', pwrRec, pwrBtn, pwrAny), pwrSt],
      avg, alt,
      hr: [rowEl('Cardio (facultatif)', hrRec, hrBtn), hrSt],
      refresh() {
        gpsBtn.textContent = run.gpsOn ? 'Couper' : 'Activer le GPS';
        let g = run.gpsErr ? run.gpsErr : run.gpsOn ? 'recherche du signal…' : 'inactif';
        if (run.lastFix && run.gpsOn) {
          g = `±${Math.round(run.lastFix.acc)} m`;
          const near = nearStart(run.lastFix);
          if (run.mode === 'prep' && near !== null) g += near < 200 ? ' · au départ' : ` · à ${km(near)} km du départ`;
        }
        setTxt(gpsSt, g);
        const Pw = Sx.power, H = Sx.hr, now = Date.now();
        alt.hidden = Pw.state === 'on';
        pwrBtn.textContent = Pw.state === 'on' ? 'Déconnecter' : 'Connecter';
        pwrAny.hidden = Pw.state === 'on' || !Pw.supported;
        pwrBtn.hidden = !Pw.supported;
        pwrRec.hidden = !(Pw.canReconnect && Pw.state === 'off');
        if (Pw.known) pwrRec.textContent = 'Reconnecter ' + (Pw.known.name || '');
        let t = Pw.supported ? BLE_STATE[Pw.state] : 'non disponible';
        if (Pw.state === 'on') {
          t = `${Pw.name || 'connecté'} · ${Pw.profile ? Pw.profile.replace(/^un /, '') : ''}`;
          const l = Pw.last;
          if (!l) t += ' · en attente de mesure (pédale quelques tours)';
          else {
            const age = (now - l.ts) / 1000, v = l.v;
            t += Number.isFinite(v.w) ? ` · ${Math.round(v.w)} W` : ' · pas de puissance dans ce profil';
            if (Number.isFinite(v.cad) && v.cad > 0) t += ` · ${Math.round(v.cad)} tr/min`;
            t += age > 4 ? ` · silencieux depuis ${Math.round(age)} s` : '';
          }
        } else if (Pw.error) t += ' · ' + Pw.error;
        setTxt(pwrSt, t);
        hrBtn.textContent = H.state === 'on' ? 'Déconnecter' : 'Connecter';
        hrBtn.hidden = !H.supported;
        hrRec.hidden = !(H.canReconnect && H.state === 'off');
        if (H.known) hrRec.textContent = 'Reconnecter ' + (H.known.name || '');
        let th = H.supported ? BLE_STATE[H.state] : 'non disponible';
        if (H.state === 'on') th = `${H.name || 'connecté'}${H.last && H.last.v && H.last.v.hr ? ' · ' + Math.round(H.last.v.hr) + ' bpm' : ''}`;
        else if (H.error) th += ' · ' + H.error;
        setTxt(hrSt, th);
      },
    };
    run.panels.add(P);
    P.refresh();
    return P;
  }

  /** Remet à jour tous les panneaux de capteurs ouverts (page de démarrage, menu de la sortie). */
  function renderSensors() {
    for (const P of run.panels) {
      if (!P.keep && !P.gps.isConnected) { run.panels.delete(P); continue; }
      P.refresh();
    }
  }
  /** Un capteur a changé : la page de démarrage se redessine, sinon seuls les panneaux de capteurs. */
  const sensorsChanged = () => { if (run.mode === 'prep') renderPrep(); else renderSensors(); };

  function renderSegTable(plan) {
    if (run.segPlan === plan) return;
    run.segPlan = plan;
    let course = null;
    try { course = (run.base || (run.base = buildBase())).course; } catch (e) { /* pas de parcours */ }
    D.clear(V.segTable);
    V.segTable.append(h('thead', null, h('tr', null, ...['N°', 'Km', 'Puissance', 'Pente', 'Durée'].map((x) => h('th', null, x)))));
    const body = h('tbody');
    R.segments(plan, course).forEach((g, i) => body.append(h('tr', null, h('td', null, i + 1), h('td', null, `${km(g.a)} → ${km(g.b)}`),
      h('td', null, `${Math.round(g.P / 5) * 5} W`), h('td', null, `${U.fmt(g.grade * 100, 1)} %`), h('td', null, hmm(g.t1 - g.t0)))));
    V.segTable.append(body);
  }

  /** Distance (m) entre la position et le départ du parcours (null sans parcours). */
  function nearStart(fix) {
    const p = store.profile;
    if (!p) return null;
    return U.haversine(fix.lat, fix.lng, p.lat[0], p.lng[0]);
  }

  /** Plan d'alimentation d'après le plan de puissance et le matériel. */
  function nutritionFor(plan) {
    const st = store.state, rider = st.rider;
    const base = run.base;
    const cp = base ? base.athlete.cp : (Number(rider.cp) || Number(rider.ftp) || 250);
    const ftp = base ? base.athlete.ftp : (Number(rider.ftp) || 250);
    return Nu.planNutrition({
      P: plan.P, dur: plan.tFinish - plan.t0, mass: Number(rider.weight) || 72, cp, ftp,
      tempC: Number(st.env.temperature), gut: Number(rider.gut) || 0, kit: st.ride.kit,
    });
  }

  function renderNutrition() {
    if (!V.nutSum) return;
    const key = run.plan ? `${run.plan.tFinish}|${run.plan.n}|${JSON.stringify(store.state.ride.kit)}|${store.state.rider.weight}|${store.state.rider.gut}` : '';
    if (key === run.nutKey && V.nutSum.firstChild) return;
    run.nutKey = key;
    D.clear(V.nutSum); D.clear(V.nutList);
    if (!run.plan) { V.nutSum.append(h('p', { class: 'rd-note' }, 'Le plan d\'alimentation apparaît dès qu\'il y a un plan de puissance.')); return; }
    const nut = nutritionFor(run.plan);
    run.nutPreview = nut;
    const L = (x, d = 1) => U.fmt(x, d);
    V.nutSum.append(
      h('p', { class: 'rd-line' }, nut.mode === 'none' ? 'Sortie courte : de l\'eau suffit, pas de glucides à prévoir.'
        : `Visé : ${nut.carbsPerH} g de glucides par heure · ${L(nut.fluidPerH)} L de boisson par heure`),
      h('p', { class: 'rd-line' }, `À prendre : ${nut.need.gels} gel${nut.need.gels > 1 ? 's' : ''}, ${nut.need.bars} barre${nut.need.bars > 1 ? 's' : ''}, ${L(nut.need.liters)} L en gorgées de rappel. `
        + `Emporté : ${nut.have.gels} gel${nut.have.gels > 1 ? 's' : ''}, ${nut.have.bars} barre${nut.have.bars > 1 ? 's' : ''}, ${L(nut.have.liters)} L.`),
      h('p', { class: 'rd-line' }, `Prévision avec ce plan : glycogène au plus bas à ${Math.round(nut.sim.minG * 100)} %, perte d'eau de ${L(nut.sim.lossPct)} % du poids à l'arrivée.`));
    for (const w of nut.warnings) V.nutSum.append(h('p', { class: 'rd-warn' }, w));
    const names = { gel: 'gel', gelglu: 'gel glucose', gelplus: 'gel haute dose', bar: 'barre', barmini: 'mini-barre', drink: 'boire' };
    for (const e of nut.events) V.nutList.append(h('li', null, `${hmm(e.t)} · ${e.type === 'drink' ? 'boire une gorgée' : 'manger : ' + (names[e.kind] || e.kind)}`));
  }

  /* ======================================================================
   * Capteurs
   * ====================================================================== */
  function onFix(f) {
    run.lastFix = f;
    run.fix.push(f);
    const lim = Date.now() - KEEP_MS;
    while (run.fix.length && run.fix[0].ts < lim) run.fix.shift();
    run.gpsErr = '';
    if (run.mode === 'prep' && !run.renderSoon) { run.renderSoon = setTimeout(() => { run.renderSoon = 0; renderPrep(); }, 1000); }
  }

  function toggleGps() {
    if (run.gpsOn) { Sx.gps.stop(); run.gpsOn = false; run.lastFix = null; sensorsChanged(); return; }
    Sx.alerts.unlock();
    run.gpsOn = Sx.gps.start(onFix, (e) => {
      run.gpsErr = e.code === 1 ? 'autorisation refusée' : e.message || 'signal perdu';
      if (e.code === 1) run.gpsOn = false;
      sensorsChanged();
    });
    sensorsChanged();
  }

  /** Mesures du capteur de puissance : puissance (si le profil en donne), cadence, et fréquence cardiaque d'un home-trainer. */
  const onPower = (v, ts) => {
    if (Number.isFinite(v.w)) { run.power.push({ ts, w: v.w }); trim(run.power); }
    if (Number.isFinite(v.cad)) { run.cads.push({ ts, w: v.cad }); trim(run.cads); }
    if (Number.isFinite(v.hr) && v.hr > 0 && Sx.hr.state !== 'on') { run.hrs.push({ ts, w: v.hr }); trim(run.hrs); }
  };
  const onPowerState = (s) => { run.powerOn = s === 'on'; sensorsChanged(); };
  const onHr = (v, ts) => { if (Number.isFinite(v.hr) && v.hr > 0) { run.hrs.push({ ts, w: v.hr }); trim(run.hrs); } };
  const onHrState = (s) => { run.hrOn = s === 'on'; sensorsChanged(); };

  async function connectPower(mode) {
    if (Sx.power.state === 'on') { Sx.power.disconnect(); run.powerOn = false; sensorsChanged(); return; }
    try { await Sx.power.connect(mode, onPower, onPowerState); } catch (e) { if (e.name !== 'NotFoundError') D.toast('Capteur de puissance : ' + e.message, 'error'); }
    sensorsChanged();
  }

  async function connectHr(mode) {
    if (Sx.hr.state === 'on') { Sx.hr.disconnect(); run.hrOn = false; sensorsChanged(); return; }
    try { await Sx.hr.connect(mode, onHr, onHrState); } catch (e) { if (e.name !== 'NotFoundError') D.toast('Ceinture cardio : ' + e.message, 'error'); }
    sensorsChanged();
  }

  /** Reconnexion à l'appareil déjà autorisé, sans liste de choix (après un rechargement de la page, ou à l'ouverture de la page Sortie). */
  async function reconnectKnown(kind) {
    const dev = kind === 'power' ? Sx.power : Sx.hr;
    try { await (kind === 'power' ? dev.reconnect(onPower, onPowerState) : dev.reconnect(onHr, onHrState)); }
    catch (e) { D.toast((kind === 'power' ? 'Capteur de puissance : ' : 'Ceinture cardio : ') + e.message, 'error'); }
    sensorsChanged();
  }

  function trim(list) { const lim = Date.now() - KEEP_MS; while (list.length && list[0].ts < lim) list.shift(); }
  const meanIn = (list, a, b) => { let s = 0, n = 0; for (const x of list) if (x.ts >= a && x.ts < b) { s += x.w; n++; } return n ? s / n : undefined; };
  const lastIn = (list, a, b) => { let r = null; for (const x of list) if (x.ts >= a && x.ts < b) r = x; return r; };

  /* ======================================================================
   * Sortie en cours
   * ====================================================================== */
  function alertsOn() { return run.mode === 'live' && !run.paused; }

  function notify(kind, text, urgent) {
    const c = cfg(), now = Date.now();
    if (!alertsOn()) return;
    if (!urgent && now - run.al.last < 4000) return;
    run.al.last = now;
    const pat = Sx.alerts.PATTERNS[kind] || Sx.alerts.PATTERNS.info;
    if (c.sound) Sx.alerts.tones(pat.tones);
    if (c.vibrate) Sx.alerts.vibrate(pat.vib);
    if (c.voice && text) Sx.alerts.speak(text);
    if (text) setBanner(text, kind);
  }

  let bannerTimer = 0;
  function setBanner(text, kind) {
    if (!V.banner) return;
    V.banner.textContent = text;
    V.banner.dataset.kind = kind || 'info';
    V.banner.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { V.banner.hidden = true; }, 6000);
  }

  /* ---------- mode démo : rejouer une sortie enregistrée ---------- */

  /** Texte de l'état : fichier chargé, durée, puissance, part du parcours couverte. */
  function renderReplay() {
    const info = run.replayInfo;
    V.replayClear.hidden = !run.replayAct;
    V.biasRow.hidden = !!run.replayAct;
    setTxt(V.replaySt, !run.replayAct
      ? 'Sans fichier, un cycliste simulé suit la consigne. Avec un fichier GPX, TCX ou FIT d\'une sortie faite sur ce même parcours, ses positions, sa vitesse, sa puissance et son cœur sont rejoués à la place.'
      : `${run.replayName}${info ? ` : ${U.fmtClock(info.duration)} sur le parcours, ${info.hasPower ? `puissance moyenne ${U.fmt(info.avgPower, 0)} W` : 'sans puissance (elle sera estimée)'}${info.hasHr ? ', cœur' : ''}${info.hasCad ? ', cadence' : ''}.` : ' (sera vérifiée au départ).'}`);
  }

  async function onReplayFile(e) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let act, info = null;
    try {
      act = PYR.replay.load(await f.arrayBuffer());
      let base = null;
      try { base = buildBase(); } catch (err) { /* pas de parcours ou de plan : la vérification aura lieu au départ */ }
      if (base) info = PYR.replay.create({ activity: act, course: base.course }).info;
    } catch (err) {
      D.toast('Sortie refusée : ' + err.message, 'error');
      return;
    }
    run.replayAct = act; run.replayName = f.name; run.replayInfo = info;
    renderReplay();
    renderPrep();
  }

  async function startLive() {
    if (run.mode !== 'prep' || !run.plan) return;
    Sx.alerts.unlock();
    const demo = V.demoChk.querySelector('input').checked;
    const startMs = Date.now();
    let base;
    try { base = sessionBase(startMs); } catch (e) { D.toast(e.message, 'error'); return; }
    const st = store.state, rider = st.rider;
    let demoRider = null;
    if (demo) {
      try {
        demoRider = run.replayAct ? PYR.replay.create({ activity: run.replayAct, course: base.course })
          : R.createDemo({ course: base.course, setup: base.setup, athlete: sessionAthlete(base), seed: startMs % 9973, bias: st.ride.demo.bias / 100 });
      } catch (e) { D.toast(e.message, 'error'); return; }
    }
    run.base = base;
    clearSaved();
    const sess = R.createSession({
      course: base.course, setup: base.setup, athlete: sessionAthlete(base), mass: Number(rider.weight) || 72, kit: st.ride.kit, gut: Number(rider.gut) || 0,
      tempC: Number(st.env.temperature), startMs, cfg: st.ride.cfg, physio: physioCard(base),
    });
    sess.setPlan(run.plan, 'plan initial');
    run.sess = sess;
    run.nut = nutritionFor(run.plan);
    run.coach = Nu.createCoach(run.nut);
    run.demo = demoRider;
    run.demoSpeed = st.ride.demo.speed;
    run.demoWall = startMs;
    run.power.length = 0; run.hrs.length = 0; run.cads.length = 0;
    run.mix = cfg().mixed && store.profile ? createMix(base, (Math.random() * 4294967296) >>> 0) : null;
    if (run.mix && !run.mix.n) run.mix = null;                   // aucun coureur virtuel : pas de défi
    enterLive();
  }

  /** Défi contre des coureurs virtuels : réglages du mode jeu (nombre, niveau), points de passage de l'onglet Parcours, graine tirée au départ. */
  function mixOptions(base, n) {
    const st = store.state;
    return { course: base.course, gustSeed: base.seed, rider: st.rider, bike: st.bike, colors: PYR.race.palette(PYR.challenges.COLORS, n) };
  }
  function createMix(base, seed) {
    const st = store.state, n = Math.max(0, Math.min(PYR.race.MAX_BOTS, Math.floor(Number(st.game.bots) || 0)));
    // niveau « égal » étalonné sur le temps du plan du cycliste (ce qu'il peut faire de mieux) : « de ton niveau » est alors vrai
    const target = run.plan ? run.plan.tFinish - run.plan.t0 : 0;
    return PYR.rideMixed.create(Object.assign(mixOptions(base, n), { cps: mixCps(), rules: {}, seed, n, level: st.game.botLevel, targetTime: target }));
  }

  /* ---------- défi contre des coureurs virtuels : pendant la sortie ---------- */
  const MIX_BUDGET_MS = 6;                     // ms de calcul des coureurs virtuels par tour d'horloge
  const ME_COLOR = '#eb6834';

  /** Un tour d'horloge du défi : départ, coureurs virtuels, passages aux sprints et aux sommets (annonces). */
  function mixTick(sess) {
    const m = run.mix;
    if (!m) return;
    const Cl = PYR.classif, CV = PYR.classifView;
    for (const e of PYR.rideMixed.update(m, sess, MIX_BUDGET_MS)) {
      const gap = e.gap > 0.05 ? ` (${CV.gapText(e.gap)})` : e.gap < -0.05 ? ` (${U.fmt(-e.gap, 0)} s d'avance)` : '';
      notify('info', `${Cl.shortLabel(e.point, m.cps)} : ${CV.ordinal(e.rank)}${gap}${e.pts ? ' · ' + CV.pts(e.pts) : ''}`, true);
    }
  }

  const gapTxt = (s) => (s < 60 ? `${Math.round(s)} s` : hmm(s));
  const distTxt = (m) => (Math.abs(m) < 1000 ? `${Math.round(Math.abs(m) / 10) * 10} m` : `${U.fmt(Math.abs(m) / 1000, 1)} km`);

  /** Lignes du classement affichées : les premiers, et ceux qui entourent le cycliste (gros peloton). */
  function mixRows(rows) {
    if (rows.length <= 9) return rows;
    const i = rows.findIndex((r) => r.me), keep = new Set([0, 1, rows.length - 1]);
    for (let k = i - 3; k <= i + 3; k++) if (k >= 0 && k < rows.length) keep.add(k);
    return rows.filter((r, k) => keep.has(k));
  }

  /** Carte de classement, pastille de place du bandeau et classements annexes (4 fois par seconde au plus). */
  function renderMix() {
    const m = run.mix, sess = run.sess;
    V.mix.hidden = V.chRank.hidden = !m;
    if (!m) return;
    const Mx = PYR.rideMixed, CV = PYR.classifView, started = m.t0 !== null;
    const rows = Mx.board(m, sess, sess.t), me = rows.find((r) => r.me);
    const act = PYR.classif.active(m.cps), hasKom = m.cps.some((c) => c.type === 'kom');
    setTxt(V.chRank, started ? `${CV.ordinal(me.rank)}/${rows.length}` : 'départ');
    setTxt(V.mixHead, started ? `Tu es ${CV.ordinal(me.rank)} sur ${rows.length}` : 'Les coureurs partent quand tu franchis la ligne de départ');
    V.mixTabs.hidden = !act;
    V.mixTabBtn.kom.hidden = !hasKom;
    if (!act && run.mixTab !== 'course') run.mixTab = 'course';
    for (const k of ['course', 'points', 'kom']) V.mixTabBtn[k].setAttribute('aria-pressed', String(run.mixTab === k));
    if (run.mixTab === 'course') {
      const shown = mixRows(rows);
      const sig = 'c|' + shown.map((r) => `${r.id}:${r.rank}:${started ? Math.round(r.dt) : 0}:${Math.round(r.dm / 10)}`).join('|');
      if (run.mixSig === sig) return;
      run.mixSig = sig;
      D.clear(V.mixBody);
      const tb = h('tbody');
      for (const r of shown) {
        const rel = r.me || !started ? null : r.dt > 0 ? 'ahead' : 'behind';
        tb.appendChild(h('tr', { class: r.me ? 'me' : '' },
          h('td', null, String(r.rank)),
          h('td', null, h('span', { class: 'dot', style: { background: r.color || ME_COLOR } }), r.name),
          h('td', { class: 'g ' + (rel || '') }, rel ? `${rel === 'ahead' ? '▲' : '▼'} ${gapTxt(Math.abs(r.dt))}` : ''),
          h('td', { class: 'd' }, rel ? distTxt(r.dm) : '')));
      }
      V.mixBody.appendChild(h('table', { class: 'rd-mix-table' }, tb));
    } else {
      const key = `${run.mixTab}|${sess.t}|${m.splits.filter((x) => x !== null).length}`;
      if (run.mixSig === key) return;
      run.mixSig = key;
      const sd = Mx.standings(m, sess), nm = Mx.names(m), name = (id) => (nm.get(id) ? nm.get(id).name : id);
      D.clear(V.mixBody);
      V.mixBody.appendChild(CV.table(run.mixTab === 'kom' ? sd.kom : sd.points, name, 'me', run.mixTab === 'kom' ? 'kom' : 'green'));
    }
  }

  function enterLive() {
    run.mode = 'live'; run.paused = false; run.replanning = false;
    run.al = { seg: -1, over: null, under: null, last: 0, eat: null, drink: null, wbal: false, gps: false, pwr: false };
    run.profPts = null;
    run.wxBusy = false; run.wxNextT = run.sess.t + cfg().weatherMin * 60;      // prochaine mise à jour de la météo (instant de la sortie, s)
    setMode('live');
    Sx.wake.request();
    if (!run.demo && !run.gpsOn) toggleGps();
    clearInterval(run.timer);
    run.timer = setInterval(tick, 250);
    tick();
  }

  /** Les mesures de la seconde k de la sortie (réelles ou simulées). */
  function inputsFor(sess, k) {
    if (run.demo && run.demo.replay) {
      const out = run.demo.step();
      const estimate = out.power === undefined && out.fix ? sess.estimate(out.fix.speed) : undefined;     // sortie sans puissance : estimée comme sans capteur
      return { power: out.power, hr: out.hr, cad: out.cad, fix: out.fix, estimate, done: out.done };
    }
    if (run.demo) {
      const g = sess.guidance();
      const out = run.demo.step(g ? g.target : 0);
      return { power: out.power, fix: out.fix, hr: undefined, done: out.done };
    }
    const a = sess.startMs + k * 1000, b = a + 1000;
    const f0 = lastIn(run.fix, a, b);
    const f = f0 ? Object.assign({}, f0, { age: (b - f0.ts) / 1000 }) : null;   // le point date d'avant la fin de la seconde
    const power = meanIn(run.power, a, b);
    const hr = meanIn(run.hrs, a, b);
    const cad = meanIn(run.cads, a, b);
    let estimate;
    if (power === undefined && !run.powerOn) estimate = sess.estimate(f && Number.isFinite(f.speed) ? f.speed : undefined);
    return { power, hr, cad, sensorOn: run.powerOn, fix: f, estimate };
  }

  function tick() {
    const sess = run.sess;
    if (!sess || run.mode !== 'live') return;
    const now = Date.now();
    let due;
    if (run.demo) {
      if (run.replanning) run.demoWall += now - (run.lastTick || now);      // le temps simulé attend le recalcul
      due = Math.floor((now - run.demoWall) / 1000 * run.demoSpeed);
    } else due = Math.floor((now - sess.startMs) / 1000);
    run.lastTick = now;
    let guard = 0;
    while (sess.t < due && !sess.finished && guard++ < 900) {
      const inp = inputsFor(sess, sess.t);
      sess.step(inp);
      if (inp.done && !sess.finished) sess.finished = true;
      const rq = sess.takeReplanRequest();
      if (rq && !run.paused) replan(rq.reason);
    }
    weatherTick(sess);
    coachTick();
    mixTick(sess);
    const g = sess.guidance();
    if (g) { alertsTick(g); render(g); }
    if (sess.t - run.lastSave >= SAVE_EVERY) saveSession();
    if (sess.finished) finish();
  }

  /* ---------- mise à jour de la météo pendant la sortie ---------- */
  const WX_RETRY_S = 120;                      // s : nouvel essai après un échec (réseau coupé)

  /** La météo se rafraîchit toutes les cfg.weatherMin minutes, seulement si elle est utilisée par le parcours ; chaque mise à jour recalcule le plan. */
  function weatherTick(sess) {
    const course = run.base && run.base.course;
    if (!course || !course.weather || course.weather.custom || run.wxBusy || run.replanning || run.paused || sess.finished) return;
    if (!(sess.t >= run.wxNextT) || sess.course.length - sess.s < 400) return;     // près de l'arrivée, plus de recalcul
    refreshWeather(sess);
  }

  async function refreshWeather(sess) {
    run.wxBusy = true;
    try {
      const course = run.base.course, We = PYR.weather, startEpoch = Math.floor(sess.startMs / 1000);
      // prévisions aux mêmes points du tracé, autour de l'heure de départ réelle de la sortie
      const res = await PYR.services.fetchWeather(course.weather.stations, We.epochToLocal(startEpoch, course.weather.off));
      if (run.sess !== sess || run.mode !== 'live') return;
      const w = We.normalize(Object.assign({}, res.snapshot, { start: startEpoch }));
      if (!w) throw new Error('prévisions invalides');
      course.weather = w;                                      // le parcours est partagé avec la séance, le recalcul et les coureurs virtuels
      for (let k = 0; k < w.stations.length && !course.hasGusts; k++) for (let i = 0; i < w.n; i++) if (w.gust[k][i] > w.ws[k][i] + 0.3) { course.hasGusts = true; break; }
      sess.weatherChanged();
      run.wxNextT = sess.t + cfg().weatherMin * 60;
      await replan('météo mise à jour');
    } catch (e) {
      console.warn('Mise à jour de la météo impossible', e);
      run.wxNextT = sess.t + WX_RETRY_S;
      D.toast('Météo indisponible : nouvel essai dans 2 min.', 'error');
    } finally {
      run.wxBusy = false;
    }
  }

  /** Recalcul du plan du reste du parcours, depuis l'état réel. */
  async function replan(reason) {
    const sess = run.sess;
    if (!sess || run.replanning || sess.finished) return;
    if (sess.course.length - sess.s < 400) { D.toast('Trop près de l\'arrivée pour recalculer.'); return; }
    run.replanning = true; sess.replanning = true;
    setBanner('Recalcul du plan : ' + reason + '…', 'plan');
    const t0 = Date.now();
    try {
      const wScale = refIsForm(run.base.margin) ? 1 : 1 - run.base.margin;
      const input = sess.replanInput(run.base, wScale);
      const res = await PYR.optimizer.optimize(input);
      if (run.sess !== sess || run.mode !== 'live') return;
      if (!res.ok) { D.toast('Recalcul impossible : ' + res.error, 'error'); return; }
      const before = sess.plan.tFinish;
      sess.setPlan(R.planFromResult(res, run.base.course.length, planRef(input.athlete, run.base.margin, input.start.wbal / wScale)), reason);
      const d = sess.plan.tFinish - before;
      notify('plan', `Plan mis à jour : arrivée ${hmm(sess.plan.tFinish)}`, true);
      setBanner(`Plan mis à jour (${reason}) : arrivée ${hmm(sess.plan.tFinish)}${Math.abs(d) >= 1 ? ' (' + U.fmtDelta(d) + ')' : ''}`, 'plan');
      run.lastReplanMs = Date.now() - t0;
      saveSession();
    } catch (e) {
      console.error(e);
      D.toast('Erreur de recalcul : ' + e.message, 'error');
    } finally {
      run.replanning = false; sess.replanning = false;
    }
  }

  /* ---------- alimentation en cours de sortie ---------- */
  function coachTick() {
    const sess = run.sess;
    if (!sess || !run.coach) return null;
    const g = sess.guidance();
    if (!g) return null;
    const plan = sess.plan, ftp = sess.athlete.ftp;
    const k = Math.max(0, Math.floor(sess.t - plan.t0));
    let easy = false;
    if (plan.P.length) {
      let s = 0, n = 0;
      for (let i = k; i < Math.min(plan.P.length, k + 300); i++) { s += plan.P[i]; n++; }
      easy = n > 0 && s / n < 0.75 * ftp;
    }
    const f = sess.fuel, st = g.fuelStatus;
    run.rem = run.coach.update(sess.t, {
      P3: g.p10, cp: sess.athlete.cp, G: g.energy, lossPct: g.lossPct, remaining: g.remainPlanT, easy, stock: { gels: st.gels, bars: st.bars },
    });
    return run.rem;
  }

  function takeFood(kind) {
    const sess = run.sess;
    if (!sess || !kind) return;
    const label = sess.eat(kind);
    if (label) { run.coach.taken('eat', sess.t); run.al.eat = null; D.toast('Noté : ' + label); coachTick(); render(sess.guidance()); }
  }
  function takeDrink(idx) {
    const sess = run.sess;
    if (!sess) return;
    const q = sess.drink(idx);
    if (q > 0) { run.coach.taken('drink', sess.t); run.al.drink = null; D.toast(`Noté : ${U.fmt(q * 1000)} mL`); coachTick(); render(sess.guidance()); }
    else D.toast('Plus rien à boire dans ce contenant.', 'error');
  }

  /* ---------- alertes ---------- */
  function alertsTick(g) {
    if (!alertsOn()) return;
    const A = run.al, c = cfg(), t = g.t;
    // changement de consigne à venir
    if (c.lookahead > 0 && g.next && g.segTimeLeft <= c.lookahead && A.seg !== g.segIndex && g.segTimeLeft > 0.5) {
      A.seg = g.segIndex;
      const to = Math.round(g.next.P / 5) * 5, d = to - g.target;
      if (Math.abs(d) >= 10) notify(d > 0 ? 'up' : 'down', to < 15 ? 'Roue libre' : `${d > 0 ? 'Plus fort' : 'Relâche'}, ${to} watts`);
    }
    // consigne non respectée depuis 10 s (trop fort) ou 15 s (trop faible), puis au plus toutes les 45 s / 60 s
    A.over = g.cue === 'way_over' ? (A.over === null ? t : A.over) : null;
    A.under = g.cue === 'way_under' && g.target >= 80 ? (A.under === null ? t : A.under) : null;
    if (A.over !== null && t - A.over >= 10 && t - (A.tOver === undefined ? -99 : A.tOver) > 45) { A.tOver = t; notify('down', 'Trop fort, relâche un peu'); }
    if (A.under !== null && t - A.under >= 15 && t - (A.tUnder === undefined ? -99 : A.tUnder) > 60) { A.tUnder = t; notify('up', 'Plus fort pour tenir le plan'); }
    // W′ presque vide
    if (g.wbalFrac < 0.12 && g.p3 > run.sess.athlete.cp && !A.wbal) { A.wbal = true; notify('warn', 'Attention, W prime presque vide', true); }
    if (g.wbalFrac > 0.3) A.wbal = false;
    // capteurs
    if (g.gpsLost && !A.gps) { A.gps = true; notify('warn', 'Signal GPS perdu', true); }
    if (!g.gpsLost) A.gps = false;
    if (g.powerLost && !A.pwr && !run.demo) { A.pwr = true; notify('warn', 'Capteur de puissance perdu', true); }
    if (!g.powerLost) A.pwr = false;
    // alimentation
    const r = run.rem;
    if (r) {
      for (const [key, lbl, say] of [['eat', 'Manger', 'Pense à manger'], ['drink', 'Boire', 'Pense à boire']]) {
        const x = r[key];
        if (!x || x.deferred || x.inS > 0) { if (!x || x.inS > 0) A[key] = null; continue; }
        if (A[key] === null || t - A[key] >= 120) { A[key] = t; notify('eat', x.empty ? 'Plus rien à manger' : say, x.urgent); }
      }
    }
  }

  /* ======================================================================
   * Affichage de la sortie
   * ====================================================================== */
  function buildLive() {
    V.live = h('section', { class: 'rd-live', hidden: true });
    V.banner = h('div', { class: 'rd-banner', hidden: true });

    // bandeau : capteurs et menu, puis les mesures (vitesse, puissance, cardio, distance, temps)
    V.chGps = h('span', { class: 'rd-chip' }, 'GPS');
    V.chPwr = h('span', { class: 'rd-chip' }, 'PUISS.');
    V.chPlan = h('span', { class: 'rd-chip plan', hidden: true }, 'Recalcul…');
    V.menuBtn = h('button', { class: 'rd-icon', type: 'button', 'aria-label': 'Réglages et actions', onclick: () => openMenu() }, '⋯');
    V.chRank = h('span', { class: 'rd-chip rank', hidden: true, title: 'Ta place parmi les coureurs virtuels' });
    V.status = h('div', { class: 'rd-status' }, h('span', { class: 'rd-chips' }, V.chRank, V.chPlan, V.chGps, V.chPwr), V.menuBtn);
    const tile = (cls, label) => {
      const val = h('div', { class: 'v' }), sub = h('div', { class: 's' });
      return { el: h('div', { class: 'rd-tile ' + cls }, h('div', { class: 'l' }, label), val, sub), val, sub };
    };
    V.hSpeed = tile('speed', 'Vitesse'); V.hGrade = tile('grade', 'Pente'); V.hPow = tile('pow', 'Puissance'); V.hHr = tile('hr', 'Cardio');
    V.hDist = tile('dist', 'Distance'); V.hTime = tile('time', 'Temps');
    V.hud = h('div', { class: 'rd-hud' }, V.hSpeed.el, V.hGrade.el, V.hPow.el, V.hHr.el, V.hDist.el, V.hTime.el);
    V.head = h('div', { class: 'rd-head' }, V.status, V.hud);

    // carte : l'élément #map de la page y est déplacé le temps de la sortie (attachMap)
    V.mTurnArrow = h('span', { class: 'a' }); V.mTurnTxt = h('span', { class: 't' });
    V.mapTurn = h('div', { class: 'rd-map-turn', hidden: true }, V.mTurnArrow, V.mTurnTxt);
    V.mapNorth = h('div', { class: 'rd-map-north', hidden: true, title: 'Nord' }, h('span', { class: 'ar' }), h('span', { class: 'n' }, 'N'));
    V.mapAttr = h('div', { class: 'rd-map-attr' });     // l'attribution de Leaflet, quand la carte tourne (la sienne est alors hors de la vue)
    V.mapProf = h('canvas', { class: 'rd-map-prof', hidden: true, onclick: () => { run.profNear = !run.profNear; if (run.sess) render(run.sess.guidance()); } });
    V.pockets = h('div', { class: 'rd-pockets', hidden: true, role: 'dialog', 'aria-label': 'Poches' });   // liste des aliments et boissons, sur la carte (renderPockets)
    V.segLeft = h('div', { class: 'rd-next', title: 'Temps restant avant la fin du segment' });
    V.ovChips = h('div', { class: 'rd-ov-chips' }, V.segLeft);     // fin du tronçon et tronçon suivant, par-dessus la carte (placeHud)
    V.mapBox = h('div', { class: 'rd-map', hidden: true }, V.mapTurn, V.mapNorth, V.mapAttr, V.ovChips, V.pockets, V.mapProf);

    // écart
    V.gapLbl = h('div', { class: 'rd-gap-lbl' });
    V.gapVal = h('div', { class: 'rd-gap-val' });
    V.gapSub = h('div', { class: 'rd-gap-sub' });
    V.gap = h('div', { class: 'rd-card rd-gap', 'data-state': 'even' }, h('div', { class: 'rd-gap-l' }, V.gapLbl, V.gapSub), V.gapVal);

    // consigne
    V.tgtLbl = h('div', { class: 'rd-tgt-lbl' }, 'Consigne');
    V.tgt = h('div', { class: 'rd-tgt' });
    V.cueTxt = h('span', { class: 'rd-cue' });           // part du temps dans le tube de la consigne, sur le tronçon en cours
    V.cueSub = h('span', { class: 'rd-cue-sub' });
    V.traj = h('canvas', { class: 'rd-traj' });
    V.seg = h('div', { class: 'rd-seg' });
    V.next = h('div', { class: 'rd-next' });
    V.est = h('div', { class: 'rd-est' });
    // le bloc consigne (valeur, part du temps dans la cible, courbe qui défile) se pose par-dessus la carte (placeHud) ; le détail du tronçon reste dans la page
    V.power = h('div', { class: 'rd-card rd-power', 'data-cue': 'ok' },
      h('div', { class: 'rd-pw-l' }, V.tgtLbl, V.tgt, h('div', { class: 'rd-gauge-lbl' }, V.cueTxt, V.cueSub)), V.traj);
    V.info = h('div', { class: 'rd-card rd-info' }, V.est, V.seg, V.next);   // V.next : tronçon suivant (sur la carte pendant la sortie)

    // défi contre des coureurs virtuels : place, classement en course, points, montagne
    V.mixHead = h('div', { class: 'rd-mix-head' });
    V.mixTabBtn = {};
    for (const [k, label] of [['course', 'Course'], ['points', 'Points'], ['kom', 'Montagne']]) {
      V.mixTabBtn[k] = h('button', { class: 'rd-mbtn small', type: 'button', onclick: () => { run.mixTab = k; run.mixSig = ''; if (run.sess) renderMix(); } }, label);
    }
    V.mixTabs = h('div', { class: 'rd-mix-tabs', hidden: true }, V.mixTabBtn.course, V.mixTabBtn.points, V.mixTabBtn.kom);
    V.mixBody = h('div', { class: 'rd-mix-body' });
    V.mix = h('div', { class: 'rd-card rd-mix', hidden: true }, h('h3', null, 'Classement'), V.mixHead, V.mixTabs, V.mixBody);

    // réserves
    const reserve = (name, stacked) => {
      const fill = h('div', { class: 'fill' }), tick = h('div', { class: 'tick', hidden: true });
      const val = h('span', { class: 'val' }), sub = h('span', { class: 'sub' });
      // glycogène : le foie à la suite des muscles, puis les glucides avalés en hachuré : dans l'intestin, puis dans l'estomac
      const liver = stacked ? h('div', { class: 'fill liver' }) : null, gut = stacked ? h('div', { class: 'gut' }) : null, stomach = stacked ? h('div', { class: 'gut stomach' }) : null;
      const el = h('div', { class: 'rd-res-row' }, h('span', { class: 'nm' }, name), h('div', { class: 'track' + (stacked ? ' stacked' : '') }, fill, liver, gut, stomach, tick), val, sub);
      return { el, fill, tick, val, sub, liver, gut, stomach };
    };
    V.rW = reserve('W′'); V.rG = reserve('Glycogène', true); V.rH = reserve('Hydratation');
    V.rT = reserve('Chaleur');      // modèle physiologique : température centrale, de 37 à 40 °C
    V.rT.el.hidden = true;
    V.tenable = h('div', { class: 'rd-tenable' });
    V.phys = h('div', { class: 'rd-phys', hidden: true });   // modèle physiologique : PC effective, glycémie, FC prévue, sodium
    V.res = h('div', { class: 'rd-card rd-res', role: 'button', tabindex: '0', title: 'Poches : manger ou boire', onclick: () => togglePockets(),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePockets(); } } }, V.rW.el, V.rG.el, V.rH.el, V.rT.el, V.tenable, V.phys);

    // alimentation
    const slot = (key, icon, name) => {
      const txt = h('span', { class: 'txt' }), btn = h('button', { class: 'btn', type: 'button' }, 'Pris');
      const el = h('div', { class: 'rd-nut-item', 'data-state': 'later' }, h('span', { class: 'ic' }, icon), h('span', { class: 'nm' }, name), txt, btn);
      return { el, txt, btn };
    };
    V.nEat = slot('eat', '🍌', 'Manger'); V.nDrink = slot('drink', '💧', 'Boire');
    V.nEat.btn.addEventListener('click', () => { const r = run.rem && run.rem.eat; takeFood(r && r.kind ? r.kind : defaultFood()); });
    V.nDrink.btn.addEventListener('click', () => takeDrink());
    V.stock = h('div', { class: 'rd-stock' });
    V.nutQuick = h('div', { class: 'rd-quick' },
      h('button', { class: 'btn small', type: 'button', onclick: () => takeFood('gel') }, '+ Gel'),
      h('button', { class: 'btn small', type: 'button', onclick: () => takeFood('bar') }, '+ Barre'),
      h('button', { class: 'btn small', type: 'button', onclick: () => takeDrink() }, '+ Gorgée'),
      h('button', { class: 'btn small', type: 'button', onclick: () => openFood() }, 'Autre…'));
    V.nut = h('div', { class: 'rd-card rd-nut' }, V.nEat.el, V.nDrink.el, V.nutQuick, V.stock);

    // profil
    V.prof = h('canvas', { class: 'rd-prof', onclick: () => { run.profNear = !run.profNear; if (run.sess) render(run.sess.guidance()); } });
    V.profCap = h('div', { class: 'rd-prof-cap' });
    V.profCard = h('div', { class: 'rd-card rd-profile' }, V.prof, V.profCap);

    V.live.append(V.banner, V.head, V.mapBox, (V.liveA = h('div', { class: 'rd-live-a' }, V.gap, V.mix, V.power, V.info)), (V.liveB = h('div', { class: 'rd-live-b' }, V.res, V.nut, V.profCard)));
  }

  const defaultFood = () => {
    const st = run.sess ? Fu.status(run.sess.fuel) : null;
    return st && st.gels > 0 ? 'gel' : 'bar';
  };

  function togglePause() {
    run.paused = !run.paused;
    V.live.classList.toggle('paused', run.paused);
    if (run.sess) { run.sess.cfg.auto = run.paused ? false : cfg().auto; }
  }

  function confirmEnd() {
    D.modal({
      title: 'Terminer la sortie ?', body: [h('p', null, 'L\'enregistrement s\'arrête. Tu pourras exporter la trace en GPX.')],
      actions: [{ label: 'Continuer' }, { label: 'Terminer', primary: true, onClick: () => { finish(true); } }],
    });
  }

  /** Mise à jour de l'écran (4 fois par seconde au plus). */
  function render(g) {
    if (!g || run.mode !== 'live') return;
    const sess = run.sess;
    // bandeau
    setAttr(V.chGps, 'data-ok', g.offCourse ? 'off' : g.gpsLost ? 'no' : run.demo || run.lastFix ? 'yes' : 'no');
    setTxt(V.chGps, g.offCourse ? 'HORS TRACÉ' : 'GPS');
    setAttr(V.chPwr, 'data-ok', run.demo || run.powerOn ? 'yes' : g.powerEstimated ? 'est' : 'no');
    setTxt(V.chPwr, g.powerEstimated ? 'PUISS. ~' : 'PUISS.');
    V.chPlan.hidden = !run.replanning;
    // mesures
    const avgKmh = g.t > 5 ? g.s / g.t * 3.6 : 0;
    setTxt(V.hSpeed.val, U.fmt(g.v * 3.6, 1)); setTxt(V.hSpeed.sub, `km/h · moy ${U.fmt(avgKmh, 1)}`);
    setTxt(V.hGrade.val, U.fmt(g.grade * 100, 1)); setTxt(V.hGrade.sub, '%');
    setTxt(V.hPow.val, Math.round(g.pDisp) + ''); setTxt(V.hPow.sub, g.pDispN === 1 ? 'W · instantanée' : `W · moy ${g.pDispN} s`);
    const hr = (run.hrOn || (run.demo && run.demo.replay)) && sess.hr > 0 ? Math.round(sess.hr) : 0;   // ceinture, ou cœur de la sortie rejouée
    const ph = g.fuelStatus && g.fuelStatus.phys;   // modèle physiologique : FC prédite à comparer à la mesure
    const hf = ph && ph.hrFit;                        // recalage du modèle par la FC mesurée (filtre de Kalman de metabo.js)
    setTxt(V.hHr.val, hr ? hr + '' : '–');
    setTxt(V.hHr.sub, hr ? (ph ? `bpm · prévue ${Math.round(ph.HR)}` : 'bpm') : ph ? `prévue ${Math.round(ph.HR)} bpm` : run.hrOn ? 'en attente' : 'pas de ceinture');
    setAttr(V.hHr.el, 'title', hf ? `FC prévue par le modèle physiologique, recalé sur ta FC depuis ${hmm(hf.n)}.` : '');
    setTxt(V.hDist.val, km(g.s)); setTxt(V.hDist.sub, `km · reste ${km(g.remaining)}`);
    setTxt(V.hTime.val, hmm(g.t)); setTxt(V.hTime.sub, `reste ${hmm(g.remainPlanT)}`);

    // écart
    const gap = g.gap, state = Math.abs(gap) < 3 ? 'even' : gap > 0 ? 'ahead' : 'behind';
    setAttr(V.gap, 'data-state', state);
    setTxt(V.gapLbl, state === 'even' ? 'Dans le plan' : state === 'ahead' ? 'En avance' : 'En retard');
    setTxt(V.gapVal, (state === 'even' ? '±' : state === 'ahead' ? '+' : '−') + gapText(gap));
    const m = Math.round(g.gapM);
    setTxt(V.gapSub, `${m >= 0 ? '+' : '−'}${Math.abs(m)} m · arrivée ${hmm(g.finishProj)}${Math.abs(g.finishDelta0) >= 1 ? ` (${U.fmtDelta(g.finishDelta0)} sur le plan de départ)` : ''}`);

    // consigne
    const tg = g.target;
    setAttr(V.power, 'data-cue', g.cue);
    setTxt(V.tgt, tg < 15 ? 'Roue libre' : tg + ' W');
    V.tgt.classList.toggle('word', tg < 15);
    // part du temps passé dans le tube de la consigne (± 5 %, moyenne 3 s) depuis le début du tronçon en cours
    setTxt(V.cueTxt, g.zonePct === null ? '–' : Math.round(g.zonePct * 100) + ' %');
    setTxt(V.cueSub, 'dans la cible' + (g.cad > 0 ? ` · ${Math.round(g.cad)} tr/min` : ''));
    drawTrajectory(g);
    const e = g.powerEstimated ? g.est30 : null;           // l'estimation sur 30 s ne sert que sans capteur de puissance
    V.est.hidden = !e;
    if (e) {
      const pct = Math.round(e.alpha * 100), dh = (x) => (x >= 0 ? '+' : '−') + U.fmt(Math.abs(x), 1) + ' m';
      setTxt(V.est, `Estimée sur ${e.n} s : ${Math.round(e.P)} W`);
      V.est.title = `Bilan d'énergie sur ${e.n} s d'après la vitesse, la météo et la dénivelée ${dh(e.dh)} : ${pct} % altitude mesurée`
        + (Number.isFinite(e.dhMeas) ? ` (${dh(e.dhMeas)})` : ' (pas de mesure)') + `, ${100 - pct} % tracé (${dh(e.dhCourse)}).` + (g.altForced ? ' Hors parcours : l\'altitude du tracé ne compte plus.' : '');
    }
    if (g.seg) {
      setTxt(V.segLeft, `Fin du segment · ${hmm(g.segTimeLeft)}`);
      setTxt(V.seg, `Tronçon ${g.segIndex + 1}/${g.segCount} · km ${km(g.seg.a)} → ${km(g.seg.b)} · pente ${U.fmt(g.grade * 100, 1)} % · encore ${km(g.toSegEnd, g.toSegEnd < 1000 ? 2 : 1)} km (${hmm(g.segTimeLeft)})`);
      setTxt(V.next, g.next ? `Prochain : ${mmss(g.next.t1 - g.next.t0)} @ ${Math.round(g.next.P / 5) * 5}W` : 'Dernier segment');
    }

    // réserves
    const pct = (x) => Math.round(U.clamp(x, 0, 1) * 100);
    V.rW.fill.style.width = pct(g.wbalFrac) + '%';
    V.rW.tick.hidden = false; V.rW.tick.style.left = pct(g.wbalPlanFrac) + '%';
    const signed = (x) => Math.round(x * 100);                    // négatif : le profil de l'athlète est dépassé
    setTxt(V.rW.val, signed(g.wbalFrac) + ' %'); setTxt(V.rW.sub, `plan ${signed(g.wbalPlanFrac)} %`);
    setAttr(V.rW.el, 'data-lvl', g.wbalFrac < 0 ? 'neg' : g.wbalFrac < 0.15 ? 'low' : g.wbalFrac < 0.4 ? 'mid' : 'ok');
    // modèle physiologique : glycogène des muscles (vert) puis du foie (jaune pâle), sinon un seul stock ; hachuré : glucides avalés pas encore absorbés, intestin (vert) puis estomac (marron)
    const gs = g.fuelStatus, sp = gs && gs.split;
    V.rG.el.classList.toggle('split', !!sp);
    V.rG.fill.style.width = pct(sp ? sp.muscle : g.energy) + '%';
    V.rG.liver.style.width = pct(sp ? sp.liver : 0) + '%';
    V.rG.gut.style.width = pct(gs ? gs.gutParts.intestine : 0) + '%';
    V.rG.stomach.style.width = pct(gs ? gs.gutParts.stomach : 0) + '%';
    setAttr(V.rG.el, 'title', (sp ? 'Vert : glycogène des muscles. Jaune pâle : glycogène du foie. ' : '') + (gs && gs.gut > 1
      ? `Hachuré : glucides avalés pas encore absorbés — intestin (vert) ${Math.round(gs.intestine)} g, estomac (marron) ${Math.round(gs.stomach)} g, absorption ${Math.round(gs.absorbing)} g/h.` : 'Hachuré : glucides avalés, dans l\'intestin (vert) et dans l\'estomac (marron).'));
    setTxt(V.rG.val, pct(g.energy) + ' %');
    const tb = g.timeToBonk;
    setTxt(V.rG.sub, g.bonk ? 'fringale !' : tb < 5400 ? `fringale dans ${hmm(tb)}` : `${g.trend >= 0 ? '+' : '−'}${U.fmt(Math.abs(g.trend) * 100, 0)} %/h`);
    setAttr(V.rG.el, 'data-lvl', g.energy < 0.2 ? 'low' : g.energy < 0.4 ? 'mid' : 'ok');
    V.rH.fill.style.width = pct(g.hydration) + '%';
    setTxt(V.rH.val, pct(g.hydration) + ' %'); setTxt(V.rH.sub, `−${U.fmt(g.lossPct, 1)} % du poids`);
    setAttr(V.rH.el, 'data-lvl', g.hydration < 0.4 ? 'low' : g.hydration < 0.7 ? 'mid' : 'ok');
    // modèle physiologique : température centrale (barre de 37 à 40 °C), puis l'état du corps sur une ligne
    V.rT.el.hidden = !ph; V.phys.hidden = !ph;
    if (ph) {
      V.rT.fill.style.width = pct((ph.Tc - 37) / 3) + '%';
      setTxt(V.rT.val, U.fmt(ph.Tc, 1) + '°');     // température centrale (°C), courte pour tenir dans la colonne
      // recalé : « recalé FC » prend la place de « sueur » (colonne étroite), le débit de sueur reste dans l'info-bulle
      setTxt(V.rT.sub, ph.critical ? 'trop chaud !' : ph.hot ? 'ralentis, bois' : hf ? `recalé FC · ${U.fmt(ph.SR, 1)} L/h` : `noyau · sueur ${U.fmt(ph.SR, 1)} L/h`);
      setAttr(V.rT.el, 'data-lvl', ph.Tc >= 39.5 ? 'low' : ph.Tc >= 38.8 ? 'mid' : 'ok');
      setAttr(V.rT.el, 'title', (hf ? 'Température centrale du modèle, recalée sur la fréquence cardiaque mesurée (filtre de Kalman)' : 'Température centrale prévue par le modèle (sans ceinture cardio, rien ne la recale)')
        + ` ; sueur ${U.fmt(ph.SR, 1)} L/h.`);
      const dHr = hr ? hr - Math.round(ph.HR) : 0;
      setTxt(V.phys, `PC ${Math.round(ph.CP2e)} W (${Math.round(ph.cpK * 100)} %) · glycémie ${U.fmt(ph.glu, 1)} · I/II/foie ${Math.round(ph.gI * 100)}/${Math.round(ph.gII * 100)}/${Math.round(ph.gL * 100)} %`
        + ` · FC prévue ${Math.round(ph.HR)}${hf ? ', recalée' : ''}${hr ? ` (mesurée ${hr}, ${dHr >= 0 ? '+' : '−'}${Math.abs(dHr)})` : ''} · Na⁺ ${Math.round(ph.Na)}`);
      const sg = (x, d, u) => `${x >= 0 ? '+' : '−'}${U.fmt(Math.abs(x), d)} ${u}`;
      V.phys.title = 'Modèle physiologique : puissance critique du moment, glycémie (mmol/L), glycogène des fibres lentes, rapides et du foie, fréquence cardiaque prévue (mesurée plus haute : plus de chaleur stockée, de déshydratation ou de fibres rapides recrutées), natrémie (mmol/L).'
        + (hf ? `
Recalé sur ta FC depuis ${hmm(hf.n)} (filtre de Kalman) : FC de repos ${Math.round(hf.HRrest)} bpm (${sg(hf.dRest, 0, 'bpm')}), FC max ${Math.round(hf.HRmax)} bpm (${sg(hf.dMax, 0, 'bpm')}),`
          + ` chaleur que la météo ne voit pas ${sg(hf.Q, 0, 'W')} ; incertitude sur le noyau ± ${U.fmt(hf.sdTc, 1)} °C ; écart FC mesurée − prévue sur la dernière minute ${sg(hf.res, 0, 'bpm')}.` : '');
      setAttr(V.phys, 'data-warn', ph.hypo || ph.hypoNa || ph.critical ? '1' : '');
    }
    const te = g.tenable;
    setTxt(V.tenable, te && Number.isFinite(te.t) ? `À ${Math.round(g.p3)} W, tu tiens encore ${hmm(te.t)}${te.by === 'wprime' ? ' (W′)' : ' (courbe record)'}` : g.p3 > 20 ? `À ${Math.round(g.p3)} W, tu peux tenir jusqu'à l'arrivée` : '');

    renderNut(g);
    renderMix();
    mapTick(g);
    drawProfile(g);
  }

  function renderNut(g) {
    const r = run.rem || coachTick();
    const sess = run.sess, t = sess.t;
    const show = (it, x, noun) => {
      if (!x) { setAttr(it.el, 'data-state', 'off'); setTxt(it.txt, 'plus utile avant l\'arrivée'); return; }
      const st = x.inS <= 0 ? (x.urgent ? 'urgent' : 'due') : x.inS < 120 ? 'soon' : 'later';
      setAttr(it.el, 'data-state', x.deferred ? 'soon' : st);
      setTxt(it.txt, x.empty ? 'plus rien dans les poches' : x.deferred ? 'après cet effort' : x.inS <= 0 ? (x.urgent ? 'maintenant !' : `maintenant${noun ? ' : ' + noun : ''}`) : `dans ${hmm(x.inS)}${noun ? ' · ' + noun : ''}`);
    };
    const lbl = (k) => (k === 'gel' ? 'un gel' : k === 'bar' ? 'une barre' : '');
    show(V.nEat, r && r.eat, r && r.eat && !r.eat.empty ? lbl(r.eat.kind) : '');
    show(V.nDrink, r && r.drink, '');
    // le bloc des réserves (sur la carte) signale qu'il est temps de manger ou de boire : ouvrir les poches
    const due = (x) => (x && !x.deferred && x.inS <= 0 ? (x.urgent ? 2 : 1) : 0), need = Math.max(due(r && r.eat), due(r && r.drink));
    setAttr(V.res, 'data-nut', need === 2 ? 'urgent' : need === 1 ? 'due' : '');
    renderPockets(g);
    const st = g.fuelStatus;
    setTxt(V.stock, `${st.gels} gel${st.gels > 1 ? 's' : ''} · ${st.bars} barre${st.bars > 1 ? 's' : ''} · ${U.fmt(st.fluid, 1)} L`
      + (st.gut > 1 ? ` · ${Math.round(st.gut)} g en cours d'absorption (${Math.round(st.absorbing)} g/h)` : ''));
  }

  /* ---------- trajectoire de puissance ---------- */
  const TRAJ_PAST = 30, TRAJ_AHEAD = 15;     // s affichées avant et après l'instant courant

  /**
   * Tube de la consigne (± 5 %) sur les 30 dernières et les 15 prochaines secondes, avec la puissance moyenne sur 3 s qui le traverse
   * (ou pas) et, juste à droite de l'instant courant, ce qu'il faut produire à la seconde suivante.
   */
  function drawTrajectory(g) {
    const cv = V.traj;
    if (!cv.isConnected) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, hgt = cv.clientHeight;
    if (!w || !hgt) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const tr = run.sess.trajectory(TRAJ_PAST, TRAJ_AHEAD);
    if (!tr) return;
    const n = tr.n, A = tr.ahead.length, tolOf = (p) => Math.max(tr.minTol, tr.tolFrac * p);
    // une consigne par seconde : tv[i] vaut de l'instant t0 + i à t0 + i + 1
    const t0 = tr.t - n, tv = new Float32Array(n + A);
    tv.set(tr.tgt, 0); tv.set(tr.ahead, n);
    const css = getComputedStyle(document.documentElement), col = (k, d) => css.getPropertyValue(k).trim() || d;
    const ink = col('--ink', '#000'), ink2 = col('--ink-2', '#555');
    const good = col('--rd-good', '#0ca30c'), goodBg = col('--rd-good-bg', 'rgba(12,163,12,0.14)');
    const warn = col('--rd-warn', '#e8a000'), bad = col('--rd-bad', '#d03b3b'), low = col('--rd-low', '#2a78d6');

    // échelle verticale : tout le tube et la courbe, arrondis à 10 W
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < tv.length; i++) {
      const tol = tolOf(tv[i]);
      if (i < n || tv[i] >= 15) { lo = Math.min(lo, tv[i] - tol); hi = Math.max(hi, tv[i] + tol); }
    }
    for (let j = 0; j < n; j++) { lo = Math.min(lo, tr.avg[j]); hi = Math.max(hi, tr.avg[j]); }
    if (!(hi > lo)) { lo = 0; hi = 100; }
    const pad = Math.max(8, (hi - lo) * 0.12);
    lo = Math.max(0, Math.floor((lo - pad) / 10) * 10); hi = Math.ceil((hi + pad) / 10) * 10;
    if (hi - lo < 40) hi = lo + 40;
    const left = 30, right = 4, top = 6, bot = hgt - 16, pw = w - left - right;
    const X = (t) => left + (t - (tr.t - TRAJ_PAST)) / (TRAJ_PAST + TRAJ_AHEAD) * pw;
    const Y = (p) => bot - (p - lo) / (hi - lo) * (bot - top);
    const nowX = X(tr.t);

    // tube : marches de la consigne, plus marqué à venir que pour le passé
    const tube = (i0, i1) => {
      if (i1 <= i0) return;
      ctx.beginPath();
      for (let i = i0; i < i1; i++) { const y = Y(tv[i] + tolOf(tv[i])); if (i === i0) ctx.moveTo(X(t0 + i), y); else ctx.lineTo(X(t0 + i), y); ctx.lineTo(X(t0 + i + 1), y); }
      for (let i = i1 - 1; i >= i0; i--) { const y = Y(Math.max(0, tv[i] - tolOf(tv[i]))); ctx.lineTo(X(t0 + i + 1), y); ctx.lineTo(X(t0 + i), y); }
      ctx.closePath();
    };
    ctx.fillStyle = goodBg; tube(0, n); ctx.fill();
    tube(n, n + A); ctx.fill(); ctx.fill();                       // deux couches : le tube à venir ressort davantage
    ctx.strokeStyle = good; ctx.lineWidth = 1.5; tube(0, n + A); ctx.stroke();
    // consigne au centre
    ctx.setLineDash([4, 3]); ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < tv.length; i++) { const y = Y(tv[i]); if (i === 0) ctx.moveTo(X(t0), y); else ctx.lineTo(X(t0 + i), y); ctx.lineTo(X(t0 + i + 1), y); }
    ctx.stroke(); ctx.setLineDash([]);

    // mesures : brutes en fond, moyenne sur 3 s en couleur selon la position dans le tube
    if (n > 0) {
      ctx.strokeStyle = ink2; ctx.globalAlpha = 0.35; ctx.lineWidth = 1; ctx.beginPath();
      for (let j = 0; j < n; j++) { const x = X(t0 + j + 0.5), y = Y(tr.raw[j]); if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke(); ctx.globalAlpha = 1;
      const colorAt = (j) => {
        const d = tr.avg[j] - tr.tgt[j], tol = tolOf(tr.tgt[j]);
        if (tr.tgt[j] < 15 && tr.avg[j] <= 40) return good;       // roue libre respectée
        return Math.abs(d) <= tol ? good : d > 0 ? (d > 2.5 * tol ? bad : warn) : low;
      };
      ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let j = 1; j < n; j++) {
        ctx.strokeStyle = colorAt(j); ctx.beginPath();
        ctx.moveTo(X(t0 + j), Y(tr.avg[j - 1])); ctx.lineTo(X(t0 + j + 1), Y(tr.avg[j])); ctx.stroke();
      }
    }

    // instant courant, puis cible de la seconde suivante
    ctx.strokeStyle = ink; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(nowX, top); ctx.lineTo(nowX, bot); ctx.stroke(); ctx.globalAlpha = 1;
    const nextT = tr.ahead.length ? tr.ahead[0] : g.target, nextX = X(tr.t + 1), nextY = Y(nextT);
    if (n > 0) {
      const cy = Y(tr.avg[n - 1]), c = g.cue === 'ok' || g.cue === 'coast' ? good : g.cue === 'under' || g.cue === 'way_under' ? low : g.cue === 'over' ? warn : bad;
      ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(nowX, cy); ctx.lineTo(nextX, nextY); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = c; ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(nowX, cy, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(nextX, nextY, 3.5, 0, Math.PI * 2); ctx.fill();

    // axes
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = ink2;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    ctx.fillText(hi + '', left - 4, top + 5); ctx.fillText(lo + '', left - 4, bot - 5);
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
    for (const dt of (w < 260 ? [-30, 0] : [-30, -15, 0, 15])) ctx.fillText(dt === 0 ? 'maintenant' : (dt > 0 ? '+' : '−') + Math.abs(dt) + ' s', Math.max(left + 14, Math.min(w - 20, X(tr.t + dt))), hgt - 3);
    // lecture : valeur à produire à la seconde suivante
    ctx.textAlign = nextX > w - 60 ? 'right' : 'left'; ctx.textBaseline = 'bottom'; ctx.fillStyle = ink; ctx.font = '700 12px system-ui, sans-serif';
    ctx.fillText(nextT < 15 ? 'roue libre' : nextT + ' W', nextX + (ctx.textAlign === 'left' ? 6 : -6), Math.max(top + 12, nextY - tolOf(nextT) / (hi - lo) * (bot - top) - 3));
  }

  /* ---------- profil ---------- */
  const ZONE_FILL = ['#8ec5f2', '#7fd48a', '#f1d95a', '#f4a24c', '#ee6a5a', '#c4509a', '#8c52c9'];

  function profileColumns(course) {
    if (run.profPts && run.profPts.course === course) return run.profPts;
    const n = 400, ele = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) ele[i] = PYR.course.eleAt(course, course.length * i / n);
    run.profPts = { course, n, ele };
    return run.profPts;
  }

  /** Profil d'élévation sur la carte (surcouche) ou dans sa carte, selon le réglage. */
  function drawProfile(g) {
    if (!V.mapProf.hidden) drawProfileOn(V.mapProf, g, null);
    if (!V.profCard.hidden) drawProfileOn(V.prof, g, V.profCap);
  }

  function drawProfileOn(cv, g, cap) {
    if (!cv.isConnected) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, hgt = cv.clientHeight;
    if (!w || !hgt) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const sess = run.sess, course = sess.course, L = course.length, s = g.s;
    const near = run.profNear;
    let a = near ? Math.max(0, s - 800) : 0, b = near ? Math.min(L, Math.max(a + 3000, s + 5200)) : L;
    if (b - a < 3000) a = Math.max(0, b - 3000);
    const cols = Math.max(40, Math.min(220, Math.floor(w / 3)));
    const el = new Float32Array(cols + 1);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= cols; i++) { const e = PYR.course.eleAt(course, a + (b - a) * i / cols); el[i] = e; if (e < lo) lo = e; if (e > hi) hi = e; }
    const pad = Math.max(8, (hi - lo) * 0.15);
    lo -= pad; hi += pad;
    const top = 14, bot = hgt - 14, X = (m) => (m - a) / (b - a) * w, Y = (e) => bot - (e - lo) / (hi - lo) * (bot - top);
    const ftp = sess.athlete.ftp;
    const segs = sess.segs;
    // remplissage : couleur de la zone de puissance cible pour ce qui reste à rouler, gris pour le passé
    let si = 0;
    for (let i = 0; i < cols; i++) {
      const m = a + (b - a) * (i + 0.5) / cols;
      let fill;
      if (m < s) fill = 'rgba(128,128,128,0.28)';
      else {
        while (si < segs.length - 1 && m >= segs[si].b) si++;
        const sg = segs[Math.min(si, segs.length - 1)];
        fill = sg ? ZONE_FILL[PYR.physio.zoneIndex(sg.P, ftp)] + 'cc' : 'rgba(128,128,128,0.2)';
      }
      ctx.fillStyle = fill;
      const x0 = X(a + (b - a) * i / cols), x1 = X(a + (b - a) * (i + 1) / cols) + 0.6;
      const yy = Y((el[i] + el[i + 1]) / 2);
      ctx.fillRect(x0, yy, x1 - x0, bot - yy);
    }
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--ink').trim() || '#000', ink2 = css.getPropertyValue('--ink-2').trim() || '#555';
    ctx.strokeStyle = ink2; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i <= cols; i++) { const x = X(a + (b - a) * i / cols), y = Y(el[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke();
    // limites de tronçons (mode proche) et étiquettes de puissance
    ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'top';
    if (near) {
      ctx.fillStyle = ink; ctx.strokeStyle = 'rgba(128,128,128,0.5)'; ctx.lineWidth = 1;
      let lastX = -99;
      for (const sg of segs) {
        if (sg.a < s - 50 || sg.a > b) continue;
        const x = X(Math.max(sg.a, a));
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot); ctx.stroke();
        if (x - lastX > 34) { ctx.fillText(Math.round(sg.P / 5) * 5 + '', Math.min(w - 26, x + 3), 1); lastX = x; }
      }
    }
    // défi : lignes des sprints et des sommets, puis les coureurs virtuels
    if (run.mix) {
      ctx.lineWidth = 2; ctx.font = '700 10px system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
      for (const cp of run.mix.cps) {
        if (cp.type === 'finish' || cp.s < a || cp.s > b) continue;
        const x = X(cp.s), col = cp.type === 'sprint' ? '#1d9a4a' : '#d62828';
        ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(x, top + 8); ctx.lineTo(x, bot); ctx.stroke();
        ctx.fillStyle = col; ctx.fillText(cp.type === 'sprint' ? 'S' : cp.cat === 'hc' ? 'HC' : cp.cat, x, top - 2);
      }
      ctx.textAlign = 'start';
      for (const o of PYR.rideMixed.positions(run.mix, sess.t)) {
        if (o.s < a || o.s > b) continue;
        ctx.fillStyle = o.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(X(o.s), Y(PYR.course.eleAt(course, o.s)), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
    // position
    const px = X(s);
    ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, top - 4); ctx.lineTo(px, bot); ctx.stroke();
    ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(px, Y(PYR.course.eleAt(course, s)), 5, 0, Math.PI * 2); ctx.fill();
    if (cap) setTxt(cap, near ? `km ${km(a)} → ${km(b)} · touche pour voir tout le parcours` : 'Parcours entier · touche pour zoomer autour de toi');
  }

  /* ---------- carte ---------- */
  /** La carte suit toujours la position du coureur : aucune interaction (un doigt posé sur la carte ne bloque pas le défilement de la page). */
  function lockMap() {
    const map = PYR.map.map;
    for (const k of ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard']) if (map[k]) map[k].disable();
  }

  /** Mesures, bloc consigne, fin et suivant du tronçon, réserves (et « Dans le plan » en haut) se posent sur la carte quand elle est affichée, sinon ils restent dans la page. */
  function placeHud() {
    (run.mapOn ? V.mapBox : V.head).appendChild(V.hud);
    if (run.mapOn) {
      V.mapBox.append(V.power, V.res);
      V.ovChips.append(V.next);
      V.status.insertBefore(V.gap, V.status.firstChild);        // « Dans le plan » en haut, à côté des capteurs
    } else {
      V.liveA.insertBefore(V.gap, V.liveA.firstChild);
      V.liveA.insertBefore(V.power, V.info);
      V.info.appendChild(V.next);
      V.liveB.insertBefore(V.res, V.liveB.firstChild);
    }
    V.mapBox.classList.toggle('hud-on', run.mapOn);
    V.info.hidden = V.nut.hidden = run.mapOn;                    // détail du tronçon et alimentation : sur la carte (pastilles, poches)
  }

  /** La carte de la page vient s'installer dans l'écran de la sortie. */
  function attachMap() {
    const M = PYR.map, p = store.profile;
    if (run.mapOn || !p || !M.map) return;
    run.mapOn = true;
    run.mapHome = { parent: M.map.getContainer().parentNode, view: [M.map.getCenter(), M.map.getZoom()] };
    V.mapBox.hidden = false;
    V.mapBox.insertBefore(M.map.getContainer(), V.mapBox.firstChild);
    M.setMode('plain');
    placeHud();
    M.map.invalidateSize();
    run.turns = PYR.nav.turns(p);
    if (run.mix && PYR.classif.active(run.mix.cps)) M.setCheckpoints(run.mix.cps, []);   // sprints et côtes classées du défi
    run.turnLayer = L.layerGroup().addTo(M.map);
    for (const t of run.turns) {
      const ll = M.latLngAt(t.s);
      if (ll) run.turnLayer.addLayer(L.circleMarker(ll, { radius: 5, color: '#fff', weight: 2, fillColor: '#222', fillOpacity: 1, interactive: false, renderer: M.renderer }));
    }
    // manche à air à côté du cycliste : dans la carte (elle tourne avec elle), contre-tournée par --rot pour rester à droite du point (voir ride.css)
    const sockSvg = '<svg class="wsock-sv" viewBox="-24 -24 48 48" aria-hidden="true"><path d="M-6 0 L6 0 L4.6 -7.5 L-4.6 -7.5 Z" fill="#fff"/><path d="M-4.6 -7.5 L4.6 -7.5 L3.3 -14.5 L-3.3 -14.5 Z" fill="#eb6834"/>'
      + '<path d="M-3.3 -14.5 L3.3 -14.5 L2 -21 L-2 -21 Z" fill="#fff"/><path d="M-6 0 L6 0 L4.6 -7.5 L3.3 -14.5 L2 -21 L-2 -21 L-3.3 -14.5 L-4.6 -7.5 Z" fill="none" stroke="#333" stroke-width="1" stroke-linejoin="round"/>'
      + '<circle r="3.4" fill="#333" stroke="#fff" stroke-width="1.2"/></svg>';
    run.sockEl = h('div', { class: 'wsock', hidden: true }); run.sockEl.innerHTML = sockSvg + '<div class="wsock-t"><b></b><span></span></div>';
    run.sock = L.marker([0, 0], { icon: L.divIcon({ className: '', html: run.sockEl, iconSize: [0, 0], iconAnchor: [0, 0] }), interactive: false, keyboard: false, zIndexOffset: 950 });
    run.turnLayer.addLayer(run.sock);
    run.sockTxt = '';
    run.turnNow = L.circleMarker([0, 0], { radius: 10, color: '#fff', weight: 3, fillColor: '#eb6834', fillOpacity: 1, interactive: false, renderer: M.renderer });
    run.mapZoom = 0; run.mapZoomAt = 0; run.mapTurnS = null; run.mapAngle = null; run.mapKey = null;
    run.mapS = null; run.mapT = null; run.mapOff = null; run.mapDimAt = 0; run.mapMoveAt = 0; run.mapEma = 0; run.progLine = null;
    D.clear(V.mapAttr);
    lockMap();
    mapTick(run.sess.guidance());
  }

  /** La carte retourne à sa place dans la page (autre onglet, fin de la sortie, carte masquée). */
  function detachMap() {
    if (!run.mapOn) return;
    const M = PYR.map, home = run.mapHome;
    run.mapOn = false;
    const map = M.map;
    for (const k of ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard']) if (map[k]) map[k].enable();
    V.mapBox.classList.remove('rot');
    V.mapNorth.hidden = true;
    const st = map.getContainer().style;                         // la carte reprend sa place et son orientation d'origine
    st.right = st.bottom = st.width = st.height = st.left = st.top = st.transform = '';
    run.mapKey = null;
    stopMapLoop();
    M.layers.progress.clearLayers(); run.progLine = null;
    M.setGameMarkers(null);
    if (run.mix) { M.setCheckpoints(null); store.emit('checkpoints'); }      // l'onglet Parcours redessine ses propres points de passage
    if (run.turnLayer) { run.turnLayer.remove(); run.turnLayer = null; }
    if (run.turnNow) { run.turnNow.remove(); run.turnNow = null; }
    run.sock = null; run.sockEl = null;
    if (home && home.parent) home.parent.insertBefore(map.getContainer(), home.parent.firstChild);
    V.mapBox.hidden = true;
    togglePockets(false);
    placeHud();
    M.setMode('grade');
    map.invalidateSize();
    if (home && home.view) map.setView(home.view[0], home.view[1], { animate: false });   // la vue de l'onglet Parcours est rendue telle qu'elle était
  }

  /** Une mise à jour de la carte (appelée par render, 4 fois par seconde au plus). */
  function mapTick(g) {
    const c = cfg(), M = PYR.map;
    const visible = document.body.dataset.tab === 'ride';
    const want = visible && !!store.profile;
    if (want && !run.mapOn) attachMap();
    else if (!want && run.mapOn) detachMap();
    const prof = want && c.mapProfile;
    V.mapProf.hidden = !prof;
    V.profCard.hidden = want;                                  // la carte occupe l'écran : le profil s'y superpose (réglage « Profil d'élévation sur la carte »)
    V.mapBox.classList.toggle('has-prof', prof);
    if (!run.mapOn) return;
    const map = M.map, now = Date.now();
    updateProgress(g.s);
    // la position n'est connue qu'une fois par seconde : la boucle d'animation (mapFrame) l'extrapole entre deux mises à jour
    run.mapT = { s: g.s, v: g.v, t: g.t, at: performance.now() };
    if (run.mapS === null) run.mapS = g.s;
    M.setGameMarkers(run.mapS, mixOthers(g.t));
    updateSock(run.mapS, g.t);
    // prochain virage : marqueur, texte, et niveau de zoom
    const t = PYR.nav.nextTurn(run.turns, g.s), dist = t ? t.s - g.s : Infinity;
    if (t && run.mapTurnS !== t.s) {
      run.mapTurnS = t.s;
      run.turnNow.setLatLng(M.latLngAt(t.s));
      if (!run.turnLayer.hasLayer(run.turnNow)) run.turnLayer.addLayer(run.turnNow);
    } else if (!t && run.mapTurnS !== null) { run.mapTurnS = null; run.turnLayer.removeLayer(run.turnNow); }
    V.mapTurn.hidden = !(t && dist < 800);
    if (t && dist < 800) {
      const d = PYR.nav.describe(t);
      setTxt(V.mTurnArrow, d.arrow);
      setTxt(V.mTurnTxt, `${dist < 20 ? 'maintenant' : (dist < 100 ? Math.round(dist / 5) * 5 : Math.round(dist / 10) * 10) + ' m'} · ${d.text}`);
    }
    // zoom : plus près à l'approche d'un virage (au plus une fois par 4 s, sauf pour se rapprocher du virage) ; le zoom est animé par Leaflet
    const z = Math.min(map.getMaxZoom(), PYR.nav.zoomFor(dist, g.v));
    if (z !== run.mapZoom && (z > run.mapZoom || now - run.mapZoomAt > 4000)) {
      const first = run.mapZoom === 0;                          // le premier niveau s'applique d'un coup, les suivants sont animés
      run.mapZoom = z; run.mapZoomAt = now;
      map.setZoomAround(M.latLngAt(run.mapS), z, { animate: !first });
    }
    startMapLoop();
  }

  /**
   * Vent à la distance s et à l'instant t de la sortie : { ws (m/s), from (° d'où il vient) }, ou null sans vent.
   * Météo du parcours quand elle est utilisée, sinon les portions de vent saisies à la main.
   */
  function windAt(s, t) {
    const C = run.sess.course;
    const i = Math.max(0, Math.min(C.n - 1, Math.floor(s / C.step)));
    let ws, from;
    if (C.weather) { const o = PYR.weather.at(C.weather, s, C.weather.start + t, run.wx || (run.wx = {})); ws = o.ws; from = o.wd; }
    else { ws = C.wMean[i]; from = C.windDir[i]; }
    if (!(ws > 0.2) || !Number.isFinite(from)) return null;
    return { ws, from };
  }

  /** Manche à air : posée à côté du cycliste, pointée vers où le vent va (dans le repère de l'écran) ; texte : vitesse du vent (km/h). */
  function updateSock(s, t) {
    const mk = run.sock, el = run.sockEl;
    if (!mk || !el) return;
    const w = windAt(s, t);
    if (el.hidden !== !w) el.hidden = !w;
    if (!w) return;
    mk.setLatLng(PYR.map.latLngAt(s));
    const toward = (w.from + 180) % 360, screen = toward - (run.mapAngle || 0);
    el.style.setProperty('--wsa', screen.toFixed(1) + 'deg');
    const kmh = Math.round(w.ws * 3.6), key = kmh + '|' + Math.round(w.from);
    if (key === run.sockTxt) return;
    run.sockTxt = key;
    el.querySelector('b').textContent = String(kmh);
    el.querySelector('span').textContent = 'km/h';
    el.title = `Vent de ${PYR.weather.compass(w.from)} : ${kmh} km/h`;
  }

  /** Coureurs virtuels à l'instant t (fractionnaire) de la sortie, pour la carte ; recalculés au plus tous les 100 ms en gros peloton. */
  function mixOthers(t) {
    const m = run.mix;
    if (!m) return [];
    const now = performance.now();
    if (m.n > 12 && run.mapOthers && now - run.mapOthersAt < 100) return run.mapOthers;
    run.mapOthersAt = now;
    return (run.mapOthers = PYR.rideMixed.positions(m, t));
  }

  /** Tracé déjà roulé : la polyligne s'allonge, au lieu d'être reconstruite. */
  function updateProgress(s) {
    const p = store.profile, M = PYR.map;
    if (!run.progLine) {
      run.progLine = L.polyline([], { color: '#eb6834', weight: 6, opacity: 1, renderer: M.renderer, interactive: false }).addTo(M.layers.progress);
      run.progIdx = -1;
    }
    const i1 = Math.min(p.n - 1, Math.floor(s / p.step));
    for (let i = run.progIdx + 1; i <= i1; i++) run.progLine.addLatLng([p.lat[i], p.lng[i]]);
    if (i1 > run.progIdx) run.progIdx = i1;
  }

  /* Animation de la carte : requestAnimationFrame à cadence adaptative. Entre deux positions (1 par seconde), le cycliste est extrapolé à sa
   * vitesse ; l'angle suit le cap avec une constante de temps (indépendante de la cadence) ; la caméra se déplace au sous-pixel. Le pas de
   * rafraîchissement dépend de la vitesse visible (pixels par seconde à ce zoom, degrés par seconde de la rotation) et du temps que
   * prend une image sur cet appareil : image à chaque rafraîchissement d'écran quand ça bouge, 8 images par seconde à l'arrêt. */
  const FRAME_MIN = 16, FRAME_MAX = 125;
  function startMapLoop() {
    if (run.mapRaf || !run.mapOn) return;
    run.mapLast = performance.now(); run.mapInterval = FRAME_MIN;
    run.mapRaf = requestAnimationFrame(mapFrame);
  }
  function stopMapLoop() { if (run.mapRaf) cancelAnimationFrame(run.mapRaf); run.mapRaf = 0; }

  function mapFrame(now) {
    run.mapRaf = 0;
    if (!run.mapOn || !run.mapT) return;
    run.mapRaf = requestAnimationFrame(mapFrame);
    const dtMs = now - run.mapLast;
    if (dtMs < run.mapInterval - 4) return;                       // cadence adaptative : on saute cette image
    run.mapLast = now;
    const t0 = performance.now(), dt = Math.min(0.25, dtMs / 1000);
    const M = PYR.map, map = M.map, p = store.profile, T = run.mapT;
    if (map._animatingZoom) return;                               // pendant le zoom animé, Leaflet déplace lui-même la carte
    // position : extrapolée depuis la dernière mesure, puis lissée (les corrections d'une mesure à l'autre s'absorbent)
    const pred = Math.min(p.length, T.s + T.v * Math.min(1.5, (t0 - T.at) / 1000));
    const prevS = run.mapS;
    run.mapS += (pred - run.mapS) * (1 - Math.exp(-dt / 0.25));
    // cap : celui de la route un peu en avance (la carte tourne avant le virage), avec une constante de temps de 0,3 s
    const ahead = PYR.nav.bearingAt(p, Math.min(p.length, run.mapS + 25));
    const prevA = run.mapAngle === null ? ahead : run.mapAngle;
    run.mapAngle = prevA + (((ahead - prevA + 540) % 360) - 180) * (1 - Math.exp(-dt / 0.3));
    layoutMap(run.mapAngle);
    // caméra : le cycliste est placé en arrière du centre (dans le sens de la marche), pour voir plus de route devant lui
    const hd = run.mapAngle * Math.PI / 180, k = 0.24 * Math.min(run.mapW || 300, run.mapH || 300);
    const want = { x: -Math.sin(hd) * k, y: Math.cos(hd) * k }, off = run.mapOff || (run.mapOff = { x: want.x, y: want.y });
    const e = 1 - Math.exp(-dt / 0.4);
    off.x += (want.x - off.x) * e; off.y += (want.y - off.y) * e;
    const ll = M.latLngAt(run.mapS);
    const moved = panCamera(map, ll, off);
    M.setGameMarkers(run.mapS, mixOthers(T.t + Math.min(1.2, (t0 - T.at) / 1000)));
    updateSock(run.mapS, T.t + Math.min(1.2, (t0 - T.at) / 1000));
    // la carte « settle » (tuiles, tracé) toutes les 0,5 s de déplacement continu, et à l'arrêt
    if (moved) { if (!run.mapMoveAt) run.mapMoveAt = now; else if (now - run.mapMoveAt > 500) { run.mapMoveAt = 0; map.fire('moveend'); } }
    else if (run.mapMoveAt) { run.mapMoveAt = 0; map.fire('moveend'); }
    // prochain pas : vitesse visible en pixels par seconde (zoom, latitude) et en degrés par seconde
    const mpp = 156543.03 * Math.cos(ll[0] * Math.PI / 180) / Math.pow(2, map.getZoom());
    const pxS = Math.abs(run.mapS - prevS) / Math.max(dt, 1e-3) / mpp, degS = Math.abs(run.mapAngle - prevA) / Math.max(dt, 1e-3);
    const visual = Math.max(pxS, 4 * degS), work = performance.now() - t0;
    run.mapEma = (run.mapEma || work) * 0.9 + work * 0.1;
    run.mapInterval = Math.min(FRAME_MAX, Math.max(FRAME_MIN, 1000 / Math.max(8, visual), 2.2 * run.mapEma));
  }

  /** Déplace la carte pour que le point soit à `off` du centre, au sous-pixel. Renvoie true si la carte a bougé. */
  function panCamera(map, ll, off) {
    const size = map.getSize();
    if (typeof map._rawPanBy !== 'function' || typeof map._getMapPanePos !== 'function') {   // volet interne indisponible : pas entier
      const c = map.latLngToContainerPoint(ll), dx = Math.round(c.x - size.x / 2 - off.x), dy = Math.round(c.y - size.y / 2 - off.y);
      if (!dx && !dy) return false;
      map.panBy([dx, dy], { animate: false });
      return true;
    }
    const p = map.project(ll), o = map.getPixelOrigin(), pane = map._getMapPanePos();
    const dx = p.x - o.x + pane.x - (size.x / 2 + off.x), dy = p.y - o.y + pane.y - (size.y / 2 + off.y);
    if (Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02) return false;
    if (Math.abs(dx) > size.x || Math.abs(dy) > size.y) { map.panBy([dx, dy], { animate: false }); return true; }   // très loin : déplacement complet
    map._rawPanBy(L.point(dx, dy));
    map.fire('move');
    return true;
  }

  /**
   * Orientation de la carte : angle (° , cap vers le haut de l'écran) ou null pour nord en haut. L'élément carte, tourné, est agrandi
   * jusqu'à sa diagonale et centré : aucun coin vide n'apparaît. Les interactions Leaflet ne sont pas corrigées de la rotation, d'où
   * la carte droite en mode libre.
   */
  function layoutMap(angle) {
    const el = PYR.map.map.getContainer(), box = V.mapBox, rot = angle !== null;
    const nowMs = performance.now();
    if (!run.mapDimAt || nowMs - run.mapDimAt > 500) { run.mapDimAt = nowMs; run.mapW = box.clientWidth; run.mapH = box.clientHeight; }   // mesures : pas à chaque image
    const w = run.mapW, h2 = run.mapH, key = rot ? w + 'x' + h2 : '';
    if (box.classList.contains('rot') !== rot) box.classList.toggle('rot', rot);
    if (V.mapNorth.hidden === rot) V.mapNorth.hidden = !rot;
    if (rot) {
      V.mapNorth.style.transform = `rotate(${-angle}deg)`;
      if (!V.mapAttr.firstChild) V.mapAttr.innerHTML = PYR.map.map.attributionControl.getContainer().innerHTML;
    }
    if (run.mapKey !== key) {
      run.mapKey = key;
      const s = el.style;
      if (rot) {
        const D = Math.ceil(Math.hypot(w, h2));
        s.right = s.bottom = 'auto'; s.width = s.height = D + 'px'; s.left = (w - D) / 2 + 'px'; s.top = (h2 - D) / 2 + 'px';
      } else { s.right = s.bottom = s.width = s.height = s.left = s.top = s.transform = ''; }
      PYR.map.map.invalidateSize({ animate: false });
    }
    if (rot) el.style.transform = `rotate(${-angle}deg)`;
    el.style.setProperty('--rot', rot ? `${angle}deg` : '0deg');    // les étiquettes et pastilles des marqueurs se contre-tournent (voir ride.css)
  }

  /* ---------- menu et feuilles ---------- */
  function openMenu() {
    const sess = run.sess;
    if (!sess) return;
    const c = cfg();
    const log = sess.planLog.map((p) => h('li', null, `${hmm(p.t)} · km ${km(p.s)} · ${p.reason} → arrivée ${hmm(p.tFinish)}`));
    const sp = sensorPanel({   // les deux réglages s'appliquent aussitôt
      alpha: (a) => { sess.cfg.altAlpha = a; render(sess.guidance()); },
      avg: (n) => { sess.cfg.powerAvg = n; render(sess.guidance()); },
    });
    const act = (label, cls, fn) => h('button', { class: 'btn ' + cls, type: 'button', onclick: () => { dlg.close(); fn(); } }, label);
    const dlg = D.modal({
      title: 'Sortie', wide: true,
      body: [
        h('div', { class: 'rd-btns' },
          act(run.paused ? 'Reprendre' : 'Pause', '', () => togglePause()),
          act('Recalculer le plan', '', () => replan('à la demande')),
          act('Terminer', 'danger', () => confirmEnd())),
        h('p', { class: 'rd-note' }, run.paused ? 'En pause : alertes et recalculs automatiques suspendus.' : 'Pause : suspend les alertes et les recalculs automatiques.'),
        rowEl('Mises à jour météo', selectEl([[5, 'toutes les 5 min'], [15, 'toutes les 15 min'], [30, 'toutes les 30 min'], [60, 'toutes les 60 min']], c.weatherMin, (v) => { store.set('ride.cfg.weatherMin', Number(v)); if (run.wxNextT !== undefined) run.wxNextT = sess.t + Number(v) * 60; })),
        h('div', { class: 'rd-checks' },
          checkEl('Recalcul automatique', c.auto && !run.paused, (v) => { store.set('ride.cfg.auto', v); sess.cfg.auto = v; }),
          checkEl('Bips', c.sound, (v) => { store.set('ride.cfg.sound', v); if (v) Sx.alerts.unlock(); }),
          checkEl('Vibrations', c.vibrate, (v) => store.set('ride.cfg.vibrate', v)),
          checkEl('Voix', c.voice, (v) => { store.set('ride.cfg.voice', v); if (v) Sx.alerts.unlock(); })),
        h('div', { class: 'rd-checks' },
          checkEl('Profil d\'élévation sur la carte', c.mapProfile, (v) => { store.set('ride.cfg.mapProfile', v); render(sess.guidance()); }),
          ),
        rowEl('Sensibilité', selectEl(Object.entries(SENS_LABEL), c.sens, (v) => { store.set('ride.cfg.sens', v); sess.cfg.sens = v; })),
        rowEl('Lissage de l\'écart', selectEl([[5, '5 s'], [8, '8 s'], [12, '12 s'], [20, '20 s']], c.gapTau, (v) => { store.set('ride.cfg.gapTau', Number(v)); sess.cfg.gapTau = Number(v); })),
        rowEl('Forme du plan (% de mes capacités)', h('span', { class: 'rd-inline' }, (() => {
          const m = marginEl((v) => {
            if (run.base) run.base.margin = 1 - v / 100;                    // les recalculs de la sortie repartent de cette base
            dlg.close();
            replan(`forme à ${v} %`);
          });
          m.disabled = store.state.perf.formRef === 'form';                 // W′bal suit le profil ajusté au départ : la forme est figée pendant la sortie
          return m;
        })(), ' %')),
        h('p', { class: 'rd-note' }, store.state.perf.formRef === 'form'
          ? 'W′bal suit le profil ajusté à la forme du départ : pour la changer en cours de sortie, choisis le profil de l\'athlète à 100 % dans la préparation.'
          : 'Changer la forme recalcule aussitôt le plan du reste du parcours ; W′bal reste lu sur le profil de l\'athlète à 100 %.'),
        h('h4', null, 'Capteurs'),
        sp.gps, ...sp.pwr, sp.avg, sp.alt, ...sp.hr,
        h('h4', null, 'Plans successifs'), h('ol', { class: 'rd-events' }, ...log),
        run.demo ? h('div', null, h('h4', null, run.demo.replay ? 'Mode démo : sortie rejouée' : 'Mode démo'),
          h('div', { class: 'rd-btns' },
            run.demo.replay ? null : h('button', { class: 'btn', type: 'button', onclick: () => { run.demo.mood(-0.25, 120); D.toast('Coup de mou : −25 % pendant 2 min.'); } }, 'Coup de mou'),
            run.demo.replay ? null : h('button', { class: 'btn', type: 'button', onclick: () => { run.demo.mood(0.3, 60); D.toast('Attaque : +30 % pendant 1 min.'); } }, 'Attaque'),
            h('button', { class: 'btn', type: 'button', onclick: () => { Sx.alerts.unlock(); notify('eat', 'Test des alertes', true); } }, 'Tester les alertes')),
          rowEl('Vitesse du temps', selectEl(SPEEDS.map((x) => [x, '×' + x]), run.demoSpeed, (v) => {
            const now = Date.now(), el = (now - run.demoWall) / 1000 * run.demoSpeed;
            run.demoSpeed = Number(v); run.demoWall = now - el / run.demoSpeed * 1000;   // le temps écoulé ne saute pas
          }))) : null,
      ],
      actions: [{ label: 'Fermer' }],
    });
    return dlg;
  }

  /* ---------- poches sur la carte ---------- */
  function togglePockets(open) {
    const on = open === undefined ? V.pockets.hidden : open;
    if (on && !run.mapOn) return;
    V.pockets.hidden = !on;
    V.mapBox.classList.toggle('pk-on', on);
    run.pkSig = '';
    clearTimeout(run.pkTimer);
    document.removeEventListener('pointerdown', pocketsOutside, true);
    if (on) { armPockets(); document.addEventListener('pointerdown', pocketsOutside, true); }
    if (on && run.sess) renderPockets(run.sess.guidance());
  }

  const POCKETS_MS = 15000;                    // les poches se referment seules après ce délai sans prise
  function armPockets() { clearTimeout(run.pkTimer); run.pkTimer = setTimeout(() => togglePockets(false), POCKETS_MS); }
  /** Un toucher hors de la vignette la ferme (le bloc des réserves, lui, l'ouvre et la ferme par son propre clic). */
  function pocketsOutside(e) {
    if (V.pockets.contains(e.target) || V.res.contains(e.target)) return;
    togglePockets(false);
  }

  /** Liste des aliments et boissons des poches : un clic mange ou boit une gorgée. Reconstruite seulement quand son contenu change. */
  function renderPockets(g) {
    if (V.pockets.hidden || !run.sess) return;
    const st = g.fuelStatus, r = run.rem;
    const foods = Fu.FOOD_IDS.filter((k) => st.stock[k] > 0);
    const sig = JSON.stringify([foods.map((k) => st.stock[k]), st.containers.map((c) => Math.round(c.vol * 1000)), r && r.eat ? [r.eat.kind, r.eat.inS <= 0] : 0, r && r.drink ? r.drink.inS <= 0 : 0]);
    if (run.pkSig === sig) return;
    run.pkSig = sig;
    const item = (cls, label, sub, fn, disabled) => h('button', { class: 'rd-pk-item ' + cls, type: 'button', disabled: !!disabled, onclick: fn }, h('span', { class: 'nm' }, label), h('span', { class: 'q' }, sub));
    const eatNow = r && r.eat && !r.eat.deferred && r.eat.inS <= 0 ? r.eat.kind : null;
    const list = [h('div', { class: 'rd-pk-sec first' }, 'Manger')];
    if (!foods.length) list.push(h('div', { class: 'rd-pk-none' }, 'Plus rien à manger dans les poches.'));
    for (const k of foods) list.push(item(eatNow === k ? 'rec' : '', FOOD_LABEL[k], '× ' + st.stock[k], () => { armPockets(); takeFood(k); }));
    list.push(h('div', { class: 'rd-pk-sec' }, 'Boire une gorgée'));
    const drinkNow = r && r.drink && !r.drink.deferred && r.drink.inS <= 0;
    if (!st.containers.length) list.push(h('div', { class: 'rd-pk-none' }, 'Aucun bidon emporté.'));
    st.containers.forEach((c) => list.push(item(drinkNow && c.vol >= 0.001 ? 'rec' : '', `${SLOT_LABEL[Fu.SLOTS.indexOf(c.type) >= 0 ? c.i : 0] || c.type} · ${(Fu.MIXES[c.mix] || {}).label || c.mix}`, `${U.fmt(c.vol, 2)} L`,
      () => { armPockets(); takeDrink(c.i); }, c.vol < 0.001)));
    D.clear(V.pockets);
    V.pockets.append(...list);
  }

  function openFood() {
    const sess = run.sess;
    if (!sess) return;
    const f = sess.fuel, st = Fu.status(f);
    const body = [h('h4', null, 'Manger')];
    const foods = h('div', { class: 'rd-btns wrap' });
    for (const k of Fu.FOOD_IDS) foods.append(h('button', { class: 'btn', type: 'button', onclick: () => { takeFood(k); dlg.close(); } }, `${FOOD_LABEL[k]} (${st.stock[k]})`));
    body.push(foods, h('h4', null, 'Boire une gorgée'));
    const cs = h('div', { class: 'rd-btns wrap' });
    st.containers.forEach((c) => cs.append(h('button', { class: 'btn', type: 'button', disabled: c.vol < 0.001, onclick: () => { takeDrink(c.i); dlg.close(); } },
      `${SLOT_LABEL[Fu.SLOTS.indexOf(c.type) >= 0 ? c.i : 0] || c.type} · ${(Fu.MIXES[c.mix] || {}).label || c.mix} · ${U.fmt(c.vol, 2)} L`)));
    body.push(cs, h('h4', null, 'Ravitaillement'), h('div', { class: 'rd-btns wrap' },
      h('button', { class: 'btn', type: 'button', onclick: () => { sess.refill(); D.toast('Bidons remplis.'); dlg.close(); } }, 'Remplir les bidons'),
      h('button', { class: 'btn', type: 'button', onclick: () => { sess.addFood('gel', 1); D.toast('+1 gel dans les poches'); dlg.close(); } }, '+1 gel reçu'),
      h('button', { class: 'btn', type: 'button', onclick: () => { sess.addFood('bar', 1); D.toast('+1 barre dans les poches'); dlg.close(); } }, '+1 barre reçue')));
    const dlg = D.modal({ title: 'Alimentation', wide: true, body, actions: [{ label: 'Fermer' }] });
  }

  /* ======================================================================
   * Fin, sauvegarde, reprise
   * ====================================================================== */
  function saveSession() {
    const sess = run.sess;
    if (!sess) return;
    run.lastSave = sess.t;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        session: sess.pack(), coach: { lastEat: run.coach.lastEat, lastDrink: run.coach.lastDrink }, demo: !!run.demo, savedAt: Date.now(),
        mix: run.mix ? PYR.rideMixed.pack(run.mix) : null,
      }));
    } catch (e) { console.warn('Sauvegarde de la sortie impossible', e); }
  }
  function readSaved() { try { const r = localStorage.getItem(SESSION_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function clearSaved() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* rien */ } }

  function renderResume() {
    const d = readSaved();
    V.resume.hidden = !(d && d.session && !d.demo && run.mode === 'prep');
    if (!V.resume.hidden) setTxt(V.resumeTxt, `Interrompue à ${hmm(d.session.t)} (${km(d.session.S[0] !== undefined ? d.session.S.reduce((a, b) => a + b, 0) / 10 : 0)} km), enregistrée à ${new Date(d.savedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`);
  }

  function resumeSession() {
    const d = readSaved();
    if (!d || !d.session) return;
    let base;
    try { base = sessionBase(d.session.startMs); } catch (e) { D.toast(e.message, 'error'); return; }
    const st = store.state, rider = st.rider;
    const sess = R.createSession({
      course: base.course, setup: base.setup, athlete: sessionAthlete(base), mass: Number(rider.weight) || 72, kit: d.session.kit, gut: d.session.gut || 0,
      tempC: Number(st.env.temperature), startMs: d.session.startMs, cfg: Object.assign({}, st.ride.cfg), physio: physioCard(base),
    });
    if (!sess.restore(d.session)) { D.toast('Sortie illisible.', 'error'); return; }
    if (!sess.plan) { D.toast('Plan introuvable dans la sauvegarde.', 'error'); return; }
    run.base = base; run.sess = sess; run.demo = null;
    run.plan = sess.plan0 || sess.plan;
    run.nut = Nu.planNutrition({
      P: run.plan.P, dur: run.plan.tFinish - run.plan.t0, mass: sess.mass, cp: base.athlete.cp, ftp: base.athlete.ftp, tempC: sess.tempC, gut: d.session.gut || 0, kit: d.session.kit,
    });
    run.coach = Nu.createCoach(run.nut);
    run.coach.restore(d.coach);
    run.mix = d.mix ? PYR.rideMixed.unpack(d.mix, mixOptions(base, d.mix.n)) : null;   // les coureurs virtuels sont rattrapés en quelques tours d'horloge
    run.power.length = 0; run.fix.length = 0; run.cads.length = 0;
    if (!run.gpsOn) toggleGps();
    // les capteurs connus se reconnectent tout seuls, sans liste de choix (si le navigateur le permet)
    if (Sx.power.canReconnect && Sx.power.state === 'off') reconnectKnown('power');
    if (Sx.hr.canReconnect && Sx.hr.state === 'off') reconnectKnown('hr');
    enterLive();
  }

  /** Fin de la sortie : écran de bilan et export. */
  function finish(manual) {
    const sess = run.sess;
    if (!sess || run.mode !== 'live') return;
    clearInterval(run.timer); run.timer = null;
    detachMap();
    Sx.wake.release();
    if (run.gpsOn) { Sx.gps.stop(); run.gpsOn = false; run.lastFix = null; }
    clearSaved();
    mixTick(sess);                                               // dernier passage (arrivée) du cycliste
    if (!manual && !run.mix) notify('info', 'Arrivée. Bien joué !', true);   // avec le défi, l'annonce de l'arrivée donne la place
    run.mode = 'done';
    buildDone();
    setMode('done');
    if (run.mix) finishMix();
  }

  /** Bilan du défi : les coureurs virtuels finissent leur course (par petites tranches de calcul), puis les classements s'affichent. */
  function finishMix() {
    const m = run.mix, sess = run.sess;
    const step = () => {
      if (run.mix !== m || run.mode !== 'done') return;
      const done = PYR.rideMixed.finishAll(m, 25);
      PYR.rideMixed.update(m, sess, 0);
      if (!done) { setTimeout(step, 0); return; }
      renderDoneMix();
    };
    step();
  }

  function renderDoneMix() {
    const m = run.mix, sess = run.sess;
    if (!m || !V.doneMix) return;
    const Mx = PYR.rideMixed, CV = PYR.classifView, nm = Mx.names(m), name = (id) => (nm.get(id) ? nm.get(id).name : id);
    const sd = Mx.standings(m, sess), me = sd.general.find((x) => x.id === 'me');
    D.clear(V.doneMix);
    const tb = h('tbody');
    for (const x of sd.general) {
      tb.appendChild(h('tr', { class: x.id === 'me' ? 'me' : '' },
        h('td', null, String(x.rank)), h('td', null, h('span', { class: 'dot', style: { background: (nm.get(x.id) && nm.get(x.id).color) || ME_COLOR } }), name(x.id)),
        h('td', null, x.time !== null ? hmm(x.time) : '–')));
    }
    V.doneMix.append(
      h('h3', null, `Défi : tu termines ${CV.ordinal(me ? me.rank : 0)} sur ${sd.general.length}`),
      CV.scrollable(h('div', { class: 'table-wrap' }, h('table', { class: 'simple num leaderboard' }, h('thead', null, h('tr', null, ...['#', 'Cycliste', 'Temps'].map((x) => h('th', null, x)))), tb)), sd.general.length),
      PYR.classif.active(m.cps) ? CV.block(m.cps, sd, { name, meId: 'me', full: true }) : null);
  }

  function buildDone() {
    const sess = run.sess, T = sess.track(), n = T.n;
    D.clear(V.done);
    let work = 0, np = 0;
    for (let k = 0; k < n; k++) work += T.P[k];
    if (n >= 30) {
      let acc = 0, s4 = 0, cnt = 0;
      for (let k = 0; k < n; k++) { acc += T.P[k]; if (k >= 30) acc -= T.P[k - 30]; if (k >= 29) { const m = acc / 30; s4 += m * m * m * m; cnt++; } }
      np = Math.pow(s4 / cnt, 0.25);
    }
    const g = sess.guidance();
    const tile = (l, v) => D.stat(l, v);
    const plan0 = sess.plan0;
    const wmin = (() => { let w = sess.athlete.w0, mn = w; for (let k = 0; k < n; k++) { w = PYR.physio.wbalStep(w, T.P[k], sess.athlete.cp, sess.athlete.w0, 1, sess.athlete.recF); if (w < mn) mn = w; } return mn; })();
    const done = sess.s >= sess.course.length - 50;
    V.done.append(h('div', { class: 'rd-card' },
      h('h3', null, done ? 'Sortie terminée' : 'Sortie arrêtée'),
      h('div', { class: 'stats' },
        tile('Temps', hmm(n)), tile('Distance', km(sess.s) + ' km'),
        tile('Plan de départ', plan0 ? hmm(plan0.tFinish) : '–'), tile('Écart', plan0 && done ? U.fmtDelta(n - plan0.tFinish) : '–'),
        tile('Puissance moy.', n ? Math.round(work / n) + ' W' : '–'), tile('Puissance norm.', np ? Math.round(np) + ' W' : '–'),
        tile('W′ minimal', Math.round(wmin / sess.athlete.w0 * 100) + ' %'), tile('Glycogène final', g ? Math.round(g.energy * 100) + ' %' : '–'),
        tile('Recalculs', Math.max(0, sess.planLog.length - 1) + ''), tile('Prises', sess.intakes.length + ''),
        ...(g && g.fuelStatus && g.fuelStatus.phys ? [
          tile('Temp. centrale max', U.fmt(g.fuelStatus.phys.maxTc, 1) + ' °C'), tile('Glycémie min.', U.fmt(g.fuelStatus.phys.minGlu, 1) + ' mmol/L'),
          tile('Sueur', U.fmt(g.fuelStatus.phys.sweatL, 1) + ' L'), tile('Glucides brûlés', Math.round(g.fuelStatus.phys.choTot) + ' g'),
          tile('PC effective finale', Math.round(g.fuelStatus.phys.cpK * 100) + ' %'),
          // recalage par la FC : FC de repos et max apprises, à reporter dans la carte athlète (onglet Cycliste) si elles se confirment
          ...(g.fuelStatus.phys.hrFit && g.fuelStatus.phys.hrFit.n >= 600 ? [tile('FC repos / max recalées', `${Math.round(g.fuelStatus.phys.hrFit.HRrest)} / ${Math.round(g.fuelStatus.phys.hrFit.HRmax)} bpm`)] : [])] : [])),
      h('h4', null, 'Enregistrer l\'activité'),
      h('p', { class: 'rd-note' }, 'Un point par seconde : position, altitude, distance, vitesse, puissance, cardio, cadence, W′bal et glycogène dépensé (cardio et cadence s\'ils étaient mesurés).'),
      h('div', { class: 'rd-btns' }, ...PYR.activityExport.FORMATS.map((fm, i) => h('button', { class: 'btn' + (i === 0 ? ' primary' : ''), type: 'button', title: fm.hint, onclick: () => exportActivity(fm.id) }, fm.label))),
      h('ul', { class: 'rd-export-hints' }, ...PYR.activityExport.FORMATS.map((fm) => h('li', null, h('strong', null, fm.label), ' : ' + fm.hint))),
      h('div', { class: 'rd-btns' },
        h('button', { class: 'btn', type: 'button', onclick: () => { run.mode = 'prep'; run.sess = null; run.demo = null; run.mix = null; setMode('prep'); renderPrep(); } }, 'Nouvelle sortie'))));
    V.doneMix = h('div', { class: 'rd-card rd-done-mix', hidden: !run.mix }, h('p', { class: 'rd-note' }, 'Calcul des arrivées des coureurs virtuels…'));
    V.done.append(V.doneMix);
  }

  /** Enregistre l'activité dans l'un des formats d'activity-export.js (FIT, TCX, GPX, CSV). */
  function exportActivity(id) {
    const sess = run.sess;
    if (!sess) return;
    if (sess.t < 2) { D.toast('Sortie trop courte pour être enregistrée.', 'error'); return; }
    try {
      const out = PYR.activityExport.build(sess, id, `Sortie du ${new Date(sess.startMs).toLocaleDateString('fr-FR')}`);
      D.download(out.filename, new Blob([out.data], { type: out.mime }), out.mime);
    } catch (e) {
      console.error(e);
      D.toast('Export impossible : ' + e.message, 'error');
    }
  }

  /* ======================================================================
   * Page
   * ====================================================================== */
  function setMode(m) {
    V.prep.hidden = m !== 'prep'; V.live.hidden = m !== 'live'; V.done.hidden = m !== 'done';
    document.body.dataset.ride = m;
    V.back.hidden = m === 'live';
    setTxt(V.title, m === 'live' ? 'Sortie en cours' : m === 'done' ? 'Bilan' : 'Sortie');
    if (V.scroll) V.scroll.scrollTop = 0;
  }

  function build() {
    const root = $('#ride');
    D.clear(root);
    V.root = root;
    V.back = h('button', { class: 'btn ghost', type: 'button', onclick: () => PYR.app.showTab(T.prev && T.prev !== 'ride' ? T.prev : 'route') }, '‹ Retour');
    V.title = h('strong', { class: 'rd-title' }, 'Sortie');
    V.top = h('header', { class: 'rd-top' }, V.back, V.title);
    buildPrep(); buildLive();
    V.done = h('section', { class: 'rd-done', hidden: true });
    V.col = h('div', { class: 'rd-col' }, V.prep, V.live, V.done);
    V.scroll = h('div', { class: 'rd-scroll' }, V.col);
    root.append(V.top, V.scroll);
  }

  const T = {
    init() {
      const rs = store.state.ride;
      if (!rs) return;
      build();
      ['profile', 'rider', 'bike', 'env', 'perf', 'weather', 'surfaces', 'winds'].forEach((e) => store.on(e, () => { if (run.mode === 'prep' && document.body.dataset.tab === 'ride') renderPrep(); }));
      // la référence de W′bal est inscrite dans le plan : un plan repris de l'onglet Performance est repris à nouveau, les autres sont signalés périmés (empreinte)
      store.on('formref', () => {
        if (run.mode !== 'prep') return;
        const info = store.state.ride.planInfo;
        if (info && info.source === 'perf' && store.plan && !store.planStale) adoptPerfPlan(true);
        if (document.body.dataset.tab === 'ride') renderPrep();
      });
      window.addEventListener('pagehide', () => { if (run.mode === 'live') saveSession(); });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && run.mode === 'live') saveSession(); });
      window.addEventListener('resize', () => {
        if (run.mode === 'live' && run.sess) render(run.sess.guidance());
        else if (run.mode === 'prep' && document.body.dataset.tab === 'ride') renderPrep();
      });
    },
    prev: 'route',                                           // onglet précédent (posé par app.js), pour le bouton « Retour »
    onShow() {
      clearInterval(run.bleTimer);
      run.bleTimer = setInterval(() => { if (document.body.dataset.tab === 'ride') renderSensors(); }, 1000);
      if (run.mode === 'prep') { run.base = null; run.segPlan = null; loadStoredPlan(); renderPrep(); }
      else if (run.mode === 'live' && run.sess) render(run.sess.guidance());
      document.body.dataset.ride = run.mode;
    },
    onHide() { detachMap(); /* la sortie continue en arrière-plan ; la carte retourne à la page */ },
    /** Pour les tests de l'interface : accès à l'état. */
    _run: run,
  };

  PYR.tabRide = T;
})(globalThis.PYR = globalThis.PYR || {});
