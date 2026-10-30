/* author : Hugo Joudrier-Faure */
/* PaceYourRide — parcours complet en fichier : un GPX enrichi.
 * C'est un GPX 1.1 ordinaire, que toute appli lit : la trace (les tronçons tels que calculés, altitude comprise) et des
 * points (sprints intermédiaires, sommets des côtes classées, zones de ravitaillement). Il emporte en plus, dans une
 * extension <pyr:route>, tout ce que la page Parcours enregistre : nom, mode de tracé, points de passage et découpage en
 * tronçons (pour retrouver un tracé modifiable), sprints et côtes, ravitaillements, revêtements, vent, météo, largeur de
 * route. Cette extension est du JSON (seuls &, < et > sont échappés). Fonctions pures, sans DOM : la lecture du XML est
 * faite par services.parseGpx, qui rend la trace et l'extension. */
(function (PYR) {
  'use strict';

  const U = PYR.util;
  const NS = 'https://paceyourride.fr/xmlns/route/1';
  const VERSION = 1;
  const KEYS = ['surfaces', 'winds', 'feedZones', 'checkpoints', 'weather', 'road'];   // avec `route` : ce que la bibliothèque garde d'un parcours

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const attr = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const text = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const isPt = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;

  /** Points de la trace [lat, lng, ele | null] et fin de chaque tronçon (indice de son dernier point), comme les concatène le profil. */
  function trackOf(route) {
    const pts = [], legs = [];
    if (route.fixed) {
      const g = route.fixed;
      for (let i = 0; i < g.n; i++) pts.push([g.lat[i] / 1e6, g.lng[i] / 1e6, g.ele[i] / 100]);
      return { pts, legs, fixed: true };
    }
    route.legs.forEach((l, k) => {
      if (!l.coords || l.coords.length < 2) throw new Error('Le tracé n\'est pas encore calculé');
      for (let i = k === 0 ? 0 : 1; i < l.coords.length; i++) pts.push(l.coords[i]);
      legs.push({ mode: l.mode, to: pts.length - 1 });
    });
    return { pts, legs, fixed: false };
  }

  /** Point du profil le plus proche de la distance s (m). */
  function at(profile, s) {
    const i = U.clamp(Math.round(s / profile.step), 0, profile.n - 1);
    return { lat: profile.lat[i], lng: profile.lng[i], ele: profile.ele[i] };
  }

  /** Résumé du contenu : « 2 sprints, 3 côtes classées, 1 ravitaillement, météo personnalisée ». */
  function summary(d) {
    const bits = [];
    const n = (list, one, many) => { const k = Array.isArray(list) ? list.length : 0; if (k) bits.push(`${k} ${k > 1 ? many : one}`); };
    const cps = Array.isArray(d.checkpoints) ? d.checkpoints : [];
    n(cps.filter((c) => c && c.type === 'sprint'), 'sprint', 'sprints');
    n(cps.filter((c) => c && c.type === 'kom'), 'côte classée', 'côtes classées');
    n(d.feedZones, 'ravitaillement', 'ravitaillements');
    n(d.surfaces, 'portion de revêtement', 'portions de revêtement');
    n(d.winds, 'portion de vent', 'portions de vent');
    const w = d.weather, c = w && w.custom;
    if (c && ((Array.isArray(c.temp) && c.temp.length) || (Array.isArray(c.rain) && c.rain.length))) bits.push('météo personnalisée');
    if (w && w.source !== 'custom' && w.snapshot) bits.push('prévisions météo');
    return bits.join(', ');
  }

  /**
   * Texte du GPX enrichi du parcours du projet `state` (store.state), dont le profil est `profile` (store.profile) ;
   * now : date de l'export (tests).
   */
  function build(state, profile, now) {
    const r = state.route;
    if (!profile) throw new Error('Aucun parcours à exporter');
    const name = String(r.name || '').trim().slice(0, 60) || 'Parcours PaceYourRide';
    const tr = trackOf(r);
    const data = { app: 'PaceYourRide', kind: 'route', version: VERSION, route: { name, mode: r.mode } };
    if (tr.fixed) data.route.fixed = { step: r.fixed.step };
    else {
      data.route.waypoints = r.waypoints.map((w) => ({ lat: +(+w.lat).toFixed(6), lng: +(+w.lng).toFixed(6) }));
      data.route.legs = tr.legs;
    }
    for (const k of KEYS) if (state[k] !== undefined) data[k] = clone(state[k]);

    const Cl = PYR.classif, s = profile.stats;
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<gpx version="1.1" creator="PaceYourRide" xmlns="http://www.topografix.com/GPX/1/1" xmlns:pyr="${NS}">`,
      '  <metadata>',
      `    <name>${text(name)}</name>`,
      `    <desc>${text([`${U.fmt(s.length / 1000, 1)} km, D+ ${U.fmt(s.up, 0)} m, D− ${U.fmt(s.down, 0)} m`, summary(data)].filter(Boolean).join(' · '))}</desc>`,
      `    <time>${new Date(now || Date.now()).toISOString()}</time>`,
      '  </metadata>',
    ];
    const wpt = (p, title, desc, sym, type) => {
      lines.push(`  <wpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"><ele>${(+p.ele).toFixed(1)}</ele><name>${text(title)}</name>`
        + (desc ? `<desc>${text(desc)}</desc>` : '') + `<sym>${sym}</sym><type>${type}</type></wpt>`);
    };
    const cps = Cl.fromList(state.checkpoints, profile);
    for (const cp of cps) {
      if (cp.type === 'sprint') wpt(at(profile, cp.s), Cl.longLabel(cp, cps), '', 'Flag, Green', 'sprint');
      else if (cp.type === 'kom') wpt(at(profile, cp.s), Cl.longLabel(cp, cps), Cl.climbText(cp), 'Summit', 'kom');
    }
    (state.feedZones || []).forEach((z, i) => {
      if (z.startKm * 1000 > profile.length) return;
      wpt(at(profile, z.startKm * 1000), `Ravitaillement n°${i + 1}`, `km ${U.fmt(z.startKm, 1)} → ${U.fmt(z.endKm, 1)}`, 'Restaurant', 'feed');
    });
    lines.push(`  <trk><name>${text(name)}</name><type>cycling</type><trkseg>`);
    const dec = tr.fixed ? 2 : 1;      // parcours figé : altitudes au centimètre, pour retrouver sa géométrie exacte
    for (const p of tr.pts) {
      const e = p[2] === null || p[2] === undefined || !Number.isFinite(+p[2]) ? '' : `<ele>${(+p[2]).toFixed(dec)}</ele>`;
      lines.push(`    <trkpt lat="${(+p[0]).toFixed(6)}" lon="${(+p[1]).toFixed(6)}">${e}</trkpt>`);
    }
    lines.push('  </trkseg></trk>');
    lines.push(`  <extensions><pyr:route version="${VERSION}">${text(JSON.stringify(data))}</pyr:route></extensions>`);
    lines.push('</gpx>');
    return lines.join('\n');
  }

  /**
   * Parcours relu d'un GPX enrichi : parsed = {name, points: [[lat, lng, ele | null]…], data (contenu de l'extension, ou null)}.
   * Renvoie ce qu'il faut recopier dans le projet ({route, surfaces, winds, …}, à vérifier par le store), ou null si le fichier
   * n'est pas un parcours PaceYourRide (simple trace). Si le découpage en tronçons ne correspond pas à la trace, elle devient
   * un seul tronçon.
   */
  function restore(parsed) {
    const d = parsed && parsed.data;
    if (!d || typeof d !== 'object' || d.app !== 'PaceYourRide' || d.kind !== 'route') return null;
    const pts = (parsed.points || []).filter(isPt).map((p) => [+p[0], +p[1], p[2] === null || p[2] === undefined || !Number.isFinite(+p[2]) ? null : +p[2]]);
    if (pts.length < 2) throw new Error('Aucune trace trouvée dans le GPX');
    const r = d.route && typeof d.route === 'object' ? d.route : {};
    const modes = PYR.services ? PYR.services.ROUTING_MODES.map((m) => m.id) : null;
    const route = {
      name: String(r.name || parsed.name || '').trim().slice(0, 60),
      mode: !modes || modes.includes(r.mode) ? String(r.mode || 'fastbike') : 'fastbike',
      fixed: null, waypoints: [], legs: [],
    };
    const ll = (p) => ({ lat: p[0], lng: p[1] });
    const last = pts.length - 1;
    if (r.fixed && Number(r.fixed.step) > 0) {
      route.fixed = {
        n: pts.length, step: Number(r.fixed.step),
        lat: pts.map((p) => Math.round(p[0] * 1e6)), lng: pts.map((p) => Math.round(p[1] * 1e6)), ele: pts.map((p) => Math.round((p[2] || 0) * 100)),
      };
      route.waypoints = [ll(pts[0]), ll(pts[last])];
    } else {
      const wps = Array.isArray(r.waypoints) ? r.waypoints : [], legs = Array.isArray(r.legs) ? r.legs : [];
      let prev = 0;
      const ok = legs.length >= 1 && wps.length === legs.length + 1 && legs.length <= pts.length
        && wps.every((w) => w && isPt([+w.lat, +w.lng]))
        && legs.every((l, k) => { const to = l && l.to; const good = Number.isInteger(to) && to > prev && (k < legs.length - 1 || to === last); prev = to; return good; });
      if (ok) {
        route.waypoints = wps.map((w) => ({ lat: +w.lat, lng: +w.lng }));
        let from = 0;
        legs.forEach((l, k) => {
          const mode = l.mode === 'gpx' || !modes || modes.includes(l.mode) ? String(l.mode) : 'gpx';
          route.legs.push({ from: route.waypoints[k], to: route.waypoints[k + 1], mode, coords: pts.slice(from, l.to + 1), status: 'ok' });
          from = l.to;
        });
      } else {
        route.waypoints = [ll(pts[0]), ll(pts[last])];
        route.legs = [{ from: route.waypoints[0], to: route.waypoints[1], mode: 'gpx', coords: pts, status: 'ok' }];
      }
    }
    const out = { route };
    for (const k of KEYS) if (d[k] !== undefined && d[k] !== null) out[k] = clone(d[k]);
    return out;
  }

  PYR.routeFile = { NS, VERSION, build, restore, summary };
})(globalThis.PYR = globalThis.PYR || {});
