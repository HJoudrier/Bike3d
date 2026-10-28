/* author : Hugo Joudrier-Faure */
/* PaceYourRide — export du plan optimal en entraînement structuré, à suivre sur un compteur ou un logiciel d'entraînement :
 *  - FIT (Garmin Edge, Wahoo, Karoo…) : une étape par tronçon, de longueur en mètres, avec une plage de puissance cible en watts ;
 *    le compteur affiche la cible et prévient quand on en sort. Les notes de l'étape donnent km, vitesse moyenne et temps ;
 *  - ZWO (Zwift, Rouvy…) et MRC (TrainerRoad, Golden Cheetah…) : étapes de durée donnée, en % de la PMA/FTP (ces formats
 *    n'ont pas de durée en distance : on prend le temps prévu du tronçon).
 * Les tronçons sont ceux de l'export GPX (plan-gpx.js), en nombre limité par ce que les compteurs acceptent. */
(function (PYR) {
  'use strict';

  const U = PYR.util;

  const FIT_MAX_STEPS = 50;   // les compteurs Garmin limitent le nombre d'étapes d'un entraînement
  const TOL_PCT = 0.05;       // plage de puissance cible : ± 5 % autour de la puissance du tronçon
  const ROUND = 5;            // W : arrondi de la puissance affichée
  const FIT_EPOCH = 631065600; // s : 31/12/1989 00:00 UTC, origine des dates FIT

  const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const km = (m) => U.fmt(m / 1000, 1);

  /** Libellé détaillé d'un tronçon : km, puissance, vitesse moyenne, temps. */
  function describe(g) {
    const dt = Math.max(1e-6, g.t1 - g.t0), P = Math.round(g.P / ROUND) * ROUND;
    return {
      P, dt, kmh: (g.b - g.a) / dt * 3.6,
      text: `Km ${km(g.a)} > ${km(g.b)} | ${P} W | ${U.fmt((g.b - g.a) / dt * 3.6, 1)} km/h | ${U.fmtClock(dt)} | pente ${U.fmt(g.grade * 100, 1)} %`,
    };
  }

  // ---------- FIT ----------

  const CRC_T = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
  function crc16(bytes, crc, from, to) {
    crc = crc || 0;
    for (let i = from || 0; i < (to === undefined ? bytes.length : to); i++) {
      const b = bytes[i];
      let tmp = CRC_T[crc & 0xF];
      crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ CRC_T[b & 0xF];
      tmp = CRC_T[crc & 0xF];
      crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ CRC_T[(b >> 4) & 0xF];
    }
    return crc;
  }

  // types de base FIT : enum, uint16, uint32, uint32z, chaîne
  const T = { enum: 0x00, u16: 0x84, u32: 0x86, u32z: 0x8C, str: 0x07 };
  const SIZE = { 0x00: 1, 0x84: 2, 0x86: 4, 0x8C: 4 };

  /** Écrit un fichier FIT. messages : [{ num, fields: [{ id, type, size (chaînes), value }] }] ; une définition par message. */
  function encodeFit(messages) {
    const body = [];
    const u16 = (v) => body.push(v & 255, (v >> 8) & 255);
    const u32 = (v) => body.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
    const enc = new TextEncoder();
    messages.forEach((m, k) => {
      const local = Math.min(k, 15) & 0x0F; // un type local par message distinct (jamais plus de 3 ici)
      body.push(0x40 | local, 0, 0); u16(m.num); body.push(m.fields.length);
      for (const f of m.fields) body.push(f.id, f.type === T.str ? f.size : SIZE[f.type], f.type);
      for (const row of m.rows || [m.fields]) {
        body.push(local);
        for (let i = 0; i < m.fields.length; i++) {
          const f = m.fields[i], v = (m.rows ? row[i] : f.value);
          if (f.type === T.str) {
            let bytes = Array.from(enc.encode(String(v)));
            if (bytes.length > f.size - 1) { // coupe sur une frontière de caractère UTF-8
              bytes = bytes.slice(0, f.size - 1);
              while (bytes.length && (bytes[bytes.length - 1] & 0xC0) === 0x80) bytes.pop();
              if (bytes.length && bytes[bytes.length - 1] >= 0xC0) bytes.pop();
            }
            while (bytes.length < f.size) bytes.push(0);
            for (const b of bytes) body.push(b);
          } else if (f.type === T.enum) body.push(v & 255);
          else if (f.type === T.u16) u16(v);
          else u32(v);
        }
      }
    });
    const out = new Uint8Array(14 + body.length + 2);
    const dv = new DataView(out.buffer);
    out[0] = 14; out[1] = 0x20; dv.setUint16(2, 2100, true); dv.setUint32(4, body.length, true);
    out.set([0x2E, 0x46, 0x49, 0x54], 8); // « .FIT »
    dv.setUint16(12, crc16(out, 0, 0, 12), true);
    out.set(body, 14);
    dv.setUint16(14 + body.length, crc16(out, 0, 0, 14 + body.length), true);
    return out;
  }

  /** Entraînement FIT : une étape par tronçon (distance en m, puissance cible en W). opts : { name, now (ms), max }.
   * Renvoie { fit (Uint8Array), sections }. */
  function buildFit(plan, opts) {
    const o = opts || {};
    const secs = PYR.planGpx.sections(plan, { max: o.max || FIT_MAX_STEPS, cuts: o.cuts });
    const name = o.name || 'Plan PaceYourRide';
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    // durées en distance arrondies au mètre, sans dérive : on arrondit les bornes cumulées
    const cm = (m) => Math.round(m) * 100;
    const messages = [
      { num: 0, fields: [
        { id: 0, type: T.enum, value: 5 },                                     // type : entraînement
        { id: 1, type: T.u16, value: 255 },                                    // fabricant : développement
        { id: 2, type: T.u16, value: 0 },
        { id: 3, type: T.u32z, value: 1 },
        { id: 4, type: T.u32, value: Math.max(0, Math.floor(now / 1000) - FIT_EPOCH) },
      ] },
      { num: 26, fields: [
        { id: 4, type: T.enum, value: 2 },                                     // sport : cyclisme
        { id: 6, type: T.u16, value: secs.length },                            // nombre d'étapes
        { id: 8, type: T.str, size: 32, value: name },
      ] },
      { num: 27, fields: [
        { id: 254, type: T.u16 }, { id: 0, type: T.str, size: 16 },            // index, nom de l'étape
        { id: 1, type: T.enum },  { id: 2, type: T.u32 },                      // durée : type (distance), valeur (cm)
        { id: 3, type: T.enum },  { id: 4, type: T.u32 },                      // cible : type (puissance), valeur (0 : plage)
        { id: 5, type: T.u32 },   { id: 6, type: T.u32 },                      // plage : bas, haut (W + 1000)
        { id: 7, type: T.enum },  { id: 8, type: T.str, size: 64 },            // intensité (active), notes
      ], rows: secs.map((g, i) => {
        const d = describe(g);
        return [i, `${d.P} W`, 1, Math.max(100, cm(g.b) - cm(g.a)), 4, 0,
          1000 + Math.round(d.P * (1 - TOL_PCT)), 1000 + Math.round(d.P * (1 + TOL_PCT)), 0, d.text];
      }) },
    ];
    return { fit: encodeFit(messages), sections: secs };
  }

  // ---------- ZWO et MRC ----------

  /** Bornes de temps arrondies à la seconde, sans dérive : [{ g, d (durée entière), P, pct (fraction de la PMA) }]. */
  function timed(plan, ftp, cuts) {
    const secs = PYR.planGpx.sections(plan, { cuts });
    let prev = 0;
    return secs.map((g) => {
      const end = Math.round(g.t1), d = Math.max(1, end - prev);
      prev += d;
      const info = describe(g);
      return Object.assign({ g, d, pct: g.P / ftp }, info);
    });
  }

  /** ZWO (Zwift et compatibles) : une étape à puissance constante par tronçon, avec un message à l'écran au début. */
  function buildZwo(plan, opts) {
    const o = opts || {}, name = o.name || 'Plan PaceYourRide', ftp = Number(o.ftp) > 0 ? Number(o.ftp) : 250;
    const steps = timed(plan, ftp, o.cuts);
    const lines = [
      '<workout_file>',
      '  <author>PaceYourRide</author>',
      `  <name>${xml(name)}</name>`,
      `  <description>${xml(`Plan optimal : ${U.fmtDuration(plan.tFinish)} pour ${km(plan.inputs.length)} km, puissances en % de la PMA (${Math.round(ftp)} W).`)}</description>`,
      '  <sportType>bike</sportType>',
      '  <tags/>',
      '  <workout>',
    ];
    for (const s of steps) {
      lines.push(`    <SteadyState Duration="${s.d}" Power="${s.pct.toFixed(3)}"><textevent timeoffset="0" message="${xml(s.text)}"/></SteadyState>`);
    }
    lines.push('  </workout>', '</workout_file>');
    return { zwo: lines.join('\n'), steps };
  }

  /** MRC (TrainerRoad, Golden Cheetah…) : minutes et % de la PMA, deux points par tronçon. */
  function buildMrc(plan, opts) {
    const o = opts || {}, name = o.name || 'Plan PaceYourRide', ftp = Number(o.ftp) > 0 ? Number(o.ftp) : 250;
    const steps = timed(plan, ftp, o.cuts);
    const lines = [
      '[COURSE HEADER]', 'VERSION = 2', 'UNITS = ENGLISH',
      `DESCRIPTION = ${name} - ${U.fmtDuration(plan.tFinish)} - ${km(plan.inputs.length)} km - PMA ${Math.round(ftp)} W`.replace(/[\r\n]/g, ' '),
      `FILE NAME = ${name}`.replace(/[\r\n]/g, ' '),
      'MINUTES PERCENT', '[END COURSE HEADER]', '[COURSE DATA]',
    ];
    const f = (v, d) => v.toFixed(d);
    let t = 0;
    for (const s of steps) {
      const pct = f(s.pct * 100, 1);
      lines.push(`${f(t / 60, 2)}\t${pct}`);
      t += s.d;
      lines.push(`${f(t / 60, 2)}\t${pct}`);
    }
    lines.push('[END COURSE DATA]');
    return { mrc: lines.join('\r\n') + '\r\n', steps };
  }

  PYR.planWorkout = { buildFit, buildZwo, buildMrc, crc16, FIT_MAX_STEPS };
})(globalThis.PYR = globalThis.PYR || {});
