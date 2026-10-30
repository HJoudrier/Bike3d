/* Bike3D — lecture / écriture de fichiers GPX. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};

  function childText(node, localName) {
    for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName === localName) return c.textContent.trim();
    }
    return null;
  }

  // Renvoie { name, points: [{lat, lon, ele|null}] }
  function parse(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('Le fichier ne semble pas être un GPX valide (XML illisible).');
    }
    let nodes = doc.getElementsByTagNameNS('*', 'trkpt');
    if (!nodes.length) nodes = doc.getElementsByTagNameNS('*', 'rtept');
    if (!nodes.length) nodes = doc.getElementsByTagNameNS('*', 'wpt');
    if (nodes.length < 2) {
      throw new Error('Aucun tracé trouvé dans le GPX (il faut au moins 2 points <trkpt> ou <rtept>).');
    }
    const points = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const lat = parseFloat(n.getAttribute('lat'));
      const lon = parseFloat(n.getAttribute('lon'));
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const eleTxt = childText(n, 'ele');
      const ele = eleTxt !== null && eleTxt !== '' && isFinite(parseFloat(eleTxt)) ? parseFloat(eleTxt) : null;
      points.push({ lat, lon, ele });
    }
    if (points.length < 2) throw new Error('Le tracé GPX contient moins de 2 points valides.');

    let name = null;
    const trk = doc.getElementsByTagNameNS('*', 'trk')[0] || doc.getElementsByTagNameNS('*', 'rte')[0];
    if (trk) name = childText(trk, 'name');
    if (!name) {
      const meta = doc.getElementsByTagNameNS('*', 'metadata')[0];
      if (meta) name = childText(meta, 'name');
    }
    return { name: name || null, points };
  }

  function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  }

  function build(name, points) {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Bike3D" xmlns="http://www.topografix.com/GPX/1/1">',
      '  <metadata><name>' + escapeXml(name) + '</name></metadata>',
      '  <trk>',
      '    <name>' + escapeXml(name) + '</name>',
      '    <trkseg>'
    ];
    for (const p of points) {
      lines.push('      <trkpt lat="' + p.lat.toFixed(7) + '" lon="' + p.lon.toFixed(7) + '"><ele>' + p.ele.toFixed(1) + '</ele></trkpt>');
    }
    lines.push('    </trkseg>', '  </trk>', '</gpx>', '');
    return lines.join('\n');
  }

  B3D.gpx = { parse, build };
})(typeof window !== 'undefined' ? window : globalThis);
