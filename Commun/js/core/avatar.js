/* author : Hugo Joudrier-Faure */
/* PaceYourRide — photo d'avatar du cycliste (rider.avatar) : une petite image carrée (JPEG, 160 px) enregistrée dans le profil sous forme
 * d'adresse « data: », donc dans le navigateur, avec l'athlète dans la bibliothèque, mais pas dans les liens de partage. Elle sert de repère
 * dans le mode course : marqueur de la carte et ligne du classement. */
(function (PYR) {
  'use strict';

  const SIZE = 160;                 // côté de l'image enregistrée (px)
  const MAX_LEN = 80000;            // longueur maximale de l'adresse data: acceptée (≈ 60 Ko d'image)
  const MAX_FILE = 25 * 1024 * 1024;
  const RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

  /** Adresse data: d'image valide et de taille raisonnable (elle finit dans un `url("…")` CSS : seuls les caractères base64 passent), sinon ''. */
  function clean(v) {
    return typeof v === 'string' && v.length <= MAX_LEN && RE.test(v) ? v : '';
  }

  /** Photo du profil en cours (celle du projet, ou de `rider` s'il est donné), ou ''. */
  function get(rider) {
    const r = rider || (PYR.store && PYR.store.state && PYR.store.state.rider);
    return r ? clean(r.avatar) : '';
  }

  /** Image choisie par l'utilisateur → adresse data: carrée (recadrée au centre, redimensionnée à SIZE px). */
  function fromFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('Ce fichier n\'est pas une image.'));
      if (file.size > MAX_FILE) return reject(new Error('Image trop lourde (25 Mo au plus).'));
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth, hgt = img.naturalHeight, side = Math.min(w, hgt);
          if (!side) throw new Error('Image vide.');
          const cv = document.createElement('canvas');
          cv.width = cv.height = SIZE;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SIZE, SIZE);         // fond blanc sous les images transparentes
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, (w - side) / 2, (hgt - side) / 2, side, side, 0, 0, SIZE, SIZE);
          let out = cv.toDataURL('image/jpeg', 0.85);
          if (out.length > MAX_LEN) out = cv.toDataURL('image/jpeg', 0.6);
          const ok = clean(out);
          if (!ok) throw new Error('Image illisible.');
          resolve(ok);
        } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible (formats acceptés : JPEG, PNG, WebP…).')); };
      img.src = url;
    });
  }

  /** Pastille ronde avec la photo (classements) : `size` en px, `color` pour l'anneau. null sans photo. */
  function span(size, color, rider) {
    const url = get(rider);
    if (!url) return null;
    const el = document.createElement('span');
    el.className = 'avatar';
    el.style.backgroundImage = `url("${url}")`;
    el.style.width = el.style.height = (size || 20) + 'px';
    if (color) el.style.setProperty('--c', color);
    return el;
  }

  PYR.avatar = { SIZE, clean, get, fromFile, span };
})(globalThis.PYR = globalThis.PYR || {});
