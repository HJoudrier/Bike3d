/* Bike3D — boucle principale : interface, génération du monde, aperçu, physique du vélo, caméra. */
(function () {
  'use strict';
  const B3D = window.B3D;
  const { clamp, lerp, formatTime, hashString } = B3D.util;
  const $ = (id) => document.getElementById(id);

  const PHYS = { mass: 85, g: 9.81, crr: 0.0045, rho: 1.2, cda: 0.32, cdaTuck: 0.22, cdaStand: 0.4, pMax: 720, brake: 430, vMax: 30 };
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
    settings: { jersey: 'jaune', quality: 'medium' },
    input: { left: false, right: false, up: false, down: false },
    camIndex: 0,
    timeScaleIndex: 0,

    init() {
      try { Object.assign(this.settings, JSON.parse(localStorage.getItem('bike3d-settings') || '{}')); } catch (e) { /* stockage indisponible */ }
      if (!B3D.TileManager.QUALITY[this.settings.quality]) this.settings.quality = 'medium';
      if (!B3D.Cyclist.JERSEYS[this.settings.jersey]) this.settings.jersey = 'jaune';

      const canvas = $('scene');
      let r;
      try {
        r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
      } catch (err) {
        this.showError('Ton navigateur ne permet pas l\'affichage 3D (WebGL indisponible). Essaie avec un navigateur récent ou active l\'accélération matérielle.');
        $('btn-model').disabled = true;
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
      this.loop();
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
      this.resize();
    },

    resize() {
      const w = window.innerWidth, h = window.innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      // contour d'environ 1,7 px quelle que soit la taille de l'écran
      B3D.toon.shared.uOutlineScale.value = 1.7 * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) / h;
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
      this.refreshChips();

      $('btn-model').onclick = () => this.newLandscape();
      $('btn-remodel').onclick = () => this.newLandscape();
      $('btn-validate').onclick = () => this.startRide();
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

    refreshChips() {
      document.querySelectorAll('#opt-jersey .chip').forEach((b) => b.classList.toggle('active', b.dataset.j === this.settings.jersey));
      document.querySelectorAll('#opt-quality .chip').forEach((b) => b.classList.toggle('active', b.dataset.q === this.settings.quality));
    },

    bindInput() {
      const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down', KeyQ: 'left', KeyZ: 'up' };
      window.addEventListener('keydown', (e) => {
        const k = map[e.code];
        if (k && (this.state === 'ride' || this.state === 'countdown')) { this.input[k] = true; e.preventDefault(); }
        if (e.repeat) return;
        if (this.state === 'ride' || this.state === 'countdown') {
          if (e.code === 'KeyC') this.cycleCamera();
          if (e.code === 'KeyT') this.timeScaleIndex = (this.timeScaleIndex + 1) % TIME_SCALES.length;
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

    show(id) { $(id).classList.remove('hidden'); },
    hide(id) { $(id).classList.add('hidden'); },

    toast(html, ms) {
      const t = $('toast');
      t.innerHTML = html;
      t.classList.remove('hidden');
      t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => t.classList.add('hidden'), ms || 2600);
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
      if (this.mooBubble) this.mooBubble.visible = false;
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
      this.setLoading(0.15, 'Rivières, lacs et falaises…');
      await nextFrame();

      // ambiance
      const amb = L.amb;
      this.scene.fog.color.set(amb.sky.fog);
      this.sun.color.set(amb.sun.color);
      this.sun.intensity = amb.sun.intensity;
      this.hemi.color.set(amb.hemi.sky);
      this.hemi.groundColor.set(amb.hemi.ground);
      this.hemi.intensity = amb.hemi.intensity;
      this.sky = new B3D.Sky(this.scene, L);
      this.sunDir = this.sky.sunDir.clone();

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
      this.cyclist = new B3D.Cyclist({ jersey: this.settings.jersey, bikeColor: ['#e2463a', '#3d7be0', '#1d1a2b', '#4cc35a', '#ff7aa8'][seed % 5] });
      this.scene.add(this.cyclist.root);
      this.placeCyclistAtStart();

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
      this.setLoading(1, 'Prêt !');
      console.info('[Bike3D] paysage', seed, 'généré en', Math.round(performance.now() - t0), 'ms');

      // interface d'aperçu
      $('seed-label').textContent = seed;
      $('preview-title').textContent = L.amb.name;
      $('landscape-desc').innerHTML = L.describe().map((d) => '<li><span>' + d.icon + ' ' + d.label + '</span><b>' + d.value + '</b></li>').join('');
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
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      this.hide('screen-preview');
      this.show('hud');
      this.sound.start();
      this.sound.silence();
      const route = this.route;
      this.ride = {
        s: route.sStart - 4, lat: 0, latV: 0, v: 0, effort: 0, cruise: 0, braking: false,
        time: 0, maxV: 0, climbsDone: new Set(), flamme: false, crowd: 0, standing: false, tuck: false,
        villagesSeen: new Set(), lastStrokes: 0, mooT: 1.5, bellT: 0, cowCheck: 0, cow: null, finishT: 0
      };
      this._rs = route.sample(this.ride.s, {});
      this.timeScaleIndex = 0;
      this.hud.setup(route, this.L);
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
      } else if (!on && this.state === 'paused') {
        this.state = this.pausedFrom;
        this.hide('screen-pause');
        this.clock.getDelta();
      }
    },

    cycleCamera() {
      this.camIndex = (this.camIndex + 1) % CAMS.length;
      this.camState = null;
    },

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

    updateRide(dtReal) {
      const R = this.ride, route = this.route, L = this.L, inp = this.input;
      const ts = TIME_SCALES[this.timeScaleIndex];
      const dt = dtReal * ts;
      const half = L.roadHalf;
      const p = route.sample(R.s, this._rs || (this._rs = {}));
      const grade = p.grade;

      // --- effort du cycliste (watts) : ↑ accélère, ↓ freine, sinon effort de croisière
      const v = R.v;
      const offRoad = Math.abs(R.lat) > half - 0.2;
      const crr = PHYS.crr * (offRoad ? 3.5 : 1);
      const cda = R.tuck ? PHYS.cdaTuck : R.standing ? PHYS.cdaStand : PHYS.cda;
      const flatPower = (vv) => vv * (crr * PHYS.mass * PHYS.g + 0.5 * PHYS.rho * PHYS.cda * vv * vv);
      if (inp.up) {
        R.effort = Math.min(PHYS.pMax, R.effort + 1300 * dt);
        R.cruise = -1;
      } else if (inp.down) {
        R.effort = Math.max(0, R.effort - 2500 * dt);
        R.cruise = -1;
      } else {
        if (R.cruise < 0) R.cruise = v > 0.5 ? Math.min(PHYS.pMax * 0.8, flatPower(v)) : 0;
        R.effort += (R.cruise - R.effort) * (1 - Math.exp(-dt * 3));
      }
      R.braking = inp.down && v > 0.05;
      const drive = R.effort / Math.max(v, 1.6);
      const sinA = grade / Math.sqrt(1 + grade * grade);
      const fg = PHYS.mass * PHYS.g * sinA;
      const fr = v > 0.05 ? crr * PHYS.mass * PHYS.g : 0;
      const fa = 0.5 * PHYS.rho * cda * v * v;
      const fb = R.braking ? PHYS.brake : 0;
      let a = (drive - fg - fr - fa - fb) / PHYS.mass;
      if (v <= 0.01 && a < 0) a = 0; // pas de recul
      R.v = clamp(v + a * dt, 0, PHYS.vMax);
      if (R.v > R.maxV) R.maxV = R.v;

      // --- déplacement latéral
      const targetLatV = ((inp.right ? 1 : 0) - (inp.left ? 1 : 0)) * (2.2 + Math.min(R.v, 12) * 0.12);
      const prevLatV = R.latV;
      R.latV = lerp(R.latV, targetLatV, 1 - Math.exp(-dtReal * 6));
      R.lat += R.latV * dt;
      // bas-côté praticable, sauf glissière, parapet de pont ou foule
      const dNow = R.s - route.sStart;
      const ii = p.i;
      const crowded = this.crowdNear(ii) || L.villageW[ii] > 0.3;
      const maxR = (L.railR[ii] || L.bridgeMask[ii] || crowded) ? half - 0.35 : half + 1.5;
      const maxL = (L.railL[ii] || L.bridgeMask[ii] || crowded) ? half - 0.35 : half + 1.5;
      if (R.lat > maxR) { R.lat = Math.max(maxR, R.lat - 4 * dt); R.latV = Math.min(0, R.latV); }
      if (R.lat < -maxL) { R.lat = Math.min(-maxL, R.lat + 4 * dt); R.latV = Math.max(0, R.latV); }

      // --- avancement
      R.s += R.v * dt;
      R.time += dt;
      R.standing = inp.up && grade > 0.06 && R.v < 8.5;
      R.tuck = !inp.up && R.v > 14 && grade < -0.02;

      // --- placement du cycliste
      const q = route.sample(R.s, p);
      const cyc = this.cyclist;
      const steer = Math.atan2(R.latV, Math.max(R.v, 2));
      const heading = Math.atan2(q.tx, q.tz) - steer;
      let y = q.y;
      if (Math.abs(R.lat) > half) y = Math.max(q.y - 0.12, L.heightAt(q.x + q.rx * R.lat, q.z + q.rz * R.lat));
      cyc.root.position.set(q.x + q.rx * R.lat, y, q.z + q.rz * R.lat);
      const lean = clamp(-Math.atan(R.v * R.v * q.curv / PHYS.g) + R.latV * 0.07 + (R.latV - prevLatV) * 0.3, -0.6, 0.6);
      R.lean = lerp(R.lean || 0, lean, 1 - Math.exp(-dtReal * 6));
      const bump = offRoad ? Math.sin(R.time * 37) * 0.025 * Math.min(1, R.v / 5) : 0;
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

      // --- évènements de parcours
      const d = R.s - route.sStart;
      route.climbs.forEach((c, i) => {
        if (!R.climbsDone.has(i) && d >= c.d1) {
          R.climbsDone.add(i);
          this.toast('⛰️ ' + L.climbNames[i] + '<small>Sommet atteint · ' + Math.round(c.summitEle) + ' m</small>', 3200);
        }
      });
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
      // ambiance sonore : foule (selon la densité de spectateurs), vaches
      R.crowd = lerp(R.crowd, this.crowdDensity(q.i), 1 - Math.exp(-dtReal * 2));
      this.sound.update(dtReal, R.v, R.effort < 25 && R.v > 1, R.crowd);
      this.updateCows(dtReal);

      if (d >= route.length) this.finish();
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
        // caméra de poursuite : se place sur la route derrière le cycliste (ne coupe pas les virages)
        const b = route.sample(R.s - mode.dist, tmp);
        desired = new THREE.Vector3(b.x + b.rx * R.lat * 0.6, Math.max(b.y, P.y - mode.dist * 0.15) + mode.height, b.z + b.rz * R.lat * 0.6);
        const a = route.sample(R.s + mode.ahead, tmp);
        look = new THREE.Vector3(a.x + a.rx * R.lat * 0.5, Math.max(a.y, P.y - 1) + mode.look, a.z + a.rz * R.lat * 0.5);
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
      ].map((s) => '<div>' + s[0] + '<b>' + s[1] + '</b></div>').join('');
      const fb = $('finish-best');
      fb.className = 'finish-best' + (record ? ' record' : '');
      fb.textContent = record ? (best > 0 ? '🎉 Nouveau record ! (ancien : ' + formatTime(best) + ')' : '🎉 Premier temps enregistré !') : 'Record à battre : ' + formatTime(best);
      setTimeout(() => { if (this.state === 'finished') this.show('screen-finish'); }, 900);
    },

    // ------------------------------------------------------------------ boucle
    loop() {
      requestAnimationFrame(() => this.loop());
      const dt = Math.min(0.05, this.clock.getDelta());
      B3D.toon.shared.uTime.value += dt;
      if (this.state === 'menu' || this.building) return;
      if (this.state === 'preview') {
        this.updatePreviewCamera(dt);
        this.tiles.update(this.focusX, this.focusZ, 8);
      } else if (this.state === 'countdown') {
        this.countdown -= dt;
        const n = Math.ceil(this.countdown - 0.2);
        const el = $('countdown-text');
        if (this.countdown > 0.2) { if (el.textContent !== String(n)) el.textContent = String(n); }
        else if (!el.classList.contains('go')) { el.textContent = 'GO !'; el.classList.add('go'); }
        if (this.countdown <= -0.5) { this.hide('screen-countdown'); this.state = 'ride'; }
        if (this.countdown <= 0.2 && this.state === 'countdown') {
          // départ lancé : la course commence pendant l'affichage de "GO !"
          this.updateRide(dt);
        }
        this.updateRideCamera(dt);
        this.tiles.update(this.focusX, this.focusZ, 6);
        this.updateHud();
      } else if (this.state === 'ride') {
        this.updateRide(dt);
        this.updateRideCamera(dt);
        this.tiles.update(this.focusX, this.focusZ, 6);
        this.updateHud();
      } else if (this.state === 'finished') {
        // le cycliste continue sur sa lancée
        this.ride.v *= Math.exp(-dt * 0.8);
        this.input.up = false; this.input.down = false;
        const R = this.ride;
        R.s += R.v * dt;
        const q = this.route.sample(R.s, this._rs);
        this.cyclist.root.position.set(q.x + q.rx * R.lat, q.y, q.z + q.rz * R.lat);
        this.cyclist.root.rotation.set(-Math.atan(q.grade), Math.atan2(q.tx, q.tz), 0, 'YXZ');
        this.cyclist.update(dt, { speed: R.v, pedaling: false, standing: false, tuck: false, steer: 0 });
        B3D.toon.shared.uRider.value.copy(this.cyclist.root.position);
        this.updateRideCamera(dt);
        this.tiles.update(this.focusX, this.focusZ, 6);
        // ovation de l'arrivée qui s'éteint doucement
        R.finishT += dt;
        this.sound.update(dt, R.v, R.v > 1, Math.max(0, 1 - R.finishT / 7));
      }
      if (this.sky) this.sky.update(this.camera, dt);
      if (this.villageGroup) B3D.villages.cull(this.villageGroup, this.camera.position, this.Q.radius + 150);
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

    updateHud() {
      const R = this.ride;
      const d = R.s - this.route.sStart;
      const q = this._rs;
      this.hud.update({
        speed: R.v, grade: q.grade, alt: q.y, d, time: R.time, x: q.x, z: q.z, hx: q.tx, hz: q.tz,
        effort: R.effort / PHYS.pMax, braking: R.braking, timeScale: TIME_SCALES[this.timeScaleIndex],
        camName: '🎥 ' + CAMS[this.camIndex].name, climb: this.currentClimb(d)
      }, performance.now());
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
