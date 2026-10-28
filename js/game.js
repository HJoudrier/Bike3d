/* Bike3D — boucle principale : interface, génération du monde, aperçu, physique du vélo, caméra. */
(function () {
  'use strict';
  const B3D = window.B3D;
  const { clamp, lerp, smoothstep, formatTime, hashString } = B3D.util;
  const $ = (id) => document.getElementById(id);

  // cp : puissance critique (tenable longtemps), wp : réserve d'énergie au-dessus de cp (J), riderMass : coureur sans vélo
  const PHYS = { mass: 85, riderMass: 77, g: 9.81, crr: 0.0045, rho: 1.2, cda: 0.32, cdaTuck: 0.22, cdaStand: 0.4, pMax: 720, cp: 330, wp: 22000, brake: 430, vMax: 30 };
  const RIDER_COUNTS = [0, 5, 10, 20, 40];
  // réglages du ciel : [valeur, libellé]
  const SKY_OPTS = {
    weather: [['variable', '🎲 Variable'], ['soleil', '☀️ Soleil'], ['nuageux', '⛅ Nuageux'], ['pluie', '🌧️ Pluie'], ['orage', '⛈️ Orage'], ['neige', '🌨️ Neige']],
    wind: [['auto', '🎲'], ['calme', 'Calme'], ['brise', 'Brise'], ['fort', 'Fort'], ['tempete', 'Tempête']],
    timeFlow: [[0, '⏸ Figé'], [30, '▶ ×30'], [300, '⏩ ×300']]
  };
  const CAMS = [
    { name: 'Poursuite', dist: 5.2, height: 2.0, look: 1.1, ahead: 4 },
    { name: 'Large', dist: 11, height: 4.6, look: 1.0, ahead: 7 },
    { name: 'TV', tv: true },
    { name: 'Vue cycliste', fpv: true },
    { name: 'Drone', dist: 24, height: 17, look: 0, ahead: 12 }
  ];
  const TIME_SCALES = [1, 2, 4, 8];

  function nextFrame() { return new Promise((r) => requestAnimationFrame(() => r())); }
  function angleWrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

  const Game = {
    state: 'menu',
    settings: { jersey: 'jaune', quality: 'medium', riders: 10, hour: 'auto', weather: 'variable', wind: 'auto', timeFlow: 30 },
    phys: PHYS,
    input: { left: false, right: false, brake: false, pUp: false, pDown: false },
    camIndex: 0,
    timeScaleIndex: 0,

    init() {
      try { Object.assign(this.settings, JSON.parse(localStorage.getItem('bike3d-settings') || '{}')); } catch (e) { /* stockage indisponible */ }
      if (!B3D.TileManager.QUALITY[this.settings.quality]) this.settings.quality = 'medium';
      if (!B3D.Cyclist.JERSEYS[this.settings.jersey]) this.settings.jersey = 'jaune';
      if (!RIDER_COUNTS.includes(this.settings.riders)) this.settings.riders = 10;
      if (!SKY_OPTS.weather.some((o) => o[0] === this.settings.weather)) this.settings.weather = 'variable';
      if (!SKY_OPTS.wind.some((o) => o[0] === this.settings.wind)) this.settings.wind = 'auto';
      if (!SKY_OPTS.timeFlow.some((o) => o[0] === this.settings.timeFlow)) this.settings.timeFlow = 30;
      if (typeof this.settings.hour !== 'number') this.settings.hour = 'auto';

      const canvas = $('scene');
      let r;
      try {
        r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
      } catch (err) {
        this.showError('Ton navigateur ne permet pas l\'affichage 3D (WebGL indisponible). Essaie avec un navigateur récent ou active l\'accélération matérielle.');
        $('btn-model').disabled = true;
        if (B3D.bridge && B3D.bridge.wanted()) B3D.bridge.fail('WebGL indisponible : la vue 3D ne peut pas s\'afficher dans ce navigateur.');
        return;
      }
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFShadowMap;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.2, 7000);
      this.sun = new THREE.DirectionalLight('#ffffff', 3);
      this.sun.castShadow = true;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.03;
      this.scene.add(this.sun, this.sun.target);
      this.hemi = new THREE.HemisphereLight('#cfe8ff', '#86b860', 1.6);
      this.scene.add(this.hemi);
      this.scene.fog = new THREE.Fog('#cfe9fb', 150, 650);
      this.applyQuality();
      this.hud = new B3D.Hud();
      this.confetti = new B3D.Confetti(this.scene, 600);
      this.mooBubble = this.makeBubble('MEUH !');
      this.scene.add(this.mooBubble);
      this.sound = new B3D.Sound();
      this.clock = new THREE.Clock();

      this.bindUI();
      this.bindInput();
      window.addEventListener('resize', () => this.resize());
      this.resize();
      // réalité virtuelle (WebXR) ; la boucle passe par le moteur de rendu pour suivre le rythme du casque
      this.vr = new B3D.VRMode(this);
      this.renderer.setAnimationLoop(() => this.loop());
      // vue 3D pilotée par PaceYourRide (index.html?pyr) : parcours et positions reçus de l'application
      if (B3D.bridge && B3D.bridge.wanted()) B3D.bridge.attach(this);
    },

    saveSettings() {
      try { localStorage.setItem('bike3d-settings', JSON.stringify(this.settings)); } catch (e) { /* ignoré */ }
    },

    applyQuality() {
      const Q = B3D.TileManager.QUALITY[this.settings.quality];
      this.Q = Q;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.pixelRatio));
      this.sun.shadow.mapSize.set(Q.shadow, Q.shadow);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      this.scene.fog.near = Q.radius * 0.22;
      this.scene.fog.far = Q.radius * 0.93;
      if (this.atmo) this.atmo.setFogBase(Q.radius * 0.22, Q.radius * 0.93);
      this.resize();
    },

    resize() {
      if (this.renderer.xr && this.renderer.xr.isPresenting) return; // le casque impose sa résolution
      const w = window.innerWidth, h = window.innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      // contour d'environ 1,7 px quelle que soit la taille de l'écran
      B3D.toon.shared.uOutlineScale.value = 1.7 * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) / h;
      if (this.hcCrowd) this.hcCrowd.setViewHeight(this.renderer.getDrawingBufferSize(new THREE.Vector2()).y);
      if (this.atmo) this.atmo.setPointScale(this.renderer.getDrawingBufferSize(new THREE.Vector2()).y * 0.5 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    },

    // ------------------------------------------------------------------ interface
    bindUI() {
      // démos
      const db = $('demo-buttons');
      for (const d of B3D.demoRoutes.list) {
        const b = document.createElement('button');
        b.className = 'btn small';
        b.innerHTML = d.name.replace(' (démo)', '') + '<small>' + d.desc + '</small>';
        b.onclick = () => this.loadRouteData(B3D.demoRoutes.get(d.id));
        db.appendChild(b);
      }
      // import fichier
      $('gpx-input').addEventListener('change', (e) => {
        const f = e.target.files[0];
        if (f) this.readFile(f);
        e.target.value = '';
      });
      const dz = $('dropzone');
      ['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
      window.addEventListener('drop', (e) => {
        const f = e.dataTransfer && e.dataTransfer.files[0];
        if (f && this.state === 'menu') this.readFile(f);
      });
      // options
      const jc = $('opt-jersey');
      for (const [id, j] of Object.entries(B3D.Cyclist.JERSEYS)) {
        const b = document.createElement('button');
        b.className = 'chip';
        b.dataset.j = id;
        const sw = j.style === 'rainbow' ? 'conic-gradient(#3d7be0,#e2463a,#1d1a2b,#f2c230,#4cc35a,#3d7be0)' : j.style === 'dots' ? 'radial-gradient(circle,#e2463a 0 3px,#fff 3.5px)' : j.base;
        b.innerHTML = '<span class="sw" style="background:' + sw + '"></span>' + j.name;
        b.onclick = () => { this.settings.jersey = id; this.saveSettings(); this.refreshChips(); };
        jc.appendChild(b);
      }
      document.querySelectorAll('#opt-quality .chip').forEach((b) => {
        b.onclick = () => { this.settings.quality = b.dataset.q; this.saveSettings(); this.refreshChips(); this.applyQuality(); };
      });
      document.querySelectorAll('#opt-riders .chip').forEach((b) => {
        b.onclick = () => { this.settings.riders = +b.dataset.n; this.saveSettings(); this.refreshChips(); };
      });
      this.refreshChips();
      this.buildSkyControls();

      $('btn-model').onclick = () => this.newLandscape();
      $('btn-remodel').onclick = () => this.newLandscape();
      $('btn-validate').onclick = () => this.startRide();
      $('btn-vr').onclick = () => this.enterVR(false);
      $('btn-pause-vr').onclick = () => this.enterVR(true);
      $('btn-back').onclick = () => this.toMenu();
      $('btn-flyover').onclick = () => { this.preview.auto = !this.preview.auto; this.updateFlyBtn(); };
      const pos = $('preview-pos');
      pos.addEventListener('input', () => {
        this.preview.s = this.route.sStart + (pos.value / 1000) * this.route.length;
        this.preview.auto = false;
        this.updateFlyBtn();
      });
      $('btn-resume').onclick = () => this.togglePause(false);
      $('btn-restart').onclick = () => { this.hide('screen-pause'); this.startRide(); };
      $('btn-pause-landscape').onclick = () => { this.hide('screen-pause'); this.backToPreview(true); };
      $('btn-pause-menu').onclick = () => { this.hide('screen-pause'); this.toMenu(); };
      $('btn-again').onclick = () => { this.hide('screen-finish'); this.startRide(); };
      $('btn-finish-landscape').onclick = () => { this.hide('screen-finish'); this.backToPreview(true); };
      $('btn-finish-menu').onclick = () => { this.hide('screen-finish'); this.toMenu(); };

      // souris dans l'aperçu
      const cv = $('scene');
      let drag = null;
      cv.addEventListener('pointerdown', (e) => { if (this.state === 'preview') { drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); } });
      cv.addEventListener('pointermove', (e) => {
        if (!drag || this.state !== 'preview') return;
        this.preview.angle -= (e.clientX - drag.x) * 0.006;
        this.preview.pitch = clamp(this.preview.pitch + (e.clientY - drag.y) * 0.004, 0.12, 1.4);
        drag.x = e.clientX; drag.y = e.clientY;
      });
      cv.addEventListener('pointerup', () => { drag = null; });
      cv.addEventListener('wheel', (e) => {
        if (this.state !== 'preview') return;
        e.preventDefault();
        this.preview.radius = clamp(this.preview.radius * Math.exp(e.deltaY * 0.0012), 20, 520);
      }, { passive: false });
    },

    // Réglages du ciel (aperçu et pause) : heure, météo, vent, écoulement du temps. Les changements
    // s'appliquent tout de suite au paysage, avec une transition douce pour la météo et le vent.
    buildSkyControls() {
      const row = (key, label) => '<div class="sky-row" data-k="' + key + '"><span class="sky-lbl">' + label + '</span>' +
        SKY_OPTS[key].map(([v, l]) => '<button class="chip" data-v="' + v + '">' + l + '</button>').join('') + '</div>';
      document.querySelectorAll('.sky-host').forEach((host) => {
        host.innerHTML = '<details class="sky-ctl"' + (host.dataset.open ? ' open' : '') + '><summary>🌦️ Ciel et météo <small class="sky-sum"></small></summary>' +
          '<div class="sky-row"><span class="sky-lbl">🕐 Heure</span><input type="range" class="sky-hour" min="0" max="23.99" step="0.25" aria-label="Heure de la journée"><b class="sky-clock">--:--</b>' +
          '<button class="chip sky-hour-auto" title="Heure tirée au hasard pour chaque nouveau paysage">🎲</button></div>' +
          row('weather', 'Météo') + row('wind', '💨 Vent') + row('timeFlow', '⏳ Temps') + '</details>';
      });
      document.querySelectorAll('.sky-row[data-k] .chip').forEach((b) => {
        b.onclick = () => {
          const k = b.parentElement.dataset.k;
          const v = k === 'timeFlow' ? +b.dataset.v : b.dataset.v;
          this.settings[k] = v;
          this.saveSettings();
          if (this.atmo) {
            if (k === 'weather') this.atmo.setWeather(v);
            else if (k === 'wind') this.atmo.setWind(v);
            else this.atmo.setFlow(v);
          }
          this.syncSkyControls();
        };
      });
      document.querySelectorAll('.sky-hour-auto').forEach((b) => {
        b.onclick = () => { this.settings.hour = 'auto'; this.saveSettings(); this.syncSkyControls(); };
      });
      document.querySelectorAll('.sky-hour').forEach((inp) => {
        inp.addEventListener('pointerdown', () => { this._hourDrag = true; });
        inp.addEventListener('pointerup', () => { this._hourDrag = false; });
        inp.addEventListener('input', () => {
          const h = +inp.value;
          this.settings.hour = h;
          if (this.atmo) this.atmo.setHour(h);
          this.syncSkyControls();
        });
        inp.addEventListener('change', () => { this._hourDrag = false; this.saveSettings(); });
      });
    },

    syncSkyControls() {
      const A = this.atmo;
      const info = A ? A.info() : null;
      document.querySelectorAll('.sky-row[data-k]').forEach((r) => {
        const k = r.dataset.k;
        r.querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', String(this.settings[k]) === b.dataset.v));
      });
      document.querySelectorAll('.sky-hour-auto').forEach((b) => b.classList.toggle('active', this.settings.hour === 'auto'));
      if (!info) return;
      document.querySelectorAll('.sky-clock').forEach((e) => { e.textContent = info.clock; });
      document.querySelectorAll('.sky-sum').forEach((e) => { e.textContent = info.clock + ' · ' + info.period + ' · ' + info.icon + ' · 💨 ' + info.windKmh + ' km/h'; });
      if (!this._hourDrag) document.querySelectorAll('.sky-hour').forEach((e) => { e.value = A.hour.toFixed(2); });
    },

    refreshChips() {
      document.querySelectorAll('#opt-jersey .chip').forEach((b) => b.classList.toggle('active', b.dataset.j === this.settings.jersey));
      document.querySelectorAll('#opt-quality .chip').forEach((b) => b.classList.toggle('active', b.dataset.q === this.settings.quality));
      document.querySelectorAll('#opt-riders .chip').forEach((b) => b.classList.toggle('active', +b.dataset.n === this.settings.riders));
    },

    // Commandes : ←/→ (ou Q/D) pour se déplacer, jauge de puissance (Z/S, molette, chiffres, glisser), Espace pour freiner.
    // Les codes sont physiques : KeyW/KeyA = Z/Q sur un clavier AZERTY.
    bindInput() {
      const map = { ArrowLeft: 'left', ArrowRight: 'right', KeyA: 'left', KeyD: 'right', KeyW: 'pUp', KeyS: 'pDown', Space: 'brake' };
      const riding = () => this.state === 'ride' || this.state === 'countdown';
      window.addEventListener('keydown', (e) => {
        const k = map[e.code];
        if (k && riding()) {
          e.preventDefault();
          if (!this.input[k] && (k === 'pUp' || k === 'pDown')) this.setTarget(this.ride.target + (k === 'pUp' ? 10 : -10));
          this.input[k] = true;
        }
        // chiffres : 1 = 10 % … 9 = 90 %, 0 = 100 % de la puissance maximale
        const dg = /^(Digit|Numpad)([0-9])$/.exec(e.code);
        if (dg && riding()) { const n = +dg[2]; this.setTarget(PHYS.pMax * (n === 0 ? 1 : n / 10)); }
        if (e.repeat) return;
        if (riding()) {
          if (e.code === 'KeyC') this.cycleCamera();
          if (e.code === 'KeyT') this.cycleTimeScale();
          if (e.code === 'KeyM') this.sound.setMuted(!this.sound.muted);
          if (e.code === 'Escape' || e.code === 'KeyP') this.togglePause(true);
        } else if (this.state === 'paused' && (e.code === 'Escape' || e.code === 'KeyP')) {
          this.togglePause(false);
        }
      });
      window.addEventListener('keyup', (e) => {
        const k = map[e.code];
        if (k) this.input[k] = false;
      });
      window.addEventListener('blur', () => { for (const k in this.input) this.input[k] = false; });
      // molette : règle la jauge pendant la course
      $('scene').addEventListener('wheel', (e) => {
        if (!riding()) return;
        e.preventDefault();
        this.setTarget(this.ride.target - Math.sign(e.deltaY) * 15);
      }, { passive: false });
      // jauge : on la saisit et on la fait glisser (souris ou doigt)
      const gauge = $('g-track');
      let gDrag = false;
      const fromY = (e) => {
        const rc = gauge.getBoundingClientRect();
        this.setTarget((1 - clamp((e.clientY - rc.top) / rc.height, 0, 1)) * PHYS.pMax);
      };
      gauge.addEventListener('pointerdown', (e) => { if (!riding()) return; e.preventDefault(); gDrag = true; gauge.setPointerCapture(e.pointerId); fromY(e); });
      gauge.addEventListener('pointermove', (e) => { if (gDrag) fromY(e); });
      const stop = () => { gDrag = false; };
      gauge.addEventListener('pointerup', stop);
      gauge.addEventListener('pointercancel', stop);
      // commandes tactiles
      document.querySelectorAll('#touch-pad button').forEach((b) => {
        const k = b.dataset.k;
        const on = (e) => { e.preventDefault(); this.input[k] = true; b.classList.add('on'); };
        const off = (e) => { e.preventDefault(); this.input[k] = false; b.classList.remove('on'); };
        b.addEventListener('pointerdown', on);
        b.addEventListener('pointerup', off);
        b.addEventListener('pointercancel', off);
        b.addEventListener('pointerleave', off);
      });
    },

    timeScale() { return TIME_SCALES[this.timeScaleIndex]; },
    cycleTimeScale() { this.timeScaleIndex = (this.timeScaleIndex + 1) % TIME_SCALES.length; },

    // ------------------------------------------------------------------ réalité virtuelle
    refreshVRButtons() {
      const ok = this.vr && this.vr.supported && !this.vr.presenting;
      for (const id of ['btn-vr', 'btn-pause-vr']) $(id).classList.toggle('hidden', !ok);
    },

    showVRError(msg) { this.toast('🥽 ' + msg, 4000); },

    // entrée / sortie du casque
    onVRChange(on) {
      this.refreshVRButtons();
      if (on) { this.camState = null; return; }
      this.resize();
      if (this.hcCrowd) this.hcCrowd.setPointScale(null);
      this.camState = null;
      // on a retiré le casque en pleine course : pause, pour reprendre à l'écran
      if (this.state === 'ride' || this.state === 'countdown') this.togglePause(true);
    },

    // bouton « Rouler en VR » (aperçu) ou « Passer en VR » (pause)
    async enterVR(fromPause) {
      if (this.building || !this.L) return;
      const ok = await this.vr.enter();
      if (!ok) return;
      if (fromPause) this.togglePause(false);
      else if (this.state === 'preview') this.startRide();
    },

    show(id) { $(id).classList.remove('hidden'); },
    hide(id) { $(id).classList.add('hidden'); },

    // Messages : un message arrivé pendant qu'un autre vient de s'afficher attend son tour.
    toast(html, ms) {
      const t = $('toast');
      this._toastQ = this._toastQ || [];
      if (!t.classList.contains('hidden') && performance.now() - this._toastShownAt < 1400) {
        this._toastQ.push([html, ms]);
        this._armToast();
        return;
      }
      this._showToast(html, ms);
    },

    _showToast(html, ms) {
      if (this.vr && this.vr.presenting) this.vr.toast(html, ms);
      const t = $('toast');
      t.innerHTML = html;
      t.classList.remove('hidden');
      t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
      this._toastShownAt = performance.now();
      this._toastMs = ms || 2600;
      this._armToast();
    },

    _armToast() {
      clearTimeout(this._toastT);
      const q = this._toastQ || [];
      const left = Math.max(0, this._toastShownAt + (q.length ? 1400 : this._toastMs) - performance.now());
      this._toastT = setTimeout(() => {
        if (q.length) { const [h, m] = q.shift(); this._showToast(h, m); } else $('toast').classList.add('hidden');
      }, left);
    },

    showError(msg) {
      const e = $('menu-error');
      e.textContent = '😕 ' + msg;
      e.classList.remove('hidden');
    },

    readFile(f) {
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const data = B3D.gpx.parse(String(fr.result));
          if (!data.name) data.name = f.name.replace(/\.gpx$/i, '');
          this.loadRouteData(data);
        } catch (err) {
          this.showError(err.message);
        }
      };
      fr.onerror = () => this.showError('Impossible de lire le fichier.');
      fr.readAsText(f);
    },

    loadRouteData(data) {
      $('menu-error').classList.add('hidden');
      let route;
      try {
        route = new B3D.Route(data);
      } catch (err) {
        this.showError(err.message);
        return;
      }
      this.route = route;
      this.state = 'menu';
      this.disposeWorld();
      const st = route.stats;
      $('route-name').textContent = route.name;
      const fmt = (v) => Math.round(v).toLocaleString('fr-FR');
      const stats = [
        ['📏', (st.length / 1000).toFixed(1).replace('.', ',') + ' km', 'distance'],
        ['⬆️', fmt(st.gain) + ' m', 'D+'],
        ['⬇️', fmt(st.loss) + ' m', 'D−'],
        ['🏔️', fmt(st.maxEle) + ' m', 'alt. max'],
        ['📐', Math.round(st.maxGrade * 100) + ' %', 'pente max']
      ];
      $('route-stats').innerHTML = stats.map((s) => '<span class="stat">' + s[0] + ' <b>' + s[1] + '</b> <small>' + s[2] + '</small></span>').join('');
      if (route.syntheticElevation) {
        $('route-stats').innerHTML += '<span class="stat">⚠️ altitudes absentes du GPX : relief inventé</span>';
      }
      B3D.drawProfile($('route-profile'), route);
      const cats = ['HC', '1', '2', '3', '4'];
      $('route-climbs').innerHTML = route.climbs.length
        ? route.climbs.map((c, i) => '<span class="climb-tag"><span class="cat">' + (c.cat === 0 ? 'HC' : 'Cat. ' + cats[c.cat]) + '</span>Montée ' + (i + 1) + ' : ' + (c.length / 1000).toFixed(1).replace('.', ',') + ' km à ' + (c.avg * 100).toFixed(1).replace('.', ',') + ' %</span>').join('')
        : '<span class="climb-tag">Pas de grosse montée : parcours roulant 😎</span>';
      $('route-info').classList.remove('hidden');
      $('route-info').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    // ------------------------------------------------------------------ génération du monde
    newLandscape() {
      if (this.building || !this.route) return;
      let seed;
      try { seed = crypto.getRandomValues(new Uint32Array(1))[0]; } catch (e) { seed = Math.floor(Math.random() * 4294967295); }
      seed = seed % 1000000; // numéro lisible
      const focus = this.preview && this.state === 'preview' ? this.preview.s : this.route.sStart + Math.min(200, this.route.length * 0.1);
      this.buildWorld(seed, focus);
    },

    disposeWorld() {
      const sc = this.scene;
      // libère géométries, matériaux et textures (panneaux, banderoles…) d'un groupe
      const free = (root) => {
        sc.remove(root);
        root.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material && !o.userData.isOutline) {
            if (o.material.map) o.material.map.dispose();
            o.material.dispose();
          }
        });
      };
      if (this.tiles) { this.tiles.dispose(); this.tiles = null; }
      if (this.roadGroup) { free(this.roadGroup); this.roadGroup = null; }
      if (this.waterGroup) { free(this.waterGroup); this.waterGroup = null; }
      if (this.villageGroup) { free(this.villageGroup); this.villageGroup = null; }
      if (this.fauna) { this.fauna.dispose(); this.fauna = null; }
      if (this.peloton) { this.peloton.dispose(); this.peloton = null; }
      if (this.convoy) { this.convoy.dispose(); this.convoy = null; }
      if (this.hcCrowd) { this.hcCrowd.dispose(); this.hcCrowd = null; }
      if (this.mooBubble) this.mooBubble.visible = false;
      if (this.atmo) { this.atmo.dispose(); this.atmo = null; }
      if (this.sky) { this.sky.dispose(); this.sky = null; }
      if (this.cyclist) { free(this.cyclist.root); this.cyclist = null; }
      this.L = null;
    },

    setLoading(p, text) {
      $('loading-bar').style.width = Math.round(p * 100) + '%';
      if (text) $('loading-text').textContent = text;
    },

    async buildWorld(seed, focusS) {
      try {
        await this._buildWorld(seed, focusS);
      } catch (err) {
        console.error(err);
        this.building = false;
        if (this.ext) { this.ext.fail('La génération du paysage a échoué (' + err.message + ').'); return; }
        document.querySelectorAll('#btn-model, #btn-remodel, #btn-validate').forEach((b) => { b.disabled = false; });
        this.hide('screen-loading');
        this.toMenu();
        this.showError('La génération du paysage a échoué (' + err.message + '). Réessaie ou change de qualité graphique.');
      }
    },

    async _buildWorld(seed, focusS) {
      this.building = true;
      document.querySelectorAll('#btn-model, #btn-remodel, #btn-validate').forEach((b) => { b.disabled = true; });
      this.show('screen-loading');
      this.setLoading(0.02, 'Lecture du relief…');
      await nextFrame();
      if (this.state === 'menu') this.hide('screen-menu');
      this.disposeWorld();
      const route = this.route;
      const t0 = performance.now();
      const L = this.L = new B3D.Landscape(route, seed);
      this.seed = seed;
      if (this.ext) this.ext.onLandscape(L); // sprints, côtes et ravitaillements de la course pilotée
      this.setLoading(0.15, 'Rivières, lacs et falaises…');
      await nextFrame();

      // ciel, heure, météo et vent (couleurs de base données par l'ambiance)
      this.sky = new B3D.Sky(this.scene, L);
      this.atmo = new B3D.Atmosphere({ scene: this.scene, sky: this.sky, sun: this.sun, hemi: this.hemi, fog: this.scene.fog, quality: this.settings.quality }, L, this.settings);
      this.atmo.setFogBase(this.Q.radius * 0.22, this.Q.radius * 0.93);
      this.atmo.onThunder = (t) => this.thunder(t);
      this.atmo.setPointScale(this.renderer.getDrawingBufferSize(new THREE.Vector2()).y * 0.5 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
      this.sunDir = this.atmo.lightDir;
      this.atmoStart = null;

      this.roadGroup = B3D.road.build(route, L);
      this.scene.add(this.roadGroup);
      this.waterGroup = B3D.water.build(L);
      this.scene.add(this.waterGroup);
      this.setLoading(0.3, 'Route, ponts et panneaux…');
      await nextFrame();

      this.tiles = new B3D.TileManager(this.scene, L, this.settings.quality);
      B3D.road.placeRoadsideInstances(route, L, this.tiles);
      this.setLoading(0.32, 'Construction des villages…');
      this.villageGroup = B3D.villages.build(route, L, this.tiles);
      this.scene.add(this.villageGroup);
      this.fauna = new B3D.Fauna(this.scene, L, route);
      this.convoy = new B3D.Convoy(this.scene, route, L);
      // cols hors catégorie : foule sur la chaussée et fumigènes
      this.hcCrowd = new B3D.HCCrowd(this.scene, route, L);
      if (!this.hcCrowd.active) this.hcCrowd = null;
      else this.hcCrowd.setViewHeight(this.renderer.getDrawingBufferSize(new THREE.Vector2()).y);
      this.cyclist = new B3D.Cyclist({ jersey: this.settings.jersey, custom: this.ext ? this.ext.jersey() : null, bikeColor: ['#e2463a', '#3d7be0', '#1d1a2b', '#4cc35a', '#ff7aa8'][seed % 5] });
      this.scene.add(this.cyclist.root);
      this.placeCyclistAtStart();
      // panneaux et banderoles (non éclairés) : assombris la nuit
      this.atmo.registerBasic(this.roadGroup);
      this.atmo.registerBasic(this.villageGroup);
      this.syncSkyControls();

      // aperçu centré sur le point focal
      this.preview = Object.assign(this.preview || { angle: 0.7, pitch: 0.5, radius: 150 }, { s: focusS, auto: true });
      this.updateFlyBtn();
      const p = route.sample(focusS, {});
      const total = Math.max(1, this.tiles.pendingCount(p.x, p.z).total);
      this.state = 'preview';
      for (let it = 0; it < 400; it++) {
        const remaining = this.tiles.update(p.x, p.z, 28);
        this.setLoading(0.32 + 0.66 * (1 - remaining / total), 'Plantation des arbres et des champs…');
        this.updatePreviewCamera(0);
        this.render();
        await nextFrame();
        if (remaining === 0) break;
      }
      this.tiles.update(p.x, p.z, 60);
      // compile d'avance les shaders des objets encore cachés (oiseaux, canards…) pour éviter un à-coup en course
      this.setLoading(0.99, 'Derniers coups de pinceau…');
      await nextFrame();
      try { await this.renderer.compileAsync(this.scene, this.camera); } catch (e) { this.renderer.compile(this.scene, this.camera); }
      this.setLoading(1, 'Prêt !');
      console.info('[Bike3D] paysage', seed, 'généré en', Math.round(performance.now() - t0), 'ms');
      if (this.ext) {
        // vue pilotée : pas d'aperçu, on rejoint directement la course
        this.hide('screen-loading');
        this.building = false;
        this.clock.getDelta();
        this.ext.onWorldReady();
        return;
      }

      // interface d'aperçu
      $('seed-label').textContent = seed;
      $('preview-title').textContent = L.amb.name;
      const desc = L.describe();
      if (L.race) desc.push({ icon: '🏁', label: 'Course', value: B3D.race.summary(L) });
      $('landscape-desc').innerHTML = desc.map((d) => '<li><span>' + d.icon + ' ' + d.label + '</span><b>' + d.value + '</b></li>').join('');
      this.hide('screen-loading');
      this.hide('hud');
      this.show('screen-preview');
      this.building = false;
      document.querySelectorAll('#btn-model, #btn-remodel, #btn-validate').forEach((b) => { b.disabled = false; });
      this.clock.getDelta();
    },

    updateFlyBtn() {
      $('btn-flyover').textContent = this.preview && this.preview.auto ? '⏸' : '▶';
    },

    backToPreview(newOne) {
      this.hide('hud');
      this.sound.silence();
      // la course est finie : on range les coureurs et la caravane
      if (this.peloton) { this.peloton.dispose(); this.peloton = null; }
      if (this.convoy) this.convoy.group.visible = false;
      if (newOne) { this.state = 'preview'; this.newLandscape(); return; }
      this.state = 'preview';
      this.show('screen-preview');
    },

    toMenu() {
      this.state = 'menu';
      this.sound.silence();
      this.hide('screen-preview'); this.hide('hud'); this.hide('screen-pause'); this.hide('screen-finish');
      this.show('screen-menu');
      this.disposeWorld();
    },

    placeCyclistAtStart() {
      const p = this.route.sample(this.route.sStart - 4, {});
      this.cyclist.root.position.set(p.x, p.y, p.z);
      this.cyclist.root.rotation.set(-Math.atan(p.grade), Math.atan2(p.tx, p.tz), 0, 'YXZ');
      this.cyclist.update(0, { speed: 0, pedaling: false, standing: false, tuck: false, steer: 0 });
    },

    // ------------------------------------------------------------------ aperçu
    updatePreviewCamera(dt) {
      const pv = this.preview, route = this.route;
      if (pv.auto) {
        pv.s += 38 * dt;
        if (pv.s > route.sEnd) pv.s = route.sStart;
        pv.angle += 0.06 * dt;
      }
      const p = route.sample(pv.s, {});
      const tgt = this._pvTarget || (this._pvTarget = new THREE.Vector3(p.x, p.y, p.z));
      if (dt === 0) tgt.set(p.x, p.y + 2, p.z);
      else tgt.lerp(new THREE.Vector3(p.x, p.y + 2, p.z), 1 - Math.exp(-dt * 4));
      const r = pv.radius;
      const cam = this.camera;
      cam.position.set(
        tgt.x + Math.sin(pv.angle) * Math.cos(pv.pitch) * r,
        tgt.y + Math.sin(pv.pitch) * r,
        tgt.z + Math.cos(pv.angle) * Math.cos(pv.pitch) * r
      );
      if (this.L) {
        const g = this.L.heightAt(cam.position.x, cam.position.z) + 6;
        if (cam.position.y < g) cam.position.y = g;
      }
      cam.lookAt(tgt);
      $('preview-pos').value = Math.round(((pv.s - route.sStart) / route.length) * 1000);
      $('preview-km').textContent = (Math.max(0, pv.s - route.sStart) / 1000).toFixed(1).replace('.', ',') + ' km';
      this.focusX = tgt.x; this.focusZ = tgt.z;
      this.shadowFollow(tgt, 70);
      B3D.toon.shared.uRider.value.copy(tgt);
    },

    shadowFollow(target, size) {
      if (!this.sunDir) return;
      const s = this.sun;
      s.position.copy(target).addScaledVector(this.sunDir, 150);
      s.target.position.copy(target);
      const c = s.shadow.camera;
      if (c.right !== size) {
        c.left = -size; c.right = size; c.top = size; c.bottom = -size;
        c.near = 10; c.far = 400;
        c.updateProjectionMatrix();
      }
    },

    // ------------------------------------------------------------------ course
    startRide() {
      if (this.building || !this.L) return;
      // la course part à l'heure affichée dans l'aperçu ; « Rejouer » repart de cette même heure
      if (this.atmo) {
        if (this.state === 'preview' || !this.atmoStart) this.atmoStart = { hour: this.atmo.hour };
        else this.atmo.setHour(this.atmoStart.hour);
      }
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      this.hide('screen-preview');
      this.show('hud');
      this.sound.start();
      this.sound.silence();
      const route = this.route;
      this.ride = {
        s: route.sStart - 4, lat: 0, latV: 0, v: 0, effort: 0, target: 250, braking: false,
        reserve: PHYS.wp, bonk: false, draft: 0, msg: null,
        time: 0, maxV: 0, flamme: false, crowd: 0, standing: false, tuck: false,
        villagesSeen: new Set(), lastStrokes: 0, mooT: 1.5, bellT: 0, cowCheck: 0, cow: null, finishT: 0
      };
      this._rs = route.sample(this.ride.s, {});
      // les autres coureurs (recréés à chaque départ : le nombre a pu changer)
      if (this.peloton) { this.peloton.dispose(); this.peloton = null; }
      this.playerProxy = { isPlayer: true, s: this.ride.s, lat: 0, v: 0, done: false, state: 'player', name: 'Toi' };
      if (this.settings.riders > 0) {
        this.peloton = new B3D.Peloton(this.scene, route, this.L, {
          count: this.settings.riders, phys: PHYS, teams: B3D.race.TEAMS,
          playerColor: B3D.Cyclist.JERSEYS[this.settings.jersey].base
        });
        this.peloton.reset(this.playerProxy);
        this.peloton.render(0, this.camera);
      }
      if (this.convoy) this.convoy.reset(this.peloton, this.playerProxy);
      this.raceT = new B3D.race.Tracker(route, this.L, PHYS, this.peloton);
      if (this.vr && this.vr.presenting) this.vr.clearPanel();
      this._toastQ = [];
      this.timeScaleIndex = 0;
      this.hud.setup(route, this.L, PHYS);
      this.camState = null;
      this.placeCyclistAtStart();
      this.state = 'countdown';
      this.countdown = 3.2;
      this.show('screen-countdown');
      $('countdown-text').classList.remove('go');
      $('countdown-text').textContent = '3';
      for (const k in this.input) this.input[k] = false;
    },

    togglePause(on) {
      if (on && (this.state === 'ride' || this.state === 'countdown')) {
        this.pausedFrom = this.state;
        this.state = 'paused';
        this.show('screen-pause');
        this.sound.silence();
        if (this.vr.presenting) this.vr.showPause(true);
      } else if (!on && this.state === 'paused') {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        this.state = this.pausedFrom;
        this.hide('screen-pause');
        this.clock.getDelta();
        if (this.vr.presenting) this.vr.showPause(false);
      }
    },

    cycleCamera() {
      this.camIndex = (this.camIndex + 1) % CAMS.length;
      this.camState = null;
    },
    cameraName() { return CAMS[this.camIndex].name; },

    // densité de spectateurs autour de l'échantillon i de la route (0..1), pour le son de la foule
    crowdDensity(i) {
      const c = this.L.crowd;
      if (!c) return 0;
      let sum = 0;
      for (let k = Math.max(0, i - 24); k <= Math.min(c.length - 1, i + 24); k++) sum += c[k] * (1 - Math.abs(k - i) / 25);
      return Math.min(1, sum / 14);
    },

    // spectateurs juste à côté : on ne peut pas rouler sur le bas-côté
    crowdNear(i) {
      const c = this.L.crowd;
      if (!c) return false;
      for (let k = Math.max(0, i - 3); k <= Math.min(c.length - 1, i + 3); k++) if (c[k]) return true;
      return false;
    },

    // Bulle de bande dessinée (sprite) au-dessus d'une vache qui meugle.
    makeBubble(text) {
      const tex = B3D.toon.textTexture((ctx, W, H) => {
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#1d1a2b'; ctx.lineWidth = 8;
        const r = 40, x0 = 10, y0 = 10, w = W - 20, h = H - 50;
        ctx.beginPath();
        ctx.moveTo(x0 + r, y0); ctx.lineTo(x0 + w - r, y0); ctx.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
        ctx.lineTo(x0 + w, y0 + h - r); ctx.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
        ctx.lineTo(W * 0.42, y0 + h); ctx.lineTo(W * 0.3, H - 6); ctx.lineTo(W * 0.3, y0 + h);
        ctx.lineTo(x0 + r, y0 + h); ctx.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
        ctx.lineTo(x0, y0 + r); ctx.quadraticCurveTo(x0, y0, x0 + r, y0);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#1d1a2b'; ctx.font = '700 64px Fredoka, Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, W / 2, y0 + h / 2 + 4);
      }, 320, 170);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      sp.scale.set(3.4, 1.8, 1);
      sp.visible = false;
      sp.renderOrder = 5;
      return sp;
    },

    // Vaches proches : meuglements (spatialisés), clarines et bulle "MEUH !".
    updateCows(dtReal) {
      const R = this.ride;
      const P = this.cyclist.root.position;
      R.mooT -= dtReal; R.bellT -= dtReal; R.cowCheck -= dtReal;
      if (R.cowCheck <= 0) { R.cowCheck = 0.3; R.cow = this.tiles.nearestCow(P.x, P.z, 100); }
      const cow = R.cow;
      if (!cow) return;
      const cam = this.camera;
      const dx = cow.x - cam.position.x, dz = cow.z - cam.position.z;
      const l = Math.hypot(dx, dz) || 1;
      const e = cam.matrixWorld.elements;
      const pan = (dx / l) * e[0] + (dz / l) * e[2];
      if (R.mooT <= 0) {
        const k = 1 - cow.d / 100;
        this.sound.moo(0.06 + 0.32 * k * k, pan * 0.8);
        R.mooT = 3 + Math.random() * 6;
        const b = this.mooBubble;
        b.position.set(cow.x, cow.y + 3.2, cow.z);
        b.visible = true;
        this.bubbleT = 1.9;
      }
      if (cow.d < 60 && R.bellT <= 0) {
        this.sound.bell(0.02 + 0.07 * (1 - cow.d / 60), pan * 0.8);
        R.bellT = 0.6 + Math.random() * 1.8;
      }
    },

    // panoramique stéréo d'un point vu de la caméra (-1 gauche, 1 droite)
    panOf(x, z) {
      const cam = this.camera;
      const cp = cam.getWorldPosition(this._pw || (this._pw = new THREE.Vector3())); // dans le casque, la caméra est dans la nacelle
      const dx = x - cp.x, dz = z - cp.z;
      const l = Math.hypot(dx, dz) || 1;
      const e = cam.matrixWorld.elements;
      return ((dx / l) * e[0] + (dz / l) * e[2]) * 0.8;
    },

    // Cris des animaux proches, chants d'oiseaux selon le milieu, grenouilles près des mares, cigales dans le Sud.
    updateWildlife(dtReal) {
      const S = this.sound;
      if (!S.ctx || S.muted) return;
      const W = this._wild || (this._wild = { t: {}, scanT: 0, mix: null, near: {} });
      const P = this.cyclist.root.position, L = this.L, R = Math.random;
      W.scanT -= dtReal;
      if (W.scanT <= 0) {
        W.scanT = 0.5;
        W.mix = this.tiles.coverMix(P.x, P.z);
        for (const [type, r] of [['horse', 90], ['sheep', 90], ['marmot', 110], ['ibex', 60], ['boar', 80], ['fox', 140], ['deer', 140]]) W.near[type] = this.tiles.nearestAnimal(type, P.x, P.z, r);
        let pd = 1e9;
        for (const lk of L.lakes) if (lk.kind === 'pond') pd = Math.min(pd, Math.hypot(lk.x - P.x, lk.z - P.z) - lk.r);
        W.pondD = pd;
      }
      const mix = W.mix;
      // minuteur : quand il expire, joue le son et repart pour base + aléa secondes
      const due = (key, base, rand) => {
        if (W.t[key] === undefined) W.t[key] = base * 0.3 + R() * rand;
        W.t[key] -= dtReal;
        if (W.t[key] > 0) return false;
        W.t[key] = base + R() * rand;
        return true;
      };
      const fall = (d, maxD) => { const k = Math.max(0, 1 - d / maxD); return k * k; };
      const near = W.near;
      if (near.horse && due('horse', 7, 14)) S.animal('horse', 0.03 + 0.2 * fall(near.horse.d, 90), this.panOf(near.horse.x, near.horse.z));
      if (near.sheep && due('sheep', 2.5, 6)) S.animal('sheep', 0.03 + 0.17 * fall(near.sheep.d, 90), this.panOf(near.sheep.x, near.sheep.z));
      if (near.marmot && near.marmot.d < 70 && due('marmot', 4, 9)) S.animal('marmot', 0.03 + 0.12 * fall(near.marmot.d, 110), this.panOf(near.marmot.x, near.marmot.z));
      // la nuit : grognements des sangliers, glapissements du renard, brame lointain du chevreuil (aboiement)
      if (near.boar && due('boar', 3, 7)) S.animal('boar', 0.04 + 0.16 * fall(near.boar.d, 80), this.panOf(near.boar.x, near.boar.z));
      if (near.fox && due('fox', 6, 12)) S.animal('fox', 0.03 + 0.12 * fall(near.fox.d, 140), this.panOf(near.fox.x, near.fox.z));
      if (near.deer && due('deer', 9, 15)) S.animal('deer', 0.03 + 0.1 * fall(near.deer.d, 140), this.panOf(near.deer.x, near.deer.z));
      // oiseaux animés (distances calculées par la faune)
      const A = this.fauna ? this.fauna.audio : null;
      if (A) {
        if (A.eagle < 260 && due('eagle', 9, 14)) S.animal('eagle', 0.03 + 0.1 * fall(A.eagle, 260), (R() - 0.5) * 1.2);
        if (A.crow < 220 && due('crow', 4, 8)) S.animal('crow', 0.02 + 0.09 * fall(A.crow, 220), (R() - 0.5) * 1.2);
        if (A.goose < 380 && due('goose', 1.5, 3)) S.animal('goose', 0.02 + 0.08 * fall(A.goose, 380), (R() - 0.5) * 0.8);
        if (A.gull < 260 && due('gull', 3, 7)) S.animal('gull', 0.02 + 0.08 * fall(A.gull, 260), (R() - 0.5) * 1.2);
        if (A.duck < 120 && due('duck', 2.5, 6)) S.animal('duck', 0.03 + 0.14 * fall(A.duck, 120), (R() - 0.5) * 1.2);
        if (A.swallow < 30 && due('swallow', 2, 5)) S.animal('swallow', 0.03, (R() - 0.5) * 1.4);
        if (A.takeoff > 0) S.animal('flutter', 0.12 + 0.04 * Math.min(4, A.takeoff), (R() - 0.5));
        if (A.owl < 160 && due('owlF', 8, 12)) S.animal('owl', 0.04 + 0.08 * fall(A.owl, 160), (R() - 0.5) * 1.2);
      }
      if (mix) {
        // le jour : oiseaux (qui se taisent sous la pluie) ; la nuit : grillons et chouettes
        const at = this.atmo, day = at ? at.dayK : 1, night = at ? at.nightK : 0, rain = at ? at.cur.rain : 0;
        // passereaux dans les prés et les haies, merles en forêt, plus discrets en altitude
        const song = (mix.meadow * 0.8 + mix.forest + mix.garrigue * 0.5 + mix.wet * 0.5) * day * (1 - 0.85 * rain);
        if (song > 0.15 && due('song', 1.4 / song, 4 / song)) S.animal(mix.forest > mix.meadow && R() < 0.6 ? 'blackbird' : 'songbird', 0.012 + 0.025 * R(), (R() - 0.5) * 1.6);
        const crick = (mix.meadow + mix.garrigue + mix.wet * 0.5) * night * (1 - 0.8 * rain) * (1 - (at ? at.snowCover : 0)); // pas de grillons dans la neige
        if (crick > 0.15 && due('cricket', 0.5 / crick, 1.4 / crick)) S.animal('cricket', 0.015 + 0.02 * R(), (R() - 0.5) * 1.6);
        if (mix.forest > 0.2 && night > 0.5 && rain < 0.3 && due('owl', 9, 16)) S.animal('owl', 0.05 + 0.04 * R(), (R() - 0.5) * 1.6);
        // grenouilles près des mares et des zones humides (surtout le soir et la nuit)
        const frogs = Math.max(W.pondD < 90 ? 1 - W.pondD / 90 : 0, mix.wet * 2) * (L.amb.id === 'soir' ? 1.4 : L.amb.id === 'hiver' ? 0 : 1) * (1 + 0.8 * night);
        if (frogs > 0.1 && due('frog', 0.8 / frogs, 2.5 / frogs)) S.animal('frog', 0.02 + 0.06 * Math.min(1, frogs), (R() - 0.5) * 1.6);
        // cigales : garrigue et campagne du Sud, l'été, au soleil
        const warm = (L.amb.id === 'ete' || L.amb.id === 'soir' ? 1 : L.amb.id === 'printemps' ? 0.3 : 0) * clamp((1000 - P.y) / 300, 0, 1);
        const sunny = at ? smoothstep(0.2, 0.6, day) * (1 - at.cur.cloud * 0.7) * (1 - rain) : 1;
        S.setCicadas(Math.min(1, (mix.garrigue * 2.5 + (L.bio.south ? mix.meadow * 0.6 + mix.forest * 0.4 : 0)) * warm * sunny));
      }
    },

    villageWelcome(name) {
      if (name.startsWith('Le ')) return 'au ' + name.slice(3);
      if (name.startsWith('Les ')) return 'aux ' + name.slice(4);
      return 'à ' + name;
    },

    currentClimb(d) {
      const route = this.route;
      for (let i = 0; i < route.climbs.length; i++) {
        const c = route.climbs[i];
        if (d >= c.d0 - 300 && d <= c.d1) {
          const left = Math.max(0, c.d1 - d);
          const tmp = {};
          const yNow = route.sample(route.sStart + d, tmp).y;
          const avg = left > 50 ? (c.summitEle - yNow) / left : 0;
          return {
            index: i, name: this.L.climbNames[i],
            toGo: left > 50 ? 'Sommet dans ' + (left / 1000).toFixed(1).replace('.', ',') + ' km · moy. ' + (avg * 100).toFixed(1).replace('.', ',') + ' %' : 'Sommet !'
          };
        }
      }
      return null;
    },

    // Un pas de physique du joueur (h en secondes de course) : puissance de la jauge, réserve, aspiration,
    // pente, roulement, air ; puis le peloton avance du même pas et règle les contacts.
    stepPlayer(h) {
      const R = this.ride, route = this.route, L = this.L, inp = this.input;
      const half = L.roadHalf;
      const p = route.sample(R.s, this._rs || (this._rs = {}));
      const grade = p.grade, v = R.v;
      const offRoad = Math.abs(R.lat) > half - 0.2;
      const wet = this.atmo ? this.atmo.wet : 0, snow = this.atmo ? this.atmo.snowCover : 0;
      // chaussée mouillée ou enneigée : ça roule moins bien, surtout sur le bas-côté plein de neige
      const crr = PHYS.crr * (offRoad ? 3.5 + 3 * snow : 1) * (1 + 0.12 * wet + 0.15 * snow);
      const cda = R.tuck ? PHYS.cdaTuck : R.standing ? PHYS.cdaStand : PHYS.cda;
      // vent : composante dans le sens de la course (de dos > 0) et de côté (vers la droite > 0)
      const W = this.atmo ? this.atmo.wind : null;
      const head = W ? W.x * p.tx + W.z * p.tz : 0, cross = W ? W.x * p.rx + W.z * p.rz : 0;
      const va = v - head; // vitesse de l'air face au coureur
      R.windHead = head; R.windCross = cross; R.air = Math.hypot(va, cross);
      if (this.playerProxy) this.playerProxy.drift = clamp(cross / Math.max(va, 3), -0.4, 0.4);
      // aspiration derrière les autres coureurs (le sillage dérive sous le vent)
      let draft = 0;
      if (this.peloton) {
        const sh = this.peloton.shelterFor(this.playerProxy, clamp(cross / Math.max(va, 3), -0.4, 0.4));
        draft = sh.f;
        this.peloton.playerDraft = draft;
        this.peloton.playerDraftSrc = sh.src;
      }
      R.draft = draft;
      // réserve d'énergie : elle se vide au-dessus de la puissance critique, se recharge en dessous
      if (R.reserve <= 0 && !R.bonk) { R.bonk = true; R.msg = 'bonk'; }
      if (R.bonk && R.reserve > PHYS.wp * 0.3) { R.bonk = false; R.msg = 'recover'; }
      const cap = R.bonk ? PHYS.cp * 0.9 : PHYS.pMax;
      R.braking = inp.brake && v > 0.05;
      const want = R.braking ? 0 : Math.min(R.target, cap);
      R.effort += clamp(want - R.effort, -3000 * h, 1500 * h);
      R.reserve = clamp(R.reserve + (PHYS.cp - R.effort) * h * (R.effort < PHYS.cp ? 0.6 : 1), 0, PHYS.wp);
      const drive = R.effort / Math.max(v, 1.6);
      const sinA = grade / Math.sqrt(1 + grade * grade);
      const fg = PHYS.mass * PHYS.g * sinA;
      const fr = v > 0.05 ? crr * PHYS.mass * PHYS.g : 0;
      const fa = 0.5 * PHYS.rho * cda * (1 - draft) * va * Math.abs(va);
      const fb = R.braking ? PHYS.brake * (1 - Math.max(0.3 * wet, 0.4 * snow)) : 0; // freins moins efficaces sous la pluie et sur la neige
      let a = (drive - fg - fr - fa - fb) / PHYS.mass;
      if (v <= 0.01 && a < 0) a = 0; // pas de recul
      R.v = clamp(v + a * h, 0, PHYS.vMax);
      if (R.v > R.maxV) R.maxV = R.v;
      // déplacement latéral : bas-côté praticable, sauf glissière, parapet, foule, barrières, soigneurs… ou un coureur à côté
      let nl = R.lat + R.latV * h;
      if (this.peloton) nl = this.peloton.lateralBlock(this.playerProxy, nl);
      R.lat = nl;
      const ii = p.i;
      const crowded = this.crowdNear(ii) || L.villageW[ii] > 0.3;
      const maxR = (L.railR[ii] || L.bridgeMask[ii] || crowded || L.fenceR[ii]) ? half - 0.35 : half + 1.5;
      const maxL = (L.railL[ii] || L.bridgeMask[ii] || crowded || L.fenceL[ii]) ? half - 0.35 : half + 1.5;
      if (R.lat > maxR) { R.lat = Math.max(maxR, R.lat - 4 * h); R.latV = Math.min(0, R.latV); }
      if (R.lat < -maxL) { R.lat = Math.min(-maxL, R.lat + 4 * h); R.latV = Math.max(0, R.latV); }
      // avancement
      R.s += R.v * h;
      R.time += h;
      R.standing = R.effort > PHYS.cp * 0.95 && grade > 0.06 && R.v < 8.5;
      R.tuck = R.effort < 40 && R.v > 14 && grade < -0.02;
      // le peloton avance du même pas ; un coureur devant peut nous freiner
      if (this.peloton) {
        const X = this.playerProxy;
        X.s = R.s; X.lat = R.lat; X.v = R.v;
        this.peloton.step(h);
        R.s = X.s; R.v = X.v;
      }
    },

    // accélération du temps de course : touche T, ou celle de la course pilotée par PaceYourRide
    simK() { return this.ext ? this.ext.timeK : TIME_SCALES[this.timeScaleIndex]; },

    updateRide(dtReal) {
      const R = this.ride, route = this.route, L = this.L, inp = this.input;
      const dt = dtReal * this.simK();
      const half = L.roadHalf;
      const prevLatV = R.latV;
      if (this.ext) {
        // vue pilotée : positions, vitesses et puissances viennent de la simulation de PaceYourRide
        this.ext.drive(dtReal, dt);
      } else {
        // direction (temps réel)
        const targetLatV = ((inp.right ? 1 : 0) - (inp.left ? 1 : 0)) * (2.2 + Math.min(R.v, 12) * 0.12);
        R.latV = lerp(R.latV, targetLatV, 1 - Math.exp(-dtReal * 6));
        // physique en petits pas (stable même en temps accéléré)
        const n = Math.max(1, Math.ceil(dt / 0.05)), h = dt / n;
        for (let k = 0; k < n; k++) this.stepPlayer(h);
      }

      // --- placement du cycliste
      const q = route.sample(R.s, this._rs);
      const offRoad = Math.abs(R.lat) > half - 0.2;
      const cyc = this.cyclist;
      const steer = Math.atan2(R.latV, Math.max(R.v, 2));
      const heading = Math.atan2(q.tx, q.tz) - steer;
      let y = q.y;
      if (Math.abs(R.lat) > half) y = Math.max(q.y - 0.12, L.heightAt(q.x + q.rx * R.lat, q.z + q.rz * R.lat));
      cyc.root.position.set(q.x + q.rx * R.lat, y, q.z + q.rz * R.lat);
      const lean = clamp(-Math.atan(R.v * R.v * q.curv / PHYS.g) + R.latV * 0.07 + (R.latV - prevLatV) * 0.3, -0.6, 0.6);
      R.lean = lerp(R.lean || 0, lean, 1 - Math.exp(-dtReal * 6));
      // secousses : bas-côté, ou revêtement de la route (pavés, chemins, imposés par PaceYourRide)
      const shake = this._shake = offRoad ? 1 : L.surf ? B3D.road.shakeOf(L.surf[q.i]) : 0;
      const bump = shake ? Math.sin(R.time * 37) * 0.025 * shake * Math.min(1, R.v / 5) : 0;
      cyc.root.rotation.set(-Math.atan(q.grade) + bump, heading, R.lean, 'YXZ');
      cyc.update(dt, {
        speed: R.v, pedaling: R.effort > 25 && R.v > 0.3 && !R.tuck, standing: R.standing, tuck: R.tuck, steer: -steer
      });
      // « woum » des roues carbone à chaque coup de pédale
      if (cyc.strokes !== R.lastStrokes) {
        if (cyc.strokes > R.lastStrokes) this.sound.pedalStroke(R.v, R.effort / PHYS.pMax);
        R.lastStrokes = cyc.strokes;
      }
      B3D.toon.shared.uRider.value.copy(cyc.root.position);

      // vibrations : bas-côté caillouteux
      if (this.vr.presenting && offRoad && R.v > 2) {
        this._gravelT = (this._gravelT || 0) - dtReal;
        if (this._gravelT <= 0) { this._gravelT = 0.12; this.vr.pulse(0.25 + Math.min(0.4, R.v / 30), 40); }
      }
      // --- réserve : coup de bambou et récupération
      if (R.msg === 'bonk' && this.vr.presenting) this.vr.pulse(1, 300);
      if (R.msg === 'bonk') this.toast('💥 Coup de bambou !<small>Réserve vide : tu roules sous ton seuil le temps de récupérer</small>', 3000);
      else if (R.msg === 'recover') this.toast('🔋 Ça repart !<small>Ta réserve se recharge, tu peux relancer</small>', 2200);
      R.msg = null;

      // --- évènements de parcours : sprints, GPM, ravitaillement (en vue pilotée, c'est PaceYourRide qui les annonce)
      const d = R.s - route.sStart;
      if (!this.ext) for (const ev of this.raceT.update(R, dt, dtReal, cyc.root.position)) {
        this.toast(ev.toast, ev.dur);
        if (ev.sound) this.sound.raceCue(ev.sound);
        if (ev.refill) R.reserve = Math.min(PHYS.wp, R.reserve + ev.refill * PHYS.wp);
        // vibrations des manettes : ligne franchie, musette attrapée
        if (ev.sound && this.vr.presenting) this.vr.pulse(ev.sound === 'win' ? 0.8 : 0.45, ev.sound === 'musette' ? 120 : 220);
      }
      if (this.peloton && !this.ext) this.handlePelotonEvents(dtReal);
      if (this.atmo) this.skyEvents();
      if (!R.flamme && route.length > 2500 && d >= route.length - 1000) {
        R.flamme = true;
        this.toast('🚩 Flamme rouge !<small>Plus qu\'un kilomètre</small>', 2400);
      }
      // traversée de village
      L.villages.forEach((v, i) => {
        if (!R.villagesSeen.has(i) && R.s >= v.i0 * route.spacing - 15 && R.s <= v.i1 * route.spacing) {
          R.villagesSeen.add(i);
          this.toast('🏘️ Bienvenue ' + this.villageWelcome(v.name) + '<small>Les habitants sont sortis t\'encourager !</small>', 3000);
        }
      });
      // ambiance sonore : foule (selon la densité de spectateurs), vent (moins fort dans l'aspiration), vaches
      R.crowd = lerp(R.crowd, this.crowdDensity(q.i), 1 - Math.exp(-dtReal * 2));
      this.sound.update(dtReal, R.v, R.effort < 25 && R.v > 1, R.crowd, this.soundEnv());
      this.updateCows(dtReal);
      this.updateWildlife(dtReal);

      if (d >= route.length && !this.ext) this.finish();
    },

    // jauge de puissance au clavier : Z/S maintenues (aussi pendant le compte à rebours)
    updateGaugeKeys(dtReal) {
      const inp = this.input;
      const pdir = (inp.pUp ? 1 : 0) - (inp.pDown ? 1 : 0);
      if (pdir) this.setTarget(this.ride.target + pdir * 320 * dtReal);
    },

    // jauge de puissance : bornée entre 0 et la puissance maximale
    setTarget(w) {
      if (!this.ride) return;
      this.ride.target = clamp(Math.round(w), 0, PHYS.pMax);
    },

    // messages du peloton : attaques, relais, crevaisons, frottements
    handlePelotonEvents(dtReal) {
      const P = this.peloton, R = this.ride;
      this._pelMsgT = Math.max(0, (this._pelMsgT || 0) - dtReal);
      this._bumpT = Math.max(0, (this._bumpT || 0) - dtReal);
      this._turnT = Math.max(0, (this._turnT || 0) - dtReal);
      this._relayT = Math.max(0, (this._relayT || 0) - dtReal);
      for (const ev of P.events) {
        const r = ev.rider, near = Math.abs(r.s - R.s) < 140;
        if (ev.type === 'attack' && near) this.toast('⚡ Attaque de ' + r.name + ' !<small>' + r.team.name + ' · à toi de voir si tu prends sa roue</small>', 2600);
        else if (ev.type === 'relay' && this._relayT <= 0 && (this._relayT = 45)) this.toast('🔄 ' + r.name + ' prend le relais<small>Glisse-toi dans sa roue pour profiter de l’aspiration</small>', 2600);
        else if (ev.type === 'yourTurn' && this._turnT <= 0) { this._turnT = 40; this.toast('🔄 À toi de prendre le relais !<small>…ou décale-toi pour rester dans les roues</small>', 2600); }
        else if (ev.type === 'flat') { if (near) this.toast('🔧 Crevaison pour ' + r.name + '<small>La voiture suiveuse s’arrête pour le dépanner</small>', 2600); if (this.convoy) this.convoy.onFlat(r); }
        else if (ev.type === 'fixed') { if (this.convoy) this.convoy.onFixed(r); }
        else if (ev.type === 'bump') {
          if (this.vr.presenting) this.vr.pulse(0.7, 90);
          if (this._bumpT <= 0) { this._bumpT = 6; this.toast('😬 Attention à la roue de ' + r.name + ' !', 1400); }
        }
      }
      P.events.length = 0;
    },

    // feux de nuit (et par temps d'orage très sombre) ; vent et chaussée mouillée pour le peloton
    applyNightLights() {
      const A = this.atmo;
      const on = A.lampK;
      if (this.cyclist) this.cyclist.setLights(on);
      if (this.peloton) {
        this.peloton.lightsOn = on > 0.3;
        this.peloton.wind = A.wind;
        this.peloton.crrK = 1 + 0.12 * A.wet + 0.15 * A.snowCover;
        this.peloton.brakeK = 1 - Math.max(0.3 * A.wet, 0.4 * A.snowCover);
      }
      if (this.convoy) this.convoy.setLights(on > 0.3);
      // animaux du jour et de la nuit
      if (this.tiles) this.tiles.setActivity(A.dayK);
      if (this.fauna) this.fauna.setDaylight(A.dayK);
    },

    // messages : changement de temps, lever et coucher du soleil
    skyEvents() {
      const A = this.atmo, R = this.ride;
      if (A.changed) {
        const MSG = {
          'soleil>nuageux': ['⛅ Les nuages arrivent', 'Le ciel se couvre'],
          'nuageux>soleil': ['☀️ Retour du soleil', 'Le ciel se dégage'],
          'nuageux>pluie': ['🌧️ La pluie arrive', 'Route glissante : on freine moins bien'],
          'pluie>orage': ['⛈️ Orage !', 'Éclairs, tonnerre et rafales de vent'],
          'orage>pluie': ['🌧️ L\u2019orage s\u2019éloigne', 'Il pleut encore'],
          'pluie>nuageux': ['⛅ La pluie cesse', 'La route va sécher peu à peu'],
          'nuageux>neige': ['🌨️ Il neige !', 'Le paysage blanchit, la route devient glissante'],
          'neige>nuageux': ['⛅ La neige cesse', 'Le manteau blanc va fondre peu à peu'],
          'pluie>neige': ['🌨️ La pluie se change en neige', 'Il fait de plus en plus froid'],
          'orage>neige': ['🌨️ L\u2019orage tourne à la neige', 'Bourrasques de flocons']
        }[A.changed.from + '>' + A.changed.to];
        if (MSG) this.toast(MSG[0] + '<small>' + MSG[1] + '</small>', 2800);
        A.changed = null;
      }
      // en montant dans le col, la pluie se transforme en neige (et l'inverse en redescendant)
      const flakes = A.cur.rain > 0.3 && A.snowFrac > 0.5;
      if (R.flakes !== undefined && flakes !== R.flakes && A.cur.rain > 0.3) {
        this.toast(flakes ? '🌨️ La pluie se change en neige<small>On a passé la limite pluie-neige</small>' : '🌧️ La neige redevient pluie<small>On redescend sous la limite pluie-neige</small>', 2600);
      }
      R.flakes = flakes;
      const per = A.period();
      if (R.period && per !== R.period) {
        if (per === 'lever du soleil') this.toast('🌅 Le soleil se lève<small>Les phares s\u2019éteignent bientôt</small>', 2600);
        else if (per === 'coucher du soleil') this.toast('🌇 Coucher de soleil<small>Les phares vont s\u2019allumer</small>', 2600);
        else if (per === 'nuit') this.toast('🌙 La nuit tombe<small>Phares allumés, étoiles et lune</small>', 2600);
      }
      R.period = per;
    },

    // tonnerre : le son arrive après l'éclair, d'autant plus tard et plus sourd que l'orage est loin
    thunder(t) {
      if (!this.sound.ctx || this.state === 'menu') return;
      const vol = 0.12 + 0.5 * (1 - Math.min(1, t.dist / 1500));
      const pan = this.panOf(t.x, t.z);
      setTimeout(() => { if (this.state !== 'menu' && this.state !== 'paused') this.sound.thunder(vol, pan, t.dist); }, t.delay * 1000);
      if (this.vr.presenting && t.dist < 600) this.vr.pulse(0.3, 160);
    },

    // sons d'ambiance liés à la course : aspiration, vélos autour, moto, hélicoptère, vent, pluie
    soundEnv() {
      const env = { draft: this.ride.draft || 0, bikes: 0, moto: 1e9, heli: 1e9, air: this.ride.air, rain: this.atmo ? this.atmo.rainEff : 0 };
      const P = this.cyclist.root.position;
      if (this.peloton) for (const r of this.peloton.riders) if (r.pos && !r.done && r.pos.distanceTo(P) < 12) env.bikes++;
      if (this.convoy) { env.moto = this.convoy.nearest('moto', P); env.heli = this.convoy.nearest('heli', P); }
      return env;
    },

    updateRideCamera(dtReal) {
      const cyc = this.cyclist.root;
      const P = cyc.position;
      const mode = CAMS[this.camIndex];
      const R = this.ride, route = this.route, half = this.L.roadHalf;
      const q = this._rs;
      if (!this.camState) this.camState = { pos: null, tvS: null, tvSide: 1 };
      const cs = this.camState;
      const cam = this.camera;
      const tmp = this._camTmp || (this._camTmp = {});
      this.cyclist.head.visible = !mode.fpv;
      let desired, look;
      if (mode.fpv) {
        const fx = q.tx, fz = q.tz;
        desired = this.cyclist.head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(fx * 0.25, 0.08, fz * 0.25));
        const a = route.sample(R.s + 12, tmp);
        look = new THREE.Vector3(a.x + a.rx * R.lat, a.y + 0.6, a.z + a.rz * R.lat);
      } else if (mode.tv) {
        // caméra TV posée au bord de la route : le cycliste passe devant, puis elle se replace plus loin
        if (cs.tvS === null || R.s > cs.tvS + 12 || R.s < cs.tvS - 60) {
          cs.tvS = R.s + 28 + Math.min(R.v, 15) * 1.5;
          cs.tvSide = -cs.tvSide;
          cs.pos = null;
        }
        const a = route.sample(cs.tvS, tmp);
        const off = (half - 0.4) * cs.tvSide;
        desired = new THREE.Vector3(a.x + a.rx * off, a.y + 2.1, a.z + a.rz * off);
        look = new THREE.Vector3(P.x, P.y + 1.0, P.z);
      } else {
        // caméra de poursuite : se place sur la route derrière le cycliste (ne coupe pas les virages) ;
        // au milieu du peloton, elle monte et recule pour voir par-dessus les coureurs de derrière
        let pack = 0;
        if (this.peloton && mode.dist < 8) {
          for (const r of this.peloton.riders) {
            const ds = R.s - r.s;
            if (ds > 0.3 && ds < mode.dist + 2 && Math.abs(r.lat - R.lat) < 2.2 && !r.done) pack++;
          }
        }
        cs.pack = lerp(cs.pack || 0, Math.min(1, pack / 2), 1 - Math.exp(-dtReal * 1.5));
        const dist = mode.dist + 2.2 * cs.pack, hgt = mode.height + 1.9 * cs.pack;
        const b = route.sample(R.s - dist, tmp);
        desired = new THREE.Vector3(b.x + b.rx * R.lat * 0.6, Math.max(b.y, P.y - dist * 0.15) + hgt, b.z + b.rz * R.lat * 0.6);
        const a = route.sample(R.s + mode.ahead, tmp);
        look = new THREE.Vector3(a.x + a.rx * R.lat * 0.5, Math.max(a.y, P.y - 1) + mode.look - 0.3 * cs.pack, a.z + a.rz * R.lat * 0.5);
      }
      if (!cs.pos || mode.fpv || mode.tv) cs.pos = desired.clone();
      else cs.pos.lerp(desired, 1 - Math.exp(-dtReal * 5));
      if (!cs.look || mode.fpv) cs.look = look.clone();
      else cs.look.lerp(look, 1 - Math.exp(-dtReal * 8));
      // ne pas passer sous le relief
      const gh = this.L.heightAt(cs.pos.x, cs.pos.z) + (mode.fpv ? 0.3 : 1.0);
      if (cs.pos.y < gh) cs.pos.y = gh;
      cam.position.copy(cs.pos);
      if (!mode.fpv && !mode.tv && R.v > 15) {
        const k = (R.v - 15) * 0.0015;
        cam.position.x += (Math.random() - 0.5) * k; cam.position.y += (Math.random() - 0.5) * k;
      }
      // sur les pavés, la vue tremble (surtout la vue cycliste)
      if (!mode.tv && this._shake > 0.3 && R.v > 2) cam.position.y += (Math.random() - 0.5) * this._shake * (mode.fpv ? 0.05 : 0.02) * Math.min(1, R.v / 8);
      cam.lookAt(mode.tv ? look : cs.look);
      const targetFov = mode.tv ? 40 : 60 + clamp((R.v - 12) * 0.6, 0, 12);
      if (Math.abs(cam.fov - targetFov) > 0.05) {
        cam.fov = lerp(cam.fov, targetFov, mode.tv ? 1 : 1 - Math.exp(-dtReal * 2));
        cam.updateProjectionMatrix();
      }
      this.focusX = P.x + q.tx * 120; this.focusZ = P.z + q.tz * 120;
      this.shadowFollow(P, 26);
    },

    finish() {
      const R = this.ride, route = this.route;
      this.state = 'finished';
      if (this.playerProxy) this.playerProxy.done = true;
      R.braking = false;
      // confettis tirés depuis les deux piliers de l'arche d'arrivée
      const fp = route.sample(route.sEnd, {});
      const span = this.L.roadHalf + 1.4;
      for (const side of [-1, 1]) this.confetti.burst(fp.x + fp.rx * span * side, fp.y + 5.8, fp.z + fp.rz * span * side, 220);
      setTimeout(() => { if (this.state === 'finished') this.confetti.burst(fp.x, fp.y + 6.5, fp.z, 150); }, 700);
      const avg = route.length / Math.max(1, R.time);
      const key = 'bike3d-best-' + hashString(route.name + '|' + Math.round(route.length) + '|' + route.n);
      let best = null;
      try { best = parseFloat(localStorage.getItem(key)); } catch (e) { /* ignoré */ }
      const record = !(best > 0) || R.time < best;
      if (record) { try { localStorage.setItem(key, String(R.time)); } catch (e) { /* ignoré */ } }
      $('finish-stats').innerHTML = [
        ['Temps', formatTime(R.time)],
        ['Moyenne', (avg * 3.6).toFixed(1).replace('.', ',') + ' km/h'],
        ['Vitesse max', (R.maxV * 3.6).toFixed(1).replace('.', ',') + ' km/h'],
        ['Dénivelé +', Math.round(route.stats.gain) + ' m']
      ].concat(this.raceStats()).map((s) => '<div>' + s[0] + '<b>' + s[1] + '</b></div>').join('');
      const fb = $('finish-best');
      fb.className = 'finish-best' + (record ? ' record' : '');
      fb.textContent = record ? (best > 0 ? '🎉 Nouveau record ! (ancien : ' + formatTime(best) + ')' : '🎉 Premier temps enregistré !') : 'Record à battre : ' + formatTime(best);
      // classement de l'étape face aux autres coureurs
      const rk = $('finish-ranking');
      if (this.peloton) {
        const rows = this.peloton.standings(R.time);
        const me = rows.findIndex((r) => r.player);
        const first = rows[0].t;
        const line = (r, i) => '<li class="' + (r.player ? 'me' : '') + '"><span class="pos">' + (i + 1) + '</span><span class="sw" style="background:' + (r.player ? B3D.Cyclist.JERSEYS[this.settings.jersey].base : r.color) + '"></span>' + r.name +
          '<b>' + (i === 0 ? formatTime(r.t) : r.t === null ? '…' : r.t - first < 1 ? 'm.t.' : '+' + formatTime(r.t - first)) + '</b></li>';
        let html = rows.slice(0, 5).map(line).join('');
        if (me >= 5) html += '<li class="dots">⋯</li>' + line(rows[me], me);
        rk.innerHTML = '<h3>' + (me === 0 ? '🏆 Victoire d’étape !' : 'Classement : ' + (me + 1) + (me === 0 ? 'er' : 'e') + ' sur ' + rows.length) + '</h3><ol>' + html + '</ol>';
        rk.classList.remove('hidden');
      } else rk.classList.add('hidden');
      // dans le casque : carte d'arrivée flottante (Ⓐ rejouer, Ⓑ quitter la VR)
      if (this.vr.presenting) {
        let rows = [{ pos: 1, name: 'Toi', time: formatTime(R.time), me: true }], title = '🏆 Arrivée !';
        if (this.peloton) {
          const all = this.peloton.standings(R.time), me = all.findIndex((r) => r.player), first = all[0].t;
          rows = all.map((r, i) => ({ pos: i + 1, name: r.name, me: !!r.player, time: i === 0 ? formatTime(r.t) : r.t === null ? '…' : r.t - first < 1 ? 'm.t.' : '+' + formatTime(r.t - first) }));
          rows = rows.slice(0, me >= 5 ? 4 : 5).concat(me >= 5 ? [rows[me]] : []);
          title = me === 0 ? '🏆 Victoire d’étape !' : '🏁 ' + (me + 1) + 'e sur ' + all.length;
        }
        const stats = formatTime(R.time) + ' · ' + (avg * 3.6).toFixed(1).replace('.', ',') + ' km/h de moyenne' + (record ? ' · record !' : '');
        setTimeout(() => { if (this.state === 'finished' && this.vr.presenting) this.vr.showFinish(title, rows, stats); }, 900);
      }
      setTimeout(() => { if (this.state === 'finished') this.show('screen-finish'); }, 900);
    },

    // classements annexes de l'écran d'arrivée
    raceStats() {
      const T = this.raceT, r = this.L.race;
      if (!T || !r) return [];
      const out = [];
      if (r.sprints.length) out.push(['🟢 Points sprint', B3D.race.ptsLabel(T.points.sprint)]);
      if (r.koms.length) out.push(['🔴 Points montagne', B3D.race.ptsLabel(T.points.kom)]);
      if (r.feeds.length) out.push(['🥤 Musettes', String(T.musettes)]);
      return out;
    },

    // ------------------------------------------------------------------ boucle
    loop() {
      const raw = this.clock.getDelta();
      const dt = Math.min(0.05, raw);
      B3D.toon.shared.uTime.value += dt;
      if (this.state === 'menu' || this.building) return;
      const vr = this.vr && this.vr.presenting;
      if (vr) this.vr.update(dt);
      if (this.state === 'preview') {
        this.updatePreviewCamera(dt);
        this.tiles.update(this.focusX, this.focusZ, 8);
      } else if (this.state === 'countdown') {
        this.updateGaugeKeys(dt);
        this.countdown -= dt;
        const n = Math.ceil(this.countdown - 0.2);
        const el = $('countdown-text');
        if (this.countdown > 0.2) { if (el.textContent !== String(n)) el.textContent = String(n); }
        else if (!el.classList.contains('go')) { el.textContent = 'GO !'; el.classList.add('go'); }
        if (vr) this.vr.countdown(el.textContent);
        if (this.countdown <= -0.5) { this.hide('screen-countdown'); this.state = 'ride'; }
        if (this.countdown <= 0.2 && this.state === 'countdown') {
          // départ lancé : la course commence pendant l'affichage de "GO !"
          this.updateRide(dt);
        }
        if (vr) this.vr.updateRig(dt); else this.updateRideCamera(dt);
        this.tiles.update(this.focusX, this.focusZ, vr ? 3 : 6);
        if (!this.vr.session) this.updateHud(); // le HUD de l'écran n'est pas visible dans le casque
      } else if (this.state === 'ride') {
        this.updateGaugeKeys(dt);
        this.updateRide(dt);
        if (vr) this.vr.updateRig(dt); else this.updateRideCamera(dt);
        this.tiles.update(this.focusX, this.focusZ, vr ? 3 : 6);
        if (!this.vr.session) this.updateHud();
      } else if (this.state === 'pyr') {
        // vue pilotée par PaceYourRide : les positions suivent l'horloge réelle de l'application, la caméra aussi (même à faible cadence)
        const dtr = Math.min(0.25, raw);
        this.ext.frame(dtr);
        if (vr) this.vr.updateRig(dtr); else this.updateRideCamera(dtr);
        this.tiles.update(this.focusX, this.focusZ, vr ? 3 : 6);
      } else if (this.state === 'finished') {
        // le cycliste continue sur sa lancée ; les autres finissent leur course
        this.ride.v *= Math.exp(-dt * 0.8);
        const R = this.ride;
        R.s += R.v * dt;
        if (this.peloton) {
          const fdt = dt * TIME_SCALES[this.timeScaleIndex], n = Math.max(1, Math.ceil(fdt / 0.05));
          for (let k = 0; k < n; k++) this.peloton.step(fdt / n);
        }
        const q = this.route.sample(R.s, this._rs);
        this.cyclist.root.position.set(q.x + q.rx * R.lat, q.y, q.z + q.rz * R.lat);
        this.cyclist.root.rotation.set(-Math.atan(q.grade), Math.atan2(q.tx, q.tz), 0, 'YXZ');
        this.cyclist.update(dt, { speed: R.v, pedaling: false, standing: false, tuck: false, steer: 0 });
        B3D.toon.shared.uRider.value.copy(this.cyclist.root.position);
        if (vr) this.vr.updateRig(dt); else this.updateRideCamera(dt);
        this.tiles.update(this.focusX, this.focusZ, 6);
        // ovation de l'arrivée qui s'éteint doucement
        R.finishT += dt;
        this.sound.update(dt, R.v, R.v > 1, Math.max(0, 1 - R.finishT / 7));
      }
      if (this.racing()) {
        if (this.peloton) this.peloton.render(dt * this.simK(), this.camera);
        if (this.convoy) this.convoy.update(dt * this.simK(), this.camera);
      }
      if (this.hcCrowd) {
        const racing = this.state !== 'preview';
        this.hcCrowd.update(dt, this.camera, this.ridersForCrowd(), racing && this.ride ? this.ride.s : this.preview.s, racing ? dt * this.simK() : dt);
      }
      if (this.fauna) this.updateFauna(dt);
      // heure, météo et vent : le temps avance avec la course (accéléré avec T), pas pendant la pause
      if (this.atmo) {
        const racing = this.racing();
        const paused = this.state === 'paused';
        this.atmo.update(paused ? 0 : racing ? dt * this.simK() : dt, paused ? 0 : dt, this.camera);
        this.applyNightLights();
        this._skySync = (this._skySync || 0) - dt;
        if (this._skySync <= 0) { this._skySync = 0.4; if (this.state === 'preview' || paused) this.syncSkyControls(); }
      }
      if (this.sky) this.sky.update(this.camera, dt);
      if (this.villageGroup) B3D.villages.cull(this.villageGroup, this.camera.getWorldPosition(this._cw || (this._cw = new THREE.Vector3())), this.Q.radius + 150);
      this.confetti.update(dt);
      // bulle "MEUH !" : petit rebond puis disparition
      if (this.bubbleT > 0) {
        this.bubbleT -= dt;
        const b = this.mooBubble, age = 1.9 - this.bubbleT;
        const pop = Math.min(1, age / 0.18);
        const k = (1 + 0.25 * Math.sin(Math.min(1, age / 0.35) * Math.PI)) * pop;
        b.scale.set(3.4 * k, 1.8 * k, 1);
        b.material.opacity = Math.min(1, this.bubbleT / 0.4);
        if (this.bubbleT <= 0 || this.state === 'menu') b.visible = false;
      }
      this.render();
    },

    // oiseaux et canards : autour du point visé en aperçu, autour du coureur en course
    updateFauna(dt) {
      let P, fwd;
      if (this.state === 'preview') {
        P = this._pvTarget;
        if (!P) return;
        const q = this.route.sample(this.preview.s, this._faunaTmp || (this._faunaTmp = {}));
        fwd = { x: q.tx, z: q.tz };
      } else {
        if (!this._rs) return;
        P = this.cyclist.root.position;
        fwd = { x: this._rs.tx, z: this._rs.tz };
      }
      this.fauna.update(dt, P, fwd, this.tiles);
    },

    updateHud() {
      const R = this.ride;
      const d = R.s - this.route.sStart;
      const q = this._rs;
      this.hud.update({
        speed: R.v, grade: q.grade, alt: q.y, d, time: R.time, x: q.x, z: q.z, hx: q.tx, hz: q.tz,
        effort: R.effort / PHYS.pMax, braking: R.braking, timeScale: TIME_SCALES[this.timeScaleIndex],
        camName: '🎥 ' + CAMS[this.camIndex].name, climb: this.currentClimb(d),
        next: this.raceT.next(R.s), points: this.raceT.points,
        target: R.target / PHYS.pMax, cp: PHYS.cp / PHYS.pMax, watts: R.effort, wkg: R.effort / PHYS.riderMass,
        reserve: R.reserve / PHYS.wp, bonk: R.bonk, draft: R.draft,
        race: this.peloton ? this.peloton.raceInfo() : null,
        sky: this.skyHud(q)
      }, performance.now());
    },

    // horloge et vent relatif au coureur (angle : 0 = le vent pousse dans le dos, 180 = de face)
    skyHud(q) {
      const A = this.atmo;
      if (!A) return null;
      const W = A.wind;
      const f = W.x * q.tx + W.z * q.tz, r = W.x * q.rx + W.z * q.rz;
      return { clock: A.clock(), icon: A.info().icon, kmh: W.speed * 3.6, angle: Math.atan2(r, f) * 180 / Math.PI };
    },

    // une course est à l'écran (jouée ici, ou pilotée par PaceYourRide)
    racing() { return this.state === 'ride' || this.state === 'countdown' || this.state === 'finished' || this.state === 'pyr'; },

    // positions des coureurs (pour la foule des cols, qui s'écarte à leur passage)
    ridersForCrowd() {
      const out = this._crowdRiders || (this._crowdRiders = []);
      out.length = 0;
      if (this.racing() && this.ride) {
        out.push(this.ride.s);
        if (this.peloton) for (const r of this.peloton.riders) out.push(r.s);
        // les motos et les voitures de la caravane passent aussi dans le couloir
        if (this.convoy && this.convoy.group.visible) for (const v of this.convoy.all) out.push(v.s + 3);
      }
      return out;
    },

    render() {
      if (this.sky) this.sky.update(this.camera, 0);
      this.renderer.render(this.scene, this.camera);
    }
  };

  window.B3D.game = Game;
  const start = () => Game.init();
  if (document.fonts && document.fonts.ready) {
    Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]).then(start);
  } else start();
})();
