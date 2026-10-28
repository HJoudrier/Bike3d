/* Bike3D — eau cartoon animée : rivières (rubans) et lacs (disques). */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};

  function waterMaterial(amb, kind) {
    const w = kind === 'pond' ? amb.pond : amb.water;
    return new THREE.ShaderMaterial({
      uniforms: {
        uDeep: { value: new THREE.Color(w.deep) },
        uShallow: { value: new THREE.Color(w.shallow) },
        uFoam: { value: new THREE.Color('#ffffff') },
        uTime: B3D.toon.shared.uTime,
        uKind: { value: kind === 'river' ? 1 : 0 },
        uFoamThr: { value: kind === 'pond' ? 0.95 : 0.86 },
        uSkyTint: B3D.toon.shared.uSkyTint,
        fogColor: { value: new THREE.Color() }, fogNear: { value: 1 }, fogFar: { value: 1000 }, fogDensity: { value: 0 }
      },
      vertexShader: [
        '#include <common>',
        '#include <fog_pars_vertex>',
        'attribute vec2 wuv;',
        'attribute float edge;',
        'varying vec2 vUv; varying float vEdge; varying vec3 vW;',
        'void main() {',
        '  vUv = wuv; vEdge = edge;',
        '  vec4 wp = modelMatrix * vec4(position, 1.0);',
        '  vW = wp.xyz;',
        '  vec4 mvPosition = viewMatrix * wp;',
        '  gl_Position = projectionMatrix * mvPosition;',
        '  #include <fog_vertex>',
        '}'
      ].join('\n'),
      fragmentShader: [
        '#include <common>',
        '#include <fog_pars_fragment>',
        'uniform vec3 uDeep, uShallow, uFoam, uSkyTint; uniform float uTime, uKind, uFoamThr;',
        'varying vec2 vUv; varying float vEdge; varying vec3 vW;',
        'float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
        'float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);',
        '  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }',
        'void main() {',
        '  vec3 c = mix(uDeep, uShallow, smoothstep(0.3, 0.95, vEdge));',
        '  float glint;',
        '  if (uKind > 0.5) {',
        '    vec2 p = vec2(vUv.x * 0.22 - uTime * 0.9, vUv.y * 5.0);',
        '    glint = step(0.8, vnoise(p) * 0.7 + vnoise(p * 2.7 + 3.1) * 0.3);',
        '  } else {',
        '    vec2 p = vW.xz * 0.09 + vec2(uTime * 0.05, uTime * 0.03);',
        '    glint = step(0.82, vnoise(p) * 0.6 + vnoise(p * 3.1 - uTime * 0.1) * 0.4);',
        '  }',
        '  c = mix(c, uFoam, glint * 0.6);',
        '  float foam = step(uFoamThr, vEdge + 0.05 * sin(uTime * 2.2 + vW.x * 0.6 + vW.z * 0.45));',
        '  c = mix(c, uFoam, foam * 0.9);',
        '  c *= uSkyTint;', // assombrie la nuit et par temps d'orage
        '  gl_FragColor = vec4(c, 1.0);',
        '  #include <fog_fragment>',
        '  #include <colorspace_fragment>',
        '}'
      ].join('\n'),
      fog: true
    });
  }

  function buildRivers(L) {
    const group = new THREE.Group();
    if (!L.rivers.length) return group;
    const mat = waterMaterial(L.amb, 'river');
    for (const rv of L.rivers) {
      const n = rv.n;
      const pos = new Float32Array(n * 3 * 3), wuv = new Float32Array(n * 3 * 2), edge = new Float32Array(n * 3);
      let dist = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        let tx = rv.x[b] - rv.x[a], tz = rv.z[b] - rv.z[a];
        const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const rx = -tz, rz = tx;
        if (i > 0) dist += Math.hypot(rv.x[i] - rv.x[i - 1], rv.z[i] - rv.z[i - 1]);
        const w = rv.rw[i] + 1.3;
        for (let k = 0; k < 3; k++) {
          const f = k - 1; // -1, 0, 1
          const v = i * 3 + k;
          pos[v * 3] = rv.x[i] + rx * w * f;
          pos[v * 3 + 1] = rv.wl[i];
          pos[v * 3 + 2] = rv.z[i] + rz * w * f;
          wuv[v * 2] = dist; wuv[v * 2 + 1] = (f + 1) / 2;
          edge[v] = Math.abs(f);
        }
      }
      const idx = [];
      for (let i = 0; i < n - 1; i++) {
        for (let k = 0; k < 2; k++) {
          const a = i * 3 + k, b = a + 1, c = a + 3, d = c + 1;
          idx.push(a, b, c, b, d, c);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('wuv', new THREE.BufferAttribute(wuv, 2));
      geo.setAttribute('edge', new THREE.BufferAttribute(edge, 1));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = false;
      group.add(mesh);
    }
    return group;
  }

  function buildLakes(L) {
    const group = new THREE.Group();
    if (!L.lakes.length) return group;
    const mat = waterMaterial(L.amb, 'lake');
    const pondMat = waterMaterial(L.amb, 'pond');
    const pads = [];
    for (const lk of L.lakes) {
      const SEG = lk.kind === 'pond' ? 28 : 72;
      const pos = new Float32Array((SEG * 2 + 1) * 3), edge = new Float32Array(SEG * 2 + 1), wuv = new Float32Array((SEG * 2 + 1) * 2);
      pos[0] = lk.x; pos[1] = lk.level; pos[2] = lk.z; edge[0] = 0;
      for (let k = 0; k < SEG; k++) {
        const ang = k / SEG * Math.PI * 2;
        const Rt = lk.r * (1 + 0.24 * L.noiseC.noise(lk.nx + Math.cos(ang) * 0.55, lk.nz + Math.sin(ang) * 0.55));
        for (let ring = 0; ring < 2; ring++) {
          const f = ring === 0 ? 0.8 : 1.07;
          const v = 1 + k * 2 + ring;
          pos[v * 3] = lk.x + Math.cos(ang) * Rt * f;
          pos[v * 3 + 1] = lk.level;
          pos[v * 3 + 2] = lk.z + Math.sin(ang) * Rt * f;
          edge[v] = ring === 0 ? 0.8 : 1.0;
        }
      }
      for (let v = 0; v < SEG * 2 + 1; v++) { wuv[v * 2] = pos[v * 3]; wuv[v * 2 + 1] = pos[v * 3 + 2]; }
      const idx = [];
      for (let k = 0; k < SEG; k++) {
        const k2 = (k + 1) % SEG;
        const a = 1 + k * 2, b = 1 + k2 * 2;
        idx.push(0, b, a);
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('wuv', new THREE.BufferAttribute(wuv, 2));
      geo.setAttribute('edge', new THREE.BufferAttribute(edge, 1));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      group.add(new THREE.Mesh(geo, lk.kind === 'pond' ? pondMat : mat));
      if (lk.kind === 'pond') {
        // nénuphars : disques échancrés et quelques fleurs roses
        let seed = Math.floor(Math.abs(lk.nx * 1000)) + 1;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        const n = 4 + Math.floor(rnd() * 7);
        for (let k = 0; k < n; k++) {
          const a = rnd() * Math.PI * 2, d = lk.r * (0.35 + rnd() * 0.45), rr = 0.35 + rnd() * 0.35;
          const x = lk.x + Math.cos(a) * d, z = lk.z + Math.sin(a) * d;
          pads.push({ geo: new THREE.CylinderGeometry(rr, rr, 0.04, 9, 1, false, 0.4, Math.PI * 2 - 0.6), color: '#4f9a3a', matrix: B3D.toon.tr(x, lk.level + 0.03, z, 0, rnd() * 6.28, 0) });
          if (rnd() < 0.35) pads.push({ geo: new THREE.ConeGeometry(0.16, 0.18, 6), color: '#ff9ec4', matrix: B3D.toon.tr(x, lk.level + 0.13, z, Math.PI, 0, 0) });
        }
      }
    }
    if (pads.length) {
      const m = new THREE.Mesh(B3D.toon.merge(pads), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: B3D.toon.gradientMap() }));
      group.add(m);
    }
    return group;
  }

  B3D.water = {
    build(L) {
      const g = new THREE.Group();
      g.name = 'water';
      g.add(buildRivers(L));
      g.add(buildLakes(L));
      return g;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
