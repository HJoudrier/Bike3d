#!/usr/bin/env node
/* Génère les fichiers GPX d'exemple du dossier samples/ à partir des parcours de démo. */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
for (const f of ['util', 'gpx', 'demo-routes']) require(path.join(root, 'js', f + '.js'));
const B3D = globalThis.B3D;

const files = { col: 'col-des-marmottes.gpx', campagne: 'balade-en-campagne.gpx', hc: 'col-hors-categorie.gpx' };
for (const d of B3D.demoRoutes.list) {
  const data = B3D.demoRoutes.get(d.id);
  const name = d.name.replace(' (démo)', '');
  const out = path.join(root, 'samples', files[d.id]);
  fs.writeFileSync(out, B3D.gpx.build(name, data.points));
  console.log('écrit', path.relative(root, out), '(' + data.points.length + ' points)');
}
