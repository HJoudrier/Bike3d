/* Bike3D — mode immersif en réalité virtuelle (WebXR), pour les casques autonomes comme le Meta Quest.
   La caméra est placée dans une « nacelle » qui suit le vélo (vue cycliste ou vue de poursuite) ; le casque
   ajoute les mouvements de la tête. Le HUD devient un compteur de vélo fixé sur la potence et des panneaux
   flottants ; les commandes passent par les manettes. Un effet tunnel dans les virages limite le mal des transports. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { clamp, lerp, formatTime, gradeColor } = B3D.util;
  const FONT = 'Fredoka, Arial, sans-serif';
  const UP = new THREE.Vector3(0, 1, 0);

  // Boutons des manettes Touch (profil « xr-standard »)
  const BTN = { trigger: 0, squeeze: 1, stick: 3, a: 4, b: 5 };

  function canvasPanel(w, h, mw, mh) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(mw, mh), mat);
    mesh.renderOrder = 20;
    return { canvas, ctx: canvas.getContext('2d'), tex, mesh };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Effet tunnel : sphère autour de la tête, assombrie en périphérie quand on tourne ou qu'on va vite.
  function vignetteMesh() {
    const m = new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: 0 } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: [
        'uniform float uStrength; varying vec3 vP;',
        'void main(){',
        '  float c = dot(normalize(vP), vec3(0.0, 0.0, -1.0));', // 1 = droit devant
        '  float inner = mix(0.92, 0.55, uStrength);',
        '  float a = (1.0 - smoothstep(inner - 0.3, inner, c)) * uStrength;',
        '  if (a < 0.003) discard;',
        '  gl_FragColor = vec4(0.06, 0.05, 0.1, a);',
        '}'
      ].join('\n'),
      side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false
    });
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 16), m);
    s.renderOrder = 30;
    s.frustumCulled = false;
    return s;
  }

  class VRMode {
    constructor(game) {
      this.game = game;
      this.renderer = game.renderer;
      this.supported = false;
      this.session = null;
      this.sim = false; // simulation sur écran (tests) : même nacelle, sans casque
      this.view = 'cockpit'; // 'cockpit' (vue cycliste) ou 'chase' (poursuite)
      this.comfort = true;
      this.rig = new THREE.Group();
      this.rig.name = 'vr-rig';
      this.anchor = new THREE.Vector3();
      this.yaw = 0;
      this.prevYaw = null;
      this.yawRate = 0;
      this.pads = { left: null, right: null };
      this.prevButtons = {};
      this.msg = null;
      this.computer = canvasPanel(512, 384, 0.26, 0.195);
      // le même écran, flottant (vue poursuite) : toujours dessiné devant les coureurs
      this.dash = new THREE.Mesh(this.computer.mesh.geometry, this.computer.mesh.material.clone());
      this.dash.material.depthTest = false;
      this.dash.renderOrder = 25;
      this.panel = canvasPanel(1024, 512, 1.6, 0.8);
      this.panel.mesh.material.depthTest = false;
      this.panel.mesh.renderOrder = 25;
      this.pack = 0;
      this.vignette = vignetteMesh();
      this.lastDraw = 0;
      if (navigator.xr && navigator.xr.isSessionSupported) {
        navigator.xr.isSessionSupported('immersive-vr').then((ok) => { this.supported = !!ok; game.refreshVRButtons(); }).catch(() => {});
        navigator.xr.addEventListener && navigator.xr.addEventListener('devicechange', () => {
          navigator.xr.isSessionSupported('immersive-vr').then((ok) => { this.supported = !!ok; game.refreshVRButtons(); }).catch(() => {});
        });
      }
    }

    get presenting() { return !!this.session || this.sim; }

    // ------------------------------------------------------------ entrée / sortie
    // Doit être appelé depuis un clic (geste de l'utilisateur).
    async enter() {
      if (this.session || !navigator.xr) return false;
      const r = this.renderer, g = this.game;
      g.sound.start(); // le son doit démarrer pendant le geste
      let session;
      try {
        // mêmes options que le VRButton de three.js ; l'espace « local » (assis) est toujours fourni
        session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'layers'] });
      } catch (e) {
        g.showVRError('Impossible de démarrer la réalité virtuelle (' + e.message + ').');
        return false;
      }
      r.xr.enabled = true;
      r.xr.setReferenceSpaceType('local'); // assis : l'origine est la tête au lancement
      // résolution par œil selon la qualité choisie (le casque autonome a peu de marge)
      r.xr.setFramebufferScaleFactor({ low: 0.8, medium: 0.9, high: 1.0 }[g.settings.quality] || 0.9);
      session.addEventListener('end', () => this._onEnd());
      // menu système du casque, casque retiré : on met la course en pause
      session.addEventListener('visibilitychange', () => {
        if (session.visibilityState !== 'visible' && (g.state === 'ride' || g.state === 'countdown')) g.togglePause(true);
      });
      await r.xr.setSession(session);
      r.xr.setFoveation(1);
      this.session = session;
      this._attach();
      return true;
    }

    exit() {
      if (this.session) this.session.end();
      else if (this.sim) { this.sim = false; this._detach(); }
    }

    simulate(on) {
      if (on && !this.presenting) { this.sim = true; this._attach(); } else if (!on && this.sim) { this.sim = false; this._detach(); }
    }

    _attach() {
      const g = this.game;
      g.scene.add(this.rig);
      this.rig.add(g.camera);
      g.camera.position.set(0, 0, 0);
      g.camera.rotation.set(0, 0, 0);
      g.camera.add(this.vignette);
      this.rig.add(this.panel.mesh);
      // au-dessus de l'horizon, légèrement incliné vers les yeux : la route reste dégagée
      this.panel.mesh.position.set(0, 0.3, -1.9);
      this.panel.mesh.rotation.set(0.12, 0, 0);
      this.panel.mesh.scale.setScalar(0.85);
      this.panel.mesh.visible = false;
      this.rig.add(this.dash);
      this.dash.position.set(0, -0.62, -1.05);
      this.dash.rotation.set(-0.55, 0, 0);
      this.dash.scale.setScalar(1.6);
      this._mountComputer();
      this.prevYaw = null;
      this.msg = null;
      // la sortie d'écran (bulle de vitesse, etc.) n'est pas visible dans le casque
      g.onVRChange(true);
      this.toast('🥽 Mode immersif<small>Manette gauche : se déplacer · stick droit : puissance · gâchettes : à fond · grips : freins · A : vue · X : pause</small>', 4500);
    }

    _detach() {
      const g = this.game;
      this.rig.remove(g.camera);
      g.camera.remove(this.vignette);
      g.scene.remove(this.rig);
      if (this.computer.mesh.parent) this.computer.mesh.parent.remove(this.computer.mesh);
      g.camera.position.set(0, 10, 10);
      if (g.cyclist) g.cyclist.head.visible = true;
      g.onVRChange(false);
    }

    _onEnd() {
      this.session = null;
      // après three.js, qui rend au canevas sa taille d'écran
      setTimeout(() => { this.renderer.xr.enabled = false; this._detach(); }, 0);
    }

    // compteur de vélo vissé devant la potence, tourné vers les yeux du coureur
    _mountComputer() {
      const c = this.game.cyclist;
      if (!c) return;
      const m = this.computer.mesh;
      if (m.parent !== c.bikeGroup) c.bikeGroup.add(m);
      const mount = new THREE.Vector3(0, 0.96, 0.6), eye = new THREE.Vector3(0, 1.58, 0.36);
      m.position.copy(mount);
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, mount, UP));
    }

    // ------------------------------------------------------------ manettes
    _readPads() {
      this.pads.left = this.pads.right = null;
      const src = this.session ? this.session.inputSources : (this.fakeInputs || []);
      for (const s of src) {
        if (!s || !s.gamepad) continue;
        if (s.handedness === 'left') this.pads.left = s.gamepad;
        else if (s.handedness === 'right') this.pads.right = s.gamepad;
      }
    }

    // vrai au moment où le bouton est enfoncé
    _pressed(hand, b) {
      const gp = this.pads[hand];
      const now = !!(gp && gp.buttons[b] && gp.buttons[b].pressed);
      const key = hand + b;
      const was = this.prevButtons[key];
      this.prevButtons[key] = now;
      return now && !was;
    }
    _held(hand, b) { const gp = this.pads[hand]; return !!(gp && gp.buttons[b] && gp.buttons[b].pressed); }
    _axis(hand, i) { const gp = this.pads[hand]; return gp && gp.axes && gp.axes.length > i ? gp.axes[i] || 0 : 0; }

    pulse(intensity, ms, hand) {
      for (const h of hand ? [hand] : ['left', 'right']) {
        const gp = this.pads[h];
        const act = gp && gp.hapticActuators && gp.hapticActuators[0];
        if (act && act.pulse) { try { act.pulse(intensity, ms); } catch (e) { /* ignoré */ } }
      }
    }

    // commandes : appelée à chaque image, quel que soit l'état du jeu
    handleInput(dt) {
      const g = this.game, inp = g.input;
      this._readPads();
      const riding = g.state === 'ride' || g.state === 'countdown';
      // direction : stick gauche (ou stick droit s'il est poussé de côté)
      const lx = this._axis('left', 2), rx = this._axis('right', 2), ry = this._axis('right', 3);
      const steer = Math.abs(lx) > 0.3 ? lx : (Math.abs(rx) > 0.5 && Math.abs(rx) > Math.abs(ry) ? rx : 0);
      if (riding) {
        inp.left = steer < -0.3; inp.right = steer > 0.3;
        // puissance : stick droit vers le haut / le bas
        if (Math.abs(ry) > 0.2 && Math.abs(ry) >= Math.abs(rx)) g.setTarget(g.ride.target - ry * 340 * dt);
        // gâchettes : à fond tant qu'on appuie (sprint) ; grips : freins
        const sprint = this._held('left', BTN.trigger) || this._held('right', BTN.trigger);
        if (sprint && !this.sprinting) { this.sprinting = true; this.saved = g.ride.target; g.setTarget(9999); }
        else if (!sprint && this.sprinting) { this.sprinting = false; g.setTarget(this.saved); }
        inp.brake = this._held('left', BTN.squeeze) || this._held('right', BTN.squeeze);
      }
      // boutons
      const A = this._pressed('right', BTN.a), B = this._pressed('right', BTN.b);
      const X = this._pressed('left', BTN.a), Y = this._pressed('left', BTN.b);
      const stickR = this._pressed('right', BTN.stick);
      if (g.state === 'paused') {
        if (A || X) g.togglePause(false);
        else if (B) this.exit();
        if (Y) this.recenter();
        return;
      }
      if (g.state === 'finished') {
        if (A) { g.hide('screen-finish'); g.startRide(); }
        else if (B) this.exit();
        return;
      }
      if (riding) {
        if (A) this.setView(this.view === 'cockpit' ? 'chase' : 'cockpit');
        if (B) { g.cycleTimeScale(); this.toast('⏩ Temps x' + g.timeScale(), 1200); }
        if (X) g.togglePause(true);
        if (Y) this.recenter();
        if (stickR) { this.comfort = !this.comfort; this.toast(this.comfort ? '🌀 Confort activé<small>L’écran s’assombrit en périphérie dans les virages</small>' : '🌀 Confort désactivé', 1800); }
      }
    }

    setView(v) {
      this.view = v;
      this.prevYaw = null;
      this.toast(v === 'cockpit' ? '🚴 Vue cycliste' : '🎥 Vue poursuite', 1200);
    }

    // recentrer : la position actuelle de la tête devient l'origine
    recenter() {
      const cam = this.game.camera;
      this.headOffset = this.headOffset || new THREE.Vector3();
      this.headOffset.set(cam.position.x, cam.position.y, cam.position.z);
      this.toast('🎯 Vue recentrée', 1000);
    }

    // ------------------------------------------------------------ placement de la nacelle
    updateRig(dt) {
      const g = this.game, cyc = g.cyclist, R = g.ride;
      if (!cyc || !R) return;
      const route = g.route;
      const heading = cyc.root.rotation.y;
      let target, wantYaw;
      if (this.view === 'cockpit') {
        // les yeux du coureur (sans le roulis : l'horizon reste droit)
        cyc.head.visible = false;
        target = cyc.head.getWorldPosition(this._hp || (this._hp = new THREE.Vector3()));
        const fwd = 0.1;
        target.x += Math.sin(heading) * fwd; target.z += Math.cos(heading) * fwd;
        target.y += 0.03;
        wantYaw = heading;
      } else {
        cyc.head.visible = true;
        // des coureurs juste derrière : la caméra monte et recule pour voir par-dessus
        let n = 0;
        if (g.peloton) for (const r of g.peloton.riders) { const ds = R.s - r.s; if (ds > 0.3 && ds < 7 && Math.abs(r.lat - R.lat) < 2.2 && !r.done) n++; }
        this.pack = lerp(this.pack, Math.min(1, n / 2), 1 - Math.exp(-dt * 1.2));
        const tmp = this._tq || (this._tq = {});
        const back = 4.6 + 2.0 * this.pack, up = 2.2 + 1.6 * this.pack;
        const b = route.sample(R.s - back, tmp);
        target = this._ct || (this._ct = new THREE.Vector3());
        target.set(b.x + b.rx * R.lat * 0.6, Math.max(b.y, cyc.root.position.y - back * 0.15) + up, b.z + b.rz * R.lat * 0.6);
        wantYaw = Math.atan2(cyc.root.position.x - target.x, cyc.root.position.z - target.z);
      }
      // lissage : la nacelle suit le vélo sans à-coups
      if (this.prevYaw === null) { this.yaw = wantYaw; this.anchor.copy(target); }
      let dy = wantYaw - this.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      this.yaw += dy * (1 - Math.exp(-dt * (this.view === 'cockpit' ? 6 : 3)));
      this.anchor.lerp(target, 1 - Math.exp(-dt * (this.view === 'cockpit' ? 30 : 6)));
      if (this.prevYaw !== null && dt > 0) {
        let d = this.yaw - this.prevYaw;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        this.yawRate = lerp(this.yawRate, Math.abs(d) / dt, 1 - Math.exp(-dt * 4));
      }
      this.prevYaw = this.yaw;
      this.rig.position.copy(this.anchor);
      this.rig.rotation.set(0, this.yaw + Math.PI, 0);
      // recentrage : on retranche la position de la tête enregistrée
      if (this.headOffset) {
        const o = this.headOffset;
        const c = Math.cos(this.yaw + Math.PI), s = Math.sin(this.yaw + Math.PI);
        this.rig.position.x -= o.x * c + o.z * s;
        this.rig.position.z -= -o.x * s + o.z * c;
        this.rig.position.y -= o.y;
      }
      this.rig.updateMatrixWorld(true);
      // tuiles chargées devant, ombres autour du coureur
      const P = cyc.root.position;
      g.focusX = P.x + Math.sin(heading) * 120; g.focusZ = P.z + Math.cos(heading) * 120;
      g.shadowFollow(P, 26);
      // effet tunnel : virages serrés et grande vitesse
      const sp = R.v || 0;
      const want = this.comfort ? clamp((this.yawRate - 0.12) / 0.5, 0, 1) * 0.85 + clamp((sp - 13) / 10, 0, 1) * 0.25 : 0;
      const u = this.vignette.material.uniforms.uStrength;
      u.value = lerp(u.value, clamp(want, 0, 0.9), 1 - Math.exp(-dt * 5));
      this.vignette.visible = u.value > 0.01;
    }

    // ------------------------------------------------------------ affichages
    toast(html, ms) {
      const parts = html.split('<small>');
      const title = parts[0].replace(/<[^>]+>/g, '');
      const sub = parts[1] ? parts[1].replace(/<[^>]+>/g, '') : '';
      this.msg = { kind: 'toast', title, sub, until: performance.now() + (ms || 2600) };
      this._drawPanel();
    }

    countdown(text) {
      if (this.msg && this.msg.kind === 'count' && this.msg.title === text) return;
      this.msg = { kind: 'count', title: text, until: performance.now() + (text === 'GO !' ? 900 : 1100) };
      this._drawPanel();
    }

    showPause(on) {
      if (!on) { if (this.msg && this.msg.kind === 'pause') this.msg = null; this.panel.mesh.visible = false; return; }
      this.msg = { kind: 'pause', title: 'Pause', lines: ['Ⓐ ou Ⓧ  reprendre', 'Ⓑ  quitter la réalité virtuelle', 'Ⓨ  recentrer la vue'], until: Infinity };
      this._drawPanel();
    }

    clearPanel() { this.msg = null; this._drawPanel(); }

    showFinish(title, rows, stats) {
      this.msg = { kind: 'finish', title, rows, stats, until: Infinity };
      this._drawPanel();
    }

    _drawPanel() {
      const { ctx, canvas, tex } = this.panel;
      const W = canvas.width, H = canvas.height, m = this.msg;
      ctx.clearRect(0, 0, W, H);
      if (!m) { this.panel.mesh.visible = false; return; }
      this.panel.mesh.visible = true;
      // les cartes (pause, arrivée) sont plus grandes que les messages, qui ne doivent pas cacher la route
      this.panel.mesh.scale.setScalar(m.kind === 'pause' || m.kind === 'finish' ? 1.15 : 0.85);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (m.kind === 'count') {
        ctx.font = '700 300px ' + FONT;
        ctx.lineWidth = 26; ctx.strokeStyle = '#1d1a2b'; ctx.fillStyle = m.title === 'GO !' ? '#5cc85a' : '#ffd23a';
        ctx.strokeText(m.title, W / 2, H / 2 + 10); ctx.fillText(m.title, W / 2, H / 2 + 10);
      } else if (m.kind === 'toast') {
        const h = m.sub ? 230 : 150, y = (H - h) / 2;
        ctx.fillStyle = '#1d1a2b'; roundRect(ctx, 40, y + 10, W - 80, h, 34); ctx.fill();
        ctx.fillStyle = '#ffd23a'; roundRect(ctx, 40, y, W - 80, h, 34); ctx.fill();
        ctx.lineWidth = 8; ctx.strokeStyle = '#1d1a2b'; ctx.stroke();
        ctx.fillStyle = '#1d1a2b';
        let size = 64; ctx.font = '700 ' + size + 'px ' + FONT;
        while (ctx.measureText(m.title).width > W - 140 && size > 30) { size -= 4; ctx.font = '700 ' + size + 'px ' + FONT; }
        ctx.fillText(m.title, W / 2, y + (m.sub ? 78 : h / 2));
        if (m.sub) {
          size = 36; ctx.font = '500 ' + size + 'px ' + FONT;
          while (ctx.measureText(m.sub).width > W - 140 && size > 20) { size -= 2; ctx.font = '500 ' + size + 'px ' + FONT; }
          ctx.fillText(m.sub, W / 2, y + 165);
        }
      } else {
        // pause ou arrivée : grande carte
        ctx.fillStyle = '#1d1a2b'; roundRect(ctx, 60, 22, W - 120, H - 34, 40); ctx.fill();
        ctx.fillStyle = '#fffaf0'; roundRect(ctx, 60, 12, W - 120, H - 34, 40); ctx.fill();
        ctx.lineWidth = 8; ctx.strokeStyle = '#1d1a2b'; ctx.stroke();
        ctx.fillStyle = '#1d1a2b';
        ctx.font = '700 64px ' + FONT;
        ctx.fillText(m.title, W / 2, 80);
        if (m.kind === 'pause') {
          ctx.font = '600 44px ' + FONT;
          m.lines.forEach((l, k) => ctx.fillText(l, W / 2, 200 + k * 80));
        } else {
          ctx.font = '500 32px ' + FONT;
          ctx.fillText(m.stats, W / 2, 140);
          ctx.textAlign = 'left';
          (m.rows || []).slice(0, 5).forEach((r, k) => {
            const y = 200 + k * 46;
            if (r.me) { ctx.fillStyle = '#ffd23a'; roundRect(ctx, 150, y - 22, W - 300, 44, 12); ctx.fill(); }
            ctx.fillStyle = '#1d1a2b';
            ctx.font = (r.me ? '700 ' : '500 ') + '32px ' + FONT;
            ctx.fillText(r.pos + '. ' + r.name, 170, y);
            ctx.textAlign = 'right'; ctx.fillText(r.time, W - 170, y); ctx.textAlign = 'left';
          });
          ctx.textAlign = 'center';
          ctx.font = '700 36px ' + FONT;
          ctx.fillText('Ⓐ rejouer   ·   Ⓑ quitter la VR', W / 2, H - 52);
        }
      }
      tex.needsUpdate = true;
    }

    // écran du compteur : vitesse, jauge de puissance, réserve, pente, aspiration, position
    _drawComputer() {
      const g = this.game, R = g.ride;
      if (!R) return;
      const { ctx, canvas, tex } = this.computer;
      const W = canvas.width, H = canvas.height;
      const P = g.phys;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#1d1a2b'; roundRect(ctx, 4, 4, W - 8, H - 8, 44); ctx.fill();
      ctx.fillStyle = '#f4f8ec'; roundRect(ctx, 22, 22, W - 44, H - 44, 30); ctx.fill();
      ctx.fillStyle = '#1d1a2b'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      // vitesse
      ctx.font = '700 118px ' + FONT;
      const kmh = String(Math.round(R.v * 3.6));
      ctx.fillText(kmh, 44, 128);
      const kw = ctx.measureText(kmh).width;
      ctx.font = '600 30px ' + FONT;
      ctx.fillText('km/h', 56 + kw, 126);
      // pente
      const q = g._rs || {};
      const gr = (q.grade || 0) * 100;
      ctx.fillStyle = gradeColor(q.grade || 0);
      roundRect(ctx, W - 196, 40, 156, 58, 29); ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = '#1d1a2b'; ctx.stroke();
      ctx.fillStyle = gr >= 9 || gr < 0 ? '#ffffff' : '#1d1a2b';
      ctx.font = '700 36px ' + FONT; ctx.textAlign = 'center';
      ctx.fillText((gr >= 0 ? '+' : '') + gr.toFixed(1).replace('.', ',') + '%', W - 118, 83);
      // aspiration
      if (R.draft > 0.03) {
        ctx.fillStyle = '#5df08a'; roundRect(ctx, W - 196, 106, 156, 40, 20); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#1d1a2b'; ctx.font = '700 26px ' + FONT;
        ctx.fillText('🌀 −' + Math.round(R.draft * 100) + '%', W - 118, 135);
      }
      // jauge de puissance horizontale
      const x0 = 44, x1 = W - 44, y0 = 168, gh = 44;
      const X = (w) => x0 + clamp(w / P.pMax, 0, 1) * (x1 - x0);
      const zones = [[0, P.cp * 0.75, '#5cc85a'], [P.cp * 0.75, P.cp, '#f2c230'], [P.cp, P.cp * 1.3, '#f39a2b'], [P.cp * 1.3, P.pMax, '#e2463a']];
      ctx.globalAlpha = 0.3;
      for (const [a, b, c] of zones) { ctx.fillStyle = c; ctx.fillRect(X(a), y0, X(b) - X(a), gh); }
      ctx.globalAlpha = 1;
      for (const [a, b, c] of zones) { if (R.effort > a) { ctx.fillStyle = c; ctx.fillRect(X(a), y0, X(Math.min(b, R.effort)) - X(a), gh); } }
      ctx.lineWidth = 5; ctx.strokeStyle = '#1d1a2b'; ctx.strokeRect(x0, y0, x1 - x0, gh);
      ctx.setLineDash([8, 6]); ctx.beginPath(); ctx.moveTo(X(P.cp), y0 - 6); ctx.lineTo(X(P.cp), y0 + gh + 6); ctx.stroke(); ctx.setLineDash([]);
      // consigne
      const tx = X(R.target);
      ctx.fillStyle = '#1d1a2b';
      ctx.beginPath(); ctx.moveTo(tx, y0 - 2); ctx.lineTo(tx - 14, y0 - 22); ctx.lineTo(tx + 14, y0 - 22); ctx.closePath(); ctx.fill();
      ctx.font = '700 34px ' + FONT; ctx.textAlign = 'left';
      ctx.fillText(Math.round(R.effort) + ' W', 44, 250);
      ctx.font = '500 26px ' + FONT;
      ctx.fillText((R.effort / P.riderMass).toFixed(1).replace('.', ',') + ' W/kg · consigne ' + Math.round(R.target) + ' W', 170, 250);
      // réserve
      ctx.fillStyle = '#ffffff'; roundRect(ctx, 44, 270, x1 - 44, 26, 13); ctx.fill();
      const res = clamp(R.reserve / P.wp, 0, 1);
      ctx.fillStyle = R.bonk ? '#e2463a' : res > 0.5 ? '#5cc85a' : res > 0.2 ? '#f39a2b' : '#e2463a';
      if (res > 0.01) { roundRect(ctx, 44, 270, (x1 - 44) * res, 26, 13); ctx.fill(); }
      roundRect(ctx, 44, 270, x1 - 44, 26, 13); ctx.lineWidth = 4; ctx.stroke();
      // ligne du bas : position, distance restante, vent (flèche relative au coureur), chrono
      ctx.fillStyle = '#1d1a2b'; ctx.font = '600 25px ' + FONT;
      const d = Math.max(0, R.s - g.route.sStart);
      const info = g.peloton ? g.peloton.raceInfo() : null;
      ctx.textAlign = 'left';
      ctx.fillText(info ? '🏁 ' + info.position + '/' + info.total : '📏 ' + (d / 1000).toFixed(1).replace('.', ',') + ' km', 40, 338);
      ctx.fillText((Math.max(0, g.route.length - d) / 1000).toFixed(1).replace('.', ',') + ' km', 150, 338);
      const sky = g.skyHud ? g.skyHud(q) : null;
      if (sky) {
        const ax = 290, ay = 329;
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(sky.angle * Math.PI / 180);
        ctx.globalAlpha = sky.kmh < 3 ? 0.3 : 1;
        ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(10, 3); ctx.lineTo(3, 1); ctx.lineTo(3, 14); ctx.lineTo(-3, 14); ctx.lineTo(-3, 1); ctx.lineTo(-10, 3); ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.fillText(Math.round(sky.kmh) + '', ax + 18, 338);
      }
      ctx.textAlign = 'right';
      ctx.fillText('⏱ ' + formatTime(R.time), W - 40, 338);
      tex.needsUpdate = true;
    }

    // à chaque image en mode immersif
    update(dt) {
      if (!this.presenting) return;
      const g = this.game;
      this.handleInput(dt);
      // écrans
      const now = performance.now();
      if (now - this.lastDraw > 100) { this.lastDraw = now; this._drawComputer(); }
      if (this.msg && now > this.msg.until) { this.msg = null; this._drawPanel(); }
      const cockpit = this.view === 'cockpit';
      this.computer.mesh.visible = cockpit && !!g.ride;
      this.dash.visible = !cockpit && !!g.ride;
      if (this.computer.mesh.parent !== (g.cyclist && g.cyclist.bikeGroup)) this._mountComputer();
      // échelle des contours et des fumigènes pour la résolution du casque
      if (this.session) {
        const xc = this.renderer.xr.getCamera();
        const eye = xc.cameras && xc.cameras[0];
        if (eye && eye.viewport && eye.viewport.w > 0) {
          const p5 = eye.projectionMatrix.elements[5];
          B3D.toon.shared.uOutlineScale.value = 1.6 * 2 / (p5 * eye.viewport.w);
          if (g.hcCrowd) g.hcCrowd.setPointScale(eye.viewport.w * 0.5 * p5);
        }
      }
    }
  }

  B3D.VRMode = VRMode;
})(typeof window !== 'undefined' ? window : globalThis);
