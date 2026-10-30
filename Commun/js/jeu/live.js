/* author : Hugo Joudrier-Faure */
/* PaceYourRide — course en direct, sans serveur de jeu (WebRTC pair-à-pair).
 *
 * - Topologie en étoile : l'organisateur est relié à chaque invité et relaie les messages.
 * - Mise en relation : l'organisateur partage un seul QR code (ou lien) pour tous. Le joueur qui
 *   le scanne envoie une demande par le relais (relay.js : quelques messages chiffrés), les deux
 *   navigateurs échangent automatiquement offre et réponse, puis le joueur attend en salle
 *   d'attente que l'organisateur l'accepte.
 * - Secours sans relais : échange manuel d'une invitation et d'une réponse (codes ou QR codes).
 * - Des serveurs STUN publics (Google, Cloudflare) servent à découvrir les adresses ; aucune
 *   donnée de jeu ne passe par eux ni par le relais.
 * - Chaque navigateur simule son propre cycliste et diffuse sa position deux fois par seconde.
 * - Départ à l'heure fixée par l'organisateur ; les horloges des invités sont synchronisées
 *   sur celle de l'organisateur (aller-retour ping/pong). */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store, C = PYR.codec, R = PYR.raceData, Cl = PYR.classif, CV = PYR.classifView;
  const { h, $ } = D;

  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const GATHER_MS = 4000;
  const CHUNK = 12000;
  const HOST_ID = 'host';
  const MAX_POINTS = 200000;
  const RETRY_MS = 4000;      // relais : renvoi d'une demande ou d'une réponse restée sans suite
  const SMOOTH_S = 0.12;      // direct : constante de temps du lissage de l'affichage des positions distantes (s)
  const MAX_TRIES = 8;
  const MAX_REQUESTS = 12;    // demandes en salle d'attente
  const NETWORK_FAIL = 'Connexion impossible : vos réseaux bloquent la liaison directe (pare-feu, NAT). Essayez un autre réseau (partage de connexion 4G…) ou un défi en différé.';

  let S = null;        // session en cours
  let clock = null;    // minuterie d'affichage

  const COLORS = () => PYR.challenges.COLORS;
  const cleanName = (x) => String(x || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30) || 'Cycliste';
  const cleanId = (x) => String(x || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || U.uid();
  const myName = () => String(store.state.rider.name || '').trim();
  const courseLength = () => (S && S.race ? S.race.course.step * (S.race.course.n - 1) : 0);

  /* ======================================================================
   * Transport : messages JSON, découpés au-delà de CHUNK caractères
   * ==================================================================== */
  function sendRaw(dc, msg) {
    if (!dc || dc.readyState !== 'open') return;
    const s = JSON.stringify(msg);
    if (s.length <= CHUNK) { dc.send(s); return; }
    const key = U.uid(), n = Math.ceil(s.length / CHUNK);
    for (let i = 0; i < n; i++) dc.send(JSON.stringify({ type: '_part', key, i, n, part: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
  }

  function makeReceiver(onMessage) {
    const parts = new Map();
    return (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === '_part') {
        if (!(msg.n > 0 && msg.n < 2000 && msg.i >= 0 && msg.i < msg.n)) return;
        let p = parts.get(msg.key);
        if (!p) { p = { n: msg.n, got: 0, arr: new Array(msg.n) }; parts.set(msg.key, p); }
        if (p.arr[msg.i] === undefined) { p.arr[msg.i] = String(msg.part); p.got++; }
        if (p.got === p.n) {
          parts.delete(msg.key);
          let full;
          try { full = JSON.parse(p.arr.join('')); } catch (e) { return; }
          onMessage(full);
        }
        return;
      }
      onMessage(msg);
    };
  }

  function waitGathering(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      const done = () => {
        if (pc.iceGatheringState !== 'complete') return;
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, GATHER_MS);
    });
  }

  function broadcast(msg, exceptId) {
    if (!S || S.role !== 'host') return;
    for (const l of S.links) if (l.admitted && l.id !== exceptId) sendRaw(l.dc, msg);
  }

  function toHost(msg) { if (S && S.role === 'guest') sendRaw(S.dc, msg); }

  /** Lien d'invitation cliquable (seulement si l'application est hébergée en http/https). */
  function inviteLink(code) {
    return /^https?:$/.test(location.protocol) ? `${location.origin}${location.pathname}#live=${code}` : null;
  }

  /* ======================================================================
   * Données de course
   * ==================================================================== */
  function packRace(r) {
    return { id: r.id, title: r.title, host: r.host, fair: r.fair, rider: r.fair ? r.rider : undefined, bike: r.fair ? r.bike : undefined, startAt: r.startAt, rules: r.rules, cps: r.cps, feed: r.feed, course: R.packCourse(r.course) };
  }

  function unpackRace(p) {
    if (!p || !p.course) throw new Error('Course invalide');
    const course = R.unpackCourse(p.course);
    if (!(course.n > 1 && course.n < MAX_POINTS) || course.lat.length !== course.n || course.lng.length !== course.n || course.ele.length !== course.n) throw new Error('Parcours invalide');
    const rules = PYR.race.normRules(p.rules);
    // sprints et sommets fixés par l'organisateur (une ancienne version n'en envoie pas : on les déduit des règles)
    const cps = Array.isArray(p.cps) ? Cl.normalize(p.cps, course.step * (course.n - 1)) : Cl.build(R.geometryProfile(course), rules);
    // zones de ravitaillement fixées par l'organisateur (une ancienne version n'en envoie pas : on les déduit des règles)
    const feed = Array.isArray(p.feed) ? PYR.feed.normalize(p.feed, course.step * (course.n - 1)) : PYR.feed.build(R.geometryProfile(course), rules);
    return { id: String(p.id), title: cleanName(p.title).slice(0, 60), host: cleanName(p.host), fair: !!p.fair, rider: p.rider, bike: p.bike, startAt: Number(p.startAt) || null, rules, cps, feed, course };
  }

  function lobbyMessage() {
    return {
      type: 'lobby',
      players: [...S.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, status: p.status })),
      startAt: S.race.startAt, fair: S.race.fair,
      rider: S.race.fair ? S.race.rider : undefined, bike: S.race.fair ? S.race.bike : undefined,
    };
  }

  function applyState(id, m) {
    const p = S && S.players.get(id);
    if (!p || p.finished) return;
    p.s = U.clamp(Number(m.s) || 0, 0, courseLength());
    p.v = U.clamp(Number(m.v) || 0, 0, 40);
    p.P = Number(m.P) || 0;
    p.w = U.clamp(Number(m.w) || 0, 0, 1);
    p.t = Number(m.t) || 0;
    // tactique et incident : pour l'aspiration et la rotation des relais chez les autres
    p.tac = /^[a-z]{1,12}$/.test(String(m.tac)) ? String(m.tac) : 'manual';
    p.ph = /^[a-z]{1,8}$/.test(String(m.ph)) ? String(m.ph) : null;
    p.inc = m.inc === 'puncture' || m.inc === 'crash' ? m.inc : null;
    // présence : avatar (a), home-trainer (t) ou cycliste sur la vraie route (r) ; absente chez une ancienne version : avatar
    p.kind = PYR.presence ? PYR.presence.fromCode(m.k) : 'avatar';
    // peloton en 2D : position latérale (m, + = à droite) ; absente chez une ancienne version, il est alors placé chez nous
    p.y = m.y !== undefined && m.y !== null && Number.isFinite(Number(m.y)) ? U.clamp(Number(m.y), -15, 15) : undefined;
    // temps de passage aux sprints et aux sommets (classements annexes)
    const sp = Cl.cleanSplits(m.sp, S.race.cps.length);
    if (sp) p.sp = sp;
    p.at = Date.now();
  }

  function applyFinish(id, m) {
    const p = S && S.players.get(id);
    if (!p || p.finished) return;
    let e;
    try { e = R.unpackEntry(m.entry); } catch (err) { return; }
    if (!(e.time > 0) || !Array.isArray(e.s) || !Array.isArray(e.P)) return;
    e.name = p.name;
    e.id = e.id ? String(e.id).slice(0, 40) : U.uid();
    if (e.sp !== undefined) e.sp = Cl.cleanSplits(e.sp, S.race.cps.length) || undefined;
    p.entry = e;
    p.finished = true;
    p.time = e.time;
    p.s = courseLength();
    checkDone();
    render();
  }

  /** La course est terminée quand tous les joueurs encore présents sont arrivés. */
  function checkDone() {
    if (!S || !S.race || (S.phase !== 'racing' && S.phase !== 'lobby')) return;
    const present = [...S.players.values()].filter((x) => x.status !== 'left');
    if (present.length && present.every((x) => x.finished)) S.phase = 'done';
  }

  /** Charge le parcours de la course dans le projet (identique pour tous). */
  function ensureCourse() {
    if (R.currentSignature(store.state) !== S.signature) PYR.challenges.applyCourse(S.race.course);
  }

  /** Prépare le jeu pour le départ (heure locale corrigée du décalage d'horloge). */
  function arm() {
    if (!S || !S.race || !S.race.startAt || !S.courseLoaded) return;
    ensureCourse();
    const local = S.race.startAt - (S.role === 'guest' ? S.offset : 0);
    S.armedAt = local;
    if (store.state.ui.tab !== 'game') PYR.app.showTab('game');
    PYR.tabGame.armLive(local);
    render();
  }

  /* ======================================================================
   * Organisateur
   * ==================================================================== */
  function hostCreate({ title, fair }) {
    if (!store.profile) throw new Error('Trace d\'abord un parcours (page Parcours).');
    if (!myName()) throw new Error('Indique d\'abord ton nom.');
    if (S) leave(true);
    const course = R.canonicalCourse(store.profile, store.state);
    PYR.routeModel.setFixed(R.courseGeometry(course));
    const rider = JSON.parse(JSON.stringify(store.state.rider));
    delete rider.name;
    const rules = PYR.race.normRules(store.state.game);
    S = {
      role: 'host',
      me: { id: HOST_ID, name: myName() },
      race: {
        id: U.uid() + U.uid(), title: String(title || '').trim().slice(0, 60) || `Course de ${myName()}`, host: myName(), fair: !!fair,
        rider, bike: JSON.parse(JSON.stringify(store.state.bike)), startAt: null, rules, course,
        cps: Cl.fromList(store.state.checkpoints, R.geometryProfile(course)), // sprints et sommets du parcours, les mêmes pour tous
        feed: PYR.feed.fromList(store.state.feedZones, R.geometryProfile(course)), // zones de ravitaillement, les mêmes pour tous
      },
      signature: R.courseSignature(course),
      players: new Map(),
      links: [],
      requests: new Map(), // salle d'attente : joueurs arrivés par le relais, à accepter ou refuser
      room: null, roomCode: null, relay: null, relayStatus: 'off',
      phase: 'lobby',
      joinOpen: true,
      courseLoaded: true,
    };
    S.players.set(HOST_ID, { id: HOST_ID, name: myName(), color: COLORS()[0], status: 'host', s: 0, v: 0 });
    openRoom();
    startClock();
    render();
  }

  /** Salle de la course sur le relais : les joueurs y demandent à entrer grâce au QR code. */
  function openRoom() {
    if (!PYR.relay || !PYR.relay.available()) { S.relayStatus = 'unavailable'; return; }
    const sess = S;
    sess.room = C.newRoom(PYR.relay.customUrl());
    sess.roomCode = C.roomToCode(sess.room);
    sess.relayStatus = 'connecting';
    sess.relay = PYR.relay.connect(sess.room, {
      onStatus: (st) => { if (S !== sess) return; sess.relayStatus = st; renderRoom(); },
      onMessage: (m) => { if (S === sess) hostOnRelay(m); },
    });
  }

  function relaySend(msg) {
    if (S && S.relay) S.relay.send(msg).catch(() => { /* le joueur renverra sa demande */ });
  }

  /** Messages du relais : demandes d'accès, réponses et départs des joueurs. */
  async function hostOnRelay(m) {
    const gid = cleanId(m.from);
    if (m.t === 'hello') {
      if (!S.joinOpen || S.phase !== 'lobby') { relaySend({ t: 'closed', to: gid }); return; }
      const known = S.requests.get(gid);
      if (known) {
        // demande répétée (message perdu en route) : on renvoie l'invitation
        if (known.link && known.link.status === 'invited') relaySend({ t: 'offer', to: gid, code: known.link.code });
        return;
      }
      if (S.players.has(gid)) return;
      if (S.requests.size >= MAX_REQUESTS) { relaySend({ t: 'closed', to: gid, why: 'full' }); return; }
      const req = { gid, name: cleanName(m.name), state: 'connecting', link: null };
      S.requests.set(gid, req);
      renderRoom();
      const sess = S;
      let link;
      try { link = await hostInvite(gid); } catch (e) { req.state = 'failed'; renderRoom(); return; }
      if (S !== sess || S.requests.get(gid) !== req) { try { link.pc.close(); } catch (e) { /* déjà fermé */ } return; }
      req.link = link;
      relaySend({ t: 'offer', to: gid, code: link.code });
    } else if (m.t === 'answer') {
      const req = S.requests.get(gid);
      if (!req || !req.link || req.link.status !== 'invited') return; // doublon
      try { await hostAcceptAnswer(m.code); } catch (e) { /* réponse illisible : ignorée */ }
    } else if (m.t === 'bye') {
      const req = S.requests.get(gid);
      if (!req) return;
      S.requests.delete(gid);
      if (req.link) { try { req.link.pc.close(); } catch (e) { /* déjà fermé */ } }
      renderRoom();
    }
  }

  /**
   * Crée une invitation WebRTC (offre). gid : joueur arrivé par le relais, qui passera par la
   * salle d'attente ; sans gid, invitation manuelle (la réponse collée vaut validation).
   */
  async function hostInvite(gid) {
    const invite = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const dc = pc.createDataChannel('pyr', { ordered: true });
    const sess = S;
    const link = { id: null, gid: gid || null, name: null, pc, dc, invite, status: 'invited', code: null, admitted: false };
    sess.links.push(link);
    dc.onopen = () => { link.status = 'open'; if (S === sess) render(); };
    dc.onmessage = makeReceiver((msg) => { if (S === sess) hostOnMessage(link, msg); });
    dc.onclose = () => {
      link.status = 'closed';
      if (S !== sess) return;
      const req = link.gid && sess.requests.get(link.gid);
      if (req && req.link === link) { sess.requests.delete(link.gid); renderRoom(); }
      const p = link.admitted && sess.players.get(link.id);
      if (p && !p.finished) { p.status = 'left'; broadcast(lobbyMessage()); checkDone(); }
      render();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== 'failed') return;
      link.status = 'failed';
      if (S !== sess) return;
      const req = link.gid && sess.requests.get(link.gid);
      if (req && req.link === link) { req.state = 'failed'; renderRoom(); }
      render();
      if (link.onFail) link.onFail();
    };
    await pc.setLocalDescription(await pc.createOffer());
    await waitGathering(pc);
    link.code = C.sdpToCode(pc.localDescription.sdp, 'offer', invite);
    return link;
  }

  async function hostAcceptAnswer(text) {
    const r = C.readCode(text);
    if (r.type !== 'answer') throw new Error(r.type === 'room' ? 'C\'est le code de ta course : il faut la réponse de ton ami.' : 'Ce code est une invitation : il faut la réponse de ton ami.');
    const link = S.links.find((l) => l.invite === r.invite);
    if (!link) throw new Error('Cette réponse ne correspond à aucune invitation en cours.');
    if (link.status !== 'invited') throw new Error('Cette invitation a déjà été utilisée.');
    link.status = 'connecting';
    await link.pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
    render();
    return link;
  }

  function hostOnMessage(link, msg) {
    switch (msg.type) {
      case 'hello': {
        if (link.id) return;
        if (!S.joinOpen || S.phase !== 'lobby') { sendRaw(link.dc, { type: 'late' }); return; }
        const id = cleanId(msg.id);
        if (S.players.has(id) || (link.gid && link.gid !== id)) return;
        link.id = id;
        link.name = cleanName(msg.name);
        if (!link.gid) { admit(link); break; } // échange manuel : la réponse collée vaut validation
        // arrivée par le relais : le joueur attend que l'organisateur valide son accès
        const req = S.requests.get(link.gid);
        if (!req || req.link !== link) { sendRaw(link.dc, { type: 'refused' }); return; }
        req.state = 'ready';
        req.name = link.name;
        sendRaw(link.dc, { type: 'waiting' });
        D.toast(`${req.name} demande à rejoindre la course.`);
        renderRoom();
        break;
      }
      case 'ping':
        sendRaw(link.dc, { type: 'pong', k: msg.k, t0: msg.t0, th: Date.now() });
        break;
      case 'state':
        if (!link.admitted) return;
        applyState(link.id, msg);
        broadcast(Object.assign({}, msg, { id: link.id }), link.id);
        break;
      case 'finish':
        if (!link.admitted) return;
        applyFinish(link.id, msg);
        broadcast({ type: 'finish', id: link.id, entry: msg.entry }, link.id);
        break;
      case 'bye': {
        const req = link.gid && S.requests.get(link.gid);
        if (req && req.link === link) { S.requests.delete(link.gid); renderRoom(); }
        const p = link.admitted && S.players.get(link.id);
        if (p && !p.finished) { p.status = 'left'; broadcast(lobbyMessage()); checkDone(); render(); }
        break;
      }
      default:
    }
  }

  /** Fait entrer un joueur dans la course : il reçoit le parcours et apparaît chez les autres. */
  function admit(link) {
    const color = COLORS()[S.players.size % COLORS().length];
    S.players.set(link.id, { id: link.id, name: link.name, color, status: 'connected', s: 0, v: 0 });
    link.admitted = true;
    sendRaw(link.dc, { type: 'race', you: { id: link.id, color }, race: packRace(S.race) });
    broadcast(lobbyMessage());
    if (link.onJoined) link.onJoined(link.name);
    render();
  }

  function acceptRequest(gid) {
    const req = S && S.role === 'host' ? S.requests.get(gid) : null;
    if (!req || req.state !== 'ready' || S.phase !== 'lobby' || !S.joinOpen) return;
    S.requests.delete(gid);
    admit(req.link);
    renderRoom();
  }

  function refuseRequest(gid) {
    const req = S && S.role === 'host' ? S.requests.get(gid) : null;
    if (!req) return;
    S.requests.delete(gid);
    dismiss(req, 'refused');
    renderRoom();
  }

  /** Congédie une demande (refus, ou départ déjà donné) : prévient le joueur puis coupe la liaison. */
  function dismiss(req, why) {
    const link = req.link;
    if (link && link.dc.readyState === 'open') sendRaw(link.dc, { type: why });
    else relaySend({ t: why === 'refused' ? 'refused' : 'closed', to: req.gid });
    if (link) setTimeout(() => { try { link.pc.close(); } catch (e) { /* déjà fermé */ } }, 400);
  }

  /** Top départ : inscriptions closes, salle d'attente vidée, relais fermé. */
  function closeRoom() {
    if (!S || S.role !== 'host') return;
    for (const req of S.requests.values()) dismiss(req, 'late');
    S.requests.clear();
    if (S.relay) { S.relay.close(); S.relay = null; }
    if (S.relayStatus !== 'unavailable') S.relayStatus = 'closed';
  }

  /** Fixe l'heure de départ (horloge de l'organisateur, ms). */
  function hostSetStart(at) {
    if (!S || S.role !== 'host' || S.phase !== 'lobby') return;
    const now = Date.now();
    if (at < now + 15000) throw new Error('Choisis une heure de départ au moins 15 s dans le futur.');
    S.race.startAt = at;
    broadcast({ type: 'start', at });
    broadcast(lobbyMessage());
    arm();
  }

  function hostSetFair(fair) {
    if (!S || S.role !== 'host' || S.phase !== 'lobby') return;
    S.race.fair = !!fair;
    broadcast(lobbyMessage());
    if (S.race.startAt) arm(); else render();
  }

  /* ======================================================================
   * Invité
   * ==================================================================== */
  function newGuestSession(viaRelay) {
    if (S && S.role === 'host' && S.phase !== 'done') throw new Error('Tu organises déjà une course : annule-la avant d\'en rejoindre une autre.');
    if (!myName()) throw new Error('Indique d\'abord ton nom.');
    if (S) leave(true);
    S = {
      role: 'guest', me: { id: U.uid() + U.uid(), name: myName() }, pc: null, dc: null, invite: null,
      offset: 0, rtt: Infinity, race: null, signature: null, players: new Map(),
      phase: viaRelay ? 'requesting' : 'connecting', viaRelay: !!viaRelay, courseLoaded: false,
      relay: null, failReason: null,
    };
    startClock();
    return S;
  }

  /** Liaison WebRTC à partir de l'offre de l'organisateur ; renvoie le code réponse. */
  async function guestAnswer(sess, offer) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    sess.pc = pc;
    sess.invite = offer.invite;
    pc.ondatachannel = (ev) => {
      sess.dc = ev.channel;
      sess.dc.onopen = () => {
        if (S !== sess) return;
        // liaison directe établie : le relais ne sert plus
        clearInterval(sess.answerTimer);
        if (sess.relay) { sess.relay.close(); sess.relay = null; }
        if (sess.viaRelay && !sess.race) sess.phase = 'waiting';
        sendRaw(sess.dc, { type: 'hello', id: sess.me.id, name: sess.me.name });
        syncClock(sess);
        notifyGuest(sess);
        render();
      };
      sess.dc.onmessage = makeReceiver((msg) => guestOnMessage(sess, msg));
      sess.dc.onclose = () => {
        if (S !== sess) return;
        if (!sess.race) { fail(sess, 'La liaison avec l\'organisateur a été coupée.'); return; }
        if (sess.phase !== 'done') { sess.phase = 'lost'; D.toast('Connexion perdue avec l\'organisateur.', 'error'); }
        render();
      };
    };
    pc.onconnectionstatechange = () => {
      if (S !== sess || pc.connectionState !== 'failed') return;
      if (!sess.race) fail(sess, NETWORK_FAIL);
    };
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitGathering(pc);
    return C.sdpToCode(pc.localDescription.sdp, 'answer', offer.invite);
  }

  /** Échange manuel : invitation de l'organisateur → code réponse à lui renvoyer. */
  async function guestJoin(offerText) {
    const r = typeof offerText === 'string' ? C.readCode(offerText) : offerText;
    if (r.type !== 'offer') throw new Error(r.type === 'answer' ? 'Ce code est une réponse : il faut le code d\'invitation de l\'organisateur.' : 'C\'est un code de salle : il s\'utilise avec « Rejoindre ».');
    const sess = newGuestSession(false);
    render();
    sess.answer = await guestAnswer(sess, r);
    if (S === sess) render();
    return sess.answer;
  }

  /** Par le relais : demande d'accès, échange automatique de l'offre et de la réponse, puis salle d'attente. */
  function guestJoinRoom(room) {
    if (!PYR.relay || !PYR.relay.available()) throw new Error('Ce navigateur ne peut pas passer par le relais (page non sécurisée ?) : demande une invitation manuelle à l\'organisateur.');
    const sess = newGuestSession(true);
    const hello = { t: 'hello', from: sess.me.id, name: sess.me.name };
    let tries = 0;
    const request = () => {
      if (S !== sess || sess.pc) { clearInterval(sess.helloTimer); return; }
      if (++tries > MAX_TRIES) { fail(sess, 'L\'organisateur ne répond pas : sa page est peut-être fermée, ou les inscriptions sont closes.'); return; }
      sess.relay.send(hello).catch(() => { /* nouvel essai au prochain tour */ });
    };
    sess.relay = PYR.relay.connect(room, {
      onStatus: (st) => {
        if (S !== sess) return;
        if (st === 'open' && !sess.helloTimer) { request(); sess.helloTimer = setInterval(request, RETRY_MS); }
        if (st === 'error' && !sess.helloTimer) { fail(sess, 'Relais injoignable : vérifie ta connexion, ou demande une invitation manuelle à l\'organisateur.'); return; }
        notifyGuest(sess);
        render();
      },
      onMessage: (m) => { if (S === sess && m.to === sess.me.id) guestOnRelay(sess, m); },
    });
    render();
    return sess;
  }

  async function guestOnRelay(sess, m) {
    if (m.t === 'offer') {
      if (sess.pc || sess.phase === 'failed') return; // doublon
      let offer;
      try { offer = C.readCode(m.code); } catch (e) { return; }
      if (offer.type !== 'offer') return;
      clearInterval(sess.helloTimer);
      sess.phase = 'connecting';
      notifyGuest(sess);
      render();
      let answer;
      try { answer = await guestAnswer(sess, offer); } catch (e) { fail(sess, NETWORK_FAIL); return; }
      if (S !== sess || sess.phase === 'failed') return;
      const msg = { t: 'answer', from: sess.me.id, code: answer };
      let tries = 0;
      const push = () => {
        if (S !== sess || !sess.relay || (sess.dc && sess.dc.readyState === 'open')) { clearInterval(sess.answerTimer); return; }
        if (++tries > MAX_TRIES) { fail(sess, NETWORK_FAIL); return; }
        sess.relay.send(msg).catch(() => { /* nouvel essai au prochain tour */ });
      };
      push();
      sess.answerTimer = setInterval(push, RETRY_MS);
    } else if (m.t === 'refused') {
      end(sess, 'L\'organisateur a refusé ta demande.');
    } else if (m.t === 'closed') {
      end(sess, m.why === 'full' ? 'La salle d\'attente est pleine : réessaie dans un instant.' : 'La course a déjà commencé : impossible de la rejoindre.');
    }
  }

  function guestStatusText(sess) {
    switch (sess.phase) {
      case 'requesting': return sess.relay && sess.relay.status === 'open' ? 'Demande envoyée à l\'organisateur…' : 'Connexion au relais…';
      case 'connecting': return sess.viaRelay ? 'Connexion à l\'organisateur…' : 'Connexion à l\'organisateur en cours… (il doit valider ta réponse)';
      case 'waiting': return 'Connecté ! En attente de la validation de l\'organisateur…';
      case 'failed': return sess.failReason || 'Connexion impossible avec l\'organisateur.';
      default: return '';
    }
  }

  function notifyGuest(sess) {
    if (sess.onStatus) sess.onStatus(guestStatusText(sess), sess.phase);
  }

  /** Échec de la connexion : la session reste affichée avec la raison, jusqu'à « Fermer ». */
  function fail(sess, reason) {
    if (S !== sess || sess.phase === 'failed') return;
    sess.phase = 'failed';
    sess.failReason = reason;
    clearInterval(sess.helloTimer);
    clearInterval(sess.answerTimer);
    if (sess.relay) { sess.relay.close(); sess.relay = null; }
    try { if (sess.pc) sess.pc.close(); } catch (e) { /* déjà fermé */ }
    notifyGuest(sess);
    render();
  }

  /** Fin décidée par l'organisateur (refus, course commencée, annulation). */
  function end(sess, reason) {
    if (S !== sess) return;
    const cb = sess.onEnd;
    D.toast(reason, 'error');
    leave(true);
    if (cb) cb(reason);
  }

  function syncClock(sess) {
    let k = 0;
    const iv = setInterval(() => {
      if (S !== sess || !sess.dc || sess.dc.readyState !== 'open' || k >= 10) { clearInterval(iv); return; }
      sendRaw(sess.dc, { type: 'ping', k: k++, t0: Date.now() });
    }, 300);
  }

  function guestOnMessage(sess, msg) {
    if (S !== sess) return;
    switch (msg.type) {
      case 'race': {
        let race;
        try { race = unpackRace(msg.race); } catch (e) { D.toast('Course reçue illisible : ' + e.message, 'error'); return; }
        sess.race = race;
        sess.signature = R.courseSignature(race.course);
        sess.me.color = msg.you && msg.you.color;
        PYR.challenges.applyCourse(race.course);
        sess.courseLoaded = true;
        sess.phase = 'lobby';
        if (sess.viaRelay) D.toast(`C'est bon : tu es inscrit à la course « ${race.title} » !`);
        if (sess.onJoined) sess.onJoined(race);
        if (race.startAt) arm(); else render();
        break;
      }
      case 'waiting':
        if (!sess.race && sess.phase !== 'failed') { sess.phase = 'waiting'; notifyGuest(sess); render(); }
        break;
      case 'refused':
        end(sess, 'L\'organisateur a refusé ta demande.');
        break;
      case 'lobby': {
        if (!Array.isArray(msg.players)) return;
        const old = sess.players;
        sess.players = new Map();
        for (const p of msg.players.slice(0, 50)) {
          const id = cleanId(p.id);
          const prev = old.get(id) || {};
          sess.players.set(id, Object.assign(prev, { id, name: cleanName(p.name), color: String(p.color || '#6f6d66').slice(0, 9), status: String(p.status || '') }));
        }
        if (sess.race) {
          const fairChanged = sess.race.fair !== !!msg.fair;
          sess.race.fair = !!msg.fair;
          if (msg.rider) sess.race.rider = msg.rider;
          if (msg.bike) sess.race.bike = msg.bike;
          if (msg.startAt && msg.startAt !== sess.race.startAt) { sess.race.startAt = Number(msg.startAt); arm(); }
          else if (fairChanged && sess.race.startAt) arm();
        }
        checkDone();
        render();
        break;
      }
      case 'start':
        if (!sess.race) return;
        sess.race.startAt = Number(msg.at);
        arm();
        break;
      case 'pong': {
        const t1 = Date.now(), rtt = t1 - Number(msg.t0);
        if (rtt >= 0 && rtt < sess.rtt) {
          sess.rtt = rtt;
          sess.offset = Number(msg.th) + rtt / 2 - t1;
          // départ pas encore donné : on recale le compte à rebours
          if (sess.race && sess.race.startAt && Date.now() < sess.race.startAt - sess.offset - 2000) arm();
        }
        break;
      }
      case 'state': applyState(cleanId(msg.id), msg); break;
      case 'finish': applyFinish(cleanId(msg.id), msg); break;
      case 'late':
        end(sess, 'La course a déjà commencé : impossible de la rejoindre.');
        break;
      case 'cancel':
        end(sess, 'L\'organisateur a annulé la course.');
        break;
      default:
    }
  }

  /* ======================================================================
   * Commun
   * ==================================================================== */
  function leave(silent) {
    if (!S) return;
    const sess = S;
    try {
      if (sess.role === 'host') {
        // joueurs inscrits et salle d'attente sont prévenus avant la coupure
        for (const l of sess.links) if (l.dc.readyState === 'open') sendRaw(l.dc, { type: 'cancel' });
        for (const req of sess.requests.values()) if (!req.link || req.link.dc.readyState !== 'open') relaySend({ t: 'closed', to: req.gid });
        if (sess.relay) sess.relay.close();
        setTimeout(() => { for (const l of sess.links) { try { l.pc.close(); } catch (e) { /* déjà fermé */ } } }, 300);
      } else {
        clearInterval(sess.helloTimer);
        clearInterval(sess.answerTimer);
        toHost({ type: 'bye' });
        if (sess.relay) { sess.relay.send({ t: 'bye', from: sess.me.id }).catch(() => {}); sess.relay.close(); }
        setTimeout(() => { try { if (sess.pc) sess.pc.close(); } catch (e) { /* déjà fermé */ } }, 300);
      }
    } finally {
      S = null;
      stopClock();
      PYR.tabGame.leaveLive();
      render();
      if (!silent) D.toast('Tu as quitté la course en direct.');
    }
  }

  function startClock() {
    if (!clock) clock = setInterval(() => refresh(), 1000);
  }
  function stopClock() {
    if (clock) { clearInterval(clock); clock = null; }
  }

  function saveAsChallenge() {
    const entries = [...S.players.values()].filter((p) => p.entry).map((p) => p.entry);
    if (!entries.length) { D.toast('Aucun résultat à enregistrer.', 'error'); return; }
    const race = S.race;
    const ch = PYR.challenges.fromRace({ title: race.title, creator: race.host, course: race.course, fair: race.fair, rider: race.rider, bike: race.bike, rules: race.rules, cps: race.cps, feed: race.feed, entries });
    D.toast(`Résultats enregistrés dans le défi « ${ch.title} » : tu peux le partager ou le rejouer.`);
    leave(true);
  }

  /* ======================================================================
   * Interface
   * ==================================================================== */
  function fmtStart(localMs) {
    const d = new Date(localMs);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return (sameDay ? '' : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }) + ' ') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function localStart() {
    if (!S || !S.race || !S.race.startAt) return null;
    return S.race.startAt - (S.role === 'guest' ? S.offset : 0);
  }

  /** Pastilles des règles de course (et des classements annexes : sprints et côtes placés sur le parcours). */
  function rulesBadges(rules, cps) {
    if (!rules) return [];
    const cl = CV.cpsText(cps);
    return [rules.events && 'incidents', rules.form && 'forme du jour', rules.fuel && 'alimentation', rules.physio && 'modèle physiologique', rules.peloton && 'peloton en 2D', cl && `classements : ${cl}`]
      .filter(Boolean).map((x) => h('span', { class: 'badge' }, x));
  }

  /** Temps de passage d'un joueur : ceux de son résultat une fois arrivé, sinon les derniers reçus. */
  function playerSplits(p) {
    if (p.entry) return Cl.entrySplits(S.race.cps, p.entry);
    return p.sp || [];
  }

  /** Classements annexes des joueurs (null sans sprint ni sommet). */
  function liveClassif() {
    if (!S || !S.race || !Cl.active(S.race.cps) || S.phase === 'lobby') return null;
    const players = [...S.players.values()];
    const sd = Cl.standings(S.race.cps, players.map((p) => ({ id: p.id, splits: playerSplits(p), s: p.s || 0 })));
    const names = new Map(players.map((p) => [p.id, p.name]));
    return { sd, name: (id) => names.get(id) || '?' };
  }

  /** Colonnes du tableau : statut des joueurs avant le départ, positions ensuite. */
  function standingsHead() {
    return S.phase === 'lobby' ? ['', 'Cycliste', 'Statut'] : ['#', 'Cycliste', 'Position', 'Vitesse / écart'];
  }

  function standingsRows(cl) {
    const list = [...S.players.values()];
    const isMe = (p) => p.id === S.me.id;
    const worn = cl ? CV.holders(cl.sd, false) : new Map();
    const nameCell = (p) => h('td', null, h('span', { class: 'dot', style: { background: isMe(p) ? '#eb6834' : p.color } }), p.name, isMe(p) ? ' (toi)' : '', ' ', ...CV.jerseysOf(worn, p.id));
    if (S.phase === 'lobby') {
      return list.map((p, i) => h('tr', { class: isMe(p) ? 'me' : '' },
        h('td', null, String(i + 1)), nameCell(p), h('td', null, statusLabel(p))));
    }
    list.sort((a, b) => {
      if (a.finished && b.finished) return a.time - b.time;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return (b.s || 0) - (a.s || 0);
    });
    const leader = list.find((p) => p.finished);
    return list.map((p, i) => h('tr', { class: isMe(p) ? 'me' : '' },
      h('td', null, String(i + 1)),
      nameCell(p),
      h('td', null, p.finished ? U.fmtClock(p.time) : `${U.fmt((p.s || 0) / 1000, 2)} km`),
      h('td', null, p.finished ? (leader && p !== leader ? U.fmtDelta(p.time - leader.time) : '–')
        : p.status === 'left' ? 'déconnecté' : `${U.fmt((p.v || 0) * 3.6, 1)} km/h`)));
  }

  function statusLabel(p) {
    return { host: 'organisateur', connected: 'connecté', left: 'déconnecté' }[p.status] || p.status;
  }

  function nameField() {
    const inp = h('input', { type: 'text', maxlength: '30', placeholder: 'Ton nom ou pseudo', value: store.state.rider.name || '' });
    inp.addEventListener('change', () => { store.set('rider.name', inp.value.trim()); PYR.app.refreshBindings(); });
    return h('div', { class: 'field' }, h('label', null, 'Ton nom (visible par les autres joueurs)'), inp);
  }

  function codeBox(code, label) {
    const ta = h('textarea', { rows: '3', readonly: true, class: 'code', 'aria-label': label });
    ta.value = code;
    ta.addEventListener('focus', () => ta.select());
    return ta;
  }

  /** Copier le lien / le code, image du QR code, partage. kind : 'room' | 'offer' | 'answer'. */
  function shareTools(code, qrText, kind) {
    const link = kind === 'answer' ? null : inviteLink(code);
    const tools = h('div', { class: 'toolbar' });
    if (link) tools.appendChild(h('button', { class: 'btn', onclick: async () => { await D.copy(link); D.toast('Lien copié.'); } }, 'Copier le lien'));
    tools.appendChild(h('button', { class: 'btn', onclick: async () => { await D.copy(code); D.toast('Code copié.'); } }, 'Copier le code'));
    tools.appendChild(h('button', { class: 'btn', onclick: async () => { D.download(kind === 'answer' ? 'reponse-course.png' : 'invitation-course.png', await PYR.qr.png(qrText)); } }, 'Image du QR code'));
    if (navigator.share) {
      const data = kind === 'answer'
        ? { title: 'Réponse PaceYourRide', text: code }
        : link ? { title: 'Course PaceYourRide', text: `Rejoins ma course « ${S.race.title} » sur PaceYourRide`, url: link } : { title: 'Invitation PaceYourRide', text: code };
      tools.appendChild(h('button', { class: 'btn', onclick: () => navigator.share(data).catch(() => {}) }, 'Partager…'));
    }
    return tools;
  }

  /** Zone de saisie d'un code avec lecture de QR code (caméra ou image). */
  function codeInput(placeholder, onDetected) {
    const area = h('textarea', { rows: '3', class: 'code', placeholder });
    const camBox = h('div', { class: 'qr-cam' });
    let stop = null, closed = false, starting = false;
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      try {
        const t = await PYR.qr.decodeImage(f);
        if (!t) { D.toast('Aucun QR code lisible dans cette image.', 'error'); return; }
        area.value = t;
        if (onDetected) onDetected(t);
      } catch (e) { D.toast(e.message, 'error'); }
    });
    const camBtn = h('button', {
      class: 'btn', type: 'button', onclick: async () => {
        if (starting) return; // demande d'autorisation en cours
        if (stop) { stopScan(); return; }
        starting = true;
        try {
          camBtn.textContent = 'Arrêter la caméra';
          const s = await PYR.qr.scanCamera(camBox, (t) => { stop = null; camBtn.textContent = 'Scanner avec la caméra'; area.value = t; if (onDetected) onDetected(t); });
          // fenêtre fermée pendant la demande d'autorisation : on coupe tout de suite
          if (closed) s(); else stop = s;
        } catch (e) {
          stop = null; camBtn.textContent = 'Scanner avec la caméra';
          if (!closed) D.toast('Caméra indisponible : ' + e.message, 'error');
        } finally { starting = false; }
      },
    }, 'Scanner avec la caméra');
    const el = h('div', null, area,
      h('div', { class: 'toolbar' }, camBtn, h('label', { class: 'btn' }, 'Lire une image de QR code', file)),
      camBox);
    const stopScan = () => { if (stop) { stop(); stop = null; } camBtn.textContent = 'Scanner avec la caméra'; };
    // stop : arrête le scan ; dispose : la fenêtre est fermée (même si la caméra démarre encore)
    return { el, area, stop: stopScan, dispose: () => { closed = true; stopScan(); } };
  }

  function openCreate() {
    const title = h('input', { type: 'text', maxlength: '60', value: `Course de ${myName() || 'moi'}` });
    const fair = h('input', { type: 'checkbox' });
    D.modal({
      title: 'Organiser une course en direct',
      body: [
        h('p', { class: 'hint' }, 'Le parcours actuel (portions, température et options comprises) est figé et envoyé à chaque joueur. Tu fixes ensuite l\'heure de départ et tu partages le QR code de la course : chaque joueur qui le scanne attend ta validation. Tes réglages de course (incidents, forme du jour, alimentation, durée des relais) s\'appliquent à tous.'),
        nameField(),
        h('div', { class: 'field' }, h('label', null, 'Nom de la course'), title),
        h('label', { class: 'check' }, fair, ' Armes égales : tout le monde roule avec mon cycliste et mon vélo'),
      ],
      actions: [
        { label: 'Annuler' },
        {
          label: 'Créer la course', primary: true, onClick: () => {
            try { hostCreate({ title: title.value, fair: fair.checked }); } catch (e) { D.toast(e.message, 'error'); return false; }
            openInvite();
            return true;
          },
        },
      ],
    });
  }

  let inviteView = null; // fenêtre « Inviter des joueurs » ouverte : {relayLine, reqBox}

  /** Un seul QR code pour tous : chaque joueur qui le scanne arrive en salle d'attente. */
  function openInvite() {
    if (!S || S.role !== 'host') return;
    if (!S.room) { openManualInvite(); return; } // relais indisponible dans ce navigateur
    const link = inviteLink(S.roomCode);
    const qrText = link || S.roomCode;
    const relayLine = h('div', { class: 'status-line' });
    const reqBox = h('div', { class: 'room-requests' });
    const m = D.modal({
      title: 'Inviter des joueurs',
      wide: true,
      onClose: () => { inviteView = null; },
      body: [
        h('p', { class: 'hint' }, 'Le même QR code sert à tout le monde : fais-le scanner ou envoie le lien. Chaque joueur qui se connecte arrive dans la salle d\'attente, et c\'est toi qui l\'acceptes.'),
        h('div', { class: 'qr-box' }, PYR.qr.svg(qrText, 'QR code de la course')),
        codeBox(link || S.roomCode, link ? 'Lien de la course' : 'Code de la course'),
        shareTools(S.roomCode, qrText, 'room'),
        relayLine,
        h('h4', null, 'Salle d\'attente'),
        reqBox,
        h('details', { class: 'manual' },
          h('summary', null, 'Relais injoignable ? Échange manuel des codes'),
          h('p', { class: 'hint' }, 'Sans relais, chaque joueur reçoit sa propre invitation et te renvoie un code réponse.'),
          h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); openManualInvite(); } }, 'Créer une invitation manuelle')),
      ],
      actions: [{ label: 'Fermer' }],
    });
    inviteView = { relayLine, reqBox };
    renderRoom();
  }

  /** Échange manuel (sans relais) : une invitation par joueur, qui renvoie un code réponse. */
  async function openManualInvite() {
    if (!S || S.role !== 'host') return;
    let input = null;
    const m = D.modal({
      title: 'Invitation manuelle', body: [h('p', { class: 'hint' }, 'Préparation de l\'invitation…')], actions: [{ label: 'Fermer' }], wide: true,
      onClose: () => { if (input) input.dispose(); },
    });
    let link;
    try { link = await hostInvite(); } catch (e) { m.setBody([h('p', { class: 'status-line error' }, 'Impossible de créer l\'invitation : ' + e.message)]); return; }
    if (m.closed) return;
    const qrText = inviteLink(link.code) || link.code;
    const status = h('div', { class: 'status-line' });
    input = codeInput('Colle ici la réponse de ton ami (code « PYR.… »)', () => validate());
    const validate = async () => {
      try {
        await hostAcceptAnswer(input.area.value);
        status.classList.remove('error');
        status.textContent = 'Connexion en cours…';
      } catch (e) { status.textContent = e.message; status.classList.add('error'); }
    };
    link.onJoined = (name) => { status.classList.remove('error'); status.textContent = `${name} a rejoint la course !`; setTimeout(() => m.close(), 1500); };
    link.onFail = () => { status.classList.add('error'); status.textContent = NETWORK_FAIL; };
    m.setBody([
      h('p', { class: 'hint' }, h('strong', null, '1. '), 'Envoie cette invitation à ton ami (message, e-mail…) ou fais-lui scanner le QR code.'),
      h('div', { class: 'qr-box' }, PYR.qr.svg(qrText, 'QR code de l\'invitation')),
      codeBox(link.code, 'Code d\'invitation'),
      shareTools(link.code, qrText, 'offer'),
      h('p', { class: 'hint' }, h('strong', null, '2. '), 'Il te renvoie un code réponse : colle-le ci-dessous ou scanne son QR code.'),
      input.el,
      status,
    ]);
    m.setActions([
      { label: 'Fermer' },
      { label: 'Valider la réponse', primary: true, onClick: async () => { await validate(); return false; } },
    ]);
  }

  function openAnswerOnly() {
    const status = h('div', { class: 'status-line' });
    const input = codeInput('Colle ici la réponse reçue (code « PYR.… »)');
    D.modal({
      title: 'Valider une réponse',
      body: [h('p', { class: 'hint' }, 'Pour une invitation déjà envoyée : colle la réponse de ton ami ou scanne son QR code.'), input.el, status],
      onClose: () => input.dispose(),
      actions: [
        { label: 'Fermer' },
        {
          label: 'Valider', primary: true, onClick: async () => {
            try { await hostAcceptAnswer(input.area.value); D.toast('Connexion en cours…'); return true; } catch (e) { status.textContent = e.message; status.classList.add('error'); return false; }
          },
        },
      ],
    });
  }

  function openJoin(prefill) {
    let preset = null;
    try { preset = prefill ? C.readCode(prefill) : null; } catch (e) { preset = null; }
    const viaLink = !!(preset && preset.type === 'room');
    const status = h('div', { class: 'status-line' });
    const input = codeInput('Colle ici le lien ou le code reçu (« PYR.… »), ou scanne le QR code');
    if (prefill) input.area.value = prefill;
    let sessRef = null;
    const setStatus = (text, phase) => {
      status.textContent = text;
      status.classList.toggle('error', phase === 'failed');
    };
    const m = D.modal({
      title: 'Rejoindre une course en direct',
      wide: !viaLink,
      onClose: () => {
        input.dispose();
        if (sessRef) { sessRef.onStatus = null; sessRef.onEnd = null; sessRef.onJoined = null; }
      },
      body: [
        h('p', { class: 'hint' }, viaLink
          ? 'Tu es invité à une course en direct ! Indique ton nom puis demande à entrer : l\'organisateur valide chaque inscription.'
          : 'Colle le lien ou le code de l\'organisateur, ou scanne son QR code. Ton parcours actuel sera remplacé par celui de la course.'),
        nameField(),
        viaLink ? null : h('div', { class: 'field' }, h('label', null, 'Lien ou code de l\'organisateur'), input.el),
        status,
      ],
      actions: [
        { label: 'Annuler' },
        { label: viaLink ? 'Demander à rejoindre' : 'Rejoindre', primary: true, onClick: () => join() },
      ],
    });

    /** Relie la session aux messages de la fenêtre (tant qu'elle est ouverte). */
    function attach(sess, show) {
      sessRef = sess;
      sess.onStatus = show;
      sess.onJoined = (race) => { show(`C'est bon ! Course « ${race.title} » reçue.`); setTimeout(() => m.close(), 1500); };
      sess.onEnd = (reason) => show(reason, 'failed');
    }

    async function join() {
      input.stop();
      let r;
      try { r = C.readCode(input.area.value); } catch (e) { setStatus(e.message, 'failed'); return false; }
      if (r.type === 'answer') { setStatus('Ce code est une réponse : il faut le lien ou le code de l\'organisateur.', 'failed'); return false; }
      if (r.type === 'room') {
        let sess;
        try { sess = guestJoinRoom(r); } catch (e) { setStatus(e.message, 'failed'); return false; }
        attach(sess, setStatus);
        setStatus(guestStatusText(sess), sess.phase);
        m.setActions([{ label: 'Fermer' }]); // la demande continue même si on ferme la fenêtre
        return false;
      }
      // invitation manuelle : on renvoie un code réponse à l'organisateur
      setStatus('Préparation de la réponse…');
      let answer;
      try { answer = await guestJoin(r); } catch (e) { setStatus(e.message, 'failed'); return false; }
      const st2 = h('div', { class: 'status-line' }, 'En attente de la connexion…');
      attach(S, (text, phase) => { st2.textContent = text; st2.classList.toggle('error', phase === 'failed'); });
      m.setTitle('Envoie ta réponse à l\'organisateur');
      m.setBody(answerView(answer).concat([st2]));
      m.setActions([{ label: 'Fermer' }]);
      return false;
    }
  }

  /** Code réponse de l'invité : QR code, code et outils de partage. */
  function answerView(answer) {
    return [
      h('p', { class: 'hint' }, 'Envoie ce code réponse à l\'organisateur (message, e-mail…) ou fais-lui scanner le QR code. La connexion s\'établit dès qu\'il l\'a validé.'),
      h('div', { class: 'qr-box' }, PYR.qr.svg(answer, 'QR code de la réponse')),
      codeBox(answer, 'Code réponse'),
      shareTools(answer, answer, 'answer'),
    ];
  }

  /** Réaffiche la réponse (si l'invité a fermé la fenêtre avant de l'envoyer). */
  function openAnswer() {
    if (!S || S.role !== 'guest' || !S.answer) return;
    const m = D.modal({ title: 'Envoie ta réponse à l\'organisateur', wide: true, body: answerView(S.answer), actions: [{ label: 'Fermer' }] });
    S.onJoined = (race) => { D.toast(`Connecté ! Course « ${race.title} » reçue.`); m.close(); };
  }

  function openStartPicker() {
    const pad = (x) => String(x).padStart(2, '0');
    const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    // minute pleine suivante : « dans 1 min » laisse toujours au moins une minute
    const inMinutes = (min) => new Date(Math.ceil((Date.now() + min * 60000) / 60000) * 60000);
    const time = h('input', { type: 'time', step: '60', value: hhmm(S.race.startAt ? new Date(S.race.startAt) : inMinutes(5)) });
    const preview = h('div', { class: 'status-line' });
    const status = h('div', { class: 'status-line' });

    /** Instant correspondant à l'heure saisie : aujourd'hui, ou demain si l'heure est passée depuis plus d'une heure. */
    function resolve() {
      const [hh, mm] = String(time.value).split(':').map(Number);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return { error: 'Heure invalide.' };
      const d = new Date();
      d.setHours(hh, mm, 0, 0);
      const ahead = d.getTime() - Date.now();
      if (ahead < -3600000) d.setDate(d.getDate() + 1);
      else if (ahead < 15000) return { error: 'Cette heure est passée ou trop proche : laisse au moins 15 s aux joueurs.' };
      return { at: d.getTime() };
    }
    function showPreview() {
      const r = resolve();
      status.textContent = '';
      status.classList.remove('error');
      if (r.error) { preview.textContent = r.error; return; }
      const tomorrow = new Date(r.at).toDateString() !== new Date().toDateString();
      preview.textContent = `Départ ${tomorrow ? 'demain' : 'aujourd\'hui'} à ${hhmm(new Date(r.at))}, dans ${U.fmtClock((r.at - Date.now()) / 1000)}.`;
    }
    time.addEventListener('input', showPreview);
    const quick = (min) => h('button', { class: 'btn small', type: 'button', onclick: () => { time.value = hhmm(inMinutes(min)); showPreview(); } }, `dans ${min} min`);
    showPreview();
    D.modal({
      title: 'Heure de départ',
      body: [
        h('p', { class: 'hint' }, 'Chaque joueur voit l\'heure dans son propre fuseau horaire ; le départ est donné au même instant pour tous.'),
        h('div', { class: 'field' }, h('label', null, 'Départ à'), time),
        h('div', { class: 'toolbar' }, quick(1), quick(2), quick(5), quick(10)),
        preview,
        status,
      ],
      actions: [
        { label: 'Annuler' },
        {
          label: 'Fixer le départ', primary: true, onClick: () => {
            const r = resolve();
            if (r.error) { status.textContent = r.error; status.classList.add('error'); return false; }
            try { hostSetStart(r.at); } catch (e) { status.textContent = e.message; status.classList.add('error'); return false; }
            D.toast(`Départ fixé à ${fmtStart(r.at)}.`);
            return true;
          },
        },
      ],
    });
  }

  let refs = {};

  function render() {
    const box = $('#live-box');
    if (!box) return;
    D.clear(box);
    refs = {};
    if (!S || S.role !== 'host') renderRoom(); // masque la carte de la salle d'attente
    if (!S) {
      box.appendChild(h('p', { class: 'hint' }, 'Roulez en même temps, chacun chez soi : l\'organisateur partage un QR code (ou un lien), chaque joueur le scanne et attend que l\'organisateur valide son inscription. Départ à l\'heure fixée par l\'organisateur.'));
      box.appendChild(h('div', { class: 'toolbar' },
        h('button', { class: 'btn', onclick: openCreate }, 'Organiser une course'),
        h('button', { class: 'btn', onclick: () => openJoin() }, 'Rejoindre une course')));
      return;
    }
    const wrap = h('div', { class: 'challenge live' });
    const race = S.race;
    if (!race) {
      wrap.appendChild(h('p', { class: S.phase === 'failed' ? 'status-line error' : '' }, guestStatusText(S)));
      wrap.appendChild(h('div', { class: 'toolbar' },
        !S.viaRelay && S.phase === 'connecting' && S.answer ? h('button', { class: 'btn', onclick: openAnswer }, 'Revoir ma réponse') : null,
        h('button', { class: 'btn ghost', onclick: () => leave(S.phase === 'failed') }, S.phase === 'failed' ? 'Fermer' : 'Abandonner')));
      box.appendChild(wrap);
      return;
    }
    const km = courseLength() / 1000;
    wrap.appendChild(h('div', { class: 'challenge-head' },
      h('strong', null, race.title),
      h('span', null, ` — ${S.role === 'host' ? 'organisée par toi' : `organisée par ${race.host}`} · ${U.fmt(km, 1)} km`),
      race.fair ? h('span', { class: 'badge' }, 'armes égales') : null,
      ...rulesBadges(race.rules, race.cps)));

    // Départ
    const ls = localStart();
    refs.start = h('div', { class: 'live-start' });
    wrap.appendChild(refs.start);
    if (S.role === 'host' && S.phase === 'lobby') {
      const fair = h('input', { type: 'checkbox', checked: !!race.fair });
      fair.addEventListener('change', () => hostSetFair(fair.checked));
      const manualPending = S.links.some((l) => !l.gid && l.status === 'invited');
      wrap.appendChild(h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', onclick: openStartPicker }, ls ? 'Changer l\'heure de départ' : 'Fixer l\'heure de départ'),
        h('button', { class: 'btn', onclick: openInvite }, 'Inviter des joueurs'),
        manualPending ? h('button', { class: 'btn ghost', onclick: openAnswerOnly }, 'Valider une réponse') : null));
      wrap.appendChild(h('label', { class: 'check' }, fair, ' Armes égales (même cycliste et même vélo pour tous)'));
      refs.room = h('div', { class: 'room' });
      wrap.appendChild(refs.room);
    }

    // Joueurs / classement
    refs.table = h('tbody');
    wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'simple num leaderboard' },
      h('thead', null, h('tr', null, ...standingsHead().map((x) => h('th', null, x)))), refs.table)));
    refs.classif = h('div');
    wrap.appendChild(refs.classif);
    const pending = S.role === 'host' ? S.links.filter((l) => !l.gid && !l.id && (l.status === 'invited' || l.status === 'connecting' || l.status === 'open')).length : 0;
    if (pending) wrap.appendChild(h('p', { class: 'hint' }, `${pending} invitation${pending > 1 ? 's' : ''} manuelle${pending > 1 ? 's' : ''} en attente de réponse.`));
    if (S.phase === 'lost') wrap.appendChild(h('div', { class: 'note warn' }, 'Connexion perdue avec l\'organisateur : tu peux finir ta course, mais les positions ne sont plus partagées.'));

    const actions = h('div', { class: 'toolbar' });
    const results = [...S.players.values()].some((p) => p.entry);
    if (results) actions.appendChild(h('button', { class: 'btn', onclick: saveAsChallenge }, 'Enregistrer les résultats comme défi'));
    actions.appendChild(h('button', {
      class: 'btn ghost danger', onclick: () => {
        if (S.role === 'host' && S.phase !== 'done' && !confirm('Annuler la course pour tous les joueurs ?')) return;
        leave();
      },
    }, S.role === 'host' ? (S.phase === 'done' ? 'Terminer' : 'Annuler la course') : 'Quitter la course'));
    wrap.appendChild(actions);
    box.appendChild(wrap);
    refresh();
    renderRoom();
  }

  function relayText() {
    if (!S.room) return 'Le relais n\'est pas disponible dans ce navigateur (page non sécurisée ?) : utilise l\'échange manuel.';
    return {
      connecting: 'Ouverture de la salle sur le relais…',
      open: 'Salle ouverte : les joueurs rejoignent avec le QR code ou le lien.',
      error: 'Relais injoignable pour l\'instant (nouvel essai automatique). En attendant, utilise l\'échange manuel.',
      closed: 'Inscriptions closes.',
    }[S.relayStatus] || '';
  }

  /** Demandes en salle d'attente, avec Accepter / Refuser. */
  function requestsView(emptyText) {
    const list = [...S.requests.values()];
    if (!list.length) return emptyText ? h('p', { class: 'hint' }, emptyText) : null;
    const stateText = { connecting: 'connexion…', ready: 'attend ta validation', failed: 'connexion impossible' };
    return h('ul', { class: 'requests' }, ...list.map((r) => h('li', { class: r.state },
      h('span', { class: 'req-name' }, r.name),
      h('span', { class: 'req-state' }, stateText[r.state] || ''),
      r.state === 'ready' ? h('button', { class: 'btn small primary', type: 'button', onclick: () => acceptRequest(r.gid) }, 'Accepter') : null,
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => refuseRequest(r.gid) }, r.state === 'failed' ? 'Retirer' : 'Refuser'))));
  }

  /** Met à jour l'état du relais et la salle d'attente (carte sur la carte, panneau, fenêtre d'invitation). */
  function renderRoom() {
    const card = $('#live-requests');
    const host = !!(S && S.role === 'host');
    if (card) {
      // visible depuis tous les onglets tant qu'une demande attend l'organisateur
      const list = host && S.phase === 'lobby' ? requestsView() : null;
      D.clear(card);
      card.hidden = !list;
      if (list) card.append(h('div', { class: 'live-requests-title' }, 'Salle d\'attente de la course'), list);
    }
    if (!host) return;
    if (refs.room) {
      D.clear(refs.room);
      if (S.phase === 'lobby') {
        refs.room.appendChild(h('p', { class: 'hint' + (S.relayStatus === 'error' ? ' warn' : '') }, relayText()));
        const list = requestsView();
        if (list) refs.room.append(h('h4', null, 'Salle d\'attente'), list);
      }
    }
    if (inviteView) {
      inviteView.relayLine.textContent = relayText();
      inviteView.relayLine.classList.toggle('error', S.relayStatus === 'error');
      D.clear(inviteView.reqBox);
      inviteView.reqBox.appendChild(requestsView(S.joinOpen ? 'Personne pour l\'instant : chaque joueur qui scanne le QR code apparaîtra ici.' : 'Inscriptions closes.'));
    }
  }

  /** Mise à jour chaque seconde (compte à rebours, classement) sans reconstruire les champs. */
  function refresh() {
    if (!S || !S.race) return;
    const ls = localStart();
    if (ls && Date.now() >= ls && S.phase === 'lobby') {
      // top départ : les inscriptions sont closes
      S.phase = 'racing';
      S.joinOpen = false;
      closeRoom();
      render();
      return;
    }
    if (!refs.table) return;
    if (refs.start) {
      D.clear(refs.start);
      if (!ls) refs.start.appendChild(h('span', null, S.role === 'host' ? 'Heure de départ à fixer.' : 'En attente de l\'heure de départ…'));
      else {
        const left = (ls - Date.now()) / 1000;
        refs.start.append('Départ : ', h('strong', null, fmtStart(ls)),
          left > 0 ? ` — dans ${U.fmtClock(left)}` : S.phase === 'done' ? ' — course terminée' : ' — course en cours');
      }
    }
    const cl = liveClassif();
    D.clear(refs.table);
    for (const row of standingsRows(cl)) refs.table.appendChild(row);
    // classements annexes (points, montagne), gardés repliés ou dépliés d'une seconde à l'autre
    if (refs.classif) {
      const wasOpen = !!(refs.classif.firstChild && refs.classif.firstChild.open);
      D.clear(refs.classif);
      if (cl) {
        const det = h('details', { class: 'classif-details', open: wasOpen }, h('summary', null, 'Classements par points et de la montagne'));
        det.appendChild(CV.block(S.race.cps, cl.sd, { name: cl.name, meId: S.me.id, full: true }));
        refs.classif.appendChild(det);
      }
    }
  }

  /* ======================================================================
   * API
   * ==================================================================== */
  const API = {
    init() {
      render();
      window.addEventListener('beforeunload', (e) => {
        if (S && S.phase !== 'done') { e.preventDefault(); e.returnValue = ''; }
      });
    },

    /** Règles de la course (incidents, forme du jour, alimentation, durée des relais). */
    rules() { return S && S.race ? S.race.rules || null : null; },

    /** Le jeu doit-il être en mode direct ? */
    inRace() { return !!(S && S.race && S.race.startAt && S.courseLoaded); },

    /** Cycliste et vélo imposés (armes égales). */
    machine() {
      if (!S || !S.race || !S.race.fair || !S.race.rider) return null;
      return { rider: Object.assign({}, S.race.rider, { name: store.state.rider.name }), bike: S.race.bike, from: S.race.host };
    },

    /**
     * Adversaires, positions extrapolées avec leur vitesse depuis leur dernier message. Chaque position est
     * datée du temps de course de son envoi : on la replace au temps de course raceT (s) s'il est donné
     * (simulation), sinon à l'instant présent de l'horloge de course partagée (affichage). Pour l'affichage,
     * la position suit en plus sa cible avec un léger lissage : les corrections à chaque message ne se voient pas.
     */
    opponents(raceT) {
      if (!S || !S.race) return [];
      const now = Date.now(), L = courseLength(), start = localStart();
      const display = raceT === undefined;
      const clock = display && start ? (now - start) / 1000 : raceT;
      return [...S.players.values()].filter((p) => p.id !== S.me.id && p.status !== 'left').map((p) => {
        let s = p.s || 0;
        if (!p.finished && !p.inc) {
          const dt = clock !== undefined && Number.isFinite(p.t) ? clock - p.t : p.at ? (now - p.at) / 1000 : 0;
          s = Math.min(L, Math.max(0, s + (p.v || 0) * U.clamp(dt, -1, 2.5)));
        }
        if (display) {
          const dts = p.dsAt ? (now - p.dsAt) / 1000 : 0;
          // première image, arrêt ou saut important (reprise après coupure) : on se place directement
          s = p.ds === undefined || p.finished || p.inc || Math.abs(s - p.ds) > 80 ? s : p.ds + (s - p.ds) * (1 - Math.exp(-dts / SMOOTH_S));
          p.ds = s; p.dsAt = now;
        }
        return {
          id: p.id, name: p.name, color: p.color, s, v: p.inc ? 0 : p.v || 0, finished: !!p.finished, time: p.finished ? p.time : null,
          mode: p.tac || 'manual', phase: p.ph || null, stopped: !p.finished && !!p.inc, splits: playerSplits(p), y: p.y,
          kind: p.kind || 'avatar', P: Number.isFinite(p.P) ? p.P : undefined,
        };
      });
    },

    /** Points de passage de la course (sprints, sommets, arrivée), fixés par l'organisateur. */
    checkpoints() { return S && S.race ? S.race.cps || null : null; },

    /** Zones de ravitaillement de la course, fixées par l'organisateur. */
    feedZones() { return S && S.race ? S.race.feed || null : null; },

    sendState(st) {
      if (!S || !S.race) return;
      const me = S.players.get(S.me.id);
      if (me) Object.assign(me, { s: st.s, v: st.v, t: st.t, at: Date.now() }, st.sp ? { sp: st.sp } : null);
      const msg = { type: 'state', id: S.me.id, t: st.t, s: st.s, v: st.v, P: st.P, w: st.w, tac: st.tac, ph: st.ph || undefined, inc: st.inc || undefined, sp: st.sp || undefined, y: Number.isFinite(st.y) ? st.y : undefined, k: st.k || undefined };
      if (S.role === 'host') broadcast(msg); else toHost(msg);
    },

    finish(entry) {
      if (!S || !S.race) return;
      const packed = R.packEntry(entry);
      const msg = { type: 'finish', id: S.me.id, entry: packed };
      applyFinish(S.me.id, msg);
      if (S.role === 'host') broadcast(msg); else toHost(msg);
      render();
    },

    /** Au chargement : lien d'invitation #live=… */
    checkHash() {
      const m = location.hash.match(/^#live=([A-Za-z0-9._-]+)/);
      if (!m) return false;
      history.replaceState(null, '', location.pathname + location.search);
      PYR.app.showTab('game');
      openJoin(decodeURIComponent(m[1]));
      return true;
    },

    get session() { return S; },
    // exposés pour les tests
    _hostCreate: hostCreate, _hostInvite: hostInvite, _hostAcceptAnswer: hostAcceptAnswer, _hostSetStart: hostSetStart, _guestJoin: guestJoin, _leave: leave,
    _acceptRequest: acceptRequest, _refuseRequest: refuseRequest,
  };

  PYR.live = API;
})(globalThis.PYR = globalThis.PYR || {});
