/* author : Hugo Joudrier-Faure */
/* PaceYourRide — lecture d'une archive zip (export d'un compte Strava, dossier de sorties compressé) et des fichiers .gz, dans le navigateur.
 *
 * L'archive n'est jamais chargée en entier : un export Strava pèse souvent plusieurs gigaoctets. On lit la fin du fichier (fin du
 * répertoire central), puis le répertoire central, puis chaque fichier à la demande (Blob.slice). Les fichiers compressés (méthode 8,
 * « deflate ») sont décompressés par le navigateur (DecompressionStream « deflate-raw », « gzip »). Zip64 (archives de plus de 4 Go ou
 * de plus de 65 535 fichiers) pris en charge ; ni chiffrement, ni archive en plusieurs morceaux. Pas de DOM : se teste sous Node. */
(function (PYR) {
  'use strict';

  const SIG_EOCD = 0x06054b50, SIG_Z64_LOC = 0x07064b50, SIG_Z64_EOCD = 0x06064b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;
  const EOCD_MAX = 22 + 65535;         // fin du répertoire central : 22 octets et un commentaire de 65 535 octets au plus

  const u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;

  async function slice(blob, a, b) { return new Uint8Array(await blob.slice(a, b).arrayBuffer()); }

  /**
   * Liste les fichiers d'une archive (Blob ou File). Renvoie [{ name, size (décompressé), compSize, method, offset, dir }] dans l'ordre du
   * répertoire central.
   */
  async function list(blob) {
    const size = blob.size;
    const tailStart = Math.max(0, size - EOCD_MAX - 20);
    const tail = await slice(blob, tailStart, size);
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === SIG_EOCD) { e = i; break; }
    if (e < 0) throw new Error('ce n\'est pas une archive zip (ou elle est incomplète)');
    let count = dv.getUint16(e + 10, true), cdSize = dv.getUint32(e + 12, true), cdOff = dv.getUint32(e + 16, true);
    if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
      const l = e - 20;                                   // localisateur zip64, juste avant
      if (l < 0 || dv.getUint32(l, true) !== SIG_Z64_LOC) throw new Error('archive zip64 illisible');
      const zOff = u64(dv, l + 8);
      const z = await slice(blob, zOff, zOff + 56), zdv = new DataView(z.buffer, z.byteOffset, z.byteLength);
      if (z.length < 56 || zdv.getUint32(0, true) !== SIG_Z64_EOCD) throw new Error('archive zip64 illisible');
      count = u64(zdv, 32); cdSize = u64(zdv, 40); cdOff = u64(zdv, 48);
    }
    if (cdOff + cdSize > size) throw new Error('archive zip incomplète (répertoire central hors du fichier)');
    const cd = await slice(blob, cdOff, cdOff + cdSize);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const utf8 = new TextDecoder('utf-8'), latin = new TextDecoder('latin1');
    const out = [];
    let p = 0;
    while (p + 46 <= cd.length && cv.getUint32(p, true) === SIG_CEN) {
      const flags = cv.getUint16(p + 8, true), method = cv.getUint16(p + 10, true);
      let compSize = cv.getUint32(p + 20, true), usize = cv.getUint32(p + 24, true);
      const nl = cv.getUint16(p + 28, true), xl = cv.getUint16(p + 30, true), kl = cv.getUint16(p + 32, true);
      let offset = cv.getUint32(p + 42, true);
      const name = ((flags & 0x800) ? utf8 : latin).decode(cd.subarray(p + 46, p + 46 + nl)).replace(/\\/g, '/');
      // champ supplémentaire zip64 (0x0001) : tailles et position quand elles dépassent 32 bits, dans cet ordre
      let x = p + 46 + nl;
      const xEnd = x + xl;
      while (x + 4 <= xEnd) {
        const id = cv.getUint16(x, true), len = cv.getUint16(x + 2, true);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xFFFFFFFF && q + 8 <= x + 4 + len) { usize = u64(cv, q); q += 8; }
          if (compSize === 0xFFFFFFFF && q + 8 <= x + 4 + len) { compSize = u64(cv, q); q += 8; }
          if (offset === 0xFFFFFFFF && q + 8 <= x + 4 + len) { offset = u64(cv, q); q += 8; }
        }
        x += 4 + len;
      }
      out.push({ name, size: usize, compSize, method, offset, encrypted: (flags & 1) === 1, dir: name.endsWith('/') });
      p = xEnd + kl;
    }
    return out;
  }

  /** Contenu (Uint8Array) d'un fichier de l'archive (une entrée de list). */
  async function read(blob, ent) {
    if (ent.encrypted) throw new Error(`${ent.name} : fichier chiffré`);
    const h = await slice(blob, ent.offset, ent.offset + 30);
    const hv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    if (h.length < 30 || hv.getUint32(0, true) !== SIG_LOC) throw new Error(`${ent.name} : en-tête local introuvable`);
    const start = ent.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    const data = await slice(blob, start, start + ent.compSize);
    if (ent.method === 0) return data;
    if (ent.method === 8) return inflate(data, 'deflate-raw');
    throw new Error(`${ent.name} : méthode de compression ${ent.method} non prise en charge`);
  }

  /** Décompresse des octets ('deflate-raw', 'deflate' ou 'gzip') avec le navigateur. */
  async function inflate(bytes, format) {
    if (typeof DecompressionStream === 'undefined') throw new Error('ce navigateur ne sait pas décompresser (DecompressionStream absent) : mets-le à jour');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const isGzip = (b) => b.length > 2 && b[0] === 0x1F && b[1] === 0x8B;
  const gunzip = (b) => inflate(b, 'gzip');

  PYR.zip = { list, read, inflate, gunzip, isGzip };
})(globalThis.PYR = globalThis.PYR || {});
