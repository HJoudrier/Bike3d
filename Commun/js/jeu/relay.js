/* author : Hugo Joudrier-Faure */
/* PaceYourRide — relais de mise en relation des courses en direct.
 *
 * Avant de se parler directement (WebRTC), deux navigateurs doivent échanger une offre et une
 * réponse. Pour éviter de renvoyer un code à la main, ces quelques messages passent par un
 * service public de publication / abonnement : ntfy.sh par défaut (gratuit, sans compte).
 *   - chaque course a son canal, d'identifiant aléatoire ;
 *   - les messages sont chiffrés (AES-GCM) avec la clé contenue dans le QR code : le relais ne
 *     voit que du texte illisible et ne peut pas en fabriquer ;
 *   - ils ne sont pas conservés sur le relais (cache=no) ;
 *   - une fois les navigateurs reliés, plus rien ne passe par le relais.
 * Protocole ntfy : POST <relais>/<canal> pour publier, flux SSE <relais>/<canal>/sse pour s'abonner.
 * Un serveur ntfy personnel peut remplacer ntfy.sh (clé localStorage « pyr.relay ») : son adresse
 * est alors incluse dans le QR code. */
(function (PYR) {
  'use strict';

  const C = PYR.codec;
  const DEFAULT_URL = 'https://ntfy.sh';
  const OPEN_TIMEOUT = 8000;
  const REOPEN_MS = 10000;

  /** Relais choisi par l'organisateur (null = relais par défaut). */
  function customUrl() {
    try {
      const v = localStorage.getItem('pyr.relay');
      if (v && /^https?:\/\/\S+$/.test(v)) {
        const u = v.replace(/\/+$/, '');
        return u === DEFAULT_URL ? null : u;
      }
    } catch (e) { /* stockage indisponible */ }
    return null;
  }

  /** Le navigateur sait-il passer par le relais ? (le chiffrement exige une page https ou locale) */
  function available() {
    return typeof EventSource !== 'undefined' && typeof fetch === 'function' && !!(globalThis.crypto && globalThis.crypto.subtle);
  }

  /* ---------- chiffrement ---------- */
  function importKey(bytes) {
    return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    return C.toB64u(out);
  }

  async function unseal(key, text) {
    const b = C.fromB64u(text);
    if (b.length < 12 + 16 + 2) throw new Error('Message trop court');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  /**
   * S'abonne au canal d'une salle ({id, key, relay}). Renvoie {send(obj), close(), status}.
   * handlers.onMessage(obj) : chaque message déchiffré (y compris ceux qu'on a soi-même envoyés) ;
   * handlers.onStatus(état) : 'connecting' | 'open' | 'error'.
   */
  function connect(room, handlers) {
    const base = (room.relay || DEFAULT_URL).replace(/\/+$/, '');
    const topic = C.roomTopic(room.id);
    const keyP = importKey(room.key);
    let closed = false, status = 'connecting', es = null, openTimer = null, reopenTimer = null;

    const setStatus = (s) => {
      if (closed || s === status) return;
      status = s;
      if (handlers.onStatus) handlers.onStatus(s);
    };

    function subscribe() {
      es = new EventSource(`${base}/${topic}/sse`);
      // ntfy envoie d'abord un évènement nommé « open » ; chaque message arrive ensuite sans nom
      es.addEventListener('open', () => setStatus('open'));
      es.onmessage = async (ev) => {
        let d;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (!d || d.event !== 'message' || typeof d.message !== 'string') return;
        let obj;
        try { obj = await unseal(await keyP, d.message); } catch (e) { return; } // autre clé ou message altéré
        if (!closed && obj && typeof obj.t === 'string' && handlers.onMessage) handlers.onMessage(obj);
      };
      es.onerror = () => {
        if (closed) return;
        if (es.readyState === EventSource.CLOSED) {
          // refus du relais (limite de débit, panne…) : nouvel essai un peu plus tard
          setStatus('error');
          clearTimeout(reopenTimer);
          reopenTimer = setTimeout(() => { if (!closed) subscribe(); }, REOPEN_MS);
        } else if (status === 'open') {
          setStatus('connecting'); // coupure réseau : le navigateur se reconnecte seul
        }
      };
    }

    subscribe();
    openTimer = setTimeout(() => { if (status === 'connecting') setStatus('error'); }, OPEN_TIMEOUT);

    return {
      get status() { return status; },
      /** Publie un message chiffré (non conservé par le relais). */
      async send(obj) {
        if (closed) return;
        const body = await seal(await keyP, obj);
        const res = await fetch(`${base}/${topic}?cache=no&firebase=no`, { method: 'POST', body });
        if (!res.ok) throw new Error(`Relais : erreur ${res.status}`);
      },
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(openTimer);
        clearTimeout(reopenTimer);
        if (es) es.close();
      },
    };
  }

  PYR.relay = { available, connect, customUrl, DEFAULT_URL, _seal: seal, _unseal: unseal, _importKey: importKey };
})(globalThis.PYR = globalThis.PYR || {});
