/* Bike3D — vue 3D pilotée par PaceYourRide (index.html?pyr).
   PaceYourRide simule la course (physiologie, météo réelle, aspiration, coureurs virtuels, joueurs en direct) ;
   Bike3D ne fait plus que la montrer : il construit le paysage autour du parcours reçu et place chaque coureur là où
   la simulation le met. La page est ouverte dans un cadre (iframe) par-dessus la carte de l'écran de course Jeu3D/, ou dans une
   fenêtre à part (second écran, devant le home-trainer) ; les deux échangent des messages (postMessage) :

   PaceYourRide → Bike3D (tous les messages portent pyr3d: 1)
     course : { key (empreinte : on ne reconstruit que si elle change), name, seed (même graine pour tous les joueurs
                d'une course en direct : même paysage), lat[], lng[], ele[] (points du parcours, m), length (m),
                cps : [{type: 'sprint' | 'kom' | 'finish', s, start (pied d'une côte), cat ('hc', '1'…'4')}],
                feed : [{s, end}] (zones de ravitaillement), me : {name, color, gear (équipement du joueur : voir gear)},
                surfaces : [{s, end, kind ('smooth' | 'asphalt' | 'rough' | 'cobbles' | 'cobbles_hard' | 'gravel_hard' |
                'gravel_loose' | 'dirt' | 'wet' | 'grass'), w (largeur, m)}] (portions de revêtement), roadW (largeur hors portions, m) }
     frame  : { t (temps de course, s), k (secondes de course par seconde réelle : ×1 … ×50), run (la course avance),
                me (identifiant du joueur), riders : [{id, name, color, kind ('avatar' | 'trainer' | 'road' | 'bot' | 'ghost'),
                s (m depuis le départ), y (m, + à droite ; absent : file unique), v (m/s), P (W), w (W′ restant, 0–1),
                dr (abri : part de la traînée économisée), st (arrêté), fin (arrivé)}],
                env : {hour (heure locale, si la météo est connue), T (°C), rain (mm/h), ws (m/s), wd (° d'où vient le vent)} }
     gear   : { gear : {frame, wheels, tire, position, helmet, clothing, glasses, socks, shoes} } (vélo et tenue du joueur, ceux de
                la vitrine du magasin, voir B3D.Cyclist.GEAR ; un nouvel équipement change le cycliste sans reconstruire le paysage)
     cmd    : { cmd: 'camera' | 'sound' | 'reroll' | 'hud', on }
   Bike3D → PaceYourRide
     hello  : la vue est prête à recevoir le parcours (renvoyé chaque seconde tant qu'il n'est pas arrivé)
     status : { state: 'building' | 'ready' | 'error', seed, text, cam, sound }
     key    : { key, code, shift } (touches renvoyées au mode jeu quand la vue a le focus ; C change de caméra ici) */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { clamp, lerp, hashString } = B3D.util;
  const $ = (id) => document.getElementById(id);

  const V = 1;                    // version du protocole
  const MAX_AGE = 0.3;            // s réelles : au-delà, on ne prolonge plus le mouvement depuis la dernière image reçue
  const SNAP = 40;                // m : saut plus grand (reprise, nouveau départ) : on se place directement
  const LANES = [0, 0.75, -0.75, 1.5, -1.5, 2.2, -2.2]; // voies des coureurs sans position latérale (file unique côté simulation)
  const KIND_ICON = { avatar: '🎮 ', trainer: '🏠 ', road: '🚴 ', bot: '', ghost: '👻 ' };
  const KIND_LABEL = { avatar: 'avatar', trainer: 'home-trainer', road: 'sur la route' };
  const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

  function wanted() { return /[?&]pyr(=|&|$)/.test(location.search); }

  // Voies pour les coureurs dont la simulation ne donne pas la position latérale : chacun garde la sienne tant qu'elle
  // est libre, sinon prend la plus proche où personne ne roule à moins de 1,9 m devant ou derrière, sur la largeur de la
  // chaussée là où il est (o.half) ; sur un chemin trop étroit, on roule en file au milieu.
  function assignLanes(list) {
    const placed = [];
    list.sort((a, b) => b.sT - a.sT);
    for (const o of list) {
      const cur = o.laneT === undefined ? 0 : o.laneT;
      const lim = Math.max(0, o.half - 0.4);
      let best = null, bestC = Infinity, any = 0, anyC = Infinity;
      for (const ln of LANES) {
        if (Math.abs(ln) > lim) continue;
        const c = Math.abs(ln - cur) + Math.abs(ln) * 0.15;
        if (c < anyC) { anyC = c; any = ln; }
        let busy = false;
        for (const p of placed) if (Math.abs(p.sT - o.sT) < 1.9 && Math.abs(p.laneT - ln) < 0.6) { busy = true; break; }
        if (busy) continue;
        if (c < bestC) { bestC = c; best = ln; }
      }
      o.laneT = best === null ? any : best;
      placed.push(o);
    }
  }

  const Bridge = {
    wanted,
    game: null,
    hostWin: null,
    embedded: false,
    timeK: 0,       // secondes de course par seconde réelle (0 : course arrêtée)
    fr: null,       // dernière image reçue
    frAt: 0,        // heure de réception (ms, horloge locale)
    key: null,      // empreinte du parcours affiché
    ready: false,

    attach(game) {
      this.game = game;
      game.ext = this;
      document.body.classList.add('pyr');
      this.embedded = window.parent !== window;
      this.hostWin = this.embedded ? window.parent : window.opener;
      // HUD de la vue : dans une fenêtre à part (second écran), pas dans le cadre où le mode jeu affiche déjà le sien
      this.hudOn = /[?&]hud=1/.test(location.search) || !this.embedded;
      game.hide('screen-menu');
      game.show('screen-loading');
      game.setLoading(0, 'En attente du parcours de PaceYourRide…');
      window.addEventListener('message', (e) => this.onMessage(e));
      window.addEventListener('keydown', (e) => this.onKey(e), true);
      // le son ne démarre qu'après un geste (règle des navigateurs) ; une touche brève sur la vue change de caméra
      let down = null;
      window.addEventListener('pointerdown', (e) => {
        if (this.soundOn) game.sound.start();
        down = e.target === game.renderer.domElement ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
      });
      window.addEventListener('pointerup', (e) => {
        if (!down || !this.ready) return;
        const tap = performance.now() - down.t < 350 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 12;
        down = null;
        if (tap) this.camera();
      });
      this.soundOn = !this.embedded;
      game.sound.setMuted(!this.soundOn);
      this.buildHud();
      if (!this.hostWin) {
        game.setLoading(0, 'Cette vue s\'ouvre depuis l\'écran de course en 3D de PaceYourRide (page Jeu, « Univers 3D »).');
        return;
      }
      // l'application n'écoute peut-être pas encore : on se signale chaque seconde jusqu'à recevoir le parcours
      const hello = () => { if (!this.key) { this.post({ type: 'hello' }); setTimeout(hello, 1000); } };
      hello();
    },

    // caméra suivante (poursuite, large, TV, vue cycliste, drone), annoncée brièvement
    camera() {
      const g = this.game;
      g.cycleCamera();
      g.toast('🎥 ' + g.cameraName(), 1100);
      this.status();
    },

    fail(text) {
      this.post({ type: 'status', state: 'error', text });
      const g = this.game;
      if (g) { g.show('screen-loading'); g.setLoading(0, '⚠️ ' + text); }
    },

    post(msg) {
      if (!this.hostWin) return;
      try { this.hostWin.postMessage(Object.assign({ pyr3d: V }, msg), '*'); } catch (e) { /* fenêtre fermée */ }
    },

    status(extra) {
      const g = this.game;
      this.post(Object.assign({ type: 'status', state: this.ready ? 'ready' : 'building', seed: g.seed, cam: g.camIndex, sound: this.soundOn }, extra || {}));
    },

    onMessage(e) {
      const m = e.data;
      if (!m || m.pyr3d !== V || typeof m.type !== 'string') return;
      if (this.hostWin && e.source !== this.hostWin) return; // seule l'application qui nous a ouverts pilote la vue
      if (m.type === 'course') this.onCourse(m);
      else if (m.type === 'frame') this.onFrame(m);
      else if (m.type === 'gear') this.setGear(m.gear);
      else if (m.type === 'cmd') this.onCmd(m);
    },

    onCmd(m) {
      const g = this.game;
      if (m.cmd === 'camera') { if (this.ready) this.camera(); }
      else if (m.cmd === 'sound') {
        this.soundOn = m.on === undefined ? !this.soundOn : !!m.on;
        if (this.soundOn) g.sound.start();
        g.sound.setMuted(!this.soundOn);
        if (!this.soundOn) g.sound.silence();
      } else if (m.cmd === 'reroll') {
        // autre paysage autour du même parcours (pour soi : les autres joueurs gardent le leur)
        if (this.course && !g.building) this.build(this.course, (this.seed + 7919) % 1000000);
      } else if (m.cmd === 'hud') {
        this.hudOn = m.on === undefined ? !this.hudOn : !!m.on;
        this.hud.classList.toggle('hidden', !this.hudOn || !this.ready);
      }
      this.status();
    },

    // ------------------------------------------------------------ parcours et monde
    onCourse(m) {
      if (!Array.isArray(m.lat) || !Array.isArray(m.lng) || m.lat.length < 2 || m.lat.length !== m.lng.length) {
        this.fail('Parcours reçu illisible.');
        return;
      }
      if (m.key && m.key === this.key) { this.setGear(m.me && m.me.gear); return; }
      if (this.game.building) { this.pending = m; return; } // on attend la fin de la génération en cours
      this.key = m.key || String(Date.now());
      const seed = (num(m.seed, hashString(this.key)) >>> 0) % 1000000;
      this.build(m, seed);
    },

    build(m, seed) {
      const g = this.game;
      const ele = Array.isArray(m.ele) ? m.ele : [];
      const points = m.lat.map((lat, i) => ({ lat: +lat, lon: +m.lng[i], ele: Number.isFinite(+ele[i]) && ele[i] !== null ? +ele[i] : null }));
      let route;
      try { route = new B3D.Route({ name: String(m.name || 'Parcours PaceYourRide').slice(0, 80), points }); } catch (err) { this.fail(err.message); return; }
      this.course = m;
      this.seed = seed;
      this.pyrLen = num(m.length, 0) > 0 ? m.length : route.length;
      this.kS = route.length / this.pyrLen; // les deux tracés sont lissés différemment : on se repère en proportion
      this.ready = false;
      this.me = m.me || {};
      this.gearLate = false;
      this.setGear(this.me.gear, true);
      this.hud.classList.add('hidden');
      if (g.peloton) { g.peloton.dispose(); g.peloton = null; }
      this.castKey = null;
      g.route = route;
      g.state = 'menu';
      g.show('screen-loading');
      this.status();
      g.buildWorld(seed, route.sStart + Math.min(200, route.length * 0.1));
    },

    // abscisse Bike3D d'une distance de PaceYourRide
    toS(s) { return this.game.route.toS(clamp(s, 0, this.pyrLen) * this.kS); },

    // maillot du joueur : sa couleur dans PaceYourRide
    jersey() {
      const c = this.me && /^#[0-9a-f]{6}$/i.test(this.me.color) ? this.me.color : '#eb6834';
      return { name: 'PaceYourRide', base: c, accent: '#1d1a2b', style: 'stripe' };
    },

    // équipement du joueur (vélo, roues, position, tenue) ; build : le monde va être construit avec
    setGear(g, build) {
      if (!g || typeof g !== 'object' || Array.isArray(g)) return;
      const key = JSON.stringify(B3D.Cyclist.normGear(g));
      if (key === this.gearKey) return;
      this.gearKey = key;
      this.gearObj = g;
      if (build) return;
      if (this.ready && !this.game.building) this.game.swapCyclist();
      else this.gearLate = true; // reçu pendant la construction : on change de cycliste une fois le monde prêt
    },

    gear() { return this.gearObj || null; },

    onLandscape(L) {
      const m = this.course, cps = Array.isArray(m.cps) ? m.cps : [];
      const cat = (c) => (c === 'hc' ? 0 : clamp(parseInt(c, 10) || 4, 1, 4));
      L.extPoints = {
        sprints: cps.filter((c) => c && c.type === 'sprint').map((c) => this.toS(num(c.s, 0))),
        koms: cps.filter((c) => c && c.type === 'kom').map((c) => ({ s0: this.toS(num(c.start, num(c.s, 0) - 1000)), s1: this.toS(num(c.s, 0)), cat: cat(c.cat) })),
        feeds: (Array.isArray(m.feed) ? m.feed : []).filter((z) => z && z.end > z.s).map((z) => ({ s0: this.toS(z.s), s1: this.toS(z.end) }))
      };
      // revêtements (portions de PaceYourRide) : rang du revêtement et demi-largeur de la chaussée à chaque échantillon de la route ;
      // la plateforme garde sa largeur (6 m), une chaussée plus étroite a des bas-côtés, une plus large est dessinée à 6 m
      const route = this.game.route, n = route.n, sp = route.spacing, ids = B3D.road.SURFACE_IDS;
      const hw = (w, d) => clamp(num(w, d * 2) / 2, 0.9, L.roadHalf);
      const def = hw(m.roadW, L.roadHalf);
      L.surf = new Uint8Array(n);
      L.surfHalf = new Float32Array(n).fill(def);
      for (const p of Array.isArray(m.surfaces) ? m.surfaces : []) {
        const k = p ? ids.indexOf(p.kind) : -1;
        if (k < 0 || !(num(p.end, 0) > num(p.s, 0))) continue;
        const a = this.toS(p.s), b = this.toS(p.end), h = hw(p.w, def);
        for (let i = Math.max(0, Math.floor(a / sp) - 1); i < n && (i + 0.5) * sp < b; i++) {
          if ((i + 0.5) * sp < a) continue;
          L.surf[i] = k; L.surfHalf[i] = h;
        }
      }
    },

    // demi-largeur de la chaussée à l'abscisse s (Bike3D)
    halfAt(s) {
      const g = this.game, L = g.L, route = g.route;
      if (!L || !L.surfHalf) return L ? L.roadHalf : 3;
      const i = clamp(Math.round(s / route.spacing), 0, route.n - 1);
      return L.bridgeMask[i] ? L.roadHalf : L.surfHalf[i];
    },

    onWorldReady() {
      const g = this.game, route = g.route;
      g.ride = {
        s: route.sStart, lat: 0, latV: 0, v: 0, effort: 0, target: 0, braking: false,
        reserve: 1, bonk: false, draft: 0, msg: null,
        time: 0, maxV: 0, flamme: false, crowd: 0, standing: false, tuck: false,
        villagesSeen: new Set(), lastStrokes: 0, mooT: 1.5, bellT: 0, cowCheck: 0, cow: null, finishT: 0
      };
      g._rs = route.sample(g.ride.s, {});
      g.playerProxy = { isPlayer: true, s: g.ride.s, lat: 0, v: 0, done: false, state: 'player', name: this.me.name || 'Toi' };
      if (g.convoy) g.convoy.reset(null, g.playerProxy);
      g.camState = null;
      if (this.gearLate) { this.gearLate = false; g.swapCyclist(); }
      g.placeCyclistAtStart();
      // l'heure et le temps suivent la course de PaceYourRide (météo réelle si elle est connue)
      if (g.atmo) { g.atmo.setFlow(0); this.baseHour = g.atmo.hour; g.atmo.setWeather(g.atmo.state); }
      this.finished = false;
      this.envSet = false;
      this.sector = null;
      this.ready = true;
      g.state = 'pyr';
      this.hud.classList.toggle('hidden', !this.hudOn);
      this.status();
      if (this.pending) { const p = this.pending; this.pending = null; this.onCourse(p); }
    },

    // ------------------------------------------------------------ positions
    onFrame(m) {
      if (!Array.isArray(m.riders)) return;
      this.fr = m;
      this.frAt = performance.now();
      this.timeK = m.run ? clamp(num(m.k, 1), 0, 100) : 0;
    },

    // appelée par la boucle de Bike3D (état « pyr »)
    frame(dt) {
      const g = this.game;
      g.updateRide(dt);
      this.applyEnv(dt);
      if (this.hudOn) this.updateHud();
    },

    // position cible (abscisse Bike3D) d'un coureur : celle de l'image reçue, prolongée à sa vitesse depuis
    targetS(o, ext) {
      const run = !o.fin && !o.st;
      return this.toS(num(o.s, 0) + (run ? num(o.v, 0) * ext : 0));
    },

    // appelée par updateRide à la place de la physique du joueur et du peloton
    drive(dtReal, dt) {
      const F = this.fr, g = this.game, R = g.ride;
      if (!F || !R) return;
      const route = g.route;
      const ext = Math.min(MAX_AGE, (performance.now() - this.frAt) / 1000) * this.timeK;
      const meO = F.riders.find((o) => o.id === F.me) || null;
      const others = F.riders.filter((o) => o !== meO);
      const follow = (a, sT) => (Math.abs(sT - a) > SNAP ? sT : a + (sT - a) * (1 - Math.exp(-dtReal / 0.08)));
      const lanes = [];
      // le joueur
      if (meO) {
        R.sT = this.targetS(meO, ext);
        R.s = follow(R.s, R.sT);
        R.v = meO.st ? 0 : num(meO.v, 0);
        if (R.v > R.maxV) R.maxV = R.v;
        R.effort = Math.max(0, num(meO.P, 0));
        R.draft = clamp(num(meO.dr, 0), 0, 0.7);
        R.time = num(F.t, 0);
        R.half = this.halfAt(R.sT);
        if (Number.isFinite(meO.y)) R.laneT = clamp(meO.y, -(R.half - 0.35), R.half - 0.35);
        else lanes.push(R);
        if (meO.fin && !this.finished) this.onFinish();
      }
      // les autres : coureurs virtuels, fantômes, joueurs en direct (avatars, home-trainers, cyclistes sur la route)
      this.syncCast(others);
      const P = g.peloton;
      if (P) {
        P.riders.forEach((r, i) => {
          const o = others[i];
          r.sT = this.targetS(o, ext);
          r.s = follow(r.s, r.sT);
          r.v = o.st || o.fin ? 0 : num(o.v, 0);
          r.power = Number.isFinite(o.P) ? o.P : r.v > 1 ? 180 : 0;
          r.done = !!o.fin;
          r.state = o.st ? 'flat' : 'follow';
          r.half = this.halfAt(r.sT);
          if (Number.isFinite(o.y)) r.laneT = clamp(o.y, -(r.half - 0.35), r.half - 0.35);
          else lanes.push(r);
        });
      }
      if (lanes.length) assignLanes(lanes);
      // déplacement latéral lissé ; latV (m par seconde de course) sert au braquage et à l'inclinaison
      const side = (a) => {
        const tgt = a.laneT === undefined ? 0 : a.laneT;
        const nl = a.lat + (tgt - a.lat) * (1 - Math.exp(-dtReal * 5));
        const lv = dt > 1e-4 ? (nl - a.lat) / dt : 0;
        a.latV = lerp(a.latV || 0, lv, 1 - Math.exp(-dtReal * 8));
        a.lat = nl;
      };
      if (meO) side(R);
      if (P) for (const r of P.riders) side(r);
      // allure du joueur : danseuse dans les côtes raides, position aéro dans les descentes rapides
      const q = route.sample(R.s, g._rs);
      const cp = this.cpW();
      R.standing = R.effort > cp * 0.95 && q.grade > 0.06 && R.v < 8.5;
      R.tuck = R.effort < 40 && R.v > 14 && q.grade < -0.02;
      this.sectorCheck(R.s);
      const X = g.playerProxy;
      X.s = R.s; X.lat = R.lat; X.v = R.v;
      if (P) {
        P.playerDraft = R.draft;
        P.playerDraftSrc = null;
        P.sortList();
        this.groups(P);
      }
    },

    // entrée dans un secteur pavé ou un chemin : annonce, comme les villages
    sectorCheck(s) {
      const g = this.game, list = B3D.road.sectors(g.route, g.L);
      const cur = list.find((x) => s >= x.s0 && s < x.s1) || null;
      if (cur === this.sector) return;
      this.sector = cur;
      if (!cur || !this.timeK) return;
      const S = B3D.road.SURFACES[cur.k], info = S.sector;
      const km = ((cur.s1 - cur.s0) / 1000).toFixed(1).replace('.', ',');
      g.toast(info.icon + ' ' + info.title.charAt(0) + info.title.slice(1).toLowerCase() + ' n°' + cur.n + '<small>' + S.name + ' · ' + km + ' km · ' + '★'.repeat(info.stars) + '☆'.repeat(5 - info.stars) + '</small>', 2800);
    },

    // puissance critique approchée du joueur (danseuse), d'après sa vitesse et ses watts habituels
    cpW() { return num(this.course && this.course.cp, 280); },

    // les coureurs à l'écran : un peloton « marionnette » (même rendu que les coureurs de Bike3D), reconstruit quand la liste change
    syncCast(list) {
      const g = this.game, key = list.map((o) => o.id).join('|');
      if (key !== this.castKey) {
        this.castKey = key;
        const old = g.peloton;
        g.peloton = null;
        if (list.length) {
          const P = new B3D.Peloton(g.scene, g.route, g.L, { count: list.length, phys: g.phys, teams: B3D.race.TEAMS, playerColor: this.jersey().base });
          const prev = new Map(old ? old.riders.map((r) => [r.pid, r]) : []);
          P.riders.forEach((r, i) => {
            const o = list[i], p = prev.get(o.id);
            r.pid = o.id;
            Object.assign(r, { s: p ? p.s : this.toS(num(o.s, 0)), lat: p ? p.lat : 0, latV: 0, v: 0, power: 0, cp: 300, done: false, state: 'follow' });
            if (p) r.laneT = p.laneT;
          });
          P.player = g.playerProxy;
          P.list = P.riders.concat([g.playerProxy]);
          P.groups = [];
          P.time = 0;
          g.peloton = P;
          if (g.atmo) g.applyNightLights();
        }
        if (old) old.dispose();
        if (g.convoy) g.convoy.peloton = g.peloton;
      }
      const P = g.peloton;
      if (P) list.forEach((o, i) => P.setLook(i, (KIND_ICON[o.kind] || '') + String(o.name || 'Cycliste').slice(0, 30), o.color));
    },

    // groupes (écart de moins de 10 m) : la caravane suit celui du joueur et celui de tête
    groups(P) {
      const groups = [];
      let gr = null;
      for (const r of P.list) {
        if (r.done) continue;
        if (!gr || gr.last.s - r.s > 10) { gr = { members: [], leader: r, last: r, head: r }; groups.push(gr); }
        gr.members.push(r);
        gr.last = r;
        r.group = gr;
      }
      P.groups = groups;
    },

    onFinish() {
      const g = this.game, route = g.route;
      this.finished = true;
      const fp = route.sample(route.sEnd, {});
      const span = g.L.roadHalf + 1.4;
      for (const side of [-1, 1]) g.confetti.burst(fp.x + fp.rx * span * side, fp.y + 5.8, fp.z + fp.rz * span * side, 220);
      g.toast('🏁 Arrivée !', 2400);
    },

    // ------------------------------------------------------------ ciel et météo
    applyEnv(dt) {
      const g = this.game, A = g.atmo, F = this.fr;
      if (!A || !F) return;
      const env = F.env || {};
      A.setHour(Number.isFinite(env.hour) ? env.hour : this.baseHour + num(F.t, 0) / 3600);
      this._envT = (this._envT || 0) - dt;
      if (this._envT > 0) return;
      this._envT = 0.5;
      // vent réel (mesuré à 10 m) ; sans vent dans la simulation, le vent de Bike3D reste celui du paysage
      if (Number.isFinite(env.ws) && Number.isFinite(env.wd)) A.setExternalWind(env.ws, env.wd);
      else A.setExternalWind(null);
      if (!Number.isFinite(env.rain)) return;
      // pluie (mm/h) → temps affiché, avec un peu d'hystérésis pour ne pas clignoter autour des seuils
      const r = env.rain, cur = A.state, wet = cur === 'pluie' || cur === 'orage' || cur === 'neige';
      let want;
      if (r >= (wet ? 0.15 : 0.3)) want = num(env.T, 10) <= 1 ? 'neige' : r >= (cur === 'orage' ? 5 : 7) && num(env.gust, 0) > 12 ? 'orage' : 'pluie';
      else if (r > 0.02 || num(env.rh, 0) > 92) want = 'nuageux';
      else want = cur === 'nuageux' && r > 0 ? 'nuageux' : 'soleil';
      if (want !== cur || A.mode !== want) A.setWeather(want);
      // première lecture : le ciel est tout de suite celui de la course, sans transition
      if (!this.envSet) {
        this.envSet = true;
        Object.assign(A.cur, A.tgt);
        A.wet = A.cur.rain > 0.2 || num(env.wet, 0) > 0.3 ? 1 : 0;
      }
    },

    // ------------------------------------------------------------ clavier
    onKey(e) {
      if (!this.ready) return;
      if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!e.repeat) this.camera();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (!this.hostWin) return;
      // le reste (puissance, tactiques, rang, alimentation, pause…) revient au mode jeu
      if (/^(Arrow|Page|Space)/.test(e.code) || e.key === ' ') e.preventDefault();
      if (!e.repeat || /^Arrow/.test(e.code)) this.post({ type: 'key', key: e.key, code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
      e.stopImmediatePropagation();
    },

    // ------------------------------------------------------------ HUD (fenêtre à part)
    buildHud() {
      const h = this.hud = document.createElement('div');
      h.id = 'pyr-hud';
      h.className = 'pyr-hud hidden';
      h.innerHTML = '<div class="ph-main"><b id="ph-speed">0</b><small>km/h</small></div>' +
        '<div class="ph-row"><span id="ph-power">0 W</span><span id="ph-grade">0 %</span></div>' +
        '<div class="ph-row"><span id="ph-time">0:00</span><span id="ph-dist">0 km</span></div>' +
        '<div class="ph-row"><span id="ph-rank"></span><span id="ph-wbal"></span></div>' +
        '<div class="ph-row"><span id="ph-surf"></span></div>' +
        '<div class="ph-btns"><button id="ph-cam" title="Changer de caméra (C)">🎥</button><button id="ph-sound" title="Son">🔇</button></div>';
      document.body.appendChild(h);
      h.querySelector('#ph-cam').addEventListener('click', () => this.camera());
      h.querySelector('#ph-sound').addEventListener('click', () => this.onCmd({ cmd: 'sound' }));
    },

    updateHud() {
      const now = performance.now();
      if (now - (this._hudT || 0) < 120) return;
      this._hudT = now;
      const F = this.fr, R = this.game.ride;
      if (!F || !R) return;
      const meO = F.riders.find((o) => o.id === F.me);
      const set = (id, t) => { const el = $(id); if (el.textContent !== t) el.textContent = t; };
      const q = this.game._rs;
      set('ph-speed', String(Math.round(R.v * 3.6)));
      set('ph-power', Math.round(R.effort) + ' W');
      set('ph-grade', (q ? Math.round(q.grade * 100) : 0) + ' %');
      set('ph-time', B3D.util.formatTime(num(F.t, 0)));
      const done = meO ? num(meO.s, 0) : 0;
      set('ph-dist', (done / 1000).toFixed(1).replace('.', ',') + ' / ' + (this.pyrLen / 1000).toFixed(1).replace('.', ',') + ' km');
      if (meO) {
        const racers = F.riders.filter((o) => o.kind !== 'ghost');
        const ahead = racers.filter((o) => o !== meO && (o.fin && !meO.fin ? true : o.s > meO.s)).length;
        set('ph-rank', racers.length > 1 ? (ahead + 1) + 'ᵉ / ' + racers.length : (KIND_LABEL[meO.kind] || ''));
        set('ph-wbal', Number.isFinite(meO.w) ? '🔋 ' + Math.round(clamp(meO.w, 0, 1) * 100) + ' %' : '');
      }
      // revêtement sous les roues (hors asphalte ordinaire)
      const L = this.game.L, k = L && L.surf && q ? L.surf[q.i] : 0;
      set('ph-surf', k ? B3D.road.SURFACES[k].name : '');
      $('ph-sound').textContent = this.soundOn ? '🔊' : '🔇';
    }
  };

  B3D.bridge = Bridge;
})(window);
