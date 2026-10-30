/* author : Hugo Joudrier-Faure */
/* PaceYourRide — services web gratuits et sans clé :
 *   - routage vélo : BRouter (brouter.de, altitude incluse), repli OSRM vélo (routing.openstreetmap.de) ;
 *   - altitude : Open-Meteo Elevation API (Copernicus DEM 90 m) ;
 *   - météo : Open-Meteo, prévisions horaires en plusieurs points du parcours ;
 *   - géocodage : Photon (komoot), repli Nominatim ;
 *   - GPX : lecture / écriture. */
(function (PYR) {
  'use strict';

  const U = PYR.util;

  // short : libellé du sélecteur posé sur la carte (onglet Parcours)
  const ROUTING_MODES = [
    { id: 'fastbike', short: 'Route', label: 'Suivre les routes — vélo de route', engine: 'brouter', profile: 'fastbike' },
    { id: 'lowtraffic', short: 'Peu de trafic', label: 'Suivre les routes — peu de trafic', engine: 'brouter', profile: 'fastbike-lowtraffic' },
    { id: 'trekking', short: 'Gravel', label: 'Suivre routes et chemins — mixte / gravel', engine: 'brouter', profile: 'trekking' },
    { id: 'straight', short: 'Ligne droite', label: 'Ligne droite (hors routes)', engine: 'straight' },
  ];

  const TIMEOUT = 20000;

  async function fetchJson(url, opts) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(id);
    }
  }

  /* ---------- Routage ---------- */
  async function routeBrouter(a, b, profile) {
    const url = `https://brouter.de/brouter?lonlats=${a.lng.toFixed(6)},${a.lat.toFixed(6)}|${b.lng.toFixed(6)},${b.lat.toFixed(6)}` +
      `&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson`;
    const data = await fetchJson(url);
    const f = data && data.features && data.features[0];
    if (!f || !f.geometry || !f.geometry.coordinates || f.geometry.coordinates.length < 2) throw new Error('Pas d\'itinéraire');
    return f.geometry.coordinates.map((c) => [c[1], c[0], c.length > 2 && isFinite(c[2]) ? c[2] : null]);
  }

  async function routeOsrm(a, b) {
    const url = `https://routing.openstreetmap.de/routed-bike/route/v1/driving/${a.lng.toFixed(6)},${a.lat.toFixed(6)};${b.lng.toFixed(6)},${b.lat.toFixed(6)}` +
      '?overview=full&geometries=geojson';
    const data = await fetchJson(url);
    const r = data && data.routes && data.routes[0];
    if (!r || !r.geometry || r.geometry.coordinates.length < 2) throw new Error('Pas d\'itinéraire');
    return r.geometry.coordinates.map((c) => [c[1], c[0], null]);
  }

  function straight(a, b) {
    return [[a.lat, a.lng, null], [b.lat, b.lng, null]];
  }

  /**
   * Tronçon entre deux points selon le mode. Renvoie {coords, mode, fallback}.
   * En cas d'échec du routage, repli sur OSRM puis sur la ligne droite.
   */
  async function route(a, b, modeId) {
    const mode = ROUTING_MODES.find((m) => m.id === modeId) || ROUTING_MODES[0];
    if (mode.engine === 'straight') return { coords: straight(a, b), mode: 'straight' };
    try {
      return { coords: await routeBrouter(a, b, mode.profile), mode: mode.id };
    } catch (e1) {
      try {
        return { coords: await routeOsrm(a, b), mode: mode.id, fallback: 'osrm' };
      } catch (e2) {
        return { coords: straight(a, b), mode: 'straight', fallback: 'straight', error: e2.message || e1.message };
      }
    }
  }

  /* ---------- Densification ---------- */
  /** Ajoute des points pour qu'aucun segment ne dépasse maxStep mètres. */
  function densify(coords, maxStep) {
    const out = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
      const p = coords[i - 1], q = coords[i];
      const d = U.haversine(p[0], p[1], q[0], q[1]);
      const n = Math.floor(d / maxStep);
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        const e = p[2] !== null && q[2] !== null ? p[2] + (q[2] - p[2]) * t : null;
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, e]);
      }
      out.push(q);
    }
    return out;
  }

  /* ---------- Altitude ---------- */
  const elevationCache = new Map();
  const cacheKey = (lat, lng) => lat.toFixed(5) + ',' + lng.toFixed(5);

  async function elevationBatch(points) {
    const lat = points.map((p) => p[0].toFixed(5)).join(',');
    const lng = points.map((p) => p[1].toFixed(5)).join(',');
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await fetchJson(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
        if (!data || !Array.isArray(data.elevation)) throw new Error('Réponse altitude invalide');
        return data.elevation;
      } catch (e) {
        lastErr = e;
        await U.sleep(800 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  /** Complète les altitudes manquantes (null) d'une liste de points [lat, lng, ele]. */
  async function fillElevations(coords, onProgress) {
    const missing = [];
    for (let i = 0; i < coords.length; i++) {
      if (coords[i][2] !== null && coords[i][2] !== undefined) continue;
      const k = cacheKey(coords[i][0], coords[i][1]);
      if (elevationCache.has(k)) coords[i][2] = elevationCache.get(k);
      else missing.push(i);
    }
    const BATCH = 100;
    let done = 0;
    const batches = [];
    for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));
    const worker = async () => {
      while (batches.length) {
        const idx = batches.shift();
        const ele = await elevationBatch(idx.map((i) => coords[i]));
        idx.forEach((i, j) => {
          const e = Number.isFinite(ele[j]) ? ele[j] : null;
          coords[i][2] = e;
          if (e !== null) elevationCache.set(cacheKey(coords[i][0], coords[i][1]), e);
        });
        done += idx.length;
        if (onProgress) onProgress(done / missing.length);
      }
    };
    await Promise.all([worker(), worker()]);
    return coords;
  }

  /* ---------- Météo ---------- */
  const WEATHER_VARS = 'temperature_2m,relative_humidity_2m,pressure_msl,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
  const WEATHER_PAST_DAYS = 90, WEATHER_FUTURE_DAYS = 15; // Open-Meteo : jusqu'à 92 jours en arrière et 16 en avant

  /**
   * Prévisions horaires aux stations du parcours (cf. weather.js stationsFor) pour un départ à startAtLocal
   * (« 2026-10-12T08:30 », heure locale du départ). Renvoie l'instantané météo {v, start, t0, n, stations, T, rh, p, rain, ws, wd, gust}
   * et le décalage UTC du lieu de départ (s). now : date du jour (tests).
   */
  async function fetchWeather(stations, startAtLocal, now) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}/.exec(String(startAtLocal || ''));
    if (!m) throw new Error('Indique d\'abord la date et l\'heure de départ.');
    const day = Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
    const today = Math.floor((now === undefined ? Date.now() : now) / 86400000);
    if (day < today - WEATHER_PAST_DAYS || day > today + WEATHER_FUTURE_DAYS) {
      throw new Error(`Les prévisions couvrent de ${WEATHER_PAST_DAYS} jours en arrière à ${WEATHER_FUTURE_DAYS} jours en avant : choisis une date dans cette plage.`);
    }
    const iso = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
    // un jour de marge de chaque côté : l'heure saisie est locale, les heures reçues sont en temps unix
    const url = 'https://api.open-meteo.com/v1/forecast?' +
      `latitude=${stations.map((s) => s.lat.toFixed(4)).join(',')}&longitude=${stations.map((s) => s.lng.toFixed(4)).join(',')}` +
      `&hourly=${WEATHER_VARS}&wind_speed_unit=ms&timeformat=unixtime&timezone=auto&start_date=${iso(day - 1)}&end_date=${iso(day + 1)}`;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await fetchJson(url);
        const list = Array.isArray(data) ? data : [data];
        if (!list[0] || !list[0].hourly) throw new Error('Réponse météo invalide');
        const offset = Number(list[0].utc_offset_seconds) || 0;
        const start = PYR.weather.localToEpoch(startAtLocal, offset);
        return { snapshot: PYR.weather.fromApi(list, stations, start, { off: offset }), utcOffset: offset };
      } catch (e) {
        lastErr = e;
        if (/prévision|incompl|invalide|incohér/.test(e.message)) break; // inutile de réessayer
        await U.sleep(800 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  /* ---------- Géocodage ---------- */
  async function geocode(q) {
    try {
      const data = await fetchJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=fr`);
      const res = (data.features || []).map((f) => {
        const p = f.properties || {};
        const sub = [p.city && p.city !== p.name ? p.city : null, p.state, p.country].filter(Boolean).join(', ');
        return { label: p.name || q, sub, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
      });
      if (res.length) return res;
    } catch (e) { /* repli ci-dessous */ }
    const data = await fetchJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=fr&q=${encodeURIComponent(q)}`);
    return (data || []).map((r) => {
      const parts = String(r.display_name || '').split(',');
      return { label: parts[0], sub: parts.slice(1, 4).join(',').trim(), lat: +r.lat, lng: +r.lon };
    });
  }

  /* ---------- GPX ---------- */
  function parseGpx(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Fichier GPX illisible');
    let nodes = Array.from(doc.getElementsByTagName('trkpt'));
    if (!nodes.length) nodes = Array.from(doc.getElementsByTagName('rtept'));
    if (!nodes.length) nodes = Array.from(doc.getElementsByTagName('wpt'));
    const points = [];
    let hasEle = false;
    for (const n of nodes) {
      const lat = parseFloat(n.getAttribute('lat')), lng = parseFloat(n.getAttribute('lon'));
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const eNode = n.getElementsByTagName('ele')[0];
      const e = eNode ? parseFloat(eNode.textContent) : NaN;
      if (isFinite(e)) hasEle = true;
      points.push([lat, lng, isFinite(e) ? e : null]);
    }
    if (points.length < 2) throw new Error('Aucune trace trouvée dans le GPX');
    const nameNode = doc.querySelector('trk > name, rte > name, metadata > name');
    // parcours complet exporté par PaceYourRide (js/core/route-file.js) : sprints, côtes, ravitaillements, météo… dans une extension
    const ext = doc.getElementsByTagNameNS(PYR.routeFile.NS, 'route')[0];
    let data = null;
    if (ext) { try { data = JSON.parse(ext.textContent); } catch (e) { /* extension illisible : simple trace */ } }
    return { name: nameNode ? nameNode.textContent.trim() : '', points, hasEle, data };
  }

  const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

  function toGpx(name, lat, lng, ele, n) {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="PaceYourRide" xmlns="http://www.topografix.com/GPX/1/1">',
      `  <metadata><name>${xmlEscape(name)}</name></metadata>`,
      `  <trk><name>${xmlEscape(name)}</name><trkseg>`,
    ];
    for (let i = 0; i < n; i++) {
      lines.push(`    <trkpt lat="${lat[i].toFixed(6)}" lon="${lng[i].toFixed(6)}"><ele>${ele[i].toFixed(1)}</ele></trkpt>`);
    }
    lines.push('  </trkseg></trk>', '</gpx>');
    return lines.join('\n');
  }

  /** Simplification Douglas-Peucker (tolérance en mètres) — renvoie les indices conservés. */
  function simplifyIdx(points, tol) {
    const n = points.length;
    if (n <= 2) return points.map((_, i) => i);
    const lat0 = points[0][0];
    const kx = 111320 * Math.cos(U.toRad(lat0)), ky = 110540;
    const xy = points.map((p) => [p[1] * kx, p[0] * ky]);
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = xy[a], [bx, by] = xy[b];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const t = U.clamp(((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / len2, 0, 1);
        const ex = ax + t * dx - xy[i][0], ey = ay + t * dy - xy[i][1];
        const d = ex * ex + ey * ey;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (idx > 0 && maxD > tol * tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
    return out;
  }

  PYR.services = { ROUTING_MODES, route, densify, fillElevations, fetchWeather, geocode, parseGpx, toGpx, simplifyIdx };
})(globalThis.PYR = globalThis.PYR || {});
