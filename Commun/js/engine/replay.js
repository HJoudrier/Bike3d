/* author : Hugo Joudrier-Faure */
/* PaceYourRide — rejouer une sortie enregistrée (GPX, TCX ou FIT) dans le mode démo du compteur.
 *
 * Au lieu d'un cycliste simulé, le compteur reçoit, seconde par seconde, ce qu'un vrai cycliste a enregistré sur le même parcours :
 * position GPS, vitesse, altitude, puissance, fréquence cardiaque et cadence. Le suivi (projection sur le tracé, écart au plan,
 * W′bal, glycogène, alertes, recalcul) est alors exactement celui d'une sortie réelle.
 *
 * Ce module ne touche ni au DOM ni aux capteurs :
 *   - decodeFit(octets) : lecteur FIT (messages « record »), qui rend la même forme que PYR.activity.parse ;
 *   - load(octets) : reconnaît le format (FIT, sinon texte GPX / TCX) ;
 *   - create({ activity, course }) : le « cycliste rejoueur », avec la même interface que ride.createDemo (step → mesures de la seconde). */
(function (PYR) {
  'use strict';

  const FIT_EPOCH = 631065600;       // s : 31/12/1989 00:00 UTC, origine des dates FIT
  const MAX_POINTS = 400000;
  const PAUSE_S = 15;                // s : un trou plus long dans l'enregistrement est une pause (arrêt automatique), ramenée à 1 s
  const ON_COURSE_M = 40;            // m : un point à moins de cette distance du tracé est « sur le parcours »
  const START_ZONE_M = 300;          // m : la sortie rejouée commence au premier point du tracé qui est dans ce premier tronçon
  const MIN_COVERAGE = 0.6;          // part des points (entre le départ et la fin) qui doivent être sur le parcours
  const MIN_REACH_M = 500;           // m : distance du parcours que la sortie doit au moins avoir suivie (ou la moitié du parcours s'il est plus court)
  const STRIDE = 5;                  // s : pas de la vérification de l'appartenance au parcours
  const R_DEG = 6371008.8 * Math.PI / 180;

  /* ======================================================================
   * Lecture d'un FIT
   * ====================================================================== */

  // types de base FIT : numéro → [taille, valeur invalide, lecteur]
  const BASE = {
    0x00: [1, 0xFF, 'u8'], 0x01: [1, 0x7F, 's8'], 0x02: [1, 0xFF, 'u8'], 0x83: [2, 0x7FFF, 's16'], 0x84: [2, 0xFFFF, 'u16'], 0x85: [4, 0x7FFFFFFF, 's32'],
    0x86: [4, 0xFFFFFFFF, 'u32'], 0x07: [1, 0, 'u8'], 0x88: [4, null, 'f32'], 0x89: [8, null, 'f64'], 0x0A: [1, 0, 'u8'], 0x8B: [2, 0, 'u16'], 0x8C: [4, 0, 'u32'], 0x0D: [1, 0xFF, 'u8'],
  };

  function readVal(dv, off, kind, little) {
    switch (kind) {
      case 'u8': return dv.getUint8(off);
      case 's8': return dv.getInt8(off);
      case 'u16': return dv.getUint16(off, little);
      case 's16': return dv.getInt16(off, little);
      case 'u32': return dv.getUint32(off, little);
      case 's32': return dv.getInt32(off, little);
      case 'f32': return dv.getFloat32(off, little);
      case 'f64': return dv.getFloat64(off, little);
      default: return NaN;
    }
  }

  const isFit = (b) => b.length >= 14 && b[8] === 0x2E && b[9] === 0x46 && b[10] === 0x49 && b[11] === 0x54;

  /**
   * Lit les messages « record » (numéro global 20) d'un FIT. Renvoie {format: 'fit', name, points: [{t, lat, lng, ele, dist, power, hr, cad, speed}],
   * hasTime, hasEle, hasPower, hasDist, hasHr, hasCad, startMs (date du premier point, ms), sport, subSport (énumérations FIT des messages
   * « session » ou « sport », undefined si absentes)}. Les champs absents ou invalides valent NaN. Les messages développeur et tous les autres
   * messages sont sautés ; la somme de contrôle n'est pas vérifiée (un fichier tronqué reste lisible jusqu'où il va).
   * opts.anyPos : garder aussi les points sans position (home trainer, sortie en salle) ; il faut alors des points horodatés.
   */
  function decodeFit(bytes, opts) {
    const anyPos = !!(opts && opts.anyPos);
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!isFit(b)) throw new Error('Ce fichier n\'est pas un FIT.');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const hdr = b[0], end = Math.min(b.length, hdr + dv.getUint32(4, true));
    const defs = new Array(16).fill(null);
    const raw = [];
    let off = hdr, lastTs = NaN, sport, subSport;
    while (off < end && raw.length < MAX_POINTS) {
      const h = b[off++];
      let local, compTs = NaN;
      if (h & 0x80) {                                           // en-tête à horodatage compressé (message de données)
        local = (h >> 5) & 3;
        const o = h & 0x1F;
        if (Number.isFinite(lastTs)) { let ts = (lastTs & ~0x1F) + o; if (o < (lastTs & 0x1F)) ts += 32; compTs = ts; }
      } else if (h & 0x40) {                                    // définition
        local = h & 15;
        const dev = (h & 0x20) !== 0;
        if (off + 5 > end) break;
        const little = b[off + 1] === 0;
        const num = little ? dv.getUint16(off + 2, true) : dv.getUint16(off + 2, false);
        const nf = b[off + 4];
        off += 5;
        const fields = [];
        for (let i = 0; i < nf; i++) { fields.push({ id: b[off], size: b[off + 1], bt: b[off + 2] }); off += 3; }
        let devSize = 0;
        if (dev) { const nd = b[off++]; for (let i = 0; i < nd; i++) { devSize += b[off + 1]; off += 3; } }
        defs[local] = { num, little, fields, devSize };
        continue;
      } else local = h & 15;                                    // message de données
      const d = defs[local];
      if (!d) break;                                            // données sans définition : fichier illisible à partir d'ici
      const start = off;
      let total = d.devSize;
      for (const f of d.fields) total += f.size;
      if (start + total > end) break;
      if (d.num === 20) {
        const r = { ts: compTs, lat: NaN, lng: NaN, alt: NaN, alt2: NaN, dist: NaN, power: NaN, hr: NaN, cad: NaN, speed: NaN, speed2: NaN };
        let p = start;
        for (const f of d.fields) {
          const bt = BASE[f.bt & 0x9F] || BASE[f.bt];
          if (bt && f.size >= bt[0]) {
            let v = readVal(dv, p, bt[2], d.little);
            if (bt[1] !== null && v === bt[1]) v = NaN;
            if (Number.isFinite(v)) {
              switch (f.id) {
                case 253: r.ts = v; break;
                case 0: r.lat = v * 180 / 2147483648; break;
                case 1: r.lng = v * 180 / 2147483648; break;
                case 2: r.alt = v / 5 - 500; break;
                case 78: r.alt2 = v / 5 - 500; break;
                case 3: r.hr = v; break;
                case 4: r.cad = v; break;
                case 5: r.dist = v / 100; break;
                case 6: r.speed = v / 1000; break;
                case 73: r.speed2 = v / 1000; break;
                case 7: r.power = v; break;
                default: break;
              }
            }
          }
          p += f.size;
        }
        if (Number.isFinite(r.ts)) lastTs = r.ts;
        raw.push(r);
      } else {
        // l'horodatage d'un autre message (champ 253) sert de référence aux en-têtes compressés suivants ; le sport se lit dans
        // la séance (message 18, champs 5 et 6) ou le message « sport » (12, champs 0 et 1)
        let p = start;
        for (const f of d.fields) {
          if (f.id === 253 && f.size === 4) { const v = dv.getUint32(p, d.little); if (v !== 0xFFFFFFFF) lastTs = v; }
          else if (f.size === 1 && b[p] !== 0xFF && ((d.num === 18 && (f.id === 5 || f.id === 6)) || (d.num === 12 && (f.id === 0 || f.id === 1)))) {
            if (f.id === 5 || f.id === 0) { if (sport === undefined || d.num === 18) sport = b[p]; } else if (subSport === undefined || d.num === 18) subSport = b[p];
          }
          p += f.size;
        }
      }
      off = start + total;
    }
    const points = [];
    for (const r of raw) {
      const pos = Number.isFinite(r.lat) && Number.isFinite(r.lng) && !(r.lat === 0 && r.lng === 0);
      if (!pos && !(anyPos && Number.isFinite(r.ts))) continue;
      points.push({
        ms: Number.isFinite(r.ts) ? (r.ts + FIT_EPOCH) * 1000 : NaN, lat: pos ? r.lat : NaN, lng: pos ? r.lng : NaN, ele: Number.isFinite(r.alt2) ? r.alt2 : r.alt, dist: r.dist,
        power: r.power, hr: r.hr, cad: r.cad, speed: Number.isFinite(r.speed2) ? r.speed2 : r.speed,
      });
    }
    if (points.length < 2) throw new Error(anyPos ? 'Aucun point horodaté dans le FIT.' : 'Aucune trace trouvée dans le FIT (il faut des points avec une position).');
    const first = points.find((p) => Number.isFinite(p.ms)), t0 = first ? first.ms : NaN;
    for (const p of points) { p.t = Number.isFinite(t0) && Number.isFinite(p.ms) ? (p.ms - t0) / 1000 : NaN; delete p.ms; }
    const any = (k) => points.some((p) => Number.isFinite(p[k]));
    return {
      format: 'fit', name: '', points, startMs: t0, sport, subSport,
      hasTime: points.filter((p) => Number.isFinite(p.t)).length >= 2, hasEle: any('ele'), hasPower: any('power'), hasDist: any('dist'), hasHr: any('hr'), hasCad: any('cad'),
    };
  }

  /** Lit un fichier de sortie (octets) : FIT, sinon texte GPX ou TCX. opts : comme decodeFit (anyPos). */
  function load(data, opts) {
    const b = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (isFit(b)) return decodeFit(b, opts);
    const act = PYR.activity.parse(new TextDecoder('utf-8').decode(b), opts);
    const any = (k) => act.points.some((p) => Number.isFinite(p[k]));
    act.hasHr = any('hr'); act.hasCad = any('cad');
    return act;
  }

  /* ======================================================================
   * Le cycliste rejoueur
   * ====================================================================== */

  const hav = (la1, lo1, la2, lo2) => {
    const x = (lo2 - lo1) * Math.cos((la1 + la2) * Math.PI / 360) * R_DEG, y = (la2 - la1) * R_DEG;
    return Math.sqrt(x * x + y * y);
  };

  /**
   * Remet la sortie à une ligne par seconde. Les pauses (trous de plus de PAUSE_S) sont ramenées à une seconde : la démo ne reste pas
   * figée. Renvoie { lat, lng, ele, power, hr, cad, speed } (tableaux Float64Array, NaN = absent), n.
   */
  function resample(act) {
    const pts = act.points.filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
    const uniq = [];
    for (const p of pts) if (!uniq.length || p.t > uniq[uniq.length - 1].t) uniq.push(p);
    if (uniq.length < 2) throw new Error('Cette sortie n\'a pas d\'horodatage : impossible de la rejouer à son rythme.');
    const tt = new Float64Array(uniq.length);
    for (let i = 1; i < uniq.length; i++) { const dt = uniq[i].t - uniq[i - 1].t; tt[i] = tt[i - 1] + (dt > PAUSE_S ? 1 : dt); }
    const n = Math.floor(tt[tt.length - 1]) + 1;
    const out = {};
    for (const k of ['lat', 'lng', 'ele', 'power', 'hr', 'cad', 'speed']) out[k] = new Float64Array(n).fill(NaN);
    const lerp = (a, b, f) => (Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : Number.isFinite(a) && f < 0.5 ? a : Number.isFinite(b) && f >= 0.5 ? b : NaN);
    let j = 0;
    for (let k = 0; k < n; k++) {
      while (j < uniq.length - 2 && tt[j + 1] <= k) j++;
      const span = tt[j + 1] - tt[j], f = span > 0 ? Math.min(1, Math.max(0, (k - tt[j]) / span)) : 0;
      const a = uniq[j], c = uniq[j + 1];
      out.lat[k] = lerp(a.lat, c.lat, f); out.lng[k] = lerp(a.lng, c.lng, f); out.ele[k] = lerp(a.ele, c.ele, f);
      out.speed[k] = lerp(a.speed, c.speed, f);
      // puissance, cadence : une mesure par échantillon (pas d'interpolation d'un trou de plus de 3 s)
      const near = f < 0.5 ? a : c;
      out.power[k] = span <= 3 ? lerp(a.power, c.power, f) : near.power;
      out.cad[k] = span <= 3 ? lerp(a.cad, c.cad, f) : near.cad;
      out.hr[k] = lerp(a.hr, c.hr, f);
    }
    // vitesse absente : d'après les positions, sur ±2 s
    for (let k = 0; k < n; k++) {
      if (Number.isFinite(out.speed[k])) continue;
      const i0 = Math.max(0, k - 2), i1 = Math.min(n - 1, k + 2);
      out.speed[k] = i1 > i0 ? hav(out.lat[i0], out.lng[i0], out.lat[i1], out.lng[i1]) / (i1 - i0) : 0;
    }
    return { track: out, n };
  }

  /**
   * Le cycliste rejoueur. o : { activity (PYR.activity.parse / decodeFit / load), course }. Lève une erreur si la sortie n'a pas d'horodatage ou
   * ne suit pas le parcours. step() → { power (undefined si non enregistrée), hr, cad, fix, t, done }, comme ride.createDemo ; `replay: true`
   * distingue les deux.
   */
  function create(o) {
    const act = o.activity, course = o.course;
    if (!act || !act.points) throw new Error('Aucune sortie à rejouer.');
    const { track: T, n: n0 } = resample(act);
    // la sortie rejouée commence au départ du parcours et finit à son dernier point sur le tracé (échauffement et retour sont écartés)
    const M = PYR.ride.createMatcher(course);
    const onCourse = [];                                     // une mesure tous les STRIDE s : { k, s, d }
    for (let k = 0; k < n0; k += STRIDE) {
      if (!Number.isFinite(T.lat[k]) || !Number.isFinite(T.lng[k])) continue;
      const r = M.project(T.lat[k], T.lng[k]);
      onCourse.push({ k, s: r.s, d: r.d });
    }
    const startI = onCourse.findIndex((x) => x.d <= ON_COURSE_M && x.s <= START_ZONE_M);
    if (startI < 0) throw new Error('Cette sortie ne passe pas au départ du parcours : ce n\'est pas le même tracé.');
    let endI = onCourse.length - 1;
    while (endI > startI && onCourse[endI].d > ON_COURSE_M) endI--;
    if (onCourse[endI].s < Math.min(MIN_REACH_M, course.length / 2)) throw new Error('Cette sortie ne suit le parcours que sur ' + Math.round(onCourse[endI].s) + ' m : ce n\'est pas le même tracé.');
    const inside = onCourse.slice(startI, endI + 1);
    const coverage = inside.filter((x) => x.d <= ON_COURSE_M).length / inside.length;
    if (coverage < MIN_COVERAGE) throw new Error(`Cette sortie ne suit le parcours que sur ${Math.round(coverage * 100)} % de sa durée : ce n'est pas le même tracé.`);
    const k0 = onCourse[startI].k, k1 = Math.min(n0 - 1, onCourse[endI].k + STRIDE - 1);
    const n = k1 - k0 + 1;
    let pSum = 0, pCnt = 0;
    for (let k = k0; k <= k1; k++) if (Number.isFinite(T.power[k])) { pSum += T.power[k]; pCnt++; }
    const any = (a) => { for (let k = k0; k <= k1; k++) if (Number.isFinite(a[k])) return true; return false; };
    const info = {
      name: act.name || '', format: act.format, duration: n, coverage, reach: onCourse[endI].s,
      hasPower: pCnt > n * 0.2, avgPower: pCnt ? pSum / pCnt : NaN, hasHr: any(T.hr), hasCad: any(T.cad),
    };
    let i = 0;
    return {
      replay: true, info, n,
      step() {
        if (i >= n) return { power: undefined, fix: null, t: i, done: true };
        const k = k0 + i++;
        const p = T.power[k];
        return {
          power: Number.isFinite(p) ? Math.round(p) : undefined,
          hr: Number.isFinite(T.hr[k]) ? T.hr[k] : undefined,
          cad: Number.isFinite(T.cad[k]) ? T.cad[k] : undefined,
          fix: { lat: T.lat[k], lng: T.lng[k], acc: 4, speed: Math.max(0, T.speed[k]), alt: T.ele[k] },
          t: i, done: false,
        };
      },
    };
  }

  PYR.replay = { decodeFit, load, create, resample, isFit, PAUSE_S };
})(globalThis.PYR = globalThis.PYR || {});
