/* Bike3D — atmosphère : heure de la journée (aube, matin, midi, après-midi, soir, nuit) avec le soleil, la lune
   et les étoiles, météo (soleil, nuageux, pluie, orage) qui évolue avec des transitions douces, vent
   (vitesse, direction, rafales), pluie, route mouillée, éclairs et tonnerre. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};
  const { mulberry32, clamp, lerp, smoothstep } = B3D.util;
  const DEG = Math.PI / 180;

  // Paramètres de chaque temps : couverture nuageuse, assombrissement, pluie, orage, visibilité, force du vent.
  const PRESETS = {
    soleil: { cloud: 0.1, dark: 0, rain: 0, storm: 0, fog: 1, wind: 1, name: 'Grand soleil', icon: '☀️' },
    nuageux: { cloud: 0.72, dark: 0.18, rain: 0, storm: 0, fog: 0.85, wind: 1.15, name: 'Nuageux', icon: '⛅' },
    pluie: { cloud: 0.96, dark: 0.45, rain: 0.75, storm: 0, fog: 0.6, wind: 1.3, name: 'Pluie', icon: '🌧️' },
    orage: { cloud: 1, dark: 0.78, rain: 1, storm: 1, fog: 0.48, wind: 1.75, name: 'Orage', icon: '⛈️' }
  };
  const KEYS = ['cloud', 'dark', 'rain', 'storm', 'fog', 'wind'];
  // météo variable : vers quel temps on peut évoluer
  const NEXT = { soleil: [['nuageux', 1]], nuageux: [['soleil', 1.2], ['pluie', 1]], pluie: [['nuageux', 1.3], ['orage', 0.7]], orage: [['pluie', 1]] };
  // vent moyen (m/s)
  const WIND = { calme: 0.6, brise: 3.6, fort: 7, tempete: 11 };
  // lever, coucher (heures) et hauteur du soleil à midi selon la saison
  const SEASON = {
    printemps: { rise: 6.75, set: 20.25, max: 55, az: 72 },
    ete: { rise: 6.0, set: 21.5, max: 64, az: 55 },
    automne: { rise: 7.75, set: 19.0, max: 36, az: 105 },
    soir: { rise: 6.0, set: 21.5, max: 64, az: 55 }
  };
  const FLOWS = [0, 30, 300];

  const C = (h) => new THREE.Color(h);
  const COL = {
    nightTop: C('#040917'), nightHor: C('#141d40'), twiTop: C('#24346e'), twiHor: C('#5a4f8a'),
    goldTop: C('#4f63b0'), goldHor: C('#ffa36b'), goldSun: C('#ff9a55'),
    overTop: C('#9ba5b2'), overHor: C('#c4c9cf'), stormTop: C('#3d4350'), stormHor: C('#5d6470'),
    moon: C('#a9bcff'), nightHemi: C('#2e3b6e'), nightGround: C('#1a2030'), overHemi: C('#c8ced6'),
    cloudDay: C('#ffffff'), cloudGold: C('#ffc6a0'), cloudNight: C('#2c3550'), cloudStorm: C('#59606d'),
    cloudDayDark: C('#aeb7c6'), cloudStormDark: C('#30353f'), white: C('#ffffff'), black: C('#000000'),
    nightTint: C('#3b4568'), sunWhite: C('#fff8e0'),
    stormHemi: C('#7f8898'), cloudLine: C('#5d6c8a'), cloudLineNight: C('#0b1022'), cloudLineStorm: C('#262a33')
  };

  // --- dôme du ciel : dégradé, soleil, lune, étoiles, couche nuageuse qui défile avec le vent, éclairs
  function domeMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() }, uSunVis: { value: 1 },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) }, uMoonVis: { value: 0 }, uStars: { value: 0 },
        uCover: { value: 0 }, uCloudLit: { value: new THREE.Color() }, uCloudDark: { value: new THREE.Color() },
        uCloudOff: { value: new THREE.Vector2() }, uFlash: { value: 0 }, uTime: B3D.toon.shared.uTime
      },
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: [
        'uniform vec3 uTop, uHorizon, uGround, uSunDir, uSunColor, uMoonDir, uCloudLit, uCloudDark;',
        'uniform float uSunVis, uMoonVis, uStars, uCover, uFlash, uTime;',
        'uniform vec2 uCloudOff;',
        'varying vec3 vDir;',
        'float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
        'float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);',
        '  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }',
        'float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s / 0.9375; }',
        'void main() {',
        '  vec3 d = normalize(vDir);',
        '  float e = d.y;',
        '  vec3 c = e > 0.0 ? mix(uHorizon, uTop, smoothstep(0.0, 0.5, pow(e, 0.8))) : uGround;',
        // étoiles qui scintillent
        '  if (uStars > 0.01 && e > 0.0) {',
        '    vec2 g = vec2(atan(d.z, d.x) * 150.0, acos(clamp(d.y, -1.0, 1.0)) * 150.0);',
        '    float h = h21(floor(g));',
        '    float star = step(0.9962, h) * (1.0 - smoothstep(0.08, 0.42, length(fract(g) - 0.5)));',
        '    star *= 0.65 + 0.35 * sin(uTime * (1.5 + h * 6.0) + h * 50.0);',
        '    c += vec3(star) * uStars * smoothstep(0.0, 0.2, e);',
        '  }',
        // soleil (halo plus large près de l'horizon) et lune
        '  float s = dot(d, normalize(uSunDir));',
        '  float halo = mix(0.97, 0.99, smoothstep(0.0, 0.4, uSunDir.y));',
        '  c = mix(c, mix(c, uSunColor, 0.5), smoothstep(halo, 0.997, s) * uSunVis);',
        '  c = mix(c, uSunColor, step(0.9986, s) * uSunVis);',
        '  float m = dot(d, normalize(uMoonDir));',
        '  c += vec3(0.05, 0.06, 0.09) * smoothstep(0.993, 0.9994, m) * uMoonVis;',
        '  c = mix(c, vec3(0.92, 0.91, 0.84), step(0.99945, m) * uMoonVis);',
        // couche nuageuse
        '  if (uCover > 0.02 && e > -0.05) {',
        '    vec2 uv = d.xz / (max(e, 0.0) + 0.14) * 0.75 + uCloudOff;',
        '    float n = fbm(uv);',
        '    float thr = 1.02 - uCover * 0.95;',
        '    float k = smoothstep(thr, thr + 0.1, n);',
        '    float sh = smoothstep(thr + 0.08, thr + 0.32, n);',
        '    vec3 cc = mix(uCloudLit, uCloudDark, sh * 0.75);',
        '    float hz = smoothstep(0.0, 0.22, e);',
        '    k = mix(uCover * 0.9, k, hz);',
        '    c = mix(c, cc, k);',
        '  }',
        '  c += vec3(0.85, 0.88, 1.0) * uFlash * (0.4 + 0.6 * uCover);',
        '  gl_FragColor = vec4(c, 1.0);',
        '  #include <colorspace_fragment>',
        '}'
      ].join('\n'),
      side: THREE.BackSide, depthWrite: false, fog: false
    });
  }

  // --- pluie : segments animés entièrement dans le shader, dans une boîte qui suit la caméra
  function rainMesh(count) {
    const seeds = new Float32Array(count * 2 * 3), ends = new Float32Array(count * 2);
    const rnd = mulberry32(77);
    for (let i = 0; i < count; i++) {
      const x = rnd(), y = rnd(), z = rnd();
      for (let k = 0; k < 2; k++) { seeds.set([x, y, z], (i * 2 + k) * 3); ends[i * 2 + k] = k; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    g.setDrawRange(0, 0);
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(36, 22, 36) },
        uFall: { value: new THREE.Vector3(0, -9, 0) }, uLen: { value: 0.55 }, uAlpha: { value: 0.5 }, uColor: { value: new THREE.Color('#c4d2e4') }
      },
      vertexShader: [
        'attribute float aEnd;',
        'uniform float uTime, uLen; uniform vec3 uCenter, uBox, uFall;',
        'varying float vA;',
        'void main() {',
        '  vec3 p = position * uBox + uFall * uTime;',
        '  vec3 rel = mod(p - uCenter, uBox) - 0.5 * uBox;',
        '  vec3 w = uCenter + rel - normalize(uFall) * uLen * aEnd;',
        '  vA = 1.0 - smoothstep(0.3, 0.5, length(rel.xz) / uBox.x);',
        '  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: 'uniform vec3 uColor; uniform float uAlpha; varying float vA; void main() { gl_FragColor = vec4(uColor, uAlpha * vA); }',
      transparent: true, depthWrite: false, fog: false
    });
    const mesh = new THREE.LineSegments(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    mesh.userData.count = count;
    return mesh;
  }

  class Atmosphere {
    // ctx : { scene, sky, sun, hemi, fog, quality }, settings : { hour, weather, wind, timeFlow }
    constructor(ctx, L, settings) {
      this.scene = ctx.scene;
      this.sky = ctx.sky;
      this.sun = ctx.sun;
      this.hemi = ctx.hemi;
      this.fog = ctx.fog;
      this.L = L;
      this.amb = L.amb;
      this.season = SEASON[L.amb.id] || SEASON.ete;
      const rnd = this.rnd = mulberry32(L.seed ^ 0xa7305);
      this.fogNear = 150; this.fogFar = 650;
      // heure de départ : réglée par le joueur, sinon tirée au sort (fin de journée pour l'ambiance « soir »)
      this.hour = typeof settings.hour === 'number' ? settings.hour : L.amb.id === 'soir' ? 19.0 + rnd() * 0.75 : 8.5 + rnd() * 9;
      this.flow = settings.timeFlow !== undefined ? settings.timeFlow : 30;
      // météo
      this.mode = settings.weather || 'variable';
      const first = this.mode === 'variable' ? this._pick([['soleil', 4], ['nuageux', 3], ['pluie', 1.6], ['orage', 0.8]]) : this.mode;
      this.state = first;
      this.cur = Object.assign({}, PRESETS[first]);
      this.tgt = PRESETS[first];
      this.nextChange = 90 + rnd() * 150;
      // vent : direction tirée au sort, force réglable, rafales
      this.windLevel = settings.wind && settings.wind !== 'auto' ? settings.wind : this._pick([['calme', 2], ['brise', 4], ['fort', 2.5], ['tempete', 0.6]]);
      this.windBase = WIND[this.windLevel];
      this.windDir0 = rnd() * Math.PI * 2; // direction vers laquelle souffle le vent
      this.windDir = this.windDir0;
      this.wind = { x: 0, z: 0, speed: 0, dir: this.windDir };
      this.gustT = rnd() * 100;
      this.wet = this.cur.rain > 0.2 ? 1 : 0;
      this.flash = 0;
      this.nextBolt = 6;
      this.onThunder = null;
      this.time = 0;
      // vecteurs exposés
      this.sunDir = new THREE.Vector3();
      this.moonDir = new THREE.Vector3();
      this.lightDir = new THREE.Vector3(0, 1, 0);
      this.dayK = 1; this.nightK = 0; this.goldK = 0;
      this.basicMats = [];
      this.tint = new THREE.Color(1, 1, 1);
      // ciel : on remplace le dôme et on récupère les nuages et les montagnes
      const sky = this.sky;
      this.dome = sky.dome;
      this.dome.material.dispose();
      this.dome.material = domeMaterial();
      this.U = this.dome.material.uniforms;
      this.cloudMat = sky.clouds.length ? sky.clouds[0].material : null;
      this.cloudOutline = sky.clouds.length && sky.clouds[0].children[0] ? sky.clouds[0].children[0].material : null;
      this.mountainMats = [];
      sky.mountains.traverse((o) => { if (o.material) this.mountainMats.push(o.material); });
      // pluie et éclair
      const q = ctx.quality || 'medium';
      this.rain = rainMesh({ low: 2600, medium: 4500, high: 7000 }[q] || 4500);
      this.scene.add(this.rain);
      this.bolt = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: '#f4f2ff', fog: false, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      this.bolt.frustumCulled = false;
      this.bolt.visible = false;
      this.bolt.renderOrder = 7;
      this.scene.add(this.bolt);
      this._c1 = new THREE.Color(); this._c2 = new THREE.Color(); this._c3 = new THREE.Color();
      this.update(0, 0, null);
    }

    _pick(list) {
      let tot = 0;
      for (const [, w] of list) tot += w;
      let r = this.rnd() * tot;
      for (const [k, w] of list) { r -= w; if (r <= 0) return k; }
      return list[list.length - 1][0];
    }

    // ------------------------------------------------------------ réglages
    setHour(h) { this.hour = ((h % 24) + 24) % 24; }
    setFlow(f) { this.flow = f; }
    setFogBase(near, far) { this.fogNear = near; this.fogFar = far; }

    setWeather(mode) {
      this.mode = mode;
      if (mode !== 'variable') { this.state = mode; this.tgt = PRESETS[mode]; }
      else this.nextChange = 60 + this.rnd() * 90;
    }

    setWind(level) {
      this.windLevel = level === 'auto' ? this.windLevel : level;
      this.windTarget = WIND[this.windLevel];
    }

    // panneaux et textes à fond blanc (non éclairés) : assombris la nuit
    registerBasic(root) {
      if (!root) return;
      root.traverse((o) => {
        const m = o.material;
        if (m && m.isMeshBasicMaterial && m.map && !this.basicMats.includes(m)) this.basicMats.push(m);
      });
    }

    // ------------------------------------------------------------ soleil
    _sun(h) {
      const S = this.season;
      const dayLen = S.set - S.rise;
      let elev, az;
      if (h >= S.rise && h <= S.set) {
        const u = (h - S.rise) / dayLen;
        elev = S.max * Math.sin(Math.PI * u);
        az = lerp(S.az, 360 - S.az, u);
      } else {
        const nightLen = 24 - dayLen;
        const u = (((h - S.set) % 24) + 24) % 24 / nightLen;
        elev = -32 * Math.sin(Math.PI * u);
        az = lerp(360 - S.az, 360 + S.az, u);
      }
      const e = elev * DEG, a = az * DEG;
      // nord = -z, est = +x
      this.sunDir.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
      this.moonDir.set(-this.sunDir.x * 0.9, Math.max(0.15, -this.sunDir.y), -this.sunDir.z * 0.9).normalize();
      return elev;
    }

    period() {
      const h = this.hour, e = this.elev;
      if (e > -6 && e < 5) return h < 12 ? 'lever du soleil' : 'coucher du soleil';
      if (e <= -6) return 'nuit';
      if (h < 11) return 'matin';
      if (h < 14) return 'midi';
      if (h < 18) return 'après-midi';
      return 'soir';
    }

    clock() {
      const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }

    info() {
      const P = PRESETS[this.state];
      return {
        clock: this.clock(), period: this.period(), icon: this.elev < -3 && (this.state === 'soleil' || this.state === 'nuageux') ? (this.state === 'soleil' ? '🌙' : '☁️') : P.icon, name: P.name,
        windKmh: Math.round(this.wind.speed * 3.6), windLevel: this.windLevel, mode: this.mode
      };
    }

    // ------------------------------------------------------------ mise à jour
    // dt : temps de course (heure, météo, vent) ; dtReal : temps réel (éclairs) ; camera : pour la pluie
    update(dt, dtReal, camera) {
      this.time += dt;
      const rnd = this.rnd;
      // heure
      if (this.flow) this.setHour(this.hour + dt * this.flow / 3600);
      const elev = this.elev = this._sun(this.hour);
      // météo variable : on change de temps de temps en temps
      if (this.mode === 'variable') {
        this.nextChange -= dt;
        if (this.nextChange <= 0) {
          const from = this.state;
          this.state = this._pick(NEXT[this.state]);
          this.changed = { from, to: this.state };
          this.tgt = PRESETS[this.state];
          this.nextChange = 150 + rnd() * 240;
        }
      }
      // transitions douces entre deux temps (constante de temps ~25 s)
      const k = 1 - Math.exp(-dt / 25);
      for (const key of KEYS) this.cur[key] += (this.tgt[key] - this.cur[key]) * k;
      const W = this.cur;
      // vent : force cible, rafales, direction qui tourne lentement
      if (this.windTarget !== undefined) { this.windBase += (this.windTarget - this.windBase) * (1 - Math.exp(-dt / 8)); }
      this.gustT += dt * (0.35 + 0.5 * W.storm);
      const gust = Math.sin(this.gustT * 1.3) * 0.5 + Math.sin(this.gustT * 2.9 + 1.7) * 0.3 + Math.sin(this.gustT * 0.47 + 4) * 0.2;
      const speed = Math.max(0, this.windBase * W.wind * (1 + (0.22 + 0.25 * W.storm) * gust));
      this.windDir = this.windDir0 + 0.35 * Math.sin(this.time * 0.004 + 1) + 0.08 * Math.sin(this.gustT * 0.7);
      this.wind.speed = speed; this.wind.dir = this.windDir;
      this.wind.x = Math.sin(this.windDir) * speed; this.wind.z = Math.cos(this.windDir) * speed;
      // route mouillée : vite sous la pluie, sèche lentement
      const wetT = W.rain > 0.2 ? 1 : 0;
      this.wet += (wetT - this.wet) * (1 - Math.exp(-dt / (wetT ? 20 : 150)));
      // la couche nuageuse défile avec le vent
      this.U.uCloudOff.value.x -= this.wind.x * dtReal * 0.0012;
      this.U.uCloudOff.value.y -= this.wind.z * dtReal * 0.0012;
      this._light(elev, W);
      this._rain(dt, dtReal, camera, W);
      this._storm(dtReal, camera, W);
      // partagés avec les matériaux (végétation, eau, route, terrain)
      const sh = B3D.toon.shared;
      sh.uWind.value.set(Math.sin(this.windDir), Math.cos(this.windDir), clamp(speed / 10, 0, 1.6));
      sh.uWet.value = this.wet;
      // lumières (fenêtres, lampadaires, phares) : dès le crépuscule, et dans l'obscurité d'un orage
      this.lampK = clamp(clamp((0.62 - this.dayK) / 0.4, 0, 1) + 0.6 * W.dark * W.rain, 0, 1);
      sh.uNight.value = this.lampK;
      sh.uSkyTint.value.copy(this.tint);
      if (this.sky) this.sky.wind.set(Math.sin(this.windDir), 0, Math.cos(this.windDir)).multiplyScalar(6 + speed * 3);
    }

    _light(elev, W) {
      const amb = this.amb, U = this.U, c = W.cloud, dark = W.dark;
      const dayK = this.dayK = smoothstep(-9, 7, elev);
      const sunK = smoothstep(-1.5, 9, elev);
      const goldK = this.goldK = smoothstep(-5, 2, elev) * (1 - smoothstep(4, 20, elev));
      const nightK = this.nightK = 1 - smoothstep(-11, -3, elev);
      const twiK = smoothstep(-9, -1, elev) * (1 - smoothstep(-1, 6, elev));
      const c1 = this._c1, c2 = this._c2, c3 = this._c3;
      // ciel : nuit -> crépuscule -> jour, teinte dorée au lever et au coucher, puis voile gris des nuages
      const top = U.uTop.value, hor = U.uHorizon.value;
      top.copy(COL.nightTop).lerp(c1.set(amb.sky.top), dayK).lerp(COL.twiTop, twiK * 0.6).lerp(COL.goldTop, goldK * 0.45);
      hor.copy(COL.nightHor).lerp(c1.set(amb.sky.horizon), dayK).lerp(COL.twiHor, twiK * 0.5).lerp(COL.goldHor, goldK * 0.85);
      const level = 0.12 + 0.88 * dayK; // luminosité générale du ciel
      c2.copy(COL.overTop).lerp(COL.stormTop, dark).multiplyScalar(level);
      c3.copy(COL.overHor).lerp(COL.stormHor, dark).multiplyScalar(level);
      top.lerp(c2, c * 0.85);
      hor.lerp(c3, c * 0.8);
      U.uGround.value.copy(hor).multiplyScalar(0.92);
      // soleil, lune, étoiles
      U.uSunDir.value.copy(this.sunDir);
      U.uSunColor.value.copy(COL.sunWhite).lerp(COL.goldSun, goldK);
      U.uSunVis.value = smoothstep(-3, 1, elev) * (1 - smoothstep(0.45, 0.85, c));
      U.uMoonDir.value.copy(this.moonDir);
      U.uMoonVis.value = nightK * (1 - smoothstep(0.5, 0.9, c));
      U.uStars.value = nightK * (1 - smoothstep(0.2, 0.75, c));
      // nuages
      U.uCover.value = smoothstep(0.15, 1, c) * 0.98 + 0.02 * c;
      const lit = U.uCloudLit.value, drk = U.uCloudDark.value;
      lit.copy(COL.cloudNight).lerp(COL.cloudDay, dayK).lerp(COL.cloudGold, goldK * 0.6).lerp(COL.cloudStorm, dark * dayK);
      drk.copy(COL.cloudNight).multiplyScalar(0.6).lerp(COL.cloudDayDark, dayK).lerp(COL.cloudStormDark, dark);
      U.uFlash.value = this.flash;
      // lumière directe : soleil le jour, lune la nuit (la bascule a lieu quand les deux sont faibles)
      const sun = this.sun;
      if (elev > -2.5) {
        this.lightDir.copy(this.sunDir);
        if (this.lightDir.y < 0.04) this.lightDir.y = 0.04;
        sun.color.set(amb.sun.color).lerp(COL.goldSun, goldK * 0.8);
        sun.intensity = amb.sun.intensity * sunK * (1 - 0.8 * c) * (1 - 0.35 * dark);
      } else {
        this.lightDir.copy(this.moonDir);
        sun.color.copy(COL.moon);
        sun.intensity = 0.6 * nightK * (1 - 0.75 * c);
      }
      this.lightDir.normalize();
      // lumière du ciel : plus diffuse sous les nuages, bleutée la nuit, flash des éclairs
      const hemi = this.hemi;
      hemi.color.copy(COL.nightHemi).lerp(c1.set(amb.hemi.sky), dayK).lerp(COL.goldHor, goldK * 0.25).lerp(COL.overHemi, c * 0.6 * dayK);
      hemi.groundColor.copy(COL.nightGround).lerp(c1.set(amb.hemi.ground), dayK);
      hemi.color.lerp(COL.stormHemi, dark * 0.6 * dayK);
      hemi.intensity = lerp(0.55, amb.hemi.intensity, dayK) * (1 + 0.15 * c * (1 - dark) * dayK) * (1 - 0.6 * dark * dayK) + this.flash * 3.5;
      // brouillard : couleur de l'horizon, plus proche sous la pluie
      this.fog.color.copy(hor).lerp(c1.set(amb.sky.fog).multiplyScalar(level), 0.25 * (1 - c)).multiplyScalar(1 - 0.3 * dark);
      const fk = W.fog * (1 - 0.15 * nightK);
      this.fog.near = this.fogNear * fk;
      this.fog.far = this.fogFar * (0.35 + 0.65 * fk);
      // nuages 3D : couleur et nombre selon la couverture
      if (this.cloudMat) {
        this.cloudMat.color.copy(lit);
        this.cloudMat.emissive.copy(drk).multiplyScalar(0.55);
      }
      if (this.cloudOutline) this.cloudOutline.uniforms.uColor.value.copy(COL.cloudLineNight).lerp(COL.cloudLine, dayK).lerp(COL.cloudLineStorm, dark * dayK);
      const clouds = this.sky ? this.sky.clouds : [];
      for (let i = 0; i < clouds.length; i++) {
        const t = i / clouds.length;
        const a = clamp((0.3 + c * 0.9 - t) * 4, 0, 1);
        clouds[i].visible = a > 0.01;
        clouds[i].scale.setScalar(0.3 + 0.7 * a);
      }
      // montagnes lointaines, panneaux non éclairés, eau : teinte d'ensemble
      this.tint.copy(COL.nightTint).lerp(COL.white, 0.25 + 0.75 * dayK).multiplyScalar(1 - 0.3 * dark * dayK);
      for (const m of this.mountainMats) m.color.copy(this.tint);
      for (const m of this.basicMats) m.color.copy(this.tint);
    }

    _rain(dt, dtReal, camera, W) {
      const r = this.rain, u = r.material.uniforms;
      const n = Math.round(r.userData.count * clamp(W.rain, 0, 1));
      r.visible = n > 20;
      if (!r.visible) return;
      r.geometry.setDrawRange(0, n * 2);
      u.uTime.value += dtReal;
      if (camera) camera.getWorldPosition(u.uCenter.value);
      u.uFall.value.set(this.wind.x * 0.85, -9 - 2 * W.storm, this.wind.z * 0.85);
      u.uAlpha.value = (0.28 + 0.25 * W.rain) * (0.45 + 0.55 * this.dayK) + this.flash * 0.5;
      u.uColor.value.copy(COL.white).lerp(this.hemi.color, 0.5);
    }

    // éclairs : flash du ciel et de la lumière, arc électrique au loin, tonnerre retardé selon la distance
    _storm(dtReal, camera, W) {
      if (this.flashT !== undefined) {
        this.flashT += dtReal;
        const t = this.flashT;
        this.flash = t < 0.07 ? 1 : t < 0.13 ? 0.15 : t < 0.2 ? 0.75 : Math.max(0, 0.75 * (1 - (t - 0.2) / 0.3));
        this.bolt.visible = t < 0.24 && (t < 0.07 || t > 0.13);
        if (t > 0.5) { this.flashT = undefined; this.flash = 0; this.bolt.visible = false; }
      }
      if (W.storm < 0.45 || !camera) return;
      this.nextBolt -= dtReal;
      if (this.nextBolt > 0) return;
      this.nextBolt = (4 + this.rnd() * 10) / W.storm;
      const rnd = this.rnd;
      const P = camera.getWorldPosition(this._cp || (this._cp = new THREE.Vector3()));
      const ang = rnd() * Math.PI * 2, dist = 280 + rnd() * 1100;
      const x = P.x + Math.cos(ang) * dist, z = P.z + Math.sin(ang) * dist;
      const y0 = this.L.heightAt(x, z), y1 = y0 + 380 + rnd() * 160;
      // arc en zigzag (deux rubans croisés)
      const pos = [], idx = [];
      let px = x, pz = z;
      const steps = 16, wdt = 2.2 + dist * 0.004;
      const pts = [];
      for (let k = 0; k <= steps; k++) {
        const y = lerp(y1, y0, k / steps);
        pts.push([px, y, pz]);
        px += (rnd() - 0.5) * 38; pz += (rnd() - 0.5) * 38;
      }
      for (const [ox, oz] of [[1, 0], [0, 1]]) {
        const b = pos.length / 3;
        pts.forEach(([a, y, c]) => { pos.push(a - ox * wdt, y, c - oz * wdt, a + ox * wdt, y, c + oz * wdt); });
        for (let k = 0; k < steps; k++) { const i = b + k * 2; idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      this.bolt.geometry.dispose();
      this.bolt.geometry = g;
      this.flashT = 0;
      if (this.onThunder) {
        // direction pour le son stéréo, retard du tonnerre (vitesse du son)
        this.onThunder({ dist, delay: Math.min(6, dist / 343), x, z });
      }
    }

    dispose() {
      this.scene.remove(this.rain);
      this.rain.geometry.dispose(); this.rain.material.dispose();
      this.scene.remove(this.bolt);
      this.bolt.geometry.dispose(); this.bolt.material.dispose();
      for (const m of this.basicMats) m.color.set('#ffffff');
      const sh = B3D.toon.shared;
      sh.uWind.value.set(0, 1, 0); sh.uWet.value = 0; sh.uNight.value = 0; sh.uSkyTint.value.set('#ffffff');
    }
  }

  Atmosphere.PRESETS = PRESETS;
  Atmosphere.WIND = WIND;
  Atmosphere.FLOWS = FLOWS;
  B3D.Atmosphere = Atmosphere;
})(typeof window !== 'undefined' ? window : globalThis);
