/* Bike3D — vitrine du magasin de PaceYourRide (showroom.html) : le vélo et le cycliste équipés, le même modèle que dans le jeu
   (B3D.Cyclist), pédalent sur place sur un home-trainer. On tourne autour en glissant (souris ou doigt), on s'approche à la molette
   ou en pinçant, un double-clic revient à la vue de départ ; sans geste, la caméra tourne doucement.

   PaceYourRide → vitrine (messages pyr3d: 1)
     gear : { gear: {frame, wheels, tire, position, helmet, clothing, glasses, socks, shoes, sex} (voir B3D.Cyclist.GEAR),
              color (couleur du joueur : maillot et casque), bg (couleur du fond), dark (thème sombre), rider (montrer le cycliste) }
     run  : { on } (l'onglet du magasin est affiché ou non : la vitrine s'arrête quand on ne la voit pas)
   vitrine → PaceYourRide
     hello  : prête à recevoir l'équipement (renvoyé chaque seconde tant qu'il n'est pas arrivé)
     status : { state: 'ready' } après la première image avec l'équipement
   Le cycliste est au niveau de détail réaliste (detail=simple ou detailed dans l'adresse pour un autre).
   Ouverte seule, elle lit l'équipement dans l'adresse : showroom.html?frame=aero&wheels=c65&position=drops&sex=f&color=%23eb6834… */
(function () {
  'use strict';
  const B3D = window.B3D;
  const $ = (id) => document.getElementById(id);
  const V = 1;                       // version du protocole (celle de la vue pilotée)
  const LIFT = 0.04;                 // m : la roue arrière est soulevée par le home-trainer
  const TARGET = new THREE.Vector3(0, 0.95, 0.02);
  const HOME = { yaw: -1.08, pitch: 0.2, dist: 0 }; // trois quarts avant, côté transmission ; dist : cadrage automatique
  const SPEED = 9;                   // m/s simulés sur le home-trainer (≈ 32 km/h, 88 tr/min)

  const S = {
    cyclist: null,
    gear: null,
    color: '#eb6834',
    detail: 'realistic', // un seul cycliste, vu de près : le niveau de détail le plus fin
    rider: true,
    running: true,
    cam: Object.assign({}, HOME),
    want: Object.assign({}, HOME),
    idle: 0,

    init() {
      const canvas = this.canvas = $('view');
      let r;
      try {
        r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      } catch (err) {
        document.body.insertAdjacentHTML('beforeend', '<div class="msg">La 3D n\'est pas disponible dans ce navigateur (WebGL).</div>');
        this.post({ type: 'status', state: 'error', text: 'WebGL indisponible' });
        return;
      }
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      const scene = this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
      // éclairage de studio : une lumière principale qui porte l'ombre au sol, et la lumière du ciel
      const sun = new THREE.DirectionalLight('#ffffff', 2.6);
      sun.position.set(-2.2, 4.5, 2.4);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      Object.assign(sun.shadow.camera, { left: -1.4, right: 1.4, top: 1.6, bottom: -1.2, near: 0.5, far: 12 });
      sun.shadow.bias = -0.0005;
      sun.shadow.normalBias = 0.02;
      scene.add(sun, sun.target);
      sun.target.position.set(0, 0.5, 0);
      this.hemi = new THREE.HemisphereLight('#ffffff', '#b9b4a8', 1.7);
      scene.add(this.hemi);
      this.buildStudio();
      this.setBg('#ebebea', false);

      this.bindInput();
      window.addEventListener('resize', () => this.resize());
      this.resize();
      window.addEventListener('message', (e) => this.onMessage(e));
      document.addEventListener('visibilitychange', () => { this.clock.getDelta(); });
      this.clock = new THREE.Clock();
      this.host = window.parent !== window ? window.parent : window.opener;
      const q = new URLSearchParams(location.search);
      if (q.get('color')) this.color = q.get('color');
      if (q.get('bg')) this.setBg(q.get('bg'), q.get('dark') === '1');
      if (q.get('rider') === '0') this.rider = false;
      const fromUrl = {};
      for (const k of ['frame', 'wheels', 'tire', 'position', 'helmet', 'clothing', 'glasses', 'socks', 'shoes', 'sex']) if (q.get(k)) fromUrl[k] = q.get(k);
      if (B3D.Cyclist.DETAILS.includes(q.get('detail'))) this.detail = q.get('detail');
      this.setGear(Object.keys(fromUrl).length || !this.host ? Object.assign({ frame: 'alu', wheels: 'alu' }, fromUrl) : { frame: 'alu', wheels: 'alu' });
      r.setAnimationLoop(() => this.loop());
      // l'application n'écoute peut-être pas encore : on se signale jusqu'à recevoir l'équipement
      if (this.host) {
        const hello = () => { if (!this.got) { this.post({ type: 'hello', view: 'showroom' }); setTimeout(hello, 1000); } };
        hello();
      }
    },

    post(msg) {
      if (!this.host) return;
      try { this.host.postMessage(Object.assign({ pyr3d: V }, msg), '*'); } catch (e) { /* fenêtre fermée */ }
    },

    onMessage(e) {
      const m = e.data;
      if (!m || m.pyr3d !== V || typeof m.type !== 'string') return;
      if (this.host && e.source !== this.host) return;
      if (m.type === 'gear') {
        this.got = true;
        if (typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color)) this.color = m.color;
        if (typeof m.bg === 'string' && /^#[0-9a-f]{6}$/i.test(m.bg)) this.setBg(m.bg, !!m.dark);
        if (typeof m.rider === 'boolean') this.setRider(m.rider);
        this.setGear(m.gear || {});
        this.announce = true;
      } else if (m.type === 'run') {
        this.running = m.on !== false;
        this.clock.getDelta();
      }
    },

    // Fond et sol : la couleur de la page qui accueille la vitrine
    setBg(hex, dark) {
      const c = new THREE.Color(hex);
      if (this.bgHex === hex) return;
      this.bgHex = hex;
      this.scene.background = c;
      document.body.style.background = hex;
      document.body.classList.toggle('dark', !!dark);
      const floor = c.clone().offsetHSL(0, 0, dark ? 0.05 : -0.06);
      this.floor.material.color.copy(floor);
      this.floorEdge.material.color.copy(floor.clone().offsetHSL(0, 0, dark ? 0.06 : -0.08));
      this.hemi.groundColor.copy(floor);
    },

    // Studio : un disque au sol, le home-trainer (pieds, rouleau et bloc de résistance) et la cale de la roue avant
    buildStudio() {
      const { mat, addOutline } = B3D.toon;
      const scene = this.scene;
      this.floor = new THREE.Mesh(new THREE.CircleGeometry(1.45, 72), new THREE.MeshToonMaterial({ color: '#dcdcda', gradientMap: B3D.toon.gradientMap() }));
      this.floor.rotation.x = -Math.PI / 2;
      this.floor.receiveShadow = true;
      scene.add(this.floor);
      this.floorEdge = new THREE.Mesh(new THREE.RingGeometry(1.45, 1.5, 72), new THREE.MeshBasicMaterial({ color: '#cfcfcc' }));
      this.floorEdge.rotation.x = -Math.PI / 2;
      this.floorEdge.position.y = 0.001;
      scene.add(this.floorEdge);
      const g = this.trainer = new THREE.Group();
      scene.add(g);
      const dark = mat('#2f2e36'), accent = mat('#2a78d6'), metal = mat('#c9ced8');
      const UP = new THREE.Vector3(0, 1, 0);
      const tube = (a, b, r, m) => {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 8), m);
        mesh.position.copy(a).add(b).multiplyScalar(0.5);
        mesh.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
        mesh.castShadow = true;
        g.add(mesh);
        addOutline(mesh, { width: 0.7, minW: 0.004, maxW: 0.03 });
        return mesh;
      };
      const P = (x, y, z) => new THREE.Vector3(x, y, z);
      const ay = 0.34 + LIFT, az = -0.5;
      for (const sx of [-1, 1]) {
        tube(P(sx * 0.075, ay, az), P(sx * 0.12, ay, az), 0.018, metal); // cônes de serrage de l'axe
        tube(P(sx * 0.12, ay, az), P(sx * 0.3, 0.02, az + 0.16), 0.016, dark);
        tube(P(sx * 0.12, ay, az), P(sx * 0.3, 0.02, az - 0.2), 0.016, dark);
        tube(P(sx * 0.3, 0.02, az + 0.16), P(sx * 0.3, 0.02, az - 0.2), 0.016, dark);
      }
      tube(P(-0.3, 0.02, az - 0.2), P(0.3, 0.02, az - 0.2), 0.016, dark);
      // rouleau contre le pneu, derrière le point bas de la roue, et le bloc de résistance
      const a = 0.38, rr = 0.34 + 0.028;
      const ry = ay - Math.cos(a) * rr, rz = az - Math.sin(a) * rr;
      tube(P(-0.05, ry, rz), P(0.05, ry, rz), 0.028, metal);
      tube(P(0.05, ry, rz), P(0.11, ry, rz), 0.01, dark);
      const unit = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 20), accent);
      unit.rotation.z = Math.PI / 2;
      unit.position.set(0.14, ry, rz);
      unit.castShadow = true;
      g.add(unit);
      addOutline(unit, { width: 0.7, minW: 0.004, maxW: 0.03 });
      tube(P(0.14, ry - 0.06, rz), P(0.3, 0.02, az - 0.2), 0.012, dark);
      tube(P(-0.05, ry, rz), P(-0.3, 0.02, az - 0.2), 0.012, dark);
      // cale de la roue avant (la roue reste à la même hauteur que l'arrière)
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.15, LIFT, 0.26), dark);
      block.position.set(0, LIFT / 2, 0.57);
      block.castShadow = true;
      block.receiveShadow = true;
      g.add(block);
      addOutline(block, { width: 0.7, minW: 0.004, maxW: 0.03 });
    },

    // (Re)construit le cycliste équipé ; le coup de pédale continue là où il en était
    setGear(gear) {
      const G = B3D.Cyclist.normGear(Object.assign({}, gear));
      const key = JSON.stringify(G) + this.color + this.detail;
      if (key === this.gearKey) return;
      this.gearKey = key;
      this.gear = G;
      const old = this.cyclist;
      const c = this.cyclist = new B3D.Cyclist({ gear: G, detail: this.detail, custom: { name: 'PaceYourRide', base: this.color, accent: '#1d1a2b', style: 'stripe' } });
      c.root.position.y = LIFT;
      if (old) {
        c.crank = old.crank; c.wheelAngle = old.wheelAngle; c.time = old.time;
        this.scene.remove(old.root);
        old.dispose();
      }
      c.setRiderVisible(this.rider);
      this.scene.add(c.root);
      c.update(0, { speed: SPEED, pedaling: true, standing: false, tuck: false, steer: 0 });
      if (!this.cam.dist) this.frame();
    },

    setRider(on) {
      this.rider = !!on;
      if (this.cyclist) this.cyclist.setRiderVisible(this.rider);
      $('btn-rider').setAttribute('aria-pressed', String(this.rider));
    },

    // Distance de départ : le vélo et le cycliste tiennent dans l'image, quelles que soient ses proportions
    frame() {
      const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
      const d = Math.max(2.1 / (2 * t), 2.1 / (2 * t * this.camera.aspect)) * 1.04;
      HOME.dist = d;
      this.want.dist = this.cam.dist = d;
    },

    resize() {
      const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      B3D.toon.shared.uOutlineScale.value = 1.7 * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) / h;
      const reset = Math.abs(this.want.dist - HOME.dist) < 1e-6;
      this.frame();
      if (!reset) this.want.dist = this.cam.dist;
    },

    reset() {
      Object.assign(this.want, HOME);
      // revenir par le plus court chemin
      while (this.cam.yaw - this.want.yaw > Math.PI) this.cam.yaw -= Math.PI * 2;
      while (this.want.yaw - this.cam.yaw > Math.PI) this.cam.yaw += Math.PI * 2;
      this.idle = -2;
    },

    // Caméra en orbite : glisser (un doigt ou la souris), molette ou pincement, double-clic / double tape
    bindInput() {
      const cv = this.canvas, pts = new Map();
      let pinch = 0, lastTap = 0;
      const touched = () => { this.idle = 0; $('hint').classList.add('off'); };
      cv.addEventListener('pointerdown', (e) => {
        cv.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        cv.classList.add('drag');
        if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
        const now = performance.now();
        if (e.pointerType !== 'mouse' && pts.size === 1 && now - lastTap < 320) this.reset(); // double tape d'un doigt
        lastTap = now;
        touched();
      });
      cv.addEventListener('pointermove', (e) => {
        const p = pts.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        if (pts.size === 1) {
          const k = 5 / Math.max(300, cv.clientWidth);
          this.want.yaw -= dx * k;
          this.want.pitch = THREE.MathUtils.clamp(this.want.pitch + dy * k * 0.8, -0.05, 1.25);
        } else if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch > 0 && d > 0) this.zoom(pinch / d);
          pinch = d;
        }
        touched();
      });
      const up = (e) => {
        pts.delete(e.pointerId);
        if (pts.size < 2) pinch = 0;
        if (!pts.size) cv.classList.remove('drag');
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(Math.exp(e.deltaY * 0.0012)); touched(); }, { passive: false });
      cv.addEventListener('dblclick', () => this.reset());
      cv.addEventListener('keydown', (e) => {
        const k = { ArrowLeft: [0.25, 0], ArrowRight: [-0.25, 0], ArrowUp: [0, 0.12], ArrowDown: [0, -0.12] }[e.key];
        if (k) { this.want.yaw += k[0]; this.want.pitch = THREE.MathUtils.clamp(this.want.pitch + k[1], -0.05, 1.25); touched(); e.preventDefault(); }
        else if (e.key === '+' || e.key === '=') { this.zoom(0.85); touched(); }
        else if (e.key === '-') { this.zoom(1.18); touched(); }
        else if (e.key === 'Home' || e.key === '0') this.reset();
      });
      $('btn-reset').addEventListener('click', () => this.reset());
      $('btn-rider').addEventListener('click', () => this.setRider(!this.rider));
    },

    zoom(f) {
      this.want.dist = THREE.MathUtils.clamp(this.want.dist * f, 1.1, Math.max(4, HOME.dist * 1.8));
    },

    loop() {
      const raw = this.clock.getDelta();
      if (!this.running || !this.cyclist) return;
      const dt = Math.min(0.05, raw);
      B3D.toon.shared.uTime.value += dt;
      const c = this.cyclist;
      c.update(dt, { speed: SPEED, pedaling: true, standing: false, tuck: false, steer: 0 });
      c.wheels[1].rotation.x = 0; // sur le home-trainer, la roue avant ne tourne pas
      // la caméra tourne doucement quand on ne la touche pas ; elle rejoint le geste en douceur
      this.idle += dt;
      if (this.idle > 4) this.want.yaw -= dt * 0.22 * Math.min(1, (this.idle - 4) / 2);
      const k = 1 - Math.exp(-dt * 10);
      for (const f of ['yaw', 'pitch', 'dist']) this.cam[f] += (this.want[f] - this.cam[f]) * k;
      const C = this.cam, cp = Math.cos(C.pitch);
      this.camera.position.set(TARGET.x + Math.sin(C.yaw) * cp * C.dist, TARGET.y + Math.sin(C.pitch) * C.dist, TARGET.z + Math.cos(C.yaw) * cp * C.dist);
      this.camera.lookAt(TARGET);
      this.renderer.render(this.scene, this.camera);
      if (this.announce) { this.announce = false; this.post({ type: 'status', state: 'ready' }); }
    }
  };

  B3D.showroom = S;
  S.init();
})();
