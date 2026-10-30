/* author : Hugo Joudrier-Faure */
/* PaceYourRide — la bibliothèque de PaceYourRide vue des jeux et du compteur : une copie locale de ce que Dropbox contient (parcours, athlètes,
 * vélos, tenues, et le projet en cours avec son plan), qu'on actualise depuis Dropbox, à laquelle on peut ajouter un parcours (GPX) ou un athlète,
 * et dont on recopie les éléments choisis dans l'état de l'application. Ce qu'on ajoute part dans Dropbox (cloud.saveLibrary), où PaceYourRide,
 * l'autre jeu et le compteur le retrouvent. Rien d'ici n'écrit le projet en cours de PaceYourRide. */
(function (PYR) {
  'use strict';

  const L = PYR.library;
  const PROJECT_ID = '__project__';                                       // le projet en cours de PaceYourRide, proposé en tête de chaque liste
  const PROJECT_KEY = (PYR.storageNs || 'paceyourride') + '.cloudproject.v1';

  const C = { lib: L.empty(), project: null, projectAt: 0, pulledAt: 0, busy: false, error: '', memo: {}, profiles: new Map() };

  function readJSON(k) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (e) { return null; } }

  function load() {
    C.memo = {};
    C.lib = L.normalize(readJSON(L.STORAGE_KEY));
    const c = readJSON(PROJECT_KEY);
    if (c && typeof c === 'object') { C.project = c.project || null; C.projectAt = Number(c.savedAt) || 0; C.pulledAt = Number(c.pulledAt) || 0; }
    return C;
  }
  function save() {
    try {
      localStorage.setItem(L.STORAGE_KEY, JSON.stringify(C.lib));
      localStorage.setItem(PROJECT_KEY, JSON.stringify({ project: C.project, savedAt: C.projectAt, pulledAt: C.pulledAt }));
      return true;
    } catch (e) { return false; }
  }

  /** Ce que le projet en cours de PaceYourRide offre pour la rubrique, ou null. */
  function projectItem(kind) {
    const p = C.project;
    if (!p || typeof p !== 'object') return null;
    const has = kind === 'route' ? L.routeLength(p) > 0 : kind === 'bike' ? !!p.bike : !!p.rider;
    if (!has) return null;
    const own = kind === 'route' ? p.route && p.route.name : kind === 'bike' ? p.bike && p.bike.name : kind === 'outfit' ? p.rider && p.rider.outfitName : p.rider && p.rider.name;
    return { id: PROJECT_ID, name: (own ? own + ' · ' : '') + 'projet en cours', savedAt: C.projectAt, data: L.extract(kind, p), project: true };
  }

  /** Éléments proposés pour la rubrique : le projet en cours (sauf s'il est déjà dans la bibliothèque), puis la bibliothèque (le plus récent d'abord). */
  function items(kind) {
    if (C.memo[kind]) return C.memo[kind];
    const out = C.lib[L.KINDS[kind].list].slice();
    const pj = projectItem(kind);
    const json = pj ? JSON.stringify(pj.data) : '';
    C.memo[kind] = pj && !out.some((x) => JSON.stringify(x.data) === json) ? [pj].concat(out) : out;
    return C.memo[kind];
  }
  const find = (kind, id) => items(kind).find((x) => x.id === id) || null;
  /** Identifiant choisi s'il existe encore, sinon le premier proposé ('' s'il n'y en a pas). */
  const pickId = (kind, id) => (items(kind).some((x) => x.id === id) ? id : (items(kind)[0] ? items(kind)[0].id : ''));

  /** Profil du parcours d'un élément (calculé une fois par version). */
  function profileOf(it) {
    const key = it.id + '@' + it.savedAt;
    if (!C.profiles.has(key)) C.profiles.set(key, L.routeProfile(it.data));
    return C.profiles.get(key);
  }

  /** Lit Dropbox et remplace la copie locale. Renvoie 'ok', 'vide' (rien dans Dropbox) ou lève une erreur lisible. */
  async function refresh() {
    C.busy = true; C.error = '';
    try {
      const snap = await PYR.cloud.pull();
      if (!snap) return 'vide';
      C.memo = {}; C.lib = snap.library; C.project = snap.project; C.projectAt = snap.savedAt; C.pulledAt = snap.pulledAt;
      save();
      return 'ok';
    } catch (e) { C.error = e.message; throw e; } finally { C.busy = false; }
  }

  /** Range un élément dans la bibliothèque locale, puis l'envoie à Dropbox si l'appareil y est connecté (sinon il restera local : message à l'appelant). */
  async function store(kind, name, data) {
    const it = L.add(C.lib, kind, name, data);
    C.memo = {};
    save();
    let sent = false, error = '';
    if (PYR.cloud.status().connected) {
      try { C.lib = await PYR.cloud.saveLibrary(C.lib); C.memo = {}; save(); sent = true; } catch (e) { error = e.message; }
    }
    return { item: it, sent, error };
  }

  /**
   * Parcours d'un fichier GPX (une simple trace, ou un parcours complet exporté par PaceYourRide) : ce qui se range dans la bibliothèque
   * ({route, surfaces, winds…}) et son nom. La trace est allégée (au plus 3 000 points) ; sans altitude dans le fichier, le parcours n'a pas de dénivelé.
   */
  function routeFromGpx(text) {
    const parsed = PYR.services.parseGpx(text);
    const full = PYR.routeFile.restore(parsed);
    if (full) return { name: String(full.route && full.route.name || parsed.name || '').trim(), data: full };
    let pts = parsed.points;
    if (pts.length > 3000) { const k = (pts.length - 1) / 2999; pts = Array.from({ length: 3000 }, (_, i) => parsed.points[Math.round(i * k)]); }
    const coords = pts.map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6, p[2] === null || p[2] === undefined ? null : Math.round(p[2] * 10) / 10]);
    const name = String(parsed.name || '').trim().slice(0, 60);
    return { name, hasEle: parsed.hasEle, data: { route: { name, mode: 'fastbike', fixed: null, waypoints: [{ lat: coords[0][0], lng: coords[0][1] }, { lat: coords[coords.length - 1][0], lng: coords[coords.length - 1][1] }], legs: [{ coords }] }, surfaces: [], winds: [], feedZones: [], checkpoints: [] } };
  }

  /**
   * Recopie dans l'état `st` (celui du store de l'application) le parcours, l'athlète, le vélo et la tenue choisis (identifiants de `pick` ; 'none' pour le vélo
   * ou la tenue : réglages par défaut), puis les réglages de stratégie et le plan optimal du projet de PaceYourRide. Le plan n'est repris que s'il correspond
   * encore au choix (plan-link.js). Renvoie l'élément parcours choisi, ou null.
   */
  function compose(st, pick) {
    const route = find('route', pickId('route', pick.route));
    const wx = st.weather;
    if (route) {
      L.startRoute(st, Date.now()); L.apply('route', st, route.data);
      // startRoute abandonne la météo : l'état doit en avoir une pour qui relit le profil aussitôt (météo du parcours enregistré, sinon la précédente, sinon aucune)
      if (!st.weather) st.weather = wx || { enabled: false, source: 'api', startAt: '', snapshot: null, utcOffset: 0, fetchedAt: 0, fetchedFor: '', custom: { baseT: 20, temp: [], rain: [] } };
    }
    const ath = find('athlete', pickId('athlete', pick.athlete));
    if (ath) L.apply('athlete', st, ath.data);
    const bike = pick.bike === 'none' ? null : find('bike', pickId('bike', pick.bike)), outfit = pick.outfit === 'none' ? null : find('outfit', pickId('outfit', pick.outfit));
    if (bike) L.apply('bike', st, bike.data);
    if (outfit) L.apply('outfit', st, outfit.data);
    const pj = C.project;
    if (pj) {
      if (pj.perf && typeof pj.perf === 'object') st.perf = Object.assign({}, st.perf, pj.perf);
      if (pj.env && typeof pj.env === 'object') st.env = Object.assign({}, st.env, pj.env);
      if (pj.ride && pj.ride.plan && pj.ride.planInfo) { st.ride.plan = pj.ride.plan; st.ride.planInfo = pj.ride.planInfo; if (pj.ride.kit) st.ride.kit = pj.ride.kit; }
    }
    return route;
  }

  PYR.libCache = { PROJECT_ID, state: C, load, save, items, find, pickId, profileOf, refresh, store, routeFromGpx, compose };
})(globalThis.PYR = globalThis.PYR || {});
