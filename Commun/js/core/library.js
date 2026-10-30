/* author : Hugo Joudrier-Faure */
/* PaceYourRide — bibliothèque de l'accueil : parcours, athlètes, vélos et tenues mis de côté pour être recombinés.
 * Le projet de l'application (store.js) ne contient qu'un parcours, un cycliste, un vélo et une tenue ; la bibliothèque en garde
 * plusieurs et sait en recopier un dans le projet (« appliquer »). Fonctions pures sur des objets simples : aucun accès au DOM.
 * Le stockage (localStorage) est fait par la page d'accueil (js/home.js). */
(function (PYR) {
  'use strict';

  /** Clé du stockage (localStorage) de la bibliothèque, partagée par l'accueil et l'éditeur. */
  const STORAGE_KEY = (PYR.storageNs || 'paceyourride') + '.library.v1';

  /** Rubriques : clé dans la bibliothèque, libellé. */
  const KINDS = {
    route: { list: 'routes', label: 'Parcours' },
    athlete: { list: 'athletes', label: 'Athlète' },
    bike: { list: 'bikes', label: 'Vélo' },
    outfit: { list: 'outfits', label: 'Tenue et position' },
  };
  /** Réglages du cycliste qui appartiennent à l'athlète (le reste du `rider` est la tenue et la position). */
  const OUTFIT_RIDER = ['position', 'helmet', 'clothing', 'glasses', 'socks', 'shave', 'outfitName'];
  /** Articles du magasin rangés avec le vélo, le reste avec la tenue. */
  const BIKE_SHOP = ['frame', 'wheels', 'tires', 'drivetrain'];
  const MAX_REMOVED = 500;   // retraits mémorisés pour la synchronisation
  const ROUTE_KEYS = ['route', 'surfaces', 'winds', 'feedZones', 'checkpoints', 'weather', 'road'];

  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const pick = (src, keys) => { const o = {}; for (const k of keys) if (src && src[k] !== undefined) o[k] = clone(src[k]); return o; };
  const omit = (src, keys) => { const o = clone(src || {}); for (const k of keys) delete o[k]; return o; };

  /** Bibliothèque vide. */
  function empty() { return { version: 1, routes: [], athletes: [], bikes: [], outfits: [], removed: {} }; }

  /** Bibliothèque relue du stockage : forme vérifiée, éléments invalides abandonnés. */
  function normalize(raw) {
    const lib = empty();
    if (!isObj(raw)) return lib;
    for (const kind of Object.keys(KINDS)) {
      const list = raw[KINDS[kind].list];
      if (!Array.isArray(list)) continue;
      for (const it of list.slice(0, 200)) {
        if (!isObj(it) || typeof it.id !== 'string' || !isObj(it.data)) continue;
        lib[KINDS[kind].list].push({ id: it.id.slice(0, 40), name: String(it.name || KINDS[kind].label).slice(0, 60), savedAt: Number(it.savedAt) || 0, data: it.data });
      }
    }
    if (isObj(raw.removed)) for (const id of Object.keys(raw.removed).slice(0, MAX_REMOVED)) if (Number(raw.removed[id]) > 0) lib.removed[id.slice(0, 40)] = Number(raw.removed[id]);
    return lib;
  }

  /** Ce que le projet contient pour la rubrique `kind` (copie). */
  function extract(kind, state) {
    const s = state || {};
    const shop = isObj(s.shop) ? s.shop : {};
    if (kind === 'route') return pick(s, ROUTE_KEYS);
    if (kind === 'athlete') return { rider: omit(s.rider, OUTFIT_RIDER) };
    if (kind === 'bike') return { bike: omit(s.bike, ['shoes']), shop: pick(shop, BIKE_SHOP) };
    if (kind === 'outfit') {
      const shopRider = {};
      for (const k of Object.keys(shop)) if (!BIKE_SHOP.includes(k)) shopRider[k] = shop[k];
      return { rider: pick(s.rider, OUTFIT_RIDER), shoes: s.bike ? s.bike.shoes : undefined, shop: shopRider };
    }
    throw new Error('Rubrique inconnue : ' + kind);
  }

  /** Recopie `data` dans le projet `state` (modifié sur place, sans toucher au reste) et le renvoie. */
  function apply(kind, state, data) {
    if (!isObj(state) || !isObj(data)) throw new Error('Élément invalide');
    const d = clone(data);
    if (kind === 'route') {
      for (const k of ROUTE_KEYS) if (d[k] !== undefined) state[k] = d[k];
    } else if (kind === 'athlete') {
      state.rider = Object.assign({}, omit(d.rider, OUTFIT_RIDER), pick(state.rider, OUTFIT_RIDER));
      const born = PYR.util.ageFrom(state.rider.birthDate);      // l'âge enregistré date d'alors : on le recalcule d'après la date de naissance
      if (born !== null) state.rider.age = clamp(born, 8, 99);
    } else if (kind === 'bike') {
      state.bike = Object.assign({}, d.bike, state.bike && state.bike.shoes !== undefined ? { shoes: state.bike.shoes } : {});
      const shop = isObj(state.shop) ? state.shop : {};
      for (const k of BIKE_SHOP) delete shop[k];
      state.shop = Object.assign(shop, d.shop);
    } else if (kind === 'outfit') {
      state.rider = Object.assign({}, state.rider, d.rider);
      if (d.shoes !== undefined) state.bike = Object.assign({}, state.bike, { shoes: d.shoes });
      const shop = isObj(state.shop) ? state.shop : {};
      for (const k of Object.keys(shop)) if (!BIKE_SHOP.includes(k)) delete shop[k];
      state.shop = Object.assign(shop, d.shop);
    } else throw new Error('Rubrique inconnue : ' + kind);
    return state;
  }

  /** Un nouvel athlète pour la bibliothèque, à partir de ce que l'accueil demande : { rider } avec les réglages par défaut de l'éditeur
   *  (js/core/store.js) pour le reste. Chaque champ est borné comme sur la page Athlète. */
  function newAthlete(f) {
    const src = f || {};
    const num = (v, min, max, dflt, dec) => {
      if (v === '' || v === null || v === undefined || !Number.isFinite(Number(v))) return dflt;
      const x = Math.min(max, Math.max(min, Number(v)));
      return dec ? Math.round(x * 10) / 10 : Math.round(x);
    };
    const born = PYR.util.ageFrom(src.birthDate);
    return { rider: Object.assign({
      name: String(src.name || '').trim().slice(0, 30), sex: src.sex === 'f' ? 'f' : 'm',
      age: born !== null ? clamp(born, 8, 99) : num(src.age, 8, 99, 35), weight: num(src.weight, 25, 200, 72, true), height: num(src.height, 120, 230, 178),
      gut: 0, ftp: num(src.ftp, 50, 600, 250), cp: '', wPrime: '', pmax: '', records: {},
    }, born !== null ? { birthDate: String(src.birthDate) } : {}) };
  }

  /** Nom donné à un nouveau parcours : « Parcours du 19/10/2026 20:26:00 » (date et heure de sa création). */
  function defaultRouteName(now) {
    const d = new Date(now || Date.now()), p = (x) => String(x).padStart(2, '0');
    return `Parcours du ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** Nom donné à un nouvel athlète : « Athlète #20261019225932 » (année, mois, jour, heure, minute, seconde de sa création, collés). */
  function defaultAthleteName(now) {
    const d = new Date(now || Date.now()), p = (x) => String(x).padStart(2, '0');
    return `Athlète #${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** Remplace le parcours du projet `state` par un parcours vide et nommé (par défaut d'après la date et l'heure) : sprints, côtes, ravitaillements,
   *  revêtements, vent et météo qui allaient avec l'ancien tracé repartent à zéro ; le mode de tracé est gardé. Modifie `state` sur place et le renvoie. */
  function startRoute(state, now) {
    const mode = isObj(state.route) && state.route.mode ? state.route.mode : 'fastbike';
    state.route = { waypoints: [], legs: [], mode, fixed: null, name: defaultRouteName(now) };
    state.surfaces = []; state.winds = []; state.feedZones = []; state.checkpoints = [];
    delete state.weather;
    delete state.road; // largeur de route par défaut : celle des réglages par défaut
    return state;
  }

  let seq = 0;
  /** Ajoute un élément (le plus récent en premier) et le renvoie. */
  function add(lib, kind, name, data, now) {
    const list = lib[KINDS[kind].list];
    const it = { id: 'l' + (now || Date.now()).toString(36) + (seq++).toString(36), name: String(name || '').trim().slice(0, 60) || KINDS[kind].label, savedAt: now || Date.now(), data: clone(data) };
    list.unshift(it);
    return it;
  }
  const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  /** L'élément de la rubrique qui porte ce nom (sans tenir compte de la casse ni des espaces autour), ou null. */
  function findByName(lib, kind, name) {
    const n = String(name || '').trim().slice(0, 60) || KINDS[kind].label;
    return lib[KINDS[kind].list].find((x) => sameName(x.name, n)) || null;
  }
  /** Enregistre `data` sous `name`. Si ce nom existe déjà, rien n'est écrit tant que `overwrite` n'est pas vrai : on renvoie alors { exists }
   *  pour que l'appelant demande confirmation ; avec `overwrite`, l'élément existant est remplacé (même identifiant, plus récent donc gagnant
   *  à la synchronisation). Renvoie { item, replaced } quand c'est enregistré. */
  function save(lib, kind, name, data, now, overwrite) {
    const old = findByName(lib, kind, name);
    if (!old) return { item: add(lib, kind, name, data, now), replaced: false };
    if (!overwrite) return { exists: old };
    old.data = clone(data);
    old.savedAt = Math.max(now || Date.now(), old.savedAt + 1);
    const list = lib[KINDS[kind].list];
    list.splice(list.indexOf(old), 1);
    list.unshift(old);
    return { item: old, replaced: true };
  }
  function find(lib, kind, id) { return lib[KINDS[kind].list].find((x) => x.id === id) || null; }
  /** Renomme un élément (la date d'enregistrement est renouvelée : c'est elle qui fait gagner la version la plus récente à la synchronisation). */
  function rename(lib, kind, id, name, now) {
    const it = find(lib, kind, id);
    if (!it) return false;
    it.name = String(name || '').trim().slice(0, 60) || KINDS[kind].label;
    it.savedAt = Math.max(now || Date.now(), it.savedAt + 1);
    return true;
  }

  /** Retire un élément et garde la date du retrait : la synchronisation entre appareils ne le ramène pas. */
  function remove(lib, kind, id, now) {
    const list = lib[KINDS[kind].list];
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) { list.splice(i, 1); lib.removed = Object.assign({}, lib.removed, { [id]: now || Date.now() }); }
    return i >= 0;
  }

  /** Fusion de deux exemplaires de la bibliothèque (cet appareil et le nuage) : tous les éléments, le plus récent en cas de doublon,
   *  sauf ceux retirés depuis (sur l'un ou l'autre) qui n'ont pas été réenregistrés après. Ne modifie ni `a` ni `b`. */
  function merge(a, b) {
    const A = normalize(a), B = normalize(b), out = empty();
    const removed = Object.assign({}, A.removed);
    for (const id of Object.keys(B.removed)) removed[id] = Math.max(removed[id] || 0, B.removed[id]);
    for (const kind of Object.keys(KINDS)) {
      const key = KINDS[kind].list, byId = new Map();
      for (const it of A[key].concat(B[key])) {
        const had = byId.get(it.id);
        if (!had || it.savedAt > had.savedAt) byId.set(it.id, it);
      }
      out[key] = Array.from(byId.values()).filter((it) => !(removed[it.id] >= it.savedAt)).sort((x, y) => y.savedAt - x.savedAt || (x.id < y.id ? -1 : 1)).slice(0, 200);
    }
    const ids = Object.keys(removed).sort((x, y) => removed[y] - removed[x] || (x < y ? -1 : 1)).slice(0, MAX_REMOVED);
    for (const id of ids) out.removed[id] = removed[id];
    return out;
  }

  /** Tracé du projet sous forme de suites de points [lat, lng, altitude] : les tronçons, ou — pour un parcours figé (défi, course en
   *  direct : `route.fixed`, sans tronçon) — sa géométrie canonique (coordonnées en 1e-6°, altitudes en cm). */
  function routeChains(state) {
    const r = state && state.route;
    const legs = r && Array.isArray(r.legs) ? r.legs : [];
    const chains = [];
    for (const leg of legs) if (leg && Array.isArray(leg.coords)) chains.push(leg.coords);
    const fx = r && r.fixed;
    if (!chains.length && fx && Array.isArray(fx.lat) && Array.isArray(fx.lng) && fx.lat.length > 1 && fx.lat.length === fx.lng.length) {
      const hasEle = Array.isArray(fx.ele) && fx.ele.length === fx.lat.length;
      chains.push(fx.lat.map((la, i) => [la / 1e6, fx.lng[i] / 1e6, hasEle ? fx.ele[i] / 100 : null]));
    }
    return chains;
  }

  /** Longueur du parcours (m) d'après le tracé du projet, ou 0. */
  function routeLength(state) {
    const hav = PYR.util && PYR.util.haversine;
    if (!hav) return 0;
    let m = 0;
    for (const c of routeChains(state)) {
      for (let i = 1; i < c.length; i++) m += hav(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
    }
    return m;
  }

  /** Dénivelé positif (m) si tous les points ont une altitude, sinon null (seuil de 3 m contre le bruit). */
  function routeAscent(state) {
    let up = 0, ref = null;
    for (const c of routeChains(state)) {
      for (const p of c) {
        const e = Number(p[2]);
        if (!Number.isFinite(e)) return null;
        if (ref === null) ref = e;
        else if (e - ref >= 3) { up += e - ref; ref = e; } else if (e < ref) ref = e;
      }
    }
    return ref === null ? null : Math.round(up);
  }

  /** Moyenne glissante centrée (demi-largeur h points). */
  function smooth(a, h) {
    const n = a.length, out = new Float64Array(n), pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - h), hi = Math.min(n - 1, i + h);
      out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
    }
    return out;
  }

  /** Profil du parcours du projet, calculé comme dans l'éditeur (tracé rééchantillonné tous les ~10 m, altitude lissée) :
   *  { n, step, length, lat, lng, ele, up, down, hasEle }, ou null s'il n'y a pas de parcours. Sans altitude, `ele` est nul et `up`/`down` valent 0. */
  function routeProfile(state) {
    const hav = PYR.util && PYR.util.haversine;
    if (!hav) return null;
    const pts = [];
    routeChains(state).forEach((c, k) => {
      for (let i = k === 0 ? 0 : 1; i < c.length; i++) if (Array.isArray(c[i]) && Number.isFinite(+c[i][0]) && Number.isFinite(+c[i][1])) pts.push(c[i]);
    });
    const lat = [], lng = [], eleIn = [], dist = [];
    let d = 0;
    for (let i = 0; i < pts.length; i++) {
      if (lat.length) {
        const dd = hav(lat[lat.length - 1], lng[lng.length - 1], +pts[i][0], +pts[i][1]);
        if (dd < 0.05) continue;
        d += dd;
      }
      lat.push(+pts[i][0]); lng.push(+pts[i][1]); dist.push(d);
      const e = pts[i][2];
      eleIn.push(e === null || e === undefined || e === '' || !Number.isFinite(+e) ? NaN : +e);
    }
    if (d < 30) return null;
    // altitudes manquantes : interpolées en distance
    const known = eleIn.map((e, i) => (Number.isFinite(e) ? i : -1)).filter((i) => i >= 0);
    const hasEle = known.length > 0;
    if (hasEle) {
      for (let i = 0; i < eleIn.length; i++) {
        if (Number.isFinite(eleIn[i])) continue;
        const a = known.filter((j) => j < i).pop(), b = known.find((j) => j > i);
        eleIn[i] = a === undefined ? eleIn[b] : b === undefined ? eleIn[a] : eleIn[a] + (eleIn[b] - eleIn[a]) * (dist[i] - dist[a]) / Math.max(1e-9, dist[b] - dist[a]);
      }
    }
    const n = Math.round(d / 10) + 1, step = d / (n - 1);
    const pLat = new Float64Array(n), pLng = new Float64Array(n), raw = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const x = i * step;
      while (j < dist.length - 2 && dist[j + 1] < x) j++;
      const span = dist[j + 1] - dist[j], t = span > 0 ? Math.min(1, Math.max(0, (x - dist[j]) / span)) : 0;
      pLat[i] = lat[j] + (lat[j + 1] - lat[j]) * t;
      pLng[i] = lng[j] + (lng[j + 1] - lng[j]) * t;
      raw[i] = hasEle ? eleIn[j] + (eleIn[j + 1] - eleIn[j]) * t : 0;
    }
    const ele = hasEle ? smooth(smooth(raw, 3), 3) : null;
    let up = 0, down = 0;
    if (ele) for (let i = 1; i < n; i++) { const de = ele[i] - ele[i - 1]; if (de > 0) up += de; else down -= de; }
    return { n, step, length: d, lat: pLat, lng: pLng, ele, up, down, hasEle };
  }

  const labelOf = (list, id) => { const x = (list || []).find((o) => o.id === id); return x ? x.label : null; };
  /** Premier mot ou groupe avant « ( » / « , » : un libellé court pour une ligne de résumé. */
  const short = (s) => (s ? String(s).split(/\s*[(,]\s*/)[0] : '');

  /** Résumé d'un élément de la rubrique `kind` : { title, detail } (ou null si le projet n'en a pas). */
  function summary(kind, data) {
    const P = PYR.physics || {};
    const C = PYR.catalog;
    const fmt = (x, d) => (Math.round(x * Math.pow(10, d || 0)) / Math.pow(10, d || 0)).toLocaleString('fr-FR');
    if (kind === 'route') {
      const km = routeLength(data) / 1000;
      if (!km) return null;
      const up = routeAscent(data);
      const extras = [];
      const n = (a) => (Array.isArray(a) ? a.length : 0);
      if (n(data.checkpoints)) extras.push(n(data.checkpoints) + ' point' + (n(data.checkpoints) > 1 ? 's' : '') + ' en jeu');
      if (n(data.feedZones)) extras.push(n(data.feedZones) + ' ravito' + (n(data.feedZones) > 1 ? 's' : ''));
      if (data.weather && data.weather.enabled && data.weather.snapshot) extras.push('météo');
      if (n(data.surfaces)) extras.push('revêtements');
      if (n(data.winds)) extras.push('vent');
      return { title: fmt(km, 1) + ' km' + (up === null ? '' : ' · D+ ' + fmt(up) + ' m'), detail: extras.join(' · ') || 'Tracé seul' };
    }
    if (kind === 'athlete') {
      const r = data && data.rider;
      if (!r) return null;
      const w = Number(r.weight), ftp = Number(r.ftp);
      const parts = [];
      if (w) parts.push(fmt(w, 1) + ' kg');
      if (ftp) parts.push('FTP ' + fmt(ftp) + ' W');
      if (w && ftp) parts.push(fmt(ftp / w, 2) + ' W/kg');
      return { title: r.name || 'Athlète sans nom', detail: parts.join(' · ') };
    }
    if (kind === 'bike') {
      const b = data && data.bike;
      if (!b) return null;
      const shop = (data.shop) || {};
      const frame = (C && shop.frame && C.get('frame', shop.frame)) ? C.get('frame', shop.frame).name : short(labelOf(P.FRAMES, b.frame));
      const wheels = (C && shop.wheels && C.get('wheels', shop.wheels)) ? C.get('wheels', shop.wheels).name : short(labelOf(P.WHEELS, b.wheels));
      const mass = Number(b.weight) + (Number(b.load) || 0);
      return { title: [frame, wheels].filter(Boolean).join(' · ') || 'Vélo', detail: [mass ? fmt(mass, 1) + ' kg avec la charge' : '', short(labelOf(P.TIRES, b.tire))].filter(Boolean).join(' · ') };
    }
    if (kind === 'outfit') {
      const r = data && data.rider;
      if (!r) return null;
      return { title: short(labelOf(P.POSITIONS, r.position)) || 'Position', detail: [short(labelOf(P.HELMETS, r.helmet)), short(labelOf(P.CLOTHING, r.clothing))].filter(Boolean).join(' · ') };
    }
    return null;
  }

  PYR.library = { STORAGE_KEY, KINDS, empty, normalize, extract, apply, newAthlete, defaultRouteName, defaultAthleteName, startRoute, add, findByName, save, find, rename, remove, merge, summary, routeLength, routeAscent, routeProfile };
})(globalThis.PYR = globalThis.PYR || {});
