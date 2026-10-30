/* author : Hugo Joudrier-Faure */
/* PaceYourRide — modèle du tracé : points de passage, tronçons routés, profil altimétrique. */
(function (PYR) {
  'use strict';

  const U = PYR.util, S = PYR.services, store = PYR.store;
  const STEP = 10;          // pas du profil (m)
  const MAX_HISTORY = 40;

  const history = [];      // états d'avant chaque modification (Annuler)
  const future = [];       // états annulés (Rétablir), vidés à la modification suivante
  let pending = 0;
  let status = { text: '', error: false };

  const route = () => store.state.route;
  const ll = (p) => ({ lat: +p.lat, lng: +p.lng });

  function setStatus(text, error) {
    status = { text, error: !!error };
    store.emit('route-status', status);
  }

  const current = () => ({ waypoints: route().waypoints.slice(), legs: route().legs.slice(), fixed: route().fixed || null, name: route().name });

  function snapshot() {
    history.push(current());
    if (history.length > MAX_HISTORY) history.shift();
    future.length = 0;
  }

  /** Revient à l'état h (annuler ou rétablir) ; un parcours effacé retrouve aussi son nom. */
  function restoreState(h) {
    route().waypoints = h.waypoints;
    route().legs = h.legs;
    route().fixed = h.fixed || null;
    if (!route().name && h.name) route().name = h.name;
    computeMissing();
    changed();
  }

  /** Remplace le tracé par une suite de points [lat, lng, ele] (géométrie conservée, points de passage simplifiés). */
  function buildFromPoints(points) {
    const pts = points.filter((p, i, a) => i === 0 || U.haversine(a[i - 1][0], a[i - 1][1], p[0], p[1]) > 0.5);
    let tol = 150, idx = S.simplifyIdx(pts, tol);
    while (idx.length > 30) { tol *= 1.5; idx = S.simplifyIdx(pts, tol); }
    const r = route();
    r.waypoints = idx.map((i) => ({ lat: pts[i][0], lng: pts[i][1] }));
    r.legs = [];
    for (let k = 0; k < idx.length - 1; k++) {
      r.legs.push({ from: r.waypoints[k], to: r.waypoints[k + 1], mode: 'gpx', coords: pts.slice(idx[k], idx[k + 1] + 1).map((c) => c.slice()), status: 'ok' });
    }
  }

  /**
   * Un parcours de défi est « figé » (profil canonique, identique chez tous les joueurs).
   * Toute modification le transforme d'abord en tracé ordinaire modifiable.
   */
  function unlockFixed() {
    const r = route();
    if (!r.fixed) return false;
    const p = PYR.raceData.geometryProfile(r.fixed);
    const pts = [];
    for (let i = 0; i < p.n; i++) pts.push([p.lat[i], p.lng[i], p.ele[i]]);
    r.fixed = null;
    buildFromPoints(pts);
    return true;
  }

  function newLeg(from, to, mode) {
    return { from: ll(from), to: ll(to), mode: mode || route().mode, coords: null, status: 'pending' };
  }

  /** Complète les altitudes : on interroge l'API sur un sous-ensemble (≥ 40 m d'écart), le reste est interpolé. */
  async function completeElevations(coords) {
    if (!coords.some((c) => c[2] === null || c[2] === undefined)) return coords;
    const idx = [0];
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      acc += U.haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
      if (acc >= 40 || i === coords.length - 1) { idx.push(i); acc = 0; }
    }
    const sub = idx.map((i) => [coords[i][0], coords[i][1], coords[i][2] === undefined ? null : coords[i][2]]);
    await S.fillElevations(sub);
    idx.forEach((i, j) => { if (coords[i][2] === null || coords[i][2] === undefined) coords[i][2] = sub[j][2]; });
    interpolateMissing(coords);
    return coords;
  }

  /** Interpole linéairement (en distance) les altitudes manquantes. */
  function interpolateMissing(coords) {
    const n = coords.length;
    const d = new Float64Array(n);
    for (let i = 1; i < n; i++) d[i] = d[i - 1] + U.haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    let prev = -1;
    for (let i = 0; i < n; i++) {
      if (coords[i][2] === null || coords[i][2] === undefined || !isFinite(coords[i][2])) continue;
      if (prev >= 0 && i - prev > 1) {
        for (let k = prev + 1; k < i; k++) {
          const t = (d[k] - d[prev]) / Math.max(1e-9, d[i] - d[prev]);
          coords[k][2] = coords[prev][2] + (coords[i][2] - coords[prev][2]) * t;
        }
      } else if (prev < 0 && i > 0) {
        for (let k = 0; k < i; k++) coords[k][2] = coords[i][2];
      }
      prev = i;
    }
    if (prev >= 0) for (let k = prev + 1; k < n; k++) coords[k][2] = coords[prev][2];
    return prev >= 0;
  }

  /** Calcule (asynchrone) un tronçon, puis le remplace dans la liste s'il y est toujours. */
  function computeLeg(leg) {
    pending++;
    refreshStatus();
    (async () => {
      let res;
      if (leg.mode === 'gpx' && leg.coords) res = { coords: leg.coords.map((c) => c.slice()), mode: 'gpx' };
      else res = await S.route(leg.from, leg.to, leg.mode === 'gpx' ? route().mode : leg.mode);
      let coords = res.coords;
      let eleError = null;
      if (coords.some((c) => c[2] === null || c[2] === undefined)) {
        if (res.mode === 'straight' || res.fallback) coords = S.densify(coords, 40);
        try { await completeElevations(coords); } catch (e) { eleError = e; }
      }
      const legs = route().legs;
      const idx = legs.indexOf(leg);
      if (idx < 0) return;
      legs[idx] = Object.assign({}, leg, {
        coords,
        mode: res.fallback === 'straight' ? 'straight' : leg.mode,
        status: 'ok',
        eleMissing: !!eleError || coords.some((c) => c[2] === null || c[2] === undefined),
      });
      if (res.fallback === 'straight') PYR.dom.toast('Itinéraire introuvable (service indisponible ?) : tronçon tracé en ligne droite.', 'error');
      else if (res.fallback === 'osrm') PYR.dom.toast('BRouter indisponible : tronçon calculé avec OSRM.');
      if (eleError) PYR.dom.toast('Altitude indisponible pour une partie du parcours (service Open-Meteo injoignable).', 'error');
      store.emit('route-geometry');
    })().catch((e) => {
      console.error(e);
      setStatus('Erreur de calcul du tronçon : ' + e.message, true);
    }).finally(() => {
      pending--;
      refreshStatus();
      if (pending === 0) rebuildProfile();
    });
  }

  function refreshStatus() {
    if (pending > 0) setStatus(`Calcul de l'itinéraire et de l'altitude… (${pending} tronçon${pending > 1 ? 's' : ''})`);
    else if (!status.error) setStatus('');
  }

  /** Relance le calcul des tronçons sans géométrie (après annulation notamment). */
  function computeMissing() {
    for (const leg of route().legs) if (!leg.coords && leg.status !== 'computing') computeLeg(leg);
  }

  function changed() {
    store.emit('route-geometry');
    store.save();
    if (pending === 0) rebuildProfile();
  }

  const M = {
    STEP,
    get status() { return status; },
    get pending() { return pending; },

    add(p) {
      snapshot();
      unlockFixed();
      const wps = route().waypoints;
      if (!wps.length && !route().name) route().name = PYR.library.defaultRouteName();      // nouveau parcours : nommé d'après sa date de création
      wps.push(ll(p));
      if (wps.length >= 2) {
        const leg = newLeg(wps[wps.length - 2], wps[wps.length - 1]);
        route().legs.push(leg);
        computeLeg(leg);
      }
      changed();
    },

    /** Insère un point sur le tronçon legIndex (entre les points legIndex et legIndex+1). */
    insert(legIndex, p) {
      snapshot();
      if (unlockFixed()) legIndex = M.nearestLeg(p);
      if (legIndex < 0) return;
      const wps = route().waypoints, legs = route().legs;
      const old = legs[legIndex];
      wps.splice(legIndex + 1, 0, ll(p));
      const mode = old && old.mode !== 'gpx' ? old.mode : route().mode;
      const l1 = newLeg(wps[legIndex], wps[legIndex + 1], mode), l2 = newLeg(wps[legIndex + 1], wps[legIndex + 2], mode);
      legs.splice(legIndex, 1, l1, l2);
      computeLeg(l1); computeLeg(l2);
      changed();
    },

    move(i, p) {
      snapshot();
      if (unlockFixed()) i = i === 0 ? 0 : route().waypoints.length - 1;
      const wps = route().waypoints, legs = route().legs;
      wps[i] = ll(p);
      if (i > 0) { const l = newLeg(wps[i - 1], wps[i], legs[i - 1].mode === 'gpx' ? route().mode : legs[i - 1].mode); legs[i - 1] = l; computeLeg(l); }
      if (i < wps.length - 1) { const l = newLeg(wps[i], wps[i + 1], legs[i].mode === 'gpx' ? route().mode : legs[i].mode); legs[i] = l; computeLeg(l); }
      changed();
    },

    remove(i) {
      snapshot();
      if (unlockFixed()) i = i === 0 ? 0 : route().waypoints.length - 1;
      const wps = route().waypoints, legs = route().legs;
      if (wps.length <= 1) { wps.length = 0; legs.length = 0; changed(); return; }
      if (i === 0) { wps.shift(); legs.shift(); }
      else if (i === wps.length - 1) { wps.pop(); legs.pop(); }
      else {
        const mode = legs[i - 1].mode === 'gpx' ? route().mode : legs[i - 1].mode;
        wps.splice(i, 1);
        const l = newLeg(wps[i - 1], wps[i], mode);
        legs.splice(i - 1, 2, l);
        computeLeg(l);
      }
      changed();
    },

    clear() {
      if (!route().waypoints.length && !route().fixed) return;
      snapshot();
      route().fixed = null;
      route().name = '';
      route().waypoints.length = 0;
      route().legs.length = 0;
      setStatus('');
      changed();
    },

    undo() {
      const h = history.pop();
      if (!h) { PYR.dom.toast('Rien à annuler'); return; }
      future.push(current());
      restoreState(h);
    },

    redo() {
      const h = future.pop();
      if (!h) { PYR.dom.toast('Rien à rétablir'); return; }
      history.push(current());
      restoreState(h);
    },

    get canUndo() { return history.length > 0; },
    get canRedo() { return future.length > 0; },

    loop() {
      const wps = route().waypoints;
      if (wps.length < 2) return;
      M.add(Object.assign({}, wps[0]));
    },

    reverse() {
      const r = route();
      if (r.waypoints.length < 2) return;
      snapshot();
      unlockFixed();
      r.waypoints = r.waypoints.slice().reverse();
      r.legs = r.legs.slice().reverse().map((l) => Object.assign({}, l, {
        from: l.to, to: l.from, coords: l.coords ? l.coords.slice().reverse() : null,
      }));
      computeMissing();
      changed();
    },

    setMode(mode) { route().mode = mode; store.save(); },

    /** Remplace le tracé par une trace GPX (géométrie conservée, points de passage simplifiés). */
    importGpx(parsed) {
      snapshot();
      const r = route();
      r.fixed = null;
      r.name = String(parsed.name || '').trim().slice(0, 60) || PYR.library.defaultRouteName();
      buildFromPoints(parsed.points);
      if (!parsed.hasEle) {
        // altitude absente du fichier : on la demande au service
        r.legs = r.legs.map((l) => Object.assign({}, l, { coords: l.coords.map((c) => [c[0], c[1], null]), status: 'pending' }));
        r.legs.forEach(computeLeg);
      }
      changed();
    },

    /** Indice du tronçon le plus proche d'un point (pour l'insertion). */
    nearestLeg(p) {
      let best = -1, bestD = Infinity;
      route().legs.forEach((leg, i) => {
        const c = leg.coords || [[leg.from.lat, leg.from.lng], [leg.to.lat, leg.to.lng]];
        for (let k = 0; k < c.length; k++) {
          const d = U.haversine(p.lat, p.lng, c[k][0], c[k][1]);
          if (d < bestD) { bestD = d; best = i; }
        }
      });
      return best;
    },

    /** Charge un parcours canonique (défi, course en direct) : il ne sera pas re-lissé. */
    setFixed(geometry) {
      snapshot();
      const r = route();
      const p = PYR.raceData.geometryProfile(geometry);
      if (!r.name) r.name = PYR.library.defaultRouteName();
      r.fixed = { n: geometry.n, step: geometry.step, lat: geometry.lat.slice(), lng: geometry.lng.slice(), ele: geometry.ele.slice() };
      r.waypoints = [{ lat: p.lat[0], lng: p.lng[0] }, { lat: p.lat[p.n - 1], lng: p.lng[p.n - 1] }];
      r.legs = [];
      setStatus('');
      changed();
    },

    get isFixed() { return !!route().fixed; },

    computeMissing,
    rebuildProfile,
    interpolateMissing,
  };

  /** Concatène les tronçons, rééchantillonne tous les ~10 m, lisse l'altitude, calcule les statistiques. */
  function rebuildProfile() {
    const fixed = route().fixed;
    if (fixed) {
      const p = PYR.raceData.geometryProfile(fixed);
      store.profile = Object.assign(p, { eleRaw: p.ele, eleMissing: false, fixed: true }, profileStats(p.ele, p.step, p.n));
      store.emit('profile', store.profile);
      return;
    }
    const legs = route().legs;
    if (!legs.length || legs.some((l) => !l.coords || l.coords.length < 2)) {
      store.profile = null;
      store.emit('profile', null);
      return;
    }
    const pts = [];
    legs.forEach((l, k) => {
      for (let i = k === 0 ? 0 : 1; i < l.coords.length; i++) pts.push(l.coords[i]);
    });
    // distances cumulées (on supprime les points confondus)
    const lat = [], lng = [], ele = [], dist = [];
    let d = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) {
        const dd = U.haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
        if (dd < 0.05) continue;
        d += dd;
      }
      lat.push(pts[i][0]); lng.push(pts[i][1]); ele.push(pts[i][2]); dist.push(d);
    }
    const L = d;
    if (L < 30) {
      store.profile = null;
      store.emit('profile', null);
      return;
    }
    const tmp = lat.map((_, i) => [lat[i], lng[i], ele[i]]);
    const hasEle = interpolateMissing(tmp);
    const eleMissing = !hasEle || legs.some((l) => l.eleMissing);

    const n = Math.round(L / STEP) + 1;
    const step = L / (n - 1);
    const pLat = new Float64Array(n), pLng = new Float64Array(n), raw = new Float32Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const x = i * step;
      while (j < dist.length - 2 && dist[j + 1] < x) j++;
      const span = dist[j + 1] - dist[j];
      const t = span > 0 ? U.clamp((x - dist[j]) / span, 0, 1) : 0;
      pLat[i] = tmp[j][0] + (tmp[j + 1][0] - tmp[j][0]) * t;
      pLng[i] = tmp[j][1] + (tmp[j + 1][1] - tmp[j][1]) * t;
      raw[i] = hasEle ? tmp[j][2] + (tmp[j + 1][2] - tmp[j][2]) * t : 0;
    }
    const smooth = movingAverage(movingAverage(raw, 3), 3);
    store.profile = Object.assign({ n, step, length: L, lat: pLat, lng: pLng, ele: smooth, eleRaw: raw, eleMissing }, profileStats(smooth, step, n));
    store.emit('profile', store.profile);
  }

  /** Statistiques de dénivelé et montées principales. */
  function profileStats(ele, step, n) {
    let up = 0, down = 0, emin = Infinity, emax = -Infinity, gmax = -Infinity, gmin = Infinity;
    for (let i = 0; i < n; i++) {
      if (i > 0) { const de = ele[i] - ele[i - 1]; if (de > 0) up += de; else down -= de; }
      if (ele[i] < emin) emin = ele[i];
      if (ele[i] > emax) emax = ele[i];
    }
    const w = Math.max(1, Math.round(100 / step));
    for (let i = 0; i + w < n; i += 1) {
      const g = (ele[i + w] - ele[i]) / (w * step);
      if (g > gmax) gmax = g;
      if (g < gmin) gmin = g;
    }
    const L = step * (n - 1);
    return {
      stats: { length: L, up, down, emin, emax, gmax: n > w ? gmax : 0, gmin: n > w ? gmin : 0, waypoints: route().waypoints.length },
      climbs: PYR.classif.findClimbs(ele, step), // avec leur catégorie (grand prix de la montagne)
    };
  }

  /** Moyenne glissante centrée (demi-largeur h points). */
  function movingAverage(a, h) {
    const n = a.length, out = new Float32Array(n), pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - h), hi = Math.min(n - 1, i + h);
      out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
    }
    return out;
  }

  PYR.routeModel = M;
})(globalThis.PYR = globalThis.PYR || {});
