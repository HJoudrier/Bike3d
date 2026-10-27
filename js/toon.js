/* Bike3D — rendu cartoon : matériaux toon, contours "inverted hull", fusion de géométries. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};

  // Uniformes partagés par tous les matériaux animés / contours.
  const shared = {
    uTime: { value: 0 },
    uOutlineScale: { value: 0.0022 }, // épaisseur (m) par mètre de distance à la caméra
    uRider: { value: new THREE.Vector3(0, -1e5, 0) } // position du coureur (le public s'excite à son passage)
  };

  // --- Animation du public : chaque spectateur applaudit, lève les bras ou fait coucou.
  // Les bras sont modélisés tendus vers l'avant (+z) depuis l'épaule ; l'attribut armSide vaut -1/+1 sur les bras.
  const PEOPLE_PARS = [
    'attribute float armSide;',
    'uniform vec3 uRider;',
    'mat3 b3dRotX(float a){ float c = cos(a), s = sin(a); return mat3(1.0,0.0,0.0, 0.0,c,s, 0.0,-s,c); }',
    'mat3 b3dRotY(float a){ float c = cos(a), s = sin(a); return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c); }',
    'mat3 b3dRotZ(float a){ float c = cos(a), s = sin(a); return mat3(c,s,0.0, -s,c,0.0, 0.0,0.0,1.0); }'
  ].join('\n');
  const PEOPLE_SETUP = [
    'mat3 armM = mat3(1.0);',
    'vec3 armPiv = vec3(0.27 * armSide, 1.42, 0.0);',
    'float jump = 0.0;',
    '#ifdef USE_INSTANCING',
    '{',
    '  vec3 ip = instanceMatrix[3].xyz;',
    '  float ph = ip.x * 0.37 + ip.z * 0.23;',
    '  float kind = floor(fract(ph * 0.618) * 3.0);',
    '  float ex = 1.0 - smoothstep(10.0, 45.0, distance(ip, uRider));',
    '  float t = uTime * (1.0 + 0.6 * ex) + ph;',
    '  if (armSide != 0.0) {',
    '    if (kind < 0.5) {',
    '      float a = 0.27 + (0.12 + 0.05 * ex) * sin(t * (13.0 + 5.0 * ex));',
    '      armM = b3dRotY(-armSide * a) * b3dRotX(-0.3 - 0.6 * ex);',
    '    } else if (kind < 1.5) {',
    '      armM = b3dRotZ(-armSide * (0.35 + 0.25 * sin(t * 7.0))) * b3dRotX(-1.75);',
    '    } else {',
    '      if (armSide > 0.0) armM = b3dRotZ(-0.55 * sin(t * 8.0) - 0.3) * b3dRotX(-1.85);',
    '      else armM = b3dRotX(1.15 - 2.9 * ex);',
    '    }',
    '  }',
    '  jump = abs(sin(t * 5.0)) * (kind > 0.5 ? 0.05 + 0.26 * ex : 0.04 * ex);',
    '}',
    '#endif'
  ].join('\n');

  let gradientTex = null;
  function gradientMap() {
    if (gradientTex) return gradientTex;
    // 5 paliers : ombre propre, ombre, transition, éclairé, plein soleil.
    const vals = [105, 112, 165, 220, 255];
    const data = new Uint8Array(vals.length * 4);
    vals.forEach((v, i) => { data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255; });
    gradientTex = new THREE.DataTexture(data, vals.length, 1, THREE.RGBAFormat);
    gradientTex.minFilter = THREE.NearestFilter;
    gradientTex.magFilter = THREE.NearestFilter;
    gradientTex.generateMipmaps = false;
    gradientTex.needsUpdate = true;
    return gradientTex;
  }

  // Rampe plus douce pour le terrain : évite les taches sombres sur les petites bosses quand le soleil est bas.
  let terrainGradientTex = null;
  function terrainGradientMap() {
    if (terrainGradientTex) return terrainGradientTex;
    const vals = [150, 155, 175, 205, 232, 250, 255, 255];
    const data = new Uint8Array(vals.length * 4);
    vals.forEach((v, i) => { data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255; });
    terrainGradientTex = new THREE.DataTexture(data, vals.length, 1, THREE.RGBAFormat);
    terrainGradientTex.minFilter = THREE.NearestFilter;
    terrainGradientTex.magFilter = THREE.NearestFilter;
    terrainGradientTex.generateMipmaps = false;
    terrainGradientTex.needsUpdate = true;
    return terrainGradientTex;
  }

  const matCache = new Map();
  // Matériau toon simple (mis en cache par couleur/options).
  function mat(color, opts = {}) {
    const key = color + '|' + JSON.stringify(opts);
    if (matCache.has(key)) return matCache.get(key);
    const m = new THREE.MeshToonMaterial(Object.assign({ color: new THREE.Color(color), gradientMap: gradientMap() }, opts));
    matCache.set(key, m);
    return m;
  }

  // Matériau toon pour instances : teinte par instance appliquée seulement là où tintMask = 1,
  // et léger balancement au vent (sway) proportionnel à la hauteur.
  function instancedMat(opts = {}) {
    const m = new THREE.MeshToonMaterial(Object.assign({ vertexColors: true, gradientMap: gradientMap() }, opts.material || {}));
    const sway = opts.sway || 0;
    const bounce = opts.bounce || 0;
    const people = !!opts.people;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = shared.uTime;
      shader.uniforms.uRider = shared.uRider;
      let vs = shader.vertexShader;
      if (people) {
        vs = vs
          .replace('#include <common>', '#include <common>\n' + PEOPLE_PARS)
          .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + PEOPLE_SETUP + '\nobjectNormal = armM * objectNormal;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = armPiv + armM * (transformed - armPiv);\ntransformed.y += jump;');
      }
      shader.vertexShader = vs
        .replace('#include <common>', '#include <common>\nattribute float tintMask;\nuniform float uTime;')
        .replace('#include <color_vertex>', [
          '#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )',
          '  vColor = vec3( 1.0 );',
          '#endif',
          '#ifdef USE_COLOR',
          '  vColor *= color;',
          '#endif',
          '#ifdef USE_INSTANCING_COLOR',
          '  vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, tintMask);',
          '#endif'
        ].join('\n'))
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + swayGLSL(sway, bounce));
    };
    m.customProgramCacheKey = () => 'inst-' + sway + '-' + bounce + '-' + people;
    return m;
  }

  function swayGLSL(sway, bounce) {
    let s = '';
    if (sway > 0 || bounce > 0) {
      s += '#ifdef USE_INSTANCING\n';
      s += 'float phase_ = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;\n';
      if (sway > 0) {
        s += 'float h_ = max(position.y, 0.0);\n';
        s += 'transformed.x += sin(uTime * 1.7 + phase_) * ' + sway.toFixed(4) + ' * h_ * h_;\n';
        s += 'transformed.z += cos(uTime * 1.3 + phase_ * 1.3) * ' + (sway * 0.6).toFixed(4) + ' * h_ * h_;\n';
      }
      if (bounce > 0) {
        s += 'transformed.y += abs(sin(uTime * 5.0 + phase_ * 3.0)) * ' + bounce.toFixed(4) + ';\n';
      }
      s += '#endif\n';
    }
    return s;
  }

  // Matériau de contour : on gonfle la géométrie le long des normales lissées et on dessine les faces arrière.
  const outlineCache = new Map();
  function outlineMat(opts = {}) {
    const color = opts.color || '#1d1a2b';
    const width = opts.width || 1;
    const sway = opts.sway || 0;
    const bounce = opts.bounce || 0;
    const people = !!opts.people;
    const key = [color, width, sway, bounce, opts.minW, opts.maxW, people].join('|');
    if (outlineCache.has(key)) return outlineCache.get(key);
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uWidth: { value: width },
        uMinW: { value: opts.minW !== undefined ? opts.minW : 0.006 },
        uMaxW: { value: opts.maxW !== undefined ? opts.maxW : 0.5 },
        uOutlineScale: shared.uOutlineScale,
        uTime: shared.uTime,
        uRider: shared.uRider,
        fogColor: { value: new THREE.Color() },
        fogNear: { value: 1 },
        fogFar: { value: 1000 },
        fogDensity: { value: 0.0 }
      },
      vertexShader: [
        '#include <common>',
        '#include <fog_pars_vertex>',
        'attribute vec3 outlineNormal;',
        'uniform float uWidth, uMinW, uMaxW, uOutlineScale, uTime;',
        people ? PEOPLE_PARS : '',
        'void main() {',
        '  vec3 transformed = position;',
        '  vec3 n = outlineNormal;',
        people ? PEOPLE_SETUP + '\ntransformed = armPiv + armM * (transformed - armPiv);\ntransformed.y += jump;\nn = armM * n;' : '',
        swayGLSL(sway, bounce),
        '  vec4 p = vec4(transformed, 1.0);',
        '  #ifdef USE_INSTANCING',
        '    p = instanceMatrix * p;',
        '    n = mat3(instanceMatrix) * n;',
        '  #endif',
        '  vec4 mvPosition = modelViewMatrix * p;',
        '  vec3 vn = normalize(mat3(modelViewMatrix) * n);',
        '  float w = clamp(-mvPosition.z * uOutlineScale * uWidth, uMinW * uWidth, uMaxW);',
        '  mvPosition.xyz += vn * w;',
        '  gl_Position = projectionMatrix * mvPosition;',
        '  #include <fog_vertex>',
        '}'
      ].join('\n'),
      fragmentShader: [
        '#include <common>',
        '#include <fog_pars_fragment>',
        'uniform vec3 uColor;',
        'void main() {',
        '  gl_FragColor = vec4(uColor, 1.0);',
        '  #include <fog_fragment>',
        '  #include <colorspace_fragment>',
        '}'
      ].join('\n'),
      side: THREE.BackSide,
      fog: true
    });
    outlineCache.set(key, m);
    return m;
  }

  // Normales lissées (moyennées par position) pour que le contour reste continu sur les arêtes vives.
  function computeOutlineNormals(geo) {
    if (geo.attributes.outlineNormal) return geo;
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const pos = geo.attributes.position, nor = geo.attributes.normal;
    const n = pos.count;
    const acc = new Map();
    const keys = new Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.round(pos.getX(i) * 500) + ',' + Math.round(pos.getY(i) * 500) + ',' + Math.round(pos.getZ(i) * 500);
      keys[i] = k;
      let a = acc.get(k);
      if (!a) { a = [0, 0, 0]; acc.set(k, a); }
      a[0] += nor.getX(i); a[1] += nor.getY(i); a[2] += nor.getZ(i);
    }
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = acc.get(keys[i]);
      const l = Math.hypot(a[0], a[1], a[2]) || 1;
      out[i * 3] = a[0] / l; out[i * 3 + 1] = a[1] / l; out[i * 3 + 2] = a[2] / l;
    }
    geo.setAttribute('outlineNormal', new THREE.BufferAttribute(out, 3));
    return geo;
  }

  // Ajoute un contour à un mesh (enfant partageant la géométrie).
  function addOutline(mesh, opts = {}) {
    computeOutlineNormals(mesh.geometry);
    const o = new THREE.Mesh(mesh.geometry, outlineMat(opts));
    o.castShadow = false;
    o.receiveShadow = false;
    o.name = 'outline';
    o.userData.isOutline = true;
    mesh.add(o);
    return o;
  }

  // Ajoute des contours à tous les meshes d'un groupe.
  function outlineAll(group, opts = {}) {
    const meshes = [];
    group.traverse((o) => { if (o.isMesh && !o.userData.isOutline && !o.userData.noOutline) meshes.push(o); });
    for (const m of meshes) addOutline(m, opts);
  }

  // Fusion de géométries (position, normal, color, tintMask[, armSide]) avec couleurs par partie.
  // parts : [{ geo, color, matrix?, tint? (0/1), arm? (-1/+1 pour les bras animés) }]
  function merge(parts) {
    let vCount = 0, iCount = 0;
    const prepared = parts.map((p) => {
      let g = p.geo;
      if (p.matrix) { g = g.clone(); g.applyMatrix4(p.matrix); }
      if (!g.attributes.normal) g.computeVertexNormals();
      const idx = g.index ? g.index.array : null;
      const cnt = g.attributes.position.count;
      vCount += cnt;
      iCount += idx ? idx.length : cnt;
      return { g, idx, cnt, color: new THREE.Color(p.color || '#ffffff'), tint: p.tint ? 1 : 0, arm: p.arm || 0 };
    });
    const hasArm = prepared.some((p) => p.arm !== 0);
    const arm = hasArm ? new Float32Array(vCount) : null;
    const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3), col = new Float32Array(vCount * 3);
    const tint = new Float32Array(vCount);
    const index = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
    let vo = 0, io = 0;
    for (const p of prepared) {
      const pa = p.g.attributes.position, na = p.g.attributes.normal;
      for (let i = 0; i < p.cnt; i++) {
        pos[(vo + i) * 3] = pa.getX(i); pos[(vo + i) * 3 + 1] = pa.getY(i); pos[(vo + i) * 3 + 2] = pa.getZ(i);
        nor[(vo + i) * 3] = na.getX(i); nor[(vo + i) * 3 + 1] = na.getY(i); nor[(vo + i) * 3 + 2] = na.getZ(i);
        col[(vo + i) * 3] = p.color.r; col[(vo + i) * 3 + 1] = p.color.g; col[(vo + i) * 3 + 2] = p.color.b;
        tint[vo + i] = p.tint;
        if (arm) arm[vo + i] = p.arm;
      }
      if (p.idx) { for (let k = 0; k < p.idx.length; k++) index[io + k] = p.idx[k] + vo; io += p.idx.length; }
      else { for (let k = 0; k < p.cnt; k++) index[io + k] = vo + k; io += p.cnt; }
      vo += p.cnt;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('tintMask', new THREE.BufferAttribute(tint, 1));
    if (arm) geo.setAttribute('armSide', new THREE.BufferAttribute(arm, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  // Petite aide pour construire des matrices de transformation.
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  function tr(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _p.set(x, y, z);
    _s.set(sx, sy, sz);
    return new THREE.Matrix4().compose(_p, _q, _s);
  }

  // Texture canvas avec du texte (panneaux, banderoles…).
  function textTexture(draw, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    draw(ctx, w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  B3D.toon = { shared, gradientMap, terrainGradientMap, mat, instancedMat, outlineMat, computeOutlineNormals, addOutline, outlineAll, merge, tr, textTexture, _m };
})(typeof window !== 'undefined' ? window : globalThis);
