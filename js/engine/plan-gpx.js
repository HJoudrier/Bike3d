/* author : Hugo Joudrier-Faure */
/* PaceYourRide — export du plan optimal en GPX pour un compteur vélo : la trace du parcours (altitude et heure
 * de passage prévue à chaque point) et, le long du parcours, un point de repère par tronçon à puissance
 * constante (« 250 W »), placé là où il faut changer d'allure. Les compteurs affichent ces repères à l'approche
 * (points de parcours Garmin, repères Wahoo) ; la description donne la plage de kilomètres, la pente et la durée.
 * Le plan seconde par seconde est simplifié en tronçons : fenêtres de WINDOW m, regroupées tant que la puissance
 * reste à moins de `tol` W de la moyenne du tronçon (au plus MAX_SECTIONS tronçons). */
(function (PYR) {
  'use strict';

  const U = PYR.util;

  const WINDOW = 250;       // m : finesse du découpage
  const TOL = 10;           // W : écart toléré dans un tronçon
  const MAX_SECTIONS = 100; // les compteurs limitent le nombre de repères
  const MAX_POINTS = 8000;  // points de trace conservés
  const ROUND = 5;          // W : arrondi de la puissance affichée

  const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

  /** Instant (s) où le plan passe à la distance s (m). */
  function timeAt(plan, s) {
    const S = plan.series.s, L = plan.inputs.length;
    if (s >= L) return plan.tFinish;
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid] <= s) lo = mid; else hi = mid; }
    const d = S[hi] - S[lo];
    return Math.min(plan.tFinish, lo + (d > 0 ? (s - S[lo]) / d : 0));
  }

  /** Puissance moyenne (W) du plan entre les instants t0 et t1 (s). */
  function meanPower(plan, t0, t1) {
    const P = plan.series.P;
    let sum = 0, w = 0;
    for (let t = Math.floor(t0); t < t1 && t < P.length; t++) {
      const d = Math.min(t + 1, t1) - Math.max(t, t0);
      if (d > 0) { sum += P[t] * d; w += d; }
    }
    return w > 0 ? sum / w : P[Math.min(P.length - 1, Math.max(0, Math.floor(t0)))] || 0;
  }

  /** Tronçons délimités à la main : cuts = distances (m) des limites ; les doublons et les limites hors du parcours sont ignorés. */
  function fromCuts(plan, cuts) {
    const L = plan.inputs.length;
    const bounds = [0, ...Array.from(new Set(cuts.map((c) => Math.round(c)).filter((c) => c > 0 && c < L))).sort((x, y) => x - y), L];
    const out = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const a = bounds[i], b = bounds[i + 1], t0 = timeAt(plan, a), t1 = timeAt(plan, b);
      out.push({
        a, b, t0, t1, P: meanPower(plan, t0, t1),
        grade: (PYR.course.eleAt(plan.course, b) - PYR.course.eleAt(plan.course, a)) / Math.max(1, b - a),
      });
    }
    return out;
  }

  /** Tronçons à puissance constante : [{ a, b (m), P (W moyens), t0, t1 (s), grade }]. opts.cuts : limites choisies (distances en m)
   * à la place du découpage automatique. */
  function sections(plan, opts) {
    if (opts && Array.isArray(opts.cuts)) return fromCuts(plan, opts.cuts);
    const o = Object.assign({ window: WINDOW, tol: TOL, max: MAX_SECTIONS }, opts);
    const S = plan.series, L = plan.inputs.length, n = S.P.length;
    const nb = Math.max(1, Math.ceil(L / o.window));
    const sum = new Float64Array(nb), cnt = new Float64Array(nb);
    for (let t = 0; t < n; t++) {
      const k = Math.min(nb - 1, Math.floor(S.s[t] / o.window));
      sum[k] += S.P[t]; cnt[k]++;
    }
    // fenêtres sans seconde de plan (passées en moins d'une seconde) : même puissance que la précédente
    const avg = new Float64Array(nb);
    for (let k = 0; k < nb; k++) avg[k] = cnt[k] ? sum[k] / cnt[k] : k ? avg[k - 1] : S.P[0] || 0;
    let tol = o.tol, groups;
    for (;;) {
      groups = [];
      let g = null;
      for (let k = 0; k < nb; k++) {
        if (g && Math.abs(avg[k] - g.sum / g.cnt) <= tol) { g.sum += sum[k]; g.cnt += cnt[k]; g.end = k + 1; }
        else groups.push(g = { start: k, end: k + 1, sum: sum[k], cnt: cnt[k] });
        if (!g.cnt) { g.sum = avg[k]; g.cnt = 1; }
      }
      if (groups.length <= o.max) break;
      tol *= 1.5;
    }
    return groups.map((g) => {
      const a = g.start * o.window, b = Math.min(L, g.end * o.window);
      return {
        a, b, P: g.sum / g.cnt, t0: timeAt(plan, a), t1: timeAt(plan, b),
        grade: (PYR.course.eleAt(plan.course, b) - PYR.course.eleAt(plan.course, a)) / Math.max(1, b - a),
      };
    });
  }

  /** GPX du plan. opts : { name, start (ms, heure de départ affichée dans la trace) }. */
  function build(plan, opts) {
    const o = opts || {};
    const name = o.name || 'Plan PaceYourRide', start = Number.isFinite(o.start) ? o.start : Date.now();
    const course = plan.course, L = plan.inputs.length;
    const secs = sections(plan, { cuts: o.cuts });
    const km = (m) => U.fmt(m / 1000, 1);
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="PaceYourRide" xmlns="http://www.topografix.com/GPX/1/1">',
      `  <metadata><name>${xml(name)}</name><desc>${xml(`Plan optimal : ${U.fmtDuration(plan.tFinish)} pour ${km(L)} km. Un repère par tronçon à puissance constante.`)}</desc><time>${iso(start)}</time></metadata>`,
    ];
    // repères de puissance, au début de chaque tronçon puis à l'arrivée
    const wpt = (s, t, label, desc) => {
      const ll = PYR.course.latLngAt(course, s);
      lines.push(`  <wpt lat="${ll[0].toFixed(6)}" lon="${ll[1].toFixed(6)}"><ele>${PYR.course.eleAt(course, s).toFixed(1)}</ele><time>${iso(start + t * 1000)}</time>`
        + `<name>${xml(label)}</name><cmt>${xml(desc)}</cmt><desc>${xml(desc)}</desc><type>Generic</type></wpt>`);
    };
    for (const g of secs) {
      const P = Math.round(g.P / ROUND) * ROUND;
      wpt(g.a, g.t0, `${P} W`, `Km ${km(g.a)} → ${km(g.b)} : ${P} W · pente ${U.fmt(g.grade * 100, 1)} % · ${U.fmtClock(g.t1 - g.t0)}`);
    }
    wpt(L, plan.tFinish, 'Arrivée', `Km ${km(L)} · temps prévu ${U.fmtDuration(plan.tFinish)}`);
    // trace : points du parcours, avec l'heure de passage prévue
    lines.push(`  <trk><name>${xml(name)}</name><trkseg>`);
    const step = course.step, last = Math.floor(L / step);
    const stride = Math.max(1, Math.ceil(last / MAX_POINTS));
    const pt = (s) => {
      const ll = PYR.course.latLngAt(course, s);
      lines.push(`    <trkpt lat="${ll[0].toFixed(6)}" lon="${ll[1].toFixed(6)}"><ele>${PYR.course.eleAt(course, s).toFixed(1)}</ele><time>${iso(start + timeAt(plan, s) * 1000)}</time></trkpt>`);
    };
    for (let i = 0; i <= last; i += stride) pt(i * step);
    if ((last % stride) !== 0 || last * step < L) pt(L);
    lines.push('  </trkseg></trk>', '</gpx>');
    return { gpx: lines.join('\n'), sections: secs };
  }

  /** TCX (parcours Garmin) du plan : un tour (« lap ») par tronçon avec son temps et sa distance, la trace datée, et un point de
   * parcours au début de chaque tronçon dont les notes donnent la puissance cible, la vitesse moyenne et le temps du tronçon.
   * opts : { name, start (ms) }. */
  function buildTcx(plan, opts) {
    const o = opts || {};
    const name = o.name || 'Plan PaceYourRide', start = Number.isFinite(o.start) ? o.start : Date.now();
    const course = plan.course, L = plan.inputs.length;
    const secs = sections(plan, { cuts: o.cuts });
    const km = (m) => U.fmt(m / 1000, 1);
    const pos = (s) => { const ll = PYR.course.latLngAt(course, s); return `<LatitudeDegrees>${ll[0].toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${ll[1].toFixed(6)}</LongitudeDegrees>`; };
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">',
      '  <Courses><Course>',
      `    <Name>${xml(name.slice(0, 15))}</Name>`,
    ];
    const info = secs.map((g) => {
      const dt = Math.max(1e-6, g.t1 - g.t0), P = Math.round(g.P / ROUND) * ROUND;
      return { g, P, dt, kmh: (g.b - g.a) / dt * 3.6 };
    });
    for (const { g, dt } of info) {
      lines.push('    <Lap>',
        `      <TotalTimeSeconds>${dt.toFixed(1)}</TotalTimeSeconds><DistanceMeters>${(g.b - g.a).toFixed(1)}</DistanceMeters>`,
        `      <BeginPosition>${pos(g.a)}</BeginPosition><EndPosition>${pos(g.b)}</EndPosition>`,
        '      <Intensity>Active</Intensity>', '    </Lap>');
    }
    // trace : points du parcours, avec l'heure de passage prévue
    lines.push('    <Track>');
    const step = course.step, last = Math.floor(L / step);
    const stride = Math.max(1, Math.ceil(last / MAX_POINTS));
    const pt = (s) => lines.push(`      <Trackpoint><Time>${iso(start + timeAt(plan, s) * 1000)}</Time><Position>${pos(s)}</Position>`
      + `<AltitudeMeters>${PYR.course.eleAt(course, s).toFixed(1)}</AltitudeMeters><DistanceMeters>${s.toFixed(1)}</DistanceMeters></Trackpoint>`);
    for (let i = 0; i <= last; i += stride) pt(i * step);
    if ((last % stride) !== 0 || last * step < L) pt(L);
    lines.push('    </Track>');
    // points de parcours : un par tronçon (nom court affiché par le compteur, détail en notes), puis l'arrivée
    const cp = (s, t, label, notes) => lines.push('    <CoursePoint>',
      `      <Name>${xml(label.slice(0, 10))}</Name><Time>${iso(start + t * 1000)}</Time><Position>${pos(s)}</Position>`,
      `      <AltitudeMeters>${PYR.course.eleAt(course, s).toFixed(1)}</AltitudeMeters><PointType>Generic</PointType><Notes>${xml(notes)}</Notes>`,
      '    </CoursePoint>');
    for (const { g, P, dt, kmh } of info) {
      cp(g.a, g.t0, `${P} W`, `Km ${km(g.a)} → ${km(g.b)} (${U.fmt((g.b - g.a) / 1000, 1)} km) · cible ${P} W · moy. ${U.fmt(kmh, 1)} km/h · ${U.fmtClock(dt)} · pente ${U.fmt(g.grade * 100, 1)} %`);
    }
    cp(L, plan.tFinish, 'Arrivée', `Km ${km(L)} · temps prévu ${U.fmtDuration(plan.tFinish)} · moy. ${U.fmt(L / Math.max(1e-6, plan.tFinish) * 3.6, 1)} km/h`);
    lines.push('  </Course></Courses>', '</TrainingCenterDatabase>');
    return { tcx: lines.join('\n'), sections: secs };
  }

  PYR.planGpx = { build, buildTcx, sections, timeAt, meanPower };
})(globalThis.PYR = globalThis.PYR || {});
