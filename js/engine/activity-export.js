/* author : Hugo Joudrier-Faure */
/* PaceYourRide — export de la sortie réalisée dans les formats des sites et compteurs : FIT (Garmin Connect, Strava, Wahoo, TrainingPeaks,
 * Zwift…), TCX, GPX et CSV. Un point par seconde, avec position, altitude, distance, vitesse, puissance, cardio et cadence (quand ils
 * étaient mesurés), plus ce que seul PaceYourRide calcule : W′bal et glycogène dépensé / restant.
 *  - FIT : champs standards (record) + champs développeur « W′bal », « Glycogene depense », « Glycogene restant » (lus par les
 *    logiciels qui les prennent en charge ; ignorés sans dommage par les autres) ;
 *  - TCX et GPX : extensions standards (Garmin TPX / gpxtpx / gpxpx) + espace de noms pyr: pour les valeurs propres à l'application ;
 *  - CSV : toutes les colonnes, pour un tableur.
 * Sans DOM (testable). */
(function (PYR) {
  'use strict';

  const U = PYR.util;
  const FIT_EPOCH = 631065600;   // s : 31/12/1989 00:00 UTC, origine des dates FIT
  const NS_PYR = 'https://paceyourride.app/xmlschemas/v1';

  const FORMATS = [
    { id: 'fit', ext: 'fit', label: 'FIT', mime: 'application/octet-stream', hint: 'Garmin Connect, Strava, Wahoo, TrainingPeaks, Zwift… : le plus complet (W′ et glycogène en champs développeur)' },
    { id: 'tcx', ext: 'tcx', label: 'TCX', mime: 'application/vnd.garmin.tcx+xml', hint: 'Garmin Connect, Strava, TrainingPeaks, Golden Cheetah…' },
    { id: 'gpx', ext: 'gpx', label: 'GPX', mime: 'application/gpx+xml', hint: 'Strava, Komoot, Garmin Connect, la plupart des sites et applications' },
    { id: 'csv', ext: 'csv', label: 'CSV', mime: 'text/csv;charset=utf-8', hint: 'Un tableur : toutes les valeurs, une ligne par seconde' },
  ];

  const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '');

  /* ======================================================================
   * Données : une ligne par seconde
   * ====================================================================== */

  /**
   * La sortie en colonnes, prête à écrire. Le point k est l'état à la fin de la seconde k : son heure est départ + k + 1 s, de sorte que la
   * durée du fichier est celle de la sortie. { n, startMs, time(k) (ms), T (traces de la séance), hasHr, hasCad, sum (bilan) }.
   */
  function prepare(sess) {
    const T = sess.track(), n = T.n, startMs = sess.startMs;
    let hasHr = false, hasCad = false;
    let sumP = 0, maxP = 0, sumHr = 0, nHr = 0, maxHr = 0, sumCad = 0, nCad = 0, maxCad = 0, maxV = 0;
    for (let k = 0; k < n; k++) {
      const p = T.P[k]; sumP += p; if (p > maxP) maxP = p;
      if (T.hr[k] > 0) { hasHr = true; sumHr += T.hr[k]; nHr++; if (T.hr[k] > maxHr) maxHr = T.hr[k]; }
      if (T.cad[k] > 0) { hasCad = true; sumCad += T.cad[k]; nCad++; if (T.cad[k] > maxCad) maxCad = T.cad[k]; }
      if (T.v[k] > maxV) maxV = T.v[k];
    }
    // dénivelé : cumul des variations de plus de 3 m (filtre de l'altitude)
    let up = 0, down = 0;
    if (n) {
      let ref = T.ele[0];
      for (let k = 1; k < n; k++) {
        const e = T.ele[k];
        if (e - ref >= 3) { up += e - ref; ref = e; } else if (ref - e >= 3) { down += ref - e; ref = e; }
      }
    }
    let wMin = Infinity;
    for (let k = 0; k < n; k++) if (T.wbal[k] < wMin) wMin = T.wbal[k];
    const kJ = sumP / 1000;
    const sum = {
      distance: n ? T.s[n - 1] : 0, seconds: n, avgSpeed: n ? (T.s[n - 1] / n) : 0, maxSpeed: maxV,
      avgPower: n ? sumP / n : 0, maxPower: maxP, work: kJ, kcal: Math.round(kJ / (4.184 * 0.24)),
      avgHr: nHr ? sumHr / nHr : 0, maxHr, avgCad: nCad ? sumCad / nCad : 0, maxCad,
      ascent: up, descent: down, wMin: n ? wMin : T.w0, w0: T.w0,
      gBurned: n ? T.gBurned[n - 1] : 0, gStock: n ? T.gStock[n - 1] : T.g0, g0: T.g0,
    };
    return { n, startMs, time: (k) => startMs + (k + 1) * 1000, T, hasHr, hasCad, sum };
  }

  /* ======================================================================
   * GPX
   * ====================================================================== */

  /**
   * GPX : <power> et l'extension de puissance Garmin (gpxpx), cardio et cadence (gpxtpx) s'ils étaient mesurés, puis vitesse, W′bal et
   * glycogène dans l'espace pyr:.
   */
  function gpx(sess, name) {
    const d = prepare(sess), T = d.T, title = xml(name || 'Sortie PaceYourRide');
    const ns = ['xmlns="http://www.topografix.com/GPX/1/1"', 'xmlns:gpxpx="http://www.garmin.com/xmlschemas/PowerExtension/v1"', `xmlns:pyr="${NS_PYR}"`];
    if (d.hasHr || d.hasCad) ns.push('xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"');
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<gpx version="1.1" creator="PaceYourRide" ${ns.join(' ')}>`,
      `  <metadata><name>${title}</name><time>${iso(d.startMs)}</time></metadata>`,
      `  <trk><name>${title}</name><type>cycling</type><trkseg>`,
    ];
    for (let k = 0; k < d.n; k++) {
      const p = Math.round(T.P[k]);
      const tp = T.hr[k] > 0 || T.cad[k] > 0
        ? `<gpxtpx:TrackPointExtension>${T.hr[k] > 0 ? `<gpxtpx:hr>${T.hr[k]}</gpxtpx:hr>` : ''}${T.cad[k] > 0 ? `<gpxtpx:cad>${Math.round(T.cad[k])}</gpxtpx:cad>` : ''}</gpxtpx:TrackPointExtension>` : '';
      lines.push(`    <trkpt lat="${T.lat[k].toFixed(6)}" lon="${T.lng[k].toFixed(6)}"><ele>${T.ele[k].toFixed(1)}</ele><time>${iso(d.time(k))}</time>`
        + `<extensions><power>${p}</power><gpxpx:PowerExtension><gpxpx:PowerInWatts>${p}</gpxpx:PowerInWatts></gpxpx:PowerExtension>${tp}`
        + `<pyr:speed>${f(T.v[k], 2)}</pyr:speed><pyr:distance>${f(T.s[k], 1)}</pyr:distance><pyr:wbal>${Math.round(T.wbal[k])}</pyr:wbal>`
        + `<pyr:glycogenBurned>${f(T.gBurned[k], 2)}</pyr:glycogenBurned><pyr:glycogenStock>${f(T.gStock[k], 1)}</pyr:glycogenStock></extensions></trkpt>`);
    }
    lines.push('  </trkseg></trk>', '</gpx>');
    return lines.join('\n');
  }

  /* ======================================================================
   * TCX
   * ====================================================================== */

  /** TCX (Garmin Training Center) : un tour, une trace d'un point par seconde, vitesse et puissance en extension TPX. */
  function tcx(sess, name) {
    const d = prepare(sess), T = d.T, S = d.sum;
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xmlns:pyr="${NS_PYR}">`,
      '  <Activities>',
      `    <Activity Sport="Biking"><Id>${iso(d.startMs)}</Id>`,
      `      <Lap StartTime="${iso(d.startMs)}"><TotalTimeSeconds>${d.n}</TotalTimeSeconds><DistanceMeters>${f(S.distance, 1)}</DistanceMeters>`
      + `<MaximumSpeed>${f(S.maxSpeed, 2)}</MaximumSpeed><Calories>${S.kcal}</Calories>`
      + (d.hasHr ? `<AverageHeartRateBpm><Value>${Math.round(S.avgHr)}</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>${S.maxHr}</Value></MaximumHeartRateBpm>` : '')
      + '<Intensity>Active</Intensity>' + (d.hasCad ? `<Cadence>${Math.round(S.avgCad)}</Cadence>` : '') + '<TriggerMethod>Manual</TriggerMethod>',
      '        <Track>',
    ];
    for (let k = 0; k < d.n; k++) {
      lines.push(`          <Trackpoint><Time>${iso(d.time(k))}</Time><Position><LatitudeDegrees>${T.lat[k].toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${T.lng[k].toFixed(6)}</LongitudeDegrees></Position>`
        + `<AltitudeMeters>${T.ele[k].toFixed(1)}</AltitudeMeters><DistanceMeters>${f(T.s[k], 1)}</DistanceMeters>`
        + (T.hr[k] > 0 ? `<HeartRateBpm><Value>${T.hr[k]}</Value></HeartRateBpm>` : '')
        + (d.hasCad ? `<Cadence>${Math.round(T.cad[k])}</Cadence>` : '')
        + `<Extensions><ns3:TPX><ns3:Speed>${f(T.v[k], 2)}</ns3:Speed><ns3:Watts>${Math.round(T.P[k])}</ns3:Watts></ns3:TPX>`
        + `<pyr:WPrimeBalance>${Math.round(T.wbal[k])}</pyr:WPrimeBalance><pyr:GlycogenBurned>${f(T.gBurned[k], 2)}</pyr:GlycogenBurned><pyr:GlycogenStock>${f(T.gStock[k], 1)}</pyr:GlycogenStock></Extensions></Trackpoint>`);
    }
    lines.push('        </Track>',
      `        <Notes>${xml(name || 'Sortie PaceYourRide')}</Notes>`,
      `        <Extensions><ns3:LX><ns3:AvgSpeed>${f(S.avgSpeed, 2)}</ns3:AvgSpeed><ns3:AvgWatts>${Math.round(S.avgPower)}</ns3:AvgWatts><ns3:MaxWatts>${Math.round(S.maxPower)}</ns3:MaxWatts></ns3:LX></Extensions>`,
      '      </Lap>', '    </Activity>', '  </Activities>', '</TrainingCenterDatabase>');
    return lines.join('\n');
  }

  /* ======================================================================
   * CSV
   * ====================================================================== */

  const CSV_COLUMNS = ['temps_s', 'heure_utc', 'latitude', 'longitude', 'altitude_m', 'distance_m', 'vitesse_kmh', 'puissance_w', 'consigne_w',
    'cardio_bpm', 'cadence_tr_min', 'wprime_j', 'wprime_pct', 'glycogene_depense_g', 'glycogene_restant_g'];

  /** CSV (séparateur « , », point décimal) : une ligne par seconde. */
  function csv(sess) {
    const d = prepare(sess), T = d.T;
    const lines = [CSV_COLUMNS.join(',')];
    for (let k = 0; k < d.n; k++) {
      lines.push([k + 1, iso(d.time(k)), f(T.lat[k], 6), f(T.lng[k], 6), f(T.ele[k], 1), f(T.s[k], 1), f(T.v[k] * 3.6, 2), Math.round(T.P[k]), T.target[k] || '',
        T.hr[k] > 0 ? T.hr[k] : '', d.hasCad ? Math.round(T.cad[k]) : '', Math.round(T.wbal[k]), f(T.w0 > 0 ? T.wbal[k] / T.w0 * 100 : NaN, 1),
        f(T.gBurned[k], 2), f(T.gStock[k], 1)].join(','));
    }
    return lines.join('\n') + '\n';
  }

  /* ======================================================================
   * FIT
   * ====================================================================== */

  // types de base FIT : [identifiant, taille, valeur invalide]
  const BT = {
    enum: [0x00, 1, 0xFF], u8: [0x02, 1, 0xFF], s32: [0x85, 4, 0x7FFFFFFF], u16: [0x84, 2, 0xFFFF], u32: [0x86, 4, 0xFFFFFFFF], u32z: [0x8C, 4, 0],
    f32: [0x88, 4, 0xFFFFFFFF], str: [0x07, 1, 0], bytes: [0x0D, 1, 0xFF],
  };
  const sizeOf = (fd) => (fd.type === 'str' || fd.type === 'bytes' ? fd.size : BT[fd.type][1]);

  /**
   * Écrit un fichier FIT. entries : [{ def: { num, fields: [{ id, type, size }], dev: [{ id, type, devIndex }] }, rows: [[valeurs des champs, puis des champs
   * développeur]] }] ; la définition d'un message est écrite à sa première apparition, les lignes d'une même définition peuvent venir en plusieurs
   * fois. Une valeur null est écrite « invalide ».
   */
  function encodeFit(entries) {
    const body = [];
    const enc = new TextEncoder();
    const dv = new DataView(new ArrayBuffer(8));
    const locals = new Map();
    const put = (fd, v) => {
      const t = fd.type, size = sizeOf(fd);
      if (t === 'str') {
        let b = v === null || v === undefined ? [] : Array.from(enc.encode(String(v)));
        if (b.length > size - 1) {
          b = b.slice(0, size - 1);
          while (b.length && (b[b.length - 1] & 0xC0) === 0x80) b.pop();
          if (b.length && b[b.length - 1] >= 0xC0) b.pop();
        }
        while (b.length < size) b.push(0);
        for (const x of b) body.push(x);
      } else if (t === 'bytes') {
        for (let i = 0; i < size; i++) body.push(v && v[i] !== undefined ? v[i] & 255 : 0xFF);
      } else if (t === 'f32') {
        if (v === null || v === undefined || !Number.isFinite(v)) { body.push(255, 255, 255, 255); return; }
        dv.setFloat32(0, v, true);
        for (let i = 0; i < 4; i++) body.push(dv.getUint8(i));
      } else {
        let x = v === null || v === undefined || !Number.isFinite(v) ? BT[t][2] : Math.round(v);
        if (t === 's32' && x < 0) x += 4294967296;
        for (let i = 0; i < size; i++) { body.push(x % 256); x = Math.floor(x / 256); }
      }
    };
    for (const e of entries) {
      const def = e.def, dev = def.dev || [];
      let local = locals.get(def);
      if (local === undefined) {
        local = locals.size;
        if (local > 15) throw new Error('Trop de messages FIT différents');
        locals.set(def, local);
        body.push(0x40 | (dev.length ? 0x20 : 0) | local, 0, 0, def.num & 255, (def.num >> 8) & 255, def.fields.length);
        for (const fd of def.fields) body.push(fd.id, sizeOf(fd), BT[fd.type][0]);
        if (dev.length) { body.push(dev.length); for (const fd of dev) body.push(fd.id, sizeOf(fd), fd.devIndex || 0); }
      }
      for (const row of e.rows) {
        body.push(local);
        def.fields.forEach((fd, i) => put(fd, row[i]));
        dev.forEach((fd, i) => put(fd, row[def.fields.length + i]));
      }
    }
    const crc16 = PYR.planWorkout.crc16;
    const out = new Uint8Array(14 + body.length + 2);
    const h = new DataView(out.buffer);
    out[0] = 14; out[1] = 0x20; h.setUint16(2, 2100, true); h.setUint32(4, body.length, true);
    out.set([0x2E, 0x46, 0x49, 0x54], 8);                         // « .FIT »
    h.setUint16(12, crc16(out, 0, 0, 12), true);
    out.set(body, 14);
    h.setUint16(14 + body.length, crc16(out, 0, 0, 14 + body.length), true);
    return out;
  }

  const semi = (deg) => (Number.isFinite(deg) ? Math.round(deg * 2147483648 / 180) : null);   // degrés → demi-cercles
  const fitTime = (ms) => Math.max(0, Math.floor(ms / 1000) - FIT_EPOCH);
  const clamp16 = (x) => Math.max(0, Math.min(65534, Math.round(x)));
  const clamp8 = (x) => Math.max(0, Math.min(254, Math.round(x)));

  // champs développeur de chaque point : [numéro, nom, unité]
  const DEV_FIELDS = [[0, 'W prime balance', 'J'], [1, 'Glycogen burned', 'g'], [2, 'Glycogen remaining', 'g']];

  /** FIT d'activité : fichier, événements début/fin, un point par seconde, un tour, la séance et l'activité. */
  function fit(sess, name) {
    const d = prepare(sess), T = d.T, S = d.sum, n = d.n;
    const t0 = fitTime(d.startMs), t1 = fitTime(d.startMs + n * 1000);
    const lat0 = n ? semi(T.lat[0]) : null, lng0 = n ? semi(T.lng[0]) : null;
    const ms = (x) => Math.round(x * 1000), cm = (x) => Math.round(x * 100);
    const fileId = { num: 0, fields: [{ id: 0, type: 'enum' }, { id: 1, type: 'u16' }, { id: 2, type: 'u16' }, { id: 3, type: 'u32z' }, { id: 4, type: 'u32' }, { id: 8, type: 'str', size: 24 }] };
    const devData = { num: 207, fields: [{ id: 0, type: 'bytes', size: 16 }, { id: 1, type: 'bytes', size: 16 }, { id: 2, type: 'u16' }, { id: 3, type: 'u8' }, { id: 4, type: 'u32' }] };
    const devDesc = { num: 206, fields: [{ id: 0, type: 'u8' }, { id: 1, type: 'u8' }, { id: 2, type: 'u8' }, { id: 3, type: 'str', size: 32 }, { id: 8, type: 'str', size: 8 }] };
    const event = { num: 21, fields: [{ id: 253, type: 'u32' }, { id: 0, type: 'enum' }, { id: 1, type: 'enum' }, { id: 4, type: 'u8' }] };
    const record = {
      num: 20,
      fields: [{ id: 253, type: 'u32' }, { id: 0, type: 's32' }, { id: 1, type: 's32' }, { id: 2, type: 'u16' }, { id: 3, type: 'u8' }, { id: 4, type: 'u8' },
        { id: 5, type: 'u32' }, { id: 6, type: 'u16' }, { id: 7, type: 'u16' }],
      dev: DEV_FIELDS.map(([id]) => ({ id, type: 'f32', devIndex: 0 })),
    };
    const lap = {
      num: 19,
      fields: [{ id: 254, type: 'u16' }, { id: 253, type: 'u32' }, { id: 0, type: 'enum' }, { id: 1, type: 'enum' }, { id: 2, type: 'u32' }, { id: 3, type: 's32' }, { id: 4, type: 's32' },
        { id: 7, type: 'u32' }, { id: 8, type: 'u32' }, { id: 9, type: 'u32' }, { id: 11, type: 'u16' }, { id: 13, type: 'u16' }, { id: 14, type: 'u16' }, { id: 15, type: 'u8' },
        { id: 16, type: 'u8' }, { id: 17, type: 'u8' }, { id: 18, type: 'u8' }, { id: 19, type: 'u16' }, { id: 20, type: 'u16' }, { id: 21, type: 'u16' }, { id: 22, type: 'u16' }, { id: 25, type: 'enum' }],
    };
    const session = {
      num: 18,
      fields: [{ id: 254, type: 'u16' }, { id: 253, type: 'u32' }, { id: 0, type: 'enum' }, { id: 1, type: 'enum' }, { id: 2, type: 'u32' }, { id: 3, type: 's32' }, { id: 4, type: 's32' },
        { id: 5, type: 'enum' }, { id: 6, type: 'enum' }, { id: 7, type: 'u32' }, { id: 8, type: 'u32' }, { id: 9, type: 'u32' }, { id: 11, type: 'u16' }, { id: 14, type: 'u16' },
        { id: 15, type: 'u16' }, { id: 16, type: 'u8' }, { id: 17, type: 'u8' }, { id: 18, type: 'u8' }, { id: 19, type: 'u8' }, { id: 20, type: 'u16' }, { id: 21, type: 'u16' },
        { id: 22, type: 'u16' }, { id: 23, type: 'u16' }, { id: 25, type: 'u16' }, { id: 26, type: 'u16' }],
    };
    const activity = { num: 34, fields: [{ id: 253, type: 'u32' }, { id: 0, type: 'u32' }, { id: 1, type: 'u16' }, { id: 2, type: 'enum' }, { id: 3, type: 'enum' }, { id: 4, type: 'enum' }] };

    const rows = [];
    for (let k = 0; k < n; k++) {
      rows.push([fitTime(d.time(k)), semi(T.lat[k]), semi(T.lng[k]), clamp16((T.ele[k] + 500) * 5), T.hr[k] > 0 ? clamp8(T.hr[k]) : null, d.hasCad ? clamp8(T.cad[k]) : null,
        cm(T.s[k]), clamp16(T.v[k] * 1000), clamp16(T.P[k]), T.wbal[k], T.gBurned[k], T.gStock[k]]);
    }
    const hrOrNull = (x) => (x > 0 ? clamp8(x) : null);
    const lapRow = [0, t1, 9, 1, t0, lat0, lng0, ms(n), ms(n), cm(S.distance), S.kcal, clamp16(S.avgSpeed * 1000), clamp16(S.maxSpeed * 1000), hrOrNull(S.avgHr), hrOrNull(S.maxHr),
      d.hasCad ? clamp8(S.avgCad) : null, d.hasCad ? clamp8(S.maxCad) : null, clamp16(S.avgPower), clamp16(S.maxPower), clamp16(S.ascent), clamp16(S.descent), 2];
    const entries = [
      { def: fileId, rows: [[4, 255, 0, 1, t0, 'PaceYourRide']] },
      { def: devData, rows: [[Array.from(new TextEncoder().encode('PaceYourRide')), Array.from(new TextEncoder().encode('PaceYourRide.activity')), 255, 0, 1]] },
      { def: devDesc, rows: DEV_FIELDS.map(([id, nm, unit]) => [0, id, 0x88, nm, unit]) },
      { def: event, rows: [[t0, 0, 0, null]] },                                   // début du chronomètre
      { def: record, rows },
      { def: event, rows: [[t1, 0, 4, null]] },                                   // arrêt
      { def: lap, rows: [lapRow] },
      { def: session, rows: [[0, t1, 8, 1, t0, lat0, lng0, 2, 7, ms(n), ms(n), cm(S.distance), S.kcal, clamp16(S.avgSpeed * 1000), clamp16(S.maxSpeed * 1000), hrOrNull(S.avgHr), hrOrNull(S.maxHr),
        d.hasCad ? clamp8(S.avgCad) : null, d.hasCad ? clamp8(S.maxCad) : null, clamp16(S.avgPower), clamp16(S.maxPower), clamp16(S.ascent), clamp16(S.descent), 0, 1]] },
      { def: activity, rows: [[t1, ms(n), 1, 0, 26, 1]] },
    ];
    // le nom de la sortie : champ 8 du fichier (product_name)
    entries[0].rows[0][5] = name || 'Sortie PaceYourRide';
    return encodeFit(entries);
  }

  /* ======================================================================
   * Interface
   * ====================================================================== */

  const pad = (x) => String(x).padStart(2, '0');

  /** Nom de fichier : sortie-AAAA-MM-JJ-HHMM.ext (heure locale du départ). */
  function filename(startMs, ext) {
    const d = new Date(startMs);
    return `sortie-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
  }

  /** Fichier d'une sortie dans un format : { filename, mime, data (texte ou Uint8Array), format }. */
  function build(sess, id, name) {
    const fmt = FORMATS.find((x) => x.id === id);
    if (!fmt) throw new Error('Format inconnu : ' + id);
    const data = id === 'fit' ? fit(sess, name) : id === 'tcx' ? tcx(sess, name) : id === 'gpx' ? gpx(sess, name) : csv(sess);
    return { filename: filename(sess.startMs, fmt.ext), mime: fmt.mime, data, format: fmt };
  }

  PYR.activityExport = { FORMATS, DEV_FIELDS, CSV_COLUMNS, prepare, gpx, tcx, csv, fit, encodeFit, build, filename };
})(globalThis.PYR = globalThis.PYR || {});
