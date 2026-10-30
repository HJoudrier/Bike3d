/* author : Hugo Joudrier-Faure */
/* PaceYourRide — revêtements d'après OpenStreetMap : pour chaque point du parcours, la voie la plus proche (API Overpass, gratuite et sans clé)
 * donne son revêtement (tag surface, à défaut tracktype ou type de voie), qui devient une portion pré-remplie (pavés, gravier, chemin…).
 * L'asphalte est le revêtement par défaut : il ne crée pas de portion. */
(function (PYR) {
  'use strict';

  const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.openstreetmap.fr/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const TIMEOUT = 25000;        // ms par essai auprès d'un serveur
  const SAMPLE = 20;            // m : écart entre deux points examinés le long du parcours
  const MATCH = 15;             // m : distance maximale entre le tracé et la voie retenue
  const STICK = 6;              // m : une voie déjà suivie garde la priorité si elle n'est pas plus loin de plus de ça
  const MIN_RUN = 60;           // m : une portion plus courte est ignorée
  const MERGE_GAP = 120;        // m : deux portions de même revêtement plus proches que ça n'en font qu'une
  const CHUNK = 10000;          // m de parcours par requête Overpass
  const BOX = 2000;             // m de parcours par boîte englobante dans une requête (boîtes serrées : peu de données, requête rapide)
  const PAD = 0.0003;           // ° : marge des boîtes (≈ 35 m)
  const BUDGET = 150000;        // ms : au-delà, la lecture s'arrête avec ce qui a été lu
  const CELL = 0.0004;          // ° : cellule de l'index spatial (≈ 45 m)

  // revêtement OpenStreetMap (tag surface) → revêtement de l'application (Ph.SURFACES) ; 'asphalt' = pas de portion
  const SURFACE = {
    asphalt: 'asphalt', paved: 'asphalt', concrete: 'asphalt', 'concrete:lanes': 'asphalt', 'concrete:plates': 'asphalt', metal: 'asphalt', wood: 'asphalt',
    bricks: 'asphalt', chipseal: 'rough', paving_stones: 'rough', 'paving_stones:lanes': 'rough', grass_paver: 'rough',
    sett: 'cobbles', cobblestone: 'cobbles', 'cobblestone:flattened': 'cobbles', unhewn_cobblestone: 'cobbles_hard',
    compacted: 'gravel_hard', fine_gravel: 'gravel_hard', gravel: 'gravel_loose', pebblestone: 'gravel_loose', rock: 'gravel_loose', stone: 'gravel_loose',
    unpaved: 'dirt', ground: 'dirt', dirt: 'dirt', earth: 'dirt', mud: 'dirt', clay: 'dirt', woodchips: 'dirt',
    grass: 'grass', sand: 'grass', snow: 'grass', ice: 'grass',
  };
  const TRACKTYPE = { grade1: 'asphalt', grade2: 'gravel_hard', grade3: 'gravel_hard', grade4: 'dirt', grade5: 'dirt' };
  const BAD = { bad: 1, very_bad: 1, horrible: 1, very_horrible: 1 };
  // sans aucune indication de revêtement : le type de voie fait foi
  const HIGHWAY = { track: 'gravel_hard', path: 'dirt', bridleway: 'dirt', footway: 'asphalt', cycleway: 'asphalt' };

  /** Revêtement de l'application d'après les tags d'une voie OpenStreetMap, ou null s'il n'y a rien à en tirer (asphalte par défaut). */
  function classify(tags) {
    const t = tags || {};
    let s = null;
    for (const v of String(t.surface || '').split(';')) {      // « asphalt;gravel » : le plus mauvais des revêtements cités
      const m = SURFACE[v.trim()];
      if (m && (!s || rank(m) > rank(s))) s = m;
    }
    if (!s && t.tracktype) s = TRACKTYPE[t.tracktype] || null;
    if (!s) s = HIGHWAY[t.highway] || null;
    if (s === 'asphalt' && BAD[t.smoothness]) s = 'rough';
    return s;
  }
  const ORDER = ['asphalt', 'smooth', 'rough', 'cobbles', 'gravel_hard', 'dirt', 'cobbles_hard', 'gravel_loose', 'grass'];
  const rank = (id) => ORDER.indexOf(id);

  const strikes = {};           // serveur → échecs de suite : les serveurs qui échouent passent après les autres

  const wait = (ms, signal) => new Promise((ok) => { const t = setTimeout(ok, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true }); });

  /** Requête Overpass avec repli sur les autres serveurs, puis un second tour si tous étaient saturés. L'erreur dit pourquoi chaque serveur a échoué. */
  async function overpass(ql, signal) {
    const why = [];
    for (let round = 0; round < 2; round++) {
      let busy = false;
      const order = ENDPOINTS.map((u, i) => [u, i]).sort((a, b) => (strikes[a[0]] || 0) - (strikes[b[0]] || 0) || a[1] - b[1]).map((x) => x[0]);
      const live = order.filter((u) => (strikes[u] || 0) < 2);      // deux échecs de suite : ce serveur est mis de côté pour cette lecture
      for (const url of live.length ? live : order) {
        const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), TIMEOUT);
        const onAbort = () => ctrl.abort();
        if (signal) signal.addEventListener('abort', onAbort);
        try {
          const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(ql), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
          if (!r.ok) { if (r.status === 429 || r.status === 504) busy = true; throw new Error('HTTP ' + r.status); }
          const data = await r.json();
          strikes[url] = 0;
          return data;
        } catch (e) {
          if (signal && signal.aborted) throw e;
          strikes[url] = (strikes[url] || 0) + 1;
          why.push(new URL(url).hostname + ' : ' + (ctrl.signal.aborted ? 'délai dépassé' : e.message === 'Failed to fetch' ? 'injoignable (réseau, blocage ou CORS)' : e.message));
        } finally {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
        }
      }
      if (!busy || round === 1) break;
      await wait(4000, signal);                     // serveurs saturés : on laisse souffler avant le second tour
      if (signal && signal.aborted) break;
    }
    const err = new Error('Overpass indisponible : ' + why.join(' ; '));
    err.reasons = why;
    throw err;
  }

  // On ne demande que les voies qui changent quelque chose : revêtement non asphalté, mauvais état, pistes et sentiers.
  // Une voie absente de la réponse est de l'asphalte (le défaut) : la réponse reste petite, même en ville.
  const NOTABLE = [
    '["surface"~"^(sett|cobblestone|cobblestone:flattened|unhewn_cobblestone|paving_stones|paving_stones:lanes|grass_paver|chipseal|compacted|fine_gravel|gravel|pebblestone|rock|stone|unpaved|ground|dirt|earth|mud|clay|woodchips|grass|sand|snow|ice)"]',
    '["highway"~"^(track|path|bridleway)$"]',
    '["tracktype"]',
    '["smoothness"~"^(bad|very_bad|horrible|very_horrible)$"]',
  ];

  /** Voies notables le long de la portion [i0, i1] du parcours : une requête, avec une boîte serrée tous les BOX m. */
  async function fetchWays(profile, i0, i1, signal) {
    const per = Math.max(2, Math.round(BOX / profile.step));
    const boxes = [];
    for (let a = i0; a < i1; a += per) {
      const b = Math.min(i1, a + per);
      let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
      for (let i = a; i <= b; i++) {
        s = Math.min(s, profile.lat[i]); n = Math.max(n, profile.lat[i]);
        w = Math.min(w, profile.lng[i]); e = Math.max(e, profile.lng[i]);
      }
      boxes.push([s - PAD, w - PAD * 1.5, n + PAD, e + PAD * 1.5].map((v) => v.toFixed(5)).join(','));
    }
    // les voies des boîtes sont lues une fois (.h), puis filtrées en mémoire : bien plus léger qu'une recherche par filtre et par boîte
    const ql = `[out:json][timeout:25];(${boxes.map((b) => `way["highway"](${b});`).join('')})->.h;(${NOTABLE.map((f) => `way.h${f};`).join('')});out tags geom;`;
    const data = await overpass(ql, signal);
    return (data.elements || []).filter((el) => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length > 1);
  }

  /**
   * Revêtement de chaque point examiné du parcours (une voie OpenStreetMap par point), à partir des voies déjà chargées.
   * Renvoie un tableau par échantillon : id du revêtement, ou null (aucune voie notable assez proche : asphalte).
   */
  function matchWays(profile, ways, stride) {
    const lat0 = profile.lat[0], kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const cellOf = (lat, lng) => Math.floor(lat / CELL) + ',' + Math.floor(lng / CELL);
    const grid = new Map();
    const segs = [];
    ways.forEach((w, wi) => {
      const g = w.geometry;
      for (let k = 0; k < g.length - 1; k++) {
        const a = g[k], b = g[k + 1];
        if (!a || !b) continue;
        const si = segs.push({ w: wi, ax: a.lon * kx, ay: a.lat * ky, bx: b.lon * kx, by: b.lat * ky }) - 1;
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(b.lat - a.lat), Math.abs(b.lon - a.lon)) / CELL));
        const seen = new Set();
        for (let q = 0; q <= n; q++) {
          const key = cellOf(a.lat + (b.lat - a.lat) * q / n, a.lon + (b.lon - a.lon) * q / n);
          if (seen.has(key)) continue;
          seen.add(key);
          (grid.get(key) || grid.set(key, []).get(key)).push(si);
        }
      }
    });
    const kinds = ways.map((w) => classify(w.tags) || 'asphalt');      // voie sans renseignement : asphalte (null = aucune voie proche)
    const out = [];
    let cur = -1;               // voie suivie au point précédent
    for (let i = 0; i < profile.n; i += stride) {
      const lat = profile.lat[i], lng = profile.lng[i], px = lng * kx, py = lat * ky;
      const cy = Math.floor(lat / CELL), cx = Math.floor(lng / CELL);
      let best = -1, bestD = MATCH, curD = Infinity;
      const near = new Map();   // voie → distance minimale
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const si of grid.get((cy + dy) + ',' + (cx + dx)) || []) {
          const s = segs[si];
          const vx = s.bx - s.ax, vy = s.by - s.ay, len2 = vx * vx + vy * vy;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - s.ax) * vx + (py - s.ay) * vy) / len2)) : 0;
          const d = Math.hypot(px - (s.ax + vx * t), py - (s.ay + vy * t));
          if (d <= MATCH && d < (near.get(s.w) === undefined ? Infinity : near.get(s.w))) near.set(s.w, d);
        }
      }
      for (const [w, d] of near) {
        if (w === cur) curD = d;
        if (d < bestD) { bestD = d; best = w; }
      }
      if (cur >= 0 && curD <= bestD + STICK) best = cur;    // pas de saut sur une voie croisée
      cur = best;
      out.push(best >= 0 ? kinds[best] : null);
    }
    return out;
  }

  /**
   * Portions de revêtement (hors asphalte) d'après les revêtements par échantillon : les portions trop courtes disparaissent et celles de même revêtement, proches, fusionnent. [{ startKm, endKm, surface }]
   */
  function toPortions(samples, stride, step, length) {
    const d = stride * step;
    const runs = [];
    // 1. aucune voie notable à proximité : asphalte (seules les voies notables sont demandées à OpenStreetMap)
    const s = samples.map((v) => v || 'asphalt');
    for (let i = 0; i < s.length;) {
      let j = i;
      while (j + 1 < s.length && s[j + 1] === s[i]) j++;
      runs.push({ surface: s[i], a: Math.max(0, (i - 0.5) * d), b: Math.min(length, (j + 0.5) * d) });
      i = j + 1;
    }
    // 2. un trou court de revêtement différent entre deux portions identiques disparaît
    for (let k = 1; k < runs.length - 1; k++) {
      if (runs[k].b - runs[k].a < MERGE_GAP && runs[k - 1].surface === runs[k + 1].surface && runs[k].surface !== runs[k - 1].surface) {
        runs[k - 1].b = runs[k + 1].b;
        runs.splice(k, 2);
        k--;
      }
    }
    // 3. hors asphalte, assez longues
    return runs.filter((r) => r.surface !== 'asphalt' && r.b - r.a >= MIN_RUN)
      .map((r) => ({ startKm: +(r.a / 1000).toFixed(2), endKm: +(r.b / 1000).toFixed(2), surface: r.surface }))
      .filter((r) => r.endKm > r.startKm);
  }

  /**
   * Détecte les revêtements du parcours. `profile` : store.profile (lat, lng, n, step, length). `onProgress(fait, total)` facultatif.
   * Renvoie { portions: [{ startKm, endKm, surface }], ways: nombre de voies lues }.
   */
  async function detect(profile, opts) {
    const o = opts || {};
    if (!profile || !(profile.n > 1)) return { portions: [], ways: 0 };
    const stride = Math.max(1, Math.round(SAMPLE / profile.step));
    const per = Math.max(2, Math.round(CHUNK / profile.step));
    for (const k of Object.keys(strikes)) delete strikes[k];
    const ways = new Map();
    const chunks = [];
    for (let i = 0; i < profile.n - 1; i += per) chunks.push([i, Math.min(profile.n - 1, i + per)]);
    let lastErr = null, done = 0;
    const t0 = Date.now();
    let todo = chunks.map((_, c) => c);
    for (let pass = 0; pass < 2 && todo.length; pass++) {       // un morceau illisible est retenté une fois, après les autres
      const next = [];
      for (const c of todo) {
        if (Date.now() - t0 > BUDGET) { next.push(c); continue; }
        if (o.onProgress) o.onProgress(done, chunks.length);
        try {
          for (const w of await fetchWays(profile, chunks[c][0], chunks[c][1], o.signal)) ways.set(w.id, w);
          done++;
        } catch (e) {
          if (o.signal && o.signal.aborted) throw e;
          next.push(c); lastErr = e;                  // un morceau illisible ne fait pas perdre les autres
        }
      }
      todo = next;
    }
    const failed = todo.length;
    if (failed === chunks.length) throw lastErr || new Error('Overpass indisponible : trop long');
    if (o.onProgress) o.onProgress(chunks.length, chunks.length);
    const list = [...ways.values()];
    return { portions: toPortions(matchWays(profile, list, stride), stride, profile.step, profile.length), ways: list.length, failed, chunks: chunks.length };
  }

  PYR.surfaceOsm = { detect, classify, matchWays, toPortions };
})(globalThis.PYR = globalThis.PYR || {});
