/* author : Hugo Joudrier-Faure */
/* PaceYourRide — état de l'application, persistance (localStorage) et bus d'événements. */
(function (PYR) {
  'use strict';

  const KEY = 'paceyourride.v1';
  const MTIME_KEY = 'paceyourride.v1.mtime';   // date de la dernière modification du projet : la synchronisation (js/core/cloud.js) garde le plus récent
  /** Réglages sans effet sur la physique : un événement à part, pour ne pas invalider le plan ni relancer le jeu. */
  const EVENT_OF = { 'rider.name': 'name', 'perf.formRef': 'formref' };
  /** Réglages de l'onglet Équipement rangés dans `rider` : position sur le vélo et tenue. */
  const EQUIPMENT_KEYS = ['position', 'helmet', 'clothing', 'glasses', 'socks', 'shave', 'outfitName'];
  /** Champs de la carte athlète du modèle physiologique (metabo.js), tous vides (estimés) par défaut. */
  const PHYSIO_KEYS = ['cp1', 'vo2max', 'hrRest', 'hrMax', 'fI', 'mfo', 'fatmax', 'glyMuscle', 'glyLiver', 'glyFill', 'sweatMax', 'sweatNa', 'tcrit', 'heatAcc', 'altAcc', 'buffer', 'cafHalf'];
  function physioDefaults() { const o = {}; for (const k of PHYSIO_KEYS) o[k] = ''; return o; }

  const defaults = () => ({
    version: 1,
    route: { waypoints: [], legs: [], mode: 'fastbike', fixed: null, name: '' },
    surfaces: [],
    winds: [],
    feedZones: [],     // zones de ravitaillement [{id, startKm, endKm}] (onglet Parcours)
    checkpoints: [],   // points en jeu : sprints intermédiaires et côtes classées [{id, type, km, startKm, cat, pts}] (onglet Parcours)
    road: { width: 6 }, // largeur de route par défaut (m), hors portions de revêtement : place du peloton dans le mode jeu (onglet Parcours)
    rider: {
      name: '', avatar: '',    // avatar : photo carrée en adresse data: (js/core/avatar.js), '' sans photo
      sex: 'm', birthDate: '', age: 35, weight: 72, height: 178, position: 'hoods_bent', helmet: 'road', clothing: 'fitted',
      glasses: 'sport', socks: 'classic', shave: 'none',
      outfitName: '',          // nom de la tenue et position (pour la retrouver dans la bibliothèque de l'accueil)
      gut: 0,                  // intestin : 0 non entraîné, 0.5 habitué, 1 très entraîné (absorption des glucides en course)
      ftp: 250, cp: '', wPrime: '', pmax: '', records: {},
      // carte athlète du modèle physiologique (metabo.js FIELDS) : '' = valeur estimée d'après le profil
      physio: physioDefaults(),
    },
    bike: {
      name: '',                // nom du vélo (pour le retrouver dans la bibliothèque de l'accueil)
      weight: 8.5, load: 1.5, frame: 'road', wheels: 'low', cdaAdjust: 0, cdaOverride: '',
      tire: 'road', crrCustom: 0.004, drivetrain: 'clean', effCustom: 97, wheelMass: 2.2, spinMaxKmh: 65, shoes: 'road',
    },
    env: { temperature: 20 },
    // météo : heure de départ locale, prévisions récupérées (instantané figé), pour quoi elles ont été récupérées
    // source : 'api' (prévisions Open-Meteo, onglet Météo) ou 'custom' (portions saisies à la main : `custom`, plus les portions de vent `winds`) ;
    // dans les deux cas `snapshot` est l'instantané que lisent les simulations
    weather: { enabled: false, source: 'api', startAt: '', snapshot: null, utcOffset: 0, fetchedAt: 0, fetchedFor: '',
      custom: { baseT: 20, temp: [], rain: [] } },
    perf: { startSpeedKmh: 0, cornering: 'normal', vmaxKmh: 80, formPct: 100, formRef: 'athlete', algo: 'hybrid', // algorithme par défaut : hybride (analytique + descente de gradient, on garde le meilleur)
      physio: false },        // stratégie vérifiée sur le modèle physiologique (metabo.js) : désactivée par défaut
    game: {
      timeScale: 5, ghost: true, follow: true,
      countdown: 5,            // décompte avant le départ (s, temps réel ; 0 : aucun), affiché sur l'écran de course
      bots: 3, botLevel: 'equal', events: true, form: true, fuel: true, pullSec: 30,
      source: 'avatar',        // présence dans la course (presence.js) : avatar, home-trainer (watts mesurés) ou vraie route (GPS)
      trainerSim: true,        // home-trainer FTMS : il reçoit la pente, le vent et l'abri du peloton
      northUp: false,          // carte : nord en haut (boussole) ; sinon elle suit l'orientation du cycliste, comme la page Sortie
      showTte: true,           // HUD : afficher la durée tenable (« Tenable », TTE) ; décoché, elle est masquée
      peloton: true,           // peloton en deux dimensions : coureurs côte à côte sur la largeur de la route, éventails (peloton.js) ; toujours vrai
      physio: true,            // modèle physiologique (avec l'alimentation) : glycogène par fibres, glycémie, chaleur, eau, fatigue, caféine
      fx: true,                // animations météo sur la carte (pluie, battement des manches à air)
      // limites en « Dans les roues » / « Suivre les attaques » (en %) : on se laisse décrocher plutôt que de passer sous ce W′ (0 : aucune limite)
      // ou de dépasser cette part de la courbe de puissance record (100 : aucune limite)
      followW: 0, followPpr: 100,
      // matériel emporté avec l'option « Alimentation et hydratation » : contenu de chaque emplacement (bidons 1 à 3, camelback ; vide = pas de contenant :
      // eau, hypo, iso, hyper) et nombre de chaque aliment dans les poches (voir fuel.js)
      kit: { slots: ['iso', 'iso', '', ''], items: { gel: 3, gelglu: 0, gelplus: 0, bar: 2, barmini: 0 } },
      // mêmes limites pour mener un relais : on laisse le relais dès qu'elles sont atteintes
      relayW: 0, relayPpr: 100,
      // retour à ×1 aux évènements : durées en secondes de course, distances avant la ligne en mètres, pauses de réaction en secondes
      slowOn: false,
      slowAttack: 60, slowAttackPause: 0, slowCrash: 60, slowCrashPause: 0, slowPuncture: 60, slowPuncturePause: 0,
      slowSprint: 1000, slowSprintPause: 0, slowKom: 1000, slowKomPause: 0, slowFinish: 1000, slowFinishPause: 0,
    },
    // page « Sortie » : plan de puissance suivi (compact, voir ride.js ; il voyage avec le projet exporté vers le téléphone), matériel emporté,
    // réglages des alertes et du recalcul automatique, mode démo
    ride: {
      plan: null, planInfo: null,
      kit: { slots: ['iso', 'iso', '', ''], items: { gel: 3, gelglu: 0, gelplus: 0, bar: 2, barmini: 0 } },
      cfg: { auto: true, sens: 'normal', gapTau: 8, sound: true, vibrate: true, voice: false, lookahead: 10, altAlpha: 0.3, powerAvg: 3, weatherMin: 15, mapProfile: true, mixed: false, physio: true },
      demo: { speed: 5, bias: 0 },
    },
    shop: {},                // magasin : article acheté par catégorie (cadre, roues…)
    challenges: {},          // défis en différé (id → défi)
    activeChallenge: null,
    // chartH : hauteurs de graphiques réglées par l'utilisateur, en px — « graphique » ou « graphique:panneau » → hauteur
    // curveScale / curveYScale : échelle des durées / des puissances de la courbe de puissance record (onglet Cycliste) : 'log' ou 'lin'
    // poi : surcouches de la carte cochées (water, bakery, cafe : points d'eau, boulangeries, cafés)
    ui: { tab: 'route', baseLayer: null, poi: { water: false, bakery: false, cafe: false }, center: null, zoom: null, shopPage: 'bike', chartH: {}, curveScale: 'log', curveYScale: 'log', gameProfile: true, gameCurve: true, gameStats: true,
      // mode jeu, grand écran : vrai pour afficher le profil / la puissance selon la durée dans le panneau de droite, sous le classement, plutôt que sur la carte
      gameProfileSide: false, gameCurveSide: false, gameStatsSide: false,
      // mode jeu, grand écran : largeur (px) de la bande latérale réglée à la poignée, 0 pour la largeur par défaut
      gameSideW: 0,
      // mode jeu, grand écran : ordre des blocs (classement, statistiques, profil d'élévation, puissance selon la durée), du premier au dernier, dans la
      // bande latérale comme dans la colonne de gauche de la carte
      gameOrder: ['classif', 'stats', 'profile', 'curve'],
      // onglet Cycliste : sortie simulée du modèle physiologique (durée h, intensité % CP2, glucides g/h, boisson mL/h, sodium mmol/L,
      // température °C, humidité %, soleil W/m², altitude m, caféine mg/kg)
      physSim: { h: 4, pct: 70, cho: 60, fluid: 500, na: 20, T: 20, rh: 50, sun: 300, alt: 200, caf: 0 },
      // mode jeu, grand écran : les statistiques en vignettes (une carte par donnée) plutôt qu'en liste
      gameStatsTiles: false,
      // mode jeu : vue 3D (Bike3D) à la place du fond de carte sur la page de jeu (view3d.js)
      view3d: false,
      // magasin : le vélo en 3D (vitrine de Bike3D) ou en photos
      shopView: '3d' },
  });

  const listeners = Object.create(null);

  const store = {
    state: defaults(),
    profile: null,   // profil du parcours (dérivé du tracé, non persisté)
    plan: null,      // stratégie optimale calculée (non persistée)
    planStale: false,

    on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    emit(evt, data) {
      for (const fn of listeners[evt] || []) {
        try { fn(data); } catch (e) { console.error(`[${evt}]`, e); }
      }
    },

    get(path) {
      return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.state);
    },

    /** Modifie une valeur (« rider.age ») puis notifie la section (« rider ») et sauvegarde. */
    set(path, value, silent) {
      const keys = path.split('.');
      let o = this.state;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!o[keys[i]] || typeof o[keys[i]] !== 'object') o[keys[i]] = {};   // ex. carte athlète absente d'un athlète d'une ancienne bibliothèque
        o = o[keys[i]];
      }
      o[keys[keys.length - 1]] = value;
      if (path === 'rider.birthDate') syncAge(this.state.rider);
      if (!silent) this.emit(EVENT_OF[path] || keys[0], { path, value });
      this.save();
    },

    save: PYR.util.debounce(function () { store.saveNow(); }, 400),

    saveNow() {
      try {
        const json = JSON.stringify(serialize(this.state));
        if (localStorage.getItem(KEY) !== json) localStorage.setItem(MTIME_KEY, String(Date.now()));     // une écriture sans changement (ouverture de l'éditeur) ne rajeunit pas le projet
        localStorage.setItem(KEY, json);
      } catch (e) {
        console.warn('Sauvegarde locale impossible', e);
      }
    },

    load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) this.state = sanitize(merge(defaults(), upgrade(JSON.parse(raw))));
      } catch (e) {
        console.warn('Lecture de la sauvegarde impossible', e);
        this.state = defaults();
      }
    },

    reset() {
      this.state = defaults();
      this.plan = null;
      try { localStorage.removeItem(KEY); localStorage.removeItem(MTIME_KEY); } catch (e) { /* stockage indisponible */ }
    },

    exportProject() {
      return JSON.stringify(Object.assign({ app: 'PaceYourRide', exportedAt: new Date().toISOString() }, serialize(this.state)));
    },

    importProject(obj) {
      if (!obj || typeof obj !== 'object' || !obj.route) throw new Error('Fichier de projet invalide');
      this.state = sanitize(merge(defaults(), upgrade(obj)));
      this.plan = null;
      this.saveNow();
    },

    /** Profil du cycliste seul (identité, morphologie, intestin, seuils, records) : un petit fichier à garder ou à échanger. La tenue et la position (onglet Équipement) n'en font pas partie. */
    exportRider() {
      const rider = cleanRider(this.state.rider);
      for (const k of EQUIPMENT_KEYS) delete rider[k];
      return JSON.stringify({ app: 'PaceYourRide', kind: 'rider', version: 1, exportedAt: new Date().toISOString(), rider });
    },

    /** Charge un profil exporté (ou le cycliste d'un projet complet) : champs vérifiés, le reste du projet est conservé, tenue et position comprises. Renvoie le profil retenu. */
    importRider(obj) {
      const src = obj && typeof obj === 'object' && obj.rider && typeof obj.rider === 'object' ? obj.rider : null;
      if (!src || obj.kind === 'challenge') throw new Error('Fichier de profil invalide');
      const rider = cleanRider(src);
      for (const k of EQUIPMENT_KEYS) { if (this.state.rider[k] === undefined) delete rider[k]; else rider[k] = this.state.rider[k]; }
      this.state.rider = rider;
      this.plan = null;
      this.emit('rider', { path: 'rider' });
      this.saveNow();
      return this.state.rider;
    },
  };

  /** Sauvegarde d'avant la « forme » : l'ancienne marge de sécurité (%) devient une forme de 100 − marge. */
  function upgrade(obj) {
    const p = obj && obj.perf;
    if (p && typeof p === 'object' && p.formPct === undefined && p.marginPct !== undefined) p.formPct = 100 - (Number(p.marginPct) || 0);
    return obj;
  }

  /** L'âge se déduit de la date de naissance (recalculé à chaque ouverture) ; une date invalide est abandonnée, l'âge gardé. */
  function syncAge(rider) {
    if (!rider) return;
    const a = PYR.util.ageFrom(rider.birthDate);
    if (a === null) { rider.birthDate = ''; return; }
    rider.age = Math.min(99, Math.max(8, a));
  }

  /** Profil d'un fichier importé : chaque champ est vérifié (bornes des champs de l'onglet, identifiants connus), sinon il garde sa valeur par défaut. */
  function cleanRider(src) {
    const r = defaults().rider;
    const num = (v, min, max, dflt, int) => {
      if (v === '' || v === null || v === undefined || !Number.isFinite(Number(v))) return dflt;
      const x = Math.min(max, Math.max(min, Number(v)));
      return int ? Math.round(x) : Math.round(x * 100) / 100;
    };
    const pick = (v, list, dflt) => (Array.isArray(list) && list.some((o) => o.id === v) ? v : dflt);
    const Ph = PYR.physics || {};
    r.name = typeof src.name === 'string' ? src.name.slice(0, 30) : '';
    r.avatar = PYR.avatar ? PYR.avatar.clean(src.avatar) : '';
    r.sex = src.sex === 'f' ? 'f' : 'm';
    r.birthDate = PYR.util.ageFrom(src.birthDate) !== null ? String(src.birthDate) : '';
    r.age = num(src.age, 8, 99, r.age, true);
    syncAge(r);
    r.weight = num(src.weight, 25, 200, r.weight);
    r.height = num(src.height, 120, 230, r.height, true);
    r.position = pick(src.position, Ph.POSITIONS, r.position);
    r.helmet = pick(src.helmet, Ph.HELMETS, r.helmet);
    r.clothing = pick(src.clothing, Ph.CLOTHING, r.clothing);
    r.glasses = pick(src.glasses, Ph.GLASSES, r.glasses);
    r.socks = pick(src.socks, Ph.SOCKS, r.socks);
    r.shave = pick(src.shave, Ph.SHAVE, r.shave);
    r.gut = num(src.gut, 0, 1, 0);
    if (PYR.fuel) {
      const lv = PYR.fuel.GUT_LEVELS.map((l) => l.value);   // un niveau proposé : le plus proche
      r.gut = lv.reduce((best, x) => (Math.abs(x - r.gut) < Math.abs(best - r.gut) ? x : best), lv[0]);
    }
    r.ftp = num(src.ftp, 50, 600, r.ftp, true);
    r.cp = num(src.cp, 50, 600, '', true);
    r.wPrime = num(src.wPrime, 2, 60, '');
    r.pmax = num(src.pmax, 100, 3000, '', true);
    const durations = PYR.physio ? PYR.physio.DURATIONS : null;
    if (src.records && typeof src.records === 'object') {
      for (const k of Object.keys(src.records)) {
        const d = Number(k), p = Number(src.records[k]);
        if (p >= 10 && p <= 3000 && Number.isFinite(d) && (!durations || durations.includes(d))) r.records[d] = Math.round(p);
      }
    }
    r.physio = cleanPhysio(src.physio);
    return r;
  }

  /** Carte athlète du modèle physiologique : chaque champ connu, borné à ses limites (metabo.FIELDS), sinon vide (estimé). */
  function cleanPhysio(src) {
    const out = physioDefaults();
    if (!src || typeof src !== 'object') return out;
    const F = PYR.metabo ? PYR.metabo.FIELD : null;
    for (const k of PHYSIO_KEYS) {
      const v = src[k];
      if (v === '' || v === null || v === undefined || !Number.isFinite(Number(v))) continue;
      const f = F && F[k];
      out[k] = f ? Math.min(f.max, Math.max(f.min, Number(v))) : Number(v);
    }
    return out;
  }

  /** Instantané météo relu de la sauvegarde ou d'un projet importé : vérifié, sinon abandonné. */
  function sanitize(state) {
    state.ui.chartH = cleanChartH(state.ui.chartH);
    // le mode jeu roule toujours en peloton 2D : deux coureurs ne s'y chevauchent jamais (l'ancienne option « en file » les superposait)
    state.game.peloton = true;
    if (state.perf.formRef !== 'form') state.perf.formRef = 'athlete';
    syncAge(state.rider);
    state.checkpoints = cleanCheckpoints(state.checkpoints);
    state.feedZones = cleanFeedZones(state.feedZones);
    cleanRide(state.ride);
    const w = state.weather;
    if (w) {
      if (w.source !== 'custom') w.source = 'api';
      w.custom = cleanCustomWeather(w.custom);
    }
    if (w && w.snapshot) {
      if (typeof w.snapshot.off !== 'number') w.snapshot.off = Number(w.utcOffset) || 0; // sauvegarde d'avant l'ajout du décalage horaire
      w.snapshot = PYR.weather ? PYR.weather.normalize(w.snapshot) : null;
      if (!w.snapshot) { w.fetchedAt = 0; w.fetchedFor = ''; }
    }
    return state;
  }

  /** Portions de température et de pluie de la météo personnalisée : champs vérifiés et bornés, éléments invalides abandonnés. */
  function cleanCustomWeather(src) {
    const c = src && typeof src === 'object' ? src : {};
    const km = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 && Number(x) <= 2000 ? Math.round(Number(x) * 100) / 100 : null);
    const list = (arr, field, min, max, dflt) => {
      const out = [];
      for (const it of Array.isArray(arr) ? arr.slice(0, 1000) : []) {      // garde-fou contre des données corrompues, pas une limite d'usage
        if (!it || typeof it !== 'object') continue;
        let a = km(it.startKm), b = km(it.endKm);
        if (a === null || b === null) continue;
        if (b < a) [a, b] = [b, a];
        const v = Number.isFinite(Number(it[field])) && it[field] !== '' ? Math.min(max, Math.max(min, Number(it[field]))) : dflt;
        out.push({ id: String(it.id || PYR.util.uid()).slice(0, 20), startKm: a, endKm: b, [field]: Math.round(v * 10) / 10 });
      }
      return out;
    };
    const baseT = Number.isFinite(Number(c.baseT)) && c.baseT !== '' ? Math.min(45, Math.max(-20, Number(c.baseT))) : 20;
    return { baseT, temp: list(c.temp, 'T', -30, 55, 20), rain: list(c.rain, 'rain', 0, 100, 1) };
  }

  /** Page « Sortie » d'une sauvegarde ou d'un projet importé : plan, matériel et réglages vérifiés. */
  function cleanRide(r) {
    const p = r.plan;
    if (p && !(Array.isArray(p.s) && Array.isArray(p.P) && Array.isArray(p.w) && p.s.length > 1 && p.s.length <= 60000 && p.P.length === p.s.length - 1 && p.w.length === p.s.length
      && Number.isFinite(p.tF) && Number.isFinite(p.L))) { r.plan = null; r.planInfo = null; }
    if (PYR.fuel) r.kit = PYR.fuel.normKit(r.kit);
    const c = r.cfg;
    c.auto = !!c.auto; c.sound = !!c.sound; c.vibrate = !!c.vibrate; c.voice = !!c.voice;
    if (!['low', 'normal', 'high'].includes(c.sens)) c.sens = 'normal';
    c.gapTau = Math.min(30, Math.max(3, Number(c.gapTau) || 8));
    c.lookahead = Math.min(30, Math.max(0, Number(c.lookahead) || 0));
    c.powerAvg = Math.min(60, Math.max(1, Math.round(Number(c.powerAvg) || 3)));
    c.weatherMin = [5, 15, 30, 60].includes(Number(c.weatherMin)) ? Number(c.weatherMin) : 15;      // période de mise à jour de la météo pendant la sortie (min)
    c.mapProfile = c.mapProfile !== false; c.mixed = !!c.mixed; c.physio = c.physio !== false;
    delete c.map; delete c.mapRotate; delete c.mapSize;      // anciens réglages : la carte est toujours affichée, orientée dans le sens de la marche
    c.altAlpha = c.altAlpha === undefined ? 0.3 : Math.min(1, Math.max(0, Number(c.altAlpha) || 0));
    r.demo.speed = [1, 5, 10, 20, 50].includes(Number(r.demo.speed)) ? Number(r.demo.speed) : 5;
    r.demo.bias = Math.min(40, Math.max(-40, Number(r.demo.bias) || 0));
  }

  /** Hauteurs de graphiques d'une sauvegarde ou d'un projet importé : clés et valeurs vérifiées (30 à 900 px). */
  function cleanChartH(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const k of Object.keys(obj).slice(0, 40)) {
      const v = Number(obj[k]);
      if (/^[a-z][a-z0-9]{0,15}(:[a-z0-9]{1,15})?$/.test(k) && Number.isFinite(v)) out[k] = Math.round(Math.min(900, Math.max(30, v)));
    }
    return out;
  }

  /** Sprints et côtes d'une sauvegarde ou d'un projet importé : champs vérifiés, éléments invalides abandonnés. */
  function cleanCheckpoints(list) {
    const km = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.round(Number(x) * 1000) / 1000 : null);
    const out = [];
    for (const it of Array.isArray(list) ? list.slice(0, 60) : []) {
      if (!it || (it.type !== 'sprint' && it.type !== 'kom') || km(it.km) === null || km(it.km) === 0) continue;
      const cp = { id: String(it.id || PYR.util.uid()).slice(0, 20), type: it.type, km: km(it.km) };
      if (it.type === 'kom') {
        cp.startKm = Math.min(km(it.startKm) || 0, cp.km);
        cp.cat = PYR.classif && PYR.classif.catOf(it.cat) ? String(it.cat) : '4';
      }
      const pts = PYR.classif ? PYR.classif.cleanPts(it.pts) : null;
      if (pts) cp.pts = pts;
      out.push(cp);
    }
    return out;
  }

  /** Zones de ravitaillement d'une sauvegarde ou d'un projet importé : vérifiées (début avant fin), les invalides sont abandonnées. */
  function cleanFeedZones(list) {
    const km = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.round(Number(x) * 1000) / 1000 : null);
    const out = [];
    for (const it of Array.isArray(list) ? list.slice(0, 60) : []) {
      if (!it) continue;
      const a = km(it.startKm), b = km(it.endKm);
      if (a === null || b === null || b - a < 0.05) continue;
      out.push({ id: String(it.id || PYR.util.uid()).slice(0, 20), startKm: a, endKm: b });
    }
    return out;
  }

  /** Arrondit les coordonnées pour alléger la sauvegarde. */
  function serialize(state) {
    const s = JSON.parse(JSON.stringify(Object.assign({}, state, { route: undefined })));
    s.route = {
      mode: state.route.mode,
      name: String(state.route.name || '').slice(0, 60),
      fixed: state.route.fixed || null,
      waypoints: state.route.waypoints.map((w) => ({ lat: +w.lat.toFixed(6), lng: +w.lng.toFixed(6) })),
      legs: state.route.legs.map((l) => ({
        mode: l.mode,
        coords: l.coords ? l.coords.map((c) => [+c[0].toFixed(6), +c[1].toFixed(6), c[2] === null || c[2] === undefined ? null : +(+c[2]).toFixed(1)]) : null,
      })),
    };
    return s;
  }

  /** Fusion récursive : les clés inconnues de la sauvegarde sont ignorées, les manquantes gardent leur défaut. */
  function merge(base, src) {
    if (!src || typeof src !== 'object') return base;
    for (const k of Object.keys(base)) {
      if (!(k in src)) continue;
      const b = base[k], v = src[k];
      if (Array.isArray(b)) base[k] = Array.isArray(v) ? v : b;
      else if (b && typeof b === 'object') base[k] = merge(b, v);
      else base[k] = v;
    }
    // objets « ouverts » (records de puissance, défis)
    if (src.records && typeof src.records === 'object' && base.records) base.records = Object.assign({}, src.records);
    if (src.challenges && typeof src.challenges === 'object' && base.challenges) base.challenges = Object.assign({}, src.challenges);
    if (src.shop && typeof src.shop === 'object' && base.shop) base.shop = Object.assign({}, src.shop);
    if (src.chartH && typeof src.chartH === 'object' && base.chartH) base.chartH = Object.assign({}, src.chartH);
    if ('fixed' in base && src.fixed && typeof src.fixed === 'object') base.fixed = src.fixed;
    return base;
  }

  PYR.store = store;
})(globalThis.PYR = globalThis.PYR || {});
