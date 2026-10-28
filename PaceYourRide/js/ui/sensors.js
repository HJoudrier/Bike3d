/* author : Hugo Joudrier-Faure */
/* PaceYourRide — capteurs et alertes du téléphone pour la page « Sortie » :
 *   - position GPS (navigator.geolocation) ;
 *   - capteur de puissance, home-trainer (FTMS) et ceinture cardio en Bluetooth basse consommation (Web Bluetooth : Chrome / Edge sur Android et
 *     ordinateur, Bluefy sur iPhone ; Safari ne le propose pas — l'application estime alors la puissance d'après la vitesse). L'ANT+ n'est
 *     pas accessible depuis un navigateur : un capteur « double » (ANT+ et Bluetooth) se connecte en Bluetooth ;
 *   - écran maintenu allumé (Screen Wake Lock) ;
 *   - alertes : bips (Web Audio), vibrations et voix (synthèse vocale), à débloquer par un geste de l'utilisateur.
 * Aucun de ces services ne fonctionne hors d'une page https ou localhost. */
(function (PYR) {
  'use strict';

  const nav = typeof navigator !== 'undefined' ? navigator : {};
  /** Le navigateur (remplaçable dans les tests : PYR.sensors.navigator). */
  const getNav = () => (PYR.sensors && PYR.sensors.navigator) || nav;
  const RECONNECT_MAX = 40;
  const reconnectMs = () => (PYR.sensors && PYR.sensors.reconnectMs) || 2500;

  /* ---------- GPS ---------- */
  const gps = {
    supported: !!nav.geolocation,
    id: null,
    start(onFix, onError) {
      if (!gps.supported) { if (onError) onError(new Error('Géolocalisation indisponible sur cet appareil.')); return false; }
      gps.stop();
      gps.id = nav.geolocation.watchPosition((p) => {
        const c = p.coords;
        onFix({
          ts: p.timestamp, lat: c.latitude, lng: c.longitude, acc: c.accuracy,
          speed: Number.isFinite(c.speed) && c.speed !== null ? c.speed : NaN, alt: Number.isFinite(c.altitude) && c.altitude !== null ? c.altitude : NaN,
        });
      }, (e) => { if (onError) onError(e); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
      return true;
    },
    stop() { if (gps.id !== null && nav.geolocation) nav.geolocation.clearWatch(gps.id); gps.id = null; },
  };

  /* ---------- Bluetooth ---------- */

  /** Lecture d'un nombre sur 16 bits non signé modulo 65536 : différence a − b. */
  const diff16 = (a, b) => (a - b + 65536) % 65536;

  /**
   * Cycling Power Measurement (0x2A63) : drapeaux (16 bits), puissance instantanée (sint16, W), puis des champs facultatifs dans l'ordre :
   * équilibre gauche/droite (bit 0, 1 octet), couple cumulé (bit 2, 2 octets), roue (bit 4 : 4 + 2 octets), manivelle (bit 5 : tours sur 16 bits
   * et date du dernier tour en 1/1024 s). La cadence se déduit de deux mesures successives de la manivelle (`st` garde la précédente).
   * Renvoie { w, cad } (cad : tr/min ou NaN).
   */
  function parsePower(dv, st) {
    if (dv.byteLength < 4) return null;
    const flags = dv.getUint16(0, true), w = Math.max(0, dv.getInt16(2, true));
    let off = 4, cad = NaN;
    if (flags & 0x01) off += 1;
    if (flags & 0x04) off += 2;
    if (flags & 0x10) off += 6;
    if (st && (flags & 0x20) && dv.byteLength >= off + 4) {
      const revs = dv.getUint16(off, true), time = dv.getUint16(off + 2, true);
      if (st.revs !== undefined) {
        const dr = diff16(revs, st.revs), dt = diff16(time, st.time) / 1024;
        if (dt > 0 && dr >= 0 && dr < 20) { st.cad = dr / dt * 60; st.at = Date.now(); }
        else if (dt === 0 && Date.now() - (st.at || 0) > 3000) st.cad = 0;   // pas de nouveau tour de manivelle : on ne pédale plus
      }
      st.revs = revs; st.time = time;
      cad = st.cad === undefined ? NaN : st.cad;
    }
    return { w, cad };
  }

  /**
   * Indoor Bike Data (FTMS, 0x2AD2), home-trainers : drapeaux (16 bits) puis, dans l'ordre, vitesse instantanée (si le bit 0 est à 0, 0,01 km/h),
   * vitesse moyenne (bit 1), cadence (bit 2, 0,5 tr/min), cadence moyenne (bit 3), distance (bit 4, 3 octets), résistance (bit 5), puissance
   * instantanée (bit 6, sint16 W), puissance moyenne (bit 7), énergie (bit 8, 5 octets), fréquence cardiaque (bit 9, 1 octet).
   * Renvoie { w, cad, hr, kmh } ; w est NaN si le trainer n'envoie pas de puissance.
   */
  function parseFtms(dv) {
    if (dv.byteLength < 2) return null;
    const f = dv.getUint16(0, true);
    let o = 2, kmh = NaN, cad = NaN, w = NaN, hr = NaN;
    const ok = (n) => o + n <= dv.byteLength;
    if (!(f & 0x01) && ok(2)) { kmh = dv.getUint16(o, true) / 100; o += 2; }
    if ((f & 0x02) && ok(2)) o += 2;
    if ((f & 0x04) && ok(2)) { cad = dv.getUint16(o, true) / 2; o += 2; }
    if ((f & 0x08) && ok(2)) o += 2;
    if ((f & 0x10) && ok(3)) o += 3;
    if ((f & 0x20) && ok(2)) o += 2;
    if ((f & 0x40) && ok(2)) { w = Math.max(0, dv.getInt16(o, true)); o += 2; }
    if ((f & 0x80) && ok(2)) o += 2;
    if ((f & 0x100) && ok(5)) o += 5;
    if ((f & 0x200) && ok(1)) { hr = dv.getUint8(o); o += 1; }
    return { w, cad, hr, kmh };
  }

  /** Heart Rate Measurement (0x2A37) : drapeaux sur 8 bits (bit 0 : valeur sur 16 bits), puis la fréquence. */
  function parseHr(dv) {
    if (dv.byteLength < 2) return null;
    return { hr: (dv.getUint8(0) & 1) ? (dv.byteLength >= 3 ? dv.getUint16(1, true) : NaN) : dv.getUint8(1) };
  }

  const KNOWN_KEY = 'paceyourride.ble.v1';
  const readKnown = () => { try { return JSON.parse(localStorage.getItem(KNOWN_KEY)) || {}; } catch (e) { return {}; } };
  const writeKnown = (kind, dev) => { try { const k = readKnown(); k[kind] = dev ? { id: dev.id, name: dev.name || '' } : undefined; localStorage.setItem(KNOWN_KEY, JSON.stringify(k)); } catch (e) { /* stockage indisponible */ } };

  /**
   * Une connexion Bluetooth qui revient toute seule après une coupure. kind : 'power' ou 'hr' (pour retenir l'appareil) ;
   * profiles : [{service, characteristic, parse (DataView, état) → valeur, label}] essayés dans l'ordre (le premier que l'appareil propose).
   * Renvoie { connect(mode, onValue, onState) → Promise<nom>, reconnect(onValue, onState), disconnect(), state, name, last, count, profile }.
   * mode : 'service' (appareils qui annoncent le profil), 'any' (liste de tous les appareils : un capteur qui n'annonce pas son profil).
   */
  function makeBle(kind, profiles) {
    let dev = null, ch = null, onValue = null, onState = null, want = false, state = 'off', prof = null, pst = {};
    const set = (s, extra) => { state = s; if (onState) onState(s, extra); };
    const handle = (e) => {
      const v = prof.parse(e.target.value, pst);
      if (!v) return;
      api.count++; api.last = { ts: Date.now(), v };
      if (onValue) onValue(v, api.last.ts);
    };

    async function open() {
      const server = await dev.gatt.connect();
      let lastErr = null;
      for (const p of profiles) {
        try {
          const svc = await server.getPrimaryService(p.service);
          ch = await svc.getCharacteristic(p.characteristic);
          prof = p; pst = {};
          await ch.startNotifications();
          ch.addEventListener('characteristicvaluechanged', handle);
          set('on', dev.name);
          return;
        } catch (e) { lastErr = e; }
      }
      try { dev.gatt.disconnect(); } catch (e) { /* rien */ }
      throw new Error(`Cet appareil ne propose pas ${profiles.map((p) => p.label).join(' ni ')}.` + (lastErr && lastErr.message ? ` (${lastErr.message})` : ''));
    }
    async function loop() {
      for (let i = 0; i < RECONNECT_MAX && want; i++) {
        set('reconnecting');
        await new Promise((r) => setTimeout(r, reconnectMs()));
        if (!want) return;
        try { await open(); return; } catch (e) { /* on réessaie */ }
      }
      if (want) set('lost');
    }
    function attach(d) {
      dev = d;
      dev.addEventListener('gattserverdisconnected', () => { if (want && dev === d) loop(); });
    }
    const bt = () => getNav().bluetooth;

    const api = {
      last: null, count: 0, error: '',
      get supported() { return !!bt(); },
      get canReconnect() { return !!(bt() && bt().getDevices && readKnown()[kind]); },
      get known() { return readKnown()[kind] || null; },
      get name() { return dev ? dev.name || '' : ''; },
      get device() { return dev; },
      get state() { return state; },
      get profile() { return prof ? prof.label : ''; },
      async connect(mode, onV, onS) {
        if (!bt()) {
          api.error = 'Le Bluetooth n\'est pas disponible dans ce navigateur (essaie Chrome sur Android, ou Bluefy sur iPhone).';
          throw new Error(api.error);
        }
        onValue = onV; onState = onS; want = true; api.error = '';
        set('connecting');
        try {
          const optionalServices = profiles.map((p) => p.service);
          const opts = mode === 'any' ? { acceptAllDevices: true, optionalServices } : { filters: profiles.map((p) => ({ services: [p.service] })), optionalServices };
          attach(await bt().requestDevice(opts));
          await open();
          writeKnown(kind, dev);
          return dev.name || profiles[0].label;
        } catch (e) { want = false; api.error = e.message || String(e); set('off'); throw e; }
      },
      /** Se reconnecte à l'appareil déjà autorisé (sans liste de choix) : après un rechargement de la page. */
      async reconnect(onV, onS) {
        const k = readKnown()[kind];
        if (!bt() || !bt().getDevices || !k) throw new Error('Aucun appareil connu.');
        onValue = onV; onState = onS; want = true; api.error = '';
        set('connecting');
        try {
          const list = await bt().getDevices();
          const d = list.find((x) => x.id === k.id) || list.find((x) => x.name && x.name === k.name);
          if (!d) throw new Error('Appareil introuvable : reconnecte-le depuis la liste.');
          attach(d);
          await open();
          return dev.name || profiles[0].label;
        } catch (e) { want = false; api.error = e.message || String(e); set('off'); throw e; }
      },
      forget() { writeKnown(kind, null); },
      disconnect() {
        want = false;
        try { if (ch) ch.removeEventListener('characteristicvaluechanged', handle); if (dev && dev.gatt && dev.gatt.connected) dev.gatt.disconnect(); } catch (e) { /* déjà coupé */ }
        set('off');
      },
    };
    return api;
  }

  /** Capteur de puissance (pédales, manivelle, moyeu) ou home-trainer connecté : profils « Cycling Power » puis « Fitness Machine ». */
  const power = makeBle('power', [
    { service: 'cycling_power', characteristic: 'cycling_power_measurement', parse: parsePower, label: 'un capteur de puissance (Cycling Power)' },
    { service: 'fitness_machine', characteristic: 'indoor_bike_data', parse: parseFtms, label: 'un home-trainer (FTMS)' },
  ]);

  /* ---------- home-trainer piloté (FTMS) ---------- */

  /**
   * « Set Indoor Bike Simulation Parameters » (Fitness Machine Control Point, code 0x11) : vent (m/s, résolution 0,001, > 0 de face),
   * pente (%, résolution 0,01), coefficient de roulement (résolution 0,0001), cw = ½·ρ·CdA (kg/m, résolution 0,01). 7 octets.
   */
  function ftmsSimBytes(o) {
    const b = new DataView(new ArrayBuffer(7));
    const i16 = (x, k, lo, hi) => Math.max(lo, Math.min(hi, Math.round((Number(x) || 0) * k)));
    b.setUint8(0, 0x11);
    b.setInt16(1, i16(o.wind, 1000, -32768, 32767), true);
    b.setInt16(3, i16(o.grade, 100, -32768, 32767), true);
    b.setUint8(5, i16(o.crr, 10000, 0, 255));
    b.setUint8(6, i16(o.cw, 100, 0, 255));
    return new Uint8Array(b.buffer);
  }

  /**
   * Pilotage d'un home-trainer connecté (celui de `power`) : prise de contrôle (0x00), départ (0x07), puis la charge à chaque
   * appel de set({grade, wind, crr, cw}) — au plus une écriture toutes les `minMs` ms, et seulement si elle a changé.
   * state : 'off', 'on', 'unsupported' (l'appareil n'a pas de point de contrôle FTMS : capteur de puissance seul).
   */
  function makeTrainer() {
    let cp = null, busy = false, lastKey = '', lastAt = 0, pending = null;
    const write = (bytes) => (cp.writeValueWithResponse ? cp.writeValueWithResponse(bytes) : cp.writeValue(bytes));
    const api = {
      state: 'off', minMs: 2000, writes: 0, error: '',
      async attach(dev) {
        api.detach();
        try {
          // le serveur GATT déjà relié (celui du capteur de puissance), sinon une nouvelle connexion
          const server = dev.gatt.connected && dev.gatt.getPrimaryService ? dev.gatt : await dev.gatt.connect();
          const svc = await server.getPrimaryService('fitness_machine');
          cp = await svc.getCharacteristic('fitness_machine_control_point');
          if (cp.startNotifications) await cp.startNotifications(); // les réponses du point de contrôle arrivent en indications
          await write(Uint8Array.of(0x00));
          await write(Uint8Array.of(0x07));
          api.state = 'on'; api.error = '';
        } catch (e) { cp = null; api.state = 'unsupported'; api.error = e.message || String(e); }
        return api.state;
      },
      /** Charge du moment ; renvoie vrai si elle a été envoyée. */
      async set(load, now) {
        if (!cp || api.state !== 'on') return false;
        const t = now === undefined ? Date.now() : now;
        const key = [Math.round(load.grade * 10), Math.round(load.wind * 2), Math.round(load.crr * 10000), Math.round(load.cw * 100)].join(',');
        if (key === lastKey || t - lastAt < api.minMs) { pending = key === lastKey ? null : load; return false; }
        if (busy) { pending = load; return false; }
        busy = true; lastKey = key; lastAt = t; pending = null;
        try { await write(ftmsSimBytes(load)); api.writes++; return true; } catch (e) { api.error = e.message || String(e); return false; } finally { busy = false; }
      },
      detach() { cp = null; api.state = 'off'; lastKey = ''; lastAt = 0; pending = null; busy = false; },
      get pending() { return pending; },
    };
    return api;
  }
  const trainer = makeTrainer();

  /** Ceinture cardio. */
  const hr = makeBle('hr', [{ service: 'heart_rate', characteristic: 'heart_rate_measurement', parse: parseHr, label: 'une ceinture cardio' }]);

  /* ---------- écran allumé ---------- */
  let lock = null, wantLock = false;
  const wake = {
    supported: !!nav.wakeLock,
    async request() {
      wantLock = true;
      if (!nav.wakeLock) return false;
      try { lock = await nav.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); return true; } catch (e) { return false; }
    },
    release() { wantLock = false; if (lock) { try { lock.release(); } catch (e) { /* rien */ } lock = null; } },
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wantLock && !lock) wake.request(); });

  /* ---------- alertes ---------- */
  let actx = null;
  const alerts = {
    /** À appeler depuis un geste de l'utilisateur (toucher) : les navigateurs interdisent le son avant. */
    unlock() {
      try {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (AC && !actx) actx = new AC();
        if (actx && actx.state === 'suspended') actx.resume();
        if (globalThis.speechSynthesis) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; globalThis.speechSynthesis.speak(u); }
      } catch (e) { /* sans son */ }
    },
    /** Notes jouées à la suite : [{f (Hz), d (ms)}]. */
    tones(list, vol) {
      if (!actx) return;
      let t = actx.currentTime + 0.01;
      for (const n of list) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = n.f;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol || 0.35, t + 0.01); g.gain.setValueAtTime(vol || 0.35, t + n.d / 1000 - 0.03); g.gain.linearRampToValueAtTime(0, t + n.d / 1000);
        o.connect(g); g.connect(actx.destination);
        o.start(t); o.stop(t + n.d / 1000 + 0.02);
        t += n.d / 1000 + 0.04;
      }
    },
    vibrate(pattern) {
      try {
        // Chrome refuse de vibrer tant que la page n'a pas reçu un toucher
        if (nav.vibrate && !(nav.userActivation && !nav.userActivation.hasBeenActive)) nav.vibrate(pattern);
      } catch (e) { /* rien */ }
    },
    speak(text) {
      try {
        const ss = globalThis.speechSynthesis;
        if (!ss) return;
        ss.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'fr-FR'; u.rate = 1.05;
        ss.speak(u);
      } catch (e) { /* sans voix */ }
    },
  };
  /** Sons types : monter (deux notes montantes), baisser, info, alerte, nutrition. */
  alerts.PATTERNS = {
    up: { tones: [{ f: 660, d: 110 }, { f: 880, d: 150 }], vib: [120, 60, 120] },
    down: { tones: [{ f: 880, d: 110 }, { f: 550, d: 150 }], vib: [250] },
    info: { tones: [{ f: 784, d: 140 }], vib: [80] },
    plan: { tones: [{ f: 698, d: 90 }, { f: 880, d: 90 }, { f: 1047, d: 120 }], vib: [60, 40, 60, 40, 60] },
    eat: { tones: [{ f: 988, d: 100 }, { f: 740, d: 100 }, { f: 988, d: 140 }], vib: [150, 80, 150] },
    warn: { tones: [{ f: 1000, d: 90 }, { f: 1000, d: 90 }, { f: 1000, d: 90 }], vib: [300, 100, 300, 100, 300] },
  };

  PYR.sensors = { gps, power, hr, trainer, wake, alerts, parsePower, parseFtms, parseHr, ftmsSimBytes, makeTrainer, navigator: null, reconnectMs: 0 };
})(globalThis.PYR = globalThis.PYR || {});
