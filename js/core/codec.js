/* author : Hugo Joudrier-Faure */
/* PaceYourRide — encodages pour le partage sans serveur :
 *   - base64url, compression deflate (API CompressionStream du navigateur) ;
 *   - JSON compressé pour les défis (lien, code ou fichier) ;
 *   - codes d'invitation WebRTC compacts (offre / réponse) pour le copier-coller et les QR codes ;
 *   - code de salle (identifiant + clé) pour rejoindre une course via le relais ;
 *   - empreinte (hachage FNV-1a) pour reconnaître un parcours. */
(function (PYR) {
  'use strict';

  const C = {};

  /* ---------- base64url ---------- */
  C.toB64u = function (bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  C.fromB64u = function (str) {
    let t = String(str).replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  /* ---------- compression ---------- */
  C.canCompress = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

  async function pipe(bytes, stream) {
    const out = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(out).arrayBuffer());
  }
  C.deflate = (bytes) => pipe(bytes, new CompressionStream('deflate-raw'));
  C.inflate = (bytes) => pipe(bytes, new DecompressionStream('deflate-raw'));

  /** Objet → texte compact : « 1 » + base64url(deflate(JSON)) (ou « 0 » + JSON non compressé). */
  C.packJson = async function (obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (C.canCompress) return '1' + C.toB64u(await C.deflate(bytes));
    return '0' + C.toB64u(bytes);
  };

  C.unpackJson = async function (str) {
    const t = String(str).trim();
    const kind = t[0];
    let bytes = C.fromB64u(t.slice(1));
    if (kind === '1') bytes = await C.inflate(bytes);
    else if (kind !== '0') throw new Error('Code non reconnu');
    return JSON.parse(new TextDecoder().decode(bytes));
  };

  /* ---------- tableaux d'entiers ---------- */
  C.delta = function (a) {
    const out = new Array(a.length);
    let prev = 0;
    for (let i = 0; i < a.length; i++) { out[i] = a[i] - prev; prev = a[i]; }
    return out;
  };
  C.undelta = function (d) {
    const out = new Array(d.length);
    let acc = 0;
    for (let i = 0; i < d.length; i++) { acc += d[i]; out[i] = acc; }
    return out;
  };

  /* ---------- empreinte FNV-1a 32 bits ---------- */
  C.hash = function (...parts) {
    let h = 0x811c9dc5;
    const byte = (b) => { h ^= b & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
    for (const p of parts) {
      if (typeof p === 'string') {
        for (let i = 0; i < p.length; i++) { const c = p.charCodeAt(i); byte(c); byte(c >> 8); }
      } else if (p && p.length !== undefined) {
        for (let i = 0; i < p.length; i++) { const v = p[i] | 0; byte(v); byte(v >> 8); byte(v >> 16); byte(v >> 24); }
      } else {
        const s = String(p);
        for (let i = 0; i < s.length; i++) byte(s.charCodeAt(i));
      }
      byte(0x1f);
    }
    return h.toString(16).padStart(8, '0');
  };

  /* ======================================================================
   * Codes d'invitation WebRTC (offre / réponse)
   * On ne garde de la description SDP que l'indispensable (identifiants ICE, empreinte DTLS,
   * candidats UDP), dans un format binaire d'une centaine d'octets, puis on reconstruit
   * une SDP standard « canal de données » de l'autre côté.
   * ==================================================================== */
  const PREFIX = 'PYR.';
  const SETUPS = ['actpass', 'active', 'passive'];
  const CTYPES = ['host', 'srflx', 'prflx', 'relay'];
  const MAX_CANDIDATES = 8;

  function parseSdp(sdp) {
    const r = { candidates: [], mid: '0', sctpPort: 5000, maxMsg: 262144, setup: 'actpass' };
    for (const raw of String(sdp).split(/\r?\n/)) {
      const l = raw.trim();
      if (l.startsWith('a=ice-ufrag:')) r.ufrag = l.slice(12);
      else if (l.startsWith('a=ice-pwd:')) r.pwd = l.slice(10);
      else if (l.startsWith('a=fingerprint:')) r.fingerprint = l.slice(14).trim();
      else if (l.startsWith('a=setup:')) r.setup = l.slice(8);
      else if (l.startsWith('a=mid:')) r.mid = l.slice(6);
      else if (l.startsWith('a=sctp-port:')) r.sctpPort = parseInt(l.slice(12), 10) || 5000;
      else if (l.startsWith('a=max-message-size:')) r.maxMsg = parseInt(l.slice(19), 10) || 262144;
      else if (l.startsWith('a=candidate:')) {
        const t = l.slice(12).split(/\s+/);
        // fondation composante protocole priorité adresse port typ type …
        if (t.length < 8 || t[1] !== '1' || t[2].toLowerCase() !== 'udp' || t[6] !== 'typ') continue;
        const type = CTYPES.indexOf(t[7]);
        if (type < 0) continue;
        r.candidates.push({ priority: Number(t[3]) >>> 0, address: t[4], port: Number(t[5]) & 0xffff, type });
      }
    }
    if (!r.ufrag || !r.pwd || !r.fingerprint) throw new Error('Description WebRTC incomplète');
    return r;
  }

  // ordre de préférence : réflexifs (Internet), relais, puis locaux IPv4, mDNS, IPv6
  function candRank(c) {
    if (c.type === 1 || c.type === 3) return 0;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(c.address)) return 1;
    if (/\.local$/i.test(c.address)) return 2;
    return 3;
  }

  const UUID_LOCAL = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

  function ipv6Bytes(a) {
    let [head, tail] = a.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
    let groups;
    if (t === null) groups = h;
    else groups = h.concat(new Array(8 - h.length - t.length).fill('0'), t);
    if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
    const out = [];
    for (const g of groups) { const v = parseInt(g, 16); out.push(v >> 8, v & 0xff); }
    return out;
  }

  class Writer {
    constructor() { this.b = []; }
    u8(v) { this.b.push(v & 0xff); }
    u16(v) { this.b.push((v >> 8) & 0xff, v & 0xff); }
    u32(v) { this.b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); }
    varint(v) { v = Math.max(0, Math.floor(v)); do { let x = v % 128; v = Math.floor(v / 128); if (v > 0) x |= 0x80; this.b.push(x); } while (v > 0); }
    str(s) { const e = new TextEncoder().encode(s); if (e.length > 255) throw new Error('Chaîne trop longue'); this.u8(e.length); for (const x of e) this.b.push(x); }
    bytes(a) { for (const x of a) this.b.push(x & 0xff); }
    out() { return Uint8Array.from(this.b); }
  }
  class Reader {
    constructor(b) { this.b = b; this.i = 0; }
    need(n) { if (this.i + n > this.b.length) throw new Error('Code tronqué'); }
    u8() { this.need(1); return this.b[this.i++]; }
    u16() { this.need(2); const v = (this.b[this.i] << 8) | this.b[this.i + 1]; this.i += 2; return v; }
    u32() { this.need(4); const v = ((this.b[this.i] << 24) | (this.b[this.i + 1] << 16) | (this.b[this.i + 2] << 8) | this.b[this.i + 3]) >>> 0; this.i += 4; return v; }
    varint() { let v = 0, mul = 1, x; do { x = this.u8(); v += (x & 0x7f) * mul; mul *= 128; } while (x & 0x80); return v; }
    str() { const n = this.u8(); this.need(n); const s = new TextDecoder().decode(this.b.subarray(this.i, this.i + n)); this.i += n; return s; }
    bytes(n) { this.need(n); const a = this.b.subarray(this.i, this.i + n); this.i += n; return a; }
  }

  /**
   * SDP → code texte.  kind : 'offer' | 'answer' ; invite : entier 32 bits reliant la réponse à l'invitation.
   */
  C.sdpToCode = function (sdp, kind, invite) {
    const p = parseSdp(sdp);
    const w = new Writer();
    const setup = Math.max(0, SETUPS.indexOf(p.setup));
    w.u8((1 << 4) | ((kind === 'answer' ? 1 : 0) << 3) | (setup << 1));
    w.u32(invite >>> 0);
    w.str(p.ufrag); w.str(p.pwd); w.str(p.mid);
    const fp = p.fingerprint.match(/^sha-256\s+((?:[0-9A-F]{2}:){31}[0-9A-F]{2})$/i);
    if (fp) { w.u8(0); w.bytes(fp[1].split(':').map((x) => parseInt(x, 16))); }
    else { w.u8(1); w.str(p.fingerprint); }
    w.varint(p.maxMsg);
    w.varint(p.sctpPort);
    const cands = p.candidates.slice().sort((a, b) => candRank(a) - candRank(b)).slice(0, MAX_CANDIDATES);
    w.u8(cands.length);
    for (const c of cands) {
      let kindA = 3, addr = null;
      const m4 = c.address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      const mu = c.address.match(UUID_LOCAL);
      if (m4) { kindA = 0; addr = m4.slice(1).map(Number); }
      else if (mu) { kindA = 2; addr = []; for (const hex of mu.slice(1).join('').match(/../g)) addr.push(parseInt(hex, 16)); }
      else if (c.address.includes(':')) { const b = ipv6Bytes(c.address); if (b) { kindA = 1; addr = b; } }
      w.u8(c.type | (kindA << 2));
      if (kindA === 3) w.str(c.address); else w.bytes(addr);
      w.u16(c.port);
      w.u32(c.priority);
    }
    return PREFIX + C.toB64u(w.out());
  };

  /**
   * Lit un code collé ou scanné (seul ou dans un lien #live=…) :
   *   - code de salle : {type: 'room', id, key, relay, topic} ;
   *   - offre ou réponse WebRTC : {type: 'offer' | 'answer', invite, sdp}.
   * Message clair si le texte n'est pas un code.
   */
  C.readCode = function (code) {
    const text = String(code || '').trim();
    if (!text) throw new Error('Colle d\'abord le code reçu (il commence par « PYR. »).');
    if (/#defi=/.test(text)) throw new Error('C\'est un lien de défi en différé : ouvre-le avec « Ouvrir un défi reçu ».');
    try {
      const bytes = C.fromB64u(C.extractCode(text));
      if ((bytes[0] >> 4) === ROOM_VERSION) return parseRoom(bytes);
      const r = parseCode(bytes);
      return { type: r.kind, invite: r.invite, sdp: r.sdp };
    } catch (e) {
      throw new Error('Code illisible : vérifie qu\'il a été copié en entier (il commence par « PYR. »).');
    }
  };

  /** Code d'offre ou de réponse → {kind, invite, sdp}. */
  C.codeToSdp = function (code) {
    const r = C.readCode(code);
    if (r.type === 'room') throw new Error('C\'est un code de salle : il s\'utilise avec « Rejoindre une course ».');
    return { kind: r.type, invite: r.invite, sdp: r.sdp };
  };

  function parseCode(bytes) {
    const r = new Reader(bytes);
    const head = r.u8();
    if ((head >> 4) !== 1) throw new Error('Version de code inconnue');
    const kind = (head >> 3) & 1 ? 'answer' : 'offer';
    const setup = SETUPS[(head >> 1) & 3] || 'actpass';
    const invite = r.u32();
    const ufrag = r.str(), pwd = r.str(), mid = r.str();
    let fingerprint;
    if (r.u8() === 0) fingerprint = 'sha-256 ' + Array.from(r.bytes(32), (x) => x.toString(16).toUpperCase().padStart(2, '0')).join(':');
    else fingerprint = r.str();
    const maxMsg = r.varint(), sctpPort = r.varint();
    const n = r.u8();
    const lines = [];
    for (let k = 0; k < n; k++) {
      const f = r.u8();
      const type = CTYPES[f & 3], kindA = (f >> 2) & 3;
      let address;
      if (kindA === 0) address = Array.from(r.bytes(4)).join('.');
      else if (kindA === 1) { const b = r.bytes(16); const g = []; for (let i = 0; i < 16; i += 2) g.push(((b[i] << 8) | b[i + 1]).toString(16)); address = g.join(':'); }
      else if (kindA === 2) { const hx = Array.from(r.bytes(16), (x) => x.toString(16).padStart(2, '0')).join(''); address = `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20)}.local`; }
      else address = r.str();
      const port = r.u16(), priority = r.u32();
      let line = `a=candidate:${k + 1} 1 udp ${priority} ${address} ${port} typ ${type}`;
      if (type !== 'host') line += ' raddr 0.0.0.0 rport 0';
      lines.push(line);
    }
    let sess = '';
    for (let i = 0; i < 18; i++) sess += Math.floor(Math.random() * 10);
    const sdp = [
      'v=0',
      `o=- ${sess.replace(/^0+/, '1')} 2 IN IP4 127.0.0.1`,
      's=-',
      't=0 0',
      `a=group:BUNDLE ${mid}`,
      'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      ...lines,
      `a=ice-ufrag:${ufrag}`,
      `a=ice-pwd:${pwd}`,
      `a=fingerprint:${fingerprint}`,
      `a=setup:${setup}`,
      `a=mid:${mid}`,
      `a=sctp-port:${sctpPort}`,
      `a=max-message-size:${maxMsg}`,
      '',
    ].join('\r\n');
    return { kind, invite, sdp };
  }

  /** Extrait le code d'un texte collé (code seul, lien #live=…, avec espaces ou retours à la ligne). */
  C.extractCode = function (text) {
    let t = String(text || '').trim();
    const m = t.match(/#live=([A-Za-z0-9._\-\s]+)/);
    if (m) t = decodeURIComponent(m[1]);
    t = t.replace(/\s+/g, '');
    if (t.startsWith(PREFIX)) t = t.slice(PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(t)) throw new Error('Code invalide');
    return t;
  };

  /* ======================================================================
   * Code de salle (mise en relation par relais) : identifiant de salle + clé de chiffrement,
   * et adresse du relais quand ce n'est pas celui par défaut. Une quarantaine de caractères.
   * ==================================================================== */
  const ROOM_VERSION = 2;
  const ROOM_ID_BYTES = 9, ROOM_KEY_BYTES = 16;

  C.newRoom = function (relay) {
    const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
    return { id: rnd(ROOM_ID_BYTES), key: rnd(ROOM_KEY_BYTES), relay: relay || null };
  };

  C.roomToCode = function ({ id, key, relay }) {
    const w = new Writer();
    w.u8((ROOM_VERSION << 4) | (relay ? 1 : 0));
    w.bytes(id);
    w.bytes(key);
    if (relay) w.str(relay);
    return PREFIX + C.toB64u(w.out());
  };

  function parseRoom(bytes) {
    const r = new Reader(bytes);
    const head = r.u8();
    const id = Uint8Array.from(r.bytes(ROOM_ID_BYTES));
    const key = Uint8Array.from(r.bytes(ROOM_KEY_BYTES));
    const relay = head & 1 ? r.str() : null;
    if (relay && !/^https?:\/\/[^\s]+$/.test(relay)) throw new Error('Relais invalide');
    return { type: 'room', id, key, relay, topic: C.roomTopic(id) };
  }

  /** Nom du canal sur le relais (ne révèle pas la clé). */
  C.roomTopic = (id) => 'pyr_' + C.toB64u(id);

  C.CODE_PREFIX = PREFIX;
  PYR.codec = C;
})(globalThis.PYR = globalThis.PYR || {});
